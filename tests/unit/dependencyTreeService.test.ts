/**
 * tests/unit/dependencyTreeService.test.ts
 *
 * Pure-function coverage for the dependency-tree builder, BFS layer
 * assignment, and the all-down multi-parent suppression evaluator. The
 * DB-bound recompute / reconcile wrappers are exercised via integration
 * tests separately.
 */

import { describe, it, expect } from "vitest";

import {
  buildDependencyEdgesFromInputs,
  assignLayers,
  evaluateSuppression,
  type DepAsset,
  type DepInterfaceEdge,
  type DepLldpEdge,
  type SuppressionAssetState,
} from "../../src/services/dependencyTreeService.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function fg(id: string, hostname: string): DepAsset {
  return { id, hostname, serialNumber: null, assetType: "firewall", fortinetTopology: null };
}
function sw(id: string, hostname: string, controllerFortigate?: string): DepAsset {
  return {
    id,
    hostname,
    serialNumber: null,
    assetType: "switch",
    fortinetTopology: controllerFortigate ? { role: "fortiswitch", controllerFortigate } : null,
  };
}
function ap(id: string, hostname: string, parentSwitch?: string, controllerFortigate?: string): DepAsset {
  return {
    id,
    hostname,
    serialNumber: null,
    assetType: "access_point",
    fortinetTopology: { role: "fortiap", parentSwitch, controllerFortigate },
  };
}

// ─── buildDependencyEdgesFromInputs ─────────────────────────────────────────

