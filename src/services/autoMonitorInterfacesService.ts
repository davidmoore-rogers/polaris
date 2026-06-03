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
 * fortiapMonitor) as a multi-block union — each block is independent and
 * the resolved pin set is the UNION across whichever blocks are present.
 * Missing key = block off; `null` selection = whole feature off.
 *
 *   byNames    : explicit ifNames the operator picked from an aggregated list
 *   byPatterns : pattern strings; regex=false treats them as shell wildcards
 *                (* and ?), regex=true treats them as raw anchor-free regex
 *   byTypes    : ifType set (physical / aggregate / vlan / loopback / tunnel)
 *   byLldp     : neighbor-assetType set; pins any interface whose LLDP
 *                neighbor matched a monitored Polaris asset of one of the
 *                selected types
 *
 * Resolution always happens against each asset's latest AssetInterfaceSample
 * rows. For the fortigate class those rows are augmented with synthetic
 * `ifType:"tunnel"` entries built from the latest AssetIpsecTunnelSample per
 * tunnel (see mergeTunnelsIntoInterfaces) — FortiOS phase1-interface tunnels
 * are real `config system interface` entries but the REST monitor endpoint
 * omits them, so they'd otherwise never appear in the "By name" / "By type"
 * pickers. The apply pass is strictly additive: it never strips existing pins.
 * This is deliberate; Asset.monitoredInterfaces is operator-owned and removing
 * items from it on every discovery would surprise anyone who pinned something
 * by hand.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { normalizeFortiapInterfaceName } from "../utils/fortiapInterfaceAlias.js";

// ─── Public types ───────────────────────────────────────────────────────────

/** Asset types that By LLDP can match against. Mirrors the AssetType enum. */
export const LLDP_NEIGHBOR_TYPES = [
  "firewall",
  "switch",
  "access_point",
  "server",
  "workstation",
  "router",
  "printer",
  "other",
] as const;
export type LldpNeighborType = (typeof LLDP_NEIGHBOR_TYPES)[number];

export const IF_TYPES = ["physical", "aggregate", "vlan", "loopback", "tunnel"] as const;
export type IfType = (typeof IF_TYPES)[number];

export interface ByNamesBlock    { names: string[] }
export interface ByPatternsBlock { patterns: string[]; regex: boolean; onlyUp: boolean }
export interface ByTypesBlock    { types: IfType[]; onlyUp: boolean }
export interface ByLldpBlock     { neighborTypes: LldpNeighborType[] }

/**
 * Multi-block selection. Each key is optional; presence = block enabled. A
 * `null` selection (or an object with all keys missing) is equivalent to the
 * whole feature being off and produces zero pins.
 */
export type AutoMonitorSelection = {
  byNames?:    ByNamesBlock;
  byPatterns?: ByPatternsBlock;
  byTypes?:    ByTypesBlock;
  byLldp?:     ByLldpBlock;
} | null;

export type AutoMonitorClass = "fortigate" | "fortiswitch" | "fortiap";

/** Minimal interface shape consumed by the resolver. */
export interface ResolverInterface {
  ifName: string;
  ifType: string | null;
  operStatus: string | null;
}

/**
 * Per-asset LLDP info passed alongside ResolverInterface[] when By LLDP is
 * in play. The resolver only needs the matched neighbor's assetType and
 * monitored flag — everything else (chassisId, system name, port id, ...)
 * lives in the AssetLldpNeighbor table but isn't consulted here.
 */
export interface LldpNeighborMatch {
  matchedAssetType: string | null;
  matchedAssetMonitored: boolean;
}

/** ifName → list of LLDP matches observed on that local port. */
export type LldpByIfName = Map<string, LldpNeighborMatch[]>;

const CLASS_TO_ASSET_TYPE: Record<AutoMonitorClass, string> = {
  fortigate: "firewall",
  fortiswitch: "switch",
  fortiap: "access_point",
};

// ─── Pattern compilation (wildcard vs regex) ────────────────────────────────

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
 * Compile an operator-supplied pattern, dispatching on the `regex` flag.
 * Wildcards are anchored (existing behavior). Regex is anchor-free — the
 * operator can include ^ and $ themselves if they want full-string match.
 * Either way the result is a usable RegExp that the resolver feeds ifNames to.
 */
