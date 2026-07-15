/**
 * src/services/maintenanceScheduleService.ts
 *
 * Maintenance schedules: operator-defined windows during which matched
 * monitored assets are put into maintenance mode — `Asset.status` is flipped
 * to "maintenance" (prior status parked in `maintenanceReturnStatus`, restored
 * on exit), which stops all server-driven polling (the monitor candidate
 * queries exclude it), makes the asset count as "down" for child dependency
 * suppression, and silences notifications.
 *
 * State model: one open `AssetMaintenanceWindow` row per (asset, schedule)
 * while that schedule holds the asset in maintenance. Open rows are the
 * source of truth — an asset is "in maintenance" iff it has ≥1 open row, it
 * enters when it gains its first and exits when it loses its last, and a
 * restart recovers for free (the first reconcile tick re-derives everything
 * from open rows + `maintenanceReturnStatus`). Closed rows are kept as
 * history for the chart maintenance bands.
 *
 * `reconcileMaintenance()` runs every 30s from src/jobs/maintenanceScheduler.ts
 * and inline after every schedule mutation (so an ad-hoc "enter maintenance
 * now" takes effect immediately). Targets = union(criteria matches, explicit
 * assetIds) ∩ monitored=true; criteria reuse the tagAssignmentService engine
 * (hostname/model/manufacturer/os contains/pattern, subnet inCidr, assetType).
 *
 * Operator interplay: an operator PUT that moves status off "maintenance"
 * while windows are open goes through `operatorReleaseAsset()` (called from
 * the assets route BEFORE the write) — the operator wins, and the
 * `endReason: "operator"` rows suppress re-entry for the current occurrence
 * of each schedule. A SYSTEM writer that clobbers status mid-window (a
 * discovery path not yet guarded) is self-healed: the reconcile re-flips to
 * "maintenance" and absorbs the clobbered value into `maintenanceReturnStatus`
 * so exit restores what the system writer wanted.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent, logEventsBatch } from "./eventLogService.js";
import {
  normalizeCriteria,
  resolveMatchingAssetIds,
  type TagCriteria,
} from "./tagAssignmentService.js";
import {
  validateScheduleShape,
  isInWindow,
  currentWindow,
  nextWindow,
  type MaintenanceScheduleShape,
} from "../utils/maintenanceRecurrence.js";

const SYSTEM_ACTOR = "system:maintenance";
const PREVIEW_CAP = 50;
/** Closed window rows older than this are pruned by the reconcile tick. */
const HISTORY_RETENTION_DAYS = 400;

// ─── Input validation ────────────────────────────────────────────────────────

export interface MaintenanceScheduleInput {
  name: string;
  enabled?: boolean;
  criteria?: unknown;
  assetIds?: string[];
  // Optional at the type level (z.unknown() infers optional); normalizeInput
  // rejects a missing/invalid shape with a 400.
  schedule?: unknown;
}

interface NormalizedInput {
  name: string;
  enabled: boolean;
  criteria: TagCriteria | null;
  assetIds: string[];
  schedule: MaintenanceScheduleShape;
}

function normalizeInput(input: MaintenanceScheduleInput): NormalizedInput {
  const name = String(input.name ?? "").trim();
  if (!name) throw new AppError(400, "Schedule name is required");
  if (name.length > 200) throw new AppError(400, "Schedule name must be 200 characters or fewer");

  let schedule: MaintenanceScheduleShape;
  try {
    schedule = validateScheduleShape(input.schedule);
  } catch (err: any) {
    const first = err?.issues?.[0];
    throw new AppError(400, `Invalid schedule: ${first?.message ?? "malformed recurrence shape"}`);
  }

  const criteria = normalizeCriteria(input.criteria ?? null);
  if (criteria && criteria.rules.some((r) => r.field === "status")) {
    // Maintenance itself flips status — a status rule would make membership
    // oscillate (asset enters → status becomes "maintenance" → rule stops
    // matching → asset exits → …).
    throw new AppError(400, "Maintenance criteria cannot filter on status");
  }

  const assetIds = Array.from(
    new Set((input.assetIds ?? []).map((id) => String(id).trim()).filter((id) => id.length > 0)),
  );
  if (!criteria && assetIds.length === 0) {
    throw new AppError(400, "Schedule must target at least one asset (criteria or explicit assets)");
  }

  return { name, enabled: input.enabled !== false, criteria, assetIds, schedule };
}

