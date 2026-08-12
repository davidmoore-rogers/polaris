/**
 * src/utils/fortinetParentKey.ts
 *
 * Resolving a Fortinet infra asset's PARENT from the identity stamps discovery
 * wrote onto `Asset.fortinetTopology`.
 *
 * The problem this exists to solve: `fortinetTopology.controllerFortigate` holds
 * FortiManager's DEVICE NAME, which is assigned inside FMG and is under no
 * obligation to match the gate's own `system global hostname`. `Asset.hostname`
 * for a FortiGate is projected from the gate's configured hostname
 * (`device.hostname || device.name`), so on any install where an operator named
 * the FMG device differently from the gate, every name-keyed parent lookup
 * silently resolved to nothing:
 *
 *   - dependency suppression never fired (no parent ⇒ never suppressed), so a
 *     FortiGate in a maintenance window left its switches reading "Down"
 *     instead of "Dep. Down" (prod 2026-08-12, the bug that found this)
 *   - the Device Map showed the gate with none of its switches/APs
 *   - map-region assignment, interface auto-monitor and connection paths all
 *     skipped the children
 *
 * The serial is definitive on both sides, so discovery now also stamps
 * `controllerSerial`. This module is the single resolution order every consumer
 * shares:
 *
 *   1. `controllerSerial` against serials — definitive, present on rows written
 *      after the 2026-08 fix.
 *   2. the NAME against hostnames — exactly the pre-fix behavior, kept as the
 *      fallback because a stamp only gains `controllerSerial` when its
 *      integration next runs discovery. Never remove it.
 *   3. the NAME against serials — covers the FortiSwitch/FortiAP direction,
 *      where the stamp (`parentSwitch`, from the AP's LLDP table) carries a
 *      switch-id that IS the serial while `Asset.hostname` may be an
 *      operator-set label.
 *
 * IMPORTANT — `controllerFortigate` has a second, unrelated class of consumer
 * that must keep using the NAME: anything addressing an FMG/FortiOS API
 * (monitoringService's parent-FortiGate polling, the discovery decommission
 * sweeps comparing against the FMG roster, infraDhcpBinding's name-to-name
 * compare, and the Sources column, which shows the FMG name deliberately —
 * business rule 22). Those are not asset-identity lookups and must not route
 * through here.
 *
 * Pure — no DB access. Callers supply the candidate set.
 */

/** One candidate parent asset. Field names match the Asset columns. */
export interface InfraParentCandidate {
  id: string;
  hostname: string | null;
  serialNumber: string | null;
  assetType: string;
  /** The candidate's OWN `fortinetTopology`. Supplying it lets the index pick up
   *  a firewall's `deviceName` (its name in FortiManager) — the key its children
   *  actually stamp. Omit and resolution falls back to hostname/serial only. */
  fortinetTopology?: unknown;
}

/** The stamps read off a child's `fortinetTopology`. Both optional. */
export interface InfraParentStamp {
  /** `controllerSerial` (or any definitive serial stamp, e.g. parentApSerial). */
  serial?: string | null;
  /** `controllerFortigate` / `parentSwitch` — a NAME, possibly a serial. */
  name?: string | null;
}

export interface InfraParentIndex {
  bySerial: Map<string, InfraParentCandidate>;
  byHostname: Map<string, InfraParentCandidate>;
  /** Keyed on each candidate's own `fortinetTopology.deviceName`. */
  byDeviceName: Map<string, InfraParentCandidate>;
}

/** Normalize a serial for comparison. Serials are compared case-insensitively
 *  upper-cased throughout the codebase (`existingAsset.serialNumber.toUpperCase()`
 *  in the discovery match guards); keep that convention. */
export function normalizeSerialKey(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim().toUpperCase() : "";
}

/** Normalize a hostname/device name for comparison — lower-cased, matching the
 *  pre-existing `byHostname` maps this replaces. */
