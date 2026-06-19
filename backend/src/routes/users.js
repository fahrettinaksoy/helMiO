import { Router } from 'express';
import { userStore } from '../store/userStore.js';
import { ROLES } from '../auth/rbac.js';
import { createUserSchema, updateUserSchema } from '../schemas.js';
import { authenticate, requirePermission, audit } from '../middleware/auth.js';
import { PERMISSIONS } from '../auth/rbac.js';
import { ah } from './util.js';

export const usersRouter = Router();

// All user-management routes require an authenticated admin.
usersRouter.use(authenticate, requirePermission(PERMISSIONS.USER_MANAGE));

usersRouter.get('/', ah(async (req, res) => {
  res.json(await userStore.list());
}));

usersRouter.post('/', ah(async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Doğrulama hatası', details: parsed.error.flatten() });
  }
  try {
    const user = await userStore.create(parsed.data);
    audit(req, { action: 'user.create', target: user.username, detail: `rol: ${user.role}` });
    res.status(201).json(user);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
}));

usersRouter.put('/:id', ah(async (req, res) => {
  const target = await userStore.getById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Doğrulama hatası', details: parsed.error.flatten() });
  }
  const patch = parsed.data;

  // Guard: never let the last active admin be demoted or disabled (lockout).
  const losingAdmin =
    target.role === ROLES.ADMIN &&
    ((patch.role && patch.role !== ROLES.ADMIN) || patch.disabled === true);
  if (losingAdmin && (await userStore.adminCount()) <= 1) {
    return res.status(409).json({ error: 'Son aktif yöneticiyi devre dışı bırakamaz veya yetkisini düşüremezsiniz' });
  }

  const updated = await userStore.update(req.params.id, patch);
  const changed = Object.keys(patch).filter((k) => k !== 'password');
  if (patch.password) changed.push('password');
  audit(req, { action: 'user.update', target: updated.username, detail: changed.join(', ') });
  res.json(updated);
}));

usersRouter.delete('/:id', ah(async (req, res) => {
  const target = await userStore.getById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  if (target.id === req.user.id) {
    return res.status(409).json({ error: 'Kendi hesabınızı silemezsiniz' });
  }
  if (target.role === ROLES.ADMIN && (await userStore.adminCount()) <= 1) {
    return res.status(409).json({ error: 'Son yöneticiyi silemezsiniz' });
  }
  await userStore.remove(req.params.id);
  audit(req, { action: 'user.delete', target: target.username });
  res.status(204).end();
}));