/** Parse a stored schedule blob defensively; null (+ warn) on mismatch. */
function parseStoredShape(row: { id: string; name: string; schedule: unknown }): MaintenanceScheduleShape | null {
  try {
    return validateScheduleShape(row.schedule);
  } catch {
    logger.warn({ scheduleId: row.id, name: row.name }, "maintenance schedule has invalid recurrence shape; skipping");
    return null;
  }
}

// ─── Target resolution ───────────────────────────────────────────────────────

const TARGET_SELECT = {
  id: true,
  hostname: true,
  ipAddress: true,
  model: true,
  manufacturer: true,
  status: true,
  maintenanceReturnStatus: true,
} as const;

type TargetAsset = {
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  model: string | null;
  manufacturer: string | null;
  status: string;
  maintenanceReturnStatus: string | null;
};

/**
 * Resolve the assets a (criteria, assetIds) pair currently targets:
 * union(criteria matches, explicit ids) ∩ monitored=true. Only monitored
 * assets can be in maintenance — there is nothing to pause otherwise, and it
 * keeps the filter preview honest.
 */
async function resolveTargetAssets(
  criteria: TagCriteria | null,
  assetIds: string[],
): Promise<TargetAsset[]> {
  const union = new Set<string>(assetIds);
  if (criteria) {
    for (const id of await resolveMatchingAssetIds(criteria)) union.add(id);
  }
  if (union.size === 0) return [];
  return prisma.asset.findMany({
    where: { id: { in: Array.from(union) }, monitored: true },
    select: TARGET_SELECT,
  }) as Promise<TargetAsset[]>;
}

export interface MaintenancePreview {
  total: number;
  assets: Array<{
    id: string;
    hostname: string | null;
    ipAddress: string | null;
    model: string | null;
    manufacturer: string | null;
  }>;
}

/** Dry-run the target filter for the builder's live device-list preview. */
export async function previewTargets(input: {
  criteria?: unknown;
  assetIds?: string[];
}): Promise<MaintenancePreview> {
  const criteria = normalizeCriteria(input.criteria ?? null);
  if (criteria && criteria.rules.some((r) => r.field === "status")) {
    throw new AppError(400, "Maintenance criteria cannot filter on status");
  }
  const assetIds = (input.assetIds ?? []).map((id) => String(id)).filter(Boolean);
  const targets = await resolveTargetAssets(criteria, assetIds);
  targets.sort((a, b) => (a.hostname ?? "").localeCompare(b.hostname ?? ""));
  return {
    total: targets.length,
    assets: targets.slice(0, PREVIEW_CAP).map(({ id, hostname, ipAddress, model, manufacturer }) => ({
      id, hostname, ipAddress, model, manufacturer,
    })),
  };
}

// ─── Schedule CRUD ───────────────────────────────────────────────────────────

export async function listSchedules() {
  return prisma.maintenanceSchedule.findMany({ orderBy: { createdAt: "desc" } });
}

export async function getSchedule(id: string) {
  const row = await prisma.maintenanceSchedule.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Maintenance schedule not found");
  return row;
}

export async function createSchedule(input: MaintenanceScheduleInput, actor?: string) {
  const n = normalizeInput(input);
  const row = await prisma.maintenanceSchedule.create({
    data: {
      name: n.name,
      enabled: n.enabled,
      criteria: (n.criteria ?? undefined) as any,
      assetIds: n.assetIds,
      schedule: n.schedule as any,
      createdBy: actor ?? null,
    },
  });
  await logEvent({
    action: "maintenance_schedule.created",
    resourceType: "maintenance-schedule",
    resourceId: row.id,
    resourceName: row.name,
    actor,
    message: `Maintenance schedule "${row.name}" created (${n.schedule.kind})`,
    details: { kind: n.schedule.kind, enabled: n.enabled },
  });
  await reconcileMaintenance();
  return row;
}

export async function updateSchedule(id: string, input: MaintenanceScheduleInput, actor?: string) {
  await getSchedule(id); // 404 if missing
  const n = normalizeInput(input);
  const row = await prisma.maintenanceSchedule.update({
    where: { id },
    data: {
      name: n.name,
      enabled: n.enabled,
      criteria: (n.criteria ?? null) as any,
      assetIds: n.assetIds,
      schedule: n.schedule as any,
    },
  });
  await logEvent({
    action: "maintenance_schedule.updated",
    resourceType: "maintenance-schedule",
    resourceId: row.id,
    resourceName: row.name,
    actor,
    message: `Maintenance schedule "${row.name}" updated`,
    details: { kind: n.schedule.kind, enabled: n.enabled },
  });
  await reconcileMaintenance();
  return row;
}

