import { describe, it, expect } from "vitest";
import {
  DEVICE_FILTER_FIELD_OPS,
  DEVICE_FILTER_ONLY_FIELDS,
  SCOPE_FIELD_OPS,
  deviceFilterConditionSchema,
  evaluateScopeCondition,
  scopeConditionMeta,
  scopeConditionSchema,
  type ScopeConditionAsset,
  type ScopeConditionGroup,
} from "../../src/services/notificationTypes.js";

const and = (...children: unknown[]): ScopeConditionGroup =>
  ({ op: "and", children } as ScopeConditionGroup);
const one = (field: string, operator: string, value: string) => and({ field, operator, value });

const ASSET: ScopeConditionAsset = {
  id: "a1",
  assetType: "switch",
  hostname: "PLV-61F-SW1",
  os: "FortiSwitch",
  osVersion: "7.4.2",
  department: "Plant Ops",
  location: "Ashfield Plant",
  learnedLocation: "CENTRALFGT1",
  fortigateSightings: [{ fortigateDevice: "ASHF-EDGE-01" }],
};

describe("the two condition vocabularies", () => {
  it("device filter is a strict superset of the automations scope", () => {
    for (const field of Object.keys(SCOPE_FIELD_OPS)) {
      expect(DEVICE_FILTER_FIELD_OPS[field]).toBeDefined();
      for (const op of SCOPE_FIELD_OPS[field]!) {
        expect(DEVICE_FILTER_FIELD_OPS[field]).toContain(op);
      }
    }
  });

  it("adds exactly the four fields the flat criteria builder had", () => {
    expect(DEVICE_FILTER_ONLY_FIELDS.sort()).toEqual(
      ["department", "fortigate", "location", "osVersion"],
    );
  });

  it("offers the wildcard only on free-string fields", () => {
    expect(DEVICE_FILTER_FIELD_OPS.hostname).toContain("matches");
    expect(DEVICE_FILTER_FIELD_OPS.location).toContain("matches");
    // Closed / CIDR-shaped fields keep their operator sets.
    expect(DEVICE_FILTER_FIELD_OPS.assetType).not.toContain("matches");
    expect(DEVICE_FILTER_FIELD_OPS.status).not.toContain("matches");
    expect(DEVICE_FILTER_FIELD_OPS.tag).not.toContain("matches");
    expect(DEVICE_FILTER_FIELD_OPS.subnet).not.toContain("matches");
    // ...and automations gains nothing.
    expect(SCOPE_FIELD_OPS.hostname).not.toContain("matches");
  });

  it("refuses the extra fields and the wildcard on an automations scope", () => {
    expect(() => scopeConditionSchema.parse(one("location", "contains", "Ashfield"))).toThrow();
    expect(() => scopeConditionSchema.parse(one("hostname", "matches", "PLV*"))).toThrow();
    // Both are fine on the device filter.
    expect(() => deviceFilterConditionSchema.parse(one("location", "contains", "Ashfield"))).not.toThrow();
    expect(() => deviceFilterConditionSchema.parse(one("hostname", "matches", "PLV*"))).not.toThrow();
  });

  it("refuses an operator the field does not support, in either vocabulary", () => {
    expect(() => deviceFilterConditionSchema.parse(one("assetType", "contains", "sw"))).toThrow();
    expect(() => deviceFilterConditionSchema.parse(one("tag", "matches", "region:*"))).toThrow();
  });

  it("refuses a malformed wildcard at save time", () => {
    const tooLong = "a".repeat(600);
    expect(() => deviceFilterConditionSchema.parse(one("hostname", "matches", tooLong))).toThrow();
  });
});

