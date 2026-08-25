/**
 * tests/unit/regionTreeRender.test.ts — the Show-regions tree module.
 *
 * public/js/region-tree.js is a browser IIFE with no module export, so it is
 * evaluated in a Node vm context and pulled off window.PolarisRegionTree — the
 * regionPills.test.ts approach.
 *
 * Two pinned behaviors matter more than the rest: a region NAME reaches HTML
 * escaped (the same contract regionPills.test.ts pins, and the reason both
 * modules take escapeHtml from the host), and a fetch that resolves AFTER the
 * pointer has left must not re-show the tooltip — otherwise a slow API leaves
 * one stuck on screen with nothing to dismiss it.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

interface OverlayRegion {
  id: string;
  name: string;
  color?: string;
  polygon?: Array<[number, number]>;
  level?: number;
  depth?: number;
  parentId?: string | null;
  childIds?: string[];
  ancestorIds?: string[];
}

interface Payload {
  regions: OverlayRegion[];
  roots?: string[];
  maxLevel?: number;
  warnings?: Array<{ kind: string; regionId: string; otherRegionId?: string; message?: string }>;
  truncated?: boolean;
}

type Tree = {
  MAX_TOOLTIP_NODES: number;
  summaryLine: (p: unknown) => string;
  childrenOf: (p: unknown, id: string | null) => OverlayRegion[];
  buildTreeHtml: (p: unknown, opts?: { maxNodes?: number }) => string;
  warningsHtml: (p: unknown) => string;
  paintOrder: (p: unknown) => OverlayRegion[];
  overlayStyle: (level: number, maxLevel: number) => Record<string, unknown>;
  attachTreeTooltip: (
    button: unknown,
    getPayload: () => Promise<unknown>,
    tip: { show: (html: string, x: number, y: number) => void; move: (x: number, y: number) => void; hide: () => void },
  ) => void;
};

const CODE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../public/js/region-tree.js"),
  "utf8",
);

function load(): Tree {
  const sandbox: Record<string, any> = { window: {}, Promise, String, Array, Number, Object };
  sandbox.window.escapeHtml = (s: string) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return sandbox.window.PolarisRegionTree as Tree;
}

/** South ⊃ {Nashville, Memphis ⊃ Bartlett}, plus a disjoint Elsewhere. */
const NESTED: Payload = {
  regions: [
    { id: "south", name: "South", color: "#4fc3f7", level: 3, depth: 0, parentId: null, childIds: ["nashville", "memphis"] },
    { id: "nashville", name: "Nashville", color: "#4ade80", level: 1, depth: 1, parentId: "south", childIds: [] },
    { id: "memphis", name: "Memphis", color: "#f59e0b", level: 2, depth: 1, parentId: "south", childIds: ["bartlett"] },
    { id: "bartlett", name: "Bartlett", color: "#a78bfa", level: 1, depth: 2, parentId: "memphis", childIds: [] },
    { id: "elsewhere", name: "Elsewhere", color: "#f472b6", level: 1, depth: 0, parentId: null, childIds: [] },
  ],
  roots: ["south", "elsewhere"],
  maxLevel: 3,
  warnings: [],
};

describe("summaryLine", () => {
  it("counts regions, top-level regions and levels", () => {
    expect(load().summaryLine(NESTED)).toBe("5 regions · 2 top-level · 3 levels");
  });

  it("states the empty case rather than rendering a blank", () => {
    expect(load().summaryLine({ regions: [] })).toBe("No regions are defined yet.");
  });

  it("does not throw on a null or malformed payload", () => {
    const t = load();
    expect(t.summaryLine(null)).toContain("No regions");
    expect(t.summaryLine({ nope: true })).toContain("No regions");
  });

  it("singularises", () => {
    const one: Payload = { regions: [{ id: "a", name: "A", level: 1, depth: 0, parentId: null }], roots: ["a"], maxLevel: 1 };
    expect(load().summaryLine(one)).toBe("1 region · 1 top-level · 1 level");
  });
});

