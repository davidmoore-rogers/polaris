/**
 * src/services/fortimanagerService.ts — FortiManager JSON RPC API client
 *
 * Authenticates via bearer token (API key) rather than session-based login.
 */

import { Netmask } from "netmask";
import { AppError } from "../utils/errors.js";
import {
  discoverDhcpSubnets as discoverViaFortigate,
  testConnection as fgTestConnection,
  type FortiGateConfig,
} from "./fortigateService.js";

export interface FortiManagerConfig {
  host: string;
  port?: number;
  apiUser: string;          // API user name (required by newer FMG versions)
  apiToken: string;         // Bearer token for authentication
  adom?: string;            // Administrative Domain (default: "root")
  verifySsl?: boolean;      // Skip TLS verification (default: false)
  mgmtInterface?: string;
  interfaceInclude?: string[];  // Interfaces to include for DHCP scope + interface IP discovery
  interfaceExclude?: string[];  // Interfaces to exclude. Ignored if interfaceInclude is non-empty.
  /** @deprecated use interfaceInclude */
  dhcpInclude?: string[];
  /** @deprecated use interfaceExclude */
  dhcpExclude?: string[];
  inventoryExcludeInterfaces?: string[];
  inventoryIncludeInterfaces?: string[];
  deviceInclude?: string[];   // FortiGate device names to include (wildcards ok). Matched against name/hostname.
  deviceExclude?: string[];   // FortiGate device names to exclude. Ignored if deviceInclude is non-empty.
  discoveryParallelism?: number; // Max concurrent FortiGates during discovery (default 5). Forced to 1 when useProxy is true.
  useProxy?: boolean;         // If true (default), all per-device queries go through FMG's /sys/proxy/json and /pm/config. If false, queries go direct to each FortiGate's management IP using fortigateApiUser + fortigateApiToken.
  fortigateApiUser?: string;  // Only used when useProxy is false — REST API admin username configured on each managed FortiGate.
  fortigateApiToken?: string; // Only used when useProxy is false — Bearer token for the REST API admin on each managed FortiGate.
  fortigateVerifySsl?: boolean; // Only used when useProxy is false — whether to verify TLS certs on direct FortiGate connections (default false).
}

interface JsonRpcRequest {
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse {
  id: number;
  result: Array<{
    status: { code: number; message: string };
    url: string;
    data?: unknown;
  }>;
}

/**
 * Test connectivity to a FortiManager using bearer token auth.
 * Calls /sys/status to verify access and retrieve version info.
 */
export async function testConnection(config: FortiManagerConfig): Promise<{
  ok: boolean;
  message: string;
  version?: string;
}> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;

  try {
    const statusPayload: JsonRpcRequest = {
      id: 1,
      method: "get",
      params: [{ url: "/sys/status" }],
    };

    const statusRes = await rpc(baseUrl, statusPayload, config.apiUser, config.apiToken, config.verifySsl);

    const code = statusRes.result?.[0]?.status?.code;
    if (code !== 0) {
      const msg = statusRes.result?.[0]?.status?.message || "Request failed";
      if (code === -11) {
        return { ok: false, message: "Invalid or expired API token" };
      }
      return { ok: false, message: msg };
    }

    const data = statusRes.result?.[0]?.data as Record<string, unknown> | undefined;
    const version = data?.Version ? String(data.Version) : undefined;

    return {
      ok: true,
      message: version ? `Connected — FortiManager ${version}` : "Connected successfully",
      version,
    };
  } catch (err: any) {
    if (err.cause?.code === "ECONNREFUSED") {
      return { ok: false, message: `Connection refused — ${config.host}:${config.port || 443}` };
    }
    if (err.cause?.code === "ENOTFOUND") {
      return { ok: false, message: `Host not found — ${config.host}` };
    }
    if (err.cause?.code === "ETIMEDOUT" || err.name === "TimeoutError") {
      return { ok: false, message: `Connection timed out — ${config.host}:${config.port || 443}` };
    }
    if (err.message === "fetch failed" && err.cause) {
      const code = err.cause?.code;
      if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "CERT_HAS_EXPIRED" || code === "ERR_TLS_CERT_ALTNAME_INVALID") {
        return { ok: false, message: `TLS certificate error (${code}) — try disabling SSL verification` };
      }
      return { ok: false, message: err.cause?.message || err.message };
    }
    return { ok: false, message: err.message || "Unknown error" };
  }
}

/**
 * Pick a random managed FortiGate from the FMG device list and run a
 * FortiGate-side connection test against it using the direct-transport
 * credentials. Exposed as a standalone call so the UI can stream its
 * result independently of the FMG connection test.
 */
export async function testRandomFortiGate(config: FortiManagerConfig): Promise<{
  ok: boolean;
  message: string;
  deviceName: string;
  version?: string;
}> {
  if (!config.fortigateApiToken) {
    return {
      ok: false,
      message: 'FortiGate API Token is required when the FortiManager proxy is disabled',
      deviceName: "(none)",
    };
  }

  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const adom = config.adom || "root";
  const devicesPayload: JsonRpcRequest = {
    id: 1,
    method: "get",
    params: [{ url: `/dvmdb/adom/${adom}/device`, fields: ["name", "hostname", "ip"] }],
  };

  let devicesRes: JsonRpcResponse;
  try {
    devicesRes = await rpc(baseUrl, devicesPayload, config.apiUser, config.apiToken, config.verifySsl);
  } catch (err: any) {
    return { ok: false, message: `Failed to fetch device list from FMG: ${err.message || "Unknown error"}`, deviceName: "(none)" };
  }

  const raw = devicesRes.result?.[0]?.data;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: `No managed devices found in ADOM "${adom}"`, deviceName: "(none)" };
  }

  // Apply the same include/exclude filters the discovery run would use, then
  // require an IP since we need to reach the FortiGate directly.
  const filtered = filterDevices(raw as any[], config.deviceInclude, config.deviceExclude)
    .filter((d: any) => typeof d.ip === "string" && d.ip.length > 0);

  if (filtered.length === 0) {
    return {
      ok: false,
      message: "No managed FortiGate with a recorded management IP is available to test against — adjust device include/exclude or make sure the gate is online in FMG",
      deviceName: "(none)",
    };
  }

  const pick = filtered[Math.floor(Math.random() * filtered.length)];
  const deviceName = String(pick.name || pick.hostname || pick.ip);

  const fgConfig: FortiGateConfig = {
    host: String(pick.ip),
    port: 443,
    apiUser: config.fortigateApiUser || "",
    apiToken: config.fortigateApiToken,
    vdom: "root",
    verifySsl: config.fortigateVerifySsl === true,
    mgmtInterface: config.mgmtInterface,
  };

  const fgResult = await fgTestConnection(fgConfig);
  return { ok: fgResult.ok, message: fgResult.message, version: fgResult.version, deviceName };
}

