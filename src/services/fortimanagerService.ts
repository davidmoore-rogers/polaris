/**
 * src/services/fortimanagerService.ts — FortiManager JSON RPC API client
 *
 * Authenticates via bearer token (API key) rather than session-based login.
 */

import { Netmask } from "netmask";
import { AppError } from "../utils/errors.js";

export interface FortiManagerConfig {
  host: string;
  port?: number;
  apiUser: string;          // API user name (required by newer FMG versions)
  apiToken: string;         // Bearer token for authentication
  adom?: string;            // Administrative Domain (default: "root")
  verifySsl?: boolean;      // Skip TLS verification (default: false)
  mgmtInterface?: string;
  dhcpInclude?: string[];
  dhcpExclude?: string[];
  inventoryExcludeInterfaces?: string[];
  inventoryIncludeInterfaces?: string[];
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
  role: string;           // "dhcp-server" or "management"
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

  // Step 1: List managed devices in the ADOM
  const devicesPayload: JsonRpcRequest = {
    id: 1,
    method: "get",
    params: [{ url: `/dvmdb/adom/${adom}/device`, fields: ["name", "hostname", "sn", "platform_str", "ip", "conn_status"], filter: [["conn_status", "==", 1]] }],
  };

  let devicesRes: JsonRpcResponse;
  try {
    devicesRes = await rpc(baseUrl, devicesPayload, apiUser, apiToken, verifySsl, signal);
  } catch (err: any) {
    log("discover.devices", "error", `Failed to list managed devices: ${err.message || "Unknown error"}`);
    throw err;
  }
  const devicesData = devicesRes.result?.[0]?.data;
  if (!Array.isArray(devicesData) || devicesData.length === 0) {
    log("discover.devices", "info", `No managed devices found in ADOM "${adom}"`);
    return { subnets: [], devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [], inventoryDevices: [], fortiSwitches: [], fortiAps: [], vips: [] };
  }
  log("discover.devices", "info", `Found ${devicesData.length} managed device(s) in ADOM "${adom}"`);

  const discovered: DiscoveredSubnet[] = [];
  const devices: DiscoveredDevice[] = [];
  const interfaceIps: DiscoveredInterfaceIp[] = [];
  const dhcpEntries: DiscoveredDhcpEntry[] = [];
  const deviceInventory: DiscoveredInventoryDevice[] = [];
  const inventoryDevices = new Set<string>();
  const fortiSwitches: DiscoveredFortiSwitch[] = [];
  const fortiAps: DiscoveredFortiAP[] = [];
  const vips: DiscoveredVip[] = [];

  // Step 2: For each device, query DHCP server configs + interfaces
  for (const device of devicesData) {
    const deviceName = device.name || device.hostname;
    if (!deviceName) continue;

    // Skip devices that are not currently connected to FortiManager.
    // conn_status 1 = UP; anything else (2=DOWN, 3=UNKNOWN) means the device
    // is unreachable and its config data may be stale or unavailable.
    if (device.conn_status !== undefined && device.conn_status !== 1) {
      log("discover.device.skip", "info", `Skipping ${deviceName} — not connected to FortiManager (conn_status=${device.conn_status})`, deviceName);
      continue;
    }

    // Stop early if the caller aborted (e.g. integration was re-saved)
    if (signal?.aborted) break;

    // Capture array lengths before this device so we can slice a per-device result
    const snBefore = discovered.length;
    const devBefore = devices.length;
    const ifIpBefore = interfaceIps.length;
    const entBefore = dhcpEntries.length;
    const invBefore = deviceInventory.length;
    const switchBefore = fortiSwitches.length;
    const apBefore = fortiAps.length;
    const vipBefore = vips.length;

    log("discover.device.start", "info", `Starting discovery for ${deviceName}`, deviceName);

    // Capture device metadata for asset creation
    const mgmtIp = device.ip || "";
    devices.push({
      name: deviceName,
      hostname: device.hostname || deviceName,
      serial: device.sn || "",
      model: device.platform_str || "",
      mgmtIp,
    });

    // If device has a management IP, record it as a placeholder (may be updated below)
    if (mgmtIp && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mgmtIp)) {
      interfaceIps.push({
        device: deviceName,
        interfaceName: config.mgmtInterface || "mgmt",
        ipAddress: mgmtIp,
        role: "management",
      });
    }

