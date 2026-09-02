/**
 * src/services/duplicateIpConflictService.ts — duplicate-address conflicts
 * between two (or more) network-present Assets.
 *
 * The third `entityType="asset"` Conflict flavour, alongside the discovery
 * hostname collisions (discoveryEngine) and the operator IP pin disagreement
 * (ipOverrideService). Distinguished by
 * `proposedAssetFields.collisionReason="duplicate-ip"` — see the header of
 * src/services/conflictResolutionService.ts for the variant table.
 *
 * WHAT IT REPORTS
 * Two Assets whose `ipAddress` is the same address while both are in a status
 * that can be on the network (i.e. NOT one of UNMONITORABLE_STATUSES —
 * decommissioned / disabled / storage / quarantined; see business rule 10),
 * where AT LEAST ONE of them is a type whose address was CHOSEN rather than
 * handed out by a pool (CONFLICT_ELIGIBLE_ASSET_TYPES — switch / access_point /
 * firewall / server). Two endpoints trading a DHCP address is DHCP working; an
 * endpoint sitting on an access point's address is an outage, so the endpoint
 * still appears as a claimant on the card, it just cannot raise the conflict by
 * itself.
 * One address answering for two devices breaks routing, monitoring and
 * quarantine alike, and nothing else in Polaris notices: the IPAM half has a
 * unique index per subnet (business rule 3) but inventory has no such
 * constraint, because two Asset rows carrying one address is exactly the state
 * discovery has to be able to REPRESENT in order to report it.
 *
 * A STALE RECORD IS NOT A DUPLICATE (business rule 40)
 * DHCP reuses addresses constantly, and an Asset keeps the last address a
 * writer staged on it until another write moves it — so a departed device's
 * row sits on an address its successor now legitimately holds. Raising a
 * conflict for every such pair would bury the real ones. A member therefore
 * only counts when its CLAIM on the address is current:
 *   • operator-owned — `ipOverride` equals the address, or `ipSource="manual"`.
 *     A typed address is a standing claim and never goes stale.
 *   • re-asserted recently — the (asset, ip) AssetIpHistory row's `lastSeen`
 *     is within CLAIM_FRESH_DAYS. That row is bumped by the db.ts extension on
 *     EVERY asset write staging `ipAddress` (even an unchanged one), so it
 *     tracks discovery/agent cadence rather than change; `Asset.lastSeen` is
 *     the fallback for a row that predates the extension or was pruned.
 * And a group needs two DEVICES, not two rows: members sharing one non-null
 * MAC are one device recorded twice (a merge job's problem, not an address
 * conflict) and are collapsed by `distinctDeviceCount`.
 *
 * LIFECYCLE
 *   raise      — one pending Conflict per ADDRESS (never per pair), carrying
 *                every member in `proposedAssetFields.members`. Stamps a
 *                `conflict.detected` Event, which is what the baseline "IP
 *                conflict detected" automation alerts on.
 *   refresh    — a later pass re-writes the member list while the row is pending.
 *   dismiss    — reject (conflictResolutionService). The rejected row is the
 *                dedup marker: the SAME member set never re-raises, a changed
 *                one does.
 *   resolve    — TWO verbs, because a duplicate address has two real causes.
 *                `reassignDuplicateIpAsset` gives ONE member a new address (two
 *                devices, one of them has to move); `mergeDuplicateIpAssets`
 *                absorbs members into a survivor through the operator merge
 *                engine (one device recorded twice, where renumbering either
 *                row would be wrong). Both close the conflict as accepted once
 *                fewer than two current claims remain, and both leave a
 *                three-way collision open on whoever still claims the address.
 *   auto-close — a duplicate that resolves itself (a device decommissioned, a
 *                discovery write moving one row) closes on the next pass.
 *
 * Accept is deliberately unsupported: there is nothing to adopt. The verbs are
 * "give one of them a different address" and "these are the same device".
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent, buildChanges } from "./eventLogService.js";
import { UNMONITORABLE_STATUSES } from "../utils/assetInvariants.js";
import { isValidIpAddress } from "../utils/cidr.js";
import { resolvePendingIpOverrideConflicts } from "./ipOverrideService.js";
import { mergeAssets } from "./assetMergeService.js";

export const DUPLICATE_IP_COLLISION_REASON = "duplicate-ip";

/** Prisma JSON filter matching this feature's conflicts. */
const DUPLICATE_IP_CONFLICT_WHERE = {
  entityType: "asset",
  proposedAssetFields: { path: ["collisionReason"], equals: DUPLICATE_IP_COLLISION_REASON },
};

