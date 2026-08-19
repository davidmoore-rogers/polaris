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
  conditionMeansAllDevices,
  createContact,
  normalizeContactCondition,
  normalizeContactEmail,
  previewContactAssets,
  resolveContactsForAsset,
  searchAddressBook,
} from "../../src/services/contactService.js";

/** A condition tree in the stored (`assetCondition`) shape. */
const COND = (field: string, operator: string, value: string) => ({
  op: "and",
  children: [{ field, operator, value }],
});

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

// ─── Condition-tree device filter (the shape that superseded assetCriteria) ───

describe("normalizeContactCondition", () => {
  it("accepts the wider device-filter vocabulary", () => {
    expect(normalizeContactCondition(COND("location", "contains", "Nashville"))).toBeTruthy();
    expect(normalizeContactCondition(COND("fortigate", "contains", "PLVCOR"))).toBeTruthy();
    expect(normalizeContactCondition(COND("hostname", "matches", "PLV*"))).toBeTruthy();
  });

  it("reads an empty tree as no filter, never as every device", () => {
    expect(normalizeContactCondition(null)).toBeNull();
    expect(normalizeContactCondition({ op: "and", children: [] })).toBeNull();
    expect(normalizeContactCondition({ op: "and", children: [{ op: "or", children: [] }] })).toBeNull();
  });

  it("rejects a malformed tree with a 400", () => {
    expect(() => normalizeContactCondition({ op: "nope", children: [] })).toThrow(/invalid/i);
    expect(() => normalizeContactCondition(COND("hostname", "isExactly", "x"))).toThrow(/invalid/i);
    expect(() => normalizeContactCondition(COND("nosuchfield", "equals", "x"))).toThrow(/invalid/i);
  });

  it("refuses a tree nested past the cap", () => {
    let node: unknown = { field: "hostname", operator: "contains", value: "x" };
    for (let i = 0; i < 8; i++) node = { op: "and", children: [node] };
    expect(() => normalizeContactCondition(node)).toThrow(/nest at most/i);
  });
});

describe("resolveContactsForAsset — condition trees", () => {
  it("matches a stored condition against the one triggering asset", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "nash@example.com", assetCondition: COND("location", "contains", "nashville") }),
      contactRow({ id: "c2", email: "knox@example.com", assetCondition: COND("location", "contains", "knoxville") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", location: "Nashville Plant", ipAddress: null });

    const out = await resolveContactsForAsset("a1");
    expect(out.map((c) => c.email)).toEqual(["nash@example.com"]);
    expect(prismaMock.asset.findMany).not.toHaveBeenCalled();
  });

  it("matches on the FortiGate a device is sighted behind", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ assetCondition: COND("fortigate", "contains", "nash-edge") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({
      id: "a1",
      learnedLocation: "PLVCORFGT1",
      fortigateSightings: [{ fortigateDevice: "NASH-EDGE-01" }],
      ipAddress: null,
    });
    expect((await resolveContactsForAsset("a1")).length).toBe(1);
  });

  it("does its own CIDR math — no containment query for a subnet condition", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ assetCondition: COND("subnet", "inCidr", "10.20.0.0/16") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", ipAddress: "10.20.3.7" });
    expect((await resolveContactsForAsset("a1")).length).toBe(1);
    // The tree evaluates ipInCidr in memory; only the legacy predicate defers
    // containment to the database.
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("treats the all-devices marker as owning every device", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ email: "everything@example.com", assetCondition: { op: "and", children: [] } }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", assetType: "printer", ipAddress: null });
    expect((await resolveContactsForAsset("a1")).map((c) => c.email)).toEqual(["everything@example.com"]);
  });

  it("folds a legacy flat criteria forward and matches through the tree", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ email: "legacy@example.com", assetCriteria: CRITERIA("location", "Nashville Plant") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", location: "Nashville Plant", ipAddress: null });
    expect((await resolveContactsForAsset("a1")).length).toBe(1);
  });

  it("keeps matching a legacy criteria the tree cannot express", async () => {
    // `integration` has no condition-tree equivalent, so this row must stay on
    // the flat predicate rather than silently losing the rule.
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({
        email: "byint@example.com",
        assetCriteria: { version: 1, match: "all", rules: [{ field: "integration", op: "exact", values: ["int-1"] }] },
      }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({
      id: "a1",
      discoveredByIntegrationId: "int-1",
      sources: [],
      ipAddress: null,
    });
    expect((await resolveContactsForAsset("a1")).length).toBe(1);
  });

  it("ignores a stored condition that no longer validates instead of throwing", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ email: "broken@example.com", assetCondition: { op: "and", children: [{ field: "gone", operator: "equals", value: "x" }] } }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", ipAddress: null });
    // No filter → owns nothing, and the list still resolves.
    expect(await resolveContactsForAsset("a1")).toEqual([]);
  });
});

