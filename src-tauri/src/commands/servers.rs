//! Sunucu komutları (eski `/api/servers` CRUD). Bağlantı/snapshot/daemon/config
//! gibi connector gerektiren uçlar Faz 3-4'te eklenecek.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::commands::full_server;
use crate::crypto::SecretBox;
use crate::error::AppResult;
use crate::store::{audit, metrics, servers};
use crate::supervisor::service::{self, SupervisorRuntime};
use crate::supervisor::{config, create_connector};
use crate::{db, meta};

#[tauri::command]
pub async fn servers_methods() -> AppResult<Value> {
    Ok(meta::connection_methods())
}

#[tauri::command]
pub async fn servers_list(app: AppHandle) -> AppResult<Value> {
    let pool = db::pool(&app).await?;
    let sb = app.state::<SecretBox>();
    servers::list(&pool, sb.inner()).await
}

#[tauri::command]
pub async fn servers_get(app: AppHandle, id: String) -> AppResult<Value> {
    let pool = db::pool(&app).await?;
    let sb = app.state::<SecretBox>();
    servers::get_public(&pool, sb.inner(), &id).await
}

#[tauri::command]
pub async fn servers_create(app: AppHandle, data: Value) -> AppResult<Value> {
    let pool = db::pool(&app).await?;
    let sb = app.state::<SecretBox>();
    let out = servers::create(&pool, sb.inner(), &data).await?;
    let id = out.get("id").and_then(Value::as_str);
    let name = out.get("name").and_then(Value::as_str);
    audit::record(&pool, "server.create", id, name, "ok", None).await;
    Ok(out)
}

#[tauri::command]
pub async fn servers_update(app: AppHandle, id: String, data: Value) -> AppResult<Value> {
    let pool = db::pool(&app).await?;
    let sb = app.state::<SecretBox>();
    let out = servers::update(&pool, sb.inner(), &id, &data).await?;
    audit::record(&pool, "server.update", Some(&id), None, "ok", None).await;
    Ok(out)
}

#[tauri::command]
pub async fn servers_remove(app: AppHandle, id: String) -> AppResult<()> {
    let pool = db::pool(&app).await?;
    servers::remove(&pool, &id).await?;
    audit::record(&pool, "server.delete", Some(&id), None, "ok", None).await;
    Ok(())
}

/// Kayıtlı bir sunucuya ping (connector'ı uçtan uca dener).
#[tauri::command]
pub async fn servers_test(app: AppHandle, id: String) -> AppResult<Value> {
    let pool = db::pool(&app).await?;
    let sb = app.state::<SecretBox>();
    let full = servers::get_full(&pool, sb.inner(), &id).await?;
    let conn = create_connector(&full)?;
    let res = conn.ping().await;
    conn.close().await;
    Ok(ping_view(res?))
}

/// Ad-hoc bağlantı formunu dener (kaydetmeden). Supervisor kurulu olmasa da
/// KANALI test eder. Maskeli secret'lar id ile kayıtlı sunucudan doldurulur.
#[tauri::command]
pub async fn servers_test_connection(app: AppHandle, data: Value) -> AppResult<Value> {
    let pool = db::pool(&app).await?;
    let sb = app.state::<SecretBox>();
    let resolved = servers::resolve_secrets(&pool, sb.inner(), &data).await?;
    Ok(crate::services::installer::test_connection(&resolved).await)
}

/// Sunucuda supervisor tespiti (kurulu/çalışıyor + kurulum seçenekleri).
#[tauri::command]
pub async fn servers_diagnose(app: AppHandle, id: String) -> AppResult<Value> {
    let server = full_server(&app, &id).await?;
    Ok(crate::services::installer::detect(&server).await)
}

fn ping_view(v: Value) -> Value {
    json!({
        "ok": true,
        "version": v.get("version").cloned().unwrap_or(Value::Null),
        "state": v.get("state").cloned().unwrap_or(Value::Null),
        "identification": v.get("identification").cloned().unwrap_or(Value::Null),
    })
}

// --- Snapshot + daemon (Faz 4A) --------------------------------------------

#[tauri::command]
pub async fn servers_snapshot(app: AppHandle, id: String) -> AppResult<Value> {
    let server = full_server(&app, &id).await?;
    let rt = app.state::<SupervisorRuntime>();
    service::snapshot(rt.inner(), &server).await
}

