/**
 * tests/unit/appMapDiscoveryService.test.ts
 *
 * Pure-logic coverage for the Application Map's Discovery MAP RULES:
 * normalizeRule / normalizeConfig (validation, dedup, pattern compilation, and
 * the fold-forward of the pre-rules single-selection shape) and resolveBlockPins
 * (which reported names a block selects).
 *
 * The DB-bound half (aggregates / previews / apply / unmapEverywhere) isn't
 * exercised here — prisma is stubbed only so importing the module doesn't open a
 * connection.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
    asset: { findMany: vi.fn(), update: vi.fn() },
    assetProcess: { findMany: vi.fn() },
    assetService: { findMany: vi.fn() },
    assetProcessConnection: { deleteMany: vi.fn() },
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}));

import {
  normalizeRule,
  normalizeConfig,
  resolveBlockPins,
  emptyConfig,
  isRuleEmpty,
} from "../../src/services/appMapDiscoveryService.js";

const block = (over: Record<string, unknown> = {}) =>
  ({ names: [], patterns: [], regex: false, ...over } as any);

const RULE = (over: Record<string, unknown> = {}) => ({ name: "R", ...over });
const SCOPE = { version: 1, match: "all", rules: [{ field: "assetType", op: "exact", values: ["server"] }] };

describe("normalizeRule", () => {
  it("requires a name", () => {
    expect(() => normalizeRule({ processes: { names: ["nginx"] } })).toThrow(/name is required/i);
    expect(() => normalizeRule(RULE({ name: "   " }))).toThrow(/name is required/i);
  });

  it("caps the name length", () => {
    expect(() => normalizeRule(RULE({ name: "x".repeat(65) }))).toThrow(/64 characters/);
  });

  it("mints an id when none is supplied and preserves one that is", () => {
    expect(normalizeRule(RULE()).id).toMatch(/[0-9a-f-]{36}/);
    expect(normalizeRule(RULE({ id: "keep-me" })).id).toBe("keep-me");
  });

  it("defaults enabled to true but honours an explicit false", () => {
    expect(normalizeRule(RULE()).enabled).toBe(true);
    expect(normalizeRule(RULE({ enabled: false })).enabled).toBe(false);
  });

  it("keeps names, trims them, and drops blanks", () => {
    const r = normalizeRule(RULE({ processes: { names: ["  nginx ", "", "   ", "java"] } }));
    expect(r.processes.names).toEqual(["nginx", "java"]);
  });

  it("dedups case-insensitively but preserves the first spelling", () => {
    // Pins are matched against inventory case-sensitively, so folding case would
    // silently stop matching the real program name.
    const r = normalizeRule(RULE({ services: { names: ["MyApp.service", "myapp.service"] } }));
    expect(r.services.names).toEqual(["MyApp.service"]);
  });

  it("rejects a non-array names field and non-string entries", () => {
    expect(() => normalizeRule(RULE({ processes: { names: "nginx" } }))).toThrow(/array of strings/);
    expect(() => normalizeRule(RULE({ processes: { names: ["nginx", 7] } }))).toThrow(/array of strings/);
  });

  it("caps each list at 64 entries (matching the assets PUT)", () => {
    const many = Array.from({ length: 65 }, (_, i) => "p" + i);
    expect(() => normalizeRule(RULE({ processes: { names: many } }))).toThrow(/64 entries/);
  });

  it("rejects an invalid regex at save time rather than on every reconcile", () => {
    expect(() => normalizeRule(RULE({
      processes: { patterns: ["([unclosed"], regex: true },
    }))).toThrow(/Invalid regex/);
  });

  it("accepts wildcard patterns when regex is false", () => {
    const r = normalizeRule(RULE({ processes: { patterns: ["nginx*"], regex: false } }));
    expect(r.processes.patterns).toEqual(["nginx*"]);
    expect(r.processes.regex).toBe(false);
  });

  it("treats an unusable scope tree as no scope, not as match-nothing", () => {
    expect(normalizeRule(RULE({ scope: { version: 1, match: "all", rules: [] } })).scope).toBeNull();
  });

  it("normalizes a usable scope tree", () => {
    const r = normalizeRule(RULE({ scope: SCOPE }));
    expect(r.scope).not.toBeNull();
    expect(r.scope!.rules.length).toBe(1);
  });
});

describe("normalizeConfig", () => {
  it("returns an empty config for null input", () => {
    expect(normalizeConfig(null)).toEqual(emptyConfig());
  });

  it("always stamps version 2", () => {
    expect(normalizeConfig({ version: 99, rules: [RULE({ processes: { names: ["x"] } })] }).version).toBe(2);
  });

  it("rejects duplicate rule names case-insensitively", () => {
    expect(() => normalizeConfig({
      rules: [RULE({ name: "Truckscale" }), RULE({ name: "truckscale" })],
    })).toThrow(/Duplicate rule name/);
  });

  it("rejects duplicate rule ids (an edit would otherwise fan out)", () => {
    expect(() => normalizeConfig({
      rules: [RULE({ name: "A", id: "same" }), RULE({ name: "B", id: "same" })],
    })).toThrow(/Duplicate rule id/);
  });

  it("caps the rule count", () => {
    const rules = Array.from({ length: 51 }, (_, i) => RULE({ name: "r" + i }));
    expect(() => normalizeConfig({ rules })).toThrow(/At most 50 rules/);
  });

  // The pre-rules shape was a single {processes, services, scope} selection. It
  // must fold forward rather than being read as "no rules", or an install that
  // configured the old modal silently loses its pins on upgrade.
  it("folds the pre-rules single selection forward into one rule", () => {
    const cfg = normalizeConfig({
      version: 1,
      processes: { names: ["nginx"] },
      services: { names: ["myapp.service"] },
      scope: SCOPE,
    });
    expect(cfg.version).toBe(2);
    expect(cfg.rules.length).toBe(1);
    expect(cfg.rules[0]!.name).toBe("Imported selection");
    expect(cfg.rules[0]!.enabled).toBe(true);
    expect(cfg.rules[0]!.processes.names).toEqual(["nginx"]);
    expect(cfg.rules[0]!.services.names).toEqual(["myapp.service"]);
    expect(cfg.rules[0]!.scope).not.toBeNull();
  });

  it("folds an EMPTY legacy selection to no rules rather than an inert one", () => {
    expect(normalizeConfig({ version: 1, processes: { names: [] }, services: { names: [] } }).rules).toEqual([]);
  });

  it("leaves an already-v2 config alone", () => {
    const cfg = normalizeConfig({ version: 2, rules: [RULE({ name: "Keep", processes: { names: ["nginx"] } })] });
    expect(cfg.rules.length).toBe(1);
    expect(cfg.rules[0]!.name).toBe("Keep");
  });
});

describe("isRuleEmpty", () => {
  it("is true when only a scope is set (a scope alone pins nothing)", () => {
    expect(isRuleEmpty(normalizeRule(RULE({ scope: SCOPE })))).toBe(true);
  });

  it("is false as soon as either side has a name or pattern", () => {
    expect(isRuleEmpty(normalizeRule(RULE({ processes: { names: ["nginx"] } })))).toBe(false);
    expect(isRuleEmpty(normalizeRule(RULE({ services: { patterns: ["*.service"] } })))).toBe(false);
  });
});

describe("resolveBlockPins", () => {
  const reported = ["nginx", "nginx-worker", "postgres", "java", "sshd"];

  it("selects nothing for an empty block", () => {
    expect(resolveBlockPins(block(), reported)).toEqual([]);
  });

  it("selects nothing when the host reports nothing", () => {
    expect(resolveBlockPins(block({ names: ["nginx"] }), [])).toEqual([]);
  });

  it("matches explicit names EXACTLY (no substring creep)", () => {
    expect(resolveBlockPins(block({ names: ["nginx"] }), reported)).toEqual(["nginx"]);
  });

  it("ignores selected names the host doesn't report", () => {
    expect(resolveBlockPins(block({ names: ["nginx", "redis"] }), reported)).toEqual(["nginx"]);
  });

  it("expands wildcard patterns", () => {
    expect(resolveBlockPins(block({ patterns: ["nginx*"] }), reported).sort())
      .toEqual(["nginx", "nginx-worker"]);
  });

  it("honours regex mode", () => {
    expect(resolveBlockPins(block({ patterns: ["^(java|sshd)$"], regex: true }), reported).sort())
      .toEqual(["java", "sshd"]);
  });

  it("unions names and patterns without duplicating an overlap", () => {
    const got = resolveBlockPins(block({ names: ["nginx", "postgres"], patterns: ["nginx*"] }), reported);
    expect(got.sort()).toEqual(["nginx", "nginx-worker", "postgres"]);
    expect(new Set(got).size).toBe(got.length);
  });
});
