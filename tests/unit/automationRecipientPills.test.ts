/**
 * tests/unit/automationRecipientPills.test.ts
 *
 * The pure pill ⇄ payload mapping behind the Notify action's To/Cc/Bcc token
 * fields. Loaded out of the browser module via node:vm off
 * window.PolarisAutomationRecipients — the automationSentences.test.ts idiom.
 *
 * What actually matters here:
 *   - a Polaris account becomes a USER pill (an id survives the person changing
 *     address; a copied string doesn't) and a typed one an ADDRESS pill;
 *   - a user id with no matching account round-trips as an "unknown" pill
 *     rather than being silently dropped on the next save — losing a recipient
 *     because an account was renamed is worse than showing a stub;
 *   - addresses normalize to lower case, matching what the server stores and
 *     what resolveEmailRecipients dedupes on.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

type Pill = { kind: string; value: string; label: string; unknown?: boolean };
type Recipients = {
  recipientUserIds?: string[];
  addresses?: string[];
  recipientRoles?: string[];
  recipientRegions?: string[];
  recipientDeviceRegion?: boolean;
  recipientAssetContacts?: boolean;
};

let pillsToRecipients: (p: Pill[]) => Recipients;
let recipientsToPills: (r: Recipients | null | undefined, users: unknown[], roles?: unknown[]) => Pill[];

beforeAll(() => {
  const src = readFileSync(resolve(__dirname, "../../public/js/automations-wizard.js"), "utf8");
  // The file's tail calls browser APIs at load; a bare window/document sandbox
  // is enough for the module-scope declarations we're after.
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  sandbox.document = { addEventListener() {}, querySelector: () => null, getElementById: () => null };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  vm.createContext(sandbox);
  new vm.Script(src, { filename: "automations-wizard.js" }).runInContext(sandbox);

  const api = (sandbox.window as Record<string, unknown>).PolarisAutomationRecipients as {
    pillsToRecipients: typeof pillsToRecipients;
    recipientsToPills: typeof recipientsToPills;
  };
  pillsToRecipients = api.pillsToRecipients;
  recipientsToPills = api.recipientsToPills;
});

const USERS = [
  { id: "u1", username: "jdoe", displayName: "Jane Doe", email: "jane@example.com" },
  { id: "u2", username: "svc", displayName: null, email: null },
];

describe("pillsToRecipients", () => {
  it("splits user pills from address pills", () => {
    expect(pillsToRecipients([
      { kind: "user", value: "u1", label: "Jane Doe" },
      { kind: "address", value: "noc@example.com", label: "noc@example.com" },
    ])).toEqual({ recipientUserIds: ["u1"], addresses: ["noc@example.com"] });
  });

  it("omits an empty half rather than sending an empty array", () => {
    expect(pillsToRecipients([{ kind: "user", value: "u1", label: "J" }])).toEqual({ recipientUserIds: ["u1"] });
    expect(pillsToRecipients([{ kind: "address", value: "a@b.co", label: "a@b.co" }])).toEqual({ addresses: ["a@b.co"] });
    expect(pillsToRecipients([])).toEqual({});
  });

  it("lower-cases addresses so they match what the server stores", () => {
    expect(pillsToRecipients([{ kind: "address", value: "  NOC@Example.COM ", label: "x" }]))
      .toEqual({ addresses: ["noc@example.com"] });
  });

  it("drops duplicates, case-insensitively for addresses", () => {
    expect(pillsToRecipients([
      { kind: "address", value: "a@b.co", label: "a" },
      { kind: "address", value: "A@B.CO", label: "a" },
      { kind: "user", value: "u1", label: "J" },
      { kind: "user", value: "u1", label: "J" },
    ])).toEqual({ recipientUserIds: ["u1"], addresses: ["a@b.co"] });
  });

  it("ignores malformed pills instead of emitting empty values", () => {
    expect(pillsToRecipients([
      { kind: "address", value: "", label: "" },
      null as unknown as Pill,
      { kind: "user", value: "u1", label: "J" },
    ])).toEqual({ recipientUserIds: ["u1"] });
  });

  it("preserves order", () => {
    expect(pillsToRecipients([
      { kind: "address", value: "z@b.co", label: "z" },
      { kind: "address", value: "a@b.co", label: "a" },
    ]).addresses).toEqual(["z@b.co", "a@b.co"]);
  });
});

describe("recipientsToPills", () => {
  it("labels a known user by display name, falling back to username", () => {
    const out = recipientsToPills({ recipientUserIds: ["u1", "u2"] }, USERS);
    expect(out.map((p) => p.label)).toEqual(["Jane Doe", "svc"]);
    expect(out.every((p) => p.kind === "user")).toBe(true);
  });

  it("KEEPS a user id with no matching account, flagged unknown", () => {
    const out = recipientsToPills({ recipientUserIds: ["ghost"] }, USERS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "user", value: "ghost", unknown: true });
    expect(out[0].label).toMatch(/unknown/i);
  });

  it("renders addresses as address pills", () => {
    expect(recipientsToPills({ addresses: ["noc@example.com"] }, USERS))
      .toEqual([{ kind: "address", value: "noc@example.com", label: "noc@example.com" }]);
  });

  it("handles null/empty input", () => {
    expect(recipientsToPills(null, USERS)).toEqual([]);
    expect(recipientsToPills(undefined, USERS)).toEqual([]);
    expect(recipientsToPills({}, USERS)).toEqual([]);
  });
});

describe("round trip", () => {
  it("survives pills → payload → pills, including the unknown id", () => {
    const before: Recipients = { recipientUserIds: ["u1", "ghost"], addresses: ["noc@example.com"] };
    const pills = recipientsToPills(before, USERS);
    expect(pillsToRecipients(pills)).toEqual(before);
  });

  it("a Cc set carrying both halves round-trips (the shape the old UI could not produce)", () => {
    const cc: Recipients = { recipientUserIds: ["u1"], addresses: ["ops@example.com"] };
    expect(pillsToRecipients(recipientsToPills(cc, USERS))).toEqual(cc);
  });
});

// ─── Role pills ─────────────────────────────────────────────────────────────
// "Notify the NOC role" is a third pill kind. Stored by ID so a rename keeps
// routing, and a DELETED role survives as an unknown pill rather than
// disappearing on the next save.
const ROLES = [
  { id: "r-noc", name: "NOC" },
  { id: "r-admin", name: "Admin" },
];

describe("role pills", () => {
  it("maps to recipientRoles, separate from users and addresses", () => {
    expect(pillsToRecipients([
      { kind: "role", value: "r-noc", label: "NOC" },
      { kind: "user", value: "u1", label: "Jane" },
      { kind: "address", value: "a@b.co", label: "a@b.co" },
    ])).toEqual({ recipientUserIds: ["u1"], addresses: ["a@b.co"], recipientRoles: ["r-noc"] });
  });

  it("dedupes repeated roles", () => {
    expect(pillsToRecipients([
      { kind: "role", value: "r-noc", label: "NOC" },
      { kind: "role", value: "r-noc", label: "NOC" },
    ])).toEqual({ recipientRoles: ["r-noc"] });
  });

  it("labels a stored role from the catalogue", () => {
    const out = recipientsToPills({ recipientRoles: ["r-noc"] }, USERS, ROLES);
    expect(out).toEqual([{ kind: "role", value: "r-noc", label: "NOC", unknown: false }]);
  });

  it("KEEPS a deleted role, flagged unknown", () => {
    const out = recipientsToPills({ recipientRoles: ["r-gone"] }, USERS, ROLES);
    expect(out[0]).toMatchObject({ kind: "role", value: "r-gone", unknown: true });
    expect(out[0].label).toMatch(/unknown role/i);
  });

  it("round-trips all three kinds together", () => {
    const before: Recipients = {
      recipientRoles: ["r-noc"],
      recipientUserIds: ["u1"],
      addresses: ["noc@example.com"],
    };
    expect(pillsToRecipients(recipientsToPills(before, USERS, ROLES))).toEqual(before);
  });
});

/**
 * Regions and the two DYNAMIC recipients. These were checkboxes beside the
 * recipient fields, which asked "who gets this alert?" in two places at once;
 * as pills they round-trip through the same mapping as everyone else.
 */
