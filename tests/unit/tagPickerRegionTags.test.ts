/**
 * tests/unit/tagPickerRegionTags.test.ts — region tags in the shared tag picker
 * (`tagFieldHTML` / `_renderTagChips` / `getTagFieldValue` in public/js/app.js).
 *
 * region: tags used to be a hidden "protected prefix": the picker filtered them
 * out of the chip list (so the Map Regions category never rendered — the bug
 * report was "I can't edit an asset's region tags in the edit modal"), hid them
 * from the read-only render, and force-merged them back into every save via a
 * data-preserved-tags stash. That guard existed because the add-only reconciler
 * couldn't tell a hand-applied region tag from its own; now that
 * mapRegionService records provenance (RegionTagAssignment), a hand-added tag
 * is operator-owned and never auto-stripped, so the picker treats region tags
 * like any other tag. This test pins the new contract so the filter can't
 * quietly come back.
 *
 * app.js is a classic browser script, so it's eval'd into a happy-dom Window —
 * the rowContextMenu.test.ts idiom. The tag cache is populated through
 * _ensureTagCache against a stubbed api, not by poking module state.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const APP_SRC = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");

const TAGS = [
  { name: "Production", category: "Environment", color: "#f87171" },
  { name: "region:Nashville", category: "Map Regions", color: "#4fc3f7" },
  { name: "region:Atlanta", category: "Map Regions", color: "#4ade80" },
];

let win: InstanceType<typeof Window>;
let doc: Window["document"];
let tagFieldHTML: (selected: string[], opts?: { readOnly?: boolean }) => string;
let getTagFieldValue: () => string[];

function exported<T>(name: string): T {
  const fn = (win as unknown as Record<string, unknown>)[name] ?? g[name];
  expect(typeof fn, `app.js no longer exposes ${name}`).toBe("function");
  return fn as T;
}

beforeEach(async () => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.fetch = () => Promise.reject(new Error("no network in this test"));
  g.showToast = () => {};
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.api = {
    serverSettings: {
      getTagSettings: async () => ({ enforce: false }),
      listTags: async () => TAGS,
    },
  };

  doc.body.innerHTML = "<div id='host'></div>";
  try { (0, eval)(APP_SRC); } catch (_e) { /* app.js boot wiring touches page-specific DOM */ }

  const ensure = exported<() => Promise<void>>("_ensureTagCache");
  await ensure();
  tagFieldHTML = exported("tagFieldHTML");
  getTagFieldValue = exported("getTagFieldValue");
});

function render(selected: string[], opts?: { readOnly?: boolean }): void {
  (doc.getElementById("host") as unknown as HTMLElement).innerHTML = tagFieldHTML(selected, opts);
}

function chipInput(name: string) {
  return doc.querySelector(`input[name="f-tags-cb"][value="${name}"]`) as unknown as HTMLInputElement | null;
}

describe("tag picker — region tags are editable", () => {
  it("renders the Map Regions category with selectable chips", () => {
    render(["region:Nashville"]);
    const labels = Array.from(doc.querySelectorAll(".tag-picker-cat-label")).map((e) => e.textContent);
    expect(labels).toContain("Map Regions");
    const nash = chipInput("region:Nashville");
    const atl = chipInput("region:Atlanta");
    expect(nash, "region chip missing — the protected-prefix filter is back").toBeTruthy();
    expect(atl).toBeTruthy();
    expect(nash!.checked).toBe(true);
    expect(atl!.checked).toBe(false);
  });

  it("explains the reconcile semantics under the Map Regions category only", () => {
    render([]);
    const hints = Array.from(doc.querySelectorAll(".tag-picker .hint")).map((e) => e.textContent ?? "");
    expect(hints.filter((t) => t.includes("re-adds it on the next reconcile"))).toHaveLength(1);
  });

  it("getTagFieldValue reflects the checkboxes — unchecking a region tag removes it", () => {
    render(["region:Nashville", "Production"]);
    expect(getTagFieldValue().sort()).toEqual(["Production", "region:Nashville"]);

    chipInput("region:Nashville")!.checked = false;
    expect(getTagFieldValue()).toEqual(["Production"]);

    chipInput("region:Atlanta")!.checked = true;
    expect(getTagFieldValue().sort()).toEqual(["Production", "region:Atlanta"]);
  });

  it("no longer stashes preserved tags on the picker element", () => {
    render(["region:Nashville"]);
    const picker = doc.getElementById("f-tags-picker") as unknown as HTMLElement;
    expect(picker.getAttribute("data-preserved-tags")).toBeNull();
  });

  it("read-only render shows region tags instead of hiding them", () => {
    render(["region:Nashville"], { readOnly: true });
    expect((doc.getElementById("host") as unknown as HTMLElement).textContent).toContain("region:Nashville");
  });
});
