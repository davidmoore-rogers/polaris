/**
 * tests/unit/assetsTabsDom.test.ts — DOM smoke for the Assets page view tabs
 * (public/js/assets-tabs.js).
 *
 * Same eval-into-happy-dom idiom as assetsFiltersDom.test.ts. This is the net
 * for the wiring no server test can see: seeding the first tab from the live
 * table, switching tabs applying that tab's state, rename, close, the
 * open-a-preset-in-a-new-tab entry point, and — the subtle one — the
 * re-entrancy guard that stops applying a tab from writing the table state back
 * into the tab the operator just left.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const SRC = readFileSync(resolve(__dirname, "../../public/js/assets-tabs.js"), "utf8");

const STRIP_HTML =
  '<div class="table-tabs" id="assets-tabs">' +
    '<div class="table-tabs-list" id="assets-tabs-list"></div>' +
    '<button id="assets-tab-add">+</button>' +
  "</div>";

let doc: Window["document"];
let win: InstanceType<typeof Window>;
let saved: Record<string, unknown>[];
let getResponse: Record<string, unknown> | null;
let liveFilters: Record<string, unknown>;
let liveSort: { key: string | null; dir: string | null };
let appliedStates: unknown[];
let refreshes: number;
let confirmAnswer: boolean;

/** Boot a fresh module instance against a fresh DOM. */
async function boot(opts?: { hashSeeded?: boolean }) {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  doc.body.innerHTML = STRIP_HTML;

  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  g.showToast = () => {};
  g.showConfirm = async () => confirmAnswer;
  g.api = {
    tableTabs: {
      get:  async () => getResponse,
      save: async (_scope: string, layout: Record<string, unknown>) => { saved.push(layout); return layout; },
    },
  };
  // Stand-ins for assets.js. getPrefs reads the mutable "live" state so a test
  // can simulate the operator typing in a filter box.
  g._assetsSF = {
    getPrefs: () => ({ sfFilters: liveFilters, sortKey: liveSort.key, sortDir: liveSort.dir }),
    applyState: (s: any) => {
      appliedStates.push(s);
      liveFilters = JSON.parse(JSON.stringify(s.sfFilters || {}));
      liveSort = { key: s.sortKey || null, dir: s.sortDir || null };
    },
  };
  g.assetsApplyFilterState = () => {
    refreshes += 1;
    tabsApi().syncFromTable();
  };

  (0, eval)(SRC);
  await tabsApi().init(opts || {});
}

// The module assigns itself onto `window`, which under happy-dom is a
// separate object from globalThis.
const tabsApi = () => (g.window as any).PolarisAssetTabs as {
  init: (o?: unknown) => Promise<void>;
  syncFromTable: () => void;
  openInNewTab: (p: unknown) => boolean;
  noteFilterLoaded: (p: unknown) => void;
  activeTabName: () => string;
  _debugState: () => { tabs: any[]; activeId: string; persisted: boolean };
};

function tabEls() {
  return Array.from(doc.querySelectorAll("#assets-tabs-list .table-tab"));
}
function fire(el: unknown, type: string, init?: Record<string, unknown>) {
  (el as { dispatchEvent: (e: unknown) => void })
    .dispatchEvent(new win.Event(type, Object.assign({ bubbles: true }, init || {})));
}
/** Let the debounced save (800ms) fire. */
function flushSave() {
  return new Promise((r) => setTimeout(r, 900));
}

beforeEach(() => {
  saved = [];
  getResponse = { version: 1, tabs: [], activeId: "" };
  liveFilters = {};
  liveSort = { key: null, dir: null };
  appliedStates = [];
  refreshes = 0;
  confirmAnswer = true;
});

describe("first visit", () => {
  it("seeds one tab from what the table is already showing, and does not write yet", async () => {
    liveFilters = { hostname: "nsh" };                    // restored localStorage prefs
    await boot();
    const tabs = tabEls();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.querySelector(".table-tab-name")!.textContent).toBe("All assets");
    expect(tabsApi()._debugState().tabs[0].state.sfFilters).toEqual({ hostname: "nsh" });
    // No server row until the operator actually uses tabs.
    expect(tabsApi()._debugState().persisted).toBe(false);
    expect(saved).toEqual([]);
    // init must NOT trigger a fetch — assets.js loads the page right after.
    expect(refreshes).toBe(0);
  });

  it("the lone tab has no close button", async () => {
    await boot();
    expect(doc.querySelector("[data-tab-close]")).toBeFalsy();
  });
});

