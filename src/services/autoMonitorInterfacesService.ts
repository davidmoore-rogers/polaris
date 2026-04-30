/**
 * src/services/autoMonitorInterfacesService.ts
 *
 * "Auto-Monitor Interfaces" feature for the FMG/FortiGate integration. Lets an
 * operator pre-select which interfaces on every discovered FortiGate /
 * FortiSwitch / FortiAP get pinned for fast-cadence (~60s) polling — i.e.
 * added to Asset.monitoredInterfaces — instead of clicking "Poll 1m" by hand
 * on every asset's System tab.
 *
 * The selection is stored as JSON inside Integration.config under each
 * existing per-class block (fortigateMonitor / fortiswitchMonitor /
 * fortiapMonitor) and supports three modes:
 *
 *   - mode "names":    operator picks specific ifNames from an aggregated list
 *   - mode "wildcard": operator writes shell-style patterns (* and ?)
 *   - mode "type":     operator picks one or more ifTypes (physical/aggregate/...)
 *
 * Resolution always happens against each asset's latest AssetInterfaceSample
 * rows — no separate inventory table. The apply pass is strictly additive: it
 * never strips existing pins. This is deliberate; Asset.monitoredInterfaces is
 * operator-owned and removing items from it on every discovery would surprise
 * anyone who pinned something by hand.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";

// ─── Public types ───────────────────────────────────────────────────────────

export type AutoMonitorSelection =
  | { mode: "names"; names: string[] }
  | { mode: "wildcard"; patterns: string[]; onlyUp: boolean }
  | { mode: "type"; types: string[]; onlyUp: boolean }
  | null;

export type AutoMonitorClass = "fortigate" | "fortiswitch" | "fortiap";

/** Minimal interface shape consumed by the resolver. */
export interface ResolverInterface {
  ifName: string;
  ifType: string | null;
  operStatus: string | null;
}

const CLASS_TO_ASSET_TYPE: Record<AutoMonitorClass, string> = {
  fortigate: "firewall",
  fortiswitch: "switch",
  fortiap: "access_point",
};

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Compile a shell-style wildcard ("port4*", "wan?") into an anchored regex.
 * Escapes regex metacharacters so e.g. "port[1]" matches the literal string,
 * not a character class.
 */
export function compileWildcard(pattern: string): RegExp {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new AppError(400, "Empty wildcard pattern");
  }
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else if ("^$.|+()[]{}\\".includes(ch)) out += "\\" + ch;
    else out += ch;
  }
  try {
    return new RegExp("^" + out + "$");
  } catch (err: any) {
    throw new AppError(400, `Invalid wildcard "${pattern}": ${err?.message || "regex compile failed"}`);
  }
}

/**
 * Apply a selection to an asset's interface list. Pure: no DB, no I/O.
 * Returns the set of ifNames that should be pinned (excluding anything
 * already in Asset.monitoredInterfaces — the caller does the union).
 */
export function resolvePinnedInterfaces(
  selection: AutoMonitorSelection,
  interfaces: ResolverInterface[],
): string[] {
  if (!selection) return [];
  if (!interfaces || interfaces.length === 0) return [];

  if (selection.mode === "names") {
    const want = new Set(selection.names);
    return interfaces.filter((i) => want.has(i.ifName)).map((i) => i.ifName);
  }

  if (selection.mode === "wildcard") {
    if (selection.patterns.length === 0) return [];
    const regexes = selection.patterns.map(compileWildcard);
    const pool = selection.onlyUp ? interfaces.filter((i) => i.operStatus === "up") : interfaces;
    return pool
      .filter((i) => regexes.some((r) => r.test(i.ifName)))
      .map((i) => i.ifName);
  }

  if (selection.mode === "type") {
    if (selection.types.length === 0) return [];
    const want = new Set(selection.types);
    return interfaces
      .filter((i) => i.ifType !== null && want.has(i.ifType))
      .filter((i) => !selection.onlyUp || i.operStatus === "up")
      .map((i) => i.ifName);
  }

  return [];
}

// ─── DB-bound functions ─────────────────────────────────────────────────────

/**
 * Latest AssetInterfaceSample per (assetId, ifName) for every asset in
 * `assetIds`. Single round-trip via DISTINCT ON. Returns a Map keyed by
 * assetId; each value is the asset's interface list.
 */
async function loadLatestInterfaces(
  assetIds: string[],
): Promise<Map<string, ResolverInterface[]>> {
  const out = new Map<string, ResolverInterface[]>();
  if (assetIds.length === 0) return out;
  const rows = await prisma.$queryRaw<Array<{
    assetId: string;
    ifName: string;
    ifType: string | null;
    operStatus: string | null;
  }>>`
    SELECT DISTINCT ON ("assetId", "ifName")
      "assetId", "ifName", "ifType", "operStatus"
    FROM asset_interface_samples
    WHERE "assetId" = ANY(${assetIds}::uuid[])
    ORDER BY "assetId", "ifName", "timestamp" DESC
  `;
  for (const r of rows) {
    if (!out.has(r.assetId)) out.set(r.assetId, []);
    out.get(r.assetId)!.push({ ifName: r.ifName, ifType: r.ifType, operStatus: r.operStatus });
  }
  return out;
}

export interface AggregateRow {
  ifName: string;
  ifType: string | null;
  deviceCount: number;
  devices: Array<{ assetId: string; hostname: string | null; ipAddress: string | null }>;
}

/**
 * Aggregate every interface seen across the integration's assets of one class,
 * grouped by ifName. Powers the "By name" checklist and the "By type" counts.
 */
