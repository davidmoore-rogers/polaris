/**
 * src/services/reservationService.ts
 */

import { PrismaClient, ReservationStatus } from "@prisma/client";
import { AppError } from "../utils/errors.js";
import { ipInCidr, isValidIpAddress, enumerateSubnetIps, detectIpVersion } from "../utils/cidr.js";
import {
  pushReservation,
  unpushReservation,
  normalizeMac,
  type PushReservationResult,
} from "./reservationPushService.js";
import type { FortiManagerConfig } from "./fortimanagerService.js";
import { logEvent } from "../api/routes/events.js";

const prisma = new PrismaClient();

export interface CreateReservationInput {
  subnetId: string;
  ipAddress?: string;
  hostname?: string;
  owner?: string;
  projectRef?: string;
  expiresAt?: Date;
  notes?: string;
  createdBy?: string;
  // MAC address for the reservation. Required when the target subnet was
  // discovered by an FMG integration that has pushReservations=true — DHCP
  // reservations on the FortiGate are MAC→IP, so a missing MAC aborts the
  // create. Optional for everything else.
  macAddress?: string;
}

export interface UpdateReservationInput {
  hostname?: string;
  owner?: string;
  projectRef?: string;
  expiresAt?: Date;
  notes?: string;
}

export interface ListReservationsFilter {
  subnetId?: string;
  owner?: string;
  projectRef?: string;
  status?: ReservationStatus;
  limit?: number;
  offset?: number;
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listReservations(filter: ListReservationsFilter = {}) {
  const limit = Math.min(filter.limit || 50, 200);
  const offset = filter.offset || 0;

  const where: Record<string, unknown> = {};
  if (filter.subnetId) where.subnetId = filter.subnetId;
  if (filter.owner) where.owner = filter.owner;
  if (filter.projectRef) where.projectRef = filter.projectRef;
  if (filter.status) where.status = filter.status;

  const [reservations, total] = await Promise.all([
    prisma.reservation.findMany({
      where,
      include: { subnet: { select: { cidr: true, name: true } } },
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
    }),
    prisma.reservation.count({ where }),
  ]);

  return { reservations, total, limit, offset };
}

// ─── Get ──────────────────────────────────────────────────────────────────────

export async function getReservation(id: string) {
  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: {
      subnet: {
        include: { block: { select: { id: true, name: true, cidr: true } } },
      },
    },
  });

  if (!reservation) throw new AppError(404, `Reservation ${id} not found`);
  return reservation;
}

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * Push eligibility for a reservation. Only manual per-IP reservations on
 * subnets discovered by an FMG integration with pushReservations=true are
 * pushed. Full-subnet reservations (ipAddress=null) and subnets without a
 * discovering integration are unaffected.
 */
function resolvePushEligibility(
  subnet: { discoveredBy: string | null; fortigateDevice: string | null; cidr: string },
  integration: { type: string; config: unknown } | null,
  ipAddress: string | null,
): { eligible: boolean; fmgConfig: FortiManagerConfig | null; deviceName: string } {
  if (!ipAddress) return { eligible: false, fmgConfig: null, deviceName: "" };
  if (!integration || integration.type !== "fortimanager") {
    return { eligible: false, fmgConfig: null, deviceName: "" };
  }
  const cfg = (integration.config ?? {}) as Record<string, unknown>;
  if (cfg.pushReservations !== true) {
    return { eligible: false, fmgConfig: null, deviceName: "" };
  }
  const deviceName = subnet.fortigateDevice || "";
  return {
    eligible: true,
    fmgConfig: cfg as unknown as FortiManagerConfig,
    deviceName,
  };
}

