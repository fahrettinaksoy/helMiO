//! TCP XML-RPC connector (ÖNERİLEN). supervisord'un `[inet_http_server]` TCP
//! portuna doğrudan XML-RPC. Alanlar: host, port(9001), secure(https),
//! username, password, path(/RPC2).

use async_trait::async_trait;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::supervisor::connector::{field_bool, field_int, field_opt, field_str, Connector};
use crate::supervisor::xmlrpc;

pub struct TcpConnector {
    url: String,
    auth: Option<(String, String)>,
    client: reqwest::Client,
}

impl TcpConnector {
    pub fn new(server: &Value) -> AppResult<Self> {
        let host = field_str(server, "host", "");
        if host.is_empty() {
            return Err(AppError::new("Host tanımlı değil."));
        }
        let port = field_int(server, "port", 9001);
        let secure = field_bool(server, "secure", false);
        let path = field_str(server, "path", "/RPC2");
        let scheme = if secure { "https" } else { "http" };
        let url = format!("{scheme}://{host}:{port}{path}");
        let auth = field_opt(server, "username").map(|u| (u, field_str(server, "password", "")));
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| AppError::new(format!("HTTP istemcisi kurulamadı: {e}")))?;
        Ok(Self { url, auth, client })
    }
}

#[async_trait]
impl Connector for TcpConnector {
    async fn call(&self, method: &str, params: Vec<Value>) -> AppResult<Value> {
        let body = xmlrpc::build_request(method, &params);
        let mut req = self
            .client
            .post(&self.url)
            .header("Content-Type", "text/xml")
            .body(body);
        if let Some((u, p)) = &self.auth {
            req = req.basic_auth(u, Some(p));
        }
        let resp = req.send().await.map_err(normalize)?;
        let text = resp
            .text()
            .await
            .map_err(|e| AppError::new(format!("Yanıt okunamadı: {e}")))?;
        xmlrpc::parse_response(&text)
    }

    fn supports_multicall(&self) -> bool {
        true
    }
}

fn normalize(e: reqwest::Error) -> AppError {
    if e.is_timeout() {
        AppError::new("Sunucuya ulaşılamadı (timeout).")
    } else if e.is_connect() {
        AppError::new(
            "Bağlantı reddedildi — supervisord açık değil veya [inet_http_server] portu yanlış.",
        )
    } else {
        AppError::new(format!("Bağlantı hatası: {e}"))
    }
}
