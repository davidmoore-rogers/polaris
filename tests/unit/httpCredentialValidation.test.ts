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

/**
 * Auth mode. The load-bearing case is BACK-COMPAT: a credential saved before
 * `authMode` existed must keep authenticating exactly as it did, because the
 * alternative is a fleet of checks that silently stop sending their credential
 * and start reporting every device as 401/down.
 */
describe("http credential validation — auth mode", () => {
  it("stamps the inferred mode onto a pre-authMode bearer credential", () => {
    expect(check({ apiToken: "t0ken" }).authMode).toBe("bearer");
  });
  it("stamps the inferred mode onto a pre-authMode basic credential", () => {
    expect(check({ username: "monitor", password: "s3cret" }).authMode).toBe("basic");
  });
  it("stamps none when there was never any credential", () => {
    expect(check({}).authMode).toBe("none");
  });
  it("accepts digest with both halves", () => {
    const c = check({ authMode: "digest", username: "root", password: "pass" });
    expect(c.authMode).toBe("digest");
    expect(c.username).toBe("root");
    expect(c.password).toBe("pass");
  });
  it("rejects digest with no password — naming digest, not basic", () => {
    expect(() => check({ authMode: "digest", username: "root" }))
      .toThrow(/digest auth needs both a username and a password/);
  });
  it("rejects bearer with no token", () => {
    expect(() => check({ authMode: "bearer" })).toThrow(/bearer auth needs an API token/);
  });
  it("rejects an unknown mode", () => {
    expect(() => check({ authMode: "ntlm" })).toThrow(/auth mode must be one of/);
  });

  // The strip runs on the MERGED config, so it is the only thing that can
  // actually remove a stored secret — blanking the field in the request body
  // means "keep the stored value" to mergeConfigPreservingSecrets.
  it("strips the bearer token when the mode is digest", () => {
    const c = check({ authMode: "digest", username: "u", password: "p", apiToken: "stale" });
    expect(c.apiToken).toBeUndefined();
  });
  it("strips the username/password pair when the mode is bearer", () => {
    const c = check({ authMode: "bearer", apiToken: "t", username: "u", password: "p" });
    expect(c.username).toBeUndefined();
    expect(c.password).toBeUndefined();
  });
  it("strips every carrier when the mode is none", () => {
    const c = check({ authMode: "none", apiToken: "t", username: "u", password: "p" });
    expect(c.apiToken).toBeUndefined();
    expect(c.username).toBeUndefined();
    expect(c.password).toBeUndefined();
  });
  it("keeps the check definition intact while stripping auth", () => {
    const c = check({ authMode: "none", apiToken: "t", path: "/healthz", expectBody: "OK", port: 8443 });
    expect(c.path).toBe("/healthz");
    expect(c.expectBody).toBe("OK");
    expect(c.port).toBe(8443);
  });
});
