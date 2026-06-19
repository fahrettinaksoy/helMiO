import { Router } from 'express';
import { serverStore } from '../store/serverStore.js';
import { supervisorService } from '../services/supervisorService.js';
import { ah } from './util.js';
import { requirePermission, audit } from '../middleware/auth.js';
import { PERMISSIONS } from '../auth/rbac.js';

// mergeParams so :serverId from the parent mount is available here.
export const processesRouter = Router({ mergeParams: true });

// Resolve the server for every route under this router.
const resolveServer = ah(async (req, res, next) => {
  const server = await serverStore.get(req.params.serverId);
  if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
  req.server = server;
  next();
});

processesRouter.use(resolveServer);

const wait = (req) => req.body?.wait !== false; // default true

// All control verbs require the process-control permission.
const canControl = requirePermission(PERMISSIONS.PROCESS_CONTROL);

function handleSupervisorError(res, err) {
  res.status(502).json({ error: err.message });
}

// --- Single process actions (fullName is "group:name" or "name") ---

processesRouter.post('/:fullName/start', canControl, ah(async (req, res) => {
  try {
    const result = await supervisorService.start(req.server, req.params.fullName, wait(req));
    audit(req, { action: 'process.start', serverId: req.server.id, target: req.params.fullName });
    res.json({ ok: true, result });
  } catch (err) {
    audit(req, { action: 'process.start', serverId: req.server.id, target: req.params.fullName, status: 'error', detail: err.message });
    handleSupervisorError(res, err);
  }
}));

processesRouter.post('/:fullName/stop', canControl, ah(async (req, res) => {
  try {
    const result = await supervisorService.stop(req.server, req.params.fullName, wait(req));
    audit(req, { action: 'process.stop', serverId: req.server.id, target: req.params.fullName });
    res.json({ ok: true, result });
  } catch (err) {
    audit(req, { action: 'process.stop', serverId: req.server.id, target: req.params.fullName, status: 'error', detail: err.message });
    handleSupervisorError(res, err);
  }
}));

processesRouter.post('/:fullName/restart', canControl, ah(async (req, res) => {
  try {
    const result = await supervisorService.restart(req.server, req.params.fullName, wait(req));
    audit(req, { action: 'process.restart', serverId: req.server.id, target: req.params.fullName });
    res.json({ ok: true, result });
  } catch (err) {
    audit(req, { action: 'process.restart', serverId: req.server.id, target: req.params.fullName, status: 'error', detail: err.message });
    handleSupervisorError(res, err);
  }
}));

processesRouter.post('/:fullName/signal', canControl, ah(async (req, res) => {
  const sig = req.body?.signal;
  if (!sig) return res.status(400).json({ error: 'Sinyal gerekli' });
  try {
    await supervisorService.signal(req.server, req.params.fullName, sig);
    audit(req, { action: 'process.signal', serverId: req.server.id, target: req.params.fullName, detail: `SIG${sig}` });
    res.json({ ok: true });
  } catch (err) {
    audit(req, { action: 'process.signal', serverId: req.server.id, target: req.params.fullName, status: 'error', detail: err.message });
    handleSupervisorError(res, err);
  }
}));

processesRouter.post('/:fullName/stdin', canControl, ah(async (req, res) => {
  const chars = req.body?.chars;
  if (chars == null) return res.status(400).json({ error: 'Girdi gerekli' });
  try {
    await supervisorService.sendStdin(req.server, req.params.fullName, chars);
    audit(req, { action: 'process.stdin', serverId: req.server.id, target: req.params.fullName });
    res.json({ ok: true });
  } catch (err) { handleSupervisorError(res, err); }
}));

processesRouter.post('/:fullName/log/clear', canControl, ah(async (req, res) => {
  try {
    await supervisorService.clearLogs(req.server, req.params.fullName);
    audit(req, { action: 'process.log_clear', serverId: req.server.id, target: req.params.fullName });
    res.json({ ok: true });
  } catch (err) { handleSupervisorError(res, err); }
}));

// Read a byte range of a process log (for scroll-back history). Read-only.
processesRouter.get('/:fullName/log/read', ah(async (req, res) => {
  const channel = req.query.channel === 'stderr' ? 'stderr' : 'stdout';
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const length = Math.min(262144, Math.max(1, Number(req.query.length) || 32768));
  try {
    const result = await supervisorService.readProcessLog(req.server, req.params.fullName, channel, offset, length);
    res.json(result);
  } catch (err) { handleSupervisorError(res, err); }
}));