export function normalizeNameKey(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/**
 * Build the lookup index once per pass.
 *
 * First writer wins on a duplicate key so the index is stable in whatever order
 * the caller supplies (the dependency recompute sorts by id for determinism).
 * Duplicate serials shouldn't exist — discovery's serial-mismatch guards
 * prevent two assets sharing one — but a duplicate HOSTNAME absolutely can
 * (that's what `mergeDuplicateHostnameAssets` cleans up), so this must not
 * throw or churn on one.
 */
export function buildInfraParentIndex(candidates: InfraParentCandidate[]): InfraParentIndex {
  const bySerial = new Map<string, InfraParentCandidate>();
  const byHostname = new Map<string, InfraParentCandidate>();
  const byDeviceName = new Map<string, InfraParentCandidate>();
  for (const c of candidates) {
    const s = normalizeSerialKey(c.serialNumber);
    if (s && !bySerial.has(s)) bySerial.set(s, c);
    const h = normalizeNameKey(c.hostname);
    if (h && !byHostname.has(h)) byHostname.set(h, c);
    const d = normalizeNameKey(readFirewallDeviceName(c.fortinetTopology));
    if (d && !byDeviceName.has(d)) byDeviceName.set(d, c);
  }
  return { bySerial, byHostname, byDeviceName };
}

/**
 * Resolve a parent from a child's stamps.
 *
 * `expectedType` guards the edge kind the caller is building (a switch's
 * controller must be a firewall; an AP's parentSwitch must be a switch) — a
 * stamp that resolves to the wrong asset type yields null rather than a bogus
 * edge, which is what the pre-fix `parent.assetType === "firewall"` checks did
 * inline. Pass undefined to accept any type.
 *
 * Returns null when nothing matches, which every caller must treat as "no
 * parent" — NOT as an error. An unadopted switch, a gate discovered by another
 * integration that hasn't run yet, and a genuinely orphaned device all land
 * here legitimately.
 */
export function resolveInfraParentAsset(
  index: InfraParentIndex,
  stamp: InfraParentStamp,
  expectedType?: string,
): InfraParentCandidate | null {
  const typeOk = (c: InfraParentCandidate | undefined): InfraParentCandidate | null => {
    if (!c) return null;
    if (expectedType && c.assetType !== expectedType) return null;
    return c;
  };

  // 1) Definitive: the stamped serial.
  const serialKey = normalizeSerialKey(stamp.serial);
  if (serialKey) {
    const hit = typeOk(index.bySerial.get(serialKey));
    if (hit) return hit;
  }

  const nameKey = normalizeNameKey(stamp.name);
  if (!nameKey) return null;

  // 2) The stamped name against each candidate's OWN FMG device name. This is
  //    the like-for-like comparison (`controllerFortigate` and `deviceName` are
  //    both FMG's name for the gate) and the one that works on data written
  //    before `controllerSerial` existed.
  const byDevice = typeOk(index.byDeviceName.get(nameKey));
  if (byDevice) return byDevice;

  // 3) Pre-fix behavior: the name against hostnames. Correct whenever the FMG
  //    device name and the gate's configured hostname agree.
  const byName = typeOk(index.byHostname.get(nameKey));
  if (byName) return byName;

  // 4) The name may itself BE a serial (a FortiSwitch's switch-id is its
  //    serial, and that's what an AP's LLDP table reports as parentSwitch).
  return typeOk(index.bySerial.get(normalizeSerialKey(stamp.name)));
}

/**
 * The stamps a child asset carries, read defensively off the untyped
 * `fortinetTopology` JSON. Shared so the ~8 consumers don't each re-derive the
 * key names (and so a future rename is one edit).
 */
export function readControllerStamp(topology: unknown): InfraParentStamp {
  const t = (topology ?? null) as Record<string, unknown> | null;
  if (!t) return {};
  return {
    serial: typeof t.controllerSerial === "string" ? t.controllerSerial : null,
    name: typeof t.controllerFortigate === "string" ? t.controllerFortigate : null,
  };
}

/**
 * The identities of one controller FortiGate, as an Asset row exposes them.
 * Take this shape rather than positional strings — three same-typed arguments
 * in an order nobody can remember is how a serial ends up compared to a name.
 */
export interface ControllerIdentity {
  hostname?: string | null;
  serialNumber?: string | null;
  /**
   * `fortinetTopology.deviceName` — the FortiGate's name IN FORTIMANAGER, which
   * discovery already stamps on the firewall precisely so write paths don't have
   * to re-look it up. This is the key children actually carry in
   * `controllerFortigate`, which makes it the match that works on data written
   * BEFORE `controllerSerial` existed. Read it with `readFirewallDeviceName`.
   */
  deviceName?: string | null;
}

/**
 * The `OR` branches selecting the children of ONE controller FortiGate. Shared
 * by the Prisma consumers (Device Map topology, the map route's per-site switch
 * list, peer-inferred LLDP) so their filters can't drift apart.
 *
 * Order matches `resolveInfraParentAsset`: definitive serial, then the FMG
 * device name, then the hostname. All three are OR'd in one query — the order is
 * documentation, not precedence, since any match makes the row a child.
 *
 * Why the hostname is LAST and still present: it was the only key these call
 * sites used before 2026-08, and it is correct on every install where the FMG
 * device name happens to equal the gate's configured hostname. Dropping it would
 * silently unparent children of a firewall whose `deviceName` stamp predates
 * that field.
 *
 * Returns a plain array; spread it into an `OR`. EMPTY when the gate exposes no
 * identity at all — callers must treat that as "no children" rather than pass
 * `OR: []` to Prisma, which matches nothing in a much less obvious way.
 */
export function controllerStampWhereOr(id: ControllerIdentity): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const push = (key: string, value: string | null | undefined) => {
    if (!value) return;
    const dedup = `${key}:${value}`;
    if (seen.has(dedup)) return;
    seen.add(dedup);
    out.push({ fortinetTopology: { path: [key], equals: value } });
  };
  push("controllerSerial", id.serialNumber);
  push("controllerFortigate", id.deviceName);
  push("controllerFortigate", id.hostname);
  return out;
}

