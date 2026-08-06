/**
 * tests/unit/seedBaselineAutomations.test.ts — the baseline-automation seed:
 * every seed body parses through the real ruleInputSchema, the V2 event set is
 * gated by its OWN run-once marker (so pre-V2 installs pick it up without
 * duplicating the original widget set), every event rule is storm-proofed
 * (timed reset + cooldown), and each actionPattern glob is pinned against the
 * verified logEvent action strings it must (and must not) match.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const settings = new Map<string, { key: string; value: unknown }>();
const createdRules: string[] = [];

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: {
      findUnique: vi.fn(async ({ where }: any) => settings.get(where.key) ?? null),
      upsert: vi.fn(async ({ where, create }: any) => {
        settings.set(where.key, { key: where.key, value: create.value });
        return create;
      }),
    },
  },
}));

vi.mock("../../src/services/notificationRuleService.js", () => ({
  createRule: vi.fn(async (input: { name: string }) => {
    createdRules.push(input.name);
    return { id: `r-${createdRules.length}`, ...input };
  }),
}));

// The module runs itself as a startup task at import time — neuter the
// instrumented wrapper so the import is inert and each test drives the seed.
vi.mock("../../src/jobs/_metrics.js", () => ({ runInstrumentedJob: vi.fn(async () => {}) }));

import {
  seedBaselineAutomations,
  BASELINE_RULES,
  EVENT_BASELINE_RULES,
} from "../../src/jobs/seedBaselineAutomations.js";
import { ruleInputSchema } from "../../src/services/notificationTypes.js";
import { globToRegExp } from "../../src/services/notificationEngine.js";

beforeEach(() => {
  settings.clear();
  createdRules.length = 0;
});

describe("seed bodies", () => {
  it("every baseline rule (both sets) parses through the real ruleInputSchema", () => {
    for (const raw of [...BASELINE_RULES, ...EVENT_BASELINE_RULES]) {
      expect(() => ruleInputSchema.parse(raw), `rule "${(raw as { name?: string }).name}"`).not.toThrow();
    }
  });

  it("every V2 event rule is storm-proofed: timed reset + cooldown + a message template", () => {
    for (const raw of EVENT_BASELINE_RULES) {
      const rule = ruleInputSchema.parse(raw);
      expect(rule.trigger.type, rule.name).toBe("event");
      expect(rule.reset.mode, rule.name).toBe("timed");
      expect(rule.reset.afterSec, rule.name).toBeGreaterThan(0);
      expect(rule.cooldownSec ?? 0, rule.name).toBeGreaterThan(0);
      expect(rule.messageTemplate, rule.name).toBeTruthy();
      expect(rule.actions, rule.name).toEqual([]); // in-app only out of the box
      expect(rule.enabled, rule.name).toBe(true);
    }
  });
});

describe("marker gating (V2 reaches existing installs)", () => {
  it("fresh install: seeds both sets and stamps both markers", async () => {
    const res = await seedBaselineAutomations();
    expect(res.skipped).toBe(false);
    expect(res.created).toBe(BASELINE_RULES.length + EVENT_BASELINE_RULES.length);
    expect(settings.has("seedBaselineAutomationsSeededAt")).toBe(true);
    expect(settings.has("seedBaselineAutomationsV2SeededAt")).toBe(true);
  });

  it("pre-V2 install (v1 marker stamped): seeds ONLY the event set", async () => {
    settings.set("seedBaselineAutomationsSeededAt", { key: "seedBaselineAutomationsSeededAt", value: {} });
    const res = await seedBaselineAutomations();
    expect(res.skipped).toBe(false);
    expect(res.created).toBe(EVENT_BASELINE_RULES.length);
    expect(createdRules).toEqual(EVENT_BASELINE_RULES.map((r) => (r as { name: string }).name));
  });

  it("fully seeded install: no-op", async () => {
    settings.set("seedBaselineAutomationsSeededAt", { key: "x", value: {} });
    settings.set("seedBaselineAutomationsV2SeededAt", { key: "y", value: {} });
    const res = await seedBaselineAutomations();
    expect(res).toEqual({ created: 0, skipped: true });
    expect(createdRules).toEqual([]);
  });
});

describe("actionPattern globs vs the real logEvent action strings", () => {
  const patternOf = (name: string): string => {
    const rule = EVENT_BASELINE_RULES.find((r) => (r as { name: string }).name === name) as { trigger: { actionPattern: string } };
    expect(rule, name).toBeTruthy();
    return rule.trigger.actionPattern;
  };

  it("discovery aborted matches both abort flavors but not the skip breadcrumb or errors", () => {
    const re = globToRegExp(patternOf("Integration discovery aborted"));
    expect(re.test("integration.discover.aborted")).toBe(true);
    expect(re.test("integration.discover.auto_aborted")).toBe(true);
    expect(re.test("integration.discover.auto_abort_skipped")).toBe(false);
    expect(re.test("integration.discover.error")).toBe(false);
    expect(re.test("integration.discover.completed")).toBe(false);
  });

  it("quarantine failures match push + unpush failures but not success/partial/release", () => {
    const re = globToRegExp(patternOf("Quarantine push failed"));
    expect(re.test("asset.quarantine.failed")).toBe(true);
    expect(re.test("asset.quarantine.unpush.failed")).toBe(true);
    expect(re.test("asset.quarantine.succeeded")).toBe(false);
    expect(re.test("asset.quarantine.partial")).toBe(false);
    expect(re.test("asset.quarantine.released")).toBe(false);
    expect(re.test("asset.quarantine.drift_detected")).toBe(false);
  });

  it("reservation push failed is exact — retry/update/permanent flavors have their own handling", () => {
    const re = globToRegExp(patternOf("Reservation push failed"));
    expect(re.test("reservation.push.failed")).toBe(true);
    expect(re.test("reservation.push.update_failed")).toBe(false);
    expect(re.test("reservation.push.queued.failed_permanent")).toBe(false);
    expect(re.test("reservation.push.queued.retry_failed")).toBe(false);
  });

  it("exact-match patterns hit their verified writer action strings", () => {
    const exact: Record<string, string> = {
      "Integration discovery failed": "integration.discover.error",
      "Reservation push permanently failed": "reservation.push.queued.failed_permanent",
      "Agent disconnected": "agent.disconnected",
      "Agent upgrade failed": "agent.upgrade_failed",
      "Capacity severity escalated": "capacity.severity_changed",
      "IP conflict detected": "conflict.detected",
      "Asset auto-decommissioned": "asset.auto_decommissioned",
      "HA standby down": "asset.ha.standby_down",
      "Login lockout engaged": "auth.login.lockout",
    };
    for (const [name, action] of Object.entries(exact)) {
      expect(globToRegExp(patternOf(name)).test(action), `${name} vs ${action}`).toBe(true);
    }
    // lockout ≠ the per-attempt "locked" breadcrumb (which fires on every try
    // against a locked account and would be noisy).
    expect(globToRegExp(patternOf("Login lockout engaged")).test("auth.login.locked")).toBe(false);
  });

  it("capacity escalations alert; recoveries are filtered by detailsMatch", () => {
    const rule = EVENT_BASELINE_RULES.find((r) => (r as { name: string }).name === "Capacity severity escalated") as {
      trigger: { detailsMatch?: Record<string, unknown> };
    };
    expect(rule.trigger.detailsMatch).toEqual({ direction: "escalated" });
  });
});
