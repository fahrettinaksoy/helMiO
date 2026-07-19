//! Sunucular arası filo orkestrasyonu (eski `/api/fleet/run`). Bir eylemi çok
//! sunucuda paralel veya sıralı (rolling) çalıştırır; her sunucu bittikçe
//! `rt:fleet` ilerleme olayı yayınlar.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::commands::full_server;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::store::audit;
use crate::supervisor::service;

const ACTIONS: &[&str] = &[
    "startAll",
    "stopAll",
    "restartAll",
    "startGroup",
    "stopGroup",
    "restartGroup",
];

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn dispatch_action(server: &Value, action: &str, group: &str) -> AppResult<Value> {
    match action {
        "startAll" => service::start_all(server).await,
        "stopAll" => service::stop_all(server).await,
        "restartAll" => service::restart_all(server).await,
        "startGroup" => service::start_group(server, group).await,
        "stopGroup" => service::stop_group(server, group).await,
        "restartGroup" => service::restart_group(server, group).await,
        _ => Err(AppError::new("Bilinmeyen eylem")),
    }
}

async fn run_one(
    app: AppHandle,
    action: String,
    group: String,
    run_id: String,
    server_id: String,
) -> Value {
    let started = now_ms();
    let result = match full_server(&app, &server_id).await {
        Err(_) => {
            json!({ "serverId": server_id, "name": server_id, "ok": false, "error": "Sunucu bulunamadı", "durationMs": 0 })
        }
        Ok(server) => {
            let name = server
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&server_id)
                .to_string();
            match dispatch_action(&server, &action, &group).await {
                Ok(_) => {
                    json!({ "serverId": server_id, "name": name, "ok": true, "durationMs": now_ms() - started })
                }
                Err(e) => {
                    json!({ "serverId": server_id, "name": name, "ok": false, "error": e.error, "durationMs": now_ms() - started })
                }
            }
        }
    };
    if !run_id.is_empty() {
        let _ = app.emit(
            "rt:fleet",
            json!({ "runId": run_id, "event": "progress", "result": result }),
        );
    }
    result
}

#[tauri::command]
pub async fn fleet_run(app: AppHandle, data: Value) -> AppResult<Value> {
    let action = data
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !ACTIONS.contains(&action.as_str()) {
        return Err(AppError::new("Geçersiz eylem"));
    }
    let server_ids: Vec<String> = data
        .get("serverIds")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if server_ids.is_empty() {
        return Err(AppError::new("En az bir sunucu seçin"));
    }
    let group = data
        .get("group")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let strategy = data
        .get("strategy")
        .and_then(Value::as_str)
        .unwrap_or("parallel")
        .to_string();
    let delay = data
        .get("delayMs")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(0, 60000);
    let run_id = data
        .get("runId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if action.ends_with("Group") && group.is_empty() {
        return Err(AppError::new("Grup adı gerekli"));
    }

    let results: Vec<Value> = if strategy == "sequential" {
        let mut acc = Vec::new();
        let n = server_ids.len();
        for (i, sid) in server_ids.into_iter().enumerate() {
            acc.push(
                run_one(
                    app.clone(),
                    action.clone(),
                    group.clone(),
                    run_id.clone(),
                    sid,
                )
                .await,
            );
            if delay > 0 && i < n - 1 {
                tokio::time::sleep(Duration::from_millis(delay as u64)).await;
            }
        }
        acc
    } else {
        // Paralel: hepsini başlat, sırayla topla (sıra korunur, eşzamanlı koşar).
        let handles: Vec<_> = server_ids
            .into_iter()
            .map(|sid| {
                let (a, g, r) = (action.clone(), group.clone(), run_id.clone());
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move { run_one(app2, a, g, r, sid).await })
            })
            .collect();
        let mut acc = Vec::with_capacity(handles.len());
        for h in handles {
            acc.push(
                h.await
                    .unwrap_or_else(|_| json!({ "ok": false, "error": "görev iptal edildi" })),
            );
        }
        acc
    };

    let total = results.len();
    let ok = results
        .iter()
        .filter(|r| r.get("ok").and_then(Value::as_bool).unwrap_or(false))
        .count();
    if !run_id.is_empty() {
        let _ = app.emit(
            "rt:fleet",
            json!({ "runId": run_id, "event": "done", "ok": ok, "total": total }),
        );
    }

    let pool = db::pool(&app).await?;
    let target = if group.is_empty() {
        action.clone()
    } else {
        format!("{action}:{group}")
    };
    let status = if ok == total { "ok" } else { "error" };
    audit::record(
        &pool,
        "fleet.run",
        None,
        Some(&target),
        status,
        Some(&format!("{strategy} · {ok}/{total} başarılı")),
    )
    .await;

    Ok(json!({
        "action": action,
        "group": if group.is_empty() { Value::Null } else { Value::String(group) },
        "strategy": strategy,
        "results": results,
        "ok": ok,
        "total": total,
    }))
}
