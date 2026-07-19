// Uygulama geneli hata tipi.
//
// Tauri komutları `Result<T, AppError>` döndürür; hata JS tarafına
// `{ "error": "<mesaj>" }` biçiminde reddedilir — böylece eski Node backend'in
// `{ error: string }` sözleşmesi birebir korunur ve frontend `e.error` okur.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct AppError {
    pub error: String,
}

impl AppError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self { error: msg.into() }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.error)
    }
}

impl std::error::Error for AppError {}

// Yaygın hata kaynaklarından dönüşümler. (Blanket `impl<E: Error>` çekirdek
// `From<T> for T` ile çakışacağından kaçınılıyor; ihtiyaç oldukça eklenir.)
impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::new(format!("JSON hatası: {e}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;
