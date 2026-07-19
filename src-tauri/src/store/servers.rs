//! Sunucu tanımları store'u. Yönteme özgü alanlar `config` JSON'unda; secret
//! alanlar (parola, privateKey, sshPassword, agentToken) ve ingest_token
//! AES-256-GCM ile şifreli saklanır. Public görünümde secret'lar maskelenir.

use serde_json::{Map, Value};
use sqlx::{Pool, Row, Sqlite};

use super::{new_id, now_iso, MASK};
use crate::crypto::SecretBox;
use crate::error::{AppError, AppResult};

/// `config` içindeki şifrelenecek alanlar (ingest_token ayrı kolonda).
const SECRET_FIELDS: &[&str] = &["password", "privateKey", "sshPassword", "agentToken"];
/// Flat objeden `config`'e taşınMAyacak (kolonlara giden veya üretilen) anahtarlar.
const NON_CONFIG_KEYS: &[&str] = &[
    "id",
    "method",
    "name",
    "createdAt",
    "updatedAt",
    "ingestToken",
];

fn as_object(v: &Value) -> AppResult<&Map<String, Value>> {
    v.as_object()
        .ok_or_else(|| AppError::new("Geçersiz sunucu verisi (nesne bekleniyordu)"))
}

fn require_str(obj: &Map<String, Value>, key: &str) -> AppResult<String> {
    obj.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::new(format!("Eksik alan: {key}")))
}

/// Flat girdi objesinden `config` alt-kümesini üretir (kolonlara/üretilenlere
/// giden anahtarlar hariç).
fn config_from_input(obj: &Map<String, Value>) -> Map<String, Value> {
    obj.iter()
        .filter(|(k, _)| !NON_CONFIG_KEYS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// DB satırını flat sunucu objesine çevirir. `reveal=true` → secret'lar çözülür
/// (connector için); `false` → maskelenir (UI için).
fn row_to_flat(row: &sqlx::sqlite::SqliteRow, sb: &SecretBox, reveal: bool) -> Value {
    let id: String = row.get("id");
    let method: String = row.get("method");
    let name: String = row.get("name");
    let config_str: String = row.get("config");
    let ingest: Option<String> = row.get("ingest_token");
    let created: String = row.get("created_at");
    let updated: String = row.get("updated_at");

    let mut cfg: Map<String, Value> =
        serde_json::from_str(&config_str).unwrap_or_else(|_| Map::new());

    for &f in SECRET_FIELDS {
        if let Some(Value::String(s)) = cfg.get(f) {
            if !s.is_empty() {
                let v = if reveal {
                    sb.decrypt(s)
                } else {
                    MASK.to_string()
                };
                cfg.insert(f.to_string(), Value::String(v));
            }
        }
    }

    let mut out = cfg;
    out.insert("id".into(), Value::String(id));
    out.insert("method".into(), Value::String(method));
    out.insert("name".into(), Value::String(name));
    out.insert("createdAt".into(), Value::String(created));
    out.insert("updatedAt".into(), Value::String(updated));
    match ingest {
        Some(t) if !t.is_empty() => {
            let v = if reveal {
                sb.decrypt(&t)
            } else {
                MASK.to_string()
            };
            out.insert("ingestToken".into(), Value::String(v));
        }
        _ => {
            out.insert("ingestToken".into(), Value::Null);
        }
    }
    Value::Object(out)
}

pub async fn list(pool: &Pool<Sqlite>, sb: &SecretBox) -> AppResult<Value> {
    let rows = sqlx::query("SELECT * FROM servers ORDER BY created_at")
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::new(format!("Sunucular okunamadı: {e}")))?;
    let list: Vec<Value> = rows.iter().map(|r| row_to_flat(r, sb, false)).collect();
    Ok(Value::Array(list))
}

async fn fetch_row(pool: &Pool<Sqlite>, id: &str) -> AppResult<sqlx::sqlite::SqliteRow> {
    sqlx::query("SELECT * FROM servers WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| AppError::new(format!("Sunucu okunamadı: {e}")))?
        .ok_or_else(|| AppError::new("Sunucu bulunamadı"))
}

pub async fn get_public(pool: &Pool<Sqlite>, sb: &SecretBox, id: &str) -> AppResult<Value> {
    Ok(row_to_flat(&fetch_row(pool, id).await?, sb, false))
}

/// Connector için secret'ları çözülmüş flat sunucu (Faz 3).
#[allow(dead_code)]
pub async fn get_full(pool: &Pool<Sqlite>, sb: &SecretBox, id: &str) -> AppResult<Value> {
    Ok(row_to_flat(&fetch_row(pool, id).await?, sb, true))
}

pub async fn create(pool: &Pool<Sqlite>, sb: &SecretBox, data: &Value) -> AppResult<Value> {
    let obj = as_object(data)?;
    let method = require_str(obj, "method")?;
    let name = require_str(obj, "name")?;

    let mut cfg = config_from_input(obj);
    let enc = sb.encrypt_fields(&cfg, SECRET_FIELDS);
    cfg = enc;

    let id = new_id();
    let now = now_iso();
    let config_str = serde_json::to_string(&Value::Object(cfg))?;

    sqlx::query(
        "INSERT INTO servers (id, method, name, config, ingest_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)",
    )
    .bind(&id)
    .bind(&method)
    .bind(&name)
    .bind(&config_str)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| AppError::new(format!("Sunucu oluşturulamadı: {e}")))?;

    get_public(pool, sb, &id).await
}

pub async fn update(
    pool: &Pool<Sqlite>,
    sb: &SecretBox,
    id: &str,
    patch: &Value,
) -> AppResult<Value> {
    let existing = fetch_row(pool, id).await?;
    let existing_cfg_str: String = existing.get("config");
    let existing_cfg: Map<String, Value> =
        serde_json::from_str(&existing_cfg_str).unwrap_or_else(|_| Map::new());

    let obj = as_object(patch)?;
    let method = require_str(obj, "method")?;
    let name = require_str(obj, "name")?;

    let mut cfg = config_from_input(obj);
    // Secret alanlar: maske gelirse ESKİ şifreli değeri koru; yeni değer gelirse şifrele.
    for &f in SECRET_FIELDS {
        match cfg.get(f).and_then(Value::as_str) {
            Some(v) if v == MASK => match existing_cfg.get(f) {
                Some(old) => {
                    cfg.insert(f.to_string(), old.clone());
                }
                None => {
                    cfg.remove(f);
                }
            },
            Some(v) if !v.is_empty() => {
                cfg.insert(f.to_string(), Value::String(sb.encrypt(v)));
            }
            _ => {}
        }
    }

    let config_str = serde_json::to_string(&Value::Object(cfg))?;
    let now = now_iso();

    sqlx::query("UPDATE servers SET method = ?, name = ?, config = ?, updated_at = ? WHERE id = ?")
        .bind(&method)
        .bind(&name)
        .bind(&config_str)
        .bind(&now)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| AppError::new(format!("Sunucu güncellenemedi: {e}")))?;

    get_public(pool, sb, id).await
}

