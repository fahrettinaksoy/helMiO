//! Bildirim kanalları store'u. `config` içindeki secret anahtarlar (webhook
//! url'leri, bot token'ları, SMTP kimlikleri) AES-256-GCM ile şifreli saklanır;
//! public görünümde maskelenir.

use serde_json::{Map, Value};
use sqlx::{Pool, Row, Sqlite};

use super::{new_id, now_iso, MASK};
use crate::crypto::SecretBox;
use crate::error::{AppError, AppResult};

const SECRET_KEYS: &[&str] = &["webhookUrl", "url", "botToken", "pass", "password"];

fn as_object(v: &Value) -> AppResult<&Map<String, Value>> {
    v.as_object()
        .ok_or_else(|| AppError::new("Geçersiz kanal verisi (nesne bekleniyordu)"))
}

fn map_secrets<F: Fn(&str) -> String>(cfg: &mut Map<String, Value>, f: F) {
    for &k in SECRET_KEYS {
        if let Some(Value::String(s)) = cfg.get(k) {
            if !s.is_empty() {
                let v = f(s);
                cfg.insert(k.to_string(), Value::String(v));
            }
        }
    }
}

fn row_to_obj(row: &sqlx::sqlite::SqliteRow, sb: &SecretBox, reveal: bool) -> Value {
    let id: String = row.get("id");
    let type_: String = row.get("type");
    let name: String = row.get("name");
    let enabled: i64 = row.get("enabled");
    let config_str: String = row.get("config");
    let filters_str: String = row.get("filters");
    let created: String = row.get("created_at");
    let updated: String = row.get("updated_at");
    let last_sent: Option<String> = row.get("last_sent_at");
    let last_error: Option<String> = row.get("last_error");

    let mut cfg: Map<String, Value> = serde_json::from_str(&config_str).unwrap_or_default();
    if reveal {
        map_secrets(&mut cfg, |s| sb.decrypt(s));
    } else {
        map_secrets(&mut cfg, |_| MASK.to_string());
    }
    let filters: Value = serde_json::from_str(&filters_str).unwrap_or(Value::Object(Map::new()));

    let mut out = Map::new();
    out.insert("id".into(), Value::String(id));
    out.insert("type".into(), Value::String(type_));
    out.insert("name".into(), Value::String(name));
    out.insert("enabled".into(), Value::Bool(enabled != 0));
    out.insert("config".into(), Value::Object(cfg));
    out.insert("filters".into(), filters);
    out.insert("createdAt".into(), Value::String(created));
    out.insert("updatedAt".into(), Value::String(updated));
    out.insert(
        "lastSentAt".into(),
        last_sent.map_or(Value::Null, Value::String),
    );
    out.insert(
        "lastError".into(),
        last_error.map_or(Value::Null, Value::String),
    );
    Value::Object(out)
}

pub async fn list(pool: &Pool<Sqlite>, sb: &SecretBox) -> AppResult<Value> {
    let rows = sqlx::query("SELECT * FROM channels ORDER BY created_at")
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::new(format!("Kanallar okunamadı: {e}")))?;
    Ok(Value::Array(
        rows.iter().map(|r| row_to_obj(r, sb, false)).collect(),
    ))
}

async fn fetch_row(pool: &Pool<Sqlite>, id: &str) -> AppResult<sqlx::sqlite::SqliteRow> {
    sqlx::query("SELECT * FROM channels WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| AppError::new(format!("Kanal okunamadı: {e}")))?
        .ok_or_else(|| AppError::new("Kanal bulunamadı"))
}

/// Notifier için secret'ları çözülmüş kanal (Faz 6).
pub async fn get_full(pool: &Pool<Sqlite>, sb: &SecretBox, id: &str) -> AppResult<Value> {
    Ok(row_to_obj(&fetch_row(pool, id).await?, sb, true))
}

/// Bir alarma uyan (etkin) kanalları, secret'ları çözülmüş döndürür.
/// Filtre: (serverIds boş VEYA içeriyor) VE (alertTypes boş VEYA içeriyor).
pub async fn match_channels(
    pool: &Pool<Sqlite>,
    sb: &SecretBox,
    server_id: &str,
    alert_type: &str,
) -> AppResult<Vec<Value>> {
    let rows = sqlx::query("SELECT * FROM channels WHERE enabled = 1")
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::new(format!("Kanallar okunamadı: {e}")))?;
    let contains = |arr: Option<&Vec<Value>>, needle: &str| -> bool {
        match arr {
            Some(a) => a.is_empty() || a.iter().any(|v| v.as_str() == Some(needle)),
            None => true,
        }
    };
    let mut out = Vec::new();
    for row in &rows {
        let ch = row_to_obj(row, sb, true);
        let filters = ch.get("filters");
        let server_ids = filters
            .and_then(|f| f.get("serverIds"))
            .and_then(Value::as_array);
        let alert_types = filters
            .and_then(|f| f.get("alertTypes"))
            .and_then(Value::as_array);
        if contains(server_ids, server_id) && contains(alert_types, alert_type) {
            out.push(ch);
        }
    }
    Ok(out)
}

