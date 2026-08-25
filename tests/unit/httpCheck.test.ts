/**
 * tests/unit/httpCheck.test.ts
 *
 * The pure decision core behind the "http" polling method (an operator-defined
 * HTTP GET health check). What's locked down here is mostly about DEFAULTS and
 * about which of two plausible readings each ambiguous input gets, because in
 * every case the wrong reading is silent: a probe that reports a broken device
 * as healthy, or a cleared override that quietly repoints a device at "/".
 */

import { describe, it, expect } from "vitest";
import {
  MAX_BODY_BYTES,
  MAX_EXCERPT_CHARS,
  bodyExcerpt,
  describeHttpTarget,
  normalizeHttpPath,
  defaultHttpPort,
  resolveHttpTarget,
  statusAccepted,
  bodyMatches,
  evaluateHttpCheck,
} from "../../src/utils/httpCheck.js";

describe("normalizeHttpPath", () => {
  it("defaults to / for absent, empty, and whitespace-only input", () => {
    expect(normalizeHttpPath(undefined)).toBe("/");
    expect(normalizeHttpPath(null)).toBe("/");
    expect(normalizeHttpPath("")).toBe("/");
    expect(normalizeHttpPath("   ")).toBe("/");
  });
  it("forces a leading slash", () => {
    expect(normalizeHttpPath("healthz")).toBe("/healthz");
    expect(normalizeHttpPath("/healthz")).toBe("/healthz");
  });
  it("trims surrounding whitespace and newlines — a pasted path carries them", () => {
    expect(normalizeHttpPath("  /healthz\n")).toBe("/healthz");
  });
  it("keeps a query string — a health endpoint legitimately takes one", () => {
    expect(normalizeHttpPath("/status?verbose=1")).toBe("/status?verbose=1");
  });
});

describe("defaultHttpPort", () => {
  it("is 443 for https and 80 otherwise", () => {
    expect(defaultHttpPort(true)).toBe(443);
    expect(defaultHttpPort(false)).toBe(80);
    expect(defaultHttpPort(undefined)).toBe(80);
  });
});

describe("resolveHttpTarget", () => {
  it("fills scheme, port and path from the credential alone", () => {
    expect(resolveHttpTarget({ useHttps: true, path: "healthz" })).toEqual({
      useHttps: true, port: 443, path: "/healthz",
    });
  });
  it("an explicit port beats the scheme default", () => {
    expect(resolveHttpTarget({ useHttps: true, port: 8443 }).port).toBe(8443);
  });
  it("a non-positive or non-integer port falls back to the scheme default rather than dialing 0", () => {
    expect(resolveHttpTarget({ port: 0 } as never).port).toBe(80);
    expect(resolveHttpTarget({ port: -1 } as never).port).toBe(80);
    expect(resolveHttpTarget({ port: 1.5 } as never).port).toBe(80);
  });
  it("a per-asset path override wins over the credential's path", () => {
    expect(resolveHttpTarget({ path: "/healthz" }, "/api/ping").path).toBe("/api/ping");
  });
  it("a BLANK override means no override — it must not repoint the device at /", () => {
    // This is the whole reason httpCheckPath is nullable with no default:
    // clearing the asset field returns the device to the credential's path.
    expect(resolveHttpTarget({ path: "/healthz" }, "").path).toBe("/healthz");
    expect(resolveHttpTarget({ path: "/healthz" }, "   ").path).toBe("/healthz");
    expect(resolveHttpTarget({ path: "/healthz" }, null).path).toBe("/healthz");
    expect(resolveHttpTarget({ path: "/healthz" }, undefined).path).toBe("/healthz");
  });
  it("an override is normalized like any other path", () => {
    expect(resolveHttpTarget({ path: "/healthz" }, "api/ping").path).toBe("/api/ping");
  });
});

describe("statusAccepted", () => {
  it("absent expectation accepts any 2xx and nothing else", () => {
    [200, 201, 204, 299].forEach((c) => expect(statusAccepted(c, undefined), String(c)).toBe(true));
    [199, 300, 302, 401, 404, 500].forEach((c) => expect(statusAccepted(c, undefined), String(c)).toBe(false));
    expect(statusAccepted(200, null)).toBe(true);
  });
  it("an explicit expectation is exact — including for a 2xx that isn't the one asked for", () => {
    expect(statusAccepted(204, 204)).toBe(true);
    expect(statusAccepted(200, 204)).toBe(false);
    expect(statusAccepted(302, 302)).toBe(true);
  });
});

describe("bodyMatches", () => {
  it("returns null when there is no expectation, distinguishing it from a miss", () => {
    expect(bodyMatches("anything", {})).toBe(null);
    expect(bodyMatches("anything", { expectBody: "" })).toBe(null);
  });
  it("contains is the default mode and folds case by default", () => {
    expect(bodyMatches("Status: OK", { expectBody: "ok" })).toBe(true);
    expect(bodyMatches("Status: OK", { expectBody: "ok", caseSensitive: true })).toBe(false);
    expect(bodyMatches("Status: DEGRADED", { expectBody: "ok" })).toBe(false);
  });
  it("regex mode compiles the pattern, case-insensitively unless asked otherwise", () => {
    expect(bodyMatches('{"state":"healthy"}', { expectBody: '"state"\\s*:\\s*"healthy"', matchMode: "regex" })).toBe(true);
    expect(bodyMatches("HEALTHY", { expectBody: "healthy", matchMode: "regex" })).toBe(true);
    expect(bodyMatches("HEALTHY", { expectBody: "healthy", matchMode: "regex", caseSensitive: true })).toBe(false);
  });
  it("throws on an invalid regex rather than reporting a miss", () => {
    // A miss would read as "the device is unhealthy"; the throw becomes an
    // error naming the pattern, which is what the operator can act on.
    expect(() => bodyMatches("x", { expectBody: "([unclosed", matchMode: "regex" })).toThrow();
  });
  it("treats the pattern as a regex ONLY in regex mode — a dot is literal in contains mode", () => {
    expect(bodyMatches("axc", { expectBody: "a.c" })).toBe(false);
    expect(bodyMatches("axc", { expectBody: "a.c", matchMode: "regex" })).toBe(true);
  });
});

