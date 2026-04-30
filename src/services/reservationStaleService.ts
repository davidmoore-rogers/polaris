/**
 * src/services/reservationStaleService.ts — Stale DHCP-reservation detection.
 *
 * The DHCP discovery sync stamps `Reservation.lastSeenLeased` whenever
 * /api/v2/monitor/system/dhcp confirms an IP is being actively held by a
 * client. The job below reads those timestamps and flags rows whose target
 * has either never been seen online or hasn't been seen in too long. Each
 * transition into "stale" emits one `reservation.stale` Event and stamps
 * `staleNotifiedAt` so the alert doesn't refire daily.
 *
 * The discovery sync clears `staleNotifiedAt` whenever it sees the IP active
 * again, so a reservation that comes back online and then goes silent
 * later will re-arm the alert cleanly.
 *
 * Threshold is admin-tunable via the `reservationStale` Setting
 * (`staleAfterDays`, default 60, 0 = disabled). The grace baseline below
 * absorbs the cold-start case: after the migration deploys, no rows have
 * `lastSeenLeased` populated yet, so we use `max(createdAt, detectionStartedAt)`
 * to avoid flooding the alert list with every existing dhcp_reservation row
 * before discovery has had a chance to populate the column.
 */

import { prisma } from "../db.js";
import { logEvent } from "../api/routes/events.js";

const SETTINGS_KEY = "reservationStale";
const DETECTION_STARTED_AT_KEY = "reservationStaleDetectionStartedAt";

// Defaults: 60 days threshold, alerts disabled until the operator opts in.
// 0 = disabled (no alerts emitted, no rows considered stale).
const DEFAULT_STALE_AFTER_DAYS = 60;

export interface ReservationStaleSettings {
  staleAfterDays: number;
}

export async function getStaleSettings(): Promise<ReservationStaleSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { staleAfterDays: DEFAULT_STALE_AFTER_DAYS };
  const val = row.value as Record<string, unknown>;
  const days = Number(val.staleAfterDays);
  return {
    staleAfterDays: Number.isFinite(days) && days >= 0 ? Math.floor(days) : DEFAULT_STALE_AFTER_DAYS,
  };
}

export async function updateStaleSettings(
  settings: Partial<ReservationStaleSettings>,
): Promise<ReservationStaleSettings> {
  const days = Number(settings.staleAfterDays);
  const merged: ReservationStaleSettings = {
    staleAfterDays: Number.isFinite(days) && days >= 0 ? Math.floor(days) : DEFAULT_STALE_AFTER_DAYS,
  };
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: merged as any },
    update: { value: merged as any },
  });
  return merged;
}

/**
 * Returns the cold-start detection baseline. On first call after migration,
 * stamps "now" so subsequent calls return the same timestamp — gives every
 * existing dhcp_reservation row a fresh `staleAfterDays` window before the
 * job can flag it, even if its createdAt predates the migration.
 */
async function getDetectionStartedAt(): Promise<Date> {
  const row = await prisma.setting.findUnique({ where: { key: DETECTION_STARTED_AT_KEY } });
  if (row) {
    const ts = (row.value as { startedAt?: string }).startedAt;
    if (ts) {
      const d = new Date(ts);
      if (!isNaN(d.getTime())) return d;
    }
  }
  const now = new Date();
  await prisma.setting.upsert({
    where: { key: DETECTION_STARTED_AT_KEY },
    create: { key: DETECTION_STARTED_AT_KEY, value: { startedAt: now.toISOString() } as any },
    update: { value: { startedAt: now.toISOString() } as any },
  });
  return now;
}

export interface ReservationAlertEntry {
  id: string;
  ipAddress: string | null;
  hostname: string | null;
  macAddress: string | null;
  subnetId: string;
  subnetCidr: string;
  subnetName: string;
  createdAt: Date;
  lastSeenLeased: Date | null;
  staleNotifiedAt: Date | null;
  daysSinceSeen: number; // since lastSeenLeased OR effective baseline
  fortigateDevice: string | null;
  pushedToId: string | null;
  pushedToName: string | null;
}

export interface SnoozeReservationResult {
  reservationId: string;
  snoozedUntil: Date;
  daysAdded: number;
}

/**
 * Push a stale-reservation alert out by `staleAfterDays` more days. Sets
 * `staleSnoozedUntil = now + staleAfterDays`. While that future, the row is
 * suppressed from listStaleReservations and the job won't re-fire. Discovery
 * clears the field if the IP comes back online before the snooze expires.
 *
 * Throws if the reservation is not an active dhcp_reservation row, or if
 * stale-detection is disabled (staleAfterDays === 0). Idempotent: snoozing
 * an already-snoozed row extends from "now" rather than from the current
 * snoozedUntil, so repeated clicks always give exactly one full window.
 */
