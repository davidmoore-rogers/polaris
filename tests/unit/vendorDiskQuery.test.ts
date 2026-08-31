/**
 * tests/unit/vendorDiskQuery.test.ts — `diskQueryFromMetricPick`,
 * `diskQueryToDoubleScalar` and `deriveDiskBytes`
 * (src/services/vendorTelemetryProfiles.ts).
 *
 * These three are the seam that makes the Manufacturer Profile's **Storage**
 * row load-bearing. Before 2026-08 `pickVendorProfileMerged` plucked only the
 * cpu / memory / temperature rows, so the storage row rendered on the profile
 * page, validated on save, seeded correctly — and was read by nothing. An
 * operator pointing it at different OIDs saw no change and no error, because
 * the collector consulted the hardcoded constant instead. The seeded row
 * happened to match that constant, which is exactly why nobody noticed.
 *
 * What's pinned, and why each is a decision rather than an implementation
 * detail:
 *
 *  - **The combiner names roles; it is not arithmetic.** A StorageSample
 *    carries the used/total byte pair and every reader (the table's Used %, the
 *    forecast, a threshold automation) derives its own percent. So
 *    `a_over_b_as_percent` means "A is used, B is total" — collapsing the pair
 *    to the percent the combiner describes would leave the table with a
 *    percentage and no bytes to render.
 *  - **A row that can't produce a pair returns null, not a guess.** A `scalar`
 *    row is a lone percentage with no total; a `table` row is
 *    HOST-RESOURCES-MIB's job and runs first anyway. Null leaves the hardcoded
 *    baseline in place, which is what keeps a half-finished operator edit from
 *    costing an install its storage collection.
 *  - **Both outputs derive from the RAW readings, never from each other.**
 *    Chaining them would let one fabricated value feed the next, so a device
 *    that answered only `free` would report a used and a total both invented
 *    from it.
 *  - **A negative used clamps to null.** Some agents transiently report free
 *    larger than total across a filesystem resize; a below-zero bar is worse
 *    than a missing one.
 *  - **The round trip holds.** `diskQueryToDoubleScalar` is what the seed job
 *    stamps and `diskQueryFromMetricPick` is what the collector reads back, so
 *    a hardcoded profile must survive the trip unchanged — otherwise seeding an
 *    install would silently change which OIDs it walks.
 */

import { describe, it, expect } from "vitest";
import {
  diskQueryFromMetricPick,
  diskQueryToDoubleScalar,
  deriveDiskBytes,
  VENDOR_TELEMETRY_PROFILES,
} from "../../src/services/vendorTelemetryProfiles.js";

const dbl = (symbol: string, symbolB: string, transform: string) =>
  ({ type: "double_scalar" as const, symbol, symbolB, transform });

describe("diskQueryFromMetricPick", () => {
  it("reads a_over_b_as_percent as used + total", () => {
    expect(diskQueryFromMetricPick(dbl("fsSysDiskUsage", "fsSysDiskCapacity", "a_over_b_as_percent")))
      .toEqual({ usedBytesSymbol: "fsSysDiskUsage", totalBytesSymbol: "fsSysDiskCapacity" });
  });

  it("reads a_over_b_ratio the same way — the same two roles, a different scale", () => {
    expect(diskQueryFromMetricPick(dbl("used", "total", "a_over_b_ratio")))
      .toEqual({ usedBytesSymbol: "used", totalBytesSymbol: "total" });
  });

  it("reads a_over_a_plus_b_as_percent as used + free", () => {
    expect(diskQueryFromMetricPick(dbl("used", "free", "a_over_a_plus_b_as_percent")))
      .toEqual({ usedBytesSymbol: "used", freeBytesSymbol: "free" });
  });

  it("reads a_plus_b as used + free", () => {
    expect(diskQueryFromMetricPick(dbl("used", "free", "a_plus_b")))
      .toEqual({ usedBytesSymbol: "used", freeBytesSymbol: "free" });
  });

  it("reads b_minus_a_over_b_as_percent as free + total (A is the free half)", () => {
    expect(diskQueryFromMetricPick(dbl("free", "total", "b_minus_a_over_b_as_percent")))
      .toEqual({ freeBytesSymbol: "free", totalBytesSymbol: "total" });
  });

  it("reads a_minus_b as total + free", () => {
    expect(diskQueryFromMetricPick(dbl("total", "free", "a_minus_b")))
      .toEqual({ totalBytesSymbol: "total", freeBytesSymbol: "free" });
  });

  it("carries the base profile's mountPath through, since the row has no such field", () => {
    expect(diskQueryFromMetricPick(dbl("used", "total", "a_over_b_as_percent"), "flash"))
      .toEqual({ mountPath: "flash", usedBytesSymbol: "used", totalBytesSymbol: "total" });
  });

  it("refuses a scalar row — one percentage is not a used/total pair", () => {
    expect(diskQueryFromMetricPick({ type: "scalar", symbol: "diskPct", symbolB: null, transform: null }))
      .toBeNull();
  });

  it("refuses a table row — hrStorageTable is the table path and runs first", () => {
    expect(diskQueryFromMetricPick({ type: "table", symbol: "hrStorageUsed", symbolB: null, transform: null }))
      .toBeNull();
  });

  it("refuses a half-filled row rather than dialing one OID", () => {
    expect(diskQueryFromMetricPick({ type: "double_scalar", symbol: "used", symbolB: null, transform: "a_over_b_as_percent" })).toBeNull();
    expect(diskQueryFromMetricPick({ type: "double_scalar", symbol: null, symbolB: "total", transform: "a_over_b_as_percent" })).toBeNull();
  });

  it("refuses a combiner with no role mapping, and a missing one", () => {
    expect(diskQueryFromMetricPick(dbl("a", "b", "signed_to_unsigned"))).toBeNull();
    expect(diskQueryFromMetricPick({ type: "double_scalar", symbol: "a", symbolB: "b", transform: null })).toBeNull();
  });
});

