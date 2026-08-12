/**
 * src/services/oidRegistry.ts — Symbolic name → numeric OID resolver.
 *
 * Loads every uploaded MIB from the database, parses out OBJECT-TYPE /
 * OBJECT IDENTIFIER / MODULE-IDENTITY / NOTIFICATION-TYPE / OBJECT-IDENTITY
 * assignments, and resolves each symbol against a built-in seed of standard
 * SMI roots + common vendor enterprise prefixes.
 *
 * Resolution is **scoped per asset**: when the SNMP probe asks for a symbol
 * for an asset with manufacturer=Cisco, model="Catalyst 2960", we look in
 *   (1) model-specific MIBs   (manufacturer="Cisco", model="Catalyst 2960")
 *   (2) vendor-wide MIBs      (manufacturer="Cisco", model=null)
 *   (3) generic MIBs          (manufacturer=null,    model=null)
 *   (4) built-in SMI seed
 * in that order. A model-specific upload therefore **overrides** the
 * vendor-wide upload for the same symbol — that's the point of letting users
 * upload device-specific MIBs even when the vendor MIB is already present.
 *
 * Each scoped numeric map is computed lazily on first request and cached
 * keyed by `${manufacturer ?? ""}|${model ?? ""}`. The cache is rebuilt from
 * scratch on every upload/delete (cheap — MIBs are small) and warmed at
 * startup so the first probe doesn't pay the load cost.
 *
 * For the UI's "vendor profile status" pill the registry exposes a separate
 * "universal" scope (manufacturer set, model omitted) — that's the floor of
 * coverage that applies to every asset from that vendor before any
 * per-model override is layered on top.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { stripComments } from "./mibParserUtils.js";

// ─── Seed ──────────────────────────────────────────────────────────────────
//
// Standard SMI roots from RFC 1155 / RFC 2578 plus a small set of vendor
// enterprise prefixes. Including the vendor prefixes lets users upload only
// the leaf MIB they care about (e.g. CISCO-PROCESS-MIB) without having to
// chase down every CISCO-SMI dependency first.
export const BUILT_IN_OIDS: Record<string, string> = {
  // Top-level
  ccitt: "0",
  iso: "1",
  "joint-iso-ccitt": "2",
  org: "1.3",
  dod: "1.3.6",
  internet: "1.3.6.1",
  directory: "1.3.6.1.1",
  mgmt: "1.3.6.1.2",
  "mib-2": "1.3.6.1.2.1",
  experimental: "1.3.6.1.3",
  private: "1.3.6.1.4",
  enterprises: "1.3.6.1.4.1",
  security: "1.3.6.1.5",
  snmpV2: "1.3.6.1.6",
  snmpDomains: "1.3.6.1.6.1",
  snmpProxys: "1.3.6.1.6.2",
  snmpModules: "1.3.6.1.6.3",
  // IEEE 802.1 anchor chain (1.0.8802.1.1.*).
  //
  // LLDP-MIB resolves without these because it spells every arc with an inline
  // number — `{ iso std(0) iso8802(8802) ieee802dot1(1) ieee802dot1mibs(1) 2 }`
  // — which tryResolveParts reads straight off the named-number syntax. The
  // IEEE8021-* family does NOT: IEEE8021-MSTP-MIB anchors at
  // `::= { ieee802dot1mibs 6 }` with that symbol IMPORTED from IEEE8021-TC-MIB.
  // Without a seed the module root is unresolvable, and because every other
  // symbol in the file chains off that root, the whole MIB resolves to nothing
  // rather than to a few gaps. Seeding the chain lets an operator upload one
  // leaf module without also chasing down the TC MIB — the same rationale as
  // the vendor enterprise prefixes below.
  std: "1.0",
  iso8802: "1.0.8802",
  ieee802dot1: "1.0.8802.1",
  ieee802dot1mibs: "1.0.8802.1.1",
  // BRIDGE-MIB (RFC 4188) anchors, for the same reason.
  //
  // stdMibLibrary resolves each bundled module INDEPENDENTLY against this seed
  // — there is deliberately no cross-MIB visibility — so a module that anchors
  // on a symbol IMPORTed from BRIDGE-MIB cannot see it even when BRIDGE-MIB is
  // bundled right alongside. Measured against the real files: without these,
  // Q-BRIDGE-MIB resolves 0 of 129 assignments (its whole tree hangs off
  // `dot1dBridge`) and RSTP-MIB 9 of 19 (`dot1dStp`). Values read off
  // BRIDGE-MIB itself: `dot1dBridge ::= { mib-2 17 }`, `dot1dStp ::=
  // { dot1dBridge 2 }`.
  dot1dBridge: "1.3.6.1.2.1.17",
  dot1dStp: "1.3.6.1.2.1.17.2",
  // Cisco
  cisco: "1.3.6.1.4.1.9",
  ciscoMgmt: "1.3.6.1.4.1.9.9",
  // CISCO-PROCESS-MIB::cpmCPUTotal5secRev — column OID of the cpmCPUTotal
  // table; walked + averaged at probe time. Seeded so the vendor telemetry
  // profile resolves CPU without requiring CISCO-PROCESS-MIB to be uploaded.
  cpmCPUTotal5secRev: "1.3.6.1.4.1.9.9.109.1.1.1.1.6",
  // CISCO-MEMORY-POOL-MIB::ciscoMemoryPool{Used,Free} — column OIDs of the
  // pool table; walked + summed at probe time. Seeded so the vendor profile
  // resolves memory without requiring CISCO-MEMORY-POOL-MIB to be uploaded.
  ciscoMemoryPoolUsed: "1.3.6.1.4.1.9.9.48.1.1.1.5",
  ciscoMemoryPoolFree: "1.3.6.1.4.1.9.9.48.1.1.1.6",
  // Juniper
  juniperMIB: "1.3.6.1.4.1.2636",
  // JUNIPER-MIB::jnxOperatingCPU / jnxOperatingBuffer — column OIDs of the
  // jnxOperatingTable; walked + averaged at probe time. Seeded so the vendor
  // profile resolves CPU/memory without requiring JUNIPER-MIB to be uploaded.
  jnxOperatingCPU: "1.3.6.1.4.1.2636.3.1.13.1.8",
  jnxOperatingBuffer: "1.3.6.1.4.1.2636.3.1.13.1.11",
  // Mikrotik
  mikrotik: "1.3.6.1.4.1.14988",
  mtxrSystem: "1.3.6.1.4.1.14988.1.1.3",
  // Aruba / HP / HPE
  hp: "1.3.6.1.4.1.11",
  hpSwitch: "1.3.6.1.4.1.11.2.14.11.5.1.9",
  // STATISTICS-MIB::hpSwitchCpuStat — scalar percent. Seeded so the vendor
  // profile resolves CPU without requiring STATISTICS-MIB to be uploaded.
  hpSwitchCpuStat: "1.3.6.1.4.1.11.2.14.11.5.1.9.6.1",
  // Fortinet
  fortinet: "1.3.6.1.4.1.12356",
  fnFortiGateMib: "1.3.6.1.4.1.12356.101",
  // Stable across every FortiOS release; seeded so the vendor telemetry
  // profile resolves CPU/memory without requiring FORTINET-FORTIGATE-MIB
  // to be uploaded — matches the always-on temperature fallback path.
  fgSysCpuUsage: "1.3.6.1.4.1.12356.101.4.1.3",
  fgSysMemUsage: "1.3.6.1.4.1.12356.101.4.1.4",
  // FortiSwitch (FORTINET-FORTISWITCH-MIB). Unlike FortiGate, the .3/.4
  // pair here is the used/total *bytes* form, not CPU/MemPercent. Seeded so
  // the vendor profile resolves CPU/memory without requiring the MIB upload.
  fnFortiSwitchMib:  "1.3.6.1.4.1.12356.106",
  // fsSysVersion @ .1 → combined "model-firmware" string, e.g.
  // "S548DF-v7.2.5-build0453,230511 (GA)". The system-info scrape reads it
  // to derive the real hardware model (utils/fortiswitchModel.ts) — FMG /
  // FortiGate discovery has no model field for managed switches.
  fsSysVersion:      "1.3.6.1.4.1.12356.106.4.1.1",
  // fsSysCpuUsage @ .2 → scalar percent (0..100). Distinct from FortiGate's
  // fgSysCpuUsage which lives under the 12356.101 root.
  fsSysCpuUsage:     "1.3.6.1.4.1.12356.106.4.1.2",
  fsSysMemUsage:     "1.3.6.1.4.1.12356.106.4.1.3",
  fsSysMemCapacity:  "1.3.6.1.4.1.12356.106.4.1.4",
  // Disk used/total bytes. FortiSwitches don't implement HOST-RESOURCES-MIB
  // hrStorageTable, so collectSystemInfoSnmp's standard storage walk yields
  // nothing — the vendor disk-fallback in the same function reads these
  // scalars instead and synthesizes one StorageSample row.
  fsSysDiskUsage:    "1.3.6.1.4.1.12356.106.4.1.5",
  fsSysDiskCapacity: "1.3.6.1.4.1.12356.106.4.1.6",
  // FortiAP (FORTINET-FORTIAP-MIB). Distinct OID root @ 12356.120; the
  // FortiAP doesn't expose anything under the FortiGate root (12356.101) or
  // the FortiSwitch root (12356.106). The vendor telemetry profile resolves
  // CPU/memory/temperature against these three seeds so the probe works
  // without uploading FORTINET-FORTIAP-MIB. Single-scalar form throughout,
  // matching FortiGate (NOT the bytes form FortiSwitch uses for memory).
  fnFortiAPMib:    "1.3.6.1.4.1.12356.120",
  fapCommon:       "1.3.6.1.4.1.12356.120.1",
  fapWTPStatus:    "1.3.6.1.4.1.12356.120.3",
  fapCpuUsage:     "1.3.6.1.4.1.12356.120.3.41",
  fapMemoryUsage:  "1.3.6.1.4.1.12356.120.3.42",
  fapTemperature:  "1.3.6.1.4.1.12356.120.3.44",
  // Dell
  dell: "1.3.6.1.4.1.674",
  // Dell PowerConnect / Force10 platforms are RADLAN-derived and expose CPU
  // under the RADLAN enterprise (89), not Dell's own (674). Seeded so the
  // vendor profile resolves CPU without requiring the RADLAN MIB upload.
  radlan: "1.3.6.1.4.1.89",
  rlCpuUtilDuringLastMinute: "1.3.6.1.4.1.89.1.7",
};

// ─── Parser ────────────────────────────────────────────────────────────────

interface ParsedAssignment {
  name: string;
  parts: string[]; // raw ::= { ... } body — mix of identifier names and integer literals
}

const ASSIGNMENT_RE =
  /\b([a-z][\w-]*)\s+(?:OBJECT-TYPE|OBJECT\s+IDENTIFIER|MODULE-IDENTITY|OBJECT-IDENTITY|NOTIFICATION-TYPE|OBJECT-GROUP|NOTIFICATION-GROUP|MODULE-COMPLIANCE)\b[\s\S]*?::=\s*\{\s*([^{}]+?)\s*\}/g;

export function parseObjectAssignments(rawText: string): ParsedAssignment[] {
  const stripped = stripComments(rawText);
  const out: ParsedAssignment[] = [];
  let m: RegExpExecArray | null;
  ASSIGNMENT_RE.lastIndex = 0;
  while ((m = ASSIGNMENT_RE.exec(stripped))) {
    const name = m[1];
    if (/^[A-Z]/.test(name)) continue;
    const parts = m[2].trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    out.push({ name, parts });
  }
  return out;
}

// ─── Loaded MIBs ───────────────────────────────────────────────────────────

interface LoadedMib {
  id: string;
  moduleName: string;
  manufacturer: string | null;
  model: string | null;
  entries: ParsedAssignment[];
}

let _mibs: LoadedMib[] | null = null;
let _loadingPromise: Promise<void> | null = null;

// Per-scope resolution cache. Key is `${manufacturer ?? ""}|${model ?? ""}`.
// Values store both the OID and which MIB (if any) provided it, for the UI.
interface ResolvedSymbol {
  oid: string;
  fromMibId: string | null;        // null = built-in seed
  fromModuleName: string | null;
  fromScope: "device" | "vendor" | "generic" | "seed";
}

const _scopeCache: Map<string, Map<string, ResolvedSymbol>> = new Map();

function scopeKey(manufacturer: string | null | undefined, model: string | null | undefined): string {
  return `${(manufacturer ?? "").toLowerCase()}|${(model ?? "").toLowerCase()}`;
}

async function loadInternal(): Promise<void> {
  const rows = await prisma.mibFile.findMany({
    select: { id: true, moduleName: true, manufacturer: true, model: true, contents: true },
  });

  const mibs: LoadedMib[] = [];
  for (const row of rows) {
    try {
      const entries = parseObjectAssignments(row.contents);
      mibs.push({
        id: row.id,
        moduleName: row.moduleName,
        manufacturer: row.manufacturer,
        model: row.model,
        entries,
      });
    } catch (err: any) {
      logger.warn({ mib: row.moduleName, err: err?.message }, "MIB parse failed during oidRegistry refresh");
    }
  }

  _mibs = mibs;
  _scopeCache.clear();

  if (rows.length > 0) {
    logger.info({ mibs: rows.length }, "MIB symbol table loaded");
  }
}

async function ensureLoaded(): Promise<void> {
  if (_mibs) return;
  if (!_loadingPromise) _loadingPromise = loadInternal();
  await _loadingPromise;
  _loadingPromise = null;
}

// ─── Resolution ────────────────────────────────────────────────────────────

function isInteger(s: string): boolean {
  return /^\d+$/.test(s);
}

// ASN.1 named-number syntax: `std(0)` means "the arc named `std` with value
// 0". LLDP-MIB's MODULE-IDENTITY anchors at
//   ::= { iso std(0) iso8802(8802) ieee802dot1(1) ieee802dot1mibs(1) 2 }
// using this idiom. We extract the digit directly; any name on the LHS is
// just human documentation in this position.
const NAMED_NUMBER_RE = /^[a-zA-Z][\w-]*\((\d+)\)$/;

export function tryResolveParts(parts: string[], numeric: Map<string, string>): string | null {
  if (parts.length === 0) return null;

  function partToOid(p: string, isFirst: boolean): string | null {
    if (isInteger(p)) return p;
    const namedNum = NAMED_NUMBER_RE.exec(p);
    if (namedNum) return namedNum[1];
    if (numeric.has(p)) return numeric.get(p)!;
    return null;
  }

  const head = partToOid(parts[0], true);
  if (head == null) return null;
  let prefix = head;
  for (let i = 1; i < parts.length; i++) {
    const v = partToOid(parts[i], false);
    if (v == null) return null;
    prefix += "." + v;
  }
  return prefix;
}

/**
 * The distinct EXTERNAL symbols a MIB leans on but never defines — the actual
 * cause when an upload resolves to nothing.
 *
 * An unresolved MIB almost always has ONE root problem rather than N
 * independent ones. A module anchored on an IMPORTed symbol
 * (IEEE8021-MSTP-MIB's `::= { ieee802dot1mibs 6 }`) fails at its root, and
 * because every other assignment in the file chains off that root they all
 * fail with it. A count tells an operator how bad it is; the missing anchor
 * tells them what to upload.
 *
 * Locally-defined names are deliberately skipped even when unresolved — those
 * are symptoms, not causes. Only names referenced in some assignment body and
 * defined NOWHERE (not in this MIB, not in the seed, not in a co-scoped
 * upload) come back, which is precisely the missing IMPORTS dependency.
 */
