/**
 * src/services/subnetChassisConflictService.ts — the `chassis-replaced`
 * Conflict flavour: the FortiGate serving a subnet is not the one that used to
 * (business rule 41).
 *
 * The first `entityType="subnet"` Conflict variant. See the header of
 * conflictResolutionService.ts for the full variant table.
 *
 * WHAT IT REPORTS
 * A discovered subnet stores the chassis SERIAL of the gate that serves it
 * (`Subnet.fortigateSerial`). When a run answers with a serial that is neither
 * the stored one nor any member of that device's HA cluster, the physical box
 * was swapped. Two very different things used to look identical here, because
 * the only stored identity was the gate's NAME:
 *
 *   • NEW NAME, new serial — the gate left FMG's roster, so the subnet was
 *     deprecated and (before the archive) its CIDR could never be re-created.
 *     Discovery skipped the replacement's identical subnets on every run.
 *   • SAME NAME, new serial — an RMA or warranty swap, which normally reuses
 *     the name. Nothing fired at all: the CIDR matched, the name matched the
 *     roster, and the new chassis silently inherited every reservation row of
 *     the old one, `pushStatus: "synced"` included, with each pushed row's
 *     `pushedScopeId` / `pushedEntryId` still addressing a DHCP entry inside a
 *     scope on a box that no longer exists. Nothing looked wrong, which is what
 *     made it worse than the first case.
 *
 * Serial identity is also what finally separates a RENAME from a REPLACEMENT —
 * the ambiguity underneath both failures. Same serial + new name is a rename
 * and re-points silently; a new serial raises this.
 *
 * WHAT IT DELIBERATELY DOES NOT DO (yet)
 * Raising is ADDITIVE. The old chassis's subnet + reservations are COPIED into
 * the archive (`snapshotSubnet`) and the live rows are left exactly as they
 * are. Nothing is deleted, released or re-pushed on the strength of an
 * automatic detection, so the worst a false positive can cost is one card and
 * one archive row. Per-line migration onto the new gate — the part that writes
 * — is the second phase and lives behind an explicit operator action.
 *
 * LIFECYCLE
 *   raise      — one pending Conflict per SUBNET, keyed on the (old, new)
 *                serial pair. Stamps a `conflict.detected` Event.
 *   refresh    — a later run re-stamps the same pending row rather than
 *                stacking duplicates (the duplicateIpConflictService pattern).
 *   accept     — `acceptChassisReplacement`: yes, the box was replaced. Stamps
 *                the new serial onto the subnet, so the next run reads `same`
 *                and nothing re-raises. The conflict's own status is stamped by
 *                conflictResolutionService's dispatcher, as for every other
 *                variant.
 *   reject     — dismiss. The rejected row is the dedup marker: the SAME serial
 *                pair never re-raises, a different one does.
 *
 * The stored serial is deliberately NOT re-pointed at raise time. While the
 * conflict is pending, `Subnet.fortigateSerial` still names the chassis Polaris
 * last agreed served this space, which is what keeps the detection derivable
 * from the subnet row itself rather than dependent on the conflict row
 * surviving. Accept is what moves it.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { normalizeSerial } from "../utils/chassisIdentity.js";
import { DEVICE_OWNED_SOURCE_TYPES } from "./reservationService.js";
import { getArchivedSubnet } from "./subnetArchiveService.js";

export const CHASSIS_REPLACED_COLLISION_REASON = "chassis-replaced";

/** Prisma filter matching this feature's conflicts. */
const CHASSIS_CONFLICT_WHERE = {
  entityType: "subnet",
  proposedSubnetFields: {
    path: ["collisionReason"],
    equals: CHASSIS_REPLACED_COLLISION_REASON,
  },
} as const;

/** The identity facts stored on the Conflict row. */
export interface ChassisReplacedPayload {
  collisionReason: typeof CHASSIS_REPLACED_COLLISION_REASON;
  cidr: string;
  blockId: string;
  oldSerial: string;
  newSerial: string;
  oldDeviceName: string | null;
  newDeviceName: string | null;
  /** ArchivedSubnet row holding the old chassis's subnet + reservations. */
  archivedSubnetId: string;
}

// ─── The per-address diff ────────────────────────────────────────────────────
//
// Computed ON READ rather than snapshotted into the Conflict row, because of
// discovery's phase order: Phase 1 syncs subnets and Phases 3–5 write
// reservations, so at detection time the live rows are still the OLD chassis's
// and a payload built then would compare old against old. Reading it live also
// means the card can never show a diff that has since gone stale.

/** One reservation as either side of the diff reports it. */
export interface DiffSide {
  ipAddress: string | null;
  hostname: string | null;
  macAddress: string | null;
  owner: string | null;
  sourceType: string;
  status: string;
  notes: string | null;
  projectRef: string | null;
}

export type LineVerdict = "only-old" | "only-new" | "differs" | "same";

