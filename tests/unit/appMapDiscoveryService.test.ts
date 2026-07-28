/**
 * tests/unit/appMapDiscoveryService.test.ts
 *
 * Pure-logic coverage for the Application Map's Discovery selection:
 * normalizeSelection (validation + dedup + pattern compilation) and
 * resolveBlockPins (which reported names a block selects).
 *
 * The DB-bound half (aggregates / preview / apply / unmapEverywhere) isn't
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
  normalizeSelection,
  resolveBlockPins,
  emptySelection,
  isSelectionEmpty,
} from "../../src/services/appMapDiscoveryService.js";

const block = (over: Record<string, unknown> = {}) =>
  ({ names: [], patterns: [], regex: false, ...over } as any);

describe("normalizeSelection", () => {
  it("returns an empty selection for null / missing input", () => {
    expect(normalizeSelection(null)).toEqual(emptySelection());
    expect(isSelectionEmpty(normalizeSelection(null))).toBe(true);
  });

  it("keeps names, trims them, and drops blanks", () => {
    const s = normalizeSelection({ processes: { names: ["  nginx ", "", "   ", "java"] } });
    expect(s.processes.names).toEqual(["nginx", "java"]);
  });

  it("dedups case-insensitively but preserves the first spelling", () => {
    // Pins are matched against inventory case-sensitively, so folding case would
    // silently stop matching the real program name.
    const s = normalizeSelection({ services: { names: ["MyApp.service", "myapp.service"] } });
    expect(s.services.names).toEqual(["MyApp.service"]);
  });

  it("rejects a non-array names field", () => {
    expect(() => normalizeSelection({ processes: { names: "nginx" } })).toThrow(/array of strings/);
  });

  it("rejects non-string entries", () => {
    expect(() => normalizeSelection({ processes: { names: ["nginx", 7] } })).toThrow(/array of strings/);
  });

  it("caps each list at 64 entries (matching the assets PUT)", () => {
    const many = Array.from({ length: 65 }, (_, i) => "p" + i);
    expect(() => normalizeSelection({ processes: { names: many } })).toThrow(/64 entries/);
  });

  it("rejects an invalid regex at save time rather than on every reconcile", () => {
    expect(() => normalizeSelection({
      processes: { patterns: ["([unclosed"], regex: true },
    })).toThrow(/Invalid regex/);
  });

  it("accepts wildcard patterns when regex is false", () => {
    const s = normalizeSelection({ processes: { patterns: ["nginx*"], regex: false } });
    expect(s.processes.patterns).toEqual(["nginx*"]);
    expect(s.processes.regex).toBe(false);
  });

  it("treats an unusable scope tree as no scope, not as match-nothing", () => {
    expect(normalizeSelection({ scope: { version: 1, match: "all", rules: [] } }).scope).toBeNull();
  });

  it("normalizes a usable scope tree", () => {
    const s = normalizeSelection({
      processes: { names: ["nginx"] },
      scope: { version: 1, match: "all", rules: [{ field: "assetType", op: "exact", values: ["server"] }] },
    });
    expect(s.scope).not.toBeNull();
    expect(s.scope!.rules.length).toBe(1);
  });

  it("always stamps version 1", () => {
    expect(normalizeSelection({ version: 99, processes: { names: ["x"] } }).version).toBe(1);
  });
});

describe("isSelectionEmpty", () => {
  it("is true when only a scope is set (a scope alone pins nothing)", () => {
    const s = normalizeSelection({
      scope: { version: 1, match: "all", rules: [{ field: "assetType", op: "exact", values: ["server"] }] },
    });
    expect(isSelectionEmpty(s)).toBe(true);
  });

  it("is false as soon as either side has a name or pattern", () => {
    expect(isSelectionEmpty(normalizeSelection({ processes: { names: ["nginx"] } }))).toBe(false);
    expect(isSelectionEmpty(normalizeSelection({ services: { patterns: ["*.service"] } }))).toBe(false);
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