export function findUnresolvedRootSymbols(
  rawText: string,
  resolved: ReadonlyMap<string, string | null>,
): string[] {
  const entries = parseObjectAssignments(rawText);
  const localNames = new Set(entries.map((e) => e.name));
  const roots = new Set<string>();

  // `resolveSymbolsForMib` keys EVERY symbol in the module and stores null for
  // the ones it couldn't resolve, so membership is not resolution — a bare
  // `.has()` here would treat every unresolved symbol as fine and report
  // nothing at all. Presence of a non-null value is the actual test.
  const isResolved = (n: string): boolean => resolved.get(n) != null;

  for (const { name, parts } of entries) {
    if (isResolved(name)) continue;
    for (const p of parts) {
      if (isInteger(p) || NAMED_NUMBER_RE.test(p)) continue;
      if (isResolved(p) || localNames.has(p)) continue;
      roots.add(p);
    }
  }
  return [...roots].sort();
}

// Run resolution for a given scope. The MIB layers are processed in
// generic → vendor → device order so that later layers overwrite earlier
// ones. After laying down all symbols we make repeated forward passes to
// resolve dependents (e.g. a leaf OID whose parent was overridden by a
// later layer).
function resolveScope(
  manufacturer: string | null | undefined,
  model: string | null | undefined,
): Map<string, ResolvedSymbol> {
  if (!_mibs) return new Map();

  // Layered selection. We compare manufacturer / model case-insensitively
  // because operators may type "Cisco" / "cisco" / "CISCO" interchangeably.
  const lcMfr   = manufacturer ? manufacturer.toLowerCase() : null;
  const lcModel = model        ? model.toLowerCase()        : null;

  const generic = _mibs.filter((m) => m.manufacturer === null);
  const vendor  = lcMfr
    ? _mibs.filter((m) => m.manufacturer?.toLowerCase() === lcMfr && m.model === null)
    : [];
  const device  = lcMfr && lcModel
    ? _mibs.filter((m) => m.manufacturer?.toLowerCase() === lcMfr && m.model?.toLowerCase() === lcModel)
    : [];

  // Seed numeric table; provenance comes from the resolved-symbol map below.
  const numeric = new Map<string, string>(Object.entries(BUILT_IN_OIDS));
  const provenance = new Map<string, ResolvedSymbol>();
  for (const [name, oid] of Object.entries(BUILT_IN_OIDS)) {
    provenance.set(name, { oid, fromMibId: null, fromModuleName: null, fromScope: "seed" });
  }

  const layers: { mibs: LoadedMib[]; layer: ResolvedSymbol["fromScope"] }[] = [
    { mibs: generic, layer: "generic" },
    { mibs: vendor,  layer: "vendor"  },
    { mibs: device,  layer: "device"  },
  ];

  for (const { mibs, layer } of layers) {
    if (mibs.length === 0) continue;

    // Collect every entry from this layer, then iteratively resolve until a
    // pass adds nothing. This catches forward references inside one MIB
    // (cpmCPUTotal5secRev → cpmCPUTotalEntry → cpmCPUTotalTable → cpmCPU)
    // and across layers (a device MIB referencing a vendor symbol).
    const pending: { entry: ParsedAssignment; mib: LoadedMib }[] = [];
    for (const mib of mibs) for (const entry of mib.entries) pending.push({ entry, mib });

    let progress = true;
    while (progress && pending.length > 0) {
      progress = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const { entry, mib } = pending[i];
        const resolved = tryResolveParts(entry.parts, numeric);
        if (resolved != null) {
          // Higher layers overwrite lower ones — that's the point of scoped
          // resolution. Within a layer, later MIBs win for the same name (an
          // operator who uploads two conflicting Cisco MIBs gets the most
          // recent one; cleaner solutions would warn, but in practice this
          // case is vanishingly rare).
          numeric.set(entry.name, resolved);
          provenance.set(entry.name, {
            oid: resolved,
            fromMibId: mib.id,
            fromModuleName: mib.moduleName,
            fromScope: layer,
          });
          pending.splice(i, 1);
          progress = true;
        }
      }
    }
  }

  return provenance;
}

