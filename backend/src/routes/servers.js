import { Router } from 'express';
import { serverStore } from '../store/serverStore.js';
import { serverSchema } from '../schemas.js';
import { supervisorService } from '../services/supervisorService.js';
import { installerService } from '../services/installerService.js';
import { dropConnector, CONNECTION_METHODS } from '../connectors/index.js';
import { ah, publicServer } from './util.js';
import { requirePermission, audit } from '../middleware/auth.js';
import { PERMISSIONS } from '../auth/rbac.js';
import { eventStore } from '../store/eventStore.js';
import { metricsStore } from '../store/metricsStore.js';

export const serversRouter = Router();

// Available connection methods (for the "add server" form).
serversRouter.get('/methods', (req, res) => {
  res.json(CONNECTION_METHODS);
});

const SECRET_FIELDS = ['password', 'privateKey', 'sshPassword', 'agentToken'];

// Test an ad-hoc (not-yet-saved) server definition before adding it.
// If `id` is supplied (edit mode), masked secrets are filled from the store.
serversRouter.post(
  '/test',
  ah(async (req, res) => {
    const data = { ...req.body };
    if (data.id) {
      const existing = await serverStore.get(data.id);
      if (existing) {
        for (const f of SECRET_FIELDS) {
          if (data[f] === '••••••') data[f] = existing[f];
        }
      }
    }
    const parsed = serverSchema.safeParse(data);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ ok: false, error: 'Doğrulama hatası', details: parsed.error.flatten() });
    }
    const result = await installerService.testConnection({
      ...parsed.data,
      id: data.id || 'adhoc',
      updatedAt: 'adhoc',
    });
    res.json(result);
  }),
);

// List all servers (secrets masked).
serversRouter.get(
  '/',
  ah(async (req, res) => {
    const servers = await serverStore.list();
    res.json(servers.map(publicServer));
  }),
);

// Create a server.
serversRouter.post(
  '/',
  requirePermission(PERMISSIONS.SERVER_MANAGE),
  ah(async (req, res) => {
    const parsed = serverSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Doğrulama hatası', details: parsed.error.flatten() });
    }
    const server = await serverStore.create(parsed.data);
    audit(req, {
      action: 'server.create',
      serverId: server.id,
      target: server.name,
      detail: `yöntem: ${server.method}`,
    });
    res.status(201).json(publicServer(server));
  }),
);

// Get one server.
serversRouter.get(
  '/:id',
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    res.json(publicServer(server));
  }),
);

// Update a server.
serversRouter.put(
  '/:id',
  requirePermission(PERMISSIONS.SERVER_MANAGE),
  ah(async (req, res) => {
    const existing = await serverStore.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Sunucu bulunamadı' });

    const parsed = serverSchema.safeParse({ ...req.body });
    if (!parsed.success) {
      return res.status(400).json({ error: 'Doğrulama hatası', details: parsed.error.flatten() });
    }
    // Keep stored secrets if the client sent the masked placeholder.
    const patch = { ...parsed.data };
    for (const f of ['password', 'privateKey', 'sshPassword', 'agentToken']) {
      if (patch[f] === '••••••') patch[f] = existing[f];
    }
    const server = await serverStore.update(req.params.id, patch);
    await dropConnector(req.params.id); // rebuild on next call
    audit(req, { action: 'server.update', serverId: server.id, target: server.name });
    res.json(publicServer(server));
  }),
);

// Delete a server.
serversRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.SERVER_MANAGE),
  ah(async (req, res) => {
    const existing = await serverStore.get(req.params.id);
    const ok = await serverStore.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    await dropConnector(req.params.id);
    audit(req, { action: 'server.delete', serverId: req.params.id, target: existing?.name });
    res.status(204).end();
  }),
);

// Test connectivity to a server (existing one or an ad-hoc definition in body).
serversRouter.post(
  '/:id/test',
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      const result = await supervisorService.ping(server);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  }),
);

// Diagnose: is Supervisor installed / running / reachable? (+ install options)
serversRouter.get(
  '/:id/diagnose',
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      const result = await installerService.detect(server);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }),
);

// --- Supervisor daemon-level actions ---

serversRouter.get(
  '/:id/daemon',
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      res.json(await supervisorService.daemonInfo(server));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }),
);

serversRouter.post(
  '/:id/daemon/reload',
  requirePermission(PERMISSIONS.DAEMON_RELOAD),
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      const result = await supervisorService.reloadConfig(server);
      audit(req, {
        action: 'daemon.reload',
        serverId: server.id,
        target: server.name,
        detail: `+${result.added?.length || 0} ~${result.changed?.length || 0} -${result.removed?.length || 0}`,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      audit(req, {
        action: 'daemon.reload',
        serverId: server.id,
        target: server.name,
        status: 'error',
        detail: err.message,
      });
      res.status(502).json({ ok: false, error: err.message });
    }
  }),
);

serversRouter.post(
  '/:id/daemon/restart',
  requirePermission(PERMISSIONS.DAEMON_RESTART),
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      await supervisorService.restartDaemon(server);
      audit(req, { action: 'daemon.restart', serverId: server.id, target: server.name });
      res.json({ ok: true });
    } catch (err) {
      audit(req, {
        action: 'daemon.restart',
        serverId: server.id,
        target: server.name,
        status: 'error',
        detail: err.message,
      });
      res.status(502).json({ ok: false, error: err.message });
    }
  }),
);