export async function snoozeReservation(reservationId: string): Promise<SnoozeReservationResult> {
  const settings = await getStaleSettings();
  if (settings.staleAfterDays === 0) {
    const { AppError } = await import("../utils/errors.js");
    throw new AppError(409, "Stale-reservation detection is disabled — set a non-zero threshold before snoozing alerts");
  }
  const row = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { id: true, status: true, sourceType: true },
  });
  const { AppError } = await import("../utils/errors.js");
  if (!row) throw new AppError(404, `Reservation ${reservationId} not found`);
  if (row.status !== "active" || row.sourceType !== "dhcp_reservation") {
    throw new AppError(409, `Cannot snooze — reservation must be active and dhcp_reservation (status=${row.status}, sourceType=${row.sourceType})`);
  }

  const snoozedUntil = new Date(Date.now() + settings.staleAfterDays * 24 * 60 * 60 * 1000);
  await prisma.reservation.update({
    where: { id: reservationId },
    data: { staleSnoozedUntil: snoozedUntil, staleNotifiedAt: null },
  });
  return { reservationId, snoozedUntil, daysAdded: settings.staleAfterDays };
}

/**
 * List all currently-stale reservations. A row is stale when the threshold
 * is non-zero AND either (a) it has never been seen leased and the effective
 * baseline is older than the threshold, or (b) lastSeenLeased is older than
 * the threshold. The effective baseline is `max(createdAt, detectionStartedAt)`
 * — both conditions widen during the cold-start grace window.
 *
 * `mode` controls which rows are returned:
 *   "active"  — non-ignored stale rows (default; what the badge counts)
 *   "ignored" — rows the operator has set staleIgnored=true on, regardless
 *               of whether they're still stale by the threshold rule
 */
export async function listStaleReservations(
  mode: "active" | "ignored" = "active",
): Promise<ReservationAlertEntry[]> {
  const settings = await getStaleSettings();
  if (mode === "active" && settings.staleAfterDays === 0) return [];

  if (mode === "ignored") {
    // Just return every ignored dhcp_reservation regardless of threshold,
    // so the operator can review what they've silenced.
    const rows = await prisma.reservation.findMany({
      where: { status: "active", sourceType: "dhcp_reservation", staleIgnored: true },
      include: {
        subnet: { select: { id: true, cidr: true, name: true, fortigateDevice: true } },
        pushedTo: { select: { id: true, name: true } },
      },
      orderBy: [{ lastSeenLeased: "asc" }, { createdAt: "asc" }],
    });
    const nowMs = Date.now();
    return rows.map((r) => {
      const lastSignalMs = r.lastSeenLeased ? r.lastSeenLeased.getTime() : r.createdAt.getTime();
      return {
        id: r.id,
        ipAddress: r.ipAddress,
        hostname: r.hostname,
        macAddress: r.macAddress,
        subnetId: r.subnetId,
        subnetCidr: r.subnet.cidr,
        subnetName: r.subnet.name,
        createdAt: r.createdAt,
        lastSeenLeased: r.lastSeenLeased,
        staleNotifiedAt: r.staleNotifiedAt,
        daysSinceSeen: Math.floor((nowMs - lastSignalMs) / (24 * 60 * 60 * 1000)),
        fortigateDevice: r.subnet.fortigateDevice,
        pushedToId: r.pushedToId,
        pushedToName: r.pushedTo?.name ?? null,
      };
    });
  }

  const detectionStartedAt = await getDetectionStartedAt();
  const cutoffMs = Date.now() - settings.staleAfterDays * 24 * 60 * 60 * 1000;

  // Pull every non-ignored active dhcp_reservation in one go and filter in
  // memory. Volume is bounded by total reservation count — small (low
  // thousands at most) on real deployments.
  const rows = await prisma.reservation.findMany({
    where: { status: "active", sourceType: "dhcp_reservation", staleIgnored: false },
    include: {
      subnet: { select: { id: true, cidr: true, name: true, fortigateDevice: true } },
      pushedTo: { select: { id: true, name: true } },
    },
    orderBy: [{ lastSeenLeased: "asc" }, { createdAt: "asc" }],
  });

  const result: ReservationAlertEntry[] = [];
  const nowMs = Date.now();
  for (const r of rows) {
    // Operator snooze: while the snooze is in the future, suppress the row.
    if (r.staleSnoozedUntil && r.staleSnoozedUntil.getTime() > nowMs) continue;

    const baseline = r.createdAt.getTime() > detectionStartedAt.getTime()
      ? r.createdAt.getTime()
      : detectionStartedAt.getTime();
    const lastSignalMs = r.lastSeenLeased ? r.lastSeenLeased.getTime() : baseline;
    if (lastSignalMs > cutoffMs) continue;

    const daysSinceSeen = Math.floor((nowMs - lastSignalMs) / (24 * 60 * 60 * 1000));
    result.push({
      id: r.id,
      ipAddress: r.ipAddress,
      hostname: r.hostname,
      macAddress: r.macAddress,
      subnetId: r.subnetId,
      subnetCidr: r.subnet.cidr,
      subnetName: r.subnet.name,
      createdAt: r.createdAt,
      lastSeenLeased: r.lastSeenLeased,
      staleNotifiedAt: r.staleNotifiedAt,
      daysSinceSeen,
      fortigateDevice: r.subnet.fortigateDevice,
      pushedToId: r.pushedToId,
      pushedToName: r.pushedTo?.name ?? null,
    });
  }
  return result;
}

