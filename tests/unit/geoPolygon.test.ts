/**
 * tests/unit/geoPolygon.test.ts
 *
 * Polygon-vs-polygon primitives behind derived region levels.
 *
 * The load-bearing case is the LAST one in the containment block: a concave
 * parent where every child vertex is inside the ring but a child EDGE cuts
 * across the notch. An all-vertices-inside implementation calls that
 * containment, which would nest a region under a division it is only partly
 * inside — and silently re-tier who gets paged for it.
 */

import { describe, it, expect } from "vitest";
import {
  AREA_EPS_REL,
  bboxContainsBbox,
  bboxesIntersect,
  isSimpleRing,
  makeWorkBudget,
  normalizeRing,
  pointRingPosition,
  polygonAreaAbs,
  polygonBbox,
  polygonContainsPolygon,
  ringsProperlyCross,
  segmentsProperlyCross,
} from "../../src/utils/geoPolygon.js";
import type { LatLng } from "../../src/utils/geo.js";

/** Axis-aligned square, [lat, lng] like everything else in Polaris. */
function square(minLat: number, minLng: number, size: number): LatLng[] {
  return [
    [minLat, minLng],
    [minLat, minLng + size],
    [minLat + size, minLng + size],
    [minLat + size, minLng],
  ];
}

const OUTER = square(33.0, -85.0, 4); // 33..37 lat, -85..-81 lng
const INNER = square(34.0, -84.0, 1); // comfortably inside OUTER

describe("polygonBbox / bbox predicates", () => {
  it("computes the box of a ring", () => {
    expect(polygonBbox(INNER)).toEqual({ minLat: 34, minLng: -84, maxLat: 35, maxLng: -83 });
  });

  it("returns an empty box for an empty ring rather than throwing", () => {
    expect(polygonBbox([])).toEqual({ minLat: 0, minLng: 0, maxLat: 0, maxLng: 0 });
  });

  it("bboxContainsBbox is true for enclosure and for an identical box", () => {
    expect(bboxContainsBbox(polygonBbox(OUTER), polygonBbox(INNER))).toBe(true);
    expect(bboxContainsBbox(polygonBbox(INNER), polygonBbox(INNER))).toBe(true);
    expect(bboxContainsBbox(polygonBbox(INNER), polygonBbox(OUTER))).toBe(false);
  });

  it("bboxesIntersect counts touching boxes as intersecting", () => {
    const a = polygonBbox(square(0, 0, 1));
    const touching = polygonBbox(square(0, 1, 1)); // shares the lng=1 edge
    const apart = polygonBbox(square(0, 5, 1));
    expect(bboxesIntersect(a, touching)).toBe(true);
    expect(bboxesIntersect(a, apart)).toBe(false);
  });
});

describe("normalizeRing", () => {
  it("drops a repeated closing vertex", () => {
    const closed: LatLng[] = [...INNER, INNER[0]!];
    expect(normalizeRing(closed)).toEqual(INNER);
  });

  it("drops consecutive duplicate vertices", () => {
    const dup: LatLng[] = [INNER[0]!, INNER[0]!, INNER[1]!, INNER[2]!, INNER[3]!];
    expect(normalizeRing(dup)).toEqual(INNER);
  });

  it("leaves an already-clean ring alone", () => {
    expect(normalizeRing(INNER)).toEqual(INNER);
  });
});

describe("polygonAreaAbs", () => {
  it("is winding-independent", () => {
    const cw = [...INNER].reverse();
    expect(polygonAreaAbs(cw)).toBeCloseTo(polygonAreaAbs(INNER), 12);
  });

  it("gives the same answer for a closed and an open ring", () => {
    expect(polygonAreaAbs([...INNER, INNER[0]!])).toBeCloseTo(polygonAreaAbs(INNER), 12);
  });

  it("is 1 for a 1x1 degree square and 16 for a 4x4 one", () => {
    expect(polygonAreaAbs(INNER)).toBeCloseTo(1, 9);
    expect(polygonAreaAbs(OUTER)).toBeCloseTo(16, 9);
  });

  it("is zero for a collinear (degenerate) ring", () => {
    const line: LatLng[] = [[0, 0], [0, 1], [0, 2]];
    expect(polygonAreaAbs(line)).toBeCloseTo(0, 12);
  });

  it("is zero for a ring with fewer than 3 distinct vertices", () => {
    expect(polygonAreaAbs([[0, 0], [1, 1]])).toBe(0);
  });
});

