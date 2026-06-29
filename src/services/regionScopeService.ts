/**
 * src/services/regionScopeService.ts
 *
 * Shared resolver for a user's effective region/other tag scope —
 * union(role tags, user tags, group-derived tags). Extracted from the
 * GET /auth/me handler so the notifications list (and any future
 * region-scoped surface) computes scope identically.
 *
 * Group-derived tags are re-resolved live from the user's last-seen SSO
 * groups (never persisted onto the user's own columns), so a GroupMapping
 * edit takes effect without re-login.
 */

import { prisma } from "../db.js";
import { resolveGroupsToAccess } from "./groupMappingService.js";
import { unionTags } from "../utils/tagNormalize.js";

export interface TagScope {
  user: string[];
  role: string[];
  group: string[];
  effective: string[];
}

export interface UserTagScopes {
  regionTags: TagScope;
  otherTags: TagScope;
}

/**
 * A user row already loaded with its role. Accepts the minimal shape so
 * callers that already hold a `prisma.user.findUnique({ include: { role } })`
 * result (e.g. /auth/me) don't pay a second query.
 */
interface UserWithRoleTags {
  regionTags: string[] | null;
  otherTags: string[] | null;
  ssoGroups: string[] | null;
  authProvider: string;
  role: { regionTags: string[] | null; otherTags: string[] | null };
}

/** Compute both tag-scope dimensions for an already-loaded user+role. */
export async function resolveTagScopesForUser(u: UserWithRoleTags): Promise<UserTagScopes> {
  const userRegions = Array.isArray(u.regionTags) ? u.regionTags : [];
  const roleRegions = Array.isArray(u.role.regionTags) ? u.role.regionTags : [];
  const userOther = Array.isArray(u.otherTags) ? u.otherTags : [];
  const roleOther = Array.isArray(u.role.otherTags) ? u.role.otherTags : [];

  let groupRegions: string[] = [];
  let groupOther: string[] = [];
  if (Array.isArray(u.ssoGroups) && u.ssoGroups.length > 0) {
    const access = await resolveGroupsToAccess(u.authProvider, u.ssoGroups);
    groupRegions = access.regionTags;
    groupOther = access.otherTags;
  }

  return {
    regionTags: {
      user: userRegions,
      role: roleRegions,
      group: groupRegions,
      effective: unionTags(roleRegions, userRegions, groupRegions),
    },
    otherTags: {
      user: userOther,
      role: roleOther,
      group: groupOther,
      effective: unionTags(roleOther, userOther, groupOther),
    },
  };
}

/**
 * Effective region tags for a user id. Empty array means "unrestricted"
 * (no region scoping applies — the caller sees everything). One indexed PK
 * lookup + (for SSO users) one cached group resolution.
 */
export async function getEffectiveRegionTags(userId: string): Promise<string[]> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: true },
  });
  if (!u) return [];
  const scopes = await resolveTagScopesForUser(u);
  return scopes.regionTags.effective;
}
