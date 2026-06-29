/**
 * src/api/middleware/permissions.ts — Dynamic-role permission resolver
 *
 * Replaces the prior hardcoded-role guards (requireAdmin / requireNetworkAdmin /
 * requireAssetsAdmin / requireUserOrAbove / isNetworkAdminOrAbove). The session
 * carries a denormalized snapshot of the user's Role (id, name, permissions,
 * updatedAt). Each request checks `permissions[functionKey]` against the
 * required access level; the snapshot is auto-refreshed when the role has
 * been edited since the snapshot was taken.
 *
 * What this module owns:
 *   - The 27-entry function-key catalogue (exported as FUNCTION_KEYS).
 *   - The access-level ordering (none < read < write < fullwrite).
 *   - requirePermission / hasPermission / requireOwnership middleware factories.
 *   - The session-snapshot refresh path (Map<roleId, updatedAt> cache + Prisma fetch).
 *   - bumpRoleVersion(roleId, updatedAt) — called by roleService after every write.
 *
 * Cache semantics:
 *   - In-process Map<roleId, isoString>. Empty at boot; lazily populated on first
 *     request per role. Subsequent requests are O(1) until the role is edited.
 *   - bumpRoleVersion bumps the entry. Any request whose session snapshot has an
 *     older updatedAt triggers one Prisma fetch + req.session.save() to persist
 *     the fresh snapshot.
 *   - Changing a USER's roleId takes effect on next login (we don't iterate the
 *     session store). Changing a ROLE's permissions takes effect on next request
 *     for every session that holds that roleId. The latter is the common case.
 */

import { Request, Response, NextFunction } from "express";
import { AppError } from "../../utils/errors.js";
import { prisma } from "../../db.js";

// ─── Function-key catalogue ────────────────────────────────────────────
//
// One row per top-level functional area an operator can grant/revoke.
// Order is the order the UI matrix renders. Adding a key requires a
// migration to seed it on every existing Role + a corresponding guard
// on whatever routes the key covers.

export type AccessLevel = "none" | "read" | "write" | "fullwrite";

export const ACCESS_LEVELS: readonly AccessLevel[] = ["none", "read", "write", "fullwrite"] as const;

const ACCESS_RANK: Record<AccessLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  fullwrite: 3,
};

export interface FunctionKeyDef {
  key: string;
  label: string;
  description: string;
  // Functions where the "write" level applies an ownership filter
  // (createdBy === username) and "fullwrite" bypasses it. Currently
  // only subnets + reservations behave this way.
  hasOwnershipDimension?: boolean;
}

export const FUNCTION_KEYS: readonly FunctionKeyDef[] = [
  { key: "ipBlocks", label: "IP Blocks", description: "Top-level CIDR blocks. Read = list/view; write = create/edit/delete." },
  { key: "subnets", label: "Subnets", description: "Child subnets. Read-Write = create + edit/delete own only; Full Read-Write = create + edit/delete any.", hasOwnershipDimension: true },
  { key: "reservations", label: "Reservations", description: "IP reservations (incl. DHCP push to FortiGate). Read-Write = create + edit/delete own only; Full Read-Write = create + edit/delete any.", hasOwnershipDimension: true },
  { key: "allocationTemplates", label: "Allocation Templates", description: "Saved multi-subnet allocation templates used by the bulk-allocate modal." },
  { key: "assets", label: "Assets", description: "Asset inventory CRUD + PDF/CSV export." },
  { key: "assetsQuarantine", label: "Asset Quarantine", description: "Push MAC quarantine to FortiGates + release + verify." },
  { key: "assetsProbe", label: "Asset Probes", description: "Manual probe-now, SNMP walk, forward/reverse DNS lookup on a specific asset." },
  { key: "assetMonitorSettings", label: "Asset Monitor Settings", description: "Per-asset / class / integration / manual monitor cadence + retention overrides." },
  { key: "processControl", label: "Process Control", description: "Start / stop / restart a service-backed process on a host via the Polaris Agent. Operator-initiated, confirmed, and audited; the agent never self-acts." },
  { key: "mibDatabase", label: "MIB Database", description: "Upload / browse / walk SNMP MIB modules." },
  { key: "manufacturerProfiles", label: "Manufacturer Profiles", description: "Per-vendor telemetry profile (CPU/memory/temperature OIDs + custom widgets)." },
  { key: "manufacturerAliases", label: "Manufacturer Aliases", description: "Vendor-name normalization map." },
  { key: "credentials", label: "Credentials", description: "Stored SNMP / WinRM / SSH credentials for monitoring probes." },
  { key: "integrations", label: "Integrations", description: "FortiManager / FortiGate / Windows Server / Entra ID / Active Directory integration CRUD + discovery." },
  { key: "discoveryConflicts", label: "Discovery Conflicts", description: "Accept / reject / merge reservation + asset conflicts raised by discovery." },
  { key: "deviceMap", label: "Device Map", description: "Geographic map of FortiGates + topology graphs." },
  { key: "mapRegions", label: "Map Regions", description: "Draw / edit / delete polygons that auto-tag enclosed FortiGates." },
  { key: "deviceIcons", label: "Device Icons", description: "Operator-uploaded icons overlaid on the topology graph." },
  { key: "events", label: "Events / Audit Log", description: "Audit log + syslog/SFTP archival settings + event retention." },
  { key: "notifications", label: "Notifications", description: "Triggered notifications (View tab). Read = view; Read-Write = acknowledge; Full Read-Write = clear." },
  { key: "notificationManagement", label: "Notification Rules", description: "Create / edit / delete notification rules (Manage tab). Full Read-Write = rule CRUD." },
  { key: "staleReservations", label: "Stale Reservations", description: "Snooze / ignore / un-ignore stale DHCP reservation alerts + the threshold setting." },
  { key: "apiTokens", label: "API Tokens", description: "Long-lived bearer tokens for external callers (SIEM quarantine, etc.)." },
  { key: "users", label: "Users", description: "User CRUD + role assignment + TOTP reset." },
  { key: "roles", label: "Roles", description: "Manage this permission matrix itself. Granting Full Read-Write effectively grants admin-equivalent control." },
  { key: "serverSettingsSystem", label: "Server Settings — System", description: "HTTPS / branding / DNS / NTP / certificates / capacity advisor." },
  { key: "serverSettingsData", label: "Server Settings — Data", description: "Database backup / restore, queue mode, security tokens, in-app updates." },
] as const;