export async function deleteSchedule(id: string, actor?: string) {
  const row = await getSchedule(id);
  await prisma.maintenanceSchedule.delete({ where: { id } });
  await logEvent({
    action: "maintenance_schedule.deleted",
    resourceType: "maintenance-schedule",
    resourceId: id,
    resourceName: row.name,
    actor,
    message: `Maintenance schedule "${row.name}" deleted`,
  });
  // Open rows now have scheduleId=null (SetNull) — the reconcile closes them
  // ("deleted") and restores statuses.
  await reconcileMaintenance();
}

// ─── Per-asset reads ─────────────────────────────────────────────────────────

/** Window rows overlapping [since, until] — powers the chart maintenance bands. */
export async function listAssetWindows(assetId: string, since: Date, until: Date) {
  return prisma.assetMaintenanceWindow.findMany({
    where: {
      assetId,
      startedAt: { lte: until },
      OR: [{ endedAt: null }, { endedAt: { gte: since } }],
    },
    orderBy: { startedAt: "asc" },
    select: { id: true, scheduleId: true, scheduleName: true, startedAt: true, endedAt: true, endReason: true },
  });
}

export interface AssetMaintenanceInfo {
  inMaintenance: boolean;
  returnStatus: string | null;
  openWindows: Array<{
    id: string;
    scheduleId: string | null;
    scheduleName: string;
    startedAt: Date;
    /** Predicted end of the current occurrence (null when not derivable). */
    until: Date | null;
  }>;
  /** Schedules whose target filter currently includes this asset. */
  schedules: Array<{
    id: string;
    name: string;
    enabled: boolean;
    activeNow: boolean;
    nextStart: Date | null;
    nextEnd: Date | null;
  }>;
}

/**
 * The edit-modal / slide-over bundle: current windows + every schedule that
 * covers this asset. Evaluates each schedule's filter against the one asset —
 * fine at single-asset cost, schedule counts are notification-rule-sized.
 */
export async function getAssetMaintenanceInfo(assetId: string): Promise<AssetMaintenanceInfo> {
  const [asset, open, schedules] = await Promise.all([
    prisma.asset.findUnique({
      where: { id: assetId },
      select: { id: true, status: true, maintenanceReturnStatus: true, monitored: true },
    }),
    prisma.assetMaintenanceWindow.findMany({
      where: { assetId, endedAt: null },
      orderBy: { startedAt: "asc" },
      select: { id: true, scheduleId: true, scheduleName: true, startedAt: true },
    }),
    prisma.maintenanceSchedule.findMany({ orderBy: { name: "asc" } }),
  ]);
  if (!asset) throw new AppError(404, "Asset not found");

  const now = new Date();
  const shapeById = new Map<string, MaintenanceScheduleShape>();
  const covering: AssetMaintenanceInfo["schedules"] = [];

  for (const s of schedules) {
    const shape = parseStoredShape(s);
    if (!shape) continue;
    shapeById.set(s.id, shape);
    let covers = s.assetIds.includes(assetId);
    if (!covers && s.criteria) {
      const criteria = s.criteria as unknown as TagCriteria;
      covers = (await resolveMatchingAssetIds(criteria)).has(assetId);
    }
    // Unmonitored assets can never be targeted (targets ∩ monitored=true),
    // so covering schedules are only reported for monitored assets.
    if (!covers || !asset.monitored) continue;
    const next = nextWindow(shape, now);
    covering.push({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      activeNow: s.enabled && isInWindow(shape, now),
      nextStart: next?.start ?? null,
      nextEnd: next?.end ?? null,
    });
  }

  return {
    inMaintenance: open.length > 0,
    returnStatus: asset.maintenanceReturnStatus,
    openWindows: open.map((w) => {
      const shape = w.scheduleId ? shapeById.get(w.scheduleId) : undefined;
      const occ = shape ? currentWindow(shape, now) : null;
      return {
        id: w.id,
        scheduleId: w.scheduleId,
        scheduleName: w.scheduleName,
        startedAt: w.startedAt,
        until: occ?.end ?? null,
      };
    }),
    schedules: covering,
  };
}

/**
 * Operator ends maintenance on one asset (called from the assets PUT route
 * BEFORE applying an operator status write that moves off "maintenance").
 * Closes every open window (endReason "operator" — suppresses scheduler
 * re-entry for each schedule's current occurrence) and clears the parked
 * return status. Deliberately does NOT write status: the operator's own
 * incoming value wins.
 */
