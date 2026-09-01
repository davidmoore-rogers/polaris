/**
 * tests/unit/lossSweep.test.ts
 *
 * Eligibility and cadence for the uniform ICMP loss sweep. The tests that
 * matter most here are the INCLUSIONS: the sampler this replaces was disabled
 * because its window (`warning` / `recovering` only) oversampled failure
 * periods, so anything that narrows the sweep back down to "when things look
 * bad" reintroduces business rule 29d's bias. Those cases are pinned
 * explicitly, with the reasoning, so a future exclusion has to argue with a
 * failing test rather than slip in as an optimisation.
 */

import { describe, it, expect } from "vitest";
import {
  lossSweepIncludes,
  lossSweepTarget,
  lossSweepIsDue,
  resolveSweepIntervalSec,
  chunkForSweep,
  LOSS_SWEEP_DEFAULT_INTERVAL_SEC,
} from "../../src/utils/lossSweep.js";

const eff = (responseTimePolling: string | null = "icmp") => ({ responseTimePolling });
const asset = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  monitored: true,
  status: "active",
  ipAddress: "10.0.0.1",
  ...over,
});

describe("lossSweepTarget", () => {
  it("prefers the address, then the DNS name, then the hostname", () => {
    expect(lossSweepTarget(asset())).toBe("10.0.0.1");
    expect(lossSweepTarget(asset({ ipAddress: null, dnsName: "a.example" }))).toBe("a.example");
    expect(lossSweepTarget(asset({ ipAddress: null, dnsName: null, hostname: "sw1" }))).toBe("sw1");
  });

  it("is null when there is nothing to ping", () => {
    expect(lossSweepTarget(asset({ ipAddress: null }))).toBeNull();
  });
});

describe("lossSweepIncludes — exclusions", () => {
  it("skips an unmonitored asset", () => {
    // Business rule 10 already forces monitored=false for the four
    // unmonitorable statuses, so this single test covers them all.
    expect(lossSweepIncludes(asset({ monitored: false }), eff())).toBe(false);
  });

  it("skips maintenance — the one status that keeps monitored true", () => {
    expect(lossSweepIncludes(asset({ status: "maintenance" }), eff())).toBe(false);
  });

  it("skips an asset whose response-time polling is disabled", () => {
    // Rule 30 reads `disabled` as "the operator said do not reach out to this
    // device", and that has to extend to ICMP or the setting means less than
    // it says.
    expect(lossSweepIncludes(asset(), eff("disabled"))).toBe(false);
  });

  it("skips an asset with no pingable target", () => {
    expect(lossSweepIncludes(asset({ ipAddress: null }), eff())).toBe(false);
  });

  it("goes quiet through the one predicate when the sweep is switched off", () => {
    expect(lossSweepIncludes(asset(), eff(), false)).toBe(false);
  });
});

describe("lossSweepIncludes — the inclusions that keep the sweep uniform", () => {
  it("includes an asset in EVERY monitor state, down included", () => {
    // The old sampler ran only in warning/recovering, which is the bias that
    // got it disabled. A ratio is only readable if its samples are evenly
    // spaced, so state must not gate the sweep at all.
    for (const monitorStatus of ["up", "warning", "recovering", "down", "unknown", "passive"]) {
      expect(lossSweepIncludes(asset({ monitorStatus }), eff())).toBe(true);
    }
  });

  it("includes a dependency-suppressed asset", () => {
    // Excluding these was a COST argument that batching retired. The failures
    // are still marked explained via AssetMonitorSample.dependencyDown (rule
    // 38b) — that is a rendering question, not a sampling one.
    expect(lossSweepIncludes(asset({ dependencySuppressed: true }), eff())).toBe(true);
  });

  it("includes an agent-monitored host", () => {
    // "I use the agent for status" must not silently mean "do not measure this
    // network's packet loss".
    expect(lossSweepIncludes(asset(), eff("agent"))).toBe(true);
  });

  it("includes hosts on every non-disabled transport", () => {
    for (const m of ["icmp", "snmp", "ssh", "winrm", "rest_api", "vcenter", "fortimanager", null]) {
      expect(lossSweepIncludes(asset(), eff(m))).toBe(true);
    }
  });
});

describe("lossSweepIsDue", () => {
  const now = new Date("2026-09-01T12:00:00Z");

  it("is due when never swept", () => {
    expect(lossSweepIsDue(null, now)).toBe(true);
  });

  it("respects the interval", () => {
    expect(lossSweepIsDue(new Date(now.getTime() - 59_000), now)).toBe(false);
    expect(lossSweepIsDue(new Date(now.getTime() - 60_000), now)).toBe(true);
  });

  it("treats a non-positive interval as disabled, even with no prior sweep", () => {
    expect(lossSweepIsDue(null, now, 0)).toBe(false);
    expect(lossSweepIsDue(null, now, -1)).toBe(false);
  });
});

describe("resolveSweepIntervalSec", () => {
  it("honours the configured interval when the host can sustain it", () => {
    expect(resolveSweepIntervalSec(120, 2000, true)).toBe(120);
  });

  it("defaults when unset", () => {
    expect(resolveSweepIntervalSec(null, 100, true)).toBe(LOSS_SWEEP_DEFAULT_INTERVAL_SEC);
    expect(resolveSweepIntervalSec(0, 100, true)).toBe(LOSS_SWEEP_DEFAULT_INTERVAL_SEC);
  });

  it("lets the throughput floor OVERRIDE a configured interval it cannot meet", () => {
    // Publishing faster than the sweep drains grows the queue without bound,
    // so the floor has to win over the operator's number rather than the
    // reverse.
    const floored = resolveSweepIntervalSec(60, 20000, false);
    expect(floored).toBeGreaterThan(60);
  });

  it("never floors below the configured value when fping is present", () => {
    expect(resolveSweepIntervalSec(300, 20000, true)).toBe(300);
  });
});

describe("chunkForSweep", () => {
  it("splits preserving order, so a chunk index is a stable singleton key", () => {
    expect(chunkForSweep(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("returns nothing for an empty fleet", () => {
    expect(chunkForSweep([], 500)).toEqual([]);
  });

  it("keeps a single chunk when the fleet fits", () => {
    expect(chunkForSweep(["a", "b"], 500)).toEqual([["a", "b"]]);
  });

  it("cannot be made to loop forever by a nonsense size", () => {
    expect(chunkForSweep(["a", "b"], 0)).toEqual([["a"], ["b"]]);
  });
});
