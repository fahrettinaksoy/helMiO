//! Helmio Agent
//! ------------
//! Hedef sunucuda supervisord'un YANINDA çalışan minik servis. Token korumalı
//! bir HTTP/JSON API sunar; her isteği YEREL supervisord'a XML-RPC ile
//! (unix socket veya localhost TCP) proxy'ler.
//!
//! Uçlar:
//!   GET  /health                 -> { ok, version }            (auth yok)
//!   POST /rpc { method, params }  -> { result } | { error }     (Bearer auth)
//!
//! Eski Node ajanının (legacy/agent) Rust portu — tek dosya, bağımsız binary.

use std::io::{Read, Write};
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use tiny_http::{Header, Method, Response, Server};

mod xmlrpc;

struct Config {
    host: String,
    port: u16,
    token: String,
    sv_socket: String,
    sv_host: String,
    sv_port: u16,
    sv_path: String,
    sv_user: String,
    sv_pass: String,
}

fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn load_config() -> Config {
    Config {
        host: env("AGENT_HOST", "0.0.0.0"),
        port: env("AGENT_PORT", "8787").parse().unwrap_or(8787),
        token: env("AGENT_TOKEN", ""),
        sv_socket: env("SUPERVISOR_SOCKET", ""),
        sv_host: env("SUPERVISOR_HOST", "127.0.0.1"),
        sv_port: env("SUPERVISOR_PORT", "9001").parse().unwrap_or(9001),
        sv_path: env("SUPERVISOR_PATH", "/RPC2"),
        sv_user: env("SUPERVISOR_USER", ""),
        sv_pass: env("SUPERVISOR_PASS", ""),
    }
}

/// Yerel supervisord'a tek XML-RPC çağrısı.
fn rpc(cfg: &Config, method: &str, params: &[Value]) -> Result<Value, String> {
    let body = xmlrpc::build_request(method, params);
    let auth = if cfg.sv_user.is_empty() {
        None
    } else {
        Some((cfg.sv_user.as_str(), cfg.sv_pass.as_str()))
    };
    let xml = if !cfg.sv_socket.is_empty() {
        let stream = std::os::unix::net::UnixStream::connect(&cfg.sv_socket)
            .map_err(|e| format!("socket bağlanamadı ({}): {e}", cfg.sv_socket))?;
        http_post(stream, "localhost", &cfg.sv_path, &body, auth)?
    } else {
        let stream = std::net::TcpStream::connect((cfg.sv_host.as_str(), cfg.sv_port))
            .map_err(|e| format!("TCP bağlanamadı: {e}"))?;
        http_post(stream, &cfg.sv_host, &cfg.sv_path, &body, auth)?
    };
    xmlrpc::parse_response(&xml)
}

/// Bir bayt akışı üzerinde minimal (senkron) HTTP/1.1 POST; yanıt gövdesini döner.
fn http_post<S: Read + Write>(
    mut stream: S,
    host: &str,
    path: &str,
    body: &str,
    auth: Option<(&str, &str)>,
) -> Result<String, String> {
    let mut req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: text/xml\r\n\
         Content-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some((u, p)) = auth {
        req.push_str(&format!(
            "Authorization: Basic {}\r\n",
            B64.encode(format!("{u}:{p}"))
        ));
    }
    req.push_str("\r\n");
    req.push_str(body);

    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).map_err(|e| e.to_string())?;

    let sep = b"\r\n\r\n";
    let idx = buf
        .windows(4)
        .position(|w| w == sep)
        .ok_or("bozuk HTTP yanıtı")?;
    String::from_utf8(buf[idx + 4..].to_vec()).map_err(|e| e.to_string())
}

fn json_response(status: u16, body: Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let data = body.to_string().into_bytes();
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    Response::from_data(data)
        .with_status_code(status)
        .with_header(header)
}

fn bearer(req: &tiny_http::Request) -> String {
    for h in req.headers() {
        if h.field.equiv("Authorization") {
            let v = h.value.as_str();
            if let Some(t) = v.strip_prefix("Bearer ") {
                return t.to_string();
            }
        }
    }
    String::new()
}

fn main() {
    let cfg = Arc::new(load_config());
    if cfg.token.is_empty() || cfg.token == "change-me" {
        eprintln!("[helmio-agent] AGENT_TOKEN ayarlı değil. Güvenlik için bir token belirleyin.");
        std::process::exit(1);
    }

    let addr = format!("{}:{}", cfg.host, cfg.port);
    let server = match Server::http(&addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[helmio-agent] {addr} dinlenemedi: {e}");
            std::process::exit(1);
        }
    };
    let target = if cfg.sv_socket.is_empty() {
        format!("{}:{}", cfg.sv_host, cfg.sv_port)
    } else {
        cfg.sv_socket.clone()
    };
    println!("[helmio-agent] http://{addr} -> supervisord @ {target}");

    for mut request in server.incoming_requests() {
        let method = request.method().clone();
        let url = request.url().to_string();

        // GET /health — auth yok.
        if method == Method::Get && url == "/health" {
            let resp = match rpc(&cfg, "supervisor.getSupervisorVersion", &[]) {
                Ok(v) => json_response(
                    200,
                    json!({ "ok": true, "version": v, "name": "helmio-agent" }),
                ),
                Err(e) => json_response(502, json!({ "ok": false, "error": e })),
            };
            let _ = request.respond(resp);
            continue;
        }

        // POST /rpc — Bearer auth.
        if method == Method::Post && url == "/rpc" {
            if bearer(&request) != cfg.token {
                let _ = request.respond(json_response(401, json!({ "error": "Yetkisiz" })));
                continue;
            }
            let mut body = String::new();
            if request.as_reader().read_to_string(&mut body).is_err() {
                let _ = request.respond(json_response(400, json!({ "error": "Gövde okunamadı" })));
                continue;
            }
            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let rpc_method = parsed.get("method").and_then(Value::as_str).unwrap_or("");
            if !rpc_method.starts_with("supervisor.") && !rpc_method.starts_with("system.") {
                let _ = request.respond(json_response(
                    400,
                    json!({ "error": "Geçersiz veya izinsiz method" }),
                ));
                continue;
            }
            let params: Vec<Value> = parsed
                .get("params")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let resp = match rpc(&cfg, rpc_method, &params) {
                Ok(result) => json_response(200, json!({ "result": result })),
                Err(e) => json_response(502, json!({ "error": e })),
            };
            let _ = request.respond(resp);
            continue;
        }

        let _ = request.respond(json_response(404, json!({ "error": "Bulunamadı" })));
    }
}
