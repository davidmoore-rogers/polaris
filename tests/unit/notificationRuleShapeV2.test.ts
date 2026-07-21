/**
 * tests/unit/notificationRuleShapeV2.test.ts — Automation rule-shape v2:
 * legacy→v2 conversion fidelity (normalizeRuleToV2 / normalizeReset /
 * targetsToNotifyActions / normalizeEscalationToV2), the legacy mirror
 * (legacyMirrorOfV2), input folding (ruleInputSchema accepts old POST
 * bodies), and the v2 cross-field validation (hysteresis threshold ordering).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  ruleInputSchema,
  previewInputSchema,
  normalizeRuleToV2,
  normalizeReset,
  normalizeEscalationToV2,
  targetsToNotifyActions,
  actionsToTargets,
  legacyMirrorOfV2,
  buildSchemaCatalog,
  type DeliveryTarget,
  type EmailComposition,
} from "../../src/services/notificationTypes.js";

const metricTrigger = { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 };

describe("normalizeReset", () => {
  it("derives reset from legacy clearBehavior/clearAfterSec", () => {
    expect(normalizeReset(null, "manual", null)).toEqual({ mode: "manual" });
    expect(normalizeReset(null, "auto", null)).toEqual({ mode: "auto" });
    expect(normalizeReset(null, "timed", 3600)).toEqual({ mode: "timed", afterSec: 3600 });
    expect(normalizeReset(null, undefined, undefined)).toEqual({ mode: "manual" });
  });

  it("strips mode-irrelevant fields from a provided reset", () => {
    expect(normalizeReset({ mode: "manual", afterSec: 60, clearThreshold: 5 } as any)).toEqual({ mode: "manual" });
    expect(normalizeReset({ mode: "timed", afterSec: 120, clearThreshold: 5 } as any)).toEqual({ mode: "timed", afterSec: 120 });
    expect(normalizeReset({ mode: "auto", clearThreshold: 80, sustainSec: 300, afterSec: 99 } as any)).toEqual({
      mode: "auto", clearThreshold: 80, sustainSec: 300,
    });
  });
});

describe("targetsToNotifyActions / actionsToTargets round-trip", () => {
  const targets: DeliveryTarget[] = [
    { channelId: "ch-email", recipientUserIds: ["u1"], addresses: ["noc@example.com"], recipientScopeRegion: true },
    { channelId: "ch-slack" },
  ];
  const comp: EmailComposition = { subjectTemplate: "[{severity.upper}] {asset}" };

  it("copies the rule-level emailComposition onto every converted notify action", () => {
    const actions = targetsToNotifyActions(targets, comp);
    expect(actions).toHaveLength(2);
    for (const a of actions) {
      expect(a.type).toBe("notify");
      expect((a as any).emailComposition).toEqual(comp);
    }
    expect((actions[0] as any).recipientUserIds).toEqual(["u1"]);
    expect((actions[0] as any).recipientScopeRegion).toBe(true);
    expect((actions[1] as any).recipientUserIds).toBeUndefined();
  });

  it("mirrors notify actions back to targets losslessly (sans per-action composition)", () => {
    const actions = targetsToNotifyActions(targets, comp);
    expect(actionsToTargets(actions)).toEqual(targets);
  });

  it("drops api_call/script actions from the legacy mirror", () => {
    const mixed = [
      ...targetsToNotifyActions([{ channelId: "c1" }], null),
      { type: "api_call" as const, method: "POST" as const, url: "https://example.com/hook", timeoutSec: 15 },
    ];
    expect(actionsToTargets(mixed)).toEqual([{ channelId: "c1" }]);
  });
});

describe("legacyMirrorOfV2", () => {
  it("projects reset back onto clearBehavior/clearAfterSec", () => {
    expect(legacyMirrorOfV2({ mode: "timed", afterSec: 900 }, [])).toEqual({
      clearBehavior: "timed", clearAfterSec: 900, targets: [],
    });
    expect(legacyMirrorOfV2({ mode: "auto", clearThreshold: 55, sustainSec: 60 }, [])).toEqual({
      clearBehavior: "auto", clearAfterSec: null, targets: [],
    });
  });
});

describe("normalizeRuleToV2 (stored rows)", () => {
  it("converts a pre-v2 row (clearBehavior + targets + emailComposition)", () => {
    const v2 = normalizeRuleToV2({
      clearBehavior: "auto",
      clearAfterSec: null,
      targets: [{ channelId: "ch1", addresses: ["a@example.com"] }],
      emailComposition: { subjectTemplate: "s" },
      escalation: null,
      reset: null,
      actions: null,
    });
    expect(v2.reset).toEqual({ mode: "auto" });
    expect(v2.actions).toEqual([
      { type: "notify", channelId: "ch1", addresses: ["a@example.com"], emailComposition: { subjectTemplate: "s" } },
    ]);
    expect(v2.escalation).toBeNull();
  });

  it("prefers persisted v2 columns over the legacy mirror", () => {
    const v2 = normalizeRuleToV2({
      clearBehavior: "manual",
      targets: [{ channelId: "stale" }],
      reset: { mode: "auto", clearThreshold: 55, sustainSec: 120 },
      actions: [{ type: "api_call", method: "POST", url: "https://example.com/x", timeoutSec: 15 }],
    });
    expect(v2.reset).toEqual({ mode: "auto", clearThreshold: 55, sustainSec: 120 });
    expect(v2.actions).toEqual([{ type: "api_call", method: "POST", url: "https://example.com/x", timeoutSec: 15 }]);
  });

  it("drops malformed stored actions defensively instead of throwing", () => {
    const v2 = normalizeRuleToV2({
      reset: { mode: "manual" },
      actions: [{ type: "notify", channelId: "ok" }, { type: "bogus" }, 42],
    });
    expect(v2.actions).toEqual([{ type: "notify", channelId: "ok" }]);
  });
});

describe("normalizeEscalationToV2", () => {
  it("converts legacy email tiers to notify-action tiers, preserving overrides", () => {
    const v2 = normalizeEscalationToV2({
      stopOn: "clear",
      tiers: [
        {
          afterMin: 30,
          channelId: "ch-email",
          to: { recipientUserIds: ["u1"], addresses: ["mgr@example.com"] },
          cc: { addresses: ["cc@example.com"] },
          subjectTemplate: "ESC {asset}",
          repeatEveryMin: 60,
          maxRepeats: 3,
        },
        { afterMin: 120, channelId: "ch-email", to: { addresses: ["oncall@example.com"] } },
      ],
    });
    expect(v2).not.toBeNull();
    expect(v2!.stopOn).toBe("clear");
    expect(v2!.tiers).toHaveLength(2);
    const t1 = v2!.tiers[0]!;
    expect(t1.afterMin).toBe(30);
    expect(t1.repeatEveryMin).toBe(60);
    expect(t1.maxRepeats).toBe(3);
    expect(t1.actions).toEqual([
      {
        type: "notify",
        channelId: "ch-email",
        recipientUserIds: ["u1"],
        addresses: ["mgr@example.com"],
        emailComposition: {
          subjectTemplate: "ESC {asset}",
          bodyTextTemplate: null,
          bodyHtmlTemplate: null,
          cc: { addresses: ["cc@example.com"] },
          bcc: null,
        },
      },
    ]);
    // Tier 2 set no overrides → emailComposition null (executor falls back to
    // the rule-level composition, then the [ESCALATION n] default).
    expect((v2!.tiers[1]!.actions[0] as any).emailComposition).toBeNull();
  });

  it("passes v2 escalation through and rejects malformed shapes to null", () => {
    const v2 = {
      stopOn: "acknowledge",
      tiers: [{ afterMin: 10, actions: [{ type: "notify", channelId: "c" }] }],
    };
    expect(normalizeEscalationToV2(v2)).toEqual({
      stopOn: "acknowledge",
      tiers: [{ afterMin: 10, actions: [{ type: "notify", channelId: "c" }], repeatEveryMin: undefined, maxRepeats: undefined }],
    });
    expect(normalizeEscalationToV2(null)).toBeNull();
    expect(normalizeEscalationToV2({ tiers: [] })).toBeNull();
    expect(normalizeEscalationToV2({ tiers: [{ nonsense: true }] })).toBeNull();
  });
});

describe("ruleInputSchema (v2 input with legacy folding)", () => {
  it("folds a legacy POST body into the v2 canonical shape", () => {
    const parsed = ruleInputSchema.parse({
      name: "legacy body",
      trigger: metricTrigger,
      scope: { allAssets: true },
      clearBehavior: "timed",
      clearAfterSec: 1800,
      targets: [{ channelId: "ch1" }],
      emailComposition: { subjectTemplate: "s" },
    });
    expect(parsed.reset).toEqual({ mode: "timed", afterSec: 1800 });
    expect(parsed.actions).toEqual([{ type: "notify", channelId: "ch1", emailComposition: { subjectTemplate: "s" } }]);
  });

  it("v2 fields win over conflicting legacy fields", () => {
    const parsed = ruleInputSchema.parse({
      name: "both",
      trigger: metricTrigger,
      scope: { allAssets: true },
      clearBehavior: "manual",
      reset: { mode: "auto", clearThreshold: 80, sustainSec: 60 },
      targets: [{ channelId: "stale" }],
      actions: [],
    });
    expect(parsed.reset).toEqual({ mode: "auto", clearThreshold: 80, sustainSec: 60 });
    expect(parsed.actions).toEqual([]);
  });

  it("rejects timed reset without afterSec", () => {
    expect(() =>
      ruleInputSchema.parse({ name: "x", trigger: metricTrigger, scope: { allAssets: true }, reset: { mode: "timed" } }),
    ).toThrow(/afterSec/);
  });

  it("rejects a clear threshold on the wrong side of the fire threshold", () => {
    // op >= 90 ⇒ clearThreshold must be ≤ 90
    expect(() =>
      ruleInputSchema.parse({
        name: "x", trigger: metricTrigger, scope: { allAssets: true },
        reset: { mode: "auto", clearThreshold: 95 },
      }),
    ).toThrow(/at or below/);
    // op <= 10 ⇒ clearThreshold must be ≥ 10
    expect(() =>
      ruleInputSchema.parse({
        name: "x",
        trigger: { type: "asset_metric", metric: "cpuPct", operator: "<=", threshold: 10 },
        scope: { allAssets: true },
        reset: { mode: "auto", clearThreshold: 5 },
      }),
    ).toThrow(/at or above/);
    // equality operators can't carry hysteresis
    expect(() =>
      ruleInputSchema.parse({
        name: "x",
        trigger: { type: "asset_metric", metric: "cpuPct", operator: "==", threshold: 0 },
        scope: { allAssets: true },
        reset: { mode: "auto", clearThreshold: 1 },
      }),
    ).toThrow(/cannot be combined/);
    // non-numeric trigger can't carry hysteresis
    expect(() =>
      ruleInputSchema.parse({
        name: "x",
        trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
        scope: { allAssets: true },
        reset: { mode: "auto", clearThreshold: 1 },
      }),
    ).toThrow(/numeric metric triggers/);
  });

  it("accepts a valid hysteresis + sustain reset", () => {
    const parsed = ruleInputSchema.parse({
      name: "temp",
      trigger: { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 60, dimensionFilter: { sensorClass: "temperature" } },
      scope: { allAssets: true },
      reset: { mode: "auto", clearThreshold: 55, sustainSec: 300 },
    });
    expect(parsed.reset).toEqual({ mode: "auto", clearThreshold: 55, sustainSec: 300 });
  });

  it("accepts api_call actions and rejects non-http(s) URLs", () => {
    const ok = ruleInputSchema.parse({
      name: "hook", trigger: metricTrigger, scope: { allAssets: true },
      actions: [{ type: "api_call", url: "https://example.com/hook", headers: { "X-Env": "prod" } }],
    });
    expect(ok.actions[0]).toMatchObject({ type: "api_call", method: "POST", timeoutSec: 15 });
    expect(() =>
      ruleInputSchema.parse({
        name: "bad", trigger: metricTrigger, scope: { allAssets: true },
        actions: [{ type: "api_call", url: "ftp://example.com/x" }],
      }),
    ).toThrow();
  });
});

describe("previewInputSchema (partial drafts)", () => {
  it("accepts a scope-only body with defaulted name and no trigger", () => {
    const parsed = previewInputSchema.parse({ scope: { assetTypes: ["server"] } });
    expect(parsed.trigger).toBeUndefined();
    expect(parsed.name).toBe("Draft automation");
    expect(parsed.scope).toEqual({ assetTypes: ["server"] });
  });

  it("still validates hysteresis ordering when a trigger is present", () => {
    expect(() =>
      previewInputSchema.parse({ trigger: metricTrigger, reset: { mode: "auto", clearThreshold: 95 } }),
    ).toThrow(/at or below/);
  });
});

describe("buildSchemaCatalog v2 additions", () => {
  it("exposes schemaVersion 2 + the wizard vocabulary", () => {
    const cat = buildSchemaCatalog();
    expect(cat.schemaVersion).toBe(2);
    expect(cat.resetModes).toEqual(["manual", "auto", "timed"]);
    expect(cat.resetModesByTriggerType.event).toEqual(["timed", "manual"]);
    expect(cat.actionTypes.map((a: { type: string }) => a.type)).toEqual(["notify", "api_call", "script"]);
    expect(cat.inverseComparators[">="]).toBe("<");
    expect(cat.comparatorPhrases[">="]).toBe("is at or above");
    expect(cat.escalationMeta.maxTiers).toBe(5);
  });
});
