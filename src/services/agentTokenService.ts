/**
 * src/services/agentTokenService.ts — Polaris Agent token mint / verify
 *
 * Peer of `apiTokenService.ts` but bound to a single asset and never
 * carries scopes other than `agents:report`. Lives in its own store
 * (`ManagedAgent` table) for three reasons:
 *
 *  1. ApiToken has `name UNIQUE`, `createdBy`, and `integrationIds[]` —
 *     none of which fit agent tokens (the "creator" is an install job,
 *     no name surface, integration filtering irrelevant).
 *  2. ApiToken expects operator-visible lifecycle (UI list / revoke).
 *     Agent token lifecycle is mint-at-install / revoke-with-ManagedAgent.
 *  3. Conflating would force `apiTokenService.verifyToken` to scan a
 *     possibly-large agent token population on every UI API call. Keeping
 *     `ManagedAgent.bearerHash`/`bearerPrefix` separate keeps both scans
 *     small.
 *
 * Two tokens per agent:
 *  - **Enrollment token** — one-shot, 10-min TTL. Generated at install
 *    kickoff, baked into the host's `agent.conf`. Consumed by the agent's
 *    first `POST /api/v1/agents/enroll`, which atomically swaps it for…
 *  - **Bearer token** — long-lived. Used for every subsequent /samples /
 *    /config / /heartbeat call and for the outbound WebSocket handshake.
 *    Revoked by operator-initiated DELETE /assets/:id/agent.
 *
 * Wire format for both: `polaris_<32-char-base64url-tail>`. Both stored as
 * argon2id hashes + a short prefix for indexed lookup, matching ApiToken.
 *
 * Bearer is bound to a single `assetId` at issuance (`ManagedAgent.assetId`
 * is `@unique`). `verifyBearer` returns the ManagedAgent + Asset together;
 * the /samples handler stamps the bearer's assetId server-side, ignoring
 * any client-supplied value — defense against stolen-bearer cross-asset reuse.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { hashPassword, verifyPassword } from "../utils/password.js";

const TOKEN_PREFIX = "polaris_";
const TOKEN_PREFIX_LEN = TOKEN_PREFIX.length + 8; // "polaris_xxxxxxxx" — indexed lookup key
const TOKEN_RANDOM_BYTES = 24; // → 32 base64url chars
const ENROLLMENT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function generateRawToken(): string {
  const tail = randomBytes(TOKEN_RANDOM_BYTES)
    .toString("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 32);
  return `${TOKEN_PREFIX}${tail}`;
}

/**
 * Generate a one-shot enrollment token for a ManagedAgent row. Stores the
 * argon2id hash + indexed prefix; returns the raw token. The raw token is
 * baked into the host's agent.conf at install time and is shown to no human.
 *
 * Idempotency: calling this on a row that already has an unconsumed
 * enrollment token overwrites it. That's intentional — the operator
 * clicking "Reinstall" or retrying a failed install should always get a
 * fresh token, never an expired one.
 */
export async function mintEnrollmentToken(managedAgentId: string): Promise<string> {
  const raw = generateRawToken();
  const enrollmentTokenHash = await hashPassword(raw);
  const enrollmentTokenPrefix = raw.slice(0, TOKEN_PREFIX_LEN);
  const enrollmentExpiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);

  await prisma.managedAgent.update({
    where: { id: managedAgentId },
    data: { enrollmentTokenHash, enrollmentTokenPrefix, enrollmentExpiresAt },
  });
  return raw;
}

export interface ConsumedEnrollment {
  managedAgent: {
    id: string;
    assetId: string;
    osPlatform: string;
    arch: string;
    serverCertFingerprint: string;
    /**
     * Phase 2 dual-pin staged additional pins. Empty in steady state; populated
     * when an operator stages a new pin for zero-downtime cert rotation. The
     * enroll cross-check accepts EITHER the canonical fingerprint OR any
     * fingerprint in this array.
     */
    additionalServerCertFingerprints: string[];
  };
}

/**
 * Atomically swap an enrollment token for a long-lived bearer.
 *
 * Walks the candidate set (prefix-indexed, not yet consumed, not expired),
 * verifies argon2 against each, and on first match: nulls the enrollment
 * fields, writes the new bearer hash/prefix/issuedAt, transitions
 * installStatus → "active", all in one transaction. Returns the
 * ManagedAgent row data the caller needs to build the /enroll response.
 *
 * Throws AppError(401) on no match — the agent retries with backoff and
 * the operator can re-mint by clicking Reinstall.
 */
