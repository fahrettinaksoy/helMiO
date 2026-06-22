import { verifyToken } from '../auth/jwt.js';
import { roleHasPermission } from '../auth/rbac.js';
import { userStore } from '../store/userStore.js';
import { auditStore } from '../store/auditStore.js';
import { apiTokenStore } from '../store/apiTokenStore.js';

/**
 * Express auth middleware + helpers.
 *
 * `authenticate` verifies the Bearer token, loads the live user (so a disabled
 * or deleted account is rejected even with a still-valid token) and attaches
 * `req.user`. `requirePermission` gates a route on an RBAC permission.
 */
function bearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return req.headers['x-helmio-api-key'] || null;
}

/**
 * Accept either a user session JWT or a programmatic API token (hmo_…). API
 * tokens carry a role, so downstream requirePermission() works identically for
 * both. CI/CD clients send the token via Bearer or the X-Helmio-Api-Key header.
 */
export async function authenticate(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Kimlik doğrulama gerekli' });

  // 1) User session JWT
  const payload = verifyToken(token);
  if (payload) {
    const user = await userStore.getById(payload.sub);
    if (!user || user.disabled)
      return res.status(401).json({ error: 'Hesap bulunamadı veya devre dışı' });
    req.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.displayName,
    };
    return next();
  }

  // 2) Programmatic API token
  if (token.startsWith('hmo_')) {
    const apiTok = await apiTokenStore.verify(token);
    if (apiTok) {
      apiTokenStore.touch(apiTok.id).catch(() => {});
      req.user = {
        id: `api:${apiTok.id}`,
        username: `token:${apiTok.name}`,
        role: apiTok.role,
        isApiToken: true,
      };
      return next();
    }
  }

  return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş oturum' });
}

/** Gate a route on a permission. Logs the denial to the audit trail. */
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Kimlik doğrulama gerekli' });
    if (!roleHasPermission(req.user.role, permission)) {
      auditStore.record({
        actorId: req.user.id,
        actorName: req.user.username,
        role: req.user.role,
        action: 'access.denied',
        status: 'error',
        detail: `${req.method} ${req.originalUrl} (need ${permission})`,
        ip: clientIp(req),
      });
      return res.status(403).json({ error: 'Bu işlem için yetkiniz yok' });
    }
    next();
  };
}

/** Best-effort client IP (honours a single proxy hop). */
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

/**
 * Record an audit event from a request context. `target` and `detail` are
 * action-specific. Status defaults to 'ok'.
 */
export function audit(
  req,
  { action, serverId = null, target = null, status = 'ok', detail = null },
) {
  auditStore.record({
    actorId: req.user?.id || null,
    actorName: req.user?.username || 'anonymous',
    role: req.user?.role || null,
    action,
    serverId,
    target,
    status,
    detail,
    ip: clientIp(req),
  });
}