/**
 * Low-level JSON RPC call to FortiManager with bearer token auth.
 */
async function rpc(
  url: string,
  payload: JsonRpcRequest,
  apiUser: string,
  apiToken: string,
  verifySsl?: boolean,
  externalSignal?: AbortSignal,
): Promise<JsonRpcResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  // If an external signal fires (e.g. integration re-saved), abort this request too
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    if (verifySsl === false) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiToken}`,
    };
    if (apiUser) headers["access_user"] = apiUser;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      throw new AppError(502, "Authentication failed — check your API token");
    }

    if (!res.ok) {
      throw new AppError(502, `FortiManager returned HTTP ${res.status}`);
    }

    return (await res.json()) as JsonRpcResponse;
  } finally {
    if (verifySsl === false) {
      if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
    }
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Proxy an arbitrary JSON-RPC call to FortiManager using stored credentials.
 * Used by the manual API query tool in the UI.
 */
export async function proxyQuery(
  config: FortiManagerConfig,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  return rpc(baseUrl, { id: 1, method, params }, config.apiUser, config.apiToken, config.verifySsl);
}

// ─── DHCP Discovery ─────────────────────────────────────────────────────────

export interface DiscoveredSubnet {
  cidr: string;
  name: string;           // DHCP server interface name
  fortigateDevice: string;
  dhcpServerId: string;
  vlan?: number;          // 802.1Q VLAN ID from the interface, if present
}

export interface DiscoveredDevice {
  name: string;           // device name in FortiManager
  hostname: string;
  serial: string;
  model: string;
  mgmtIp: string;        // management IP from device list
}

export interface DiscoveredInterfaceIp {
  device: string;         // FortiGate device name
  interfaceName: string;  // interface name (e.g. "port5")
  ipAddress: string;      // IP address of the interface
  role: string;           // "interface" or "management"
}

export interface DiscoveredDhcpEntry {
  device: string;           // FortiGate device name
  interfaceName: string;    // DHCP server interface
  ipAddress: string;        // Leased or reserved IP
  macAddress: string;       // Client MAC address
  hostname: string;         // Client hostname (if available)
  type: "dhcp-reservation" | "dhcp-lease"; // Static reservation vs dynamic lease
  expireTime?: number;      // Unix timestamp from expire_time (dynamic leases only)
  accessPoint?: string;     // AP name for wireless leases
  ssid?: string;            // SSID for wireless leases
  vci?: string;             // Vendor class identifier (e.g. "FortiSwitch-108F-FPOE")
}

export interface DiscoveredInventoryDevice {
  device: string;           // FortiGate that detected this client
  macAddress: string;
  ipAddress: string;
  hostname: string;
  os: string;               // Detected OS (e.g. "Windows", "Linux", "macOS")
  osVersion: string;        // Detailed version (e.g. "Windows 11 23H2")
  hardwareVendor: string;   // NIC / device manufacturer
  interfaceName: string;    // FortiGate interface the device is on
  switchName: string;       // FortiSwitch name (if behind a managed switch)
  switchPort: string;       // FortiSwitch port (if behind a managed switch)
  apName: string;           // FortiAP name (if connected wirelessly)
  user: string;             // Logged-in / registered user (if available)
  isOnline: boolean;
  lastSeen: string;         // ISO timestamp
}

export interface DiscoveredFortiSwitch {
  device: string;       // FortiGate controller name
  name: string;         // switch-id
  serial: string;
  ipAddress: string;    // connecting_from
  fgtInterface: string; // fgt_peer_intf_name (FortiLink interface on FortiGate)
  osVersion: string;
  joinTime?: number;    // join_time (Unix timestamp — when first authorized)
  state: string;        // "Authorized" | "Unauthorized"
  connected: boolean;   // status === "Connected"
}

export interface DiscoveredFortiAP {
  device: string;      // FortiGate controller name
  name: string;
  serial: string;
  model: string;
  ipAddress: string;
  baseMac: string;
  status: string;
  osVersion: string;
}

export interface DiscoveredVip {
  device: string;      // FortiGate device name
  name: string;        // VIP object name (used as hostname on reservations)
  extip: string;       // External IP address
  mappedips: string[]; // Internal mapped IP addresses
  extintf: string;     // External interface name
}

export interface DiscoveryResult {
  subnets: DiscoveredSubnet[];
  devices: DiscoveredDevice[];
  interfaceIps: DiscoveredInterfaceIp[];
  dhcpEntries: DiscoveredDhcpEntry[];
  deviceInventory: DiscoveredInventoryDevice[];
  // FortiGates whose inventory query succeeded this run (may be empty-result).
  // Used to scope stale-device sweep: MAC stamps pointing to devices NOT in this
  // list are left alone (we didn't get a fresh answer).
  inventoryDevices: string[];
  // All FortiGates configured in FortiManager, regardless of conn_status or
  // include/exclude filter. A subnet's fortigateDevice missing from this set
  // means the device was removed from FMG — safe to deprecate. An offline but
  // still-configured device remains here, so its subnets are left alone.
  knownDeviceNames: string[];
  fortiSwitches: DiscoveredFortiSwitch[];
  fortiAps: DiscoveredFortiAP[];
  vips: DiscoveredVip[];
}

export type DiscoveryProgressCallback = (
  step: string,
  level: "info" | "error",
  message: string,
  device?: string,
) => void;

/**
 * Query FortiManager for DHCP servers across all managed FortiGate devices.
 * Returns discovered subnets, device metadata (for asset creation),
 * and interface IPs (for reservation creation).
 */
export async function discoverDhcpSubnets(
  config: FortiManagerConfig,
  signal?: AbortSignal,
  onProgress?: DiscoveryProgressCallback,
  inventoryMaxAgeHours = 24,
  onDeviceComplete?: (result: DiscoveryResult) => Promise<void>,
): Promise<DiscoveryResult> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const adom = config.adom || "root";
  const { apiUser, apiToken, verifySsl } = config;
  const log = onProgress || (() => {});

  // Step 1: List managed devices in the ADOM. We deliberately do NOT filter on
  // conn_status server-side — we need the full roster (online + offline) so the
  // stale-subnet sweep can distinguish "device offline" from "device removed."
  const devicesPayload: JsonRpcRequest = {
    id: 1,
    method: "get",
    params: [{ url: `/dvmdb/adom/${adom}/device`, fields: ["name", "hostname", "sn", "platform_str", "ip", "conn_status"] }],
  };

  let devicesRes: JsonRpcResponse;
  try {
    devicesRes = await rpc(baseUrl, devicesPayload, apiUser, apiToken, verifySsl, signal);
  } catch (err: any) {
    log("discover.devices", "error", `Failed to list managed devices: ${err.message || "Unknown error"}`);
    throw err;
  }
  const devicesDataRaw = devicesRes.result?.[0]?.data;
  if (!Array.isArray(devicesDataRaw) || devicesDataRaw.length === 0) {
    const status = devicesRes.result?.[0]?.status;
    if (status && status.code !== undefined && status.code !== 0) {
      log("discover.devices", "error", `Device list query returned status ${status.code}: ${status.message || "(no message)"} for ADOM "${adom}" — check that the ADOM name is exact and the API user has read access to /dvmdb/adom/${adom}/device`);
    } else {
      log("discover.devices", "info", `No managed devices found in ADOM "${adom}"`);
    }
    return { subnets: [], devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [], inventoryDevices: [], knownDeviceNames: [], fortiSwitches: [], fortiAps: [], vips: [] };
  }

  // Capture the full roster of configured devices (pre-filter, any conn_status).
  // Subnets whose fortigateDevice is NOT in this set were discovered from a
  // device that has since been deleted from FMG — those are the ones to deprecate.
  const knownDeviceNames: string[] = (devicesDataRaw as any[])
    .map((d) => d.name || d.hostname)
    .filter((n): n is string => typeof n === "string" && n.length > 0);

  // Apply device-level include/exclude filter (FortiGate names or hostnames).
  // Include wins over exclude when both are set.
  const devicesData = filterDevices(devicesDataRaw, config.deviceInclude, config.deviceExclude);
  const filteredOut = devicesDataRaw.length - devicesData.length;
  if (filteredOut > 0) {
    log("discover.devices", "info", `Found ${devicesDataRaw.length} managed device(s) in ADOM "${adom}" — ${devicesData.length} included, ${filteredOut} filtered by device include/exclude`);
  } else {
    log("discover.devices", "info", `Found ${devicesData.length} managed device(s) in ADOM "${adom}"`);
  }
  if (devicesData.length === 0) {
    return { subnets: [], devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [], inventoryDevices: [], knownDeviceNames, fortiSwitches: [], fortiAps: [], vips: [] };
  }

  const discovered: DiscoveredSubnet[] = [];
  const devices: DiscoveredDevice[] = [];
  const interfaceIps: DiscoveredInterfaceIp[] = [];
  const dhcpEntries: DiscoveredDhcpEntry[] = [];
  const deviceInventory: DiscoveredInventoryDevice[] = [];
  const inventoryDevices = new Set<string>();
  const fortiSwitches: DiscoveredFortiSwitch[] = [];
  const fortiAps: DiscoveredFortiAP[] = [];
  const vips: DiscoveredVip[] = [];

  type DeviceChunk = {
    device: DiscoveredDevice;
    subnets: DiscoveredSubnet[];
    interfaceIps: DiscoveredInterfaceIp[];
    dhcpEntries: DiscoveredDhcpEntry[];
    deviceInventory: DiscoveredInventoryDevice[];
    didInventory: boolean;
    fortiSwitches: DiscoveredFortiSwitch[];
    fortiAps: DiscoveredFortiAP[];
    vips: DiscoveredVip[];
  };

  const mgmtIfaceName = config.mgmtInterface || "mgmt";
  const useProxy = config.useProxy !== false; // default true

  // Per-device discovery: runs all 8 RPC steps and returns local result arrays.
  // Isolated from shared state — safe to run concurrently across devices.
  async function processDevice(rawDevice: any): Promise<DeviceChunk | null> {
    const deviceName: string = rawDevice.name || rawDevice.hostname;
    if (!deviceName) return null;

    if (rawDevice.conn_status !== undefined && rawDevice.conn_status !== 1) {
      log("discover.device.skip", "info", `Skipping ${deviceName} — not connected to FortiManager (conn_status=${rawDevice.conn_status})`);
      return null;
    }
    if (signal?.aborted) return null;

    log("discover.device.start", "info", `Starting discovery for ${deviceName}`, deviceName);

    // Direct mode: skip FMG entirely for per-device calls. Use the FortiGate's own
    // REST API at the mgmt IP reported by FMG's device DB. All discovery steps are
    // handled by fortigateService.discoverDhcpSubnets so there's a single source of
    // truth for the FortiGate-side discovery shape.
    if (!useProxy) {
      if (!rawDevice.ip) {
        log("discover.device.skip", "error", `Skipping ${deviceName} — direct mode needs FMG to know the device's management IP, but no IP is recorded for this device`, deviceName);
        return null;
      }
      if (!config.fortigateApiToken) {
        log("discover.device.skip", "error", `Skipping ${deviceName} — direct mode requires "FortiGate API Token" to be set on the integration`, deviceName);
        return null;
      }

      const fgConfig: FortiGateConfig = {
        host: rawDevice.ip,
        port: 443,
        apiUser: config.fortigateApiUser || "",
        apiToken: config.fortigateApiToken,
        vdom: "root",
        verifySsl: config.fortigateVerifySsl === true,
        mgmtInterface: config.mgmtInterface,
        dhcpInclude: config.interfaceInclude ?? config.dhcpInclude,
        dhcpExclude: config.interfaceExclude ?? config.dhcpExclude,
        inventoryIncludeInterfaces: config.inventoryIncludeInterfaces,
        inventoryExcludeInterfaces: config.inventoryExcludeInterfaces,
      };

      try {
        const fgResult = await discoverViaFortigate(fgConfig, signal, log, inventoryMaxAgeHours);
        // fortigateService reports one "device" keyed by the FortiGate's own
        // hostname/serial. Remap every cross-reference to FMG's canonical
        // deviceName so the downstream sync pipeline treats this as one device
        // belonging to the FMG integration.
        const fgDeviceName = fgResult.devices[0]?.name || rawDevice.ip;
        for (const s of fgResult.subnets)         s.fortigateDevice = s.fortigateDevice === fgDeviceName ? deviceName : s.fortigateDevice;
        for (const i of fgResult.interfaceIps)    i.device          = i.device === fgDeviceName ? deviceName : i.device;
        for (const e of fgResult.dhcpEntries)     e.device          = e.device === fgDeviceName ? deviceName : e.device;
        for (const v of fgResult.vips)            v.device          = v.device === fgDeviceName ? deviceName : v.device;
        for (const sw of fgResult.fortiSwitches)  sw.device         = sw.device === fgDeviceName ? deviceName : sw.device;
        for (const ap of fgResult.fortiAps)       ap.device         = ap.device === fgDeviceName ? deviceName : ap.device;
        for (const inv of fgResult.deviceInventory) inv.device      = inv.device === fgDeviceName ? deviceName : inv.device;

        const localDev: DiscoveredDevice = {
          name: deviceName,
          hostname: rawDevice.hostname || deviceName,
          serial:   rawDevice.sn || fgResult.devices[0]?.serial || "",
          model:    rawDevice.platform_str || fgResult.devices[0]?.model || "",
          mgmtIp:   rawDevice.ip,
        };

        log("discover.device.complete", "info", `Completed direct discovery for ${deviceName}`, deviceName);
        return {
          device: localDev,
          subnets: fgResult.subnets,
          interfaceIps: fgResult.interfaceIps,
          dhcpEntries: fgResult.dhcpEntries,
          deviceInventory: fgResult.deviceInventory,
          didInventory: fgResult.inventoryDevices.length > 0,
          fortiSwitches: fgResult.fortiSwitches,
          fortiAps: fgResult.fortiAps,
          vips: fgResult.vips,
        };
      } catch (err: any) {
        log("discover.device", "error", `${deviceName}: Direct discovery failed — ${err.message || "Unknown error"}`, deviceName);
        return null;
      }
    }

    const localDevice: DiscoveredDevice = {
      name: deviceName,
      hostname: rawDevice.hostname || deviceName,
      serial: rawDevice.sn || "",
      model: rawDevice.platform_str || "",
      mgmtIp: rawDevice.ip || "",
    };
    const localSubnets: DiscoveredSubnet[] = [];
    const localInterfaceIps: DiscoveredInterfaceIp[] = [];
    const localDhcpEntries: DiscoveredDhcpEntry[] = [];
    const localInventory: DiscoveredInventoryDevice[] = [];
    let didInventory = false;
    const localSwitches: DiscoveredFortiSwitch[] = [];
    const localAps: DiscoveredFortiAP[] = [];
    const localVips: DiscoveredVip[] = [];

    if (localDevice.mgmtIp && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(localDevice.mgmtIp)) {
      localInterfaceIps.push({ device: deviceName, interfaceName: mgmtIfaceName, ipAddress: localDevice.mgmtIp, role: "management" });
    }

    // Step 1: Resolve management interface IP from device config
    try {
      const mgmtIfacePayload: JsonRpcRequest = {
        id: 6,
        method: "get",
        params: [{ url: `/pm/config/device/${deviceName}/global/system/interface`, filter: [["name", "==", mgmtIfaceName]], fields: ["name", "ip"] }],
      };
      const mgmtIfaceRes = await rpc(baseUrl, mgmtIfacePayload, apiUser, apiToken, verifySsl, signal);
      const ifaceList = mgmtIfaceRes.result?.[0]?.data;
      if (Array.isArray(ifaceList)) {
        const found = (ifaceList as any[]).find((i) => i.name === mgmtIfaceName);
        const rawIp = found
          ? (Array.isArray(found.ip) ? found.ip[0] : (found.ip as string | null))
          : null;
        if (rawIp && rawIp !== "0.0.0.0" && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rawIp)) {
          localDevice.mgmtIp = rawIp;
          const ifEntry = localInterfaceIps.find((e) => e.role === "management");
          if (ifEntry) ifEntry.ipAddress = rawIp;
          else localInterfaceIps.push({ device: deviceName, interfaceName: mgmtIfaceName, ipAddress: rawIp, role: "management" });
          log("discover.device.mgmtip", "info", `${deviceName}: Resolved management IP from ${mgmtIfaceName}: ${rawIp}`, deviceName);
        }
      }
    } catch { /* best-effort; keep device.ip as fallback */ }

    try {
      // Step 2: DHCP server config — subnets and static reservations
      const dhcpPayload: JsonRpcRequest = {
        id: 2,
        method: "get",
        params: [{ url: `/pm/config/device/${deviceName}/vdom/root/system/dhcp/server` }],
      };
      const dhcpRes = await rpc(baseUrl, dhcpPayload, apiUser, apiToken, verifySsl, signal);
      const dhcpData = dhcpRes.result?.[0]?.data;
      if (!Array.isArray(dhcpData)) {
        const dhcpStatus = dhcpRes.result?.[0]?.status;
        if (dhcpStatus && dhcpStatus.code !== undefined && dhcpStatus.code !== 0) {
          log("discover.dhcp", "error", `${deviceName}: DHCP server query returned status ${dhcpStatus.code}: ${dhcpStatus.message || "(no message)"}`, deviceName);
        } else {
          log("discover.dhcp", "info", `${deviceName}: No DHCP servers configured`, deviceName);
        }
      } else {
        let deviceSubnetCount = 0;
        let deviceReservationCount = 0;
        for (const server of dhcpData) {
          const iface = typeof server.interface === "string" ? server.interface : String(server.interface ?? "");
          const serverId = String(server.id || iface);
          const netmaskStr = server.netmask;
          const ranges = server["ip-range"];
          if (!netmaskStr || !Array.isArray(ranges) || ranges.length === 0) continue;
          const startIp = ranges[0]["start-ip"];
          if (!startIp) continue;
          try {
            const block = new Netmask(`${startIp}/${netmaskStr}`);
            const cidr = `${block.base}/${block.bitmask}`;
            localSubnets.push({ cidr, name: iface || `dhcp-${serverId}`, fortigateDevice: deviceName, dhcpServerId: serverId });
            deviceSubnetCount++;
          } catch { /* skip invalid netmask/IP */ }

          const reservedAddrs = server["reserved-address"];
          if (Array.isArray(reservedAddrs)) {
            for (const entry of reservedAddrs) {
              const rIp = entry.ip;
              const rMac = entry.mac || "";
              if (!rIp || rIp === "0.0.0.0") continue;
              localDhcpEntries.push({
                device: deviceName,
                interfaceName: iface || `dhcp-${serverId}`,
                ipAddress: rIp,
                macAddress: rMac,
                hostname: entry.description || entry.action === 6 ? (entry.description || "") : "",
                type: "dhcp-reservation",
              });
              deviceReservationCount++;
            }
          }
        }
        log("discover.dhcp", "info", `${deviceName}: Found ${deviceSubnetCount} DHCP subnet(s) and ${deviceReservationCount} static reservation(s)`, deviceName);
      }
    } catch (err: any) {
      log("discover.dhcp", "error", `${deviceName}: Failed to query DHCP server config — ${err.message || "Unknown error"}`, deviceName);
    }

    // Step 3a: Live DHCP monitor — replaces config-based reservation fallback if successful
    try {
      const leasePayload: JsonRpcRequest = {
        id: 4,
        method: "exec",
        params: [{
          url: `/sys/proxy/json`,
          data: {
            target: [`/adom/${adom}/device/${deviceName}`],
            action: "get",
            resource: "/api/v2/monitor/system/dhcp?format=ip|mac|hostname|interface|reserved|expire_time|access_point|ssid|vci",
          },
        }],
      };
      const leaseRes = await rpc(baseUrl, leasePayload, apiUser, apiToken, verifySsl, signal);
      const leaseData = leaseRes.result?.[0]?.data;
      const monitorStatus = Array.isArray(leaseData) ? leaseData[0]?.status?.code : undefined;
      const rawResults = Array.isArray(leaseData)
        ? leaseData[0]?.response?.results
        : (leaseData as any)?.response?.results;

      let resultsArray: any[] = [];
      if (Array.isArray(rawResults)) resultsArray = rawResults;
      else if (rawResults && typeof rawResults === "object") resultsArray = Object.values(rawResults);

      const flatLeases: any[] = [];
      for (const entry of resultsArray) {
        if (Array.isArray(entry.leases)) {
          const serverIface = String(entry.server_interface || entry.interface || "");
          for (const lease of entry.leases) flatLeases.push({ ...lease, _serverIface: serverIface });
        } else if (entry.ip) {
          flatLeases.push(entry);
        }
      }
      log("discover.leases", "info", `${deviceName}: Raw DHCP entries from monitor: ${flatLeases.length}`, deviceName);

      if (monitorStatus === 0 && flatLeases.length > 0) {
        localDhcpEntries.length = 0; // discard config-based fallback; monitor data wins
      }

      let deviceEntryCount = 0;
      for (const lease of flatLeases) {
        const leaseIp = lease.ip;
        const leaseMac = lease.mac || "";
        let leaseIface = lease.interface || lease._serverIface || "";
        if (!leaseIp || leaseIp === "0.0.0.0") continue;
        if (localDhcpEntries.some((e) => e.ipAddress === leaseIp)) continue;
        if (!leaseIface) {
          const matched = localSubnets.find((s) => {
            try { return new Netmask(s.cidr).contains(leaseIp); } catch { return false; }
          });
          leaseIface = matched?.name || "";
        }
        localDhcpEntries.push({
          device: deviceName,
          interfaceName: leaseIface || "unknown",
          ipAddress: leaseIp,
          macAddress: leaseMac,
          hostname: lease.hostname || "",
          type: lease.reserved === true ? "dhcp-reservation" : "dhcp-lease",
          expireTime: lease.expire_time || undefined,
          accessPoint: lease.access_point || undefined,
          ssid: lease.ssid || undefined,
          vci: lease.vci || undefined,
        });
        deviceEntryCount++;
      }
      log("discover.leases", "info", `${deviceName}: Found ${deviceEntryCount} DHCP entry/entries from monitor`, deviceName);
    } catch (err: any) {
      log("discover.leases", "error", `${deviceName}: Failed to query DHCP monitor — ${err.message || "Unknown error"}`, deviceName);
    }

    // Step 3: Interface IPs + VLAN backfill onto local subnets
    try {
      const ifacePayload: JsonRpcRequest = {
        id: 3,
        method: "get",
        params: [{ url: `/pm/config/device/${deviceName}/vdom/root/system/interface`, fields: ["name", "ip", "vlanid", "switch-controller-mgmt-vlan"] }],
      };
      const ifaceRes = await rpc(baseUrl, ifacePayload, apiUser, apiToken, verifySsl, signal);
      const ifaceData = ifaceRes.result?.[0]?.data;
      const ifaceVlanMap = new Map<string, number>();
      let ifaceIpCount = 0;
      if (Array.isArray(ifaceData)) {
        for (const iface of ifaceData) {
          const ifaceName = iface.name || "";
          const parseVid = (v: unknown): number => {
            const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
            return !isNaN(n) && n > 0 ? n : 0;
          };
          const vid = parseVid(iface.vlanid) || parseVid(iface["switch-controller-mgmt-vlan"]);
          if (vid > 0) ifaceVlanMap.set(ifaceName, vid);
          if (ifaceName === mgmtIfaceName) continue;
          if (!matchesInterfaceFilter(ifaceName, config)) continue;
          const ipArr = iface.ip;
          if (Array.isArray(ipArr) && ipArr.length >= 1 && ipArr[0] && ipArr[0] !== "0.0.0.0") {
            localInterfaceIps.push({ device: deviceName, interfaceName: ifaceName, ipAddress: ipArr[0], role: "interface" });
            ifaceIpCount++;
          }
        }
      }
      for (const sub of localSubnets) {
        const vid = ifaceVlanMap.get(sub.name);
        if (vid) sub.vlan = vid;
      }
      log("discover.interfaces", "info", `${deviceName}: Resolved ${ifaceIpCount} interface IP(s)`, deviceName);
    } catch (err: any) {
      log("discover.interfaces", "error", `${deviceName}: Failed to query interfaces — ${err.message || "Unknown error"}`, deviceName);
    }

    // Step 3b: Device inventory
    try {
      const inventoryPayload: JsonRpcRequest = {
        id: 5,
        method: "exec",
        params: [{
          url: `/sys/proxy/json`,
          data: {
            target: [`/adom/${adom}/device/${deviceName}`],
            action: "get",
            resource: "/api/v2/monitor/user/device/query?format=mac|ip|hostname|host|os|type|os_version|hardware_vendor|interface|switch_fortilink|fortiswitch|switch_port|ap_name|fortiap|user|detected_user|is_online|last_seen",
          },
        }],
      };
      const inventoryRes = await rpc(baseUrl, inventoryPayload, apiUser, apiToken, verifySsl, signal);
      const inventoryData = inventoryRes.result?.[0]?.data;
      const results = Array.isArray(inventoryData)
        ? inventoryData[0]?.response?.results
        : (inventoryData as any)?.response?.results;
      const inventoryCutoffMs = Date.now() - inventoryMaxAgeHours * 60 * 60 * 1000;
      let inventoryCount = 0;
      if (Array.isArray(results)) {
        for (const client of results) {
          const mac = client.mac || "";
          const ip = client.ip || "";
          if (!mac && !ip) continue;
          if (!client.last_seen || client.last_seen * 1000 < inventoryCutoffMs) continue;
          localInventory.push({
            device: deviceName,
            macAddress: mac,
            ipAddress: ip,
            hostname: client.hostname || client.host || "",
            os: client.os || client.type || "",
            osVersion: client.os_version || "",
            hardwareVendor: client.hardware_vendor || "",
            interfaceName: client.interface || "",
            switchName: client.switch_fortilink || client.fortiswitch || "",
            switchPort: client.switch_port != null ? String(client.switch_port) : "",
            apName: client.ap_name || client.fortiap || "",
            user: client.user || client.detected_user || "",
            isOnline: !!client.is_online,
            lastSeen: new Date(client.last_seen * 1000).toISOString(),
          });
          inventoryCount++;
        }
      }
      didInventory = true;
      log("discover.inventory", "info", `${deviceName}: Found ${inventoryCount} device inventory client(s)`, deviceName);
    } catch (err: any) {
      log("discover.inventory", "error", `${deviceName}: Failed to query device inventory — ${err.message || "Unknown error"}`, deviceName);
    }

    // Step 3c: Managed FortiSwitches
    try {
      const switchPayload: JsonRpcRequest = {
        id: 8,
        method: "exec",
        params: [{
          url: `/sys/proxy/json`,
          data: {
            target: [`/adom/${adom}/device/${deviceName}`],
            action: "get",
            resource: "/api/v2/monitor/switch-controller/managed-switch/status?format=connecting_from|fgt_peer_intf_name|join_time|os_version|serial|switch-id|state|status",
          },
        }],
      };
      const switchRes = await rpc(baseUrl, switchPayload, apiUser, apiToken, verifySsl, signal);
      const switchData = switchRes.result?.[0]?.data;
      const switchProxyEntry = Array.isArray(switchData) ? switchData[0] : switchData as any;
      const switchProxyStatus = switchProxyEntry?.status?.code ?? 0;
      const switchHttpStatus = switchProxyEntry?.response?.http_status ?? 200;
      const switchResults = switchProxyEntry?.response?.results;
      let switchCount = 0;
      if (switchProxyStatus !== 0 || switchHttpStatus === 404) {
        log("discover.fortiswitches", "info", `${deviceName}: switch-controller not available (proxy status ${switchProxyStatus}, HTTP ${switchHttpStatus}) — skipping`, deviceName);
      } else if (Array.isArray(switchResults)) {
        for (const sw of switchResults) {
          localSwitches.push({
            device: deviceName,
            name: sw["switch-id"] || "",
            serial: sw.serial || "",
            ipAddress: sw.connecting_from || "",
            fgtInterface: sw.fgt_peer_intf_name || "",
            osVersion: sw.os_version || "",
            joinTime: Number.isFinite(sw.join_time) && sw.join_time > 0 ? sw.join_time : undefined,
            state: sw.state || "",
            connected: sw.status === "Connected",
          });
          switchCount++;
        }
        log("discover.fortiswitches", "info", `${deviceName}: Found ${switchCount} managed FortiSwitch(es)`, deviceName);
      } else {
        log("discover.fortiswitches", "info", `${deviceName}: Found 0 managed FortiSwitch(es)`, deviceName);
      }
    } catch (err: any) {
      log("discover.fortiswitches", "error", `${deviceName}: Failed to query managed FortiSwitches — ${err.message || "Unknown error"}`, deviceName);
    }

    // Step 3d: Managed FortiAPs
    try {
      const apPayload: JsonRpcRequest = {
        id: 9,
        method: "exec",
        params: [{
          url: `/sys/proxy/json`,
          data: {
            target: [`/adom/${adom}/device/${deviceName}`],
            action: "get",
            resource: "/api/v2/monitor/wifi/managed_ap?format=name|wtp_id|serial|model|wtp_profile|ip_addr|ip_address|local_ipv4_address|base_mac|mac|status|state|version|firmware_version",
          },
        }],
      };
      const apRes = await rpc(baseUrl, apPayload, apiUser, apiToken, verifySsl, signal);
      const apData = apRes.result?.[0]?.data;
      const apProxyEntry = Array.isArray(apData) ? apData[0] : apData as any;
      const apProxyStatus = apProxyEntry?.status?.code ?? 0;
      const apHttpStatus = apProxyEntry?.response?.http_status ?? 200;
      const apResults = apProxyEntry?.response?.results;
      let apCount = 0;
      if (apProxyStatus !== 0 || apHttpStatus === 404) {
        log("discover.fortiaps", "info", `${deviceName}: wifi/managed_ap not available (proxy status ${apProxyStatus}, HTTP ${apHttpStatus}) — skipping`, deviceName);
      } else if (Array.isArray(apResults)) {
        for (const ap of apResults) {
          const rawApIp = ap.ip_addr || ap.ip_address || ap.local_ipv4_address || "";
          const rawApMac = ap.base_mac || ap.mac || "";
          localAps.push({
            device: deviceName,
            name: ap.name || ap.wtp_id || "",
            serial: ap.serial || ap.wtp_id || "",
            model: ap.model || ap.wtp_profile || "",
            ipAddress: rawApIp === "0.0.0.0" ? "" : rawApIp,
            baseMac: /^0{1,2}[:\-.]0{1,2}[:\-.]0{1,2}[:\-.]0{1,2}[:\-.]0{1,2}[:\-.]0{1,2}$/i.test(rawApMac) ? "" : rawApMac,
            status: ap.status || ap.state || "",
            osVersion: ap.version || ap.firmware_version || "",
          });
          apCount++;
        }
        log("discover.fortiaps", "info", `${deviceName}: Found ${apCount} managed FortiAP(s)`, deviceName);
      } else {
        log("discover.fortiaps", "info", `${deviceName}: Found 0 managed FortiAP(s)`, deviceName);
      }
    } catch (err: any) {
      log("discover.fortiaps", "error", `${deviceName}: Failed to query managed FortiAPs — ${err.message || "Unknown error"}`, deviceName);
    }

    // Step 3e: Firewall VIPs
    try {
      const vipPayload: JsonRpcRequest = {
        id: 11,
        method: "get",
        params: [{ url: `/pm/config/device/${deviceName}/vdom/root/firewall/vip`, fields: ["name", "extip", "mappedip", "extintf"] }],
      };
      const vipRes = await rpc(baseUrl, vipPayload, apiUser, apiToken, verifySsl, signal);
      const vipData = vipRes.result?.[0]?.data;
      let vipCount = 0;
      if (Array.isArray(vipData)) {
        for (const vip of vipData) {
          const name = vip.name || "";
          if (!name) continue;
          const extip = parseRangeFirstIp(String(vip.extip || ""));
          if (!extip) continue;
          const mappedips: string[] = [];
          if (Array.isArray(vip.mappedip)) {
            for (const m of vip.mappedip) {
              const ip = parseRangeFirstIp(String(m.range || ""));
              if (ip) mappedips.push(ip);
            }
          }
          localVips.push({ device: deviceName, name, extip, mappedips, extintf: vip.extintf || "" });
          vipCount++;
        }
      }
      log("discover.vips", "info", `${deviceName}: Found ${vipCount} firewall VIP(s)`, deviceName);
    } catch (err: any) {
      log("discover.vips", "error", `${deviceName}: Failed to query firewall VIPs — ${err.message || "Unknown error"}`, deviceName);
    }

    // Enrich inventory: fill blank interfaceNames from this device's own DHCP data
    const macToIface = new Map<string, string>();
    for (const e of localDhcpEntries) {
      if (e.macAddress && e.interfaceName) {
        const norm = e.macAddress.toUpperCase().replace(/-/g, ":");
        if (!macToIface.has(norm)) macToIface.set(norm, e.interfaceName);
      }
    }
    for (const inv of localInventory) {
      if (!inv.interfaceName && inv.macAddress) {
        const norm = inv.macAddress.toUpperCase().replace(/-/g, ":");
        const iface = macToIface.get(norm);
        if (iface) inv.interfaceName = iface;
      }
    }

    log("discover.device.complete", "info", `Completed discovery for ${deviceName}`, deviceName);
    return { device: localDevice, subnets: localSubnets, interfaceIps: localInterfaceIps, dhcpEntries: localDhcpEntries, deviceInventory: localInventory, didInventory, fortiSwitches: localSwitches, fortiAps: localAps, vips: localVips };
  }

  // Process up to `concurrency` FortiGates in parallel.
  // Merging into shared arrays is a synchronous block — no interleaving possible.
  // When useProxy is true (default), all per-device calls funnel through FMG and
  // concurrency is forced to 1 — FMG drops parallel /sys/proxy/json connections
  // past very low parallelism, producing sporadic `fetch failed` errors. Direct
  // mode talks to each FortiGate independently so parallelism is safe there.
  const concurrency = useProxy ? 1 : Math.max(1, config.discoveryParallelism ?? 5);
  const executing = new Set<Promise<void>>();

  for (const rawDevice of devicesData) {
    if (signal?.aborted) break;

    const task: Promise<void> = (async () => {
      const chunk = await processDevice(rawDevice);
      if (!chunk) return;

      const filteredDevSubnets = filterDhcpResults(
        chunk.subnets,
        config.interfaceInclude ?? config.dhcpInclude,
        config.interfaceExclude ?? config.dhcpExclude,
      );
      const excludedDevIfaces = new Set(
        chunk.subnets
          .filter((s) => !filteredDevSubnets.includes(s))
          .map((s) => `${s.fortigateDevice}/${s.name}`)
      );
      const filteredDevInventory = chunk.deviceInventory.filter(
        (d) => !excludedDevIfaces.has(`${d.device}/${d.interfaceName}`) &&
                matchesInventoryFilter(d.interfaceName, config)
      );

      // Atomic merge into shared arrays (synchronous — no await between here and end of block)
      discovered.push(...filteredDevSubnets);
      devices.push(chunk.device);
      interfaceIps.push(...chunk.interfaceIps);
      dhcpEntries.push(...chunk.dhcpEntries);
      deviceInventory.push(...filteredDevInventory);
      if (chunk.didInventory) inventoryDevices.add(chunk.device.name);
      fortiSwitches.push(...chunk.fortiSwitches);
      fortiAps.push(...chunk.fortiAps);
      vips.push(...chunk.vips);

      if (onDeviceComplete) {
        try {
          await onDeviceComplete({
            subnets: filteredDevSubnets,
            devices: [chunk.device],
            interfaceIps: chunk.interfaceIps,
            dhcpEntries: chunk.dhcpEntries,
            deviceInventory: filteredDevInventory,
            inventoryDevices: chunk.didInventory ? [chunk.device.name] : [],
            knownDeviceNames: [],
            fortiSwitches: chunk.fortiSwitches,
            fortiAps: chunk.fortiAps,
            vips: chunk.vips,
          });
        } catch (err: any) {
          log("discover.device", "error", `${chunk.device.name}: Per-device sync failed — ${err.message || "Unknown error"}`, chunk.device.name);
        }
      }
    })().catch(() => {});

    executing.add(task);
    task.then(() => executing.delete(task), () => executing.delete(task));
    if (executing.size >= concurrency) await Promise.race(executing);
  }
  await Promise.all(executing);

  // Step 4: Filtering was applied per-device during collection; log summary and return.
  log("discover.filter", "info", `Filter complete: ${discovered.length} subnet(s) included, ${dhcpEntries.length} DHCP entries, ${deviceInventory.length} inventory device(s)`);

  return { subnets: discovered, devices, interfaceIps, dhcpEntries, deviceInventory, inventoryDevices: [...inventoryDevices], knownDeviceNames, fortiSwitches, fortiAps, vips };
}

