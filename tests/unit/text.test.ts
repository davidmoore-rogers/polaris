/**
 * tests/unit/text.test.ts — shared string/param helpers
 */

import { describe, it, expect } from "vitest";
import { truncate, csvParam } from "../../src/utils/text.js";

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("", 10)).toBe("");
  });

  it("appends an ellipsis past max", () => {
    expect(truncate("abcdef", 3)).toBe("abc…");
  });

  it("defaults max to 200", () => {
    const long = "x".repeat(250);
    expect(truncate(long)).toBe("x".repeat(200) + "…");
    expect(truncate("x".repeat(200))).toBe("x".repeat(200));
  });
});

describe("csvParam", () => {
  it("splits, trims, and drops empty segments", () => {
    expect(csvParam("a, b ,,c")).toEqual(["a", "b", "c"]);
  });

  it("returns undefined for absent / blank / non-string input", () => {
    expect(csvParam(undefined)).toBeUndefined();
    expect(csvParam("")).toBeUndefined();
    expect(csvParam("   ")).toBeUndefined();
    expect(csvParam(",,,")).toBeUndefined();
    expect(csvParam(42)).toBeUndefined();
  });
});
