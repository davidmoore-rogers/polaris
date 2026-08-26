/**
 * src/utils/interfaceIdentity.ts
 *
 * Which name IS an interface, and which name merely DESCRIBES one.
 *
 * The problem this exists for, from the field (prod 2026-08-25). The SNMP
 * interface collectors resolve a port's name as `ifName` with an `ifDescr`
 * fallback, and each column is walked independently with its own `.catch()`.
 * On a FortiSwitch `ifDescr` carries the operator's port DESCRIPTION — so a
 * tick where the `ifName` walk failed but `ifDescr` answered renamed `port9`
 * to `MORGAN-221E-1`, the name of the access point plugged into it. That name
 * then became an IDENTITY everywhere downstream: written to
 * `asset_interfaces`, pinned by auto-monitor (LLDP's local port label is the
 * same description, so By-LLDP matched it), and fed samples by later degraded
 * ticks. The result was a PoE alert reading "Interface PoE status on
 * MORGAN-221E-1 is fault" — a real fault on a real port, reported under the
 * name of the neighbour instead of the port.
 *
 * The fix is not to distrust `ifDescr` (on plenty of devices it is the only
 * name there is) but to reconcile against what the asset has already
 * reported: `asset_interfaces` is the identity of record, and it stores each
 * row's `alias` and `description` beside its `ifName`. A collected name that
 * is some row's description is that row wearing a label, so it is mapped back.
 *
 * Three rules, each one a decision:
 *
 *  - **A real `ifName` always wins.** A label that happens to equal a port
 *    name is never treated as a label — a FortiSwitch reports `ifAlias` = the
 *    port name, so that is the common case, not the corner.
 *  - **An ambiguous label resolves to nothing.** Two ports described "Camera
 *    Station" cannot say which one a reading belongs to, and a reading stamped
 *    on the wrong port is worse than one under an odd name — the same
 *    reasoning `utils/poePorts.ts` applies to PoE correlation.
 *  - **An UNKNOWN name passes through unchanged.** A port that genuinely
 *    appeared since the last full scrape has no row yet, and dropping it would
 *    make new hardware invisible until the next pass.
 *
 * Kept dependency-free (no Prisma) so the whole decision table unit-tests
 * directly, matching utils/poePorts.ts and utils/hardwareSensors.ts.
 */

/** The identity columns of one `asset_interfaces` row. */
export interface InterfaceIdentityRow {
  ifName: string;
  alias?: string | null;
  description?: string | null;
}

/** Resolved identity for one asset's interfaces. */
export interface InterfaceIdentity {
  /** Every name the asset reports as an interface. */
  names: ReadonlySet<string>;
  /** alias / description → the ifName carrying it; unambiguous entries only. */
  labelToName: ReadonlyMap<string, string>;
}

/** An identity that knows nothing — every canonicalization becomes a no-op. */
export const EMPTY_INTERFACE_IDENTITY: InterfaceIdentity = {
  names: new Set<string>(),
  labelToName: new Map<string, string>(),
};

function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the identity map from an asset's stored interface rows.
 *
 * Within one row the description is considered before the alias (they rarely
 * differ, and when they do the description is the operator's label). Across
 * rows, a label claimed by two different ifNames is dropped.
 */
export function buildInterfaceIdentity(rows: readonly InterfaceIdentityRow[]): InterfaceIdentity {
  const names = new Set<string>();
  for (const r of rows) {
    const n = clean(r.ifName);
    if (n) names.add(n);
  }
  const labelToName = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const r of rows) {
    const name = clean(r.ifName);
    if (!name) continue;
    for (const label of [clean(r.description), clean(r.alias)]) {
      // A label that IS an interface name is not a label — it is that
      // interface, and rule one says the real name wins.
      if (!label || names.has(label) || ambiguous.has(label)) continue;
      const existing = labelToName.get(label);
      if (existing === undefined) {
        labelToName.set(label, name);
      } else if (existing !== name) {
        // Claimed by two ports: unresolvable, so it resolves to nothing.
        labelToName.delete(label);
        ambiguous.add(label);
      }
    }
  }
  return { names, labelToName };
}

/**
 * The canonical interface name for `name`, or null when the asset has never
 * reported anything by that name or that label.
 */
export function canonicalInterfaceName(name: string, identity: InterfaceIdentity): string | null {
  const n = clean(name);
  if (!n) return null;
  if (identity.names.has(n)) return n;
  return identity.labelToName.get(n) ?? null;
}

/** Outcome of canonicalizing a batch of interface-keyed rows. */
export interface CanonicalizeResult<T> {
  rows: T[];
  /** Rows whose name was a label and got mapped back to its port. */
  renamed: Array<{ from: string; to: string }>;
  /** Rows dropped because the port they map to is already in the batch. */
  dropped: number;
}

/**
 * Map every row keyed by an interface name onto its canonical port.
 *
 * A row whose label maps onto a port the batch ALREADY carries is dropped
 * rather than merged: both describe the same physical port in the same scrape,
 * and the one that arrived under the real name is the one to trust. Order is
 * otherwise preserved, so a caller's first-wins semantics
 * (`dedupeAndCapInterfaces`) are unchanged.
 */
export function canonicalizeInterfaceRows<T extends { ifName: string }>(
  rows: readonly T[],
  identity: InterfaceIdentity,
): CanonicalizeResult<T> {
  if (rows.length === 0 || identity.labelToName.size === 0) {
    return { rows: rows.slice(), renamed: [], dropped: 0 };
  }
  const present = new Set<string>();
  for (const r of rows) {
    const n = clean(r.ifName);
    if (n && identity.names.has(n)) present.add(n);
  }
  const out: T[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  let dropped = 0;
  for (const row of rows) {
    const from = clean(row.ifName);
    if (!from || identity.names.has(from)) { out.push(row); continue; }
    const to = identity.labelToName.get(from);
    if (!to) { out.push(row); continue; } // unknown name — rule three
    if (present.has(to)) { dropped++; continue; }
    present.add(to);
    renamed.push({ from, to });
    out.push({ ...row, ifName: to });
  }
  return { rows: out, renamed, dropped };
}

/**
 * Canonicalize a pin list (`Asset.monitoredInterfaces`), returning null when
 * nothing changed so the caller can skip the write.
 *
 * A pin is an operator's (or auto-monitor's) statement about a PORT, so a pin
 * naming a description is rewritten to the port and collapses into an existing
 * pin for it rather than duplicating it. A pin naming something the asset
 * doesn't report AT ALL is left alone — an interface can be absent from one
 * scrape (a module pulled, a stack member rebooting) and stripping the pin
 * would silently unmonitor it.
 */
export function canonicalizeInterfacePins(
  pins: readonly string[],
  identity: InterfaceIdentity,
): { pins: string[]; renamed: Array<{ from: string; to: string }> } | null {
  if (pins.length === 0 || identity.labelToName.size === 0) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  const renamed: Array<{ from: string; to: string }> = [];
  for (const pin of pins) {
    const from = clean(pin);
    if (!from) continue;
    const to = identity.names.has(from) ? from : identity.labelToName.get(from) ?? from;
    if (to !== from) renamed.push({ from, to });
    if (seen.has(to)) continue;
    seen.add(to);
    out.push(to);
  }
  if (renamed.length === 0 && out.length === pins.length) return null;
  return { pins: out, renamed };
}
