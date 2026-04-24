/**
 * src/services/fortigateService.ts — Single FortiGate REST API client
 *
 * Talks directly to a standalone FortiGate (not managed by FortiManager).
 * Uses the FortiOS REST API with Bearer token authentication against a specific
 * VDOM. Discovery scope mirrors fortimanagerService but without the FMG proxy
 * wrapper — requests go straight to `/api/v2/cmdb/...` and `/api/v2/monitor/...`.
 *
 * Returns DiscoveryResult from fortimanagerService so the existing sync pipeline
 * in integrations.ts consumes both integrations identically.
 */

import { Netmask } from "netmask";
import { AppError } from "../utils/errors.js";
import type {
  DiscoveredSubnet,
  DiscoveredDevice,
  DiscoveredInterfaceIp,
  DiscoveredDhcpEntry,
  DiscoveredInventoryDevice,
  DiscoveredFortiSwitch,
  DiscoveredFortiAP,
  DiscoveredVip,
  DiscoveryResult,
  DiscoveryProgressCallback,
} from "./fortimanagerService.js";

export interface FortiGateConfig {
  host: string;
  port?: number;
  apiUser: string;          // API admin username (optional; sent as X-Csrftoken-style header for parity with FMG)
  apiToken: string;         // Bearer token for authentication
  vdom?: string;            // Virtual Domain (default: "root")
  verifySsl?: boolean;      // Skip TLS verification (default: false)
  mgmtInterface?: string;
  dhcpInclude?: string[];
  dhcpExclude?: string[];
  inventoryExcludeInterfaces?: string[];
  inventoryIncludeInterfaces?: string[];
}

/**
 * Test connectivity to a FortiGate using bearer token auth.
 * Calls /api/v2/monitor/system/status to verify access and retrieve version info.
 */
export async function testConnection(config: FortiGateConfig): Promise<{
  ok: boolean;
  message: string;
  version?: string;
}> {
  try {
    const res = await fgRequest<any>(config, "GET", "/api/v2/monitor/system/status");
    const version = res?.version ? String(res.version) : undefined;
    const hostname = res?.hostname ? String(res.hostname) : undefined;
    const label = hostname && version
      ? `Connected — ${hostname} (FortiOS ${version})`
      : version
        ? `Connected — FortiOS ${version}`
        : "Connected successfully";
    return { ok: true, message: label, version };
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
    if (err instanceof AppError) {
      return { ok: false, message: err.message };
    }
    return { ok: false, message: err.message || "Unknown error" };
  }
}

/**
 * Low-level FortiOS REST request with bearer token auth.
 * Returns the decoded JSON body on success, or throws AppError on auth/HTTP failures.
 * Exported so fortimanagerService can reuse this when `useProxy` is disabled on
 * an FMG integration — FMG enumerates the devices, per-device REST calls go direct.
 */
