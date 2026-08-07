/**
 * tests/unit/tableTabsService.test.ts
 *
 * `sanitizeTabs` — the validator behind per-user list-page tabs. Per-tab state
 * validation is delegated to savedFilterService.sanitizeFilterState (covered in
 * its own suite); what's tested here is the envelope: caps, uniqueness, name
 * hygiene, the preset back-reference, and the activeId repair rule.
 */

import { describe, it, expect } from "vitest";
import { sanitizeTabs, MAX_TABS, MAX_TAB_NAME_LEN } from "../../src/services/tableTabsService.js";

const STATE = { sfFilters: { assetType: ["firewall"] }, sortKey: "hostname", sortDir: "asc" };

function tab(over: Record<string, unknown> = {}) {
  return { id: "t1", name: "Firewalls", state: STATE, ...over };
}

describe("sanitizeTabs", () => {
  it("round-trips a tab with its state and preset back-reference", () => {
    const out = sanitizeTabs({
      tabs: [tab({ savedFilterId: "f1", savedFilterName: "Edge firewalls" })],
      activeId: "t1",
    });
    expect(out).toEqual({
      version: 1,
      activeId: "t1",
      tabs: [{
        id: "t1",
        name: "Firewalls",
        state: STATE,
        savedFilterId: "f1",
        savedFilterName: "Edge firewalls",
      }],
    });
  });

  it("defaults a missing state to the empty filter set and nulls the back-reference", () => {
    const out = sanitizeTabs({ tabs: [{ id: "t1", name: "Blank" }], activeId: "t1" });
    expect(out.tabs[0]!.state).toEqual({ sfFilters: {}, sortKey: null, sortDir: null });
    expect(out.tabs[0]!.savedFilterId).toBeNull();
    expect(out.tabs[0]!.savedFilterName).toBeNull();
  });

  it("trims names and rejects blank / control-character ones", () => {
    expect(sanitizeTabs({ tabs: [tab({ name: "  Edge  " })] }).tabs[0]!.name).toBe("Edge");
    expect(() => sanitizeTabs({ tabs: [tab({ name: "   " })] })).toThrowError(/name is required/);
    expect(() => sanitizeTabs({ tabs: [tab({ name: "a" + String.fromCharCode(7) + "b" })] }))
      .toThrowError(/control characters/);
    expect(() => sanitizeTabs({ tabs: [tab({ name: "x".repeat(MAX_TAB_NAME_LEN + 1) })] }))
      .toThrowError(/exceeds/);
  });

  it("repairs a stale activeId instead of losing the layout", () => {
    // A client that closed a tab in another window shouldn't 400 the whole PUT.
    const out = sanitizeTabs({ tabs: [tab(), tab({ id: "t2", name: "Switches" })], activeId: "gone" });
    expect(out.activeId).toBe("t1");
  });

  it("normalizes an empty tab set to an empty activeId", () => {
    expect(sanitizeTabs({ tabs: [], activeId: "t1" })).toEqual({ version: 1, tabs: [], activeId: "" });
  });

  it("rejects duplicate ids, over-long sets, and non-object payloads", () => {
    expect(() => sanitizeTabs({ tabs: [tab(), tab()] })).toThrowError(/unique/);
    const many = Array.from({ length: MAX_TABS + 1 }, (_, i) => tab({ id: `t${i}` }));
    expect(() => sanitizeTabs({ tabs: many })).toThrowError(/too many tabs/);
    expect(() => sanitizeTabs({ tabs: "nope" })).toThrowError(/must be an array/);
    expect(() => sanitizeTabs([])).toThrowError(/must be an object/);
    expect(() => sanitizeTabs({ tabs: [null] })).toThrowError(/must be an object/);
  });

  it("rejects a tab state the table could not have produced", () => {
    // Delegated to sanitizeFilterState — the tab envelope must not be a way
    // around it.
    expect(() => sanitizeTabs({ tabs: [tab({ state: { sfFilters: { hostname: { op: "rm -rf" } } } })] }))
      .toThrowError(/not a recognized filter shape/);
  });
});
