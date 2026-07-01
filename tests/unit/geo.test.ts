/**
 * tests/unit/geo.test.ts
 */

import { describe, it, expect } from "vitest";
import { manualCoordPatchError, pointInPolygon } from "../../src/utils/geo.js";

// Square covering Atlanta-ish: roughly (33.5,-84.7) → (34.0,-84.2)
const SQUARE: [number, number][] = [
  [33.5, -84.7],
  [33.5, -84.2],
  [34.0, -84.2],
  [34.0, -84.7],
];

describe("pointInPolygon", () => {
  it("rejects polygons with fewer than 3 vertices", () => {
    expect(pointInPolygon([0, 0], [])).toBe(false);
    expect(pointInPolygon([0, 0], [[0, 0]])).toBe(false);
    expect(pointInPolygon([0, 0], [[0, 0], [1, 1]])).toBe(false);
  });

  it("returns true for a point clearly inside the polygon", () => {
    expect(pointInPolygon([33.75, -84.45], SQUARE)).toBe(true);
  });

  it("returns false for a point clearly outside the polygon", () => {
    expect(pointInPolygon([35.0, -85.0], SQUARE)).toBe(false);
    expect(pointInPolygon([0, 0], SQUARE)).toBe(false);
  });

  it("handles a closed ring (first vertex repeated at the end) the same as an open ring", () => {
    const closed: [number, number][] = [...SQUARE, SQUARE[0]!];
    expect(pointInPolygon([33.75, -84.45], closed)).toBe(true);
    expect(pointInPolygon([35.0, -85.0], closed)).toBe(false);
  });

  it("handles non-convex polygons via ray casting", () => {
    // Concave "C" shape opening to the right
    const C: [number, number][] = [
      [0, 0],
      [0, 4],
      [3, 4],
      [3, 3],
      [1, 3],
      [1, 1],
      [3, 1],
      [3, 0],
    ];
    // (2, 2) is in the open mouth of the C → outside
    expect(pointInPolygon([2, 2], C)).toBe(false);
    // (0.5, 2) is on the back wall → inside
    expect(pointInPolygon([0.5, 2], C)).toBe(true);
  });
});

describe("manualCoordPatchError", () => {
  it("accepts both omitted (no change)", () => {
    expect(manualCoordPatchError(undefined, undefined)).toBeNull();
  });

  it("accepts both null (clear)", () => {
    expect(manualCoordPatchError(null, null)).toBeNull();
  });

  it("accepts a valid pair", () => {
    expect(manualCoordPatchError(36.1627, -86.7816)).toBeNull();
    expect(manualCoordPatchError(-90, 180)).toBeNull();
  });

  it("rejects one provided without the other", () => {
    expect(manualCoordPatchError(36.16, undefined)).toMatch(/together/);
    expect(manualCoordPatchError(undefined, -86.78)).toMatch(/together/);
  });

  it("rejects one set with the other cleared", () => {
    expect(manualCoordPatchError(36.16, null)).toMatch(/both/);
    expect(manualCoordPatchError(null, -86.78)).toMatch(/both/);
  });

  it("rejects out-of-range values", () => {
    expect(manualCoordPatchError(91, 0)).toMatch(/decimal degrees/);
    expect(manualCoordPatchError(-91, 0)).toMatch(/decimal degrees/);
    expect(manualCoordPatchError(0, 181)).toMatch(/decimal degrees/);
    expect(manualCoordPatchError(0, -181)).toMatch(/decimal degrees/);
  });

  it("rejects the (0,0) unset sentinel", () => {
    expect(manualCoordPatchError(0, 0)).toMatch(/decimal degrees/);
  });

  it("rejects non-finite numbers", () => {
    expect(manualCoordPatchError(NaN, 10)).toMatch(/decimal degrees/);
    expect(manualCoordPatchError(10, Infinity)).toMatch(/decimal degrees/);
  });
});
