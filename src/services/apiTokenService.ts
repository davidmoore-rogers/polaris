/**
 * src/services/apiTokenService.ts — Bearer-token authentication for
 * external callers (e.g. SIEM systems invoking quarantine, NOC kiosks,
 * read-only inventory consumers).
 *
 * Each token is bound to a Role at mint time; requirePermission resolves
 * the token's role matrix exactly like a session role snapshot, so the
 * token can reach whatever the chosen role grants and nothing else.
 * (The prior fixed scope-string list — assets:read / dashboard:read /
 * assets:quarantine — was retired in migration 20260706000000; legacy
 * tokens were mapped onto seeded api-* roles with matching matrices.)
 *
 * Binding a token to an admin-equivalent role is allowed but logs a
 * warning Event — a leaked token would be a full-control credential.
 *
 * The raw token is shown ONCE at creation; only the argon2id hash is
 * stored. Lookup cost is bounded by the number of non-revoked,
 * non-expired tokens sharing the 8-char prefix (small N in practice).
 *
 * Wire format: `Authorization: Bearer polaris_<32-char-base62-tail>`.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { logEvent } from "../api/routes/events.js";
import {
  normalizePermissions,
  isAdminEquivalentPermissions,
  type AccessLevel,
} from "../api/middleware/permissions.js";

const TOKEN_PREFIX = "polaris_";
const TOKEN_RANDOM_BYTES = 24; // → 32 base64url chars

export interface ApiTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  roleId: string;
  roleName: string;
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
  roleId: string;
  integrationIds: string[];
}

function generateRawToken(): string {
  const tail = randomBytes(TOKEN_RANDOM_BYTES)
    .toString("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 32);
  return `${TOKEN_PREFIX}${tail}`;
}

export interface CreateTokenInput {
  name: string;
  roleId: string;
  integrationIds?: string[];
  expiresAt?: Date | null;
  createdBy: string;
}

const QUARANTINE_INTEGRATION_TYPES = new Set(["fortimanager", "fortigate"]);

function grantsQuarantineWrite(perms: Record<string, AccessLevel>): boolean {
  return perms.assetsQuarantine === "write" || perms.assetsQuarantine === "fullwrite";
}

async function validateIntegrationIds(
  needsIntegrations: boolean,
  integrationIds: string[],
): Promise<string[]> {
  if (!needsIntegrations) return [];
  if (integrationIds.length === 0) {
    throw new AppError(
      400,
      "Tokens whose role grants Asset Quarantine write must select at least one FortiManager or FortiGate integration",
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
  if (!input.roleId?.trim()) throw new AppError(400, "Token role is required");

  const role = await prisma.role.findUnique({ where: { id: input.roleId } });
  if (!role) throw new AppError(400, `Role ${input.roleId} not found`);
  const perms = normalizePermissions(role.permissions);

  const existing = await prisma.apiToken.findUnique({ where: { name: input.name.trim() } });
  if (existing) throw new AppError(409, `A token named "${input.name}" already exists`);

  const integrationIds = await validateIntegrationIds(
    grantsQuarantineWrite(perms),
    input.integrationIds ?? [],
  );

  const raw = generateRawToken();
  const tokenHash = await hashPassword(raw);
  const tokenPrefix = raw.slice(0, TOKEN_PREFIX.length + 8); // "polaris_xxxxxxxx"

  const row = await prisma.apiToken.create({
    data: {
      name: input.name.trim(),
      tokenHash,
      tokenPrefix,
      roleId: role.id,
      integrationIds,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
    },
    include: { role: { select: { name: true } } },
  });

  // Same posture as groupMappingService: an admin-equivalent binding is
  // allowed but leaves a loud audit trail — a leaked long-lived token bound
  // to this role is a full-control credential.
  if (isAdminEquivalentPermissions(perms)) {
    void logEvent({
      action: "api_token.admin_equivalent",
      resourceType: "api_token",
      resourceId: row.id,
      resourceName: row.name,
      actor: input.createdBy,
      level: "warning",
      message: `API token "${row.name}" is bound to admin-equivalent role "${role.name}" — anyone holding this token has full control of Polaris`,
    });
  }

  return { token: toSummary(row), rawToken: raw };
}

export async function listTokens(): Promise<ApiTokenSummary[]> {
  const rows = await prisma.apiToken.findMany({
    orderBy: { createdAt: "desc" },
    include: { role: { select: { name: true } } },
  });
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
  roleId: string;
  role: { name: string };
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
    roleId: row.roleId,
    roleName: row.role.name,
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
 * expired) token row sharing the prefix and verifies argon2id against
 * each. Returns the matching token's identity + bound roleId on success,
 * null on mismatch.
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

    return { id: row.id, name: row.name, roleId: row.roleId, integrationIds: row.integrationIds };
  }
  return null;
}
