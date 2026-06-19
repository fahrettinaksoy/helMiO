import { Router } from 'express';
import { auditStore } from '../store/auditStore.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../auth/rbac.js';
import { ah } from './util.js';

export const auditRouter = Router();

auditRouter.use(authenticate, requirePermission(PERMISSIONS.AUDIT_READ));

// Query the audit trail (newest first) with optional filters + pagination.
auditRouter.get('/', ah(async (req, res) => {
  const { serverId, actorId, action, status, limit, offset } = req.query;
  res.json(await auditStore.query({ serverId, actorId, action, status, limit, offset }));
}));
