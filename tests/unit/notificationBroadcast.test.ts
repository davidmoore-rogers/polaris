/**
 * tests/unit/notificationBroadcast.test.ts — the Web Push broadcast recipient
 * modes: recipientAllUsers, recipientAllRegions and recipientRegions.
 *
 * The load-bearing property is the REGION-ONLY match. IndexedUser.matchSet
 * flattens region ∪ other tags into one namespace, which is fine for the legacy
 * free-form recipientTags but wrong once an operator picks a region BY NAME
 * from the map-region catalogue: a user whose unrelated "other" tag happens to
 * read "Atlanta" must not receive Atlanta's alerts. resolveUsersByRegions
 * therefore matches on regionSet, and these tests pin that apart from
 * resolveRecipientUsers, which deliberately still uses matchSet.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const userRows = [
  { id: "u-atl", email: "atl@example.com", displayName: "Atlanta Op", regionTags: ["Atlanta"], otherTags: [], ssoGroups: [], authProvider: "local", roleId: "r-noc", role: null },
  { id: "u-mem", email: "mem@example.com", displayName: "Memphis Op", regionTags: ["Memphis"], otherTags: [], ssoGroups: [], authProvider: "local", roleId: "r-noc", role: null },
  // The trap: "Atlanta" as an OTHER tag, not a region.
  { id: "u-trap", email: "trap@example.com", displayName: "Vendor", regionTags: [], otherTags: ["Atlanta"], ssoGroups: [], authProvider: "local", roleId: "r-ro", role: null },
  { id: "u-none", email: "none@example.com", displayName: "No Region", regionTags: [], otherTags: [], ssoGroups: [], authProvider: "local", roleId: "r-admin", role: null },
];

const createdRows: Record<string, unknown>[] = [];

vi.mock("../../src/db.js", () => ({
  prisma: {
    user: { findMany: vi.fn(async () => userRows) },
    notificationChannel: {
      findMany: vi.fn(async () => [{ id: "c-push", type: "web_push", enabled: true }]),
    },
    notificationDelivery: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        createdRows.push(...data);
        return { count: data.length };
      }),
    },
    // Every user has exactly one subscription, so a delivery row per recipient.
    pushSubscription: {
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
        where.userId.in.map((uid) => ({
          id: "s-" + uid, userId: uid, endpoint: "https://push/" + uid,
          p256dh: "k", auth: "a", surface: "desktop",
        }))),
    },
  },
}));

vi.mock("../../src/services/regionScopeService.js", () => ({
  resolveTagScopesForUser: vi.fn(async (u: { regionTags: string[]; otherTags: string[] }) => ({
    regionTags: { effective: u.regionTags },
    otherTags: { effective: u.otherTags },
  })),
}));

import {
  expandDeliveries,
  bumpRecipientIndex,
  resolveAllUsers,
  resolveUsersByRegions,
  resolveUsersInAnyRegion,
  resolveRecipientUsers,
  resolveUsersByRoles,
} from "../../src/services/notificationRecipientService.js";

beforeEach(() => {
  createdRows.length = 0;
  bumpRecipientIndex();
});

const emails = (us: Array<{ email: string | null }>) => us.map((u) => u.email).sort();

describe("resolveUsersByRegions", () => {
  it("matches region tags", async () => {
    expect(emails(await resolveUsersByRegions(["Atlanta"]))).toEqual(["atl@example.com"]);
  });

  it("does NOT match a same-named tag in the other-tags dimension", async () => {
    // The whole reason regionSet exists.
    const out = await resolveUsersByRegions(["Atlanta"]);
    expect(out.map((u) => u.id)).not.toContain("u-trap");
  });

  it("still matches that user through the legacy tag routing", async () => {
    // resolveRecipientUsers keeps the flattened matchSet, so old rules behave
    // exactly as before this change.
    expect(emails(await resolveRecipientUsers(["Atlanta"]))).toEqual(["atl@example.com", "trap@example.com"]);
  });

  it("is case-insensitive and tolerates the region: prefix", async () => {
    expect(emails(await resolveUsersByRegions(["atlanta"]))).toEqual(["atl@example.com"]);
    expect(emails(await resolveUsersByRegions(["region:Atlanta"]))).toEqual(["atl@example.com"]);
  });

  it("unions across several regions", async () => {
    expect(emails(await resolveUsersByRegions(["Atlanta", "Memphis"])))
      .toEqual(["atl@example.com", "mem@example.com"]);
  });

  it("routes to nobody for an empty list", async () => {
    expect(await resolveUsersByRegions([])).toEqual([]);
    expect(await resolveUsersByRegions(undefined)).toEqual([]);
  });
});

describe("resolveUsersInAnyRegion", () => {
  it("returns users carrying at least one region tag, and excludes region-less ones", async () => {
    const out = emails(await resolveUsersInAnyRegion());
    expect(out).toEqual(["atl@example.com", "mem@example.com"]);
    // u-trap has an "Atlanta" OTHER tag but no region; u-none has neither.
    expect(out).not.toContain("trap@example.com");
    expect(out).not.toContain("none@example.com");
  });
});

describe("resolveAllUsers", () => {
  it("returns every account, region or not", async () => {
    expect(await resolveAllUsers()).toHaveLength(4);
  });
});

describe("expandDeliveries broadcast modes", () => {
  it("recipientAllUsers reaches everyone", async () => {
    const n = await expandDeliveries("n1", [{ channelId: "c-push", recipientAllUsers: true }] as never, {});
    expect(n).toBe(4);
  });

  it("recipientAllUsers short-circuits the narrower sources rather than unioning", async () => {
    // Belt and braces: whatever else is set, the result is still everyone —
    // and specifically not a double-counted set.
    const n = await expandDeliveries(
      "n1",
      [{ channelId: "c-push", recipientAllUsers: true, recipientUserIds: ["u-atl"], recipientRegions: ["Memphis"] }] as never,
      {},
    );
    expect(n).toBe(4);
  });

  it("recipientAllRegions reaches only the region-tagged users", async () => {
    const n = await expandDeliveries("n1", [{ channelId: "c-push", recipientAllRegions: true }] as never, {});
    expect(n).toBe(2);
    expect(createdRows.map((r) => r.target).sort()).toEqual(["https://push/u-atl", "https://push/u-mem"]);
  });

  it("recipientRegions narrows to the named regions", async () => {
    await expandDeliveries("n1", [{ channelId: "c-push", recipientRegions: ["Memphis"] }] as never, {});
    expect(createdRows.map((r) => r.target)).toEqual(["https://push/u-mem"]);
  });

  it("unions named regions with explicitly picked users, deduped", async () => {
    await expandDeliveries(
      "n1",
      [{ channelId: "c-push", recipientRegions: ["Atlanta"], recipientUserIds: ["u-atl", "u-none"] }] as never,
      {},
    );
    expect(createdRows.map((r) => r.target).sort()).toEqual(["https://push/u-atl", "https://push/u-none"]);
  });
});

// ─── Role recipients ────────────────────────────────────────────────────────
// "Notify the NOC role" routes to whoever holds that role right now, so a
// staffing change needs no automation edit. Matched by role ID, never name — a
// rename must not silently reroute an alert.
describe("resolveUsersByRoles", () => {
  it("returns every user holding the role", async () => {
    expect(emails(await resolveUsersByRoles(["r-noc"]))).toEqual(["atl@example.com", "mem@example.com"]);
  });

  it("unions across several roles, deduped by user", async () => {
    expect(emails(await resolveUsersByRoles(["r-noc", "r-admin"])))
      .toEqual(["atl@example.com", "mem@example.com", "none@example.com"]);
  });

  it("routes to nobody for an empty or unknown role list", async () => {
    expect(await resolveUsersByRoles([])).toEqual([]);
    expect(await resolveUsersByRoles(undefined)).toEqual([]);
    expect(await resolveUsersByRoles(["r-deleted"])).toEqual([]);
  });

  it("reaches them through expandDeliveries, unioned with picked users", async () => {
    await expandDeliveries(
      "n1",
      [{ channelId: "c-push", recipientRoles: ["r-admin"], recipientUserIds: ["u-atl"] }] as never,
      {},
    );
    expect(createdRows.map((r) => r.target).sort()).toEqual(["https://push/u-atl", "https://push/u-none"]);
  });

  it("does not double-count a user picked both individually and by role", async () => {
    await expandDeliveries(
      "n1",
      [{ channelId: "c-push", recipientRoles: ["r-admin"], recipientUserIds: ["u-none"] }] as never,
      {},
    );
    expect(createdRows).toHaveLength(1);
  });
});