export function compilePattern(pattern: string, regex: boolean): RegExp {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new AppError(400, "Empty pattern");
  }
  if (!regex) return compileWildcard(pattern);
  try {
    return new RegExp(pattern);
  } catch (err: any) {
    throw new AppError(400, `Invalid regex "${pattern}": ${err?.message || "regex compile failed"}`);
  }
}

// ─── Pure resolver ──────────────────────────────────────────────────────────

/**
 * Returns the set of ifNames a multi-block selection would pin on one asset.
 * Pure: no DB, no I/O. The set is the UNION across whichever blocks are
 * present; an empty / null selection produces zero pins. Caller does the
 * union with the asset's existing Asset.monitoredInterfaces.
 *
 * `lldpByIfName` is only consulted when `selection.byLldp` is set. Callers
 * that don't intend to use By LLDP can skip it; if it's missing AND byLldp
 * is set, By LLDP contributes nothing (rather than throwing).
 */
export function resolvePinnedInterfaces(
  selection: AutoMonitorSelection,
  interfaces: ResolverInterface[],
  lldpByIfName?: LldpByIfName,
): string[] {
  if (!selection) return [];
  if (!interfaces || interfaces.length === 0) return [];

  const picked = new Set<string>();

  // By name — explicit ifNames; up/down state ignored on purpose.
  if (selection.byNames && selection.byNames.names.length > 0) {
    const want = new Set(selection.byNames.names);
    for (const i of interfaces) if (want.has(i.ifName)) picked.add(i.ifName);
  }

  // By pattern — wildcards or regex per the block's `regex` flag.
  if (selection.byPatterns && selection.byPatterns.patterns.length > 0) {
    const regexes = selection.byPatterns.patterns.map((p) => compilePattern(p, selection.byPatterns!.regex));
    const pool = selection.byPatterns.onlyUp ? interfaces.filter((i) => i.operStatus === "up") : interfaces;
    for (const i of pool) if (regexes.some((r) => r.test(i.ifName))) picked.add(i.ifName);
  }

  // By type — ifType ∈ chosen set.
  if (selection.byTypes && selection.byTypes.types.length > 0) {
    const want = new Set(selection.byTypes.types);
    for (const i of interfaces) {
      if (i.ifType === null) continue;
      if (!want.has(i.ifType as IfType)) continue;
      if (selection.byTypes.onlyUp && i.operStatus !== "up") continue;
      picked.add(i.ifName);
    }
  }

  // By LLDP — an LLDP neighbor on this port matched a monitored Polaris asset
  // whose assetType is in the chosen set. Multiple neighbors on the same port
  // (shared media / aggregate) — any single match is enough to pin.
  if (selection.byLldp && selection.byLldp.neighborTypes.length > 0 && lldpByIfName && lldpByIfName.size > 0) {
    const want = new Set(selection.byLldp.neighborTypes);
    for (const i of interfaces) {
      const neighbors = lldpByIfName.get(i.ifName);
      if (!neighbors || neighbors.length === 0) continue;
      const hit = neighbors.some(
        (n) => n.matchedAssetMonitored && n.matchedAssetType !== null && want.has(n.matchedAssetType as LldpNeighborType),
      );
      if (hit) picked.add(i.ifName);
    }
  }

  return Array.from(picked);
}

// ─── IPsec tunnel → synthetic interface merge (pure) ─────────────────────────

/** Latest IPsec tunnel observation the merge helper consumes. */
export interface TunnelObservation {
  tunnelName: string;
  /** Phase-1 rollup status: "up" | "down" | "partial" | "dynamic". */
  status: string | null;
}

/**
 * Append IPsec tunnels to each asset's interface list as synthetic
 * `ifType: "tunnel"` rows so the auto-monitor "By name" / "By interface type"
 * pickers (and the preview/apply resolver) can see them. FortiOS phase1-
 * interface tunnels are real `config system interface` entries of type
 * `tunnel`, but the REST `/api/v2/monitor/system/interface` endpoint omits
 * them — so on REST-polled FortiGates they never reach asset_interface_samples
 * and would otherwise be invisible here. Their byte counters live in the
 * dedicated IPsec section (asset_ipsec_tunnel_samples); pinning one only adds
 * it to Asset.monitoredInterfaces, which yields IF-MIB counters on SNMP and
 * nothing on REST. See the module header.
 *
 * Pure: mutates `interfacesByAsset` in place and returns it. De-dupes per
 * asset against existing ifNames so a tunnel SNMP already captured as a real
 * interface row (ifType tunnel via IF-MIB ifType 131) isn't double-counted.
 *
 * operStatus mapping: only a fully-`down` tunnel maps to "down"; up / partial
 * / dynamic all map to "up" so the "only currently-up" filter on By type /
 * By pattern keeps healthy-but-not-fully-up tunnels (dial-up server templates
 * report "dynamic" and are operational by design).
 */
