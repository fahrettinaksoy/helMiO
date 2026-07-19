//! Gerçek zamanlı katman — eski Socket.IO poller'ının Tauri-event karşılığı.
//!
//! Frontend `socket.emit('subscribe', {serverId})` → `rt_subscribe` komutu;
//! Rust bir arka plan poller görevi başlatır ve periyodik olarak `rt:snapshot`
//! Tauri olayı yayınlar. Abonelik refcount'ludur; son abone çıkınca poller
//! iptal edilir. Alarm tespiti frontend realtime store'unda (client-side) yapılır.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::full_server;
use crate::db;
use crate::error::AppResult;
use crate::services::{installer, notifier};
use crate::store::metrics;
use crate::supervisor::service::{self, SupervisorRuntime};

/// Metrik örnekleme throttle (eski MIN_INTERVAL_MS).
const METRIC_MIN_INTERVAL_MS: i64 = 10000;

/// Poller cadence (eski POLL_INTERVAL_MS varsayılanı).
const POLL_INTERVAL_MS: u64 = 3000;

struct PollerEntry {
    refcount: u32,
    handle: JoinHandle<()>,
}

pub struct RealtimeState {
    pollers: Mutex<HashMap<String, PollerEntry>>,
    /// Aktif canlı log kuyruklama görevi (aynı anda tek panel). Yeni start
    /// öncekini iptal eder.
    log_task: Mutex<Option<JoinHandle<()>>>,
    /// Sunucu başına son metrik örnek zamanı (throttle).
    metric_last: Mutex<HashMap<String, i64>>,
    /// Sunucu → fullName → (statecode, flapping); server-side alarm tespiti için.
    #[allow(clippy::type_complexity)]
    alert_prev: Mutex<HashMap<String, HashMap<String, (i64, bool)>>>,
}

