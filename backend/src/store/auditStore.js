import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../config.js';

const FILE = path.join(config.dataDir, 'audit.log');
const MAX_LINES = 20000; // keep the most recent N events; trim on append

/**
 * Append-only audit trail. One JSON object per line (JSONL) so writes are cheap
 * and append-safe. Each entry records who did what, to which target, the result
 * and the source IP.
 *
 * Entry shape:
 *   { id, at, actorId, actorName, role, action, serverId, target, status, detail, ip }
 */
let writeChain = Promise.resolve(); // serialise appends to avoid interleaving

async function appendLine(line) {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.appendFile(FILE, line + '\n', 'utf8');
}

async function readLines() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    return raw.split('\n').filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export const auditStore = {
  /**
   * Record an audit event. Never throws into the caller — auditing must not
   * break the action it describes. Returns the created entry.
   */
  record(entry) {
    const full = {
      id: nanoid(12),
      at: new Date().toISOString(),
      actorId: entry.actorId || null,
      actorName: entry.actorName || 'system',
      role: entry.role || null,
      action: entry.action,
      serverId: entry.serverId || null,
      target: entry.target || null,
      status: entry.status || 'ok', // 'ok' | 'error'
      detail: entry.detail || null,
      ip: entry.ip || null,
    };
    writeChain = writeChain
      .then(() => appendLine(JSON.stringify(full)))
      .then(async () => {
        // Periodic trim: when the file grows past MAX_LINES, keep the tail.
        const lines = await readLines();
        if (lines.length > MAX_LINES) {
          const kept = lines.slice(-MAX_LINES).join('\n') + '\n';
          await fs.writeFile(FILE, kept, 'utf8');
        }
      })
      .catch((err) => console.error('[helmio] audit write failed:', err.message));
    return full;
  },

  /**
   * Query the trail (newest first) with optional filters and pagination.
   * @param {{ serverId?: string, actorId?: string, action?: string,
   *           status?: string, limit?: number, offset?: number }} opts
   */
  async query(opts = {}) {
    const lines = await readLines();
    let items = lines
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean)
      .reverse(); // newest first

    if (opts.serverId) items = items.filter((e) => e.serverId === opts.serverId);
    if (opts.actorId) items = items.filter((e) => e.actorId === opts.actorId);
    if (opts.action) items = items.filter((e) => e.action === opts.action);
    if (opts.status) items = items.filter((e) => e.status === opts.status);

    const total = items.length;
    const offset = Math.max(0, Number(opts.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
    return { total, offset, limit, items: items.slice(offset, offset + limit) };
  },
};
