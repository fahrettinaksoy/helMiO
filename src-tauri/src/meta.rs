//! UI'ın bağlı olduğu statik kataloglar (eski backend'deki sabitlerle birebir):
//! bağlantı yöntemleri, kanal tipleri/alarm tipleri, sağlık kontrolü tip/eylemleri.

use serde_json::{json, Value};

/// Eski `CONNECTION_METHODS` (connectors/index.js). `recommended` sıralama/rozet
/// için; `fields` form alanlarını belirler.
pub fn connection_methods() -> Value {
    json!([
        {
            "id": "tcp",
            "label": "TCP XML-RPC (inet_http_server)",
            "recommended": true,
            "available": true,
            "description": "supervisord'un TCP portuna doğrudan XML-RPC. En verimli, en az kurulum. Uzak/WSL/Docker (port publish) için ideal.",
            "fields": ["host", "port", "secure", "username", "password", "path"]
        },
        {
            "id": "local",
            "label": "Yerel Unix Socket",
            "recommended": false,
            "available": true,
            "description": "Aynı makinedeki supervisord socket'ine port açmadan bağlanır. Yerel dev (macOS/Linux) veya socket mount edilmiş Docker için.",
            "fields": ["socketPath", "username", "password", "path"]
        },
        {
            "id": "ssh",
            "label": "SSH tüneli",
            "recommended": false,
            "available": true,
            "description": "supervisord unix socket / localhost TCP erişimi SSH üzerinden. Port açmaya gerek yok, SSH erişimi yeterli.",
            "fields": ["sshHost", "sshPort", "sshUser", "sshPassword", "privateKey", "target", "socketPath", "targetHost", "targetPort", "username", "password", "path"]
        },
        {
            "id": "docker",
            "label": "Docker (exec)",
            "recommended": false,
            "available": true,
            "description": "Container içindeki supervisord'a port açmadan, docker exec ile erişir. Helmio'nun Docker daemon'a erişimi gerekir.",
            "fields": ["container", "connection", "dockerSocket", "dockerHost", "dockerPort", "confPath"]
        },
        {
            "id": "agent",
            "label": "Helmio Agent",
            "recommended": false,
            "available": true,
            "description": "Hedef sunucuya kurulan ajan, supervisord'a yerelden bağlanır. NAT/firewall arkası için ideal.",
            "fields": ["agentUrl", "agentToken"]
        }
    ])
}

/// Eski `channels/meta` yanıtı: `{ types, alertTypes }`.
pub fn channel_meta() -> Value {
    json!({
        "types": ["webhook", "slack", "discord", "telegram", "email"],
        "alertTypes": ["fatal", "flapping", "healthcheck"]
    })
}

/// Eski `healthchecks/meta` yanıtı: `{ types, actions }`.
pub fn healthcheck_meta() -> Value {
    json!({
        "types": ["http", "tcp", "script"],
        "actions": ["restart", "alert"]
    })
}
