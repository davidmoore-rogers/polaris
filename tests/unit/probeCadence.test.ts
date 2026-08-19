/**
 * tests/unit/probeCadence.test.ts
 *
 * `resolveProbeIntervalSec` — the shared probe-spacing decision used by BOTH
 * monitor paths (the cursor pass's computeDueWork and the pg-boss publisher's
 * mirrored due-calc). The two due-sets are contractually identical, so this is
 * the one place the arithmetic is pinned.
 *
 * The response-time poll runs at exactly the configured cadence, with ONE
 * clamp: a dependency-suppressed asset drops to 2× the interval. There is
 * deliberately NO acceleration while a failure or recovery run is being
 * confirmed — the fast-confirm re-probe was removed 2026-08-19, and extra
 * resolution during a run is the ICMP loss sampler's job (lossSampler.test.ts),
 * which feeds packet-loss statistics only and never the state machine. So
 * time-to-down is `failureThreshold × intervalSeconds`, which is what the
 * monitor-settings card reports.
 *
 * Coverage:
 *   - the cadence is returned as configured in every counter state, so nothing
 *     can quietly re-introduce a mid-run acceleration.
 *   - dependency suppression doubles it.
 *   - a disabled stream is not slowed by suppression (nothing to slow).
 */

import { describe, it, expect } from "vitest";
import { resolveProbeIntervalSec } from "../../src/services/monitoringService.js";

type Eff = Parameters<typeof resolveProbeIntervalSec>[1];

function eff(over: Partial<Eff> = {}): Eff {
  return {
    intervalSeconds: 300,
    responseTimePolling: "icmp",
    ...over,
  } as Eff;
}

function asset(dependencySuppressed = false) {
  return { dependencySuppressed };
}

describe("resolveProbeIntervalSec", () => {
  it("returns the configured cadence for a steady asset", () => {
    expect(resolveProbeIntervalSec(asset(), eff())).toBe(300);
    expect(resolveProbeIntervalSec(asset(), eff({ intervalSeconds: 60 }))).toBe(60);
  });

  it("does not accelerate mid-run — down takes failureThreshold × interval", () => {
    // The counters are no longer an input at all; every state gets base cadence.
    // Pinned explicitly because re-introducing acceleration here would silently
    // change what `down` means and double-count a miss inside a probe timeout.
    for (const interval of [5, 60, 300]) {
      expect(resolveProbeIntervalSec(asset(), eff({ intervalSeconds: interval }))).toBe(interval);
    }
  });

  it("halves the rate for a dependency-suppressed asset (parent is dark)", () => {
    expect(resolveProbeIntervalSec(asset(true), eff())).toBe(600);
    expect(resolveProbeIntervalSec(asset(true), eff({ intervalSeconds: 60 }))).toBe(120);
  });

  it("leaves a disabled stream alone even when suppressed", () => {
    expect(resolveProbeIntervalSec(asset(true), eff({ responseTimePolling: "disabled" }))).toBe(300);
  });

  it("applies the suppression clamp regardless of transport", () => {
    for (const m of ["icmp", "snmp", "rest_api", "winrm", "ssh", "agent"]) {
      expect(resolveProbeIntervalSec(asset(true), eff({ responseTimePolling: m }))).toBe(600);
      expect(resolveProbeIntervalSec(asset(), eff({ responseTimePolling: m }))).toBe(300);
    }
  });
});
