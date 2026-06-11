/**
 * tests/unit/topologyColumns.test.ts
 *
 * Unit tests for computeTopologyColumns() — the Dijkstra-weighted column
 * solver in public/js/topology-render.js. The solver lives in a browser IIFE
 * (no module export), so we evaluate the file in a Node vm context with a
 * stub `window` and pull the function off window.PolarisTopologyRender.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

type Cols = Record<string, { depth: number; lane: number }>;
type El = { data: Record<string, unknown> };

let computeTopologyColumns: (els: El[]) => Cols | null;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../public/js/topology-render.js");
  const code = readFileSync(file, "utf8");
  const sandbox: { window: Record<string, any> } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  computeTopologyColumns = sandbox.window.PolarisTopologyRender.computeTopologyColumns;
});

// Helpers to build a /topology element set.
const node = (id: string, role: string): El => ({ data: { id, role } });
// A physically-verified link (interface-inferred or LLDP) — this is what
// proves a switch's real cable to the firewall.
const edge = (source: string, target: string): El => ({
  data: { id: `e-${source}-${target}`, source, target, isIface: 1 },
});
// A controller/FortiLink edge — NOT physical proof. A switch reachable only
// through these is a fallback (negative columns).
const controllerEdge = (source: string, target: string): El => ({
  data: { id: `c-${source}-${target}`, source, target },
});
// A wireless-mesh backhaul edge root AP → leaf AP.
const meshEdge = (source: string, target: string): El => ({
  data: { id: `m-${source}-${target}`, source, target, isMesh: 1 },
});
// A wireless client edge AP → station.
const wirelessEdge = (source: string, target: string): El => ({
  data: { id: `w-${source}-${target}`, source, target, isWireless: 1 },
});
// A controller edge whose link is physically confirmed (interface/LLDP-backed),
// flagged server-side after the FG↔switch interface edge is deduped into it.
const verifiedControllerEdge = (source: string, target: string): El => ({
  data: { id: `v-${source}-${target}`, source, target, isVerifiedUplink: 1 },
});

describe("computeTopologyColumns", () => {
  it("returns null when there is no firewall root", () => {
    expect(computeTopologyColumns([node("s1", "fortiswitch")])).toBeNull();
    expect(computeTopologyColumns([])).toBeNull();
  });

  it("places a lone firewall in column 0", () => {
    const cols = computeTopologyColumns([node("fg", "fortigate")])!;
    expect(cols.fg.depth).toBe(0);
  });

  it("puts infra on even columns by weighted depth, compacting gaps", () => {
    // fw(1) → sw1(1+2=3) → sw2(3+2=5) → ap on sw2 (5+3=8)
    // distinct infra values {1,3,5,8} → ranks 0,1,2,3 → even cols 0,2,4,6
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw1", "fortiswitch"),
      node("sw2", "fortiswitch"),
      node("ap", "fortiap"),
      edge("fg", "sw1"),
      edge("sw1", "sw2"),
      edge("sw2", "ap"),
    ])!;
    expect(cols.fg.depth).toBe(0);
    expect(cols.sw1.depth).toBe(2);
    expect(cols.sw2.depth).toBe(4);
    expect(cols.ap.depth).toBe(6);
    // every infra column is even
    [cols.fg, cols.sw1, cols.sw2, cols.ap].forEach((c) => expect(c.depth % 2).toBe(0));
  });

  it("places a leaf (wireless station) in the odd column right of its parent", () => {
    // fw(1) → sw(3) → ap(3+3=6); ap infra rank → col 4; station leaf → col 5
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("ap", "fortiap"),
      node("sta", "wireless-station"),
      edge("fg", "sw"),
      edge("sw", "ap"),
      edge("ap", "sta"),
    ])!;
    expect(cols.ap.depth).toBe(4);
    expect(cols.sta.depth).toBe(5); // odd, one right of the AP
    expect(cols.sta.depth % 2).toBe(1);
  });

  it("walks to the nearest infra ancestor for a leaf one hop past a leaf", () => {
    // An endpoint hanging off a switch sits one column right of that switch.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("ep", "endpoint"),
      edge("fg", "sw"),
      edge("sw", "ep"),
    ])!;
    expect(cols.sw.depth).toBe(2);
    expect(cols.ep.depth).toBe(3);
  });

  it("drops disconnected nodes into a rightmost orphan column", () => {
    // fw(0) → sw(2). An island switch with no path to fw lands at maxInfra+1 = 3.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("island", "fortiswitch"),
      edge("fg", "sw"),
    ])!;
    expect(cols.sw.depth).toBe(2);
    expect(cols.island.depth).toBe(3);
  });

  it("treats a verifiedUplink controller edge as a real link (switch not a fallback)", () => {
    // swA reaches the FG via a verifiedUplink controller edge (the deduped
    // interface edge); swB chains off swA via interface; swF has only a plain
    // controller edge → fallback. swA/swB verified (positive), swF at -2.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("swA", "fortiswitch"),
      node("swB", "fortiswitch"),
      node("swF", "fortiswitch"),
      verifiedControllerEdge("fg", "swA"),
      edge("swA", "swB"),
      controllerEdge("fg", "swF"),
    ])!;
    expect(cols.swA.depth).toBe(2);
    expect(cols.swB.depth).toBe(4);
    expect(cols.swF.depth).toBe(-2);
  });

  it("exiles a FortiLink-fallback switch (no physical link) to column -2", () => {
    // swF reaches the firewall ONLY through a controller edge — no interface
    // or LLDP proof — so it lands in the negative column -2.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("swOk", "fortiswitch"),
      node("swF", "fortiswitch"),
      edge("fg", "swOk"), // verified
      controllerEdge("fg", "swF"), // fallback — controller only
    ])!;
    expect(cols.swOk.depth).toBe(2);
    expect(cols.swF.depth).toBe(-2);
  });

  it("puts an endpoint on a fallback switch in column -3", () => {
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("swF", "fortiswitch"),
      node("ep", "endpoint"),
      controllerEdge("fg", "swF"), // fallback switch
      controllerEdge("swF", "ep"),
    ])!;
    expect(cols.swF.depth).toBe(-2);
    expect(cols.ep.depth).toBe(-3);
  });

  it("treats a switch chained off a fallback switch (no physical path to fw) as fallback too", () => {
    // Neither switch can prove a physical path to the firewall.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("swF1", "fortiswitch"),
      node("swF2", "fortiswitch"),
      controllerEdge("fg", "swF1"),
      controllerEdge("swF1", "swF2"),
    ])!;
    expect(cols.swF1.depth).toBe(-2);
    expect(cols.swF2.depth).toBe(-2);
  });

  it("routes a mesh-leaf AP through its root AP, not its (bogus) fallback uplink", () => {
    // apRoot on a switch (col 4); apLeaf meshes off apRoot and also has a bogus
    // FG fallback edge. The mesh must win → apLeaf one tier right of apRoot.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("apRoot", "fortiap"),
      node("apLeaf", "fortiap"),
      edge("fg", "sw"),
      edge("sw", "apRoot"),
      meshEdge("apRoot", "apLeaf"),
      controllerEdge("fg", "apLeaf"), // bogus wired uplink — must be suppressed
    ])!;
    expect(cols.apRoot.depth).toBe(4);
    expect(cols.apLeaf.depth).toBe(6); // apRoot + one AP hop, NOT col 2 via the FG fallback
  });

  it("nudges an endpoint off a connection line passing through its column", () => {
    // Station hangs off apRoot (col 2) → it would sit in col 3; the mesh edge
    // apRoot(col2)→apLeaf(col4) crosses col 3 at lane 0, so the station must be
    // moved off lane 0.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("apRoot", "fortiap"),
      node("apLeaf", "fortiap"),
      node("sta", "wireless-station"),
      edge("fg", "apRoot"),
      meshEdge("apRoot", "apLeaf"),
      wirelessEdge("apRoot", "sta"),
    ])!;
    expect(cols.apRoot.depth).toBe(2);
    expect(cols.apLeaf.depth).toBe(4);
    expect(cols.sta.depth).toBe(3); // odd column right of its AP
    expect(cols.sta.lane).not.toBe(0); // nudged off the mesh line at lane 0
  });

  it("routes a switch bridged behind an AP through the AP, not as a fallback", () => {
    // swBridge is reached via a mesh/bridge edge from apRoot and also carries a
    // bogus FortiLink controller edge. It must route through the AP (positive
    // column), not the -2 FortiLink-fallback column.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("apRoot", "fortiap"),
      node("swBridge", "fortiswitch"),
      edge("fg", "sw"),
      edge("sw", "apRoot"),
      meshEdge("apRoot", "swBridge"),
      controllerEdge("fg", "swBridge"), // bogus FortiLink — suppressed
    ])!;
    expect(cols.apRoot.depth).toBe(4);
    expect(cols.swBridge.depth).toBe(6); // apRoot + one switch hop, NOT -2
    expect(cols.swBridge.depth).toBeGreaterThan(0);
  });

  it("assigns distinct lanes to siblings sharing a column", () => {
    // Two switches both directly on the firewall → same column, different lanes.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("swA", "fortiswitch"),
      node("swB", "fortiswitch"),
      edge("fg", "swA"),
      edge("fg", "swB"),
    ])!;
    expect(cols.swA.depth).toBe(2);
    expect(cols.swB.depth).toBe(2);
    expect(cols.swA.lane).not.toBe(cols.swB.lane);
  });

  it("keeps the spine on one row: a chain shares the firewall's lane", () => {
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw1", "fortiswitch"),
      node("sw2", "fortiswitch"),
      node("ap", "fortiap"),
      edge("fg", "sw1"),
      edge("sw1", "sw2"),
      edge("sw2", "ap"),
    ])!;
    expect(cols.fg.lane).toBe(0);
    expect(cols.sw1.lane).toBe(0);
    expect(cols.sw2.lane).toBe(0);
    expect(cols.ap.lane).toBe(0);
  });

  it("gives sibling subtrees disjoint row bands", () => {
    // swA (3 endpoints) and swB (2 endpoints) both on the firewall: every row
    // in swA's subtree sits strictly above every row in swB's, and swB
    // continues on its own first endpoint's row.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("swA", "fortiswitch"),
      node("swB", "fortiswitch"),
      node("a1", "endpoint"),
      node("a2", "endpoint"),
      node("a3", "endpoint"),
      node("b1", "endpoint"),
      node("b2", "endpoint"),
      edge("fg", "swA"),
      edge("fg", "swB"),
      edge("swA", "a1"),
      edge("swA", "a2"),
      edge("swA", "a3"),
      edge("swB", "b1"),
      edge("swB", "b2"),
    ])!;
    const bandA = [cols.swA, cols.a1, cols.a2, cols.a3].map((c) => c.lane);
    const bandB = [cols.swB, cols.b1, cols.b2].map((c) => c.lane);
    expect(Math.max(...bandA)).toBeLessThan(Math.min(...bandB));
    expect(cols.swB.lane).toBe(cols.b1.lane); // swB's spine continues through its first endpoint
  });

  it("places every endpoint of one switch on its own row, first one on the switch's row", () => {
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("e1", "endpoint"),
      node("e2", "endpoint"),
      node("e3", "endpoint"),
      node("e4", "endpoint"),
      edge("fg", "sw"),
      edge("sw", "e1"),
      edge("sw", "e2"),
      edge("sw", "e3"),
      edge("sw", "e4"),
    ])!;
    const lanes = [cols.e1, cols.e2, cols.e3, cols.e4].map((c) => c.lane);
    expect(new Set(lanes).size).toBe(4); // all distinct rows
    expect(cols.e1.lane).toBe(cols.sw.lane); // first endpoint continues the switch's row
    expect(Math.min(...lanes)).toBe(cols.sw.lane); // the rest stack below
  });

  it("stacks a leaf chained off a leaf (same column) on a distinct row", () => {
    // ep2 hangs off ep1; both resolve to the same odd column right of the
    // switch — the spine must NOT collapse them onto one row.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("ep1", "endpoint"),
      node("ep2", "endpoint"),
      edge("fg", "sw"),
      edge("sw", "ep1"),
      edge("ep1", "ep2"),
    ])!;
    expect(cols.ep1.depth).toBe(3);
    expect(cols.ep2.depth).toBe(3);
    expect(cols.ep1.lane).not.toBe(cols.ep2.lane);
    expect(cols.sw.lane).toBe(cols.ep1.lane); // spine inherits through the rightward leaf
  });

  it("band-places fallback exiles with their own cursor", () => {
    // A fallback switch's spine continues through its first endpoint (leftward
    // band), and two chained fallback switches (same column -2) get distinct rows.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("swOk", "fortiswitch"),
      node("swF1", "fortiswitch"),
      node("swF2", "fortiswitch"),
      node("epF", "endpoint"),
      edge("fg", "swOk"),
      controllerEdge("fg", "swF1"),
      controllerEdge("swF1", "swF2"),
      controllerEdge("swF1", "epF"),
    ])!;
    expect(cols.swF1.depth).toBe(-2);
    expect(cols.swF2.depth).toBe(-2);
    expect(cols.epF.depth).toBe(-3);
    expect(cols.swF1.lane).toBe(cols.epF.lane); // exile spine continues leftward
    expect(cols.swF1.lane).not.toBe(cols.swF2.lane); // same-column chain stacks
    expect(cols.swF1.lane).toBeGreaterThanOrEqual(0);
    // The verified spine still owns row 0 — a fallback switch must never steal it.
    expect(cols.fg.lane).toBe(0);
    expect(cols.swOk.lane).toBe(0);
  });

  it("stacks orphans below the main tree so they can't share a row with verified leaves", () => {
    // The verified leaf `ep` occupies orphanCol (maxInfra=2 → orphanCol=3);
    // the island lands in the same column and must sit on a lower row.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("ep", "endpoint"),
      node("island", "fortiswitch"),
      edge("fg", "sw"),
      edge("sw", "ep"),
    ])!;
    expect(cols.ep.depth).toBe(3);
    expect(cols.island.depth).toBe(3);
    expect(cols.island.lane).toBeGreaterThan(cols.ep.lane);
  });

  it("is deterministic across repeated calls on the same elements", () => {
    const els = [
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("apRoot", "fortiap"),
      node("apLeaf", "fortiap"),
      node("sta", "wireless-station"),
      node("swF", "fortiswitch"),
      node("e1", "endpoint"),
      node("e2", "endpoint"),
      edge("fg", "sw"),
      edge("sw", "apRoot"),
      meshEdge("apRoot", "apLeaf"),
      wirelessEdge("apRoot", "sta"),
      controllerEdge("fg", "swF"),
      edge("sw", "e1"),
      edge("sw", "e2"),
    ];
    expect(computeTopologyColumns(els)).toEqual(computeTopologyColumns(els));
  });
});
