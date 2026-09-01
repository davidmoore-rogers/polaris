/**
 * tests/unit/wildcard.test.ts — the shared pattern compiler.
 *
 * The behavioural coverage lives in autoMonitorInterfacesService.test.ts, which
 * exercises these through that service's re-export (its four consumers import
 * them from there). This file pins the properties the SECOND consumer depends
 * on — the condition tree's `matches` operator — so a change made for the
 * interface picker can't quietly redefine what a contact's device filter means.
 */

import { describe, it, expect } from "vitest";
import { compileWildcard, compilePattern, MAX_PATTERN_LENGTH } from "../../src/utils/wildcard.js";

describe("compileWildcard", () => {
  it("anchors the pattern — a wildcard match is whole-string", () => {
    const r = compileWildcard("plv-*-sw?");
    expect(r.test("plv-61f-sw1")).toBe(true);
    expect(r.test("plv-61f-sw")).toBe(false);
    expect(r.test("xplv-61f-sw1")).toBe(false);
  });

  it("treats regex metacharacters as literals", () => {
    // The reason a device filter can safely take operator text: "." is a dot,
    // not "any character", and "[1]" is not a character class.
    expect(compileWildcard("ashfield.plant").test("ashfield.plant")).toBe(true);
    expect(compileWildcard("ashfield.plant").test("ashfieldXplant")).toBe(false);
    expect(compileWildcard("port[1]").test("port[1]")).toBe(true);
    expect(compileWildcard("port[1]").test("port1")).toBe(false);
  });

  it("refuses empty and over-long patterns rather than compiling them", () => {
    expect(() => compileWildcard("")).toThrow();
    expect(() => compileWildcard("a".repeat(MAX_PATTERN_LENGTH + 1))).toThrow(/exceeds/);
    expect(() => compileWildcard("a".repeat(MAX_PATTERN_LENGTH))).not.toThrow();
  });

  it("memoizes per pattern — the engine reaches this per asset per rule per tick", () => {
    // Same instance back means no recompile; safe to share because the
    // compiled RegExp has no /g flag, so .test() carries no lastIndex state.
    const a = compileWildcard("port4*");
    expect(compileWildcard("port4*")).toBe(a);
    expect(a.global).toBe(false);
    expect(compileWildcard("port5*")).not.toBe(a);
  });
});

describe("compilePattern", () => {
  it("dispatches on the regex flag — wildcards anchored, raw regex not", () => {
    expect(compilePattern("wan*", false).source).toBe("^wan.*$");
    expect(compilePattern("wan", true).test("xwanx")).toBe(true);
  });

  it("surfaces a malformed regex as a throw at save time", () => {
    expect(() => compilePattern("(unclosed", true)).toThrow();
  });
});