describe("evaluateScopeCondition — device-filter fields", () => {
  it("matches the three plain columns", () => {
    expect(evaluateScopeCondition(one("osVersion", "startsWith", "7.4"), ASSET)).toBe(true);
    expect(evaluateScopeCondition(one("department", "equals", "plant ops"), ASSET)).toBe(true);
    expect(evaluateScopeCondition(one("location", "contains", "ashfield"), ASSET)).toBe(true);
    expect(evaluateScopeCondition(one("location", "contains", "knoxville"), ASSET)).toBe(false);
  });

  it("treats an absent column as empty rather than matching everything", () => {
    const bare: ScopeConditionAsset = { id: "a2" };
    expect(evaluateScopeCondition(one("department", "contains", "ops"), bare)).toBe(false);
    expect(evaluateScopeCondition(one("department", "notContains", "ops"), bare)).toBe(true);
  });

  it("applies the wildcard operator anchored, with metacharacters literal", () => {
    expect(evaluateScopeCondition(one("hostname", "matches", "plv-*-sw?"), ASSET)).toBe(true);
    expect(evaluateScopeCondition(one("hostname", "matches", "plv-*-sw"), ASSET)).toBe(false); // anchored
    expect(evaluateScopeCondition(one("hostname", "matches", "*61f*"), ASSET)).toBe(true);
    expect(evaluateScopeCondition(one("location", "matches", "ashfield.plant"), ASSET)).toBe(false); // "." is literal
  });

  describe("fortigate — one rule against several candidate names", () => {
    it("is satisfied by learnedLocation OR any sighting", () => {
      expect(evaluateScopeCondition(one("fortigate", "contains", "central"), ASSET)).toBe(true);
      expect(evaluateScopeCondition(one("fortigate", "contains", "ashf-edge"), ASSET)).toBe(true);
      expect(evaluateScopeCondition(one("fortigate", "equals", "ashf-edge-01"), ASSET)).toBe(true);
      expect(evaluateScopeCondition(one("fortigate", "contains", "memphis"), ASSET)).toBe(false);
    });

    it("requires a negative operator to hold for EVERY name", () => {
      // Sighted behind ASHF-EDGE-01, so "not behind ashf" must be false even
      // though the other candidate name doesn't contain it.
      expect(evaluateScopeCondition(one("fortigate", "notContains", "ashf"), ASSET)).toBe(false);
      expect(evaluateScopeCondition(one("fortigate", "notContains", "memphis"), ASSET)).toBe(true);
    });

    it("reads no known gate as absence, not as a match", () => {
      const bare: ScopeConditionAsset = { id: "a3" };
      expect(evaluateScopeCondition(one("fortigate", "contains", "central"), bare)).toBe(false);
      expect(evaluateScopeCondition(one("fortigate", "notContains", "central"), bare)).toBe(true);
    });

    it("ignores a sighting row with no device name", () => {
      const asset: ScopeConditionAsset = { id: "a4", fortigateSightings: [{ fortigateDevice: null }] };
      expect(evaluateScopeCondition(one("fortigate", "contains", "x"), asset)).toBe(false);
    });
  });

  it("keeps the automations fields working unchanged", () => {
    expect(evaluateScopeCondition(one("assetType", "equals", "switch"), ASSET)).toBe(true);
    expect(evaluateScopeCondition(one("hostname", "endsWith", "sw1"), ASSET)).toBe(true);
    expect(evaluateScopeCondition(one("os", "notContains", "windows"), ASSET)).toBe(true);
  });
});

describe("scopeConditionMeta", () => {
  it("publishes only the fields of the vocabulary it is given", () => {
    const auto = scopeConditionMeta(SCOPE_FIELD_OPS).fields.map((f) => f.field);
    const contact = scopeConditionMeta(DEVICE_FILTER_FIELD_OPS).fields.map((f) => f.field);
    expect(auto).not.toContain("location");
    expect(contact).toContain("location");
    expect(contact).toContain("fortigate");
    for (const f of auto) expect(contact).toContain(f);
  });

  it("omits assetId from both (valid to store, not offered to build)", () => {
    expect(scopeConditionMeta(SCOPE_FIELD_OPS).fields.map((f) => f.field)).not.toContain("assetId");
    expect(scopeConditionMeta(DEVICE_FILTER_FIELD_OPS).fields.map((f) => f.field)).not.toContain("assetId");
  });

  it("carries the precedence ladder for automations only", () => {
    expect(scopeConditionMeta(SCOPE_FIELD_OPS)).toHaveProperty("specificity");
    expect(scopeConditionMeta(DEVICE_FILTER_FIELD_OPS)).not.toHaveProperty("specificity");
  });

  it("labels the wildcard operator", () => {
    expect(scopeConditionMeta(DEVICE_FILTER_FIELD_OPS).operatorLabels.matches).toMatch(/wildcard/i);
  });
});
