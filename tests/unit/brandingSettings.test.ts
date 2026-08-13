/**
 * tests/unit/brandingSettings.test.ts — the pure helpers behind the branding
 * Setting row.
 *
 * The flag normalizer is the one with teeth: the placement checkboxes default
 * ON, so reading a stored `false` through a `||` would silently turn an
 * operator's "don't show my logo here" back on at every read.
 */

import { describe, it, expect } from "vitest";
import {
  BRANDING_DEFAULTS,
  displayAppName,
  hasCustomLogo,
  normalizeBrandingFlag,
  normalizeTemperatureUnit,
} from "../../src/services/brandingService.js";

describe("normalizeBrandingFlag", () => {
  it("keeps a stored false, defaults only when nothing is stored", () => {
    expect(normalizeBrandingFlag(false, true)).toBe(false);
    expect(normalizeBrandingFlag(undefined, true)).toBe(true);
    expect(normalizeBrandingFlag(null, true)).toBe(true);
    expect(normalizeBrandingFlag(undefined, false)).toBe(false);
  });

  it('reads the string forms a form post can produce ("false"/"" are off)', () => {
    expect(normalizeBrandingFlag("true", false)).toBe(true);
    expect(normalizeBrandingFlag("on", false)).toBe(true);
    expect(normalizeBrandingFlag("false", true)).toBe(false);
    expect(normalizeBrandingFlag("0", true)).toBe(false);
    expect(normalizeBrandingFlag("", true)).toBe(false);
  });
});

describe("hasCustomLogo", () => {
  it("is true only for a logo that isn't the shipped default", () => {
    expect(hasCustomLogo("/uploads/custom-logo.png")).toBe(true);
    expect(hasCustomLogo(BRANDING_DEFAULTS.logoUrl)).toBe(false);
    expect(hasCustomLogo("")).toBe(false);
  });
});

describe("displayAppName", () => {
  it("falls back for the surfaces that must print a name", () => {
    expect(displayAppName({ appName: "Acme" })).toBe("Acme");
    // Blank is a legitimate stored value — a logo can carry the wordmark — but
    // a page title or a PWA manifest still needs something to say.
    expect(displayAppName({ appName: "" })).toBe("Polaris");
    expect(displayAppName({ appName: "   " })).toBe("Polaris");
    expect(displayAppName({})).toBe("Polaris");
  });
});

describe("normalizeTemperatureUnit", () => {
  it("is unchanged by the new fields", () => {
    expect(normalizeTemperatureUnit("f")).toBe("f");
    expect(normalizeTemperatureUnit("nonsense")).toBe("c");
  });
});
