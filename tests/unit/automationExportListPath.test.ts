/**
 * The LIST export path goes row -> _ruleToInput -> stripForExport, a different
 * route from the wizard's buildPayload. Pin that it also produces a body the
 * real schema accepts, and that it carries no ids.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));
import { ruleInputSchema } from "../../src/services/notificationTypes.js";

const g = globalThis as Record<string, unknown>;

interface Port {
  stripForExport(b: unknown, c?: unknown): { rule: Record<string, unknown>; dependencies: unknown[] };
  buildExportFile(b: unknown, c?: unknown, m?: unknown): Record<string, unknown>;
}

let ruleToInput: (r: unknown, o?: unknown) => Record<string, unknown>;
let P: Port;

beforeAll(() => {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  win.document.body.innerHTML = '<button id="btn-refresh"></button>';
  g.escapeHtml = (s: unknown) => String(s == null ? "" : s);
  g.showToast = () => {};
  g.showConfirm = async () => false;
  // permAtLeast=false keeps bootPage from initializing the rules table, so the
  // script loads inert — only the module-scope functions matter here (the
  // automationsRuleToInput.test.ts harness does exactly this).
  g.permAtLeast = () => false;
  g.api = {};

  const listSrc = readFileSync(resolve("public/js/automations.js"), "utf8");
  (0, eval)(listSrc);
  ruleToInput = (win as unknown as { _ruleToInput: typeof ruleToInput })._ruleToInput;

  (0, eval)(readFileSync(resolve("public/js/automations-portability.js"), "utf8"));
  P = (g.window as unknown as { PolarisAutomationPortability: Port }).PolarisAutomationPortability;
});

describe("list-row export path", () => {
  /** A row as GET /automations returns it: v2 fields PLUS the legacy mirror that
   *  withV2 spreads in, plus the list-render extras. */
  const row = {
    id: "rule-1",
    name: "Switch temp high",
    description: "watch it",
    enabled: true,
    severity: "warning",
    trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">=", threshold: 80, forDurationSec: 300 },
    scope: { assetTypes: ["switch"], assetIds: ["a1"] },
    reset: { mode: "auto", clearThreshold: 70 },
    actions: [{ type: "event" }, { type: "notify", channelId: "ch-9", recipientUserIds: ["user-9"] }],
    escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 10, actions: [{ type: "notify", channelId: "ch-9", recipientUserIds: ["user-9"] }] }] },
    severityBands: null,
    bandNotify: null,
    resetActions: null,
    emailComposition: null,
    cooldownSec: 300,
    messageTemplate: "{asset}",
    requireAckNote: false,
    channels: ["in_app"],
    // The legacy mirror, which withV2 spreads onto every row.
    targets: [{ channelId: "ch-9", recipientUserIds: ["user-9"] }],
    clearBehavior: "auto",
    clearAfterSec: null,
    // List-render extras.
    createdBy: "dmoore",
    createdAt: "2026-08-01T00:00:00.000Z",
    triggerType: "asset_metric",
    devicesSummary: "Switches",
  };

  it("_ruleToInput is reachable from the list module", () => {
    expect(typeof ruleToInput).toBe("function");
  });

  it("row -> _ruleToInput -> stripForExport parses as a valid rule input", () => {
    const stripped = P.stripForExport(ruleToInput(row), {
      channels: [{ id: "ch-9", name: "NOC email" }],
      users: [{ id: "user-9", username: "oncall" }],
    });
    const parsed = ruleInputSchema.safeParse(stripped.rule);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
    }
  });

  it("the exported file names the channel and the user but carries neither id", () => {
    const file = P.buildExportFile(ruleToInput(row), {
      channels: [{ id: "ch-9", name: "NOC email" }],
      users: [{ id: "user-9", username: "oncall" }],
      assets: [{ id: "a1", hostname: "CORE-SW-01" }],
    });
    const text = JSON.stringify(file);
    expect(text).toContain("NOC email");
    expect(text).toContain("oncall");
    expect(text).toContain("CORE-SW-01");
    expect(text).not.toContain("ch-9");
    expect(text).not.toContain("user-9");
    // The legacy mirror must not ride along either — it is a live schema field,
    // and an import that carried `targets` would resurrect delivery wiring.
    const rule = file.rule as Record<string, unknown>;
    expect(rule.targets).toBeUndefined();
    expect(rule.clearBehavior).toBeUndefined();
  });
});
