/**
 * tests/unit/assetRowMenu.test.ts — the Assets list row-menu item builders
 * (`_assetMenuItems` / `_quarantineMenuItems` in public/js/assets.js).
 *
 * The quarantine verbs are the reason this file exists. Quarantine pushes a MAC
 * block to every FortiGate that has seen the device, so who may reach it and
 * which devices may receive it are both load-bearing:
 *
 *  - It rides its OWN function key, `assetsQuarantine`, not `assets`. Every
 *    /assets/:id/quarantine* route gates on it. The pre-menu version of this
 *    code gated on canManageAssets() (`assets:write`) — it was never wired up,
 *    so the mismatch never shipped, and this pins it so it can't come back.
 *  - Fortinet infrastructure can never be quarantined: blocking the device that
 *    enforces the block would lock the operator out of their own network.
 *  - Release must stay available for an already-quarantined asset REGARDLESS of
 *    type, so a misclassified quarantine is always reversible.
 *  - No MAC means no target to block, so neither verb applies.
 *
 * assets.js is an ~18k-line browser script with no module boundary, so the
 * builders are sliced out by name and eval'd — the approach in
 * assetInterfacesTableDom.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

interface MenuItem {
  label?: string;
  separator?: boolean;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect?: () => void;
}
interface AssetRow {
  id: string;
  hostname?: string;
  status?: string;
  assetType?: string;
  macAddress?: string | null;
  macAddresses?: unknown[];
}

const g = globalThis as Record<string, any>;
const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

let assetMenuItems: (a: AssetRow) => MenuItem[];
let quarantineMenuItems: (a: AssetRow) => MenuItem[];

/** Actionable labels only, separators dropped. */
const labels = (items: MenuItem[]) => items.filter((i) => !i.separator).map((i) => i.label);

/** A quarantinable endpoint: has a MAC, ordinary type, not already quarantined. */
function endpoint(over: Partial<AssetRow> = {}): AssetRow {
  return { id: "a1", hostname: "wks-01", status: "active", assetType: "workstation", macAddress: "aa:bb:cc:dd:ee:ff", ...over };
}

/** Re-eval the builders with the two permission gates set independently. */
function withPerms(assets: boolean, quarantine: boolean) {
  g.canManageAssets = () => assets;
  g.canQuarantineAssets = () => quarantine;
  (0, eval)(fnSrc("_quarantineMenuItems"));
  (0, eval)(fnSrc("_assetMenuItems"));
  assetMenuItems = g._assetMenuItems;
  quarantineMenuItems = g._quarantineMenuItems;
}

beforeEach(() => {
  g.openViewModal = () => {};
  g.openEditModal = () => {};
  g.confirmDelete = () => {};
  g.quarantineAssetRow = () => {};
  g.releaseAssetQuarantine = () => {};
  withPerms(true, true);
  expect(typeof assetMenuItems, "assets.js no longer declares _assetMenuItems").toBe("function");
});

describe("_quarantineMenuItems — permission gate", () => {
  it("offers Quarantine with assetsQuarantine, even without assets:write", () => {
    withPerms(false, true);
    expect(labels(quarantineMenuItems(endpoint()))).toEqual(["Quarantine…"]);
  });

  it("offers NOTHING without assetsQuarantine, even with assets:write", () => {
    // The old code gated on canManageAssets() — this is that bug, pinned out.
    withPerms(true, false);
    expect(quarantineMenuItems(endpoint())).toEqual([]);
    expect(quarantineMenuItems(endpoint({ status: "quarantined" }))).toEqual([]);
  });

  it("keeps quarantine out of the row menu entirely when the key is missing", () => {
    withPerms(true, false);
    const l = labels(assetMenuItems(endpoint()));
    expect(l).not.toContain("Quarantine…");
    expect(l).not.toContain("Release quarantine");
  });
});

