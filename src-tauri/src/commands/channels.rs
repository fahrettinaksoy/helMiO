//! Bildirim kanalı komutları (eski `/api/channels`). `channels_test` bildirim
//! gönderimi gerektirdiği için Faz 6'da (notifier) eklenecek.

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::crypto::SecretBox;
use crate::error::AppResult;
use crate::store::{audit, channels};
use crate::{db, meta};

#[tauri::command]
pub async fn channels_meta() -> AppResult<Value> {
    Ok(meta::channel_meta())
}

#[tauri::command]
pub async fn channels_list(app: AppHandle) -> AppResult<Value> {
    let pool = db::pool(&app).await?;
    let sb = app.state::<SecretBox>();
    channels::list(&pool, sb.inner()).await
}

#[tauri::command]
pub async fn channels_create(app: AppHandle, data: Value) -> AppResult<Value> {
    let pool = db::pool(&app).await?;
    let sb = app.state::<SecretBox>();
    let out = channels::create(&pool, sb.inner(), &data).await?;
    audit::record(
        &pool,
        "channel.create",
        None,
        out.get("name").and_then(Value::as_str),
        "ok",
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
pub async fn channels_update(app: AppHandle, id: String, data: Value) -> AppResult<Value> {
    let pool = db::pool(&app).await?;
    let sb = app.state::<SecretBox>();
    let out = channels::update(&pool, sb.inner(), &id, &data).await?;
    audit::record(&pool, "channel.update", None, Some(&id), "ok", None).await;
    Ok(out)
}

#[tauri::command]
pub async fn channels_remove(app: AppHandle, id: String) -> AppResult<()> {
    let pool = db::pool(&app).await?;
    channels::remove(&pool, &id).await?;
    audit::record(&pool, "channel.delete", None, Some(&id), "ok", None).await;
    Ok(())
}

/// Kanaldan tek seferlik test bildirimi gönderir.
#[tauri::command]
pub async fn channels_test(app: AppHandle, id: String) -> AppResult<Value> {
    let out = crate::services::notifier::send_test(&app, &id).await?;
    let pool = db::pool(&app).await?;
    audit::record(&pool, "channel.test", None, Some(&id), "ok", None).await;
    Ok(out)
}
