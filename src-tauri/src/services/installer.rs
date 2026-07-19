//! Supervisor tespiti (diagnose) + tek-tık kurulum (shell erişimli
//! connector'larda). Eski installerService.js portu.
//!
//! NOT: eski sürüm exec çıktısını satır satır akıtıyordu; burada exec tam çıktıyı
//! sonda döndürdüğü için ilerleme ADIM ADIM (komut etiketi + çıktısı) yayınlanır.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::supervisor::connector::Connector;
use crate::supervisor::create_connector;

const FACTS_SCRIPT: &str = r#"
echo "WHOAMI=$(whoami 2>/dev/null)"
echo "UNAME=$(uname -s 2>/dev/null)"
echo "SUPERVISORD=$(command -v supervisord 2>/dev/null)"
echo "SUPERVISORCTL=$(command -v supervisorctl 2>/dev/null)"
echo "VERSION=$(supervisord -v 2>/dev/null)"
echo "SUDO=$(command -v sudo 2>/dev/null)"
echo "RUNNING=$(pgrep -x supervisord >/dev/null 2>&1 && echo yes || echo no)"
for pm in apt-get apk dnf yum brew pip3 pip; do command -v $pm >/dev/null 2>&1 && echo "PM=$pm"; done
for c in /etc/supervisor/supervisord.conf /etc/supervisord.conf /usr/local/etc/supervisord.conf /opt/homebrew/etc/supervisord.conf; do [ -f "$c" ] && echo "CONF=$c"; done
if command -v systemctl >/dev/null 2>&1; then echo "INIT=systemd"; elif command -v rc-service >/dev/null 2>&1; then echo "INIT=openrc"; else echo "INIT=none"; fi
if [ -f /etc/os-release ]; then . /etc/os-release; echo "OS_ID=$ID"; echo "OS_NAME=$PRETTY_NAME"; fi
"#;

const PM_PRIORITY: &[&str] = &["apt-get", "dnf", "yum", "apk", "pip3", "pip"];

struct Facts {
    whoami: String,
    installed: bool,
    version: Option<String>,
    running: bool,
    has_sudo: bool,
    package_manager: Option<String>,
    available: Vec<String>,
    conf_path: Option<String>,
    init: String,
    os: String,
    os_id: String,
}

fn parse_facts(stdout: &str) -> Facts {
    let mut kv = std::collections::HashMap::new();
    let mut pms: Vec<String> = Vec::new();
    let mut conf: Option<String> = None;
    for line in stdout.split('\n') {
        if let Some(idx) = line.find('=') {
            let key = line[..idx].trim().to_string();
            let val = line[idx + 1..].trim().to_string();
            if key == "PM" {
                pms.push(val);
            } else if key == "CONF" {
                if conf.is_none() {
                    conf = Some(val);
                }
            } else {
                kv.insert(key, val);
            }
        }
    }
    let g = |k: &str| kv.get(k).cloned().unwrap_or_default();
    let is_mac = g("UNAME") == "Darwin";
    let pm = PM_PRIORITY
        .iter()
        .find(|p| pms.iter().any(|x| x == *p))
        .map(|s| s.to_string());
    let version = {
        let v = g("VERSION");
        if v.is_empty() {
            None
        } else {
            Some(v)
        }
    };
    Facts {
        whoami: g("WHOAMI"),
        installed: !g("SUPERVISORD").is_empty(),
        version,
        running: g("RUNNING") == "yes",
        has_sudo: !g("SUDO").is_empty(),
        package_manager: if is_mac && pm.is_none() {
            Some("brew".into())
        } else {
            pm
        },
        available: pms,
        conf_path: conf,
        init: {
            let i = g("INIT");
            if i.is_empty() {
                "none".into()
            } else {
                i
            }
        },
        os: {
            let o = g("OS_NAME");
            if !o.is_empty() {
                o
            } else if is_mac {
                "macOS".into()
            } else {
                let u = g("UNAME");
                if u.is_empty() {
                    "unknown".into()
                } else {
                    u
                }
            }
        },
        os_id: {
            let i = g("OS_ID");
            if !i.is_empty() {
                i
            } else if is_mac {
                "macos".into()
            } else {
                String::new()
            }
        },
    }
}

async fn gather_facts(conn: &dyn Connector) -> Result<Facts, String> {
    let out = conn.exec(FACTS_SCRIPT, None).await.map_err(|e| e.error)?;
    Ok(parse_facts(&out.stdout))
}