describe("_quarantineMenuItems — which devices", () => {
  it("offers Quarantine for an ordinary endpoint with a MAC", () => {
    const items = quarantineMenuItems(endpoint());
    expect(items[0]!.label).toBe("Quarantine…");
    expect(items[0]!.danger).toBe(true);
  });

  it("offers nothing when the asset has no MAC — there is no target to block", () => {
    expect(quarantineMenuItems(endpoint({ macAddress: null }))).toEqual([]);
    expect(quarantineMenuItems(endpoint({ macAddress: undefined, macAddresses: [] }))).toEqual([]);
  });

  it("accepts a MAC from the macAddresses list when the primary is empty", () => {
    const items = quarantineMenuItems(endpoint({ macAddress: null, macAddresses: [{ macAddress: "aa:bb:cc:00:11:22" }] }));
    expect(labels(items)).toEqual(["Quarantine…"]);
  });

  it("never offers Quarantine for Fortinet infrastructure", () => {
    // Blocking the device that enforces the block locks the operator out.
    for (const t of ["firewall", "switch", "access_point"]) {
      expect(quarantineMenuItems(endpoint({ assetType: t })), t).toEqual([]);
    }
  });

  it("offers Release for an already-quarantined asset", () => {
    const items = quarantineMenuItems(endpoint({ status: "quarantined" }));
    expect(items[0]!.label).toBe("Release quarantine");
    // A restore, not a destructive act.
    expect(items[0]!.danger).toBeFalsy();
  });

  it("offers Release even on infrastructure, so a misclassification is reversible", () => {
    for (const t of ["firewall", "switch", "access_point"]) {
      expect(labels(quarantineMenuItems(endpoint({ assetType: t, status: "quarantined" }))), t)
        .toEqual(["Release quarantine"]);
    }
  });

  it("never offers both verbs at once", () => {
    for (const status of ["active", "quarantined", "maintenance", "storage"]) {
      expect(quarantineMenuItems(endpoint({ status })).length).toBeLessThanOrEqual(1);
    }
  });
});

describe("_assetMenuItems", () => {
  it("always offers Open, so a read-only viewer still gets a working menu", () => {
    withPerms(false, false);
    expect(labels(assetMenuItems(endpoint()))).toEqual(["Open"]);
  });

  it("adds Edit and Delete with assets:write", () => {
    withPerms(true, false);
    expect(labels(assetMenuItems(endpoint()))).toEqual(["Open", "Edit…", "Delete"]);
  });

  it("orders the full menu Open, Edit, Quarantine, Delete", () => {
    expect(labels(assetMenuItems(endpoint()))).toEqual(["Open", "Edit…", "Quarantine…", "Delete"]);
  });

  it("marks Delete destructive and puts it last", () => {
    const items = assetMenuItems(endpoint());
    const last = items[items.length - 1]!;
    expect(last.label).toBe("Delete");
    expect(last.danger).toBe(true);
  });

  it("never renders a leading, trailing, or doubled separator", () => {
    // A divider with nothing after it looks like a broken menu. Exercised across
    // every permission × asset-shape combination.
    for (const [ma, qa] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      withPerms(ma, qa);
      for (const shape of [endpoint(), endpoint({ macAddress: null }), endpoint({ status: "quarantined" }), endpoint({ assetType: "switch" })]) {
        const items = assetMenuItems(shape);
        expect(items[0]!.separator, JSON.stringify([ma, qa, shape.assetType, shape.status])).toBeFalsy();
        expect(items[items.length - 1]!.separator).toBeFalsy();
        items.forEach((it, i) => {
          if (it.separator) expect(items[i + 1] && !items[i + 1]!.separator).toBe(true);
        });
      }
    }
  });

  it("is never empty for any permission combination", () => {
    for (const [ma, qa] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      withPerms(ma, qa);
      expect(labels(assetMenuItems(endpoint())).length).toBeGreaterThan(0);
    }
  });
});