export function mergeTunnelsIntoInterfaces(
  interfacesByAsset: Map<string, ResolverInterface[]>,
  tunnelsByAsset: Map<string, TunnelObservation[]>,
): Map<string, ResolverInterface[]> {
  for (const [assetId, tunnels] of tunnelsByAsset) {
    if (tunnels.length === 0) continue;
    let list = interfacesByAsset.get(assetId);
    if (!list) { list = []; interfacesByAsset.set(assetId, list); }
    const existing = new Set(list.map((i) => i.ifName));
    for (const t of tunnels) {
      if (!t.tunnelName || existing.has(t.tunnelName)) continue;
      existing.add(t.tunnelName);
      list.push({
        ifName:     t.tunnelName,
        ifType:     "tunnel",
        operStatus: t.status === "down" ? "down" : "up",
      });
    }
  }
  return interfacesByAsset;
}

// ─── DB-bound functions ─────────────────────────────────────────────────────

/**
 * Latest AssetInterfaceSample per (assetId, ifName) for every asset in
 * `assetIds`. Single round-trip via DISTINCT ON. Returns a Map keyed by
 * assetId; each value is the asset's interface list.
 *
 * When `includeIpsecTunnels` is set (fortigate class only — switches/APs have
 * no IPsec), the latest IPsec tunnel per (assetId, tunnelName) is also pulled
 * from asset_ipsec_tunnel_samples and merged in as synthetic tunnel-type
 * interfaces via `mergeTunnelsIntoInterfaces`. The two reads run in parallel.
 */
async function loadLatestInterfaces(
  assetIds: string[],
  includeIpsecTunnels = false,
): Promise<Map<string, ResolverInterface[]>> {
  const out = new Map<string, ResolverInterface[]>();
  if (assetIds.length === 0) return out;
  // Bound the read to a recent window — without it the DISTINCT ON has to
  // walk the entire active hypertable chunk per (assetId, ifName) pair, the
  // same disaster pattern interfaceTopologyService.ts had to fix (observed
  // at 13.5 min / 90M rows / 9 GB I/O on prod). 72h tolerates the long end
  // of the pollInterval-linked systemInfo cadence (up to 24h) plus a couple
  // missed scrapes; APs that haven't reported in 3 days drop from the
  // "By name" checklist, which is the right behavior.
  const ifacesPromise = prisma.$queryRaw<Array<{
    assetId: string;
    ifName: string;
    ifType: string | null;
    operStatus: string | null;
  }>>`
    SELECT DISTINCT ON ("assetId", "ifName")
      "assetId", "ifName", "ifType", "operStatus"
    FROM asset_interface_samples
    WHERE "assetId" = ANY(${assetIds}::text[])
      AND "timestamp" > NOW() - INTERVAL '72 hours'
    ORDER BY "assetId", "ifName", "timestamp" DESC
  `;
  // IPsec tunnels (fortigate only): same 72h-bounded DISTINCT ON shape so the
  // picker surfaces phase1-interface tunnels the REST monitor endpoint omits.
  const tunnelsPromise = includeIpsecTunnels
    ? prisma.$queryRaw<Array<{ assetId: string; tunnelName: string; status: string | null }>>`
        SELECT DISTINCT ON ("assetId", "tunnelName")
          "assetId", "tunnelName", "status"
        FROM asset_ipsec_tunnel_samples
        WHERE "assetId" = ANY(${assetIds}::text[])
          AND "timestamp" > NOW() - INTERVAL '72 hours'
        ORDER BY "assetId", "tunnelName", "timestamp" DESC
      `
    : Promise.resolve([] as Array<{ assetId: string; tunnelName: string; status: string | null }>);

  const [rows, tunnelRows] = await Promise.all([ifacesPromise, tunnelsPromise]);
  for (const r of rows) {
    if (!out.has(r.assetId)) out.set(r.assetId, []);
    out.get(r.assetId)!.push({ ifName: r.ifName, ifType: r.ifType, operStatus: r.operStatus });
  }
  if (tunnelRows.length > 0) {
    const tunnelsByAsset = new Map<string, TunnelObservation[]>();
    for (const t of tunnelRows) {
      if (!tunnelsByAsset.has(t.assetId)) tunnelsByAsset.set(t.assetId, []);
      tunnelsByAsset.get(t.assetId)!.push({ tunnelName: t.tunnelName, status: t.status });
    }
    mergeTunnelsIntoInterfaces(out, tunnelsByAsset);
  }
  return out;
}

