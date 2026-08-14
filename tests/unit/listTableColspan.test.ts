/**
 * tests/unit/listTableColspan.test.ts — every list table's header column count
 * must match the `colspan` on its loading/empty placeholder row.
 *
 * A mismatch is invisible until a table is empty or errors, at which point the
 * placeholder under- or over-spans and the page looks broken. It is easy to
 * introduce because adding or removing a column touches three places: the
 * `<th>`, the static placeholder in the HTML, and every `colspan` in the JS
 * empty/error states. Moving the per-row action buttons behind a name context
 * menu removed an Actions column from five tables across four pages at once,
 * and produced exactly this bug twice before it was caught.
 *
 * automationsTableContract.test.ts pins the same property for the Automations
 * table alongside its other markup contracts; this file generalises the check
 * so a new list page gets it for free by being added to PAGES.
 *
 * Deliberately static: it reads the shipped HTML rather than rendering, so it
 * costs nothing and cannot be skipped by a missing DB.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Pages carrying at least one list table with a placeholder row. */
const PAGES = [
  "public/assets.html",
  "public/automations.html",
  "public/blocks.html",
  "public/ipam.html",
  "public/subnets.html",
  "public/users.html",
  "public/events.html",
];

interface TableInfo { index: number; headerCells: number; colspan: number | null }

/**
 * Split a page into tables and, for each, count `<th>` in the thead and read the
 * first `colspan` appearing after `</thead>`.
 *
 * Regex rather than a DOM parse because these are static files with one table
 * shape; a table without a thead or without a placeholder is reported as null
 * and skipped by the assertions rather than failing.
 */
function tablesIn(html: string): TableInfo[] {
  return html
    .split(/<table[^>]*>/)
    .slice(1)
    .map((chunk, index) => {
      const headEnd = chunk.indexOf("</thead>");
      if (headEnd < 0) return null;
      const headerCells = (chunk.slice(0, headEnd).match(/<th[\s>]/g) ?? []).length;
      const body = chunk.slice(headEnd);
      const m = body.match(/colspan="(\d+)"/);
      return { index, headerCells, colspan: m ? Number(m[1]) : null };
    })
    .filter((t): t is TableInfo => t !== null && t.headerCells > 0);
}

describe("list table placeholder colspan matches the header column count", () => {
  for (const page of PAGES) {
    const html = readFileSync(resolve(__dirname, "../..", page), "utf8");
    const tables = tablesIn(html);

    it(`${page} has at least one list table`, () => {
      expect(tables.length, `no <table> with a <thead> found in ${page}`).toBeGreaterThan(0);
    });

    for (const t of tables) {
      it(`${page} table #${t.index} spans all ${t.headerCells} columns`, () => {
        if (t.colspan === null) return; // no placeholder row — nothing to keep in step
        expect(t.colspan).toBe(t.headerCells);
      });
    }
  }
});

describe("row-menu pages no longer ship an Actions column", () => {
  // The four pages converted to the name context menu. Pinned so a future
  // change can't quietly reintroduce a per-row button column on one of them
  // while the others keep the menu — an inconsistency an operator would feel
  // before anyone noticed it in review.
  const CONVERTED = ["public/assets.html", "public/automations.html", "public/blocks.html", "public/ipam.html", "public/subnets.html", "public/users.html"];
  for (const page of CONVERTED) {
    it(`${page} has no data-col-id="actions" header`, () => {
      const html = readFileSync(resolve(__dirname, "../..", page), "utf8");
      expect(html).not.toMatch(/data-col-id="actions"/);
    });
  }
});
