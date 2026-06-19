import { z } from 'zod';
import { ROLE_LIST } from './auth/rbac.js';

// --- Auth / users ---

const usernameField = z
  .string()
  .min(3, 'Kullanıcı adı en az 3 karakter olmalı')
  .max(32, 'Kullanıcı adı en fazla 32 karakter olabilir')
  .regex(/^[A-Za-z0-9_.-]+$/, 'Sadece harf, rakam, . _ - kullanın');

const passwordField = z
  .string()
  .min(8, 'Parola en az 8 karakter olmalı')
  .max(128, 'Parola çok uzun');

// First-run admin bootstrap (no role — always admin).
export const setupSchema = z.object({
  username: usernameField,
  password: passwordField,
  displayName: z.string().max(64).optional().default(''),
});

export const loginSchema = z.object({
  username: z.string().min(1, 'Kullanıcı adı gerekli'),
  password: z.string().min(1, 'Parola gerekli'),
});

export const createUserSchema = z.object({
  username: usernameField,
  password: passwordField,
  displayName: z.string().max(64).optional().default(''),
  role: z.enum(ROLE_LIST),
});

export const updateUserSchema = z.object({
  displayName: z.string().max(64).optional(),
  role: z.enum(ROLE_LIST).optional(),
  disabled: z.boolean().optional(),
  password: passwordField.optional(),
});

// Self password change (any authenticated user).
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Mevcut parola gerekli'),
  newPassword: passwordField,
});

// --- Notification channels ---

export const CHANNEL_TYPES = ['webhook', 'slack', 'discord', 'telegram', 'email'];
export const ALERT_TYPES = ['fatal', 'flapping', 'healthcheck'];

const filtersSchema = z.object({
  serverIds: z.array(z.string()).optional().default([]),
  alertTypes: z.array(z.enum(ALERT_TYPES)).optional().default([]),
}).optional().default({ serverIds: [], alertTypes: [] });

// Per-type config. Kept permissive (z.object passthrough-ish) but validates the
// fields each transport actually needs. Masked-secret placeholders ('••••••')
// are allowed through and resolved against the stored value on update.
const masked = (s) => z.union([s, z.literal('••••••')]);

const configByType = {
  webhook: z.object({ url: masked(z.string().url('Geçerli bir URL girin')) }),
  slack: z.object({ webhookUrl: masked(z.string().url('Geçerli bir Slack webhook URL girin')) }),
  discord: z.object({ webhookUrl: masked(z.string().url('Geçerli bir Discord webhook URL girin')) }),
  telegram: z.object({
    botToken: masked(z.string().min(1, 'Bot token gerekli')),
    chatId: z.string().min(1, 'Chat ID gerekli'),
  }),
  email: z.object({
    smtpHost: z.string().min(1, 'SMTP host gerekli'),
    smtpPort: z.coerce.number().int().positive().default(587),
    secure: z.boolean().default(false),
    user: z.string().optional().default(''),
    pass: masked(z.string()).optional().default(''),
    from: z.string().min(1, 'Gönderen adresi gerekli'),
    to: z.string().min(1, 'Alıcı adresi gerekli'),
  }),
};

// --- Health checks ---

export const HEALTHCHECK_TYPES = ['http', 'tcp', 'script'];
export const HEALTHCHECK_ACTIONS = ['restart', 'alert'];

const httpCheckConfig = z.object({
  url: z.string().url('Geçerli bir URL girin'),
  expectStatus: z.coerce.number().int().min(100).max(599).optional().default(200),
  timeoutMs: z.coerce.number().int().positive().max(60000).optional().default(5000),
});
const tcpCheckConfig = z.object({
  host: z.string().min(1, 'Host gerekli').optional().default('127.0.0.1'),
  port: z.coerce.number().int().positive(),
  timeoutMs: z.coerce.number().int().positive().max(60000).optional().default(5000),
});
const scriptCheckConfig = z.object({
  command: z.string().min(1, 'Komut gerekli'),
  expectExit: z.coerce.number().int().min(0).max(255).optional().default(0),
  timeoutMs: z.coerce.number().int().positive().max(60000).optional().default(5000),
});

