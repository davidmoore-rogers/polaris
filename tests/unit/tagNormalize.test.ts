/**
 * tests/unit/tagNormalize.test.ts
 */

import { describe, it, expect } from "vitest";
import { normalizeTags, unionTags, TAG_MAX_LEN } from "../../src/utils/tagNormalize.js";
import { AppError } from "../../src/utils/errors.js";

describe("normalizeTags", () => {
  it("trims, drops empties, and dedupes case-insensitively (first casing wins)", () => {
    expect(normalizeTags(["  East ", "east", "WEST", "", "  "])).toEqual(["East", "WEST"]);
  });

  it("returns [] for non-array input", () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags("east")).toEqual([]);
  });

  it("skips non-string entries", () => {
    expect(normalizeTags(["ok", 5, {}, true, "two"] as unknown)).toEqual(["ok", "two"]);
  });

  it("throws AppError when a tag exceeds the length cap", () => {
    const long = "x".repeat(TAG_MAX_LEN + 1);
    expect(() => normalizeTags([long], "region tag")).toThrowError(AppError);
    expect(() => normalizeTags([long], "region tag")).toThrowError(/Region tag/);
  });

  it("throws AppError when there are too many tags", () => {
    const many = Array.from({ length: 65 }, (_, i) => `t${i}`);
    expect(() => normalizeTags(many)).toThrowError(/At most 64/);
  });
});

describe("unionTags", () => {
  it("unions multiple lists, dedupes case-insensitively (first casing wins), and sorts", () => {
    // "east" first appears lowercase (in list 1), so it wins over "EAST".
    expect(unionTags(["West", "east"], ["EAST", "north"], null, undefined)).toEqual(["east", "north", "West"]);
  });

  it("first-seen casing wins across lists", () => {
    expect(unionTags(["Prod"], ["prod"])).toEqual(["Prod"]);
  });

  it("ignores blanks and non-strings", () => {
    expect(unionTags(["  ", "ok"], [3 as unknown as string])).toEqual(["ok"]);
  });
});