describe("restoring saved tabs", () => {
  beforeEach(() => {
    getResponse = {
      version: 1,
      activeId: "t2",
      tabs: [
        { id: "t1", name: "All assets", state: { sfFilters: {}, sortKey: null, sortDir: null } },
        { id: "t2", name: "Firewalls", state: { sfFilters: { assetType: ["firewall"] }, sortKey: "hostname", sortDir: "asc" }, savedFilterId: "f1", savedFilterName: "Edge firewalls" },
      ],
    };
  });

  it("renders every tab, marks the active one, and applies its state without an extra fetch", async () => {
    await boot();
    const tabs = tabEls();
    expect(tabs.map((t) => t.querySelector(".table-tab-name")!.textContent)).toEqual(["All assets", "Firewalls"]);
    expect(tabs[1]!.classList.contains("active")).toBe(true);
    expect(appliedStates).toHaveLength(1);
    expect((appliedStates[0] as any).sfFilters).toEqual({ assetType: ["firewall"] });
    expect(refreshes).toBe(0);
    // A tab carrying filters gets the marker dot; an empty one doesn't.
    expect(tabs[0]!.querySelector(".table-tab-dot")).toBeFalsy();
    expect(tabs[1]!.querySelector(".table-tab-dot")).toBeTruthy();
  });

  it("switching tabs applies that tab's state and re-fetches exactly once", async () => {
    await boot();
    fire(tabEls()[0], "click");
    expect(refreshes).toBe(1);
    expect(liveFilters).toEqual({});
    expect(tabEls()[0]!.classList.contains("active")).toBe(true);
    // The re-entrancy guard: applying tab 1 must not have written its (empty)
    // state over tab 2, which the operator just left.
    const state = tabsApi()._debugState();
    expect(state.tabs[1].state.sfFilters).toEqual({ assetType: ["firewall"] });
  });

  it("a filter change lands in the ACTIVE tab only, and persists", async () => {
    await boot();
    liveFilters = { status: ["decommissioned"] };         // operator types in a filter box
    (g.assetsApplyFilterState as () => void)();
    const state = tabsApi()._debugState();
    expect(state.tabs[1].state.sfFilters).toEqual({ status: ["decommissioned"] });
    expect(state.tabs[0].state.sfFilters).toEqual({});
    await flushSave();
    // Assert the LAST payload rather than the count: a debounced save scheduled
    // by an earlier test's module instance can still land in this window.
    const last = saved[saved.length - 1] as any;
    expect(last.activeId).toBe("t2");
    expect(last.tabs[1].state.sfFilters).toEqual({ status: ["decommissioned"] });
  });

  it("hashSeeded keeps a deep link's narrowing instead of the tab's", async () => {
    liveFilters = { assetType: ["switch"] };              // #type=switch already applied
    await boot({ hashSeeded: true });
    expect(appliedStates).toEqual([]);                    // tab state never applied over it
    expect(tabsApi()._debugState().tabs[1].state.sfFilters).toEqual({ assetType: ["switch"] });
  });
});

describe("tab management", () => {
  beforeEach(() => {
    getResponse = {
      version: 1,
      activeId: "t1",
      tabs: [{ id: "t1", name: "All assets", state: { sfFilters: { hostname: "a" }, sortKey: null, sortDir: null } }],
    };
  });

  it("+ opens an empty tab, makes it active, and clears the table", async () => {
    await boot();
    fire(doc.getElementById("assets-tab-add"), "click");
    const tabs = tabEls();
    expect(tabs).toHaveLength(2);
    expect(tabs[1]!.querySelector(".table-tab-name")!.textContent).toBe("Tab 2");
    expect(tabs[1]!.classList.contains("active")).toBe(true);
    expect(liveFilters).toEqual({});
    expect(refreshes).toBe(1);
    // Two tabs → both closable now.
    expect(doc.querySelectorAll("[data-tab-close]").length).toBe(2);
  });

  it("double-click renames; Enter commits and Escape reverts", async () => {
    await boot();
    fire(tabEls()[0], "dblclick");
    let input = doc.querySelector(".table-tab-input") as any;
    expect(input).toBeTruthy();
    input.value = "  Edge   gear ";
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(tabEls()[0]!.querySelector(".table-tab-name")!.textContent).toBe("Edge gear");

    fire(tabEls()[0], "dblclick");
    input = doc.querySelector(".table-tab-input") as any;
    input.value = "Discarded";
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(tabEls()[0]!.querySelector(".table-tab-name")!.textContent).toBe("Edge gear");
    await flushSave();
    expect((saved[saved.length - 1] as any).tabs[0].name).toBe("Edge gear");
  });

  it("closing asks first when the tab holds unsaved filters", async () => {
    await boot();
    fire(doc.getElementById("assets-tab-add"), "click");   // now 2 tabs; t1 has filters
    confirmAnswer = false;
    fire(doc.querySelector('[data-tab-close="t1"]'), "click");
    await new Promise((r) => setTimeout(r, 0));
    expect(tabEls()).toHaveLength(2);

    confirmAnswer = true;
    fire(doc.querySelector('[data-tab-close="t1"]'), "click");
    await new Promise((r) => setTimeout(r, 0));
    expect(tabEls()).toHaveLength(1);
  });
});

describe("saved-filter entry points", () => {
  beforeEach(() => {
    getResponse = {
      version: 1,
      activeId: "t1",
      tabs: [{ id: "t1", name: "All assets", state: { sfFilters: {}, sortKey: null, sortDir: null } }],
    };
  });

  const PRESET = {
    id: "f7",
    name: "Down switches",
    state: { sfFilters: { assetType: ["switch"], _monitor: ["Down"] }, sortKey: "hostname", sortDir: "asc" },
  };

  it("openInNewTab adds a tab named after the preset and applies it", async () => {
    await boot();
    expect(tabsApi().openInNewTab(PRESET)).toBe(true);
    const tabs = tabEls();
    expect(tabs).toHaveLength(2);
    expect(tabs[1]!.querySelector(".table-tab-name")!.textContent).toBe("Down switches");
    expect(liveFilters).toEqual({ assetType: ["switch"], _monitor: ["Down"] });
    expect(tabsApi()._debugState().tabs[1].savedFilterId).toBe("f7");
    // The original tab is untouched — that's the whole point of "new tab".
    expect(tabsApi()._debugState().tabs[0].state.sfFilters).toEqual({});
  });

  it("noteFilterLoaded adopts the preset name for a default-named tab only", async () => {
    await boot();
    tabsApi().noteFilterLoaded(PRESET);
    expect(tabEls()[0]!.querySelector(".table-tab-name")!.textContent).toBe("Down switches");
    expect(tabsApi().activeTabName()).toBe("Down switches");

    tabsApi().noteFilterLoaded({ id: "f8", name: "Something else", state: { sfFilters: {} } });
    expect(tabEls()[0]!.querySelector(".table-tab-name")!.textContent).toBe("Down switches");
    expect(tabsApi()._debugState().tabs[0].savedFilterId).toBe("f8");
  });
});
