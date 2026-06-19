import { serverStore } from './store/serverStore.js';
import { supervisorService } from './services/supervisorService.js';
import { installerService } from './services/installerService.js';
import { config } from './config.js';
import { verifyToken } from './auth/jwt.js';
import { userStore } from './store/userStore.js';
import { roleHasPermission, PERMISSIONS } from './auth/rbac.js';
import { auditStore } from './store/auditStore.js';
import { eventBus } from './events/eventBus.js';
import { metricsStore } from './store/metricsStore.js';

/**
 * Realtime layer. Clients join a per-server room ("server:<id>"). For each room
 * with at least one subscriber, a single poller fetches a snapshot every
 * POLL_INTERVAL_MS and broadcasts it. The poller stops when the room empties.
 *
 * Socket events
 *   client -> server: "subscribe" { serverId } / "unsubscribe" { serverId }
 *   server -> client: "snapshot"  { serverId, snapshot } / "error" { serverId, error }
 */
export function setupRealtime(io) {
  const pollers = new Map(); // serverId -> intervalId

  // Authenticate every socket from its handshake token. Rejected sockets never
  // reach the connection handler, so all realtime data is gated behind login.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    const payload = token ? verifyToken(token) : null;
    if (!payload) return next(new Error('unauthorized'));
    const user = await userStore.getById(payload.sub);
    if (!user || user.disabled) return next(new Error('unauthorized'));
    socket.user = { id: user.id, username: user.username, role: user.role };
    next();
  });

  function roomName(serverId) {
    return `server:${serverId}`;
  }

  function subscriberCount(serverId) {
    return io.sockets.adapter.rooms.get(roomName(serverId))?.size ?? 0;
  }

  // Previous per-process state per server, for snapshot-based alert detection.
  // This makes alerting work for ALL servers (polled), even without the
  // eventlistener installed; the listener just makes the same alerts instant.
  const prevStates = new Map(); // serverId -> Map(fullName -> { statecode, flapping })

  function detectAlerts(serverId, snapshot) {
    const prev = prevStates.get(serverId) || new Map();
    const next = new Map();
    const now = Date.now();
    for (const p of snapshot.processes || []) {
      next.set(p.fullName, { statecode: p.statecode, flapping: !!p.flapping });
      const pr = prev.get(p.fullName);
      if (!pr) continue; // skip first observation to avoid a load-time flood
      if (p.statecode === 200 && pr.statecode !== 200) {
        eventBus.emit('alert', { serverId, alert: { type: 'fatal', fullName: p.fullName, at: now } });
      }
      if (p.flapping && !pr.flapping) {
        eventBus.emit('alert', { serverId, alert: { type: 'flapping', fullName: p.fullName, at: now } });
      }
    }
    prevStates.set(serverId, next);
  }

  // Record a metric sample (throttled). Pulls host load/mem/disk too when the
  // sample is actually due and the connector has shell access.
  async function sampleMetrics(serverId, server, snapshot) {
    if (!metricsStore.due(serverId)) return;
    let host = null;
    try { host = await supervisorService.hostMetrics(server); } catch { /* none */ }
    metricsStore.recordFromSnapshot(serverId, snapshot, { host });
  }

  async function pollOnce(serverId) {
    const server = await serverStore.get(serverId);
    if (!server) {
      io.to(roomName(serverId)).emit('error', { serverId, error: 'Sunucu bulunamadı' });
      return;
    }
    try {
      const snapshot = await supervisorService.snapshot(server);
      detectAlerts(serverId, snapshot);
      await sampleMetrics(serverId, server, snapshot);
      io.to(roomName(serverId)).emit('snapshot', { serverId, snapshot, at: Date.now() });
    } catch (err) {
      io.to(roomName(serverId)).emit('error', { serverId, error: err.message, at: Date.now() });
    }
  }

  function startPoller(serverId) {
    if (pollers.has(serverId)) return;
    pollOnce(serverId); // immediate first tick
    const interval = setInterval(() => pollOnce(serverId), config.pollIntervalMs);
    pollers.set(serverId, interval);
  }

  function stopPoller(serverId) {
    const interval = pollers.get(serverId);
    if (interval) {
      clearInterval(interval);
      pollers.delete(serverId);
    }
  }

  // --- Event-driven push (from the supervisord eventlistener via ingest) ---
  // A state-change event means the polled snapshot is now stale; refresh it
  // immediately (debounced so a burst of events triggers one refresh).
  const refreshTimers = new Map(); // serverId -> timeout
  function scheduleRefresh(serverId) {
    if (subscriberCount(serverId) === 0) return;
    if (refreshTimers.has(serverId)) return;
    const t = setTimeout(() => {
      refreshTimers.delete(serverId);
      pollOnce(serverId);
    }, 400);
    refreshTimers.set(serverId, t);
  }

  eventBus.on('event', ({ serverId, event }) => {
    io.to(roomName(serverId)).emit('event', { serverId, event, at: event.at });
    // PROCESS_STATE / GROUP changes affect the process table → refresh snapshot.
    if (event.eventname?.startsWith('PROCESS_STATE') || event.eventname?.startsWith('PROCESS_GROUP')
        || event.eventname?.startsWith('SUPERVISOR_STATE')) {
      scheduleRefresh(serverId);
    }
  });

  eventBus.on('alert', ({ serverId, alert }) => {
    io.to(roomName(serverId)).emit('alert', { serverId, ...alert });
  });

  // Fleet orchestration live progress — broadcast; the client filters by runId.
  eventBus.on('fleet', (payload) => {
    io.emit('fleet', payload);
  });

  // --- Background alert sweep ---
  // Polls every server that is NOT already being watched (no subscriber poller)
  // for alert detection only. Watched servers get detection from their poller;
  // servers with the eventlistener get it via push. This closes the gap for
  // unwatched, listener-less servers so notifications still fire.
  async function monitorOnce(serverId) {
    if (pollers.has(serverId)) return; // already polled by a subscriber
    const server = await serverStore.get(serverId);
    if (!server) return;
    try {
      const snapshot = await supervisorService.snapshot(server);
      detectAlerts(serverId, snapshot);
      await sampleMetrics(serverId, server, snapshot);
    } catch { /* unreachable server: skip this sweep */ }
  }

  if (config.alertPollIntervalMs > 0) {
    setInterval(async () => {
      const servers = await serverStore.list().catch(() => []);
      for (const s of servers) monitorOnce(s.id);
    }, config.alertPollIntervalMs);
  }

  io.on('connection', (socket) => {
    socket.on('subscribe', ({ serverId } = {}) => {
      if (!serverId) return;
      socket.join(roomName(serverId));
      startPoller(serverId);
      pollOnce(serverId); // push fresh data to the newcomer
    });

    socket.on('unsubscribe', ({ serverId } = {}) => {
      if (!serverId) return;
      socket.leave(roomName(serverId));
      if (subscriberCount(serverId) === 0) stopPoller(serverId);
    });

    socket.on('disconnecting', () => {
      for (const room of socket.rooms) {
        if (!room.startsWith('server:')) continue;
        const serverId = room.slice('server:'.length);
        // size still counts this socket; it leaves after this handler.
        if (subscriberCount(serverId) <= 1) stopPoller(serverId);
      }
    });

    // --- Supervisor install (live log stream to the requesting socket) ---
    let installing = false;
    socket.on('install:start', async ({ serverId, sudoPassword = '', configureHttp = true } = {}) => {
      if (installing) return;
      // Installing Supervisor mutates the target host — admin-level action.
      if (!roleHasPermission(socket.user.role, PERMISSIONS.SERVER_MANAGE)) {
        socket.emit('install:result', { ok: false, error: 'Bu işlem için yetkiniz yok' });
        return;
      }
      const server = await serverStore.get(serverId);
      if (!server) {
        socket.emit('install:result', { ok: false, error: 'Sunucu bulunamadı' });
        return;
      }
      installing = true;
      auditStore.record({
        actorId: socket.user.id, actorName: socket.user.username, role: socket.user.role,
        action: 'supervisor.install', serverId, target: server.name,
      });
      const log = (line) => socket.emit('install:log', { serverId, line });
      try {
        const result = await installerService.install(server, { sudoPassword, configureHttp }, log);
        socket.emit('install:result', { serverId, ...result });
      } catch (err) {
        socket.emit('install:log', { serverId, line: `\n✗ Hata: ${err.message}` });
        socket.emit('install:result', { serverId, ok: false, error: err.message });
      } finally {
        installing = false;
      }
    });

    // --- Live log tail (per socket) ---
    let logTimer = null;
    function stopLog() {
      if (logTimer) { clearInterval(logTimer); logTimer = null; }
    }
    socket.on('log:start', async ({ serverId, fullName, channel = 'stdout', daemon = false } = {}) => {
      stopLog();
      const server = await serverStore.get(serverId);
      if (!server || (!fullName && !daemon)) {
        socket.emit('log:error', { error: 'Sunucu/işlem bulunamadı' });
        return;
      }

      // Main supervisord log: snapshot replace each tick.
      if (daemon) {
        const tickD = async () => {
          try {
            const data = await supervisorService.tailDaemonLog(server);
            socket.emit('log:chunk', { data, append: false });
          } catch (err) {
            socket.emit('log:error', { error: err.message });
          }
        };
        await tickD();
        logTimer = setInterval(tickD, 2000);
        return;
      }

      const incremental = supervisorService.supportsLogOffset(server);
      let offset = 0;
      let first = true;
      const tick = async () => {
        try {
          const useOffset = incremental ? offset : 0;
          const res = await supervisorService.tailLog(server, fullName, channel, useOffset);
          offset = res.offset;
          if (incremental) {
            if (first) {
              // Byte offset where the displayed content begins — the anchor the
              // client uses to page backwards through older log history.
              const startOffset = Math.max(0, (res.offset || 0) - Buffer.byteLength(res.data || '', 'utf8'));
              socket.emit('log:chunk', { data: res.data || '', append: false, startOffset });
            } else if (res.data) {
              socket.emit('log:chunk', { data: res.data, append: true });
            }
            first = false;
          } else {
            // No offset support (docker): send full snapshot, client replaces.
            socket.emit('log:chunk', { data: res.data, append: false });
          }
        } catch (err) {
          socket.emit('log:error', { error: err.message });
        }
      };
      await tick();
      logTimer = setInterval(tick, 1500);
    });
    socket.on('log:stop', stopLog);

    socket.on('disconnecting', stopLog);
  });
}