const CHECK_CONFIG = { http: httpCheckConfig, tcp: tcpCheckConfig, script: scriptCheckConfig };

export const healthCheckSchema = z
  .object({
    target: z.string().min(1, 'Süreç (group:name) gerekli'),
    type: z.enum(HEALTHCHECK_TYPES),
    enabled: z.boolean().optional().default(true),
    intervalSec: z.coerce.number().int().min(5).max(3600).optional().default(30),
    failureThreshold: z.coerce.number().int().min(1).max(20).optional().default(3),
    action: z.enum(HEALTHCHECK_ACTIONS).optional().default('restart'),
    config: z.record(z.any()),
  })
  .superRefine((data, ctx) => {
    const schema = CHECK_CONFIG[data.type] || httpCheckConfig;
    const res = schema.safeParse(data.config);
    if (!res.success) {
      for (const issue of res.error.issues) ctx.addIssue({ ...issue, path: ['config', ...issue.path] });
    } else {
      data.config = res.data;
    }
  });

export const channelSchema = z
  .object({
    type: z.enum(CHANNEL_TYPES),
    name: z.string().min(1, 'İsim gerekli').max(64),
    enabled: z.boolean().optional().default(true),
    config: z.record(z.any()),
    filters: filtersSchema,
  })
  .superRefine((data, ctx) => {
    const schema = configByType[data.type];
    const res = schema.safeParse(data.config);
    if (!res.success) {
      for (const issue of res.error.issues) {
        ctx.addIssue({ ...issue, path: ['config', ...issue.path] });
      }
    } else {
      data.config = res.data;
    }
  });

const tcpSchema = z.object({
  method: z.literal('tcp'),
  name: z.string().min(1, 'İsim gerekli'),
  host: z.string().min(1, 'Host gerekli'),
  port: z.coerce.number().int().positive().default(9001),
  secure: z.boolean().default(false),
  username: z.string().optional().default(''),
  password: z.string().optional().default(''),
  path: z.string().default('/RPC2'),
});

const sshSchema = z.object({
  method: z.literal('ssh'),
  name: z.string().min(1),
  sshHost: z.string().min(1, 'SSH host gerekli'),
  sshPort: z.coerce.number().int().positive().default(22),
  sshUser: z.string().min(1, 'SSH kullanıcı gerekli'),
  sshPassword: z.string().optional().default(''),
  privateKey: z.string().optional().default(''),
  // How the remote daemon is reached through the tunnel.
  target: z.enum(['socket', 'tcp']).default('socket'),
  socketPath: z.string().default('/var/run/supervisor.sock'),
  targetHost: z.string().default('127.0.0.1'),
  targetPort: z.coerce.number().int().positive().default(9001),
  // Optional supervisor HTTP auth (rare for unix socket).
  username: z.string().optional().default(''),
  password: z.string().optional().default(''),
  path: z.string().default('/RPC2'),
});

const localSchema = z.object({
  method: z.literal('local'),
  name: z.string().min(1, 'İsim gerekli'),
  socketPath: z.string().default('/var/run/supervisor.sock'),
  username: z.string().optional().default(''),
  password: z.string().optional().default(''),
  path: z.string().default('/RPC2'),
});

const dockerSchema = z.object({
  method: z.literal('docker'),
  name: z.string().min(1, 'İsim gerekli'),
  container: z.string().min(1, 'Container adı/ID gerekli'),
  connection: z.enum(['socket', 'tcp']).default('socket'),
  dockerSocket: z.string().default('/var/run/docker.sock'),
  dockerHost: z.string().default('127.0.0.1'),
  dockerPort: z.coerce.number().int().positive().default(2375),
  confPath: z.string().optional().default(''),
});

const agentSchema = z.object({
  method: z.literal('agent'),
  name: z.string().min(1),
  agentUrl: z.string().url(),
  agentToken: z.string().optional().default(''),
});

export const serverSchema = z.discriminatedUnion('method', [
  tcpSchema,
  localSchema,
  sshSchema,
  dockerSchema,
  agentSchema,
]);

// Updates: same shape, but every field optional (method still required to pick variant).
export const serverUpdateSchema = serverSchema;
