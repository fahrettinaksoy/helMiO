-- Helmio ilk şema (tek-kullanıcı masaüstü sürümü).
--
-- Eski Node backend JSON dosyaları yerine SQLite. Auth kaldırıldığı için
-- users/api_tokens/rate-limit tabloları YOK. Secret alanlar (parola, privateKey,
-- token'lar) uygulama katmanında AES-256-GCM ile şifrelenip `enc:1:` etiketiyle
-- saklanır; şema bunları düz TEXT olarak tutar.

-- Yönetilen supervisord sunucuları. Yönteme özgü alanlar `config` JSON'unda
-- (secret alanları şifreli). `method`: tcp | local | ssh | docker | agent.
CREATE TABLE IF NOT EXISTS servers (
  id           TEXT PRIMARY KEY,
  method       TEXT NOT NULL,
  name         TEXT NOT NULL,
  config       TEXT NOT NULL DEFAULT '{}',
  ingest_token TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Bildirim kanalları. type: webhook | slack | discord | telegram | email.
-- `config` (secret'lar şifreli) ve `filters` JSON.
CREATE TABLE IF NOT EXISTS channels (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  config       TEXT NOT NULL DEFAULT '{}',
  filters      TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_sent_at TEXT,
  last_error   TEXT
);

-- Sağlık kontrolleri (sunucuya bağlı). type: http | tcp | script.
CREATE TABLE IF NOT EXISTS healthchecks (
  id                   TEXT PRIMARY KEY,
  server_id            TEXT NOT NULL,
  target               TEXT NOT NULL,
  type                 TEXT NOT NULL,
  enabled              INTEGER NOT NULL DEFAULT 1,
  interval_sec         INTEGER NOT NULL DEFAULT 30,
  failure_threshold    INTEGER NOT NULL DEFAULT 3,
  action               TEXT NOT NULL DEFAULT 'restart',
  config               TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  last_checked_at      TEXT,
  last_status          TEXT NOT NULL DEFAULT 'unknown',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  last_action_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_healthchecks_server ON healthchecks (server_id);

-- Denetim günlüğü (eylem geçmişi). Tek kullanıcı olduğundan actor alanları yok.
CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  action    TEXT NOT NULL,
  server_id TEXT,
  target    TEXT,
  status    TEXT NOT NULL DEFAULT 'ok',
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit (at);

-- Zaman serisi metrikleri (snapshot + host). Halka tamponu uygulama katmanında
-- eski kayıtlar budanarak yönetilir.
CREATE TABLE IF NOT EXISTS metrics (
  server_id TEXT NOT NULL,
  at        INTEGER NOT NULL, -- epoch ms (zaman serisi filtre/bucket için)
  total     INTEGER,
  running   INTEGER,
  stopped   INTEGER,
  fatal     INTEGER,
  other     INTEGER,
  cpu       REAL,
  mem       REAL,
  load      REAL,
  mem_pct   REAL,
  disk_pct  REAL
);
CREATE INDEX IF NOT EXISTS idx_metrics_server_at ON metrics (server_id, at);

-- Genel anahtar/değer ayarları (tema, dil, seçili aralık vb. — çoğu frontend
-- tarafında tutulur ama Rust'ın da ihtiyaç duyabileceği ayarlar için).
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