impl RealtimeState {
    pub fn new() -> Self {
        Self {
            pollers: Mutex::new(HashMap::new()),
            log_task: Mutex::new(None),
            metric_last: Mutex::new(HashMap::new()),
            alert_prev: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for RealtimeState {
    fn default() -> Self {
        Self::new()
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Bir sunucu için periyodik snapshot döngüsü. İlk snapshot hemen yayınlanır.
async fn poll_loop(app: AppHandle, server_id: String) {
    loop {
        match full_server(&app, &server_id).await {
            Ok(server) => {
                let rt = app.state::<SupervisorRuntime>();
                match service::snapshot(rt.inner(), &server).await {
                    Ok(snap) => {
                        let _ = app.emit(
                            "rt:snapshot",
                            json!({ "serverId": server_id, "snapshot": snap, "at": now_ms() }),
                        );
                        maybe_record_metrics(&app, &server_id, &server, &snap).await;
                        detect_alerts(&app, &server_id, &snap).await;
                    }
                    Err(e) => {
                        let _ = app.emit(
                            "rt:error",
                            json!({ "serverId": server_id, "error": e.error, "at": now_ms() }),
                        );
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "rt:error",
                    json!({ "serverId": server_id, "error": e.error, "at": now_ms() }),
                );
            }
        }
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

/// Server-side alarm tespiti (FATAL geçişi, flapping yükselen kenar) → notifier.
/// İstemci kendi snackbar'ını snapshot'tan üretir; burada YALNIZ kanallara iletiriz.
async fn detect_alerts(app: &AppHandle, server_id: &str, snapshot: &serde_json::Value) {
    let now = now_ms();
    let mut to_send: Vec<(String, &'static str)> = Vec::new();
    {
        let state = app.state::<RealtimeState>();
        let mut prev_map = state.alert_prev.lock().unwrap();
        let prev = prev_map.entry(server_id.to_string()).or_default();
        let mut next: HashMap<String, (i64, bool)> = HashMap::new();
        if let Some(procs) = snapshot.get("processes").and_then(|v| v.as_array()) {
            for p in procs {
                let full = p
                    .get("fullName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let statecode = p.get("statecode").and_then(|v| v.as_i64()).unwrap_or(0);
                let flapping = p.get("flapping").and_then(|v| v.as_bool()).unwrap_or(false);
                if let Some(&(pstate, pflap)) = prev.get(&full) {
                    if statecode == 200 && pstate != 200 {
                        to_send.push((full.clone(), "fatal"));
                    }
                    if flapping && !pflap {
                        to_send.push((full.clone(), "flapping"));
                    }
                }
                next.insert(full, (statecode, flapping));
            }
        }
        *prev = next;
    }
    for (full, atype) in to_send {
        let alert = json!({ "serverId": server_id, "type": atype, "fullName": full, "at": now });
        notifier::handle_alert(app, server_id, &alert).await;
    }
}

/// Metrik örneğini kaydeder (10s throttle). Due değilse host metriği bile çekmez.
async fn maybe_record_metrics(
    app: &AppHandle,
    server_id: &str,
    server: &serde_json::Value,
    snap: &serde_json::Value,
) {
    let now = now_ms();
    {
        let state = app.state::<RealtimeState>();
        let mut last = state.metric_last.lock().unwrap();
        let due = now - last.get(server_id).copied().unwrap_or(0) >= METRIC_MIN_INTERVAL_MS;
        if !due {
            return;
        }
        last.insert(server_id.to_string(), now);
    }
    let host = service::host_metrics(server)
        .await
        .ok()
        .filter(|v| !v.is_null());
    if let Ok(pool) = db::pool(app).await {
        let _ = metrics::record(&pool, server_id, snap, host.as_ref(), now).await;
    }
}

/// Bir sunucuya abone ol — poller yoksa başlat, varsa refcount artır.
#[tauri::command]
pub async fn rt_subscribe(app: AppHandle, server_id: String) -> AppResult<()> {
    let state = app.state::<RealtimeState>();
    let mut map = state.pollers.lock().unwrap();
    if let Some(entry) = map.get_mut(&server_id) {
        entry.refcount += 1;
        return Ok(());
    }
    let app_clone = app.clone();
    let sid = server_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        poll_loop(app_clone, sid).await;
    });
    map.insert(
        server_id,
        PollerEntry {
            refcount: 1,
            handle,
        },
    );
    Ok(())
}

/// Abonelikten çık — son abone çıkınca poller görevini iptal et.
#[tauri::command]
pub async fn rt_unsubscribe(app: AppHandle, server_id: String) -> AppResult<()> {
    let state = app.state::<RealtimeState>();
    let mut map = state.pollers.lock().unwrap();
    if let Some(entry) = map.get_mut(&server_id) {
        if entry.refcount > 1 {
            entry.refcount -= 1;
        } else if let Some(removed) = map.remove(&server_id) {
            removed.handle.abort();
        }
    }
    Ok(())
}

// --- Canlı log kuyruklama ---------------------------------------------------

/// Ana supervisord log'u: her tick tam görüntüyü değiştirir (2s).
async fn daemon_log_loop(app: AppHandle, server_id: String) {
    let server = match full_server(&app, &server_id).await {
        Ok(s) => s,
        Err(e) => {
            let _ = app.emit("rt:log:error", json!({ "error": e.error }));
            return;
        }
    };
    loop {
        match service::tail_daemon_log(&server).await {
            Ok(data) => {
                let _ = app.emit("rt:log:chunk", json!({ "data": data, "append": false }));
            }
            Err(e) => {
                let _ = app.emit("rt:log:error", json!({ "error": e.error }));
            }
        }
        tokio::time::sleep(Duration::from_millis(2000)).await;
    }
}

/// Süreç log'u: offset destekliyse artımlı ekle (1.5s), yoksa (docker) tam değiştir.
async fn process_log_loop(app: AppHandle, server_id: String, full_name: String, channel: String) {
    let server = match full_server(&app, &server_id).await {
        Ok(s) => s,
        Err(e) => {
            let _ = app.emit("rt:log:error", json!({ "error": e.error }));
            return;
        }
    };
    let incremental = service::supports_log_offset(&server);
    let mut offset = 0i64;
    let mut first = true;
    loop {
        let use_offset = if incremental { offset } else { 0 };
        match service::tail_log(&server, &full_name, &channel, use_offset, 16384).await {
            Ok(res) => {
                let data = res
                    .get("data")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let new_offset = res.get("offset").and_then(|v| v.as_i64()).unwrap_or(offset);
                offset = new_offset;
                if incremental {
                    if first {
                        let start_offset = (new_offset - data.len() as i64).max(0);
                        let _ = app.emit(
                            "rt:log:chunk",
                            json!({ "data": data, "append": false, "startOffset": start_offset }),
                        );
                    } else if !data.is_empty() {
                        let _ = app.emit("rt:log:chunk", json!({ "data": data, "append": true }));
                    }
                    first = false;
                } else {
                    let _ = app.emit("rt:log:chunk", json!({ "data": data, "append": false }));
                }
            }
            Err(e) => {
                let _ = app.emit("rt:log:error", json!({ "error": e.error }));
            }
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
}

fn set_log_task(state: &RealtimeState, handle: Option<JoinHandle<()>>) {
    let mut slot = state.log_task.lock().unwrap();
    if let Some(old) = slot.take() {
        old.abort();
    }
    *slot = handle;
}

/// Canlı log kuyruklamayı başlat (öncekini iptal eder).
#[tauri::command]
pub async fn rt_log_start(
    app: AppHandle,
    server_id: String,
    full_name: Option<String>,
    channel: Option<String>,
    daemon: Option<bool>,
) -> AppResult<()> {
    let state = app.state::<RealtimeState>();
    let is_daemon = daemon.unwrap_or(false);
    let channel = channel.unwrap_or_else(|| "stdout".to_string());

    if !is_daemon && full_name.is_none() {
        let _ = app.emit(
            "rt:log:error",
            json!({ "error": "Sunucu/işlem bulunamadı" }),
        );
        return Ok(());
    }

    let app_clone = app.clone();
    let handle = if is_daemon {
        tauri::async_runtime::spawn(daemon_log_loop(app_clone, server_id))
    } else {
        let fname = full_name.unwrap_or_default();
        tauri::async_runtime::spawn(process_log_loop(app_clone, server_id, fname, channel))
    };
    set_log_task(state.inner(), Some(handle));
    Ok(())
}

/// Canlı log kuyruklamayı durdur.
#[tauri::command]
pub async fn rt_log_stop(app: AppHandle) -> AppResult<()> {
    let state = app.state::<RealtimeState>();
    set_log_task(state.inner(), None);
    Ok(())
}

/// Supervisor kurulumunu başlatır (arka planda; ilerleme rt:install:* olaylarıyla).
#[tauri::command]
pub async fn rt_install_start(
    app: AppHandle,
    server_id: String,
    sudo_password: Option<String>,
    configure_http: Option<bool>,
) -> AppResult<()> {
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        match full_server(&app2, &server_id).await {
            Ok(server) => {
                installer::install(
                    &app2,
                    &server,
                    &sudo_password.unwrap_or_default(),
                    configure_http.unwrap_or(true),
                )
                .await;
            }
            Err(e) => {
                let _ = app2.emit(
                    "rt:install:result",
                    json!({ "serverId": server_id, "ok": false, "error": e.error }),
                );
            }
        }
    });
    Ok(())
}