export async function createReservation(input: CreateReservationInput) {
  // 1. Load the target subnet (with integration for push eligibility)
  const subnet = await prisma.subnet.findUnique({
    where: { id: input.subnetId },
    include: { integration: true },
  });
  if (!subnet) throw new AppError(404, `Subnet ${input.subnetId} not found`);
  if (subnet.status === "deprecated")
    throw new AppError(409, `Subnet ${subnet.cidr} is deprecated and cannot accept new reservations`);

  // 2. If a specific IP was given, validate it belongs to the subnet
  if (input.ipAddress) {
    if (!isValidIpAddress(input.ipAddress))
      throw new AppError(400, `Invalid IP address: ${input.ipAddress}`);

    if (!ipInCidr(input.ipAddress, subnet.cidr))
      throw new AppError(
        400,
        `IP ${input.ipAddress} is not within subnet ${subnet.cidr}`
      );

    // Check for existing active reservation on this IP
    const existing = await prisma.reservation.findFirst({
      where: {
        subnetId: input.subnetId,
        ipAddress: input.ipAddress,
        status: "active",
      },
    });
    if (existing)
      throw new AppError(
        409,
        `IP ${input.ipAddress} is already actively reserved (reservation: ${existing.id})`
      );
  } else {
    // Full-subnet reservation — check no active full-subnet reservation exists
    const existing = await prisma.reservation.findFirst({
      where: { subnetId: input.subnetId, ipAddress: null, status: "active" },
    });
    if (existing)
      throw new AppError(
        409,
        `Subnet ${subnet.cidr} is already fully reserved (reservation: ${existing.id})`
      );
  }

  // 3. Resolve push eligibility BEFORE creating the row so we can fail fast
  //    on missing MAC without leaving a half-created reservation behind.
  const push = resolvePushEligibility(
    subnet,
    subnet.integration,
    input.ipAddress ?? null,
  );
  if (push.eligible) {
    if (!input.macAddress || !input.macAddress.trim()) {
      throw new AppError(
        400,
        "MAC address is required — this subnet's integration is configured to push reservations to the FortiGate, and DHCP reservations are MAC→IP",
      );
    }
    if (!push.deviceName) {
      throw new AppError(
        409,
        `Subnet ${subnet.cidr} has no fortigateDevice — the integration discovered the subnet without a device name, so push cannot resolve a target FortiGate`,
      );
    }
  }

  // 4. Create the reservation & mark subnet as reserved if full-subnet
  const macClean = input.macAddress ? normalizeMac(input.macAddress) : null;
  const reservation = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.create({
      data: {
        subnetId: input.subnetId,
        ipAddress: input.ipAddress ?? null,
        hostname: input.hostname,
        owner: input.owner || null,
        projectRef: input.projectRef || null,
        expiresAt: input.expiresAt,
        notes: input.notes,
        status: "active",
        createdBy: input.createdBy ?? null,
        macAddress: macClean,
      } as any,
    });

    if (!input.ipAddress) {
      await tx.subnet.update({
        where: { id: input.subnetId },
        data: { status: "reserved" },
      });
    }

    return res;
  });

  // 5. If push isn't eligible, we're done.
  if (!push.eligible || !push.fmgConfig || !input.ipAddress || !macClean) {
    return reservation;
  }

  // 6. Push to FortiGate. On any failure we delete the Polaris row so the
  //    create reads as atomic from the operator's perspective. We accept the
  //    rare case where the FortiOS write succeeded but verify failed (the
  //    push function throws inside verify) — those orphans on the device
  //    will be reconciled by the next discovery run via Drift detection.
  try {
    const pushed: PushReservationResult = await pushReservation({
      reservationId: reservation.id,
      subnetCidr: subnet.cidr,
      ip: input.ipAddress,
      mac: macClean,
      hostname: input.hostname ?? null,
      owner: input.owner ?? null,
      fmgConfig: push.fmgConfig,
      deviceName: push.deviceName,
    });

    const stamped = await prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        pushedToId: subnet.discoveredBy,
        pushedScopeId: pushed.scopeId,
        pushedEntryId: pushed.entryId,
        pushStatus: "synced",
        pushedAt: new Date(),
        pushError: null,
      },
    });

    void logEvent({
      action: "reservation.push.succeeded",
      level: "info",
      resourceType: "reservation",
      resourceId: stamped.id,
      resourceName: stamped.hostname || stamped.ipAddress || undefined,
      actor: input.createdBy ?? undefined,
      message: `Reservation pushed to FortiGate "${push.deviceName}" (scope ${pushed.scopeId}, entry ${pushed.entryId})`,
      details: {
        deviceName: push.deviceName,
        scopeId: pushed.scopeId,
        entryId: pushed.entryId,
        serverInterface: pushed.serverInterface,
        ip: input.ipAddress,
        mac: macClean,
      },
    });

    return stamped;
  } catch (err: any) {
    // Roll back: push failed (or verify failed). Don't leave a Polaris ghost.
    try {
      await prisma.reservation.delete({ where: { id: reservation.id } });
    } catch {
      // Swallow rollback failure — the original push error is more useful.
    }
    void logEvent({
      action: "reservation.push.failed",
      level: "warning",
      resourceType: "reservation",
      resourceName: input.hostname || input.ipAddress || undefined,
      actor: input.createdBy ?? undefined,
      message: `Reservation push to FortiGate "${push.deviceName}" failed — reservation aborted: ${err?.message || "Unknown error"}`,
      details: {
        deviceName: push.deviceName,
        ip: input.ipAddress,
        mac: macClean,
        error: err?.message || String(err),
      },
    });
    throw err;
  }
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateReservation(
  id: string,
  input: UpdateReservationInput
) {
  const reservation = await prisma.reservation.findUnique({ where: { id } });
  if (!reservation) throw new AppError(404, `Reservation ${id} not found`);
  if (reservation.status !== "active")
    throw new AppError(409, `Cannot update a ${reservation.status} reservation`);

  return prisma.reservation.update({
    where: { id },
    data: {
      hostname: input.hostname,
      owner: input.owner,
      projectRef: input.projectRef,
      expiresAt: input.expiresAt,
      notes: input.notes,
    },
  });
}