export async function fgRequest<T>(
  config: FortiGateConfig,
  method: "GET" | "POST",
  path: string,
  opts: { query?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<T> {
  const port = config.port || 443;
  const qs = new URLSearchParams(opts.query || {});
  const url = `https://${config.host}:${port}${path}${qs.toString() ? (path.includes("?") ? "&" : "?") + qs.toString() : ""}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    if (config.verifySsl === false) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiToken}`,
    };
    // Parity with FMG: forward the API user if provided. FortiOS ignores it,
    // but some admin/audit configurations log this header.
    if (config.apiUser) headers["access_user"] = config.apiUser;

    const res = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      throw new AppError(502, "Authentication failed — check your API token");
    }
    if (res.status === 404) {
      throw new AppError(404, `Endpoint not found: ${path}`);
    }
    if (!res.ok) {
      throw new AppError(502, `FortiGate returned HTTP ${res.status}`);
    }

    const body = (await res.json()) as any;

    // FortiOS REST envelope: { status, http_status, results, ... }
    // Errors may arrive as { status: "error", http_status: 4xx, error: <code> }
    if (body && body.status === "error") {
      throw new AppError(502, `FortiGate error (${body.error ?? "unknown"}): ${body.message ?? path}`);
    }

    return (body?.results ?? body) as T;
  } finally {
    if (config.verifySsl === false) {
      if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
    }
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Proxy an arbitrary REST call to the FortiGate using stored credentials.
 * Used by the manual API query tool in the UI.
 */
export async function proxyQuery(
  config: FortiGateConfig,
  method: "GET" | "POST",
  path: string,
  query?: Record<string, string>,
): Promise<unknown> {
  return fgRequest(config, method, path, { query });
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/**
 * Query a single FortiGate directly for its DHCP configuration, interfaces,
 * VIPs, and managed switch/AP inventory. Mirrors fortimanagerService.discoverDhcpSubnets
 * but produces a DiscoveryResult with a single "device" entry: the FortiGate itself.
 */
export async function discoverDhcpSubnets(
  config: FortiGateConfig,
  signal?: AbortSignal,
  onProgress?: DiscoveryProgressCallback,
  _inventoryMaxAgeHours = 24, // Monitor endpoints only return live state on direct FGT
  _onDeviceComplete?: (result: DiscoveryResult) => Promise<void>,
): Promise<DiscoveryResult> {
  const log = onProgress || (() => {});
  const vdom = config.vdom || "root";
  const queryBase: Record<string, string> = { vdom };

  // Step 1: Identify the FortiGate itself (one "device")
  let deviceName = "";
  let deviceHostname = "";
  let deviceSerial = "";
  let deviceModel = "";
  let deviceOsVersion = "";
  try {
    const status = await fgRequest<any>(config, "GET", "/api/v2/monitor/system/status", { signal });
    deviceName = String(status?.hostname || status?.serial || config.host);
    deviceHostname = String(status?.hostname || deviceName);
    deviceSerial = String(status?.serial || "");
    deviceModel = String(status?.model_name || status?.model || "FortiGate");
    deviceOsVersion = String(status?.version || "");
    log("discover.devices", "info", `Connected to ${deviceHostname} — FortiOS ${deviceOsVersion}`, deviceHostname);
  } catch (err: any) {
    log("discover.devices", "error", `Failed to query FortiGate status: ${err.message || "Unknown error"}`);
    throw err;
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

  // Step 2: Resolve the FortiGate's management interface IP from its own config.
  // We don't know its mgmt IP from /sys/status; fall back to the host we connected to.
  const mgmtIfaceName = config.mgmtInterface || "mgmt";
  let mgmtIp: string | null = null;
  try {
    const ifaceList = await fgRequest<any[]>(config, "GET", "/api/v2/cmdb/system/interface", {
      query: { ...queryBase, filter: `name==${mgmtIfaceName}` },
      signal,
    });
    if (Array.isArray(ifaceList) && ifaceList.length > 0) {
      const iface = ifaceList[0];
      const rawIp = Array.isArray(iface.ip)
        ? iface.ip[0]
        : (typeof iface.ip === "string" ? iface.ip.split(" ")[0] : "");
      if (rawIp && rawIp !== "0.0.0.0" && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rawIp)) {
        mgmtIp = rawIp;
        log("discover.device.mgmtip", "info", `${deviceHostname}: Resolved management IP from ${mgmtIfaceName}: ${rawIp}`, deviceHostname);
      }
    }
  } catch { /* best-effort */ }

  // If we couldn't resolve the management interface, fall back to the config host
  if (!mgmtIp && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(config.host)) {
    mgmtIp = config.host;
  }

  devices.push({
    name: deviceName,
    hostname: deviceHostname,
    serial: deviceSerial,
    model: deviceModel,
    mgmtIp: mgmtIp || "",
  });

  if (mgmtIp) {
    interfaceIps.push({
      device: deviceName,
      interfaceName: mgmtIfaceName,
      ipAddress: mgmtIp,
      role: "management",
    });
  }

  // Stop early if aborted
  if (signal?.aborted) {
    return { subnets: [], devices, interfaceIps, dhcpEntries: [], deviceInventory: [], inventoryDevices: [], knownDeviceNames: [deviceName], fortiSwitches: [], fortiAps: [], vips: [] };
  }

  // Step 3: DHCP server configuration
  const dhcpInterfaceNames: string[] = [];
  const configResStart = dhcpEntries.length;
  try {
    const dhcpData = await fgRequest<any[]>(config, "GET", "/api/v2/cmdb/system.dhcp/server", { query: queryBase, signal });
    if (!Array.isArray(dhcpData)) {
      log("discover.dhcp", "info", `${deviceHostname}: No DHCP servers configured`, deviceHostname);
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
          discovered.push({
            cidr,
            name: iface || `dhcp-${serverId}`,
            fortigateDevice: deviceName,
            dhcpServerId: serverId,
          });
          deviceSubnetCount++;
          if (iface) dhcpInterfaceNames.push(iface);
        } catch {
          // skip malformed
        }

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
              hostname: entry.description || "",
              type: "dhcp-reservation",
            });
            deviceReservationCount++;
          }
        }
      }
      log("discover.dhcp", "info", `${deviceHostname}: Found ${deviceSubnetCount} DHCP subnet(s) and ${deviceReservationCount} static reservation(s)`, deviceHostname);
    }
  } catch (err: any) {
    log("discover.dhcp", "error", `${deviceHostname}: Failed to query DHCP servers — ${err.message || "Unknown error"}`, deviceHostname);
  }

  // Step 3a: Live DHCP table (reservations + leases) via monitor endpoint
  try {
    const leases = await fgRequest<any[]>(config, "GET", "/api/v2/monitor/system/dhcp", {
      query: { ...queryBase, format: "ip|mac|hostname|interface|reserved|expire_time|access_point|ssid|vci" },
      signal,
    });

    const flatLeases: any[] = [];
    if (Array.isArray(leases)) {
      for (const entry of leases) {
        if (Array.isArray(entry.leases)) {
          const serverIface = String(entry.server_interface || entry.interface || "");
          for (const lease of entry.leases) flatLeases.push({ ...lease, _serverIface: serverIface });
        } else if (entry.ip) {
          flatLeases.push(entry);
        }
      }
    }

    log("discover.leases", "info", `${deviceHostname}: Raw DHCP entries from monitor: ${flatLeases.length}`, deviceHostname);

    if (flatLeases.length > 0) {
      // Replace config-based reservation fallback with richer monitor data
      dhcpEntries.splice(configResStart, dhcpEntries.length - configResStart);
    }

    let deviceEntryCount = 0;
    for (const lease of flatLeases) {
      const leaseIp = lease.ip;
      const leaseMac = lease.mac || "";
      let leaseIface = lease.interface || lease._serverIface || "";
      if (!leaseIp || leaseIp === "0.0.0.0") continue;
      if (dhcpEntries.some((e) => e.ipAddress === leaseIp && e.device === deviceName)) continue;

      if (!leaseIface) {
        const matched = discovered.find((s) => {
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
    log("discover.leases", "info", `${deviceHostname}: Found ${deviceEntryCount} DHCP entry/entries from monitor`, deviceHostname);
  } catch (err: any) {
    log("discover.leases", "error", `${deviceHostname}: Failed to query DHCP monitor — ${err.message || "Unknown error"}`, deviceHostname);
  }

  // Step 3b: Interface IPs + VLAN IDs
  if (dhcpInterfaceNames.length > 0) {
    try {
      const ifaceData = await fgRequest<any[]>(config, "GET", "/api/v2/cmdb/system/interface", { query: queryBase, signal });
      const ifaceVlanMap = new Map<string, number>();
      let ifaceIpCount = 0;
      if (Array.isArray(ifaceData)) {
        const parseVid = (v: unknown): number => {
          const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
          return !isNaN(n) && n > 0 ? n : 0;
        };
        for (const iface of ifaceData) {
          const ifaceName = iface.name || "";
          const vid = parseVid(iface.vlanid) || parseVid(iface["switch-controller-mgmt-vlan"]);
          if (vid > 0) ifaceVlanMap.set(ifaceName, vid);

          if (!dhcpInterfaceNames.includes(ifaceName)) continue;
          const rawIp = Array.isArray(iface.ip)
            ? iface.ip[0]
            : (typeof iface.ip === "string" ? iface.ip.split(" ")[0] : "");
          if (rawIp && rawIp !== "0.0.0.0" && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rawIp)) {
            interfaceIps.push({
              device: deviceName,
              interfaceName: ifaceName,
              ipAddress: rawIp,
              role: "dhcp-server",
            });
            ifaceIpCount++;
          }
        }
      }

      for (const sub of discovered) {
        const vid = ifaceVlanMap.get(sub.name);
        if (vid) sub.vlan = vid;
      }
      log("discover.interfaces", "info", `${deviceHostname}: Resolved ${ifaceIpCount} DHCP interface IP(s)`, deviceHostname);
    } catch (err: any) {
      log("discover.interfaces", "error", `${deviceHostname}: Failed to query interfaces — ${err.message || "Unknown error"}`, deviceHostname);
    }
  }

  // Step 3c: Device inventory (detected clients)
  try {
    const results = await fgRequest<any[]>(config, "GET", "/api/v2/monitor/user/device/query", {
      query: { ...queryBase, format: "mac|ip|hostname|host|os|type|os_version|hardware_vendor|interface|switch_fortilink|fortiswitch|switch_port|ap_name|fortiap|user|detected_user|is_online|last_seen" },
      signal,
    });

    let inventoryCount = 0;
    if (Array.isArray(results)) {
      for (const client of results) {
        const mac = client.mac || "";
        const ip = client.ip || "";
        if (!mac && !ip) continue;
        if (!client.last_seen) continue;

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
    log("discover.inventory", "info", `${deviceHostname}: Found ${inventoryCount} device inventory client(s)`, deviceHostname);
  } catch (err: any) {
    log("discover.inventory", "error", `${deviceHostname}: Failed to query device inventory — ${err.message || "Unknown error"}`, deviceHostname);
  }

  // Step 3d: Managed FortiSwitches
  try {
    const swResults = await fgRequest<any[]>(config, "GET", "/api/v2/monitor/switch-controller/managed-switch/status", {
      query: { ...queryBase, format: "connecting_from|fgt_peer_intf_name|join_time|os_version|serial|switch-id|state|status" },
      signal,
    });
    let switchCount = 0;
    if (Array.isArray(swResults)) {
      for (const sw of swResults) {
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
    }
    log("discover.fortiswitches", "info", `${deviceHostname}: Found ${switchCount} managed FortiSwitch(es)`, deviceHostname);
  } catch (err: any) {
    // 404 means switch-controller not licensed/available — downgrade to info
    const isNotFound = err instanceof AppError && err.httpStatus === 404;
    log("discover.fortiswitches", isNotFound ? "info" : "error", `${deviceHostname}: ${isNotFound ? "switch-controller not available — skipping" : `Failed to query managed FortiSwitches — ${err.message || "Unknown error"}`}`, deviceHostname);
  }

  // Step 3e: Managed FortiAPs
  try {
    const apResults = await fgRequest<any[]>(config, "GET", "/api/v2/monitor/wifi/managed_ap", {
      query: { ...queryBase, format: "name|wtp_id|serial|model|wtp_profile|ip_addr|ip_address|local_ipv4_address|base_mac|mac|status|state|version|firmware_version" },
      signal,
    });
    let apCount = 0;
    if (Array.isArray(apResults)) {
      for (const ap of apResults) {
        const rawApIp = ap.ip_addr || ap.ip_address || ap.local_ipv4_address || "";
        const rawApMac = ap.base_mac || ap.mac || "";
        fortiAps.push({
          device: deviceName,
          name: ap.name || ap.wtp_id || "",
          serial: ap.serial || ap.wtp_id || "",
          model: ap.model || ap.wtp_profile || "",
          ipAddress: rawApIp === "0.0.0.0" ? "" : rawApIp,
          baseMac: /^0{1,2}[:\-.]0{1,2}[:\-.]0{1,2}[:\-.]0{1,2}[:\-.]0{1,2}[:\-.]0{1,2}[:\-.]0{1,2}$/i.test(rawApMac) ? "" : rawApMac,
          status: ap.status || ap.state || "",
          osVersion: ap.version || ap.firmware_version || "",
        });
        apCount++;
      }
    }
    log("discover.fortiaps", "info", `${deviceHostname}: Found ${apCount} managed FortiAP(s)`, deviceHostname);
  } catch (err: any) {
    const isNotFound = err instanceof AppError && err.httpStatus === 404;
    log("discover.fortiaps", isNotFound ? "info" : "error", `${deviceHostname}: ${isNotFound ? "wifi/managed_ap not available — skipping" : `Failed to query managed FortiAPs — ${err.message || "Unknown error"}`}`, deviceHostname);
  }

  // Step 3e.5: FortiAP → FortiSwitch port mapping via detected-device MAC table
  try {
    const detected = await fgRequest<any[]>(config, "GET", "/api/v2/monitor/switch-controller/detected-device", {
      query: { ...queryBase, format: "mac|switch_id|port_name|vlan_id|last_seen" },
      signal,
    });
    if (Array.isArray(detected)) {
      const macMap = new Map<string, { switchId: string; portName: string; vlan?: number }>();
      for (const d of detected) {
        const mac = String(d.mac || "").toUpperCase().replace(/-/g, ":");
        if (!mac) continue;
        if (!macMap.has(mac)) {
          macMap.set(mac, {
            switchId: String(d.switch_id || ""),
            portName: String(d.port_name || ""),
            vlan: Number.isFinite(d.vlan_id) ? Number(d.vlan_id) : undefined,
          });
        }
      }
      let pairedCount = 0;
      for (const ap of fortiAps) {
        if (!ap.baseMac) continue;
        const norm = ap.baseMac.toUpperCase().replace(/-/g, ":");
        const hit = macMap.get(norm);
        if (hit) {
          ap.peerSwitch = hit.switchId;
          ap.peerPort = hit.portName;
          ap.peerVlan = hit.vlan;
          pairedCount++;
        }
      }
      log("discover.ap-uplinks", "info", `${deviceHostname}: Resolved ${pairedCount}/${fortiAps.length} AP→switch-port uplinks`, deviceHostname);
    }
  } catch (err: any) {
    const isNotFound = err instanceof AppError && err.httpStatus === 404;
    log("discover.ap-uplinks", "info", `${deviceHostname}: ${isNotFound ? "detected-device not available — skipping" : `AP uplink query skipped — ${err.message || "Unknown error"}`}`, deviceHostname);
  }

  // Step 3e.6: Geo coordinates from `config system global`
  try {
    const sysGlobal = await fgRequest<any>(config, "GET", "/api/v2/cmdb/system/global", {
      query: { ...queryBase, format: "longitude|latitude|alias|hostname" },
      signal,
    });
    // CMDB single-object responses can come back either as a bare object or wrapped in results
    const globalObj = sysGlobal && typeof sysGlobal === "object" && !Array.isArray(sysGlobal)
      ? sysGlobal
      : null;
    if (globalObj) {
      const lat = parseFloat(String(globalObj.latitude ?? ""));
      const lng = parseFloat(String(globalObj.longitude ?? ""));
      if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0) && devices[0]) {
        devices[0].latitude = lat;
        devices[0].longitude = lng;
        log("discover.geo", "info", `${deviceHostname}: Resolved coordinates ${lat.toFixed(4)}, ${lng.toFixed(4)}`, deviceHostname);
      }
    }
  } catch (err: any) {
    log("discover.geo", "info", `${deviceHostname}: Geo lookup skipped — ${err.message || "Unknown error"}`, deviceHostname);
  }

  // Step 3f: Firewall VIPs
  try {
    const vipData = await fgRequest<any[]>(config, "GET", "/api/v2/cmdb/firewall/vip", { query: queryBase, signal });
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
    log("discover.vips", "info", `${deviceHostname}: Found ${vipCount} firewall VIP(s)`, deviceHostname);
  } catch (err: any) {
    log("discover.vips", "error", `${deviceHostname}: Failed to query firewall VIPs — ${err.message || "Unknown error"}`, deviceHostname);
  }

  // Filter
  const filteredSubnets = filterDhcpResults(discovered, config.dhcpInclude, config.dhcpExclude);
  const includedIfaceNames = new Set(filteredSubnets.map((s) => s.name));
  const filteredIps = interfaceIps.filter(
    (ip) => ip.role === "management" || includedIfaceNames.has(ip.interfaceName)
  );

  // Enrich inventory entries whose interfaceName is blank by matching them to DHCP
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

  const excludedIfaceNames = new Set(
    discovered.filter((s) => !filteredSubnets.includes(s)).map((s) => `${s.fortigateDevice}/${s.name}`)
  );
  const filteredInventory = deviceInventory.filter(
    (d) => !excludedIfaceNames.has(`${d.device}/${d.interfaceName}`) &&
           matchesInventoryFilter(d.interfaceName, config)
  );

  const excluded = discovered.length - filteredSubnets.length;
  log("discover.filter", "info", `Filter complete: ${filteredSubnets.length} subnet(s) included, ${excluded} excluded, ${dhcpEntries.length} DHCP entries, ${filteredInventory.length} inventory device(s)`);

  return {
    subnets: filteredSubnets,
    devices,
    interfaceIps: filteredIps,
    dhcpEntries,
    deviceInventory: filteredInventory,
    inventoryDevices: [...inventoryDevices],
    // Standalone FortiGate: the one device we connected to is the entire roster.
    knownDeviceNames: [deviceName],
    fortiSwitches,
    fortiAps,
    vips,
  };
}

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

function matchesInventoryFilter(interfaceName: string, config: FortiGateConfig): boolean {
  const includeList = config.inventoryIncludeInterfaces ?? [];
  const excludeList = config.inventoryExcludeInterfaces ?? [];

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
