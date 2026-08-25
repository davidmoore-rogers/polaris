/**
 * tests/unit/notificationRepeat.test.ts
 *
 * Repeating an alert's notifications while it stays unhandled.
 *
 * Four cases here are the reason the feature needed its own machinery rather
 * than a synthetic escalation tier:
 *
 *   - `repeatIsDue` must NOT stop after 5. tierIsDue resolves
 *     `maxRepeats ?? DEFAULT_MAX_REPEATS`, so reusing it would silently cap the
 *     one behaviour that was explicitly asked to be unbounded.
 *   - a REPEAT-ONLY automation must be swept at all. The per-notification loop
 *     used to `continue` on "no escalation chains" before the suppression
 *     check, which such a rule hits — that single early return would disable
 *     the whole feature.
 *   - a repeat re-runs NOTIFY actions only. Unbounded re-execution of a
 *     ticket-creating webhook or a registry script is a different order of
 *     blast radius from an extra email.
 *   - a reminder is labelled a REMINDER, not an escalation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  rules: [] as any[],
  notifs: [] as any[],
  channels: [] as any[],
  deliveries: [] as any[],
  notifUpdates: [] as any[],
  scriptRuns: [] as any[],
  events: [] as any[],
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
    notificationChannel: {
      findMany: vi.fn(async ({ where }: any) => db.channels.filter((c) => where.id.in.includes(c.id))),
    },
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
    setting: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async (e: any) => {
    db.events.push(e);
  }),
}));

// A script action must never be re-run by a reminder; fail loudly if one is.
vi.mock("../../src/services/automationScriptService.js", () => ({
  requestScriptRun: vi.fn(async (args: any) => {
    db.scriptRuns.push(args);
    return { id: "run-1" };
  }),
}));

import { runEscalationSweep, repeatIsDue } from "../../src/services/notificationEscalationService.js";

const NOW = new Date("2026-08-25T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const CTX = {
  asset: "sw-core-1",
  value: "95",
  threshold: "90",
  severity: "warning",
  message: "cpu hot",
  "trigger.summary": "CPU utilization is 95%",
};

function seedRule(overrides: Record<string, unknown> = {}) {
  db.rules.push({
    id: "r1",
    name: "cpu rule",
    description: null,
    scope: {},
    emailComposition: null,
    severity: "warning",
    escalation: null,
    targets: [],
    clearBehavior: "manual",
    clearAfterSec: null,
    reset: { mode: "manual" },
    actions: [],
    severityBands: null,
    repeat: null,
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
    triggeredAt: minsAgo(35),
    acknowledged: false,
    templateCtx: CTX,
    escalationState: null,
    regionTags: [],
    ...overrides,
  });
}

const NOTIFY = { type: "notify", channelId: "ch-email", addresses: ["oncall@example.com"] };

beforeEach(() => {
  db.rules.length = 0;
  db.notifs.length = 0;
  db.channels.length = 0;
  db.deliveries.length = 0;
  db.notifUpdates.length = 0;
  db.scriptRuns.length = 0;
  db.events.length = 0;
  db.channels.push({ id: "ch-email", type: "smtp", enabled: true });
});

describe("repeatIsDue", () => {
  const state = (lastSentMinsAgo: number, count: number) => ({
    firstSentAt: minsAgo(lastSentMinsAgo + 10).toISOString(),
    lastSentAt: minsAgo(lastSentMinsAgo).toISOString(),
    count,
  });

  it("is not due before one interval has passed since the fire", () => {
    expect(repeatIsDue({ everyMin: 15 }, minsAgo(10), undefined, NOW)).toBe(false);
  });

  it("is due one interval after the fire — the initial send IS the first one", () => {
    expect(repeatIsDue({ everyMin: 15 }, minsAgo(15), undefined, NOW)).toBe(true);
    expect(repeatIsDue({ everyMin: 15 }, minsAgo(40), undefined, NOW)).toBe(true);
  });

  it("measures subsequent repeats from the LAST send, not the fire", () => {
    expect(repeatIsDue({ everyMin: 15 }, minsAgo(120), state(5, 3), NOW)).toBe(false);
    expect(repeatIsDue({ everyMin: 15 }, minsAgo(120), state(20, 3), NOW)).toBe(true);
  });

  it("does NOT stop after 5 — the tierIsDue cap must not leak in", () => {
    // The whole reason this is a separate predicate.
    for (const count of [5, 6, 20, 500]) {
      expect(repeatIsDue({ everyMin: 15 }, minsAgo(600), state(20, count), NOW)).toBe(true);
    }
  });

  it("honours an optional stopAfterHours cut-off", () => {
    expect(repeatIsDue({ everyMin: 15, stopAfterHours: 4 }, minsAgo(239), state(20, 9), NOW)).toBe(true);
    expect(repeatIsDue({ everyMin: 15, stopAfterHours: 4 }, minsAgo(241), state(20, 9), NOW)).toBe(false);
  });

  it("treats a null stopAfterHours as unbounded", () => {
    expect(repeatIsDue({ everyMin: 15, stopAfterHours: null }, minsAgo(10_000), state(20, 99), NOW)).toBe(true);
  });
});

describe("the sweep's repeat pass", () => {
  it("sweeps a REPEAT-ONLY automation, which has no escalation chains at all", async () => {
    seedRule({ actions: [NOTIFY], repeat: { everyMin: 15, stopOn: "acknowledge" } });
    seedNotif();

    const runs = await runEscalationSweep(NOW);

    expect(runs).toBe(1);
    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0].target).toBe("oncall@example.com");
    // Progress is recorded under the reserved key, beside any tier keys.
    expect(db.notifUpdates[0].data.escalationState.tiers.repeat.count).toBe(1);
  });

  it("labels the email a REMINDER, never an escalation", async () => {
    seedRule({ actions: [NOTIFY], repeat: { everyMin: 15, stopOn: "acknowledge" } });
    seedNotif();
    await runEscalationSweep(NOW);
    const meta = db.deliveries[0].meta;
    expect(meta.subject).toContain("[REMINDER 1]");
    expect(meta.subject).not.toContain("ESCALATION");
    // Provenance is its own meta key.
    expect(meta.repeat).toEqual({ attempt: 1 });
    expect(meta.escalation).toBeUndefined();
  });

  it("counts up across sweeps", async () => {
    seedRule({ actions: [NOTIFY], repeat: { everyMin: 15, stopOn: "acknowledge" } });
    seedNotif({
      escalationState: { tiers: { repeat: { firstSentAt: minsAgo(40).toISOString(), lastSentAt: minsAgo(20).toISOString(), count: 2 } } },
    });
    await runEscalationSweep(NOW);
    expect(db.deliveries[0].meta.subject).toContain("[REMINDER 3]");
    expect(db.notifUpdates[0].data.escalationState.tiers.repeat.count).toBe(3);
  });

  it("keeps an operator's own subject template verbatim", async () => {
    seedRule({
      actions: [{ ...NOTIFY, emailComposition: { subjectTemplate: "Still broken: {asset} (#{repeat.attempt})" } }],
      repeat: { everyMin: 15, stopOn: "acknowledge" },
    });
    seedNotif();
    await runEscalationSweep(NOW);
    expect(db.deliveries[0].meta.subject).toBe("Still broken: sw-core-1 (#1)");
  });

  it("re-runs NOTIFY only — never a script or an api_call", async () => {
    seedRule({
      actions: [
        NOTIFY,
        { type: "api_call", method: "POST", url: "https://tickets.example.com/new", timeoutSec: 10 },
        { type: "script", scriptId: "s1", runOn: "server" },
        { type: "event" },
      ],
      repeat: { everyMin: 15, stopOn: "acknowledge" },
    });
    seedNotif();

    await runEscalationSweep(NOW);

    // Exactly one delivery — the email. No api_call row, no script run.
    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0].transport).toBe("email");
    expect(db.deliveries.some((d) => d.transport === "api_call")).toBe(false);
    expect(db.scriptRuns).toHaveLength(0);
  });

  it("stops on acknowledge when stopOn is acknowledge", async () => {
    seedRule({ actions: [NOTIFY], repeat: { everyMin: 15, stopOn: "acknowledge" } });
    seedNotif({ acknowledged: true });
    expect(await runEscalationSweep(NOW)).toBe(0);
    expect(db.deliveries).toHaveLength(0);
  });

  it("keeps repeating an acknowledged alert when stopOn is clear", async () => {
    seedRule({ actions: [NOTIFY], repeat: { everyMin: 15, stopOn: "clear" } });
    seedNotif({ acknowledged: true });
    expect(await runEscalationSweep(NOW)).toBe(1);
    expect(db.deliveries).toHaveLength(1);
  });

  it("does not repeat before the interval has elapsed", async () => {
    seedRule({ actions: [NOTIFY], repeat: { everyMin: 60, stopOn: "acknowledge" } });
    seedNotif({ triggeredAt: minsAgo(35) });
    expect(await runEscalationSweep(NOW)).toBe(0);
  });

  it("pauses while the asset is suppressed, and resumes after", async () => {
    seedRule({ actions: [NOTIFY], repeat: { everyMin: 15, stopOn: "acknowledge" } });
    seedNotif({ assetId: "a1" });
    const { prisma } = await import("../../src/db.js");
    (prisma.asset.findMany as any).mockImplementationOnce(async () => [
      { id: "a1", status: "maintenance", dependencySuppressed: false },
    ]);
    expect(await runEscalationSweep(NOW)).toBe(0);

    // Next sweep, window over.
    expect(await runEscalationSweep(NOW)).toBe(1);
  });

  it("writes its OWN audit action, not notification.escalated", async () => {
    seedRule({ actions: [NOTIFY], repeat: { everyMin: 15, stopOn: "acknowledge" } });
    seedNotif();
    await runEscalationSweep(NOW);
    const actions = db.events.map((e) => e.action);
    expect(actions).toContain("notification.repeated");
    expect(actions).not.toContain("notification.escalated");
  });

  it("runs a repeat and a due escalation tier in the same sweep", async () => {
    // Deliberately NOT mutually exclusive: skipping the reminder would drift
    // its clock and make "every 15 minutes" a lie.
    seedRule({
      actions: [NOTIFY],
      repeat: { everyMin: 15, stopOn: "acknowledge" },
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 30, actions: [{ type: "notify", channelId: "ch-email", addresses: ["boss@example.com"] }] }] },
    });
    seedNotif();

    const runs = await runEscalationSweep(NOW);

    expect(runs).toBe(2);
    const subjects = db.deliveries.map((d) => d.meta.subject);
    expect(subjects.some((s: string) => s.includes("[REMINDER 1]"))).toBe(true);
    expect(subjects.some((s: string) => s.includes("[ESCALATION 1]"))).toBe(true);
    const state = db.notifUpdates[0].data.escalationState.tiers;
    // Distinct state keys — the repeat key can never collide with a tier's.
    expect(state.repeat.count).toBe(1);
    expect(state["0"].count).toBe(1);
  });

  it("does not repeat when the automation has no repeat config", async () => {
    seedRule({ actions: [NOTIFY] });
    seedNotif();
    expect(await runEscalationSweep(NOW)).toBe(0);
  });

  it("stops once stopAfterHours has passed", async () => {
    seedRule({ actions: [NOTIFY], repeat: { everyMin: 15, stopOn: "acknowledge", stopAfterHours: 1 } });
    seedNotif({ triggeredAt: minsAgo(90) });
    expect(await runEscalationSweep(NOW)).toBe(0);
  });
});
