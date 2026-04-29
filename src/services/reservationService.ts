/**
 * src/services/reservationService.ts
 */

import { PrismaClient, ReservationStatus } from "@prisma/client";
import { AppError } from "../utils/errors.js";
import { ipInCidr, isValidIpAddress, enumerateSubnetIps, detectIpVersion } from "../utils/cidr.js";

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

export async function createReservation(input: CreateReservationInput) {
  // 1. Load the target subnet
  const subnet = await prisma.subnet.findUnique({ where: { id: input.subnetId } });
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

  // 3. Create the reservation & mark subnet as reserved if full-subnet
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

  return reservation;
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
    include: { subnet: true },
  });

  if (!reservation) throw new AppError(404, `Reservation ${id} not found`);
  if (reservation.status !== "active")
    throw new AppError(409, `Reservation is already ${reservation.status}`);

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
      data: { status: "released" },
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
