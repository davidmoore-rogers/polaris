/**
 * tests/unit/automationsScopeTooltip.test.ts — pins the Automations list's
 * Scope-cell hover tooltip (`_scopeTooltip` in public/js/automations.js).
 *
 * The cell itself can only say "custom filter (3 conditions)", so the tooltip
 * is where an operator actually reads what an automation does. Its action
 * tally has to walk FOUR separate places actions and escalation chains can
 * live — rule-level actions, per-action chains, severity-band actions, and
 * per-band chains — and quietly missing one makes a noisy automation look
 * quiet. That's the regression this pins.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
let scopeTooltip: (r: Record<string, unknown>) => string;

beforeAll(() => {
  const win = new Window();
  win.document.body.innerHTML = '<button id="btn-refresh"></button>';
  g.window = win;
  g.document = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.showToast = () => {};
  g.showConfirm = async () => false;
  g.permAtLeast = () => false;
  g.api = {};
  // The builder catalogs live in automations-wizard.js (which the page loads
  // alongside this file); null is the pre-fetch state, and the tooltip's
  // documented fallback is raw field/operator names — which is what the
  // expectations below pin.
  g._ruleSchema = null;
  const src = readFileSync(resolve(__dirname, "../../public/js/automations.js"), "utf8");
  (0, eval)(src);
  scopeTooltip = (win as unknown as { _scopeTooltip: typeof scopeTooltip })._scopeTooltip;
});

/** Filter half of the tooltip. */
function filterLine(r: Record<string, unknown>): string {
  return scopeTooltip(r).split("\n")[0].replace(/^Filter: /, "");
}
/** Actions half of the tooltip. */
function actionsLine(r: Record<string, unknown>): string {
  return scopeTooltip(r).split("\n")[1].replace(/^Actions: /, "");
}

describe("automations scope tooltip — filter row", () => {
  it("always emits exactly a Filter row and an Actions row", () => {
    const lines = scopeTooltip({ scope: { allAssets: true } }).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("Filter: ")).toBe(true);
    expect(lines[1].startsWith("Actions: ")).toBe(true);
  });

  it("spells out a condition tree rather than counting it", () => {
    expect(filterLine({
      scope: { condition: { op: "and", children: [
        { field: "assetType", operator: "equals", value: "access_point" },
        { field: "tag", operator: "has", value: "region:nashville" },
      ] } },
    })).toBe("assetType equals access_point AND tag has region:nashville");
  });

  it("renders each group operator, and parenthesizes nested groups", () => {
    const nested = { op: "or", children: [
      { field: "os", operator: "contains", value: "Windows" },
      { op: "and", children: [
        { field: "model", operator: "equals", value: "FG-60F" },
        { field: "status", operator: "equals", value: "active" },
      ] },
    ] };
    expect(filterLine({ scope: { condition: nested } }))
      .toBe("os contains Windows OR (model equals FG-60F AND status equals active)");
    expect(filterLine({ scope: { condition: { op: "none", children: [{ field: "tag", operator: "has", value: "lab" }] } } }))
      .toBe("NOT(tag has lab)");
    const notAll = { op: "notAll", children: [
      { field: "tag", operator: "has", value: "lab" },
      { field: "tag", operator: "has", value: "test" },
    ] };
    expect(filterLine({ scope: { condition: notAll } })).toBe("NOT(tag has lab AND tag has test)");
  });

  it("describes an all-assets scope and falls back to the cell summary otherwise", () => {
    expect(filterLine({ scope: { allAssets: true } })).toBe("Every asset Polaris knows about.");
    expect(filterLine({ scope: { assetTypes: ["firewall"], tags: ["core"] } }))
      .toBe("types: firewall; tags: core");
    expect(filterLine({ scope: {} })).toBe("n/a");
  });

  it("survives an empty condition group instead of rendering a bare label", () => {
    expect(filterLine({ scope: { condition: { op: "and", children: [] } } })).toBe("(no conditions)");
  });
});

describe("automations scope tooltip — actions row", () => {
  it("names the in-app alert even when nothing else is configured", () => {
    // Every automation writes an in-app alert (the wizard's non-removable
    // card) — an empty action list is not a silent automation.
    expect(actionsLine({ scope: {}, actions: [] })).toBe("in-app alert");
    expect(actionsLine({ scope: {} })).toBe("in-app alert");
  });

  it("counts and pluralizes each action type", () => {
    expect(actionsLine({
      scope: {},
      actions: [{ type: "notify" }, { type: "notify" }, { type: "script" }],
    })).toBe("in-app alert + 2 notifications + 1 script run");
    expect(actionsLine({ scope: {}, actions: [{ type: "api_call" }] }))
      .toBe("in-app alert + 1 API call");
  });

  it("counts severity-band and dedicated-resolved actions too", () => {
    expect(actionsLine({
      scope: {},
      actions: [{ type: "notify" }],
      severityBands: [{ severity: "critical", threshold: 95, actions: [{ type: "script" }] }],
      bandNotify: { resolvedMode: "dedicated", resolvedActions: [{ type: "notify" }] },
    })).toBe("in-app alert + 2 notifications + 1 script run");
  });

  it("tallies escalation tiers from all four places a chain can live", () => {
    const tier = { afterMin: 15, actions: [] };
    expect(actionsLine({
      scope: {},
      escalation: { tiers: [tier] },                                   // rule level
      actions: [{ type: "notify", escalation: { tiers: [tier, tier] } }], // per-action
      severityBands: [{
        severity: "critical",
        threshold: 95,
        escalation: { tiers: [tier] },                                 // band level
        actions: [{ type: "notify", escalation: { tiers: [tier] } }],   // per-band-action
      }],
    })).toBe("in-app alert + 2 notifications (5 escalation tiers)");
  });

  it("omits the escalation clause when no chain has tiers", () => {
    expect(actionsLine({ scope: {}, actions: [{ type: "notify" }], escalation: { tiers: [] } }))
      .toBe("in-app alert + 1 notification");
  });

  it("does not throw on malformed action / band entries", () => {
    expect(() => scopeTooltip({
      scope: {},
      actions: [null, {}, { type: "notify" }],
      severityBands: [null, { actions: null }],
    })).not.toThrow();
  });
});
