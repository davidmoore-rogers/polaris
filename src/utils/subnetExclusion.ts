/**
 * src/utils/subnetExclusion.ts — the pure half of business rule 42.
 *
 * An exclusion is a CIDR the operator has declared out of scope for the
 * networks list. Two questions get asked of the set, and they use DIFFERENT
 * geometry on purpose:
 *
 *   isCidrExcluded()      — "may this CIDR be recorded as a network?" Answered
 *                           by CONTAINMENT, one direction only: an exclusion
 *                           covers a CIDR equal to it or narrower than it. The
 *                           other direction is deliberately not excluded —
 *                           excluding 10.9.9.0/24 must not silently swallow a
 *                           10.0.0.0/8 someone discovers, which would take out
 *                           far more address space than the operator named.
 *
 *   exclusionsOverlapping() — "which excluded ranges are unavailable inside
 *                           this block?" Answered by OVERLAP, both directions,
 *                           because it feeds the allocator's taken-space list
 *                           and a candidate that merely intersects excluded
 *                           space must not be handed out.
 *
 * IPv4 only. The containment math is `netmask`-backed (as everything in
 * utils/cidr.ts is) and the address space this exists for — site management
 * VLANs reported by FortiGate DHCP — is v4; the service layer refuses a v6
 * exclusion at the door rather than storing one that could never match.
 */

import { cidrContains, cidrOverlaps } from "./cidr.js";

/** The shape both helpers need — a stored `SubnetExclusion` satisfies it. */
export interface ExclusionLike {
  cidr: string;
  name?: string;
}

/**
 * The exclusion covering `cidr` (equal to it, or a supernet of it), or null.
 *
 * Returns the MOST SPECIFIC match when several cover the same CIDR, so the
 * message an operator reads names the exclusion they would actually delete to
 * let the subnet through.
 */
export function findCoveringExclusion<T extends ExclusionLike>(
  cidr: string,
  exclusions: readonly T[],
): T | null {
  let best: T | null = null;
  let bestPrefix = -1;
  for (const ex of exclusions) {
    if (!cidrContains(ex.cidr, cidr)) continue;
    const prefix = prefixLengthOf(ex.cidr);
    if (prefix > bestPrefix) {
      best = ex;
      bestPrefix = prefix;
    }
  }
  return best;
}

/** Convenience predicate over `findCoveringExclusion`. */
export function isCidrExcluded(cidr: string, exclusions: readonly ExclusionLike[]): boolean {
  return findCoveringExclusion(cidr, exclusions) !== null;
}

/**
 * The exclusions that intersect `scopeCidr` — the excluded ranges an allocator
 * working inside that block/anchor has to treat as already taken.
 */
export function exclusionsOverlapping<T extends ExclusionLike>(
  scopeCidr: string,
  exclusions: readonly T[],
): T[] {
  return exclusions.filter((ex) => cidrOverlaps(scopeCidr, ex.cidr));
}

/** Bare prefix length, or -1 when the string carries none. */
function prefixLengthOf(cidr: string): number {
  const slash = cidr.lastIndexOf("/");
  if (slash < 0) return -1;
  const n = Number.parseInt(cidr.slice(slash + 1), 10);
  return Number.isNaN(n) ? -1 : n;
}
