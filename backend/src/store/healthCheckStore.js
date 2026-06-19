import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../config.js';

const FILE = path.join(config.dataDir, 'healthchecks.json');

/**
 * Persistent registry of health checks. A check probes an HTTP endpoint or TCP
 * port that a supervised process exposes; after N consecutive failures it takes
 * an action (restart the process and/or raise an alert).
 *
 * Shape:
 *   { id, serverId, target (fullName), type: 'http'|'tcp', enabled,
 *     intervalSec, failureThreshold, action: 'restart'|'alert',
 *     config: { url, expectStatus, host, port, timeoutMs },
 *     createdAt, updatedAt,
 *     lastCheckedAt, lastStatus: 'ok'|'fail'|'unknown', consecutiveFailures,
 *     lastError, lastActionAt }
 *
 * Runtime status fields (lastStatus, consecutiveFailures, …) are persisted so
 * the UI shows current health across restarts.
 */
async function readAll() {
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

let writeChain = Promise.resolve();
function writeAll(checks) {
  // Serialise writes so concurrent probe-result updates don't clobber each other.
  writeChain = writeChain.then(async () => {
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(checks, null, 2), 'utf8');
  });
  return writeChain;
}

export const healthCheckStore = {
  async list() {
    return readAll();
  },

  async listByServer(serverId) {
    return (await readAll()).filter((c) => c.serverId === serverId);
  },

  async get(id) {
    return (await readAll()).find((c) => c.id === id) || null;
  },

  async create(data) {
    const all = await readAll();
    const now = new Date().toISOString();
    const check = {
      id: nanoid(10),
      serverId: data.serverId,
      target: data.target,
      type: data.type,
      enabled: data.enabled ?? true,
      intervalSec: data.intervalSec ?? 30,
      failureThreshold: data.failureThreshold ?? 3,
      action: data.action ?? 'restart',
      config: data.config || {},
      createdAt: now,
      updatedAt: now,
      lastCheckedAt: null,
      lastStatus: 'unknown',
      consecutiveFailures: 0,
      lastError: null,
      lastActionAt: null,
    };
    all.push(check);
    await writeAll(all);
    return check;
  },

  async update(id, patch) {
    const all = await readAll();
    const idx = all.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    all[idx] = { ...all[idx], ...patch, id, updatedAt: new Date().toISOString() };
    await writeAll(all);
    return all[idx];
  },

  /** Persist a probe outcome without bumping updatedAt. */
  async recordResult(id, fields) {
    const all = await readAll();
    const idx = all.findIndex((c) => c.id === id);
    if (idx === -1) return;
    all[idx] = { ...all[idx], ...fields };
    await writeAll(all);
  },

  async remove(id) {
    const all = await readAll();
    const next = all.filter((c) => c.id !== id);
    if (next.length === all.length) return false;
    await writeAll(next);
    return true;
  },
};
