/**
 * tests/unit/topologyGroupedLayout.test.ts
 *
 * Quotient (two-level) layout for location-coded sites —
 * computeGroupedLayout in public/js/topology-render.js (browser IIFE loaded
 * in a Node vm context, same harness as topologyColumns.test.ts).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

type El = { data: Record<string, any> };
type Pos = Record<string, { depth: number; lane: number }>;

let computeGroupedLayout: (els: El[]) => Pos | null;
let computeTopologyColumns: (els: El[]) => Pos | null;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../public/js/topology-render.js");
  const code = readFileSync(file, "utf8");
  const sandbox: { window: Record<string, any> } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const api = sandbox.window.PolarisTopologyRender;
  computeGroupedLayout = api.computeGroupedLayout;
  computeTopologyColumns = api.computeTopologyColumns;
});

const node = (id: string, role: string, loc?: { a?: string; b?: string; f?: string }): El => ({
  data: {
    id,
    role,
    ...(loc?.a ? { locA: loc.a.toLowerCase(), locAName: loc.a } : {}),
    ...(loc?.b ? { locB: loc.b.toLowerCase(), locBName: loc.b } : {}),
    ...(loc?.f ? { locF: loc.f.toLowerCase(), locFName: loc.f } : {}),
  },
});
const edge = (source: string, target: string): El => ({
  data: { id: `e-${source}-${target}`, source, target, isIface: 1 },
});

// Bounding box of a set of node ids in a layout.
function box(pos: Pos, ids: string[]) {
  const xs = ids.map((i) => pos[i].depth);
  const ys = ids.map((i) => pos[i].lane);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}
function disjoint(a: ReturnType<typeof box>, b: ReturnType<typeof box>) {
  return a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1;
}

// A JEFFERSON-shaped miniature: FG in Scale House; a deep chain into the
// Mine building whose members sit far right in GLOBAL depth; a mid-chain
// untagged switch; a small QC Lab building; a FortiLink fallback.
const site = (): El[] => {
  const els = [
    node("fg", "fortigate", { b: "Scale House" }),
    node("sh1", "fortiswitch", { b: "Scale House" }),
    node("sh2", "fortiswitch", { b: "Scale House" }),
    node("shap", "fortiap", { b: "Scale House" }),
    node("mid", "fortiswitch"), // untagged mid-chain hop
    node("m1", "fortiswitch", { b: "Mine", f: "Surface" }),
    node("m2", "fortiswitch", { b: "Mine", f: "Surface" }),
    node("m3", "fortiswitch", { b: "Mine", f: "Slope" }),
    node("map1", "fortiap", { b: "Mine", f: "Surface" }),
    node("map2", "fortiap", { b: "Mine", f: "Slope" }),
    node("qc1", "fortiswitch", { b: "QC Lab" }),
    node("qcap", "fortiap", { b: "QC Lab" }),
    node("fb", "fortiswitch"), // FortiLink fallback (controller edge only)
    edge("fg", "sh1"),
    edge("sh1", "sh2"),
    edge("sh1", "shap"),
    edge("sh2", "mid"),
    edge("mid", "m1"),
    edge("m1", "m2"),
    edge("m2", "m3"),
    edge("m1", "map1"),
    edge("m3", "map2"),
    edge("fg", "qc1"),
    edge("qc1", "qcap"),
  ];
  els.push({ data: { id: "c-fg-fb", source: "fg", target: "fb" } }); // unverified controller edge
  return els;
};

const SCALE = ["fg", "sh1", "sh2", "shap"];
const MINE = ["m1", "m2", "m3", "map1", "map2"];
const QC = ["qc1", "qcap"];
const UNGROUPED = ["mid", "fb"];

describe("computeGroupedLayout", () => {
  it("returns null on untagged sites (flat solver remains the layout)", () => {
    expect(
      computeGroupedLayout([
        node("fg", "fortigate"),
        node("sw", "fortiswitch"),
        edge("fg", "sw"),
      ])
    ).toBeNull();
  });

  it("returns null when the flat solver has no FortiGate root", () => {
    expect(computeGroupedLayout([node("sw", "fortiswitch", { b: "Shop" })])).toBeNull();
  });

  it("keeps group boxes pairwise disjoint (including the uncoded pseudo-group)", () => {
    const pos = computeGroupedLayout(site())!;
    const boxes = [SCALE, MINE, QC, UNGROUPED].map((ids) => box(pos, ids));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(disjoint(boxes[i], boxes[j])).toBe(true);
      }
    }
  });

  it("compacts each group to its own subtree size regardless of global depth", () => {
    const pos = computeGroupedLayout(site())!;
    // Mine's members span 3 chained switches + leaf APs. Global depth would
    // start ~8 columns in (behind Scale House and the untagged hop); locally
    // the box must be no wider than its distinct column count (4: three
    // anchor columns + shared leaf columns compressed) and start at its own
    // x-origin.
    const mine = box(pos, MINE);
    expect(mine.x2 - mine.x1).toBeLessThanOrEqual(4);
    // ...whereas the flat layout is much wider overall for the same members.
    const flat = computeTopologyColumns(site())!;
    const flatMine = box(flat, MINE);
    expect(flatMine.x2 - flatMine.x1).toBeGreaterThanOrEqual(mine.x2 - mine.x1);
  });

  it("orders quotient columns by inter-group depth (FG's group leftmost of the coded groups)", () => {
    const pos = computeGroupedLayout(site())!;
    const scale = box(pos, SCALE);
    const mine = box(pos, MINE);
    // Scale House contains the FG (entry) — its box starts left of Mine's.
    expect(scale.x1).toBeLessThan(mine.x1);
  });

  it("preserves each group's internal relative ordering from the flat solver", () => {
    const pos = computeGroupedLayout(site())!;
    const flat = computeTopologyColumns(site())!;
    // Chain m1 → m2 → m3 keeps strictly increasing x in both layouts.
    expect(pos.m1.depth).toBeLessThan(pos.m2.depth);
    expect(pos.m2.depth).toBeLessThan(pos.m3.depth);
    expect(flat.m1.depth).toBeLessThan(flat.m2.depth);
    // APs stay right of their parent switch.
    expect(pos.map1.depth).toBeGreaterThan(pos.m1.depth);
    expect(pos.map2.depth).toBeGreaterThan(pos.m3.depth);
  });

  it("covers every node exactly once", () => {
    const pos = computeGroupedLayout(site())!;
    const all = [...SCALE, ...MINE, ...QC, ...UNGROUPED];
    all.forEach((id) => expect(pos[id]).toBeTruthy());
    expect(Object.keys(pos).sort()).toEqual([...all].sort());
  });

  it("is deterministic across repeated calls", () => {
    const els = site();
    expect(computeGroupedLayout(els)).toEqual(computeGroupedLayout(els));
  });

  it("groups by area when present — buildings sharing an area share one box", () => {
    const els = [
      node("fg", "fortigate", { b: "HQ" }),
      node("x1", "fortiswitch", { a: "Mine", b: "Shop" }),
      node("x2", "fortiswitch", { a: "Mine", b: "Office" }),
      node("y1", "fortiswitch", { b: "Depot" }),
      edge("fg", "x1"),
      edge("x1", "x2"),
      edge("fg", "y1"),
    ];
    const pos = computeGroupedLayout(els)!;
    const mineBox = box(pos, ["x1", "x2"]);
    const depotBox = box(pos, ["y1"]);
    const hqBox = box(pos, ["fg"]);
    expect(disjoint(mineBox, depotBox)).toBe(true);
    expect(disjoint(mineBox, hqBox)).toBe(true);
  });
});
