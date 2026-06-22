/**
 * Seed 46 API tokens into DATA_DIR/api-tokens.json.
 *
 * Goes through apiTokenStore.create() so each record gets a real random secret,
 * SHA-256 hash, prefix and id exactly like the API produces (the plaintext is
 * discarded — it's only shown once anyway). A second pass back-fills varied
 * createdAt / lastUsedAt so the list looks lived-in (some never used).
 *
 * Idempotent: any existing api-tokens.json is backed up to .bak and cleared.
 *
 * Run:  node scripts/seedApiTokens.js
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { apiTokenStore } from '../src/store/apiTokenStore.js';
import { ROLES } from '../src/auth/rbac.js';

const CREATED_BY = 'fahrettinaksoy';

// 46 token definitions grouped by role, with realistic integration names.
const defs = [];

// --- viewer (18): read-only dashboards / monitoring scrapers ---
[
  'Grafana Reader',
  'Datadog Sync',
  'Status Page',
  'Uptime Robot',
  'Prometheus Scraper',
  'New Relic Agent',
  'Read-only Dashboard',
  'Mobile App (read)',
  'Slack Status Bot',
  'Public Metrics',
  'BI Export',
  'QA Read Access',
  'Support Portal',
  'Audit Reader',
  'Healthcheck Probe',
  'Looker Connector',
  'Intern Read Token',
  'Demo Viewer',
].forEach((name) => defs.push({ name, role: ROLES.VIEWER }));

// --- operator (20): CI/CD pipelines & deploy automation ---
[
  'GitHub Actions Deploy',
  'GitLab CI Pipeline',
  'Jenkins Prod',
  'Jenkins Staging',
  'CircleCI Deploy',
  'ArgoCD Sync',
  'Deploy Bot Prod',
  'Deploy Bot Staging',
  'Restart Cron',
  'Release Pipeline',
  'Canary Rollout',
  'Blue-Green Switcher',
  'Hotfix Runner',
  'Nightly Build',
  'Worker Scaler',
  'Queue Restarter',
  'Backend Deployer',
  'Frontend Deployer',
  'Migration Runner',
  'Smoke Test Runner',
].forEach((name) => defs.push({ name, role: ROLES.OPERATOR }));

// --- admin (8): infra automation / server management ---
[
  'Terraform Provisioner',
  'Ansible Automation',
  'Bootstrap Script',
  'Infra Admin CLI',
  'Server Onboarding',
  'Disaster Recovery',
  'Backup Orchestrator',
  'Platform Admin Bot',
].forEach((name) => defs.push({ name, role: ROLES.ADMIN }));

const DAY = 86_400_000;
const HOUR = 3_600_000;

async function main() {
  if (defs.length !== 46) throw new Error(`expected 46 definitions, got ${defs.length}`);

  const file = path.join(config.dataDir, 'api-tokens.json');
  try {
    await fs.copyFile(file, `${file}.bak`);
    await fs.rm(file);
    console.log('[seed] existing api-tokens.json backed up to api-tokens.json.bak and cleared');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  for (const d of defs) {
    await apiTokenStore.create({ name: d.name, role: d.role, createdBy: CREATED_BY });
  }

  // Second pass: spread createdAt over the last ~5 months and vary lastUsedAt
  // (every 4th token was never used). Deterministic — no randomness.
  const now = Date.now();
  const all = JSON.parse(await fs.readFile(file, 'utf8'));
  all.forEach((tok, i) => {
    tok.createdAt = new Date(now - i * 3 * DAY - HOUR).toISOString();
    tok.lastUsedAt = i % 4 === 0 ? null : new Date(now - (i % 30) * HOUR).toISOString();
  });
  await fs.writeFile(file, JSON.stringify(all, null, 2), 'utf8');

  console.log(`[seed] created ${all.length} API tokens in ${file}`);
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
