/**
 * tests/unit/timescaleTables.test.ts
 *
 * Drift guards for the TimescaleDB-managed table inventory. The 2026-06
 * whole-app review found the SD-WAN sample tables written by
 * sampleRollupService and pruned by monitoringService but missing from
 * timescaleService's SAMPLE_TABLES / ROLLUP_TABLES — leaving them plain
 * Postgres tables (no hypertable conversion, no compression, seq-scanning
 * deleteMany pruning; the same failure family as the 2026-06-08 chunk-bloat
 * incident). These tests make that drift class mechanical: any sample-shaped
 * table referenced by the rollup writer, the prune layer, or declared in
 * prisma/schema.prisma must be in the managed inventory (or on the explicit
 * exemption list below).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// timescaleService / sampleRetentionService import prisma at module load;
// stub it so importing the constants doesn't open a DB connection.
vi.mock("../../src/db.js", () => ({
  prisma: { setting: { findUnique: vi.fn(), upsert: vi.fn() } },
}));

import {
  SAMPLE_TABLES,
  ROLLUP_TABLES,
  STANDALONE_SAMPLE_TABLES,
  ALL_HYPERTABLE_CANDIDATES,
} from "../../src/services/timescaleService.js";
import { RETENTION_ENTITIES } from "../../src/services/sampleRetentionService.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Sample-shaped tables that intentionally are NOT Timescale-managed. Empty
 * today — asset_custom_widget_samples was the last holdout and is now a
 * STANDALONE_SAMPLE_TABLES hypertable. Add a name here only with a comment
 * justifying why it can't be a hypertable.
 */
const EXEMPT = new Set<string>([]);

const managed = new Set<string>(ALL_HYPERTABLE_CANDIDATES);

/** Every double-quoted sample-table string literal in a source file. */
function tablesReferencedIn(relPath: string): string[] {
  const src = readFileSync(join(ROOT, relPath), "utf8");
  const re = /"(asset_[a-z_]+_samples(?:_hourly|_daily)?)"/g;
  const found = new Set<string>();
  for (const m of src.matchAll(re)) found.add(m[1]);
  return [...found].sort();
}

describe("timescaleService managed-table inventory", () => {
  it("covers one detail + hourly + daily table per retention entity, plus standalones", () => {
    // 8 retention entities × 3 tiers = 24 tiered hypertables. A new tiered
    // sample stream must land in SAMPLE_TABLES + ROLLUP_TABLES alongside its
    // RETENTION_ENTITIES entry, or this count diverges. Detail-only streams
    // with no rollups live in STANDALONE_SAMPLE_TABLES instead.
    expect(SAMPLE_TABLES.length).toBe(RETENTION_ENTITIES.length);
    expect(ROLLUP_TABLES.length).toBe(RETENTION_ENTITIES.length * 2);
    expect(ALL_HYPERTABLE_CANDIDATES.length).toBe(
      RETENTION_ENTITIES.length * 3 + STANDALONE_SAMPLE_TABLES.length,
    );
  });

  it("every table the rollup writer touches is Timescale-managed", () => {
    const referenced = tablesReferencedIn("src/services/sampleRollupService.ts");
    expect(referenced.length).toBeGreaterThan(0);
    const unmanaged = referenced.filter((t) => !managed.has(t) && !EXEMPT.has(t));
    expect(unmanaged).toEqual([]);
  });

  it("every hypertable name the prune layer passes to dropChunks is Timescale-managed", () => {
    const referenced = tablesReferencedIn("src/services/monitoringService.ts");
    expect(referenced.length).toBeGreaterThan(0);
    const unmanaged = referenced.filter((t) => !managed.has(t) && !EXEMPT.has(t));
    expect(unmanaged).toEqual([]);
  });

  it("capacityService's local projection map covers every TIERED managed table", () => {
    // capacityService keeps its own per-table list (entity/tier/countKey) plus
    // DEFAULT_ROWS_PER_ASSET_PER_DAY / DEFAULT_BYTES_PER_ROW maps. The rows
    // map is dereferenced WITHOUT a fallback (`DEFAULT_ROWS_PER_ASSET_PER_DAY
    // [def.name](intervals)`), so a managed table missing there throws inside
    // the capacity snapshot. The maps use unquoted identifier keys, so match
    // bare words rather than string literals.
    // Scope: the TIERED tables only. STANDALONE_SAMPLE_TABLES are deliberately
    // excluded from the steady-state size projection — they have no
    // RetentionEntity (the projection keys retention off entity/tier) and are
    // small (custom-widget samples only exist when operators define widgets).
    const tiered = new Set<string>([...SAMPLE_TABLES, ...ROLLUP_TABLES]);
    const src = readFileSync(join(ROOT, "src", "services", "capacityService.ts"), "utf8");
    const re = /\basset_[a-z_]+_samples(?:_hourly|_daily)?\b/g;
    const referenced = new Set<string>();
    for (const m of src.matchAll(re)) referenced.add(m[0]);

    const missing = [...tiered].filter((t) => !referenced.has(t)).sort();
    expect(missing).toEqual([]);

    const unmanaged = [...referenced].filter((t) => !managed.has(t) && !EXEMPT.has(t)).sort();
    expect(unmanaged).toEqual([]);
  });

  it("every sample-shaped table in prisma/schema.prisma is Timescale-managed or explicitly exempt", () => {
    const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
    const re = /@@map\("(asset_[a-z_]+_samples(?:_hourly|_daily)?)"\)/g;
    const declared = new Set<string>();
    for (const m of schema.matchAll(re)) declared.add(m[1]);
    expect(declared.size).toBeGreaterThanOrEqual(ALL_HYPERTABLE_CANDIDATES.length);

    const unmanaged = [...declared].filter((t) => !managed.has(t) && !EXEMPT.has(t)).sort();
    expect(unmanaged).toEqual([]);

    // Reverse direction: a typo'd name in SAMPLE_TABLES / ROLLUP_TABLES would
    // fail at runtime only as a logged-and-swallowed per-table error. Catch it
    // here instead — every managed name must exist in the schema.
    const phantom = [...managed].filter((t) => !declared.has(t)).sort();
    expect(phantom).toEqual([]);
  });
});
