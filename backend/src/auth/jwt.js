import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * JWT signing/verification for panel sessions.
 *
 * The secret comes from JWT_SECRET when set. Otherwise we generate a random one
 * once and persist it under DATA_DIR so tokens survive restarts in dev without
 * forcing the operator to set an env var. In production, set JWT_SECRET.
 */
const TOKEN_TTL = config.jwtTtl || '12h';

function resolveSecret() {
  if (config.jwtSecret) return config.jwtSecret;
  const secretFile = path.join(config.dataDir, '.jwt-secret');
  try {
    return fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    const generated = crypto.randomBytes(48).toString('hex');
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    } catch (err) {
      console.error('[helmio] could not persist JWT secret:', err.message);
    }
    return generated;
  }
}

const SECRET = resolveSecret();

/** Sign a session token for a user. */
export function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

/** Verify a token; returns the decoded payload or null. */
export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}
