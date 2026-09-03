/**
 * tests/unit/assetUpstream.test.ts
 *
 * The pure half of the upstream-device resolver: splitting a `lastSeenSwitch`
 * value into the device name the asset page makes clickable and the port half
 * it leaves as text. The resolution itself needs a database and is covered by
 * tests/integration/assetUpstream.test.ts.
 */

import { describe, it, expect } from "vitest";
import { splitLastSeenSwitch } from "../../src/services/assetUpstreamService.js";

describe("splitLastSeenSwitch", () => {
  it("splits the stored '<switch>/<port>' shape", () => {
    expect(splitLastSeenSwitch("FS-248E-01/port15")).toEqual({ name: "FS-248E-01", port: "port15" });
  });
  it("accepts a bare switch name with no port", () => {
    expect(splitLastSeenSwitch("S248EPTF1234567")).toEqual({ name: "S248EPTF1234567", port: "" });
  });
  it("keeps a port name containing a slash intact", () => {
    // Only the FIRST slash separates; a FortiSwitch port can carry more.
    expect(splitLastSeenSwitch("SW-1/port1/1")).toEqual({ name: "SW-1", port: "port1/1" });
  });
  it("trims both halves", () => {
    expect(splitLastSeenSwitch("  SW-1 / port3 ")).toEqual({ name: "SW-1", port: "port3" });
  });
  it("null for empty / missing / a value with no device name", () => {
    expect(splitLastSeenSwitch(null)).toBeNull();
    expect(splitLastSeenSwitch(undefined)).toBeNull();
    expect(splitLastSeenSwitch("   ")).toBeNull();
    expect(splitLastSeenSwitch("/port9")).toBeNull();
  });
});
