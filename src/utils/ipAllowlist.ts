/**
 * src/utils/ipAllowlist.ts — source-IP allowlist matching for trusted-header auth
 *
 * Backs the Entra App Proxy header-SSO trust gate: identity headers are
 * unsigned, so the ONLY thing standing between "request" and "authenticated
 * user" is whether the request's source address is one of the operator-listed
 * App Proxy connector hosts. Fail closed everywhere: an empty allowlist, an
 * empty/unparseable candidate IP, or an invalid allowlist entry all match
 * nothing.
 *
 * Match `req.ip` (trust-proxy resolved), never the raw socket — behind nginx
 * the socket peer is always 127.0.0.1.
 */

import { expandIpv6, ipInCidr, isValidCidr, isValidIpAddress } from "./cidr.js";

/**
 * Unwrap IPv6-mapped IPv4 (`::ffff:10.0.0.1` → `10.0.0.1`) and lowercase.
 * Node hands out the mapped form for v4 connections on dual-stack sockets.
 */
function normalizeIp(ip: string): string {
  let candidate = ip.trim().toLowerCase();
  if (candidate.startsWith("::ffff:") && candidate.includes(".")) {
    candidate = candidate.slice(7);
  }
  return candidate;
}

/** Expanded IPv6 → 128-bit BigInt. Input must be a full 8-group form. */
function expandedIpv6ToBigInt(expanded: string): bigint {
  let value = 0n;
  for (const group of expanded.split(":")) {
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/** IPv6 CIDR containment via BigInt prefix compare. */
function ipv6InCidr(ip: string, cidr: string): boolean {
  const [addr, prefixStr] = cidr.split("/");
  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 128) return false;
  try {
    const ipBits = expandedIpv6ToBigInt(expandIpv6(ip));
    const netBits = expandedIpv6ToBigInt(expandIpv6(addr));
    if (prefix === 0) return true;
    const shift = BigInt(128 - prefix);
    return ipBits >> shift === netBits >> shift;
  } catch {
    return false;
  }
}

/**
 * True when `entry` is a plausible allowlist line: a bare IPv4/IPv6 address
 * or an IPv4/IPv6 CIDR. Used at settings-save time so typos are rejected
 * instead of silently never matching.
 */
export function isValidAllowlistEntry(entry: string): boolean {
  const candidate = entry.trim();
  if (!candidate) return false;
  if (candidate.includes("/")) return isValidCidr(candidate);
  return isValidIpAddress(candidate);
}

/**
 * True when `ip` matches at least one allowlist entry (exact address or CIDR
 * containment). Fail closed: empty ip, empty list, or malformed entries never
 * match.
 */
export function ipMatchesAllowlist(ip: string | undefined, entries: string[]): boolean {
  if (!ip || !Array.isArray(entries) || entries.length === 0) return false;
  const candidate = normalizeIp(ip);
  if (!candidate || !isValidIpAddress(candidate)) return false;
  const candidateIsV6 = candidate.includes(":");

  for (const rawEntry of entries) {
    const entry = normalizeIp(String(rawEntry ?? ""));
    if (!entry) continue;

    if (entry.includes("/")) {
      if (!isValidCidr(entry)) continue;
      const entryIsV6 = entry.includes(":");
      if (entryIsV6 !== candidateIsV6) continue;
      if (entryIsV6 ? ipv6InCidr(candidate, entry) : ipInCidr(candidate, entry)) return true;
      continue;
    }

    if (!isValidIpAddress(entry)) continue;
    if (entry.includes(":") !== candidateIsV6) continue;
    if (candidateIsV6) {
      try {
        if (expandIpv6(entry) === expandIpv6(candidate)) return true;
      } catch {
        continue;
      }
    } else if (entry === candidate) {
      return true;
    }
  }
  return false;
}
