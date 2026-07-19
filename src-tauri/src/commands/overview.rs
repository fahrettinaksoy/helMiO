//! Filo geneli dashboard özeti (eski `/api/overview`). Metrik zaman serisi +
//! host gauge'ları + sağlık kontrolü özeti — hepsi yerel DB'den, hedeflere
//! dokunmadan.

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::crypto::SecretBox;
use crate::db;
use crate::error::AppResult;
use crate::store::{healthchecks, metrics, servers};

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[tauri::command]
pub async fn overview_get(app: AppHandle, range: Option<i64>) -> AppResult<Value> {
    let minutes = range.unwrap_or(60).clamp(5, 1440);
    let pool = db::pool(&app).await?;
    let sb = app.state::<SecretBox>();

    // Sunucu id → ad.
    let servers = servers::list(&pool, sb.inner()).await?;
    let mut name_by_id: Map<String, Value> = Map::new();
    if let Some(arr) = servers.as_array() {
        for s in arr {
            if let (Some(id), Some(name)) = (
                s.get("id").and_then(Value::as_str),
                s.get("name").and_then(Value::as_str),
            ) {
                name_by_id.insert(id.to_string(), Value::String(name.to_string()));
            }
        }
    }
    let name_of = |id: &str| -> String {
        name_by_id
            .get(id)
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_string()
    };

    // Metrikler.
    let now = now_ms();
    let fleet = metrics::fleet(&pool, minutes * 60000, now).await?;
    let series = fleet.get("series").cloned().unwrap_or(Value::Array(vec![]));
    let hosts: Vec<Value> = fleet
        .get("hosts")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(id, s)| {
                    json!({
                        "serverId": id,
                        "name": name_of(id),
                        "load": s.get("load").cloned().unwrap_or(Value::Null),
                        "memPct": s.get("memPct").cloned().unwrap_or(Value::Null),
                        "diskPct": s.get("diskPct").cloned().unwrap_or(Value::Null),
                        "cpu": s.get("cpu").cloned().unwrap_or(Value::Null),
                        "mem": s.get("mem").cloned().unwrap_or(Value::Null),
                        "at": s.get("at").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // Sağlık kontrolleri özeti.
    let checks = healthchecks::list_all(&pool).await?;
    let status_of = |c: &Value| {
        c.get("lastStatus")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string()
    };
    let passing = checks.iter().filter(|c| status_of(c) == "ok").count();
    let failing: Vec<&Value> = checks.iter().filter(|c| status_of(c) == "fail").collect();
    let failing_list: Vec<Value> = failing
        .iter()
        .map(|c| {
            json!({
                "target": c.get("target").cloned().unwrap_or(Value::Null),
                "serverName": name_of(c.get("serverId").and_then(Value::as_str).unwrap_or("")),
                "type": c.get("type").cloned().unwrap_or(Value::Null),
                "error": c.get("lastError").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();

    let mut with_actions: Vec<&Value> = checks
        .iter()
        .filter(|c| c.get("lastActionAt").and_then(Value::as_str).is_some())
        .collect();
    with_actions.sort_by(|a, b| {
        let ka = a.get("lastActionAt").and_then(Value::as_str).unwrap_or("");
        let kb = b.get("lastActionAt").and_then(Value::as_str).unwrap_or("");
        kb.cmp(ka) // en yeni önce (ISO string sıralaması)
    });
    let recent_actions: Vec<Value> = with_actions
        .iter()
        .take(5)
        .map(|c| {
            json!({
                "target": c.get("target").cloned().unwrap_or(Value::Null),
                "serverName": name_of(c.get("serverId").and_then(Value::as_str).unwrap_or("")),
                "at": c.get("lastActionAt").cloned().unwrap_or(Value::Null),
                "action": c.get("action").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();

    Ok(json!({
        "range": minutes,
        "metrics": { "series": series, "hosts": hosts },
        "health": {
            "total": checks.len(),
            "passing": passing,
            "failing": failing.len(),
            "failingList": failing_list,
            "recentActions": recent_actions,
        },
    }))
}
