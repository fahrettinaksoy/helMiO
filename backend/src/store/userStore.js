import fs from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { ROLES } from '../auth/rbac.js';

const FILE = path.join(config.dataDir, 'users.json');
const SALT_ROUNDS = 10;

/**
 * Persistent registry of Helmio panel users (NOT supervisord processes).
 * Backed by a single JSON file under DATA_DIR. Passwords are stored only as
 * bcrypt hashes; the plaintext never touches disk.
 *
 * User shape: { id, username, displayName, role, passwordHash,
 *               disabled, createdAt, updatedAt, lastLoginAt }
 */
async function readAll() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeAll(users) {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(users, null, 2), 'utf8');
}

/** Strip the password hash before a user object leaves the backend. */
export function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

export const userStore = {
  async count() {
    return (await readAll()).length;
  },

  /** True before the first admin is created — gates the one-time setup flow. */
  async needsSetup() {
    return (await readAll()).length === 0;
  },

  async list() {
    return (await readAll()).map(publicUser);
  },

  async getById(id) {
    return (await readAll()).find((u) => u.id === id) || null;
  },

  async getByUsername(username) {
    const lc = String(username || '').toLowerCase();
    return (await readAll()).find((u) => u.username.toLowerCase() === lc) || null;
  },

  /** Create a user. `password` is plaintext and gets hashed here. */
  async create({ username, password, displayName = '', role = ROLES.VIEWER }) {
    const all = await readAll();
    if (all.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('Bu kullanıcı adı zaten kullanımda.');
    }
    const now = new Date().toISOString();
    const user = {
      id: nanoid(10),
      username,
      displayName: displayName || username,
      role,
      passwordHash: await bcrypt.hash(password, SALT_ROUNDS),
      disabled: false,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };
    all.push(user);
    await writeAll(all);
    return publicUser(user);
  },

  /**
   * Update a user. `patch` may include displayName, role, disabled and
   * `password` (plaintext, re-hashed). Returns the public user or null.
   */
  async update(id, patch = {}) {
    const all = await readAll();
    const idx = all.findIndex((u) => u.id === id);
    if (idx === -1) return null;
    const next = { ...all[idx] };
    if (patch.displayName != null) next.displayName = patch.displayName;
    if (patch.role != null) next.role = patch.role;
    if (patch.disabled != null) next.disabled = !!patch.disabled;
    if (patch.password) next.passwordHash = await bcrypt.hash(patch.password, SALT_ROUNDS);
    next.updatedAt = new Date().toISOString();
    all[idx] = next;
    await writeAll(all);
    return publicUser(next);
  },

  async remove(id) {
    const all = await readAll();
    const next = all.filter((u) => u.id !== id);
    if (next.length === all.length) return false;
    await writeAll(next);
    return true;
  },

  async touchLogin(id) {
    const all = await readAll();
    const idx = all.findIndex((u) => u.id === id);
    if (idx === -1) return;
    all[idx].lastLoginAt = new Date().toISOString();
    await writeAll(all);
  },

  /** Verify a password against the stored hash. */
  async verifyPassword(user, password) {
    if (!user || !user.passwordHash) return false;
    return bcrypt.compare(password, user.passwordHash);
  },

  /** How many admins exist (used to prevent removing/demoting the last one). */
  async adminCount() {
    return (await readAll()).filter((u) => u.role === ROLES.ADMIN && !u.disabled).length;
  },
};
