/**
 * tests/unit/chunk.test.ts
 */

import { describe, it, expect } from "vitest";
import { chunkArray } from "../../src/utils/chunk.js";

describe("chunkArray", () => {
  it("splits into consecutive chunks with a short tail", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns one chunk when size >= length, and [] for empty input", () => {
    expect(chunkArray([1, 2], 10)).toEqual([[1, 2]]);
    expect(chunkArray([], 3)).toEqual([]);
  });

  it("size 1 yields singletons", () => {
    expect(chunkArray(["a", "b"], 1)).toEqual([["a"], ["b"]]);
  });

  it("rejects a non-positive or non-finite size", () => {
    expect(() => chunkArray([1], 0)).toThrow(RangeError);
    expect(() => chunkArray([1], -2)).toThrow(RangeError);
    expect(() => chunkArray([1], NaN)).toThrow(RangeError);
  });

  it("covers every element exactly once", () => {
    const xs = Array.from({ length: 23 }, (_, i) => i);
    expect(chunkArray(xs, 5).flat()).toEqual(xs);
  });
});
