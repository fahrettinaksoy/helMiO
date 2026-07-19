//! Sağlık kontrolü zamanlayıcısı. supervisord'da "RUNNING" yalnız sürecin ayakta
//! olduğunu gösterir; barındırdığı servisin gerçekten yanıt verdiğini değil. Bir
//! sağlık kontrolü HTTP/TCP/script ile prob atar; `failureThreshold` ardışık
//! başarısızlıktan sonra eylem alır (restart → yeniden başlat + uyarı, alert → yalnız uyarı).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::full_server;
use crate::db;
use crate::store::{audit, healthchecks};
use crate::supervisor::{create_connector, service};

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn now_iso() -> String {
    crate::store::now_iso()
}

pub struct HealthcheckState {
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl HealthcheckState {
    pub fn new() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for HealthcheckState {
    fn default() -> Self {
        Self::new()
    }
}

// --- Prob'lar (her biri { ok, status?, error?, durationMs } döner) ----------

async fn probe_http(cfg: &Value, started: i64) -> Value {
    let url = cfg.get("url").and_then(Value::as_str).unwrap_or("");
    let expect = cfg
        .get("expectStatus")
        .and_then(Value::as_i64)
        .unwrap_or(200);
    let timeout = cfg
        .get("timeoutMs")
        .and_then(Value::as_i64)
        .unwrap_or(5000)
        .max(1) as u64;

    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(timeout))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return json!({ "ok": false, "error": e.to_string(), "durationMs": now_ms() - started })
        }
    };
    match client.get(url).send().await {
        Ok(res) => {
            let status = res.status().as_u16() as i64;
            let ok = status == expect;
            json!({
                "ok": ok,
                "status": status,
                "error": if ok { Value::Null } else { Value::String(format!("beklenen {expect}, gelen {status}")) },
                "durationMs": now_ms() - started,
            })
        }
        Err(e) => {
            let msg = if e.is_timeout() {
                "zaman aşımı".to_string()
            } else {
                e.to_string()
            };
            json!({ "ok": false, "error": msg, "durationMs": now_ms() - started })
        }
    }
}

async fn probe_tcp(cfg: &Value, started: i64) -> Value {
    let host = cfg
        .get("host")
        .and_then(Value::as_str)
        .unwrap_or("127.0.0.1");
    let port = cfg.get("port").and_then(Value::as_i64).unwrap_or(0);
    let timeout = cfg
        .get("timeoutMs")
        .and_then(Value::as_i64)
        .unwrap_or(5000)
        .max(1) as u64;
    let addr = format!("{host}:{port}");
    let res = tokio::time::timeout(
        Duration::from_millis(timeout),
        tokio::net::TcpStream::connect(&addr),
    )
    .await;
    match res {
        Ok(Ok(_)) => json!({ "ok": true, "error": Value::Null, "durationMs": now_ms() - started }),
        Ok(Err(e)) => {
            json!({ "ok": false, "error": e.to_string(), "durationMs": now_ms() - started })
        }
        Err(_) => json!({ "ok": false, "error": "zaman aşımı", "durationMs": now_ms() - started }),
    }
}

fn sh_arg(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

async fn probe_script(cfg: &Value, server: Option<&Value>, started: i64) -> Value {
    let Some(server) = server else {
        return json!({ "ok": false, "error": "sunucu bulunamadı", "durationMs": now_ms() - started });
    };
    let conn = match create_connector(server) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": e.error, "durationMs": now_ms() - started }),
    };
    if !conn.supports_exec() {
        conn.close().await;
        return json!({ "ok": false, "error": "script kontrolü için shell erişimli bağlantı gerekir", "durationMs": now_ms() - started });
    }
    let command = cfg.get("command").and_then(Value::as_str).unwrap_or("");
    let expect = cfg.get("expectExit").and_then(Value::as_i64).unwrap_or(0);
    let timeout = cfg.get("timeoutMs").and_then(Value::as_i64).unwrap_or(5000);
    let secs = ((timeout as f64) / 1000.0).ceil().max(1.0) as i64;
    let wrapped = format!(
        "timeout {secs} sh -c {} 2>&1; echo \"__rc=$?\"",
        sh_arg(command)
    );

    let out = conn.exec(&wrapped, None).await;
    conn.close().await;
    match out {
        Ok(o) => {
            let rc = o
                .stdout
                .rfind("__rc=")
                .map(|i| {
                    o.stdout[i + 5..]
                        .chars()
                        .take_while(|c| c.is_ascii_digit())
                        .collect::<String>()
                        .parse::<i64>()
                        .unwrap_or(1)
                })
                .unwrap_or(1);
            let ok = rc == expect;
            json!({
                "ok": ok,
                "error": if ok { Value::Null } else { Value::String(format!("çıkış kodu {rc} (beklenen {expect})")) },
                "durationMs": now_ms() - started,
            })
        }
        Err(e) => json!({ "ok": false, "error": e.error, "durationMs": now_ms() - started }),
    }
}

