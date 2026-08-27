/**
 * tests/unit/ackLinkFanout.test.ts — every recipient of a composed alert email
 * who MAY acknowledge gets their own acknowledge button.
 *
 * The gap this pins: a composed notify action renders one body, and the token
 * in it records who acknowledged — so the old expander handed a link out only
 * when exactly one person was on the To line with nobody cc'd. Two recipients,
 * or one cc, and the alert went out with no button for anybody, which is the
 * ordinary shape of a real automation rather than an edge case.
 *
 * Sibling of ackLinkRouting.test.ts, which pins the pure planner
 * (planComposedEmails) and the per-row {ack} substitution. This file drives the
 * whole expander, so the row count, the minted tokens and the rendered bodies
 * are tested together.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const createdRows: Record<string, unknown>[] = [];
const mintedTokens: Record<string, unknown>[] = [];

// Two users who may acknowledge (alerts write/fullwrite), one who may only read.
const USERS = [
  { id: "u1", email: "dana@example.com", displayName: "Dana", role: { permissions: { alerts: "write" } } },
  { id: "u2", email: "sam@example.com", displayName: "Sam", role: { permissions: { alerts: "fullwrite" } } },
  { id: "u3", email: "reader@example.com", displayName: "Reader", role: { permissions: { alerts: "read" } } },
].map((u) => ({ ...u, regionTags: [], otherTags: [], ssoGroups: [], authProvider: "local", roleId: "r" }));

vi.mock("../../src/db.js", () => ({
  prisma: {
    user: { findMany: vi.fn(async () => USERS) },
    notificationChannel: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, type: "smtp", enabled: true }))),
    },
    notificationDelivery: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        createdRows.push(...data);
        return { count: data.length };
      }),
    },
    notificationAckToken: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        mintedTokens.push(...data);
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

/** The composed body an automation's Notify action renders, {ack} still in it. */
const composedEmail = (extra: Record<string, unknown> = {}) => ({
  subject: "S",
  text: "Device sw-1 is down\nAcknowledge: {ack}",
  html: '<a href="{ack}">Acknowledge alert</a>',
  ...extra,
});

const target = (t: Record<string, unknown> = {}) => [{ channelId: "c-mail", ...t }] as never;

const metaOf = (row: Record<string, unknown>) => row.meta as {
  to: string[];
  cc?: string[];
  bcc?: string[];
  text: string;
  html?: string;
  ack?: { token: string; userId: string };
};

const prevPublicUrl = process.env.POLARIS_PUBLIC_URL;
beforeEach(() => {
  createdRows.length = 0;
  mintedTokens.length = 0;
  bumpRecipientIndex();
  // An /ack link is absolute or it is nothing — a relative URL is useless in
  // mail, so the expander withholds every link without a public URL.
  process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
});
afterEach(() => {
  if (prevPublicUrl === undefined) delete process.env.POLARIS_PUBLIC_URL;
  else process.env.POLARIS_PUBLIC_URL = prevPublicUrl;
});

describe("composed alert email fan-out", () => {
  it("gives each of two ackable users their own message, token and link", async () => {
    const n = await expandDeliveries("n1", target({ recipientUserIds: ["u1", "u2"] }), {
      composedEmail: composedEmail(),
    });
    expect(n).toBe(2);
    expect(createdRows.map((r) => r.target)).toEqual(["dana@example.com", "sam@example.com"]);

    const [a, b] = createdRows.map(metaOf);
    expect(a!.to).toEqual(["dana@example.com"]);
    expect(b!.to).toEqual(["sam@example.com"]);
    // Distinct tokens, each bound to the reader of that message.
    expect(a!.ack?.userId).toBe("u1");
    expect(b!.ack?.userId).toBe("u2");
    expect(a!.ack?.token).not.toBe(b!.ack?.token);
    // ...and each body carries its own, not a shared one.
    expect(a!.text).toContain("/ack/" + a!.ack!.token);
    expect(b!.text).toContain("/ack/" + b!.ack!.token);
    expect(a!.html).toContain('href="https://polaris.example.com/ack/' + a!.ack!.token + '"');
    expect(mintedTokens).toHaveLength(2);
  });

  it("keeps the button for the To recipient once someone is cc'd", async () => {
    // The old gate withheld it from everybody the moment a cc existed.
    const n = await expandDeliveries("n1", target({ recipientUserIds: ["u1"] }), {
      composedEmail: composedEmail({ cc: { addresses: ["vendor@example.net"] }, bcc: { addresses: ["audit@example.org"] } }),
    });
    expect(n).toBe(1);
    const meta = metaOf(createdRows[0]!);
    expect(meta.ack?.userId).toBe("u1");
    expect(meta.cc).toEqual(["vendor@example.net"]);
    expect(meta.bcc).toEqual(["audit@example.org"]);
  });

  it("mails Cc/Bcc once across a fan-out rather than once per recipient", async () => {
    await expandDeliveries("n1", target({ recipientUserIds: ["u1", "u2"] }), {
      composedEmail: composedEmail({ cc: { addresses: ["vendor@example.net"] }, bcc: { addresses: ["audit@example.org"] } }),
    });
    expect(createdRows.map((r) => metaOf(r).cc)).toEqual([["vendor@example.net"], []]);
    expect(createdRows.map((r) => metaOf(r).bcc)).toEqual([["audit@example.org"], []]);
  });

  it("splits a mixed group and renders the contact's {ack} away, not a dead link", async () => {
    await expandDeliveries("n1", target({ recipientUserIds: ["u1"], recipientAssetContacts: true }), {
      assetContactEmails: ["owner@example.com"],
      composedEmail: composedEmail(),
    });
    expect(createdRows).toHaveLength(2);
    const byAddr = new Map(createdRows.map((r) => [r.target as string, metaOf(r)]));
    expect(byAddr.get("dana@example.com")!.ack?.userId).toBe("u1");
    const contact = byAddr.get("owner@example.com")!;
    expect(contact.ack).toBeUndefined();
    expect(contact.text).not.toContain("{ack}");
    // The label goes with the link — "Acknowledge:" over nothing reads broken.
    expect(contact.text).not.toContain("Acknowledge:");
    expect(mintedTokens).toHaveLength(1);
  });

  it("keeps ONE group message when no recipient could acknowledge anyway", async () => {
    // u3 reads alerts but cannot acknowledge them, so splitting the message
    // would multiply the send and rewrite the To line for no one's benefit.
    const n = await expandDeliveries("n1", target({ recipientUserIds: ["u3"], recipientAssetContacts: true }), {
      assetContactEmails: ["owner@example.com"],
      composedEmail: composedEmail(),
    });
    expect(n).toBe(1);
    const meta = metaOf(createdRows[0]!);
    expect(meta.to).toEqual(["reader@example.com", "owner@example.com"]);
    expect(meta.ack).toBeUndefined();
    expect(meta.text).not.toContain("{ack}");
    expect(mintedTokens).toHaveLength(0);
  });

  it("withholds every link — and does not split — with no public URL", async () => {
    delete process.env.POLARIS_PUBLIC_URL;
    const n = await expandDeliveries("n1", target({ recipientUserIds: ["u1", "u2"] }), {
      composedEmail: composedEmail(),
    });
    expect(n).toBe(1);
    expect(metaOf(createdRows[0]!).to).toEqual(["dana@example.com", "sam@example.com"]);
    expect(mintedTokens).toHaveLength(0);
  });
});
