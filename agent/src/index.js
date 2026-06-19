#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import xmlrpc from 'xmlrpc';

/**
 * Helmio Agent
 * ------------
 * A tiny service that runs ON the target host, next to supervisord. It exposes a
 * token-protected HTTP/JSON API that the Helmio panel calls, and proxies each
 * request to the LOCAL supervisord via XML-RPC (unix socket or localhost TCP).
 *
 * Endpoints:
 *   GET  /health            -> { ok, version }            (no auth)
 *   POST /rpc { method, params }  -> { result } | { error }  (Bearer auth)
 */
const PORT = Number(process.env.AGENT_PORT) || 8787;
const HOST = process.env.AGENT_HOST || '0.0.0.0';
const TOKEN = process.env.AGENT_TOKEN || '';
const SUPERVISOR_SOCKET = process.env.SUPERVISOR_SOCKET || '';
const SUPERVISOR_HOST = process.env.SUPERVISOR_HOST || '127.0.0.1';
const SUPERVISOR_PORT = Number(process.env.SUPERVISOR_PORT) || 9001;
const SUPERVISOR_PATH = process.env.SUPERVISOR_PATH || '/RPC2';

if (!TOKEN || TOKEN === 'change-me') {
  console.error('[helmio-agent] AGENT_TOKEN ayarlı değil. Güvenlik için bir token belirleyin.');
  process.exit(1);
}

// Build an xmlrpc client to the local supervisord.
const clientOptions = { path: SUPERVISOR_PATH };
if (SUPERVISOR_SOCKET) {
  clientOptions.socketPath = SUPERVISOR_SOCKET; // honored by node http
  clientOptions.host = 'localhost';
} else {
  clientOptions.host = SUPERVISOR_HOST;
  clientOptions.port = SUPERVISOR_PORT;
}
if (process.env.SUPERVISOR_USER) {
  clientOptions.basic_auth = { user: process.env.SUPERVISOR_USER, pass: process.env.SUPERVISOR_PASS || '' };
}
const supervisor = xmlrpc.createClient(clientOptions);

function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    supervisor.methodCall(method, params, (err, value) => {
      if (err) {
        if (err.faultString) return reject(new Error(err.faultString));
        return reject(err instanceof Error ? err : new Error(String(err)));
      }
      resolve(value);
    });
  });
}

const app = express();
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    const version = await rpc('supervisor.getSupervisorVersion');
    res.json({ ok: true, version, name: 'helmio-agent' });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Bearer auth for everything below.
app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== TOKEN) return res.status(401).json({ error: 'Yetkisiz' });
  next();
});

app.post('/rpc', async (req, res) => {
  const { method, params = [] } = req.body || {};
  if (typeof method !== 'string' || !method.startsWith('supervisor.') && !method.startsWith('system.')) {
    return res.status(400).json({ error: 'Geçersiz veya izinsiz method' });
  }
  try {
    const result = await rpc(method, Array.isArray(params) ? params : []);
    res.json({ result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  const target = SUPERVISOR_SOCKET ? SUPERVISOR_SOCKET : `${SUPERVISOR_HOST}:${SUPERVISOR_PORT}`;
  console.log(`[helmio-agent] listening on http://${HOST}:${PORT} -> supervisord @ ${target}`);
});
