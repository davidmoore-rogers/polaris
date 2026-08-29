/**
 * tests/unit/monitorHeavyCadenceGate.test.ts
 *
 * `runsHeavyCadences` decides whether telemetry / system-info / interfaces /
 * storage / LLDP / processes run for an asset. It exists as ONE function
 * because two documented-lockstep implementations read it — the cursor pass
 * (monitoringService.loadMonitorPassCandidates) and the pg-boss publisher
 * (jobs/monitorAssets) — and because the passive case is the highest-risk
 * silent regression in the down-detection change: get it wrong and every
 * passive device's charts go flat with nothing erroring.
 */

import { describe, it, expect } from "vitest";
import { runsHeavyCadences } from "../../src/utils/monitorStatus.js";

const a = (monitorStatus: string | null, over: Partial<{ consecutiveFailures: number | null; dependencySuppressed: boolean }> = {}) => ({
  monitorStatus,
  consecutiveFailures: 0,
  dependencySuppressed: false,
  ...over,
});

describe("runsHeavyCadences", () => {
  it("runs for a confirmed-up asset", () => {
    expect(runsHeavyCadences(a("up"))).toBe(true);
  });

  it("does NOT run for the in-flux / unreachable states", () => {
    for (const s of ["warning", "down", "unknown", null]) {
      expect(runsHeavyCadences(a(s))).toBe(false);
    }
    // Recovering with misses still outstanding is in-flux like the rest — a
    // device three misses deep that has answered once is not somewhere to point
    // a full SNMP walk.
    expect(runsHeavyCadences(a("recovering", { consecutiveFailures: 1 }))).toBe(false);
  });

  describe("recovering", () => {
    it("RUNS once the bucket has drained — the confirmation run is not an outage", () => {
      // Reachable only since the recovery confirmation run existed (business
      // rule 36): before it, `recovering` implied outstanding misses. The asset
      // is answering every probe and is amber only because its automation asked
      // for more confirmations, which is not a thing that should decide how
      // fresh its charts are.
      expect(runsHeavyCadences(a("recovering", { consecutiveFailures: 0 }))).toBe(true);
    });
  });

  it("dependency suppression beats every status, including up", () => {
    expect(runsHeavyCadences(a("up", { dependencySuppressed: true }))).toBe(false);
    expect(runsHeavyCadences(a("passive", { dependencySuppressed: true }))).toBe(false);
  });

  describe("passive", () => {
    it("RUNS while the last probe succeeded — a passive device is still polled and charted", () => {
      expect(runsHeavyCadences(a("passive", { consecutiveFailures: 0 }))).toBe(true);
    });

    it("stops once the device stops answering — no full SNMP walks at a dark host", () => {
      expect(runsHeavyCadences(a("passive", { consecutiveFailures: 1 }))).toBe(false);
      expect(runsHeavyCadences(a("passive", { consecutiveFailures: 9 }))).toBe(false);
    });

    it("treats a missing counter as answering (pre-feature rows, and the pseudo-host)", () => {
      expect(runsHeavyCadences({ monitorStatus: "passive", consecutiveFailures: null, dependencySuppressed: false })).toBe(true);
      expect(runsHeavyCadences({ monitorStatus: "passive", dependencySuppressed: false })).toBe(true);
    });
  });

  it("an up asset runs regardless of its failure counter", () => {
    // "up" is already a positive verdict — the counter only stands in for one
    // where no verdict exists.
    expect(runsHeavyCadences(a("up", { consecutiveFailures: 2 }))).toBe(true);
  });
});
