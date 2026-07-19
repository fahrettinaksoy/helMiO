//! Veri erişim katmanı — eski Node JSON store'larının SQLite karşılığı.
//!
//! Her alt modül bir varlığı yönetir (servers/channels/healthchecks/audit).
//! Secret alanlar uygulama katmanında AES-256-GCM ile şifrelenir (bkz. crypto).

pub mod audit;
pub mod channels;
pub mod healthchecks;
pub mod metrics;
pub mod servers;

use chrono::{SecondsFormat, Utc};

/// JS `new Date().toISOString()` ile uyumlu ISO-8601 (milisaniye + "Z").
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Eski nanoid(10) ile aynı uzunluk/alfabe (URL-safe).
pub fn new_id() -> String {
    nanoid::nanoid!(10)
}

/// UI'da secret alanların gösterildiği maske (eski backend ile aynı).
pub const MASK: &str = "••••••";
