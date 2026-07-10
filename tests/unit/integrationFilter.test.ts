/**
 * tests/unit/integrationFilter.test.ts
 *
 * assetMatchesIntegrationFilter — the "would the next discovery sweep still
 * include this asset" gate used by /assets/:id/probe-now. Covers the vCenter
 * vmInclude/vmExclude branch (added with the vCenter integration) plus the
 * pre-existing hostname and OU behaviors it sits beside.
 */

import { describe, it, expect } from "vitest";
import { assetMatchesIntegrationFilter } from "../../src/utils/integrationFilter.js";

function asset(over: Record<string, unknown> = {}) {
  return { hostname: null, learnedLocation: null, ...over } as any;
}

describe("assetMatchesIntegrationFilter — vcenter", () => {
  const intg = (config: Record<string, unknown>) => ({ type: "vcenter", config });

  it("matches the vCenter-side VM name (source-preferred) over the merged hostname", () => {
    // Guest hostname won projection, but the filter matches the vCenter VM name.
    const a = asset({ hostname: "sql01.corp.local", vmName: "prod-sql01" });
    expect(assetMatchesIntegrationFilter(a, intg({ vmInclude: ["prod-*"] })).included).toBe(true);
    expect(assetMatchesIntegrationFilter(a, intg({ vmInclude: ["dev-*"] })).included).toBe(false);
  });

  it("falls back to the asset hostname when no vmName was threaded", () => {
    const a = asset({ hostname: "prod-sql01" });
    expect(assetMatchesIntegrationFilter(a, intg({ vmExclude: ["prod-*"] })).included).toBe(false);
    expect(assetMatchesIntegrationFilter(a, intg({ vmExclude: ["dev-*"] })).included).toBe(true);
  });

  it("include wins over exclude (discovery-side filterVms semantics)", () => {
    const a = asset({ vmName: "prod-a" });
    expect(assetMatchesIntegrationFilter(a, intg({ vmInclude: ["prod-*"], vmExclude: ["*"] })).included).toBe(true);
  });

  it("ESXi hosts are never name-filtered", () => {
    const a = asset({ hostname: "esx01.corp.local", assetType: "hypervisor" });
    expect(assetMatchesIntegrationFilter(a, intg({ vmExclude: ["*"] })).included).toBe(true);
  });

  it("no candidate name → included (can't evaluate)", () => {
    expect(assetMatchesIntegrationFilter(asset(), intg({ vmInclude: ["prod-*"] })).included).toBe(true);
  });
});

describe("assetMatchesIntegrationFilter — pre-existing branches unchanged", () => {
  it("fortimanager filters on hostname", () => {
    const intg = { type: "fortimanager", config: { deviceInclude: ["branch-*"] } };
    expect(assetMatchesIntegrationFilter(asset({ hostname: "branch-01" }), intg).included).toBe(true);
    expect(assetMatchesIntegrationFilter(asset({ hostname: "hq-01" }), intg).included).toBe(false);
  });

  it("activedirectory filters on the OU path (source-preferred adOuPath)", () => {
    const intg = { type: "activedirectory", config: { ouExclude: ["*OU=Retired*"] } };
    expect(assetMatchesIntegrationFilter(asset({ hostname: "pc1", adOuPath: "OU=Retired,DC=corp" }), intg).included).toBe(false);
    expect(assetMatchesIntegrationFilter(asset({ hostname: "pc1", adOuPath: "OU=HQ,DC=corp" }), intg).included).toBe(true);
  });

  it("unknown integration types are always included (no authoritative match data)", () => {
    expect(assetMatchesIntegrationFilter(asset({ hostname: "x" }), { type: "somethingelse", config: {} }).included).toBe(true);
  });
});