export interface ChassisDiffLine {
  /** Address, or null for a full-subnet reservation. */
  ip: string | null;
  verdict: LineVerdict;
  old: DiffSide | null;
  new: DiffSide | null;
  /**
   * Whether an operator may carry the OLD line onto the new gate. False when
   * there is no old line, and false for a device-owned row (`vip` /
   * `interface_ip`) — the new gate's own config states those, so writing
   * Polaris's memory of the dead box over them would be backwards.
   */
  migratable: boolean;
  /** Present when `migratable` is false and an old line exists. */
  notMigratableReason?: "device-owned";
}

/** Fields whose disagreement makes a line `differs` rather than `same`. */
const COMPARED_FIELDS: Array<keyof DiffSide> = [
  "hostname",
  "macAddress",
  "owner",
  "sourceType",
  "notes",
  "projectRef",
];

/** Full-subnet reservations carry a null ipAddress; they still need a key. */
const FULL_SUBNET_KEY = "__full__";
const lineKey = (ip: string | null): string => ip ?? FULL_SUBNET_KEY;

/**
 * Pure per-address diff of two reservation sets. Exported for tests and so the
 * verdict rules live in exactly one place.
 */
export function diffReservationLines(
  oldRows: readonly DiffSide[],
  newRows: readonly DiffSide[],
): ChassisDiffLine[] {
  const oldByKey = new Map<string, DiffSide>();
  for (const r of oldRows) oldByKey.set(lineKey(r.ipAddress), r);
  const newByKey = new Map<string, DiffSide>();
  for (const r of newRows) newByKey.set(lineKey(r.ipAddress), r);

  const keys = Array.from(new Set([...oldByKey.keys(), ...newByKey.keys()])).sort();
  const out: ChassisDiffLine[] = [];

  for (const k of keys) {
    const o = oldByKey.get(k) ?? null;
    const n = newByKey.get(k) ?? null;
    const ip = (o?.ipAddress ?? n?.ipAddress) ?? null;

    let verdict: LineVerdict;
    if (o && !n) verdict = "only-old";
    else if (!o && n) verdict = "only-new";
    else if (o && n) {
      verdict = COMPARED_FIELDS.every((f) => (o[f] ?? null) === (n[f] ?? null)) ? "same" : "differs";
    } else continue; // unreachable — a key comes from one side or the other

    const deviceOwned = !!o && DEVICE_OWNED_SOURCE_TYPES.has(o.sourceType);
    const migratable = !!o && !deviceOwned;
    out.push({
      ip,
      verdict,
      old: o,
      new: n,
      migratable,
      ...(o && deviceOwned ? { notMigratableReason: "device-owned" as const } : {}),
    });
  }
  return out;
}

const toDiffSide = (r: {
  ipAddress: string | null;
  hostname: string | null;
  macAddress: string | null;
  owner: string | null;
  sourceType: string;
  status: string;
  notes: string | null;
  projectRef: string | null;
}): DiffSide => ({
  ipAddress: r.ipAddress,
  hostname: r.hostname,
  macAddress: r.macAddress,
  owner: r.owner,
  sourceType: String(r.sourceType),
  status: String(r.status),
  notes: r.notes,
  projectRef: r.projectRef,
});

/**
 * The diff for one pending chassis conflict: the archived (old chassis) rows
 * against the live subnet's rows as they stand now.
 */
export async function buildChassisDiff(conflict: {
  subnetId: string | null;
  proposedSubnetFields: unknown;
}): Promise<{ payload: ChassisReplacedPayload; lines: ChassisDiffLine[] }> {
  const payload = conflict.proposedSubnetFields as ChassisReplacedPayload | null;
  if (!payload?.archivedSubnetId) {
    throw new AppError(409, "This conflict carries no archived chassis snapshot to compare against");
  }
  const archived = await getArchivedSubnet(payload.archivedSubnetId);

  // The live subnet may be gone (archived, or its block deleted) — an empty
  // "new" side is a legitimate answer, not an error.
  const live = conflict.subnetId
    ? await prisma.reservation.findMany({
        where: { subnetId: conflict.subnetId },
        select: {
          ipAddress: true, hostname: true, macAddress: true, owner: true,
          sourceType: true, status: true, notes: true, projectRef: true,
        },
      })
    : [];

  return {
    payload,
    lines: diffReservationLines(archived.reservations.map(toDiffSide), live.map(toDiffSide)),
  };
}

// ─── Raise / refresh ─────────────────────────────────────────────────────────

export interface RaiseChassisConflictInput {
  subnetId: string;
  cidr: string;
  blockId: string;
  oldSerial: string;
  newSerial: string;
  oldDeviceName?: string | null;
  newDeviceName?: string | null;
  archivedSubnetId: string;
  integrationId?: string | null;
  integrationName?: string | null;
  actor?: string | null;
}

export type RaiseOutcome = "raised" | "refreshed" | "suppressed";

