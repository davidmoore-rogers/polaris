/**
 * tests/unit/topologyLocationCompaction.test.ts
 *
 * Location-tier row compaction in computeTopologyColumns — the full a/b/f/r/jb
 * clustering chain (stableBucketByTiers) applied to sibling anchors (pass 5a)
 * and to each parent's leaf block (pass 5b). The point of the feature: members
 * of one room / junction box take ADJACENT lanes so their grouping hull is a
 * tight band instead of a bounding box spanning interleaved foreign rows.
 *
 * Same Node-vm harness as topologyColumns.test.ts (the solver lives in a
 * browser IIFE with no module export).
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

type Loc = { a?: string; b?: string; f?: string; r?: string; jb?: string };
const node = (id: string, role: string, loc?: Loc): El => ({
  data: {
    id,
    role,
    ...(loc?.a ? { locA: loc.a.toLowerCase() } : {}),
    ...(loc?.b ? { locB: loc.b.toLowerCase() } : {}),
    ...(loc?.f ? { locF: loc.f.toLowerCase() } : {}),
    ...(loc?.r ? { locR: loc.r.toLowerCase() } : {}),
    ...(loc?.jb ? { locJb: loc.jb.toLowerCase() } : {}),
  },
});
const edge = (source: string, target: string): El => ({
  data: { id: `e-${source}-${target}`, source, target, isIface: 1 },
});

/** Lanes of `ids`, sorted ascending. */
const lanes = (cols: Cols, ids: string[]) => ids.map((i) => cols[i].lane).sort((a, b) => a - b);
/** True when the ids occupy one contiguous lane band with no foreigner inside it. */
function contiguousBand(cols: Cols, ids: string[], allIds: string[], col: number): boolean {
  const ls = lanes(cols, ids);
  const lo = ls[0];
  const hi = ls[ls.length - 1];
  // No gaps among members…
  for (let i = 1; i < ls.length; i++) if (ls[i] !== ls[i - 1] + 1) return false;
  // …and no non-member in the same column sitting inside the band.
  return !allIds.some(
    (id) => !ids.includes(id) && cols[id].depth === col && cols[id].lane >= lo && cols[id].lane <= hi,
  );
}