/**
 * Per-asset LLDP neighbor info, grouped by (assetId, localIfName). Joined to
 * Asset so we know the matched neighbor's assetType + monitored flag. Only
 * rows with a non-null matchedAssetId are returned — unmatched neighbors
 * can't satisfy "is an asset of type X" anyway.
 */
async function loadLldpByAsset(
  assetIds: string[],
): Promise<Map<string, LldpByIfName>> {
  const out = new Map<string, LldpByIfName>();
  if (assetIds.length === 0) return out;
  const rows = await prisma.$queryRaw<Array<{
    assetId: string;
    localIfName: string;
    matchedAssetType: string | null;
    matchedAssetMonitored: boolean | null;
  }>>`
    SELECT
      n."assetId"                 AS "assetId",
      n."localIfName"             AS "localIfName",
      a."assetType"::text         AS "matchedAssetType",
      a."monitored"               AS "matchedAssetMonitored"
    FROM asset_lldp_neighbors n
    LEFT JOIN assets a ON a.id = n."matchedAssetId"
    WHERE n."assetId" = ANY(${assetIds}::text[])
      AND n."matchedAssetId" IS NOT NULL
  `;
  for (const r of rows) {
    let perAsset = out.get(r.assetId);
    if (!perAsset) { perAsset = new Map(); out.set(r.assetId, perAsset); }
    let list = perAsset.get(r.localIfName);
    if (!list) { list = []; perAsset.set(r.localIfName, list); }
    list.push({
      matchedAssetType: r.matchedAssetType,
      matchedAssetMonitored: r.matchedAssetMonitored === true,
    });
  }
  return out;
}

/** True iff the selection mentions byLldp (so the apply path knows to load LLDP). */
function selectionUsesLldp(sel: AutoMonitorSelection): boolean {
  return !!sel?.byLldp && sel.byLldp.neighborTypes.length > 0;
}

/**
 * Peer-inferred LLDP matches synthesized from `Asset.fortinetTopology` so
 * "By LLDP" covers managed FortiAPs whose FortiSwitch silently consumes
 * LLDP without re-publishing via SNMP LLDP-MIB. Same data source as the
 * inferred Neighbor column on the System tab (peerInferredLldpService).
 *
 * Three class-aware queries:
 *   - klass=fortigate     → child switches name this FG as controllerFortigate.
 *                           Emit on FG's id at localIfName = switch.uplinkInterface
 *                           (FortiGate-side FortiLink port name).
 *   - klass=fortiswitch   → child APs name this switch as parentSwitch. Emit
 *                           on switch's id at localIfName = ap.parentPort.
 *   - klass=fortiap       → self has parentSwitch + uplinkInterface (AP-local
 *                           port). Emit on AP's id at that localIfName, with
 *                           the matched switch's monitored flag.
 */
