import net from 'node:net';
import { healthCheckStore } from '../store/healthCheckStore.js';
import { serverStore } from '../store/serverStore.js';
import { supervisorService } from './supervisorService.js';
import { getConnector } from '../connectors/index.js';
import { eventBus } from '../events/eventBus.js';
import { auditStore } from '../store/auditStore.js';

/**
 * Health check scheduler.
 *
 * "RUNNING" in supervisord only means the process is alive — not that the
 * service it hosts actually answers. A health check probes an HTTP endpoint or
 * TCP port; after `failureThreshold` consecutive failures it takes an action:
 *   - 'restart' → restart the process AND raise an alert
 *   - 'alert'   → raise an alert only
 *
 * Alerts flow through the same event bus as FATAL/flapping, so configured
 * notification channels deliver them too.
 */

// --- Probes. Each resolves to { ok, status?, error?, durationMs }. ---

async function probeHttp(cfg, startedAt) {
  const expect = cfg.expectStatus || 200;
  try {
    const res = await fetch(cfg.url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(cfg.timeoutMs || 5000),
    });
    const ok = res.status === expect;
    return {
      ok,
      status: res.status,
      error: ok ? null : `beklenen ${expect}, gelen ${res.status}`,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'zaman aşımı' : err.message;
    return { ok: false, error: msg, durationMs: Date.now() - startedAt };
  }
}

function probeTcp(cfg, startedAt) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, error: error || null, durationMs: Date.now() - startedAt });
    };
    socket.setTimeout(cfg.timeoutMs || 5000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'zaman aşımı'));
    socket.once('error', (err) => finish(false, err.message));
    socket.connect(cfg.port, cfg.host || '127.0.0.1');
  });
}

async function probeScript(cfg, server, startedAt) {
  if (!server) return { ok: false, error: 'sunucu bulunamadı', durationMs: Date.now() - startedAt };
  const c = getConnector(server);
  if (!(c.supportsExec && c.supportsExec())) {
    return {
      ok: false,
      error: 'script kontrolü için shell erişimli bağlantı gerekir',
      durationMs: Date.now() - startedAt,
    };
  }
  const expect = cfg.expectExit ?? 0;
  try {
    // Wrap with `timeout` when available so a hung command can't block forever.
    const secs = Math.max(1, Math.ceil((cfg.timeoutMs || 5000) / 1000));
    const wrapped = `timeout ${secs} sh -c ${JSON.stringify(cfg.command)} 2>&1; echo "__rc=$?"`;
    const { stdout } = await c.exec(wrapped);
    const m = /__rc=(\d+)\s*$/.exec(stdout || '');
    const rc = m ? Number(m[1]) : 1;
    const ok = rc === expect;
    return {
      ok,
      error: ok ? null : `çıkış kodu ${rc} (beklenen ${expect})`,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return { ok: false, error: err.message, durationMs: Date.now() - startedAt };
  }
}

/** Probe once without mutating state — used by the "run now" / test endpoint. */
export async function probe(check, server) {
  const startedAt = Date.now();
  if (check.type === 'http') return probeHttp(check.config, startedAt);
  if (check.type === 'tcp') return probeTcp(check.config, startedAt);
  return probeScript(check.config, server, startedAt);
}

async function takeAction(check, result) {
  const server = await serverStore.get(check.serverId);
  if (!server) return;
  const actionLabel = check.action === 'restart' ? 'yeniden başlatıldı' : 'uyarı verildi';
  const detail = `sağlık kontrolü başarısız (${result.error}) → ${actionLabel}`;

  // Raise an alert (→ notification channels) regardless of the action.
  eventBus.emit('alert', {
    serverId: check.serverId,
    alert: { type: 'healthcheck', fullName: check.target, at: Date.now(), detail },
  });
  auditStore.record({
    actorName: 'healthcheck',
    action: 'healthcheck.triggered',
    serverId: check.serverId,
    target: check.target,
    status: 'error',
    detail: `${check.type}: ${result.error}`,
  });

  if (check.action === 'restart') {
    try {
      await supervisorService.restart(server, check.target);
      auditStore.record({
        actorName: 'healthcheck',
        action: 'healthcheck.restart',
        serverId: check.serverId,
        target: check.target,
      });
    } catch (err) {
      auditStore.record({
        actorName: 'healthcheck',
        action: 'healthcheck.restart',
        serverId: check.serverId,
        target: check.target,
        status: 'error',
        detail: err.message,
      });
    }
  }
}

class HealthCheckScheduler {
  constructor() {
    this.timers = new Map(); // checkId -> interval handle
  }

  /** Run one scheduled check by id (re-reads it for the latest failure count). */
  async runCheck(id) {
    const check = await healthCheckStore.get(id);
    if (!check || !check.enabled) {
      this.unschedule(id);
      return;
    }

    const server = check.type === 'script' ? await serverStore.get(check.serverId) : null;
    const result = await probe(check, server);
    const now = new Date().toISOString();

    if (result.ok) {
      await healthCheckStore.recordResult(id, {
        lastCheckedAt: now,
        lastStatus: 'ok',
        consecutiveFailures: 0,
        lastError: null,
      });
      return;
    }

    const failures = (check.consecutiveFailures || 0) + 1;
    const fields = {
      lastCheckedAt: now,
      lastStatus: 'fail',
      consecutiveFailures: failures,
      lastError: result.error,
    };
    if (failures >= check.failureThreshold) {
      // Reset the counter after acting so we don't restart every interval; the
      // count climbs again before the next action.
      fields.consecutiveFailures = 0;
      fields.lastActionAt = now;
      await takeAction(check, result);
    }
    await healthCheckStore.recordResult(id, fields);
  }

  schedule(check) {
    this.unschedule(check.id);
    if (!check.enabled) return;
    const ms = Math.max(5, check.intervalSec || 30) * 1000;
    const handle = setInterval(() => {
      this.runCheck(check.id).catch((err) =>
        console.error('[helmio] health check error:', err.message),
      );
    }, ms);
    if (handle.unref) handle.unref();
    this.timers.set(check.id, handle);
  }

  unschedule(id) {
    const handle = this.timers.get(id);
    if (handle) {
      clearInterval(handle);
      this.timers.delete(id);
    }
  }

  /** Resync timers with the store (call at startup and after any CRUD). */
  async reload() {
    for (const id of [...this.timers.keys()]) this.unschedule(id);
    const checks = await healthCheckStore.list().catch(() => []);
    for (const c of checks) if (c.enabled) this.schedule(c);
  }
}

export const healthCheckScheduler = new HealthCheckScheduler();

export function startHealthChecks() {
  healthCheckScheduler
    .reload()
    .catch((err) => console.error('[helmio] health check init failed:', err.message));
}