/**
 * How long a DISCOVERED claim on an address stays current. Generous on
 * purpose: discovery re-asserts an asset's IP on the integration's
 * `pollInterval`, which operators routinely set to hours, and a claim only has
 * to look current for the pair to be worth a human's attention. Operator-owned
 * claims ignore this entirely.
 */
export const CLAIM_FRESH_DAYS = 7;

/**
 * Which asset types make a shared address worth reporting. A conflict is raised
 * when AT LEAST ONE claimant is one of these — the group still carries every
 * other claimant (an endpoint that took an AP's address is exactly what the card
 * needs to name), but two endpoints trading a DHCP address between them is not a
 * fault, it is DHCP working.
 *
 * These four have addresses somebody CHOSE: a switch, an access point and a
 * FortiGate are statically addressed or DHCP-reserved infrastructure, and a
 * server is addressed on purpose whether it is physical or a vCenter VM (VMs are
 * typed `server` — the `virtual_machine` type was retired). A workstation,
 * printer or phone is handed whatever the pool has free, which is why a
 * duplicate involving only those is noise.
 *
 * Deliberately a constant rather than a Setting: it is a claim about which
 * equipment has deliberate addressing, not a per-install preference, and a
 * settings surface for it would need an asset-type picker no other conflict
 * behaviour has. Operator-added custom types fall outside it by design (the
 * `assetType`-branching convention in CLAUDE.md) — add them here deliberately.
 * `hypervisor` (an ESXi host) and `router` are NOT here; see business rule 40.
 */
export const CONFLICT_ELIGIBLE_ASSET_TYPES = ["switch", "access_point", "firewall", "server"];

/** Safety cap on the duplicate scan's result set (rows, not groups). */
const SCAN_ROW_CAP = 5000;

/** One asset's claim on one address, as the scan reads it. */
export interface IpClaimRow {
  id: string;
  ip: string;
  hostname: string | null;
  assetType: string | null;
  status: string | null;
  monitored: boolean;
  macAddress: string | null;
  ipSource: string | null;
  ipOverride: string | null;
  lastSeen: Date | null;
  /** AssetIpHistory.lastSeen for (asset, ip) — null when no history row. */
  ipLastSeen: Date | null;
}

/** A member as it is stored on the conflict (JSON-safe). */
export interface DuplicateIpMember {
  assetId: string;
  hostname: string | null;
  assetType: string | null;
  status: string | null;
  monitored: boolean;
  macAddress: string | null;
  ipSource: string | null;
  /** True when the address is operator-owned (pin or manual) on this asset. */
  pinned: boolean;
  lastSeen: string | null;
  ipLastSeen: string | null;
}

export interface DuplicateIpGroup {
  ip: string;
  members: IpClaimRow[];
}

// ─── Pure decisions (unit-tested in tests/unit/duplicateIpConflict.test.ts) ──

/** Is this asset's address the operator's own statement rather than a sighting? */
export function claimIsOperatorOwned(
  row: Pick<IpClaimRow, "ip" | "ipOverride" | "ipSource">,
): boolean {
  if (row.ipOverride && row.ipOverride === row.ip) return true;
  return row.ipSource === "manual";
}

/**
 * Does this row still CLAIM the address, or is it a leftover? Operator-owned
 * claims never expire; a discovered one must have been re-asserted (or the
 * device seen, for rows with no history) since `cutoff`.
 */
export function claimIsCurrent(row: IpClaimRow, cutoff: Date): boolean {
  if (claimIsOperatorOwned(row)) return true;
  const ts = row.ipLastSeen ?? row.lastSeen;
  if (!ts) return false;
  // These arrive from $queryRaw, so the declared Date is a claim about the
  // driver rather than a guarantee — normalize instead of calling .getTime().
  const at = ts instanceof Date ? ts.getTime() : new Date(ts as unknown as string).getTime();
  if (!Number.isFinite(at)) return false;
  return at >= cutoff.getTime();
}

/**
 * How many distinct DEVICES a member list represents. Two rows sharing one
 * non-null MAC are the same device recorded twice — a duplicate record, which
 * `mergeDuplicateHostnameAssets` / an operator merge fixes, not an address
 * collision. A null MAC proves nothing, so each counts as its own device.
 */
