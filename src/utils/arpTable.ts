/**
 * Pure preparation of a FortiGate's ARP table for persistence.
 *
 * The rows arrive from `processArpRows` (utils/fortinetDetectedDevice.ts) as a
 * flat list across every gate in the run; everything here is per-gate shaping:
 * normalize, dedupe, order, cap. No I/O, so the decisions that matter are
 * testable on their own — see services/arpTableService.ts for the writer.
 */

import { compareIpv4 } from "./cidr.js";

/**
 * Rows per firewall asset. A FortiGate at a large site holds a few hundred
 * neighbours; 4000 is well clear of that while still bounding the damage from
 * a gate fronting a very large flat network. Truncation is reported so the
 * caller can log it LOUDLY: a partial ARP table makes "Polaris doesn't know
 * about this address" indistinguishable from "the row was cut", which is
 * exactly the reading operators would draw from the tab.
 */
export const ARP_ROWS_PER_ASSET_CAP = 4000;

/** The shape `processArpRows` produces (DiscoveredArpEntry, minus the device). */
export interface RawArpRow {
  ip: string;
  mac: string;
  interface?: string;
  age?: number;
}

/** One row ready for `asset_arp_entries`. */
export interface PreparedArpRow {
  ipAddress:  string;
  macAddress: string;
  ifName:     string | null;
  ageSec:     number | null;
}

/** Business key for a prepared row, with the nullable interface folded to "". */
export function arpRowKey(row: { ipAddress: string; macAddress: string; ifName: string | null }): string {
  return `${row.ipAddress}|${row.macAddress}|${row.ifName ?? ""}`;
}

/**
 * Normalize, dedupe and order one gate's ARP rows.
 *
 * - The MAC is re-normalized here rather than trusted: this util is the last
 *   step before the unique index, and a key that disagrees with the stored
 *   value by case would make every cycle look like a fresh binding.
 * - An empty `interface` becomes NULL — FortiOS answers "" for an entry it
 *   cannot attribute, and storing that as a distinct interface named "" would
 *   render as a real port in the tab.
 * - Duplicates keep the FRESHEST row (lowest age). FortiOS can report the same
 *   binding twice when an interface and its VLAN child both resolve it; the
 *   younger entry is the one the gate acted on most recently. A row with no age
 *   loses to one that has an age, since "the firmware did not say" is not
 *   evidence of freshness.
 * - Ordering is interface-then-numeric-IP so the cap slices deterministically
 *   and the tab's grouping gets its rows already in place.
 */
export function prepareArpRows(
  rows: readonly RawArpRow[],
  cap: number = ARP_ROWS_PER_ASSET_CAP,
): { entries: PreparedArpRow[]; truncated: number } {
  const byKey = new Map<string, PreparedArpRow>();

  for (const raw of rows) {
    const ipAddress = typeof raw?.ip === "string" ? raw.ip.trim() : "";
    const macRaw    = typeof raw?.mac === "string" ? raw.mac.trim() : "";
    if (!ipAddress || !macRaw) continue;
    const macAddress = macRaw.toUpperCase().replace(/-/g, ":");
    const ifRaw  = typeof raw?.interface === "string" ? raw.interface.trim() : "";
    const ifName = ifRaw === "" ? null : ifRaw;
    const ageSec = Number.isFinite(raw?.age) ? Math.trunc(Number(raw.age)) : null;

    const prepared: PreparedArpRow = { ipAddress, macAddress, ifName, ageSec };
    const key = arpRowKey(prepared);
    const existing = byKey.get(key);
    if (!existing || isFresher(prepared.ageSec, existing.ageSec)) byKey.set(key, prepared);
  }

  const all = [...byKey.values()].sort(compareArpRows);
  return {
    entries:   all.length > cap ? all.slice(0, cap) : all,
    truncated: Math.max(0, all.length - cap),
  };
}

/** `a` is fresher than `b`: a known age beats an unknown one, then lower wins. */
function isFresher(a: number | null, b: number | null): boolean {
  if (a === null) return false;
  if (b === null) return true;
  return a < b;
}

/** Interface first (unattributed rows last), then numeric IP, then MAC. */
export function compareArpRows(a: PreparedArpRow, b: PreparedArpRow): number {
  if ((a.ifName === null) !== (b.ifName === null)) return a.ifName === null ? 1 : -1;
  if (a.ifName !== null && b.ifName !== null && a.ifName !== b.ifName) {
    return a.ifName.localeCompare(b.ifName, undefined, { numeric: true, sensitivity: "base" });
  }
  const byIp = compareIpv4(a.ipAddress, b.ipAddress);
  if (byIp !== 0) return byIp;
  return a.macAddress.localeCompare(b.macAddress);
}

/**
 * Split a run's flat ARP rows into per-gate buckets, keyed by the LOWERCASED
 * FortiManager device name.
 *
 * Case-folding is the same accommodation `fmgNameKey` makes elsewhere: the
 * device name reaches us from several FMG payloads that do not agree on case,
 * and a bucket that misses because of it looks exactly like a gate that
 * returned nothing.
 */
export function groupArpRowsByDevice<T extends { fortigateDevice?: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const byDevice = new Map<string, T[]>();
  for (const row of rows) {
    const device = typeof row?.fortigateDevice === "string" ? row.fortigateDevice.trim() : "";
    if (!device) continue;
    const key = device.toLowerCase();
    let bucket = byDevice.get(key);
    if (!bucket) { bucket = []; byDevice.set(key, bucket); }
    bucket.push(row);
  }
  return byDevice;
}