async function loadInferredLldpByAsset(
  assets: ReadonlyArray<{ id: string; hostname: string | null }>,
  klass: AutoMonitorClass,
): Promise<Map<string, LldpByIfName>> {
  const out = new Map<string, LldpByIfName>();
  const hostnames = assets.map((a) => a.hostname).filter((h): h is string => !!h && h.length > 0);
  if (hostnames.length === 0) return out;
  const byHostname = new Map<string, string>();
  for (const a of assets) if (a.hostname) byHostname.set(a.hostname, a.id);

  const add = (selfId: string, ifName: string, matchedAssetType: string, matchedMonitored: boolean) => {
    let perAsset = out.get(selfId);
    if (!perAsset) { perAsset = new Map(); out.set(selfId, perAsset); }
    let list = perAsset.get(ifName);
    if (!list) { list = []; perAsset.set(ifName, list); }
    list.push({ matchedAssetType, matchedAssetMonitored: matchedMonitored });
  };

  if (klass === "fortigate") {
    const rows = await prisma.$queryRaw<Array<{
      controllerFortigate: string;
      uplinkInterface: string;
      monitored: boolean;
    }>>`
      SELECT
        "fortinetTopology"->>'controllerFortigate' AS "controllerFortigate",
        "fortinetTopology"->>'uplinkInterface'     AS "uplinkInterface",
        monitored                                  AS "monitored"
      FROM assets
      WHERE "assetType"::text = 'switch'
        AND "fortinetTopology"->>'controllerFortigate' = ANY(${hostnames}::text[])
        AND "fortinetTopology"->>'uplinkInterface' IS NOT NULL
    `;
    for (const r of rows) {
      const fgId = byHostname.get(r.controllerFortigate);
      if (!fgId) continue;
      add(fgId, r.uplinkInterface, "switch", r.monitored === true);
    }
  } else if (klass === "fortiswitch") {
    const rows = await prisma.$queryRaw<Array<{
      parentSwitch: string;
      parentPort: string;
      monitored: boolean;
    }>>`
      SELECT
        "fortinetTopology"->>'parentSwitch' AS "parentSwitch",
        "fortinetTopology"->>'parentPort'   AS "parentPort",
        monitored                           AS "monitored"
      FROM assets
      WHERE "assetType"::text = 'access_point'
        AND "fortinetTopology"->>'parentSwitch' = ANY(${hostnames}::text[])
        AND "fortinetTopology"->>'parentPort' IS NOT NULL
    `;
    for (const r of rows) {
      const swId = byHostname.get(r.parentSwitch);
      if (!swId) continue;
      add(swId, r.parentPort, "access_point", r.monitored === true);
    }
  } else if (klass === "fortiap") {
    // For each in-scope AP that has parentSwitch + uplinkInterface, resolve
    // the switch by hostname so we can carry its monitored flag.
    const apRows = await prisma.$queryRaw<Array<{
      id: string;
      parentSwitch: string;
      uplinkInterface: string;
    }>>`
      SELECT
        id,
        "fortinetTopology"->>'parentSwitch'     AS "parentSwitch",
        "fortinetTopology"->>'uplinkInterface'  AS "uplinkInterface"
      FROM assets
      WHERE id = ANY(${assets.map((a) => a.id)}::text[])
        AND "fortinetTopology"->>'parentSwitch' IS NOT NULL
        AND "fortinetTopology"->>'uplinkInterface' IS NOT NULL
    `;
    if (apRows.length > 0) {
      const switchHostnames = [...new Set(apRows.map((r) => r.parentSwitch))];
      const switches = await prisma.asset.findMany({
        where: { hostname: { in: switchHostnames }, assetType: "switch" as any },
        select: { hostname: true, monitored: true },
      });
      const swMonitoredByHostname = new Map<string, boolean>();
      for (const sw of switches) if (sw.hostname) swMonitoredByHostname.set(sw.hostname, sw.monitored === true);
      for (const r of apRows) {
        if (!swMonitoredByHostname.has(r.parentSwitch)) continue;
        add(r.id, r.uplinkInterface, "switch", swMonitoredByHostname.get(r.parentSwitch)!);
      }
    }
  }

  return out;
}

/**
 * Rewrite fortiap inferred-LLDP keys from the FortiAP CLI naming used by
 * discovery (`lan1`, `lan2`, ...) into the SNMP-canonical names the AP's
 * own IF-MIB exposes (`eth0`, `eth1`, ...) so the entries line up with the
 * interface table AND with what `Asset.monitoredInterfaces` would have to
 * contain for fast-cadence pinning to actually scrape a real ifIndex.
 * Mutates `inferred` in place — collisions on rewrite merge into the
 * existing key. See `src/utils/fortiapInterfaceAlias.ts`.
 */
function normalizeFortiapInferredLldp(
  inferred: Map<string, LldpByIfName>,
  interfacesByAsset: Map<string, ResolverInterface[]>,
): void {
  for (const [assetId, byIf] of inferred) {
    const known = interfacesByAsset.get(assetId);
    if (!known || known.length === 0) continue;
    const knownIfNames = new Set(known.map((i) => i.ifName));
    const renames: Array<{ from: string; to: string }> = [];
    for (const ifName of byIf.keys()) {
      const normalized = normalizeFortiapInterfaceName(ifName, knownIfNames);
      if (normalized !== ifName) renames.push({ from: ifName, to: normalized });
    }
    for (const { from, to } of renames) {
      const matches = byIf.get(from)!;
      byIf.delete(from);
      const existing = byIf.get(to);
      if (existing) existing.push(...matches);
      else byIf.set(to, matches);
    }
  }
}

