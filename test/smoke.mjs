// Panel-level smoke test for the auth/security/automation features.
// Boots the backend in-process against a throwaway DATA_DIR and exercises the
// HTTP API end to end. No supervisord needed — supervisord-dependent flows
// (snapshot, fleet actions, log read, auto-restart) are covered separately.
//
// Usage: node test/smoke.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3970;
const B = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helmio-smoke-'));
process.env.DATA_DIR = DATA_DIR;
process.env.PORT = String(PORT);
process.env.CORS_ORIGIN = '*';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}
const J = (r) => r.json();
const auth = (tok) => ({ authorization: `Bearer ${tok}`, 'content-type': 'application/json' });

// local receiver for webhook channel + http health check
let lastWebhook = null;
let healthy = true;
const recv = http.createServer((req, res) => {
  if (req.url.startsWith('/health')) { res.writeHead(healthy ? 200 : 500); return res.end(); }
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { lastWebhook = JSON.parse(b || '{}'); res.end('ok'); });
});

async function main() {
  await new Promise((r) => recv.listen(4700, r));
  await import('../backend/src/index.js');
  await new Promise((r) => setTimeout(r, 500));

  console.log('\n== auth + rbac ==');
  const setup = await fetch(`${B}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'supersecret1' }) }).then(J);
  ok('setup returns admin token', setup.token && setup.user.role === 'admin');
  const A = auth(setup.token);

  // rate limit: 5 bad attempts then 429
  let rl = 200;
  for (let i = 0; i < 6; i += 1) {
    const r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
    rl = r.status;
  }
  ok('login rate-limited after repeated failures (429)', rl === 429, `got ${rl}`);

  const vu = await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'viewer1', password: 'viewerpass1', role: 'viewer' }) });
  ok('admin creates viewer', vu.status === 201);
  const vtok = (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'viewer1', password: 'viewerpass1' }) }).then(J)).token;
  const vcreate = await fetch(`${B}/api/servers`, { method: 'POST', headers: auth(vtok), body: JSON.stringify({ method: 'tcp', name: 'x', host: '127.0.0.1', port: 9001 }) });
  ok('viewer cannot create server (403)', vcreate.status === 403, `got ${vcreate.status}`);

  console.log('\n== secret encryption at rest ==');
  const srv = await fetch(`${B}/api/servers`, { method: 'POST', headers: A, body: JSON.stringify({ method: 'tcp', name: 'enc-test', host: '127.0.0.1', port: 9001, username: 'u', password: 'TOPSECRET' }) }).then(J);
  const onDisk = fs.readFileSync(path.join(DATA_DIR, 'servers.json'), 'utf8');
  ok('server password encrypted on disk (enc: prefix)', onDisk.includes('enc:1:'), 'no enc prefix');
  ok('plaintext password NOT on disk', !onDisk.includes('TOPSECRET'), 'leaked!');
  const fetched = await fetch(`${B}/api/servers/${srv.id}`, { headers: A }).then(J);
  ok('password masked in API response', fetched.password === '••••••');

  console.log('\n== api tokens ==');
  const tk = await fetch(`${B}/api/apitokens`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'ci', role: 'operator' }) }).then(J);
  ok('token created (hmo_ plaintext once)', tk.token.startsWith('hmo_') && tk.record.prefix.startsWith('hmo_'));
  const tlist = await fetch(`${B}/api/apitokens`, { headers: A }).then(J);
  ok('token hash not exposed in list', !('tokenHash' in (tlist[0] || {})));
  const viaKey = await fetch(`${B}/api/servers`, { headers: { 'x-helmio-api-key': tk.token } });
  ok('X-Helmio-Api-Key authenticates', viaKey.status === 200);
  const tokenCreate = await fetch(`${B}/api/servers`, { method: 'POST', headers: auth(tk.token), body: JSON.stringify({ method: 'tcp', name: 'y', host: '127.0.0.1', port: 9001 }) });
  ok('operator token cannot create server (403)', tokenCreate.status === 403, `got ${tokenCreate.status}`);

  console.log('\n== notification channel ==');
  const ch = await fetch(`${B}/api/channels`, { method: 'POST', headers: A, body: JSON.stringify({ type: 'webhook', name: 'hook', config: { url: 'http://127.0.0.1:4700/hook' }, filters: { serverIds: [], alertTypes: [] } }) }).then(J);
  ok('channel secret masked in response', ch.config.url === '••••••');
  const chDisk = fs.readFileSync(path.join(DATA_DIR, 'channels.json'), 'utf8');
  ok('channel webhook url encrypted on disk', chDisk.includes('enc:1:'));
  await fetch(`${B}/api/channels/${ch.id}/test`, { method: 'POST', headers: A });
  await new Promise((r) => setTimeout(r, 300));
  ok('channel test delivered to webhook', !!lastWebhook && /test/.test(lastWebhook.text || lastWebhook.message || ''));

  console.log('\n== event ingest + alert routing ==');
  const tok2 = (await fetch(`${B}/api/servers/${srv.id}/eventlistener/rotate-token`, { method: 'POST', headers: A }).then(J)).token;
  lastWebhook = null;
  await fetch(`${B}/api/ingest/${srv.id}/events`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok2}` }, body: JSON.stringify({ eventname: 'PROCESS_STATE_FATAL', payload: { processname: 'w', groupname: 'w' } }) });
  const feed = await fetch(`${B}/api/servers/${srv.id}/events`, { headers: A }).then(J);
  ok('event buffered in feed', feed.events.length === 1 && feed.events[0].state === 'FATAL');
  await new Promise((r) => setTimeout(r, 300));
  ok('FATAL alert routed to channel', !!lastWebhook && lastWebhook.type === 'fatal');

  console.log('\n== config program builder + parse ==');
  const def = { name: 'demo', command: 'node app.js', numprocs: 3, autorestart: 'true', environment: [{ key: 'A', value: '1' }] };
  const prev = await fetch(`${B}/api/servers/${srv.id}/config/program/preview`, { method: 'POST', headers: A, body: JSON.stringify(def) }).then(J);
  ok('preview emits process_name for numprocs>1', prev.block.includes('process_name='));
  ok('preview emits environment', prev.block.includes('environment=A="1"'));

  console.log('\n== health checks ==');
  const hc = await fetch(`${B}/api/servers/${srv.id}/healthchecks`, { method: 'POST', headers: A, body: JSON.stringify({ target: 'w:w', type: 'http', intervalSec: 5, failureThreshold: 2, action: 'alert', config: { url: 'http://127.0.0.1:4700/health', expectStatus: 200, timeoutMs: 1000 } }) }).then(J);
  ok('health check created', !!hc.id);
  healthy = true;
  const run1 = await fetch(`${B}/api/servers/${srv.id}/healthchecks/${hc.id}/run`, { method: 'POST', headers: A }).then(J);
  ok('http probe ok when healthy', run1.ok === true);
  healthy = false;
  const run2 = await fetch(`${B}/api/servers/${srv.id}/healthchecks/${hc.id}/run`, { method: 'POST', headers: A }).then(J);
  ok('http probe fails when unhealthy', run2.ok === false);

  console.log('\n== fleet validation ==');
  const fbad = await fetch(`${B}/api/fleet/run`, { method: 'POST', headers: A, body: JSON.stringify({ action: 'restartAll', serverIds: [] }) });
  ok('fleet rejects empty serverIds (400)', fbad.status === 400, `got ${fbad.status}`);

  console.log('\n== metrics endpoint ==');
  const m = await fetch(`${B}/api/servers/${srv.id}/metrics?range=60`, { headers: A }).then(J);
  ok('metrics endpoint returns samples array', Array.isArray(m.samples));

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('SMOKE CRASH', e); process.exit(1); });