fn sh_q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Komutu ayrıcalıkla çalıştıracak şekilde sarar → (command, stdin_input?).
fn privilege_wrap(
    cmd: &str,
    is_root: bool,
    is_docker: bool,
    sudo_password: &str,
) -> (String, Option<String>) {
    if is_root || is_docker {
        (cmd.to_string(), None)
    } else if !sudo_password.is_empty() {
        (
            format!("sudo -S -p '' sh -c {}", sh_q(cmd)),
            Some(format!("{sudo_password}\n")),
        )
    } else {
        (format!("sudo -n sh -c {}", sh_q(cmd)), None)
    }
}

fn install_command(pm: &str) -> Option<&'static str> {
    match pm {
        "apt-get" => Some("export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y supervisor"),
        "apk" => Some("apk add --no-cache supervisor"),
        "dnf" => Some("dnf install -y supervisor || { dnf install -y epel-release && dnf install -y supervisor; }"),
        "yum" => Some("yum install -y supervisor || { yum install -y epel-release && yum install -y supervisor; }"),
        "pip3" => Some("pip3 install supervisor"),
        "pip" => Some("pip install supervisor"),
        _ => None,
    }
}

fn default_conf_path(pm: &str) -> &'static str {
    if pm == "apt-get" {
        "/etc/supervisor/supervisord.conf"
    } else {
        "/etc/supervisord.conf"
    }
}

fn configure_script(conf_path: &str, is_pip: bool, inet_user: &str, inet_password: &str) -> String {
    let block = format!(
        "\n[unix_http_server]\nfile=/var/run/supervisor.sock\nchmod=0700\n\n[inet_http_server]\nport=127.0.0.1:9001\nusername={inet_user}\npassword={inet_password}\n\n[supervisorctl]\nserverurl=unix:///var/run/supervisor.sock\n\n[include]\nfiles = /etc/supervisor/conf.d/*.conf /etc/supervisor.d/*.ini\n"
    );
    let b64 = B64.encode(block.as_bytes());
    let ensure_conf = if is_pip {
        format!("[ -f {conf_path} ] || {{ command -v echo_supervisord_conf >/dev/null 2>&1 && echo_supervisord_conf > {conf_path} || : ; }}; touch {conf_path}")
    } else {
        format!("touch {conf_path}")
    };
    let section = |name: &str| {
        format!(
            "grep -q '^\\[{name}\\]' {conf_path} || printf '\\n%s\\n' \"$(echo {b64} | base64 -d | sed -n '/\\[{name}\\]/,/^$/p')\" >> {conf_path}"
        )
    };
    [
        "mkdir -p /etc/supervisor/conf.d".to_string(),
        ensure_conf,
        section("unix_http_server"),
        section("inet_http_server"),
        section("supervisorctl"),
        section("include"),
    ]
    .join(" && ")
}

fn service_script(init: &str, conf_path: &str) -> String {
    match init {
        "systemd" => "systemctl enable supervisor 2>/dev/null || systemctl enable supervisord 2>/dev/null; systemctl restart supervisor 2>/dev/null || systemctl restart supervisord 2>/dev/null || true".to_string(),
        "openrc" => "rc-update add supervisord default 2>/dev/null; rc-service supervisord restart 2>/dev/null || rc-service supervisord start".to_string(),
        _ => format!("pgrep -x supervisord >/dev/null 2>&1 || supervisord -c {conf_path}"),
    }
}

/// Bağlantı KANALINI test eder (supervisor kurulu olmasa da). { ok, channel, supervisor }.
pub async fn test_connection(server: &Value) -> Value {
    let method = server.get("method").and_then(Value::as_str).unwrap_or("");
    let conn = match create_connector(server) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": e.error }),
    };

    let result = if method == "agent" {
        let base = server
            .get("agentUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_end_matches('/')
            .to_string();
        if base.is_empty() {
            json!({ "ok": false, "error": "Agent URL gerekli." })
        } else {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .ok();
            match client {
                Some(c) => match c.get(format!("{base}/health")).send().await {
                    Ok(res) => {
                        let body: Value = res.json().await.unwrap_or(Value::Null);
                        json!({ "ok": true, "channel": "agent", "supervisor": {
                            "reachable": body.get("ok").and_then(Value::as_bool).unwrap_or(false),
                            "version": body.get("version").cloned().unwrap_or(Value::Null),
                        }})
                    }
                    Err(e) => json!({ "ok": false, "error": format!("Agent'a ulaşılamadı: {e}") }),
                },
                None => json!({ "ok": false, "error": "HTTP istemcisi kurulamadı." }),
            }
        }
    } else if conn.supports_exec() {
        match conn.exec("echo helmio-ok", None).await {
            Ok(o) if o.code == 0 && o.stdout.contains("helmio-ok") => {
                let supervisor = match conn.call("supervisor.getSupervisorVersion", vec![]).await {
                    Ok(v) => json!({ "reachable": true, "version": v }),
                    Err(_) => json!({ "reachable": false, "version": Value::Null }),
                };
                json!({ "ok": true, "channel": "shell", "supervisor": supervisor })
            }
            Ok(_) => json!({ "ok": false, "error": "Bağlantı kuruldu ama komut çalıştırılamadı." }),
            Err(e) => json!({ "ok": false, "error": e.error }),
        }
    } else {
        match conn.call("supervisor.getSupervisorVersion", vec![]).await {
            Ok(v) => {
                json!({ "ok": true, "channel": "rpc", "supervisor": { "reachable": true, "version": v } })
            }
            Err(e) => json!({ "ok": false, "error": e.error }),
        }
    };
    conn.close().await;
    result
}

