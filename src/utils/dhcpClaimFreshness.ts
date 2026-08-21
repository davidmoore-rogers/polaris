/**
 * src/utils/dhcpClaimFreshness.ts — rank competing DHCP claims on one asset.
 *
 * An endpoint sighted by more than one FortiGate in a single discovery run
 * has several DHCP entries claiming its address: the unexpired lease still
 * bound on the site it left, the fresh lease on the site it moved to, or a
 * config-only static reservation beside a live lease. Before this helper the
 * discovery engine staged ipAddress / ipSource / learnedLocation from EVERY
 * entry, so the asset kept whichever entry happened to iterate (and win the
 * concurrent write race) last — not the latest firewall sighting.
 *
 * The score is a lexicographic vector, most decisive first:
 *   1. seenLeased — the gate's DHCP monitor confirms the binding is live-held
 *      right now. A config-only reservation row never beats a held lease.
 *   2. inventorySeenMs — the FortiGate's OWN per-client device-inventory
 *      last_seen for (mac, gate). The only genuine per-gate freshness signal:
 *      two unexpired leases are both "live" to the DHCP monitor, but only the
 *      gate the client is actually behind keeps seeing it.
 *   3. expireTime — leases only. With similar scope durations, the lease
 *      renewed most recently expires last, so the decaying remnant on the old
 *      gate loses even when inventory is disabled.
 *   4. lease-over-reservation — deterministic tiebreak.
 *
 * A LATER entry must strictly beat the standing best to take over, so equal
 * evidence keeps the first claim and re-runs are stable.
 */

export interface DhcpClaimEvidence {
  type: "dhcp-reservation" | "dhcp-lease";
  /** Monitor-confirmed currently-held binding. */
  seenLeased?: boolean;
  /** Unix seconds from the lease's expire_time (dynamic leases only). */
  expireTime?: number;
  /** The sighting gate's own per-client inventory last_seen, ms epoch. */
  inventorySeenMs?: number;
}

export type DhcpClaimScore = readonly [number, number, number, number];

export function scoreDhcpClaim(e: DhcpClaimEvidence): DhcpClaimScore {
  return [
    e.seenLeased ? 1 : 0,
    Number.isFinite(e.inventorySeenMs) ? (e.inventorySeenMs as number) : 0,
    e.type === "dhcp-lease" && Number.isFinite(e.expireTime) ? (e.expireTime as number) : 0,
    e.type === "dhcp-lease" ? 1 : 0,
  ];
}

/** Strict lexicographic comparison — ties keep the incumbent. */
export function claimBeats(candidate: DhcpClaimScore, incumbent: DhcpClaimScore): boolean {
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] !== incumbent[i]) return candidate[i] > incumbent[i];
  }
  return false;
}
