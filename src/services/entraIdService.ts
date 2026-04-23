/**
 * src/services/entraIdService.ts — Microsoft Entra ID (Azure AD) device discovery
 *
 * Authenticates via OAuth2 client credentials and queries Microsoft Graph:
 *   • /v1.0/devices — every Entra-registered device (hostname, OS, trust type)
 *   • /v1.0/deviceManagement/managedDevices — Intune enrolled devices (serial,
 *     MAC, model, manufacturer, primary user, compliance) — only when
 *     config.enableIntune is true
 *
 * Results from both endpoints are merged on deviceId ↔ azureADDeviceId; Intune
 * data wins on any field present in both sources.
 */

import { AppError } from "../utils/errors.js";

export interface EntraIdConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  enableIntune?: boolean;
  deviceInclude?: string[];  // Match against displayName; wildcards supported
  deviceExclude?: string[];
}

export interface DiscoveredEntraDevice {
  deviceId: string;            // Azure AD deviceId — stable identifier across both endpoints
  displayName: string;         // Hostname in Entra; deviceName in Intune
  operatingSystem: string;
  operatingSystemVersion: string;
  trustType: string;           // "AzureAd" | "Workplace" | "ServerAd" | ""
  registrationDateTime?: string;
  approximateLastSignInDateTime?: string;
  isCompliant?: boolean;
  isManaged?: boolean;
  // Intune-only fields (present only when enableIntune and a matching managed device was found)
  serialNumber?: string;
  macAddress?: string;
  manufacturer?: string;
  model?: string;
  userPrincipalName?: string;
  chassisType?: string;        // "desktop" | "laptop" | "tablet" | "phone" | ...
  complianceState?: string;    // "compliant" | "noncompliant" | "unknown" | ...
  lastSyncDateTime?: string;
  ipAddress?: string;
}

export interface EntraDiscoveryResult {
  devices: DiscoveredEntraDevice[];
}

export type EntraDiscoveryProgressCallback = (
  step: string,
  level: "info" | "error",
  message: string,
) => void;

// ─── Access token cache ─────────────────────────────────────────────────────
// Keyed by tenantId:clientId — value includes token and expiry timestamp.
// Tokens are refreshed 60s before expiry to avoid mid-request expiration.

interface CachedToken {
  token: string;
  expiresAt: number; // Unix ms
}
const tokenCache = new Map<string, CachedToken>();

function cacheKey(config: EntraIdConfig): string {
  return `${config.tenantId}:${config.clientId}`;
}