describe("region + dynamic pills", () => {
  it("maps a region pill to recipientRegions, deduped", () => {
    expect(pillsToRecipients([
      { kind: "region", value: "Nashville", label: "Nashville" },
      { kind: "region", value: "Nashville", label: "Nashville" },
      { kind: "region", value: "Memphis", label: "Memphis" },
    ])).toEqual({ recipientRegions: ["Nashville", "Memphis"] });
  });

  it("does NOT lower-case a region — it is a catalogue name, not an address", () => {
    // Addresses normalize; a region name is matched against stored region tags.
    expect(pillsToRecipients([{ kind: "region", value: "Nashville", label: "Nashville" }]))
      .toEqual({ recipientRegions: ["Nashville"] });
  });

  it("maps each dynamic pill to its flag", () => {
    expect(pillsToRecipients([{ kind: "deviceRegion", value: "1", label: "x" }]))
      .toEqual({ recipientDeviceRegion: true });
    expect(pillsToRecipients([{ kind: "assetContacts", value: "1", label: "x" }]))
      .toEqual({ recipientAssetContacts: true });
  });

  it("renders the dynamic flags back as pills, broadest first", () => {
    const out = recipientsToPills(
      { recipientDeviceRegion: true, recipientAssetContacts: true, recipientUserIds: ["u1"] },
      USERS,
      ROLES,
    );
    expect(out.map((p) => p.kind)).toEqual(["deviceRegion", "assetContacts", "user"]);
    // The labels are what the operator reads in the To field.
    expect(out[0].label).toMatch(/region/i);
    expect(out[1].label).toMatch(/contact/i);
  });

  it("round-trips every kind at once", () => {
    const before: Recipients = {
      recipientDeviceRegion: true,
      recipientAssetContacts: true,
      recipientRegions: ["Nashville"],
      recipientRoles: ["r-noc"],
      recipientUserIds: ["u1"],
      addresses: ["noc@example.com"],
    };
    expect(pillsToRecipients(recipientsToPills(before, USERS, ROLES))).toEqual(before);
  });

  it("omits a false flag rather than storing it", () => {
    // A dropped pill must leave the key absent — `false` and absent mean the
    // same thing to the server, but absent is what an untouched rule looks like.
    expect(recipientsToPills({ recipientDeviceRegion: false }, USERS, ROLES)).toEqual([]);
    expect(pillsToRecipients([])).toEqual({});
  });
});
