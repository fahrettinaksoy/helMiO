import { Router } from 'express';
import { serverStore } from '../store/serverStore.js';
import { healthCheckStore } from '../store/healthCheckStore.js';
import { healthCheckSchema, HEALTHCHECK_TYPES, HEALTHCHECK_ACTIONS } from '../schemas.js';
import { healthCheckScheduler, probe } from '../services/healthCheckService.js';
import { requirePermission, audit } from '../middleware/auth.js';
import { PERMISSIONS } from '../auth/rbac.js';
import { ah } from './util.js';

// mergeParams so :serverId from the parent mount is available.
export const healthChecksRouter = Router({ mergeParams: true });

healthChecksRouter.use(ah(async (req, res, next) => {
  const server = await serverStore.get(req.params.serverId);
  if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });
  req.server = server;
  next();
}));

const canManage = requirePermission(PERMISSIONS.PROCESS_CONTROL);

// Metadata for the form.
healthChecksRouter.get('/meta', (req, res) => {
  res.json({ types: HEALTHCHECK_TYPES, actions: HEALTHCHECK_ACTIONS });
});

// List checks for this server (any authenticated user).
healthChecksRouter.get('/', ah(async (req, res) => {
  res.json(await healthCheckStore.listByServer(req.server.id));
}));

healthChecksRouter.post('/', canManage, ah(async (req, res) => {
  const parsed = healthCheckSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Doğrulama hatası', details: parsed.error.flatten() });
  }
  const check = await healthCheckStore.create({ ...parsed.data, serverId: req.server.id });
  await healthCheckScheduler.reload();
  audit(req, { action: 'healthcheck.create', serverId: req.server.id, target: check.target, detail: `${check.type} · ${check.action}` });
  res.status(201).json(check);
}));

healthChecksRouter.put('/:id', canManage, ah(async (req, res) => {
  const existing = await healthCheckStore.get(req.params.id);
  if (!existing || existing.serverId !== req.server.id) return res.status(404).json({ error: 'Kontrol bulunamadı' });
  const parsed = healthCheckSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Doğrulama hatası', details: parsed.error.flatten() });
  }
  const check = await healthCheckStore.update(req.params.id, { ...parsed.data, serverId: req.server.id });
  await healthCheckScheduler.reload();
  audit(req, { action: 'healthcheck.update', serverId: req.server.id, target: check.target });
  res.json(check);
}));

healthChecksRouter.delete('/:id', canManage, ah(async (req, res) => {
  const existing = await healthCheckStore.get(req.params.id);
  if (!existing || existing.serverId !== req.server.id) return res.status(404).json({ error: 'Kontrol bulunamadı' });
  await healthCheckStore.remove(req.params.id);
  await healthCheckScheduler.reload();
  audit(req, { action: 'healthcheck.delete', serverId: req.server.id, target: existing.target });
  res.status(204).end();
}));

// Probe now and return the outcome (does not affect failure counters or actions).
healthChecksRouter.post('/:id/run', canManage, ah(async (req, res) => {
  const check = await healthCheckStore.get(req.params.id);
  if (!check || check.serverId !== req.server.id) return res.status(404).json({ error: 'Kontrol bulunamadı' });
  const result = await probe(check, req.server);
  res.json(result);
}));
