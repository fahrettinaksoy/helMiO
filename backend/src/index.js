import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server as SocketServer } from 'socket.io';

import { config } from './config.js';
import { serversRouter } from './routes/servers.js';
import { processesRouter, groupsRouter, bulkRouter } from './routes/processes.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { auditRouter } from './routes/audit.js';
import { ingestRouter } from './routes/ingest.js';
import { channelsRouter } from './routes/channels.js';
import { healthChecksRouter } from './routes/healthchecks.js';
import { apiTokensRouter } from './routes/apitokens.js';
import { fleetRouter } from './routes/fleet.js';
import { overviewRouter } from './routes/overview.js';
import { authenticate } from './middleware/auth.js';
import { setupRealtime } from './realtime.js';
import { startNotifier } from './services/notifierService.js';
import { startHealthChecks } from './services/healthCheckService.js';
import { metricsStore } from './store/metricsStore.js';

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'helmio', ts: Date.now() }));

// Machine-to-machine event ingest (per-server token auth, NOT user JWT).
app.use('/api/ingest', ingestRouter);

// Auth endpoints (login/setup/status are public; me/logout self-authenticate).
app.use('/api/auth', authRouter);
// Panel administration (each router enforces the admin permission internally).
app.use('/api/users', usersRouter);
app.use('/api/audit', auditRouter);
app.use('/api/channels', channelsRouter);
app.use('/api/apitokens', apiTokensRouter);
// Cross-server fleet orchestration (auth enforced inside).
app.use('/api/fleet', authenticate, fleetRouter);
// Fleet-wide dashboard overview (metrics + health aggregate).
app.use('/api/overview', overviewRouter);

// Everything below requires a valid session; per-route RBAC is enforced inside.
app.use('/api/servers', authenticate, serversRouter);
// Process / group / bulk actions are scoped under a server id.
app.use('/api/servers/:serverId/processes', authenticate, processesRouter);
app.use('/api/servers/:serverId/groups', authenticate, groupsRouter);
app.use('/api/servers/:serverId/bulk', authenticate, bulkRouter);
app.use('/api/servers/:serverId/healthchecks', authenticate, healthChecksRouter);

// 404 for unknown API routes.
app.use('/api', (req, res) => res.status(404).json({ error: 'Bulunamadı' }));

// Central error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[helmio]', err);
  res.status(500).json({ error: err.message || 'Sunucu hatası' });
});

const httpServer = http.createServer(app);
const io = new SocketServer(httpServer, {
  cors: { origin: config.corsOrigin },
});
setupRealtime(io);
startNotifier(); // route derived alerts to configured notification channels
startHealthChecks(); // schedule HTTP/TCP probes with auto-restart
// Trend metrics: restore history, then persist periodically.
metricsStore.load();
setInterval(() => metricsStore.persist(), 60000).unref?.();

// Fail loudly if the port is already taken. Otherwise the process would crash
// opaquely and the Vite proxy would silently forward /api to whatever stranger
// holds the port — surfacing as an empty/garbled error on the login screen.
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[helmio] FATAL: port ${config.port} is already in use by another process.`);
    console.error(
      '[helmio] Free it (lsof -iTCP:%d -sTCP:LISTEN) or set PORT in backend/.env to a free port.',
      config.port,
    );
    process.exit(1);
  }
  console.error('[helmio] server error:', err);
  process.exit(1);
});

httpServer.listen(config.port, () => {
  console.log(`[helmio] backend listening on http://localhost:${config.port}`);
  console.log(`[helmio] CORS origin: ${config.corsOrigin}, poll: ${config.pollIntervalMs}ms`);
});
