/**
 * src/utils/cidr.ts
 *
 * All IP math lives here. Never do string manipulation on IPs elsewhere.
 */

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
    if (!cidr.includes("/")) return false;
    if (detectIpVersion(cidr) === "v4") {
      new Netmask(cidr); // throws on invalid
    } else {
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
 * Return true if the given string is a valid dotted-quad IPv4 address
 * (octets validated ≤ 255). The discovery services previously retyped a
 * raw `\d{1,3}` regex at 8 sites, which accepted impossible octets like
 * 999.1.1.1 — this is the sanctioned inline guard for IPv4-only contexts;
 * use isValidIpAddress when IPv6 is also acceptable.
 */
export function isValidIpv4(ip: string): boolean {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  return ip.split(".").every((octet) => parseInt(octet) <= 255);
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

/**
 * RFC 1918 private-range check (10/8, 172.16/12, 192.168/16). IPv4 only —
 * returns false for IPv6 or anything that isn't a valid address.
 */
export function isPrivateIpv4(ip: string): boolean {
  if (!isValidIpAddress(ip) || ip.includes(":")) return false;
  const parts = ip.split(".").map(Number);
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

/**
 * RFC 1918 private-range OR loopback check for source-IP gating (the Dash
 * wallboard's app-level gate). Accepts:
 *   - the three RFC 1918 ranges (via isPrivateIpv4)
 *   - IPv4 loopback 127.0.0.0/8 and IPv6 loopback ::1
 *   - IPv6-mapped IPv4 forms (`::ffff:10.0.0.1`) — Node hands these out for
 *     v4 connections on dual-stack sockets, so they must be unwrapped before
 *     the v4 tests.
 * Deliberately NOT accepted: fc00::/7 (ULA) and 169.254/16 (link-local) —
 * the operator-facing contract is "RFC 1918 + loopback", nothing broader.
 */
export function isPrivateOrLoopbackIp(ip: string): boolean {
  if (!ip) return false;
  let candidate = ip.trim();
  if (candidate.toLowerCase().startsWith("::ffff:") && candidate.includes(".")) {
    candidate = candidate.slice(7);
  }
  if (candidate === "::1") return true;
  if (!isValidIpAddress(candidate) || candidate.includes(":")) return false;
  if (candidate.split(".").map(Number)[0] === 127) return true;
  return isPrivateIpv4(candidate);
}

/**
 * First IPv4 address of a FortiOS "a.b.c.d-e.f.g.h" range string (a bare IP
 * is treated as a single-address range). Null for empty / non-IPv4 input and
 * for the FortiOS "any" placeholder 0.0.0.0.
 */
export function parseRangeFirstIp(rangeStr: string): string | null {
  if (!rangeStr) return null;
  const ip = rangeStr.split("-")[0].trim();
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) && ip !== "0.0.0.0") return ip;
  return null;
}

/**
 * Fully expand an IPv6 address: `::` filled with zero groups, every group
 * zero-padded to 4 hex digits. Input is assumed syntactically valid.
 */
export function expandIpv6(ip: string): string {
  const halves = ip.split("::");
  let groups: string[];
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    groups = [...left, ...Array(missing).fill("0000"), ...right];
  } else {
    groups = ip.split(":");
  }
  return groups.map((g) => g.padStart(4, "0")).join(":");
}

/**
 * Reverse-DNS PTR query name for an IPv4 or IPv6 address
 * (`d.c.b.a.in-addr.arpa` / nibble-reversed `ip6.arpa`).
 */
export function ipToPtrName(ip: string): string {
  if (ip.includes(":")) {
    const full = expandIpv6(ip);
    const hex = full.replace(/:/g, "");
    return hex.split("").reverse().join(".") + ".ip6.arpa";
  }
  return ip.split(".").reverse().join(".") + ".in-addr.arpa";
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
    // inner must start at or after outer's base and end at or before its last
    // address. `broadcast` is UNDEFINED for a /31 and a /32 (there is no
    // broadcast address in a point-to-point or host route), and the previous
    // non-null assertion made `contains(undefined)` throw straight into the
    // catch below — so every /31 and /32 inner reported "not contained",
    // silently. That took out the two callers that pass a host route: the
    // region-tag propagation to assets addressed out of an enclosed gate's
    // subnet, and the sighting-to-subnet enrichment on the asset panel; it
    // would also have refused a /32 subnet inside its own block. `last` is the
    // last address for those prefixes and the last USABLE host for wider ones,
    // so prefer `broadcast` where it exists to keep the wider case unchanged.
    const innerEnd = innerBlock.broadcast ?? innerBlock.last;
    return outerBlock.contains(innerBlock.base) && outerBlock.contains(innerEnd);
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

/**
 * Pre-compile a list of CIDRs into a reusable "which of these contains this IP?"
 * test, returning the first matching CIDR or null.
 *
 * Exists for the loops that ask the question once per asset: `ipInCidr` builds a
 * fresh Netmask per call, so testing n assets against m subnets constructs n*m
 * of them — at 2000 assets and a few hundred subnets that is the dominant cost
 * of a map-region reconcile, and it repeats per region. Parsing each CIDR once
 * makes the inner loop a pair of integer comparisons.
 *
 * Unparseable CIDRs are dropped rather than throwing: the caller is matching
 * against discovery-supplied rows, and one bad row must not blind the rest.
 * IPv4 only (Netmask), same as `ipInCidr` — an IPv6 address simply matches
 * nothing.
 */
export function buildCidrMatcher(cidrs: string[]): (ip: string) => string | null {
  const blocks: Array<{ cidr: string; block: Netmask }> = [];
  for (const cidr of cidrs) {
    try {
      blocks.push({ cidr, block: new Netmask(cidr) });
    } catch {
      /* skip unparseable */
    }
  }
  return (ip: string): string | null => {
    if (!ip) return null;
    for (const b of blocks) {
      try {
        if (b.block.contains(ip)) return b.cidr;
      } catch {
        /* not an IPv4 address this block can evaluate */
      }
    }
    return null;
  };
}

/**
 * Normalize a single operator-entered allow-list entry to a canonical IPv4
 * CIDR (host bits zeroed), or null if it isn't a valid IPv4 CIDR / bare IPv4
 * address. A bare address becomes a /32. IPv4-only — the Netmask matcher
 * (ipMatchesAnyCidr) can't evaluate IPv6, so IPv6 entries are rejected here
 * rather than silently stored and never matched. Used by the Dash wallboard's
 * custom source-IP allow-list.
 */
export function normalizeAllowlistCidr(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const withPrefix = s.includes("/") ? s : `${s}/32`;
  if (detectIpVersion(withPrefix) !== "v4") return null;
  if (!isValidCidr(withPrefix)) return null;
  try {
    return normalizeCidr(withPrefix);
  } catch {
    return null;
  }
}

// ipMatchesAnyCidr was retired 2026-08 (audit): it was an IPv4-only subset of
// utils/ipAllowlist.ipMatchesAllowlist with the same ::ffff: unwrapping — the
// Dash wallboard gate (its only caller) now uses the allowlist matcher.

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
