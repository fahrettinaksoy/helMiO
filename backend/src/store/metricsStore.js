import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Time-series of per-server health/resource samples feeding the trend charts.
 *
 * Samples are taken from each realtime snapshot, throttled to MIN_INTERVAL so a
 * fast poll cadence doesn't flood the buffer, and held in a bounded ring buffer.
 * The series is periodically persisted to disk (DATA_DIR/metrics.json) and
 * reloaded on boot, so trends survive a restart.
 *
 * Sample: { at, total, running, stopped, fatal, other, cpu, mem, load, memPct, diskPct }
 *   cpu/mem = aggregate process CPU% / RSS MB · load = host 1-min load
 *   memPct/diskPct = host memory / disk usage %  (host fields null without shell)
 */
const MAX_PER_SERVER = 2000;
const MIN_INTERVAL_MS = 10000;
const FILE = path.join(config.dataDir, 'metrics.json');

const series = new Map(); // serverId -> sample[]
const lastAt = new Map(); // serverId -> epoch ms of last recorded sample
let dirty = false;

export const metricsStore = {
  /** True if enough time has passed to record a new sample for this server. */
  due(serverId, now = Date.now()) {
    return now - (lastAt.get(serverId) || 0) >= MIN_INTERVAL_MS;
  },

  /**
   * Record a sample from a snapshot (+ optional host metrics). Honours the
   * per-server throttle; pass `force` to bypass it.
   */
  recordFromSnapshot(serverId, snapshot, { host = null, now = Date.now(), force = false } = {}) {
    if (!force && !this.due(serverId, now)) return;
    lastAt.set(serverId, now);

    const s = snapshot.summary || {};
    let cpu = null;
    let mem = null;
    for (const p of snapshot.processes || []) {
      if (typeof p.cpu === 'number') cpu = (cpu || 0) + p.cpu;
      if (typeof p.memMb === 'number') mem = (mem || 0) + p.memMb;
    }
    const memPct = host?.mem ? Math.round((host.mem.usedMb / host.mem.totalMb) * 1000) / 10 : null;
    const sample = {
      at: now,
      total: s.total ?? 0,
      running: s.running ?? 0,
      stopped: s.stopped ?? 0,
      fatal: s.fatal ?? 0,
      other: s.other ?? 0,
      cpu: cpu != null ? Math.round(cpu * 10) / 10 : null,
      mem: mem != null ? Math.round(mem * 10) / 10 : null,
      load: host?.load ? host.load.one : null,
      memPct,
      diskPct: host?.disk ? host.disk.usePct : null,
    };

    let buf = series.get(serverId);
    if (!buf) {
      buf = [];
      series.set(serverId, buf);
    }
    buf.push(sample);
    if (buf.length > MAX_PER_SERVER) buf.splice(0, buf.length - MAX_PER_SERVER);
    dirty = true;
  },

  /** Samples within the last `sinceMs` ms (oldest first). 0 = everything. */
  query(serverId, sinceMs = 3600000) {
    const buf = series.get(serverId) || [];
    if (!sinceMs) return [...buf];
    const cutoff = Date.now() - sinceMs;
    return buf.filter((p) => p.at >= cutoff);
  },

  /**
   * Fleet-wide aggregate for the dashboard:
   *  - series: per-minute buckets summed across servers (cpu/mem/running/total)
   *  - hosts:  the latest sample per server (load/mem%/disk% + cpu/mem)
   * Read entirely from the in-memory buffers — no calls to the targets.
   */
  fleet(sinceMs = 3600000, bucketMs = 60000) {
    const cutoff = Date.now() - sinceMs;
    const byBucket = new Map(); // bucketAt -> Map(serverId -> sample)
    const hosts = {};
    for (const [id, buf] of series) {
      const recent = buf.filter((p) => p.at >= cutoff);
      if (recent.length) hosts[id] = recent[recent.length - 1];
      for (const p of recent) {
        const b = Math.floor(p.at / bucketMs) * bucketMs;
        let m = byBucket.get(b);
        if (!m) {
          m = new Map();
          byBucket.set(b, m);
        }
        m.set(id, p); // last sample per server wins within a bucket
      }
    }
    const fleetSeries = [...byBucket.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([at, m]) => {
        let cpu = 0,
          mem = 0,
          running = 0,
          total = 0,
          cpuHas = false,
          memHas = false;
        for (const p of m.values()) {
          if (p.cpu != null) {
            cpu += p.cpu;
            cpuHas = true;
          }
          if (p.mem != null) {
            mem += p.mem;
            memHas = true;
          }
          running += p.running || 0;
          total += p.total || 0;
        }
        return {
          at,
          cpu: cpuHas ? Math.round(cpu * 10) / 10 : null,
          mem: memHas ? Math.round(mem * 10) / 10 : null,
          running,
          total,
        };
      });
    return { series: fleetSeries, hosts };
  },

  clear(serverId) {
    series.delete(serverId);
    lastAt.delete(serverId);
    dirty = true;
  },

  /** Load persisted series on boot. */
  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(FILE, 'utf8'));
      for (const [id, samples] of Object.entries(raw)) {
        if (Array.isArray(samples)) series.set(id, samples.slice(-MAX_PER_SERVER));
      }
    } catch {
      /* no prior metrics */
    }
  },

  /** Persist current series to disk (only when changed). */
  async persist() {
    if (!dirty) return;
    dirty = false;
    const obj = {};
    for (const [id, samples] of series) obj[id] = samples;
    try {
      await fs.mkdir(config.dataDir, { recursive: true });
      await fs.writeFile(FILE, JSON.stringify(obj), 'utf8');
    } catch (err) {
      console.error('[helmio] metrics persist failed:', err.message);
    }
  },
};
