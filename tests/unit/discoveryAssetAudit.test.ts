import { describe, it, expect } from "vitest";
import {
  snapshotMaterialAssetFields,
  computeMaterialAssetChanges,
} from "../../src/services/eventLogService.js";

// These two pure helpers back the per-asset discovery audit events surfaced on
// the asset details Events tab. The diff gating is what keeps the 7-day Event
// table from flooding at 2000 assets: an unchanged discovery pass (which still
// bumps lastSeen / monitor stamp every cycle) must produce NO change set.

describe("snapshotMaterialAssetFields", () => {
  it("captures the material-field whitelist and null-coalesces missing fields", () => {
    const snap = snapshotMaterialAssetFields({
      id: "a1",
      hostname: "fw-1",
      status: "active",
      // lastSeen / monitored deliberately omitted from the whitelist
      lastSeen: new Date(),
      monitored: true,
    });
    expect(snap.hostname).toBe("fw-1");
    expect(snap.status).toBe("active");
    expect(snap.ipAddress).toBeNull(); // missing → null
    expect("lastSeen" in snap).toBe(false); // non-material, not captured
    expect("monitored" in snap).toBe(false);
  });
});

describe("computeMaterialAssetChanges", () => {
  it("returns undefined when nothing material changed", () => {
    const before = { hostname: "fw-1", status: "active", ipAddress: "10.0.0.1" };
    // A typical unchanged discovery write: only non-material churn fields.
    const after = { lastSeen: new Date(), fortinetTopology: { role: "fortigate" }, monitored: true };
    expect(computeMaterialAssetChanges(before, after)).toBeUndefined();
  });

  it("returns undefined when material fields are present but identical", () => {
    const before = { hostname: "fw-1", status: "active", ipAddress: "10.0.0.1" };
    const after = { hostname: "fw-1", status: "active", ipAddress: "10.0.0.1", lastSeen: new Date() };
    expect(computeMaterialAssetChanges(before, after)).toBeUndefined();
  });

  it("records only the material fields the write actually touched", () => {
    const before = { hostname: "fw-1", status: "active", ipAddress: "10.0.0.1", model: "FortiGate" };
    const after = { hostname: "fw-1-renamed", ipAddress: "10.0.0.2", lastSeen: new Date() };
    const changes = computeMaterialAssetChanges(before, after);
    expect(changes).toBeDefined();
    expect(changes!.hostname).toEqual({ from: "fw-1", to: "fw-1-renamed" });
    expect(changes!.ipAddress).toEqual({ from: "10.0.0.1", to: "10.0.0.2" });
    // model wasn't in `after` (discovery had no opinion) → not a change.
    expect("model" in changes!).toBe(false);
    // status was unchanged → not a change even though it's material.
    expect("status" in changes!).toBe(false);
  });

  it("treats null/undefined as equal (no spurious change)", () => {
    const before = { learnedAddress: null };
    const after = { learnedAddress: undefined };
    expect(computeMaterialAssetChanges(before, after)).toBeUndefined();
  });

  it("detects a re-typed asset (endpoint → switch) as a material change", () => {
    const before = { assetType: "other" };
    const after = { assetType: "switch" };
    const changes = computeMaterialAssetChanges(before, after);
    expect(changes!.assetType).toEqual({ from: "other", to: "switch" });
  });

  it("detects a decommission → active resurrection", () => {
    const before = { status: "decommissioned" };
    const after = { status: "active" };
    const changes = computeMaterialAssetChanges(before, after);
    expect(changes!.status).toEqual({ from: "decommissioned", to: "active" });
  });
});
