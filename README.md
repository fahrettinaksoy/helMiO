# helMiO

> **Helmio — Take control of your processes.**
> Multi-server **Supervisor (supervisord)** management and monitoring platform.

**English** · [Türkçe](README.tr.md)

[![CI](https://github.com/fahrettinaksoy/helmio/actions/workflows/ci.yml/badge.svg)](https://github.com/fahrettinaksoy/helmio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](.nvmrc)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/code%20of%20conduct-v2.1-blue.svg)](CODE_OF_CONDUCT.md)

Helmio lets you monitor and manage every `supervisord` master and child process (process / process group) running across one or dozens of Linux servers from **a single panel**. Status tracking, start/stop/restart, live log streaming, configuration editing, health checks, alerting/notification channels, fleet-wide bulk orchestration, role-based access control (RBAC) and an audit log are all gathered under one roof.

---

## Table of contents

- [Highlights](#highlights)
- [Screenshots](#screenshots)
- [Architecture](#architecture)
- [Connection methods (connector)](#connection-methods-connector)
- [Environment-based connection guide](#environment-based-connection-guide)
- [Quick start](#quick-start)
- [Configuration (environment variables)](#configuration-environment-variables)
- [Target server prerequisites](#target-server-prerequisites)
- [Components](#components)
  - [Backend](#backend-helmiobackend)
  - [Frontend](#frontend-helmiofrontend)
  - [Helmio Agent](#helmio-agent-helmioagent)
  - [Event Listener](#event-listener-eventlistener)
- [Security and authorization](#security-and-authorization)
- [REST API & API tokens (CI/CD)](#rest-api--api-tokens-cicd)
- [Realtime layer (Socket.IO)](#realtime-layer-socketio)
- [Health checks & auto-restart](#health-checks--auto-restart)
- [Alerting & notification channels](#alerting--notification-channels)
- [Fleet orchestration](#fleet-orchestration)
- [Data store](#data-store)
- [Tests](#tests)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## Highlights

| Area                        | Description                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-server**            | Unlimited server registrations, each with its own connection method. The connector architecture binds to every server the most suitable way. |
| **5 connection methods**    | TCP XML-RPC, local Unix socket, SSH tunnel, Docker (exec), Helmio Agent. Management is possible without opening a port on the target server. |
| **Realtime status**         | The process/group status table updates live over Socket.IO; eventlistener push + background polling combined.                                |
| **Process control**         | start / stop / restart, single and group, signal sending, writing to stdin, log clearing.                                                    |
| **Bulk operations**         | Bulk signal and clear-all-logs within a server; parallel/sequential (rolling) bulk start/stop/restart fleet-wide.                            |
| **Live logs**               | Realtime stdout/stderr streaming + scroll-back (offset-based history reading), server-side full log download, in-log search/filter.          |
| **Config management**       | Raw `.conf` editor + guided program builder (templates, live preview), `reread` / `update`.                                                  |
| **Monitoring & trends**     | Per-process CPU/memory + host metrics time series, dependency-free SVG trend/donut charts, persisted history.                                |
| **Health checks**           | Per-process HTTP / TCP / script probe; auto-restart or warning on threshold breach.                                                          |
| **Alerting & notification** | FATAL and flapping detection; routing to Slack / Discord / Telegram / webhook / e-mail channels.                                             |
| **Auth & RBAC**             | JWT sessions, bcrypt passwords, 3 roles (admin / operator / viewer), audit log, login rate-limit.                                            |
| **API tokens**              | Role-based `hmo_…` tokens for CI/CD; `Authorization: Bearer` or `X-Helmio-Api-Key`.                                                          |
| **Security**                | All secrets (server passwords, channel credentials) are AES-256-GCM encrypted on disk; masked in API responses.                              |
| **Install wizard**          | If supervisord is missing on the target, detect + install (apt/apk) from the panel with a live install log.                                  |
| **i18n**                    | Turkish and English interface.                                                                                                               |

---

## Screenshots

<table>
  <tr>
    <td width="50%" valign="top">
      <b>📊 Dashboard</b><br/>
      <img src="screenshots/dashboard.png" alt="Dashboard" width="100%"/><br/>
      <sub>Fleet-wide KPIs, the "fleet health" bar and insight cards: problem processes, state distribution (donut), connection methods and last-24h activity.</sub>
    </td>
    <td width="50%" valign="top">
      <b>🖥️ Servers</b><br/>
      <img src="screenshots/servers.png" alt="Servers" width="100%"/><br/>
      <sub>All <code>supervisord</code> connections in card/table view: method, connection, status (running/total/faulty) and a live CPU/memory resource summary.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <b>📋 Server detail — process table</b><br/>
      <img src="screenshots/server-detail.png" alt="Server detail — process table" width="100%"/><br/>
      <sub>Grouped process list (PID, uptime, description), status filters, trend charts and inline start/stop/restart actions.</sub>
    </td>
    <td width="50%" valign="top">
      <b>⚙️ Actions menu</b><br/>
      <img src="screenshots/server-detail-2.png" alt="Actions menu" width="100%"/><br/>
      <sub>Bulk operations for all processes (start/stop/restart all, signal all, clear all logs) and server tools: Diagnose/Install, Event Listener, Health Checks, Config.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <b>🩺 Supervisor install & diagnostics</b><br/>
      <img src="screenshots/server-detail-3.png" alt="Supervisor install & diagnostics" width="100%"/><br/>
      <sub>XML-RPC access, supervisord installation and operating-system (package manager) detection; install from the panel if needed.</sub>
    </td>
    <td width="50%" valign="top">
      <b>⚡ Event Listener setup</b><br/>
      <img src="screenshots/server-detail-4.png" alt="Event Listener" width="100%"/><br/>
      <sub>One-click setup of the push-based event listener, manual setup instructions and a live event feed.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <b>❤️ Add health check</b><br/>
      <img src="screenshots/server-detail-5.png" alt="Health Checks" width="100%"/><br/>
      <sub>Per-process HTTP / TCP / Script probe definition: expected status, interval, failure threshold, timeout and on-failure behavior (restart / warn only).</sub>
    </td>
    <td width="50%" valign="top">
      <b>📝 Config editing</b><br/>
      <img src="screenshots/server-detail-6.png" alt="Config" width="100%"/><br/>
      <sub>Raw <code>.conf</code> editor and guided "Add Program" flow; save + <code>reread</code>/<code>update</code>.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <b>📜 Live log stream</b><br/>
      <img src="screenshots/server-detail-7.png" alt="Live log" width="100%"/><br/>
      <sub>Live follow for <code>supervisord</code> and process logs, in-log search, download and clear.</sub>
    </td>
    <td width="50%" valign="top">
      <b>🚀 Fleet operations</b><br/>
      <img src="screenshots/fleet-operations.png" alt="Fleet Operations" width="100%"/><br/>
      <sub>One action across many servers at once: server selection, action and <b>parallel</b> or <b>sequential (rolling)</b> strategy, per-server result.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <b>🔔 Notification channels</b><br/>
      <img src="screenshots/notification-channels.png" alt="Notification Channels" width="100%"/><br/>
      <sub>Slack / Discord / Telegram / webhook / e-mail channels; filters by server and alert type (FATAL, Flapping), enable/disable and test delivery.</sub>
    </td>
    <td width="50%" valign="top">
      <b>🔑 API tokens (CI/CD)</b><br/>
      <img src="screenshots/api-tokens.png" alt="API Tokens" width="100%"/><br/>
      <sub>Role-based <code>hmo_…</code> tokens; programmatic access via <code>Authorization: Bearer</code> or <code>X-Helmio-Api-Key</code>, with last-used tracking.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <b>👥 Users & roles</b><br/>
      <img src="screenshots/users.png" alt="Users" width="100%"/><br/>
      <sub>Panel access and role assignment (admin / operator / viewer), status and last-login info.</sub>
    </td>
    <td width="50%" valign="top">
      <b>🧾 Audit log</b><br/>
      <img src="screenshots/audit-log.png" alt="Audit Log" width="100%"/><br/>
      <sub>Who did what, and when: searchable audit trail with actor/action/server filters, status and IP.</sub>
    </td>
  </tr>
</table>

---

## Architecture

The project is an **npm workspace monorepo** (`workspaces`: `backend`, `frontend`, `agent`).

```
helmio/
├── backend/         Express + Socket.IO API; connects to supervisord via connectors (Node ≥20)
├── frontend/        Vue 3 + Vuetify 3 + Pinia + Vue Router + Socket.IO client (Vite)
├── agent/           Token-protected XML-RPC proxy agent installed on the target server (optional)
├── eventlistener/   supervisord eventlistener bridge — pushes events to the backend (Python 3, optional)
└── test/            Smoke tests + Docker-based install/test harness
```

### Data flow

```
                 ┌──────────────────────────────────────────────┐
   Browser ──►   │  Frontend (Vite :5173)                        │
   (Vue 3)       │  Axios REST  ·  Socket.IO client              │
                 └───────────────┬──────────────────────────────┘
                                 │  /api  +  /socket.io  (proxied in dev)
                 ┌───────────────▼──────────────────────────────┐
                 │  Backend (Express + Socket.IO  :3001)         │
                 │  Auth/RBAC · Connectors · Services · Stores   │
                 └───┬───────────┬───────────┬──────────┬────────┘
            TCP/RPC  │   SSH     │   Docker   │  HTTP    │  ◄── HTTP POST (ingest)
                     ▼   tunnel  ▼   exec     ▼  +token  ▼      (eventlistener push)
                 supervisord  supervisord  supervisord  Helmio Agent ──► supervisord
```

- In development the **frontend** proxies `/api` and `/socket.io` requests to `localhost:3001` via the Vite proxy.
- The **backend** creates and caches a **connector** instance per server; on XML-RPC calls it batches requests into a single round-trip with `system.multicall`.
- The **Event Listener** and **Agent** are optional; they come into play depending on the connection method.

---

## Connection methods (connector)

The backend offers 5 methods built on a shared `BaseConnector` under `src/connectors/`. The method is chosen in the UI when adding a server.

| Method (`id`)                   | Description                                                                                                                                                                    | Port on target? | Status |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ------ |
| **TCP XML-RPC** (`tcp`)         | Direct XML-RPC to the supervisord `[inet_http_server]` TCP port (e.g. `:9001`). **Most efficient / recommended.**                                                              | Required        | ✅     |
| **Local Unix Socket** (`local`) | Connects to a supervisord socket on the same machine without opening a port.                                                                                                   | No              | ✅     |
| **SSH tunnel** (`ssh`)          | The supervisord unix socket / localhost TCP port is forwarded over SSH. Only SSH access is needed.                                                                             | No              | ✅     |
| **Docker (exec)** (`docker`)    | Reaches supervisord inside a container via `docker exec`; nothing is installed in the container, no port is opened. Helmio needs access to the Docker daemon.                  | No              | ✅     |
| **Helmio Agent** (`agent`)      | An agent ([agent/](agent/)) installed on the target server connects to supervisord locally; the panel reaches it over token-authenticated HTTP. Ideal for behind NAT/firewall. | Agent port      | ✅     |

> **Note:** TCP XML-RPC is the lowest-latency method that requires the least setup. It is enough for the `[inet_http_server]` section to be enabled in `supervisord.conf` on the target server. Connector instances are cached by server `id` and rebuilt when the definition changes (`updatedAt`).

---

## Environment-based connection guide

| Environment                   | Recommended method   | Notes                                                                                                                                                                         |
| ----------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS / Linux (local dev)** | Local Unix Socket    | The Homebrew socket is usually `/opt/homebrew/var/run/supervisor.sock`. No port needed. Use SSH/TCP if remote.                                                                |
| **Windows + WSL2**            | TCP XML-RPC          | Bind `inet_http_server` to `0.0.0.0:9001` inside WSL; reach it from the host via `localhost:9001` thanks to WSL2 _localhostForwarding_. Alternative: `sshd` + SSH inside WSL. |
| **Docker container**          | Docker (exec) or TCP | If you don't want to open a port, use Docker (exec) — Helmio needs access to `/var/run/docker.sock`. Or publish `-p 9001:9001` and use TCP.                                   |
| **Remote Linux server**       | SSH tunnel or TCP    | SSH works without opening any port; for TCP bind `inet_http_server` to `0.0.0.0:9001`. Use the Agent behind NAT.                                                              |

> The Docker (exec) method requires you to mount the host's Docker socket if Helmio runs inside a container: `-v /var/run/docker.sock:/var/run/docker.sock`. For the Agent method see [agent/README.md](agent/README.md).

---

## Quick start

Requirement: **Node.js ≥ 20**.

```bash
# 1) Install all workspace dependencies
npm install

# 2) Backend (:3001) + frontend (:5173) together (watch mode)
npm run dev
```

- Backend API: <http://localhost:3001>
- Frontend: <http://localhost:5173>

On first launch the panel greets you with a **setup** screen: you create the first **admin** user. After that you can add your servers via **Servers → Add Server**.

### Useful scripts (root `package.json`)

| Command                | Function                                           |
| ---------------------- | -------------------------------------------------- |
| `npm run dev`          | Starts backend + frontend together (concurrently). |
| `npm run dev:backend`  | Backend only (`node --watch`).                     |
| `npm run dev:frontend` | Frontend only (Vite).                              |
| `npm run build`        | Frontend production build (Vite).                  |
| `npm start`            | Starts the backend in production mode.             |
| `npm test`             | Runs the smoke test suite (`test/smoke.mjs`).      |
| `npm run lint`         | Lints the codebase with ESLint.                    |
| `npm run format`       | Formats the codebase with Prettier.                |

---

## Configuration (environment variables)

Backend settings are configured via `backend/.env` (you can base it on `backend/.env.example`):

| Variable                 | Default                 | Description                                                                                                                                                                                                                                       |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                   | `3001`                  | Backend HTTP/Socket.IO port.                                                                                                                                                                                                                      |
| `CORS_ORIGIN`            | `http://localhost:5173` | Allowed frontend origin (CORS).                                                                                                                                                                                                                   |
| `POLL_INTERVAL_MS`       | `3000`                  | Refresh interval (ms) of the realtime poller per subscribed server.                                                                                                                                                                               |
| `DATA_DIR`               | `./data`                | Path to the JSON data store.                                                                                                                                                                                                                      |
| `JWT_SECRET`             | _(empty)_               | Secret used to sign session JWTs. If empty, a random one is generated and written to `DATA_DIR/.jwt-secret`. **Set it in production.**                                                                                                            |
| `JWT_TTL`                | `12h`                   | Session token lifetime (`12h`, `7d`, `30m`…).                                                                                                                                                                                                     |
| `HELMIO_SECRET_KEY`      | _(empty)_               | AES-256-GCM key for secrets at rest (server passwords, channel credentials). If empty, a random one is generated and written to `DATA_DIR/.secret-key`. **Set it in production and keep it safe** — losing it makes stored secrets unrecoverable. |
| `HELMIO_PUBLIC_URL`      | `http://localhost:PORT` | The public URL at which the backend is reachable from target servers. Baked into the generated eventlistener config so the listener can POST events back. **Set it in production.**                                                               |
| `ALERT_POLL_INTERVAL_MS` | `30000`                 | Background alert sweep (ms): polls servers that don't have the eventlistener and that nobody is watching, so notifications still fire. `0` = disabled.                                                                                            |

---

## Target server prerequisites

### For TCP XML-RPC

Into `/etc/supervisor/supervisord.conf` (or your distribution's path):

```ini
[inet_http_server]
port=*:9001
username=admin
password=secret
```

Then:

```bash
supervisorctl reread && supervisorctl update    # or restart the service
```

### Other methods

- **Local socket / SSH / Docker:** no extra port needed; socket access, SSH access or Docker daemon access respectively is enough.
- **Agent:** install [agent/](agent/) on the target server (see [Helmio Agent](#helmio-agent-helmioagent)).
- **No supervisord:** the panel can detect and install supervisord on the target (for methods with shell access — local/SSH/Docker). See [SupervisorInstallPanel](#frontend-helmiofrontend).

---

## Components

### Backend (`@helmio/backend`)

API built on Express 4 + Socket.IO 4. Entry point [backend/src/index.js](backend/src/index.js).

**Key dependencies:** `express`, `socket.io`, `xmlrpc` (supervisord), `ssh2` (SSH tunnel), `dockerode` (Docker exec), `jsonwebtoken` + `bcryptjs` (auth), `zod` (schema validation), `nodemailer` (e-mail notification), `nanoid`, `dotenv`.

**Mounted routes** ([index.js](backend/src/index.js)):

| Path                            | Authentication                  | Function                                                                 |
| ------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/health`               | None                            | Health endpoint.                                                         |
| `/api/ingest`                   | Per-server token (not user JWT) | Machine-to-machine event ingest (eventlistener push).                    |
| `/api/auth`                     | Public + self                   | `setup`, `login`, `me`, `change-password`, `logout`.                     |
| `/api/users`                    | Admin                           | User CRUD, role management (last-admin protection).                      |
| `/api/audit`                    | Admin                           | Audit log querying (filtered).                                           |
| `/api/channels`                 | Admin                           | Notification channel CRUD + test delivery.                               |
| `/api/apitokens`                | Admin                           | API token CRUD (`hmo_…`).                                                |
| `/api/fleet`                    | JWT                             | Cross-server bulk orchestration.                                         |
| `/api/overview`                 | JWT                             | Dashboard aggregates (metrics + health summary).                         |
| `/api/servers`                  | JWT + RBAC                      | Server CRUD + connection test + daemon control + config + eventlistener. |
| `/api/servers/:id/processes`    | JWT + RBAC                      | start/stop/restart/signal/stdin/clearlog, single process.                |
| `/api/servers/:id/groups`       | JWT + RBAC                      | Group operations.                                                        |
| `/api/servers/:id/bulk`         | JWT + RBAC                      | Bulk operations (bulk signal, clear all logs).                           |
| `/api/servers/:id/healthchecks` | JWT + RBAC                      | Health check CRUD.                                                       |

**Services** ([backend/src/services/](backend/src/services/)):

- **`supervisorService`** — snapshot, start/stop/restart, signal, stdin, daemon control, log tail (offset-based history), host metrics via the connector. Batching with XML-RPC `system.multicall`.
- **`notifierService`** — routes derived alerts to channels (Slack/Discord/Telegram/webhook/e-mail), with a de-duplication window.
- **`healthCheckService`** — schedules HTTP/TCP/script probes; restart or warn on threshold breach.
- **`installerService`** — supervisord detection and installation (apt/apk) on the target.

**Connectors** ([backend/src/connectors/](backend/src/connectors/)): `BaseConnector` + `TcpXmlRpcConnector`, `LocalConnector`, `SshUnixSocketConnector`, `DockerConnector`, `AgentConnector`. See [Connection methods](#connection-methods-connector).

### Frontend (`@helmio/frontend`)

Vue 3.5 + Vuetify 3.7 + Pinia + Vue Router + Vue i18n, bundled with Vite 6. Charts are drawn as pure SVG **with no external library**.

**Dev proxy** ([frontend/vite.config.js](frontend/vite.config.js)): port `5173`; `/api` and `/socket.io` → `localhost:3001`.

**Views** and routes ([frontend/src/router/index.js](frontend/src/router/index.js)):

| Route             | View             | Access            | Content                                                                            |
| ----------------- | ---------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `/login`          | LoginView        | Public            | Login / first-time setup.                                                          |
| `/dashboard`      | DashboardView    | Session           | KPIs, fleet health bar, problem processes, top consumers, trends, admin summaries. |
| `/servers`        | ServersView      | Session           | Server card/table view, search, test/diagnose/edit.                                |
| `/servers/:id`    | ServerDetailView | Session           | Process table (grouped), trend charts, daemon control, config/log panels.          |
| `/fleet`          | FleetView        | `process:control` | Multi-server bulk operations, live progress.                                       |
| `/admin/channels` | ChannelsView     | Admin             | Notification channel management.                                                   |
| `/admin/tokens`   | ApiTokensView    | Admin             | API token management (one-time reveal).                                            |
| `/admin/users`    | UsersView        | Admin             | User management + role assignment.                                                 |
| `/admin/audit`    | AuditView        | Admin             | Searchable audit log.                                                              |

**Key components** ([frontend/src/components/](frontend/src/components/)): `ProcessTable` (grouped, filterable, column preferences in localStorage), `LogPanel` (live stdout/stderr + scroll-back), `ConfigPanel` + `ProgramBuilder` (INI editor + guided program adding), `HealthChecksPanel`, `EventListenerPanel` (one-click setup + token rotation), `SupervisorInstallPanel` (diagnostics + install + live log), `TrendChart` / `DonutChart` (SVG), `ServerFormDrawer` (add a server with 5 methods + connection test), `ProcessDetailPanel` (signal + stdin), `StatusChip`, `ServerCard`.

**Stores (Pinia):** `auth` (token, user, setup state), `servers` (server list + CRUD), `realtime` (Socket.IO snapshot/event/alert), `ui` (server form state).

**API layer:** [src/api/client.js](frontend/src/api/client.js) (Axios, `/api` base, automatic Bearer token attachment, 401 handling), [src/api/socket.js](frontend/src/api/socket.js) (Socket.IO).

**i18n:** Turkish (`tr`) and English (`en`); the choice is determined in order of `localStorage` (`helmio-lang`) → browser language → English.

### Helmio Agent (`@helmio/agent`)

A token-protected lightweight HTTP/JSON proxy installed **alongside** supervisord on the target server. It forwards the panel's calls to the local supervisord over XML-RPC. It allows managing servers behind NAT/firewall without opening the supervisord TCP port. Entry point [agent/src/index.js](agent/src/index.js).

**Endpoints:**

- `GET /health` — unauthenticated; returns the supervisord version (`{ ok, version, name: 'helmio-agent' }`), 502 if unreachable.
- `POST /rpc` — `Authorization: Bearer <token>` required; body `{ method, params }`. Only `supervisor.*` and `system.*` methods are allowed (whitelist).

**Environment variables:** `AGENT_PORT` (8787), `AGENT_HOST` (0.0.0.0), `AGENT_TOKEN` (**required**; won't start if `change-me`/empty), `SUPERVISOR_SOCKET` or `SUPERVISOR_HOST`+`SUPERVISOR_PORT` (9001), `SUPERVISOR_PATH` (/RPC2), `SUPERVISOR_USER`/`SUPERVISOR_PASS`. Token generation: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. Details: [agent/README.md](agent/README.md).

### Event Listener (`eventlistener/`)

A **dependency-free** Python 3 script ([eventlistener/helmio_eventlistener.py](eventlistener/helmio_eventlistener.py)) that speaks supervisord's `[eventlistener:]` protocol over stdin/stdout. It HTTP POSTs state-change events to the backend in real time; this gives **live** updates in the panel instead of polling.

- **Listened events:** `PROCESS_STATE`, `PROCESS_GROUP`, `SUPERVISOR_STATE_CHANGE`, `TICK_60`.
- **Push target:** `POST {HELMIO_INGEST_URL}/{HELMIO_SERVER_ID}/events`, `Authorization: Bearer {HELMIO_TOKEN}`.
- **Environment variables:** `HELMIO_INGEST_URL`, `HELMIO_SERVER_ID`, `HELMIO_TOKEN` (optional), `HELMIO_TIMEOUT` (5 s).
- Even if the HTTP push fails it always returns `RESULT 2\nOK` to supervisord; a listener crash does not affect the processes.

It can be installed from the panel in one click: **Server Detail → ⋮ → Event Listener → Install** (for methods with shell access). Details: [eventlistener/README.md](eventlistener/README.md).

---

## Security and authorization

- **Authentication:** JWT-based sessions; passwords are hashed with `bcrypt` (10 rounds).
- **RBAC — 3 roles:**
  - **viewer** — read-only.
  - **operator** — process control (start/stop/restart/signal) + `daemon:reload`.
  - **admin** — everything (user/channel/token management, daemon restart, config writing…).
- **Permissions:** `server:read`, `process:control`, `daemon:reload`, `daemon:restart`, `server:manage`, `config:write`, `user:manage`, `audit:read`, `notify:manage`.
- **Secret encryption:** server passwords, SSH keys and channel credentials are encrypted on disk with **AES-256-GCM** (`enc:1:` prefix) and masked in API responses (`••••••`).
- **Login rate-limit:** `429` after 5 failed attempts per IP+username within 15 minutes.
- **Audit log:** critical operations are written as JSONL to `data/audit.log` (max ~20k lines).

---

## REST API & API tokens (CI/CD)

Role-based API tokens are generated for non-human clients (CI/CD, automation).

- Token format `hmo_…`; only the **SHA-256 hash** is stored on disk, the plain value is shown one time.
- Authentication: `Authorization: Bearer hmo_…` **or** `X-Helmio-Api-Key: hmo_…`.
- The role assigned to a token is subject to the same RBAC rules as user roles.

```bash
# Example: restart a process with an API token
curl -X POST https://panel.example.com/api/servers/<serverId>/processes/<name>/restart \
     -H "Authorization: Bearer hmo_xxx"
```

---

## Realtime layer (Socket.IO)

The backend offers a room-based Socket.IO layer via [src/realtime.js](backend/src/realtime.js):

- **`subscribe` / `unsubscribe`** — once subscribed to a server room, that server is polled at `POLL_INTERVAL_MS` (default 3 s).
- **`snapshot`** — process state snapshot.
- **`event`** — state-change events coming from the eventlistener.
- **`alert`** — derived FATAL / flapping / health-check alerts.
- **`log:start` / `log:chunk` / `log:stop`** — live log stream.
- **`install:start` / `install:log` / `install:result`** — live supervisord install stream.
- **`fleet`** — cross-server orchestration progress.

**Alert detection:** FATAL (state=200), flapping (3+ state changes in 60 s) and health-check failures are derived automatically. The background sweep (`ALERT_POLL_INTERVAL_MS`) fires notifications even on servers nobody is watching.

---

## Health checks & auto-restart

Per-process **HTTP / TCP / script** probes are defined:

- On threshold breach (consecutive failure count) it does an **auto-restart** or only a **warning** (tied to notification channels).
- Health-check failures are included in the alert stream.
- Management: from the panel via [HealthChecksPanel](#frontend-helmiofrontend) or `/api/servers/:id/healthchecks`.

---

## Alerting & notification channels

Supported channel types: **Slack**, **Discord**, **Telegram**, **webhook**, **e-mail** (`nodemailer`).

- Triggered on FATAL and flapping events and on health-check threshold breaches.
- Channel credentials (token, webhook URL, SMTP password) are encrypted on disk; masked in responses.
- A **test delivery** can be sent from the panel.

---

## Fleet orchestration

To apply the same operation across multiple servers at once:

- **Parallel** or **sequential (rolling)** strategy.
- A separate result per server; live progress is published via the Socket.IO `fleet` event.
- Access is protected by the `process:control` permission.

---

## Data store

There is no external database; all state is kept in JSON/JSONL files under `DATA_DIR` (default `backend/data/`):

| File              | Content                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `servers.json`    | Server definitions (secrets encrypted).                                |
| `users.json`      | Users (bcrypt password hashes).                                        |
| `channels.json`   | Notification channels (credentials encrypted).                         |
| `api-tokens.json` | API token hashes + metadata.                                           |
| `audit.log`       | Audit log (JSONL, append-only).                                        |
| `metrics.json`    | Time-series metric samples (~2000 per server, periodically persisted). |
| `.jwt-secret`     | Auto-generated JWT signing key (if absent).                            |
| `.secret-key`     | Auto-generated AES key (if absent).                                    |

> If `.jwt-secret` and `.secret-key` are lost, sessions are invalidated and stored secrets become **unrecoverable**. In production set `JWT_SECRET` and `HELMIO_SECRET_KEY` explicitly and back them up.

---

## Tests

```bash
npm test                                  # smoke test suite (test/smoke.mjs)
```

**Smoke tests** ([test/smoke.mjs](test/smoke.mjs)) boot the backend **in-process** (with a temporary `DATA_DIR`) and verify: auth & RBAC (setup, login rate-limit, role restrictions), encryption at rest (`enc:1:` prefix, masking), API tokens, notification channels (masking + test delivery), event ingest + alert routing, the program config builder/preview, health checks, fleet validation, the metrics endpoint.

**Docker-based install test** ([test/run.mjs](test/run.mjs) + [test/docker-compose.yml](test/docker-compose.yml)) runs the detect → install → re-detect flow against clean containers (Debian/Alpine) that have no supervisord installed:

```bash
docker compose -f test/docker-compose.yml up -d     # start the test containers
node test/run.mjs [container-name]                   # default: helmio-test-debian
test/seed-demo.sh [container-name]                   # load a rich demo supervisord config
```

Details: [test/README.md](test/README.md).

---

## Contributing

Contributions are welcome! Please read the [Contributing guidelines](CONTRIBUTING.md) to get started, and note that this project follows a [Code of Conduct](CODE_OF_CONDUCT.md). Changes are tracked in the [Changelog](CHANGELOG.md).

## Security

Found a vulnerability? Please **do not** open a public issue — follow the responsible disclosure process described in our [Security policy](SECURITY.md).

---

## License

This project is licensed under the **MIT License**. The rights to use, copy, modify, merge, publish, distribute, sublicense and/or sell the software are free, provided that the above copyright notice and this permission notice are included in all copies. The software is provided "as is", without warranty of any kind.

For the full text see [LICENSE](LICENSE).
