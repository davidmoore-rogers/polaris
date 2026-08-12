/**
 * src/utils/poePorts.ts
 *
 * POWER-ETHERNET-MIB (RFC 3621) decoding for the PoE half of the interfaces
 * stream: what a `pethPsePortTable` row means, and which interface it belongs
 * to.
 *
 * Why the second half is hard: the table is `INDEX { pethPsePortGroupIndex,
 * pethPsePortIndex }` and **RFC 3621 provides no join back to ifIndex**.
 * BRIDGE-MIB hands you `dot1dBasePortIfIndex` for exactly this; POWER-ETHERNET
 * hands you nothing, so correlating a PoE row to a port name is inference and
 * is treated as such here — an unresolvable row is dropped, never guessed onto
 * a neighbouring interface.
 *
 * Kept dependency-free (no Prisma, no SNMP types) so the whole decision table
 * unit-tests directly, matching utils/hardwareSensors.ts.
 */

/**
 * `pethPsePortDetectionStatus` → the stored status string.
 *
 * RFC 3621: `disabled(1) searching(2) deliveringPower(3) fault(4) test(5)
 * otherFault(6)`.
 *
 * `fault` and `otherFault` stay DISTINCT rather than collapsing into one
 * "fault" value. They mean different things to a vendor (a detected PD fault
 * versus an implementation-specific one), and an operator authoring an
 * automation should be able to alert on both or treat them separately —
 * merging them would quietly remove that choice.
 */
export function poeStatusLabel(raw: number | null | undefined): string | null {
  switch (raw) {
    case 1:  return "disabled";
    case 2:  return "searching";
    case 3:  return "delivering";
    case 4:  return "fault";
    case 5:  return "test";
    case 6:  return "other-fault";
    default: return null;
  }
}

/** Every value `poeStatusLabel` can produce — the automation builder's enum. */
export const POE_STATUS_VALUES = [
  "disabled",
  "searching",
  "delivering",
  "fault",
  "test",
  "other-fault",
] as const;

/** Statuses that mean the port is actively powering a device. */
export function poeIsDelivering(status: string | null | undefined): boolean {
  return status === "delivering";
}

/**
 * Statuses that represent a real PoE fault an operator would want to know
 * about. Deliberately excludes `searching` (a port with nothing plugged in
 * searches forever) and `disabled` (an operator choice, not a failure).
 */
export function poeIsFault(status: string | null | undefined): boolean {
  return status === "fault" || status === "other-fault";
}

/**
 * `pethPsePortPowerClassifications` → the stored class string.
 *
 * **Watch the off-by-one.** The MIB enumerates `class0(1) class1(2) class2(3)
 * class3(4) class4(5)` — the enum value is one MORE than the IEEE class it
 * names. Storing the raw integer would report a class-0 powered device as
 * "class 1" and a class-4 (25.5 W) device as "class 5", which does not exist.
 * That is the entire reason this is a named function with a test rather than a
 * cast at the call site.
 *
 * The class is a negotiated power BUDGET bracket, not a measurement: class 3
 * means "up to 12.95 W at the PD", not "drawing 12.95 W". RFC 3621 has no
 * per-port wattage object at all.
 */
export function poeClassLabel(raw: number | null | undefined): string | null {
  if (raw == null) return null;
  if (raw < 1 || raw > 5) return null;
  return `class${raw - 1}`;
}

/** Every value `poeClassLabel` can produce. */
export const POE_CLASS_VALUES = ["class0", "class1", "class2", "class3", "class4"] as const;

/** Trailing integer in an interface name — "port5" → 5, "GigabitEthernet1/0/7" → 7. */
function trailingPortNumber(ifName: string): number | null {
  const m = /(\d+)\s*$/.exec(ifName.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Split a `pethPsePortTable` walk suffix into its two index components.
 *
 * A walk map is keyed by the OID suffix past the column, so a row indexed
 * `{ group, port }` arrives as `"1.5"`. Some agents index by a single value
 * instead; those arrive as `"5"` and are treated as group 1.
 */
export function parsePoeIndex(suffix: string): { group: number; port: number } | null {
  const parts = suffix.split(".").filter((p) => p !== "");
  if (parts.length === 0 || parts.length > 2) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return parts.length === 1
    ? { group: 1, port: nums[0] as number }
    : { group: nums[0] as number, port: nums[1] as number };
}

/**
 * Map each `pethPsePortTable` row to an interface name.
 *
 * Two strategies, tried in order, both of which are INFERENCE — RFC 3621
 * defines no relationship between a PoE port index and ifIndex, so which one
 * is correct is a property of the agent:
 *
 *   1. **Port index is an ifIndex.** Some agents number PoE ports by ifIndex
 *      directly. Accepted only when that ifIndex actually exists in the same
 *      scrape's IF-MIB walk.
 *   2. **Port index matches the trailing number of a port name.** A FortiSwitch
 *      names its ports `port1..port48`, so PoE port 5 is `port5`. Accepted only
 *      when exactly ONE interface has that trailing number — an ambiguous match
 *      (a stacked switch with `1/0/5` and `2/0/5`) is not resolved by guessing.
 *
 * Anything unresolved is omitted from the result rather than attached to a
 * best-guess interface: a PoE status stamped on the wrong port is worse than
 * no PoE status, because it would alert on a port that is fine and stay silent
 * on the one that is not.
 *
 * @param poeIndexes  walk suffixes from any pethPsePortTable column
 * @param ifNameByIndex  ifIndex → interface name, from the same scrape
 */
export function poeIfNameByIndex(
  poeIndexes: readonly string[],
  ifNameByIndex: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();

  // Trailing-number → ifName, keeping only unambiguous mappings.
  const byTrailing = new Map<number, string | null>();
  for (const name of ifNameByIndex.values()) {
    const n = trailingPortNumber(name);
    if (n == null) continue;
    byTrailing.set(n, byTrailing.has(n) ? null : name); // null marks ambiguity
  }

  for (const suffix of poeIndexes) {
    const parsed = parsePoeIndex(suffix);
    if (!parsed) continue;

    const asIfIndex = ifNameByIndex.get(String(parsed.port));
    if (asIfIndex) {
      out.set(suffix, asIfIndex);
      continue;
    }

    const byName = byTrailing.get(parsed.port);
    if (byName) out.set(suffix, byName);
  }

  return out;
}
