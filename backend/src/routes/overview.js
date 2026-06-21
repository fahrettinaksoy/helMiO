import { Router } from 'express';
import { serverStore } from '../store/serverStore.js';
import { metricsStore } from '../store/metricsStore.js';
import { healthCheckStore } from '../store/healthCheckStore.js';
import { authenticate } from '../middleware/auth.js';
import { ah } from './util.js';

/**
 * Fleet-wide dashboard overview. Aggregates data that isn't in the realtime
 * snapshots: the metric time-series (for fleet CPU/memory trends + per-host
 * resource gauges) and a health-check summary. Read entirely from in-memory
 * stores, so it's cheap and never touches the target hosts.
 */
export const overviewRouter = Router();

overviewRouter.get('/', authenticate, ah(async (req, res) => {
  const minutes = Math.min(1440, Math.max(5, Number(req.query.range) || 60));
  const servers = await serverStore.list();
  const nameById = Object.fromEntries(servers.map((s) => [s.id, s.name]));

  // --- Metrics (trend series + latest host sample per server) ---
  const fleet = metricsStore.fleet(minutes * 60000);
  const hosts = Object.entries(fleet.hosts).map(([id, s]) => ({
    serverId: id,
    name: nameById[id] || id,
    load: s.load,
    memPct: s.memPct,
    diskPct: s.diskPct,
    cpu: s.cpu,
    mem: s.mem,
    at: s.at,
  }));

  // --- Health checks summary ---
  const checks = await healthCheckStore.list();
  const failing = checks.filter((c) => c.lastStatus === 'fail');
  const recentActions = checks
    .filter((c) => c.lastActionAt)
    .sort((a, b) => Date.parse(b.lastActionAt) - Date.parse(a.lastActionAt))
    .slice(0, 5)
    .map((c) => ({ target: c.target, serverName: nameById[c.serverId] || c.serverId, at: c.lastActionAt, action: c.action }));

  res.json({
    range: minutes,
    metrics: { series: fleet.series, hosts },
    health: {
      total: checks.length,
      passing: checks.filter((c) => c.lastStatus === 'ok').length,
      failing: failing.length,
      failingList: failing.map((c) => ({ target: c.target, serverName: nameById[c.serverId] || c.serverId, type: c.type, error: c.lastError })),
      recentActions,
    },
  });
}));