serversRouter.post(
  '/:id/daemon/log/clear',
  requirePermission(PERMISSIONS.PROCESS_CONTROL),
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      await supervisorService.clearDaemonLog(server);
      audit(req, { action: 'daemon.log_clear', serverId: server.id, target: server.name });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  }),
);

serversRouter.post(
  '/:id/daemon/shutdown',
  requirePermission(PERMISSIONS.DAEMON_RESTART),
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      await supervisorService.shutdownDaemon(server);
      audit(req, { action: 'daemon.shutdown', serverId: server.id, target: server.name });
      res.json({ ok: true });
    } catch (err) {
      audit(req, {
        action: 'daemon.shutdown',
        serverId: server.id,
        target: server.name,
        status: 'error',
        detail: err.message,
      });
      res.status(502).json({ ok: false, error: err.message });
    }
  }),
);

// --- Config files (shell connectors) ---

serversRouter.get(
  '/:id/config',
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      res.json(await supervisorService.listConfigFiles(server));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }),
);

serversRouter.get(
  '/:id/config/file',
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      const content = await supervisorService.readConfigFile(server, req.query.path);
      res.json({ path: req.query.path, content });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }),
);

serversRouter.put(
  '/:id/config/file',
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      await supervisorService.writeConfigFile(server, req.body?.path, req.body?.content ?? '');
      audit(req, { action: 'config.write', serverId: server.id, target: req.body?.path });
      res.json({ ok: true });
    } catch (err) {
      audit(req, {
        action: 'config.write',
        serverId: server.id,
        target: req.body?.path,
        status: 'error',
        detail: err.message,
      });
      res.status(502).json({ ok: false, error: err.message });
    }
  }),
);

serversRouter.post(
  '/:id/config/program',
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      const result = await supervisorService.addProgram(server, req.body || {});
      audit(req, { action: 'config.add_program', serverId: server.id, target: req.body?.name });
      res.json({ ok: true, ...result });
    } catch (err) {
      audit(req, {
        action: 'config.add_program',
        serverId: server.id,
        target: req.body?.name,
        status: 'error',
        detail: err.message,
      });
      res.status(502).json({ ok: false, error: err.message });
    }
  }),
);

// Preview the [program:…] block for a definition without writing it.
serversRouter.post(
  '/:id/config/program/preview',
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  ah(async (req, res) => {
    try {
      res.json({ block: supervisorService.buildProgramBlock(req.body || {}) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }),
);

// Parse an existing .conf file's first [program:…] section into a structured
// def, so it can be edited in the program builder.
serversRouter.get(
  '/:id/config/program/parse',
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      const content = await supervisorService.readConfigFile(server, req.query.path);
      const def = supervisorService.parseProgramBlock(content);
      if (!def) return res.status(422).json({ error: 'Dosyada [program:…] bölümü bulunamadı' });
      res.json({ def });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }),
);

// Host resource metrics (shell connectors only; null otherwise).
serversRouter.get(
  '/:id/host',
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      res.json(await supervisorService.hostMetrics(server));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }),
);

// --- Event listener (push-based events) ---

// Status + install plan (config snippet + ingest token). Token is sensitive →
// gated behind config-write (admin).
serversRouter.get(
  '/:id/eventlistener',
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      const [status, plan] = await Promise.all([
        supervisorService.eventListenerStatus(server),
        supervisorService.eventListenerPlan(server),
      ]);
      res.json({ status, plan });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }),
);

serversRouter.post(
  '/:id/eventlistener/install',
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      const result = await supervisorService.installEventListener(server);
      audit(req, { action: 'eventlistener.install', serverId: server.id, target: server.name });
      res.json({ ok: true, ...result });
    } catch (err) {
      audit(req, {
        action: 'eventlistener.install',
        serverId: server.id,
        target: server.name,
        status: 'error',
        detail: err.message,
      });
      res.status(502).json({ ok: false, error: err.message });
    }
  }),
);

serversRouter.post(
  '/:id/eventlistener/uninstall',
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      await supervisorService.uninstallEventListener(server);
      audit(req, { action: 'eventlistener.uninstall', serverId: server.id, target: server.name });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  }),
);

serversRouter.post(
  '/:id/eventlistener/rotate-token',
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    const token = await supervisorService.rotateIngestToken(server);
    audit(req, { action: 'eventlistener.rotate_token', serverId: server.id, target: server.name });
    res.json({ ok: true, token });
  }),
);

// Recent buffered events for the live feed (newest first).
serversRouter.get(
  '/:id/events',
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    res.json({ events: eventStore.list(server.id, limit) });
  }),
);

// Time-series metric samples for the trend charts (oldest first).
// ?range=<minutes> (default 60, max 1440).
serversRouter.get(
  '/:id/metrics',
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    const minutes = Math.min(1440, Math.max(1, Number(req.query.range) || 60));
    res.json({ range: minutes, samples: metricsStore.query(server.id, minutes * 60000) });
  }),
);

// Current full snapshot (state + processes + groups + summary).
serversRouter.get(
  '/:id/snapshot',
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
    try {
      const snap = await supervisorService.snapshot(server);
      res.json(snap);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }),
);