export function distinctDeviceCount(members: Pick<IpClaimRow, "macAddress">[]): number {
  const macs = new Set<string>();
  let unknown = 0;
  for (const m of members) {
    const mac = (m.macAddress || "").trim().toUpperCase();
    if (mac) macs.add(mac);
    else unknown++;
  }
  return macs.size + unknown;
}

/**
 * Does this set of claimants include equipment whose address was CHOSEN? One
 * qualifying member is enough — the conflict is about that device, and the
 * endpoint sitting on its address is the other half of the story rather than a
 * reason to stay quiet.
 */
export function groupHasEligibleType(members: Pick<IpClaimRow, "assetType">[]): boolean {
  return members.some((m) => CONFLICT_ELIGIBLE_ASSET_TYPES.includes((m.assetType || "").trim()));
}

/** Group current claims by address and keep only the real collisions. */
export function groupCurrentClaims(rows: IpClaimRow[], cutoff: Date): DuplicateIpGroup[] {
  const byIp = new Map<string, IpClaimRow[]>();
  for (const row of rows) {
    if (!row.ip) continue;
    if (!claimIsCurrent(row, cutoff)) continue;
    const list = byIp.get(row.ip);
    if (list) list.push(row);
    else byIp.set(row.ip, [row]);
  }
  const groups: DuplicateIpGroup[] = [];
  for (const [ip, members] of byIp) {
    if (members.length < 2) continue;
    if (distinctDeviceCount(members) < 2) continue;
    // Eligibility is tested on the CURRENT claims, not on everything the scan
    // returned: an address whose only qualifying claimant is a stale record is
    // two endpoints trading a DHCP lease, which is not a fault.
    if (!groupHasEligibleType(members)) continue;
    groups.push({ ip, members: [...members].sort((a, b) => a.id.localeCompare(b.id)) });
  }
  return groups.sort((a, b) => a.ip.localeCompare(b.ip));
}

/**
 * Which members a merge may absorb into `survivorAssetId`. Pure so the refusal
 * rules are testable without a database: the survivor and every target must be
 * a member of THIS conflict (nothing may reach an asset the card never showed),
 * the survivor is silently dropped from the target list rather than attempting
 * a self-merge, duplicates collapse, and an empty result is refused — the
 * caller is about to delete rows and "merge nothing" is never what was meant.
 */
export function resolveMergeTargets(
  members: { assetId: string }[],
  survivorAssetId: string,
  rawAbsorbIds: string[],
): string[] {
  const memberIds = new Set(members.map((m) => m.assetId));
  if (!memberIds.has(survivorAssetId)) {
    throw new AppError(400, "The surviving asset is not one of the assets sharing this address");
  }
  const absorbIds = [...new Set((rawAbsorbIds || []).filter(Boolean))].filter(
    (id) => id !== survivorAssetId,
  );
  if (absorbIds.length === 0) {
    throw new AppError(400, "Choose at least one other asset to merge into the survivor");
  }
  for (const id of absorbIds) {
    if (!memberIds.has(id)) {
      throw new AppError(400, "An asset to merge is not one of the assets sharing this address");
    }
  }
  return absorbIds;
}

/** Stable identity of a member set — the dedup key behind "already dismissed". */
export function memberSetKey(members: { assetId?: string; id?: string }[]): string {
  return members
    .map((m) => m.assetId ?? m.id ?? "")
    .filter(Boolean)
    .sort()
    .join(",");
}

/**
 * Which member the Conflict row's `assetId` points at. Lowest id wins — a
 * stable pick so a refresh doesn't churn the FK (and therefore the cascade
 * that would delete the conflict) as sightings reorder the list.
 */
export function pickPrimaryMemberId(members: { id: string }[]): string | null {
  const ids = members.map((m) => m.id).filter(Boolean).sort();
  return ids[0] ?? null;
}

export function toStoredMember(row: IpClaimRow): DuplicateIpMember {
  return {
    assetId: row.id,
    hostname: row.hostname ?? null,
    assetType: row.assetType ?? null,
    status: row.status ?? null,
    monitored: !!row.monitored,
    macAddress: row.macAddress ?? null,
    ipSource: row.ipSource ?? null,
    pinned: claimIsOperatorOwned(row),
    lastSeen: row.lastSeen ? new Date(row.lastSeen).toISOString() : null,
    ipLastSeen: row.ipLastSeen ? new Date(row.ipLastSeen).toISOString() : null,
  };
}

