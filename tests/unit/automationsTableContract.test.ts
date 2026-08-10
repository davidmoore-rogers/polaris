/**
 * tests/unit/automationsTableContract.test.ts — markup contract for the
 * Automations list table.
 *
 * The list gained persisted sort/filter/column widths, a "Show N" selector,
 * pagination and a frozen header by adopting the shared helpers rather than
 * growing its own. Every one of those helpers is keyed off MARKUP, and every
 * one of them FAILS SILENTLY when the markup doesn't match:
 *
 *   - `renderPageControls(containerId, …)` returns early when neither
 *     `#<id>` nor `#<id>-top` exists. A typo means no pagination and no error.
 *   - `sizeStickyTableWrappers()` only bounds elements carrying
 *     `.table-wrapper-sticky`. Without the class the header still renders,
 *     just never freezes.
 *   - `TableSF` / `setupColumnLayout` only wire columns that carry
 *     `data-sf-key` / `data-col-id`; an unmarked column silently loses its
 *     sort, filter and width persistence.
 *
 * None of that throws, so nothing else in the suite would notice. This pins
 * the contract instead.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

let doc: Window["document"];

beforeAll(() => {
  const html = readFileSync(resolve(__dirname, "../../public/automations.html"), "utf8");
  const win = new Window();
  win.document.body.innerHTML = html;
  doc = win.document;
});

describe("Automations list — pagination container contract", () => {
  it("has BOTH containers renderPageControls writes into", () => {
    // The helper fills `#<id>` and `#<id>-top`; the "Show N" selector renders
    // in the -top row only, so a missing -top means no page-size control.
    expect(doc.getElementById("rules-pagination"), "#rules-pagination").not.toBeNull();
    expect(doc.getElementById("rules-pagination-top"), "#rules-pagination-top").not.toBeNull();
  });

  it("puts the top controls ABOVE the table and the bottom ones below", () => {
    const top = doc.getElementById("rules-pagination-top")!;
    const bottom = doc.getElementById("rules-pagination")!;
    const tbody = doc.getElementById("rules-tbody")!;
    // compareDocumentPosition: 4 = FOLLOWING (argument comes after node).
    expect(top.compareDocumentPosition(tbody) & 4).toBeTruthy();
    expect(tbody.compareDocumentPosition(bottom) & 4).toBeTruthy();
  });
});

describe("Automations list — frozen header contract", () => {
  it("wraps the table in .table-wrapper-sticky so the header freezes", () => {
    const tbody = doc.getElementById("rules-tbody")!;
    const wrapper = tbody.closest(".table-wrapper");
    expect(wrapper, "table-wrapper").not.toBeNull();
    // Without this class sizeStickyTableWrappers() skips it and the header
    // scrolls away with the body — no error, just a table that doesn't freeze.
    expect(wrapper!.classList.contains("table-wrapper-sticky")).toBe(true);
  });
});

describe("Automations list — sort/filter/width column contract", () => {
  const dataColumns = () => {
    const tbody = doc.getElementById("rules-tbody")!;
    const thead = tbody.closest("table")!.querySelector("thead")!;
    return Array.from(thead.querySelectorAll("th"));
  };

  it("marks every data column with data-sf-key so it sorts and filters", () => {
    // The trailing actions column is the one legitimate exception — it holds
    // buttons, not data, and is flagged data-col-required so it can't be hidden.
    const unmarked = dataColumns().filter(
      (th) => !th.getAttribute("data-sf-key") && !th.getAttribute("data-col-required"),
    );
    expect(unmarked.map((th) => th.textContent?.trim())).toEqual([]);
  });

  it("gives every column a data-col-id so width/visibility can persist", () => {
    const missing = dataColumns().filter((th) => !th.getAttribute("data-col-id"));
    expect(missing.map((th) => th.textContent?.trim())).toEqual([]);
  });

  it("keeps the column count in step with the empty-state colspan", () => {
    // A mismatched colspan makes the "No automations yet" row under-span the
    // table and look broken — easy to miss when a column is added.
    const count = dataColumns().length;
    const placeholder = doc.querySelector("#rules-tbody td[colspan]");
    expect(Number(placeholder?.getAttribute("colspan"))).toBe(count);
  });
});
