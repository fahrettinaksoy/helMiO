//! Sağlık kontrolü komutları (eski `/api/servers/:id/healthchecks`).

use serde_json::Value;
use tauri::AppHandle;

use crate::commands::full_server;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::meta;
use crate::services::healthcheck as hc;
use crate::store::{audit, healthchecks};

#[tauri::command]
pub async fn servers_healthcheck_meta() -> AppResult<Value> {
    Ok(meta::healthcheck_meta())
}

#[tauri::command]
pub async fn servers_healthchecks(app: AppHandle, id: String) -> AppResult<Value> {
    let pool = db::pool(&app).await?;
    healthchecks::list_by_server(&pool, &id).await
}

#[tauri::command]
pub async fn servers_healthcheck_create(
    app: AppHandle,
    id: String,
    data: Value,
) -> AppResult<Value> {
    let pool = db::pool(&app).await?;
    let out = healthchecks::create(&pool, &id, &data).await?;
    audit::record(&pool, "healthcheck.create", Some(&id), None, "ok", None).await;
    hc::reload(&app).await;
    Ok(out)
}

#[tauri::command]
pub async fn servers_healthcheck_update(
    app: AppHandle,
    id: String,
    hid: String,
    data: Value,
) -> AppResult<Value> {
    let pool = db::pool(&app).await?;
    let out = healthchecks::update(&pool, &id, &hid, &data).await?;
    audit::record(
        &pool,
        "healthcheck.update",
        Some(&id),
        Some(&hid),
        "ok",
        None,
    )
    .await;
    hc::reload(&app).await;
    Ok(out)
}

#[tauri::command]
pub async fn servers_healthcheck_remove(app: AppHandle, id: String, hid: String) -> AppResult<()> {
    let pool = db::pool(&app).await?;
    healthchecks::remove(&pool, &id, &hid).await?;
    audit::record(
        &pool,
        "healthcheck.delete",
        Some(&id),
        Some(&hid),
        "ok",
        None,
    )
    .await;
    hc::reload(&app).await;
    Ok(())
}

/// Bir kontrolü hemen çalıştır (durum değiştirmez) — sonucu döndürür.
#[tauri::command]
pub async fn servers_healthcheck_run(app: AppHandle, id: String, hid: String) -> AppResult<Value> {
    let pool = db::pool(&app).await?;
    let check = healthchecks::get(&pool, &hid).await?;
    if check.get("serverId").and_then(Value::as_str) != Some(&id) {
        return Err(AppError::new("Sağlık kontrolü bulunamadı"));
    }
    let server = if check.get("type").and_then(Value::as_str) == Some("script") {
        full_server(&app, &id).await.ok()
    } else {
        None
    };
    Ok(hc::probe(&check, server.as_ref()).await)
}