export async function getInterfaceAggregate(
  integrationId: string,
  klass: AutoMonitorClass,
): Promise<AggregateRow[]> {
  const assetType = CLASS_TO_ASSET_TYPE[klass];
  const assets = await prisma.asset.findMany({
    where: { discoveredByIntegrationId: integrationId, assetType: assetType as any },
    select: { id: true, hostname: true, ipAddress: true },
  });
  if (assets.length === 0) return [];
  const byAssetId = new Map(assets.map((a) => [a.id, a]));
  const interfacesByAsset = await loadLatestInterfaces(assets.map((a) => a.id));

  // Group by ifName across all assets.
  const byIfName = new Map<string, AggregateRow>();
  for (const [assetId, ifaces] of interfacesByAsset) {
    const asset = byAssetId.get(assetId);
    if (!asset) continue;
    for (const i of ifaces) {
      let row = byIfName.get(i.ifName);
      if (!row) {
        row = { ifName: i.ifName, ifType: i.ifType, deviceCount: 0, devices: [] };
        byIfName.set(i.ifName, row);
      }
      // Prefer a non-null ifType when one shows up later.
      if (row.ifType === null && i.ifType !== null) row.ifType = i.ifType;
      row.deviceCount += 1;
      row.devices.push({ assetId, hostname: asset.hostname, ipAddress: asset.ipAddress });
    }
  }

  return Array.from(byIfName.values()).sort((a, b) => {
    if (b.deviceCount !== a.deviceCount) return b.deviceCount - a.deviceCount;
    return a.ifName.localeCompare(b.ifName);
  });
}

export interface PreviewResult {
  deviceCount: number;
  interfaceCount: number;
  perDeviceMax: number;
  sampleDevices: Array<{ hostname: string | null; pinNames: string[] }>;
}

/**
 * Preview what `selection` would pin if applied right now. Does not write.
 * `interfaceCount` is the sum of pin lengths — i.e. what *this selection
 * alone* would produce, not unioned with whatever the operator pinned by
 * hand. That's intentional: the preview answers "what does my selection
 * cover", and existing manual pins are a separate concern.
 */
export async function previewAutoMonitorForClass(
  integrationId: string,
  klass: AutoMonitorClass,
  selection: AutoMonitorSelection,
): Promise<PreviewResult> {
  if (!selection) return { deviceCount: 0, interfaceCount: 0, perDeviceMax: 0, sampleDevices: [] };
  const assetType = CLASS_TO_ASSET_TYPE[klass];
  const assets = await prisma.asset.findMany({
    where: { discoveredByIntegrationId: integrationId, assetType: assetType as any },
    select: { id: true, hostname: true },
  });
  if (assets.length === 0) return { deviceCount: 0, interfaceCount: 0, perDeviceMax: 0, sampleDevices: [] };
  const interfacesByAsset = await loadLatestInterfaces(assets.map((a) => a.id));

  let deviceCount = 0;
  let interfaceCount = 0;
  let perDeviceMax = 0;
  const matched: Array<{ hostname: string | null; pinNames: string[] }> = [];
  for (const a of assets) {
    const pin = resolvePinnedInterfaces(selection, interfacesByAsset.get(a.id) ?? []);
    if (pin.length === 0) continue;
    deviceCount += 1;
    interfaceCount += pin.length;
    if (pin.length > perDeviceMax) perDeviceMax = pin.length;
    matched.push({ hostname: a.hostname, pinNames: pin });
  }
  matched.sort((x, y) => (x.hostname || "").localeCompare(y.hostname || ""));
  return { deviceCount, interfaceCount, perDeviceMax, sampleDevices: matched.slice(0, 5) };
}

export interface ApplyResult {
  devices: number;
  interfacesAdded: number;
  perDeviceMax: number;
  sampleDevices: Array<{ assetId: string; hostname: string | null; pinNames: string[] }>;
}

/**
 * Apply `selection` to every asset of `klass` discovered by `integrationId`.
 * Strictly additive: pin = union(existing, computed); we never strip. Skips
 * the write when nothing would change so back-to-back discoveries stay quiet.
 */
export async function applyAutoMonitorForClass(
  integrationId: string,
  klass: AutoMonitorClass,
  selection: AutoMonitorSelection,
  _actor?: string,
): Promise<ApplyResult> {
  const empty: ApplyResult = { devices: 0, interfacesAdded: 0, perDeviceMax: 0, sampleDevices: [] };
  if (!selection) return empty;
  const assetType = CLASS_TO_ASSET_TYPE[klass];
  const assets = await prisma.asset.findMany({
    where: { discoveredByIntegrationId: integrationId, assetType: assetType as any },
    select: { id: true, hostname: true, monitoredInterfaces: true },
  });
  if (assets.length === 0) return empty;
  const interfacesByAsset = await loadLatestInterfaces(assets.map((a) => a.id));

  let devices = 0;
  let interfacesAdded = 0;
  let perDeviceMax = 0;
  const sampleDevices: ApplyResult["sampleDevices"] = [];

  for (const a of assets) {
    const computed = resolvePinnedInterfaces(selection, interfacesByAsset.get(a.id) ?? []);
    if (computed.length === 0) continue;
    const existing = new Set(a.monitoredInterfaces);
    const fresh = computed.filter((n) => !existing.has(n));
    if (fresh.length === 0) continue;
    const unioned = [...a.monitoredInterfaces, ...fresh];
    await prisma.asset.update({
      where: { id: a.id },
      data: { monitoredInterfaces: unioned },
    });
    devices += 1;
    interfacesAdded += fresh.length;
    if (unioned.length > perDeviceMax) perDeviceMax = unioned.length;
    if (sampleDevices.length < 5) {
      sampleDevices.push({ assetId: a.id, hostname: a.hostname, pinNames: fresh });
    }
  }

  return { devices, interfacesAdded, perDeviceMax, sampleDevices };
}