/**
 * Merge inferred matches into the real-LLDP map per (assetId, ifName).
 * Real entries come first, inferred appended after. Duplicates within an
 * ifName are harmless — `resolvePinnedInterfaces` looks for ANY match
 * satisfying the byLldp filter — so no dedupe.
 */
function mergeLldpMaps(
  base: Map<string, LldpByIfName>,
  extra: Map<string, LldpByIfName>,
): Map<string, LldpByIfName> {
  if (extra.size === 0) return base;
  for (const [assetId, extraByIf] of extra) {
    let baseByIf = base.get(assetId);
    if (!baseByIf) { baseByIf = new Map(); base.set(assetId, baseByIf); }
    for (const [ifName, matches] of extraByIf) {
      const existing = baseByIf.get(ifName);
      if (!existing) baseByIf.set(ifName, matches.slice());
      else existing.push(...matches);
    }
  }
  return base;
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
  const interfacesByAsset = await loadLatestInterfaces(assets.map((a) => a.id), klass === "fortigate");

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
  /**
   * Per-asset set difference between `selection` and the optional
   * `baselineSelection` (typically the previous in-flight selection or the
   * saved selection). Only present when `baselineSelection` is supplied to
   * `previewAutoMonitorForClass`. Drives the "+X / −Y" delta hint on the
   * auto-monitor card's live preview so operators see what each checkbox
   * toggle just changed without re-counting by hand.
   *
   * `addedCount` / `removedCount` count distinct (assetId, ifName) pairs,
   * not raw ifName strings — the same ifName on two devices is two pairs.
   * `addedSample` / `removedSample` carry up to 5 illustrative entries each
   * for the UI to surface.
   */
  diff?: {
    addedCount: number;
    removedCount: number;
    addedSample: Array<{ hostname: string | null; ifName: string }>;
    removedSample: Array<{ hostname: string | null; ifName: string }>;
  };
}

/**
 * Compute the per-asset pin set for `selection` against an already-loaded
 * (assets, interfacesByAsset, lldpByAsset) view. Pure — no DB I/O. Used by
 * the diff path so we can run two pin computations against one DB fetch.
 */
function computePinsByAsset(
  assets: ReadonlyArray<{ id: string; hostname: string | null }>,
  interfacesByAsset: Map<string, ResolverInterface[]>,
  lldpByAsset: Map<string, LldpByIfName>,
  selection: AutoMonitorSelection,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!selection) return out;
  for (const a of assets) {
    const pin = resolvePinnedInterfaces(
      selection,
      interfacesByAsset.get(a.id) ?? [],
      lldpByAsset.get(a.id),
    );
    if (pin.length === 0) continue;
    out.set(a.id, pin);
  }
  return out;
}

/**
 * Preview what `selection` would pin if applied right now. Does not write.
 * `interfaceCount` is the sum of pin lengths — i.e. what *this selection
 * alone* would produce, not unioned with whatever the operator pinned by
 * hand. That's intentional: the preview answers "what does my selection
 * cover", and existing manual pins are a separate concern.
 *
 * When `baselineSelection` is non-undefined the response carries a `diff`
 * block enumerating per-asset (assetId, ifName) pairs that the change in
 * selection just added or removed. `null` baselineSelection counts as "no
 * pins at all" so the diff shows the full current set as additions — that
 * matches the natural reading of "you just turned this block on for the
 * first time, here's what +X means."
 */
