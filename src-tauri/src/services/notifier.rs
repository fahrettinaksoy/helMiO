//! Bildirim gönderici — türetilmiş alarmları dış kanallara (Slack/Discord/
//! Telegram/webhook/e-posta) iletir. Eski notifierService.js portu.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::crypto::SecretBox;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::store::{audit, channels, servers};

const DEDUP_WINDOW_MS: i64 = 60000;

/// Aynı alarmın iki yoldan (poll + eventlistener) çift bildirim yapmasını önler.
pub struct NotifierState {
    recent: Mutex<HashMap<String, i64>>,
}

impl NotifierState {
    pub fn new() -> Self {
        Self {
            recent: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for NotifierState {
    fn default() -> Self {
        Self::new()
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn is_duplicate(state: &NotifierState, key: &str, now: i64) -> bool {
    let mut recent = state.recent.lock().unwrap();
    if let Some(last) = recent.get(key) {
        if now - last < DEDUP_WINDOW_MS {
            return true;
        }
    }
    recent.insert(key.to_string(), now);
    if recent.len() > 1000 {
        recent.retain(|_, t| now - *t <= DEDUP_WINDOW_MS);
    }
    false
}

fn emoji(t: &str) -> &'static str {
    match t {
        "fatal" => "🔴",
        "flapping" => "🟠",
        "healthcheck" => "🩺",
        _ => "⚠️",
    }
}
fn verb(t: &str) -> &'static str {
    match t {
        "fatal" => "FATAL durumuna düştü",
        "flapping" => "sürekli yeniden başlıyor (flapping)",
        "healthcheck" => "sağlık kontrolünden geçemedi",
        _ => "uyarı oluşturdu",
    }
}

struct Msg {
    title: String,
    text: String,
}

fn describe(alert: &Value, server_name: &str) -> Msg {
    let t = alert.get("type").and_then(Value::as_str).unwrap_or("");
    let e = emoji(t);
    let v = alert
        .get("detail")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| verb(t).to_string());
    let proc = alert
        .get("fullName")
        .and_then(Value::as_str)
        .unwrap_or("bir süreç");
    Msg {
        title: format!("{e} Helmio uyarısı — {server_name}"),
        text: format!("{e} [{server_name}] {proc} {v}"),
    }
}

async fn post_json(url: &str, body: &Value) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(url)
        .json(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    Ok(())
}

async fn send_email(cfg: &Value, subject: &str, text: &str) -> Result<(), String> {
    use lettre::message::Mailbox;
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

    let s = |k: &str| cfg.get(k).and_then(Value::as_str).unwrap_or("");
    let host = s("smtpHost");
    let port = cfg.get("smtpPort").and_then(Value::as_i64).unwrap_or(587) as u16;
    let secure = cfg.get("secure").and_then(Value::as_bool).unwrap_or(false);

    let from: Mailbox = s("from")
        .parse()
        .map_err(|_| "geçersiz 'from' adresi".to_string())?;
    let mut builder = Message::builder().from(from).subject(subject);
    for addr in s("to").split(',') {
        let a = addr.trim();
        if !a.is_empty() {
            let mb: Mailbox = a.parse().map_err(|_| format!("geçersiz alıcı: {a}"))?;
            builder = builder.to(mb);
        }
    }
    let email = builder.body(text.to_string()).map_err(|e| e.to_string())?;

    let mut tb = if secure {
        AsyncSmtpTransport::<Tokio1Executor>::relay(host).map_err(|e| e.to_string())?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
    }
    .port(port);
    let user = s("user");
    if !user.is_empty() {
        tb = tb.credentials(Credentials::new(user.to_string(), s("pass").to_string()));
    }
    let mailer = tb.build();
    mailer.send(email).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn dispatch(
    channel: &Value,
    msg: &Msg,
    alert: &Value,
    server_name: &str,
) -> Result<(), String> {
    let cfg = channel.get("config").cloned().unwrap_or(json!({}));
    let s = |k: &str| cfg.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match channel.get("type").and_then(Value::as_str) {
        Some("slack") => post_json(&s("webhookUrl"), &json!({ "text": msg.text })).await,
        Some("discord") => post_json(&s("webhookUrl"), &json!({ "content": msg.text })).await,
        Some("telegram") => {
            let url = format!("https://api.telegram.org/bot{}/sendMessage", s("botToken"));
            post_json(&url, &json!({ "chat_id": s("chatId"), "text": msg.text })).await
        }
        Some("webhook") => {
            post_json(
                &s("url"),
                &json!({
                    "source": "helmio",
                    "type": alert.get("type").cloned().unwrap_or(Value::Null),
                    "server": server_name,
                    "serverId": alert.get("serverId").cloned().unwrap_or(Value::Null),
                    "process": alert.get("fullName").cloned().unwrap_or(Value::Null),
                    "at": alert.get("at").cloned().unwrap_or(Value::Null),
                    "message": msg.text,
                }),
            )
            .await
        }
        Some("email") => send_email(&cfg, &msg.title, &msg.text).await,
        other => Err(format!("bilinmeyen kanal türü: {}", other.unwrap_or(""))),
    }
}

/// Bir alarmı uyan kanallara iletir (dedup'lı). realtime poller ve healthcheck
/// tarafından çağrılır.
pub async fn handle_alert(app: &AppHandle, server_id: &str, alert: &Value) {
    let alert_type = alert.get("type").and_then(Value::as_str).unwrap_or("");
    let full_name = alert.get("fullName").and_then(Value::as_str).unwrap_or("");
    let now = alert
        .get("at")
        .and_then(Value::as_i64)
        .unwrap_or_else(now_ms);

    {
        let state = app.state::<NotifierState>();
        let key = format!("{server_id}:{full_name}:{alert_type}");
        if is_duplicate(state.inner(), &key, now) {
            return;
        }
    }

    let Ok(pool) = db::pool(app).await else {
        return;
    };
    let sb = app.state::<SecretBox>();
    let matches = match channels::match_channels(&pool, sb.inner(), server_id, alert_type).await {
        Ok(m) if !m.is_empty() => m,
        _ => return,
    };

    let server_name = servers::get_public(&pool, sb.inner(), server_id)
        .await
        .ok()
        .and_then(|s| s.get("name").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| server_id.to_string());

    let mut enriched = alert.clone();
    if let Some(obj) = enriched.as_object_mut() {
        obj.insert("serverId".into(), Value::String(server_id.to_string()));
    }
    let msg = describe(&enriched, &server_name);

    for channel in &matches {
        let cid = channel.get("id").and_then(Value::as_str).unwrap_or("");
        let cname = channel.get("name").and_then(Value::as_str).unwrap_or("");
        let ctype = channel.get("type").and_then(Value::as_str).unwrap_or("");
        match dispatch(channel, &msg, &enriched, &server_name).await {
            Ok(()) => {
                let _ = channels::mark_sent(&pool, cid, None).await;
                audit::record(
                    &pool,
                    "notify.sent",
                    Some(server_id),
                    Some(cname),
                    "ok",
                    Some(&format!("{ctype} · {alert_type} · {full_name}")),
                )
                .await;
            }
            Err(e) => {
                let _ = channels::mark_sent(&pool, cid, Some(&e)).await;
                audit::record(
                    &pool,
                    "notify.failed",
                    Some(server_id),
                    Some(cname),
                    "error",
                    Some(&format!("{ctype}: {e}")),
                )
                .await;
            }
        }
    }
}

/// Bir kanaldan tek seferlik test bildirimi (channels_test komutu).
pub async fn send_test(app: &AppHandle, channel_id: &str) -> AppResult<Value> {
    let pool = db::pool(app).await?;
    let sb = app.state::<SecretBox>();
    let channel = channels::get_full(&pool, sb.inner(), channel_id).await?;
    let name = channel
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("kanal");
    let msg = Msg {
        title: "✅ Helmio test bildirimi".to_string(),
        text: format!("✅ Helmio test bildirimi — \"{name}\" kanalı çalışıyor."),
    };
    let test_alert = json!({ "type": "test", "at": now_ms() });
    dispatch(&channel, &msg, &test_alert, "test")
        .await
        .map_err(AppError::new)?;
    let _ = channels::mark_sent(&pool, channel_id, None).await;
    Ok(json!({ "ok": true }))
}
