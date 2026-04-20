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

export interface DiscoveryResult {
  subnets: DiscoveredSubnet[];
  devices: DiscoveredDevice[];
  interfaceIps: DiscoveredInterfaceIp[];
  dhcpEntries: DiscoveredDhcpEntry[];
  deviceInventory: DiscoveredInventoryDevice[];
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
    params: [{ url: `/dvmdb/adom/${adom}/device` }],
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
    return { subnets: [], devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [] };
  }
  log("discover.devices", "info", `Found ${devicesData.length} managed device(s) in ADOM "${adom}"`);

  const discovered: DiscoveredSubnet[] = [];
  const devices: DiscoveredDevice[] = [];
  const interfaceIps: DiscoveredInterfaceIp[] = [];
  const dhcpEntries: DiscoveredDhcpEntry[] = [];
  const deviceInventory: DiscoveredInventoryDevice[] = [];

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

    // If device has a management IP, record it
    if (mgmtIp && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mgmtIp)) {
      interfaceIps.push({
        device: deviceName,
        interfaceName: config.mgmtInterface || "mgmt",
        ipAddress: mgmtIp,
        role: "management",
      });
    }

    // Track which interface names serve DHCP so we can look up their IPs
    const dhcpInterfaceNames: string[] = [];

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

        // Extract DHCP reserved addresses (static MAC-to-IP bindings)
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

      // Step 3a: Query DHCP lease table for dynamic leases
      try {
        const leasePayload: JsonRpcRequest = {
          id: 4,
          method: "exec",
          params: [{
            url: `/sys/proxy/json`,
            data: {
              target: [`/adom/${adom}/device/${deviceName}`],
              action: "get",
              resource: "/api/v2/monitor/dhcp/server-leases",
            },
          }],
        };

        const leaseRes = await rpc(baseUrl, leasePayload, apiUser, apiToken, verifySsl, signal);
        const leaseData = leaseRes.result?.[0]?.data;

        // FMG wraps the FortiGate response: data[0].response.results
        const rawResults = Array.isArray(leaseData)
          ? leaseData[0]?.response?.results
          : (leaseData as any)?.response?.results;

        // Some FortiOS versions return a nested structure where results[i] is a
        // DHCP server entry with a "leases" sub-array. Others return a flat array
        // where each item is a lease directly. Normalise to a flat list.
        const flatLeases: any[] = [];
        if (Array.isArray(rawResults)) {
          for (const entry of rawResults) {
            if (Array.isArray(entry.leases)) {
              // Nested: carry the server-level interface name down to each lease
              const serverIface = String(entry.server_interface || entry.interface || "");
              for (const lease of entry.leases) {
                flatLeases.push({ ...lease, _serverIface: serverIface });
              }
            } else {
              flatLeases.push(entry);
            }
          }
        }

        log("discover.leases", "info", `${deviceName}: Raw lease entries from API: ${flatLeases.length}`, deviceName);

        let deviceLeaseCount = 0;
        for (const lease of flatLeases) {
          const leaseIp = lease.ip;
          const leaseMac = lease.mac || "";
          const leaseIface = lease.interface || lease._serverIface || "";
          if (!leaseIp || leaseIp === "0.0.0.0") continue;

          // Skip if already captured as a static reservation
          const alreadyExists = dhcpEntries.some(
            (e) => e.ipAddress === leaseIp && e.device === deviceName
          );
          if (alreadyExists) continue;

          dhcpEntries.push({
            device: deviceName,
            interfaceName: leaseIface || "unknown",
            ipAddress: leaseIp,
            macAddress: leaseMac,
            hostname: lease.hostname || "",
            type: "dhcp-lease",
          });
          deviceLeaseCount++;
        }
        log("discover.leases", "info", `${deviceName}: Found ${deviceLeaseCount} dynamic DHCP lease(s)`, deviceName);
      } catch (err: any) {
        log("discover.leases", "error", `${deviceName}: Failed to query DHCP leases — ${err.message || "Unknown error"}`, deviceName);
      }

      // Step 3: Query interfaces to get IPs for DHCP-serving interfaces
      if (dhcpInterfaceNames.length > 0) {
        try {
          const ifacePayload: JsonRpcRequest = {
            id: 3,
            method: "get",
            params: [{ url: `/pm/config/device/${deviceName}/vdom/root/system/interface` }],
          };

          const ifaceRes = await rpc(baseUrl, ifacePayload, apiUser, apiToken, verifySsl, signal);
          const ifaceData = ifaceRes.result?.[0]?.data;
          const ifaceVlanMap = new Map<string, number>();
          let ifaceIpCount = 0;
          if (Array.isArray(ifaceData)) {
            for (const iface of ifaceData) {
              const ifaceName = iface.name || "";

              // Collect VLAN ID for every interface (used to backfill discovered subnets)
              const vid = typeof iface.vlanid === "number" ? iface.vlanid : parseInt(String(iface.vlanid ?? ""), 10);
              if (!isNaN(vid) && vid > 0) ifaceVlanMap.set(ifaceName, vid);

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
              resource: "/api/v2/monitor/user/device/query",
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
            if (client.last_seen && client.last_seen * 1000 < inventoryCutoffMs) continue;

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
              lastSeen: client.last_seen ? new Date(client.last_seen * 1000).toISOString() : new Date().toISOString(),
            });
            inventoryCount++;
          }
        }
        log("discover.inventory", "info", `${deviceName}: Found ${inventoryCount} device inventory client(s)`, deviceName);
      } catch (err: any) {
        log("discover.inventory", "error", `${deviceName}: Failed to query device inventory — ${err.message || "Unknown error"}`, deviceName);
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
        await onDeviceComplete({
          subnets: filteredDevSubnets,
          devices: devices.slice(devBefore),
          interfaceIps: interfaceIps.slice(ifIpBefore).filter(
            (ip) => ip.role === "management" || includedIfaces.has(ip.interfaceName)
          ),
          dhcpEntries: dhcpEntries.slice(entBefore).filter((e) => includedIfaces.has(e.interfaceName)),
          deviceInventory: deviceInventory.slice(invBefore).filter(
            (d) => !excludedDevIfaces.has(`${d.device}/${d.interfaceName}`)
          ),
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

  // Filter DHCP entries to only include those from filtered DHCP interfaces
  const filteredDhcpEntries = dhcpEntries.filter(
    (e) => includedIfaceNames.has(e.interfaceName)
  );

  // Filter device inventory: drop devices connected to excluded DHCP interfaces
  const excludedIfaceNames = new Set(
    discovered
      .filter((s) => !filteredSubnets.includes(s))
      .map((s) => `${s.fortigateDevice}/${s.name}`)
  );
  const filteredInventory = deviceInventory.filter(
    (d) => !excludedIfaceNames.has(`${d.device}/${d.interfaceName}`)
  );

  const excluded = discovered.length - filteredSubnets.length;
  log("discover.filter", "info", `Filter complete: ${filteredSubnets.length} subnet(s) included, ${excluded} excluded, ${filteredDhcpEntries.length} DHCP entries, ${filteredInventory.length} inventory device(s)`);

  return { subnets: filteredSubnets, devices, interfaceIps: filteredIps, dhcpEntries: filteredDhcpEntries, deviceInventory: filteredInventory };
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
        String(s.name).toLowerCase().includes(pattern.toLowerCase()) ||
        String(s.dhcpServerId).toLowerCase().includes(pattern.toLowerCase())
      )
    );
  }

  if (exclude && exclude.length > 0) {
    result = result.filter((s) =>
      !exclude.some((pattern) =>
        String(s.name).toLowerCase().includes(pattern.toLowerCase()) ||
        String(s.dhcpServerId).toLowerCase().includes(pattern.toLowerCase())
      )
    );
  }

  return result;
}
