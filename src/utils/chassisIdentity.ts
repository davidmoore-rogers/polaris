/**
 * src/utils/chassisIdentity.ts
 *
 * Pure (no I/O) decision layer for "is this still the same FortiGate?".
 *
 * A discovered Subnet records WHICH gate served it. Until 2026-09 that record
 * was the gate's NAME (`Subnet.fortigateDevice`) and nothing else, which made
 * two very different events indistinguishable:
 *
 *   • a RENAME  — same chassis, new FMG device name. The subnet should quietly
 *     re-point; nothing about the address space changed.
 *   • a REPLACEMENT — new chassis, and possibly the SAME name (an RMA or
 *     warranty swap normally reuses the name). The new box knows nothing about
 *     the reservations Polaris holds for that subnet, and every pushed row's
 *     `pushedScopeId` / `pushedEntryId` now points at a DHCP entry on a chassis
 *     that no longer exists.
 *
 * Name-only identity reads the first as a device leaving the roster (so the
 * subnet is deprecated and, per business rule 41, its CIDR can never be
 * re-created) and the second as nothing at all — the new gate silently
 * inherits the old one's reservation rows. Serial is chassis identity and is
 * never renamed, which is why the stale-firewall sweep (Phase 2a) already
 * matches firewalls by serial FIRST and falls back to hostname. Subnets never
 * got the same treatment; this is that treatment.
 *
 * TRI-STATE, AND THE DISTINCTION IS LOAD-BEARING
 * The stored serial is nullable and its three states mean different things —
 * the same discipline `AssetDependencyParent.managedSwitchSerials` uses:
 *
 *   absent  → UNKNOWN. A row that predates this feature, or a source that
 *             never published a serial. Applies NO constraint.
 *   present → the chassis that last served this subnet.
 *
 * and symmetrically on the discovered side, an unreadable serial is UNKNOWN
 * and must never read as "different" — one failed CMDB read would otherwise
 * declare every subnet on the fleet replaced. Absence of evidence is not
 * evidence of absence, the rule `haStandbyOfUnreadCluster` already encodes for
 * the firewall sweep.
 *
 * HA IS WHY THE COMPARISON IS AGAINST A SET, NOT A VALUE
 * A cluster has several chassis and FMG's device record flips its top-level
 * `sn` to whichever member is currently active. Comparing the stored serial
 * against only the CURRENT primary would report a replacement on every
 * failover — the single largest false-positive risk in this feature. So the
 * test is membership in the reporting device's own chassis set (its serial
 * plus every `ha_slave[]` member), and a stored serial still inside that set
 * is the same logical gate however the cluster has reshuffled.
 *
 * The set is deliberately PER DEVICE, not fleet-wide: an old chassis that was
 * re-registered in FMG under a different device entry (a gate repurposed to
 * another site) is genuinely a replacement for THIS subnet, and a fleet-wide
 * set would call it unchanged.
 */

/** What one subnet's stored chassis identity says about this discovery pass. */
export type ChassisVerdict =
  /** Nothing to compare — no constraint applied, no write. */
  | { kind: "unknown"; reason: "no-discovered-serial" }
  /** Stored identity absent: adopt the discovered serial. A first learn is not a replacement. */
  | { kind: "learn"; serial: string }
  /** Same chassis, or another member of the same cluster. */
  | { kind: "same"; serial: string; viaCluster: boolean }
  /** Different chassis, and the stored one is not in this device's cluster. */
  | { kind: "replaced"; from: string; to: string };

/** Serials are compared upper-cased and trimmed; blank normalizes to null. */
export function normalizeSerial(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toUpperCase();
  return t.length > 0 ? t : null;
}

/** Normalized, blank-free serial set — the reporting device's whole chassis roster. */
export function normalizeSerialSet(values: Iterable<string | null | undefined> | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const v of values ?? []) {
    const n = normalizeSerial(v);
    if (n) out.add(n);
  }
  return out;
}

/**
 * Decide what the discovered chassis serial says about a subnet's stored one.
 *
 * `clusterSerials` is the reporting device's own chassis set (its serial plus
 * every HA member's). `discovered` is normally in it; it is passed separately
 * because the standalone-FortiGate path can resolve the calling unit's serial
 * before its `ha-peer` read populates the members.
 */
export function classifyChassis(
  stored: string | null | undefined,
  discovered: string | null | undefined,
  clusterSerials?: Iterable<string | null | undefined> | null,
): ChassisVerdict {
  const to = normalizeSerial(discovered);
  // An unreadable serial this run tells us nothing. Never "replaced".
  if (!to) return { kind: "unknown", reason: "no-discovered-serial" };

  const from = normalizeSerial(stored);
  // First learn. A row predating the feature is not a device swap.
  if (!from) return { kind: "learn", serial: to };

  if (from === to) return { kind: "same", serial: to, viaCluster: false };

  // The stored chassis is still a member of the cluster now reporting this
  // subnet — an HA failover or a member reshuffle, not a replacement.
  const cluster = normalizeSerialSet(clusterSerials);
  if (cluster.has(from)) return { kind: "same", serial: to, viaCluster: true };

  return { kind: "replaced", from, to };
}

/**
 * True when the verdict should write `Subnet.fortigateSerial`.
 *
 * `learn` adopts; `same` re-stamps so the stored value tracks the active
 * cluster member (which keeps a later failover comparing against the newest
 * primary rather than an ever-staler one). `unknown` must not write — that is
 * what stops an unreadable read from erasing a known identity — and
 * `replaced` must not write either, because the conflict is what carries that
 * transition and the stored serial is the evidence the operator resolves it
 * against.
 */
export function verdictWritesSerial(v: ChassisVerdict): string | null {
  if (v.kind === "learn") return v.serial;
  if (v.kind === "same") return v.serial;
  return null;
}
