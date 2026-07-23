//! SSH connector. Uzak supervisord'a SSH üzerinden ulaşır: her XML-RPC çağrısı
//! için ya uzak unix socket'e (direct-streamlocal) ya da bir host:port'a
//! (direct-tcpip) yönlendirilmiş bir kanal açar ve HTTP/XML-RPC'yi bu kanal
//! akışı üstünden konuşur. Saf Rust (russh) — libssh2/openssl sistem bağımlılığı
//! yok. Parola VEYA özel anahtar ile kimlik doğrulama.
//!
//! Not (perf): şimdilik her çağrıda yeni SSH handshake yapılır. Kalıcı bağlantı
//! önbelleği Faz 4/5'te eklenecek.

use std::sync::Arc;

use async_trait::async_trait;
use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::supervisor::connector::{field_int, field_opt, field_str, Connector, ExecOutput};
use crate::supervisor::{http, xmlrpc};

/// Sunucu anahtarını doğrulamaz (eski ssh2 Node bağlayıcısı da doğrulamıyordu).
struct ClientHandler;

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub struct SshConnector {
    ssh_host: String,
    ssh_port: u16,
    ssh_user: String,
    ssh_password: Option<String>,
    private_key: Option<String>,
    target: String, // "socket" | "tcp"
    socket_path: String,
    target_host: String,
    target_port: u32,
    rpc_path: String,
    auth: Option<(String, String)>,
}

impl SshConnector {
    pub fn new(server: &Value) -> AppResult<Self> {
        let ssh_host = field_str(server, "sshHost", "");
        let ssh_user = field_str(server, "sshUser", "");
        if ssh_host.is_empty() || ssh_user.is_empty() {
            return Err(AppError::new("SSH host ve kullanıcı adı gerekli."));
        }
        Ok(Self {
            ssh_host,
            ssh_port: field_int(server, "sshPort", 22) as u16,
            ssh_user,
            ssh_password: field_opt(server, "sshPassword"),
            private_key: field_opt(server, "privateKey"),
            target: field_str(server, "target", "socket"),
            socket_path: field_str(server, "socketPath", "/var/run/supervisor.sock"),
            target_host: field_str(server, "targetHost", "127.0.0.1"),
            target_port: field_int(server, "targetPort", 9001) as u32,
            rpc_path: field_str(server, "path", "/RPC2"),
            auth: field_opt(server, "username").map(|u| (u, field_str(server, "password", ""))),
        })
    }

    /// SSH oturumu kurar ve kimlik doğrular (önce anahtar, sonra parola).
    async fn connect(&self) -> AppResult<Handle<ClientHandler>> {
        let config = Arc::new(client::Config::default());
        let mut handle = client::connect(
            config,
            (self.ssh_host.as_str(), self.ssh_port),
            ClientHandler,
        )
        .await
        .map_err(|e| AppError::new(format!("SSH bağlantı hatası: {e}")))?;

        let mut authed = false;
        if let Some(pk) = &self.private_key {
            if let Ok(key) = decode_secret_key(pk, self.ssh_password.as_deref()) {
                authed = handle
                    .authenticate_publickey(
                        &self.ssh_user,
                        PrivateKeyWithHashAlg::new(Arc::new(key), None),
                    )
                    .await
                    .map(|r| r.success())
                    .unwrap_or(false);
            }
        }
        if !authed {
            if let Some(pw) = &self.ssh_password {
                authed = handle
                    .authenticate_password(&self.ssh_user, pw.clone())
                    .await
                    .map_err(|e| AppError::new(format!("SSH kimlik doğrulama hatası: {e}")))?
                    .success();
            }
        }
        if !authed {
            return Err(AppError::new(
                "SSH kimlik doğrulama başarısız (kullanıcı/parola/anahtar).",
            ));
        }
        Ok(handle)
    }
}

#[async_trait]
impl Connector for SshConnector {
    async fn call(&self, method: &str, params: Vec<Value>) -> AppResult<Value> {
        let handle = self.connect().await?;
        let channel = if self.target == "tcp" {
            handle
                .channel_open_direct_tcpip(
                    self.target_host.clone(),
                    self.target_port,
                    "127.0.0.1",
                    0,
                )
                .await
                .map_err(|e| AppError::new(format!("SSH TCP forward hatası: {e}")))?
        } else {
            handle
                .channel_open_direct_streamlocal(self.socket_path.clone())
                .await
                .map_err(|e| {
                    AppError::new(format!(
                        "SSH socket forward hatası ({}): {e}",
                        self.socket_path
                    ))
                })?
        };

        let stream = channel.into_stream();
        let body = xmlrpc::build_request(method, &params);
        let auth = self.auth.as_ref().map(|(u, p)| (u.as_str(), p.as_str()));
        let xml = http::post_xmlrpc(stream, &self.target_host, &self.rpc_path, &body, auth).await?;
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

        let handle = self.connect().await?;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::new(format!("SSH oturum kanalı açılamadı: {e}")))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| AppError::new(format!("SSH exec hatası: {e}")))?;

        if let Some(data) = input {
            let mut writer = channel.make_writer();
            let _ = writer.write_all(data.as_bytes()).await;
            let _ = writer.shutdown().await;
        }

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut code = 0i32;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
                ChannelMsg::ExtendedData { ref data, ext: 1 } => stderr.extend_from_slice(data),
                ChannelMsg::ExitStatus { exit_status } => code = exit_status as i32,
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            code,
        })
    }
}