/** Extract the first (start) IP from a range string like "1.2.3.4-1.2.3.5" or a plain IP. */
function parseRangeFirstIp(rangeStr: string): string | null {
  if (!rangeStr) return null;
  const ip = rangeStr.split("-")[0].trim();
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) && ip !== "0.0.0.0") return ip;
  return null;
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

function matchesInterfaceFilter(interfaceName: string, config: FortiManagerConfig): boolean {
  const includeList = config.interfaceInclude ?? config.dhcpInclude ?? [];
  const excludeList = config.interfaceExclude ?? config.dhcpExclude ?? [];
  if (includeList.length > 0) return includeList.some((p) => matchesWildcard(p, interfaceName));
  if (excludeList.length > 0) return !excludeList.some((p) => matchesWildcard(p, interfaceName));
  return true;
}

function matchesInventoryFilter(interfaceName: string, config: FortiManagerConfig): boolean {
  const includeList = config.inventoryIncludeInterfaces ?? [];
  const excludeList = config.inventoryExcludeInterfaces ?? [];

  // Plain patterns (no wildcards) also match VLAN sub-interfaces:
  // "RGIGuest" matches "RGIGuest.100", "dmz" matches "dmz.10"
  function matches(pattern: string, iface: string): boolean {
    if (matchesWildcard(pattern, iface)) return true;
    if (!pattern.includes("*") && iface.toLowerCase().startsWith(pattern.toLowerCase() + ".")) return true;
    return false;
  }

  if (includeList.length > 0) return includeList.some((p) => matches(p, interfaceName));
  if (excludeList.length > 0) return !excludeList.some((p) => matches(p, interfaceName));
  return true;
}

