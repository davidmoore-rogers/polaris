/**
 * tests/unit/tableColumnFit.test.ts — the column-fit pass in
 * `setupColumnLayout` (public/js/table-sf.js).
 *
 * What's pinned here is the arithmetic that decides how a table with room to
 * spare spends it. The rule: leftover width is spread across EVERY resizable
 * column in proportion to its base width, columns pinned to a declared width
 * (utility cb/fav + `data-col-no-resize`) never stretch, and the visible
 * columns always sum to exactly the container width — a narrow table used to
 * dump the whole remainder on the rightmost column, leaving cramped columns
 * and one enormous blank one.
 *
 * table-sf.js is a plain browser script (no module exports), so it's eval'd
 * into a happy-dom Window with the app-shell globals stubbed — same approach as
 * tests/unit/tableColumnOrder.test.ts. Node has no requestAnimationFrame, so
 * the fit pass runs synchronously here (its own documented fallback), which is
 * what makes these assertions deterministic. happy-dom reports all-zero rects,
 * so the container width is stubbed explicitly.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;

const AVAIL = 1000;

// cb (utility, pinned 20px) | fixed (static-width, declared 100px) |
// three resizable columns, the last of which is the auto-fill one.
const TABLE_HTML = `
  <div class="table-wrapper">
    <table>
      <thead><tr>
        <th class="cb-col"></th>
        <th style="width:100px" data-col-no-resize="true" data-col-id="badge">Badge</th>
        <th data-col-id="hostname">Hostname</th>
        <th data-col-id="ip">IP Address</th>
        <th data-col-id="created">Created</th>
      </tr></thead>
      <tbody id="tb">
        <tr><td class="cb-col">cb</td><td>b</td><td>host-1</td><td>10.0.0.1</td><td>Apr 17</td></tr>
      </tbody>
    </table>
  </div>`;

let win: Window;
let doc: Window["document"];
let layout: any;

/** Rendered <col> width in px, by display position. */
function colWidths(): number[] {
  return Array.from(doc.querySelectorAll("colgroup col")).map(
    (c) => parseFloat((c as any).style.width) || 0,
  );
}

function widthOf(colId: string): number {
  const ids = Array.from(doc.querySelectorAll("thead th")).map((t) => t.getAttribute("data-col-id"));
  return colWidths()[ids.indexOf(colId)];
}

function setup() {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.MutationObserver = (win as any).MutationObserver;
  g.getComputedStyle = (el: Element) => (win as any).getComputedStyle(el);
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  doc.body.innerHTML = TABLE_HTML;

  // The two measurements the fit pass takes: the table must be measurable at
  // all, and the parent's content box is what `table { width: 100% }` resolves
  // against.
  const table = doc.querySelector("table")! as any;
  const wrapper = doc.querySelector(".table-wrapper")! as any;
  table.getBoundingClientRect = () => ({ width: AVAIL, height: 100, top: 0, left: 0, right: AVAIL, bottom: 100 });
  Object.defineProperty(wrapper, "clientWidth", { value: AVAIL, configurable: true });

  const src = readFileSync(resolve(__dirname, "../../public/js/table-sf.js"), "utf8");
  (0, eval)(src);

  layout = (g as any).setupColumnLayout(table, { onChange: () => {} });
  return layout;
}

/** A resize drag on `colId`'s handle, `dx` px (negative = narrower). */
function dragHandle(colId: string, dx: number): void {
  const th = doc.querySelector(`thead th[data-col-id="${colId}"]`)!;
  const handle = th.querySelector(".sf-resize-handle")!;
  const fire = (target: any, type: string, clientX: number) => {
    const ev: any = new (win as any).Event(type, { bubbles: true, cancelable: true });
    ev.clientX = clientX;
    target.dispatchEvent(ev);
  };
  fire(handle, "mousedown", 500);
  fire(doc, "mousemove", 500 + dx);
  fire(doc, "mouseup", 500 + dx);
}

beforeEach(() => { setup(); });

describe("column fit — spending the leftover width", () => {
  it("spreads slack across every resizable column, proportionally", () => {
    // 1000 available − 20 (cb) − 100 (static) = 880 for the three resizable
    // columns, whose base widths sum to 400 → ×2.2 each.
    layout.setPrefs({ widths: { hostname: 100, ip: 200, created: 100 } });

    expect(widthOf("hostname")).toBe(220);
    expect(widthOf("ip")).toBe(440);
    expect(widthOf("created")).toBe(220);
  });

  it("honors the declared width of utility + static-width columns", () => {
    layout.setPrefs({ widths: { hostname: 100, ip: 200, created: 100, badge: 999 } });

    expect(widthOf("badge")).toBe(100);      // declared width is the source of truth
    expect(colWidths()[0]).toBe(20);         // cb-col pin
  });

  it("leaves no trailing gap — the visible columns sum to the container width", () => {
    layout.setPrefs({ widths: { hostname: 137, ip: 211, created: 89 } });

    const total = colWidths().reduce((a, b) => a + b, 0);
    expect(total).toBe(AVAIL);
  });

  it("re-fits after a column is hidden, rather than parking the space in the last one", () => {
    layout.setPrefs({ widths: { hostname: 100, ip: 200, created: 100 } });
    layout.setPrefs({ hidden: ["ip"], shown: ["hostname", "created"] });

    // 880 now shared by hostname + created (base 200) → ×4.4.
    expect(widthOf("hostname")).toBe(440);
    expect(widthOf("created")).toBe(440);
  });

  it("does not shrink an over-committed table — the last column stays visible", () => {
    layout.setPrefs({ widths: { hostname: 500, ip: 500, created: 500 } });

    expect(widthOf("hostname")).toBe(500);
    expect(widthOf("ip")).toBe(500);
    // No leftover to fill: the auto-fill column keeps its saved width instead
    // of collapsing to ~0px behind the wrapper's scrollbar.
    expect(widthOf("created")).toBe(500);
    expect(widthOf("badge")).toBe(100);
  });

  it("tracks a resize drag 1:1 against what's on screen", () => {
    // Stretched render is hostname 220 / ip 440. Dragging the divider 50px left
    // has to move it 50 SCREEN px — the stored base (100/200) sums narrower
    // than the container, so applying the delta to the base would move the
    // divider by 50 × 2.2.
    layout.setPrefs({ widths: { hostname: 100, ip: 200, created: 100 } });
    dragHandle("hostname", -50);

    expect(widthOf("hostname")).toBe(170);
    expect(widthOf("ip")).toBe(490);
    expect(widthOf("created")).toBe(220);
    expect(colWidths().reduce((a, b) => a + b, 0)).toBe(AVAIL);
  });
});
