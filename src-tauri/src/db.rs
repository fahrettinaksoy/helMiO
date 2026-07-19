//! tauri-plugin-sql havuzuna erişim.
//!
//! Kendi bağlantımızı açmak yerine plugin'in KENDİ havuzunu ödünç alırız
//! (weltoly deseni): tek doğruluk kaynağı, WAL kilidi için yarış yok, DB yolu
//! yeniden çözülmez. DB, tauri.conf `plugins.sql.preload` ile açılışta yüklenip
//! migrate edilir; bu yüzden komutlar JS'in `Database.load()` çağırmasını
//! beklemek zorunda değildir.

use sqlx::{Pool, Sqlite};
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool};

use crate::error::{AppError, AppResult};

/// Migration anahtarı (lib.rs) ve preload url'siyle AYNI olmalı.
pub const DB_URL: &str = "sqlite:helmio.db";

/// Plugin havuzunun bir klonunu döndürür (Pool = Arc, klon ucuz).
pub async fn pool(app: &AppHandle) -> AppResult<Pool<Sqlite>> {
    let instances = app.state::<DbInstances>();
    let map = instances.0.read().await;
    match map.get(DB_URL) {
        Some(DbPool::Sqlite(p)) => Ok(p.clone()),
        _ => Err(AppError::new(format!("veritabanı yüklenmemiş: {DB_URL}"))),
    }
}
