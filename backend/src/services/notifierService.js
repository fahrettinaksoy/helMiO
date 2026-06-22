import { eventBus } from '../events/eventBus.js';
import { channelStore } from '../store/channelStore.js';
import { serverStore } from '../store/serverStore.js';
import { auditStore } from '../store/auditStore.js';

/**
 * Notifier: turns derived alerts into outbound notifications.
 *
 * Subscribes to the event bus 'alert' channel, finds the channels whose filters
 * match the alert, formats a per-transport message and dispatches it. Delivery
 * is best-effort and de-duplicated so the poll path and the eventlistener push
 * path don't double-notify for the same alert.
 */
const DEDUP_WINDOW_MS = 60000;
const recent = new Map(); // `${serverId}:${fullName}:${type}` -> epoch ms

function isDuplicate(serverId, fullName, type, now) {
  const key = `${serverId}:${fullName}:${type}`;
  const last = recent.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return true;
  recent.set(key, now);
  // Opportunistic cleanup to keep the map bounded.
  if (recent.size > 1000) {
    for (const [k, t] of recent) if (now - t > DEDUP_WINDOW_MS) recent.delete(k);
  }
  return false;
}

const EMOJI = { fatal: '🔴', flapping: '🟠', healthcheck: '🩺' };
const VERB = {
  fatal: 'FATAL durumuna düştü',
  flapping: 'sürekli yeniden başlıyor (flapping)',
  healthcheck: 'sağlık kontrolünden geçemedi',
};

function describe(alert, serverName) {
  const emoji = EMOJI[alert.type] || '⚠️';
  const verb = alert.detail || VERB[alert.type] || 'uyarı oluşturdu';
  const proc = alert.fullName || 'bir süreç';
  return {
    title: `${emoji} Helmio uyarısı — ${serverName}`,
    text: `${emoji} [${serverName}] ${proc} ${verb}`,
  };
}

// --- Per-transport dispatch. Each returns a promise; throws on failure. ---

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function dispatch(channel, msg, alert, serverName) {
  const c = channel.config || {};
  switch (channel.type) {
    case 'slack':
      return postJson(c.webhookUrl, { text: msg.text });
    case 'discord':
      return postJson(c.webhookUrl, { content: msg.text });
    case 'telegram':
      return postJson(`https://api.telegram.org/bot${c.botToken}/sendMessage`, {
        chat_id: c.chatId,
        text: msg.text,
      });
    case 'webhook':
      return postJson(c.url, {
        source: 'helmio',
        type: alert.type,
        server: serverName,
        serverId: alert.serverId,
        process: alert.fullName,
        at: alert.at,
        message: msg.text,
      });
    case 'email': {
      const { default: nodemailer } = await import('nodemailer');
      const transport = nodemailer.createTransport({
        host: c.smtpHost,
        port: c.smtpPort,
        secure: !!c.secure,
        auth: c.user ? { user: c.user, pass: c.pass } : undefined,
      });
      return transport.sendMail({
        from: c.from,
        to: c.to,
        subject: msg.title,
        text: msg.text,
      });
    }
    default:
      throw new Error(`bilinmeyen kanal türü: ${channel.type}`);
  }
}

/** Send a one-off test message through a channel (used by the test endpoint). */
export async function sendTest(channel) {
  const msg = {
    title: '✅ Helmio test bildirimi',
    text: `✅ Helmio test bildirimi — "${channel.name}" kanalı çalışıyor.`,
  };
  await dispatch(
    channel,
    msg,
    { type: 'test', at: Date.now(), fullName: null, serverId: null },
    'test',
  );
  await channelStore.markSent(channel.id, null);
  return { ok: true };
}

async function handleAlert({ serverId, alert }) {
  const now = alert.at || Date.now();
  if (isDuplicate(serverId, alert.fullName, alert.type, now)) return;

  const matches = await channelStore.match(serverId, alert.type);
  if (!matches.length) return;

  const server = await serverStore.get(serverId);
  const serverName = server?.name || serverId;
  const msg = describe({ ...alert, serverId }, serverName);

  for (const channel of matches) {
    try {
      await dispatch(channel, msg, { ...alert, serverId }, serverName);
      await channelStore.markSent(channel.id, null);
      auditStore.record({
        actorName: 'notifier',
        action: 'notify.sent',
        serverId,
        target: channel.name,
        detail: `${channel.type} · ${alert.type} · ${alert.fullName || ''}`,
      });
    } catch (err) {
      await channelStore.markSent(channel.id, err.message);
      auditStore.record({
        actorName: 'notifier',
        action: 'notify.failed',
        serverId,
        status: 'error',
        target: channel.name,
        detail: `${channel.type}: ${err.message}`,
      });
    }
  }
}

/** Wire the notifier to the event bus. Call once at startup. */
export function startNotifier() {
  eventBus.on('alert', (payload) => {
    handleAlert(payload).catch((err) => console.error('[helmio] notifier error:', err.message));
  });
}