/**
 * The `OR` branches finding the PARENT asset named by one child stamp — the
 * reverse of `controllerStampWhereOr` (there: one gate, find its children;
 * here: one child, find its gate).
 *
 * Deliberately over-fetches rather than picking a winner in SQL: `findFirst`
 * with an OR gives no control over WHICH match comes back, so callers should
 * fetch with this and then run the candidates through `resolveInfraParentAsset`,
 * which applies the documented precedence deterministically. One query, one
 * decision, and the precedence lives in exactly one place.
 *
 * EMPTY when the stamp names nothing — treat as "no parent".
 */
export function parentAssetWhereOr(stamp: InfraParentStamp): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (stamp.serial) out.push({ serialNumber: stamp.serial });
  if (stamp.name) {
    out.push({ fortinetTopology: { path: ["deviceName"], equals: stamp.name } });
    out.push({ hostname: stamp.name });
    // A stamped "name" that is really a switch-id, i.e. a serial.
    out.push({ serialNumber: stamp.name });
  }
  return out;
}

/**
 * Read the FMG device name off a FIREWALL's own `fortinetTopology.deviceName`.
 * Returns null when absent (a firewall discovered before the stamp existed, or
 * a manually-created one), which every caller must tolerate.
 */
export function readFirewallDeviceName(topology: unknown): string | null {
  const t = (topology ?? null) as Record<string, unknown> | null;
  if (!t) return null;
  return typeof t.deviceName === "string" && t.deviceName.trim() ? t.deviceName.trim() : null;
}

/**
 * Every string a controller FortiGate might be named by in a CHILD's stamp or in
 * `Subnet.fortigateDevice`, most-definitive first. For the callers that compare
 * in memory or need a plain `in:` list rather than a JSON-path OR.
 */
export function controllerIdentityKeys(id: ControllerIdentity): string[] {
  const out: string[] = [];
  for (const v of [id.serialNumber, id.deviceName, id.hostname]) {
    const t = typeof v === "string" ? v.trim() : "";
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * The `OR` branches that match ONE topology stamp key against several identities
 * of the same device. Used for `parentSwitch`, where there is only one stamp key
 * but the value may be either the switch's hostname or its switch-id (= serial),
 * depending on what the reporting AP's LLDP table published.
 *
 * Duplicates and empties are dropped so an asset whose hostname equals its
 * serial produces one branch, not two.
 */
export function topologyStampWhereOr(
  key: string,
  values: Array<string | null | undefined>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const v of values) {
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push({ fortinetTopology: { path: [key], equals: v } });
  }
  return out;
}

/** As `readControllerStamp`, for an AP's wired uplink switch. There is no
 *  `parentSwitchSerial` stamp — the AP's LLDP table reports a name — but that
 *  name is usually the switch-id, which resolution step 3 handles. */
export function readParentSwitchStamp(topology: unknown): InfraParentStamp {
  const t = (topology ?? null) as Record<string, unknown> | null;
  if (!t) return {};
  return {
    serial: null,
    name: typeof t.parentSwitch === "string" ? t.parentSwitch : null,
  };
}
