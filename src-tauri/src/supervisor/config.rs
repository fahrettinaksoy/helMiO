//! supervisord config dosyası işlemleri ve `[program:...]` bloğu üret/ayrıştır
//! (shell erişimli connector'lar). Eski supervisorService.js'in config kısmı.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

use crate::error::{AppError, AppResult};
use crate::supervisor::{create_connector, service};

/// Değeri shell için tek tırnak içine alır.
fn sh_arg(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Config dosyası erişimini supervisor konumlarıyla sınırlar.
fn is_allowed_config_path(p: &str) -> bool {
    if p.contains("..") {
        return false;
    }
    if !(p.ends_with(".conf") || p.ends_with(".ini")) {
        return false;
    }
    let prefixes = [
        "/etc/supervisor/",
        "/etc/supervisord.d/",
        "/etc/supervisor.d/",
        "/usr/local/etc/",
    ];
    p == "/etc/supervisord.conf" || prefixes.iter().any(|pre| p.starts_with(pre))
}

const LIST_SCRIPT: &str = r#"
for d in /etc/supervisor/conf.d /etc/supervisord.d /etc/supervisor.d; do
  [ -d "$d" ] && ls -1 "$d"/*.conf "$d"/*.ini 2>/dev/null
done
for f in /etc/supervisor/supervisord.conf /etc/supervisord.conf /usr/local/etc/supervisord.conf; do
  [ -f "$f" ] && echo "$f"
done
echo "CONFDIR=$(for d in /etc/supervisor/conf.d /etc/supervisord.d /etc/supervisor.d; do [ -d "$d" ] && echo "$d" && break; done)"
"#;

pub async fn list_config_files(server: &Value) -> AppResult<Value> {
    let conn = create_connector(server)?;
    if !conn.supports_exec() {
        conn.close().await;
        return Ok(json!({ "supported": false, "files": [], "confDir": Value::Null }));
    }
    let out = conn.exec(LIST_SCRIPT, None).await?;
    conn.close().await;

    let mut files: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut conf_dir = Value::Null;
    for line in out.stdout.split('\n') {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if let Some(rest) = l.strip_prefix("CONFDIR=") {
            conf_dir = if rest.is_empty() {
                Value::Null
            } else {
                Value::String(rest.to_string())
            };
        } else if seen.insert(l.to_string()) {
            files.push(Value::String(l.to_string()));
        }
    }
    Ok(json!({ "supported": true, "files": files, "confDir": conf_dir }))
}

pub async fn read_config_file(server: &Value, path: &str) -> AppResult<String> {
    if !is_allowed_config_path(path) {
        return Err(AppError::new("İzin verilmeyen dosya yolu."));
    }
    let conn = create_connector(server)?;
    let out = conn
        .exec(&format!("cat {} 2>/dev/null", sh_arg(path)), None)
        .await?;
    conn.close().await;
    if out.code != 0 {
        return Err(AppError::new("Dosya okunamadı."));
    }
    Ok(out.stdout)
}

pub async fn write_config_file(server: &Value, path: &str, content: &str) -> AppResult<bool> {
    if !is_allowed_config_path(path) {
        return Err(AppError::new("İzin verilmeyen dosya yolu."));
    }
    let conn = create_connector(server)?;
    let b64 = B64.encode(content.as_bytes());
    let cmd = format!("printf %s {} | base64 -d > {}", sh_arg(&b64), sh_arg(path));
    let out = conn.exec(&cmd, None).await?;
    conn.close().await;
    if out.code != 0 {
        return Err(AppError::new(if out.stderr.is_empty() {
            "Dosya yazılamadı (yetki gerekebilir).".to_string()
        } else {
            out.stderr
        }));
    }
    Ok(true)
}

// --- [program:name] bloğu üretimi -------------------------------------------

fn as_str_val(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::String(_) | Value::Null => None,
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn coerce_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Yapılandırılmış tanımdan tam bir `[program:name]` bloğu üretir.
pub fn build_program_block(def: &Value) -> AppResult<String> {
    let empty = Map::new();
    let d = def.as_object().unwrap_or(&empty);

    let name = d.get("name").and_then(as_str_val);
    let command = d.get("command").and_then(as_str_val);
    let (name, command) = match (name, command) {
        (Some(n), Some(c)) => (n, c),
        _ => return Err(AppError::new("Program adı ve komut gerekli.")),
    };
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
    {
        return Err(AppError::new("Geçersiz program adı."));
    }

    let mut lines = vec![format!("[program:{name}]"), format!("command={command}")];
    macro_rules! add {
        ($k:expr, $v:expr) => {
            if let Some(val) = $v {
                if !val.is_empty() {
                    lines.push(format!("{}={}", $k, val));
                }
            }
        };
    }
    let get = |k: &str| d.get(k).and_then(as_str_val);
    let bool_of = |k: &str| -> bool {
        d.get(k)
            .and_then(|v| v.as_bool().or_else(|| v.as_str().map(|s| s == "true")))
            .unwrap_or(false)
    };
    let present = |k: &str| d.get(k).map(|v| !v.is_null()).unwrap_or(false);

    add!("directory", get("directory"));
    add!("user", get("user"));

    let numprocs = d
        .get("numprocs")
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .filter(|&n| n >= 1)
        .unwrap_or(1);
    if numprocs > 1 {
        add!("numprocs", Some(numprocs.to_string()));
        add!(
            "process_name",
            Some(
                get("process_name").unwrap_or_else(|| "%(program_name)s_%(process_num)02d".into())
            )
        );
    } else if let Some(pn) = get("process_name") {
        add!("process_name", Some(pn));
    }
    add!("priority", get("priority"));
    add!("umask", get("umask"));

    if present("autostart") {
        add!("autostart", Some(bool_of("autostart").to_string()));
    }
    if let Some(ar) = d.get("autorestart") {
        if !ar.is_null() && ar.as_str() != Some("") {
            let v = match ar {
                Value::Bool(b) => b.to_string(),
                _ => coerce_str(ar),
            };
            add!("autorestart", Some(v));
        }
    }
    add!("startsecs", get("startsecs"));
    add!("startretries", get("startretries"));
    add!("exitcodes", get("exitcodes"));
    add!("stopsignal", get("stopsignal"));
    add!("stopwaitsecs", get("stopwaitsecs"));
    if present("stopasgroup") {
        add!("stopasgroup", Some(bool_of("stopasgroup").to_string()));
    }
    if present("killasgroup") {
        add!("killasgroup", Some(bool_of("killasgroup").to_string()));
    }

    let redirect = bool_of("redirect_stderr");
    if present("redirect_stderr") {
        add!("redirect_stderr", Some(redirect.to_string()));
    }
    add!(
        "stdout_logfile",
        Some(get("stdout_logfile").unwrap_or_else(|| format!("/var/log/{name}.log")))
    );
    add!("stdout_logfile_maxbytes", get("stdout_logfile_maxbytes"));
    add!("stdout_logfile_backups", get("stdout_logfile_backups"));
    if !redirect {
        add!(
            "stderr_logfile",
            Some(get("stderr_logfile").unwrap_or_else(|| format!("/var/log/{name}.err")))
        );
        add!("stderr_logfile_maxbytes", get("stderr_logfile_maxbytes"));
        add!("stderr_logfile_backups", get("stderr_logfile_backups"));
    }

    // environment: [{key,value}] veya ham string.
    match d.get("environment") {
        Some(Value::Array(arr)) if !arr.is_empty() => {
            let env = arr
                .iter()
                .filter_map(|e| {
                    let k = e
                        .get("key")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())?;
                    let v = e
                        .get("value")
                        .map(coerce_str)
                        .unwrap_or_default()
                        .replace('"', "\\\"");
                    Some(format!("{k}=\"{v}\""))
                })
                .collect::<Vec<_>>()
                .join(",");
            add!("environment", Some(env));
        }
        Some(Value::String(s)) if !s.is_empty() => add!("environment", Some(s.clone())),
        _ => {}
    }

    lines.push(String::new()); // sondaki newline
    Ok(lines.join("\n"))
}

/// Bir .conf içindeki ilk `[program:name]` bölümünü form tanımına çözer.
pub fn parse_program_block(content: &str) -> Option<Value> {
    let mut name: Option<String> = None;
    let mut kv: Map<String, Value> = Map::new();
    let mut in_section = false;
    for raw in content.split('\n') {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("[program:") {
            if let Some(n) = rest.strip_suffix(']') {
                if in_section {
                    break; // yalnız ilk bölüm
                }
                name = Some(n.to_string());
                in_section = true;
                continue;
            }
        }
        if line.starts_with('[') {
            if in_section {
                break;
            }
            continue;
        }
        if !in_section {
            continue;
        }
        if let Some(eq) = line.find('=') {
            kv.insert(
                line[..eq].trim().to_string(),
                Value::String(line[eq + 1..].trim().to_string()),
            );
        }
    }
    let name = name?;

    let s = |k: &str| kv.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let num = |k: &str| -> Value {
        match kv.get(k).and_then(Value::as_str) {
            Some(v) if !v.is_empty() => v.parse::<i64>().map(Value::from).unwrap_or(Value::Null),
            _ => Value::Null,
        }
    };
    let boolish = |k: &str, default: bool| -> Value {
        match kv.get(k).and_then(Value::as_str) {
            Some(v) => Value::Bool(v == "true"),
            None => Value::Bool(default),
        }
    };

    // environment="A=\"x\"",B="y" -> [{key,value}]
    let mut env: Vec<Value> = Vec::new();
    if let Some(env_str) = kv.get("environment").and_then(Value::as_str) {
        let re = regex::Regex::new(r#"[^,]+="(?:[^"\\]|\\.)*"|[^,]+=[^,]*"#).unwrap();
        for m in re.find_iter(env_str) {
            let part = m.as_str();
            if let Some(i) = part.find('=') {
                if i > 0 {
                    let key = part[..i].trim().to_string();
                    let val = part[i + 1..].trim().trim_matches('"').to_string();
                    env.push(json!({ "key": key, "value": val }));
                }
            }
        }
    }

    let numprocs = match num("numprocs") {
        Value::Number(n) => n.as_i64().filter(|&x| x != 0).unwrap_or(1),
        _ => 1,
    };
    let autorestart = kv
        .get("autorestart")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("unexpected")
        .to_string();

    Some(json!({
        "name": name,
        "command": s("command"),
        "directory": s("directory"),
        "user": s("user"),
        "numprocs": numprocs,
        "process_name": s("process_name"),
        "priority": num("priority"),
        "umask": kv.get("umask").cloned().unwrap_or(Value::Null),
        "autostart": boolish("autostart", true),
        "autorestart": autorestart,
        "startsecs": num("startsecs"),
        "startretries": num("startretries"),
        "exitcodes": kv.get("exitcodes").cloned().unwrap_or(Value::Null),
        "stopsignal": if s("stopsignal").is_empty() { "TERM".to_string() } else { s("stopsignal") },
        "stopwaitsecs": num("stopwaitsecs"),
        "redirect_stderr": boolish("redirect_stderr", false),
        "stdout_logfile": s("stdout_logfile"),
        "stderr_logfile": s("stderr_logfile"),
        "environment": env,
    }))
}

/// Yeni bir [program] config'i tanımdan üretir ve uygular.
pub async fn add_program(server: &Value, def: &Value) -> AppResult<Value> {
    let block = build_program_block(def)?;
    let detected = list_config_files(server).await.ok();
    let dir = def
        .get("confDir")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            detected
                .as_ref()
                .and_then(|d| d.get("confDir"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "/etc/supervisor/conf.d".to_string());
    let name = def.get("name").and_then(Value::as_str).unwrap_or("program");
    let path = format!("{dir}/{name}.conf");
    write_config_file(server, &path, &block).await?;
    service::reload_config(server).await?;
    Ok(json!({ "path": path }))
}
