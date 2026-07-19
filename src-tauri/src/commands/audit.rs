//! Denetim günlüğü komutu (eski `/api/audit`).

use serde_json::Value;
use tauri::AppHandle;

use crate::db;
use crate::error::AppResult;
use crate::store::audit;

#[tauri::command]
pub async fn audit_query(app: AppHandle, params: Value) -> AppResult<Value> {
    let pool = db::pool(&app).await?;
    audit::query(&pool, &params).await
}
