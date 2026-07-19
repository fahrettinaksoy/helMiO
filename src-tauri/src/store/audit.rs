//! Denetim günlüğü store'u. Tek-kullanıcı sürümünde actor alanları yok — yalnız
//! eylem geçmişi (ne, hangi sunucu, sonuç, ne zaman).

use serde_json::{Map, Value};
use sqlx::{Pool, Row, Sqlite};

use super::now_iso;
use crate::error::{AppError, AppResult};

fn row_to_obj(row: &sqlx::sqlite::SqliteRow) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), Value::from(row.get::<i64, _>("id")));
    out.insert("at".into(), Value::String(row.get("at")));
    out.insert("action".into(), Value::String(row.get("action")));
    out.insert("serverId".into(), opt(row.get("server_id")));
    out.insert("target".into(), opt(row.get("target")));
    out.insert("status".into(), Value::String(row.get("status")));
    out.insert("detail".into(), opt(row.get("detail")));
    Value::Object(out)
}

fn opt(v: Option<String>) -> Value {
    v.map_or(Value::Null, Value::String)
}

/// Eski `GET /audit`: `{ total, offset, limit, items }`, en yeni önce.
/// Desteklenen filtreler: action, serverId, status, limit(≤500), offset.
pub async fn query(pool: &Pool<Sqlite>, params: &Value) -> AppResult<Value> {
    let p = params.as_object().cloned().unwrap_or_default();
    let action = p.get("action").and_then(Value::as_str);
    let server_id = p.get("serverId").and_then(Value::as_str);
    let status = p.get("status").and_then(Value::as_str);
    let limit = p
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(200)
        .clamp(1, 500);
    let offset = p.get("offset").and_then(Value::as_i64).unwrap_or(0).max(0);

    // Dinamik WHERE — opsiyonel filtreler.
    let mut where_sql = String::from("WHERE 1=1");
    if action.is_some() {
        where_sql.push_str(" AND action = ?");
    }
    if server_id.is_some() {
        where_sql.push_str(" AND server_id = ?");
    }
    if status.is_some() {
        where_sql.push_str(" AND status = ?");
    }

    // Toplam sayı.
    let count_sql = format!("SELECT COUNT(*) AS c FROM audit {where_sql}");
    let mut count_q = sqlx::query(&count_sql);
    for v in [action, server_id, status].into_iter().flatten() {
        count_q = count_q.bind(v.to_string());
    }
    let total: i64 = count_q
        .fetch_one(pool)
        .await
        .map_err(|e| AppError::new(format!("Denetim günlüğü sayılamadı: {e}")))?
        .get("c");

    // Sayfa.
    let list_sql = format!("SELECT * FROM audit {where_sql} ORDER BY id DESC LIMIT ? OFFSET ?");
    let mut list_q = sqlx::query(&list_sql);
    for v in [action, server_id, status].into_iter().flatten() {
        list_q = list_q.bind(v.to_string());
    }
    let rows = list_q
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::new(format!("Denetim günlüğü okunamadı: {e}")))?;

    let items: Vec<Value> = rows.iter().map(row_to_obj).collect();
    Ok(serde_json::json!({
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": items,
    }))
}

/// Bir denetim kaydı ekler (diğer fazlar eylemleri buraya yazar). Asla panik etmez.
pub async fn record(
    pool: &Pool<Sqlite>,
    action: &str,
    server_id: Option<&str>,
    target: Option<&str>,
    status: &str,
    detail: Option<&str>,
) {
    let res = sqlx::query(
        "INSERT INTO audit (at, action, server_id, target, status, detail) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(now_iso())
    .bind(action)
    .bind(server_id)
    .bind(target)
    .bind(status)
    .bind(detail)
    .execute(pool)
    .await;
    if let Err(e) = res {
        log::warn!("[helmio] denetim kaydı yazılamadı: {e}");
    }
}
