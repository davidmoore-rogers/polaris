/**
 * tests/unit/savedDashboardsRbacLockstep.test.ts
 *
 * The two-way lockstep adding an RBAC function key requires — the key in
 * FUNCTION_KEYS **and** a migration seeding it onto every existing Role's
 * matrix — for `savedDashboards`. Same reasoning as
 * networkScanRbacLockstep.test.ts: `requirePermission` reads the STORED matrix
 * with no admin bypass, so a catalogued-but-unseeded key reads `none` for
 * everyone (admin included) on every existing install while working perfectly
 * on a fresh one, and a seeded-but-uncatalogued one evaporates the first time
 * anybody edits a role.
 *
 * The seeded LEVELS encode decisions, not defaults:
 *   - `readonly` and `user` get READ, because keeping a PRIVATE dashboard is
 *     the same act the ungated per-user /me/dashboard already allows — there is
 *     nothing to withhold — while publishing one is not.
 *   - `networkadmin` / `assetsadmin` get WRITE: publishing reaches every
 *     operator AND the unauthenticated Dash wallboard, which is exactly the
 *     capability an admin may want to withhold from someone who may still
 *     build their own screens.
 *
 * The readonly level is load-bearing for a second reason: the Dash wallboard
 * answers as the built-in readonly role, so it is what lets a wallboard load a
 * published dashboard at all.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";

const MIGRATION = resolve(__dirname, "../../prisma/migrations/20260904040000_saved_dashboards/migration.sql");
const sql = () => readFileSync(MIGRATION, "utf8");

/** The level the migration seeds for a role name, read out of the UPDATE blocks. */
function seededLevel(role: string): string | null {
  const blocks = sql().split(/UPDATE "roles"/).slice(1);
  for (const block of blocks) {
    const level = /'\{savedDashboards\}',\s*'"(\w+)"'/.exec(block);
    if (!level) continue;
    const where = block.slice(block.indexOf("WHERE"));
    if (new RegExp(`'${role}'`).test(where)) return level[1];
  }
  return null;
}

describe("savedDashboards function key — lockstep", () => {
  it("is in the FUNCTION_KEYS catalogue", () => {
    expect(FUNCTION_KEYS.map((f) => f.key)).toContain("savedDashboards");
  });

  it("carries no ownership dimension", () => {
    // Ownership IS enforced (a caller edits only rows they created), but by the
    // route reading row.ownerId — not by requireOwnership's createdBy filter,
    // which would also hide other operators' PUBLIC dashboards from the list
    // and defeat the whole feature.
    const def = FUNCTION_KEYS.find((f) => f.key === "savedDashboards")!;
    expect(def.hasOwnershipDimension).toBeUndefined();
  });

  it("defaults the key to none for any role missing it", () => {
    expect(sql()).toMatch(
      /'\{savedDashboards\}',\s*'"none"'[\s\S]*?WHERE NOT \("permissions" \? 'savedDashboards'\)/,
    );
  });

  it("seeds every built-in role explicitly", () => {
    expect(seededLevel("admin")).toBe("fullwrite");
    expect(seededLevel("readonly")).toBe("read");
    expect(seededLevel("user")).toBe("read");
    expect(seededLevel("networkadmin")).toBe("write");
    expect(seededLevel("assetsadmin")).toBe("write");
  });

  it("bumps updatedAt so live role snapshots refetch", () => {
    const blocks = sql().split(/UPDATE "roles"/).slice(1);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block).toContain('"updatedAt"   = NOW()');
  });
});

describe("saved_dashboards table — migration shape", () => {
  it("creates the table", () => {
    expect(sql()).toContain('CREATE TABLE "saved_dashboards"');
  });

  it("keeps a published dashboard when its author's account goes (SET NULL, not CASCADE)", () => {
    // The SavedTableFilter rule: a shared preset outlives its author, and
    // ownerName is the surviving label. CASCADE here would delete the NOC's
    // wallboard screen the day the person who published it left.
    expect(sql()).toMatch(/saved_dashboards_ownerId_fkey[\s\S]*?ON DELETE SET NULL/);
  });

  it("makes (owner, name) unique — the name IS the overwrite key", () => {
    expect(sql()).toContain('CREATE UNIQUE INDEX "saved_dashboards_ownerId_name_key"');
  });

  it("indexes visibility — the wallboard's read has no owner to narrow it", () => {
    expect(sql()).toContain('"saved_dashboards_visibility_idx"');
  });
});
