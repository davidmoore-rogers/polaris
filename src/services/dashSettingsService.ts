/**
 * src/services/dashSettingsService.ts
 *
 * Operator-settable Dash wallboard config (Server Settings → Certificates →
 * Dash Wallboard card). Single Setting row (`dashConfig`), JSON blob,
 * in-process cache with short TTL + explicit invalidate — the same pattern
 * as proxyConfigService.
 *
 * The TTL matters more here than for proxyConfig: the dash listener runs in
 * a SEPARATE process (POLARIS_ROLE=dash) from the web process that writes
 * the row, so the cache TTL is the cross-process propagation delay for the
 * on/off toggle and the IP-scope switch. ~10s keeps the hot path at roughly
 * one DB read per 10s while letting a toggle land without a restart.
 *
 * Shape: { enabled, rfc1918Only }.
 *   - enabled defaults to FALSE: a brand-new unauthenticated surface must
 *     never silently appear on upgrade — the operator flips it on once.
 *   - rfc1918Only defaults to TRUE: private-source-only until the operator
 *     explicitly widens it.
 */

import { prisma } from "../db.js";

export const DASH_SETTING_KEY = "dashConfig";

export interface DashSettings {
  /** Master switch for the /dash wallboard surface. */
  enabled: boolean;
  /** When true (default), only RFC1918 + loopback source IPs are served. */
  rfc1918Only: boolean;
}

export function defaultDashSettings(): DashSettings {
  return { enabled: false, rfc1918Only: true };
}

const CACHE_TTL_MS = 10_000;
let cache: { value: DashSettings; fetchedAt: number } | null = null;

export function invalidateDashSettingsCache(): void {
  cache = null;
}

/** TTL-cached read — the dash listener consults this on every request. */
export async function getDashSettings(): Promise<DashSettings> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  const row = await prisma.setting.findUnique({ where: { key: DASH_SETTING_KEY } });
  const value = parseDashSettings(row?.value);
  cache = { value, fetchedAt: now };
  return value;
}

export async function saveDashSettings(input: Partial<DashSettings>): Promise<DashSettings> {
  const current = await getDashSettings();
  const merged: DashSettings = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    rfc1918Only: typeof input.rfc1918Only === "boolean" ? input.rfc1918Only : current.rfc1918Only,
  };
  await prisma.setting.upsert({
    where: { key: DASH_SETTING_KEY },
    update: { value: merged as any },
    create: { key: DASH_SETTING_KEY, value: merged as any },
  });
  invalidateDashSettingsCache();
  return merged;
}

function parseDashSettings(raw: unknown): DashSettings {
  const fallback = defaultDashSettings();
  if (raw == null || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : fallback.enabled,
    rfc1918Only: typeof r.rfc1918Only === "boolean" ? r.rfc1918Only : fallback.rfc1918Only,
  };
}
