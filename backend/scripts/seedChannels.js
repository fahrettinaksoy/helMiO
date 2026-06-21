/**
 * Seed 38 notification channels into DATA_DIR/channels.json.
 *
 * Goes through channelStore.create() so ids, timestamps and at-rest secret
 * encryption all match what the API produces. Idempotent: any existing
 * channels.json is removed first (a .bak copy is kept).
 *
 * Run:  node scripts/seedChannels.js
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { channelStore } from '../src/store/channelStore.js';

// Real server ids from data/servers.json — used to vary channel filters.
const SERVERS = ['lmiu2V9Mam', '3VbbGK-wvV', '5_t0_yZxMc'];
const ALERTS = ['fatal', 'flapping', 'healthcheck'];

// Pick deterministically (no randomness) so reruns produce identical data.
const pick = (arr, i) => arr[i % arr.length];

/**
 * Build a filter that cycles through a few realistic shapes:
 *  - every Nth channel: all servers / all alerts (broadest)
 *  - others: a specific server and/or a subset of alert types
 */
function filtersFor(i) {
  switch (i % 4) {
    case 0:
      return { serverIds: [], alertTypes: [] }; // catch-all
    case 1:
      return { serverIds: [pick(SERVERS, i)], alertTypes: ['fatal'] };
    case 2:
      return { serverIds: [pick(SERVERS, i), pick(SERVERS, i + 1)], alertTypes: ['fatal', 'flapping'] };
    default:
      return { serverIds: [], alertTypes: [pick(ALERTS, i)] };
  }
}

// Disable roughly every 5th channel so the list shows a mix of states.
const enabledFor = (i) => i % 5 !== 0;

// 38 channel definitions, grouped by transport with realistic names + config.
const defs = [];

// --- Slack (9) ---
[
  'Slack #ops-alerts', 'Slack #incidents', 'Slack #platform', 'Slack #oncall',
  'Slack #backend', 'Slack #infra-prod', 'Slack #infra-staging', 'Slack #db-team',
  'Slack #noc',
].forEach((name, k) =>
  defs.push({
    type: 'slack',
    name,
    config: { webhookUrl: `https://hooks.slack.com/services/T0SEED${k}AB/B0SEED${k}CD/${'x'.repeat(20)}${k}` },
  }),
);

// --- Discord (8) ---
[
  'Discord Ops', 'Discord Alerts', 'Discord SRE', 'Discord Dev',
  'Discord Prod Watch', 'Discord Staging', 'Discord Night Shift', 'Discord Escalations',
].forEach((name, k) =>
  defs.push({
    type: 'discord',
    name,
    config: { webhookUrl: `https://discord.com/api/webhooks/10000000000000${k}0/${'d'.repeat(24)}${k}` },
  }),
);

// --- Telegram (7) ---
[
  'Telegram Ops Bot', 'Telegram Alerts Bot', 'Telegram SRE Bot', 'Telegram On-Call',
  'Telegram Infra', 'Telegram Critical', 'Telegram Daily Digest',
].forEach((name, k) =>
  defs.push({
    type: 'telegram',
    name,
    config: { botToken: `70000000${k}:AAH-seed-token-${'t'.repeat(16)}${k}`, chatId: `-100123456${100 + k}` },
  }),
);

// --- Webhook (8) ---
[
  'PagerDuty Webhook', 'Opsgenie Webhook', 'Generic Webhook A', 'Generic Webhook B',
  'Datadog Events', 'Grafana OnCall', 'Internal Bus', 'Audit Sink',
].forEach((name, k) =>
  defs.push({
    type: 'webhook',
    name,
    config: { url: `https://hooks.example.com/helmio/seed-${k}/${'w'.repeat(12)}${k}` },
  }),
);

// --- Email (6) ---
[
  { name: 'Email Ops Team', to: 'ops@example.com' },
  { name: 'Email SRE', to: 'sre@example.com' },
  { name: 'Email Management', to: 'managers@example.com' },
  { name: 'Email NOC', to: 'noc@example.com' },
  { name: 'Email DBA', to: 'dba@example.com' },
  { name: 'Email Escalation', to: 'escalation@example.com' },
].forEach((e, k) =>
  defs.push({
    type: 'email',
    name: e.name,
    config: {
      smtpHost: 'smtp.example.com',
      smtpPort: k % 2 === 0 ? 587 : 465,
      secure: k % 2 !== 0,
      user: 'alerts@example.com',
      pass: `seed-smtp-pass-${k}`,
      from: 'HelMiO Alerts <alerts@example.com>',
      to: e.to,
    },
  }),
);

async function main() {
  if (defs.length !== 38) throw new Error(`expected 38 definitions, got ${defs.length}`);

  const file = path.join(config.dataDir, 'channels.json');
  try {
    await fs.copyFile(file, `${file}.bak`);
    await fs.rm(file);
    console.log(`[seed] existing channels.json backed up to channels.json.bak and cleared`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let n = 0;
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    await channelStore.create({
      type: d.type,
      name: d.name,
      enabled: enabledFor(i),
      config: d.config,
      filters: filtersFor(i),
    });
    n++;
  }
  console.log(`[seed] created ${n} notification channels in ${file}`);
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
