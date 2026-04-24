/**
 * src/utils/mfaPending.ts — Short-lived store for the "password verified,
 * TOTP still required" state during two-phase login.
 *
 * After a correct password, the server issues a single-use opaque token
 * bound to a user ID and a 5-minute TTL. The browser sends it back on the
 * TOTP step; on success it's consumed immediately (replay protection).
 *
 * Storage is process-local — a restart drops all pending MFA challenges,
 * forcing users to redo their password. Acceptable for single-instance
 * deployment; swap for Redis if Shelob ever goes multi-replica.
 */

import { randomBytes } from "node:crypto";

interface Entry {
  userId: string;
  username: string;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const store = new Map<string, Entry>();

/** Create a pending-MFA token for the given user. Call after password verify succeeds. */
export function issue(userId: string, username: string): string {
  const token = randomBytes(32).toString("hex");
  store.set(token, { userId, username, expiresAt: Date.now() + TTL_MS });
  return token;
}

/**
 * Look up but do not consume the token. Used to get the username for audit
 * logs when the TOTP code is wrong (so we don't leak "that token's for Alice"
 * by accepting bad codes silently).
 */
export function peek(token: string | undefined | null): Entry | null {
  if (!token) return null;
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(token);
    return null;
  }
  return entry;
}

/** Consume the token (single-use) and return its payload, or null if missing/expired. */
export function consume(token: string | undefined | null): Entry | null {
  const entry = peek(token);
  if (entry) store.delete(token as string);
  return entry;
}

/** Drop any pending challenges for a given user — e.g. on password reset. */
export function revokeForUser(userId: string): void {
  for (const [token, entry] of store.entries()) {
    if (entry.userId === userId) store.delete(token);
  }
}

// Periodic cleanup so expired entries don't accumulate
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of store.entries()) {
    if (entry.expiresAt < now) store.delete(token);
  }
}, 60 * 1000).unref();
