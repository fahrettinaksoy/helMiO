// Helmio - Tauri arka uç girişi.
//
// Eski Node/Express backend'in yerini alan Rust katmanı. Yerel veri:
// tauri-plugin-sql (SQLite, bundled). Faz 2: veri katmanı (store'lar + secret
// şifreleme). Connector/supervisor/realtime modülleri sonraki fazlarda eklenecek.

mod commands;
mod crypto;
mod db;
mod error;
mod meta;
mod realtime;
mod services;
mod store;
mod supervisor;

use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

use crate::crypto::SecretBox;
use crate::realtime::RealtimeState;
use crate::services::healthcheck::HealthcheckState;
use crate::services::notifier::NotifierState;
use crate::supervisor::service::SupervisorRuntime;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "ilk şema (servers, channels, healthchecks, audit, metrics, settings)",
        sql: include_str!("../migrations/001_init.sql"),
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::app_health,
            commands::app_version,
            commands::servers::servers_methods,
            commands::servers::servers_list,
            commands::servers::servers_get,
            commands::servers::servers_create,
            commands::servers::servers_update,
            commands::servers::servers_remove,
            commands::servers::servers_test,
            commands::servers::servers_test_connection,
            commands::servers::servers_diagnose,
            commands::servers::servers_snapshot,
            commands::servers::servers_daemon,
            commands::servers::servers_daemon_reload,
            commands::servers::servers_daemon_restart,
            commands::servers::servers_daemon_shutdown,
            commands::servers::servers_daemon_clear_log,
            commands::servers::servers_host,
            commands::servers::servers_config_list,
            commands::servers::servers_config_file,
            commands::servers::servers_config_save,
            commands::servers::servers_config_add_program,
            commands::servers::servers_config_program_preview,
            commands::servers::servers_config_program_parse,
            commands::servers::servers_metrics,
            commands::overview::overview_get,
            commands::process::process_start,
            commands::process::process_stop,
            commands::process::process_restart,
            commands::process::process_signal,
            commands::process::process_send_stdin,
            commands::process::process_clear_log,
            commands::process::process_read_log,
            commands::process::process_download_log,
            commands::groups::group_start,
            commands::groups::group_stop,
            commands::groups::group_restart,
            commands::groups::group_signal,
            commands::bulk::bulk_start_all,
            commands::bulk::bulk_stop_all,
            commands::bulk::bulk_restart_all,
            commands::bulk::bulk_signal_all,
            commands::bulk::bulk_clear_all_logs,
            commands::channels::channels_meta,
            commands::channels::channels_list,
            commands::channels::channels_create,
            commands::channels::channels_update,
            commands::channels::channels_remove,
            commands::channels::channels_test,
            commands::healthchecks::servers_healthcheck_meta,
            commands::healthchecks::servers_healthchecks,
            commands::healthchecks::servers_healthcheck_create,
            commands::healthchecks::servers_healthcheck_update,
            commands::healthchecks::servers_healthcheck_remove,
            commands::healthchecks::servers_healthcheck_run,
            commands::audit::audit_query,
            commands::fleet::fleet_run,
            realtime::rt_subscribe,
            realtime::rt_unsubscribe,
            realtime::rt_log_start,
            realtime::rt_log_stop,
            realtime::rt_install_start,
        ])
        // Secret kutusu (AES-256-GCM anahtarı) — app config dizininden yüklenir/üretilir.
        .setup(|app| {
            let dir = app
                .path()
                .app_config_dir()
                .expect("app config dizini çözülemedi");
            app.manage(SecretBox::load(&dir));
            app.manage(SupervisorRuntime::new());
            app.manage(RealtimeState::new());
            app.manage(HealthcheckState::new());
            app.manage(NotifierState::new());
            // Sağlık kontrolü zamanlayıcısını arka planda başlat (DB preload sonrası).
            services::healthcheck::start(app.handle().clone());
            Ok(())
        })
        // Log: hem stdout'a (geliştirmede) hem app log dizinindeki DÖNEN dosyaya.
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("sqlx", log::LevelFilter::Warn)
                .level_for("tao", log::LevelFilter::Warn)
                .level_for("wry", log::LevelFilter::Warn)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:helmio.db", migrations)
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
