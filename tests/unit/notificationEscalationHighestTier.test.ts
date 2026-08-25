/**
 * tests/unit/notificationEscalationHighestTier.test.ts — "highest tier wins"
 * recipient suppression in the escalation sweep.
 *
 * A person named by several tiers of ONE chain — the case that prompted this:
 * an operator in two map regions, each region paged by a different tier — is
 * paged once, at the LAST tier that would reach them. The load-bearing cases
 * are the ones where suppressing would LOSE someone rather than de-duplicate
 * them: a later tier whose channel is disabled, a push-only later tier the
 * user has no device for, and a tier in a DIFFERENT chain (independent
 * ladders). Plus the bookkeeping arm: a tier whose whole audience is owned by
 * a higher tier must count as spent, or the sweep retries it every 60s for the
 * life of the alert.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  rules: [] as any[],
  notifs: [] as any[],
  channels: [] as any[],
  users: [] as any[],
  pushSubs: [] as any[],
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
    notificationChannel: {
      // Honours `enabled` because resolveReachableUserIds filters on it and
      // expandDeliveries does not — a mock that ignored it would hide exactly
      // the disabled-later-channel case below.
      findMany: vi.fn(async ({ where }: any) =>
        db.channels.filter((c) => where.id.in.includes(c.id) && (where.enabled === undefined || c.enabled === where.enabled)),
      ),
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
    user: { findMany: vi.fn(async () => db.users) },
    role: { findMany: vi.fn(async () => []) },
    pushSubscription: {
      findMany: vi.fn(async ({ where }: any) => db.pushSubs.filter((s) => where.userId.in.includes(s.userId))),
      groupBy: vi.fn(async ({ where }: any) => {
        const ids = new Set(db.pushSubs.filter((s) => where.userId.in.includes(s.userId)).map((s) => s.userId));
        return Array.from(ids, (userId) => ({ userId }));
      }),
    },
    notificationAckToken: { createMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import { runEscalationSweep } from "../../src/services/notificationEscalationService.js";
import { bumpRecipientIndex } from "../../src/services/notificationRecipientService.js";
import { higherEscalationTiers } from "../../src/services/notificationTypes.js";

const NOW = new Date("2026-08-24T12:00:00Z");
const T35_AGO = new Date(NOW.getTime() - 35 * 60_000);

/** Users: one per region plus the person who belongs to BOTH. */
function seedUsers() {
  const mk = (id: string, email: string, regions: string[]) => ({
    id,
    email,
    displayName: id,
    regionTags: regions,
    otherTags: [],
    ssoGroups: [],
    authProvider: "local",
    roleId: "role-1",
    role: { regionTags: [], otherTags: [], permissions: {} },
  });
  db.users.push(mk("u-north", "north@example.com", ["North"]));
  db.users.push(mk("u-both", "both@example.com", ["North", "South"]));
  db.users.push(mk("u-south", "south@example.com", ["South"]));
}

const notifyRegions = (regions: string[], channelId = "ch-email") => ({
  type: "notify" as const,
  channelId,
  recipientRegions: regions,
});

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
    templateCtx: { asset: "sw-core-1", severity: "warning", message: "cpu hot" },
    escalationState: null,
    regionTags: [],
    ...overrides,
  });
}

/** The To list of the delivery row produced by tier `n` (1-based). */
function toOfTier(n: number): string[] {
  const row = db.deliveries.find((d) => d.meta?.escalation?.tier === n);
  return (row?.meta?.to as string[]) ?? [];
}

beforeEach(() => {
  db.rules.length = 0;
  db.notifs.length = 0;
  db.channels.length = 0;
  db.users.length = 0;
  db.pushSubs.length = 0;
  db.deliveries.length = 0;
  db.notifUpdates.length = 0;
  db.channels.push({ id: "ch-email", type: "smtp", enabled: true });
  db.channels.push({ id: "ch-push", type: "web_push", enabled: true });
  db.channels.push({ id: "ch-email-off", type: "smtp", enabled: false });
  seedUsers();
  bumpRecipientIndex(); // the user index is cached 30s — tests must not share one
});

describe("higherEscalationTiers", () => {
  it("selects the tiers that fire later, not the ones stored later", () => {
    const tiers = [{ afterMin: 15 }, { afterMin: 30 }, { afterMin: 60 }];
    expect(higherEscalationTiers(tiers, 0).map((t) => t.afterMin)).toEqual([30, 60]);
    expect(higherEscalationTiers(tiers, 1).map((t) => t.afterMin)).toEqual([60]);
    expect(higherEscalationTiers(tiers, 2)).toEqual([]);
  });

  it("reads out-of-order tiers by their delay — a late-authored short tier is not the highest", () => {
    // Nothing validates ascending authoring order, so position alone would
    // make the 5-minute tier outrank the 60-minute one and silence it.
    const tiers = [{ afterMin: 60 }, { afterMin: 5 }];
    expect(higherEscalationTiers(tiers, 0)).toEqual([]);
    expect(higherEscalationTiers(tiers, 1).map((t) => t.afterMin)).toEqual([60]);
  });

  it("breaks an equal-delay tie on position so two tiers never outrank each other", () => {
    const tiers = [{ afterMin: 30 }, { afterMin: 30 }];
    expect(higherEscalationTiers(tiers, 0).length).toBe(1);
    expect(higherEscalationTiers(tiers, 1).length).toBe(0);
  });

  it("returns nothing for an index off the end", () => {
    expect(higherEscalationTiers([{ afterMin: 30 }], 5)).toEqual([]);
  });
});

