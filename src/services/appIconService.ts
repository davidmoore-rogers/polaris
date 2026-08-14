/**
 * src/services/appIconService.ts — PWA home-screen icons, rendered from branding.
 *
 * The mobile SPA is installable (see src/api/routes/pwa.ts), and an installable
 * manifest needs real 192/512 PNG icons. Operators can upload their own logo at
 * any size/aspect, so we rasterize on demand rather than shipping a fixed set:
 * an SVG canvas of the target size embeds the source bitmap as a data: URI and
 * @resvg/resvg-js renders it to PNG. resvg is already a dependency.
 *
 * Rendered on demand and cached in memory rather than pre-generated onto disk:
 *   - POLARIS_ROLE=web is single-instance (deploy/polaris-web.service is not a
 *     templated unit), so one process-local cache covers the whole HTTP surface.
 *   - UPLOADS_DIR is backed-up operator state; derived artifacts don't belong there.
 *   - On-demand is ONE code path that doubles as the fallback path, instead of
 *     hooks on both branding routes plus a boot self-heal plus a fallback anyway.
 *
 * Cache key includes the logo file's mtime because the branding upload route
 * writes a FIXED filename (custom-logo.png) — logoUrl alone never changes on
 * re-upload, so mtime is the only invalidation signal and is load-bearing.
 *
 * Nothing here throws: every failure rung degrades to the shipped default logo,
 * because a branding mistake must not take down the manifest or the icons a
 * push notification renders with.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { getBranding, BRANDING_DEFAULTS, isDefaultLogoUrl } from "./brandingService.js";
import { detectImageMagic } from "../utils/imageMagic.js";
import { UPLOADS_DIR, PUBLIC_DIR } from "../utils/paths.js";
import { logger } from "../utils/logger.js";

export type IconVariant = "any" | "maskable" | "apple";

export interface IconSpec {
  /** URL basename, without the .png — the route's allowlist key. */
  name: string;
  variant: IconVariant;
  size: number;
}

/**
 * The complete allowlist. The route must reject anything not in here: an
 * operator-supplied size would let resvg allocate an arbitrarily large canvas.
 */
export const ICON_SPECS: readonly IconSpec[] = [
  { name: "app-192", variant: "any", size: 192 },
  { name: "app-512", variant: "any", size: 512 },
  { name: "app-maskable-192", variant: "maskable", size: 192 },
  { name: "app-maskable-512", variant: "maskable", size: 512 },
  { name: "app-apple-180", variant: "apple", size: 180 },
];

export function findIconSpec(name: string): IconSpec | null {
  return ICON_SPECS.find((s) => s.name === name) ?? null;
}

/** --md-surface (dark) from public/css/mobile.css — matches the manifest background_color. */
const ICON_BG = "#111418";

/**
 * Fractional inset of the artwork inside the canvas, per variant.
 *  - any:      no inset, no background. Android applies its own shape; baking
 *              one in double-frames the icon.
 *  - maskable: 20% inset = the spec's 40%-diameter safe zone. Must be opaque or
 *              the OS mask shows through.
 *  - apple:    10%. iOS composites transparency onto BLACK and applies its own
 *              rounded rect, so an opaque, slightly inset icon is the only
 *              thing that looks right.
 */
const VARIANT_STYLE: Record<IconVariant, { inset: number; opaque: boolean }> = {
  any: { inset: 0, opaque: false },
  maskable: { inset: 0.2, opaque: true },
  apple: { inset: 0.1, opaque: true },
};

// The shipped mark used when no custom logo is set. The LIGHT-INKED variant
// (`-dark` = for a dark background, per the brand naming convention) because
// every opaque icon variant paints ICON_BG behind it and iOS composites
// transparency onto black — the dark-inked file would vanish on both.
const DEFAULT_LOGO_PATH = join(PUBLIC_DIR, "img", "brand", "polaris-symbol-dark.png");

// ─── Source-file resolution ──────────────────────────────────────────────

export interface ResolvedLogo {
  path: string;
  /** false when logoUrl doesn't name a file we're willing to read. */
  ok: boolean;
}

/**
 * Map a branding logoUrl to a file on disk.
 *
 * The `branding` Setting row is the only untrusted input in this service: the
 * upload route writes a fixed filename, but nothing stops a hand-edited row
 * from carrying "/uploads/../../.env". Take the basename AND assert the
 * resolved path is still inside UPLOADS_DIR.
 */
export function resolveBrandingLogoFile(logoUrl: string): ResolvedLogo {
  // isDefaultLogoUrl, not an equality check: an install seeded before the themed
  // marks still stores the retired "/logo.png", and treating that as an upload
  // would send it down the /uploads/ branch and render ok:false forever.
  if (!logoUrl || isDefaultLogoUrl(logoUrl)) return { path: DEFAULT_LOGO_PATH, ok: true };
  if (!logoUrl.startsWith("/uploads/")) return { path: DEFAULT_LOGO_PATH, ok: false };

  const name = basename(logoUrl.slice("/uploads/".length));
  if (!name || name === "." || name === "..") return { path: DEFAULT_LOGO_PATH, ok: false };

  const candidate = resolve(join(UPLOADS_DIR, name));
  const root = resolve(UPLOADS_DIR);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return { path: DEFAULT_LOGO_PATH, ok: false };
  }
  return { path: candidate, ok: true };
}