/// Gönderim sonucunu kaydeder (last_sent_at + last_error).
pub async fn mark_sent(pool: &Pool<Sqlite>, id: &str, error: Option<&str>) -> AppResult<()> {
    sqlx::query("UPDATE channels SET last_sent_at = ?, last_error = ? WHERE id = ?")
        .bind(now_iso())
        .bind(error)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| AppError::new(format!("Kanal durumu yazılamadı: {e}")))?;
    Ok(())
}

pub async fn create(pool: &Pool<Sqlite>, sb: &SecretBox, data: &Value) -> AppResult<Value> {
    let obj = as_object(data)?;
    let type_ = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let enabled = obj.get("enabled").and_then(Value::as_bool).unwrap_or(true);

    let mut cfg = obj
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    map_secrets(&mut cfg, |s| sb.encrypt(s));
    let filters = obj
        .get("filters")
        .cloned()
        .unwrap_or(Value::Object(Map::new()));

    let id = new_id();
    let now = now_iso();
    sqlx::query(
        "INSERT INTO channels (id, type, name, enabled, config, filters, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&type_)
    .bind(&name)
    .bind(enabled as i64)
    .bind(serde_json::to_string(&Value::Object(cfg))?)
    .bind(serde_json::to_string(&filters)?)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| AppError::new(format!("Kanal oluşturulamadı: {e}")))?;

    get_full(pool, sb, &id).await.map(mask_view)
}

pub async fn update(
    pool: &Pool<Sqlite>,
    sb: &SecretBox,
    id: &str,
    data: &Value,
) -> AppResult<Value> {
    let existing = fetch_row(pool, id).await?;
    let existing_cfg_str: String = existing.get("config");
    let existing_cfg: Map<String, Value> =
        serde_json::from_str(&existing_cfg_str).unwrap_or_default();

    let obj = as_object(data)?;
    let type_ = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let enabled = obj.get("enabled").and_then(Value::as_bool).unwrap_or(true);

    let mut cfg = obj
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    // Maske gelen secret'ları eski şifreli değerle koru; yenileri şifrele.
    for &k in SECRET_KEYS {
        match cfg.get(k).and_then(Value::as_str) {
            Some(v) if v == MASK => {
                if let Some(old) = existing_cfg.get(k) {
                    cfg.insert(k.to_string(), old.clone());
                } else {
                    cfg.remove(k);
                }
            }
            Some(v) if !v.is_empty() => {
                cfg.insert(k.to_string(), Value::String(sb.encrypt(v)));
            }
            _ => {}
        }
    }
    let filters = obj
        .get("filters")
        .cloned()
        .unwrap_or(Value::Object(Map::new()));

    sqlx::query(
        "UPDATE channels SET type = ?, name = ?, enabled = ?, config = ?, filters = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&type_)
    .bind(&name)
    .bind(enabled as i64)
    .bind(serde_json::to_string(&Value::Object(cfg))?)
    .bind(serde_json::to_string(&filters)?)
    .bind(now_iso())
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| AppError::new(format!("Kanal güncellenemedi: {e}")))?;

    get_full(pool, sb, id).await.map(mask_view)
}

pub async fn remove(pool: &Pool<Sqlite>, id: &str) -> AppResult<()> {
    let res = sqlx::query("DELETE FROM channels WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| AppError::new(format!("Kanal silinemedi: {e}")))?;
    if res.rows_affected() == 0 {
        return Err(AppError::new("Kanal bulunamadı"));
    }
    Ok(())
}

/// Çözülmüş kanaldaki secret'ları maskeleyip public görünüme çevirir.
fn mask_view(mut ch: Value) -> Value {
    if let Some(cfg) = ch.get_mut("config").and_then(Value::as_object_mut) {
        for &k in SECRET_KEYS {
            if let Some(Value::String(s)) = cfg.get(k) {
                if !s.is_empty() {
                    cfg.insert(k.to_string(), Value::String(MASK.to_string()));
                }
            }
        }
    }
    ch
}