const FUNCTION_KEY_SET = new Set(FUNCTION_KEYS.map(f => f.key));

export function isValidFunctionKey(key: string): boolean {
  return FUNCTION_KEY_SET.has(key);
}

export function isValidAccessLevel(level: string): level is AccessLevel {
  return level === "none" || level === "read" || level === "write" || level === "fullwrite";
}

/**
 * Sanitize an incoming permissions object: drop unknown keys, drop bad
 * values, default every function-key to "none" when missing. Returns a
 * fully-populated matrix ready to persist.
 */
export function normalizePermissions(input: unknown): Record<string, AccessLevel> {
  const out: Record<string, AccessLevel> = {};
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  for (const def of FUNCTION_KEYS) {
    const v = raw[def.key];
    out[def.key] = typeof v === "string" && isValidAccessLevel(v) ? v : "none";
  }
  return out;
}

// ─── Privilege ranking (group-mapping "highest privilege wins") ─────────
//
// When a user belongs to multiple mapped IdP groups, the highest-privilege
// matched role is applied. "Privilege" is ranked as:
//   1. Admin-equivalent (users=fullwrite AND roles=fullwrite) outranks any
//      non-admin role — reuses the same predicate as roleService's
//      lastAdminEquivalent guard so the two notions can't drift.
//   2. Otherwise the weighted sum of every function key's access level
//      (none0 / read1 / write2 / fullwrite3).
// Ties (genuinely equal-privilege roles) break deterministically by role id.

export function isAdminEquivalentPermissions(perms: Record<string, AccessLevel>): boolean {
  return perms.users === "fullwrite" && perms.roles === "fullwrite";
}

/** Numeric privilege rank for a permissions matrix. Higher = more privilege. */
export function rankRole(permissions: unknown): number {
  const perms = normalizePermissions(permissions);
  if (isAdminEquivalentPermissions(perms)) return Number.MAX_SAFE_INTEGER;
  let sum = 0;
  for (const def of FUNCTION_KEYS) {
    sum += ACCESS_RANK[perms[def.key] ?? "none"];
  }
  return sum;
}

/**
 * Pick the highest-privilege role id from a candidate list. Ties break by the
 * lexicographically-smallest id so the result is deterministic regardless of
 * input order. Returns null for an empty list.
 */
export function pickHighestPrivilegeRoleId(
  roles: readonly { id: string; permissions: unknown }[],
): string | null {
  let best: { id: string; rank: number } | null = null;
  for (const r of roles) {
    const rank = rankRole(r.permissions);
    if (best === null || rank > best.rank || (rank === best.rank && r.id < best.id)) {
      best = { id: r.id, rank };
    }
  }
  return best ? best.id : null;
}

