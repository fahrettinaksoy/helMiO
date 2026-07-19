# Helmio

> **Helmio — Take control of your processes.**
> A cross-platform **desktop app** to monitor and manage **Supervisor (supervisord)** across one or many Linux servers.

**English** · [Türkçe](README.tr.md)

[![CI](https://github.com/fahrettinaksoy/helmio/actions/workflows/ci.yml/badge.svg)](https://github.com/fahrettinaksoy/helmio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app)
[![Rust](https://img.shields.io/badge/rust-1.96-orange.svg)](src-tauri/rust-toolchain.toml)

Helmio lets you watch and control every `supervisord` process and process group running across your Linux servers from **a single desktop window** — status tracking, start/stop/restart, live log streaming, configuration editing, health checks, alerting, and fleet-wide bulk orchestration.

It is a **local-first desktop application** (Tauri v2): the UI, the connection logic, and all data live on your machine. There is no server to deploy and no account to create — a single-user tool that connects out to your `supervisord` instances.

---

## Highlights

- **5 connection methods** — direct TCP XML-RPC, local Unix socket, SSH tunnel, Docker (`docker exec`), or the Helmio Agent. Add a server, test the channel, done.
- **Live process view** — per-server snapshots every few seconds: state, PID, uptime, CPU/RAM, restart count, flapping detection.
- **Full control** — start/stop/restart/signal at the process, group, or whole-server level; send stdin; clear logs.
- **Live + downloadable logs** — tail process and daemon logs in real time; page back through history; download the full log.
- **Config editing** — browse and edit `supervisord` config files, and add new `[program:…]` blocks with a form-based builder.
- **Health checks** — HTTP / TCP / script probes with automatic restart after N consecutive failures.
- **Alerting** — route FATAL / flapping / health-check alerts to Slack, Discord, Telegram, a generic webhook, or email.
- **Fleet orchestration** — run an action across many servers in parallel or as a rolling (sequential) restart.
- **One-click install** — detect and install Supervisor over a shell connection (SSH / Docker / local) with best-practice config.
- **Host metrics & trends** — load, memory, disk gauges and time-series charts.
- **Turkish + English** UI, light/dark theme, audit log.

---

## Architecture

- **Frontend** (`src/`) — Vue 3 + Vuetify + Pinia + vue-router + vue-i18n, running in the Tauri WebView. Talks to the backend only through Tauri IPC (`src/api/*`).
- **Backend** (`src-tauri/`) — Rust. Connectors, the supervisord service layer, realtime pollers, health-check scheduler, notifier, and installer. Local data (servers, channels, health checks, metrics, audit) is stored in **SQLite** (`tauri-plugin-sql`); connection secrets are encrypted at rest with **AES-256-GCM**.
- **Agent** (`agent/`) — an optional tiny Rust binary you deploy **on a target host** next to `supervisord`; it exposes a token-protected HTTP/JSON API that Helmio calls (for hosts you can't reach directly by TCP/SSH).

The Vue UI never talks to a network backend — it calls Rust commands over Tauri IPC, and the Rust side reaches out to your `supervisord` servers via XML-RPC, SSH, `docker exec`, or the agent.

---

## Connection methods

| Method                        | How it reaches supervisord                    | Use when                                    |
| ----------------------------- | --------------------------------------------- | ------------------------------------------- |
| **TCP XML-RPC** (recommended) | Direct XML-RPC to `[inet_http_server]`        | The daemon exposes a TCP port you can reach |
| **Local Unix socket**         | XML-RPC over `[unix_http_server]` socket      | Helmio runs on the same host                |
| **SSH tunnel**                | XML-RPC tunneled over SSH (socket or TCP)     | You have SSH access, no open port           |
| **Docker (exec)**             | `docker exec supervisorctl …`                 | supervisord runs inside a container         |
| **Helmio Agent**              | HTTP/JSON to the agent, which proxies locally | NAT/firewall — nothing else reachable       |

Connection secrets (passwords, private keys, agent tokens) are encrypted before they touch disk.

---

## Quick start (development)

Prerequisites: **Node ≥ 20**, **Rust 1.96** (see [`src-tauri/rust-toolchain.toml`](src-tauri/rust-toolchain.toml)), and the [Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS.

```bash
npm install
npm run tauri:dev      # launches the desktop app with hot reload
```

Other scripts:

```bash
npm run dev            # Vite dev server only (no desktop shell)
npm run build          # build the frontend
npm run tauri:build    # build the desktop installers
npm run lint           # ESLint
npm run format         # Prettier
```

---

## The Helmio Agent

For hosts you can't reach directly, deploy the agent next to `supervisord`:

```bash
cd agent
cargo build --release
AGENT_TOKEN=<a-strong-secret> \
SUPERVISOR_SOCKET=/var/run/supervisor.sock \
./target/release/helmio-agent
```

Then add a server in Helmio using the **Agent** method with the agent's URL and the same token. Configuration (all via env vars): `AGENT_PORT` (8787), `AGENT_HOST`, `AGENT_TOKEN` (required), and the supervisord target — `SUPERVISOR_SOCKET` **or** `SUPERVISOR_HOST`/`SUPERVISOR_PORT`, plus optional `SUPERVISOR_PATH` / `SUPERVISOR_USER` / `SUPERVISOR_PASS`.

---

## Target-server prerequisites

- **Supervisor** installed and running (or use Helmio's one-click install over a shell connector).
- For the **TCP** method, `supervisord.conf` must expose an `[inet_http_server]` (Helmio's installer sets this up with a password-protected `127.0.0.1:9001` by default).
- For **SSH / local / docker** methods, a `[unix_http_server]` socket is enough.

---

## Data & security

- All data is local (SQLite in the app data directory). No telemetry, no remote server.
- Secrets are encrypted at rest (AES-256-GCM); the key lives in the app config directory (`.secret-key`, mode `0600`) or the `HELMIO_SECRET_KEY` environment variable.
- Logs (JS + Rust) go to a single rotating file in the app log directory.

---

## Contributing & docs

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
