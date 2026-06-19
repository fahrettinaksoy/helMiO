import { Router } from 'express';
import { z } from 'zod';
import { serverStore } from '../store/serverStore.js';
import { supervisorService } from '../services/supervisorService.js';
import { eventBus } from '../events/eventBus.js';
import { requirePermission, audit } from '../middleware/auth.js';
import { PERMISSIONS } from '../auth/rbac.js';
import { ah } from './util.js';

/**
 * Cross-server fleet orchestration. Runs one action across many servers with a
 * chosen strategy:
 *   - parallel   : fire at all targets at once (fastest)
 *   - sequential : one server at a time, optional delay between — a rolling
 *                  restart that keeps the rest of the fleet up while each is cycled
 *
 * Returns a per-target result list. Bounded so a long rolling delay can't hang
 * the request indefinitely.
 */
export const fleetRouter = Router();

const ACTIONS = {
  startAll: (s) => supervisorService.startAll(s),
  stopAll: (s) => supervisorService.stopAll(s),
  restartAll: (s) => supervisorService.restartAll(s),
  startGroup: (s, g) => supervisorService.startGroup(s, g),
  stopGroup: (s, g) => supervisorService.stopGroup(s, g),
  restartGroup: (s, g) => supervisorService.restartGroup(s, g),
};

const runSchema = z.object({
  action: z.enum(Object.keys(ACTIONS)),
  serverIds: z.array(z.string()).min(1, 'En az bir sunucu seçin'),
  group: z.string().optional(),
  strategy: z.enum(['parallel', 'sequential']).default('parallel'),
  delayMs: z.coerce.number().int().min(0).max(60000).optional().default(0),
  // Optional client-generated id so the UI can match live progress events.
  runId: z.string().max(64).optional(),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fleetRouter.post('/run', requirePermission(PERMISSIONS.PROCESS_CONTROL), ah(async (req, res) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Doğrulama hatası', details: parsed.error.flatten() });
  }
  const { action, serverIds, group, strategy, delayMs, runId } = parsed.data;
  const isGroup = action.endsWith('Group');
  if (isGroup && !group) return res.status(400).json({ error: 'Grup adı gerekli' });

  const emitProgress = (result) => {
    if (runId) eventBus.emit('fleet', { runId, event: 'progress', result });
  };

  const runOne = async (serverId) => {
    const started = Date.now();
    const server = await serverStore.get(serverId);
    let result;
    if (!server) {
      result = { serverId, name: serverId, ok: false, error: 'Sunucu bulunamadı', durationMs: 0 };
    } else {
      try {
        await ACTIONS[action](server, group);
        result = { serverId, name: server.name, ok: true, durationMs: Date.now() - started };
      } catch (err) {
        result = { serverId, name: server.name, ok: false, error: err.message, durationMs: Date.now() - started };
      }
    }
    emitProgress(result); // live push to the UI as each server completes
    return result;
  };

  let results;
  if (strategy === 'parallel') {
    results = await Promise.all(serverIds.map(runOne));
  } else {
    results = [];
    for (let i = 0; i < serverIds.length; i += 1) {
      results.push(await runOne(serverIds[i]));
      if (delayMs && i < serverIds.length - 1) await sleep(delayMs);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  if (runId) eventBus.emit('fleet', { runId, event: 'done', ok: okCount, total: results.length });
  audit(req, {
    action: 'fleet.run',
    target: `${action}${group ? `:${group}` : ''}`,
    status: okCount === results.length ? 'ok' : 'error',
    detail: `${strategy} · ${okCount}/${results.length} başarılı`,
  });
  res.json({ action, group: group || null, strategy, results, ok: okCount, total: results.length });
}));
