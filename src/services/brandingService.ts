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

export interface BrandingSettings {
  appName: string;
  subtitle: string;
  logoUrl: string;
}

export const BRANDING_DEFAULTS: BrandingSettings = {
  appName: "Polaris",
  subtitle: "Network Management Tool",
  logoUrl: "/logo.png",
};

const APP_VERSION: string = getAppVersion();

export async function getBranding(): Promise<BrandingSettings & { version: string }> {
  const row = await prisma.setting.findUnique({ where: { key: "branding" } });
  const saved = row ? (row.value as Record<string, unknown>) : {};
  return {
    appName:  (saved.appName as string)  || BRANDING_DEFAULTS.appName,
    subtitle: saved.subtitle !== undefined ? (saved.subtitle as string) : BRANDING_DEFAULTS.subtitle,
    logoUrl:  (saved.logoUrl as string)  || BRANDING_DEFAULTS.logoUrl,
    version:  APP_VERSION,
  };
}
