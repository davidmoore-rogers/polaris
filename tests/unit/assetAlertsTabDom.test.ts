/**
 * tests/unit/assetAlertsTabDom.test.ts — the asset-details Alerts tab's active
 * list (public/js/assets.js).
 *
 * The tab shipped as a per-row surface, which held up only while an asset had
 * one alert. A per-interface automation on a switch that loses its uplink
 * raises one alert per pinned port, all in the same minute, all rendering the
 * automation's one message template — so the operator saw two dozen identical
 * rows, no way to tell which port each was about, and no way to see that
 * clearing one had done anything.
 *
 * What's pinned here is what makes that list usable and would rot silently:
 *  - the dimension column (the interface / sensor the alert is ABOUT), since
 *    without it the rows are genuinely indistinguishable;
 *  - the empty-state colspan tracking the permission-dependent column count;
 *  - equal-timestamp ordering by dimension, numerically (port2 before port10);
 *  - the select/bulk wiring, including that a reload does NOT stack a second
 *    handler on the persistent bulk buttons — that bug fires N batches on the
 *    Nth click, and clearing twice as many alerts as asked is not recoverable
 *    from the UI;
 *  - action toasts reporting the SERVER's count, which is how "I clicked Clear
 *    and nothing happened" becomes "that alert was already cleared".
 *
 * assets.js is a ~17k-line browser script with no module boundary, so the
 * functions under test are sliced out by name and eval'd with the app-shell
 * globals stubbed — the approach of tests/unit/assetInterfacesTableDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `[async ]function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex(
    (l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`),
  );
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

const FN_NAMES = [
  "_assetAlertTableShape",
  "_assetNotificationsTabHTML",
  "_sortAssetAlerts",
  "_loadAssetNotificationsTab",
  "_wireAssetAlertSelection",
  "_alertCountLabel",
  "_acknowledgeAssetAlert",
  "_clearAssetAlert",
  "_bulkAcknowledgeAssetAlerts",
  "_bulkClearAssetAlerts",
];

/** Two ports of one switch, down together — the shape that motivated all this. */
function makeAlerts() {
  return [
    { id: "n2", severity: "serious", message: "LAKESIDE-148F-1: a monitored interface is down", dimension: "port10", metric: "ifOperStatus", triggeredAt: "2026-07-23T14:50:00Z", acknowledged: false },
    { id: "n1", severity: "serious", message: "LAKESIDE-148F-1: a monitored interface is down", dimension: "port2", metric: "ifOperStatus", triggeredAt: "2026-07-23T14:50:00Z", acknowledged: false },
    { id: "n0", severity: "warning", message: "LAKESIDE-148F-1 is down", dimension: null, metric: "monitorStatus", triggeredAt: "2026-07-22T14:50:00Z", acknowledged: true, acknowledgedBy: "jsmith", acknowledgedAt: "2026-07-22T15:00:00Z" },
  ];
}

interface Ctx {
  acked: { ids: string[]; note?: string }[];
  cleared: string[][];
  toasts: { msg: string; type: string }[];
  ackResult: () => any;
  clearResult: () => any;
}

let ctx: Ctx;

/** Mount the tab shell and run one load against the stubbed API. */
async function mount(opts?: { perm?: string; alerts?: any[] }) {
  const perm = opts?.perm ?? "fullwrite";
  const RANK: Record<string, number> = { none: 0, read: 1, write: 2, fullwrite: 3 };
  g.permAtLeast = (_key: string, level: string) => RANK[perm] >= RANK[level];
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g.showToast = (msg: string, type?: string) => ctx.toasts.push({ msg, type: type || "success" });
  g.showConfirm = vi.fn(async () => true);
  g.api = {
    assets: { alerts: vi.fn(async () => ({ active: opts?.alerts ?? makeAlerts(), matchingRules: [] })) },
    alerts: {
      acknowledge: vi.fn(async (ids: string[], note?: string) => { ctx.acked.push({ ids, note }); return ctx.ackResult(); }),
      clear: vi.fn(async (ids: string[]) => { ctx.cleared.push(ids); return ctx.clearResult(); }),
    },
  };
  // _loadAssetNotificationsTab's other half (the matching-automations table) is
  // out of scope here; stub the two hooks it reaches for.
  g._assetRuleSentences = () => Promise.resolve(null);
  g._renderAssetRuleRows = vi.fn();

  document.body.innerHTML = `<div id="tab">${g._assetNotificationsTabHTML()}</div>`;
  g._loadAssetNotificationsTab("A1");
  await new Promise((r) => setTimeout(r, 0));
}

