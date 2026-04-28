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

// ─── Seed ──────────────────────────────────────────────────────────────────
//
// Standard SMI roots from RFC 1155 / RFC 2578 plus a small set of vendor
// enterprise prefixes. Including the vendor prefixes lets users upload only
// the leaf MIB they care about (e.g. CISCO-PROCESS-MIB) without having to
// chase down every CISCO-SMI dependency first.
const BUILT_IN_OIDS: Record<string, string> = {
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
  // Cisco
  cisco: "1.3.6.1.4.1.9",
  ciscoMgmt: "1.3.6.1.4.1.9.9",
  // Juniper
  juniperMIB: "1.3.6.1.4.1.2636",
  // Mikrotik
  mikrotik: "1.3.6.1.4.1.14988",
  mtxrSystem: "1.3.6.1.4.1.14988.1.1.3",
  // Aruba / HP / HPE
  hp: "1.3.6.1.4.1.11",
  hpSwitch: "1.3.6.1.4.1.11.2.14.11.5.1.9",
  // Fortinet
  fortinet: "1.3.6.1.4.1.12356",
  fnFortiGateMib: "1.3.6.1.4.1.12356.101",
  // Dell
  dell: "1.3.6.1.4.1.674",
};

// ─── Parser ────────────────────────────────────────────────────────────────

interface ParsedAssignment {
  name: string;
  parts: string[]; // raw ::= { ... } body — mix of identifier names and integer literals
}

const ASSIGNMENT_RE =
  /\b([a-z][\w-]*)\s+(?:OBJECT-TYPE|OBJECT\s+IDENTIFIER|MODULE-IDENTITY|OBJECT-IDENTITY|NOTIFICATION-TYPE|OBJECT-GROUP|NOTIFICATION-GROUP|MODULE-COMPLIANCE)\b[\s\S]*?::=\s*\{\s*([^{}]+?)\s*\}/g;

// Strip ASN.1 comments. Duplicated from mibService.ts to keep this module
// independent and avoid a circular import.
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n && text[i] !== '"') {
        out += text[i];
        i++;
      }
      if (i < n) {
        out += text[i];
        i++;
      }
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      out += "  ";
      i += 2;
      while (i < n) {
        if (text[i] === "\n" || text[i] === "\r") break;
        if (text[i] === "-" && text[i + 1] === "-") {
          out += "  ";
          i += 2;
          break;
        }
        out += text[i] === "\t" ? "\t" : " ";
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

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

function tryResolveParts(parts: string[], numeric: Map<string, string>): string | null {
  if (parts.length === 0) return null;
  const head = parts[0];
  let prefix: string | null;
  if (isInteger(head)) {
    prefix = head;
  } else if (numeric.has(head)) {
    prefix = numeric.get(head)!;
  } else {
    return null;
  }
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (isInteger(p)) {
      prefix += "." + p;
    } else if (numeric.has(p)) {
      prefix += "." + numeric.get(p)!;
    } else {
      return null;
    }
  }
  return prefix;
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