// ─── Scan ────────────────────────────────────────────────────────────────────

/**
 * Every claim on an address that at least two network-present assets record.
 * ONE query: the CTE narrows to duplicated addresses in SQL (so a 2000-asset
 * fleet returns the handful of colliding rows, not the fleet), and the
 * freshness verdict stays in JS where it is pure and testable.
 */
export async function loadDuplicateIpClaims(): Promise<IpClaimRow[]> {
  return prisma.$queryRaw<IpClaimRow[]>`
    WITH claims AS (
      SELECT a.id, a."ipAddress" AS ip, a.hostname, a."assetType",
             a.status::text AS status, a.monitored, a."macAddress",
             a."ipSource", a."ipOverride", a."lastSeen",
             h."lastSeen" AS "ipLastSeen"
      FROM assets a
      LEFT JOIN asset_ip_history h ON h."assetId" = a.id AND h.ip = a."ipAddress"
      WHERE a."ipAddress" IS NOT NULL
        AND a."ipAddress" <> ''
        AND a.status::text <> ALL(${UNMONITORABLE_STATUSES}::text[])
    ),
    dups AS (
      -- Addresses with at least two claims AND at least one claim from a type
      -- worth reporting. A SUPERSET of what qualifies (this cannot see the
      -- freshness verdict, so a stale switch row still passes bool_or here and
      -- is dropped in JS) — the point is to keep endpoint-only duplicates,
      -- which on a DHCP fleet are most of them, out of the result set entirely.
      SELECT ip FROM claims
      GROUP BY ip
      HAVING count(*) > 1
         AND bool_or("assetType" = ANY(${CONFLICT_ELIGIBLE_ASSET_TYPES}::text[]))
    )
    SELECT c.* FROM claims c JOIN dups d ON d.ip = c.ip
    ORDER BY c.ip, c.id
    LIMIT ${SCAN_ROW_CAP}
  `;
}

/** Every network-present claim on ONE address (no "at least two" pre-filter). */
async function loadClaimsForIp(ip: string): Promise<IpClaimRow[]> {
  return prisma.$queryRaw<IpClaimRow[]>`
    SELECT a.id, a."ipAddress" AS ip, a.hostname, a."assetType",
           a.status::text AS status, a.monitored, a."macAddress",
           a."ipSource", a."ipOverride", a."lastSeen",
           h."lastSeen" AS "ipLastSeen"
    FROM assets a
    LEFT JOIN asset_ip_history h ON h."assetId" = a.id AND h.ip = a."ipAddress"
    WHERE a."ipAddress" = ${ip}
      AND a.status::text <> ALL(${UNMONITORABLE_STATUSES}::text[])
    ORDER BY a.id
  `;
}

function freshnessCutoff(now = Date.now()): Date {
  return new Date(now - CLAIM_FRESH_DAYS * 86_400_000);
}

/** The live group for one address, or null when it is no longer a collision. */
async function evaluateIp(ip: string): Promise<DuplicateIpGroup | null> {
  const rows = await loadClaimsForIp(ip);
  const groups = groupCurrentClaims(rows, freshnessCutoff());
  return groups.find((g) => g.ip === ip) ?? null;
}

// ─── Reconcile (the job's entry point) ───────────────────────────────────────

export interface DuplicateIpReconcileResult {
  groups: number;
  raised: number;
  refreshed: number;
  closed: number;
  suppressed: number;
}

function conflictIpOf(conflict: { proposedAssetFields: unknown }): string | null {
  const proposed = conflict.proposedAssetFields as Record<string, unknown> | null;
  const ip = proposed?.ipAddress;
  return typeof ip === "string" && ip ? ip : null;
}

function conflictMembersOf(conflict: { proposedAssetFields: unknown }): DuplicateIpMember[] {
  const proposed = conflict.proposedAssetFields as Record<string, unknown> | null;
  const members = proposed?.members;
  return Array.isArray(members) ? (members as DuplicateIpMember[]) : [];
}

/**
 * Raise / refresh / close the duplicate-address conflict set. Idempotent — a
 * steady-state fleet with no duplicates issues zero writes.
 */