export interface IgnoreReservationResult {
  reservationId: string;
  staleIgnored: boolean;
}

/**
 * Set or clear the staleIgnored flag on a dhcp_reservation. When true, the
 * row is suppressed from the active alert list and the job won't ever re-fire
 * on it — even if it later goes online and offline again. Cleared by an
 * explicit un-ignore (passing false), not by discovery activity.
 *
 * Reserved for admin / network-admin via the route guard; the service trusts
 * the caller and just mutates the row.
 */
export async function setStaleIgnored(
  reservationId: string,
  staleIgnored: boolean,
): Promise<IgnoreReservationResult> {
  const { AppError } = await import("../utils/errors.js");
  const row = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { id: true, status: true, sourceType: true },
  });
  if (!row) throw new AppError(404, `Reservation ${reservationId} not found`);
  if (row.status !== "active" || row.sourceType !== "dhcp_reservation") {
    throw new AppError(409, `Cannot ignore — reservation must be active and dhcp_reservation (status=${row.status}, sourceType=${row.sourceType})`);
  }
  await prisma.reservation.update({
    where: { id: reservationId },
    data: {
      staleIgnored,
      // Clearing the snooze + notified timestamps when ignoring keeps the
      // row state consistent (no point in tracking a snooze on an ignored
      // row); when un-ignoring, leave them alone so the next scan picks
      // up the row fresh.
      ...(staleIgnored ? { staleSnoozedUntil: null, staleNotifiedAt: null } : {}),
    },
  });
  return { reservationId, staleIgnored };
}

/**
 * Job entry point. Scans for stale reservations, emits one
 * `reservation.stale` Event per row that hasn't already been notified, and
 * stamps `staleNotifiedAt` so the next run doesn't refire the same alert
 * unless the row's lastSeenLeased advances (sync clears staleNotifiedAt).
 */
export async function flagStaleReservations(): Promise<number> {
  const settings = await getStaleSettings();
  if (settings.staleAfterDays === 0) return 0;

  const stale = await listStaleReservations();
  let emitted = 0;
  const now = new Date();

  for (const row of stale) {
    if (row.staleNotifiedAt) continue;

    const ipLabel = row.ipAddress ?? "(no IP)";
    const sinceLabel = row.lastSeenLeased
      ? `${row.daysSinceSeen} day${row.daysSinceSeen === 1 ? "" : "s"} since last seen leased`
      : `never seen leased — ${row.daysSinceSeen} day${row.daysSinceSeen === 1 ? "" : "s"} since detection baseline`;

    await logEvent({
      action: "reservation.stale",
      level: "warning",
      resourceType: "reservation",
      resourceId: row.id,
      resourceName: row.hostname || ipLabel,
      message: `DHCP reservation ${ipLabel} on ${row.subnetCidr}${row.fortigateDevice ? ` (${row.fortigateDevice})` : ""} appears stale — ${sinceLabel}.`,
      details: {
        subnetCidr: row.subnetCidr,
        subnetName: row.subnetName,
        ipAddress: row.ipAddress,
        macAddress: row.macAddress,
        hostname: row.hostname,
        fortigateDevice: row.fortigateDevice,
        pushedTo: row.pushedToName,
        lastSeenLeased: row.lastSeenLeased?.toISOString() ?? null,
        daysSinceSeen: row.daysSinceSeen,
        staleAfterDays: settings.staleAfterDays,
      },
    });

    await prisma.reservation.update({
      where: { id: row.id },
      data: { staleNotifiedAt: now },
    });
    emitted++;
  }
  return emitted;
}
