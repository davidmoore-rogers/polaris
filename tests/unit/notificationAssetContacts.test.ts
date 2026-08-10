/**
 * tests/unit/notificationAssetContacts.test.ts — recipientAssetContacts
 * routing: a notify action flagged with it also emails the address-book
 * contacts RESPONSIBLE for the triggering device.
 *
 * The addresses are resolved by the CALLER (automationActionService, from
 * contactService) and handed to expandDeliveries as assetContactEmails, the
 * same way region tags are — contactService imports notificationRecipientService
 * for listRecipientUsers, so the expander fetching contacts itself would close
 * an import cycle. These tests pin the expander's half of that contract.
 *
 * Sibling of notificationDeviceRegion.test.ts, which covers the region flags.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const createdRows: Record<string, unknown>[] = [];
const channels: Record<string, { id: string; type: string; enabled: boolean }> = {
  "c-mail": { id: "c-mail", type: "smtp", enabled: true },
  "c-push": { id: "c-push", type: "web_push", enabled: true },
};

vi.mock("../../src/db.js", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async () => [
        { id: "u1", email: "user@example.com", displayName: "U", regionTags: [], otherTags: [], ssoGroups: [], authProvider: "local", role: null },
      ]),
    },
    notificationChannel: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => channels[id]).filter(Boolean)),
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

vi.mock("../../src/services/regionScopeService.js", () => ({
  resolveTagScopesForUser: vi.fn(async () => ({
    regionTags: { effective: [] },
    otherTags: { effective: [] },
  })),
}));

import { expandDeliveries, bumpRecipientIndex } from "../../src/services/notificationRecipientService.js";

const targets = (t: Record<string, unknown>) => [{ channelId: "c-mail", ...t }] as never;

beforeEach(() => {
  createdRows.length = 0;
  bumpRecipientIndex();
});

describe("recipientAssetContacts routing", () => {
  it("emails the contacts responsible for the triggering device", async () => {
    const n = await expandDeliveries("n1", targets({ recipientAssetContacts: true }), {
      assetContactEmails: ["owner@example.com"],
    });
    expect(n).toBe(1);
    expect(createdRows[0]).toMatchObject({ transport: "email", target: "owner@example.com" });
  });

  it("does nothing when the action did not opt in", async () => {
    // The addresses being available must not be enough — the flag is the opt-in.
    const n = await expandDeliveries("n1", targets({ recipientUserIds: ["u1"] }), {
      assetContactEmails: ["owner@example.com"],
    });
    expect(n).toBe(1);
    expect(createdRows.map((r) => r.target)).toEqual(["user@example.com"]);
  });

  it("is a no-op when the device has no contacts", async () => {
    const n = await expandDeliveries("n1", targets({ recipientAssetContacts: true }), {
      assetContactEmails: [],
    });
    expect(n).toBe(0);
    expect(createdRows).toHaveLength(0);
  });

  it("unions with the other recipient sources rather than replacing them", async () => {
    await expandDeliveries("n1", targets({ recipientUserIds: ["u1"], recipientAssetContacts: true }), {
      assetContactEmails: ["owner@example.com"],
    });
    expect(createdRows.map((r) => r.target).sort()).toEqual(["owner@example.com", "user@example.com"]);
  });

  it("dedupes a contact address that is also a user's address", async () => {
    await expandDeliveries("n1", targets({ recipientUserIds: ["u1"], recipientAssetContacts: true }), {
      assetContactEmails: ["USER@example.com"],
    });
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]).toMatchObject({ target: "user@example.com" });
  });

  it("normalizes case so the address matches what the server stored", async () => {
    await expandDeliveries("n1", targets({ recipientAssetContacts: true }), {
      assetContactEmails: ["  Owner@Example.COM "],
    });
    expect(createdRows[0]).toMatchObject({ target: "owner@example.com" });
  });

  it("folds contacts into the To list of a COMPOSED email", async () => {
    await expandDeliveries("n1", targets({ recipientUserIds: ["u1"], recipientAssetContacts: true }), {
      assetContactEmails: ["owner@example.com"],
      composedEmail: { subject: "S", text: "T" },
    });
    expect(createdRows).toHaveLength(1);
    const meta = createdRows[0].meta as { composed: boolean; to: string[] };
    expect(meta.composed).toBe(true);
    expect(meta.to.sort()).toEqual(["owner@example.com", "user@example.com"]);
  });

  it("is ignored on a push channel — a contact is an address, not an account", async () => {
    const n = await expandDeliveries(
      "n1",
      [{ channelId: "c-push", recipientAssetContacts: true }] as never,
      { assetContactEmails: ["owner@example.com"] },
    );
    expect(n).toBe(0);
    expect(createdRows).toHaveLength(0);
  });
});