// ─── Release ──────────────────────────────────────────────────────────────────

export async function releaseReservation(id: string) {
  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: {
      subnet: true,
      pushedTo: true,
    },
  });

  if (!reservation) throw new AppError(404, `Reservation ${id} not found`);
  if (reservation.status !== "active")
    throw new AppError(409, `Reservation is already ${reservation.status}`);

  // Best-effort unpush from the FortiGate before flipping Polaris state.
  // We tolerate device-side failures (offline, missing entry, etc.) so an
  // unreachable FortiGate doesn't block the operator from releasing — but
  // we surface the failure as a `reservation.unpush.failed` Event so the
  // orphan is auditable.
  if (
    reservation.pushedTo &&
    reservation.pushedScopeId !== null &&
    reservation.pushedEntryId !== null
  ) {
    const fmgConfig = reservation.pushedTo.config as unknown as FortiManagerConfig;
    const deviceName = reservation.subnet.fortigateDevice || "";
    if (deviceName) {
      try {
        const result = await unpushReservation({
          reservationId: id,
          scopeId: reservation.pushedScopeId,
          entryId: reservation.pushedEntryId,
          fmgConfig,
          deviceName,
        });
        void logEvent({
          action: "reservation.unpush.succeeded",
          level: "info",
          resourceType: "reservation",
          resourceId: id,
          resourceName: reservation.hostname || reservation.ipAddress || undefined,
          message: result.alreadyAbsent
            ? `Reservation unpush — entry was already absent on FortiGate "${deviceName}" (scope ${reservation.pushedScopeId}, entry ${reservation.pushedEntryId})`
            : `Reservation unpushed from FortiGate "${deviceName}" (scope ${reservation.pushedScopeId}, entry ${reservation.pushedEntryId})`,
          details: {
            deviceName,
            scopeId: reservation.pushedScopeId,
            entryId: reservation.pushedEntryId,
            alreadyAbsent: result.alreadyAbsent,
          },
        });
      } catch (err: any) {
        void logEvent({
          action: "reservation.unpush.failed",
          level: "warning",
          resourceType: "reservation",
          resourceId: id,
          resourceName: reservation.hostname || reservation.ipAddress || undefined,
          message: `Reservation unpush from FortiGate "${deviceName}" failed — Polaris release proceeded but the device entry may be orphaned: ${err?.message || "Unknown error"}`,
          details: {
            deviceName,
            scopeId: reservation.pushedScopeId,
            entryId: reservation.pushedEntryId,
            error: err?.message || String(err),
          },
        });
      }
    }
  }

  return prisma.$transaction(async (tx) => {
    // The @@unique([subnetId, ipAddress, status]) constraint means we can't
    // have two released rows for the same IP. Reserve→unreserve→reserve→
    // unreserve cycles would otherwise collide on the second release. The
    // historical released row carries no information not already captured in
    // the audit log (reservation.released Event), so dropping it is safe.
    await tx.reservation.deleteMany({
      where: {
        id: { not: id },
        subnetId: reservation.subnetId,
        ipAddress: reservation.ipAddress,
        status: "released",
      },
    });

    const released = await tx.reservation.update({
      where: { id },
      data: {
        status: "released",
        // Clear push pointers — the device entry is gone (or orphaned and
        // logged) and a future re-reservation should make its own push.
        pushedToId: null,
        pushedScopeId: null,
        pushedEntryId: null,
        pushStatus: null,
        pushedAt: null,
      },
    });

    // If it was a full-subnet reservation, set subnet back to available
    if (!reservation.ipAddress) {
      await tx.subnet.update({
        where: { id: reservation.subnetId },
        data: { status: "available" },
      });
    }

    return released;
  });
}