// Download the full process log (assembled server-side). Read-only.
processesRouter.get('/:fullName/log/download', ah(async (req, res) => {
  const channel = req.query.channel === 'stderr' ? 'stderr' : 'stdout';
  try {
    const { data, truncated } = await supervisorService.downloadProcessLog(req.server, req.params.fullName, channel);
    const safe = req.params.fullName.replace(/[^A-Za-z0-9_.-]/g, '_');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.${channel}.log"`);
    if (truncated) res.setHeader('X-Helmio-Truncated', 'true');
    res.send(data);
  } catch (err) { handleSupervisorError(res, err); }
}));

// Read: any authenticated user (all roles have server:read).
processesRouter.get('/:fullName', ah(async (req, res) => {
  try {
    const info = await supervisorService.getProcessInfo(req.server, req.params.fullName);
    res.json(info);
  } catch (err) { handleSupervisorError(res, err); }
}));

export const groupsRouter = Router({ mergeParams: true });
groupsRouter.use(resolveServer);

// --- Group actions ---

groupsRouter.post('/:groupName/start', canControl, ah(async (req, res) => {
  try {
    const result = await supervisorService.startGroup(req.server, req.params.groupName, wait(req));
    audit(req, { action: 'group.start', serverId: req.server.id, target: req.params.groupName });
    res.json({ ok: true, result });
  } catch (err) { handleSupervisorError(res, err); }
}));

groupsRouter.post('/:groupName/stop', canControl, ah(async (req, res) => {
  try {
    const result = await supervisorService.stopGroup(req.server, req.params.groupName, wait(req));
    audit(req, { action: 'group.stop', serverId: req.server.id, target: req.params.groupName });
    res.json({ ok: true, result });
  } catch (err) { handleSupervisorError(res, err); }
}));

groupsRouter.post('/:groupName/restart', canControl, ah(async (req, res) => {
  try {
    const result = await supervisorService.restartGroup(req.server, req.params.groupName, wait(req));
    audit(req, { action: 'group.restart', serverId: req.server.id, target: req.params.groupName });
    res.json({ ok: true, result });
  } catch (err) { handleSupervisorError(res, err); }
}));

groupsRouter.post('/:groupName/signal', canControl, ah(async (req, res) => {
  const sig = req.body?.signal;
  if (!sig) return res.status(400).json({ error: 'Sinyal gerekli' });
  try {
    await supervisorService.signalGroup(req.server, req.params.groupName, sig);
    audit(req, { action: 'group.signal', serverId: req.server.id, target: req.params.groupName, detail: `SIG${sig}` });
    res.json({ ok: true });
  } catch (err) { handleSupervisorError(res, err); }
}));

// --- Bulk actions across all processes on the server ---

export const bulkRouter = Router({ mergeParams: true });
bulkRouter.use(resolveServer);

bulkRouter.post('/start-all', canControl, ah(async (req, res) => {
  try {
    const result = await supervisorService.startAll(req.server, wait(req));
    audit(req, { action: 'bulk.start_all', serverId: req.server.id, target: req.server.name });
    res.json({ ok: true, result });
  } catch (err) { handleSupervisorError(res, err); }
}));

bulkRouter.post('/stop-all', canControl, ah(async (req, res) => {
  try {
    const result = await supervisorService.stopAll(req.server, wait(req));
    audit(req, { action: 'bulk.stop_all', serverId: req.server.id, target: req.server.name });
    res.json({ ok: true, result });
  } catch (err) { handleSupervisorError(res, err); }
}));

bulkRouter.post('/restart-all', canControl, ah(async (req, res) => {
  try {
    const result = await supervisorService.restartAll(req.server, wait(req));
    audit(req, { action: 'bulk.restart_all', serverId: req.server.id, target: req.server.name });
    res.json({ ok: true, result });
  } catch (err) { handleSupervisorError(res, err); }
}));

bulkRouter.post('/signal-all', canControl, ah(async (req, res) => {
  const sig = req.body?.signal;
  if (!sig) return res.status(400).json({ error: 'Sinyal gerekli' });
  try {
    await supervisorService.signalAll(req.server, sig);
    audit(req, { action: 'bulk.signal_all', serverId: req.server.id, target: req.server.name, detail: `SIG${sig}` });
    res.json({ ok: true });
  } catch (err) { handleSupervisorError(res, err); }
}));

bulkRouter.post('/clear-all-logs', canControl, ah(async (req, res) => {
  try {
    await supervisorService.clearAllLogs(req.server);
    audit(req, { action: 'bulk.clear_all_logs', serverId: req.server.id, target: req.server.name });
    res.json({ ok: true });
  } catch (err) { handleSupervisorError(res, err); }
}));