describe("segmentsProperlyCross", () => {
  const a1: LatLng = [0, 0];
  const a2: LatLng = [2, 2];

  it("is true for a proper X crossing", () => {
    expect(segmentsProperlyCross(a1, a2, [0, 2], [2, 0])).toBe(true);
  });

  it("is FALSE for a shared endpoint — a child touching its parent is nesting", () => {
    expect(segmentsProperlyCross(a1, a2, a2, [4, 0])).toBe(false);
    expect(segmentsProperlyCross(a1, a2, a1, [0, 4])).toBe(false);
  });

  it("is FALSE for collinear overlap", () => {
    expect(segmentsProperlyCross(a1, a2, [1, 1], [3, 3])).toBe(false);
  });

  it("is false for collinear disjoint and for parallel segments", () => {
    expect(segmentsProperlyCross(a1, a2, [3, 3], [4, 4])).toBe(false);
    expect(segmentsProperlyCross(a1, a2, [0, 1], [2, 3])).toBe(false);
  });

  it("is false when either segment is degenerate", () => {
    expect(segmentsProperlyCross(a1, a1, [0, 2], [2, 0])).toBe(false);
  });
});

describe("pointRingPosition", () => {
  it("separates inside, outside and boundary", () => {
    expect(pointRingPosition([34.5, -83.5], INNER)).toBe("inside");
    expect(pointRingPosition([40, -70], INNER)).toBe("outside");
  });

  it("reports a vertex and a mid-edge point as boundary, not a coin flip", () => {
    expect(pointRingPosition(INNER[0]!, INNER)).toBe("boundary");
    expect(pointRingPosition([34, -83.5], INNER)).toBe("boundary"); // mid-edge
  });

  it("treats a point within eps of an edge as boundary", () => {
    expect(pointRingPosition([34 + 1e-12, -83.5], INNER)).toBe("boundary");
  });

  it("is outside for a ring with fewer than 3 vertices", () => {
    expect(pointRingPosition([0, 0], [[0, 0], [1, 1]])).toBe("outside");
  });
});

describe("ringsProperlyCross", () => {
  it("is false for nested rings and true for partially overlapping ones", () => {
    expect(ringsProperlyCross(INNER, OUTER)).toBe(false);
    expect(ringsProperlyCross(square(34.5, -83.5, 2), INNER)).toBe(true);
  });

  it("reports budget exhaustion instead of silently answering false", () => {
    const budget = makeWorkBudget(1);
    expect(ringsProperlyCross(square(34.5, -83.5, 2), INNER, budget)).toBe("budget");
  });
});

describe("isSimpleRing", () => {
  it("accepts a plain square and a triangle", () => {
    expect(isSimpleRing(INNER)).toBe(true);
    expect(isSimpleRing([[0, 0], [0, 2], [2, 1]])).toBe(true);
  });

  it("rejects a bow tie", () => {
    // Vertex order crosses the ring over itself.
    expect(isSimpleRing([[0, 0], [2, 2], [0, 2], [2, 0]])).toBe(false);
  });
});

