# Helmio Agent

supervisord ile **aynı sunucuya** kurulan küçük servis. Token korumalı HTTP API'si üzerinden Helmio paneli, yerel supervisord'a XML-RPC ile erişir. NAT/firewall arkasındaki sunucular için veya TCP XML-RPC portunu dışarı açmak istemediğinizde kullanışlıdır.

## Kurulum

```bash
# Sunucuya kopyalayın (veya repoyu klonlayıp `npm install` çalıştırın)
cd agent
cp .env.example .env
# .env içinde AGENT_TOKEN ve supervisord erişimini ayarlayın
node src/index.js
```

Üretimde supervisord'un kendisiyle yönetilmesi önerilir:

```ini
[program:helmio-agent]
command=node /opt/helmio/agent/src/index.js
directory=/opt/helmio/agent
autostart=true
autorestart=true
environment=AGENT_PORT="8787",AGENT_TOKEN="...",SUPERVISOR_SOCKET="/var/run/supervisor.sock"
```

## Yapılandırma (.env)

| Değişken | Açıklama |
| --- | --- |
| `AGENT_PORT` / `AGENT_HOST` | Agent'ın dinlediği adres (panel buraya bağlanır) |
| `AGENT_TOKEN` | Paylaşılan gizli anahtar (panel `Authorization: Bearer` ile gönderir) |
| `SUPERVISOR_SOCKET` | Yerel supervisord unix socket (ör. `/var/run/supervisor.sock`) |
| `SUPERVISOR_HOST` / `SUPERVISOR_PORT` | Socket yerine TCP kullanılacaksa |
| `SUPERVISOR_USER` / `SUPERVISOR_PASS` | supervisord HTTP auth (opsiyonel) |

## API

- `GET /health` → `{ ok, version }` (auth yok)
- `POST /rpc` `{ method, params }` → `{ result }` veya `{ error }` (Bearer auth) — yalnızca `supervisor.*` / `system.*` methodlarına izin verilir.

> Panelde sunucu eklerken **Helmio Agent** yöntemini seçip Agent URL (`http://sunucu:8787`) ve token girin.