function filterDevices(
  devices: any[],
  include?: string[],
  exclude?: string[],
): any[] {
  const matchDevice = (d: any, pattern: string): boolean => {
    const name = String(d.name ?? "");
    const hostname = String(d.hostname ?? "");
    return matchesWildcard(pattern, name) || (hostname !== "" && matchesWildcard(pattern, hostname));
  };

  if (include && include.length > 0) {
    return devices.filter((d) => include.some((p) => matchDevice(d, p)));
  }
  if (exclude && exclude.length > 0) {
    return devices.filter((d) => !exclude.some((p) => matchDevice(d, p)));
  }
  return devices;
}

function filterDhcpResults(
  subnets: DiscoveredSubnet[],
  include?: string[],
  exclude?: string[],
): DiscoveredSubnet[] {
  let result = subnets;

  if (include && include.length > 0) {
    result = result.filter((s) =>
      include.some((pattern) =>
        matchesWildcard(pattern, String(s.name)) ||
        matchesWildcard(pattern, String(s.dhcpServerId))
      )
    );
  }

  if (exclude && exclude.length > 0) {
    result = result.filter((s) =>
      !exclude.some((pattern) =>
        matchesWildcard(pattern, String(s.name)) ||
        matchesWildcard(pattern, String(s.dhcpServerId))
      )
    );
  }

  return result;
}
