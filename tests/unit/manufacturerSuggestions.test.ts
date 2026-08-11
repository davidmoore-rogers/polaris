/**
 * tests/unit/manufacturerSuggestions.test.ts — the typeahead behind the
 * Manufacturer Profiles "+ Add Manufacturer" box
 * (`mergeManufacturerSuggestions` / `listManufacturerSuggestions`).
 *
 * The whole point of the picker is to stop an operator minting a near-duplicate
 * profile ("Aruba Networks") that `getProfileFor` — which resolves through
 * `normalizeManufacturer` — would then never match. So the risks are all about
 * the merge lying: offering both spellings of one vendor, offering a
 * manufacturer that already has a profile (a guaranteed 409), or burying the
 * 400-device vendor below an alias-only entry. Prisma + the OUI service are
 * mocked; the merge is what's under test, not the queries.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const assetGroupBy = vi.fn();
const aliasFindMany = vi.fn();
const profileFindMany = vi.fn();
const getOuiOverrides = vi.fn();

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: { groupBy: (...a: unknown[]) => assetGroupBy(...a) },
    manufacturerAlias: { findMany: (...a: unknown[]) => aliasFindMany(...a) },
    manufacturerProfile: { findMany: (...a: unknown[]) => profileFindMany(...a) },
  },
}));

vi.mock("../../src/services/ouiService.js", () => ({
  getOuiOverrides: (...a: unknown[]) => getOuiOverrides(...a),
}));

const { mergeManufacturerSuggestions, listManufacturerSuggestions } =
  await import("../../src/services/manufacturerProfileService.js");
const { setAliasMap, _resetAliasMap } = await import("../../src/utils/manufacturerNormalize.js");

const EMPTY = { assets: [], aliases: [], oui: [], existing: [] };

beforeEach(() => {
  vi.clearAllMocks();
  _resetAliasMap();
});

describe("mergeManufacturerSuggestions", () => {
  it("merges the three contributors and tags each value with where it came from", () => {
    const out = mergeManufacturerSuggestions({
      assets:   [{ manufacturer: "Fortinet", count: 12 }],
      aliases:  ["Aruba"],
      oui:      ["Custom Switch Co."],
      existing: [],
    });
    expect(out.map((r) => r.value)).toEqual(["Fortinet", "Aruba", "Custom Switch Co."]);
    expect(out[0]).toEqual({ value: "Fortinet", sources: ["asset"], assetCount: 12 });
    expect(out[1].sources).toEqual(["alias"]);
    expect(out[2].sources).toEqual(["oui"]);
  });

  it("collapses spellings that canonicalize to the same vendor", () => {
    // The alias map is what `createProfile` will apply, so the picker must
    // offer the canonical form only — never both halves of an alias pair.
    setAliasMap([["aruba networks", "Aruba"]]);
    const out = mergeManufacturerSuggestions({
      ...EMPTY,
      assets: [
        { manufacturer: "Aruba Networks", count: 30 },
        { manufacturer: "Aruba", count: 4 },
      ],
    });
    expect(out).toEqual([{ value: "Aruba", sources: ["asset"], assetCount: 34 }]);
  });

  it("dedupes case-insensitively and unions the sources", () => {
    const out = mergeManufacturerSuggestions({
      assets:   [{ manufacturer: "cisco", count: 7 }],
      aliases:  ["Cisco"],
      oui:      ["CISCO"],
      existing: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe("cisco"); // first spelling seen wins
    expect(out[0].sources).toEqual(["asset", "alias", "oui"]);
  });

  it("drops manufacturers that already have a profile, matching canonically", () => {
    setAliasMap([["fortinet, inc.", "Fortinet"]]);
    const out = mergeManufacturerSuggestions({
      ...EMPTY,
      assets:   [{ manufacturer: "Fortinet, Inc.", count: 99 }, { manufacturer: "Dell", count: 2 }],
      existing: ["fortinet"],
    });
    expect(out.map((r) => r.value)).toEqual(["Dell"]);
  });

  it("orders by device count, then alphabetically", () => {
    const out = mergeManufacturerSuggestions({
      assets:   [{ manufacturer: "Dell", count: 3 }, { manufacturer: "Fortinet", count: 40 }],
      aliases:  ["Zebra", "Arista"],
      oui:      [],
      existing: [],
    });
    expect(out.map((r) => r.value)).toEqual(["Fortinet", "Dell", "Arista", "Zebra"]);
  });

  it("ignores null and blank values instead of emitting an empty row", () => {
    const out = mergeManufacturerSuggestions({
      assets:   [{ manufacturer: null, count: 5 }, { manufacturer: "   ", count: 5 }],
      aliases:  [""],
      oui:      ["  "],
      existing: [],
    });
    expect(out).toEqual([]);
  });
});

describe("listManufacturerSuggestions", () => {
  it("shapes the four queries into the merge input", async () => {
    assetGroupBy.mockResolvedValue([{ manufacturer: "Fortinet", _count: { _all: 8 } }]);
    aliasFindMany.mockResolvedValue([{ canonical: "Aruba" }]);
    getOuiOverrides.mockResolvedValue([{ prefix: "AA:BB:CC", manufacturer: "Custom Switch Co." }]);
    profileFindMany.mockResolvedValue([{ manufacturer: "Aruba" }]);

    const out = await listManufacturerSuggestions();
    expect(out).toEqual([
      { value: "Fortinet", sources: ["asset"], assetCount: 8 },
      { value: "Custom Switch Co.", sources: ["oui"], assetCount: 0 },
    ]);
  });

  it("still returns the other contributors when the OUI override read fails", async () => {
    // Overrides live in a Setting row; a read failure there must not cost the
    // operator the asset-derived suggestions, which are the useful ones.
    assetGroupBy.mockResolvedValue([{ manufacturer: "Dell", _count: { _all: 3 } }]);
    aliasFindMany.mockResolvedValue([]);
    getOuiOverrides.mockRejectedValue(new Error("setting unreadable"));
    profileFindMany.mockResolvedValue([]);

    await expect(listManufacturerSuggestions()).resolves.toEqual([
      { value: "Dell", sources: ["asset"], assetCount: 3 },
    ]);
  });
});