export async function operatorReleaseAsset(assetId: string, actor?: string): Promise<boolean> {
  const open = await prisma.assetMaintenanceWindow.findMany({
    where: { assetId, endedAt: null },
    select: { id: true, scheduleName: true },
  });
  if (open.length === 0) return false;
  const now = new Date();
  await prisma.$transaction([
    prisma.assetMaintenanceWindow.updateMany({
      where: { id: { in: open.map((w) => w.id) } },
      data: { endedAt: now, endReason: "operator" },
    }),
    prisma.asset.update({ where: { id: assetId }, data: { maintenanceReturnStatus: null } }),
  ]);
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true } });
  await logEvent({
    action: "maintenance.exited",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: asset?.hostname ?? assetId,
    actor,
    message: `Maintenance ended by operator (${open.map((w) => w.scheduleName).join(", ")})`,
    details: { reason: "operator", schedules: open.map((w) => w.scheduleName) },
  });
  return true;
}

// ─── Reconcile ───────────────────────────────────────────────────────────────

// Serialized + coalesced: an in-flight run never overlaps another, and a call
// made during a run (a CRUD mutation racing the 30s tick) queues exactly one
// follow-up so the mutation is guaranteed to be reflected by a run that
// STARTED after it.
let inFlight: Promise<void> | null = null;
let followUp: Promise<void> | null = null;

