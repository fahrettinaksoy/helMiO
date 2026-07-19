//! Süreç kontrol komutları (eski `/api/servers/:id/processes/...`).

use serde_json::Value;
use tauri::AppHandle;

use crate::commands::full_server;
use crate::db;
use crate::error::AppResult;
use crate::store::audit;
use crate::supervisor::service;

#[tauri::command]
pub async fn process_start(app: AppHandle, sid: String, full_name: String) -> AppResult<Value> {
    let server = full_server(&app, &sid).await?;
    let out = service::start(&server, &full_name).await?;
    audit::record(
        &db::pool(&app).await?,
        "process.start",
        Some(&sid),
        Some(&full_name),
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn process_stop(app: AppHandle, sid: String, full_name: String) -> AppResult<Value> {
    let server = full_server(&app, &sid).await?;
    let out = service::stop(&server, &full_name).await?;
    audit::record(
        &db::pool(&app).await?,
        "process.stop",
        Some(&sid),
        Some(&full_name),
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn process_restart(app: AppHandle, sid: String, full_name: String) -> AppResult<Value> {
    let server = full_server(&app, &sid).await?;
    let out = service::restart(&server, &full_name).await?;
    audit::record(
        &db::pool(&app).await?,
        "process.restart",
        Some(&sid),
        Some(&full_name),
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn process_signal(
    app: AppHandle,
    sid: String,
    full_name: String,
    signal: String,
) -> AppResult<Value> {
    if signal.is_empty() {
        return Err(crate::error::AppError::new("Sinyal gerekli."));
    }
    let server = full_server(&app, &sid).await?;
    let out = service::signal(&server, &full_name, &signal).await?;
    let detail = format!("SIG{signal}");
    audit::record(
        &db::pool(&app).await?,
        "process.signal",
        Some(&sid),
        Some(&full_name),
        "ok",
        Some(&detail),
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn process_send_stdin(
    app: AppHandle,
    sid: String,
    full_name: String,
    chars: String,
) -> AppResult<Value> {
    let server = full_server(&app, &sid).await?;
    let out = service::send_stdin(&server, &full_name, &chars).await?;
    audit::record(
        &db::pool(&app).await?,
        "process.stdin",
        Some(&sid),
        Some(&full_name),
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn process_clear_log(app: AppHandle, sid: String, full_name: String) -> AppResult<Value> {
    let server = full_server(&app, &sid).await?;
    let out = service::clear_logs(&server, &full_name).await?;
    audit::record(
        &db::pool(&app).await?,
        "process.log_clear",
        Some(&sid),
        Some(&full_name),
        "ok",
        None,
    )
    .await;
    Ok(out)
}

/// Log okuma (offset tabanlı geriye kaydırma) — { data, startOffset, length }.
#[tauri::command]
pub async fn process_read_log(
    app: AppHandle,
    sid: String,
    full_name: String,
    channel: String,
    offset: i64,
    length: i64,
) -> AppResult<Value> {
    let server = full_server(&app, &sid).await?;
    service::read_process_log(&server, &full_name, &channel, offset, length).await
}

/// Tüm log'u indirir — frontend metni Blob'a sarar; bu yüzden düz metin döner.
#[tauri::command]
pub async fn process_download_log(
    app: AppHandle,
    sid: String,
    full_name: String,
    channel: String,
) -> AppResult<String> {
    let server = full_server(&app, &sid).await?;
    let out = service::download_process_log(&server, &full_name, &channel).await?;
    Ok(out
        .get("data")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}
