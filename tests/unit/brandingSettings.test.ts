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
  isDefaultLogoUrl,
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

  it("still treats the RETIRED /logo.png default as non-custom", () => {
    // The upgrade trap this guards: an install seeded before the themed brand
    // marks has `logoUrl: "/logo.png"` in its branding Setting row, and that
    // file no longer ships. Judging it by the CURRENT default alone answers
    // true, every surface then treats it as an operator upload, and the sidebar
    // and login page of every pre-existing install paint a 404.
    expect(hasCustomLogo("/logo.png")).toBe(false);
  });
});

describe("isDefaultLogoUrl", () => {
  it("accepts the current default and every retired one", () => {
    expect(isDefaultLogoUrl("/img/brand/polaris-symbol-dark.png")).toBe(true);
    expect(isDefaultLogoUrl("/logo.png")).toBe(true);
  });

  it("rejects an upload, a lookalike path, and empty values", () => {
    expect(isDefaultLogoUrl("/uploads/custom-logo.png")).toBe(false);
    // Substring-ish neighbours must not pass — this is an exact-match list.
    expect(isDefaultLogoUrl("/img/brand/polaris-symbol-light.png")).toBe(false);
    expect(isDefaultLogoUrl("/logo.png.bak")).toBe(false);
    expect(isDefaultLogoUrl("")).toBe(false);
    expect(isDefaultLogoUrl(null)).toBe(false);
    expect(isDefaultLogoUrl(undefined)).toBe(false);
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
