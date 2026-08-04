/**
 * tests/unit/secretMask.test.ts — shared secret-mask sentinel + detector
 */

import { describe, it, expect } from "vitest";
import { SECRET_MASK, LEGACY_ASTERISK_MASK, isMaskedSecret } from "../../src/utils/secretMask.js";

describe("SECRET_MASK", () => {
  it("is a run of bullets (the glyph every surface emits)", () => {
    expect(SECRET_MASK).toBe("••••••••");
    expect(isMaskedSecret(SECRET_MASK)).toBe(true);
  });
});

describe("isMaskedSecret", () => {
  it("matches bullet runs of any length ≥ 1", () => {
    expect(isMaskedSecret("•")).toBe(true);
    expect(isMaskedSecret("••••")).toBe(true);
    expect(isMaskedSecret("••••••••••••")).toBe(true);
  });

  it("does NOT match asterisk runs (a real all-asterisk password must stay settable)", () => {
    expect(isMaskedSecret(LEGACY_ASTERISK_MASK)).toBe(false);
    expect(isMaskedSecret("****")).toBe(false);
  });

  it("does NOT match empty, mixed, or non-string input", () => {
    expect(isMaskedSecret("")).toBe(false);
    expect(isMaskedSecret("•secret•")).toBe(false);
    expect(isMaskedSecret("hunter2")).toBe(false);
    expect(isMaskedSecret(null)).toBe(false);
    expect(isMaskedSecret(undefined)).toBe(false);
    expect(isMaskedSecret(12345)).toBe(false);
  });
});
