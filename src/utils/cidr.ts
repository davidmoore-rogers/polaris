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
      outerBlock.contains(innerBlock.broadcast!)
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
  const endInt = ipToInt(parent.broadcast!);

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

// ─── Enumeration ─────────────────────────────────────────────────────────────

export interface EnumeratedIp {
  address: string;
  type: "network" | "broadcast" | "host";
}

export function enumerateSubnetIps(
  cidr: string,
  page: number = 1,
  pageSize: number = 256
): { addresses: EnumeratedIp[]; total: number } {
  const block = new Netmask(cidr);
  const baseInt = ipToInt(block.base);
  const broadcastInt = ipToInt(block.broadcast!);
  const total = broadcastInt - baseInt + 1;

  const startIdx = (page - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, total);
  const addresses: EnumeratedIp[] = [];

  for (let i = startIdx; i < endIdx; i++) {
    const ip = intToIp(baseInt + i);
    let type: EnumeratedIp["type"];
    if (block.bitmask >= 31) {
      type = "host";
    } else if (i === 0) {
      type = "network";
    } else if (i === total - 1) {
      type = "broadcast";
    } else {
      type = "host";
    }
    addresses.push({ address: ip, type });
  }

  return { addresses, total };
}

// ─── Conversion Utilities ─────────────────────────────────────────────────────

// ─── Template packing / anchor allocation ───────────────────────────────────

export interface PackedEntry<T> {
  /** Caller-supplied source entry. */
  entry: T;
  /** Byte offset (relative to anchor start) where this subnet begins. */
  offset: number;
  /** The prefix length of the packed subnet. */
  prefixLength: number;
}

export interface PackResult<T> {
  packed: PackedEntry<T>[];
  /** Total span from offset 0 to end of last entry (in addresses). */
  totalSpan: number;
  /** Smallest prefix length whose block fully contains all packed entries. */
  containingPrefix: number;
}

/**
 * Pack a series of subnet sizes sequentially, padding each entry's offset
 * up to its own prefix boundary. Returns per-entry offsets plus the smallest
 * prefix length whose block fully contains the whole group.
 *
 * The packer preserves caller order; put larger subnets (smaller prefix
 * numbers) first to avoid alignment padding holes.
 */
export function packTemplateEntries<T extends { prefixLength: number }>(
  entries: T[]
): PackResult<T> {
  if (!entries.length) return { packed: [], totalSpan: 0, containingPrefix: 32 };

  let cursor = 0;
  const packed: PackedEntry<T>[] = [];
  for (const e of entries) {
    const size = 2 ** (32 - e.prefixLength);
    // Align cursor up to the next multiple of size (prefix alignment).
    if (cursor % size !== 0) cursor = Math.ceil(cursor / size) * size;
    packed.push({ entry: e, offset: cursor, prefixLength: e.prefixLength });
    cursor += size;
  }
  const totalSpan = cursor;
  // Smallest block that fully contains totalSpan addresses.
  const containingSize = 2 ** Math.ceil(Math.log2(totalSpan));
  const containingPrefix = 32 - Math.log2(containingSize);
  return { packed, totalSpan, containingPrefix };
}

export interface AnchoredPackResult<T> {
  /** Absolute CIDRs for each packed entry, in caller order. */
  assignments: Array<{ entry: T; cidr: string }>;
  /** The anchor CIDR the group was placed into. */
  anchorCidr: string;
  /** The effective anchor prefix actually used (may be smaller-number than requested). */
  effectiveAnchorPrefix: number;
}

/**
 * Pack a template's worth of entries into a single anchor-aligned region of
 * the parent block.
 *
 * - Entries are packed in caller order, each aligned to its own prefix.
 * - The effective anchor prefix = `min(requestedAnchorPrefix, smallest-prefix-that-contains-the-group)`.
 *   (i.e. whichever block is larger). This guarantees all entries fit.
 * - The first anchor-aligned region inside `parentCidr` that has no overlap
 *   with any `allocatedCidrs` is chosen.
 *
 * Returns null if no free region is available (caller should surface a
 * "no room" error).
 */
export function packIntoAnchor<T extends { prefixLength: number }>(
  parentCidr: string,
  allocatedCidrs: string[],
  entries: T[],
  requestedAnchorPrefix: number
): AnchoredPackResult<T> | null {
  if (!entries.length) {
    return { assignments: [], anchorCidr: parentCidr, effectiveAnchorPrefix: requestedAnchorPrefix };
  }

  const parent = new Netmask(parentCidr);
  const packed = packTemplateEntries(entries);

  // Effective anchor is the larger of (requested, containing) — i.e. smaller prefix number.
  let effectiveAnchorPrefix = Math.min(requestedAnchorPrefix, packed.containingPrefix);
  if (effectiveAnchorPrefix < parent.bitmask) effectiveAnchorPrefix = parent.bitmask;

  const anchorSize = 2 ** (32 - effectiveAnchorPrefix);
  const baseInt = ipToInt(parent.base);
  const endInt = ipToInt(parent.broadcast!);

  let candidate = baseInt;
  while (candidate + anchorSize - 1 <= endInt) {
    const anchorCidr = `${intToIp(candidate)}/${effectiveAnchorPrefix}`;
    const hasOverlap = allocatedCidrs.some((existing) => cidrOverlaps(anchorCidr, existing));
    if (!hasOverlap) {
      const assignments = packed.packed.map((p) => ({
        entry: p.entry,
        cidr: `${intToIp(candidate + p.offset)}/${p.prefixLength}`,
      }));
      return { assignments, anchorCidr, effectiveAnchorPrefix };
    }
    candidate += anchorSize;
  }
  return null;
}

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
