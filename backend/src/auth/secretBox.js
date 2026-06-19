import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Symmetric secret encryption for data at rest (server connection secrets,
 * ingest tokens, channel credentials). AES-256-GCM with a 32-byte key.
 *
 * Key resolution: HELMIO_SECRET_KEY env (hex/base64/passphrase — any string is
 * accepted and folded to 32 bytes via SHA-256). If unset, a random key is
 * generated once and persisted to DATA_DIR/.secret-key, like the JWT secret.
 * In production, set HELMIO_SECRET_KEY so secrets stay readable across hosts.
 *
 * Encrypted values are tagged `enc:1:<base64(iv|tag|ciphertext)>`. Values
 * without that prefix are treated as legacy plaintext and returned as-is, so
 * existing stores migrate transparently (re-encrypted on next write).
 */
const PREFIX = 'enc:1:';
const IV_LEN = 12;

function resolveKey() {
  const raw = process.env.HELMIO_SECRET_KEY;
  if (raw) return crypto.createHash('sha256').update(raw).digest(); // 32 bytes
  const keyFile = path.join(config.dataDir, '.secret-key');
  try {
    return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  } catch {
    const key = crypto.randomBytes(32);
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
    } catch (err) {
      console.error('[helmio] could not persist secret key:', err.message);
    }
    return key;
  }
}

const KEY = resolveKey();

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Encrypt a string. No-op on empty/encrypted/non-string input. */
export function encrypt(value) {
  if (value == null || value === '' || typeof value !== 'string') return value;
  if (isEncrypted(value)) return value;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypt a value produced by encrypt(); returns legacy plaintext unchanged. */
export function decrypt(value) {
  if (!isEncrypted(value)) return value;
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + 16);
    const ct = buf.subarray(IV_LEN + 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('[helmio] secret decrypt failed (wrong key?):', err.message);
    return '';
  }
}

/** Encrypt the named fields of an object in place-ish (returns a new object). */
export function encryptFields(obj, fields) {
  const out = { ...obj };
  for (const f of fields) if (out[f]) out[f] = encrypt(out[f]);
  return out;
}

/** Decrypt the named fields of an object (returns a new object). */
export function decryptFields(obj, fields) {
  const out = { ...obj };
  for (const f of fields) if (out[f]) out[f] = decrypt(out[f]);
  return out;
}