describe("escalation sweep — highest tier wins", () => {
  it("pages a two-region user only at the higher tier", async () => {
    seedRule({
      escalation: {
        stopOn: "acknowledge",
        tiers: [
          { afterMin: 15, actions: [notifyRegions(["North"])] },
          { afterMin: 30, actions: [notifyRegions(["South"])] },
        ],
      },
    });
    seedNotif();

    await runEscalationSweep(NOW);

    // North's tier drops the person South's tier will also reach.
    expect(toOfTier(1)).toEqual(["north@example.com"]);
    expect(toOfTier(2)).toEqual(["both@example.com", "south@example.com"]);
  });

  it("counts a fully-suppressed tier as spent instead of retrying it forever", async () => {
    // The ordinary "escalate to a wider group" ladder: tier 2's audience is a
    // superset of tier 1's, so tier 1 resolves to nobody.
    seedRule({
      escalation: {
        stopOn: "acknowledge",
        tiers: [
          { afterMin: 15, actions: [notifyRegions(["South"])] },
          { afterMin: 30, actions: [notifyRegions(["North", "South"])] },
        ],
      },
    });
    seedNotif();

    const runs = await runEscalationSweep(NOW);

    expect(toOfTier(1)).toEqual([]); // nothing delivered for tier 1
    expect(toOfTier(2)).toEqual(["north@example.com", "both@example.com", "south@example.com"]);
    // ...but tier 1 is recorded, so the next sweep does not re-run it.
    expect(runs).toBe(2);
    const state = db.notifUpdates[0].data.escalationState;
    expect(state.tiers["0"].count).toBe(1);
    expect(state.tiers["1"].count).toBe(1);
  });

  it("does NOT suppress for a later tier whose channel is disabled", async () => {
    seedRule({
      escalation: {
        stopOn: "acknowledge",
        tiers: [
          { afterMin: 15, actions: [notifyRegions(["North"])] },
          { afterMin: 30, actions: [notifyRegions(["North"], "ch-email-off")] },
        ],
      },
    });
    seedNotif();

    await runEscalationSweep(NOW);

    // A dead channel reaches nobody, so deferring to it would page nobody at all.
    expect(toOfTier(1)).toEqual(["north@example.com", "both@example.com"]);
  });

  it("does NOT suppress for a push-only later tier when the user has no enrolled device", async () => {
    db.pushSubs.push({ userId: "u-north", endpoint: "e1", p256dh: "k", auth: "a", surface: "desktop" });
    seedRule({
      escalation: {
        stopOn: "acknowledge",
        tiers: [
          { afterMin: 15, actions: [notifyRegions(["North"])] },
          { afterMin: 30, actions: [notifyRegions(["North"], "ch-push")] },
        ],
      },
    });
    seedNotif();

    await runEscalationSweep(NOW);

    // u-north has a device so the higher tier really does reach them; u-both
    // never enrolled, so push is not a place they will hear about it.
    expect(toOfTier(1)).toEqual(["both@example.com"]);
  });

  it("never suppresses across chains — a per-action chain is its own ladder", async () => {
    seedRule({
      // The per-action chain's tier is not yet due AND belongs to another
      // ladder; neither fact may silence the level chain's tier.
      actions: [
        {
          ...notifyRegions(["North"]),
          escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 60, actions: [notifyRegions(["North"])] }] },
        },
      ],
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 30, actions: [notifyRegions(["North"])] }] },
    });
    seedNotif();

    await runEscalationSweep(NOW);

    expect(toOfTier(1)).toEqual(["north@example.com", "both@example.com"]);
  });

  it("leaves a typed address on the lower tier alone — only accounts are suppressed", async () => {
    seedRule({
      escalation: {
        stopOn: "acknowledge",
        tiers: [
          {
            afterMin: 15,
            actions: [{ type: "notify", channelId: "ch-email", recipientRegions: ["North"], addresses: ["both@example.com"] }],
          },
          { afterMin: 30, actions: [notifyRegions(["South"])] },
        ],
      },
    });
    seedNotif();

    await runEscalationSweep(NOW);

    // u-both is deferred as a USER, but the same address typed by hand is an
    // explicit choice to page that mailbox and survives.
    expect(toOfTier(1)).toEqual(["both@example.com", "north@example.com"]);
  });
});
