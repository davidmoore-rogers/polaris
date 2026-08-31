/**
 * tests/unit/integrationHealthService.test.ts
 *
 * The FortiManager proxy-transport advisory. Pure halves only — the DB half is
 * two queries and a groupBy, and what is worth pinning here is the RULE: which
 * integrations count as proxy-mode, and where the line sits.
 */

import { describe, it, expect } from "vitest";
import {
  FMG_PROXY_GATE_ADVISORY_THRESHOLD,
  integrationIsFmgProxyMode,
  selectProxyAdvice,
} from "../../src/services/integrationHealthService.js";

describe("integrationIsFmgProxyMode — proxy is the default", () => {
  // The whole codebase reads this field as `!== false` because the Zod schema
  // defaults useProxy to true and older rows predate the field entirely. An
  // absent flag is a PROXY-mode integration, and reading it as direct would
  // silence the advisory for exactly the installs that never touched the
  // setting — the ones most likely to still be on the default transport.
  it("treats an absent flag as proxy mode", () => {
    expect(integrationIsFmgProxyMode({})).toBe(true);
    expect(integrationIsFmgProxyMode(null)).toBe(true);
    expect(integrationIsFmgProxyMode(undefined)).toBe(true);
    expect(integrationIsFmgProxyMode({ useProxy: undefined })).toBe(true);
  });

  it("treats an explicit true as proxy mode", () => {
    expect(integrationIsFmgProxyMode({ useProxy: true })).toBe(true);
  });

  it("treats ONLY an explicit false as bypass", () => {
    expect(integrationIsFmgProxyMode({ useProxy: false })).toBe(false);
  });
});

describe("selectProxyAdvice — who gets advised", () => {
  const A = { id: "a", name: "PLVCORFMG1" };
  const B = { id: "b", name: "Branch FMG" };

  it("advises an integration strictly OVER the threshold", () => {
    const counts = new Map([["a", FMG_PROXY_GATE_ADVISORY_THRESHOLD + 1]]);
    expect(selectProxyAdvice([A], counts)).toEqual([
      { id: "a", name: "PLVCORFMG1", managedFortigates: FMG_PROXY_GATE_ADVISORY_THRESHOLD + 1 },
    ]);
  });

  // Strictly greater-than: a fleet sitting exactly ON the threshold is the
  // supported case, not the advised one.
  it("stays quiet AT the threshold and below", () => {
    expect(selectProxyAdvice([A], new Map([["a", FMG_PROXY_GATE_ADVISORY_THRESHOLD]]))).toEqual([]);
    expect(selectProxyAdvice([A], new Map([["a", 1]]))).toEqual([]);
  });

  // A proxy integration that has discovered nothing yet must not be advised —
  // the groupBy simply returns no row for it, and a missing row is zero gates,
  // not an unknown to be treated as large.
  it("treats a missing gate count as zero, not as over the line", () => {
    expect(selectProxyAdvice([A], new Map())).toEqual([]);
  });

  it("advises each qualifying integration independently", () => {
    const counts = new Map([["a", 50], ["b", 2]]);
    expect(selectProxyAdvice([A, B], counts)).toEqual([
      { id: "a", name: "PLVCORFMG1", managedFortigates: 50 },
    ]);
  });

  it("honours an explicit threshold override", () => {
    expect(selectProxyAdvice([A], new Map([["a", 5]]), 3)).toHaveLength(1);
    expect(selectProxyAdvice([A], new Map([["a", 5]]), 99)).toHaveLength(0);
  });
});
