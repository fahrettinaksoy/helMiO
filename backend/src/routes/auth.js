import { Router } from 'express';
import { userStore } from '../store/userStore.js';
import { ROLES, permissionsForRole } from '../auth/rbac.js';
import { signToken } from '../auth/jwt.js';
import { setupSchema, loginSchema, changePasswordSchema } from '../schemas.js';
import { authenticate, audit, clientIp } from '../middleware/auth.js';
import { auditStore } from '../store/auditStore.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { ah } from './util.js';

export const authRouter = Router();

/** Decorate a public user with its effective permission list for the client. */
function withPermissions(user) {
  return { ...user, permissions: permissionsForRole(user.role) };
}

// Public: does the panel still need its first admin?
authRouter.get('/status', ah(async (req, res) => {
  res.json({ needsSetup: await userStore.needsSetup() });
}));

// One-time bootstrap: create the first admin. Only works while no users exist.
authRouter.post('/setup', ah(async (req, res) => {
  if (!(await userStore.needsSetup())) {
    return res.status(409).json({ error: 'Kurulum zaten tamamlanmış' });
  }
  const parsed = setupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Doğrulama hatası', details: parsed.error.flatten() });
  }
  const user = await userStore.create({ ...parsed.data, role: ROLES.ADMIN });
  auditStore.record({
    actorId: user.id, actorName: user.username, role: user.role,
    action: 'auth.setup', target: user.username, ip: clientIp(req),
  });
  const token = signToken(user);
  res.status(201).json({ token, user: withPermissions(user) });
}));

// Login: issue a JWT for valid credentials.
authRouter.post('/login', ah(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Kullanıcı adı ve parola gerekli' });
  }
  const { username, password } = parsed.data;
  const ip = clientIp(req);
  const limitKey = `${ip}:${username.toLowerCase()}`;

  // Brute-force guard: block after too many recent failures.
  const limit = loginLimiter.check(limitKey);
  if (limit.blocked) {
    auditStore.record({ actorName: username, action: 'auth.login', status: 'error', detail: 'rate-limited', ip });
    res.set('Retry-After', String(limit.retryAfterSec));
    return res.status(429).json({ error: `Çok fazla deneme. ${limit.retryAfterSec} sn sonra tekrar deneyin.` });
  }

  const user = await userStore.getByUsername(username);
  const ok = user && !user.disabled && (await userStore.verifyPassword(user, password));
  if (!ok) {
    loginLimiter.fail(limitKey);
    auditStore.record({
      actorName: username, action: 'auth.login', status: 'error',
      detail: 'geçersiz kimlik bilgisi', ip,
    });
    return res.status(401).json({ error: 'Kullanıcı adı veya parola hatalı' });
  }
  loginLimiter.succeed(limitKey);
  await userStore.touchLogin(user.id);
  auditStore.record({
    actorId: user.id, actorName: user.username, role: user.role,
    action: 'auth.login', ip: clientIp(req),
  });
  const pub = { id: user.id, username: user.username, displayName: user.displayName, role: user.role };
  res.json({ token: signToken(pub), user: withPermissions(pub) });
}));

// Current session identity + permissions.
authRouter.get('/me', authenticate, ah(async (req, res) => {
  const user = await userStore.getById(req.user.id);
  if (!user) return res.status(401).json({ error: 'Hesap bulunamadı' });
  res.json({
    user: withPermissions({
      id: user.id, username: user.username, displayName: user.displayName, role: user.role,
      lastLoginAt: user.lastLoginAt,
    }),
  });
}));

// Change own password.
authRouter.post('/change-password', authenticate, ah(async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Doğrulama hatası', details: parsed.error.flatten() });
  }
  const user = await userStore.getById(req.user.id);
  const ok = user && (await userStore.verifyPassword(user, parsed.data.currentPassword));
  if (!ok) {
    audit(req, { action: 'auth.change_password', status: 'error', detail: 'mevcut parola hatalı' });
    return res.status(400).json({ error: 'Mevcut parola hatalı' });
  }
  await userStore.update(user.id, { password: parsed.data.newPassword });
  audit(req, { action: 'auth.change_password', target: user.username });
  res.json({ ok: true });
}));

// Logout is stateless for JWT; record it for the trail.
authRouter.post('/logout', authenticate, ah(async (req, res) => {
  audit(req, { action: 'auth.logout' });
  res.json({ ok: true });
}));
