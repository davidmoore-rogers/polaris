import { describe, it, expect } from "vitest";
import { criteriaToCondition } from "../../src/utils/criteriaToCondition.js";
import {
  deviceFilterConditionSchema,
  evaluateScopeCondition,
  scopeConditionSchema,
  type ScopeConditionGroup,
} from "../../src/services/notificationTypes.js";

/** A converted tree must be storable — i.e. valid under the contacts schema. */
function parsed(raw: unknown): ScopeConditionGroup {
  const { condition } = criteriaToCondition(raw);
  expect(condition).not.toBeNull();
  return deviceFilterConditionSchema.parse(condition);
}

describe("criteriaToCondition", () => {
  it("returns no condition for an empty / absent blob", () => {
    expect(criteriaToCondition(null).condition).toBeNull();
    expect(criteriaToCondition({}).condition).toBeNull();
    expect(criteriaToCondition({ rules: [] }).condition).toBeNull();
  });

  it("ANDs the rules and keeps a single-value rule as a bare leaf", () => {
    const tree = parsed({
      version: 1,
      match: "all",
      rules: [
        { field: "assetType", op: "exact", values: ["switch"] },
        { field: "hostname", op: "contains", values: ["-61f-"] },
      ],
    });
    expect(tree.op).toBe("and");
    expect(tree.children).toEqual([
      { field: "assetType", operator: "equals", value: "switch" },
      { field: "hostname", operator: "contains", value: "-61f-" },
    ]);
  });

  it("ORs the values within one rule as a subgroup", () => {
    const tree = parsed({ rules: [{ field: "os", op: "contains", values: ["Windows", "Linux"] }] });
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toEqual({
      op: "or",
      children: [
        { field: "os", operator: "contains", value: "Windows" },
        { field: "os", operator: "contains", value: "Linux" },
      ],
    });
  });

  it("maps every flat operator, including pattern → the wildcard op", () => {
    const tree = parsed({
      rules: [
        { field: "model", op: "exact", values: ["FS-108F"] },
        { field: "location", op: "contains", values: ["Nashville"] },
        { field: "hostname", op: "pattern", values: ["PLV*-61F-?"] },
      ],
    });
    expect((tree.children as any[]).map((c) => c.operator)).toEqual(["equals", "contains", "matches"]);
  });

  it("reads subnet rules from cidrs, not values", () => {
    const tree = parsed({ rules: [{ field: "subnet", op: "inCidr", cidrs: ["10.20.0.0/16", "10.30.0.1"] }] });
    expect(tree.children[0]).toEqual({
      op: "or",
      children: [
        { field: "subnet", operator: "inCidr", value: "10.20.0.0/16" },
        // A bare IP stays as typed — the schema accepts either form and
        // scopeCidrOf widens it at match time.
        { field: "subnet", operator: "inCidr", value: "10.30.0.1" },
      ],
    });
  });

  it("carries the four fields automations lacks", () => {
    const tree = parsed({
      rules: [
        { field: "osVersion", op: "contains", values: ["23H2"] },
        { field: "department", op: "exact", values: ["Plant Ops"] },
        { field: "location", op: "contains", values: ["Nashville"] },
        { field: "fortigate", op: "contains", values: ["PLVCOR"] },
      ],
    });
    expect((tree.children as any[]).map((c) => c.field)).toEqual([
      "osVersion", "department", "location", "fortigate",
    ]);
    // ...and those same fields must NOT be storable as an automation scope.
    expect(() => scopeConditionSchema.parse(tree)).toThrow();
  });

  it("reports `integration` as unconvertible instead of dropping it silently", () => {
    const out = criteriaToCondition({
      rules: [
        { field: "integration", op: "exact", values: ["int-1"] },
        { field: "hostname", op: "contains", values: ["prod"] },
      ],
    });
    expect(out.unconvertible).toEqual(["integration"]);
    // The convertible half still comes back, so a caller can show what it would
    // become — but a non-empty `unconvertible` is its signal not to store it.
    expect(out.condition).toEqual({
      op: "and",
      children: [{ field: "hostname", operator: "contains", value: "prod" }],
    });
  });

  it("skips rules with no usable values", () => {
    const out = criteriaToCondition({
      rules: [
        { field: "hostname", op: "contains", values: ["  ", ""] },
        { field: "subnet", op: "inCidr", cidrs: [] },
      ],
    });
    expect(out.condition).toBeNull();
  });

  it("preserves matching behaviour end to end (AND of rules, OR of values)", () => {
    const tree = parsed({
      rules: [
        { field: "assetType", op: "exact", values: ["switch"] },
        { field: "location", op: "contains", values: ["nashville", "murfreesboro"] },
      ],
    });
    const at = (assetType: string, location: string) =>
      evaluateScopeCondition(tree, { id: "a", assetType, location });

    expect(at("switch", "Nashville Plant")).toBe(true);
    expect(at("switch", "Murfreesboro Quarry")).toBe(true);
    expect(at("switch", "Knoxville")).toBe(false); // neither value
    expect(at("server", "Nashville Plant")).toBe(false); // AND leg fails
  });
});