// ─── Session snapshot shape ────────────────────────────────────────────

export interface SessionRoleSnapshot {
  id: string;
  name: string;
  isProtected: boolean;
  permissions: Record<string, AccessLevel>;
  updatedAt: string; // ISO; compared against the cached Map to trigger refresh
}

// ─── Role-version cache ────────────────────────────────────────────────

// Lazily populated. Empty Map at boot → first request per role triggers a
// Prisma fetch (the session snapshot's updatedAt will not match nothing,
// but our compare path treats a missing cache entry as "trust the snapshot"
// to avoid stampeding the DB on cold start; the entry is filled in by the
// snapshot loader's read).
const roleVersionMap = new Map<string, string>();

/**
 * Called by roleService.update / roleService.delete (and the initial seed
 * on first boot) to stamp the in-process cache with the freshest updatedAt.
 * Stale session snapshots that hold this roleId will refresh on next request.
 */
export function bumpRoleVersion(roleId: string, updatedAt: Date | string): void {
  const iso = typeof updatedAt === "string" ? updatedAt : updatedAt.toISOString();
  roleVersionMap.set(roleId, iso);
}

// Internal: load a Role from DB + stamp the version cache + project to
// the snapshot shape. Throws AppError(401) if the role no longer exists
// (covers admin-deleted-the-user's-role edge case — should be prevented
// by FK Restrict, but defense-in-depth).
async function loadRoleSnapshot(roleId: string): Promise<SessionRoleSnapshot> {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) {
    throw new AppError(401, "Your role no longer exists — please log in again.");
  }
  const updatedAtIso = role.updatedAt.toISOString();
  roleVersionMap.set(role.id, updatedAtIso);
  return {
    id: role.id,
    name: role.name,
    isProtected: role.isProtected,
    permissions: normalizePermissions(role.permissions),
    updatedAt: updatedAtIso,
  };
}

/**
 * Build a fresh snapshot from a Role row. Used by login + role-assign
 * paths that already have the Role in hand and want to stamp the session
 * without a second DB roundtrip.
 */
export function snapshotFromRole(role: {
  id: string;
  name: string;
  isProtected: boolean;
  permissions: unknown;
  updatedAt: Date;
}): SessionRoleSnapshot {
  const iso = role.updatedAt.toISOString();
  roleVersionMap.set(role.id, iso);
  return {
    id: role.id,
    name: role.name,
    isProtected: role.isProtected,
    permissions: normalizePermissions(role.permissions),
    updatedAt: iso,
  };
}

// ─── Snapshot resolution for a request ─────────────────────────────────

/**
 * Returns the up-to-date role snapshot for the current request, refreshing
 * the session snapshot from DB when the cached role version is newer.
 * Returns null when the caller is unauthenticated OR is a bearer-token
 * caller (no session snapshot for tokens — they use scopes instead).
 *
 * Persists session writes via session.save() so the refresh is durable
 * across the response cycle.
 */
async function resolveSnapshot(req: Request): Promise<SessionRoleSnapshot | null> {
  if (!req.session?.userId) return null;
  // Old-session self-heal: a session issued before the dynamic-roles
  // cutover (`829b80a`) carries `req.session.userId` + a string
  // `req.session.role` but no `roleId` / `roleSnapshot`. Without this
  // fallback, the operator's existing session 403s on every guarded
  // route until they log out and back in — including the page-level
  // redirect in app.ts, which silently bounces them home. Look up
  // the user, stamp the new fields, and continue. One DB hit per
  // surviving old session; subsequent requests use the snapshot.
  if (!req.session.roleId) {
    const u = await prisma.user.findUnique({
      where: { id: req.session.userId },
      include: { role: true },
    });
    if (!u) return null;
    const fresh = snapshotFromRole(u.role);
    req.session.roleId = u.roleId;
    req.session.roleSnapshot = fresh;
    req.session.role = u.role.name;
    await new Promise<void>((resolve, reject) => {
      req.session.save(err => (err ? reject(err) : resolve()));
    });
    return fresh;
  }
  const snap = req.session.roleSnapshot;
  if (snap && snap.id === req.session.roleId) {
    const cached = roleVersionMap.get(snap.id);
    if (cached && cached === snap.updatedAt) {
      // Hot path: same role, same version. No DB hit.
      return snap;
    }
    if (!cached) {
      // Cold cache + we have a snapshot: trust the snapshot and warm the cache.
      // Avoids a stampede right after process start where every concurrent
      // request would otherwise issue its own findUnique.
      roleVersionMap.set(snap.id, snap.updatedAt);
      return snap;
    }
    // Cached version is newer (an admin edited the role). Fall through to refetch.
  }
  const fresh = await loadRoleSnapshot(req.session.roleId);
  req.session.roleSnapshot = fresh;
  // Keep the legacy flat fields in sync so any straggler reads see the new name.
  req.session.role = fresh.name;
  await new Promise<void>((resolve, reject) => {
    req.session.save(err => (err ? reject(err) : resolve()));
  });
  return fresh;
}