    // Resolve the FortiGate's actual management interface IP from its own config.
    // device.ip from the FMG device DB reflects the FMG's own management address,
    // not the FortiGate's interface IP.
    const mgmtIfaceName = config.mgmtInterface || "mgmt";
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
          devices[devices.length - 1].mgmtIp = rawIp;
          const ifEntry = interfaceIps.find((e) => e.device === deviceName && e.role === "management");
          if (ifEntry) {
            ifEntry.ipAddress = rawIp;
          } else {
            interfaceIps.push({ device: deviceName, interfaceName: mgmtIfaceName, ipAddress: rawIp, role: "management" });
          }
          log("discover.device.mgmtip", "info", `${deviceName}: Resolved management IP from ${mgmtIfaceName}: ${rawIp}`, deviceName);
        }
      }
    } catch { /* best-effort; keep device.ip as fallback */ }

    // Track which interface names serve DHCP so we can look up their IPs
    const dhcpInterfaceNames: string[] = [];
    // Record start index so the monitor phase can replace config reservations with richer data
    const configResStart = dhcpEntries.length;

    try {
      const dhcpPayload: JsonRpcRequest = {
        id: 2,
        method: "get",
        params: [{ url: `/pm/config/device/${deviceName}/vdom/root/system/dhcp/server` }],
      };

      const dhcpRes = await rpc(baseUrl, dhcpPayload, apiUser, apiToken, verifySsl, signal);
      const dhcpData = dhcpRes.result?.[0]?.data;
      if (!Array.isArray(dhcpData)) {
        log("discover.dhcp", "info", `${deviceName}: No DHCP servers configured`, deviceName);
        continue;
      }

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

        // Derive CIDR from start-ip + netmask
        try {
          const block = new Netmask(`${startIp}/${netmaskStr}`);
          const cidr = `${block.base}/${block.bitmask}`;

          discovered.push({
            cidr,
            name: iface || `dhcp-${serverId}`,
            fortigateDevice: deviceName,
            dhcpServerId: serverId,
          });

          deviceSubnetCount++;
          if (iface) dhcpInterfaceNames.push(iface);
        } catch {
          // Skip entries with invalid netmask/IP combinations
        }

        // Extract DHCP reserved addresses as fallback — replaced below if system/dhcp succeeds
        const reservedAddrs = server["reserved-address"];
        if (Array.isArray(reservedAddrs)) {
          for (const entry of reservedAddrs) {
            const rIp = entry.ip;
            const rMac = entry.mac || "";
            if (!rIp || rIp === "0.0.0.0") continue;
            dhcpEntries.push({
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

      // Step 3a: Query live DHCP table (reservations + leases) via system/dhcp monitor endpoint.
      // If successful, replace the config-based reservation fallback entries with this richer data
      // which includes vci (device model), access_point, ssid, and the reserved flag.
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

        // FMG wraps the FortiGate response: data[0].response.results
        const rawResults = Array.isArray(leaseData)
          ? leaseData[0]?.response?.results
          : (leaseData as any)?.response?.results;

        // system/dhcp returns a flat array of all current entries (both reserved and dynamic).
        // Older endpoints may return nested formats; normalise all to a flat list.
        let resultsArray: any[] = [];
        if (Array.isArray(rawResults)) {
          resultsArray = rawResults;
        } else if (rawResults && typeof rawResults === "object") {
          resultsArray = Object.values(rawResults);
        }

        const flatLeases: any[] = [];
        for (const entry of resultsArray) {
          if (Array.isArray(entry.leases)) {
            // Nested format: carry server-level interface name down to each lease
            const serverIface = String(entry.server_interface || entry.interface || "");
            for (const lease of entry.leases) {
              flatLeases.push({ ...lease, _serverIface: serverIface });
            }
          } else if (entry.ip) {
            flatLeases.push(entry);
          }
        }

        log("discover.leases", "info", `${deviceName}: Raw DHCP entries from monitor: ${flatLeases.length}`, deviceName);

        if (monitorStatus === 0 && flatLeases.length > 0) {
          // Monitor succeeded — replace config-based reservation fallback entries with monitor data
          dhcpEntries.splice(configResStart, dhcpEntries.length - configResStart);
        }

        // Subnets discovered for this device (for interface inference below)
        const deviceSubnets = discovered.slice(snBefore);

        let deviceEntryCount = 0;
        for (const lease of flatLeases) {
          const leaseIp = lease.ip;
          const leaseMac = lease.mac || "";
          let leaseIface = lease.interface || lease._serverIface || "";
          if (!leaseIp || leaseIp === "0.0.0.0") continue;

          // Skip duplicates (can occur when monitor and config fallback both run)
          if (dhcpEntries.some((e) => e.ipAddress === leaseIp && e.device === deviceName)) continue;

          // If no interface name came from the API, infer from whichever discovered subnet contains it
          if (!leaseIface) {
            const matched = deviceSubnets.find((s) => {
              try { return new Netmask(s.cidr).contains(leaseIp); } catch { return false; }
            });
            leaseIface = matched?.name || "";
          }

          dhcpEntries.push({
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

      // Step 3: Query interfaces to get IPs for DHCP-serving interfaces
      if (dhcpInterfaceNames.length > 0) {
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

              // Collect VLAN ID for every interface (used to backfill discovered subnets).
              // FortiLink interfaces report vlanid=0 and carry the real VLAN in
              // switch-controller-mgmt-vlan, so `??` fallback won't work (0 isn't nullish).
              const parseVid = (v: unknown): number => {
                const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
                return !isNaN(n) && n > 0 ? n : 0;
              };
              const vid = parseVid(iface.vlanid) || parseVid(iface["switch-controller-mgmt-vlan"]);
              if (vid > 0) ifaceVlanMap.set(ifaceName, vid);

              // Collect IP only for DHCP-serving interfaces
              if (!dhcpInterfaceNames.includes(ifaceName)) continue;
              const ipArr = iface.ip;
              if (Array.isArray(ipArr) && ipArr.length >= 1 && ipArr[0] && ipArr[0] !== "0.0.0.0") {
                interfaceIps.push({
                  device: deviceName,
                  interfaceName: ifaceName,
                  ipAddress: ipArr[0],
                  role: "dhcp-server",
                });
                ifaceIpCount++;
              }
            }
          }

          // Back-fill VLAN IDs onto discovered subnets for this device
          for (const sub of discovered) {
            if (sub.fortigateDevice === deviceName) {
              const vid = ifaceVlanMap.get(sub.name);
              if (vid) sub.vlan = vid;
            }
          }
          log("discover.interfaces", "info", `${deviceName}: Resolved ${ifaceIpCount} DHCP interface IP(s)`, deviceName);
        } catch (err: any) {
          log("discover.interfaces", "error", `${deviceName}: Failed to query interfaces — ${err.message || "Unknown error"}`, deviceName);
        }
      }

      // Step 3b: Query device inventory (detected clients) via FMG proxy
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
            // Treat missing last_seen as stale: FMG holds historical entries
            // without a timestamp and we don't want them overwriting fresh
            // DHCP attribution on assets.
            if (!client.last_seen || client.last_seen * 1000 < inventoryCutoffMs) continue;

            deviceInventory.push({
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
        inventoryDevices.add(deviceName);
        log("discover.inventory", "info", `${deviceName}: Found ${inventoryCount} device inventory client(s)`, deviceName);
      } catch (err: any) {
        log("discover.inventory", "error", `${deviceName}: Failed to query device inventory — ${err.message || "Unknown error"}`, deviceName);
      }

      // Step 3c: Query managed FortiSwitches via FMG proxy
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
            fortiSwitches.push({
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

      // Step 3d: Query managed FortiAPs via FMG proxy
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
            fortiAps.push({
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

      // Step 3e: Query firewall VIPs from FortiGate config via FMG
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

            // Parse extip — may be "1.2.3.4" or "1.2.3.4-1.2.3.5"
            const extip = parseRangeFirstIp(String(vip.extip || ""));
            if (!extip) continue;

            // Parse mappedip array: [{range: "10.0.0.1-10.0.0.1"}, ...]
            const mappedips: string[] = [];
            if (Array.isArray(vip.mappedip)) {
              for (const m of vip.mappedip) {
                const ip = parseRangeFirstIp(String(m.range || ""));
                if (ip) mappedips.push(ip);
              }
            }

            vips.push({
              device: deviceName,
              name,
              extip,
              mappedips,
              extintf: vip.extintf || "",
            });
            vipCount++;
          }
        }
        log("discover.vips", "info", `${deviceName}: Found ${vipCount} firewall VIP(s)`, deviceName);
      } catch (err: any) {
        log("discover.vips", "error", `${deviceName}: Failed to query firewall VIPs — ${err.message || "Unknown error"}`, deviceName);
      }
    } catch (err: any) {
      log("discover.device", "error", `${deviceName}: Failed to query device — ${err.message || "Unknown error"}`, deviceName);
    }

    // Emit a filtered per-device result so the caller can sync incrementally
    if (onDeviceComplete) {
      try {
        const devSubnets = discovered.slice(snBefore);
        const filteredDevSubnets = filterDhcpResults(devSubnets, config.dhcpInclude, config.dhcpExclude);
        const includedIfaces = new Set(filteredDevSubnets.map((s) => s.name));
        const excludedDevIfaces = new Set(
          devSubnets.filter((s) => !filteredDevSubnets.includes(s)).map((s) => `${s.fortigateDevice}/${s.name}`)
        );
        // Enrich blank interfaceNames in this device's inventory slice using DHCP data
        const devDhcpEntries = dhcpEntries.slice(entBefore);
        const devMacToIface = new Map<string, string>();
        for (const e of devDhcpEntries) {
          if (e.macAddress && e.interfaceName) {
            const norm = e.macAddress.toUpperCase().replace(/-/g, ":");
            if (!devMacToIface.has(norm)) devMacToIface.set(norm, e.interfaceName);
          }
        }
        const devInventory = deviceInventory.slice(invBefore);
        for (const inv of devInventory) {
          if (!inv.interfaceName && inv.macAddress) {
            const norm = inv.macAddress.toUpperCase().replace(/-/g, ":");
            const iface = devMacToIface.get(norm);
            if (iface) inv.interfaceName = iface;
          }
        }

        await onDeviceComplete({
          subnets: filteredDevSubnets,
          devices: devices.slice(devBefore),
          interfaceIps: interfaceIps.slice(ifIpBefore).filter(
            (ip) => ip.role === "management" || includedIfaces.has(ip.interfaceName)
          ),
          // Pass all DHCP entries (including from excluded interfaces) so that manually-created
          // subnets matching an excluded network still get populated with reservations and leases.
          dhcpEntries: devDhcpEntries,
          deviceInventory: devInventory.filter(
            (d) => !excludedDevIfaces.has(`${d.device}/${d.interfaceName}`) &&
                   matchesInventoryFilter(d.interfaceName, config)
          ),
          inventoryDevices: inventoryDevices.has(deviceName) ? [deviceName] : [],
          fortiSwitches: fortiSwitches.slice(switchBefore),
          fortiAps: fortiAps.slice(apBefore),
          vips: vips.slice(vipBefore),
        });
      } catch (err: any) {
        log("discover.device", "error", `${deviceName}: Per-device sync failed — ${err.message || "Unknown error"}`, deviceName);
      }
    }
  }

  // Step 4: Filter subnets by dhcpInclude / dhcpExclude
  const filteredSubnets = filterDhcpResults(discovered, config.dhcpInclude, config.dhcpExclude);

  // Also filter interface IPs to only include those from filtered (included) DHCP interfaces
  const includedIfaceNames = new Set(filteredSubnets.map((s) => s.name));
  const filteredIps = interfaceIps.filter(
    (ip) => ip.role === "management" || includedIfaceNames.has(ip.interfaceName)
  );

  // Pass all DHCP entries (including from excluded interfaces) so that manually-created
  // subnets matching an excluded network still get populated with reservations and leases.
  // syncDhcpSubnets uses findSubnetForIp, which returns nothing if no subnet exists,
  // so entries for fully-excluded networks with no matching subnet are silently skipped.
  const filteredDhcpEntries = dhcpEntries;

  // Enrich inventory entries whose interfaceName is blank by matching them to a DHCP entry
  // with the same MAC. FortiGate sometimes omits client.interface for wireless clients;
  // the DHCP entry for the same device carries the correct interface (DHCP server interface).
  const macToDhcpIface = new Map<string, string>();
  for (const e of dhcpEntries) {
    if (e.macAddress && e.interfaceName) {
      const norm = e.macAddress.toUpperCase().replace(/-/g, ":");
      if (!macToDhcpIface.has(norm)) macToDhcpIface.set(norm, e.interfaceName);
    }
  }
  for (const inv of deviceInventory) {
    if (!inv.interfaceName && inv.macAddress) {
      const norm = inv.macAddress.toUpperCase().replace(/-/g, ":");
      const iface = macToDhcpIface.get(norm);
      if (iface) inv.interfaceName = iface;
    }
  }

  // Filter device inventory: drop devices connected to excluded DHCP interfaces
  const excludedIfaceNames = new Set(
    discovered
      .filter((s) => !filteredSubnets.includes(s))
      .map((s) => `${s.fortigateDevice}/${s.name}`)
  );
  const filteredInventory = deviceInventory.filter(
    (d) => !excludedIfaceNames.has(`${d.device}/${d.interfaceName}`) &&
           matchesInventoryFilter(d.interfaceName, config)
  );

  const excluded = discovered.length - filteredSubnets.length;
  log("discover.filter", "info", `Filter complete: ${filteredSubnets.length} subnet(s) included, ${excluded} excluded, ${filteredDhcpEntries.length} DHCP entries, ${filteredInventory.length} inventory device(s)`);

  return { subnets: filteredSubnets, devices, interfaceIps: filteredIps, dhcpEntries: filteredDhcpEntries, deviceInventory: filteredInventory, inventoryDevices: [...inventoryDevices], fortiSwitches, fortiAps, vips };
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
