/**
 * src/services/dashRoleSnapshotService.ts
 *
 * Supplies the permission identity for the unauthenticated Dash wallboard:
 * the seeded built-in `readonly` Role, materialized as a SessionRoleSnapshot
 * so the dash listener can stamp it onto `req.roleSnapshot` and every
 * existing gate (`requirePermission`, `hasPermission`, `ensureRoleSnapshot`,
 * the filter-don't-403 dashboard handlers) works unmodified.
 *
 * `readonly` is protected (cannot be edited or deleted), so the 60s TTL is
 * cheap defense-in-depth rather than a freshness requirement.
 */

import { prisma } from "../db.js";
import { snapshotFromRole, type SessionRoleSnapshot } from "../api/middleware/permissions.js";
import { AppError } from "../utils/errors.js";

const CACHE_TTL_MS = 60_000;
let cache: { snapshot: SessionRoleSnapshot; regionTags: string[]; fetchedAt: number } | null = null;

export function invalidateDashRoleSnapshotCache(): void {
  cache = null;
}

export interface DashRoleIdentity {
  snapshot: SessionRoleSnapshot;
  /** The readonly Role's region tags — surfaced by the synthetic /auth/me. */
  regionTags: string[];
}

/** The seeded `readonly` role as a request-stampable snapshot (60s TTL). */
export async function getReadonlyRoleIdentity(): Promise<DashRoleIdentity> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { snapshot: cache.snapshot, regionTags: cache.regionTags };
  }
  const role = await prisma.role.findUnique({ where: { name: "readonly" } });
  if (!role) {
    throw new AppError(500, "Built-in 'readonly' role not found — Polaris is mis-seeded");
  }
  const snapshot = snapshotFromRole(role);
  const regionTags = Array.isArray(role.regionTags) ? role.regionTags : [];
  cache = { snapshot, regionTags, fetchedAt: now };
  return { snapshot, regionTags };
}