export async function consumeEnrollmentToken(
  rawEnrollmentToken: string,
): Promise<{ managedAgent: ConsumedEnrollment["managedAgent"]; bearer: string }> {
  if (!rawEnrollmentToken || !rawEnrollmentToken.startsWith(TOKEN_PREFIX)) {
    throw new AppError(401, "Invalid enrollment token");
  }
  const prefix = rawEnrollmentToken.slice(0, TOKEN_PREFIX_LEN);

  const candidates = await prisma.managedAgent.findMany({
    where: {
      enrollmentTokenPrefix: prefix,
      enrollmentTokenHash: { not: null },
      enrollmentExpiresAt: { gt: new Date() },
    },
  });

  for (const row of candidates) {
    if (!row.enrollmentTokenHash) continue;
    const { valid } = await verifyPassword(rawEnrollmentToken, row.enrollmentTokenHash);
    if (!valid) continue;

    const bearer = generateRawToken();
    const bearerHash = await hashPassword(bearer);
    const bearerPrefix = bearer.slice(0, TOKEN_PREFIX_LEN);

    // Single transaction: clear enrollment fields + write bearer + flip
    // ManagedAgent to active + stamp the asset's four *Polling fields to
    // "agent" so the periodic puller no-ops cleanly. The polling stamp
    // is what tells the resolver "this asset's monitoring is fully owned
    // by the on-host agent; don't try to poll it from here." Source
    // defaults (ICMP for AD/Entra etc.) would otherwise still fire.
    // The argon2 hashes are unique so even if two enrollment POSTs raced
    // for the same row (operator double-click on Reinstall), only one
    // would verify; the second loses on the verifyPassword check.
    await prisma.$transaction([
      prisma.managedAgent.update({
        where: { id: row.id },
        data: {
          enrollmentTokenHash: null,
          enrollmentTokenPrefix: null,
          enrollmentExpiresAt: null,
          bearerHash,
          bearerPrefix,
          bearerIssuedAt: new Date(),
          bearerRevokedAt: null,
          installStatus: "active",
          installError: null,
        },
      }),
      prisma.asset.update({
        where: { id: row.assetId },
        data: {
          responseTimePolling: "agent",
          cpuMemoryPolling:    "agent",
          temperaturePolling:  "agent",
          interfacesPolling:   "agent",
          lldpPolling:         "agent",
          storagePolling:      "agent",
        },
      }),
    ]);

    return {
      managedAgent: {
        id: row.id,
        assetId: row.assetId,
        osPlatform: row.osPlatform,
        arch: row.arch,
        serverCertFingerprint: row.serverCertFingerprint,
        additionalServerCertFingerprints: row.additionalServerCertFingerprints,
      },
      bearer,
    };
  }

  throw new AppError(401, "Enrollment token rejected — expired or already consumed");
}

export interface VerifiedAgent {
  managedAgentId: string;
  assetId: string;
}

/**
 * Verify a presented agent bearer. Walks live (non-revoked) tokens with
 * the matching prefix and argon2-verifies each. Returns null on mismatch,
 * the {managedAgentId, assetId} pair on success.
 *
 * Bumps lastSeenAt + lastSeenIp opportunistically (best-effort — a failure
 * here doesn't fail auth).
 */
export async function verifyBearer(
  rawBearer: string,
  callerIp: string | null,
): Promise<VerifiedAgent | null> {
  if (!rawBearer || !rawBearer.startsWith(TOKEN_PREFIX)) return null;

  const prefix = rawBearer.slice(0, TOKEN_PREFIX_LEN);
  const candidates = await prisma.managedAgent.findMany({
    where: {
      bearerPrefix: prefix,
      bearerHash: { not: null },
      bearerRevokedAt: null,
    },
    select: { id: true, assetId: true, bearerHash: true },
  });

  for (const row of candidates) {
    if (!row.bearerHash) continue;
    const { valid } = await verifyPassword(rawBearer, row.bearerHash);
    if (!valid) continue;

    // Best-effort liveness stamp.
    prisma.managedAgent
      .update({
        where: { id: row.id },
        data: { lastSeenAt: new Date(), lastSeenIp: callerIp ?? null },
      })
      .catch(() => {
        /* ignore */
      });

    return { managedAgentId: row.id, assetId: row.assetId };
  }
  return null;
}

/**
 * Revoke an agent's bearer immediately. The agent's next push attempt
 * receives 401; same for the reconnect loop on the WebSocket. The host-
 * side daemon does NOT self-uninstall on 401 (operator may want to
 * forensic-investigate); the operator-initiated DELETE /assets/:id/agent
 * runs the uninstall script separately.
 *
 * Idempotent: revoking an already-revoked agent is a no-op (returns false).
 * Returns true when a row was actually flipped.
 */
export async function revokeBearer(managedAgentId: string): Promise<boolean> {
  const row = await prisma.managedAgent.findUnique({
    where: { id: managedAgentId },
    select: { bearerRevokedAt: true },
  });
  if (!row) throw new AppError(404, "Managed agent not found");
  if (row.bearerRevokedAt) return false;
  await prisma.managedAgent.update({
    where: { id: managedAgentId },
    data: { bearerRevokedAt: new Date() },
  });
  return true;
}
