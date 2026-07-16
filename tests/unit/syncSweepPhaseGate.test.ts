import { describe, it, expect } from "vitest";
import { sweepPhaseEnabled, type SyncMode } from "../../src/api/routes/integrations.js";

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