describe("buildDependencyEdgesFromInputs", () => {
  it("emits controller→switch edges from fortinetTopology", () => {
    const assets = [fg("fg1", "FG-EDGE-01"), sw("sw1", "FS-CORE-01", "FG-EDGE-01")];
    const edges = buildDependencyEdgesFromInputs(assets, [], []);
    expect(edges).toEqual([
      { childAssetId: "sw1", parentAssetId: "fg1", detectedVia: "controller" },
    ]);
  });

  it("makes a mesh leaf AP depend on its root AP, not the controller-resolved switch", () => {
    const assets = [
      fg("fg1", "FG-EDGE-01"),
      sw("sw1", "FS-CORE-01", "FG-EDGE-01"),
      ap("apRoot", "FAP-ROOT", "FS-CORE-01"), // root AP genuinely on the switch
      ap("apLeaf", "FAP-LEAF", "FS-CORE-01"), // discovery WRONGLY put the leaf on the switch
    ];
    const meshEdges = [{ rootApId: "apRoot", leafApId: "apLeaf" }];
    const edges = buildDependencyEdgesFromInputs(assets, [], [], meshEdges);
    // Leaf gets NO controller edge to the switch...
    expect(edges).not.toContainEqual({ childAssetId: "apLeaf", parentAssetId: "sw1", detectedVia: "controller" });
    // ...and instead a mesh edge to its root AP.
    expect(edges).toContainEqual({ childAssetId: "apLeaf", parentAssetId: "apRoot", detectedVia: "mesh" });

    const { layers, keptEdges } = assignLayers(assets, edges);
    // fg=1, sw=2, apRoot=3, apLeaf=4 (one layer below its root AP).
    expect(layers.get("apRoot")).toBe(3);
    expect(layers.get("apLeaf")).toBe(4);
    const leafParent = keptEdges.find((e) => e.childAssetId === "apLeaf");
    expect(leafParent).toEqual({ childAssetId: "apLeaf", parentAssetId: "apRoot", detectedVia: "mesh" });
  });

  it("makes a switch bridged behind an AP depend on the AP, not the FortiGate", () => {
    const assets = [
      fg("fg1", "FG-EDGE-01"),
      ap("apX", "FAP-REMOTE", undefined, "FG-EDGE-01"), // remote AP, no parentSwitch
      sw("swBridge", "FS-REMOTE", "FG-EDGE-01"), // FortiLink-managed switch behind apX
    ];
    const lldpEdges = [{ assetId: "apX", matchedAssetId: "swBridge" }];
    const bridgeLeaves = new Set(["swBridge"]);
    const edges = buildDependencyEdgesFromInputs(assets, [], lldpEdges, [], bridgeLeaves);
    // FortiLink controller edge to the FortiGate is suppressed...
    expect(edges).not.toContainEqual({ childAssetId: "swBridge", parentAssetId: "fg1", detectedVia: "controller" });
    // ...replaced by an LLDP edge to the AP.
    expect(edges).toContainEqual({ childAssetId: "swBridge", parentAssetId: "apX", detectedVia: "lldp" });

    const { layers, keptEdges } = assignLayers(assets, edges);
    expect(layers.get("apX")).toBe(2); // AP off the FortiGate
    expect(layers.get("swBridge")).toBe(3); // bridged switch off the AP
    const leafParent = keptEdges.find((e) => e.childAssetId === "swBridge");
    expect(leafParent).toEqual({ childAssetId: "swBridge", parentAssetId: "apX", detectedVia: "lldp" });
  });

  it("suppresses a mesh leaf's backwards controller edge via fortinetTopology.meshUplink even without station-derived mesh edges", () => {
    // The user-reported inversion: a mesh-leaf AP (FortiOS mesh_uplink="mesh")
    // whose LLDP sees a switch bridged behind its LAN port. Pre-fix discovery
    // stamped that switch as the leaf's parentSwitch, so the controller edge
    // pointed BACKWARDS (leaf depends on the bridged switch). The stamped
    // meshUplink flag alone — no root-AP station scrape required — must
    // suppress it, and with the switch flagged as a bridge leaf the switch
    // depends on the AP via LLDP.
    const meshLeaf: DepAsset = {
      id: "apLeaf",
      hostname: "FP234FTF21009379",
      serialNumber: null,
      assetType: "access_point",
      fortinetTopology: { role: "fortiap", parentSwitch: "S108EFTQ21003618", controllerFortigate: "FG-EDGE-01", meshUplink: "mesh" },
    };
    const assets = [fg("fg1", "FG-EDGE-01"), sw("swBridge", "S108EFTQ21003618", "FG-EDGE-01"), meshLeaf];
    const lldpEdges = [{ assetId: "apLeaf", matchedAssetId: "swBridge" }];
    const edges = buildDependencyEdgesFromInputs(assets, [], lldpEdges, [], new Set(["swBridge"]));
    // No backwards leaf→bridged-switch controller edge…
    expect(edges).not.toContainEqual({ childAssetId: "apLeaf", parentAssetId: "swBridge", detectedVia: "controller" });
    // …and the bridged switch's FortiLink edge stays suppressed in favor of
    // the LLDP edge to the AP.
    expect(edges).not.toContainEqual({ childAssetId: "swBridge", parentAssetId: "fg1", detectedVia: "controller" });
    expect(edges).toContainEqual({ childAssetId: "swBridge", parentAssetId: "apLeaf", detectedVia: "lldp" });
  });

  it("emits switch→AP edges from fortinetTopology.parentSwitch", () => {
    const assets = [
      fg("fg1", "FG-EDGE-01"),
      sw("sw1", "FS-CORE-01", "FG-EDGE-01"),
      ap("ap1", "FAP-01", "FS-CORE-01"),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], []);
    expect(edges).toContainEqual({ childAssetId: "ap1", parentAssetId: "sw1", detectedVia: "controller" });
  });

  it("falls back to FortiGate parent for an AP not behind a switch", () => {
    const assets = [
      fg("fg1", "FG-EDGE-01"),
      ap("ap1", "FAP-01", undefined, "FG-EDGE-01"),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], []);
    expect(edges).toContainEqual({ childAssetId: "ap1", parentAssetId: "fg1", detectedVia: "controller" });
  });

  it("emits both directions for interface edges (BFS resolves direction)", () => {
    const assets = [sw("sw1", "FS-A"), sw("sw2", "FS-B")];
    const edges = buildDependencyEdgesFromInputs(assets, [{ sourceAssetId: "sw1", targetAssetId: "sw2" }], []);
    expect(edges).toContainEqual({ childAssetId: "sw1", parentAssetId: "sw2", detectedVia: "interface" });
    expect(edges).toContainEqual({ childAssetId: "sw2", parentAssetId: "sw1", detectedVia: "interface" });
  });

  it("emits one edge per signal kind for the same pair (collapsing happens in assignLayers' prune step)", () => {
    const assets = [fg("fg1", "FG-EDGE-01"), sw("sw1", "FS-CORE-01", "FG-EDGE-01")];
    const edges = buildDependencyEdgesFromInputs(
      assets,
      [{ sourceAssetId: "sw1", targetAssetId: "fg1" }],
      [{ assetId: "sw1", matchedAssetId: "fg1" }],
    );
    const swToFg = edges.filter(e => e.childAssetId === "sw1" && e.parentAssetId === "fg1");
    const kinds = swToFg.map(e => e.detectedVia).sort();
    expect(kinds).toEqual(["controller", "interface", "lldp"]);
  });

  it("ignores self-loops and references to unknown assets", () => {
    const assets = [sw("sw1", "FS-A")];
    const edges = buildDependencyEdgesFromInputs(
      assets,
      [
        { sourceAssetId: "sw1", targetAssetId: "sw1" }, // self-loop
        { sourceAssetId: "sw1", targetAssetId: "ghost" }, // unknown peer
      ],
      [],
    );
    expect(edges).toEqual([]);
  });

  it("does not bind a switch's controllerFortigate to an asset of the wrong type", () => {
    // hostname collides with an AP, not a firewall — must NOT create the edge.
    const assets = [
      ap("ap1", "FG-EDGE-01"), // pretend an AP somehow shares a hostname with a FortiGate
      sw("sw1", "FS-CORE-01", "FG-EDGE-01"),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], []);
    expect(edges.find(e => e.childAssetId === "sw1")).toBeUndefined();
  });
});

