/**
 * tests/unit/widgetSeverityFilter.test.ts
 *
 * Unit tests for the dashboard widgets' shared "Minimum severity" display
 * filter — minSeverityRank(), filterByMinSeverity(), severityTierForRank(),
 * minSeverityEmptyText() and minSeverityOptionsHTML() in
 * public/js/widgets/index.js, plus the gear-popover control
 * renderMinSeverityConfig() writes. Those live in a browser IIFE (no module
 * export), so the file is eval'd into a happy-dom window with the app-shell
 * globals stubbed and the helpers pulled off window.PolarisWidgets — same
 * approach as tests/unit/automationsWizardDom.test.ts.
 *
 * The behaviour under test is what the operator was promised: the tier ladder
 * matches the alert severity ranks the server attaches, and any tier past
 * "All rows" hides rows carrying no active alert.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

interface Tier { key: string; label: string; minRank: number }
interface Row { hostname: string; alertSeverity?: string; severity?: string }
interface Cfg { minSeverity?: string }

let W: {
  SEVERITY_TIERS: Tier[];
  ALERT_SEVERITY_RANK: Record<string, number>;
  minSeverityRank: (c?: Cfg) => number;
  filterByMinSeverity: <T>(rows: T[] | null, c?: Cfg, sevOf?: (r: T) => string | undefined) => T[];
  severityTierForRank: (rank: number) => string;
  minSeverityEmptyText: (c?: Cfg) => string | null;
  minSeverityOptionsHTML: (current?: string) => string;
  renderMinSeverityConfig: (el: any, c: Cfg, onChange: (k: string, v: unknown) => void, hint?: string) => void;
};
const g = globalThis as Record<string, unknown>;
let doc: Window["document"];

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(resolve(here, "../../public/js/widgets/index.js"), "utf8");
  const win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  // escapeHtml is app.js's; `api` / `downloadCsv` are only touched from inside
  // the fetch + export handlers, which these tests don't reach.
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  (0, eval)(code);
  W = (win as unknown as { PolarisWidgets: typeof W }).PolarisWidgets;
});

const rows = (): Row[] => [
  { hostname: "no-alert" },
  { hostname: "noticed", alertSeverity: "notice" },
  { hostname: "informed", alertSeverity: "informational" },
  { hostname: "warned", alertSeverity: "warning" },
  { hostname: "serious-one", alertSeverity: "serious" },
  { hostname: "critical-one", alertSeverity: "critical" },
];
const names = (r: Row[]) => r.map((x) => x.hostname);

describe("severity tier ladder", () => {
  it("orders least→most severe with ranks matching ALERT_SEVERITY_RANK", () => {
    expect(W.SEVERITY_TIERS.map((t) => t.key)).toEqual([
      "all", "notice", "informational", "warning", "serious", "critical",
    ]);
    const ranks = W.SEVERITY_TIERS.map((t) => t.minRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // Every tier past "all" names a severity the shared rank map knows, at the
    // same rank — the export menu and the display filter share this list, so a
    // drift here would silently disagree about what "Serious and up" means.
    W.SEVERITY_TIERS.slice(1).forEach((t) => {
      expect(W.ALERT_SEVERITY_RANK[t.key]).toBe(t.minRank);
    });
  });

  it("minSeverityRank treats unset / 'all' / junk as no filter", () => {
    expect(W.minSeverityRank()).toBe(0);
    expect(W.minSeverityRank({})).toBe(0);
    expect(W.minSeverityRank({ minSeverity: "all" })).toBe(0);
    expect(W.minSeverityRank({ minSeverity: "not-a-tier" })).toBe(0);
    expect(W.minSeverityRank({ minSeverity: "serious" })).toBe(4);
  });
});

describe("filterByMinSeverity", () => {
  it("passes everything through at tier 'all' (and on an unset config)", () => {
    expect(names(W.filterByMinSeverity(rows(), {}))).toEqual(names(rows()));
    expect(names(W.filterByMinSeverity(rows(), { minSeverity: "all" }))).toEqual(names(rows()));
  });

  it("keeps rows at or above the tier and drops un-alerted rows", () => {
    expect(names(W.filterByMinSeverity(rows(), { minSeverity: "warning" })))
      .toEqual(["warned", "serious-one", "critical-one"]);
    expect(names(W.filterByMinSeverity(rows(), { minSeverity: "serious" })))
      .toEqual(["serious-one", "critical-one"]);
    expect(names(W.filterByMinSeverity(rows(), { minSeverity: "critical" })))
      .toEqual(["critical-one"]);
    // Even the lowest real tier hides a row with no active alert — the
    // documented consequence of setting any minimum.
    expect(names(W.filterByMinSeverity(rows(), { minSeverity: "notice" })))
      .not.toContain("no-alert");
  });

  it("honours a custom severityOf (the Active Alerts widget's Event level)", () => {
    const events: Row[] = [
      { hostname: "e-info", severity: "info" },
      { hostname: "e-warn", severity: "warning" },
      { hostname: "e-err", severity: "error" },
    ];
    const sevOf = (r: Row) => r.severity;
    expect(names(W.filterByMinSeverity(events, { minSeverity: "warning" }, sevOf)))
      .toEqual(["e-warn", "e-err"]);
    // info ranks with informational; error ranks with critical.
    expect(names(W.filterByMinSeverity(events, { minSeverity: "informational" }, sevOf)))
      .toEqual(["e-info", "e-warn", "e-err"]);
    expect(names(W.filterByMinSeverity(events, { minSeverity: "critical" }, sevOf)))
      .toEqual(["e-err"]);
  });

  it("never mutates or aliases the caller's array, and tolerates null", () => {
    const src = rows();
    const out = W.filterByMinSeverity(src, { minSeverity: "all" });
    expect(out).not.toBe(src);
    out.pop();
    expect(src).toHaveLength(6);
    expect(W.filterByMinSeverity(null, { minSeverity: "warning" })).toEqual([]);
  });
});

describe("severityTierForRank", () => {
  it("round-trips every tier's own rank", () => {
    W.SEVERITY_TIERS.forEach((t) => expect(W.severityTierForRank(t.minRank)).toBe(t.key));
  });

  it("folds a rank floor down to the tier at or below it", () => {
    expect(W.severityTierForRank(0)).toBe("all");
    expect(W.severityTierForRank(99)).toBe("critical");
    // Active Alerts' legacy ["warning","error"] config → lowest rank 3.
    expect(W.severityTierForRank(W.ALERT_SEVERITY_RANK.warning)).toBe("warning");
    // …and ["info", …] → rank 2, which is the informational tier.
    expect(W.severityTierForRank(W.ALERT_SEVERITY_RANK.info)).toBe("informational");
  });
});

describe("minSeverityEmptyText", () => {
  it("returns null at tier 'all' so the widget keeps its own empty text", () => {
    expect(W.minSeverityEmptyText({})).toBeNull();
    expect(W.minSeverityEmptyText({ minSeverity: "all" })).toBeNull();
  });

  it("names the tier so an emptied widget doesn't read as 'nothing is wrong'", () => {
    expect(W.minSeverityEmptyText({ minSeverity: "serious" })).toBe("No rows at or above serious severity");
    expect(W.minSeverityEmptyText({ minSeverity: "critical" })).toBe("No rows at or above critical severity");
  });
});

describe("minSeverityOptionsHTML", () => {
  it("emits one option per tier and marks the current one", () => {
    const html = W.minSeverityOptionsHTML("serious");
    expect((html.match(/<option /g) || []).length).toBe(W.SEVERITY_TIERS.length);
    expect(html).toContain('<option value="serious" selected>Serious and up</option>');
    expect(html).toContain('<option value="all">All rows</option>');
  });

  it("defaults to 'all' when unset", () => {
    expect(W.minSeverityOptionsHTML()).toContain('<option value="all" selected>');
  });
});

describe("renderMinSeverityConfig (gear popover control)", () => {
  function mount(config: Cfg, hint?: string) {
    const el = doc.createElement("div");
    // The control APPENDS, so a widget can render its own selects first.
    el.innerHTML = '<label>Row limit</label><select data-k="rowLimit"></select>';
    const changes: Array<[string, unknown]> = [];
    W.renderMinSeverityConfig(el, config, (k, v) => changes.push([k, v]), hint);
    return { el, changes, sel: el.querySelector("[data-minsev]") as any, note: el.querySelector("[data-minsev-hint]") as any };
  }

  it("appends a tier select seeded from the config, keeping prior controls", () => {
    const { el } = mount({ minSeverity: "serious" });
    expect(el.querySelector('[data-k="rowLimit"]')).toBeTruthy();
    const opts = Array.from(el.querySelectorAll("[data-minsev] option")) as any[];
    expect(opts).toHaveLength(W.SEVERITY_TIERS.length);
    // Assert the `selected` ATTRIBUTE, not select.value: happy-dom reports
    // selectedIndex 1 for any markup-selected option past the first, so .value
    // is unusable here (browsers get this right — it's an environment quirk).
    expect(opts.filter((o) => o.hasAttribute("selected")).map((o) => o.getAttribute("value"))).toEqual(["serious"]);
  });

  it("hides the caveat hint at tier 'all' and shows it once a minimum is picked", () => {
    const { el, sel, note, changes } = mount({});
    expect((el.querySelector('[data-minsev] option[value="all"]') as any).hasAttribute("selected")).toBe(true);
    expect(note.style.display).toBe("none");
    sel.value = "warning";
    sel.dispatchEvent(new (doc.defaultView as any).Event("change"));
    expect(changes).toEqual([["minSeverity", "warning"]]);
    expect(note.style.display).toBe("");
    // …and back off again.
    sel.value = "all";
    sel.dispatchEvent(new (doc.defaultView as any).Event("change"));
    expect(changes[1]).toEqual(["minSeverity", "all"]);
    expect(note.style.display).toBe("none");
  });

  it("renders a per-widget hint when given one", () => {
    const { note } = mount({ minSeverity: "critical" }, "Only nodes with an active alert are shown.");
    expect(note.textContent).toBe("Only nodes with an active alert are shown.");
  });
});
