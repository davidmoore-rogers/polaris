/**
 * tests/unit/notificationCarveOut.test.ts — the precedence carve-out decision
 * (buildShadowIndex + isAssetShadowed): a more-specific automation shadows a
 * less-specific one that watches the SAME trigger signature, per asset. The
 * DB-bound firing/clear-on-supersede behavior is exercised by the integration
 * suite; this covers the pure decision (ranks, ties, cross-signature isolation,
 * self-exclusion).
 */

import { describe, it, expect } from "vitest";
import { buildShadowIndex, isAssetShadowed } from "../../src/services/notificationEngine.js";
import { triggerSignature, scopeRank } from "../../src/services/notificationTypes.js";
import type { ScopeAsset } from "../../src/services/notificationRuleService.js";

const tempTrigger = { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 80, aggregation: "latest", windowSec: 0, forDurationSec: 0 };
const downTrigger = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", forDurationSec: 0 };

const rule = (id: string, trigger: any, scope: any) => ({ id, name: id, trigger, scope }) as any;
const hostnameScope = (name: string) => ({ condition: { op: "and", children: [{ field: "hostname", operator: "equals", value: name }] } });

const a101f: ScopeAsset = { id: "101f", hostname: "fortigate-101f", assetType: "firewall", tags: [], discoveredByIntegrationId: null };
const other: ScopeAsset = { id: "o1", hostname: "switch-1", assetType: "switch", tags: [], discoveredByIntegrationId: null };

// Mirror the engine's per-asset call.
function shadowed(index: ReturnType<typeof buildShadowIndex>, r: any, asset: ScopeAsset): boolean {
  const sig = triggerSignature(r.trigger);
  if (!sig) return false;
  return isAssetShadowed(index, r, sig, scopeRank(r.scope), asset);
}

describe("buildShadowIndex", () => {
  it("groups asset_metric/asset_state rules by signature and tracks max rank", () => {
    const general = rule("general", tempTrigger, { allAssets: true });
    const specific = rule("specific", tempTrigger, hostnameScope("fortigate-101f"));
    const down = rule("down", downTrigger, { allAssets: true });
    const idx = buildShadowIndex([general, specific, down]);
    const tempSig = triggerSignature(tempTrigger as any)!;
    expect(idx.bySig.get(tempSig)).toHaveLength(2);
    expect(idx.maxRankBySig.get(tempSig)).toBe(scopeRank(specific.scope)); // hostname rank
  });

  it("omits host/event/change/composite rules (null signature)", () => {
    const host = rule("host", { type: "host_metric", metric: "cpuPct", operator: ">=", threshold: 90, aggregation: "latest", windowSec: 0, forDurationSec: 0 }, { allAssets: true });
    const idx = buildShadowIndex([host]);
    expect(idx.bySig.size).toBe(0);
  });
});

describe("isAssetShadowed", () => {
  const general = rule("general", tempTrigger, { allAssets: true });
  const specific = rule("specific", tempTrigger, hostnameScope("fortigate-101f"));
  const down = rule("down", downTrigger, { allAssets: true });
  const idx = buildShadowIndex([general, specific, down]);

  it("carves the covered asset out of the general rule", () => {
    expect(shadowed(idx, general, a101f)).toBe(true);
  });

  it("leaves assets the specific rule does NOT cover alone", () => {
    expect(shadowed(idx, general, other)).toBe(false);
  });

  it("never shadows the most-specific rule itself", () => {
    expect(shadowed(idx, specific, a101f)).toBe(false);
  });

  it("does not carve across different trigger signatures (temp never shadows DOWN)", () => {
    // a101f is covered by the specific TEMP rule, but the DOWN rule watches a
    // different thing — it keeps alerting on a101f.
    expect(shadowed(idx, down, a101f)).toBe(false);
  });

  it("same-rank same-signature rules do not shadow each other (tie → both fire)", () => {
    const genA = rule("genA", tempTrigger, { allAssets: true });
    const genB = rule("genB", tempTrigger, { allAssets: true });
    const tie = buildShadowIndex([genA, genB]);
    expect(shadowed(tie, genA, a101f)).toBe(false);
    expect(shadowed(tie, genB, a101f)).toBe(false);
  });

  it("ranks by specificity, not rule order (a subnet rule carves out a device-type rule)", () => {
    const byType = rule("byType", tempTrigger, { assetTypes: ["firewall"] });
    const bySubnet = rule("bySubnet", tempTrigger, { subnetCidrs: ["10.0.0.0/24"] });
    const idx2 = buildShadowIndex([byType, bySubnet]);
    const inSubnet: ScopeAsset = { ...a101f, assetType: "firewall", ipAddress: "10.0.0.5" };
    expect(shadowed(idx2, byType, inSubnet)).toBe(true); // subnet (7) > assetType (1)
    expect(shadowed(idx2, bySubnet, inSubnet)).toBe(false);
  });
});
