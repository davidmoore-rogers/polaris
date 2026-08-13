/**
 * src/services/brandingService.ts — operator-customizable app identity.
 *
 * Owns the `branding` Setting row: app name, subtitle, and logo URL. Extracted
 * from src/api/routes/serverSettings.ts so non-route consumers can read it
 * without importing a route module (appIconService renders the PWA icon set
 * from the logo; the pwa route builds the web manifest from all three).
 *
 * Writers still live in the serverSettings routes (PUT /branding,
 * POST|DELETE /branding/logo) — they re-export this module's helpers so the
 * route surface is unchanged.
 */

import { prisma } from "../db.js";
import { getAppVersion } from "../utils/version.js";

/**
 * Display unit for hardware-sensor temperatures. **Presentation only** — samples
 * are always collected, stored, rolled up, and compared by the automation engine
 * in Celsius (`SENSOR_CLASS_UNITS.temperature`), so flipping this can never move
 * an alert threshold or fork a sensor's history. The frontends convert at render
 * (`public/js/temp-unit.js`).
 *
 * It rides the branding Setting because branding is the one presentation channel
 * every surface already has: `GET /server-settings/branding` is unauthenticated,
 * app.js caches it in localStorage (so the sync string-building renderers can
 * read it without an await), and the Dash wallboard — which has no user identity
 * at all, so a per-user preference could never reach it — serves the same route.
 */
export type TemperatureUnit = "c" | "f";

export interface BrandingSettings {
  /**
   * May be EMPTY. An operator whose uploaded logo already carries their
   * wordmark wants no text beside it, and blanking this field is how they say
   * so — so unlike pre-2026-08 behavior an empty value is preserved rather
   * than snapped back to "Polaris". Every consumer that must print a name
   * (page titles, the PWA manifest, the acknowledge page) goes through
   * `displayAppName`.
   */
  appName: string;
  subtitle: string;
  logoUrl: string;
  /**
   * Overlay the Polaris symbol on the bottom-right corner of the operator's
   * logo. Composited server-side (brandLogoService) so one rendering feeds
   * every surface — login, sidebar, mobile. Ignored without a custom logo.
   */
  logoAccent: boolean;
  /** Show the custom logo on the login page (else the Polaris wordmark art). */
  logoOnLogin: boolean;
  /** Show the custom logo in the sidebar after login (else the Polaris art). */
  logoOnSidebar: boolean;
  temperatureUnit: TemperatureUnit;
}

export const BRANDING_DEFAULTS: BrandingSettings = {
  appName: "Polaris",
  subtitle: "Network Management Tool",
  logoUrl: "/logo.png",
  logoAccent: false,
  // An operator who bothered to upload a logo wants it in both places; the
  // checkboxes exist to take it back out of one of them.
  logoOnLogin: true,
  logoOnSidebar: true,
  temperatureUnit: "c",
};

/** Narrow an operator-supplied value to a unit code; anything else = Celsius. */
export function normalizeTemperatureUnit(value: unknown): TemperatureUnit {
  return String(value ?? "").trim().toLowerCase() === "f" ? "f" : "c";
}

/**
 * Read a stored/posted boolean flag, defaulting when it isn't present. Only
 * `undefined`/`null` mean "not stored" — a stored `false` must survive, which
 * a plain `value || fallback` would silently flip back on.
 */
export function normalizeBrandingFlag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value !== "false" && value !== "0" && value !== "";
  return Boolean(value);
}

/**
 * Is this install running an operator-supplied logo rather than the shipped
 * default? The placement + accent flags only bite when it is — with no custom
 * logo every surface shows the Polaris brand art regardless.
 */
export function hasCustomLogo(logoUrl: string): boolean {
  return Boolean(logoUrl) && logoUrl !== BRANDING_DEFAULTS.logoUrl;
}

/** A non-empty name, for the surfaces that must print one. */
export function displayAppName(branding: { appName?: string | null }): string {
  return (branding.appName || "").trim() || BRANDING_DEFAULTS.appName;
}

const APP_VERSION: string = getAppVersion();

export async function getBranding(): Promise<BrandingSettings & { version: string; customLogo: boolean }> {
  const row = await prisma.setting.findUnique({ where: { key: "branding" } });
  const saved = row ? (row.value as Record<string, unknown>) : {};
  const logoUrl = (saved.logoUrl as string) || BRANDING_DEFAULTS.logoUrl;
  return {
    // `!== undefined`, not `||`: an operator can deliberately blank the name.
    appName:  saved.appName  !== undefined ? (saved.appName as string)  : BRANDING_DEFAULTS.appName,
    subtitle: saved.subtitle !== undefined ? (saved.subtitle as string) : BRANDING_DEFAULTS.subtitle,
    logoUrl,
    logoAccent:    normalizeBrandingFlag(saved.logoAccent,    BRANDING_DEFAULTS.logoAccent),
    logoOnLogin:   normalizeBrandingFlag(saved.logoOnLogin,   BRANDING_DEFAULTS.logoOnLogin),
    logoOnSidebar: normalizeBrandingFlag(saved.logoOnSidebar, BRANDING_DEFAULTS.logoOnSidebar),
    temperatureUnit: normalizeTemperatureUnit(saved.temperatureUnit),
    // Derived, so the frontends never hardcode the default logo's path to
    // work out whether a custom one is in play.
    customLogo: hasCustomLogo(logoUrl),
    version:  APP_VERSION,
  };
}
