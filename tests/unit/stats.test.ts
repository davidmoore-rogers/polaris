import { describe, it, expect } from "vitest";
import { median } from "../../src/utils/stats.js";

describe("median", () => {
  it("returns null for an empty set (no reading, not zero)", () => {
    expect(median([])).toBeNull();
  });

  it("returns the middle value for an odd-length set", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("averages the two middle values for an even-length set", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("ignores input order", () => {
    expect(median([90, 10, 11, 12, 13])).toBe(12);
  });

  it("does not mutate the caller's array", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it("is unmoved by an outlier that would drag the average", () => {
    // The point of offering median alongside avg: one 100% spike in a window
    // of quiet samples must not make the window look loaded.
    expect(median([2, 3, 4, 3, 100])).toBe(3);
  });

  it("handles a single sample and negatives", () => {
    expect(median([7])).toBe(7);
    expect(median([-5, -1, -3])).toBe(-3);
  });
});
