/**
 * tests/unit/notificationEventTail.test.ts — the engine's event-tail fixes
 * that make event-trigger automations safe to seed at scale:
 *
 *   - cooldownSec enforcement: the tail has no per-(rule,asset) state rows, so
 *     cooldown is checked against recent Notification rows + an in-batch map
 *     (a single 1000-event batch self-dedupes). Keyed by assetId-or-
 *     resourceName so two integrations' failures never suppress each other.
 *   - runEventRuleTimedClear: event/change rules with reset.mode=timed get
 *     their uncleared notifications cleared after afterSec — the regular timed
 *     sweeps walk NotificationRuleState rows, which the event tail never
 *     creates (pre-fix: timed event rules simply never cleared).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const db = {
  rules: [] as any[],
  events: [] as any[],
  recentNotifs: [] as any[],
  created: [] as any[],
  updateManyCalls: [] as any[],
  settings: new Map<string, any>(),
};

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationRule: { findMany: vi.fn(async () => db.rules) },
    event: { findMany: vi.fn(async () => db.events) },
    notification: {
      findMany: vi.fn(async () => db.recentNotifs),
      createMany: vi.fn(async ({ data }: any) => {
        db.created.push(...data);
        return { count: data.length };
      }),
      updateMany: vi.fn(async (args: any) => {
        db.updateManyCalls.push(args);
        return { count: 0 };
      }),
    },
    setting: {
      findUnique: vi.fn(async ({ where }: any) => db.settings.get(where.key) ?? null),
      upsert: vi.fn(async ({ where, create }: any) => {
        db.settings.set(where.key, { key: where.key, value: create.value });
        return create;
      }),
    },
    asset: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    notificationRuleState: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import { evaluateAllNotificationRules, runEventRuleTimedClear } from "../../src/services/notificationEngine.js";

const NOW = Date.now();

function eventRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "r-ev",
    name: "Discovery failed",
    description: null,
    enabled: true,
    severity: "serious",
    trigger: { type: "event", actionPattern: "integration.discover.error" },
    scope: {},
    reset: { mode: "timed", afterSec: 3600 },
    actions: [],
    targets: [],
    clearBehavior: "timed",
    clearAfterSec: 3600,
    cooldownSec: 600,
    messageTemplate: null,
    emailComposition: null,
    escalation: null,
    severityBands: null,
    bandNotify: null,
    channels: ["in_app"],
    ...overrides,
  };
}

function discoverErrorEvent(resourceName: string, atMsAgo: number) {
  return {
    id: `e-${resourceName}-${atMsAgo}`,
    timestamp: new Date(NOW - atMsAgo),
    action: "integration.discover.error",
    resourceType: "integration",
    resourceId: `i-${resourceName}`,
    resourceName,
    level: "error",
    message: `Discovery failed for ${resourceName}`,
    details: null,
    actor: "system:discovery",
  };
}

beforeEach(() => {
  db.rules.length = 0;
  db.events.length = 0;
  db.recentNotifs.length = 0;
  db.created.length = 0;
  db.updateManyCalls.length = 0;
  db.settings.clear();
});

describe("event-tail cooldown", () => {
  it("two matching events for the same resource inside the window fire ONCE (in-batch dedupe)", async () => {
    db.rules.push(eventRule());
    db.events.push(discoverErrorEvent("FMG-1", 120_000), discoverErrorEvent("FMG-1", 60_000));
    await evaluateAllNotificationRules();
    expect(db.created).toHaveLength(1);
    expect(db.created[0]).toMatchObject({ ruleId: "r-ev", assetHostname: "FMG-1" });
  });

  it("different resources never suppress each other", async () => {
    db.rules.push(eventRule());
    db.events.push(discoverErrorEvent("FMG-1", 120_000), discoverErrorEvent("FMG-2", 60_000));
    await evaluateAllNotificationRules();
    expect(db.created.map((n) => n.assetHostname).sort()).toEqual(["FMG-1", "FMG-2"]);
  });

  it("a recent stored notification suppresses a new fire for the same key", async () => {
    db.rules.push(eventRule());
    db.recentNotifs.push({ ruleId: "r-ev", assetId: null, assetHostname: "FMG-1", triggeredAt: new Date(NOW - 120_000) });
    db.events.push(discoverErrorEvent("FMG-1", 60_000));
    await evaluateAllNotificationRules();
    expect(db.created).toHaveLength(0);
  });

  it("an event past the cooldown window fires again", async () => {
    db.rules.push(eventRule({ cooldownSec: 60 }));
    db.recentNotifs.push({ ruleId: "r-ev", assetId: null, assetHostname: "FMG-1", triggeredAt: new Date(NOW - 300_000) });
    db.events.push(discoverErrorEvent("FMG-1", 10_000));
    await evaluateAllNotificationRules();
    expect(db.created).toHaveLength(1);
  });

  it("no cooldown configured → every matching event fires (pre-feature behavior)", async () => {
    db.rules.push(eventRule({ cooldownSec: null }));
    db.events.push(discoverErrorEvent("FMG-1", 120_000), discoverErrorEvent("FMG-1", 60_000));
    await evaluateAllNotificationRules();
    expect(db.created).toHaveLength(2);
  });
});

describe("runEventRuleTimedClear", () => {
  const asDbRule = (r: Record<string, unknown>) => ({
    id: r.id, name: r.name, description: null, severity: "serious",
    trigger: r.trigger, scope: {}, reset: r.reset, actions: [],
    cooldownSec: null, messageTemplate: null, emailComposition: null,
    escalation: null, severityBands: null, bandNotify: null,
  });

  it("clears uncleared notifications older than afterSec for timed event rules only", async () => {
    const rules = [
      asDbRule({ id: "r-timed", name: "timed", trigger: { type: "event", actionPattern: "x.*" }, reset: { mode: "timed", afterSec: 3600 } }),
      asDbRule({ id: "r-manual", name: "manual", trigger: { type: "event", actionPattern: "y.*" }, reset: { mode: "manual" } }),
      asDbRule({ id: "r-metric", name: "metric", trigger: { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 }, reset: { mode: "timed", afterSec: 3600 } }),
    ];
    const now = new Date();
    await runEventRuleTimedClear(rules as never, now);
    expect(db.updateManyCalls).toHaveLength(1);
    const call = db.updateManyCalls[0];
    expect(call.where.ruleId).toBe("r-timed");
    expect(call.where.cleared).toBe(false);
    expect(call.where.triggeredAt.lte.getTime()).toBe(now.getTime() - 3600_000);
    expect(call.data).toMatchObject({ cleared: true, clearedBy: "system:timed" });
  });

  it("change-trigger rules with timed reset are swept too", async () => {
    const rules = [
      asDbRule({ id: "r-change", name: "change", trigger: { type: "change", changeType: "lldp_neighbor_added" }, reset: { mode: "timed", afterSec: 60 } }),
    ];
    await runEventRuleTimedClear(rules as never, new Date());
    expect(db.updateManyCalls).toHaveLength(1);
    expect(db.updateManyCalls[0].where.ruleId).toBe("r-change");
  });
});