/**
 * Exported wrapper around `resolveSnapshot` for callers outside the
 * middleware factories that need the same old-session self-heal — most
 * notably the page-level static-HTML redirect in `app.ts`, which runs
 * before the API router and doesn't go through `requirePermission`.
 * Returns the snapshot or null when the caller has no session at all.
 */
export async function ensureSessionRoleSnapshot(req: Request): Promise<SessionRoleSnapshot | null> {
  return resolveSnapshot(req);
}

function rankMeets(actual: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_RANK[actual] >= ACCESS_RANK[required];
}

// ─── Public middleware factories ───────────────────────────────────────

/**
 * Express middleware factory. 403 unless the caller's role grants at
 * least `required` on `functionKey`. Bearer-token callers do NOT pass
 * this gate — they have no role snapshot. Routes that should accept
 * tokens use requireSessionOrTokenPermission instead.
 */
export function requirePermission(functionKey: string, required: AccessLevel) {
  if (!isValidFunctionKey(functionKey)) {
    throw new Error(`requirePermission: unknown functionKey "${functionKey}"`);
  }
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const snap = await resolveSnapshot(req);
      if (!snap) {
        return next(new AppError(403, "Forbidden — session role required"));
      }
      const actual = snap.permissions[functionKey] ?? "none";
      if (!rankMeets(actual, required)) {
        return next(new AppError(403, `Forbidden — your role lacks ${required} access on ${functionKey}`));
      }
      req.permissionLevel = actual;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Boolean inline check for handlers that need conditional behavior
 * (e.g. "if FullRW, skip the ownership filter"). Returns true when the
 * caller has at least `required` on the functionKey. NEVER throws —
 * returns false on missing session or stale snapshot fallback.
 *
 * Synchronous because it reads the snapshot already attached to the
 * session. Use AFTER a `requirePermission(...)` guard has run, which
 * guarantees the snapshot is fresh.
 */
export function hasPermission(req: Request, functionKey: string, required: AccessLevel): boolean {
  const snap = req.session?.roleSnapshot;
  if (!snap) return false;
  const actual = snap.permissions[functionKey] ?? "none";
  return rankMeets(actual, required);
}

/**
 * Composite guard for ownership-dimensioned functions (subnets / reservations).
 * Requires at least "write"; handler reads req.permissionLevel to decide
 * whether to apply the createdBy filter:
 *
 *   if (req.permissionLevel !== "fullwrite" && row.createdBy !== req.session.username) ...
 */
export function requireOwnership(functionKey: string) {
  return requirePermission(functionKey, "write");
}

// ─── Bearer-token hybrid (replaces requireSessionOrTokenScope) ─────────

/**
 * Hybrid guard: pass if either
 *   (a) the session has at least `level` on `functionKey`, OR
 *   (b) a bearer token whose scopes include `requiredScope` is present.
 *
 * Used by routes that an external system needs to reach (the asset
 * quarantine push surface is the canonical case).
 */
export function requireSessionOrTokenPermission(
  functionKey: string,
  level: AccessLevel,
  requiredScope: string,
) {
  if (!isValidFunctionKey(functionKey)) {
    throw new Error(`requireSessionOrTokenPermission: unknown functionKey "${functionKey}"`);
  }
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (req.apiToken) {
        if (req.apiToken.scopes.includes(requiredScope)) return next();
        return next(new AppError(403, `Forbidden — token "${req.apiToken.name}" lacks scope "${requiredScope}"`));
      }
      const snap = await resolveSnapshot(req);
      if (snap) {
        const actual = snap.permissions[functionKey] ?? "none";
        if (rankMeets(actual, level)) {
          req.permissionLevel = actual;
          return next();
        }
        return next(new AppError(403, `Forbidden — your role lacks ${level} access on ${functionKey}`));
      }
      next(new AppError(401, "Unauthorized — session login or bearer token required"));
    } catch (err) {
      next(err);
    }
  };
}
