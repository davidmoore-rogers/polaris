/**
 * tests/unit/arpPrimeService.test.ts
 *
 * Pure-function coverage for the sweep planner (dedupe / validation / cap /
 * batching) plus a loopback smoke test of the fire-and-forget sender. No
 * FortiGate involved — the sender's only observable contract is "hands N
 * datagrams to the socket and never throws."
 */

import { describe, it, expect } from "vitest";
import {
  planSweepBatches,
  primeArpCache,
  ARP_SWEEP_BATCH_SIZE,
  ARP_SWEEP_MAX_TARGETS,
} from "../../src/services/arpPrimeService.js";

describe("planSweepBatches", () => {
  it("dedupes and preserves first-seen order", () => {
    const { batches, targets, dropped } = planSweepBatches([
      "10.0.0.1", "10.0.0.2", "10.0.0.1", " 10.0.0.3 ", "10.0.0.2",
    ]);
    expect(batches).toEqual([["10.0.0.1", "10.0.0.2", "10.0.0.3"]]);
    expect(targets).toBe(3);
    expect(dropped).toBe(0);
  });

  it("silently skips malformed / non-IPv4 entries (they were never sweepable)", () => {
    const { batches, targets } = planSweepBatches([
      "10.0.0.1",
      "",                    // empty
      "not-an-ip",
      "10.0.0.999",          // octet out of range
      "10.0.0",              // too short
      "2001:db8::1",         // IPv6 — reservations under stale detection are v4
      "10.0.0.2/24",         // CIDR, not a host
    ]);
    expect(batches).toEqual([["10.0.0.1"]]);
    expect(targets).toBe(1);
  });

  it("chunks into pacing batches of the configured size", () => {
    const ips = Array.from({ length: ARP_SWEEP_BATCH_SIZE * 2 + 5 }, (_, i) => `10.${Math.floor(i / 65536) % 256}.${Math.floor(i / 256) % 256}.${i % 256}`);
    const { batches, targets } = planSweepBatches(ips);
    expect(targets).toBe(ips.length);
    expect(batches.length).toBe(3);
    expect(batches[0].length).toBe(ARP_SWEEP_BATCH_SIZE);
    expect(batches[1].length).toBe(ARP_SWEEP_BATCH_SIZE);
    expect(batches[2].length).toBe(5);
  });

  it("caps at maxTargets and reports the overflow as dropped (never silent)", () => {
    const ips = Array.from({ length: 30 }, (_, i) => `10.0.0.${i + 1}`);
    const { batches, targets, dropped } = planSweepBatches(ips, 8, 20);
    expect(targets).toBe(20);
    expect(dropped).toBe(10);
    expect(batches.flat().length).toBe(20);
  });

  it("returns no batches for an empty / all-invalid list", () => {
    expect(planSweepBatches([]).batches).toEqual([]);
    expect(planSweepBatches(["nope", ""]).batches).toEqual([]);
  });

  it("default cap matches the exported constant", () => {
    // Pin the planner's default so an accidental cap change shows up in review.
    const ips = Array.from({ length: ARP_SWEEP_MAX_TARGETS + 1 }, (_, i) => `10.${Math.floor(i / 65536) % 256}.${Math.floor(i / 256) % 256}.${i % 256}`);
    const { targets, dropped } = planSweepBatches(ips);
    expect(targets).toBe(ARP_SWEEP_MAX_TARGETS);
    expect(dropped).toBe(1);
  });
});

describe("primeArpCache", () => {
  it("sends to loopback targets without throwing and reports the count", async () => {
    // Loopback delivery needs no listener — UDP send succeeds (or at worst
    // errors into the swallowed per-datagram callback). Either way the
    // contract is: resolves, sent === planned targets, never throws.
    const { sent, dropped } = await primeArpCache(["127.0.0.1", "127.0.0.1", "127.0.0.2", "bogus"]);
    expect(sent).toBe(2); // deduped, malformed skipped
    expect(dropped).toBe(0);
  });

  it("no-ops cleanly on an empty target list", async () => {
    const { sent, dropped } = await primeArpCache([]);
    expect(sent).toBe(0);
    expect(dropped).toBe(0);
  });
});
