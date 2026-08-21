/**
 * tests/unit/probeLossAnchor.test.ts
 *
 * The two halves of the packet-loss recovery anchor (business rule 29b):
 * `stampsRecoveryAnchor` (which probe ends an outage and stamps
 * Asset.recoveryStartedAt) and `effectiveLossAnchorMs` (where the measurement
 * then starts — the JS mirror of the query's GREATEST).
 *
 * Both are one-liners with silent failure modes, which is why they're pinned:
 * stamping on warning->up collapses a flapping device's window to its last few
 * probes and reports ~0% forever, and taking the wrong side of the anchor makes
 * the alert email's chart contradict the reading that fired it.
 */

import { describe, it, expect } from "vitest";
import { stampsRecoveryAnchor, effectiveLossAnchorMs } from "../../src/utils/probeLossAnchor.js";

describe("stampsRecoveryAnchor", () => {
  it("stamps the success that ends an outage", () => {
    // The usual shape (down -> recovering) and the failureThreshold===1 shape
    // (down -> up) both arrive here as "success out of down".
    expect(stampsRecoveryAnchor("down", true)).toBe(true);
  });

  it("stamps the first success of a device that had never answered", () => {
    expect(stampsRecoveryAnchor("unknown", true)).toBe(true);
    expect(stampsRecoveryAnchor(null, true)).toBe(true);
    expect(stampsRecoveryAnchor(undefined, true)).toBe(true);
  });

  it("does NOT stamp a warning->up recovery — this is what keeps flapping measurable", () => {
    // A lossy device sits in warning between failures. Anchoring there would
    // restart the loss window every few probes, so every flapping device would
    // read ~0% and no packet-loss automation would ever fire.
    expect(stampsRecoveryAnchor("warning", true)).toBe(false);
  });

  it("does not stamp mid-recovery or on a steady-state success", () => {
    // Already inside the recovery: the stamp was taken on its first probe and
    // must not creep forward, or each recovery success would trim the window
    // again.
    expect(stampsRecoveryAnchor("recovering", true)).toBe(false);
    expect(stampsRecoveryAnchor("up", true)).toBe(false);
  });

  it("never stamps on a failed probe, whatever the state", () => {
    for (const s of ["up", "warning", "recovering", "down", "unknown", null]) {
      expect(stampsRecoveryAnchor(s, false)).toBe(false);
    }
  });
});

describe("effectiveLossAnchorMs", () => {
  const first = 1_000_000;

  it("takes the recovery when it is later — the outage that started mid-window", () => {
    expect(effectiveLossAnchorMs(first, first + 60_000)).toBe(first + 60_000);
  });

  it("ignores a recovery older than the window (mirrors GREATEST's NULL handling)", () => {
    expect(effectiveLossAnchorMs(first, first - 3_600_000)).toBe(first);
    expect(effectiveLossAnchorMs(first, null)).toBe(first);
  });

  it("has no anchor when nothing answered — the caller decides what that means", () => {
    // The engine drops such an asset (asset-down owns a total outage); display
    // paths keep every row and read 100%.
    expect(effectiveLossAnchorMs(null, first)).toBeNull();
    expect(effectiveLossAnchorMs(null, null)).toBeNull();
  });
});