describe("polygonContainsPolygon", () => {
  it("reports contains for concentric squares", () => {
    expect(polygonContainsPolygon(OUTER, INNER)).toBe("contains");
  });

  it("does NOT report contains in the reversed direction", () => {
    expect(polygonContainsPolygon(INNER, OUTER)).not.toBe("contains");
  });

  it("reports equal-area for identical rings, so neither can parent the other", () => {
    expect(polygonContainsPolygon(INNER, [...INNER])).toBe("equal-area");
    // ...and for the same shape wound the other way.
    expect(polygonContainsPolygon(INNER, [...INNER].reverse())).toBe("equal-area");
  });

  it("reports equal-area for two rings whose areas differ by less than the relative eps", () => {
    const nudged: LatLng[] = INNER.map(([lat, lng]) => [lat, lng] as LatLng);
    nudged[2] = [nudged[2]![0] + AREA_EPS_REL * 1e-3, nudged[2]![1]];
    expect(polygonContainsPolygon(INNER, nudged)).toBe("equal-area");
  });

  it("reports disjoint for rings that do not meet", () => {
    expect(polygonContainsPolygon(OUTER, square(50, 10, 1))).toBe("disjoint");
  });

  it("reports contains when the child shares a full edge with its parent", () => {
    // Child pinned to OUTER's southern edge (lat 33).
    const flush = square(33.0, -84.0, 1);
    expect(polygonContainsPolygon(OUTER, flush)).toBe("contains");
  });

  it("reports overlaps when one child vertex pokes out", () => {
    const poking: LatLng[] = [...INNER];
    poking[2] = [38.0, -83.0]; // above OUTER's northern edge
    expect(polygonContainsPolygon(OUTER, poking)).toBe("overlaps");
  });

  it("never reports contains for a zero-area outer ring", () => {
    const line: LatLng[] = [[34, -84], [34, -83], [34, -82]];
    expect(polygonContainsPolygon(line, INNER)).not.toBe("contains");
  });

  // ── The concave cases this module exists for ──────────────────────────────
  //
  //   C-shaped parent, notch opening to the east (increasing lng):
  //
  //     lat 4  +--------+
  //            |        |
  //     lat 3  |  +-----+      <- notch (the gap) spans lat 1..3, lng 2..4
  //            |  |
  //     lat 1  |  +-----+
  //            |        |
  //     lat 0  +--------+
  //          lng 0      4
  //
  const C_PARENT: LatLng[] = [
    [0, 0],
    [0, 4],
    [1, 4],
    [1, 2],
    [3, 2],
    [3, 4],
    [4, 4],
    [4, 0],
  ];

  it("reports disjoint for a child sitting in the notch (inside the bbox, outside the ring)", () => {
    const inNotch = [
      [1.5, 2.5],
      [1.5, 3.5],
      [2.5, 3.5],
      [2.5, 2.5],
    ] as LatLng[];
    expect(polygonContainsPolygon(C_PARENT, inNotch)).toBe("overlaps");
    // Every vertex really is outside the ring — the bbox is what made this
    // candidate look plausible in the first place.
    for (const v of inNotch) expect(pointRingPosition(v, C_PARENT)).toBe("outside");
  });

  it("reports OVERLAPS when every child vertex is inside but an edge cuts the notch", () => {
    // Both vertices on the left arm, both inside the C — but the edge between
    // them runs straight through the notch. All-vertices-inside would wrongly
    // call this containment.
    const bridging = [
      [0.5, 1.0],
      [3.5, 1.0],
      [3.5, 3.0],
      [0.5, 3.0],
    ] as LatLng[];
    const positions = bridging.map((v) => pointRingPosition(v, C_PARENT));
    expect(positions).toEqual(["inside", "inside", "inside", "inside"]);
    expect(polygonContainsPolygon(C_PARENT, bridging)).toBe("overlaps");
  });

  it("still reports contains for a child wholly inside one arm of the C", () => {
    const inArm = [
      [0.2, 0.2],
      [0.2, 3.8],
      [0.8, 3.8],
      [0.8, 0.2],
    ] as LatLng[];
    expect(polygonContainsPolygon(C_PARENT, inArm)).toBe("contains");
  });

  it("degrades to an explicitly approximate answer when the budget runs out", () => {
    const budget = makeWorkBudget(1);
    expect(polygonContainsPolygon(OUTER, INNER, { budget })).toBe("approximate");
  });

  it("accepts precomputed boxes and areas without changing the answer", () => {
    const rel = polygonContainsPolygon(OUTER, INNER, {
      outerBbox: polygonBbox(OUTER),
      innerBbox: polygonBbox(INNER),
      outerArea: polygonAreaAbs(OUTER),
      innerArea: polygonAreaAbs(INNER),
    });
    expect(rel).toBe("contains");
  });
});