describe("location-tier row compaction", () => {
  it("clusters same-room sibling anchors onto adjacent lanes", () => {
    // Six switches under one parent. The FIRST child (uncoded s0) takes the
    // parent's spine row — spine placement wins over grouping by design — and
    // the remaining rooms are interleaved in element order: r1, r2, r1, r2,
    // uncoded. Same-room pairs must land adjacent with no foreign-room switch
    // between them.
    const els = [
      node("fg", "fortigate"),
      node("p", "fortiswitch"),
      node("s0", "fortiswitch"), // spine-taker
      node("s1", "fortiswitch", { b: "Mill", r: "MCC Room" }),
      node("s2", "fortiswitch", { b: "Mill", r: "Server Room" }),
      node("s3", "fortiswitch", { b: "Mill", r: "MCC Room" }),
      node("s4", "fortiswitch", { b: "Mill", r: "Server Room" }),
      node("s5", "fortiswitch"),
      edge("fg", "p"),
      edge("p", "s0"),
      edge("p", "s1"),
      edge("p", "s2"),
      edge("p", "s3"),
      edge("p", "s4"),
      edge("p", "s5"),
    ];
    const cols = computeTopologyColumns(els)!;
    const all = ["s0", "s1", "s2", "s3", "s4", "s5"];
    const col = cols.s1.depth;
    // Siblings share one column…
    all.forEach((id) => expect(cols[id].depth).toBe(col));
    // …and each room is a contiguous band.
    expect(contiguousBand(cols, ["s1", "s3"], all, col)).toBe(true);
    expect(contiguousBand(cols, ["s2", "s4"], all, col)).toBe(true);
  });

  it("orders a parent's leaf block so same-room leaves take contiguous lanes", () => {
    // One switch with six terminal APs, rooms interleaved in payload order.
    const els = [
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("a1", "fortiap", { r: "North Bay" }),
      node("a2", "fortiap", { r: "South Bay" }),
      node("a3", "fortiap", { r: "North Bay" }),
      node("a4", "fortiap", { r: "South Bay" }),
      node("a5", "fortiap", { r: "North Bay" }),
      node("a6", "fortiap"),
      edge("fg", "sw"),
      edge("sw", "a1"),
      edge("sw", "a2"),
      edge("sw", "a3"),
      edge("sw", "a4"),
      edge("sw", "a5"),
      edge("sw", "a6"),
    ];
    const cols = computeTopologyColumns(els)!;
    const aps = ["a1", "a2", "a3", "a4", "a5", "a6"];
    const col = cols.a1.depth;
    aps.forEach((id) => expect(cols[id].depth).toBe(col));
    expect(contiguousBand(cols, ["a1", "a3", "a5"], aps, col)).toBe(true);
    expect(contiguousBand(cols, ["a2", "a4"], aps, col)).toBe(true);
    // Keyless leaves sink to the tail of the block.
    expect(cols.a6.lane).toBe(Math.max(...aps.map((id) => cols[id].lane)));
  });

  it("clusters junction-box co-members within a room", () => {
    const els = [
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("a1", "fortiap", { r: "Crusher", jb: "JB-1" }),
      node("a2", "fortiap", { r: "Crusher", jb: "JB-2" }),
      node("a3", "fortiap", { r: "Crusher", jb: "JB-1" }),
      node("a4", "fortiap", { r: "Crusher", jb: "JB-2" }),
      edge("fg", "sw"),
      edge("sw", "a1"),
      edge("sw", "a2"),
      edge("sw", "a3"),
      edge("sw", "a4"),
    ];
    const cols = computeTopologyColumns(els)!;
    const aps = ["a1", "a2", "a3", "a4"];
    const col = cols.a1.depth;
    expect(contiguousBand(cols, ["a1", "a3"], aps, col)).toBe(true);
    expect(contiguousBand(cols, ["a2", "a4"], aps, col)).toBe(true);
  });

  it("clusters room-coded-but-floorless siblings alongside fully-coded ones", () => {
    // s2/s4 carry a room but no floor: the synthetic no-floor bucket must
    // still bring them together instead of scattering them in the tail.
    const els = [
      node("fg", "fortigate"),
      node("p", "fortiswitch"),
      node("s0", "fortiswitch"), // spine-taker (spine placement wins over grouping)
      node("s1", "fortiswitch", { b: "Plant", f: "1", r: "East" }),
      node("s2", "fortiswitch", { b: "Plant", r: "West" }),
      node("s3", "fortiswitch", { b: "Plant", f: "1", r: "East" }),
      node("s4", "fortiswitch", { b: "Plant", r: "West" }),
      edge("fg", "p"),
      edge("p", "s0"),
      edge("p", "s1"),
      edge("p", "s2"),
      edge("p", "s3"),
      edge("p", "s4"),
    ];
    const cols = computeTopologyColumns(els)!;
    const sibs = ["s0", "s1", "s2", "s3", "s4"];
    const col = cols.s1.depth;
    expect(contiguousBand(cols, ["s1", "s3"], sibs, col)).toBe(true);
    expect(contiguousBand(cols, ["s2", "s4"], sibs, col)).toBe(true);
  });

  it("is a strict no-op on keyless inputs (leaf lanes keep payload order)", () => {
    const els = [
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("a1", "fortiap"),
      node("a2", "fortiap"),
      node("a3", "fortiap"),
      edge("fg", "sw"),
      edge("sw", "a1"),
      edge("sw", "a2"),
      edge("sw", "a3"),
    ];
    const cols = computeTopologyColumns(els)!;
    // Untagged leaves stack in element order — the tier chain must not
    // disturb the pre-feature layout on sites with no location codes.
    expect(cols.a1.lane).toBeLessThan(cols.a2.lane);
    expect(cols.a2.lane).toBeLessThan(cols.a3.lane);
  });

  it("keeps clustering inside the fallback (negative-column) region", () => {
    // Two unverified (controller-edge-only) switches sharing a room: exiled
    // to the fallback column, but still adjacent there. The uncoded fb0 is
    // listed first to absorb any spine/row-0 preference.
    const els = [
      node("fg", "fortigate"),
      node("fb0", "fortiswitch"),
      node("fb1", "fortiswitch", { r: "IDF" }),
      node("fb2", "fortiswitch"),
      node("fb3", "fortiswitch", { r: "IDF" }),
      { data: { id: "c0", source: "fg", target: "fb0" } },
      { data: { id: "c1", source: "fg", target: "fb1" } },
      { data: { id: "c2", source: "fg", target: "fb2" } },
      { data: { id: "c3", source: "fg", target: "fb3" } },
    ];
    const cols = computeTopologyColumns(els)!;
    ["fb0", "fb1", "fb2", "fb3"].forEach((id) => expect(cols[id].depth).toBeLessThan(0));
    expect(Math.abs(cols.fb1.lane - cols.fb3.lane)).toBe(1);
  });
});
