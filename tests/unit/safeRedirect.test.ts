/**
 * tests/unit/safeRedirect.test.ts — post-login redirect sanitization.
 *
 * This predicate stands between `?next=` and `res.redirect` on a route an
 * operator reaches mid-authentication, so every case that must NOT survive is
 * pinned here rather than left to the shape of the implementation.
 */

import { describe, it, expect } from "vitest";
import { safeNextPath } from "../../src/utils/safeRedirect.js";

describe("safeNextPath — accepted targets", () => {
  it("passes a plain local path through unchanged", () => {
    expect(safeNextPath("/assets.html")).toBe("/assets.html");
  });

  it("keeps the query string", () => {
    expect(safeNextPath("/assets.html?tab=monitoring")).toBe("/assets.html?tab=monitoring");
  });

  it("keeps a fragment (it never reaches the server, and cannot carry an authority)", () => {
    expect(safeNextPath("/mobile.html#more/alerts")).toBe("/mobile.html#more/alerts");
  });

  it("leaves percent-encoding alone rather than decoding it into a new meaning", () => {
    // %2f decoded would read as a path separator; it must stay encoded.
    expect(safeNextPath("/a%2f%2fevil.com")).toBe("/a%2f%2fevil.com");
  });
});

describe("safeNextPath — rejected targets fall back to /", () => {
  const rejected: Array<[string, unknown]> = [
    ["absolute http URL", "https://evil.example/x"],
    ["protocol-relative", "//evil.example/x"],
    ["backslash-smuggled authority", "/\\evil.example"],
    ["backslash then slash", "/\\/evil.example"],
    ["scheme-only", "javascript:alert(1)"],
    ["empty string", ""],
    ["not a string", 42],
    ["null", null],
    ["undefined", undefined],
    ["object", { toString: () => "/ok" }],
    ["does not start with /", "assets.html"],
  ];
  for (const [name, input] of rejected) {
    it(`rejects ${name}`, () => {
      expect(safeNextPath(input)).toBe("/");
    });
  }

  it("refuses the login page, which would read as a failed login", () => {
    expect(safeNextPath("/login.html")).toBe("/");
    expect(safeNextPath("/login.html?error=x")).toBe("/");
  });

  it("does not treat a path merely PREFIXED with login.html as the login page", () => {
    expect(safeNextPath("/login.html.bak")).toBe("/login.html.bak");
  });
});
