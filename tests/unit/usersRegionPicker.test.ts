/**
 * tests/unit/usersRegionPicker.test.ts — the Users page region picker's
 * "unknown region tag" verdict (`regionPickerHtml` in public/js/users.js).
 *
 * The picker's orphan row is the surface an operator reads as "my region
 * assignments were wiped", so it must only make that claim when it can support
 * it. Two ways it couldn't:
 *
 *  - CASE. The catalogue is keyed by the region's stored name, and everything
 *    that actually matches a tag compares case-insensitively (`selSet` in this
 *    same function, `normalizeNeedle` in notificationRecipientService, `key()`
 *    in regionHierarchyService). A user tagged "southeast" against a region
 *    named "Southeast" is scoped correctly, and was being listed as an orphan
 *    AND as a selected pill at the same time.
 *  - AN UNREADABLE CATALOGUE. `GET /map/regions` needs mapRegions=read, and
 *    (until window.api was published) it never resolved for anyone at all —
 *    which turned every assignment on the page into "no longer in the map".
 *    Absent a catalogue there is no evidence about any tag.
 *
 * What must hold in both cases: the assignments stay collectable
 * (`data-selected="1"`), because `collectRegionPicker` reads exactly those
 * chips and a save must never silently drop a scope the admin didn't touch.
 *
 * users.js is a classic browser script; an indirect eval puts its top-level
 * declarations on globalThis — the usersRowMenu.test.ts idiom.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
let regionPickerHtml: (idPrefix: string, selected: string[]) => string;

const CATALOG: Record<string, string> = { Southeast: "#4fc3f7", Midwest: "#ef5350" };

/** Point users.js at a catalogue, or at the unreadable-catalogue state. */
function setCatalog(loaded: boolean, byName: Record<string, string> = {}) {
  g._regionByName = byName;
  g._regionList = Object.keys(byName).sort();
  g.window.PolarisRegionPills = {
    isLoaded: () => loaded,
    load: async () => byName,
    names: () => Object.keys(byName).sort(),
    catalog: () => byName,
    colorFor: (n: string) => byName[n] || "#9e9e9e",
    rgbTriplet: () => "79, 195, 247",
    pill: (n: string) => `<span>${n}</span>`,
    html: (names: string[]) => names.join(""),
  };
}

/** The chip row above the grid: the tags the picker is calling unnamed. */
function orphanRow(html: string): { note: string; names: string[] } {
  const doc = new Window().document;
  doc.body.innerHTML = html;
  const wrap = doc.querySelector("div > div");
  const note = wrap ? (wrap.textContent || "").trim() : "";
  // Orphan chips are <span> (removable); catalogue pills are <button>.
  const names = Array.from(doc.querySelectorAll("span.region-chip")).map((el) =>
    (el.getAttribute("data-region") || "").trim(),
  );
  return { note, names };
}

/** Everything a save would collect — mirrors collectRegionPicker's selector. */
function collected(html: string): string[] {
  const doc = new Window().document;
  doc.body.innerHTML = html;
  return Array.from(doc.querySelectorAll('.region-chip[data-selected="1"]')).map((el) =>
    (el.getAttribute("data-region") || "").trim(),
  );
}

beforeAll(() => {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  g.PolarisPrefs = { save: () => {}, load: () => null };
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g.showToast = () => {};
  g.showConfirm = async () => false;
  g.permAtLeast = () => true;
  g.api = {};
  g.currentUsername = "alice";
  g.formatDate = () => "";
  g.TableSF = function () {};
  g.setupColumnLayout = () => null;
  g.userReady = Promise.resolve();
  setCatalog(true, CATALOG);

  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/users.js"), "utf8"));
  regionPickerHtml = g.regionPickerHtml as typeof regionPickerHtml;
  expect(typeof regionPickerHtml, "users.js no longer declares regionPickerHtml").toBe("function");
});

beforeEach(() => setCatalog(true, CATALOG));

describe("a readable catalogue", () => {
  it("does not call a case-differing tag unknown", () => {
    const html = regionPickerHtml("f-user-regions", ["southeast", "MIDWEST"]);
    expect(orphanRow(html).names).toEqual([]);
  });

  it("renders a case-differing tag as a SELECTED catalogue pill", () => {
    // Which also normalizes the stored casing to the region's on the next save,
    // since the pill carries the catalogue name in data-region.
    const html = regionPickerHtml("f-user-regions", ["southeast"]);
    expect(collected(html)).toEqual(["Southeast"]);
  });

  it("still calls a tag naming no region unknown", () => {
    const { note, names } = orphanRow(regionPickerHtml("f-user-regions", ["Southeast", "Ashfield"]));
    expect(names).toEqual(["Ashfield"]);
    expect(note).toContain("no longer in the map");
  });

  it("keeps an unknown tag collectable so a save cannot drop it", () => {
    expect(collected(regionPickerHtml("f-user-regions", ["Ashfield"]))).toEqual(["Ashfield"]);
  });

  it("offers the empty state only as 'none drawn yet'", () => {
    setCatalog(true, {});
    const html = regionPickerHtml("f-user-regions", []);
    expect(html).toContain("No map regions defined yet");
  });
});

describe("an unreadable catalogue", () => {
  beforeEach(() => setCatalog(false, {}));

  it("calls no assignment unknown", () => {
    const { note } = orphanRow(regionPickerHtml("f-user-regions", ["Southeast", "Ashfield"]));
    expect(note).not.toContain("no longer in the map");
    expect(note).toContain("could not be read");
  });

  it("still lists every assignment, and keeps them collectable", () => {
    const html = regionPickerHtml("f-user-regions", ["Southeast", "Ashfield"]);
    expect(orphanRow(html).names).toEqual(["Southeast", "Ashfield"]);
    expect(collected(html)).toEqual(["Southeast", "Ashfield"]);
  });

  it("does not claim no regions are defined", () => {
    const html = regionPickerHtml("f-user-regions", ["Southeast"]);
    expect(html).not.toContain("No map regions defined yet");
    expect(html).toContain("Map regions unavailable");
  });
});