export async function reconcileDuplicateIpConflicts(): Promise<DuplicateIpReconcileResult> {
  const result: DuplicateIpReconcileResult = {
    groups: 0,
    raised: 0,
    refreshed: 0,
    closed: 0,
    suppressed: 0,
  };

  const rows = await loadDuplicateIpClaims();
  const groups = groupCurrentClaims(rows, freshnessCutoff());
  result.groups = groups.length;

  const pending = await prisma.conflict.findMany({
    where: { ...DUPLICATE_IP_CONFLICT_WHERE, status: "pending" },
    orderBy: { createdAt: "asc" },
    select: { id: true, assetId: true, proposedAssetFields: true },
  });
  // One pending row per ADDRESS is the invariant; the OLDEST wins and any
  // extra (a raced create, a hand-inserted row) is closed below rather than
  // left to linger unreachable behind the winner.
  const pendingByIp = new Map<string, (typeof pending)[number]>();
  const strandedPendingIds: string[] = [];
  for (const row of pending) {
    const ip = conflictIpOf(row);
    if (!ip) continue;
    if (pendingByIp.has(ip)) strandedPendingIds.push(row.id);
    else pendingByIp.set(ip, row);
  }
  if (strandedPendingIds.length) {
    const stranded = await prisma.conflict.updateMany({
      where: { id: { in: strandedPendingIds }, status: "pending" },
      data: { status: "rejected", resolvedBy: "system:auto-resolved", resolvedAt: new Date() },
    });
    result.closed += stranded.count;
  }

  // Every previously-dismissed duplicate, newest first — the re-raise
  // suppressor. Read once (not per group): the resolved set is small and a
  // per-group query would be one round trip per collision.
  const resolved = groups.length
    ? await prisma.conflict.findMany({
        where: { ...DUPLICATE_IP_CONFLICT_WHERE, status: { not: "pending" } },
        orderBy: { resolvedAt: "desc" },
        select: { status: true, proposedAssetFields: true },
        take: 500,
      })
    : [];
  const lastResolvedByIp = new Map<string, (typeof resolved)[number]>();
  for (const row of resolved) {
    const ip = conflictIpOf(row);
    if (ip && !lastResolvedByIp.has(ip)) lastResolvedByIp.set(ip, row);
  }

  for (const group of groups) {
    const members = group.members.map(toStoredMember);
    const proposedAssetFields = {
      collisionReason: DUPLICATE_IP_COLLISION_REASON,
      ipAddress: group.ip,
      // Conflict-queue widget subtitle reads `hostname`.
      hostname: group.members[0]?.hostname ?? null,
      members,
    } as any;
    const existingAssetSnapshot = { ipAddress: group.ip, members } as any;
    const open = pendingByIp.get(group.ip);

    if (open) {
      const primaryId = pickPrimaryMemberId(group.members);
      const stillAMember = group.members.some((m) => m.id === open.assetId);
      await prisma.conflict.update({
        where: { id: open.id },
        data: {
          proposedAssetFields,
          existingAssetSnapshot,
          ...(stillAMember || !primaryId ? {} : { assetId: primaryId }),
        },
      });
      result.refreshed++;
      continue;
    }

    // Dismissed before with exactly this member set — don't nag every cycle.
    const lastResolved = lastResolvedByIp.get(group.ip);
    const dismissedSameSet =
      lastResolved?.status === "rejected" &&
      memberSetKey(conflictMembersOf(lastResolved)) === memberSetKey(members);
    if (dismissedSameSet) {
      result.suppressed++;
      continue;
    }

    const primaryId = pickPrimaryMemberId(group.members);
    if (!primaryId) continue;
    await prisma.conflict.create({
      data: {
        entityType: "asset",
        assetId: primaryId,
        conflictFields: ["ipAddress"],
        proposedAssetFields,
        existingAssetSnapshot,
      },
    });
    result.raised++;
    const names = group.members.map((m) => m.hostname || m.id).join(", ");
    logEvent({
      action: "conflict.detected",
      resourceType: "asset",
      resourceId: primaryId,
      resourceName: group.members[0]?.hostname || group.ip,
      actor: "system",
      message: `Duplicate IP address ${group.ip} — ${group.members.length} assets claim it: ${names}`,
      details: {
        collisionReason: DUPLICATE_IP_COLLISION_REASON,
        ipAddress: group.ip,
        assetIds: group.members.map((m) => m.id),
        hostnames: group.members.map((m) => m.hostname ?? null),
      },
    });
  }

  // Duplicates that resolved themselves (one row moved on, or a member left a
  // network-present status) — close the open conflict.
  const liveIps = new Set(groups.map((g) => g.ip));
  for (const [ip, row] of pendingByIp) {
    if (liveIps.has(ip)) continue;
    await prisma.conflict.update({
      where: { id: row.id },
      data: {
        status: "rejected",
        resolvedBy: "system:auto-resolved",
        resolvedAt: new Date(),
      },
    });
    result.closed++;
    logEvent({
      action: "conflict.rejected",
      resourceType: "asset",
      resourceId: row.assetId ?? undefined,
      resourceName: ip,
      actor: "system",
      message: `Duplicate IP conflict on ${ip} auto-resolved — the address no longer has two current claims from equipment Polaris reports duplicates for`,
      details: { collisionReason: DUPLICATE_IP_COLLISION_REASON, ipAddress: ip },
    });
  }

  return result;
}