// ─── assignLayers ───────────────────────────────────────────────────────────

describe("assignLayers", () => {
  it("assigns layer 1 to every FortiGate root", () => {
    const assets = [fg("fg1", "A"), fg("fg2", "B"), sw("sw1", "C")];
    const { layers } = assignLayers(assets, []);
    expect(layers.get("fg1")).toBe(1);
    expect(layers.get("fg2")).toBe(1);
    expect(layers.has("sw1")).toBe(false); // no edges → unresolved
  });

  it("walks a 4-tier chain (FG → core → distribution → access)", () => {
    const assets = [
      fg("fg",  "FG"),
      sw("core","CORE", "FG"),
      sw("dist","DIST"), // chained via interface edge to core
      sw("acc", "ACC"),  // chained via interface edge to dist
    ];
    const ifEdges: DepInterfaceEdge[] = [
      { sourceAssetId: "core", targetAssetId: "dist" },
      { sourceAssetId: "dist", targetAssetId: "acc"  },
    ];
    const candidate = buildDependencyEdgesFromInputs(assets, ifEdges, []);
    const { layers, keptEdges } = assignLayers(assets, candidate);
    expect(layers.get("fg")).toBe(1);
    expect(layers.get("core")).toBe(2);
    expect(layers.get("dist")).toBe(3);
    expect(layers.get("acc")).toBe(4);
    expect(keptEdges).toContainEqual({ childAssetId: "core", parentAssetId: "fg",   detectedVia: "controller" });
    expect(keptEdges).toContainEqual({ childAssetId: "dist", parentAssetId: "core", detectedVia: "interface" });
    expect(keptEdges).toContainEqual({ childAssetId: "acc",  parentAssetId: "dist", detectedVia: "interface" });
  });

  it("MCLAG-paired switches at the same layer don't become parents of each other", () => {
    // FG at L1; sw1 + sw2 both controllerFortigate=FG → both L2; mutual interface edge.
    const assets = [
      fg("fg",  "FG"),
      sw("sw1", "A", "FG"),
      sw("sw2", "B", "FG"),
    ];
    const ifEdges: DepInterfaceEdge[] = [{ sourceAssetId: "sw1", targetAssetId: "sw2" }];
    const candidate = buildDependencyEdgesFromInputs(assets, ifEdges, []);
    const { layers, keptEdges } = assignLayers(assets, candidate);
    expect(layers.get("sw1")).toBe(2);
    expect(layers.get("sw2")).toBe(2);
    // Same-layer edges are pruned.
    expect(keptEdges.find(e => e.childAssetId === "sw1" && e.parentAssetId === "sw2")).toBeUndefined();
    expect(keptEdges.find(e => e.childAssetId === "sw2" && e.parentAssetId === "sw1")).toBeUndefined();
  });

  it("dual-homed switch records BOTH FortiGates as parents", () => {
    // controllerFortigate is single-valued, but the second FG also has an
    // interface edge from sw1 — both end up as L1 parents at L2.
    const assets = [
      fg("fg1", "FG-A"),
      fg("fg2", "FG-B"),
      sw("sw1", "DUAL", "FG-A"),
    ];
    const ifEdges: DepInterfaceEdge[] = [{ sourceAssetId: "sw1", targetAssetId: "fg2" }];
    const candidate = buildDependencyEdgesFromInputs(assets, ifEdges, []);
    const { layers, keptEdges } = assignLayers(assets, candidate);
    expect(layers.get("sw1")).toBe(2);
    const sw1Parents = keptEdges.filter(e => e.childAssetId === "sw1").map(e => e.parentAssetId).sort();
    expect(sw1Parents).toEqual(["fg1", "fg2"]);
  });

  it("chains a 3-switch daisy where every switch reports controllerFortigate=FG and only siblings are LLDP-connected", () => {
    // The bug-fix case: all three switches are FortiLink-managed by the
    // same FG (so every one has a controller edge to FG), but the chain
    // head 148F-1 has no detectable physical edge back to the FG. Only
    // sibling LLDP edges (148F-1↔148F-2, 148F-2↔148F-3) exist. The chain
    // should still resolve via the controller-fallback simple-path
    // detection so 148F-2 attaches under 148F-1 and 148F-3 under 148F-2.
    const assets = [
      fg("fg",   "CKYSMA-91G-1"),
      sw("sw1",  "CKYSMA-148F-1", "CKYSMA-91G-1"),
      sw("sw2",  "CKYSMA-148F-2", "CKYSMA-91G-1"),
      sw("sw3",  "CKYSMA-148F-3", "CKYSMA-91G-1"),
    ];
    const candidate = buildDependencyEdgesFromInputs(
      assets,
      [],
      [
        { assetId: "sw1", matchedAssetId: "sw2" },
        { assetId: "sw2", matchedAssetId: "sw1" },
        { assetId: "sw2", matchedAssetId: "sw3" },
        { assetId: "sw3", matchedAssetId: "sw2" },
      ],
    );
    const { layers, keptEdges } = assignLayers(assets, candidate);
    expect(layers.get("fg")).toBe(1);
    expect(layers.get("sw1")).toBe(2);
    expect(layers.get("sw2")).toBe(3);
    expect(layers.get("sw3")).toBe(4);
    const parentOf = (id: string) =>
      keptEdges.find(e => e.childAssetId === id)?.parentAssetId;
    expect(parentOf("sw1")).toBe("fg");
    expect(parentOf("sw2")).toBe("sw1");
    expect(parentOf("sw3")).toBe("sw2");
  });

  it("prefers physical-uplink edges over controller edges when both reach the FG", () => {
    // The clean case: 148F-1 has both a controller edge (FortiLink mgmt)
    // and an LLDP edge to the FG. Physical-first BFS lands 148F-1 at L2
    // via the LLDP edge directly, and the kept edge for the (sw1, fg)
    // pair carries detectedVia="lldp" rather than "controller" so the
    // audit trail reflects the cable, not just the management contract.
    const assets = [fg("fg", "FG"), sw("sw1", "SW", "FG")];
    const candidate = buildDependencyEdgesFromInputs(
      assets,
      [],
      [{ assetId: "sw1", matchedAssetId: "fg" }, { assetId: "fg", matchedAssetId: "sw1" }],
    );
    const { layers, keptEdges } = assignLayers(assets, candidate);
    expect(layers.get("sw1")).toBe(2);
    const swEdge = keptEdges.find(e => e.childAssetId === "sw1" && e.parentAssetId === "fg");
    expect(swEdge?.detectedVia).toBe("lldp");
  });

  it("orphans (no path from any FG) end up unresolved", () => {
    const assets = [
      fg("fg",  "FG"),
      sw("sw1", "ISLAND-A"),
      sw("sw2", "ISLAND-B"),
    ];
    const ifEdges: DepInterfaceEdge[] = [{ sourceAssetId: "sw1", targetAssetId: "sw2" }];
    const candidate = buildDependencyEdgesFromInputs(assets, ifEdges, []);
    const { layers, unresolved } = assignLayers(assets, candidate);
    expect(layers.get("fg")).toBe(1);
    expect(unresolved.sort()).toEqual(["sw1", "sw2"]);
  });
});

