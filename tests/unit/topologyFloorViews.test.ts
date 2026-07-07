/**
 * tests/unit/topologyFloorViews.test.ts
 *
 * Floor-view partitioning for the Device Map topology modal —
 * computeFloorViews / partitionElementsForFloor / compareFloors in
 * public/js/topology-render.js (browser IIFE loaded in a Node vm context,
 * same harness as topologyColumns.test.ts).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

type El = { data: Record<string, any> };
type FloorView = { key: string; buildingName: string; floorName: string; label: string };

let computeFloorViews: (els: El[]) => FloorView[];
let partitionElementsForFloor: (els: El[], viewKey: string) => El[];
let compareFloors: (a: string, b: string) => number;
let computeTopologyColumns: (els: El[]) => Record<string, { depth: number; lane: number }> | null;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../public/js/topology-render.js");
  const code = readFileSync(file, "utf8");
  const sandbox: { window: Record<string, any> } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const api = sandbox.window.PolarisTopologyRender;
  computeFloorViews = api.computeFloorViews;
  partitionElementsForFloor = api.partitionElementsForFloor;
  compareFloors = api.compareFloors;
  computeTopologyColumns = api.computeTopologyColumns;
});

// Element builders. locB/locF are normalized grouping keys; loc*Name the
// display casing (buildTopologyElements stamps both in production).
const node = (id: string, role: string, loc?: { b?: string; f?: string }): El => ({
  data: {
    id,
    role,
    label: id.toUpperCase(),
    ...(loc?.b ? { locB: loc.b.toLowerCase(), locBName: loc.b } : {}),
    ...(loc?.f ? { locF: loc.f.toLowerCase(), locFName: loc.f } : {}),
  },
});
const edge = (source: string, target: string, extra?: Record<string, unknown>): El => ({
  data: { id: `e-${source}-${target}`, source, target, isIface: 1, ...(extra || {}) },
});

// Two-building site: Shop floors 1/2, Office floor 1, one untagged switch.
const site = (): El[] => [
  node("fg", "fortigate"),
  node("s1", "fortiswitch", { b: "Shop", f: "1" }),
  node("s2", "fortiswitch", { b: "Shop", f: "2" }),
  node("o1", "fortiswitch", { b: "Office", f: "1" }),
  node("plain", "fortiswitch"),
  node("ap1", "fortiap", { b: "Shop", f: "1" }),
  edge("fg", "s1"),
  edge("s1", "s2"),
  edge("fg", "o1"),
  edge("fg", "plain"),
  edge("s1", "ap1"),
  edge("s2", "plain"),
];

describe("compareFloors", () => {
  it("orders underground, numbered, and named floors: -2 < B1(-1) < 1 < 2 < Mezzanine", () => {
    const sorted = ["Mezzanine", "2", "B1", "-2", "1"].sort(compareFloors);
    expect(sorted).toEqual(["-2", "B1", "1", "2", "Mezzanine"]);
  });

  it("is case-insensitive on B# basement notation", () => {
    expect(compareFloors("b2", "B1")).toBeLessThan(0);
  });

  it("sorts named floors alphabetically after all numbered floors", () => {
    expect(compareFloors("Roof", "99")).toBeGreaterThan(0);
    expect(compareFloors("Attic", "Roof")).toBeLessThan(0);
  });
});

describe("computeFloorViews", () => {
  it("returns one view per (building, floor) pair with per-building labels", () => {
    const views = computeFloorViews(site());
    expect(views.map((v) => v.key)).toEqual(["office|1", "shop|1", "shop|2"]);
    expect(views.map((v) => v.label)).toEqual(["Office — 1", "Shop — 1", "Shop — 2"]);
  });

  it("returns empty when no node carries an f: code (no switcher rendered)", () => {
    expect(computeFloorViews([node("fg", "fortigate"), node("sw", "fortiswitch", { b: "Shop" })])).toEqual([]);
    expect(computeFloorViews([])).toEqual([]);
  });

  it("buckets f:-without-b: under an unnamed building, listed last", () => {
    const views = computeFloorViews([
      node("fg", "fortigate"),
      node("x", "fortiswitch", { f: "2" }),
      node("y", "fortiswitch", { b: "Shop", f: "1" }),
    ]);
    expect(views.map((v) => v.label)).toEqual(["Shop — 1", "Floor 2"]);
    expect(views[1].key).toBe("|2");
  });

  it("orders floors underground-aware within a building", () => {
    const views = computeFloorViews([
      node("a", "fortiswitch", { b: "Shop", f: "2" }),
      node("b", "fortiswitch", { b: "Shop", f: "B1" }),
      node("c", "fortiswitch", { b: "Shop", f: "-2" }),
      node("d", "fortiswitch", { b: "Shop", f: "Mezzanine" }),
    ]);
    expect(views.map((v) => v.floorName)).toEqual(["-2", "B1", "2", "Mezzanine"]);
  });
});

describe("partitionElementsForFloor", () => {
  const ids = (els: El[]) => els.filter((e) => !e.data.source).map((e) => e.data.id).sort();

  it("keeps only the floor's tagged devices plus the FortiGate root", () => {
    const parts = partitionElementsForFloor(site(), "shop|1");
    expect(ids(parts)).toEqual(["ap1", "fg", "portal:s2", "s1"]);
  });

  it("always includes the FortiGate even when it carries a different floor tag", () => {
    const els = site();
    els[0] = node("fg", "fortigate", { b: "Shop", f: "2" });
    const parts = partitionElementsForFloor(els, "shop|1");
    expect(ids(parts)).toContain("fg");
  });

  it("excludes untagged devices and drops their edges without a stub", () => {
    const parts = partitionElementsForFloor(site(), "shop|2");
    // s2's edge to the untagged "plain" switch vanishes entirely.
    expect(ids(parts)).toEqual(["fg", "portal:s1", "s2"]);
    const edgeTargets = parts.filter((e) => e.data.source).map((e) => `${e.data.source}>${e.data.target}`);
    expect(edgeTargets.some((t) => t.includes("plain"))).toBe(false);
  });

  it("rewires a cross-floor edge to one portal per remote device with a jump target", () => {
    const parts = partitionElementsForFloor(site(), "shop|1");
    const portal = parts.find((e) => e.data.id === "portal:s2")!;
    expect(portal.data.isPortal).toBe(1);
    expect(portal.data.targetView).toBe("shop|2");
    expect(portal.data.label).toBe("→ Shop — 2: S2");
    // The s1↔s2 edge now terminates at the portal.
    const rewired = parts.find((e) => e.data.source === "s1" && e.data.target === "portal:s2");
    expect(rewired).toBeTruthy();
  });

  it("converges parallel links to the same remote device on a single portal", () => {
    const els = site();
    els.push(edge("ap1", "s2", { isLldp: 1 })); // second edge crossing to floor 2
    const parts = partitionElementsForFloor(els, "shop|1");
    expect(parts.filter((e) => e.data.id === "portal:s2").length).toBe(1);
    const portalEdges = parts.filter((e) => e.data.source && e.data.target === "portal:s2");
    expect(portalEdges.length).toBe(2);
  });

  it("preserves edge flags (loop halos survive the partition)", () => {
    const els = site();
    const s1s2 = els.find((e) => e.data.id === "e-s1-s2")!;
    s1s2.data.inLoop = 1;
    const parts = partitionElementsForFloor(els, "shop|1");
    const rewired = parts.find((e) => e.data.source === "s1" && e.data.target === "portal:s2")!;
    expect(rewired.data.inLoop).toBe(1);
    expect(rewired.data.isIface).toBe(1);
  });

  it("does not mutate the input element set", () => {
    const els = site();
    const snapshot = JSON.parse(JSON.stringify(els));
    partitionElementsForFloor(els, "shop|1");
    expect(els).toEqual(snapshot);
  });

  it("produces a subgraph the column solver can lay out (FG-rooted, portals as leaves)", () => {
    const cols = computeTopologyColumns(partitionElementsForFloor(site(), "shop|1"))!;
    expect(cols).toBeTruthy();
    expect(cols.fg.depth).toBe(0);
    expect(cols.s1.depth).toBe(2);
    // Portal (no role → leaf weight) hangs in the odd column right of s1.
    expect(cols["portal:s2"].depth).toBe(3);
    expect(cols.ap1.depth).toBe(3);
  });
});