// The sliced functions call each other by name, so they have to land on
// globalThis rather than in a Function body's scope.
const SRC = FN_NAMES.map(fnSrc).join("\n") + "\n" + FN_NAMES.map((n) => `globalThis.${n} = ${n};`).join("\n");

beforeEach(() => {
  ctx = {
    acked: [], cleared: [], toasts: [],
    ackResult: () => ({ acknowledged: 1 }),
    clearResult: () => ({ cleared: 1 }),
  };
  // Owned by the suite, not by mount(), so a test can set its return value
  // before mounting without having it replaced underneath.
  g.window.prompt = vi.fn(() => "");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
});

const rows = () => Array.from(document.querySelectorAll("#asset-notif-active-tbody tr"));
const cell = (tr: Element, i: number) => (tr.children[i] as HTMLElement).textContent!.trim();

describe("asset Alerts tab — active list", () => {
  it("freezes the header by scrolling inside the table, not the panel", async () => {
    await mount();
    const wrap = document.querySelector(".table-wrapper-modal-sticky") as HTMLElement;
    expect(wrap).toBeTruthy();
    // Self-bounding: the sticky-thead CSS only helps if the wrapper is what
    // scrolls, which needs a height bound. No JS sizer runs in a slide-over.
    expect(wrap.style.maxHeight).toBeTruthy();
    expect(wrap.querySelector("thead")).toBeTruthy();
  });

  it("names the dimension each alert was raised for", async () => {
    await mount();
    const detail = rows().map((tr) => cell(tr, 3)); // cb(0) time(1) severity(2) detail(3)
    expect(detail.slice(0, 2)).toEqual(["port2", "port10"]);
    // A whole-device alert has no dimension and must not print a bare blank.
    expect(detail[2]).toBe("—");
    // The metric identifies what the dimension IS, on the cell rather than in
    // a column that would repeat one value down the whole table.
    expect((rows()[0].children[3] as HTMLElement).getAttribute("title")).toBe("ifOperStatus");
  });

  it("orders equal timestamps by dimension, numerically", async () => {
    const sorted = g._sortAssetAlerts(makeAlerts());
    // Same minute → port2 before port10 (a plain string sort inverts these).
    expect(sorted.map((a: any) => a.id)).toEqual(["n1", "n2", "n0"]);
  });

  it("counts the active alerts in the heading", async () => {
    await mount();
    expect(document.getElementById("asset-notif-active-count")!.textContent).toBe("(3)");
    await mount({ alerts: [] });
    expect(document.getElementById("asset-notif-active-count")!.textContent).toBe("");
  });

  it("spans the empty state across every column that renders", async () => {
    await mount({ alerts: [] });
    const td = document.querySelector("#asset-notif-active-tbody td") as HTMLElement;
    const headers = document.querySelectorAll("#tab thead th").length - 3; // minus the rules table's 3
    expect(Number(td.getAttribute("colspan"))).toBe(headers);
    expect(Number(td.getAttribute("colspan"))).toBe(6);
  });
});