export async function previewAutoMonitorForClass(
  integrationId: string,
  klass: AutoMonitorClass,
  selection: AutoMonitorSelection,
  baselineSelection?: AutoMonitorSelection,
): Promise<PreviewResult> {
  const empty: PreviewResult = { deviceCount: 0, interfaceCount: 0, perDeviceMax: 0, sampleDevices: [] };
  const wantDiff = baselineSelection !== undefined;
  if (!selection && !wantDiff) return empty;

  const assetType = CLASS_TO_ASSET_TYPE[klass];
  const assets = await prisma.asset.findMany({
    where: { discoveredByIntegrationId: integrationId, assetType: assetType as any },
    select: { id: true, hostname: true },
  });
  if (assets.length === 0) {
    return wantDiff
      ? { ...empty, diff: { addedCount: 0, removedCount: 0, addedSample: [], removedSample: [] } }
      : empty;
  }
  const ids = assets.map((a) => a.id);
  // LLDP join is only needed if either selection uses byLldp; load once.
  const needLldp = selectionUsesLldp(selection) || (wantDiff && selectionUsesLldp(baselineSelection ?? null));
  const [interfacesByAsset, realLldp, inferredLldp] = await Promise.all([
    loadLatestInterfaces(ids, klass === "fortigate"),
    needLldp ? loadLldpByAsset(ids) : Promise.resolve(new Map<string, LldpByIfName>()),
    needLldp ? loadInferredLldpByAsset(assets, klass) : Promise.resolve(new Map<string, LldpByIfName>()),
  ]);
  if (needLldp && klass === "fortiap") normalizeFortiapInferredLldp(inferredLldp, interfacesByAsset);
  const lldpByAsset = mergeLldpMaps(realLldp, inferredLldp);

  const currentPins = computePinsByAsset(assets, interfacesByAsset, lldpByAsset, selection);

  // Build the preview shape from currentPins.
  let deviceCount = 0;
  let interfaceCount = 0;
  let perDeviceMax = 0;
  const matched: Array<{ hostname: string | null; pinNames: string[] }> = [];
  for (const a of assets) {
    const pin = currentPins.get(a.id);
    if (!pin || pin.length === 0) continue;
    deviceCount += 1;
    interfaceCount += pin.length;
    if (pin.length > perDeviceMax) perDeviceMax = pin.length;
    matched.push({ hostname: a.hostname, pinNames: pin });
  }
  matched.sort((x, y) => (x.hostname || "").localeCompare(y.hostname || ""));
  const result: PreviewResult = {
    deviceCount,
    interfaceCount,
    perDeviceMax,
    sampleDevices: matched.slice(0, 5),
  };

  if (!wantDiff) return result;

  // Diff currentPins against baselinePins, one (assetId, ifName) pair at a
  // time. Hostname is captured per-asset so the sample can render a useful
  // "hostname · ifName" pair without a second lookup.
  const baselinePins = computePinsByAsset(assets, interfacesByAsset, lldpByAsset, baselineSelection ?? null);
  const hostnameById = new Map(assets.map((a) => [a.id, a.hostname]));
  let addedCount = 0;
  let removedCount = 0;
  const addedSample: Array<{ hostname: string | null; ifName: string }> = [];
  const removedSample: Array<{ hostname: string | null; ifName: string }> = [];
  // Walk every asset that appears in either set so partial overlaps are
  // counted correctly. Per-asset comparison is cheap because pin lists are
  // small (rarely >50 interfaces).
  const allIds = new Set<string>([...currentPins.keys(), ...baselinePins.keys()]);
  for (const id of allIds) {
    const cur = currentPins.get(id) ?? [];
    const base = baselinePins.get(id) ?? [];
    if (cur.length === 0 && base.length === 0) continue;
    const baseSet = new Set(base);
    const curSet = new Set(cur);
    for (const n of cur) {
      if (!baseSet.has(n)) {
        addedCount += 1;
        if (addedSample.length < 5) addedSample.push({ hostname: hostnameById.get(id) ?? null, ifName: n });
      }
    }
    for (const n of base) {
      if (!curSet.has(n)) {
        removedCount += 1;
        if (removedSample.length < 5) removedSample.push({ hostname: hostnameById.get(id) ?? null, ifName: n });
      }
    }
  }
  result.diff = { addedCount, removedCount, addedSample, removedSample };
  return result;
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
  const ids = assets.map((a) => a.id);
  const needLldp = selectionUsesLldp(selection);
  const [interfacesByAsset, realLldp, inferredLldp] = await Promise.all([
    loadLatestInterfaces(ids, klass === "fortigate"),
    needLldp ? loadLldpByAsset(ids) : Promise.resolve(new Map<string, LldpByIfName>()),
    needLldp ? loadInferredLldpByAsset(assets, klass) : Promise.resolve(new Map<string, LldpByIfName>()),
  ]);
  if (needLldp && klass === "fortiap") normalizeFortiapInferredLldp(inferredLldp, interfacesByAsset);
  const lldpByAsset = mergeLldpMaps(realLldp, inferredLldp);

  // Two-phase apply: compute every pending update in memory FIRST, then
  // batch the prisma.asset.update calls in chunks so the network round-trips
  // don't serialize. The previous shape did `await prisma.asset.update` once
  // per asset inside the resolver loop, which on a fleet of a few hundred
  // switches stacked up enough round-trips to wedge the modal's "Applying..."
  // state for minutes (and exhaust the DB connection pool's headroom for the
  // rest of the app).
  //
  // Idempotency holds because the apply pass is strictly additive — a half-
  // landed batch produces the same final pin set as a fully-landed one
  // re-run (the next call recomputes `fresh` against the current
  // monitoredInterfaces and only fires for the rows that still need a
  // change). So we use Promise.allSettled rather than a $transaction; one
  // failed write doesn't block the other writes from landing, and the
  // operator just re-clicks Apply if they care to catch up.
  interface PendingUpdate {
    assetId:   string;
    hostname:  string | null;
    fresh:     string[];
    unionedLength: number;
    unionedNext:   string[];
  }
  const pending: PendingUpdate[] = [];
  let perDeviceMax = 0;
  for (const a of assets) {
    const computed = resolvePinnedInterfaces(
      selection,
      interfacesByAsset.get(a.id) ?? [],
      lldpByAsset.get(a.id),
    );
    if (computed.length === 0) continue;
    const existing = new Set(a.monitoredInterfaces);
    const fresh = computed.filter((n) => !existing.has(n));
    if (fresh.length === 0) continue;
    const unioned = [...a.monitoredInterfaces, ...fresh];
    if (unioned.length > perDeviceMax) perDeviceMax = unioned.length;
    pending.push({
      assetId:       a.id,
      hostname:      a.hostname,
      fresh,
      unionedLength: unioned.length,
      unionedNext:   unioned,
    });
  }
  if (pending.length === 0) return { devices: 0, interfacesAdded: 0, perDeviceMax: 0, sampleDevices: [] };

  // Chunked Promise.allSettled — mirrors `batchSettled` in
  // src/api/routes/integrations.ts. 50 is the conventional batch size in
  // this codebase; small enough to keep pool headroom for the rest of the
  // app on big fleets but large enough to amortize the per-batch overhead.
  const BATCH_SIZE = 50;
  let devices = 0;
  let interfacesAdded = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const chunk = pending.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      chunk.map((p) =>
        prisma.asset.update({
          where: { id: p.assetId },
          data:  { monitoredInterfaces: p.unionedNext },
        }),
      ),
    );
    for (let k = 0; k < results.length; k++) {
      const r = results[k];
      const p = chunk[k];
      if (!r || !p) continue;
      if (r.status === "fulfilled") {
        devices += 1;
        interfacesAdded += p.fresh.length;
      }
    }
  }

  // Sample devices used to be filled inline as updates landed; rebuild them
  // from the first 5 successful entries in pending order. Order is stable
  // across re-applies which keeps the toast deterministic.
  const sampleDevices: ApplyResult["sampleDevices"] = pending.slice(0, 5).map((p) => ({
    assetId:  p.assetId,
    hostname: p.hostname,
    pinNames: p.fresh,
  }));

  return { devices, interfacesAdded, perDeviceMax, sampleDevices };
}