export function reconcileMaintenance(): Promise<void> {
  if (inFlight) {
    if (!followUp) {
      followUp = inFlight
        .catch(() => {})
        .then(() => {
          followUp = null;
          return reconcileMaintenance();
        });
    }
    return followUp;
  }
  inFlight = runReconcile()
    .catch((err: any) => {
      logger.warn({ err: err?.message ?? String(err) }, "maintenance reconcile failed (non-fatal)");
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function runReconcile(): Promise<void> {
  const now = new Date();
  const schedules = await prisma.maintenanceSchedule.findMany();
  const scheduleById = new Map(schedules.map((s) => [s.id, s]));

  // Desired (asset, schedule) pairs for every schedule active RIGHT NOW.
  const desired = new Map<string, Set<string>>(); // scheduleId → assetIds
  const shapeById = new Map<string, MaintenanceScheduleShape>();
  for (const s of schedules) {
    const shape = parseStoredShape(s);
    if (!shape) continue;
    shapeById.set(s.id, shape);
    if (!s.enabled || !isInWindow(shape, now)) continue;
    const targets = await resolveTargetAssets(
      (s.criteria ?? null) as TagCriteria | null,
      s.assetIds,
    );
    desired.set(s.id, new Set(targets.map((t) => t.id)));
  }

  const openRows = await prisma.assetMaintenanceWindow.findMany({
    where: { endedAt: null },
    select: { id: true, assetId: true, scheduleId: true, scheduleName: true },
  });

  // ── Diff ──────────────────────────────────────────────────────────────────
  const toClose: Array<{ id: string; assetId: string; reason: string }> = [];
  const openPairs = new Set<string>(); // "assetId|scheduleId" for rows staying open
  for (const row of openRows) {
    const sched = row.scheduleId ? scheduleById.get(row.scheduleId) : undefined;
    if (!sched) {
      toClose.push({ id: row.id, assetId: row.assetId, reason: "deleted" });
    } else if (!sched.enabled) {
      toClose.push({ id: row.id, assetId: row.assetId, reason: "disabled" });
    } else if (!desired.has(sched.id)) {
      toClose.push({ id: row.id, assetId: row.assetId, reason: "schedule" });
    } else if (!desired.get(sched.id)!.has(row.assetId)) {
      toClose.push({ id: row.id, assetId: row.assetId, reason: "criteria" });
    } else {
      openPairs.add(`${row.assetId}|${row.scheduleId}`);
    }
  }

  // Candidate opens = desired pairs without an open row.
  const candidateOpens: Array<{ assetId: string; scheduleId: string }> = [];
  for (const [scheduleId, assetIds] of desired) {
    for (const assetId of assetIds) {
      if (!openPairs.has(`${assetId}|${scheduleId}`)) candidateOpens.push({ assetId, scheduleId });
    }
  }

  // Operator-release suppression: skip a candidate pair when the operator
  // ended maintenance during THIS occurrence of that schedule.
  let toOpen = candidateOpens;
  if (candidateOpens.length > 0) {
    const released = await prisma.assetMaintenanceWindow.findMany({
      where: {
        endReason: "operator",
        assetId: { in: Array.from(new Set(candidateOpens.map((c) => c.assetId))) },
        scheduleId: { in: Array.from(new Set(candidateOpens.map((c) => c.scheduleId))) },
        endedAt: { not: null },
      },
      select: { assetId: true, scheduleId: true, endedAt: true },
    });
    const latestRelease = new Map<string, number>();
    for (const r of released) {
      const key = `${r.assetId}|${r.scheduleId}`;
      const t = r.endedAt!.getTime();
      if ((latestRelease.get(key) ?? 0) < t) latestRelease.set(key, t);
    }
    toOpen = candidateOpens.filter((c) => {
      const releasedAt = latestRelease.get(`${c.assetId}|${c.scheduleId}`);
      if (releasedAt == null) return true;
      const occ = currentWindow(shapeById.get(c.scheduleId)!, now);
      return occ ? releasedAt < occ.start.getTime() : true;
    });
  }

  if (toClose.length === 0 && toOpen.length === 0) {
    await pruneOldWindows(now);
    return;
  }

  // Per-asset open-row accounting → who ENTERS (0 → >0) and who EXITS (>0 → 0).
  const beforeCount = new Map<string, number>();
  for (const row of openRows) beforeCount.set(row.assetId, (beforeCount.get(row.assetId) ?? 0) + 1);
  const afterCount = new Map<string, number>(beforeCount);
  for (const c of toClose) afterCount.set(c.assetId, (afterCount.get(c.assetId) ?? 0) - 1);
  for (const o of toOpen) afterCount.set(o.assetId, (afterCount.get(o.assetId) ?? 0) + 1);

  const entering = Array.from(afterCount.entries())
    .filter(([assetId, n]) => n > 0 && (beforeCount.get(assetId) ?? 0) === 0)
    .map(([assetId]) => assetId);
  const exiting = Array.from(afterCount.entries())
    .filter(([assetId, n]) => n <= 0 && (beforeCount.get(assetId) ?? 0) > 0)
    .map(([assetId]) => assetId);

  // ── Window-row writes (grouped) ───────────────────────────────────────────
  const closesByReason = new Map<string, string[]>();
  for (const c of toClose) {
    const list = closesByReason.get(c.reason) ?? [];
    list.push(c.id);
    closesByReason.set(c.reason, list);
  }
  const writes: any[] = [];
  for (const [reason, ids] of closesByReason) {
    writes.push(
      prisma.assetMaintenanceWindow.updateMany({
        where: { id: { in: ids } },
        data: { endedAt: now, endReason: reason },
      }),
    );
  }
  if (toOpen.length > 0) {
    writes.push(
      prisma.assetMaintenanceWindow.createMany({
        data: toOpen.map((o) => ({
          assetId: o.assetId,
          scheduleId: o.scheduleId,
          scheduleName: scheduleById.get(o.scheduleId)?.name ?? "(unknown)",
          startedAt: now,
        })),
      }),
    );
  }
  await prisma.$transaction(writes);

  // ── Status flips (grouped updateMany per target status) ──────────────────
  // ENTERS: park the current status and flip to maintenance. An asset the
  // operator had ALREADY set to "maintenance" parks "maintenance" verbatim —
  // exit restores the operator's manual state, no loop.
  if (entering.length > 0) {
    const rows = await prisma.asset.findMany({
      where: { id: { in: entering } },
      select: { id: true, status: true, hostname: true },
    });
    const byStatus = new Map<string, string[]>();
    for (const r of rows) {
      const list = byStatus.get(r.status) ?? [];
      list.push(r.id);
      byStatus.set(r.status, list);
    }
    await prisma.$transaction(
      Array.from(byStatus.entries()).map(([status, ids]) =>
        prisma.asset.updateMany({
          where: { id: { in: ids } },
          data: {
            status: "maintenance" as any,
            maintenanceReturnStatus: status as any,
            statusChangedAt: now,
            statusChangedBy: SYSTEM_ACTOR,
          },
        }),
      ),
    );
    const nameById = new Map(rows.map((r) => [r.id, r.hostname ?? r.id]));
    const openNamesByAsset = new Map<string, string[]>();
    for (const o of toOpen) {
      const list = openNamesByAsset.get(o.assetId) ?? [];
      list.push(scheduleById.get(o.scheduleId)?.name ?? "(unknown)");
      openNamesByAsset.set(o.assetId, list);
    }
    const schedNames = (assetId: string) => openNamesByAsset.get(assetId) ?? [];
    await logEventsBatch(
      entering.map((assetId) => ({
        action: "maintenance.entered",
        resourceType: "asset",
        resourceId: assetId,
        resourceName: nameById.get(assetId) ?? assetId,
        actor: SYSTEM_ACTOR,
        message: `Entered maintenance mode (${schedNames(assetId).join(", ") || "schedule"})`,
        details: { schedules: schedNames(assetId) },
      })),
    );
  }

  // EXITS: restore the parked status — but only when status is still
  // "maintenance" (an operator or guarded system writer that moved it since
  // is respected). The parked column is cleared for every exiting asset
  // either way (no longer scheduler-managed).
  if (exiting.length > 0) {
    const rows = await prisma.asset.findMany({
      where: { id: { in: exiting } },
      select: { id: true, status: true, maintenanceReturnStatus: true, hostname: true },
    });
    const restorable = rows.filter((r) => r.status === "maintenance");
    const byReturn = new Map<string, string[]>();
    for (const r of restorable) {
      const target = r.maintenanceReturnStatus ?? "active";
      const list = byReturn.get(target) ?? [];
      list.push(r.id);
      byReturn.set(target, list);
    }
    const others = rows.filter((r) => r.status !== "maintenance").map((r) => r.id);
    const txn: any[] = Array.from(byReturn.entries()).map(([status, ids]) =>
      prisma.asset.updateMany({
        where: { id: { in: ids } },
        data: {
          status: status as any,
          maintenanceReturnStatus: null,
          statusChangedAt: now,
          statusChangedBy: SYSTEM_ACTOR,
        },
      }),
    );
    if (others.length > 0) {
      txn.push(
        prisma.asset.updateMany({
          where: { id: { in: others } },
          data: { maintenanceReturnStatus: null },
        }),
      );
    }
    await prisma.$transaction(txn);
    await logEventsBatch(
      rows.map((r) => ({
        action: "maintenance.exited",
        resourceType: "asset",
        resourceId: r.id,
        resourceName: r.hostname ?? r.id,
        actor: SYSTEM_ACTOR,
        message:
          r.status === "maintenance"
            ? `Exited maintenance mode (status restored to ${r.maintenanceReturnStatus ?? "active"})`
            : "Exited maintenance mode (status left as-is — changed while in maintenance)",
        details: { restored: r.status === "maintenance", returnStatus: r.maintenanceReturnStatus },
      })),
    );
  }

  // ── Self-heal ─────────────────────────────────────────────────────────────
  // Assets that REMAIN in maintenance but whose status was clobbered by an
  // unguarded system writer: re-flip and absorb the clobbered value so exit
  // restores what that writer wanted. (Operator moves never land here — the
  // assets PUT route closes the windows synchronously first.)
  const enteringSet = new Set(entering);
  const staying = Array.from(afterCount.entries())
    .filter(([assetId, n]) => n > 0 && !enteringSet.has(assetId))
    .map(([assetId]) => assetId);
  await selfHealStatuses(staying, now);

  await pruneOldWindows(now);
}

/** Re-flip clobbered in-maintenance assets; absorb the clobbered status. */
async function selfHealStatuses(assetIds: string[], now: Date): Promise<void> {
  if (assetIds.length === 0) return;
  const clobbered = await prisma.asset.findMany({
    where: { id: { in: assetIds }, status: { not: "maintenance" as any } },
    select: { id: true, status: true, hostname: true },
  });
  if (clobbered.length === 0) return;
  const byStatus = new Map<string, string[]>();
  for (const r of clobbered) {
    const list = byStatus.get(r.status) ?? [];
    list.push(r.id);
    byStatus.set(r.status, list);
  }
  await prisma.$transaction(
    Array.from(byStatus.entries()).map(([status, ids]) =>
      prisma.asset.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "maintenance" as any,
          maintenanceReturnStatus: status as any,
          statusChangedAt: now,
          statusChangedBy: SYSTEM_ACTOR,
        },
      }),
    ),
  );
  logger.info(
    { count: clobbered.length },
    "maintenance self-heal: re-flipped assets whose status was changed by a system writer mid-window",
  );
}

async function pruneOldWindows(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.assetMaintenanceWindow.deleteMany({ where: { endedAt: { lt: cutoff } } });
}
