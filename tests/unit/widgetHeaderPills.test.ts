/**
 * tests/unit/widgetHeaderPills.test.ts
 *
 * Unit tests for the dashboard widgets' header count pills —
 * setHeaderPills() / setHeaderCount() / alertSeverityCounts() /
 * setHeaderSeverityCounts() in public/js/widgets/index.js. Same harness as
 * tests/unit/widgetSeverityFilter.test.ts: the browser IIFE is eval'd into a
 * happy-dom window with the app-shell globals stubbed.
 *
 * The behaviour under test is what the operator reads off a widget title: one
 * pill per ACTIVE alert severity, colored to that severity and ordered most
 * severe first, instead of a single total colored to the worst of them.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

interface Row { hostname: string; alertSeverity?: string; level?: string }
interface Pill { text: string | number; className?: string; title?: string }

let W: {
  ALERT_SEVERITY_RANK: Record<string, number>;
  setHeaderPills: (el: unknown, pills: Pill[] | null) => void;
  setHeaderCount: (el: unknown, count: number, severity?: string | null) => void;
  alertSeverityCounts: <T>(rows: T[] | null, sevOf?: (r: T) => string | undefined) => Array<{ severity: string; count: number }>;
  setHeaderSeverityCounts: <T>(el: unknown, rows: T[] | null, opts?: { unalerted?: string; severityOf?: (r: T) => string | undefined }) => void;
  setHeaderTierCounts: <T>(el: unknown, rows: T[] | null, opts: {
    keyOf?: (r: T) => string | undefined;
    order: string[];
    classOf?: (k: string) => string;
    noun?: string;
  }) => void;
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
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  (0, eval)(code);
  W = (win as unknown as { PolarisWidgets: typeof W }).PolarisWidgets;
});

/** A widget shell: the title the pills land on + the body element widgets pass. */
function mountWidget() {
  const article = doc.createElement("article");
  article.className = "dashboard-widget";
  article.innerHTML = '<h3 class="dashboard-widget-title">Down Interfaces</h3><div class="body"></div>';
  doc.body.appendChild(article);
  const el = article.querySelector(".body") as unknown as HTMLElement;
  const title = article.querySelector(".dashboard-widget-title") as unknown as HTMLElement;
  const pills = () =>
    Array.from(title.querySelectorAll(".widget-header-count .widget-pill")).map((p: any) => ({
      text: p.textContent,
      cls: (p.getAttribute("class") || "").replace("widget-pill ", ""),
      title: p.getAttribute("title"),
    }));
  return { el, title, pills, host: () => title.querySelector(".widget-header-count") };
}

const rows = (): Row[] => [
  { hostname: "quiet-1" },
  { hostname: "quiet-2" },
  { hostname: "warned", alertSeverity: "warning" },
  { hostname: "serious-1", alertSeverity: "serious" },
  { hostname: "serious-2", alertSeverity: "serious" },
  { hostname: "critical-1", alertSeverity: "critical" },
];

describe("alertSeverityCounts", () => {
  it("counts each severity and orders most severe first", () => {
    expect(W.alertSeverityCounts(rows())).toEqual([
      { severity: "critical", count: 1 },
      { severity: "serious", count: 2 },
      { severity: "warning", count: 1 },
    ]);
  });

  it("excludes rows with no alert, and severities the rank ladder doesn't know", () => {
    expect(W.alertSeverityCounts([{ hostname: "a" }, { hostname: "b", alertSeverity: "made-up" }])).toEqual([]);
    expect(W.alertSeverityCounts(null)).toEqual([]);
  });

  it("honours a custom severityOf (the Active Alerts widget's Event level)", () => {
    const events: Row[] = [
      { hostname: "e-info", level: "info" },
      { hostname: "e-err", level: "error" },
      { hostname: "e-err2", level: "error" },
    ];
    expect(W.alertSeverityCounts(events, (r) => r.level)).toEqual([
      { severity: "error", count: 2 },
      { severity: "info", count: 1 },
    ]);
  });
});