pub async fn remove(pool: &Pool<Sqlite>, id: &str) -> AppResult<()> {
    let res = sqlx::query("DELETE FROM servers WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| AppError::new(format!("Sunucu silinemedi: {e}")))?;
    if res.rows_affected() == 0 {
        return Err(AppError::new("Sunucu bulunamadı"));
    }
    Ok(())
}

/// Ad-hoc test verisindeki maskeli secret'ları, kayıtlı sunucudan (id varsa)
/// çözülmüş değerlerle doldurur. id yoksa veri olduğu gibi döner (form düz-metin).
pub async fn resolve_secrets(
    pool: &Pool<Sqlite>,
    sb: &SecretBox,
    data: &Value,
) -> AppResult<Value> {
    let mut obj = data.as_object().cloned().unwrap_or_default();
    if let Some(id) = obj.get("id").and_then(Value::as_str).map(str::to_string) {
        if let Ok(full) = get_full(pool, sb, &id).await {
            if let Some(fobj) = full.as_object() {
                for &f in SECRET_FIELDS.iter().chain(&["ingestToken"]) {
                    if obj.get(f).and_then(Value::as_str) == Some(MASK) {
                        if let Some(v) = fobj.get(f) {
                            obj.insert(f.to_string(), v.clone());
                        }
                    }
                }
            }
        }
    }
    Ok(Value::Object(obj))
}

/// ingest_token'ı şifreleyip kaydeder (eventlistener akışı — Faz 6/7).
#[allow(dead_code)]
pub async fn set_ingest_token(
    pool: &Pool<Sqlite>,
    sb: &SecretBox,
    id: &str,
    token: &str,
) -> AppResult<()> {
    let enc = sb.encrypt(token);
    sqlx::query("UPDATE servers SET ingest_token = ?, updated_at = ? WHERE id = ?")
        .bind(&enc)
        .bind(now_iso())
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| AppError::new(format!("ingest token kaydedilemedi: {e}")))?;
    Ok(())
}