describe("writes normalize the filter to one live shape", () => {
  beforeEach(() => {
    prismaMock.contact.findUnique.mockResolvedValue(null); // no email clash
    prismaMock.contact.create.mockImplementation(({ data }: any) => ({
      id: "new",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));
  });

  const createdData = () => prismaMock.contact.create.mock.calls[0]![0].data;

  it("stores a posted condition and leaves the legacy column unset", async () => {
    await createContact({ email: "a@example.com", assetCondition: COND("location", "contains", "nash") }, "dmoore");
    expect(createdData().assetCondition).toEqual(COND("location", "contains", "nash"));
    expect(createdData().assetCriteria).toBeUndefined();
  });

  it("folds a posted flat criteria forward rather than storing it", async () => {
    await createContact({ email: "a@example.com", assetCriteria: CRITERIA("assetType", "switch") }, "dmoore");
    expect(createdData().assetCondition).toEqual({
      op: "and",
      children: [{ field: "assetType", operator: "equals", value: "switch" }],
    });
    expect(createdData().assetCriteria).toBeUndefined();
  });

  it("keeps a flat criteria the tree cannot express as legacy", async () => {
    await createContact(
      {
        email: "a@example.com",
        assetCriteria: { version: 1, match: "all", rules: [{ field: "integration", op: "exact", values: ["int-1"] }] },
      },
      "dmoore",
    );
    expect(createdData().assetCondition).toBeUndefined();
    expect(createdData().assetCriteria).toBeTruthy();
  });

  it("only produces the all-devices marker from the explicit flag", async () => {
    await createContact({ email: "a@example.com", assetAllDevices: true }, "dmoore");
    expect(conditionMeansAllDevices(createdData().assetCondition)).toBe(true);

    prismaMock.contact.create.mockClear();
    // An empty tree is NOT a way in — that would hand the contact the fleet.
    await createContact({ email: "b@example.com", assetCondition: { op: "and", children: [] } }, "dmoore");
    expect(createdData().assetCondition).toBeUndefined();
  });
});

describe("previewContactAssets", () => {
  beforeEach(() => {
    prismaMock.asset.findMany.mockResolvedValue([]);
  });

  it("evaluates a condition over the fleet and counts the MONITORED matches", async () => {
    prismaMock.asset.findMany
      .mockResolvedValueOnce([
        { id: "a1", location: "Nashville Plant" },
        { id: "a2", location: "Knoxville Yard" },
      ])
      // the sample read for the matched ids
      .mockResolvedValueOnce([
        { id: "a1", hostname: "SW1", ipAddress: null, assetType: "switch", monitored: true },
      ]);

    const out = await previewContactAssets({ assetCondition: COND("location", "contains", "nashville") });
    expect(out.matchCount).toBe(1);
    expect(out.unmonitoredCount).toBe(0);
    expect(out.sample.map((s) => s.id)).toEqual(["a1"]);
    // `monitored` is a filter input, not something the caller renders.
    expect(out.sample[0]).not.toHaveProperty("monitored");
  });

  it("counts unmonitored matches separately and keeps them out of the list", async () => {
    // The filter DOES cover them — an event/change automation fires on an
    // unmonitored device — so they're reported, just not offered as choices.
    prismaMock.asset.findMany
      .mockResolvedValueOnce([{ id: "a1" }, { id: "a2" }, { id: "a3" }])
      .mockResolvedValueOnce([
        { id: "a1", hostname: "SW1", ipAddress: null, assetType: "switch", monitored: true },
        { id: "a2", hostname: "OLD1", ipAddress: null, assetType: "server", monitored: false },
        { id: "a3", hostname: "OLD2", ipAddress: null, assetType: "server", monitored: false },
      ]);

    const out = await previewContactAssets({ assetCondition: COND("status", "notEquals", "decommissioned") });
    expect(out.matchCount).toBe(1);
    expect(out.unmonitoredCount).toBe(2);
    expect(out.sample.map((s) => s.hostname)).toEqual(["SW1"]);
  });

  it("joins the FortiGate sighting relation only when a condition asks for it", async () => {
    await previewContactAssets({ assetCondition: COND("location", "contains", "x") });
    expect(prismaMock.asset.findMany.mock.calls[0]![0].select.fortigateSightings).toBeUndefined();

    prismaMock.asset.findMany.mockClear();
    prismaMock.asset.findMany.mockResolvedValue([]);
    await previewContactAssets({ assetCondition: COND("fortigate", "contains", "x") });
    expect(prismaMock.asset.findMany.mock.calls[0]![0].select.fortigateSightings).toBeTruthy();
  });

  it("reads an address-only contact as covering nothing, with no fleet read", async () => {
    const out = await previewContactAssets({});
    expect(out).toEqual({ matchCount: 0, unmonitoredCount: 0, sample: [] });
    expect(prismaMock.asset.findMany).not.toHaveBeenCalled();
  });

  it("unions explicit pins with the condition matches", async () => {
    prismaMock.asset.findMany
      .mockResolvedValueOnce([{ id: "a1", location: "Nashville" }])
      .mockResolvedValueOnce([
        { id: "a1", hostname: "SW1", ipAddress: null, assetType: "switch", monitored: true },
        { id: "pinned", hostname: "SRV9", ipAddress: null, assetType: "server", monitored: true },
      ]);
    const out = await previewContactAssets({
      assetCondition: COND("location", "contains", "nashville"),
      assetIds: ["pinned"],
    });
    expect(out.matchCount).toBe(2);
  });
});
