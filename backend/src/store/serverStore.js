import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { encryptFields, decryptFields } from '../auth/secretBox.js';

const FILE = path.join(config.dataDir, 'servers.json');

// Connection secrets encrypted at rest (AES-256-GCM). Read paths decrypt so the
// rest of the app sees plaintext; write paths encrypt. Legacy plaintext values
// are migrated to ciphertext on the next write.
const SECRET_FIELDS = ['password', 'privateKey', 'sshPassword', 'agentToken', 'ingestToken'];

/**
 * Persistent registry of Supervisor server definitions, backed by a single JSON
 * file under DATA_DIR. Connection secrets are encrypted at rest (see secretBox).
 */
async function readAll() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    const list = JSON.parse(raw);
    return list.map((s) => decryptFields(s, SECRET_FIELDS));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeAll(servers) {
  await fs.mkdir(config.dataDir, { recursive: true });
  const encrypted = servers.map((s) => encryptFields(s, SECRET_FIELDS));
  await fs.writeFile(FILE, JSON.stringify(encrypted, null, 2), 'utf8');
}

export const serverStore = {
  async list() {
    return readAll();
  },

  async get(id) {
    const all = await readAll();
    return all.find((s) => s.id === id) || null;
  },

  async create(data) {
    const all = await readAll();
    const now = new Date().toISOString();
    const server = { id: nanoid(10), createdAt: now, updatedAt: now, ...data };
    all.push(server);
    await writeAll(all);
    return server;
  },

  async update(id, patch) {
    const all = await readAll();
    const idx = all.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    all[idx] = { ...all[idx], ...patch, id, updatedAt: new Date().toISOString() };
    await writeAll(all);
    return all[idx];
  },

  async remove(id) {
    const all = await readAll();
    const next = all.filter((s) => s.id !== id);
    if (next.length === all.length) return false;
    await writeAll(next);
    return true;
  },
};
