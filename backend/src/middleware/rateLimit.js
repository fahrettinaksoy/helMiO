/**
 * Minimal in-memory fixed-window rate limiter for sensitive endpoints (login).
 * Keyed by client IP + username so one attacker can't lock out everyone, and
 * one account can't be hammered from many IPs unnoticed.
 *
 * Not distributed — fine for a single-process panel. For multi-instance setups
 * put a reverse-proxy / WAF rate limit in front.
 */
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILURES = 5;

const buckets = new Map(); // key -> { count, resetAt }

function prune(now) {
  if (buckets.size < 500) return;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

export const loginLimiter = {
  /** @returns {{ blocked: boolean, retryAfterSec?: number }} */
  check(key) {
    const now = Date.now();
    const b = buckets.get(key);
    if (b && b.resetAt > now && b.count >= MAX_FAILURES) {
      return { blocked: true, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
    }
    return { blocked: false };
  },

  /** Record a failed attempt; starts/extends the window. */
  fail(key) {
    const now = Date.now();
    prune(now);
    const b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      b.count += 1;
    }
  },

  /** Clear the bucket on a successful login. */
  succeed(key) {
    buckets.delete(key);
  },
};
