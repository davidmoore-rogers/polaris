/**
 * tests/unit/reservationStaleService.test.ts
 *
 * Pure-function coverage for effectiveLastSignalMs — the evidence-picking core
 * of stale-reservation detection. The DB-backed correlation (matching a
 * reservation to an Asset by MAC/IP) is exercised by the integration suite;
 * this file just pins the "which signal wins" logic, including the
 * static-but-present case (asset presence rescues a never-leased reservation).
 */

import { describe, it, expect } from "vitest";
import { effectiveLastSignalMs } from "../../src/services/reservationStaleService.js";

const DAY = 24 * 60 * 60 * 1000;

describe("effectiveLastSignalMs", () => {
  it("falls back to the baseline when there is no real evidence", () => {
    const baselineMs = 1_000 * DAY;
    expect(
      effectiveLastSignalMs({ lastSeenLeasedMs: null, assetLastSeenMs: null, baselineMs }),
    ).toEqual({ ms: baselineMs, evidence: "baseline" });
  });

  it("uses the lease when only a lease exists (legacy behavior preserved)", () => {
    const leaseMs = 500 * DAY;
    expect(
      effectiveLastSignalMs({ lastSeenLeasedMs: leaseMs, assetLastSeenMs: null, baselineMs: 1_000 * DAY }),
    ).toEqual({ ms: leaseMs, evidence: "lease" });
  });

  it("uses a real lease even when it predates the baseline (baseline is a fallback, not a floor)", () => {
    // A long-dead reservation with a genuine old lease must still surface as
    // stale during the cold-start window rather than being spared.
    const leaseMs = 10 * DAY;
    const baselineMs = 900 * DAY;
    expect(
      effectiveLastSignalMs({ lastSeenLeasedMs: leaseMs, assetLastSeenMs: null, baselineMs }),
    ).toEqual({ ms: leaseMs, evidence: "lease" });
  });

  it("rescues a never-leased reservation when a correlated asset is fresher (the static-IP case)", () => {
    // No DHCP lease ever, but the statically-addressed device is online and
    // its asset lastSeen is recent → asset wins, well past the baseline.
    const assetMs = 1_200 * DAY;
    const baselineMs = 1_000 * DAY;
    expect(
      effectiveLastSignalMs({ lastSeenLeasedMs: null, assetLastSeenMs: assetMs, baselineMs }),
    ).toEqual({ ms: assetMs, evidence: "asset" });
  });

  it("picks the freshest of lease and asset when both exist", () => {
    const leaseMs = 100 * DAY;
    const assetMs = 300 * DAY;
    expect(
      effectiveLastSignalMs({ lastSeenLeasedMs: leaseMs, assetLastSeenMs: assetMs, baselineMs: 0 }),
    ).toEqual({ ms: assetMs, evidence: "asset" });

    // Lease fresher than asset → lease wins.
    expect(
      effectiveLastSignalMs({ lastSeenLeasedMs: assetMs, assetLastSeenMs: leaseMs, baselineMs: 0 }),
    ).toEqual({ ms: assetMs, evidence: "lease" });
  });

  it("prefers the lease on an exact tie (deterministic)", () => {
    const ms = 250 * DAY;
    expect(
      effectiveLastSignalMs({ lastSeenLeasedMs: ms, assetLastSeenMs: ms, baselineMs: 0 }),
    ).toEqual({ ms, evidence: "lease" });
  });

  it("a stale asset does not rescue — both signals beyond the window still flag", () => {
    // Asset lastSeen is old too (device genuinely gone). Effective signal is
    // the freshest real evidence; the caller compares it against the cutoff.
    const leaseMs = 5 * DAY;
    const assetMs = 8 * DAY;
    const baselineMs = 100 * DAY;
    const out = effectiveLastSignalMs({ lastSeenLeasedMs: leaseMs, assetLastSeenMs: assetMs, baselineMs });
    expect(out).toEqual({ ms: assetMs, evidence: "asset" });
  });

  it("rescues a never-leased, asset-less reservation via ARP confirmation (the ICMP-silent static case)", () => {
    // The device never DHCPs and was never discovered as an Asset, but the
    // FortiGate's ARP table bound its reserved MAC to the IP this cycle.
    const arpMs = 1_200 * DAY;
    const baselineMs = 1_000 * DAY;
    expect(
      effectiveLastSignalMs({ lastSeenLeasedMs: null, lastSeenArpMs: arpMs, assetLastSeenMs: null, baselineMs }),
    ).toEqual({ ms: arpMs, evidence: "arp" });
  });

  it("picks the freshest across all three real signals", () => {
    expect(
      effectiveLastSignalMs({ lastSeenLeasedMs: 100 * DAY, lastSeenArpMs: 300 * DAY, assetLastSeenMs: 200 * DAY, baselineMs: 0 }),
    ).toEqual({ ms: 300 * DAY, evidence: "arp" });
    expect(
      effectiveLastSignalMs({ lastSeenLeasedMs: 400 * DAY, lastSeenArpMs: 300 * DAY, assetLastSeenMs: 200 * DAY, baselineMs: 0 }),
    ).toEqual({ ms: 400 * DAY, evidence: "lease" });
    expect(
      effectiveLastSignalMs({ lastSeenLeasedMs: 100 * DAY, lastSeenArpMs: 300 * DAY, assetLastSeenMs: 500 * DAY, baselineMs: 0 }),
    ).toEqual({ ms: 500 * DAY, evidence: "asset" });
  });

  it("uses a real-but-old ARP signal over the baseline (fallback, not floor) and still lets the row flag", () => {
    const arpMs = 10 * DAY;
    const baselineMs = 900 * DAY;
    expect(
      effectiveLastSignalMs({ lastSeenLeasedMs: null, lastSeenArpMs: arpMs, assetLastSeenMs: null, baselineMs }),
    ).toEqual({ ms: arpMs, evidence: "arp" });
  });

  it("prefers the lease over ARP on an exact tie (deterministic)", () => {
    const ms = 250 * DAY;
    expect(
      effectiveLastSignalMs({ lastSeenLeasedMs: ms, lastSeenArpMs: ms, assetLastSeenMs: null, baselineMs: 0 }),
    ).toEqual({ ms, evidence: "lease" });
  });

  it("omitting lastSeenArpMs entirely preserves pre-feature behavior", () => {
    const leaseMs = 500 * DAY;
    expect(
      effectiveLastSignalMs({ lastSeenLeasedMs: leaseMs, assetLastSeenMs: null, baselineMs: 1_000 * DAY }),
    ).toEqual({ ms: leaseMs, evidence: "lease" });
  });
});
