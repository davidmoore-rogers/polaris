/**
 * src/utils/infraDhcpBinding.ts
 *
 * Two decisions the Fortinet-infra reservation rows need, kept pure so they
 * unit-test without a database or a FortiGate.
 *
 * Why this exists: Phase 3a/3b of discovery create a reservation for every
 * managed FortiSwitch / FortiAP with a resolvable address — and that address is
 * often read out of the gate's own DHCP lease table (the hostname fallback), so
 * Polaris records a *dynamic lease* as a reservation with sourceType
 * "fortiswitch"/"fortinap". Phase 5, which is the only pass that knows whether an
 * address is leased or genuinely reserved on the device, had no branch for those
 * source types: the fact was discovered and dropped on every cycle. Operators saw
 * an authoritative-looking row with no Reserve action while the FortiGate's own
 * DHCP page said "Not Reserved".
 *
 * The fix is not to relabel the row. `sourceType` is answering a different
 * question (who owns this IP) and is still right. What was missing is the
 * orthogonal fact — how the gate hands the address out — which now lives in
 * `Reservation.dhcpBinding`. These helpers decide (a) what to write onto an
 * existing infra row when Phase 5 sees a DHCP entry for it, and (b) whether a
 * reservation already sitting at a managed device's IP belongs to THAT device, so
 * Phase 3 doesn't raise a conflict card against a row an operator just created
 * for the AP in front of them.
 */

/** Values `Reservation.dhcpBinding` is allowed to hold. */
export type DhcpBinding = "lease" | "reservation";

/** The subset of `Reservation` these decisions read. */
export interface InfraReservationRow {
  sourceType: string;
  macAddress?: string | null;
  hostname?: string | null;
  dhcpBinding?: string | null;
  pushedToId?: string | null;
}

/** The subset of a discovered DHCP entry these decisions read. */
export interface InfraDhcpEntry {
  /** "dhcp-reservation" = a real reserved-address entry; "dhcp-lease" = dynamic. */
  type: "dhcp-reservation" | "dhcp-lease";
  macAddress?: string | null;
  /** True when the monitor side confirmed a client is actively holding the IP. */
  seenLeased?: boolean;
}

/** The two source types whose binding state Phase 5 is the only observer of. */
export const INFRA_SOURCE_TYPES = ["fortiswitch", "fortinap"] as const;

export function isInfraSourceType(sourceType: string | null | undefined): boolean {
  return sourceType === "fortiswitch" || sourceType === "fortinap";
}

/**
 * Is this row takeover-able by an operator "Reserve"?
 *
 * Only a lease-backed infra row. A row marked "reservation" is a real MAC→IP
 * binding on the gate and stays authoritative; a NULL row has simply never been
 * observed in DHCP data (an AP on a static address, or one not currently
 * leasing) and must keep its pre-feature behavior rather than being assumed
 * free — guessing wrong here hands an operator an IP the device is still using.
 */
export function isLeaseBackedInfraRow(row: InfraReservationRow | null | undefined): boolean {
  if (!row) return false;
  return isInfraSourceType(row.sourceType) && row.dhcpBinding === "lease";
}

/** MAC comparison in the Asset/Reservation storage form (upper, colon-separated). */
function normalizeMacForCompare(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const t = mac.trim();
  if (!t) return null;
  return t.toUpperCase().replace(/-/g, ":");
}

export interface InfraBindingPatch {
  dhcpBinding?: DhcpBinding;
  /** Only ever set when the row had none — the lease entry's MAC. */
  macAddress?: string;
  /** Presence stamp, mirroring the dhcp_* branch's staleness bump. */
  lastSeenLeased?: true;
}

/**
 * What Phase 5 should write onto an existing fortiswitch/fortinap row given the
 * DHCP entry it just found at that IP. Returns null when nothing changed.
 *
 * Returning a patch only on change is load-bearing, not an optimization: this
 * runs per DHCP entry per discovery cycle, and at 2000 assets an unconditional
 * write per row is exactly the pattern the surrounding code goes out of its way
 * to avoid (it defers pure staleness bumps into one updateMany).
 *
 * Three deliberate omissions:
 *   • `expiresAt` is never staged. A lease carries an expiry, and stamping it
 *     here would hand these rows to expireReservations — the row would expire on
 *     the gate's lease clock, be re-created by the next discovery, and churn,
 *     with windows where a live AP reads as unreserved.
 *   • `macAddress` is taken from the LEASE ENTRY only, and only to fill a blank.
 *     It is the MAC the gate actually saw requesting the address, which is the
 *     only MAC a future MAC→IP push may bind. A device's base MAC is not
 *     reliably its DHCP client MAC, and binding the wrong one yields an entry
 *     that looks correct everywhere and never binds.
 *   • `sourceType` is never touched. The row's ownership fact is unchanged.
 */
export function decideInfraDhcpBinding(
  row: InfraReservationRow,
  entry: InfraDhcpEntry,
): InfraBindingPatch | null {
  if (!isInfraSourceType(row.sourceType)) return null;

  const patch: InfraBindingPatch = {};

  const binding: DhcpBinding = entry.type === "dhcp-reservation" ? "reservation" : "lease";
  if (row.dhcpBinding !== binding) patch.dhcpBinding = binding;

  // Fill-only. An operator-corrected MAC on the row is never overwritten by
  // discovery, matching how the description-sync and VIP-merge paths treat
  // operator-authored values.
  const entryMac = normalizeMacForCompare(entry.macAddress);
  if (entryMac && !normalizeMacForCompare(row.macAddress)) patch.macAddress = entryMac;

  // Inert today — the stale-reservation service only evaluates dhcp_reservation
  // rows — but it keeps these rows consistent with the presence model, and it is
  // the evidence a future pool/staleness surface would read.
  if (entry.seenLeased) patch.lastSeenLeased = true;

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Does an existing reservation at a managed device's IP belong to that device?
 *
 * Phase 3a/3b raise a conflict card whenever they find a `manual` row at the
 * switch/AP address they are about to claim. Once an operator reserves an AP's
 * IP — which is the whole point of making these rows takeover-able — that is
 * precisely what the next discovery cycle finds, so without this predicate the
 * feature's first effect would be a conflict card per reserved AP.
 *
 * Identity is MAC first (the strong key), then hostname, then "Polaris pushed
 * this row somewhere" as the weakest signal — a pushed row at the device's own
 * address was created by this system on purpose, not typed by an operator who
 * happens to want the same IP. A genuine collision — an operator reserving an
 * address a different device holds — still matches none of these and still
 * raises its card.
 */
export function reservationBelongsToInfraDevice(
  row: InfraReservationRow | null | undefined,
  device: { mac?: string | null; name?: string | null },
): boolean {
  if (!row) return false;

  const rowMac = normalizeMacForCompare(row.macAddress);
  const devMac = normalizeMacForCompare(device.mac);
  if (rowMac && devMac) return rowMac === devMac;

  const rowHost = (row.hostname || "").trim().toLowerCase();
  const devHost = (device.name || "").trim().toLowerCase();
  if (rowHost && devHost && rowHost === devHost) return true;

  return !!row.pushedToId;
}