// ─── Resolution: give one member a different address ─────────────────────────

export interface ReassignOutcome {
  ipAddress: string;
  newIpAddress: string;
  assetId: string;
  /** True when the conflict closed (fewer than two current claims remain). */
  resolved: boolean;
  /** Members still claiming the original address after the write. */
  remaining: number;
}

/**
 * Move ONE member of a duplicate-address conflict to a new address, with the
 * operator-edit semantics of the asset form: `ipAddress` + `ipOverride` +
 * `ipSource="manual"` in one write, so the db.ts override guard defers to it
 * (and discovery reporting the same address later releases the pin by itself).
 *
 * Refuses an address another network-present asset already holds — moving the
 * collision is not resolving it.
 */
export async function reassignDuplicateIpAsset(
  conflict: { id: string; assetId: string | null; proposedAssetFields: unknown },
  assetId: string,
  rawIp: string,
  actor?: string,
): Promise<ReassignOutcome> {
  const proposed = (conflict.proposedAssetFields || {}) as Record<string, unknown>;
  if (proposed.collisionReason !== DUPLICATE_IP_COLLISION_REASON) {
    throw new AppError(400, "This conflict is not a duplicate IP address conflict");
  }
  const ip = conflictIpOf(conflict);
  if (!ip) throw new AppError(500, "Duplicate IP conflict is missing its address");

  const members = conflictMembersOf(conflict);
  if (!members.some((m) => m.assetId === assetId)) {
    throw new AppError(400, "That asset is not one of the assets sharing this address");
  }

  const newIp = (rawIp || "").trim();
  if (!newIp) throw new AppError(400, "A new IP address is required");
  if (!isValidIpAddress(newIp)) throw new AppError(400, `"${newIp}" is not a valid IP address`);
  if (newIp === ip) {
    throw new AppError(400, "The new address is the same as the conflicting address");
  }

  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { id: true, hostname: true, ipAddress: true, ipOverride: true, ipSource: true },
  });
  if (!asset) throw new AppError(404, "Asset not found");

  const holder = await prisma.asset.findFirst({
    where: {
      id: { not: assetId },
      ipAddress: newIp,
      status: { notIn: UNMONITORABLE_STATUSES as any },
    },
    select: { id: true, hostname: true },
  });
  if (holder) {
    throw new AppError(
      409,
      `${newIp} is already recorded on "${holder.hostname || holder.id}" — that would move the duplicate, not resolve it`,
    );
  }

  await prisma.asset.update({
    where: { id: assetId },
    data: { ipAddress: newIp, ipOverride: newIp, ipSource: "manual" },
  });

  // Setting the pin makes any pending ip-override conflict on this asset moot —
  // the operator just made the call it was asking about (same as PUT /assets/:id).
  resolvePendingIpOverrideConflicts(assetId, actor ?? "manual").catch(() => {});

  const label = asset.hostname || newIp;
  const changes = buildChanges(
    { ipAddress: asset.ipAddress, ipOverride: asset.ipOverride, ipSource: asset.ipSource },
    { ipAddress: newIp, ipOverride: newIp, ipSource: "manual" },
  );
  logEvent({
    action: "asset.updated",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: label,
    actor,
    message: `Asset "${label}" moved off duplicate address ${ip} to ${newIp}`,
    details: changes ? { changes, duplicateIp: ip } : { duplicateIp: ip },
  });

  const group = await evaluateIp(ip);
  const remaining = group ? group.members.length : 0;
  if (!group) {
    await prisma.conflict.update({
      where: { id: conflict.id },
      data: { status: "accepted", resolvedBy: actor ?? null, resolvedAt: new Date() },
    });
    logEvent({
      action: "conflict.accepted",
      resourceType: "asset",
      resourceId: conflict.assetId ?? assetId,
      resourceName: ip,
      actor,
      message: `Duplicate IP conflict on ${ip} resolved — "${label}" now records ${newIp}`,
      details: {
        collisionReason: DUPLICATE_IP_COLLISION_REASON,
        ipAddress: ip,
        newIpAddress: newIp,
        assetId,
      },
    });
    return { ipAddress: ip, newIpAddress: newIp, assetId, resolved: true, remaining };
  }

  // Still contested (a three-way collision) — keep the conflict open on the
  // survivors so the operator can move the next one.
  const survivors = group.members.map(toStoredMember);
  await prisma.conflict.update({
    where: { id: conflict.id },
    data: {
      proposedAssetFields: {
        collisionReason: DUPLICATE_IP_COLLISION_REASON,
        ipAddress: ip,
        hostname: group.members[0]?.hostname ?? null,
        members: survivors,
      } as any,
      existingAssetSnapshot: { ipAddress: ip, members: survivors } as any,
    },
  });
  return { ipAddress: ip, newIpAddress: newIp, assetId, resolved: false, remaining };
}

