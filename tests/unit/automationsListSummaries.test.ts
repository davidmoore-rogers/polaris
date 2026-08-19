/**
 * tests/unit/automationsListSummaries.test.ts — the Automations list's four
 * prose columns (`_ruleSummaries` in public/js/automations.js).
 *
 * The list used to carry one terse Scope cell ("custom filter (3 conditions)"),
 * so telling two automations apart meant opening both. These columns describe
 * each part of the automation in the SAME words the wizard uses — the trigger
 * and reset strings come from the shared `PolarisAutomationSentences` factory,
 * which is the property worth pinning: a second phrasing here would let the list
 * and the editor disagree about one automation.
 *
 * The other property is that the cells are PLAIN TEXT. TableSF filters and sorts
 * on these strings, so markup left in them would be matched by a search for
 * "strong" and would sort as tags.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
type Rule = Record<string, unknown>;
let S: {
  devices: (r: Rule) => string;
  trigger: (r: Rule) => string;
  reset: (r: Rule) => string;
  actions: (r: Rule) => string;
};

/** Enough schema for the sentence factory to name things properly. */
const SCHEMA = {
  metricMeta: {
    cpuPct: { label: "CPU usage", unit: "%" },
    probeLossPct: { label: "Packet loss (probe)", unit: "%" },
  },
  comparatorPhrases: { ">": "is above", ">=": "is at or above", "<=": "is at or below", "==": "is", "!=": "is not" },
  inverseComparators: { ">": "<=", ">=": "<", "<": ">=", "<=": ">", "==": "!=", "!=": "==" },
  aggregationPhrases: { latest: "", avg: "avg over", median: "median over" },
  windowedRatioMetrics: ["probeLossPct"],
  scopeCondition: {
    fields: [
      { field: "assetType", label: "Device type" },
      { field: "tag", label: "Tag" },
    ],
    operatorLabels: { equals: "is equal to", has: "is applied" },
  },
  fieldMeta: { monitorStatus: { label: "Monitor status" } },
};

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
  // The sentence factory lives in the wizard file, which the page loads
  // alongside this one — the summaries reach it through window.
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/automations-wizard.js"), "utf8"));
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/automations.js"), "utf8"));
  // AFTER both: the wizard file declares its own `_ruleSchema` at top level, so
  // an earlier assignment is overwritten by its null initializer. Both files
  // read the global lazily, which is what makes this order work.
  g._ruleSchema = SCHEMA;
  S = (win as unknown as { _ruleSummaries: typeof S })._ruleSummaries;
});

const METRIC_RULE: Rule = {
  name: "Hot CPU",
  severity: "warning",
  trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
  scope: { condition: { op: "and", children: [{ field: "assetType", operator: "equals", value: "switch" }] } },
  reset: { mode: "auto", clearThreshold: 75 },
  actions: [{ type: "event" }, { type: "notify", channelId: "c1" }],
};

describe("Devices column", () => {
  it("spells a condition tree out in the builder's own words", () => {
    expect(S.devices(METRIC_RULE)).toBe("Device type is equal to switch");
  });

  it("says All devices for an unfiltered automation", () => {
    expect(S.devices({ scope: { allAssets: true } })).toBe("All devices");
  });

  it("falls back to the flat dimensions a pre-builder rule carries", () => {
    expect(S.devices({ scope: { assetTypes: ["switch", "firewall"] } })).toContain("switch/firewall");
  });

  it("never renders empty for a scope-less rule", () => {
    expect(S.devices({}).length).toBeGreaterThan(0);
  });
});

describe("Trigger column", () => {
  it("is the wizard's own trigger sentence, as plain text", () => {
    const out = S.trigger(METRIC_RULE);
    expect(out).toContain("CPU usage");
    expect(out).toContain("avg over 5 minutes");
    expect(out).toContain("is above 90 %");
    // Plain text: TableSF filters and sorts on this string.
    expect(out).not.toMatch(/<[a-z/]/i);
  });

  it("names every severity a banded automation can raise", () => {
    const out = S.trigger({
      ...METRIC_RULE,
      severityBands: [{ threshold: 95, severity: "critical" }],
    });
    expect(out).toContain("warning");
    expect(out).toContain("critical");
  });

  it("degrades to the trigger type rather than throwing on a shape it can't phrase", () => {
    expect(S.trigger({ trigger: { type: "change" } }).length).toBeGreaterThan(0);
  });
});

describe("Reset column", () => {
  it("carries the hysteresis clear line", () => {
    const out = S.reset(METRIC_RULE);
    expect(out).toContain("is at or below 75 %");
    expect(out).not.toMatch(/<[a-z/]/i);
  });

  it("says a manual automation stays until someone clears it", () => {
    expect(S.reset({ ...METRIC_RULE, reset: { mode: "manual" } })).toMatch(/clears it manually/i);
  });

  it("carries the monitor-status caveat into the list", () => {
    const out = S.reset({
      severity: "critical",
      trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
      reset: { mode: "auto" },
    });
    expect(out).toMatch(/first successful probe/i);
  });
});

describe("Actions column", () => {
  it("leads with the in-app alert every automation has", () => {
    expect(S.actions(METRIC_RULE).startsWith("in-app alert")).toBe(true);
  });

  it("counts escalation tiers from every place a chain can live", () => {
    const out = S.actions({
      actions: [{ type: "notify", channelId: "c1", escalation: { tiers: [{ afterMin: 10 }] } }],
      escalation: { tiers: [{ afterMin: 5 }] },
      severityBands: [{
        severity: "critical",
        escalation: { tiers: [{ afterMin: 15 }] },
        actions: [{ type: "notify", channelId: "c1", escalation: { tiers: [{ afterMin: 20 }] } }],
      }],
    });
    expect(out).toContain("4 escalation tiers");
  });
});
