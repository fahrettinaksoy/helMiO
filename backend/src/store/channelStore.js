import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { encrypt, decrypt } from '../auth/secretBox.js';

const FILE = path.join(config.dataDir, 'channels.json');

/**
 * Persistent registry of notification channels. A channel routes derived alerts
 * (fatal / flapping / ...) to an external destination (Slack, Discord, Telegram,
 * generic webhook or email).
 *
 * Channel shape:
 *   { id, type, name, enabled, config:{...}, filters:{ serverIds:[], alertTypes:[] },
 *     createdAt, updatedAt, lastSentAt, lastError }
 *
 * `config` holds type-specific secrets (webhook urls, bot tokens, SMTP creds).
 * Those are masked by publicChannel() before leaving the backend.
 */
const SECRET_KEYS = ['webhookUrl', 'url', 'botToken', 'pass', 'password'];

// Encrypt/decrypt the secret keys inside a channel's config at rest.
function mapSecrets(ch, fn) {
  if (!ch?.config) return ch;
  const cfg = { ...ch.config };
  for (const k of SECRET_KEYS) if (cfg[k]) cfg[k] = fn(cfg[k]);
  return { ...ch, config: cfg };
}

async function readAll() {
  try {
    const list = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return list.map((c) => mapSecrets(c, decrypt));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeAll(channels) {
  await fs.mkdir(config.dataDir, { recursive: true });
  const encrypted = channels.map((c) => mapSecrets(c, encrypt));
  await fs.writeFile(FILE, JSON.stringify(encrypted, null, 2), 'utf8');
}

/** Mask secret config values before sending a channel to the client. */
export function publicChannel(ch) {
  if (!ch) return null;
  const cfg = { ...ch.config };
  for (const k of SECRET_KEYS) {
    if (cfg[k]) cfg[k] = '••••••';
  }
  return { ...ch, config: cfg };
}

export const channelStore = {
  async list() {
    return readAll();
  },

  async listPublic() {
    return (await readAll()).map(publicChannel);
  },

  async get(id) {
    return (await readAll()).find((c) => c.id === id) || null;
  },

  /** Channels that should receive a given alert for a given server. */
  async match(serverId, alertType) {
    const all = await readAll();
    return all.filter((c) => {
      if (!c.enabled) return false;
      const f = c.filters || {};
      if (f.serverIds?.length && !f.serverIds.includes(serverId)) return false;
      if (f.alertTypes?.length && !f.alertTypes.includes(alertType)) return false;
      return true;
    });
  },

  async create(data) {
    const all = await readAll();
    const now = new Date().toISOString();
    const channel = {
      id: nanoid(10),
      type: data.type,
      name: data.name,
      enabled: data.enabled ?? true,
      config: data.config || {},
      filters: {
        serverIds: data.filters?.serverIds || [],
        alertTypes: data.filters?.alertTypes || [],
      },
      createdAt: now,
      updatedAt: now,
      lastSentAt: null,
      lastError: null,
    };
    all.push(channel);
    await writeAll(all);
    return publicChannel(channel);
  },

  async update(id, patch) {
    const all = await readAll();
    const idx = all.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    const existing = all[idx];
    // Merge config, preserving stored secrets when the masked placeholder arrives.
    const nextConfig = { ...existing.config, ...(patch.config || {}) };
    for (const k of SECRET_KEYS) {
      if (patch.config && patch.config[k] === '••••••') nextConfig[k] = existing.config[k];
    }
    all[idx] = {
      ...existing,
      ...patch,
      id,
      config: nextConfig,
      filters: patch.filters
        ? { serverIds: patch.filters.serverIds || [], alertTypes: patch.filters.alertTypes || [] }
        : existing.filters,
      updatedAt: new Date().toISOString(),
    };
    await writeAll(all);
    return publicChannel(all[idx]);
  },

  /** Record delivery outcome (called by the notifier). */
  async markSent(id, error = null) {
    const all = await readAll();
    const idx = all.findIndex((c) => c.id === id);
    if (idx === -1) return;
    all[idx].lastSentAt = new Date().toISOString();
    all[idx].lastError = error;
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