#[tauri::command]
pub async fn servers_daemon(app: AppHandle, id: String) -> AppResult<Value> {
    let server = full_server(&app, &id).await?;
    service::daemon_info(&server).await
}

#[tauri::command]
pub async fn servers_daemon_reload(app: AppHandle, id: String) -> AppResult<Value> {
    let server = full_server(&app, &id).await?;
    let out = service::reload_config(&server).await?;
    audit::record(
        &db::pool(&app).await?,
        "daemon.reload",
        Some(&id),
        None,
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn servers_daemon_restart(app: AppHandle, id: String) -> AppResult<Value> {
    let server = full_server(&app, &id).await?;
    let out = service::restart_daemon(&server).await?;
    audit::record(
        &db::pool(&app).await?,
        "daemon.restart",
        Some(&id),
        None,
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn servers_daemon_shutdown(app: AppHandle, id: String) -> AppResult<Value> {
    let server = full_server(&app, &id).await?;
    let out = service::shutdown_daemon(&server).await?;
    audit::record(
        &db::pool(&app).await?,
        "daemon.shutdown",
        Some(&id),
        None,
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn servers_daemon_clear_log(app: AppHandle, id: String) -> AppResult<Value> {
    let server = full_server(&app, &id).await?;
    let out = service::clear_daemon_log(&server).await?;
    audit::record(
        &db::pool(&app).await?,
        "daemon.log_clear",
        Some(&id),
        None,
        "ok",
        None,
    )
    .await;
    Ok(out)
}

// --- Host + config dosyaları (Faz 4B) --------------------------------------

#[tauri::command]
pub async fn servers_host(app: AppHandle, id: String) -> AppResult<Value> {
    let server = full_server(&app, &id).await?;
    service::host_metrics(&server).await
}

#[tauri::command]
pub async fn servers_config_list(app: AppHandle, id: String) -> AppResult<Value> {
    let server = full_server(&app, &id).await?;
    config::list_config_files(&server).await
}

#[tauri::command]
pub async fn servers_config_file(app: AppHandle, id: String, path: String) -> AppResult<Value> {
    let server = full_server(&app, &id).await?;
    let content = config::read_config_file(&server, &path).await?;
    Ok(json!({ "path": path, "content": content }))
}

#[tauri::command]
pub async fn servers_config_save(
    app: AppHandle,
    id: String,
    path: String,
    content: String,
) -> AppResult<Value> {
    let server = full_server(&app, &id).await?;
    config::write_config_file(&server, &path, &content).await?;
    audit::record(
        &db::pool(&app).await?,
        "config.write",
        Some(&id),
        Some(&path),
        "ok",
        None,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn servers_config_add_program(
    app: AppHandle,
    id: String,
    data: Value,
) -> AppResult<Value> {
    let server = full_server(&app, &id).await?;
    let out = config::add_program(&server, &data).await?;
    audit::record(
        &db::pool(&app).await?,
        "config.add_program",
        Some(&id),
        None,
        "ok",
        None,
    )
    .await;
    Ok(json!({ "ok": true, "path": out.get("path").cloned().unwrap_or(Value::Null) }))
}

#[tauri::command]
pub async fn servers_config_program_preview(
    app: AppHandle,
    id: String,
    data: Value,
) -> AppResult<Value> {
    // Yalnız blok üretimi — sunucuya dokunmaz (ama izin kontrolü için id alınır).
    let _ = full_server(&app, &id).await?;
    let block = config::build_program_block(&data)?;
    Ok(json!({ "block": block }))
}

#[tauri::command]
pub async fn servers_config_program_parse(
    app: AppHandle,
    id: String,
    path: String,
) -> AppResult<Value> {
    let server = full_server(&app, &id).await?;
    let content = config::read_config_file(&server, &path).await?;
    match config::parse_program_block(&content) {
        Some(def) => Ok(json!({ "def": def })),
        None => Err(crate::error::AppError::new(
            "Dosyada [program] bölümü bulunamadı.",
        )),
    }
}

// --- Metrikler (Faz 6A) ----------------------------------------------------

#[tauri::command]
pub async fn servers_metrics(app: AppHandle, id: String, range: Option<i64>) -> AppResult<Value> {
    let minutes = range.unwrap_or(60).clamp(1, 1440);
    let pool = db::pool(&app).await?;
    let now = chrono::Utc::now().timestamp_millis();
    let samples = metrics::query(&pool, &id, minutes * 60000, now).await?;
    Ok(json!({ "range": minutes, "samples": samples }))
}