// ─── Resolution: the two records are one device ───────────────────────────────

export interface MergeDuplicateIpOutcome {
  ipAddress: string;
  survivorAssetId: string;
  absorbedAssetIds: string[];
  movedSources: number;
  /** True when the conflict closed (fewer than two current claims remain). */
  resolved: boolean;
  /** Members still claiming the address after the merges. */
  remaining: number;
}

/**
 * The other reason two assets share an address: they are ONE device recorded
 * twice, and renumbering either would be wrong. Absorbs the named members into
 * the survivor through the operator merge engine (`mergeAssets`) — the same
 * path the asset page's Merge modal and `acceptAssetConflict`'s ghost absorb
 * use, so provenance, MACs, IP history, sightings, the agent enrolment,
 * dependency edges and the monitoring carry all behave identically — then
 * resolves the conflict.
 *
 * Field winners are deliberately NOT accepted here: this surface exists to
 * clear a duplicate address, and the blank-fill default is what every other
 * automatic absorb uses. Per-field control lives on the asset's Sources tab,
 * which is what the card's confirm text points at.
 *
 * `Conflict.assetId` is re-pointed at the survivor BEFORE the first merge —
 * deleting an absorbed asset CASCADES to conflicts pointing at it, which would
 * otherwise destroy this row mid-operation (and with it the audit trail of how
 * the duplicate was resolved).
 */
