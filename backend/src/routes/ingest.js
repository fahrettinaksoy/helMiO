import { Router } from 'express';
import { serverStore } from '../store/serverStore.js';
import { eventStore } from '../store/eventStore.js';
import { eventBus } from '../events/eventBus.js';
import { ah } from './util.js';

/**
 * Machine-to-machine event ingest. The supervisord-side eventlistener POSTs here
 * with the per-server ingest token (NOT a user JWT). Each event is buffered,
 * any derived alert is computed, and both are published on the event bus for the
 * realtime layer to broadcast.
 *
 *   POST /api/ingest/:serverId/events
 *   Authorization: Bearer <ingestToken>
 *   body: a single event object, or { events: [...] }
 */
export const ingestRouter = Router();

function bearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return req.headers['x-helmio-token'] || null;
}

ingestRouter.post(
  '/:serverId/events',
  ah(async (req, res) => {
    const server = await serverStore.get(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'unknown server' });
    if (!server.ingestToken || bearer(req) !== server.ingestToken) {
      return res.status(401).json({ error: 'invalid ingest token' });
    }

    const body = req.body || {};
    const events = Array.isArray(body.events) ? body.events : [body];
    let accepted = 0;
    for (const ev of events) {
      if (!ev || typeof ev !== 'object' || !ev.eventname) continue;
      const { record, alert } = eventStore.add(server.id, ev);
      eventBus.emit('event', { serverId: server.id, event: record });
      if (alert) eventBus.emit('alert', { serverId: server.id, alert });
      accepted += 1;
    }
    res.json({ ok: true, accepted });
  }),
);