// ─── evaluateSuppression ────────────────────────────────────────────────────

describe("evaluateSuppression", () => {
  function st(id: string, layer: number | null, monitorStatus: string | null, monitored = true): SuppressionAssetState {
    return { id, layer, monitorStatus, monitored, currentlySuppressed: false };
  }

  it("orphans (no parents) are never suppressed", () => {
    const states = [st("a", 1, "down")];
    const out = evaluateSuppression(states, new Map());
    expect(out.get("a")).toBe(false);
  });

  it("single parent down → child suppressed", () => {
    const states = [st("fg", 1, "down"), st("sw", 2, "up")];
    const parents = new Map([["sw", ["fg"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("fg")).toBe(false);
    expect(out.get("sw")).toBe(true);
  });

  it("multi-parent: ANY parent up → child not suppressed", () => {
    const states = [st("fg1", 1, "down"), st("fg2", 1, "up"), st("sw", 2, "up")];
    const parents = new Map([["sw", ["fg1", "fg2"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(false);
  });

  it("multi-parent: ALL parents down → child suppressed", () => {
    const states = [st("fg1", 1, "down"), st("fg2", 1, "down"), st("sw", 2, "up")];
    const parents = new Map([["sw", ["fg1", "fg2"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(true);
  });

  it("transitive: parent suppressed → grandchild suppressed too", () => {
    const states = [
      st("fg",   1, "down"),
      st("core", 2, "up"),
      st("acc",  3, "up"),
    ];
    const parents = new Map([["core", ["fg"]], ["acc", ["core"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("core")).toBe(true);
    expect(out.get("acc")).toBe(true);
  });

  it("warning / recovering parents do NOT suppress descendants", () => {
    // Suppression follows confirmed-down only.
    const wState = [st("fg", 1, "warning"), st("sw", 2, "up")];
    const rState = [st("fg", 1, "recovering"), st("sw", 2, "up")];
    const parents = new Map([["sw", ["fg"]]]);
    expect(evaluateSuppression(wState, parents).get("sw")).toBe(false);
    expect(evaluateSuppression(rState, parents).get("sw")).toBe(false);
  });

  it("unmonitored parent is transparent — walks up to grandparents", () => {
    // sw_mid is unmonitored; FG is down; acc should be suppressed because
    // its only chain back to a monitored ancestor is via a down FG.
    const states = [
      st("fg",     1, "down"),
      st("sw_mid", 2, null, /*monitored=*/false),
      st("acc",    3, "up"),
    ];
    const parents = new Map([["sw_mid", ["fg"]], ["acc", ["sw_mid"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(true);
  });

  it("unmonitored parent with no grandparents is treated as ok", () => {
    // No monitored ancestor → no signal → not suppressed.
    const states = [
      st("orphan", 2, null, /*monitored=*/false),
      st("acc",    3, "up"),
    ];
    const parents = new Map([["acc", ["orphan"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(false);
  });

  // Admin-only "Dependency Test" overlay — parent with a future
  // dependencyTestUntil is treated as confirmed-down for suppression even
  // when its real probe is up. Past timestamps are inactive (auto-expired).
  it("dependencyTestUntil in the future treats parent as down", () => {
    const future = new Date(Date.now() + 30 * 60 * 1000);
    const states: SuppressionAssetState[] = [
      { id: "fg",  layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false, dependencyTestUntil: future },
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false },
    ];
    const parents = new Map([["sw", ["fg"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(true);
  });

  it("dependencyTestUntil in the past is ignored (acts as inactive)", () => {
    const past = new Date(Date.now() - 60 * 1000);
    const states: SuppressionAssetState[] = [
      { id: "fg",  layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false, dependencyTestUntil: past },
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false },
    ];
    const parents = new Map([["sw", ["fg"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(false);
  });

  it("dependency-test parent does NOT walk transparently to grandparents", () => {
    // Operator's intent is "pretend THIS box went offline" — even when an
    // upstream root is healthy, children of the test target stay suppressed.
    const future = new Date(Date.now() + 30 * 60 * 1000);
    const states: SuppressionAssetState[] = [
      { id: "fg",  layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false },
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false, dependencyTestUntil: future },
      { id: "acc", layer: 3, monitorStatus: "up", monitored: true, currentlySuppressed: false },
    ];
    const parents = new Map([["sw", ["fg"]], ["acc", ["sw"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(false);  // sw itself only depends on fg, which is up
    expect(out.get("acc")).toBe(true);  // acc's only parent is in test mode
  });

  it("multi-parent: test-active parent counts as down for the all-down rule", () => {
    // sw has two FortiGate parents; one is test-active, one is up. With
    // all-down semantics, ANY parent being up keeps sw not-suppressed.
    const future = new Date(Date.now() + 30 * 60 * 1000);
    const states: SuppressionAssetState[] = [
      { id: "fg1", layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false, dependencyTestUntil: future },
      { id: "fg2", layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false },
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false },
    ];
    const parents = new Map([["sw", ["fg1", "fg2"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(false);
  });

  // Maintenance window — a parent with status="maintenance" behaves exactly
  // like an active Dependency Test overlay: confirmed-down for suppression,
  // no transparent walk to grandparents.
  it("maintenance parent treats children as dependency-down", () => {
    const states: SuppressionAssetState[] = [
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "maintenance" },
      { id: "acc", layer: 3, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "active" },
    ];
    const parents = new Map([["acc", ["sw"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(true);
    expect(out.get("sw")).toBe(false); // the maintained box itself is not suppressed
  });

  it("maintenance parent does NOT walk transparently to a healthy grandparent", () => {
    const states: SuppressionAssetState[] = [
      { id: "fg",  layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "active" },
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "maintenance" },
      { id: "acc", layer: 3, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "active" },
    ];
    const parents = new Map([["sw", ["fg"]], ["acc", ["sw"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(true);
  });

  it("multi-parent: one maintained + one healthy parent keeps the child up (all-down rule)", () => {
    const states: SuppressionAssetState[] = [
      { id: "fg1", layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "maintenance" },
      { id: "fg2", layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "active" },
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "active" },
    ];
    const parents = new Map([["sw", ["fg1", "fg2"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(false);
  });

  // Per-schedule opt-out (suppressChildren=false → maintenanceSuppressChildren
  // false on the state): the maintenance status is ignored by suppression and
  // the parent evaluates by its frozen monitorStatus.
  it("maintenance parent with suppressChildren=false leaves an up-parent's children unsuppressed", () => {
    const states: SuppressionAssetState[] = [
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "maintenance", maintenanceSuppressChildren: false },
      { id: "acc", layer: 3, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "active" },
    ];
    const parents = new Map([["acc", ["sw"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(false);
  });

  it("maintenance parent with suppressChildren=false still suppresses via its frozen down monitorStatus", () => {
    // Parent was already down when the window opened — the opt-out only
    // removes the maintenance-implies-down shortcut, not real down state.
    const states: SuppressionAssetState[] = [
      { id: "sw",  layer: 2, monitorStatus: "down", monitored: true, currentlySuppressed: false, status: "maintenance", maintenanceSuppressChildren: false },
      { id: "acc", layer: 3, monitorStatus: "up",   monitored: true, currentlySuppressed: false, status: "active" },
    ];
    const parents = new Map([["acc", ["sw"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(true);
  });

  it("maintenanceSuppressChildren=true (explicit) matches the default maintenance-down behavior", () => {
    const states: SuppressionAssetState[] = [
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "maintenance", maintenanceSuppressChildren: true },
      { id: "acc", layer: 3, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "active" },
    ];
    const parents = new Map([["acc", ["sw"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(true);
  });
});

// ─── vCenter cluster multi-parent (vMotion-safe) ────────────────────────────
// A clustered VM carries one edge per cluster-member host; all-down semantics
// suppress it only when the ENTIRE cluster is dark, so an intra-cluster
// vMotion between discovery cycles can never cause a false Dep. Down.

describe("evaluateSuppression — vCenter cluster hosts", () => {
  function st2(id: string, layer: number | null, monitorStatus: string | null, monitored = true): SuppressionAssetState {
    return { id, layer, monitorStatus, monitored, currentlySuppressed: false };
  }

  it("VM with three cluster-host parents suppresses only when all three are down", () => {
    const parents = new Map([["vm", ["h1", "h2", "h3"]]]);

    // One host down (the VM's recorded host, say) — the cluster still has
    // live members, so the VM stays unsuppressed even if placement is stale.
    let out = evaluateSuppression(
      [st2("h1", 1, "down"), st2("h2", 1, "up"), st2("h3", 1, "up"), st2("vm", 2, "down")],
      parents,
    );
    expect(out.get("vm")).toBe(false);

    // Whole cluster dark → suppressed.
    out = evaluateSuppression(
      [st2("h1", 1, "down"), st2("h2", 1, "down"), st2("h3", 1, "down"), st2("vm", 2, "down")],
      parents,
    );
    expect(out.get("vm")).toBe(true);
  });

  it("standalone-host VM suppresses when its single host is down", () => {
    const parents = new Map([["vm", ["h1"]]]);
    const out = evaluateSuppression(
      [st2("h1", 1, "down"), st2("vm", 2, "down")],
      parents,
    );
    expect(out.get("vm")).toBe(true);
  });
});
