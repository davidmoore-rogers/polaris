/**
 * tests/unit/httpCredentialValidation.test.ts
 *
 * Save-time validation of the `http` (HTTP Check) credential type. The point of
 * validating here at all is WHEN the operator finds out: a check definition is
 * exercised by a background probe once per asset per interval, so anything not
 * caught in the form is discovered from a probe error column hours later, on
 * every asset at once. The regex compile is the clearest case of that.
 */

import { describe, it, expect } from "vitest";
import { validateConfig } from "../../src/services/credentialService.js";

/** validateConfig mutates its argument (canonicalization) — hand it a fresh copy. */
function check(cfg: Record<string, unknown>) {
  const c = { ...cfg };
  validateConfig("http", c);
  return c;
}

describe("http credential validation — accepted shapes", () => {
  it("accepts an entirely empty config: an unauthenticated GET / expecting any 2xx is a valid check", () => {
    expect(check({}).path).toBe("/");
  });
  it("canonicalizes the path so the stored value equals the request line", () => {
    expect(check({ path: "healthz" }).path).toBe("/healthz");
    expect(check({ path: "  /healthz \n" }).path).toBe("/healthz");
  });
  it("stores a blank path as / — this IS the definition, so it must name a path", () => {
    // Deliberately unlike Asset.httpCheckPath, where blank means "no override".
    expect(check({ path: "" }).path).toBe("/");
  });
  it("coerces port and expectStatus to numbers so the stored JSON is typed", () => {
    const c = check({ port: "8443", expectStatus: "204" });
    expect(c.port).toBe(8443);
    expect(c.expectStatus).toBe(204);
  });
  it("accepts a valid regex", () => {
    expect(() => check({ expectBody: '"state"\\s*:\\s*"up"', matchMode: "regex" })).not.toThrow();
  });
  it("accepts both halves of basic auth", () => {
    expect(() => check({ username: "monitor", password: "s3cret" })).not.toThrow();
  });
  it("tolerates a lone caseSensitive/failOnMismatch toggle with no expectBody", () => {
    // Harmless, and rejecting it would 400 a form mid-edit.
    expect(() => check({ caseSensitive: true, failOnMismatch: false })).not.toThrow();
  });
});

describe("http credential validation — rejected shapes", () => {
  it("rejects an invalid regex at SAVE time, not once per probe forever", () => {
    expect(() => check({ expectBody: "([unclosed", matchMode: "regex" })).toThrow(/regex is invalid/i);
  });
  it("does not compile the pattern in contains mode — a bare bracket is legitimate text", () => {
    expect(() => check({ expectBody: "([unclosed" })).not.toThrow();
  });
  it("rejects an out-of-range port", () => {
    expect(() => check({ port: 0 })).toThrow(/between 1 and 65535/);
    expect(() => check({ port: 70000 })).toThrow(/between 1 and 65535/);
  });
  it("rejects a status code that isn't one", () => {
    expect(() => check({ expectStatus: 99 })).toThrow(/status code/i);
    expect(() => check({ expectStatus: 600 })).toThrow(/status code/i);
  });
  it("rejects an unknown match mode", () => {
    expect(() => check({ matchMode: "glob" })).toThrow(/contains/);
  });
  it("rejects half-configured basic auth in either direction", () => {
    // A username with no password sends an empty credential and reads as an
    // auth failure the operator can't explain from the form.
    expect(() => check({ username: "monitor" })).toThrow(/both a username and a password/);
    expect(() => check({ password: "s3cret" })).toThrow(/both a username and a password/);
  });
  it("rejects non-boolean flags", () => {
    expect(() => check({ verifyTls: "yes" })).toThrow(/must be a boolean/);
    expect(() => check({ useHttps: 1 })).toThrow(/must be a boolean/);
  });
});
