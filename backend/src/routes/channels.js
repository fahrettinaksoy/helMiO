import { Router } from 'express';
import { channelStore } from '../store/channelStore.js';
import { channelSchema, CHANNEL_TYPES, ALERT_TYPES } from '../schemas.js';
import { authenticate, requirePermission, audit } from '../middleware/auth.js';
import { PERMISSIONS } from '../auth/rbac.js';
import { sendTest } from '../services/notifierService.js';
import { ah } from './util.js';

export const channelsRouter = Router();

// All channel routes require an authenticated admin (notify:manage).
channelsRouter.use(authenticate, requirePermission(PERMISSIONS.NOTIFY_MANAGE));

// Metadata for the form (available types + alert types).
channelsRouter.get('/meta', (req, res) => {
  res.json({ types: CHANNEL_TYPES, alertTypes: ALERT_TYPES });
});

channelsRouter.get(
  '/',
  ah(async (req, res) => {
    res.json(await channelStore.listPublic());
  }),
);

channelsRouter.post(
  '/',
  ah(async (req, res) => {
    const parsed = channelSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Doğrulama hatası', details: parsed.error.flatten() });
    }
    const channel = await channelStore.create(parsed.data);
    audit(req, { action: 'channel.create', target: channel.name, detail: channel.type });
    res.status(201).json(channel);
  }),
);

channelsRouter.put(
  '/:id',
  ah(async (req, res) => {
    const existing = await channelStore.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Kanal bulunamadı' });
    const parsed = channelSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Doğrulama hatası', details: parsed.error.flatten() });
    }
    const channel = await channelStore.update(req.params.id, parsed.data);
    audit(req, { action: 'channel.update', target: channel.name, detail: channel.type });
    res.json(channel);
  }),
);

channelsRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const existing = await channelStore.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Kanal bulunamadı' });
    await channelStore.remove(req.params.id);
    audit(req, { action: 'channel.delete', target: existing.name });
    res.status(204).end();
  }),
);

// Send a test notification. Uses the SAVED channel (with real secrets) when an
// id is given; otherwise validates and tests an ad-hoc definition from the body.
channelsRouter.post(
  '/:id/test',
  ah(async (req, res) => {
    const channel = await channelStore.get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Kanal bulunamadı' });
    try {
      await sendTest(channel);
      audit(req, { action: 'channel.test', target: channel.name, detail: channel.type });
      res.json({ ok: true });
    } catch (err) {
      audit(req, {
        action: 'channel.test',
        target: channel.name,
        status: 'error',
        detail: err.message,
      });
      res.status(502).json({ ok: false, error: err.message });
    }
  }),
);
