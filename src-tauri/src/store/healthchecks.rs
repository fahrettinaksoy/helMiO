//! Sağlık kontrolleri store'u (sunucuya bağlı). Secret alan yok.

use serde_json::{Map, Value};
use sqlx::{Pool, Row, Sqlite};

use super::{new_id, now_iso};
use crate::error::{AppError, AppResult};

fn as_object(v: &Value) -> AppResult<&Map<String, Value>> {
    v.as_object()
        .ok_or_else(|| AppError::new("Geçersiz sağlık kontrolü verisi"))
}

fn row_to_obj(row: &sqlx::sqlite::SqliteRow) -> Value {
    let config_str: String = row.get("config");
    let config: Value = serde_json::from_str(&config_str).unwrap_or(Value::Object(Map::new()));
    let mut out = Map::new();
    out.insert("id".into(), Value::String(row.get("id")));
    out.insert("serverId".into(), Value::String(row.get("server_id")));
    out.insert("target".into(), Value::String(row.get("target")));
    out.insert("type".into(), Value::String(row.get("type")));
    out.insert(
        "enabled".into(),
        Value::Bool(row.get::<i64, _>("enabled") != 0),
    );
    out.insert(
        "intervalSec".into(),
        Value::from(row.get::<i64, _>("interval_sec")),
    );
    out.insert(
        "failureThreshold".into(),
        Value::from(row.get::<i64, _>("failure_threshold")),
    );
    out.insert("action".into(), Value::String(row.get("action")));
    out.insert("config".into(), config);
    out.insert("createdAt".into(), Value::String(row.get("created_at")));
    out.insert("updatedAt".into(), Value::String(row.get("updated_at")));
    out.insert("lastCheckedAt".into(), opt_str(row.get("last_checked_at")));
    out.insert("lastStatus".into(), Value::String(row.get("last_status")));
    out.insert(
        "consecutiveFailures".into(),
        Value::from(row.get::<i64, _>("consecutive_failures")),
    );
    out.insert("lastError".into(), opt_str(row.get("last_error")));
    out.insert("lastActionAt".into(), opt_str(row.get("last_action_at")));
    Value::Object(out)
}

fn opt_str(v: Option<String>) -> Value {
    v.map_or(Value::Null, Value::String)
}

/// Tüm sunuculardaki sağlık kontrolleri (overview + scheduler için).
pub async fn list_all(pool: &Pool<Sqlite>) -> AppResult<Vec<Value>> {
    let rows = sqlx::query("SELECT * FROM healthchecks ORDER BY created_at")
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::new(format!("Sağlık kontrolleri okunamadı: {e}")))?;
    Ok(rows.iter().map(row_to_obj).collect())
}

pub async fn list_by_server(pool: &Pool<Sqlite>, server_id: &str) -> AppResult<Value> {
    let rows = sqlx::query("SELECT * FROM healthchecks WHERE server_id = ? ORDER BY created_at")
        .bind(server_id)
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::new(format!("Sağlık kontrolleri okunamadı: {e}")))?;
    Ok(Value::Array(rows.iter().map(row_to_obj).collect()))
}

pub async fn get(pool: &Pool<Sqlite>, id: &str) -> AppResult<Value> {
    let row = sqlx::query("SELECT * FROM healthchecks WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| AppError::new(format!("Sağlık kontrolü okunamadı: {e}")))?
        .ok_or_else(|| AppError::new("Sağlık kontrolü bulunamadı"))?;
    Ok(row_to_obj(&row))
}

pub async fn create(pool: &Pool<Sqlite>, server_id: &str, data: &Value) -> AppResult<Value> {
    let obj = as_object(data)?;
    let target = obj
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let type_ = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let enabled = obj.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let interval = obj.get("intervalSec").and_then(Value::as_i64).unwrap_or(30);
    let threshold = obj
        .get("failureThreshold")
        .and_then(Value::as_i64)
        .unwrap_or(3);
    let action = obj
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("restart")
        .to_string();
    let config = obj
        .get("config")
        .cloned()
        .unwrap_or(Value::Object(Map::new()));

    let id = new_id();
    let now = now_iso();
    sqlx::query(
        "INSERT INTO healthchecks
         (id, server_id, target, type, enabled, interval_sec, failure_threshold, action, config,
          created_at, updated_at, last_status, consecutive_failures)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 0)",
    )
    .bind(&id)
    .bind(server_id)
    .bind(&target)
    .bind(&type_)
    .bind(enabled as i64)
    .bind(interval)
    .bind(threshold)
    .bind(&action)
    .bind(serde_json::to_string(&config)?)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| AppError::new(format!("Sağlık kontrolü oluşturulamadı: {e}")))?;

    get(pool, &id).await
}

pub async fn update(
    pool: &Pool<Sqlite>,
    server_id: &str,
    id: &str,
    data: &Value,
) -> AppResult<Value> {
    // Kayıt bu sunucuya mı ait? (yanlış sunucu → 404)
    let existing = get(pool, id).await?;
    if existing.get("serverId").and_then(Value::as_str) != Some(server_id) {
        return Err(AppError::new("Sağlık kontrolü bulunamadı"));
    }

    let obj = as_object(data)?;
    let target = obj
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let type_ = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let enabled = obj.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let interval = obj.get("intervalSec").and_then(Value::as_i64).unwrap_or(30);
    let threshold = obj
        .get("failureThreshold")
        .and_then(Value::as_i64)
        .unwrap_or(3);
    let action = obj
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("restart")
        .to_string();
    let config = obj
        .get("config")
        .cloned()
        .unwrap_or(Value::Object(Map::new()));

    sqlx::query(
        "UPDATE healthchecks SET target = ?, type = ?, enabled = ?, interval_sec = ?,
         failure_threshold = ?, action = ?, config = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&target)
    .bind(&type_)
    .bind(enabled as i64)
    .bind(interval)
    .bind(threshold)
    .bind(&action)
    .bind(serde_json::to_string(&config)?)
    .bind(now_iso())
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| AppError::new(format!("Sağlık kontrolü güncellenemedi: {e}")))?;

    get(pool, id).await
}

/// Prob sonucunu yazar. `last_action_at=None` → mevcut değeri korur.
pub async fn record_result(
    pool: &Pool<Sqlite>,
    id: &str,
    last_checked_at: &str,
    last_status: &str,
    consecutive_failures: i64,
    last_error: Option<&str>,
    last_action_at: Option<&str>,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE healthchecks SET last_checked_at = ?, last_status = ?, consecutive_failures = ?,
         last_error = ?, last_action_at = COALESCE(?, last_action_at) WHERE id = ?",
    )
    .bind(last_checked_at)
    .bind(last_status)
    .bind(consecutive_failures)
    .bind(last_error)
    .bind(last_action_at)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| AppError::new(format!("Sağlık kontrolü sonucu yazılamadı: {e}")))?;
    Ok(())
}

pub async fn remove(pool: &Pool<Sqlite>, server_id: &str, id: &str) -> AppResult<()> {
    let res = sqlx::query("DELETE FROM healthchecks WHERE id = ? AND server_id = ?")
        .bind(id)
        .bind(server_id)
        .execute(pool)
        .await
        .map_err(|e| AppError::new(format!("Sağlık kontrolü silinemedi: {e}")))?;
    if res.rows_affected() == 0 {
        return Err(AppError::new("Sağlık kontrolü bulunamadı"));
    }
    Ok(())
}
