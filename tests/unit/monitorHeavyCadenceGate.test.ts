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
    for (const s of ["warning", "recovering", "down", "unknown", null]) {
      expect(runsHeavyCadences(a(s))).toBe(false);
    }
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
