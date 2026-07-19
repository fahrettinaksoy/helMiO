//! Grup kontrol komutları (eski `/api/servers/:id/groups/...`).

use serde_json::Value;
use tauri::AppHandle;

use crate::commands::full_server;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::store::audit;
use crate::supervisor::service;

#[tauri::command]
pub async fn group_start(app: AppHandle, sid: String, group: String) -> AppResult<Value> {
    let server = full_server(&app, &sid).await?;
    let out = service::start_group(&server, &group).await?;
    audit::record(
        &db::pool(&app).await?,
        "group.start",
        Some(&sid),
        Some(&group),
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn group_stop(app: AppHandle, sid: String, group: String) -> AppResult<Value> {
    let server = full_server(&app, &sid).await?;
    let out = service::stop_group(&server, &group).await?;
    audit::record(
        &db::pool(&app).await?,
        "group.stop",
        Some(&sid),
        Some(&group),
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn group_restart(app: AppHandle, sid: String, group: String) -> AppResult<Value> {
    let server = full_server(&app, &sid).await?;
    let out = service::restart_group(&server, &group).await?;
    audit::record(
        &db::pool(&app).await?,
        "group.restart",
        Some(&sid),
        Some(&group),
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn group_signal(
    app: AppHandle,
    sid: String,
    group: String,
    signal: String,
) -> AppResult<Value> {
    if signal.is_empty() {
        return Err(AppError::new("Sinyal gerekli."));
    }
    let server = full_server(&app, &sid).await?;
    let out = service::signal_group(&server, &group, &signal).await?;
    audit::record(
        &db::pool(&app).await?,
        "group.signal",
        Some(&sid),
        Some(&group),
        "ok",
        None,
    )
    .await;
    Ok(out)
}
