/**
 * tests/unit/normalizeMac.test.ts — global-search MAC normalization
 */

import { describe, it, expect } from "vitest";
import { normalizeMac } from "../../src/services/searchService.js";

describe("normalizeMac", () => {
  const CANONICAL = "00:00:00:00:00:00";

  it("accepts colon form", () => {
    expect(normalizeMac("00:00:00:00:00:00")).toBe(CANONICAL);
  });

  it("accepts bare/no-separator form", () => {
    expect(normalizeMac("000000000000")).toBe(CANONICAL);
  });

  it("accepts dash form", () => {
    expect(normalizeMac("00-00-00-00-00-00")).toBe(CANONICAL);
  });

  it("accepts Cisco dotted-quad form", () => {
    expect(normalizeMac("0000.0000.0000")).toBe(CANONICAL);
  });

  it("is case-insensitive and emits an uppercase canonical form", () => {
    expect(normalizeMac("aa:bb:cc:dd:ee:ff")).toBe("AA:BB:CC:DD:EE:FF");
    expect(normalizeMac("AaBbCcDdEeFf")).toBe("AA:BB:CC:DD:EE:FF");
    expect(normalizeMac("aabb.ccdd.eeff")).toBe("AA:BB:CC:DD:EE:FF");
    expect(normalizeMac("aa-bb-cc-dd-ee-ff")).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("tolerates surrounding whitespace", () => {
    expect(normalizeMac("  aa:bb:cc:dd:ee:ff  ")).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("rejects non-MAC input", () => {
    expect(normalizeMac("hello")).toBeNull();
    expect(normalizeMac("00:00:00:00:00")).toBeNull(); // too short (10 hex)
    expect(normalizeMac("00:00:00:00:00:00:00")).toBeNull(); // too long (14 hex)
    expect(normalizeMac("zz:zz:zz:zz:zz:zz")).toBeNull(); // non-hex
    expect(normalizeMac("10.1.1.1")).toBeNull();
  });
});
