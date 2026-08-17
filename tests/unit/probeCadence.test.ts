/**
 * tests/unit/probeCadence.test.ts
 *
 * `resolveProbeIntervalSec` — the shared probe-spacing decision used by BOTH
 * monitor paths (the cursor pass's computeDueWork and the pg-boss publisher's
 * mirrored due-calc). Business rule 30: an asset whose failure/recovery run is
 * still being confirmed is re-probed at the fast-confirm cadence instead of
 * waiting a full interval, so time-to-down stops being a multiple of the
 * operator's cadence choice.
 *
 * Coverage:
 *   - steady up / steady down keep base cadence (no acceleration, no backoff).
 *   - a failure run under the threshold accelerates; the run that REACHES the
 *     threshold does not (the asset is down — there's nothing left to confirm).
 *   - a recovery run accelerates the same way.
 *   - dependency suppression wins over acceleration (2× base).
 *   - agent / disabled streams never accelerate.
 *   - the floor: never faster than the probe timeout or the loop tick, and
 *     never slower than the configured cadence.
 */

import { describe, it, expect } from "vitest";
import { resolveProbeIntervalSec } from "../../src/services/monitoringService.js";

type Eff = Parameters<typeof resolveProbeIntervalSec>[1];

function eff(over: Partial<Eff> = {}): Eff {
  return {
    intervalSeconds: 300,
    failureThreshold: 3,
    probeTimeoutMs: 5000,
    fastConfirmIntervalSec: 10,
    responseTimePolling: "icmp",
    ...over,
  } as Eff;
}

function asset(cf: number, cs: number, dependencySuppressed = false) {
  return { dependencySuppressed, consecutiveFailures: cf, consecutiveSuccesses: cs };
}

describe("resolveProbeIntervalSec", () => {
  it("leaves a steady asset on its configured cadence", () => {
    expect(resolveProbeIntervalSec(asset(0, 5), eff())).toBe(300);  // steady up
    expect(resolveProbeIntervalSec(asset(9, 0), eff())).toBe(300);  // long down
    // Exactly at the threshold is DOWN, not mid-confirmation.
    expect(resolveProbeIntervalSec(asset(3, 0), eff())).toBe(300);
  });

  it("accelerates a failure run that hasn't reached the threshold", () => {
    expect(resolveProbeIntervalSec(asset(1, 0), eff())).toBe(10);
    expect(resolveProbeIntervalSec(asset(2, 0), eff())).toBe(10);
  });

  it("accelerates an unconfirmed recovery run too", () => {
    // A recovery needs failureThreshold successes; at a 300s cadence that's 15
    // minutes of "recovering" before the down alert can clear.
    expect(resolveProbeIntervalSec(asset(0, 1), eff())).toBe(10);
    expect(resolveProbeIntervalSec(asset(0, 2), eff())).toBe(10);
    expect(resolveProbeIntervalSec(asset(0, 3), eff())).toBe(300); // confirmed up
  });

  it("gives dependency suppression precedence over acceleration", () => {
    // Parent is dark: half-rate, never hammer.
    expect(resolveProbeIntervalSec(asset(1, 0, true), eff())).toBe(600);
    expect(resolveProbeIntervalSec(asset(0, 0, true), eff())).toBe(600);
    // …except a disabled stream, which has nothing to slow down.
    expect(resolveProbeIntervalSec(asset(1, 0, true), eff({ responseTimePolling: "disabled" }))).toBe(300);
  });

  it("never accelerates a stream the server doesn't drive", () => {
    // Agent hosts advance their counters on pushes, so a fast server-side probe
    // would spin without ever confirming anything.
    expect(resolveProbeIntervalSec(asset(1, 0), eff({ responseTimePolling: "agent" }))).toBe(300);
    expect(resolveProbeIntervalSec(asset(1, 0), eff({ responseTimePolling: "disabled" }))).toBe(300);
    expect(resolveProbeIntervalSec(asset(1, 0), eff({ responseTimePolling: null }))).toBe(300);
  });

  it("floors the fast cadence at the probe timeout and the loop tick", () => {
    // A 30s SNMP timeout means a 10s re-probe would overlap its own predecessor
    // and double-count the failure — raised to 30s.
    expect(resolveProbeIntervalSec(asset(1, 0), eff({ probeTimeoutMs: 30_000 }))).toBe(30);
    // Below the 5s probe-loop tick is not deliverable, so 1s becomes 5s.
    expect(resolveProbeIntervalSec(asset(1, 0), eff({ fastConfirmIntervalSec: 1, probeTimeoutMs: 1000 }))).toBe(5);
    // And it never SLOWS a cadence that's already tighter than the fast value.
    expect(resolveProbeIntervalSec(asset(1, 0), eff({ intervalSeconds: 5, probeTimeoutMs: 1000 }))).toBe(5);
    expect(resolveProbeIntervalSec(asset(1, 0), eff({ intervalSeconds: 30, fastConfirmIntervalSec: 60, probeTimeoutMs: 1000 }))).toBe(30);
  });

  it("treats missing counters as zero (a candidate row that predates them)", () => {
    expect(resolveProbeIntervalSec({ dependencySuppressed: false }, eff())).toBe(300);
  });
});
