/**
 * src/services/reservationPushService.ts — Push manual IP reservations to a
 * FortiGate device via a FortiManager integration.
 *
 * Two transports, selected by the integration's `useProxy` flag:
 *   - `useProxy=true`  → wrap the FortiOS REST call in FMG `/sys/proxy/json`
 *                        so it lands on the running config in real time
 *                        (FortiManager forwards to the FortiGate).
 *   - `useProxy=false` → resolve the device's management IP via FMG, then
 *                        call the FortiGate REST API directly.
 *
 * Both paths verify the write by reading the entry back from the FortiGate
 * before returning success. Any failure throws AppError so the caller can
 * roll back the Polaris reservation (the user requested fail-on-failure
 * semantics so a missing/unreachable FortiGate does not produce a
 * Polaris-only ghost reservation).
 */

import { Netmask } from "netmask";
import { AppError } from "../utils/errors.js";
import { fgRequest, type FortiGateConfig } from "./fortigateService.js";
import {
  fmgProxyRest,
  resolveDeviceMgmtIpViaFmg,
  type FortiManagerConfig,
} from "./fortimanagerService.js";

// ─── FortiOS DHCP CMDB shapes (subset we use) ───────────────────────────────

interface FortiOsDhcpServer {
  id: number;
  interface?: string;
  "default-gateway"?: string;
  netmask?: string;
  "ip-range"?: Array<{ "start-ip"?: string; "end-ip"?: string }>;
}

interface FortiOsReservedAddress {
  id: number;
  ip?: string;
  mac?: string;
  description?: string;
  type?: string; // FortiOS: "mac" or "option82"
}

// FortiOS sometimes returns CMDB writes wrapped as { mkey } and sometimes
// just the new id at the top level — the helper below handles both.
interface FortiOsWriteResponse {
  mkey?: number | string;
  id?: number;
}

// ─── Transport ──────────────────────────────────────────────────────────────

type Transport =
  | { kind: "direct-fortigate"; fgConfig: FortiGateConfig; vdom: string }
  | { kind: "fmg-proxy"; fmgConfig: FortiManagerConfig; deviceName: string; vdom: string };

async function buildTransport(
  fmgConfig: FortiManagerConfig,
  deviceName: string,
): Promise<Transport> {
  const vdom = "root"; // FMG-managed FortiGates default to root vdom in Polaris

  if (fmgConfig.useProxy === false) {
    if (!fmgConfig.fortigateApiToken) {
      throw new AppError(
        400,
        "Direct mode requires a FortiGate API token on the integration",
      );
    }
    if (!fmgConfig.mgmtInterface?.trim()) {
      throw new AppError(
        400,
        'Direct mode requires "Management Interface" to be set on the integration',
      );
    }
    const mgmtIp = await resolveDeviceMgmtIpViaFmg(fmgConfig, deviceName);
    if (!mgmtIp) {
      throw new AppError(
        502,
        `Could not resolve management IP for "${deviceName}" via FortiManager`,
      );
    }
    const fgConfig: FortiGateConfig = {
      host: mgmtIp,
      port: 443,
      apiUser: fmgConfig.fortigateApiUser || "",
      apiToken: fmgConfig.fortigateApiToken,
      vdom,
      verifySsl: fmgConfig.fortigateVerifySsl === true,
      mgmtInterface: fmgConfig.mgmtInterface,
    };
    return { kind: "direct-fortigate", fgConfig, vdom };
  }

  return { kind: "fmg-proxy", fmgConfig, deviceName, vdom };
}

