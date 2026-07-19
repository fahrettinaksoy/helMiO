//! `Connector` — tek bir supervisord sunucusunun XML-RPC API'sine ulaşan tekdüze
//! arayüz. Somut connector'lar yalnız TAŞIMA biçiminde ayrışır (doğrudan TCP,
//! yerel Unix socket, SSH tüneli, Docker exec, uzak agent).

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

/// Tek bir XML-RPC çağrısı (multicall öğesi).
pub struct Call {
    pub method_name: String,
    pub params: Vec<Value>,
}

impl Call {
    pub fn new(method: &str) -> Self {
        Self {
            method_name: method.to_string(),
            params: vec![],
        }
    }
    #[allow(dead_code)] // Faz 4: parametreli multicall çağrıları
    pub fn with(method: &str, params: Vec<Value>) -> Self {
        Self {
            method_name: method.to_string(),
            params,
        }
    }
}

/// Bir multicall öğesinin sonucu: değer VEYA hata (ikisi bir arada değil).
#[derive(Clone)]
pub struct CallResult {
    pub value: Option<Value>,
    pub error: Option<String>,
}

/// Shell komutu çıktısı (exec destekleyen connector'lar için).
#[allow(dead_code)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

#[async_trait]
pub trait Connector: Send + Sync {
    /// Ham XML-RPC çağrısı (ör. "supervisor.getAllProcessInfo").
    async fn call(&self, method: &str, params: Vec<Value>) -> AppResult<Value>;

    /// Taşıma `system.multicall`'ı destekliyor mu? (tcp/local/ssh/agent → true)
    fn supports_multicall(&self) -> bool {
        false
    }

    /// Mümkünse çağrıları tek round-trip'te toplar; değilse ardışık düşer.
    async fn multicall(&self, calls: Vec<Call>) -> AppResult<Vec<CallResult>> {
        if self.supports_multicall() {
            let arr = Value::Array(
                calls
                    .iter()
                    .map(|c| json!({ "methodName": c.method_name, "params": c.params }))
                    .collect(),
            );
            if let Ok(Value::Array(items)) = self.call("system.multicall", vec![arr]).await {
                if items.len() == calls.len() {
                    return Ok(items.into_iter().map(unwrap_multicall_item).collect());
                }
            }
            // multicall başarısız/uyumsuz → ardışık dene.
        }
        let mut out = Vec::with_capacity(calls.len());
        for c in calls {
            match self.call(&c.method_name, c.params).await {
                Ok(v) => out.push(CallResult {
                    value: Some(v),
                    error: None,
                }),
                Err(e) => out.push(CallResult {
                    value: None,
                    error: Some(e.error),
                }),
            }
        }
        Ok(out)
    }

    /// Ulaşılabilirlik + kimlik probu (tek round-trip'e toplanır).
    async fn ping(&self) -> AppResult<Value> {
        let res = self
            .multicall(vec![
                Call::new("supervisor.getSupervisorVersion"),
                Call::new("supervisor.getState"),
                Call::new("supervisor.getIdentification"),
            ])
            .await?;
        if let Some(e) = res.get(1).and_then(|r| r.error.clone()) {
            return Err(AppError::new(e));
        }
        Ok(json!({
            "version": res.first().and_then(|r| r.value.clone()).unwrap_or(Value::Null),
            "state": res.get(1).and_then(|r| r.value.clone()).unwrap_or(Value::Null),
            "identification": res.get(2).and_then(|r| r.value.clone()).unwrap_or(Value::Null),
        }))
    }

    /// Bu connector rastgele shell komutu çalıştırabilir mi? (local/ssh/docker)
    #[allow(dead_code)] // Faz 4/6: diagnose/install/config/host için
    fn supports_exec(&self) -> bool {
        false
    }

    /// Hedefte shell komutu çalıştırır (diagnose/install/config/host için).
    #[allow(dead_code)]
    async fn exec(&self, _command: &str, _input: Option<&str>) -> AppResult<ExecOutput> {
        Err(AppError::new(
            "Bu bağlantı türü shell komutu çalıştırmayı desteklemiyor.",
        ))
    }

    /// Kalıcı kaynakları (tünel, socket) serbest bırakır.
    async fn close(&self) {}
}

/// system.multicall zarfını açar: başarı `[value]` (tek elemanlı dizi), fault ise
/// `{faultCode, faultString}` struct'ı olarak gelir.
fn unwrap_multicall_item(item: Value) -> CallResult {
    if let Value::Object(ref m) = item {
        if m.contains_key("faultString") || m.contains_key("faultCode") {
            let msg = m
                .get("faultString")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    format!(
                        "fault {}",
                        m.get("faultCode").and_then(Value::as_i64).unwrap_or(0)
                    )
                });
            return CallResult {
                value: None,
                error: Some(msg),
            };
        }
    }
    let value = match item {
        Value::Array(mut arr) if arr.len() == 1 => arr.pop().unwrap(),
        other => other,
    };
    CallResult {
        value: Some(value),
        error: None,
    }
}

// --- Sunucu tanımından alan okuma yardımcıları ------------------------------

pub fn field_str(server: &Value, key: &str, default: &str) -> String {
    server
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(default)
        .to_string()
}

pub fn field_opt(server: &Value, key: &str) -> Option<String> {
    server
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub fn field_int(server: &Value, key: &str, default: i64) -> i64 {
    server
        .get(key)
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(default)
}

pub fn field_bool(server: &Value, key: &str, default: bool) -> bool {
    server
        .get(key)
        .and_then(|v| {
            v.as_bool()
                .or_else(|| v.as_str().map(|s| s == "true" || s == "1"))
        })
        .unwrap_or(default)
}