describe("deriveDiskBytes", () => {
  it("passes a stated used + total straight through", () => {
    expect(deriveDiskBytes({ used: 400, total: 1000 })).toEqual({ usedBytes: 400, totalBytes: 1000 });
  });

  it("completes total from used + free", () => {
    expect(deriveDiskBytes({ used: 400, free: 600 })).toEqual({ usedBytes: 400, totalBytes: 1000 });
  });

  it("completes used from total - free", () => {
    expect(deriveDiskBytes({ total: 1000, free: 600 })).toEqual({ usedBytes: 400, totalBytes: 1000 });
  });

  it("derives each output from the raw readings, never from the other", () => {
    // Only `free` answered. Neither half may be invented from it.
    expect(deriveDiskBytes({ free: 600 })).toEqual({ usedBytes: null, totalBytes: null });
  });

  it("keeps a stated zero — a full flash and an empty one are both readings", () => {
    expect(deriveDiskBytes({ used: 0, total: 1000 })).toEqual({ usedBytes: 0, totalBytes: 1000 });
    expect(deriveDiskBytes({ used: 1000, free: 0 })).toEqual({ usedBytes: 1000, totalBytes: 1000 });
  });

  it("clamps a negative used to null rather than charting a below-zero bar", () => {
    expect(deriveDiskBytes({ total: 500, free: 900 })).toEqual({ usedBytes: null, totalBytes: 500 });
  });

  it("treats a non-finite reading as absent", () => {
    expect(deriveDiskBytes({ used: Number.NaN, total: 1000 })).toEqual({ usedBytes: null, totalBytes: 1000 });
  });

  it("reports nothing when nothing answered", () => {
    expect(deriveDiskBytes({})).toEqual({ usedBytes: null, totalBytes: null });
  });
});

describe("diskQueryToDoubleScalar", () => {
  it("expresses used + total as the combiner the collector reads back", () => {
    expect(diskQueryToDoubleScalar({ usedBytesSymbol: "u", totalBytesSymbol: "t" }))
      .toEqual({ type: "double_scalar", symbol: "u", symbolB: "t", transform: "a_over_b_as_percent" });
  });

  it("expresses used + free and total + free", () => {
    expect(diskQueryToDoubleScalar({ usedBytesSymbol: "u", freeBytesSymbol: "f" })?.transform)
      .toBe("a_over_a_plus_b_as_percent");
    expect(diskQueryToDoubleScalar({ totalBytesSymbol: "t", freeBytesSymbol: "f" })?.transform)
      .toBe("a_minus_b");
  });

  it("has nothing to seed from a block naming fewer than two symbols", () => {
    expect(diskQueryToDoubleScalar({ usedBytesSymbol: "u" })).toBeNull();
    expect(diskQueryToDoubleScalar({})).toBeNull();
    expect(diskQueryToDoubleScalar(undefined)).toBeNull();
  });

  it("round-trips every hardcoded profile's disk block unchanged", () => {
    // The seed stamps one direction and the collector reads the other. A
    // profile that doesn't survive the trip would have an install walking
    // different OIDs than the constant says.
    const withDisk = VENDOR_TELEMETRY_PROFILES.filter((p) => p.disk);
    expect(withDisk.length).toBeGreaterThan(0);
    for (const p of withDisk) {
      const seeded = diskQueryToDoubleScalar(p.disk);
      expect(seeded, p.vendor).not.toBeNull();
      const back = diskQueryFromMetricPick(seeded!, p.disk!.mountPath);
      expect(back, p.vendor).toEqual(p.disk);
    }
  });
});
