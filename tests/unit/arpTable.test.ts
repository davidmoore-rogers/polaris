/**
 * tests/unit/arpTable.test.ts — pure shaping of a FortiGate's ARP table before
 * it lands in `asset_arp_entries`.
 */

import { describe, it, expect } from "vitest";
import {
  prepareArpRows,
  groupArpRowsByDevice,
  arpRowKey,
  compareArpRows,
  ARP_ROWS_PER_ASSET_CAP,
} from "../../src/utils/arpTable.js";

const row = (ip: string, mac: string, iface = "internal1", age?: number) => ({ ip, mac, interface: iface, age });

describe("prepareArpRows", () => {
  it("normalizes the MAC to colon-uppercase", () => {
    const { entries } = prepareArpRows([row("10.0.0.1", "aa-bb-cc-dd-ee-ff")]);
    expect(entries[0].macAddress).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("stores an empty interface as NULL rather than a port named the empty string", () => {
    const { entries } = prepareArpRows([row("10.0.0.1", "AA:BB:CC:DD:EE:01", "")]);
    expect(entries[0].ifName).toBeNull();
  });

  it("drops rows missing an IP or a MAC", () => {
    const { entries } = prepareArpRows([
      row("", "AA:BB:CC:DD:EE:01"),
      row("10.0.0.2", ""),
      row("10.0.0.3", "AA:BB:CC:DD:EE:03"),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].ipAddress).toBe("10.0.0.3");
  });

  it("keeps the freshest row when the same binding is reported twice", () => {
    const { entries } = prepareArpRows([
      row("10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1", 300),
      row("10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1", 12),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].ageSec).toBe(12);
  });

  it("prefers a row that reports an age over one that does not", () => {
    const withAge = prepareArpRows([
      row("10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1", undefined),
      row("10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1", 90),
    ]);
    expect(withAge.entries[0].ageSec).toBe(90);
    // ...and the reverse arrival order reaches the same answer.
    const reversed = prepareArpRows([
      row("10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1", 90),
      row("10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1", undefined),
    ]);
    expect(reversed.entries[0].ageSec).toBe(90);
  });

  it("keeps the same IP+MAC seen on two interfaces as two rows", () => {
    const { entries } = prepareArpRows([
      row("10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1"),
      row("10.0.0.1", "AA:BB:CC:DD:EE:01", "internal2"),
    ]);
    expect(entries).toHaveLength(2);
  });

  it("keeps two MACs claiming one IP — a duplicate-address finding, not a dedupe", () => {
    const { entries } = prepareArpRows([
      row("10.0.0.1", "AA:BB:CC:DD:EE:01"),
      row("10.0.0.1", "AA:BB:CC:DD:EE:02"),
    ]);
    expect(entries).toHaveLength(2);
  });

  it("stores a missing age as null, never zero", () => {
    const { entries } = prepareArpRows([row("10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1", undefined)]);
    expect(entries[0].ageSec).toBeNull();
  });
});

describe("prepareArpRows ordering + cap", () => {
  it("orders by interface, then numerically by IP", () => {
    const { entries } = prepareArpRows([
      row("10.0.0.10", "AA:BB:CC:DD:EE:0A", "internal2"),
      row("10.0.0.2",  "AA:BB:CC:DD:EE:02", "internal2"),
      row("10.0.0.1",  "AA:BB:CC:DD:EE:01", "internal1"),
    ]);
    expect(entries.map((e) => `${e.ifName}/${e.ipAddress}`)).toEqual([
      "internal1/10.0.0.1",
      "internal2/10.0.0.2",
      "internal2/10.0.0.10",
    ]);
  });

  it("sorts unattributed rows last", () => {
    const { entries } = prepareArpRows([
      row("10.0.0.9", "AA:BB:CC:DD:EE:09", ""),
      row("10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1"),
    ]);
    expect(entries[0].ifName).toBe("internal1");
    expect(entries[1].ifName).toBeNull();
  });

  it("caps deterministically and reports what it dropped", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      row(`10.0.0.${i + 1}`, `AA:BB:CC:DD:EE:0${i + 1}`),
    );
    const { entries, truncated } = prepareArpRows(many, 3);
    expect(entries).toHaveLength(3);
    expect(truncated).toBe(2);
    expect(entries.map((e) => e.ipAddress)).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
  });

  it("reports zero truncation when the table fits", () => {
    const { truncated } = prepareArpRows([row("10.0.0.1", "AA:BB:CC:DD:EE:01")], 3);
    expect(truncated).toBe(0);
  });

  it("ships a cap comfortably above a large site's gate", () => {
    expect(ARP_ROWS_PER_ASSET_CAP).toBeGreaterThanOrEqual(1000);
  });

  it("returns nothing for an empty table without throwing", () => {
    expect(prepareArpRows([])).toEqual({ entries: [], truncated: 0 });
  });
});

describe("arpRowKey", () => {
  it("folds a null interface to the empty string so the key is total", () => {
    expect(arpRowKey({ ipAddress: "10.0.0.1", macAddress: "AA:BB:CC:DD:EE:01", ifName: null }))
      .toBe("10.0.0.1|AA:BB:CC:DD:EE:01|");
  });

  it("distinguishes the same binding on two interfaces", () => {
    const a = arpRowKey({ ipAddress: "10.0.0.1", macAddress: "AA:BB:CC:DD:EE:01", ifName: "internal1" });
    const b = arpRowKey({ ipAddress: "10.0.0.1", macAddress: "AA:BB:CC:DD:EE:01", ifName: "internal2" });
    expect(a).not.toBe(b);
  });
});

describe("compareArpRows", () => {
  it("breaks an IP tie on the MAC, so two claimants order stably", () => {
    const a = { ipAddress: "10.0.0.1", macAddress: "AA:BB:CC:DD:EE:02", ifName: "internal1", ageSec: null };
    const b = { ipAddress: "10.0.0.1", macAddress: "AA:BB:CC:DD:EE:01", ifName: "internal1", ageSec: null };
    expect(compareArpRows(a, b)).toBeGreaterThan(0);
  });
});

describe("groupArpRowsByDevice", () => {
  it("buckets by the lowercased device name", () => {
    const grouped = groupArpRowsByDevice([
      { fortigateDevice: "FGT-A", ip: "10.0.0.1" },
      { fortigateDevice: "fgt-a", ip: "10.0.0.2" },
      { fortigateDevice: "FGT-B", ip: "10.0.0.3" },
    ]);
    expect([...grouped.keys()].sort()).toEqual(["fgt-a", "fgt-b"]);
    expect(grouped.get("fgt-a")).toHaveLength(2);
  });

  it("drops rows that name no device rather than inventing a bucket", () => {
    const grouped = groupArpRowsByDevice([
      { fortigateDevice: "", ip: "10.0.0.1" },
      { ip: "10.0.0.2" } as { fortigateDevice?: string },
    ]);
    expect(grouped.size).toBe(0);
  });
});
