import { Router } from 'express';
import { z } from 'zod';
import { apiTokenStore } from '../store/apiTokenStore.js';
import { ROLE_LIST } from '../auth/rbac.js';
import { authenticate, requirePermission, audit } from '../middleware/auth.js';
import { PERMISSIONS } from '../auth/rbac.js';
import { ah } from './util.js';

export const apiTokensRouter = Router();

// Managing API tokens is an admin concern (same permission as user management).
apiTokensRouter.use(authenticate, requirePermission(PERMISSIONS.USER_MANAGE));

const createSchema = z.object({
  name: z.string().min(1, 'İsim gerekli').max(64),
  role: z.enum(ROLE_LIST),
});

apiTokensRouter.get(
  '/',
  ah(async (req, res) => {
    res.json(await apiTokenStore.list());
  }),
);

apiTokensRouter.post(
  '/',
  ah(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Doğrulama hatası', details: parsed.error.flatten() });
    }
    const { token, record } = await apiTokenStore.create({
      ...parsed.data,
      createdBy: req.user.username,
    });
    audit(req, { action: 'apitoken.create', target: record.name, detail: `rol: ${record.role}` });
    // Plaintext token returned ONCE — the client must store it now.
    res.status(201).json({ token, record });
  }),
);

apiTokensRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const existing = await apiTokenStore.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Token bulunamadı' });
    await apiTokenStore.remove(req.params.id);
    audit(req, { action: 'apitoken.delete', target: existing.name });
    res.status(204).end();
  }),
);
