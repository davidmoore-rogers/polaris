/**
 * tests/unit/fortiapRadioBand.test.ts
 */

import { describe, it, expect } from "vitest";
import { deriveRadioBand, is6GhzRadioType } from "../../src/utils/fortiapRadioBand.js";

describe("deriveRadioBand", () => {
  it("maps 2.4 GHz channels (1-14)", () => {
    expect(deriveRadioBand(null, 1)).toBe("2.4GHz");
    expect(deriveRadioBand(null, 6)).toBe("2.4GHz");
    expect(deriveRadioBand(null, 11)).toBe("2.4GHz");
    expect(deriveRadioBand(null, 14)).toBe("2.4GHz");
  });

  it("maps 5 GHz channels (32-177)", () => {
    expect(deriveRadioBand(null, 36)).toBe("5GHz");
    expect(deriveRadioBand(null, 48)).toBe("5GHz");
    expect(deriveRadioBand(null, 100)).toBe("5GHz");
    expect(deriveRadioBand(null, 149)).toBe("5GHz");
    expect(deriveRadioBand(null, 165)).toBe("5GHz");
    expect(deriveRadioBand(null, 177)).toBe("5GHz");
  });

  it("maps clearly-6 GHz extended channels (>177)", () => {
    expect(deriveRadioBand(null, 181)).toBe("6GHz");
    expect(deriveRadioBand(null, 197)).toBe("6GHz");
    expect(deriveRadioBand(null, 233)).toBe("6GHz");
  });

  it("uses the radio-type hint to resolve 6 GHz on low/overlapping channels", () => {
    // A 6E radio parked on channel 5 must not be mislabeled 2.4 GHz.
    expect(deriveRadioBand("802.11ax-6E", 5)).toBe("6GHz");
    expect(deriveRadioBand("11ax6e", 1)).toBe("6GHz");
    // 6E radio on a channel that also exists in 5 GHz numbering.
    expect(deriveRadioBand("6GHz", 37)).toBe("6GHz");
  });

  it("falls back to the type hint when channel is unknown", () => {
    expect(deriveRadioBand("802.11ax-6E", null)).toBe("6GHz");
    expect(deriveRadioBand(null, null)).toBeNull();
    expect(deriveRadioBand("802.11ac", null)).toBeNull();
  });

  it("returns null for out-of-plan / missing channels with no 6E hint", () => {
    expect(deriveRadioBand(null, undefined)).toBeNull();
    expect(deriveRadioBand(null, 0)).toBeNull();
    expect(deriveRadioBand(null, 20)).toBeNull();
    expect(deriveRadioBand(null, NaN)).toBeNull();
  });

  it("does not treat non-6 radio types as 6 GHz on a 2.4 GHz channel", () => {
    expect(deriveRadioBand("802.11n", 6)).toBe("2.4GHz");
    expect(deriveRadioBand("802.11ax", 11)).toBe("2.4GHz");
  });
});

describe("is6GhzRadioType", () => {
  it("detects 6 GHz indicators", () => {
    expect(is6GhzRadioType("6e")).toBe(true);
    expect(is6GhzRadioType("802.11ax-6E")).toBe(true);
    expect(is6GhzRadioType("6GHz")).toBe(true);
    expect(is6GhzRadioType("11ax6e")).toBe(true);
  });

  it("rejects non-6 GHz types, bare numbers, and nullish input", () => {
    expect(is6GhzRadioType("802.11ac")).toBe(false);
    expect(is6GhzRadioType("802.11n")).toBe(false);
    expect(is6GhzRadioType(6)).toBe(false); // bare numeric enum value, not a 6 GHz hint
    expect(is6GhzRadioType("5GHz")).toBe(false);
    expect(is6GhzRadioType(null)).toBe(false);
    expect(is6GhzRadioType(undefined)).toBe(false);
  });
});
