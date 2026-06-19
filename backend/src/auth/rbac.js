/**
 * Role-based access control for the Helmio panel.
 *
 * Three roles, increasing in power:
 *   viewer   — read-only: see servers, processes, logs, metrics, config.
 *   operator — viewer + day-to-day process control (start/stop/restart/signal,
 *              stdin, clear logs, reload config). Cannot change the inventory.
 *   admin    — everything: server CRUD, config writes, daemon restart/shutdown,
 *              user management and audit access.
 *
 * Routes declare a required PERMISSION (a verb), not a role. The role→permission
 * map below is the single source of truth, so adding a permission to a role is a
 * one-line change.
 */
export const ROLES = {
  ADMIN: 'admin',
  OPERATOR: 'operator',
  VIEWER: 'viewer',
};

export const ROLE_LIST = [ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN];

export const PERMISSIONS = {
  // read
  SERVER_READ: 'server:read',
  // process control
  PROCESS_CONTROL: 'process:control', // start/stop/restart/signal/stdin/clearlog, group, bulk
  // daemon
  DAEMON_RELOAD: 'daemon:reload',
  DAEMON_RESTART: 'daemon:restart', // restart + shutdown the supervisord daemon
  // inventory + config (write)
  SERVER_MANAGE: 'server:manage', // add/edit/delete servers, install supervisor
  CONFIG_WRITE: 'config:write', // edit .conf, add program
  // panel administration
  USER_MANAGE: 'user:manage',
  AUDIT_READ: 'audit:read',
  NOTIFY_MANAGE: 'notify:manage', // configure alert notification channels
};

const VIEWER_PERMS = [PERMISSIONS.SERVER_READ];

const OPERATOR_PERMS = [
  ...VIEWER_PERMS,
  PERMISSIONS.PROCESS_CONTROL,
  PERMISSIONS.DAEMON_RELOAD,
];

const ADMIN_PERMS = [
  ...OPERATOR_PERMS,
  PERMISSIONS.DAEMON_RESTART,
  PERMISSIONS.SERVER_MANAGE,
  PERMISSIONS.CONFIG_WRITE,
  PERMISSIONS.USER_MANAGE,
  PERMISSIONS.AUDIT_READ,
  PERMISSIONS.NOTIFY_MANAGE,
];

const ROLE_PERMISSIONS = {
  [ROLES.VIEWER]: new Set(VIEWER_PERMS),
  [ROLES.OPERATOR]: new Set(OPERATOR_PERMS),
  [ROLES.ADMIN]: new Set(ADMIN_PERMS),
};

export function isValidRole(role) {
  return ROLE_LIST.includes(role);
}

/** Does a role grant a permission? */
export function roleHasPermission(role, permission) {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** Flat list of permission strings for a role (handy for the client UI). */
export function permissionsForRole(role) {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}
