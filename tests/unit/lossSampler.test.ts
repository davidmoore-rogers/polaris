/**
 * tests/unit/lossSampler.test.ts
 *
 * The ICMP packet-loss sampler's pure decisions. The load-bearing rule is the
 * WINDOW: `warning` and `recovering` only, never `down` — ICMP does not
 * authenticate the device it reaches, so replies are only trustworthy while the
 * response-time poll is still succeeding intermittently and can corroborate
 * them. A fully-down asset must read 100% loss rather than whatever answers its
 * address.
 *
 * The sampler is currently DISABLED via the LOSS_SAMPLER_ENABLED kill switch
 * (packet loss reads from the response-time poll alone); the window logic is
 * exercised with an explicit `enabled: true` so it stays verified for when the
 * feature is revisited, and the kill-switch block pins the shipped default.
 *
 * Coverage:
 *   - the kill switch: default-off, and off wins over an otherwise-eligible asset.
 *   - the window: warning/recovering sample; up / down / recovering-adjacent
 *     states and unknown/null do not.
 *   - dependency suppression excludes (never ping into an upstream outage).
 *   - maintenance excludes.
 *   - agent / disabled / null polling exclude.
 *   - target resolution + "nothing to ping" exclusion.
 *   - the due-check arithmetic, including the disable-by-zero case.
 */

import { describe, it, expect } from "vitest";
import {
  lossSamplerAppliesTo,
  lossSampleIsDue,
  lossSamplerTarget,
  LOSS_SAMPLER_ENABLED,
  LOSS_SAMPLER_INTERVAL_SEC,
  LOSS_SAMPLER_TIMEOUT_MS,
} from "../../src/utils/lossSampler.js";

const eff = (responseTimePolling: string | null = "snmp") => ({ responseTimePolling });
const asset = (over: Record<string, unknown> = {}) => ({
  monitorStatus: "warning",
  ipAddress: "10.0.0.5",
  ...over,
}) as any;

describe("lossSamplerAppliesTo — kill switch", () => {
  it("is shipped disabled: the default call refuses an otherwise-eligible asset", () => {
    expect(LOSS_SAMPLER_ENABLED).toBe(false);
    expect(lossSamplerAppliesTo(asset(), eff())).toBe(false);
  });

  it("an explicit enabled=false wins regardless of state", () => {
    expect(lossSamplerAppliesTo(asset({ monitorStatus: "warning" }), eff(), false)).toBe(false);
    expect(lossSamplerAppliesTo(asset({ monitorStatus: "recovering" }), eff(), false)).toBe(false);
  });
});

describe("lossSamplerAppliesTo — the window (enabled)", () => {
  it("samples while a failure run is being served (warning)", () => {
    expect(lossSamplerAppliesTo(asset({ monitorStatus: "warning" }), eff(), true)).toBe(true);
  });

  it("samples while a recovery run is being served (recovering)", () => {
    expect(lossSamplerAppliesTo(asset({ monitorStatus: "recovering" }), eff(), true)).toBe(true);
  });

  it("does NOT sample a down asset — uncorroborated ICMP could mask 100% loss", () => {
    expect(lossSamplerAppliesTo(asset({ monitorStatus: "down" }), eff(), true)).toBe(false);
  });

  it("does not sample a healthy asset (nothing to resolve — loss is 0%)", () => {
    expect(lossSamplerAppliesTo(asset({ monitorStatus: "up" }), eff(), true)).toBe(false);
  });

  it("does not sample an asset that has never been probed", () => {
    expect(lossSamplerAppliesTo(asset({ monitorStatus: "unknown" }), eff(), true)).toBe(false);
    expect(lossSamplerAppliesTo(asset({ monitorStatus: null }), eff(), true)).toBe(false);
  });
});

describe("lossSamplerAppliesTo — exclusions (enabled)", () => {
  it("never pings into an upstream outage", () => {
    expect(lossSamplerAppliesTo(asset({ dependencySuppressed: true }), eff(), true)).toBe(false);
    // ...and an explicit false is not treated as suppression.
    expect(lossSamplerAppliesTo(asset({ dependencySuppressed: false }), eff(), true)).toBe(true);
  });

  it("skips an asset in a maintenance window", () => {
    expect(lossSamplerAppliesTo(asset({ status: "maintenance" }), eff(), true)).toBe(false);
    expect(lossSamplerAppliesTo(asset({ status: "active" }), eff(), true)).toBe(true);
  });

  it("skips streams the server does not drive", () => {
    expect(lossSamplerAppliesTo(asset(), eff("agent"), true)).toBe(false);
    expect(lossSamplerAppliesTo(asset(), eff("disabled"), true)).toBe(false);
    expect(lossSamplerAppliesTo(asset(), eff(null), true)).toBe(false);
  });

  it("applies regardless of which transport the response-time stream uses", () => {
    for (const m of ["snmp", "icmp", "rest_api", "winrm", "ssh"]) {
      expect(lossSamplerAppliesTo(asset(), eff(m), true)).toBe(true);
    }
  });

  it("skips an asset with nothing to ping", () => {
    expect(lossSamplerAppliesTo(asset({ ipAddress: null }), eff(), true)).toBe(false);
  });
});

describe("lossSamplerTarget", () => {
  it("prefers the IP, then the DNS name, then the hostname", () => {
    expect(lossSamplerTarget({ monitorStatus: "warning", ipAddress: "10.0.0.5", dnsName: "a.example", hostname: "a" })).toBe("10.0.0.5");
    expect(lossSamplerTarget({ monitorStatus: "warning", ipAddress: null, dnsName: "a.example", hostname: "a" })).toBe("a.example");
    expect(lossSamplerTarget({ monitorStatus: "warning", ipAddress: null, dnsName: null, hostname: "a" })).toBe("a");
  });

  it("returns null when the asset has no addressable identity", () => {
    expect(lossSamplerTarget({ monitorStatus: "warning" })).toBeNull();
    expect(lossSamplerTarget({ monitorStatus: "warning", ipAddress: "", dnsName: "", hostname: "" })).toBeNull();
  });
});

describe("lossSampleIsDue", () => {
  const now = new Date("2026-08-19T12:00:00.000Z");

  it("is due when it has never sampled", () => {
    expect(lossSampleIsDue(null, now)).toBe(true);
    expect(lossSampleIsDue(undefined, now)).toBe(true);
  });

  it("is due once the interval has fully elapsed", () => {
    const last = new Date(now.getTime() - LOSS_SAMPLER_INTERVAL_SEC * 1000);
    expect(lossSampleIsDue(last, now)).toBe(true);
  });

  it("is not due inside the interval", () => {
    const last = new Date(now.getTime() - (LOSS_SAMPLER_INTERVAL_SEC * 1000 - 1));
    expect(lossSampleIsDue(last, now)).toBe(false);
  });

  it("treats a non-positive interval as disabled", () => {
    expect(lossSampleIsDue(null, now, 0)).toBe(false);
    expect(lossSampleIsDue(null, now, -1)).toBe(false);
  });
});

describe("constants", () => {
  it("keeps the per-ping timeout below the spacing so a sample can never overlap the next", () => {
    expect(LOSS_SAMPLER_TIMEOUT_MS).toBeLessThan(LOSS_SAMPLER_INTERVAL_SEC * 1000);
  });
});
