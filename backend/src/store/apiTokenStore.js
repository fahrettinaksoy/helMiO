import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { ROLES } from '../auth/rbac.js';

const FILE = path.join(config.dataDir, 'api-tokens.json');

/**
 * Persistent registry of API tokens for programmatic / CI-CD access to the
 * Helmio REST API. A token carries a role, so it is gated by the exact same
 * RBAC as a human session — an 'operator' token can start/stop processes but
 * not manage servers, etc.
 *
 * The plaintext token (`hmo_<hex>`) is shown ONCE at creation; only its SHA-256
 * hash is stored. Lookups hash the presented token and compare.
 *
 * Shape: { id, name, role, prefix, tokenHash, createdAt, createdBy, lastUsedAt }
 */
function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function readAll() {
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

let writeChain = Promise.resolve();
function writeAll(tokens) {
  writeChain = writeChain.then(async () => {
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(tokens, null, 2), 'utf8');
  });
  return writeChain;
}

/** Public view — never exposes the hash. `prefix` lets the UI identify a token. */
export function publicToken(t) {
  if (!t) return null;
  const { tokenHash, ...rest } = t;
  return rest;
}

export const apiTokenStore = {
  async list() {
    return (await readAll()).map(publicToken);
  },

  /**
   * Create a token. Returns { token (plaintext, show once), record (public) }.
   */
  async create({ name, role = ROLES.VIEWER, createdBy = null }) {
    const all = await readAll();
    const secret = `hmo_${crypto.randomBytes(24).toString('hex')}`;
    const now = new Date().toISOString();
    const record = {
      id: nanoid(10),
      name,
      role,
      prefix: secret.slice(0, 11), // "hmo_" + 7 hex
      tokenHash: hash(secret),
      createdAt: now,
      createdBy,
      lastUsedAt: null,
    };
    all.push(record);
    await writeAll(all);
    return { token: secret, record: publicToken(record) };
  },

  /** Verify a presented token. Returns the record (incl. role) or null. */
  async verify(token) {
    if (!token || !token.startsWith('hmo_')) return null;
    const h = hash(token);
    const all = await readAll();
    return all.find((t) => t.tokenHash === h) || null;
  },

  /** Throttled lastUsedAt bump (avoids a write on every request). */
  async touch(id) {
    const all = await readAll();
    const idx = all.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const last = all[idx].lastUsedAt ? Date.parse(all[idx].lastUsedAt) : 0;
    if (Date.now() - last < 60000) return; // at most once per minute
    all[idx].lastUsedAt = new Date().toISOString();
    await writeAll(all);
  },

  async get(id) {
    return (await readAll()).find((t) => t.id === id) || null;
  },

  async remove(id) {
    const all = await readAll();
    const next = all.filter((t) => t.id !== id);
    if (next.length === all.length) return false;
    await writeAll(next);
    return true;
  },
};