describe("childrenOf", () => {
  it("returns the roots for a null parent, name-sorted", () => {
    expect(load().childrenOf(NESTED, null).map((r) => r.name)).toEqual(["Elsewhere", "South"]);
  });

  it("returns direct children only", () => {
    expect(load().childrenOf(NESTED, "south").map((r) => r.name)).toEqual(["Memphis", "Nashville"]);
    expect(load().childrenOf(NESTED, "memphis").map((r) => r.name)).toEqual(["Bartlett"]);
    expect(load().childrenOf(NESTED, "bartlett")).toEqual([]);
  });
});

describe("buildTreeHtml", () => {
  it("nests children inside their parent and labels each level", () => {
    const html = load().buildTreeHtml(NESTED);
    expect(html).toContain('class="rtree"');
    expect(html).toContain("Nashville");
    expect(html).toContain("L3");
    // Bartlett is two levels in, so its row sits inside two nested containers.
    const bartlettAt = html.indexOf("Bartlett");
    const memphisAt = html.indexOf("Memphis");
    expect(memphisAt).toBeGreaterThan(-1);
    expect(bartlettAt).toBeGreaterThan(memphisAt);
    expect((html.match(/rtree-children/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it("annotates a container with how many regions are inside it", () => {
    expect(load().buildTreeHtml(NESTED)).toContain("2 inside");
  });

  it("ESCAPES a region name", () => {
    const nasty: Payload = {
      regions: [{ id: "x", name: '<script>alert(1)</script>', level: 1, depth: 0, parentId: null }],
      roots: ["x"],
      maxLevel: 1,
    };
    const html = load().buildTreeHtml(nasty);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("caps the node count and says how many it left out", () => {
    const many: OverlayRegion[] = [];
    for (let i = 0; i < 70; i++) many.push({ id: "r" + i, name: "R" + i, level: 1, depth: 0, parentId: null });
    const html = load().buildTreeHtml({ regions: many, roots: many.map((r) => r.id), maxLevel: 1 }, { maxNodes: 10 });
    expect(html).toContain("+60 more not shown");
  });

  it("renders a stated empty message for no regions", () => {
    expect(load().buildTreeHtml({ regions: [] })).toContain("No regions are defined yet");
  });

  it("does not throw on a null payload", () => {
    expect(() => load().buildTreeHtml(null)).not.toThrow();
  });
});

describe("warningsHtml", () => {
  it("is empty when there is nothing to say", () => {
    expect(load().warningsHtml(NESTED)).toBe("");
    expect(load().warningsHtml(null)).toBe("");
  });

  it("names both regions in a pairwise finding", () => {
    const p: Payload = {
      ...NESTED,
      warnings: [{ kind: "overlap", regionId: "nashville", otherRegionId: "memphis" }],
    };
    const html = load().warningsHtml(p);
    expect(html).toContain("overlap");
    expect(html).toContain("Nashville");
    expect(html).toContain("Memphis");
  });

  it("ignores warning kinds an operator cannot act on", () => {
    const p: Payload = { ...NESTED, warnings: [{ kind: "ambiguous-parent", regionId: "nashville" }] };
    expect(load().warningsHtml(p)).toBe("");
  });
});

describe("paintOrder and overlayStyle", () => {
  it("paints outermost first so children stay on top and clickable", () => {
    const order = load().paintOrder(NESTED).map((r) => r.name);
    expect(order.indexOf("South")).toBeLessThan(order.indexOf("Nashville"));
    expect(order.indexOf("Memphis")).toBeLessThan(order.indexOf("Bartlett"));
  });

  it("gives a permanent label only to the outermost level of a nested set", () => {
    const t = load();
    expect(t.overlayStyle(3, 3).labelPermanent).toBe(true);
    expect(t.overlayStyle(1, 3).labelPermanent).toBe(false);
  });

  it("does not label anything permanently when nothing is nested", () => {
    // With one flat level, "outermost" is every region — labelling them all
    // permanently would paper the map over.
    expect(load().overlayStyle(1, 1).labelPermanent).toBe(false);
  });

  it("keeps fill opacity low because nesting stacks it", () => {
    expect(load().overlayStyle(2, 3).fillOpacity).toBeLessThanOrEqual(0.08);
  });
});

describe("attachTreeTooltip", () => {
  /** Minimal EventTarget stand-in — no DOM needed. */
  function fakeButton() {
    const handlers: Record<string, Array<(ev: any) => void>> = {};
    return {
      addEventListener(name: string, fn: (ev: any) => void) {
        (handlers[name] ||= []).push(fn);
      },
      fire(name: string, ev: any = {}) {
        for (const fn of handlers[name] ?? []) fn(ev);
      },
    };
  }

  function fakeTip() {
    return { show: vi.fn(), move: vi.fn(), hide: vi.fn() };
  }

  it("shows a loading frame immediately, then swaps in the tree", async () => {
    const t = load();
    const btn = fakeButton();
    const tip = fakeTip();
    t.attachTreeTooltip(btn, async () => NESTED, tip);

    btn.fire("mouseenter", { clientX: 10, clientY: 20 });
    expect(tip.show).toHaveBeenCalledTimes(1);
    expect(tip.show.mock.calls[0]![0]).toContain("Loading regions…");

    await new Promise((r) => setTimeout(r, 0));
    expect(tip.show).toHaveBeenCalledTimes(2);
    expect(tip.show.mock.calls[1]![0]).toContain("Nashville");
  });

  it("hides on mouseleave", async () => {
    const t = load();
    const btn = fakeButton();
    const tip = fakeTip();
    t.attachTreeTooltip(btn, async () => NESTED, tip);
    btn.fire("mouseenter", {});
    btn.fire("mouseleave", {});
    expect(tip.hide).toHaveBeenCalled();
  });

  it("does NOT re-show when the fetch resolves after mouseleave", async () => {
    const t = load();
    const btn = fakeButton();
    const tip = fakeTip();
    let release: (v: unknown) => void = () => {};
    const slow = new Promise((r) => { release = r; });
    t.attachTreeTooltip(btn, () => slow.then(() => NESTED) as Promise<unknown>, tip);

    btn.fire("mouseenter", {});
    btn.fire("mouseleave", {});
    release(null);
    await new Promise((r) => setTimeout(r, 0));

    // Only the loading frame ever showed; the late payload was discarded.
    expect(tip.show).toHaveBeenCalledTimes(1);
    expect(tip.show.mock.calls[0]![0]).toContain("Loading regions…");
  });

  it("reports a failed load in the tooltip instead of leaving the loading frame up", async () => {
    const t = load();
    const btn = fakeButton();
    const tip = fakeTip();
    t.attachTreeTooltip(btn, async () => { throw new Error("403"); }, tip);
    btn.fire("mouseenter", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(tip.show.mock.calls[1]![0]).toContain("could not be loaded");
  });

  it("repositions on mousemove only while open", () => {
    const t = load();
    const btn = fakeButton();
    const tip = fakeTip();
    t.attachTreeTooltip(btn, async () => NESTED, tip);
    btn.fire("mousemove", { clientX: 5, clientY: 5 });
    expect(tip.move).not.toHaveBeenCalled();
    btn.fire("mouseenter", {});
    btn.fire("mousemove", { clientX: 5, clientY: 5 });
    expect(tip.move).toHaveBeenCalledWith(5, 5);
  });

  it("is keyboard reachable via focus/blur", async () => {
    const t = load();
    const btn = fakeButton();
    const tip = fakeTip();
    t.attachTreeTooltip(btn, async () => NESTED, tip);
    btn.fire("focus", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(tip.show.mock.calls.length).toBeGreaterThanOrEqual(2);
    btn.fire("blur", {});
    expect(tip.hide).toHaveBeenCalled();
  });

  it("does nothing when given no button or no tip surface", () => {
    const t = load();
    expect(() => t.attachTreeTooltip(null, async () => NESTED, fakeTip())).not.toThrow();
    expect(() => t.attachTreeTooltip(fakeButton(), async () => NESTED, null as any)).not.toThrow();
  });
});
