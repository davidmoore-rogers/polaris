/**
 * src/services/apiTokenService.ts — Bearer-token authentication for
 * external callers (e.g. SIEM systems invoking quarantine).
 *
 * Tokens are scoped to a fixed list of capability strings. The raw token
 * is shown ONCE at creation; only the argon2id hash is stored. Lookup
 * cost is bounded by the number of non-revoked, non-expired tokens
 * (each request walks the live tokens and verifies argon2 against each
 * — a small N in practice).
 *
 * Wire format: `Authorization: Bearer polaris_<32-char-base62-tail>`.
 *
 * Available scopes (extend in `KNOWN_SCOPES` as needed):
 *   - `assets:quarantine` — POST/DELETE /assets/:id/quarantine
 *   - `assets:read`       — GET /assets/* (read-only)
 *   - `dashboard:read`    — GET /dashboard/noc-summary (read-only NOC fleet
 *                           aggregates; backs the no-login kiosk dashboard.
 *                           Map data — /map/sites — is already reachable by any
 *                           valid token.)
 */

import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { hashPassword, verifyPassword } from "../utils/password.js";

export const KNOWN_SCOPES = ["assets:quarantine", "assets:read", "dashboard:read"] as const;
export type ApiTokenScope = (typeof KNOWN_SCOPES)[number];

const TOKEN_PREFIX = "polaris_";
const TOKEN_RANDOM_BYTES = 24; // → 32 base64url chars

export interface ApiTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  integrationIds: string[];
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}

export interface AuthenticatedToken {
  id: string;
  name: string;
  scopes: string[];
  integrationIds: string[];
}

function generateRawToken(): string {
  const tail = randomBytes(TOKEN_RANDOM_BYTES)
    .toString("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 32);
  return `${TOKEN_PREFIX}${tail}`;
}

function validateScopes(scopes: string[]): void {
  if (scopes.length === 0) {
    throw new AppError(400, "Token must have at least one scope");
  }
  const known = new Set<string>(KNOWN_SCOPES);
  const unknown = scopes.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    throw new AppError(
      400,
      `Unknown scope(s): ${unknown.join(", ")}. Valid scopes: ${KNOWN_SCOPES.join(", ")}`,
    );
  }
}

export interface CreateTokenInput {
  name: string;
  scopes: string[];
  integrationIds?: string[];
  expiresAt?: Date | null;
  createdBy: string;
}

const QUARANTINE_INTEGRATION_TYPES = new Set(["fortimanager", "fortigate"]);

async function validateIntegrationIds(scopes: string[], integrationIds: string[]): Promise<string[]> {
  const needsIntegrations = scopes.includes("assets:quarantine");
  if (!needsIntegrations) return [];
  if (integrationIds.length === 0) {
    throw new AppError(
      400,
      "Tokens with the assets:quarantine scope must select at least one FortiManager or FortiGate integration",
    );
  }
  const unique = Array.from(new Set(integrationIds));
  const rows = await prisma.integration.findMany({
    where: { id: { in: unique } },
    select: { id: true, type: true },
  });
  const found = new Map(rows.map((r) => [r.id, r.type]));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AppError(400, `Unknown integration id(s): ${missing.join(", ")}`);
  }
  const wrongType = unique.filter((id) => !QUARANTINE_INTEGRATION_TYPES.has(found.get(id) || ""));
  if (wrongType.length > 0) {
    throw new AppError(
      400,
      `Integration(s) ${wrongType.join(", ")} are not FortiManager or FortiGate — quarantine push only supports those types`,
    );
  }
  return unique;
}

export interface CreateTokenResult {
  token: ApiTokenSummary;
  rawToken: string; // Shown ONCE; never recoverable later.
}

export async function createToken(input: CreateTokenInput): Promise<CreateTokenResult> {
  if (!input.name?.trim()) throw new AppError(400, "Token name is required");
  validateScopes(input.scopes);

  const existing = await prisma.apiToken.findUnique({ where: { name: input.name.trim() } });
  if (existing) throw new AppError(409, `A token named "${input.name}" already exists`);

  const integrationIds = await validateIntegrationIds(input.scopes, input.integrationIds ?? []);

  const raw = generateRawToken();
  const tokenHash = await hashPassword(raw);
  const tokenPrefix = raw.slice(0, TOKEN_PREFIX.length + 8); // "polaris_xxxxxxxx"

  const row = await prisma.apiToken.create({
    data: {
      name: input.name.trim(),
      tokenHash,
      tokenPrefix,
      scopes: input.scopes,
      integrationIds,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
    },
  });
  return { token: toSummary(row), rawToken: raw };
}

export async function listTokens(): Promise<ApiTokenSummary[]> {
  const rows = await prisma.apiToken.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map(toSummary);
}

export async function revokeToken(id: string, revokedBy: string): Promise<void> {
  const row = await prisma.apiToken.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Token not found");
  if (row.revokedAt) throw new AppError(409, "Token is already revoked");
  await prisma.apiToken.update({
    where: { id },
    data: { revokedAt: new Date(), revokedBy },
  });
}

export async function deleteToken(id: string): Promise<void> {
  const row = await prisma.apiToken.findUnique({ where: { id }, select: { id: true } });
  if (!row) throw new AppError(404, "Token not found");
  await prisma.apiToken.delete({ where: { id } });
}

function toSummary(row: {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  integrationIds: string[];
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: row.scopes,
    integrationIds: row.integrationIds,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
  };
}

/**
 * Verify a presented bearer token. Walks every live (non-revoked, non-
 * expired) token row and verifies argon2id against each. Returns the
 * matching token's identity + scopes on success, null on mismatch.
 *
 * On success, lastUsedAt + lastUsedIp are bumped opportunistically (best-
 * effort — failure here doesn't fail auth).
 */
export async function verifyToken(
  rawToken: string,
  callerIp: string | null,
): Promise<AuthenticatedToken | null> {
  if (!rawToken || !rawToken.startsWith(TOKEN_PREFIX)) return null;

  const candidates = await prisma.apiToken.findMany({
    where: {
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      tokenPrefix: rawToken.slice(0, TOKEN_PREFIX.length + 8),
    },
  });

  for (const row of candidates) {
    const { valid } = await verifyPassword(rawToken, row.tokenHash);
    if (!valid) continue;

    // Best-effort lastUsed bump.
    prisma.apiToken
      .update({
        where: { id: row.id },
        data: { lastUsedAt: new Date(), lastUsedIp: callerIp ?? null },
      })
      .catch(() => {
        /* ignore */
      });

    return { id: row.id, name: row.name, scopes: row.scopes, integrationIds: row.integrationIds };
  }
  return null;
}
