/**
 * tests/unit/notificationDeviceRegion.test.ts — recipientDeviceRegion routing:
 * a notify action flagged with it routes email to users whose region tags
 * match the TRIGGERING asset's region snapshot (assetRegionTags — the
 * stripped `region:` tags the engine snapshots onto Notification.regionTags),
 * independent of the rule's scope. Distinct from recipientScopeRegion, which
 * mines region: tags from the rule's device filter.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const userRows = [
  { id: "u-atl", email: "atl@example.com", displayName: "Atlanta Op", regionTags: ["Atlanta"], otherTags: [], ssoGroups: [], authProvider: "local", role: null },
  { id: "u-nash", email: "nash@example.com", displayName: "Nashville Op", regionTags: ["Nashville"], otherTags: [], ssoGroups: [], authProvider: "local", role: null },
  { id: "u-none", email: "none@example.com", displayName: "No Region", regionTags: [], otherTags: [], ssoGroups: [], authProvider: "local", role: null },
];

const createdRows: Record<string, unknown>[] = [];

vi.mock("../../src/db.js", () => ({
  prisma: {
    user: { findMany: vi.fn(async () => userRows) },
    notificationChannel: {
      findMany: vi.fn(async () => [{ id: "c1", type: "smtp", enabled: true }]),
    },
    notificationDelivery: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        createdRows.push(...data);
        return { count: data.length };
      }),
    },
    pushSubscription: { findMany: vi.fn(async () => []) },
  },
}));

// Tag scopes resolve straight from the stub rows (no role/group unioning here —
// that's regionScopeService's own test surface).
vi.mock("../../src/services/regionScopeService.js", () => ({
  resolveTagScopesForUser: vi.fn(async (u: { regionTags: string[]; otherTags: string[] }) => ({
    regionTags: { effective: u.regionTags },
    otherTags: { effective: u.otherTags },
  })),
}));

import { expandDeliveries, bumpRecipientIndex } from "../../src/services/notificationRecipientService.js";

beforeEach(() => {
  createdRows.length = 0;
  bumpRecipientIndex(); // the user index is TTL-cached across tests
});

describe("recipientDeviceRegion routing", () => {
  it("routes to users matching the triggering asset's region snapshot", async () => {
    const n = await expandDeliveries("n1", [{ channelId: "c1", recipientDeviceRegion: true }], {
      assetRegionTags: ["Atlanta"],
    });
    expect(n).toBe(1);
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]).toMatchObject({ transport: "email", target: "atl@example.com" });
  });

  it("a device in a different region reaches that region's users instead", async () => {
    await expandDeliveries("n1", [{ channelId: "c1", recipientDeviceRegion: true }], {
      assetRegionTags: ["Nashville"],
    });
    expect(createdRows.map((r) => r.target)).toEqual(["nash@example.com"]);
  });

  it("no asset region tags → the flag contributes no recipients", async () => {
    const n = await expandDeliveries("n1", [{ channelId: "c1", recipientDeviceRegion: true }], {});
    expect(n).toBe(0);
    expect(createdRows).toHaveLength(0);
  });

  it("device-region and scope-region are independent sources that union", async () => {
    await expandDeliveries(
      "n1",
      [{ channelId: "c1", recipientDeviceRegion: true, recipientScopeRegion: true }],
      { assetRegionTags: ["Atlanta"], scopeRegionTags: ["region:Nashville"] },
    );
    expect(createdRows.map((r) => r.target).sort()).toEqual(["atl@example.com", "nash@example.com"]);
  });

  it("scope-region alone ignores the asset snapshot (pre-feature behavior preserved)", async () => {
    await expandDeliveries("n1", [{ channelId: "c1", recipientScopeRegion: true }], {
      assetRegionTags: ["Atlanta"],
      scopeRegionTags: ["region:Nashville"],
    });
    expect(createdRows.map((r) => r.target)).toEqual(["nash@example.com"]);
  });
});