/// Supervisor kurulu/çalışıyor mu + kurulum seçenekleri.
pub async fn detect(server: &Value) -> Value {
    let method = server
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let conn = match create_connector(server) {
        Ok(c) => c,
        Err(e) => {
            return json!({ "method": method, "reachable": false, "installed": "unknown", "running": false, "canInstall": false, "rpcError": e.error })
        }
    };

    let (rpc_ok, rpc_version, rpc_err) = match conn.ping().await {
        Ok(p) => (
            true,
            p.get("version").cloned().unwrap_or(Value::Null),
            Value::Null,
        ),
        Err(e) => (false, Value::Null, Value::String(e.error)),
    };
    let installed_unknown = if rpc_ok {
        json!(true)
    } else {
        json!("unknown")
    };

    let result = if !conn.supports_exec() {
        json!({
            "method": method, "shell": false, "reachable": rpc_ok,
            "installed": installed_unknown, "running": rpc_ok, "version": rpc_version,
            "canInstall": false, "rpcError": if rpc_ok { Value::Null } else { rpc_err },
        })
    } else {
        match gather_facts(conn.as_ref()).await {
            Err(e) => json!({
                "method": method, "shell": true, "reachable": rpc_ok,
                "installed": installed_unknown, "running": rpc_ok, "version": rpc_version,
                "canInstall": false, "error": format!("Tespit komutları çalıştırılamadı: {e}"),
            }),
            Ok(f) => {
                let can_install = !f.installed
                    && f.package_manager
                        .as_deref()
                        .and_then(install_command)
                        .is_some();
                json!({
                    "method": method, "shell": true, "reachable": rpc_ok,
                    "installed": f.installed,
                    "running": f.running || rpc_ok,
                    "version": f.version.clone().map(Value::String).unwrap_or(rpc_version),
                    "os": f.os, "packageManager": f.package_manager, "availablePackageManagers": f.available,
                    "confPath": f.conf_path, "init": f.init, "whoami": f.whoami, "hasSudo": f.has_sudo,
                    "canInstall": can_install,
                    "canConfigure": f.installed && !rpc_ok,
                    "rpcError": if rpc_ok { Value::Null } else { rpc_err },
                    "osId": f.os_id,
                })
            }
        }
    };
    conn.close().await;
    result
}

fn emit_log(app: &AppHandle, server_id: &str, line: impl Into<String>) {
    let _ = app.emit(
        "rt:install:log",
        json!({ "serverId": server_id, "line": line.into() }),
    );
}

#[allow(clippy::too_many_arguments)]
async fn run_raw(
    app: &AppHandle,
    conn: &dyn Connector,
    server_id: &str,
    cmd: &str,
    label: &str,
    is_root: bool,
    is_docker: bool,
    sudo_password: &str,
) -> Result<(), String> {
    emit_log(app, server_id, format!("\n$ {label}"));
    let (command, input) = privilege_wrap(cmd, is_root, is_docker, sudo_password);
    let out = conn
        .exec(&command, input.as_deref())
        .await
        .map_err(|e| e.error)?;
    if !out.stdout.trim().is_empty() {
        emit_log(app, server_id, out.stdout.trim_end().to_string());
    }
    if out.code != 0 {
        let src = if !out.stderr.trim().is_empty() {
            &out.stderr
        } else {
            &out.stdout
        };
        let tail: Vec<&str> = src.trim().lines().rev().take(3).collect();
        let tail: String = tail.into_iter().rev().collect::<Vec<_>>().join(" ");
        return Err(format!("Komut başarısız (çıkış {}): {tail}", out.code));
    }
    Ok(())
}

