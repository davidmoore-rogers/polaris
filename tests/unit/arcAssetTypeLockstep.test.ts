/**
 * tests/unit/arcAssetTypeLockstep.test.ts
 *
 * Guards the three-way lockstep that adding a built-in asset type requires.
 * `seedBuiltInAssetTypes` SKIPS any seed whose name is absent from
 * BUILT_IN_ASSET_TYPES, so shipping the migration and the seed without the
 * name — or the name without the seed — is a SILENT no-op on fresh Docker
 * volumes and restored backups. Nothing else in the suite would catch it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILT_IN_ASSET_TYPES } from "../../src/utils/assetTypes.js";

const MIGRATION = resolve(
  __dirname,
  "../../prisma/migrations/20260807000000_arc_kubernetes_asset_type/migration.sql",
);
const SERVICE = resolve(__dirname, "../../src/services/assetTypeService.ts");

describe("kubernetes_cluster asset-type lockstep", () => {
  it("is in BUILT_IN_ASSET_TYPES", () => {
    expect(BUILT_IN_ASSET_TYPES as readonly string[]).toContain("kubernetes_cluster");
  });

  it("is in the seedBuiltInAssetTypes self-heal list", () => {
    // Without this the type exists only where the migration ran — a fresh
    // volume or a restored backup comes up without it.
    expect(readFileSync(SERVICE, "utf8")).toContain('name: "kubernetes_cluster"');
  });

  it("has a migration that adopts rather than fails on an existing custom type", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain("kubernetes_cluster");
    // ON CONFLICT DO UPDATE is what stops the upgrade from failing when an
    // operator already created a custom type of the same name.
    expect(sql).toMatch(/ON CONFLICT \("name"\) DO UPDATE/);
  });

  it("every built-in name has a matching seed", () => {
    // The general form of the same trap, for whoever adds the next one.
    const service = readFileSync(SERVICE, "utf8");
    const missing = (BUILT_IN_ASSET_TYPES as readonly string[])
      .filter((n) => !service.includes(`name: "${n}"`));
    expect(missing).toEqual([]);
  });
});