async function getAccessToken(config: EntraIdConfig, signal?: AbortSignal): Promise<string> {
  const key = cacheKey(config);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const url = `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.error_description) msg = String(parsed.error_description).split(/\r?\n/)[0];
        else if (parsed.error) msg = String(parsed.error);
      } catch { /* ignore */ }
      throw new AppError(502, `Entra ID token request failed: ${msg}`);
    }

    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) {
      throw new AppError(502, "Entra ID token response missing access_token");
    }
    const expiresInMs = (parsed.expires_in ?? 3600) * 1000;
    tokenCache.set(key, { token: parsed.access_token, expiresAt: Date.now() + expiresInMs });
    return parsed.access_token;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Invalidate the cached token for this config (e.g. after a 401). */
function invalidateToken(config: EntraIdConfig): void {
  tokenCache.delete(cacheKey(config));
}

// ─── Graph GET with paging ──────────────────────────────────────────────────

async function graphGet(
  config: EntraIdConfig,
  url: string,
  signal?: AbortSignal,
  retryOn401 = true,
): Promise<any> {
  const token = await getAccessToken(config, signal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "ConsistencyLevel": "eventual",
      },
      signal: controller.signal,
    });

    if (res.status === 401 && retryOn401) {
      invalidateToken(config);
      return graphGet(config, url, signal, false);
    }
    if (res.status === 403) {
      const text = await res.text();
      throw new AppError(502, `Graph API permission denied (403): ${extractGraphError(text)}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new AppError(502, `Graph API HTTP ${res.status}: ${extractGraphError(text)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

function extractGraphError(body: string): string {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message || body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

// Page through a Graph collection, concatenating `value` arrays until
// nextLink is absent or hardCap items have been collected.
async function graphPage(
  config: EntraIdConfig,
  initialUrl: string,
  hardCap: number,
  signal?: AbortSignal,
): Promise<any[]> {
  const results: any[] = [];
  let url: string | undefined = initialUrl;
  while (url) {
    if (signal?.aborted) break;
    const page = await graphGet(config, url, signal);
    if (Array.isArray(page.value)) results.push(...page.value);
    if (results.length >= hardCap) break;
    url = page["@odata.nextLink"];
  }
  return results.slice(0, hardCap);
}

// ─── Connection test ────────────────────────────────────────────────────────

export async function testConnection(config: EntraIdConfig): Promise<{
  ok: boolean;
  message: string;
}> {
  if (!config.tenantId) return { ok: false, message: "Tenant ID is required" };
  if (!config.clientId) return { ok: false, message: "Client ID is required" };
  if (!config.clientSecret) return { ok: false, message: "Client secret is required" };

  try {
    // Invalidate any cached token so the test always exercises the fresh secret
    invalidateToken(config);
    const org = await graphGet(config, "https://graph.microsoft.com/v1.0/organization?$select=displayName,verifiedDomains");
    const name = org?.value?.[0]?.displayName;

    // Also verify device read scope by fetching a single device
    await graphGet(config, "https://graph.microsoft.com/v1.0/devices?$top=1&$select=id");

    if (config.enableIntune) {
      try {
        await graphGet(config, "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$top=1&$select=id");
      } catch (err: any) {
        return {
          ok: false,
          message: `Entra device scope OK, but Intune query failed — ${err.message || "check DeviceManagementManagedDevices.Read.All permission"}`,
        };
      }
    }

    return { ok: true, message: name ? `Connected — tenant "${name}"` : "Connected successfully" };
  } catch (err: any) {
    if (err instanceof AppError) {
      return { ok: false, message: err.message };
    }
    if (err.cause?.code === "ENOTFOUND") {
      return { ok: false, message: "Host not found — check network connectivity" };
    }
    if (err.cause?.code === "ETIMEDOUT" || err.name === "TimeoutError" || err.name === "AbortError") {
      return { ok: false, message: "Connection timed out contacting Microsoft Graph" };
    }
    return { ok: false, message: err.message || "Unknown error" };
  }
}

// ─── Device discovery ───────────────────────────────────────────────────────

const DEVICES_HARD_CAP = 10_000;

export async function discoverDevices(
  config: EntraIdConfig,
  signal?: AbortSignal,
  onProgress?: EntraDiscoveryProgressCallback,
): Promise<EntraDiscoveryResult> {
  const log = onProgress || (() => {});

  // 1. Entra ID core devices
  const entraUrl = "https://graph.microsoft.com/v1.0/devices?$top=999&$select=" + [
    "id",
    "deviceId",
    "displayName",
    "operatingSystem",
    "operatingSystemVersion",
    "trustType",
    "registrationDateTime",
    "approximateLastSignInDateTime",
    "isCompliant",
    "isManaged",
  ].join(",");

  let entraDevices: any[] = [];
  try {
    entraDevices = await graphPage(config, entraUrl, DEVICES_HARD_CAP, signal);
    log("discover.entra.devices", "info", `Entra ID: retrieved ${entraDevices.length} device(s)`);
  } catch (err: any) {
    log("discover.entra.devices", "error", `Entra ID: failed to list devices — ${err.message || "Unknown error"}`);
    throw err;
  }

  // 2. Intune managed devices (optional overlay)
  const intuneByDeviceId = new Map<string, any>();
  if (config.enableIntune && !signal?.aborted) {
    const intuneUrl = "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$top=999&$select=" + [
      "id",
      "azureADDeviceId",
      "deviceName",
      "operatingSystem",
      "osVersion",
      "serialNumber",
      "wiFiMacAddress",
      "ethernetMacAddress",
      "manufacturer",
      "model",
      "userPrincipalName",
      "chassisType",
      "complianceState",
      "lastSyncDateTime",
    ].join(",");

    try {
      const intuneDevices = await graphPage(config, intuneUrl, DEVICES_HARD_CAP, signal);
      for (const d of intuneDevices) {
        const key = String(d.azureADDeviceId || "").toLowerCase();
        if (key) intuneByDeviceId.set(key, d);
      }
      log("discover.intune.devices", "info", `Intune: retrieved ${intuneDevices.length} managed device(s)`);
    } catch (err: any) {
      log("discover.intune.devices", "error", `Intune: failed to list managed devices — ${err.message || "Unknown error"}`);
      // Continue with Entra-only results rather than failing the whole run
    }
  }

  // 3. Merge — Intune wins on fields present in both
  const merged: DiscoveredEntraDevice[] = [];
  const seenDeviceIds = new Set<string>();

  for (const e of entraDevices) {
    const deviceId = String(e.deviceId || "").toLowerCase();
    if (!deviceId) continue;
    seenDeviceIds.add(deviceId);

    const intune = intuneByDeviceId.get(deviceId);
    merged.push({
      deviceId,
      displayName: (intune?.deviceName || e.displayName || "") as string,
      operatingSystem: (intune?.operatingSystem || e.operatingSystem || "") as string,
      operatingSystemVersion: (intune?.osVersion || e.operatingSystemVersion || "") as string,
      trustType: String(e.trustType || ""),
      registrationDateTime: e.registrationDateTime || undefined,
      approximateLastSignInDateTime: e.approximateLastSignInDateTime || undefined,
      isCompliant: typeof e.isCompliant === "boolean" ? e.isCompliant : undefined,
      isManaged: typeof e.isManaged === "boolean" ? e.isManaged : undefined,
      serialNumber: intune?.serialNumber || undefined,
      macAddress: pickMac(intune) || undefined,
      manufacturer: intune?.manufacturer || undefined,
      model: intune?.model || undefined,
      userPrincipalName: intune?.userPrincipalName || undefined,
      chassisType: intune?.chassisType || undefined,
      complianceState: intune?.complianceState || undefined,
      lastSyncDateTime: intune?.lastSyncDateTime || undefined,
    });
  }

  // Intune-only devices (not yet registered in Entra — rare but possible)
  for (const [deviceId, intune] of intuneByDeviceId) {
    if (seenDeviceIds.has(deviceId)) continue;
    merged.push({
      deviceId,
      displayName: String(intune.deviceName || ""),
      operatingSystem: String(intune.operatingSystem || ""),
      operatingSystemVersion: String(intune.osVersion || ""),
      trustType: "",
      serialNumber: intune.serialNumber || undefined,
      macAddress: pickMac(intune) || undefined,
      manufacturer: intune.manufacturer || undefined,
      model: intune.model || undefined,
      userPrincipalName: intune.userPrincipalName || undefined,
      chassisType: intune.chassisType || undefined,
      complianceState: intune.complianceState || undefined,
      lastSyncDateTime: intune.lastSyncDateTime || undefined,
    });
  }

  // 4. Apply device include/exclude filter (match displayName)
  const filtered = filterDevices(merged, config.deviceInclude, config.deviceExclude);
  const dropped = merged.length - filtered.length;
  if (dropped > 0) {
    log("discover.filter", "info", `Device filter: ${filtered.length} included, ${dropped} excluded`);
  } else {
    log("discover.filter", "info", `Merged total: ${filtered.length} device(s)`);
  }

  return { devices: filtered };
}

function pickMac(intune: any): string {
  if (!intune) return "";
  const mac = intune.wiFiMacAddress || intune.ethernetMacAddress || "";
  if (!mac) return "";
  // Intune returns MACs without separators, e.g. "A0B1C2D3E4F5" — normalize to colon form
  const compact = String(mac).replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
  if (compact.length !== 12) return String(mac).toUpperCase();
  return compact.match(/.{2}/g)!.join(":");
}

function matchesWildcard(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return v.includes(p.slice(1, -1));
  if (p.startsWith("*")) return v.endsWith(p.slice(1));
  if (p.endsWith("*")) return v.startsWith(p.slice(0, -1));
  return v === p;
}

function filterDevices(
  devices: DiscoveredEntraDevice[],
  include?: string[],
  exclude?: string[],
): DiscoveredEntraDevice[] {
  if (include && include.length > 0) {
    return devices.filter((d) => include.some((p) => matchesWildcard(p, d.displayName)));
  }
  if (exclude && exclude.length > 0) {
    return devices.filter((d) => !exclude.some((p) => matchesWildcard(p, d.displayName)));
  }
  return devices;
}
