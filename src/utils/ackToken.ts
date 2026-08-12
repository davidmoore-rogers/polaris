/**
 * src/utils/ackToken.ts — one-click alert-acknowledge link tokens.
 *
 * A deliberate divergence from src/utils/bearerToken.ts + argon2id, which is
 * the house pattern for ApiToken and the agent tokens. Those hash secrets an
 * operator can see, paste and re-use, where a slow KDF buys real protection
 * against a leaked hash. This token is 24 bytes we generate, embed once in one
 * message, and consume — 192 bits of entropy with no dictionary behind it, so
 * the KDF work factor defends nothing. What it WOULD cost is real: minting
 * happens on the alert fan-out path, so a rule notifying a 40-person role
 * would spend ~2s of blocked CPU per alert hashing links, inside the process
 * that also serves HTTP.
 *
 * Storing a plain digest also means redemption is one findUnique on a unique
 * index rather than the prefix-indexed candidate walk argon2 forces — which is
 * why NotificationAckToken has no prefix column.
 *
 * Pure: no DB, no env. The service that owns the rows is
 * services/notificationAckService.ts.
 */

import { createHash, randomBytes } from "node:crypto";

/** Distinguishes an ack token from a bearer token at a glance in logs/support. */
export const ACK_TOKEN_PREFIX = "polaris_ack_";
export const ACK_TOKEN_RANDOM_BYTES = 24; // 192 bits → 32 base64url chars
/**
 * Tokens are minted fresh per delivery row (a hash cannot be re-read to reuse
 * an old one), so this TTL only has to outlive a single message's usefulness —
 * not a whole 5-tier × 7-day escalation chain, whose later tiers carry their
 * own tokens.
 */
export const ACK_TOKEN_TTL_DAYS = 30;

const TAIL_LEN = 32;
const TAIL_RE = new RegExp(`^[A-Za-z0-9_-]{${TAIL_LEN}}$`);

/** `polaris_ack_<32 base64url chars>`. */
export function generateAckToken(): string {
  const tail = randomBytes(ACK_TOKEN_RANDOM_BYTES)
    .toString("base64url")
    .slice(0, TAIL_LEN);
  return `${ACK_TOKEN_PREFIX}${tail}`;
}

/** base64url(sha256(raw)) — the stored form. Deterministic. */
export function hashAckToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("base64url");
}

/**
 * Shape check only — lets the public /ack route reject junk (and every mail
 * scanner's mangled URL) before it costs a database round trip. Never a
 * substitute for the lookup: a well-formed token is not a valid one.
 */
export function isWellFormedAckToken(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw.startsWith(ACK_TOKEN_PREFIX)) return false;
  return TAIL_RE.test(raw.slice(ACK_TOKEN_PREFIX.length));
}

export function ackTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + ACK_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
