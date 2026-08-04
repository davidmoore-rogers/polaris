import { describe, it, expect } from "vitest";
import { sweepPhaseEnabled, cascadeControllerOf, type SyncMode } from "../../src/api/routes/integrations.js";

// The mode→sweep-phase matrix behind syncDhcpSubnets' destructive phases.
// Getting this wrong on a scoped run mass-deprecates subnets (Phase 2) or
// decommissions healthy firewalls (Phase 2a) — knownFirewallSerials is built
// from result.devices (the processed chunks, one device in a scoped run),
// not the raw ADOM roster.

const PHASES = ["2", "2a", "2b", "2c"] as const;

describe("sweepPhaseEnabled — SyncMode × sweep-phase matrix", () => {
  it("finalize-scoped runs ONLY Phase 2b (per-controller switch/AP decommission)", () => {
    expect(sweepPhaseEnabled("finalize-scoped", "2b")).toBe(true);
    expect(sweepPhaseEnabled("finalize-scoped", "2")).toBe(false);
    expect(sweepPhaseEnabled("finalize-scoped", "2a")).toBe(false);
    expect(sweepPhaseEnabled("finalize-scoped", "2c")).toBe(false);
  });

  it("skip-deprecation runs no sweep phase (the per-device pass)", () => {
    for (const phase of PHASES) {
      expect(sweepPhaseEnabled("skip-deprecation", phase)).toBe(false);
    }
  });

  it("full / finalize / deprecation-only run every sweep phase (pre-feature behavior)", () => {
    for (const mode of ["full", "finalize", "deprecation-only"] as SyncMode[]) {
      for (const phase of PHASES) {
        expect(sweepPhaseEnabled(mode, phase)).toBe(true);
      }
    }
  });
});

// Phase 2a controller cascade — a decommissioned FortiGate takes its managed
// FortiSwitches/FortiAPs with it. The matcher must be case-insensitive on the
// controller name (FMG device names vs FortiOS hostnames can disagree in case)
// and must never match a child with no controllerFortigate stamp.
describe("cascadeControllerOf — Phase 2a switch/AP cascade matcher", () => {
  const stale = new Set(["jefferson-101f-1", "glenrose-61f-1"]);

  it("matches a child whose controllerFortigate is a decommissioned gate, returning the stamped name", () => {
    expect(cascadeControllerOf({ controllerFortigate: "JEFFERSON-101F-1" }, stale)).toBe("JEFFERSON-101F-1");
    expect(cascadeControllerOf({ controllerFortigate: "glenrose-61f-1" }, stale)).toBe("glenrose-61f-1");
  });

  it("does not match a child managed by a surviving gate", () => {
    expect(cascadeControllerOf({ controllerFortigate: "SPRINGDALE-61F-1" }, stale)).toBeNull();
  });

  it("does not match when the topology stamp is missing, null, or carries no controller", () => {
    expect(cascadeControllerOf(null, stale)).toBeNull();
    expect(cascadeControllerOf(undefined, stale)).toBeNull();
    expect(cascadeControllerOf({}, stale)).toBeNull();
    expect(cascadeControllerOf({ controllerFortigate: null }, stale)).toBeNull();
    expect(cascadeControllerOf({ controllerFortigate: "" }, stale)).toBeNull();
    expect(cascadeControllerOf({ controllerFortigate: 42 }, stale)).toBeNull();
  });

  it("matches nothing against an empty stale set (no gates decommissioned this run)", () => {
    expect(cascadeControllerOf({ controllerFortigate: "JEFFERSON-101F-1" }, new Set())).toBeNull();
  });
});
