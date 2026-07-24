/**
 * tests/unit/notificationSeverityBands.test.ts — severity bands: input
 * validation (ordered numeric trigger, monotonic thresholds, strictly
 * increasing severities), read-path normalization, and the engine's tier /
 * notify-policy resolution. The DB-bound fire/escalate/resolve transitions are
 * exercised by the integration suite + the podman mock walkthrough.
 */

import { describe, it, expect } from "vitest";
import { ruleInputSchema, normalizeRuleToV2 } from "../../src/services/notificationTypes.js";
import { tierForSeverity, bandNotifyOf } from "../../src/services/notificationEngine.js";

const bandedRule = (over: any = {}) => ({
  name: "Core temp",
  trigger: { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 55 },
  severity: "warning",
  scope: { allAssets: true },
  severityBands: [
    { threshold: 60, severity: "serious" },
    { threshold: 65, severity: "critical" },
  ],
  ...over,
});

describe("ruleInputSchema — severity bands", () => {
  it("accepts a valid ascending banded rule", () => {
    const parsed = ruleInputSchema.parse(bandedRule());
    expect(parsed.severityBands).toHaveLength(2);
    expect(parsed.severityBands![0]).toMatchObject({ threshold: 60, severity: "serious", actions: [] });
  });

  it("accepts a descending (<=) banded rule (e.g. days-until-full)", () => {
    expect(() => ruleInputSchema.parse(bandedRule({
      trigger: { type: "asset_metric", metric: "storageDaysUntilFull", operator: "<=", threshold: 30 },
      severityBands: [{ threshold: 14, severity: "serious" }, { threshold: 7, severity: "critical" }],
    }))).not.toThrow();
  });

  it("rejects bands whose severity does not strictly increase above the base", () => {
    expect(() => ruleInputSchema.parse(bandedRule({
      severityBands: [{ threshold: 60, severity: "warning" }], // same as base
    }))).toThrow();
    expect(() => ruleInputSchema.parse(bandedRule({
      severityBands: [{ threshold: 60, severity: "critical" }, { threshold: 65, severity: "serious" }], // decreasing
    }))).toThrow();
  });

  it("accepts a per-tier operator override (tiers share sampling, vary the comparison)", () => {
    const parsed = ruleInputSchema.parse(bandedRule({
      severityBands: [{ threshold: 60, severity: "serious", operator: ">" }],
    }));
    expect((parsed.severityBands![0] as any).operator).toBe(">");
  });

  it("rejects a per-tier equality operator (needs an ordered comparison)", () => {
    expect(() => ruleInputSchema.parse(bandedRule({
      severityBands: [{ threshold: 60, severity: "serious", operator: "==" }],
    }))).toThrow();
  });

  it("no longer requires monotonic thresholds — the most-severe MET tier wins", () => {
    // Threshold below the base is allowed now (per-tier operators make strict
    // threshold ordering meaningless); only severity must strictly increase.
    expect(() => ruleInputSchema.parse(bandedRule({
      severityBands: [{ threshold: 50, severity: "serious" }],
    }))).not.toThrow();
  });

  it("rejects bands on a non-numeric trigger", () => {
    expect(() => ruleInputSchema.parse(bandedRule({
      trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
    }))).toThrow();
  });

  it("rejects bands with an equality operator (no ordering)", () => {
    expect(() => ruleInputSchema.parse(bandedRule({
      trigger: { type: "asset_metric", metric: "hwSensorValue", operator: "==", threshold: 55 },
    }))).toThrow();
  });

  it("applies bandNotify defaults and accepts a resolved policy", () => {
    const parsed = ruleInputSchema.parse(bandedRule({ bandNotify: { onDecrease: true, resolvedMode: "dedicated", resolvedActions: [] } }));
    expect(parsed.bandNotify).toMatchObject({ onIncrease: true, onDecrease: true, onResolved: true, resolvedMode: "dedicated" });
  });
});

describe("normalizeRuleToV2 — bands round-trip", () => {
  it("surfaces stored severityBands + bandNotify", () => {
    const v2 = normalizeRuleToV2({
      severityBands: [{ threshold: 60, severity: "serious", actions: [] }],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
    });
    expect(v2.severityBands).toHaveLength(1);
    expect(v2.bandNotify).toMatchObject({ resolvedMode: "reuse" });
  });

  it("returns null bands/policy for a pre-band row", () => {
    const v2 = normalizeRuleToV2({});
    expect(v2.severityBands).toBeNull();
    expect(v2.bandNotify).toBeNull();
  });
});

describe("tierForSeverity", () => {
  const rule: any = {
    severity: "warning",
    actions: [{ type: "notify", channelId: "base" }],
    escalation: null,
    severityBands: [
      { threshold: 60, severity: "serious", actions: [{ type: "notify", channelId: "sev" }], escalation: null },
      { threshold: 65, severity: "critical", actions: [{ type: "notify", channelId: "crit" }], escalation: null },
    ],
  };
  it("maps the base severity to the base (tier 0) actions", () => {
    expect(tierForSeverity(rule, "warning").actions[0]).toMatchObject({ channelId: "base" });
  });
  it("maps a band severity to that band's actions", () => {
    expect(tierForSeverity(rule, "critical").actions[0]).toMatchObject({ channelId: "crit" });
  });
  it("falls back to tier 0 for an unknown severity", () => {
    expect(tierForSeverity(rule, "notice").actions[0]).toMatchObject({ channelId: "base" });
  });
});

describe("bandNotifyOf", () => {
  it("defaults to increase + resolved (reuse), decrease off", () => {
    expect(bandNotifyOf({ bandNotify: null } as any)).toEqual({ onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse", resolvedActions: [] });
  });
  it("honors an explicit policy", () => {
    expect(bandNotifyOf({ bandNotify: { onIncrease: false, onDecrease: true, onResolved: false, resolvedMode: "dedicated", resolvedActions: [] } } as any))
      .toMatchObject({ onIncrease: false, onDecrease: true, onResolved: false, resolvedMode: "dedicated" });
  });
});
