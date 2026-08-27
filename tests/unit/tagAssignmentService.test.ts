/**
 * tests/unit/tagAssignmentService.test.ts
 *
 * Pure-function coverage for criteria normalization, the DB prefilter
 * (superset invariant), and the matcher predicate. No DB calls; the
 * reconcile/apply/preview paths are exercised by the integration suite.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeCriteria,
  normalizeTagCondition,
  buildPrefilterWhere,
  assetMatchesCriteria,
  tagFilterOf,
  tagFilterView,
  tagIsManaged,
  type TagCriteria,
} from "../../src/services/tagAssignmentService.js";

function asset(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    ipAddress: null,
    manufacturer: null,
    model: null,
    os: null,
    osVersion: null,
    hostname: null,
    department: null,
    location: null,
    assetType: "other",
    status: "active",
    ...over,
  } as any;
}

describe("normalizeCriteria", () => {
  it("returns null for null/empty/zero-rule input", () => {
    expect(normalizeCriteria(null)).toBeNull();
    expect(normalizeCriteria(undefined)).toBeNull();
    expect(normalizeCriteria({ rules: [] })).toBeNull();
    // Rule with empty values is dropped → no usable rules → null.
    expect(normalizeCriteria({ rules: [{ field: "manufacturer", op: "exact", values: ["", "  "] }] })).toBeNull();
  });

  it("normalizes a string rule, de-duping and trimming values", () => {
    const c = normalizeCriteria({
      rules: [{ field: "manufacturer", op: "contains", values: [" Cisco ", "Cisco", "Arista"] }],
    });
    expect(c).toEqual({
      version: 1,
      match: "all",
      rules: [{ field: "manufacturer", op: "contains", values: ["Cisco", "Arista"] }],
    });
  });

  it("rejects unknown fields and operators", () => {
    expect(() => normalizeCriteria({ rules: [{ field: "bogus", op: "exact", values: ["x"] }] })).toThrow();
    expect(() => normalizeCriteria({ rules: [{ field: "os", op: "regex", values: ["x"] }] })).toThrow();
  });

  it("forces exact-only on enum fields and validates the status domain", () => {
    expect(() => normalizeCriteria({ rules: [{ field: "status", op: "contains", values: ["active"] }] })).toThrow();
    expect(() => normalizeCriteria({ rules: [{ field: "status", op: "exact", values: ["bogus"] }] })).toThrow();
    const c = normalizeCriteria({ rules: [{ field: "status", op: "exact", values: ["ACTIVE"] }] })!;
    expect(c.rules[0]).toEqual({ field: "status", op: "exact", values: ["active"] });
  });

  it("validates subnet CIDRs and keeps v4 + v6", () => {
    expect(() => normalizeCriteria({ rules: [{ field: "subnet", op: "inCidr", cidrs: ["not-a-cidr"] }] })).toThrow();
    const c = normalizeCriteria({
      rules: [{ field: "subnet", op: "inCidr", cidrs: ["10.1.0.0/16", "2001:db8::/32"] }],
    })!;
    expect(c.rules[0]).toEqual({ field: "subnet", op: "inCidr", cidrs: ["10.1.0.0/16", "2001:db8::/32"] });
  });

  it("rejects an uncompilable wildcard pattern", () => {
    // compileWildcard escapes metachars, so this is hard to break; an empty
    // value is dropped before pattern compilation, leaving no rule → null.
    expect(normalizeCriteria({ rules: [{ field: "os", op: "pattern", values: [""] }] })).toBeNull();
  });

  it("integration is exact-only; fortigate takes the string operators", () => {
    expect(() => normalizeCriteria({ rules: [{ field: "integration", op: "contains", values: ["id-1"] }] })).toThrow();
    const i = normalizeCriteria({ rules: [{ field: "integration", op: "exact", values: ["id-1"] }] })!;
    expect(i.rules[0]).toEqual({ field: "integration", op: "exact", values: ["id-1"] });

    const f = normalizeCriteria({ rules: [{ field: "fortigate", op: "contains", values: ["RIVERBEND"] }] })!;
    expect(f.rules[0]).toEqual({ field: "fortigate", op: "contains", values: ["RIVERBEND"] });
    expect(() => normalizeCriteria({ rules: [{ field: "fortigate", op: "regex", values: ["x"] }] })).toThrow();
  });
});

describe("assetMatchesCriteria (predicate)", () => {
  it("exact is case-insensitive and ORs values within a rule", () => {
    const c = normalizeCriteria({ rules: [{ field: "manufacturer", op: "exact", values: ["Cisco", "Arista"] }] })!;
    expect(assetMatchesCriteria(asset({ manufacturer: "cisco" }), c)).toBe(true);
    expect(assetMatchesCriteria(asset({ manufacturer: "ARISTA" }), c)).toBe(true);
    expect(assetMatchesCriteria(asset({ manufacturer: "Juniper" }), c)).toBe(false);
    expect(assetMatchesCriteria(asset({ manufacturer: null }), c)).toBe(false);
  });

  it("contains matches a substring", () => {
    const c = normalizeCriteria({ rules: [{ field: "os", op: "contains", values: ["windows"] }] })!;
    expect(assetMatchesCriteria(asset({ os: "Microsoft Windows Server 2022" }), c)).toBe(true);
    expect(assetMatchesCriteria(asset({ os: "Ubuntu 22.04" }), c)).toBe(false);
  });

  it("pattern matches a wildcard, anchored", () => {
    const c = normalizeCriteria({ rules: [{ field: "os", op: "pattern", values: ["Windows*"] }] })!;
    expect(assetMatchesCriteria(asset({ os: "Windows 11" }), c)).toBe(true);
    expect(assetMatchesCriteria(asset({ os: "MS Windows 11" }), c)).toBe(false); // not prefix
  });

  it("ANDs across multiple rules", () => {
    const c = normalizeCriteria({
      rules: [
        { field: "manufacturer", op: "exact", values: ["Fortinet"] },
        { field: "assetType", op: "exact", values: ["firewall"] },
      ],
    })!;
    expect(assetMatchesCriteria(asset({ manufacturer: "Fortinet", assetType: "firewall" }), c)).toBe(true);
    expect(assetMatchesCriteria(asset({ manufacturer: "Fortinet", assetType: "switch" }), c)).toBe(false);
  });

  it("subnet rule matches via the supplied matched-CIDR set", () => {
    const c = normalizeCriteria({ rules: [{ field: "subnet", op: "inCidr", cidrs: ["10.1.0.0/16", "10.2.0.0/16"] }] })!;
    const a = asset({ ipAddress: "10.1.5.20" });
    expect(assetMatchesCriteria(a, c, new Set(["10.1.0.0/16"]))).toBe(true);
    expect(assetMatchesCriteria(a, c, new Set())).toBe(false);
  });

  it("integration matches discoveredByIntegrationId OR any AssetSource row", () => {
    const c = normalizeCriteria({ rules: [{ field: "integration", op: "exact", values: ["int-1"] }] })!;
    expect(assetMatchesCriteria(asset({ discoveredByIntegrationId: "int-1" }), c)).toBe(true);
    expect(assetMatchesCriteria(asset({ sources: [{ integrationId: "int-1" }] }), c)).toBe(true);
    expect(assetMatchesCriteria(asset({ discoveredByIntegrationId: "int-2", sources: [{ integrationId: null }] }), c)).toBe(false);
    expect(assetMatchesCriteria(asset({}), c)).toBe(false);
  });

  it("fortigate matches learnedLocation OR any sighting, with string ops", () => {
    const exact = normalizeCriteria({ rules: [{ field: "fortigate", op: "exact", values: ["RIVERBEND-FG"] }] })!;
    expect(assetMatchesCriteria(asset({ learnedLocation: "riverbend-fg" }), exact)).toBe(true);
    expect(assetMatchesCriteria(asset({ fortigateSightings: [{ fortigateDevice: "RIVERBEND-FG" }] }), exact)).toBe(true);
    expect(assetMatchesCriteria(asset({ learnedLocation: "OTHER-FG" }), exact)).toBe(false);

    // contains covers a site prefix across every gate at the site.
    const site = normalizeCriteria({ rules: [{ field: "fortigate", op: "contains", values: ["riverbend"] }] })!;
    expect(assetMatchesCriteria(asset({ fortigateSightings: [{ fortigateDevice: "RIVERBEND-101F-1" }] }), site)).toBe(true);
    expect(assetMatchesCriteria(asset({ learnedLocation: "SALINE-FG" }), site)).toBe(false);
    expect(assetMatchesCriteria(asset({}), site)).toBe(false);
  });
});

describe("buildPrefilterWhere (superset invariant)", () => {
  it("excludes decommissioned unless status is targeted", () => {
    const c = normalizeCriteria({ rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] })!;
    const where = JSON.stringify(buildPrefilterWhere(c));
    expect(where).toContain("decommissioned");
  });

  it("does not force a decommissioned exclusion when status is a criterion", () => {
    const c = normalizeCriteria({ rules: [{ field: "status", op: "exact", values: ["decommissioned"] }] })!;
    const where: any = buildPrefilterWhere(c);
    // Only the status equality clause; no extra `status not decommissioned`.
    const flat = JSON.stringify(where);
    expect(flat).toContain("decommissioned");
    expect((flat.match(/decommissioned/g) || []).length).toBe(1);
  });

  it("contributes no field clause for a prefixless pattern (predicate-only, superset preserved)", () => {
    const c: TagCriteria = { version: 1, match: "all", rules: [{ field: "os", op: "pattern", values: ["*nix"] }] };
    const where: any = buildPrefilterWhere(c);
    // Only the implicit decommissioned exclusion remains — the pattern adds nothing.
    expect(JSON.stringify(where)).not.toContain('"os"');
  });

  it("uses a literal-prefix startsWith only when every pattern value has a prefix", () => {
    const c: TagCriteria = {
      version: 1,
      match: "all",
      rules: [{ field: "os", op: "pattern", values: ["Win*", "Lin*"] }],
    };
    expect(JSON.stringify(buildPrefilterWhere(c))).toContain("startsWith");

    const mixed: TagCriteria = {
      version: 1,
      match: "all",
      rules: [{ field: "os", op: "pattern", values: ["Win*", "*x"] }],
    };
    // A prefixless value present → skip DB narrowing for the rule entirely.
    expect(JSON.stringify(buildPrefilterWhere(mixed))).not.toContain("startsWith");
  });

  it("integration narrows on both provenance surfaces", () => {
    const c = normalizeCriteria({ rules: [{ field: "integration", op: "exact", values: ["int-1"] }] })!;
    const flat = JSON.stringify(buildPrefilterWhere(c));
    expect(flat).toContain("discoveredByIntegrationId");
    expect(flat).toContain("sources");
  });

  it("fortigate narrows on learnedLocation AND sightings for exact/contains; prefixless pattern adds nothing", () => {
    const c = normalizeCriteria({ rules: [{ field: "fortigate", op: "contains", values: ["JEFF"] }] })!;
    const flat = JSON.stringify(buildPrefilterWhere(c));
    expect(flat).toContain("learnedLocation");
    expect(flat).toContain("fortigateSightings");

    const prefixless: TagCriteria = {
      version: 1,
      match: "all",
      rules: [{ field: "fortigate", op: "pattern", values: ["*-FG"] }],
    };
    expect(JSON.stringify(buildPrefilterWhere(prefixless))).not.toContain("learnedLocation");
  });
});

// ─── Filter shape: the condition tree, and the legacy blob's fold-forward ────

describe("normalizeTagCondition", () => {
  it("accepts a tree over the WIDE device-filter vocabulary", () => {
    // osVersion / department / location / fortigate + the wildcard operator are
    // the fields the flat criteria builder already offered, so the tag surface
    // has to keep reaching them or the shape cutover is a regression.
    const cond = normalizeTagCondition({
      op: "and",
      children: [
        { field: "osVersion", operator: "matches", value: "24H2*" },
        { field: "department", operator: "equals", value: "Ops" },
        { field: "location", operator: "contains", value: "Ashfield" },
        { field: "fortigate", operator: "startsWith", value: "PLV" },
      ],
    });
    expect(cond).not.toBeNull();
    expect(cond!.children).toHaveLength(4);
  });

  it("collapses an EMPTY tree to null rather than reading it as every asset", () => {
    // and([]) is true for any asset by boolean identity. A tag has no
    // All-devices control, so an empty tree can only come from a half-built
    // form — honoring it would tag the whole fleet on save.
    expect(normalizeTagCondition({ op: "and", children: [] })).toBeNull();
    expect(normalizeTagCondition(null)).toBeNull();
  });

  it("rejects a field outside the vocabulary", () => {
    expect(() =>
      normalizeTagCondition({ op: "and", children: [{ field: "nope", operator: "equals", value: "x" }] }),
    ).toThrow();
  });
});

describe("tagFilterOf", () => {
  const tree = { op: "and" as const, children: [{ field: "manufacturer", operator: "equals", value: "Cisco" }] };

  it("prefers a stored condition over a legacy blob", () => {
    const filter = tagFilterOf({
      assetCondition: tree,
      criteria: { version: 1, match: "all", rules: [{ field: "model", op: "exact", values: ["X"] }] },
    });
    expect(filter.condition).toEqual(tree);
    expect(filter.criteria).toBeNull();
  });

  it("folds a legacy blob forward so consumers only ever see a tree", () => {
    const filter = tagFilterOf({
      criteria: { version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] },
    });
    expect(filter.criteria).toBeNull();
    expect(filter.condition).toEqual({
      op: "and",
      children: [{ field: "manufacturer", operator: "equals", value: "Cisco" }],
    });
  });

  it("keeps a blob the tree cannot express on the LEGACY predicate", () => {
    // An `integration` rule has no tree equivalent. Converting would widen which
    // devices carry the tag and dropping the rule would narrow it, so the flat
    // blob stays live instead of being half-converted.
    const filter = tagFilterOf({
      criteria: { version: 1, match: "all", rules: [{ field: "integration", op: "exact", values: ["int-1"] }] },
    });
    expect(filter.condition).toBeNull();
    expect(filter.criteria).not.toBeNull();
  });

  it("treats a tag with neither shape as unmanaged", () => {
    expect(tagFilterOf({})).toEqual({ condition: null, criteria: null });
    expect(tagIsManaged({})).toBe(false);
    expect(tagIsManaged({ criteria: { version: 1, match: "all", rules: [] } })).toBe(true);
    expect(tagIsManaged({ assetCondition: tree })).toBe(true);
  });

  it("drops a stored tree that no longer validates instead of throwing", () => {
    // One bad row must not 500 the tag list or wedge the reconcile job.
    expect(tagFilterOf({ assetCondition: { op: "and", children: [{ field: "gone", operator: "eq", value: "x" }] } }))
      .toEqual({ condition: null, criteria: null });
  });
});

describe("tagFilterView", () => {
  it("hands the editor a tree for a tag still on the flat shape", () => {
    // Without the fold the editor would render an auto-assigning tag as
    // unfiltered, and the next save would silently clear a live filter.
    const view = tagFilterView({
      criteria: { version: 1, match: "all", rules: [{ field: "model", op: "contains", values: ["FS-108"] }] },
    });
    expect(view.assetCondition).toBeNull();
    expect(view.assetConditionEffective).toEqual({
      op: "and",
      children: [{ field: "model", operator: "contains", value: "FS-108" }],
    });
    expect(view.assetFilterUnconvertible).toEqual([]);
  });

  it("names the fields that blocked the fold so the editor can say so", () => {
    const view = tagFilterView({
      criteria: { version: 1, match: "all", rules: [{ field: "integration", op: "exact", values: ["int-1"] }] },
    });
    expect(view.assetConditionEffective).toBeNull();
    expect(view.assetFilterUnconvertible).toEqual(["integration"]);
  });

  it("ORs a multi-value rule into a subgroup", () => {
    const view = tagFilterView({
      criteria: { version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco", "Juniper"] }] },
    });
    expect(view.assetConditionEffective).toEqual({
      op: "and",
      children: [
        {
          op: "or",
          children: [
            { field: "manufacturer", operator: "equals", value: "Cisco" },
            { field: "manufacturer", operator: "equals", value: "Juniper" },
          ],
        },
      ],
    });
  });
});