// ─── Cache ───────────────────────────────────────────────────────────────

const iconCache = new Map<string, Buffer>();
const MAX_CACHE_ENTRIES = 16;
/** Warn once per distinct reason so a broken install doesn't spam the log. */
const warned = new Set<string>();

function warnOnce(key: string, msg: string, detail?: Record<string, unknown>): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn({ ...detail }, msg);
}

function cachePut(key: string, buf: Buffer): Buffer {
  if (iconCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = iconCache.keys().next().value;
    if (oldest !== undefined) iconCache.delete(oldest);
  }
  iconCache.set(key, buf);
  return buf;
}

/** Test seam — clears memoized icons and the warn-once set. */
export function __resetIconCacheForTests(): void {
  iconCache.clear();
  warned.clear();
}

// ─── Source loading ──────────────────────────────────────────────────────

interface LoadedSource {
  buf: Buffer;
  mime: string;
  /** Identity of the bytes, for the cache key + manifest version. */
  stamp: string;
}

async function loadSource(): Promise<LoadedSource | null> {
  const branding = await getBranding().catch(() => BRANDING_DEFAULTS);
  const resolved = resolveBrandingLogoFile(branding.logoUrl);
  if (!resolved.ok) {
    warnOnce(`unresolvable:${branding.logoUrl}`, "appIcon: branding logoUrl not usable, falling back to default logo", { logoUrl: branding.logoUrl });
  }

  const attempts = resolved.path === DEFAULT_LOGO_PATH ? [DEFAULT_LOGO_PATH] : [resolved.path, DEFAULT_LOGO_PATH];
  for (const path of attempts) {
    try {
      const [buf, st] = await Promise.all([readFile(path), stat(path)]);
      // Re-sniff: never trust the extension, and resvg cannot decode WebP in
      // an embedded <image>, so a WebP-branded install falls back by design.
      const ext = detectImageMagic(buf);
      if (ext === null || ext === ".webp") {
        warnOnce(`unsupported:${path}`, "appIcon: logo format unusable for icon rendering (PNG/JPEG required), falling back", { path, detected: ext ?? "unknown" });
        continue;
      }
      return {
        buf,
        mime: ext === ".png" ? "image/png" : "image/jpeg",
        stamp: `${path}|${st.mtimeMs}|${buf.length}`,
      };
    } catch (err) {
      warnOnce(`unreadable:${path}`, "appIcon: could not read logo file, falling back", { path, err: (err as Error)?.message });
    }
  }
  return null;
}

// ─── Rendering ───────────────────────────────────────────────────────────

function buildSvg(src: LoadedSource, variant: IconVariant, size: number): string {
  const { inset, opaque } = VARIANT_STYLE[variant];
  const pad = Math.round(size * inset);
  const inner = size - pad * 2;
  const href = `data:${src.mime};base64,${src.buf.toString("base64")}`;
  const bg = opaque ? `<rect width="${size}" height="${size}" fill="${ICON_BG}"/>` : "";
  // xMidYMid meet = contain-fit, so we never need to decode the source's own
  // dimensions to keep a non-square logo from stretching.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    bg +
    `<image href="${href}" x="${pad}" y="${pad}" width="${inner}" height="${inner}" preserveAspectRatio="xMidYMid meet"/>` +
    `</svg>`
  );
}

/**
 * Render one icon. Never throws — on total failure returns the raw default
 * logo bytes (a valid PNG, just not the requested size) and caches that so a
 * broken install doesn't re-attempt a render on every request.
 */
export async function renderAppIcon(variant: IconVariant, size: number): Promise<Buffer> {
  const src = await loadSource();
  const key = `${src?.stamp ?? "none"}|${variant}|${size}`;
  const hit = iconCache.get(key);
  if (hit) return hit;

  if (!src) return cachePut(key, await readFile(DEFAULT_LOGO_PATH).catch(() => Buffer.alloc(0)));

  try {
    // Lazy import: @resvg/resvg-js resolves a per-platform native binding, and
    // a missing one must degrade to the raw logo rather than fail module load
    // (and with it every route in this process).
    const { Resvg } = await import("@resvg/resvg-js");
    const png = new Resvg(buildSvg(src, variant, size), { fitTo: { mode: "width", value: size } }).render().asPng();
    return cachePut(key, Buffer.from(png));
  } catch (err) {
    warnOnce("resvg-failed", "appIcon: rasterization failed, serving the source logo unscaled", { err: (err as Error)?.message });
    return cachePut(key, src.buf);
  }
}

/**
 * Short stable hash of the current icon source. Used as the manifest's `?v=`
 * cache-buster and as the icon ETag, so a branding change invalidates both.
 */
export async function getIconSetVersion(): Promise<string> {
  const src = await loadSource();
  return createHash("sha256").update(src?.stamp ?? "none").digest("hex").slice(0, 8);
}
