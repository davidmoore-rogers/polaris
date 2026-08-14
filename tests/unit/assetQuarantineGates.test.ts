/**
 * tests/unit/assetQuarantineGates.test.ts — every UI surface that reaches the
 * quarantine routes must gate on the `assetsQuarantine` function key.
 *
 * Quarantine pushes a MAC block to every FortiGate that has seen a device, and
 * it has its OWN key: every /assets/:id/quarantine* route and both bulk routes
 * gate on `assetsQuarantine`, never on `assets`. Three surfaces shipped gated on
 * `canManageAssets()` (= `assets:write`) instead — the asset-details Quarantine
 * tab (visibility AND wiring) and the two bulk-bar buttons. Because a role may
 * hold either key without the other, that broke both ways:
 *
 *   - `assets:write` with no quarantine grant → controls visible, every click 403s.
 *   - `assetsQuarantine:write` with `assets:read` → the SOC shape, allowed to
 *     contain a device but not to edit inventory, saw NO quarantine UI at all.
 *
 * No built-in role is affected (all five have `assets` >= `assetsQuarantine`), so
 * this only bit operator-defined roles — which is what dynamic roles are for.
 *
 * The assertions are STATIC against the shipped sources rather than behavioural:
 * these are one-line gates buried in an ~18k-line render path, and standing up
 * the asset-details machinery to observe them would test the harness more than
 * the gate. Each negative assertion has been verified to fail when the old gate
 * is planted back in, so none of them passes vacuously.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const assetsSrc = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8");
const appSrc = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");
const assetsHtml = readFileSync(resolve(__dirname, "../../public/assets.html"), "utf8");

describe("quarantine UI gates", () => {
  it("app.js exposes canQuarantineAssets bound to the assetsQuarantine key", () => {
    expect(appSrc).toMatch(/function canQuarantineAssets\(\)\s*\{\s*return permAtLeast\("assetsQuarantine",\s*"write"\)/);
  });

  it("the Quarantine tab's visibility and wiring both use it", () => {
    // Visibility: the tabs.push condition.
    expect(assetsSrc).toMatch(/if \(canQuarantineAssets\(\) && \(a\.status === "quarantined"/);
    // Wiring: without this the tab renders but its buttons do nothing.
    expect(assetsSrc).toMatch(/if \(canQuarantineAssets\(\)\) _wireQuarantineTab\(a\);/);
    expect(assetsSrc).not.toMatch(/if \(canManageAssets\(\)\) _wireQuarantineTab\(a\);/);
  });

  it("the bulk-bar quarantine block uses it", () => {
    // The guard is load-bearing: without the key the block never runs, so the
    // buttons keep the display:none the attribute applier set at load.
    expect(assetsSrc).toMatch(/if \(canQuarantineAssets\(\)\) \{[\s\S]*?assets-bulk-quarantine-btn/);
    // And the old wrong gate is gone from that block.
    expect(assetsSrc).not.toMatch(/if \(canManageAssets\(\)\) \{[\s\S]*?assets-bulk-quarantine-btn/);
  });

  it("the bulk-bar buttons carry data-quarantine-assets, not data-manage-assets", () => {
    for (const id of ["assets-bulk-quarantine-btn", "assets-bulk-unquarantine-btn"]) {
      const tag = assetsHtml.split(`id="${id}"`)[1]!.split(">")[0]!;
      expect(tag, id).toContain("data-quarantine-assets");
      expect(tag, id).not.toContain("data-manage-assets");
    }
  });

  it("app.js hides data-quarantine-assets elements without the key", () => {
    expect(appSrc).toMatch(/\[data-quarantine-assets\][\s\S]{0,200}canQuarantineAssets\(\)/);
  });
});

