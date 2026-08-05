/**
 * tests/unit/object.test.ts
 */

import { describe, it, expect } from "vitest";
import { asObject } from "../../src/utils/object.js";

describe("asObject", () => {
  it("shallow-copies a plain object", () => {
    const src = { a: 1, nested: { b: 2 } };
    const out = asObject(src);
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
    expect(out.nested).toBe(src.nested); // shallow
  });

  it("returns {} for null, undefined, and primitives", () => {
    expect(asObject(null)).toEqual({});
    expect(asObject(undefined)).toEqual({});
    expect(asObject("str")).toEqual({});
    expect(asObject(42)).toEqual({});
    expect(asObject(true)).toEqual({});
  });

  it("spreads arrays into index-keyed objects (historic behavior, relied on nowhere but preserved)", () => {
    expect(asObject(["x", "y"])).toEqual({ 0: "x", 1: "y" });
  });
});