describe("setHeaderPills", () => {
  it("renders one pill per entry with its class and tooltip", () => {
    const { el, pills } = mountWidget();
    W.setHeaderPills(el, [
      { text: 3, className: "widget-pill-red", title: "3 with an active critical alert" },
      { text: 7, className: "widget-pill-orange" },
    ]);
    expect(pills()).toEqual([
      { text: "3", cls: "widget-pill-red", title: "3 with an active critical alert" },
      { text: "7", cls: "widget-pill-orange", title: null },
    ]);
  });

  it("re-renders in place on every call and removes the host when emptied", () => {
    const { el, pills, host } = mountWidget();
    W.setHeaderPills(el, [{ text: 1, className: "widget-pill-red" }]);
    const first = host();
    W.setHeaderPills(el, [{ text: 2, className: "widget-pill-orange" }]);
    expect(host()).toBe(first); // same container, rewritten contents
    expect(pills()).toEqual([{ text: "2", cls: "widget-pill-orange", title: null }]);
    W.setHeaderPills(el, []);
    expect(host()).toBeNull();
    W.setHeaderPills(el, null);
    expect(host()).toBeNull();
  });

  it("no-ops outside a dashboard shell (the widget-library preview)", () => {
    const orphan = doc.createElement("div");
    expect(() => W.setHeaderPills(orphan, [{ text: 1 }])).not.toThrow();
  });

  it("setHeaderCount still stamps a single pill, colored to the severity", () => {
    const { el, pills, host } = mountWidget();
    W.setHeaderCount(el, 14, "serious");
    expect(pills()).toEqual([{ text: "14", cls: "widget-pill-orange", title: null }]);
    // No severity → the widgets' generic red "these are down" count.
    W.setHeaderCount(el, 14, null);
    expect(pills()[0].cls).toBe("widget-pill-red");
    // 0 clears it.
    W.setHeaderCount(el, 0, "critical");
    expect(host()).toBeNull();
  });
});

describe("setHeaderSeverityCounts", () => {
  it("stamps a pill per severity plus a grey bucket that makes the pills sum to the total", () => {
    const { el, pills } = mountWidget();
    W.setHeaderSeverityCounts(el, rows());
    expect(pills()).toEqual([
      { text: "1", cls: "widget-pill-red", title: "1 with an active critical alert" },
      { text: "2", cls: "widget-pill-orange", title: "2 with an active serious alert" },
      { text: "1", cls: "widget-pill-amber", title: "1 with an active warning alert" },
      { text: "2", cls: "widget-pill-neutral", title: "2 with no active alert" },
    ]);
    expect(pills().reduce((n, p) => n + Number(p.text), 0)).toBe(rows().length);
  });

  it("drops the grey bucket when every row is alerting", () => {
    const { el, pills } = mountWidget();
    W.setHeaderSeverityCounts(el, rows().filter((r) => r.alertSeverity));
    expect(pills().map((p) => p.cls)).toEqual(["widget-pill-red", "widget-pill-orange", "widget-pill-amber"]);
  });

  it("falls back to the plain red total when nothing is alerting", () => {
    const { el, pills } = mountWidget();
    W.setHeaderSeverityCounts(el, [{ hostname: "a" }, { hostname: "b" }]);
    expect(pills()).toEqual([{ text: "2", cls: "widget-pill-red", title: null }]);
  });

  it("omits unalerted rows entirely in 'omit' mode (the ranked top-N widgets)", () => {
    const { el, pills, host } = mountWidget();
    W.setHeaderSeverityCounts(el, rows(), { unalerted: "omit" });
    expect(pills()).toEqual([
      { text: "1", cls: "widget-pill-red", title: "1 with an active critical alert" },
      { text: "2", cls: "widget-pill-orange", title: "2 with an active serious alert" },
      { text: "1", cls: "widget-pill-amber", title: "1 with an active warning alert" },
    ]);
    // A top-N set where nothing alerts shows no pill at all — the row count
    // there is just the operator's Row limit, not a fleet total.
    W.setHeaderSeverityCounts(el, [{ hostname: "a" }], { unalerted: "omit" });
    expect(host()).toBeNull();
  });

  it("clears the pills when the set empties", () => {
    const { el, host } = mountWidget();
    W.setHeaderSeverityCounts(el, rows());
    expect(host()).not.toBeNull();
    W.setHeaderSeverityCounts(el, []);
    expect(host()).toBeNull();
  });
});

// Capacity Health's ok/watch/amber/red reasons — a ladder of its own that must
// NOT be folded into ALERT_SEVERITY_RANK (a capacity "red" is a disk tier, not a
// notification severity).
describe("setHeaderTierCounts", () => {
  const CAP = {
    order: ["red", "amber", "watch", "ok"],
    classOf: (k: string) => "widget-pill-" + k,
    noun: "reason(s)",
  };
  const reasons = (): Array<{ severity: string }> => [
    { severity: "amber" }, { severity: "red" }, { severity: "watch" }, { severity: "amber" },
  ];

  it("counts each tier in the caller's order, most severe first", () => {
    const { el, pills } = mountWidget();
    W.setHeaderTierCounts(el, reasons(), CAP);
    expect(pills()).toEqual([
      { text: "1", cls: "widget-pill-red", title: "1 reason(s) at red" },
      { text: "2", cls: "widget-pill-amber", title: "2 reason(s) at amber" },
      { text: "1", cls: "widget-pill-watch", title: "1 reason(s) at watch" },
    ]);
  });

  it("ignores tiers outside the caller's ladder and clears on an empty set", () => {
    const { el, pills, host } = mountWidget();
    W.setHeaderTierCounts(el, [{ severity: "critical" }, { severity: "" }], CAP);
    expect(pills()).toEqual([]);
    expect(host()).toBeNull();
    W.setHeaderTierCounts(el, null, CAP);
    expect(host()).toBeNull();
  });
});
