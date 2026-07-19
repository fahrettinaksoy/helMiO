//! Toplu işlem komutları (eski `/api/servers/:id/bulk/...`).

use serde_json::Value;
use tauri::AppHandle;

use crate::commands::full_server;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::store::audit;
use crate::supervisor::service;

#[tauri::command]
pub async fn bulk_start_all(app: AppHandle, sid: String) -> AppResult<Value> {
    let server = full_server(&app, &sid).await?;
    let out = service::start_all(&server).await?;
    audit::record(
        &db::pool(&app).await?,
        "bulk.start_all",
        Some(&sid),
        None,
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn bulk_stop_all(app: AppHandle, sid: String) -> AppResult<Value> {
    let server = full_server(&app, &sid).await?;
    let out = service::stop_all(&server).await?;
    audit::record(
        &db::pool(&app).await?,
        "bulk.stop_all",
        Some(&sid),
        None,
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn bulk_restart_all(app: AppHandle, sid: String) -> AppResult<Value> {
    let server = full_server(&app, &sid).await?;
    let out = service::restart_all(&server).await?;
    audit::record(
        &db::pool(&app).await?,
        "bulk.restart_all",
        Some(&sid),
        None,
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn bulk_signal_all(app: AppHandle, sid: String, signal: String) -> AppResult<Value> {
    if signal.is_empty() {
        return Err(AppError::new("Sinyal gerekli."));
    }
    let server = full_server(&app, &sid).await?;
    let out = service::signal_all(&server, &signal).await?;
    audit::record(
        &db::pool(&app).await?,
        "bulk.signal_all",
        Some(&sid),
        None,
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn bulk_clear_all_logs(app: AppHandle, sid: String) -> AppResult<Value> {
    let server = full_server(&app, &sid).await?;
    let out = service::clear_all_logs(&server).await?;
    audit::record(
        &db::pool(&app).await?,
        "bulk.clear_all_logs",
        Some(&sid),
        None,
        "ok",
        None,
    )
    .await;
    Ok(out)
}
