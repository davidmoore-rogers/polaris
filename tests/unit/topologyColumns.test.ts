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
});