/// Supervisor'ı kurar (+opsiyonel yapılandırma). İlerleme rt:install:log ile,
/// sonuç rt:install:result ile yayınlanır.
pub async fn install(app: &AppHandle, server: &Value, sudo_password: &str, configure_http: bool) {
    let server_id = server
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let emit_result = |ok: bool, error: Option<String>, inet: Value| {
        let mut payload = json!({ "serverId": server_id, "ok": ok });
        if let Some(e) = error {
            payload["error"] = Value::String(e);
        }
        if !inet.is_null() {
            payload["inet"] = inet;
        }
        let _ = app.emit("rt:install:result", payload);
    };

    let conn = match create_connector(server) {
        Ok(c) => c,
        Err(e) => return emit_result(false, Some(e.error), Value::Null),
    };
    if !conn.supports_exec() {
        conn.close().await;
        return emit_result(
            false,
            Some("Bu bağlantı türünde kurulum yapılamaz (shell erişimi yok).".into()),
            Value::Null,
        );
    }

    let facts = match gather_facts(conn.as_ref()).await {
        Ok(f) => f,
        Err(e) => {
            conn.close().await;
            return emit_result(false, Some(e), Value::Null);
        }
    };
    let is_docker = server.get("method").and_then(Value::as_str) == Some("docker");
    let is_root = facts.whoami == "root";
    let pm = facts.package_manager.clone().unwrap_or_default();

    // 1. Paket kurulumu.
    if facts.installed {
        emit_log(
            app,
            &server_id,
            "Supervisor zaten kurulu — yapılandırma adımına geçiliyor.",
        );
    } else {
        match install_command(&pm) {
            None => {
                conn.close().await;
                return emit_result(
                    false,
                    Some(format!(
                        "Desteklenen paket yöneticisi bulunamadı (tespit: {}).",
                        if facts.available.is_empty() {
                            "yok".into()
                        } else {
                            facts.available.join(", ")
                        }
                    )),
                    Value::Null,
                );
            }
            Some(cmd) => {
                emit_log(
                    app,
                    &server_id,
                    format!("Paket yöneticisi: {pm}. Supervisor kuruluyor..."),
                );
                if let Err(e) = run_raw(
                    app,
                    conn.as_ref(),
                    &server_id,
                    cmd,
                    &format!("{pm} ile supervisor kurulumu"),
                    is_root,
                    is_docker,
                    sudo_password,
                )
                .await
                {
                    conn.close().await;
                    return emit_result(false, Some(e), Value::Null);
                }
            }
        }
    }

    // 2. En iyi pratik http arayüzleri.
    let is_pip = pm == "pip" || pm == "pip3";
    let conf_path = facts
        .conf_path
        .clone()
        .unwrap_or_else(|| default_conf_path(&pm).to_string());
    let mut inet = Value::Null;
    if configure_http {
        let inet_user = "helmio";
        let mut pw = [0u8; 12];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut pw);
        let inet_password = hex::encode(pw);
        inet = json!({ "host": "127.0.0.1", "port": 9001, "username": inet_user, "password": inet_password });
        emit_log(
            app,
            &server_id,
            "\nEn iyi pratiklerle yapılandırılıyor (unix socket + 127.0.0.1:9001 inet, auth)...",
        );
        let script = configure_script(&conf_path, is_pip, inet_user, &inet_password);
        if let Err(e) = run_raw(
            app,
            conn.as_ref(),
            &server_id,
            &script,
            &format!("yapılandırma yazılıyor ({conf_path})"),
            is_root,
            is_docker,
            sudo_password,
        )
        .await
        {
            conn.close().await;
            return emit_result(false, Some(e), Value::Null);
        }
    }

    // 3. Servisi (yeniden) başlat.
    emit_log(app, &server_id, "\nServis başlatılıyor...");
    let svc = service_script(&facts.init, &conf_path);
    if let Err(e) = run_raw(
        app,
        conn.as_ref(),
        &server_id,
        &svc,
        "servis başlatma",
        is_root,
        is_docker,
        sudo_password,
    )
    .await
    {
        conn.close().await;
        return emit_result(false, Some(e), inet);
    }

    emit_log(app, &server_id, "\n✓ Kurulum tamamlandı.");
    if is_docker {
        emit_log(app, &server_id, "⚠ Not: Container içine kurulum kalıcı değildir — container yeniden oluşturulursa kaybolur. Kalıcılık için supervisor'ı imaja ekleyin.");
    }
    conn.close().await;
    emit_result(true, None, inet);
}
