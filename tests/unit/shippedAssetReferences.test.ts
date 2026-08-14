/**
 * tests/unit/shippedAssetReferences.test.ts — every image path a shipped page
 * or a server default points at must exist on disk.
 *
 * `public/logo.png` was deleted during the brand-mark rework while 14 references
 * still pointed at it: the favicon on 16 HTML pages, the first-run wizard's
 * visible logo, the branding default `logoUrl`, and the PWA icon rasterizer's
 * source file — which reads the FILE, so a missing default silently degrades
 * every generated icon to empty bytes. None of that raises an error at build or
 * boot; the first symptom is a broken image in a browser.
 *
 * So this test walks the actual references rather than trusting a grep at review
 * time. It's static and needs no DB.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "../..");
const PUBLIC_DIR = join(ROOT, "public");

const htmlFiles = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".html"));

/** Local absolute asset paths referenced from src/href attributes. */
function localAssetRefs(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/(?:href|src)="(\/[^"]+\.(?:png|jpg|jpeg|svg|webp|ico|gif))"/g)) {
    out.add(m[1]!);
  }
  return Array.from(out);
}

describe("shipped HTML pages reference images that exist", () => {
  it("finds the pages to check (guards the scanner itself)", () => {
    // A glob that silently matched nothing would make every case below vacuous.
    expect(htmlFiles.length).toBeGreaterThan(10);
  });

  for (const file of htmlFiles) {
    const html = readFileSync(join(PUBLIC_DIR, file), "utf8");
    const refs = localAssetRefs(html);
    it(`${file} — ${refs.length} image reference(s) all resolve`, () => {
      const missing = refs.filter((r) => {
        // /uploads/* is operator content written at runtime, not shipped.
        if (r.startsWith("/uploads/")) return false;
        // /icons/* is rasterized on demand from the branding logo by
        // pwaRouter.get("/icons/:file") — no file exists on disk by design.
        // (The source file THAT route falls back to is covered separately
        // below, via BRANDING_DEFAULTS.logoUrl.)
        if (r.startsWith("/icons/")) return false;
        return !existsSync(join(PUBLIC_DIR, r.replace(/^\//, "")));
      });
      expect(missing, `${file} points at files that don't exist`).toEqual([]);
    });
  }

  it("no page still points at the retired /logo.png", () => {
    const offenders = htmlFiles.filter((f) =>
      /(?:href|src)="\/logo\.png"/.test(readFileSync(join(PUBLIC_DIR, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("every page carries a favicon", () => {
    // Dropping the link entirely is the other way to "fix" a broken favicon.
    const withoutIcon = htmlFiles.filter((f) =>
      !/rel="icon"/.test(readFileSync(join(PUBLIC_DIR, f), "utf8")));
    expect(withoutIcon).toEqual([]);
  });

  it("the themed favicon pair is keyed on prefers-color-scheme, not data-theme", () => {
    // The favicon renders in BROWSER CHROME, which follows the OS — not
    // Polaris's data-theme, which an operator sets independently. It is the one
    // themed asset that must not use the MutationObserver path.
    const index = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
    expect(index).toMatch(/rel="icon"[^>]*polaris-symbol-light\.png"/);
    expect(index).toMatch(/rel="icon"[^>]*polaris-symbol-dark\.png"[^>]*media="\(prefers-color-scheme: dark\)"/);
    // The unconditional light link must come FIRST so browsers that ignore
    // `media` on rel=icon still get a usable icon.
    expect(index.indexOf("polaris-symbol-light.png")).toBeLessThan(index.indexOf("polaris-symbol-dark.png"));
  });
});

describe("server-side default assets exist on disk", () => {
  it("the branding default logoUrl resolves to a shipped file", async () => {
    const { BRANDING_DEFAULTS } = await import("../../src/services/brandingService.js");
    const rel = BRANDING_DEFAULTS.logoUrl.replace(/^\//, "");
    expect(existsSync(join(PUBLIC_DIR, rel)), `${BRANDING_DEFAULTS.logoUrl} is missing`).toBe(true);
  });

  it("the brand marks brand-logo.js can paint all exist", () => {
    // The resolver ships one file per (variant, theme); a missing one doesn't
    // look wrong, it renders nothing.
    for (const f of [
      "polaris-horiz-dark.png", "polaris-horiz-light.png",
      "polaris-vert-dark.png", "polaris-vert-light.png",
      "polaris-symbol-dark.png", "polaris-symbol-light.png",
    ]) {
      expect(existsSync(join(PUBLIC_DIR, "img", "brand", f)), f).toBe(true);
    }
  });
});
