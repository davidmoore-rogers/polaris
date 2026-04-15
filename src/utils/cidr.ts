/**
 * src/utils/cidr.ts
 *
 * All IP math lives here. Never do string manipulation on IPs elsewhere.
 */

import IPCIDR from "ip-cidr";
import { Netmask } from "netmask";

export type IpVersion = "v4" | "v6";

// ─── Parsing & Normalisation ──────────────────────────────────────────────────

/**
 * Normalise a CIDR string so the host bits are always zeroed.
 * e.g. "10.1.1.5/24" → "10.1.1.0/24"
 */
export function normalizeCidr(cidr: string): string {
  const block = new Netmask(cidr);
  return `${block.base}/${block.bitmask}`;
}

/**
 * Detect whether a CIDR string is IPv4 or IPv6.
 */
export function detectIpVersion(cidr: string): IpVersion {
  return cidr.includes(":") ? "v6" : "v4";
}

/**
 * Return true if the string is a valid CIDR notation.
 */
export function isValidCidr(cidr: string): boolean {
  try {
    if (detectIpVersion(cidr) === "v4") {
      new Netmask(cidr); // throws on invalid
    } else {
      // Basic IPv6 CIDR check
      const [addr, prefix] = cidr.split("/");
      if (!addr || !prefix) return false;
      const prefixNum = parseInt(prefix, 10);
      if (isNaN(prefixNum) || prefixNum < 0 || prefixNum > 128) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Return true if the given IP address (without prefix) is a valid IPv4 or IPv6 address.
 */
export function isValidIpAddress(ip: string): boolean {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  if (ipv4Regex.test(ip)) {
    return ip.split(".").every((octet) => parseInt(octet) <= 255);
  }
  return ipv6Regex.test(ip);
}

// ─── Containment & Overlap ────────────────────────────────────────────────────

/**
 * Return true if `inner` is fully contained within `outer`.
 * Both must be IPv4 CIDRs.
 */
export function cidrContains(outer: string, inner: string): boolean {
  try {
    const outerBlock = new Netmask(outer);
    const innerBlock = new Netmask(inner);
    // inner must start at or after outer's base and end at or before outer's broadcast
    return (
      outerBlock.contains(innerBlock.base) &&
      outerBlock.contains(innerBlock.broadcast)
    );
  } catch {
    return false;
  }
}

/**
 * Return true if two CIDRs overlap at all (either contains the other or they
 * share any addresses).
 */
export function cidrOverlaps(a: string, b: string): boolean {
  try {
    const blockA = new Netmask(a);
    const blockB = new Netmask(b);
    return blockA.contains(blockB.base) || blockB.contains(blockA.base);
  } catch {
    return false;
  }
}

/**
 * Return true if the given IP address is within the CIDR range.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  try {
    const block = new Netmask(cidr);
    return block.contains(ip);
  } catch {
    return false;
  }
}

// ─── Allocation Helpers ───────────────────────────────────────────────────────

/**
 * Return the total number of usable host addresses in a CIDR block.
 * /31 and /32 are handled as special cases (RFC 3021).
 */
export function usableHostCount(cidr: string): number {
  const block = new Netmask(cidr);
  if (block.bitmask === 32) return 1;
  if (block.bitmask === 31) return 2;
  return block.size - 2; // subtract network and broadcast
}

/**
 * Given a parent CIDR and a list of already-allocated child CIDRs,
 * find the first available sub-block of the requested prefix length.
 *
 * Returns the CIDR string of the next available block, or null if none found.
 */
export function findNextAvailableSubnet(
  parentCidr: string,
  allocatedCidrs: string[],
  requestedPrefix: number
): string | null {
  const parent = new Netmask(parentCidr);
  const blockSize = Math.pow(2, 32 - requestedPrefix);

  // Convert base IP to a 32-bit integer
  const baseInt = ipToInt(parent.base);
  const endInt = ipToInt(parent.broadcast);

  let candidate = baseInt;

  while (candidate + blockSize - 1 <= endInt) {
    const candidateCidr = `${intToIp(candidate)}/${requestedPrefix}`;
    const hasOverlap = allocatedCidrs.some((existing) =>
      cidrOverlaps(candidateCidr, existing)
    );

    if (!hasOverlap) {
      return normalizeCidr(candidateCidr);
    }

    candidate += blockSize;
  }

  return null;
}

// ─── Conversion Utilities ─────────────────────────────────────────────────────

function ipToInt(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function intToIp(int: number): string {
  return [
    (int >>> 24) & 255,
    (int >>> 16) & 255,
    (int >>> 8) & 255,
    int & 255,
  ].join(".");
}
