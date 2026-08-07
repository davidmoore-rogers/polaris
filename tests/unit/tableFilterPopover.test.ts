/**
 * tests/unit/tableFilterPopover.test.ts — the document-wide popover-close
 * wiring in public/js/table-sf.js (TableSF._wireDocClose).
 *
 * table-sf.js is a plain browser script (no module exports), so it's eval'd
 * into a happy-dom Window with the app-shell globals stubbed — same approach as
 * tests/unit/tableColumnOrder.test.ts.
 *
 * What's pinned here is the interaction that broke on the Events page: a
 * multi-select filter popover has its own max-height + overflow-y, and the
 * capture-phase scroll listener (which exists so a page scroll can't leave the
 * position:fixed popover floating away from its button) used to close it when
 * the operator scrolled the LIST — wheel or scrollbar drag alike.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;

const TABLE_HTML = `
  <table>
    <thead><tr>
      <th data-sf-key="resourceType" data-sf-type="string" data-sf-options="asset|integration|subnet">Resource</th>
      <th data-sf-key="resourceName" data-sf-type="string">Name</th>
    </tr></thead>
    <tbody id="tb"><tr><td>integration</td><td>PLVCORFMG1</td></tr></tbody>
  </table>`;

let win: Window;
let doc: Window["document"];

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
  const src = readFileSync(resolve(__dirname, "../../public/js/table-sf.js"), "utf8");
  (0, eval)(src);
  return new (g as any).TableSF("tb", () => {});
}

function fire(type: string, target: any, extra: Record<string, unknown> = {}): void {
  const ev: any = new (win as any).Event(type, { bubbles: type !== "scroll", cancelable: true });
  Object.assign(ev, extra);
  target.dispatchEvent(ev);
}

function popover(): Element {
  return doc.querySelector(".sf-multi-popover")!;
}

function isOpen(): boolean {
  return !popover().hasAttribute("hidden");
}

function openPopover(): void {
  (doc.querySelector(".sf-multi-button") as any).click();
  expect(isOpen()).toBe(true);
}

beforeEach(() => { setup(); });

describe("filter popover close wiring", () => {
  it("stays open while the operator scrolls INSIDE the popover", () => {
    openPopover();
    fire("scroll", popover());
    expect(isOpen()).toBe(true);
  });

  it("stays open when a scrollbar drag started inside it releases outside", () => {
    openPopover();
    // Scrollbar drag: mousedown on the popover, mouseup off it — the browser
    // dispatches the resulting click on the common ancestor (body).
    fire("mousedown", popover());
    fire("scroll", popover());
    fire("click", doc.body);
    expect(isOpen()).toBe(true);
  });

  it("still closes on a page scroll outside the popover", () => {
    openPopover();
    fire("scroll", doc.body);
    expect(isOpen()).toBe(false);
  });

  it("still closes on an outside click, a resize, and Escape", () => {
    openPopover();
    fire("click", doc.body);
    expect(isOpen()).toBe(false);

    openPopover();
    fire("resize", win);
    expect(isOpen()).toBe(false);

    openPopover();
    fire("keydown", doc, { key: "Escape" });
    expect(isOpen()).toBe(false);
  });
});