/// Durum değiştirmeden tek prob (run-now / test ucu için).
pub async fn probe(check: &Value, server: Option<&Value>) -> Value {
    let started = now_ms();
    let cfg = check.get("config").cloned().unwrap_or(json!({}));
    match check.get("type").and_then(Value::as_str) {
        Some("http") => probe_http(&cfg, started).await,
        Some("tcp") => probe_tcp(&cfg, started).await,
        _ => probe_script(&cfg, server, started).await,
    }
}

async fn take_action(app: &AppHandle, check: &Value, error: &str) {
    let server_id = check.get("serverId").and_then(Value::as_str).unwrap_or("");
    let target = check.get("target").and_then(Value::as_str).unwrap_or("");
    let ctype = check.get("type").and_then(Value::as_str).unwrap_or("");
    let action = check
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("alert");
    let action_label = if action == "restart" {
        "yeniden başlatıldı"
    } else {
        "uyarı verildi"
    };
    let detail = format!("sağlık kontrolü başarısız ({error}) → {action_label}");

    // Uyarıyı istemciye ilet.
    let alert = json!({ "serverId": server_id, "type": "healthcheck", "fullName": target, "at": now_ms(), "detail": detail });
    let _ = app.emit("rt:alert", &alert);
    // Bildirim kanallarına ilet.
    crate::services::notifier::handle_alert(app, server_id, &alert).await;

    let Ok(pool) = db::pool(app).await else {
        return;
    };
    audit::record(
        &pool,
        "healthcheck.triggered",
        Some(server_id),
        Some(target),
        "error",
        Some(&format!("{ctype}: {error}")),
    )
    .await;

    if action == "restart" {
        if let Ok(server) = full_server(app, server_id).await {
            match service::restart(&server, target).await {
                Ok(_) => {
                    audit::record(
                        &pool,
                        "healthcheck.restart",
                        Some(server_id),
                        Some(target),
                        "ok",
                        None,
                    )
                    .await
                }
                Err(e) => {
                    audit::record(
                        &pool,
                        "healthcheck.restart",
                        Some(server_id),
                        Some(target),
                        "error",
                        Some(&e.error),
                    )
                    .await
                }
            }
        }
    }
}

/// Zamanlanmış tek kontrolü çalıştırır (en güncel sayaç için yeniden okur).
async fn run_check(app: &AppHandle, id: &str) {
    let Ok(pool) = db::pool(app).await else {
        return;
    };
    let Ok(check) = healthchecks::get(&pool, id).await else {
        return;
    };
    if !check
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return;
    }

    let ctype = check.get("type").and_then(Value::as_str).unwrap_or("");
    let server = if ctype == "script" {
        let sid = check.get("serverId").and_then(Value::as_str).unwrap_or("");
        full_server(app, sid).await.ok()
    } else {
        None
    };

    let result = probe(&check, server.as_ref()).await;
    let now = now_iso();
    let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);

    if ok {
        let _ = healthchecks::record_result(&pool, id, &now, "ok", 0, None, None).await;
        return;
    }

    let error = result
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("bilinmeyen hata");
    let threshold = check
        .get("failureThreshold")
        .and_then(Value::as_i64)
        .unwrap_or(3);
    let failures = check
        .get("consecutiveFailures")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        + 1;

    if failures >= threshold {
        // Eylemden sonra sayacı sıfırla ki her intervalde restart olmasın.
        take_action(app, &check, error).await;
        let _ =
            healthchecks::record_result(&pool, id, &now, "fail", 0, Some(error), Some(&now)).await;
    } else {
        let _ =
            healthchecks::record_result(&pool, id, &now, "fail", failures, Some(error), None).await;
    }
}

fn spawn_check_loop(app: AppHandle, id: String, interval_ms: u64) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(interval_ms)).await;
            run_check(&app, &id).await;
        }
    })
}

/// Zamanlayıcıyı store ile yeniden eşitler (açılışta ve her CRUD'dan sonra).
pub async fn reload(app: &AppHandle) {
    let state = app.state::<HealthcheckState>();
    {
        let mut tasks = state.tasks.lock().unwrap();
        for (_, h) in tasks.drain() {
            h.abort();
        }
    }
    let Ok(pool) = db::pool(app).await else {
        return;
    };
    let Ok(checks) = healthchecks::list_all(&pool).await else {
        return;
    };
    let mut tasks = state.tasks.lock().unwrap();
    for c in checks {
        if !c.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let id = c
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let interval = c
            .get("intervalSec")
            .and_then(Value::as_i64)
            .unwrap_or(30)
            .max(5) as u64
            * 1000;
        let handle = spawn_check_loop(app.clone(), id.clone(), interval);
        tasks.insert(id, handle);
    }
}

/// Açılışta zamanlayıcıyı başlatır (DB preload için kısa gecikme + retry).
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        for _ in 0..10 {
            if db::pool(&app).await.is_ok() {
                reload(&app).await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
}