function getScopeMap(
  manufacturer: string | null | undefined,
  model: string | null | undefined,
): Map<string, ResolvedSymbol> {
  const key = scopeKey(manufacturer, model);
  let cached = _scopeCache.get(key);
  if (!cached) {
    cached = resolveScope(manufacturer, model);
    _scopeCache.set(key, cached);
  }
  return cached;
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface ResolveScope {
  manufacturer?: string | null;
  model?: string | null;
}

/**
 * Resolve a symbolic OID name to its numeric form for a given asset scope.
 * Returns `null` when the name isn't defined in any MIB visible at this
 * scope (or any of its parent scopes back to the built-in seed).
 */
export async function resolveOid(name: string, scope: ResolveScope = {}): Promise<string | null> {
  await ensureLoaded();
  const map = getScopeMap(scope.manufacturer, scope.model);
  return map.get(name)?.oid ?? null;
}

/**
 * Synchronous variant for hot probe paths. Caller must have awaited
 * `ensureRegistryLoaded()` once before; returns null until that completes.
 * Note: only the (manufacturer-only) and (manufacturer+model) caches that
 * have already been populated will return values — call `resolveOid()` once
 * with the same scope before using the sync variant.
 */
export function resolveOidSync(name: string, scope: ResolveScope = {}): string | null {
  if (!_mibs) return null;
  const map = getScopeMap(scope.manufacturer, scope.model);
  return map.get(name)?.oid ?? null;
}

export async function ensureRegistryLoaded(): Promise<void> {
  await ensureLoaded();
}

export async function refreshRegistry(): Promise<void> {
  _mibs = null;
  _loadingPromise = null;
  _scopeCache.clear();
  await ensureLoaded();
}

// ─── Introspection — used by the UI status pill ───────────────────────────

export interface SymbolStatus {
  symbol: string;
  resolved: boolean;
  oid: string | null;
  fromScope: ResolvedSymbol["fromScope"] | null;
  fromModuleName: string | null;
}

/**
 * Resolve a single symbol at the **universal** (manufacturer-only) scope.
 * That's the floor of coverage that every asset from this vendor gets
 * before any model-specific upload is layered on top — useful for the UI's
 * "is this vendor profile ready?" indicator.
 */
export async function resolveSymbolAtVendorScope(
  manufacturer: string,
  symbol: string,
): Promise<SymbolStatus> {
  await ensureLoaded();
  const map = getScopeMap(manufacturer, null);
  const r = map.get(symbol);
  return {
    symbol,
    resolved: !!r,
    oid: r?.oid ?? null,
    fromScope: r?.fromScope ?? null,
    fromModuleName: r?.fromModuleName ?? null,
  };
}

/**
 * Distinct list of model values for which device-specific MIBs have been
 * uploaded under the given manufacturer. Used by the status pill to show
 * "Model overrides for: Catalyst 2960, Nexus 7000".
 */
export async function listModelOverrides(manufacturer: string): Promise<{ model: string; mibCount: number }[]> {
  await ensureLoaded();
  if (!_mibs) return [];
  const lc = manufacturer.toLowerCase();
  const counts = new Map<string, number>();
  for (const m of _mibs) {
    if (m.manufacturer?.toLowerCase() !== lc) continue;
    if (!m.model) continue;
    counts.set(m.model, (counts.get(m.model) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([model, mibCount]) => ({ model, mibCount }))
    .sort((a, b) => a.model.localeCompare(b.model));
}

/** Number of resolved symbols contributed by a specific MIB row id. */
export async function getMibSymbolCount(mibId: string): Promise<number> {
  await ensureLoaded();
  if (!_mibs) return 0;
  const mib = _mibs.find((m) => m.id === mibId);
  if (!mib) return 0;
  // Count is the same regardless of scope — it's just "how many of this
  // MIB's declarations would resolve when it's loaded into a scope where
  // its dependencies are present". We use the manufacturer scope for the
  // count so vendor MIBs see their own dependencies, which is the typical
  // case. Generic MIBs use the empty scope.
  const scope = mib.manufacturer
    ? { manufacturer: mib.manufacturer, model: mib.model }
    : {};
  const numeric = getScopeMap(scope.manufacturer, scope.model);
  return mib.entries.filter((e) => numeric.has(e.name)).length;
}

/**
 * Resolve every symbol declared by the given MIB to its numeric OID at the
 * MIB's natural scope (its own manufacturer + model layer, falling back to
 * vendor-only and generic layers as `getScopeMap` does for any probe).
 *
 * Used by the `/server-settings/mibs/:id/structure` browse endpoint and by
 * the MIB-aware walk endpoint to map an operator-selected symbol back to a
 * numeric OID for `snmpWalkRaw`. Symbols whose dependencies are not present
 * (a missing IMPORTS dependency, e.g. CISCO-PROCESS-MIB importing
 * `entPhysicalIndex` from an un-uploaded ENTITY-MIB) return `null` rather
 * than throwing, so the UI can render them with a "(unresolved)" hint.
 *
 * Returns null when the MIB row id doesn't exist in the registry.
 */
export async function resolveSymbolsForMib(
  mibId: string,
): Promise<Map<string, string | null> | null> {
  await ensureLoaded();
  if (!_mibs) return null;
  const mib = _mibs.find((m) => m.id === mibId);
  if (!mib) return null;
  const scope = mib.manufacturer
    ? { manufacturer: mib.manufacturer, model: mib.model }
    : {};
  const numeric = getScopeMap(scope.manufacturer, scope.model);
  const out = new Map<string, string | null>();
  for (const entry of mib.entries) {
    const resolved = numeric.get(entry.name);
    out.set(entry.name, resolved?.oid ?? null);
  }
  return out;
}

/**
 * Resolve a single symbol against an explicit MIB's natural scope. Same
 * fallback chain as `resolveSymbolsForMib`. Returns null when the MIB id
 * doesn't exist or the symbol can't be resolved at this scope.
 *
 * Used by the MIB-aware walk endpoint when the operator picks an object
 * by name from the browse modal — we resolve the name through the MIB's
 * own scope rather than the asset's scope (the operator chose THIS MIB
 * deliberately; resolving against e.g. a Catalyst's scope when the MIB is
 * Fortinet would silently miss the symbol).
 */
export async function resolveSymbolForMib(
  mibId: string,
  name: string,
): Promise<string | null> {
  const map = await resolveSymbolsForMib(mibId);
  if (!map) return null;
  return map.get(name) ?? null;
}
