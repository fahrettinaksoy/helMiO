//! Yerel Unix socket connector. Aynı makinedeki supervisord'un
//! `[unix_http_server]` socket'ine port açmadan XML-RPC. Alanlar: socketPath
//! (/var/run/supervisor.sock), username, password, path(/RPC2).
//!
//! Yalnız Unix. Windows'ta `new` hata döner.

use async_trait::async_trait;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::supervisor::connector::{field_opt, field_str, Connector, ExecOutput};

pub struct LocalConnector {
    socket_path: String,
    rpc_path: String,
    auth: Option<(String, String)>,
}

impl LocalConnector {
    pub fn new(server: &Value) -> AppResult<Self> {
        if !cfg!(unix) {
            return Err(AppError::new(
                "Yerel Unix socket bağlantısı yalnız macOS/Linux'ta desteklenir.",
            ));
        }
        Ok(Self {
            socket_path: field_str(server, "socketPath", "/var/run/supervisor.sock"),
            rpc_path: field_str(server, "path", "/RPC2"),
            auth: field_opt(server, "username").map(|u| (u, field_str(server, "password", ""))),
        })
    }
}

#[cfg(unix)]
#[async_trait]
impl Connector for LocalConnector {
    async fn call(&self, method: &str, params: Vec<Value>) -> AppResult<Value> {
        use crate::supervisor::http;
        use crate::supervisor::xmlrpc;

        let stream = tokio::net::UnixStream::connect(&self.socket_path)
            .await
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => AppError::new(format!(
                    "Socket bulunamadı: {} (supervisord çalışıyor mu, yol doğru mu?)",
                    self.socket_path
                )),
                std::io::ErrorKind::PermissionDenied => {
                    AppError::new(format!("Socket erişim izni yok: {}", self.socket_path))
                }
                _ => AppError::new(format!("Socket bağlantı hatası: {e}")),
            })?;

        let body = xmlrpc::build_request(method, &params);
        let auth = self.auth.as_ref().map(|(u, p)| (u.as_str(), p.as_str()));
        let xml = http::post_xmlrpc(stream, "localhost", &self.rpc_path, &body, auth).await?;
        xmlrpc::parse_response(&xml)
    }

    fn supports_multicall(&self) -> bool {
        true
    }

    fn supports_exec(&self) -> bool {
        true
    }

    async fn exec(&self, command: &str, input: Option<&str>) -> AppResult<ExecOutput> {
        use tokio::io::AsyncWriteExt;
        use tokio::process::Command;

        let mut child = Command::new("sh")
            .arg("-c")
            .arg(command)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| AppError::new(format!("Komut başlatılamadı: {e}")))?;

        if let Some(data) = input {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(data.as_bytes()).await;
                let _ = stdin.shutdown().await;
            }
        }

        let out = child
            .wait_with_output()
            .await
            .map_err(|e| AppError::new(format!("Komut çalıştırılamadı: {e}")))?;
        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            code: out.status.code().unwrap_or(0),
        })
    }
}

// Windows: yalnız derlensin diye trait boş uygulanır (new zaten hata döndürür).
#[cfg(not(unix))]
#[async_trait]
impl Connector for LocalConnector {
    async fn call(&self, _method: &str, _params: Vec<Value>) -> AppResult<Value> {
        Err(AppError::new(
            "Yerel Unix socket bağlantısı yalnız macOS/Linux'ta desteklenir.",
        ))
    }
}
