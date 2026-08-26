/**
 * tests/unit/widgetAssetTypes.test.ts
 *
 * The dashboard widgets' asset-type vocabulary — `BUILTIN_ASSET_TYPES`,
 * `ASSET_TYPE_LABELS` / `ASSET_TYPE_COLORS` and `effectiveAssetTypes` in
 * public/js/widgets/index.js, plus the Assets-by-type chart that reads them
 * (public/js/widgets/assetTypes.js). Same harness as widgetActiveAlerts:
 * index.js is eval'd into a happy-dom window with the app-shell globals
 * stubbed, then the widget module registers itself and is pulled back off
 * the registry.
 *
 * The property under test is that a type the REGISTRY knows about is a type
 * the dashboard can see, and the three ways that stopped being true:
 *   • the widgets kept their own copy of the built-in list and it fell two
 *     names behind (`hypervisor`, `kubernetes_cluster`). The server derives
 *     the HIDDEN set as (its built-ins − the ones the widget sent), so a name
 *     missing from the widget's copy is one the operator can never filter on.
 *     The first test is a straight parity guard against the registry constant
 *     — it is the whole point of this file.
 *   • the stored filter is the ENABLED list, so a config saved before a new
 *     built-in existed doesn't mention it — which reads identically to
 *     "operator switched it off". Widening an all-on legacy config is what
 *     keeps adding a built-in from silently hiding it everywhere.
 *   • the chart mapped over the LABEL map's keys rather than the rows, so an
 *     unknown type was dropped from the drawing while still counting toward
 *     the total: the pie came up a wedge short and every percentage read low.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";
import { BUILT_IN_ASSET_TYPES } from "../../src/utils/assetTypes.js";

interface ChartModule {
  type: string;
  renderInstance: (
    el: unknown,
    config: Record<string, unknown>,
    data: unknown,
    ctx: { onUnmount: (fn: () => void) => void },
  ) => void;
}
interface Widgets {
  BUILTIN_ASSET_TYPES: string[];
  ASSET_TYPE_LABELS: Record<string, string>;
  ASSET_TYPE_COLORS: Record<string, string>;
  effectiveAssetTypes: (list: unknown) => string[] | null;
  getByType: (t: string) => ChartModule;
}

/** The eight types that existed before the registry grew. */
const LEGACY = [
  "server", "switch", "router", "firewall",
  "workstation", "printer", "access_point", "other",
];

let W: Widgets;
let doc: Window["document"];
const g = globalThis as Record<string, unknown>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.timeAgo = () => "5m ago";
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/index.js"), "utf8"));
  W = (win as unknown as { PolarisWidgets: Widgets }).PolarisWidgets;
  g.PolarisWidgets = W;
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/assetTypes.js"), "utf8"));
});

describe("widget asset-type vocabulary vs the registry", () => {
  // The drift-catcher. If someone adds a built-in to the registry without
  // touching the widgets, this fails and names the missing type.
  it("BUILTIN_ASSET_TYPES matches BUILT_IN_ASSET_TYPES exactly, in order", () => {
    expect(W.BUILTIN_ASSET_TYPES).toEqual([...BUILT_IN_ASSET_TYPES]);
  });

  it("every built-in has a display label", () => {
    const missing = BUILT_IN_ASSET_TYPES.filter((t) => !W.ASSET_TYPE_LABELS[t]);
    expect(missing).toEqual([]);
  });

  it("every built-in has a chart color", () => {
    const missing = BUILT_IN_ASSET_TYPES.filter((t) => !W.ASSET_TYPE_COLORS[t]);
    expect(missing).toEqual([]);
  });

  it("carries the two built-ins that were missing (hypervisor, kubernetes_cluster)", () => {
    expect(W.BUILTIN_ASSET_TYPES).toContain("hypervisor");
    expect(W.BUILTIN_ASSET_TYPES).toContain("kubernetes_cluster");
  });
});

describe("effectiveAssetTypes — reading a stored filter in today's terms", () => {
  it("leaves an unset filter unfiltered", () => {
    expect(W.effectiveAssetTypes(undefined)).toBeNull();
    expect(W.effectiveAssetTypes(null)).toBeNull();
  });

  // The regression that matters: a config that was all-on when it was saved
  // must not become a NARROWING the moment a built-in is added, or the server
  // starts hiding the types that config never heard of.
  it("widens an all-on legacy config to every current built-in", () => {
    expect(W.effectiveAssetTypes(LEGACY)).toEqual([...BUILT_IN_ASSET_TYPES]);
  });

  it("widened all-on is not a strict subset, so no filter param is sent", () => {
    const resolved = W.effectiveAssetTypes(LEGACY)!;
    expect(resolved.length).toBe(W.BUILTIN_ASSET_TYPES.length);
  });

  it("passes a deliberate narrowing through untouched", () => {
    expect(W.effectiveAssetTypes(["server", "switch"])).toEqual(["server", "switch"]);
  });

  it("passes a post-upgrade pick through untouched", () => {
    const pick = [...LEGACY.slice(0, 7), "hypervisor"];
    expect(W.effectiveAssetTypes(pick)).toEqual(pick);
  });
});

describe("Assets-by-type chart renders types the label map doesn't know", () => {
  const rows = [
    { assetType: "server", count: 10 },
    { assetType: "kubernetes_cluster", count: 5 },
    { assetType: "plc_controller", count: 5 }, // operator-added custom type
  ];

  function render(chartStyle: string) {
    const el = doc.createElement("div");
    W.getByType("assetTypes").renderInstance(
      el, { chartStyle, hiddenTypes: [] }, rows, { onUnmount: () => {} },
    );
    return el;
  }

  it("draws a newer built-in with its label", () => {
    expect(render("pie").innerHTML).toContain("K8s Cluster");
  });

  it("draws an operator-added custom type, humanized from its stored name", () => {
    expect(render("pie").innerHTML).toContain("Plc Controller");
  });

  it("legends every type present, not just the known ones", () => {
    const hits = render("pie").innerHTML.match(/dash-pie-legend-item/g) || [];
    expect(hits.length).toBe(3);
  });

  // 10/5/5 of 20 = 50/25/25. Before the fix the two unknown types were dropped
  // from the drawing but kept in the total, so server read 50% and the
  // remaining half of the circle was simply absent.
  it("takes percentages from the rows it actually draws", () => {
    const html = render("pie").innerHTML;
    expect(html).toContain("50%");
    expect(html).toContain("25%");
  });

  it("bars every type present, scaled against a visible max", () => {
    const hits = render("bar").innerHTML.match(/util-bar-fill/g) || [];
    expect(hits.length).toBe(3);
  });

  it("still honors the gear's hidden-types pick", () => {
    const el = doc.createElement("div");
    W.getByType("assetTypes").renderInstance(
      el, { chartStyle: "pie", hiddenTypes: ["kubernetes_cluster"] }, rows, { onUnmount: () => {} },
    );
    expect(el.innerHTML).not.toContain("K8s Cluster");
    expect(el.innerHTML).toContain("Plc Controller");
  });
});
