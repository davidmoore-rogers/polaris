/**
 * tests/unit/contactService.test.ts
 *
 * Address-book service coverage:
 *   - normalizeContactEmail  — the write-side normalization the unique index
 *                              depends on (lower-case) plus its rejections.
 *   - searchAddressBook      — the union of Polaris users and contacts, the
 *                              dedupe precedence (user beats contact on the
 *                              same address), and prefix-first ranking.
 *   - resolveContactsForAsset — the FIRE-TIME path. The properties that matter
 *                              are that it unions pins with criteria matches,
 *                              never double-counts a contact matching both,
 *                              and never scans the fleet: it loads exactly the
 *                              one triggering asset, and only when some contact
 *                              actually carries a criteria filter.
 *
 * prisma is stubbed — this is the pure/behavioral half, not persistence.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above the imports, so the stub it closes over has to be
// hoisted with it.
const prismaMock = vi.hoisted(() => ({
  contact: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  asset: { findMany: vi.fn(), findUnique: vi.fn() },
  user: { findMany: vi.fn() },
  pushSubscription: { groupBy: vi.fn() },
  event: { create: vi.fn() },
  $queryRaw: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ prisma: prismaMock }));
// logEvent reads retention settings on every call; stub it out entirely so the
// CRUD paths under test don't drag the settings cache in.
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn() }));

import {
  bumpContactCache,
  normalizeContactEmail,
  resolveContactsForAsset,
  searchAddressBook,
} from "../../src/services/contactService.js";

const CRITERIA = (field: string, value: string) => ({
  version: 1,
  match: "all",
  rules: [{ field, op: "exact", values: [value] }],
});

const contactRow = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  email: "noc@example.com",
  name: "NOC",
  description: null,
  assetCriteria: null,
  assetIds: [],
  createdBy: "dmoore",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  bumpContactCache();
  prismaMock.user.findMany.mockResolvedValue([]);
  prismaMock.pushSubscription.groupBy.mockResolvedValue([]);
  prismaMock.contact.findMany.mockResolvedValue([]);
});

describe("normalizeContactEmail", () => {
  it("trims and lower-cases so the unique index is case-insensitive", () => {
    expect(normalizeContactEmail("  NOC@Example.COM ")).toBe("noc@example.com");
  });

  it("rejects blanks and malformed addresses", () => {
    expect(() => normalizeContactEmail("")).toThrow(/required/i);
    expect(() => normalizeContactEmail("   ")).toThrow(/required/i);
    expect(() => normalizeContactEmail("not-an-address")).toThrow(/not a valid email/i);
    expect(() => normalizeContactEmail("a@b")).toThrow(/not a valid email/i);
    expect(() => normalizeContactEmail("two words@example.com")).toThrow(/not a valid email/i);
  });

  it("rejects an over-long address before it reaches the column", () => {
    expect(() => normalizeContactEmail("a".repeat(315) + "@example.com")).toThrow(/too long/i);
  });
});

describe("searchAddressBook", () => {
  it("returns users and contacts together", async () => {
    prismaMock.user.findMany.mockResolvedValue([
      { id: "u1", username: "jdoe", displayName: "Jane Doe", email: "jane@example.com" },
    ]);
    prismaMock.contact.findMany.mockResolvedValue([contactRow()]);

    const out = await searchAddressBook("");
    expect(out.map((e) => e.email).sort()).toEqual(["jane@example.com", "noc@example.com"]);
    expect(out.find((e) => e.email === "jane@example.com")!.source).toBe("user");
    expect(out.find((e) => e.email === "noc@example.com")!.source).toBe("contact");
  });

  it("skips user accounts with no email — they cannot be an email recipient", async () => {
    prismaMock.user.findMany.mockResolvedValue([
      { id: "u1", username: "svc", displayName: null, email: null },
    ]);
    expect(await searchAddressBook("")).toEqual([]);
  });

  it("dedupes on the address with the USER winning over the contact", async () => {
    // A user id survives the person changing address; a stored contact string
    // does not — so the account is the entry worth keeping.
    prismaMock.user.findMany.mockResolvedValue([
      { id: "u1", username: "jdoe", displayName: "Jane Doe", email: "jane@example.com" },
    ]);
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c9", email: "jane@example.com", name: "Jane (personal)" }),
    ]);

    const out = await searchAddressBook("");
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("user");
  });

  it("matches on name as well as address, case-insensitively", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "a@example.com", name: "Night Shift" }),
      contactRow({ id: "c2", email: "b@example.com", name: "Day Shift" }),
    ]);
    const out = await searchAddressBook("NIGHT");
    expect(out.map((e) => e.email)).toEqual(["a@example.com"]);
  });

  it("ranks prefix matches above interior ones", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "jane.donovan@example.com", name: "Jane Donovan" }),
      contactRow({ id: "c2", email: "noc@example.com", name: "NOC" }),
    ]);
    // "no" appears inside "jane.doNOvan" and at the head of "noc@…".
    const out = await searchAddressBook("no");
    expect(out[0].email).toBe("noc@example.com");
  });

  it("flags rows the caller owns so the picker can offer Edit", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "mine@example.com", createdBy: "dmoore" }),
      contactRow({ id: "c2", email: "theirs@example.com", createdBy: "someone-else" }),
    ]);
    const out = await searchAddressBook("", { callerUsername: "dmoore" });
    expect(out.find((e) => e.email === "mine@example.com")!.owned).toBe(true);
    expect(out.find((e) => e.email === "theirs@example.com")!.owned).toBe(false);
  });

  it("caps the result set", async () => {
    prismaMock.contact.findMany.mockResolvedValue(
      Array.from({ length: 80 }, (_, i) => contactRow({ id: `c${i}`, email: `u${i}@example.com` })),
    );
    expect(await searchAddressBook("")).toHaveLength(50);
    expect(await searchAddressBook("", { limit: 5 })).toHaveLength(5);
  });
});

describe("resolveContactsForAsset", () => {
  it("returns nothing when the book is empty, without touching the asset table", async () => {
    prismaMock.contact.findMany.mockResolvedValue([]);
    expect(await resolveContactsForAsset("a1")).toEqual([]);
    expect(prismaMock.asset.findUnique).not.toHaveBeenCalled();
  });

  it("matches an explicit pin WITHOUT loading the asset at all", async () => {
    // Pins are a plain id comparison — a contact that only pins devices must
    // not cost a query on the fire-time path.
    prismaMock.contact.findMany.mockResolvedValue([contactRow({ assetIds: ["a1"] })]);
    const out = await resolveContactsForAsset("a1");
    expect(out.map((c) => c.email)).toEqual(["noc@example.com"]);
    expect(prismaMock.asset.findUnique).not.toHaveBeenCalled();
  });

  it("does not match a contact pinned to a different device", async () => {
    prismaMock.contact.findMany.mockResolvedValue([contactRow({ assetIds: ["other"] })]);
    expect(await resolveContactsForAsset("a1")).toEqual([]);
  });

  it("matches on criteria, loading exactly the one triggering asset", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "srv@example.com", assetCriteria: CRITERIA("assetType", "server") }),
      contactRow({ id: "c2", email: "fw@example.com", assetCriteria: CRITERIA("assetType", "firewall") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", assetType: "server", ipAddress: null });

    const out = await resolveContactsForAsset("a1");
    expect(out.map((c) => c.email)).toEqual(["srv@example.com"]);
    // One asset read, never a findMany over the fleet.
    expect(prismaMock.asset.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.asset.findMany).not.toHaveBeenCalled();
  });

  it("skips the CIDR containment query when no contact filters by subnet", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ assetCriteria: CRITERIA("assetType", "server") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", assetType: "server", ipAddress: "10.0.0.5" });
    await resolveContactsForAsset("a1");
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("unions pins with criteria matches and never lists a contact twice", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "both@example.com", assetIds: ["a1"], assetCriteria: CRITERIA("assetType", "server") }),
      contactRow({ id: "c2", email: "pin@example.com", assetIds: ["a1"] }),
      contactRow({ id: "c3", email: "crit@example.com", assetCriteria: CRITERIA("assetType", "server") }),
      contactRow({ id: "c4", email: "neither@example.com", assetCriteria: CRITERIA("assetType", "printer") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", assetType: "server", ipAddress: null });

    const out = await resolveContactsForAsset("a1");
    expect(out.map((c) => c.email).sort()).toEqual(["both@example.com", "crit@example.com", "pin@example.com"]);
  });

  it("still honours pins when the asset row has been deleted", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "pin@example.com", assetIds: ["a1"] }),
      contactRow({ id: "c2", email: "crit@example.com", assetCriteria: CRITERIA("assetType", "server") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue(null);
    const out = await resolveContactsForAsset("a1");
    expect(out.map((c) => c.email)).toEqual(["pin@example.com"]);
  });
});
