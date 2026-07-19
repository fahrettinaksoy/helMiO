//! Helmio Agent connector. Hedef sunucudaki ajan XML-RPC'yi yerel supervisord'a
//! proxy'ler; burada yalnızca method/params'ı Bearer token ile HTTP(S) POST'larız.
//! Alanlar: agentUrl, agentToken.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::supervisor::connector::{field_str, Connector};

pub struct AgentConnector {
    base: String,
    token: String,
    client: reqwest::Client,
}

impl AgentConnector {
    pub fn new(server: &Value) -> AppResult<Self> {
        let base = field_str(server, "agentUrl", "")
            .trim_end_matches('/')
            .to_string();
        if base.is_empty() {
            return Err(AppError::new("Agent URL tanımlı değil."));
        }
        let token = field_str(server, "agentToken", "");
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| AppError::new(format!("HTTP istemcisi kurulamadı: {e}")))?;
        Ok(Self {
            base,
            token,
            client,
        })
    }
}

#[async_trait]
impl Connector for AgentConnector {
    async fn call(&self, method: &str, params: Vec<Value>) -> AppResult<Value> {
        let resp = self
            .client
            .post(format!("{}/rpc", self.base))
            .bearer_auth(&self.token)
            .json(&json!({ "method": method, "params": params }))
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    AppError::new("Agent zaman aşımı.")
                } else {
                    AppError::new(format!("Agent'a ulaşılamadı: {e}"))
                }
            })?;

        let status = resp.status();
        let data: Value = resp
            .json()
            .await
            .map_err(|_| AppError::new(format!("Agent geçersiz yanıt döndü (HTTP {status}).")))?;

        if !status.is_success() {
            if status.as_u16() == 401 {
                return Err(AppError::new("Agent: yetkisiz (token hatalı)."));
            }
            let msg = data
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("Agent hatası (HTTP {status})."));
            return Err(AppError::new(msg));
        }
        Ok(data.get("result").cloned().unwrap_or(Value::Null))
    }

    fn supports_multicall(&self) -> bool {
        true
    }
}
