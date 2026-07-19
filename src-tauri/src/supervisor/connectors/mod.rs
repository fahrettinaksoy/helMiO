//! Somut connector'lar ve fabrika. SSH ve Docker Faz 3B'de eklenecek.

mod agent;
mod docker;
mod local;
mod ssh;
mod tcp;

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::supervisor::connector::Connector;

/// Sunucu tanımına (secret'ları çözülmüş, flat) göre uygun connector'ı kurar.
pub fn create_connector(server: &Value) -> AppResult<Box<dyn Connector>> {
    match server.get("method").and_then(Value::as_str) {
        Some("tcp") => Ok(Box::new(tcp::TcpConnector::new(server)?)),
        Some("agent") => Ok(Box::new(agent::AgentConnector::new(server)?)),
        Some("local") => Ok(Box::new(local::LocalConnector::new(server)?)),
        Some("docker") => Ok(Box::new(docker::DockerConnector::new(server)?)),
        Some("ssh") => Ok(Box::new(ssh::SshConnector::new(server)?)),
        Some(m) => Err(AppError::new(format!("Bilinmeyen bağlantı yöntemi: {m}"))),
        None => Err(AppError::new("Bağlantı yöntemi belirtilmemiş.")),
    }
}
