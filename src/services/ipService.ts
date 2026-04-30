/**
 * src/services/ipService.ts — Core IP math & validation logic
 *
 * Higher-level IP operations used across services.
 * All low-level address arithmetic lives in src/utils/cidr.ts.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import {
  isValidIpAddress,
  isValidCidr,
  normalizeCidr,
  ipInCidr,
  detectIpVersion,
  usableHostCount,
} from "../utils/cidr.js";

// ─── Validation helpers ───────────────────────────────────────────────────────

/** Throw 400 if the IP address string is not a valid IPv4/IPv6 address. */
export function assertValidIp(ip: string): void {
  if (!isValidIpAddress(ip))
    throw new AppError(400, `Invalid IP address: ${ip}`);
}

/** Throw 400 if the CIDR string is invalid; return the normalized form. */
export function assertValidCidr(cidr: string): string {
  if (!isValidCidr(cidr))
    throw new AppError(400, `Invalid CIDR notation: ${cidr}`);
  return normalizeCidr(cidr);
}

/** Throw 400 if the IP does not fall within the given subnet CIDR. */
export function assertIpInSubnet(ip: string, subnetCidr: string): void {
  if (!ipInCidr(ip, subnetCidr))
    throw new AppError(400, `IP ${ip} is not within subnet ${subnetCidr}`);
}

// ─── IP availability ──────────────────────────────────────────────────────────

/** Return true if the IP has no active reservation in the given subnet. */
export async function isIpAvailable(
  ip: string,
  subnetId: string
): Promise<boolean> {
  assertValidIp(ip);
  const existing = await prisma.reservation.findFirst({
    where: { subnetId, ipAddress: ip, status: "active" },
  });
  return existing === null;
}

/** Return all active reservations for a subnet, sorted by IP. */
export async function getActiveReservationsForSubnet(subnetId: string) {
  return prisma.reservation.findMany({
    where: { subnetId, status: "active" },
    orderBy: { ipAddress: "asc" },
  });
}

// ─── Capacity ─────────────────────────────────────────────────────────────────

/**
 * Return utilization stats for a subnet.
 * Currently IPv4-only; IPv6 support can be added when bigint math is wired up.
 */
export async function subnetCapacity(subnetCidr: string, subnetId: string) {
  if (detectIpVersion(subnetCidr) !== "v4")
    throw new AppError(
      400,
      "Capacity calculation is currently only supported for IPv4 subnets"
    );

  const total = usableHostCount(subnetCidr);
  const reserved = await prisma.reservation.count({
    where: { subnetId, status: "active", ipAddress: { not: null } },
  });

  return {
    total,
    reserved,
    available: total - reserved,
    utilizationPercent: total > 0 ? Math.round((reserved / total) * 100) : 0,
  };
}
