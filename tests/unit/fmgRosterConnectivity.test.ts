/**
 * tests/unit/fmgRosterConnectivity.test.ts
 *
 * extractRosterConnectivity — the reachability half of the FMG device roster,
 * backing the "fortimanager" polling method. Pure: takes the raw
 * /dvmdb/adom/<adom>/device payload, returns per-chassis status.
 *
 * The two encodings it reads (`conn_status` at the top level,
 * `ha_slave[].status` per member) are pinned here because getting either
 * inverted would mass-down a fleet, and because the ha_slave meaning is
 * flagged verify-on-real-FMG where it is first read.
 */

import { describe, it, expect } from "vitest";
import { extractRosterConnectivity } from "../../src/services/fortimanagerService.js";

describe("extractRosterConnectivity — top-level conn_status", () => {
  it("1 is connected", () => {
    const out = extractRosterConnectivity([{ name: "GATE-1", sn: "FG100F0000000001", conn_status: 1 }]);
    expect(out).toHaveLength(1);
    expect(out[0].connected).toBe(true);
    expect(out[0].serial).toBe("FG100F0000000001");
    expect(out[0].haMember).toBe(false);
  });

  it("anything else is disconnected, and the raw value is preserved for the error", () => {
    const out = extractRosterConnectivity([{ name: "GATE-1", sn: "sn1", conn_status: 0 }]);
    expect(out[0].connected).toBe(false);
    expect(out[0].raw).toContain("0");
  });

  // "Unknown is not down." Discovery's own offline test is
  // `conn_status !== undefined && conn_status !== 1`, i.e. an absent field
  // means online. Diverging here would let an FMG that stopped reporting the
  // field mark every gate in the fleet down at the same instant.
  it("an absent conn_status counts as connected", () => {
    for (const row of [{ name: "G", sn: "s1" }, { name: "G", sn: "s1", conn_status: null }]) {
      const out = extractRosterConnectivity([row]);
      expect(out[0].connected, JSON.stringify(row)).toBe(true);
      expect(out[0].raw).toBe("unreported");
    }
  });

  // Every Fortinet serial join in the codebase folds case on both sides.
  it("upper-cases the serial", () => {
    expect(extractRosterConnectivity([{ sn: "fg100f0000000001", conn_status: 1 }])[0].serial)
      .toBe("FG100F0000000001");
  });

  it("skips rows with no serial — there is nothing to join on", () => {
    expect(extractRosterConnectivity([{ name: "no-serial", conn_status: 1 }])).toHaveLength(0);
    expect(extractRosterConnectivity([{ name: "blank", sn: "   ", conn_status: 1 }])).toHaveLength(0);
  });
});

describe("extractRosterConnectivity — HA members", () => {
  // A standby never appears at the top level; its identity and its state live
  // only inside ha_slave[]. This is the whole reason the walk descends.
  it("emits a row per ha_slave member, flagged as such", () => {
    const out = extractRosterConnectivity([{
      name: "CLUSTER-1",
      sn: "PRIMARY1",
      conn_status: 1,
      ha_slave: [
        { name: "CLUSTER-1", sn: "PRIMARY1", status: 1 },
        { name: "CLUSTER-1-standby", sn: "STANDBY1", status: 1 },
      ],
    }]);
    const standby = out.find((r) => r.serial === "STANDBY1");
    expect(standby).toBeDefined();
    expect(standby!.connected).toBe(true);
    expect(standby!.haMember).toBe(true);
  });

  it("status 0 is a down member", () => {
    const out = extractRosterConnectivity([{
      sn: "PRIMARY1",
      conn_status: 1,
      ha_slave: [{ name: "standby", sn: "STANDBY1", status: 0 }],
    }]);
    const standby = out.find((r) => r.serial === "STANDBY1")!;
    expect(standby.connected).toBe(false);
    expect(standby.raw).toContain("ha_slave.status");
  });

  it("an absent member status counts as connected, same as the top level", () => {
    const out = extractRosterConnectivity([{
      sn: "P", conn_status: 1, ha_slave: [{ name: "s", sn: "S" }],
    }]);
    expect(out.find((r) => r.serial === "S")!.connected).toBe(true);
  });

  // The primary is listed twice — top level and inside ha_slave[]. Both rows
  // are emitted; de-duplication (preferring the ha_slave row, which is the
  // per-member one) is the caller's job in the warm cache.
  it("emits the primary from both places rather than guessing", () => {
    const out = extractRosterConnectivity([{
      sn: "P1", conn_status: 1, ha_slave: [{ name: "p", sn: "P1", status: 1 }],
    }]);
    expect(out.filter((r) => r.serial === "P1")).toHaveLength(2);
    expect(out.filter((r) => r.serial === "P1" && r.haMember)).toHaveLength(1);
  });
});

describe("extractRosterConnectivity — malformed input", () => {
  it("tolerates a non-array, an empty array, and junk rows", () => {
    expect(extractRosterConnectivity(undefined as any)).toEqual([]);
    expect(extractRosterConnectivity(null as any)).toEqual([]);
    expect(extractRosterConnectivity([])).toEqual([]);
    expect(extractRosterConnectivity([null, 42, "x"] as any)).toEqual([]);
  });

  it("tolerates ha_slave being absent or not an array", () => {
    expect(extractRosterConnectivity([{ sn: "s", conn_status: 1, ha_slave: "nope" } as any])).toHaveLength(1);
  });
});