async function callFortiOs<T>(
  t: Transport,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  if (t.kind === "direct-fortigate") {
    return fgRequest<T>(t.fgConfig, method, path, {
      query: { vdom: t.vdom },
      body,
    });
  }
  const sep = path.includes("?") ? "&" : "?";
  const resource = `${path}${sep}vdom=${encodeURIComponent(t.vdom)}`;
  return fmgProxyRest<T>(t.fmgConfig, t.deviceName, method, resource, { body });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function normalizeMac(mac: string): string {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return mac.toLowerCase();
  return hex.match(/.{2}/g)!.join(":");
}

function buildDescription(
  hostname: string | null | undefined,
  createdBy: string | null | undefined,
  fallback: string,
): string {
  // Format: "Polaris/<user>: <hostname>" — origin first so a FortiGate admin
  // looking at the device immediately sees this entry was written by Polaris,
  // followed by who pushed it and what it's for. Falls back to "Polaris: …"
  // when no authenticated user is available.
  const name = (hostname && hostname.trim()) || fallback || "(unnamed)";
  const prefix = createdBy && createdBy.trim()
    ? `Polaris/${createdBy.trim()}: `
    : `Polaris: `;
  const candidate = prefix + name;
  // FortiOS 7.x accepts up to ~255 chars for reserved-address description,
  // but 6.2 and older capped at 35. Cap at 64 to keep the field readable
  // across versions while still fitting prefix + a typical hostname.
  return candidate.length > 64 ? candidate.slice(0, 64) : candidate;
}

async function findScopeIdForCidr(
  t: Transport,
  cidr: string,
): Promise<{ scopeId: number; serverInterface?: string }> {
  const servers = await callFortiOs<FortiOsDhcpServer[]>(
    t,
    "GET",
    "/api/v2/cmdb/system.dhcp/server",
  );
  const list = Array.isArray(servers) ? servers : [];
  let block: Netmask;
  try {
    block = new Netmask(cidr);
  } catch {
    throw new AppError(400, `Invalid subnet CIDR: ${cidr}`);
  }

  for (const s of list) {
    // Primary match: default-gateway + netmask reconstruct the same network.
    const gateway = s["default-gateway"];
    const netmask = s.netmask;
    if (gateway && netmask) {
      try {
        const blk = new Netmask(`${gateway}/${netmask}`);
        if (blk.base === block.base && blk.bitmask === block.bitmask) {
          return { scopeId: s.id, serverInterface: s.interface };
        }
      } catch {
        /* fall through */
      }
    }
    // Fallback: the configured ip-range start-ip lives inside the subnet.
    const startIp = s["ip-range"]?.[0]?.["start-ip"];
    if (startIp) {
      try {
        if (block.contains(startIp)) {
          return { scopeId: s.id, serverInterface: s.interface };
        }
      } catch {
        /* fall through */
      }
    }
  }
  throw new AppError(
    409,
    `FortiGate has no DHCP scope matching subnet ${cidr}`,
  );
}

async function listReservedAddresses(
  t: Transport,
  scopeId: number,
): Promise<FortiOsReservedAddress[]> {
  const data = await callFortiOs<FortiOsReservedAddress[]>(
    t,
    "GET",
    `/api/v2/cmdb/system.dhcp/server/${scopeId}/reserved-address`,
  );
  return Array.isArray(data) ? data : [];
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface PushReservationParams {
  reservationId: string;
  subnetCidr: string;
  ip: string;
  mac: string;
  hostname?: string | null;
  // Username of the operator who created the reservation. Stamped into the
  // FortiGate description so the device-side row identifies who pushed it.
  createdBy?: string | null;
  fmgConfig: FortiManagerConfig;
  deviceName: string;
}

export interface PushReservationResult {
  scopeId: number;
  entryId: number;
  serverInterface?: string;
  description: string;
}

/**
 * Write a DHCP reserved-address entry to the FortiGate and verify it landed.
 * Throws AppError on transport, resolution, write, or verify failure so the
 * upstream reservation create can roll back its Polaris row.
 */
export async function pushReservation(
  params: PushReservationParams,
): Promise<PushReservationResult> {
  if (!params.deviceName) {
    throw new AppError(
      400,
      "Subnet has no fortigateDevice — push requires a discovered FortiGate device name",
    );
  }
  const mac = normalizeMac(params.mac);
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) {
    throw new AppError(
      400,
      `Invalid MAC address: ${params.mac} — push requires a 48-bit MAC`,
    );
  }

  const t = await buildTransport(params.fmgConfig, params.deviceName);
  const { scopeId, serverInterface } = await findScopeIdForCidr(
    t,
    params.subnetCidr,
  );

  const description = buildDescription(
    params.hostname,
    params.createdBy,
    params.ip,
  );

  // Pre-check for collision so we can fail with a clearer message than the
  // FortiOS error envelope would give us. FortiOS rejects duplicate MAC and
  // duplicate IP within a scope.
  const existing = await listReservedAddresses(t, scopeId);
  for (const r of existing) {
    if (r.ip && r.ip === params.ip) {
      throw new AppError(
        409,
        `FortiGate already has a reservation for ${params.ip} on this scope (entry id ${r.id})`,
      );
    }
    if (r.mac && normalizeMac(r.mac) === mac) {
      throw new AppError(
        409,
        `FortiGate already has a reservation for MAC ${mac} on this scope (entry id ${r.id})`,
      );
    }
  }

  // Write the entry. FortiOS auto-assigns the new id; some versions echo it
  // in the response body's `mkey` field, others omit it.
  const writeRes = await callFortiOs<FortiOsWriteResponse>(
    t,
    "POST",
    `/api/v2/cmdb/system.dhcp/server/${scopeId}/reserved-address`,
    { ip: params.ip, mac, description, type: "mac" },
  );

  let entryId: number | undefined;
  const echoedKey = writeRes?.mkey ?? writeRes?.id;
  if (typeof echoedKey === "number") entryId = echoedKey;
  else if (typeof echoedKey === "string" && /^\d+$/.test(echoedKey))
    entryId = parseInt(echoedKey, 10);

  // Verify by reading the entry back. If we have an echoed id use it; if
  // not, look up by IP + MAC. Either way, we require the entry to be there
  // before considering the push successful.
  const after = await listReservedAddresses(t, scopeId);
  let verified: FortiOsReservedAddress | undefined;
  if (entryId !== undefined) {
    verified = after.find((r) => r.id === entryId);
  }
  if (!verified) {
    verified = after.find(
      (r) => r.ip === params.ip && r.mac && normalizeMac(r.mac) === mac,
    );
    if (verified && entryId === undefined) entryId = verified.id;
  }
  if (!verified || entryId === undefined) {
    throw new AppError(
      502,
      `FortiGate accepted the create but the entry was not visible on read-back for ${params.ip} (${mac})`,
    );
  }
  if (verified.ip !== params.ip || normalizeMac(verified.mac || "") !== mac) {
    throw new AppError(
      502,
      `FortiGate verify mismatch — read back ${verified.ip ?? "?"} / ${verified.mac ?? "?"}, wrote ${params.ip} / ${mac}`,
    );
  }

  return { scopeId, entryId, serverInterface, description };
}

export interface UnpushReservationParams {
  reservationId: string;
  scopeId: number;
  entryId: number;
  fmgConfig: FortiManagerConfig;
  deviceName: string;
}

export interface UnpushReservationResult {
  removed: boolean;
  alreadyAbsent: boolean;
}

/**
 * Remove a previously-pushed reserved-address entry from the FortiGate.
 *
 * Treats "not found on device" as success-with-warning (the operator may
 * have already deleted it locally). Other failures throw AppError; callers
 * decide whether to surface this as a hard failure or as a warning toast.
 */
export async function unpushReservation(
  params: UnpushReservationParams,
): Promise<UnpushReservationResult> {
  const t = await buildTransport(params.fmgConfig, params.deviceName);

  // Confirm the entry still exists before issuing DELETE — this lets us
  // distinguish "operator deleted it on the device" (alreadyAbsent=true,
  // not an error) from "we couldn't reach the device" (transport error).
  let stillThere = false;
  try {
    const list = await listReservedAddresses(t, params.scopeId);
    stillThere = list.some((r) => r.id === params.entryId);
  } catch (err) {
    // If the read fails, fall through to the DELETE attempt and let the
    // delete failure mode produce the canonical error.
  }

  if (!stillThere) {
    return { removed: false, alreadyAbsent: true };
  }

  await callFortiOs<unknown>(
    t,
    "DELETE",
    `/api/v2/cmdb/system.dhcp/server/${params.scopeId}/reserved-address/${params.entryId}`,
  );

  return { removed: true, alreadyAbsent: false };
}
