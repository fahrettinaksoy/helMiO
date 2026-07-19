// Tauri komut yüzeyi (IPC). Eski Express route'larının yerini bu komutlar alır.
//
// Faz 1: sağlık/sürüm. Faz 2: servers/channels/healthchecks/audit CRUD.
// Sonraki fazlarda connector/supervisor/realtime komutları eklenecek.

pub mod audit;
pub mod bulk;
pub mod channels;
pub mod fleet;
pub mod groups;
pub mod healthchecks;
pub mod overview;
pub mod process;
pub mod servers;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::crypto::SecretBox;
use crate::db;
use crate::error::AppResult;

/// Bir komutun ihtiyaç duyduğu, secret'ları ÇÖZÜLMÜŞ (connector'a hazır) sunucu.
pub(crate) async fn full_server(app: &AppHandle, id: &str) -> AppResult<Value> {
    let pool = db::pool(app).await?;
    let sb = app.state::<SecretBox>();
    crate::store::servers::get_full(&pool, sb.inner(), id).await
}

#[derive(Serialize)]
pub struct HealthInfo {
    pub ok: bool,
    pub name: &'static str,
    pub version: &'static str,
}

/// Eski `GET /api/health` karşılığı. Frontend'in IPC köprüsünün ayakta
/// olduğunu doğrulamak için kullanılır.
#[tauri::command]
pub fn app_health() -> AppResult<HealthInfo> {
    Ok(HealthInfo {
        ok: true,
        name: "helmio",
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// Uygulama sürümü (UI'da "Hakkında" vb. için).
#[tauri::command]
pub fn app_version() -> AppResult<String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}
