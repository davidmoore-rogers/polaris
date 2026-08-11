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
  appName: string;
  subtitle: string;
  logoUrl: string;
  temperatureUnit: TemperatureUnit;
}

export const BRANDING_DEFAULTS: BrandingSettings = {
  appName: "Polaris",
  subtitle: "Network Management Tool",
  logoUrl: "/logo.png",
  temperatureUnit: "c",
};

/** Narrow an operator-supplied value to a unit code; anything else = Celsius. */
export function normalizeTemperatureUnit(value: unknown): TemperatureUnit {
  return String(value ?? "").trim().toLowerCase() === "f" ? "f" : "c";
}

const APP_VERSION: string = getAppVersion();

export async function getBranding(): Promise<BrandingSettings & { version: string }> {
  const row = await prisma.setting.findUnique({ where: { key: "branding" } });
  const saved = row ? (row.value as Record<string, unknown>) : {};
  return {
    appName:  (saved.appName as string)  || BRANDING_DEFAULTS.appName,
    subtitle: saved.subtitle !== undefined ? (saved.subtitle as string) : BRANDING_DEFAULTS.subtitle,
    logoUrl:  (saved.logoUrl as string)  || BRANDING_DEFAULTS.logoUrl,
    temperatureUnit: normalizeTemperatureUnit(saved.temperatureUnit),
    version:  APP_VERSION,
  };
}
