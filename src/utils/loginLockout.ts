/**
 * src/utils/loginLockout.ts — Per-username login failure counter & lockout
 *
 * Complements the per-IP rate limiter on /auth/login. The IP limiter stops
 * concentrated attacks from a single source; this module caps the total
 * number of failed attempts against a single account name (across all IPs),
 * which matters because distributed botnets trivially bypass IP throttling.
 *
 * Storage is process-local — a restart clears all lockouts. That is fine for
 * a single-instance deployment. If Polaris ever runs multi-replica, swap the
 * Map for a Redis-backed implementation with the same interface.
 */

interface Entry {
  failures: number;
  lockedUntil: number;   // epoch ms; 0 = not locked
  firstFailureAt: number;
}

const MAX_FAILURES = 5;
const LOCKOUT_MS   = 15 * 60 * 1000; // 15 min lockout once threshold is hit
const WINDOW_MS    = 15 * 60 * 1000; // failures older than this reset the counter

const store = new Map<string, Entry>();

function key(username: string): string {
  return username.trim().toLowerCase();
}

export function isLocked(username: string): { locked: boolean; until?: Date } {
  const entry = store.get(key(username));
  if (!entry) return { locked: false };
  if (entry.lockedUntil > Date.now()) {
    return { locked: true, until: new Date(entry.lockedUntil) };
  }
  return { locked: false };
}

/**
 * Record a failed login attempt. Returns whether this attempt tipped the
 * account into the locked state, plus the new unlock time.
 */
export function recordFailure(username: string): { lockedNow: boolean; failures: number; until?: Date } {
  const k = key(username);
  const now = Date.now();
  let entry = store.get(k);

  // Fresh window if this is the first failure or the last one is stale
  if (!entry || now - entry.firstFailureAt > WINDOW_MS) {
    entry = { failures: 0, lockedUntil: 0, firstFailureAt: now };
  }

  entry.failures += 1;

  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS;
    store.set(k, entry);
    return { lockedNow: true, failures: entry.failures, until: new Date(entry.lockedUntil) };
  }

  store.set(k, entry);
  return { lockedNow: false, failures: entry.failures };
}

/** Clear the counter + any active lockout. Call on successful login and on admin password reset. */
export function clearLockout(username: string): void {
  store.delete(key(username));
}

// Periodic cleanup keeps memory bounded in pathological scenarios (attacker
// cycling through thousands of usernames). Runs every 10 min, drops entries
// whose lockout has expired and whose failure window is also stale.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (v.lockedUntil <= now && now - v.firstFailureAt > WINDOW_MS) {
      store.delete(k);
    }
  }
}, 10 * 60 * 1000).unref();
