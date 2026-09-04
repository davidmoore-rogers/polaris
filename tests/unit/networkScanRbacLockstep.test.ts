/**
 * tests/unit/networkScanRbacLockstep.test.ts
 *
 * Guards the two-way lockstep that adding an RBAC function key requires: the
 * key in FUNCTION_KEYS **and** a migration that seeds it onto every existing
 * Role's matrix.
 *
 * Either half alone fails silently in a way nothing else in the suite catches.
 * `requirePermission` resolves against the STORED matrix with no admin bypass,
 * so a key present in the catalogue but absent from every stored role reads as
 * `none` for everyone — including admin — and the feature is simply
 * unreachable on every existing install while working perfectly on a fresh
 * one. The reverse (seeded but not catalogued) makes `normalizePermissions`
 * drop the value on the next role write, so the grant silently evaporates the
 * first time someone edits a role.
 *
 * The seeded LEVELS are asserted too, because they encode a decision rather
 * than a default: `user` is deliberately `none` — that built-in exists for
 * IP-space self-service and has no business sweeping address ranges — and
 * `readonly` is deliberately `read`, since watching a scan someone else
 * configured is a legitimate read.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";

const MIGRATION = resolve(__dirname, "../../prisma/migrations/20260825040000_network_scan/migration.sql");
const sql = () => readFileSync(MIGRATION, "utf8");

/** The level the migration seeds for a role name, read out of the UPDATE blocks. */
function seededLevel(role: string): string | null {
  // Each block is: SET permissions = jsonb_set(…,'{networkScan}','"<level>"',true) … WHERE "name" … <role>
  const blocks = sql().split(/UPDATE "roles"/).slice(1);
  for (const block of blocks) {
    const level = /'\{networkScan\}',\s*'"(\w+)"'/.exec(block);
    if (!level) continue;
    const where = block.slice(block.indexOf("WHERE"));
    if (new RegExp(`'${role}'`).test(where)) return level[1];
  }
  return null;
}

describe("networkScan function key — lockstep", () => {
  it("is in the FUNCTION_KEYS catalogue", () => {
    expect(FUNCTION_KEYS.map((f) => f.key)).toContain("networkScan");
  });

  it("carries the ownership dimension", () => {
    // Since the private/public cutover a Discovery HAS a per-row owner:
    // `write` creates and runs, and edits/deletes only your own; `fullwrite`
    // reaches anyone's. The flag is what puts the "(Read-Write = own · Full
    // Read-Write = any)" note on the roles matrix, and its absence made the
    // matrix claim fullwrite bought nothing over write.
    //
    // Note the ONE way this key differs from subnets / reservations /
    // contacts: PUBLISHING is not the escalated level. Those keys gate a
    // shared write at fullwrite; here sharing is the point of the feature and
    // rides plain `write`, because networkadmin and assetsadmin hold write and
    // are exactly the roles that author Discoveries.
    const def = FUNCTION_KEYS.find((f) => f.key === "networkScan")!;
    expect(def.hasOwnershipDimension).toBe(true);
  });

  it("has a migration that defaults the key to none for any role missing it", () => {
    // Custom roles must land somewhere explicit; an absent key is not the same
    // as "none" once normalizePermissions runs over it.
    expect(sql()).toMatch(/'\{networkScan\}',\s*'"none"'[\s\S]*?WHERE NOT \("permissions" \? 'networkScan'\)/);
  });

  it("seeds every built-in role explicitly", () => {
    // admin included — requirePermission has no admin bypass.
    expect(seededLevel("admin")).toBe("fullwrite");
    expect(seededLevel("readonly")).toBe("read");
    expect(seededLevel("networkadmin")).toBe("write");
    expect(seededLevel("assetsadmin")).toBe("write");
  });

  it("leaves `user` at none rather than granting it write", () => {
    // The three-way `IN (...)` seed that contacts used covers user as well;
    // this one deliberately does not, so assert the absence rather than
    // trusting that a future edit won't quietly add it.
    expect(seededLevel("user")).toBeNull();
    const inClause = /WHERE "name" IN \(([^)]*)\)/.exec(sql().slice(sql().lastIndexOf("networkScan")))?.[1] ?? "";
    expect(inClause).not.toContain("'user'");
  });

  it("bumps updatedAt so live role snapshots refetch", () => {
    // The in-memory Map<roleId, updatedAt> cache is what makes the gate O(1);
    // without the bump, every session holding a pre-deploy snapshot keeps
    // reading the old matrix until re-login.
    const blocks = sql().split(/UPDATE "roles"/).slice(1);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block).toContain('"updatedAt"   = NOW()');
  });
});

describe("network_scan tables — migration shape", () => {
  it("creates both tables with a cascading FK from run to scan", () => {
    const s = sql();
    expect(s).toContain('CREATE TABLE "network_scans"');
    expect(s).toContain('CREATE TABLE "network_scan_runs"');
    // Neither is a hypertable, so the no-FK rule (TimescaleDB-only) does not
    // apply and deleting a Discovery must take its run history with it.
    expect(s).toMatch(/network_scan_runs_scanId_fkey[\s\S]*?ON DELETE CASCADE/);
  });

  it("makes the Discovery name unique", () => {
    // The name round-trips through the .discovery.json filename, so two
    // Discoveries sharing one would make an export ambiguous on import.
    expect(sql()).toContain('CREATE UNIQUE INDEX "network_scans_name_key"');
  });

  it("indexes what the list and the reaper actually query", () => {
    const s = sql();
    expect(s).toContain('"network_scan_runs_scanId_createdAt_idx"');
    expect(s).toContain('"network_scan_runs_status_idx"');
  });
});
