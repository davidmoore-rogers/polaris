/**
 * tests/unit/notificationEscalationV2.test.ts — B7 escalation v2:
 * the sweep drives tiers through automationActionService.executeActions.
 *
 * The load-bearing suite is LEGACY OUTPUT PARITY: a pre-v2 email tier swept
 * through the new pipeline must produce delivery rows identical to the old
 * sweep's (per-field tier→rule composition fallback, always-composed,
 * "[ESCALATION n]" default-subject prefix, tier-only cc/bcc, escalation meta,
 * retry-until-something-sends state semantics). Plus: v2 tiers carrying
 * api_call actions execute + the acknowledged/stopOn gate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  rules: [] as any[],
  notifs: [] as any[],
  channels: [] as any[],
  deliveries: [] as any[],
  notifUpdates: [] as any[],
};

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationRule: { findMany: vi.fn(async () => db.rules) },
    notification: {
      findMany: vi.fn(async () => db.notifs),
      update: vi.fn(async (args: any) => {
        db.notifUpdates.push(args);
        return {};
      }),
    },
    asset: { findMany: vi.fn(async () => []) },
    notificationChannel: { findMany: vi.fn(async ({ where }: any) => db.channels.filter((c) => where.id.in.includes(c.id))) },
    notificationDelivery: {
      createMany: vi.fn(async ({ data }: any) => {
        db.deliveries.push(...data);
        return { count: data.length };
      }),
      create: vi.fn(async ({ data }: any) => {
        db.deliveries.push(data);
        return { id: "d", ...data };
      }),
    },
    user: { findMany: vi.fn(async () => []) },
    pushSubscription: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import { runEscalationSweep, tierIsDue } from "../../src/services/notificationEscalationService.js";

const NOW = new Date("2026-07-21T12:00:00Z");
const T35_AGO = new Date(NOW.getTime() - 35 * 60_000);

const CTX = {
  asset: "sw-core-1",
  value: "95",
  threshold: "90",
  severity: "warning",
  "severity.upper": "WARNING",
  link: "",
  message: "cpu hot",
};

function seedRule(overrides: Record<string, unknown> = {}) {
  db.rules.push({
    id: "r1",
    name: "cpu rule",
    description: null,
    scope: {},
    emailComposition: null,
    escalation: null,
    targets: [],
    clearBehavior: "manual",
    clearAfterSec: null,
    reset: { mode: "manual" },
    actions: [],
    ...overrides,
  });
}

function seedNotif(overrides: Record<string, unknown> = {}) {
  db.notifs.push({
    id: "n1",
    ruleId: "r1",
    assetId: null,
    assetHostname: "sw-core-1",
    severity: "warning",
    message: "cpu hot",
    triggeredAt: T35_AGO,
    acknowledged: false,
    templateCtx: CTX,
    escalationState: null,
    ...overrides,
  });
}

beforeEach(() => {
  db.rules.length = 0;
  db.notifs.length = 0;
  db.channels.length = 0;
  db.deliveries.length = 0;
  db.notifUpdates.length = 0;
  db.channels.push({ id: "ch-email", type: "smtp", enabled: true });
});

describe("legacy email-tier output parity", () => {
  it("tier with no overrides renders the RULE composition (no prefix) with tier recipients + escalation meta", async () => {
    seedRule({
      emailComposition: { subjectTemplate: "RULE {asset}", bodyTextTemplate: "BODY {value}" },
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 30, channelId: "ch-email", to: { addresses: ["oncall@example.com"] } }] },
    });
    seedNotif();

    const runs = await runEscalationSweep(NOW);
    expect(runs).toBe(1);
    expect(db.deliveries).toHaveLength(1);
    const row = db.deliveries[0];
    expect(row.channelId).toBe("ch-email");
    expect(row.transport).toBe("email");
    expect(row.target).toBe("oncall@example.com");
    expect(row.meta).toEqual({
      composed: true,
      to: ["oncall@example.com"],
      cc: [],
      bcc: [],
      subject: "RULE sw-core-1",
      text: "BODY 95",
      escalation: { tier: 1, attempt: 1 },
    });
    // escalationState bookkeeping
    expect(db.notifUpdates).toHaveLength(1);
    expect(db.notifUpdates[0].data.escalationState.tiers["0"].count).toBe(1);
  });

  it("no subject template anywhere → default subject with the [ESCALATION n] prefix", async () => {
    seedRule({
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 30, channelId: "ch-email", to: { addresses: ["a@example.com"] } }] },
    });
    seedNotif();
    await runEscalationSweep(NOW);
    expect(db.deliveries[0].meta.subject).toBe("[ESCALATION 1] [WARNING] sw-core-1");
    // default body = message + no link (empty link in ctx)
    expect(db.deliveries[0].meta.text).toBe("cpu hot");
  });

  it("tier subject-only override keeps the RULE body (per-field merge) and tier cc", async () => {
    seedRule({
      emailComposition: { subjectTemplate: "RULE {asset}", bodyTextTemplate: "BODY {value}" },
      escalation: {
        stopOn: "acknowledge",
        tiers: [{
          afterMin: 30, channelId: "ch-email",
          to: { addresses: ["a@example.com"] },
          cc: { addresses: ["cc@example.com"] },
          subjectTemplate: "TIER {escalation.tier} {asset}",
        }],
      },
    });
    seedNotif();
    await runEscalationSweep(NOW);
    const meta = db.deliveries[0].meta;
    expect(meta.subject).toBe("TIER 1 sw-core-1"); // tier wins, no prefix
    expect(meta.text).toBe("BODY 95"); // rule body survives a subject-only override
    expect(meta.cc).toEqual(["cc@example.com"]);
  });

  it("a tier whose channel is disabled does NOT count as sent — retried next sweep", async () => {
    db.channels[0].enabled = false;
    seedRule({
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 30, channelId: "ch-email", to: { addresses: ["a@example.com"] } }] },
    });
    seedNotif();
    const runs = await runEscalationSweep(NOW);
    expect(runs).toBe(0);
    expect(db.deliveries).toHaveLength(0);
    expect(db.notifUpdates).toHaveLength(0); // no state bump → tier stays due
  });

  it("acknowledged notification stops stopOn=acknowledge but not stopOn=clear", async () => {
    seedRule({
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 30, channelId: "ch-email", to: { addresses: ["a@example.com"] } }] },
    });
    seedNotif({ acknowledged: true });
    expect(await runEscalationSweep(NOW)).toBe(0);

    db.rules[0].escalation.stopOn = "clear";
    expect(await runEscalationSweep(NOW)).toBe(1);
  });
});

describe("v2 tiers of actions", () => {
  it("an api_call tier action enqueues a NULL-channel delivery with escalation meta + rendered body", async () => {
    seedRule({
      escalation: {
        stopOn: "acknowledge",
        tiers: [{
          afterMin: 30,
          actions: [{ type: "api_call", method: "POST", url: "https://pager.example.com/esc", bodyTemplate: '{"asset":"{asset}","tier":{escalation.tier}}', timeoutSec: 15 }],
        }],
      },
    });
    seedNotif();
    const runs = await runEscalationSweep(NOW);
    expect(runs).toBe(1);
    expect(db.deliveries).toHaveLength(1);
    const row = db.deliveries[0];
    expect(row.transport).toBe("api_call");
    expect(row.channelId).toBeNull();
    expect(row.meta.body).toBe('{"asset":"sw-core-1","tier":1}');
    expect(row.meta.escalation).toEqual({ tier: 1, attempt: 1 });
  });

  it("a mixed tier (notify + api_call) executes both from one due tier", async () => {
    seedRule({
      escalation: {
        stopOn: "acknowledge",
        tiers: [{
          afterMin: 30,
          actions: [
            { type: "notify", channelId: "ch-email", addresses: ["a@example.com"], emailComposition: null },
            { type: "api_call", method: "POST", url: "https://pager.example.com/esc", timeoutSec: 15 },
          ],
        }],
      },
    });
    seedNotif();
    expect(await runEscalationSweep(NOW)).toBe(1);
    const transports = db.deliveries.map((d) => d.transport).sort();
    expect(transports).toEqual(["api_call", "email"]);
    // notify action in an escalation is ALWAYS composed (legacy semantics)
    const email = db.deliveries.find((d) => d.transport === "email")!;
    expect(email.meta.composed).toBe(true);
    expect(email.meta.subject).toBe("[ESCALATION 1] [WARNING] sw-core-1");
  });
});

describe("tierIsDue (unchanged semantics)", () => {
  const tier = { afterMin: 30, repeatEveryMin: 60, maxRepeats: 2 };
  it("first send after afterMin, repeats per repeatEveryMin, capped at maxRepeats", () => {
    const t0 = new Date("2026-07-21T00:00:00Z");
    expect(tierIsDue(tier, t0, undefined, new Date(t0.getTime() + 29 * 60_000))).toBe(false);
    expect(tierIsDue(tier, t0, undefined, new Date(t0.getTime() + 31 * 60_000))).toBe(true);
    const sent = { firstSentAt: new Date(t0.getTime() + 31 * 60_000).toISOString(), lastSentAt: new Date(t0.getTime() + 31 * 60_000).toISOString(), count: 1 };
    expect(tierIsDue(tier, t0, sent, new Date(t0.getTime() + 60 * 60_000))).toBe(false);
    expect(tierIsDue(tier, t0, sent, new Date(t0.getTime() + 92 * 60_000))).toBe(true);
    expect(tierIsDue(tier, t0, { ...sent, count: 2 }, new Date(t0.getTime() + 300 * 60_000))).toBe(false);
  });
});