/**
 * Create or refresh the pending conflict for one replaced chassis.
 *
 * Dedup is keyed on the (oldSerial, newSerial) pair, not just the subnet: a
 * pending row for the same pair is refreshed, a REJECTED row for the same pair
 * suppresses re-raise (the operator dismissed exactly this transition), and a
 * different pair — the box was swapped twice — raises anew.
 */
export async function raiseChassisReplacedConflict(
  input: RaiseChassisConflictInput,
): Promise<RaiseOutcome> {
  const oldSerial = normalizeSerial(input.oldSerial);
  const newSerial = normalizeSerial(input.newSerial);
  if (!oldSerial || !newSerial || oldSerial === newSerial) return "suppressed";

  const existing = await prisma.conflict.findMany({
    where: {
      ...CHASSIS_CONFLICT_WHERE,
      subnetId: input.subnetId,
      status: { in: ["pending", "rejected"] },
    },
    select: { id: true, status: true, proposedSubnetFields: true },
  });

  const samePair = existing.filter((c) => {
    const p = c.proposedSubnetFields as ChassisReplacedPayload | null;
    return normalizeSerial(p?.oldSerial) === oldSerial && normalizeSerial(p?.newSerial) === newSerial;
  });

  if (samePair.some((c) => c.status === "rejected")) return "suppressed";

  const payload: ChassisReplacedPayload = {
    collisionReason: CHASSIS_REPLACED_COLLISION_REASON,
    cidr: input.cidr,
    blockId: input.blockId,
    oldSerial,
    newSerial,
    oldDeviceName: input.oldDeviceName ?? null,
    newDeviceName: input.newDeviceName ?? null,
    archivedSubnetId: input.archivedSubnetId,
  };

  const pending = samePair.find((c) => c.status === "pending");
  if (pending) {
    await prisma.conflict.update({
      where: { id: pending.id },
      data: { proposedSubnetFields: payload as any, integrationId: input.integrationId ?? undefined },
    });
    return "refreshed";
  }

  await prisma.conflict.create({
    data: {
      entityType: "subnet",
      subnetId: input.subnetId,
      integrationId: input.integrationId ?? undefined,
      conflictFields: ["fortigateSerial"],
      proposedSubnetFields: payload as any,
    },
  });

  void logEvent({
    level: "warning",
    action: "conflict.detected",
    resourceType: "subnet",
    resourceId: input.subnetId,
    resourceName: input.cidr,
    actor: input.actor ?? "system",
    message:
      `Subnet ${input.cidr} is now served by a different FortiGate chassis — ` +
      `serial ${oldSerial} replaced by ${newSerial}` +
      (input.newDeviceName ? ` (device "${input.newDeviceName}")` : "") +
      `. Its previous reservations are archived for review.`,
    details: { ...payload, integrationName: input.integrationName ?? null },
  });

  return "raised";
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Accept the replacement: stamp the new chassis serial onto the live subnet and
 * close the conflict. The next discovery pass then reads `same` and nothing
 * re-raises. Reservation migration is a separate, explicit action.
 */
export async function acceptChassisReplacement(conflict: any, actor?: string): Promise<void> {
  const payload = conflict.proposedSubnetFields as ChassisReplacedPayload | null;
  if (!payload) throw new AppError(409, "This conflict carries no chassis payload");
  if (!conflict.subnetId) throw new AppError(409, "This conflict's subnet no longer exists");

  await prisma.subnet.update({
    where: { id: conflict.subnetId },
    data: { fortigateSerial: payload.newSerial },
  });
  void logEvent({
    action: "subnet.chassis.adopted",
    resourceType: "subnet",
    resourceId: conflict.subnetId,
    resourceName: payload.cidr,
    actor,
    message:
      `Subnet ${payload.cidr} adopted FortiGate chassis ${payload.newSerial} ` +
      `(was ${payload.oldSerial})`,
    details: { ...payload },
  });
}

/**
 * Dismiss. The rejected row is the dedup marker for this exact serial pair, so
 * the same transition never re-raises while a later, different swap still does.
 */
export async function rejectChassisReplacement(conflict: any, actor?: string): Promise<void> {
  const payload = conflict.proposedSubnetFields as ChassisReplacedPayload | null;
  void logEvent({
    action: "subnet.chassis.dismissed",
    resourceType: "subnet",
    resourceId: conflict.subnetId ?? undefined,
    resourceName: payload?.cidr,
    actor,
    message: payload
      ? `Chassis-replacement conflict for ${payload.cidr} dismissed (${payload.oldSerial} → ${payload.newSerial})`
      : "Chassis-replacement conflict dismissed",
    details: payload ? { ...payload } : undefined,
  });
}

/** Pending chassis conflicts, newest first — for the review surface. */
export async function listChassisConflicts(limit = 50) {
  return prisma.conflict.findMany({
    where: { ...CHASSIS_CONFLICT_WHERE, status: "pending" },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    include: { subnet: { select: { id: true, cidr: true, name: true, fortigateDevice: true } } },
  });
}
