/**
 * tests/unit/prismaTextFilter.test.ts — operator-aware text-filter builder
 */

import { describe, it, expect } from "vitest";
import { buildPrismaTextFilter, TEXT_FILTER_OPS } from "../../src/utils/prismaTextFilter.js";

describe("buildPrismaTextFilter", () => {
  it("defaults to contains (missing or unknown op)", () => {
    expect(buildPrismaTextFilter("hostname", "web", undefined))
      .toEqual({ hostname: { contains: "web", mode: "insensitive" } });
    expect(buildPrismaTextFilter("hostname", "web", "bogus"))
      .toEqual({ hostname: { contains: "web", mode: "insensitive" } });
  });

  it("not_contains keeps mode as a SIBLING of not (Prisma rejects nesting)", () => {
    expect(buildPrismaTextFilter("hostname", "web", "not_contains"))
      .toEqual({ hostname: { not: { contains: "web" }, mode: "insensitive" } });
  });

  it("empty / is_not_empty carry a null arm for nullable columns (default)", () => {
    expect(buildPrismaTextFilter("actor", "", "empty"))
      .toEqual({ OR: [{ actor: null }, { actor: "" }] });
    expect(buildPrismaTextFilter("actor", "", "is_not_empty"))
      .toEqual({ AND: [{ actor: { not: null } }, { actor: { not: "" } }] });
  });

  it("empty / is_not_empty compare against \"\" only when nullable: false", () => {
    expect(buildPrismaTextFilter("action", "", "empty", { nullable: false }))
      .toEqual({ action: "" });
    expect(buildPrismaTextFilter("action", "", "is_not_empty", { nullable: false }))
      .toEqual({ action: { not: "" } });
  });

  it("returns undefined (no-op) for blank values on contains ops", () => {
    expect(buildPrismaTextFilter("hostname", "", "contains")).toBeUndefined();
    expect(buildPrismaTextFilter("hostname", "   ", "not_contains")).toBeUndefined();
    expect(buildPrismaTextFilter("hostname", undefined, undefined)).toBeUndefined();
  });

  it("exports the four-operator set", () => {
    expect([...TEXT_FILTER_OPS].sort())
      .toEqual(["contains", "empty", "is_not_empty", "not_contains"]);
  });
});