// ─── Next Available IP ────────────────────────────────────────────────────────

export interface NextAvailableReservationInput {
  subnetId: string;
  hostname?: string;
  owner?: string;
  projectRef?: string;
  expiresAt?: Date;
  notes?: string;
  createdBy?: string;
  macAddress?: string;
}

export async function nextAvailableReservation(input: NextAvailableReservationInput) {
  const subnet = await prisma.subnet.findUnique({ where: { id: input.subnetId } });
  if (!subnet) throw new AppError(404, `Subnet ${input.subnetId} not found`);
  if (subnet.status === "deprecated")
    throw new AppError(409, `Subnet ${subnet.cidr} is deprecated and cannot accept new reservations`);
  if (detectIpVersion(subnet.cidr) !== "v4")
    throw new AppError(400, "Auto-allocate is only supported for IPv4 subnets");

  const activeReservations = await prisma.reservation.findMany({
    where: { subnetId: input.subnetId, status: "active" },
    select: { ipAddress: true },
  });
  const reservedIps = new Set(
    activeReservations.map((r) => r.ipAddress).filter(Boolean) as string[]
  );

  const pageSize = 256;
  let page = 1;
  let found: string | null = null;

  while (!found) {
    const { addresses, total } = enumerateSubnetIps(subnet.cidr, page, pageSize);
    for (const addr of addresses) {
      if (addr.type !== "host") continue;
      if (!reservedIps.has(addr.address)) {
        found = addr.address;
        break;
      }
    }
    if (!found && page * pageSize >= total) break;
    page++;
  }

  if (!found) throw new AppError(409, `No available IP addresses in subnet ${subnet.cidr}`);

  return createReservation({ ...input, ipAddress: found });
}

// ─── Expire (called by scheduled job) ────────────────────────────────────────

export async function expireStaleReservations(): Promise<number> {
  const result = await prisma.reservation.updateMany({
    where: {
      status: "active",
      expiresAt: { lt: new Date() },
    },
    data: { status: "expired" },
  });
  return result.count;
}
