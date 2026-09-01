/**
 * tests/unit/probeLossAnchor.test.ts
 *
 * `stampsRecoveryAnchor` — which probe ends an outage and so stamps
 * `Asset.recoveryStartedAt`.
 *
 * The column is DORMANT since 2026-09-01: the loss ratio used to start no
 * earlier than it, and that trim is gone (business rule 29). The predicate is
 * still pinned because the write survives, and because the reasoning behind it
 * is exactly the reasoning that removed its reader — stamping on a warning->up
 * recovery would have collapsed a flapping device's window to its last few
 * probes and reported ~0% loss forever, which is precisely what the anchor
 * turned out to be doing from the `down` side.
 */

import { describe, it, expect } from "vitest";
import { stampsRecoveryAnchor } from "../../src/utils/probeLossAnchor.js";

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