describe("asset Alerts tab — selection + bulk actions", () => {
  it("enables the bulk buttons only once something is selected", async () => {
    await mount();
    const ack = document.getElementById("asset-alert-bulk-ack") as HTMLButtonElement;
    const clr = document.getElementById("asset-alert-bulk-clear") as HTMLButtonElement;
    expect(ack.disabled).toBe(true);
    expect(clr.disabled).toBe(true);
    expect(document.getElementById("asset-alert-selcount")!.textContent).toBe("None selected");

    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>(".asset-alert-sel"));
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new Event("change"));
    expect(ack.disabled).toBe(false);
    expect(clr.disabled).toBe(false);
    expect(document.getElementById("asset-alert-selcount")!.textContent).toBe("1 selected");
    // Partial selection: the header box reads as neither on nor off.
    const all = document.getElementById("asset-alert-selall") as HTMLInputElement;
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);
  });

  it("select-all takes every rendered row", async () => {
    await mount();
    const all = document.getElementById("asset-alert-selall") as HTMLInputElement;
    all.checked = true;
    all.dispatchEvent(new Event("change"));
    expect(document.querySelectorAll<HTMLInputElement>(".asset-alert-sel:checked").length).toBe(3);
    expect(document.getElementById("asset-alert-selcount")!.textContent).toBe("3 selected");
    expect(all.indeterminate).toBe(false);
  });

  it("clears the whole selection in ONE request, confirmed with the count", async () => {
    ctx.clearResult = () => ({ cleared: 3 });
    await mount();
    const all = document.getElementById("asset-alert-selall") as HTMLInputElement;
    all.checked = true;
    all.dispatchEvent(new Event("change"));
    (document.getElementById("asset-alert-bulk-clear") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(g.showConfirm).toHaveBeenCalledTimes(1);
    expect(String((g.showConfirm as any).mock.calls[0][0])).toContain("3 alerts");
    expect(ctx.cleared).toEqual([["n1", "n2", "n0"]]);
    expect(ctx.toasts.at(-1)).toEqual({ msg: "Cleared 3 alerts", type: "success" });
  });

  it("acknowledges the selection with one shared note", async () => {
    ctx.ackResult = () => ({ acknowledged: 2 });
    (g.window.prompt as any).mockReturnValue("switch reboot");
    await mount();
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>(".asset-alert-sel"));
    boxes[0].checked = true; boxes[0].dispatchEvent(new Event("change"));
    boxes[1].checked = true; boxes[1].dispatchEvent(new Event("change"));
    (document.getElementById("asset-alert-bulk-ack") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.acked).toEqual([{ ids: ["n1", "n2"], note: "switch reboot" }]);
    expect(ctx.toasts.at(-1)!.msg).toBe("Acknowledged 2 alerts");
  });

  it("cancelling the note prompt sends nothing", async () => {
    (g.window.prompt as any).mockReturnValue(null);
    await mount();
    const all = document.getElementById("asset-alert-selall") as HTMLInputElement;
    all.checked = true;
    all.dispatchEvent(new Event("change"));
    (document.getElementById("asset-alert-bulk-ack") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.acked).toEqual([]);
  });

  it("does not stack a second handler on the bulk buttons when the tab reloads", async () => {
    await mount();
    // Every action reloads the tab; the tbody is rebuilt but the bulk bar and
    // the select-all are NOT, so a naive re-wire fires N batches on click N.
    g._loadAssetNotificationsTab("A1");
    await new Promise((r) => setTimeout(r, 0));
    g._loadAssetNotificationsTab("A1");
    await new Promise((r) => setTimeout(r, 0));

    const all = document.getElementById("asset-alert-selall") as HTMLInputElement;
    all.checked = true;
    all.dispatchEvent(new Event("change"));
    expect(document.querySelectorAll<HTMLInputElement>(".asset-alert-sel:checked").length).toBe(3);
    (document.getElementById("asset-alert-bulk-clear") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.cleared.length).toBe(1);
  });
});

describe("asset Alerts tab — what the toast reports", () => {
  it("says so when the server cleared nothing", async () => {
    ctx.clearResult = () => ({ cleared: 0 });
    await mount();
    (document.querySelector(".asset-alert-clear") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.toasts.at(-1)).toEqual({ msg: "That alert was already cleared", type: "error" });
  });

  it("says so when the alert was already acknowledged", async () => {
    ctx.ackResult = () => ({ acknowledged: 0 });
    await mount();
    (document.querySelector(".asset-alert-ack") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.toasts.at(-1)).toEqual({ msg: "Already acknowledged", type: "error" });
  });
});

describe("asset Alerts tab — permission gating", () => {
  it("offers no selection at all to a viewer who cannot act", async () => {
    await mount({ perm: "read" });
    expect(document.getElementById("asset-alert-bulkbar")).toBeNull();
    expect(document.getElementById("asset-alert-selall")).toBeNull();
    expect(document.querySelectorAll(".asset-alert-sel").length).toBe(0);
    // Five columns, not six — and the empty state has to match.
    await mount({ perm: "read", alerts: [] });
    expect(Number(document.querySelector("#asset-notif-active-tbody td")!.getAttribute("colspan"))).toBe(5);
  });

  it("gives a write-level operator acknowledge but not clear", async () => {
    await mount({ perm: "write" });
    expect(document.getElementById("asset-alert-bulk-ack")).toBeTruthy();
    expect(document.getElementById("asset-alert-bulk-clear")).toBeNull();
    expect(document.querySelectorAll(".asset-alert-clear").length).toBe(0);
    expect(document.querySelectorAll(".asset-alert-sel").length).toBe(3);
  });
});
