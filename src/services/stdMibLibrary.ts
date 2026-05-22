/**
 * src/services/stdMibLibrary.ts — built-in standard MIB browse/walk support.
 *
 * Mirrors the upload-MIB pathway (mibService.parseMibStructured +
 * oidRegistry.resolveSymbolsForMib) for the seven canonical RFC/IEEE
 * modules bundled under [stdMibs/](./stdMibs/). The SNMP Walk tab on the
 * asset details modal consumes this surface via two routes in
 * [../api/routes/mibs.ts](../api/routes/mibs.ts):
 *
 *   GET  /server-settings/mibs/std/:key/structure
 *   POST /server-settings/mibs/std/:key/walk
 *
 * Standard MIBs are immutable at runtime — we parse + resolve each one
 * lazily on first request and cache the result module-level. The
 * resolver runs against `BUILT_IN_OIDS` only (no DB MIB layering); std
 * MIBs root at well-known SMI anchors already present in the seed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import {
  parseMibStructured,
  type MibSymbol,
  type ParsedMibStructured,
} from "./mibService.js";
import {
  BUILT_IN_OIDS,
  parseObjectAssignments,
  tryResolveParts,
} from "./oidRegistry.js";

export interface StdMibDef {
  /** Frontend-facing id, e.g. "std:system". */
  key: string;
  /** Human label shown in the SNMP Walk dropdown. */
  label: string;
  /** SMI module name as declared in the file's `<NAME> DEFINITIONS ::= BEGIN`. */
  moduleName: string;
  /** Convenience root OID (used by the legacy raw-OID prefill path). */
  rootOid: string;
  /** Filename under stdMibs/. Multiple std keys may share one file
   * (e.g. std:interfaces + std:if-ext both come from IF-MIB.txt). */
  filename: string;
}

export const STD_MIBS: readonly StdMibDef[] = [
  { key: "std:system",         label: "System (RFC 3418)",                      moduleName: "SNMPv2-MIB",       rootOid: "1.3.6.1.2.1.1",  filename: "SNMPv2-MIB.txt" },
  { key: "std:interfaces",     label: "Interfaces — ifTable (RFC 2863)",        moduleName: "IF-MIB",           rootOid: "1.3.6.1.2.1.2",  filename: "IF-MIB.txt" },
  { key: "std:if-ext",         label: "Interfaces — ifXTable, 64-bit (RFC 2863)", moduleName: "IF-MIB",         rootOid: "1.3.6.1.2.1.31", filename: "IF-MIB.txt" },
  { key: "std:host-resources", label: "HOST-RESOURCES-MIB (RFC 2790)",          moduleName: "HOST-RESOURCES-MIB", rootOid: "1.3.6.1.2.1.25", filename: "HOST-RESOURCES-MIB.txt" },
  { key: "std:entity",         label: "ENTITY-MIB (RFC 4133)",                  moduleName: "ENTITY-MIB",       rootOid: "1.3.6.1.2.1.47", filename: "ENTITY-MIB.txt" },
  { key: "std:entity-sensor",  label: "ENTITY-SENSOR-MIB (RFC 3433)",           moduleName: "ENTITY-SENSOR-MIB", rootOid: "1.3.6.1.2.1.99", filename: "ENTITY-SENSOR-MIB.txt" },
  { key: "std:lldp",           label: "LLDP-MIB (IEEE 802.1AB)",                moduleName: "LLDP-MIB",         rootOid: "1.0.8802.1.1.2", filename: "LLDP-MIB.txt" },
];

const STD_MIBS_DIR = join(dirname(fileURLToPath(import.meta.url)), "stdMibs");

/**
 * Lazily-populated parse cache keyed by std key. Values include
 * resolved `fullOid` stamps on every symbol (null where unresolved).
 * Module-level immutable lifetime — std MIBs don't change at runtime.
 */
const _cache = new Map<string, ParsedMibStructured & { unresolvedCount: number }>();

/**
 * Shared symbol map keyed by module name → name → fullOid. We resolve
 * each module independently (no cross-MIB visibility) since std MIBs
 * don't IMPORTS-chain to each other at the OID level — every std MIB's
 * symbols root at the same SMI seed.
 */
function resolveStdMibOids(parsed: ParsedMibStructured, rawText: string): Map<string, string> {
  // Build the per-MIB numeric map by seeding from BUILT_IN_OIDS and then
  // iteratively resolving each parsed assignment until a pass adds nothing.
  // This catches forward references inside one MIB (e.g. ifMIBObjects
  // declared after the table that uses it).
  const numeric = new Map<string, string>(Object.entries(BUILT_IN_OIDS));

  // We re-run the cheap regex-based extractor used by the production
  // oidRegistry loader rather than rebuilding from parsed.symbols — the
  // structured parse drops some OID-IDENTIFIER shorthand assignments
  // (`name OBJECT IDENTIFIER ::= { parent N }`) that the registry
  // resolver picks up. Cross-checked against parsed.symbols below.
  const pending = parseObjectAssignments(rawText);

  let progress = true;
  while (progress && pending.length > 0) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const { name, parts } = pending[i];
      const resolved = tryResolveParts(parts, numeric);
      if (resolved != null) {
        numeric.set(name, resolved);
        pending.splice(i, 1);
        progress = true;
      }
    }
  }

  return numeric;
}

function loadAndCache(def: StdMibDef): ParsedMibStructured & { unresolvedCount: number } {
  const cached = _cache.get(def.key);
  if (cached) return cached;

  const filePath = join(STD_MIBS_DIR, def.filename);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ filePath, err: msg }, "Failed to read std MIB file");
    throw new AppError(500, `Standard MIB "${def.moduleName}" is not installed on the server`);
  }

  const parsed = parseMibStructured(raw);
  const numeric = resolveStdMibOids(parsed, raw);

  // Stamp resolved OIDs onto each symbol the structured parser produced.
  for (const sym of parsed.symbols) {
    sym.fullOid = numeric.get(sym.name) ?? null;
  }

  const unresolvedCount = parsed.symbols.filter((s) => s.fullOid === null).length;
  if (unresolvedCount > 0) {
    logger.debug(
      { module: def.moduleName, unresolvedCount, total: parsed.symbols.length },
      "std MIB has unresolved symbols (likely IMPORTS-only references)",
    );
  }

  const result = { ...parsed, unresolvedCount };
  _cache.set(def.key, result);
  return result;
}

/** List every bundled standard MIB. */
export function listStdMibs(): readonly StdMibDef[] {
  return STD_MIBS;
}

/** Look up a std MIB definition by frontend key (`std:lldp` etc.). Returns null when unknown. */
export function getStdMibDef(key: string): StdMibDef | null {
  return STD_MIBS.find((m) => m.key === key) ?? null;
}

/**
 * Parsed structure for the std MIB at `key`, with `fullOid` resolved on
 * every symbol that the BUILT_IN_OIDS seed can reach. Throws AppError(404)
 * for an unknown key, AppError(500) if the file is missing or unparseable.
 */
export function getStdMibStructure(key: string): ParsedMibStructured & { unresolvedCount: number } {
  const def = getStdMibDef(key);
  if (!def) throw new AppError(404, `Unknown standard MIB key "${key}"`);
  return loadAndCache(def);
}

/**
 * Look up a single symbol within a std MIB by name. Used by the std walk
 * route to translate the operator's "Object name" input into a numeric
 * OID. Returns null when the symbol is unknown OR unresolved.
 */
export function resolveStdSymbol(key: string, name: string): MibSymbol | null {
  const structure = getStdMibStructure(key);
  return structure.symbols.find((s) => s.name === name) ?? null;
}