describe("evaluateHttpCheck", () => {
  it("status alone decides when no content is expected", () => {
    expect(evaluateHttpCheck({ statusCode: 200, body: "", config: {} }))
      .toEqual({ ok: true, matched: null });
  });

  it("a bad status is blamed on the status, not the body", () => {
    // A 401 with an expectBody set must not report "expected text not found" —
    // that sends the operator to the wrong field.
    const r = evaluateHttpCheck({ statusCode: 401, body: "Unauthorized", config: { expectBody: "OK" } });
    expect(r.ok).toBe(false);
    expect(r.matched).toBe(null);
    expect(r.error).toContain("HTTP 401");
    expect(r.error).toContain("expected any 2xx");
  });

  it("names the specific status when one was configured", () => {
    const r = evaluateHttpCheck({ statusCode: 200, body: "", config: { expectStatus: 204 } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("expected 204");
  });

  it("a 200 whose body doesn't match is DOWN by default — the point of the feature", () => {
    const r = evaluateHttpCheck({ statusCode: 200, body: "<h1>502 Bad Gateway</h1>", config: { expectBody: "OK" } });
    expect(r.ok).toBe(false);
    expect(r.matched).toBe(false);
    expect(r.error).toContain("Expected text not found");
  });

  // There used to be a `failOnMismatch` escape hatch that let a mismatch pass.
  // It is gone: the check is a widget that records an outcome and an automation
  // decides what "down" means, so a mismatch recorded as a PASS would make
  // `expectBody` decorative — nothing downstream could tell the two apart. A
  // laxer rule is expressed by leaving `expectBody` empty instead.
  it("a mismatch always fails, and a leftover failOnMismatch cannot re-open it", () => {
    const legacy = evaluateHttpCheck({
      statusCode: 200, body: "nope",
      config: { expectBody: "OK", failOnMismatch: false } as any,
    });
    expect(legacy.ok).toBe(false);
    expect(legacy.matched).toBe(false);
    expect(legacy.error).toContain("Expected text not found");
  });

  it("a match on an accepted status is a plain success", () => {
    expect(evaluateHttpCheck({ statusCode: 200, body: "Status: OK", config: { expectBody: "OK" } }))
      .toEqual({ ok: true, matched: true });
  });

  it("says so when the body was truncated, so a match past the cap is diagnosable", () => {
    const r = evaluateHttpCheck({ statusCode: 200, body: "x", config: { expectBody: "OK" }, truncated: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`first ${Math.floor(MAX_BODY_BYTES / 1024)} KB`);
  });

  it("an invalid stored regex fails the probe with a pattern error, not a content error", () => {
    const r = evaluateHttpCheck({ statusCode: 200, body: "x", config: { expectBody: "([bad", matchMode: "regex" } });
    expect(r.ok).toBe(false);
    expect(r.matched).toBe(null);
    expect(r.error).toContain("Invalid regex pattern");
  });

  it("reports 'pattern' vs 'text' so the message matches the mode the operator chose", () => {
    const text = evaluateHttpCheck({ statusCode: 200, body: "no", config: { expectBody: "OK" } });
    const rx = evaluateHttpCheck({ statusCode: 200, body: "no", config: { expectBody: "OK", matchMode: "regex" } });
    expect(text.error).toContain("Expected text not found");
    expect(rx.error).toContain("Expected pattern not found");
  });
});

describe("bodyExcerpt — what the Test Connection flow shows back", () => {
  it("passes a short body through untouched and unflagged", () => {
    expect(bodyExcerpt("Status: OK")).toEqual({ text: "Status: OK", truncated: false });
  });
  it("caps a long body and flags it, so the UI can say 'first N characters'", () => {
    const r = bodyExcerpt("z".repeat(MAX_EXCERPT_CHARS + 500));
    expect(r.text.length).toBe(MAX_EXCERPT_CHARS);
    expect(r.truncated).toBe(true);
  });
  it("is a much tighter cap than the READ cap — 64 KB of minified HTML is not readable in a modal", () => {
    expect(MAX_EXCERPT_CHARS).toBeLessThan(MAX_BODY_BYTES);
  });
  it("an empty body is not a truncation", () => {
    expect(bodyExcerpt("")).toEqual({ text: "", truncated: false });
  });
});

describe("describeHttpTarget — the request line the operator reads", () => {
  it("omits a default port, so nothing invites the reader to wonder why it's there", () => {
    expect(describeHttpTarget("10.0.0.5", { useHttps: true, port: 443, path: "/healthz" }))
      .toBe("https://10.0.0.5/healthz");
    expect(describeHttpTarget("10.0.0.5", { useHttps: false, port: 80, path: "/" }))
      .toBe("http://10.0.0.5/");
  });
  it("prints a non-default port", () => {
    expect(describeHttpTarget("10.0.0.5", { useHttps: true, port: 8443, path: "/x" }))
      .toBe("https://10.0.0.5:8443/x");
  });
  it("describes the RESOLVED target, so a path override shows up in what the operator reads", () => {
    const target = resolveHttpTarget({ useHttps: true, path: "/healthz" }, "/api/ping");
    expect(describeHttpTarget("host.example", target)).toBe("https://host.example/api/ping");
  });
});