// ─── Legacy shape coercion ──────────────────────────────────────────────────

/**
 * Coerce the pre-multi-block discriminated-union shape into the new shape.
 * Used both by the Zod parser (incoming legacy bodies) and by the one-shot
 * migration job (existing stored configs).
 *
 *   { mode: "names",    names }                  → { byNames:    { names } }
 *   { mode: "wildcard", patterns, onlyUp }       → { byPatterns: { patterns, regex: false, onlyUp } }
 *   { mode: "type",     types, onlyUp }          → { byTypes:    { types, onlyUp } }
 *
 * Already-new-shape objects pass through. Returns null for null/empty input.
 */
export function coerceLegacySelection(input: any): AutoMonitorSelection {
  if (!input || typeof input !== "object") return null;

  // New-shape: any of the four blocks present.
  if ("byNames" in input || "byPatterns" in input || "byTypes" in input || "byLldp" in input) {
    return input as AutoMonitorSelection;
  }

  // Legacy: { mode, ... }
  if (input.mode === "names" && Array.isArray(input.names)) {
    return { byNames: { names: input.names.slice() } };
  }
  if (input.mode === "wildcard" && Array.isArray(input.patterns)) {
    return {
      byPatterns: {
        patterns: input.patterns.slice(),
        regex:    false,
        onlyUp:   input.onlyUp === true,
      },
    };
  }
  if (input.mode === "type" && Array.isArray(input.types)) {
    return {
      byTypes: {
        types:  input.types.slice(),
        onlyUp: input.onlyUp !== false,
      },
    };
  }

  return null;
}