export async function mergeDuplicateIpAssets(
  conflict: { id: string; assetId: string | null; proposedAssetFields: unknown },
  survivorAssetId: string,
  rawAbsorbIds: string[],
  actor?: string,
): Promise<MergeDuplicateIpOutcome> {
  const proposed = (conflict.proposedAssetFields || {}) as Record<string, unknown>;
  if (proposed.collisionReason !== DUPLICATE_IP_COLLISION_REASON) {
    throw new AppError(400, "This conflict is not a duplicate IP address conflict");
  }
  const ip = conflictIpOf(conflict);
  if (!ip) throw new AppError(500, "Duplicate IP conflict is missing its address");

  const members = conflictMembersOf(conflict);
  const absorbIds = resolveMergeTargets(members, survivorAssetId, rawAbsorbIds);

  const labelOf = (id: string) =>
    members.find((m) => m.assetId === id)?.hostname || id;
  const survivorLabel = labelOf(survivorAssetId);

  // Keep the conflict row alive across the deletes (see the header note).
  if (conflict.assetId !== survivorAssetId) {
    await prisma.conflict.update({
      where: { id: conflict.id },
      data: { assetId: survivorAssetId },
    });
  }

  let movedSources = 0;
  const absorbed: string[] = [];
  for (const ghostId of absorbIds) {
    const ghostLabel = labelOf(ghostId);
    const result = await mergeAssets({ canonicalId: survivorAssetId, ghostId });
    movedSources += result.movedSources;
    absorbed.push(result.absorbedId);
    logEvent({
      action: "asset.merged",
      resourceType: "asset",
      resourceId: result.survivorId,
      resourceName: survivorLabel,
      actor,
      level: "info",
      message:
        `Merged asset ${ghostLabel} into ${survivorLabel} — resolving duplicate address ${ip}; ` +
        `moved ${result.movedSources} source(s)` +
        (result.carriedMonitoring ? "; monitoring carried over from the absorbed asset" : "") +
        (result.movedDependents > 0 ? `; re-pointed ${result.movedDependents} dependent device(s)` : "") +
        (result.movedDependencyParents > 0 ? `; carried ${result.movedDependencyParents} dependency parent link(s)` : ""),
      details: {
        survivorId: result.survivorId,
        absorbedId: result.absorbedId,
        duplicateIp: ip,
        collisionReason: DUPLICATE_IP_COLLISION_REASON,
        carriedMonitoring: result.carriedMonitoring,
        monitorFieldsAdopted: result.monitorFieldsAdopted,
        movedSources: result.movedSources,
        movedMacs: result.movedMacs,
        movedIps: result.movedIps,
        movedIpHistory: result.movedIpHistory,
        movedSightings: result.movedSightings,
        movedManagedAgent: result.movedManagedAgent,
        movedDependencyParents: result.movedDependencyParents,
        replacedDependencyParents: result.replacedDependencyParents,
        movedDependents: result.movedDependents,
        appliedFields: result.appliedFields,
      },
    });
  }

  const group = await evaluateIp(ip);
  const remaining = group ? group.members.length : 0;
  if (!group) {
    await prisma.conflict.update({
      where: { id: conflict.id },
      data: { status: "accepted", resolvedBy: actor ?? null, resolvedAt: new Date() },
    });
    logEvent({
      action: "conflict.accepted",
      resourceType: "asset",
      resourceId: survivorAssetId,
      resourceName: ip,
      actor,
      message:
        `Duplicate IP conflict on ${ip} resolved by merge — ${absorbed.length} duplicate record(s) absorbed into "${survivorLabel}"`,
      details: {
        collisionReason: DUPLICATE_IP_COLLISION_REASON,
        ipAddress: ip,
        survivorAssetId,
        absorbedAssetIds: absorbed,
      },
    });
    return { ipAddress: ip, survivorAssetId, absorbedAssetIds: absorbed, movedSources, resolved: true, remaining };
  }

  // A member of a 3+ collision was left standing — keep the conflict open on
  // whoever still claims the address.
  const survivors = group.members.map(toStoredMember);
  await prisma.conflict.update({
    where: { id: conflict.id },
    data: {
      proposedAssetFields: {
        collisionReason: DUPLICATE_IP_COLLISION_REASON,
        ipAddress: ip,
        hostname: group.members[0]?.hostname ?? null,
        members: survivors,
      } as any,
      existingAssetSnapshot: { ipAddress: ip, members: survivors } as any,
    },
  });
  return { ipAddress: ip, survivorAssetId, absorbedAssetIds: absorbed, movedSources, resolved: false, remaining };
}

/** Audit copy for a dismissal — the resolution engine marks the row itself. */
export function duplicateIpRejectMessage(conflict: { proposedAssetFields: unknown }): string {
  const ip = conflictIpOf(conflict) ?? "unknown";
  const members = conflictMembersOf(conflict);
  const names = members.map((m) => m.hostname || m.assetId).join(", ") || "the assets involved";
  return `Duplicate IP conflict on ${ip} dismissed — ${names} keep the address (the same set won't re-raise)`;
}

export function logDuplicateIpDismissal(
  conflict: { id: string; assetId: string | null; proposedAssetFields: unknown },
  actor?: string,
): void {
  logEvent({
    action: "conflict.rejected",
    resourceType: "asset",
    resourceId: conflict.assetId ?? undefined,
    resourceName: conflictIpOf(conflict) ?? undefined,
    actor,
    message: duplicateIpRejectMessage(conflict),
    details: { collisionReason: DUPLICATE_IP_COLLISION_REASON, ipAddress: conflictIpOf(conflict) },
  });
}

/** Used by the job wrapper so a scan failure logs once with context. */
export function logScanFailure(err: unknown): void {
  logger.warn(
    { err: err instanceof Error ? err.message : String(err) },
    "duplicate-ip conflict reconcile failed (will retry next cycle)",
  );
}
