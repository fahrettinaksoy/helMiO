import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT) || 3001,
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 3000,
  // Background alert sweep: poll every server (even unwatched ones with no
  // eventlistener) at this slower cadence so notifications fire when nobody is
  // looking. Set to 0 to disable the background sweep.
  alertPollIntervalMs: process.env.ALERT_POLL_INTERVAL_MS != null ? Number(process.env.ALERT_POLL_INTERVAL_MS) : 30000,
  dataDir: path.resolve(__dirname, '..', process.env.DATA_DIR || './data'),
  // Auth: JWT secret (auto-generated + persisted if unset) and token lifetime.
  jwtSecret: process.env.JWT_SECRET || '',
  jwtTtl: process.env.JWT_TTL || '12h',
  // Public base URL this backend is reachable at FROM the target hosts. Baked
  // into the generated eventlistener config so the listener can POST events back.
  publicUrl: (process.env.HELMIO_PUBLIC_URL || `http://localhost:${Number(process.env.PORT) || 3001}`).replace(/\/$/, ''),
};
