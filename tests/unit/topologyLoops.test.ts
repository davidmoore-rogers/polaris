/**
 * tests/unit/topologyLoops.test.ts
 *
 * Unit tests for markPhysicalLoops() — the wired-cycle detector in
 * public/js/topology-render.js that stamps `inLoop: 1` on every wired edge
 * lying on a cycle (Tarjan bridge-finding over the simple graph). Loaded the
 * same way as the column-solver tests: the file is a browser IIFE, so it is
 * evaluated in a Node vm context with a stub `window`.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

type El = { data: Record<string, unknown> };

let markPhysicalLoops: (els: El[]) => void;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../public/js/topology-render.js");
  const code = readFileSync(file, "utf8");
  const sandbox: { window: Record<string, any> } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  markPhysicalLoops = sandbox.window.PolarisTopologyRender.markPhysicalLoops;
});

const node = (id: string): El => ({ data: { id, role: "fortiswitch" } });
const iface = (id: string, source: string, target: string): El => ({
  data: { id, source, target, isIface: 1 },
});
const lldp = (id: string, source: string, target: string): El => ({
  data: { id, source, target, isLldp: 1 },
});
const mclag = (id: string, source: string, target: string): El => ({
  data: { id, source, target, isMclag: 1 },
});
const mesh = (id: string, source: string, target: string): El => ({
  data: { id, source, target, isMesh: 1 },
});
const controller = (id: string, source: string, target: string): El => ({
  data: { id, source, target },
});

const loopIds = (els: El[]): string[] =>
  els.filter((e) => e.data.inLoop === 1).map((e) => String(e.data.id)).sort();

describe("markPhysicalLoops", () => {
  it("marks every edge of a switch ring and spares the spur", () => {
    // fg — sw1 — sw2 — sw3 — sw1 (ring), plus a spur sw3 — sw4.
    const els = [
      node("fg"), node("sw1"), node("sw2"), node("sw3"), node("sw4"),
      iface("e1", "fg", "sw1"),
      iface("e2", "sw1", "sw2"),
      iface("e3", "sw2", "sw3"),
      iface("e4", "sw3", "sw1"),
      iface("e5", "sw3", "sw4"), // spur — a cut edge, not on the cycle
    ];
    markPhysicalLoops(els);
    expect(loopIds(els)).toEqual(["e2", "e3", "e4"]);
  });

  it("marks nothing on a loop-free chain", () => {
    const els = [
      node("fg"), node("sw1"), node("sw2"),
      iface("e1", "fg", "sw1"),
      iface("e2", "sw1", "sw2"),
    ];
    markPhysicalLoops(els);
    expect(loopIds(els)).toEqual([]);
  });

  it("does not flag parallel cables between the same two switches (trunk pair, not an L2 loop)", () => {
    const els = [
      node("sw1"), node("sw2"),
      iface("e1", "sw1", "sw2"),
      iface("e2", "sw1", "sw2"),
      iface("e3", "sw1", "sw2"),
    ];
    markPhysicalLoops(els);
    expect(loopIds(els)).toEqual([]);
  });

  it("mixes signals: an LLDP edge closing an interface-edge ring is flagged too", () => {
    const els = [
      node("sw1"), node("sw2"), node("sw3"),
      iface("e1", "sw1", "sw2"),
      iface("e2", "sw2", "sw3"),
      lldp("e3", "sw3", "sw1"),
    ];
    markPhysicalLoops(els);
    expect(loopIds(els)).toEqual(["e1", "e2", "e3"]);
  });

  it("flags the MCLAG ICL when it closes a loop (both peers uplink to a common parent)", () => {
    // The usual MCLAG shape: swA and swB both uplink to fg, ICL between them.
    // That's a real physical triangle — every edge, ICL included, is haloed.
    const els = [
      node("fg"), node("swA"), node("swB"),
      iface("e1", "fg", "swA"),
      iface("e2", "fg", "swB"),
      mclag("e3", "swA", "swB"),
    ];
    markPhysicalLoops(els);
    expect(loopIds(els)).toEqual(["e1", "e2", "e3"]);
  });

  it("does NOT flag an isolated MCLAG ICL (no other path between the peers)", () => {
    // swA-swB joined only by the ICL — a bridge (cut-edge), not a ring.
    const els = [
      node("fg"), node("swA"), node("swB"), node("leaf"),
      iface("e1", "fg", "swA"),
      mclag("e2", "swA", "swB"),
      iface("e3", "swB", "leaf"),
    ];
    markPhysicalLoops(els);
    expect(loopIds(els)).toEqual([]);
  });

  it("ignores wireless mesh and unverified controller edges when they close a triangle", () => {
    // Triangle only closed by a mesh edge → wired graph is a chain, no loop.
    const elsMesh = [
      node("fg"), node("ap"), node("sw"),
      iface("e1", "fg", "sw"),
      iface("e2", "sw", "ap"),
      mesh("e3", "ap", "fg"),
    ];
    markPhysicalLoops(elsMesh);
    expect(loopIds(elsMesh)).toEqual([]);

    // Triangle only closed by an unverified controller edge → same.
    const elsCtl = [
      node("fg"), node("sw1"), node("sw2"),
      iface("e1", "fg", "sw1"),
      iface("e2", "sw1", "sw2"),
      controller("e3", "fg", "sw2"),
    ];
    markPhysicalLoops(elsCtl);
    expect(loopIds(elsCtl)).toEqual([]);
  });

  it("flags each independent ring in a multi-loop graph", () => {
    // Two rings sharing node "mid": fg-a-mid-fg and mid-b-c-mid.
    const els = [
      node("fg"), node("a"), node("mid"), node("b"), node("c"),
      iface("e1", "fg", "a"),
      iface("e2", "a", "mid"),
      iface("e3", "mid", "fg"),
      iface("e4", "mid", "b"),
      iface("e5", "b", "c"),
      iface("e6", "c", "mid"),
    ];
    markPhysicalLoops(els);
    expect(loopIds(els)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
  });
});
