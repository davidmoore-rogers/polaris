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
import { matchesWildcard } from "../utils/integrationFilter.js";
import { insecureTlsDispatcher } from "../utils/tlsDispatcher.js";
import { normalizeMacOrNull, normalizeMacsDistinct } from "../utils/mac.js";
import { parseRangeFirstIp, isValidIpv4 } from "../utils/cidr.js";
import { parseFortiapMonitorRow, FORTIAP_MONITOR_FORMAT } from "../utils/fortiapMonitorRow.js";
import type {
  DiscoveredSubnet,
  DiscoveredDevice,
  DiscoveredInterfaceIp,
  DiscoveredDhcpEntry,
  DiscoveredInventoryDevice,
  DiscoveredFortiSwitch,
  DiscoveredFortiAP,
  DiscoveredVip,
  DiscoveredSwitchMacEntry,
  DiscoveredArpEntry,
  DiscoveryResult,
  DiscoveryProgressCallback,
} from "./fortimanagerService.js";
import { parseVipServerInfo } from "./fortimanagerService.js";
import { findFortiswitchUplinkPorts } from "../utils/fortiswitchCmdb.js";
import { primeArpCache, ARP_SETTLE_MS } from "./arpPrimeService.js";

export interface FortiGateConfig {
  host: string;
  port?: number;
  apiUser: string;          // API admin username (optional; sent as X-Csrftoken-style header for parity with FMG)
  apiToken: string;         // Bearer token for authentication
  vdom?: string;            // Virtual Domain (default: "root")
  verifySsl?: boolean;      // Skip TLS verification (default: false)
  mgmtInterface?: string;
  interfaceInclude?: string[];  // Interfaces to include for non-DHCP interface IP discovery
  interfaceExclude?: string[];  // Interfaces to exclude. Ignored if interfaceInclude is non-empty.
  dhcpInclude?: string[];
  dhcpExclude?: string[];
  inventoryExcludeInterfaces?: string[];
  inventoryIncludeInterfaces?: string[];
  // ARP presence sweep targets (opt-in via Integration.config.arpPresenceSweep;
  // built by the caller from this device's active dhcp_reservation rows). When
  // non-empty, Chain D fires one fire-and-forget UDP datagram at each IP and
  // settles briefly BEFORE reading the ARP table, forcing the FortiGate to
  // ARP-resolve every reserved IP so live-but-quiet devices (statically
  // configured, ICMP-firewalled) land in the table. See arpPrimeService.ts.
  arpSweepIps?: string[];
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
 *
 * Method support: GET / POST / PUT / DELETE. POST and PUT may carry a JSON
 * body via `opts.body`; the body is JSON-stringified before send. GET and
 * DELETE ignore the body field. Used by reservation push to write
 * /api/v2/cmdb/system.dhcp/server/<id>/reserved-address.
 */
export async function fgRequest<T>(
  config: FortiGateConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const port = config.port || 443;
  const qs = new URLSearchParams(opts.query || {});
  const url = `https://${config.host}:${port}${path}${qs.toString() ? (path.includes("?") ? "&" : "?") + qs.toString() : ""}`;

  const controller = new AbortController();
  // Default 15s for discovery / push paths. Response-time probes pass their
  // resolved per-asset probeTimeoutMs (default 5000, range 100..60000) so a
  // wedged FortiOS box trips faster than the discovery default.
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiToken}`,
    };
    // Parity with FMG: forward the API user if provided. FortiOS ignores it,
    // but some admin/audit configurations log this header.
    if (config.apiUser) headers["access_user"] = config.apiUser;

    // verifySsl=false relaxes TLS for THIS connection only (undici
    // dispatcher) — never via the process-global NODE_TLS_REJECT_UNAUTHORIZED
    // flip, which raced the parallel per-device query chains.
    const init: RequestInit & { dispatcher?: ReturnType<typeof insecureTlsDispatcher> } = {
      method,
      headers,
      signal: controller.signal,
      ...(config.verifySsl === false ? { dispatcher: insecureTlsDispatcher() } : {}),
    };
    if (opts.body !== undefined && (method === "POST" || method === "PUT")) {
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, init);

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
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  query?: Record<string, string>,
  body?: unknown,
): Promise<unknown> {
  return fgRequest(config, method, path, { query, body });
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/**
 * Read the switch-controller managed-switch CMDB and return a map of switch
 * serial (UPPERCASE) → CMDB metadata: the single physical uplink port to the
 * FortiGate (e.g. "port47") and the operator-set admin description. The
 * status endpoint discovery already queries only exposes the FortiGate-side
 * logical interface ("fortilink"); the physical uplink port lives in the
 * CMDB. Switches with zero (chained behind another switch over ISL) or more
 * than one (dual-homed, ambiguous) uplink port get uplinkPort null — the
 * FG↔switch edge label falls back to LLDP for those. The description carries
 * a:/b:/f:/r:/jb: location codes for the Device Map (utils/locationCodes.ts).
 * Best-effort: any failure yields an empty map.
 */
async function fetchFortiswitchCmdbMeta(
  config: FortiGateConfig,
  queryBase: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Map<string, { uplinkPort: string | null; description: string | null }>> {
  const out = new Map<string, { uplinkPort: string | null; description: string | null }>();
  try {
    const rows = await fgRequest<any[]>(config, "GET", "/api/v2/cmdb/switch-controller/managed-switch", {
      query: { ...queryBase, datasource: "1" },
      signal,
    });
    if (!Array.isArray(rows)) return out;
    for (const row of rows) {
      const serial = String(row?.sn || row?.["switch-id"] || row?.name || "").trim();
      if (!serial) continue;
      const uplinks = findFortiswitchUplinkPorts(row?.ports);
      const desc = typeof row?.description === "string" ? row.description.trim() : "";
      out.set(serial.toUpperCase(), {
        uplinkPort: uplinks.length === 1 ? uplinks[0] : null,
        description: desc || null,
      });
    }
  } catch { /* best-effort — leave uplinkPhysicalPort/description null, fall back to LLDP */ }
  return out;
}

/**
 * Read the wireless-controller wtp CMDB and return a map of AP serial
 * (UPPERCASE) → operator-set admin description. The description surface is
 * the wtp `location` field (AP Manager's field, 35-char cap — the same
 * field description sync pushes to), with `comment` as fallback for rows
 * that only carry the legacy field; the managed_ap monitor endpoint carries
 * neither. Same role as the managed-switch description above:
 * a:/b:/f:/r:/jb: location codes for the Device Map. Best-effort: a 404
 * (older FortiOS / wireless-controller disabled) or any other failure
 * yields an empty map and never fails discovery. Mirrors the FMG path's
 * wtp CMDB roster read (Step 3d.4).
 */
async function fetchFortiapDescriptions(
  config: FortiGateConfig,
  queryBase: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const rows = await fgRequest<any[]>(config, "GET", "/api/v2/cmdb/wireless-controller/wtp", {
      query: { ...queryBase, datasource: "1" },
      signal,
    });
    if (!Array.isArray(rows)) return out;
    for (const row of rows) {
      const serial = String(row?.["wtp-id"] || "").trim();
      if (!serial) continue;
      const location = typeof row?.location === "string" ? row.location.trim() : "";
      const comment = typeof row?.comment === "string" ? row.comment.trim() : "";
      const description = location || comment;
      if (description) out.set(serial.toUpperCase(), description);
    }
  } catch { /* best-effort — leave AP descriptions null */ }
  return out;
}

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
  skipGeoLog = false,
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
  const switchMacTable: DiscoveredSwitchMacEntry[] = [];
  const arpTable: DiscoveredArpEntry[] = [];
  // "Did the inventory query land successfully?" flags — see fortimanagerService
  // for why we track these separately from the result arrays. A 404 (feature
  // not licensed) counts as success because the controller is reachable.
  let didSwitchQuery = false;
  let didApQuery = false;
  // Same pattern for the authoritative-source queries — Phase 5b in
  // syncDhcpSubnets uses these to scope its stale-row sweep. A failed
  // VIP or DHCP CMDB query must NOT cause Polaris to release rows we
  // haven't actually heard the gate disclaim.
  let didVipQuery = false;
  let didDhcpReservationsQuery = false;
  let didDhcpLeasesQuery = false;

  // Step 2: Resolve the FortiGate's management interface IP from its own config.
  // We don't know its mgmt IP from /sys/status; fall back to the host we connected to.
  const mgmtIfaceName = config.mgmtInterface || "mgmt";
  let mgmtIp: string | null = null;
  // MAC of the management interface (scalar identity) plus EVERY physical
  // interface's MAC. A peer FortiGate can sight this firewall in its ARP /
  // device-inventory table on any interface, not just the one bearing the mgmt
  // IP — so we capture them all and index the firewall by all of them, which
  // is the only way to reliably stop a duplicate `fortigate-endpoint` ghost.
  // Read off the same /system/interface query (fetch all, no name filter);
  // loopback / tunnel interfaces report all-zero MACs and are dropped by
  // normalizeMacsDistinct.
  let mgmtMac: string | null = null;
  let interfaceMacs: string[] = [];
  try {
    const ifaceList = await fgRequest<any[]>(config, "GET", "/api/v2/cmdb/system/interface", {
      query: { ...queryBase },
      signal,
    });
    if (Array.isArray(ifaceList) && ifaceList.length > 0) {
      const mgmtIface = ifaceList.find((i) => i?.name === mgmtIfaceName);
      if (mgmtIface) {
        const rawIp = Array.isArray(mgmtIface.ip)
          ? mgmtIface.ip[0]
          : (typeof mgmtIface.ip === "string" ? mgmtIface.ip.split(" ")[0] : "");
        if (rawIp && rawIp !== "0.0.0.0" && isValidIpv4(rawIp)) {
          mgmtIp = rawIp;
          log("discover.device.mgmtip", "info", `${deviceHostname}: Resolved management IP from ${mgmtIfaceName}: ${rawIp}`, deviceHostname);
        }
        mgmtMac = normalizeMacOrNull(typeof mgmtIface.macaddr === "string" ? mgmtIface.macaddr : null);
      }
      interfaceMacs = normalizeMacsDistinct(ifaceList.map((i) => (typeof i?.macaddr === "string" ? i.macaddr : null)));
    }
  } catch { /* best-effort */ }

  // If we couldn't resolve the management interface, fall back to the config host
  if (!mgmtIp && isValidIpv4(config.host)) {
    mgmtIp = config.host;
  }

  // Geo coordinates from `config system global` (parity with FMG's CMDB read at
  // fortimanagerService.ts: `/pm/config/device/<name>/global/system/global`).
  // Drives Device Map pin placement; without this the standalone path leaves
  // latitude/longitude null and the projection layer can't write them back to
  // the Asset row.
  let deviceLatitude: number | undefined;
  let deviceLongitude: number | undefined;
  try {
    const sysGlobal = await fgRequest<any>(config, "GET", "/api/v2/cmdb/system/global", {
      query: { ...queryBase, format: "gui-device-latitude|gui-device-longitude|latitude|longitude" },
      signal,
    });
    const g = sysGlobal && typeof sysGlobal === "object" && !Array.isArray(sysGlobal) ? sysGlobal : {};
    const lat = parseFloat(String(g["gui-device-latitude"] ?? g.latitude ?? ""));
    const lng = parseFloat(String(g["gui-device-longitude"] ?? g.longitude ?? ""));
    if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
      deviceLatitude = lat;
      deviceLongitude = lng;
      if (!skipGeoLog) {
        log("discover.geo", "info", `${deviceHostname}: Resolved coordinates from CMDB: ${lat.toFixed(4)}, ${lng.toFixed(4)}`, deviceHostname);
      }
    } else if (!skipGeoLog) {
      log("discover.geo", "info", `${deviceHostname}: No latitude/longitude in CMDB system/global — set them in System → Settings → Device Geographical Location`, deviceHostname);
    }
  } catch (err: any) {
    if (!skipGeoLog) {
      log("discover.geo", "info", `${deviceHostname}: Geo lookup skipped — ${err.message || "Unknown error"}`, deviceHostname);
    }
  }

  devices.push({
    name: deviceName,
    hostname: deviceHostname,
    serial: deviceSerial,
    model: deviceModel,
    mgmtIp: mgmtIp || "",
    osVersion: deviceOsVersion,
    ...(mgmtMac ? { mgmtMac } : {}),
    ...(interfaceMacs.length ? { interfaceMacs } : {}),
    ...(deviceLatitude !== undefined && deviceLongitude !== undefined
      ? { latitude: deviceLatitude, longitude: deviceLongitude }
      : {}),
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
    return { subnets: [], devices, interfaceIps, dhcpEntries: [], deviceInventory: [], inventoryDevices: [], knownDeviceNames: [deviceName], fortiSwitches: [], fortiAps: [], vips: [], switchMacTable: [], arpTable: [], cmdbSwitchSerials: [], cmdbApSerials: [], switchInventoriedDevices: [], apInventoriedDevices: [] };
  }

  // Hoisted: dhcpInterfaceNames is built in Step 3 and read both by Step 3b
  // (VLAN tagging on subnets) and the post-discovery filter logic at line
  // ~779. Keep its declaration outside the Promise.all chain so all readers
  // share the same array regardless of which chain populated it.
  const dhcpInterfaceNames: string[] = [];
  const configResStart = dhcpEntries.length;

  // Fan out the seven independent per-FortiGate query chains in parallel.
  // Inside each chain, steps stay sequential where they share state:
  //   Chain A:  Step 3 (DHCP CMDB) → Promise.all(Step 3a + Step 3b)
  //   Chain B:  Step 3c    (device inventory)
  //   Chain C:  Step 3d (managed switches) → Step 3e (APs) → Step 3e.5 (port map)
  //   Chain D:  Step 3e.55 (ARP table)
  //   Chain E:  Step 3e.6  (geo coordinates)
  //   Chain F:  Step 3f    (firewall VIPs)
  //   Chain G:  Step 3g    (HA peer roster)
  // Per-FortiGate wall-clock drops from sum-of-all to max(any chain). Peak
  // intra-device REST concurrency is ~7 simultaneous calls; small-branch
  // FortiGates (60F/61F class) handle this in practice, and the existing
  // per-step try/catch isolates a slow individual query from tanking the
  // whole device's discovery.
  await Promise.all([
    // ─── Chain A: DHCP CMDB → DHCP monitor + interface IPs in parallel ───
    (async () => {
      // Step 3: DHCP server configuration
      try {
        const dhcpData = await fgRequest<any[]>(config, "GET", "/api/v2/cmdb/system.dhcp/server", { query: queryBase, signal });
    // CMDB query succeeded — used by syncDhcpSubnets Phase 5b to scope
    // the stale dhcp_reservation sweep. Empty-result success (no DHCP
    // servers configured) still counts: that's the gate saying it has
    // no reservations, which is exactly when previously-known ones
    // should be released.
    didDhcpReservationsQuery = true;
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
            const numericScopeId = typeof server.id === "number" ? server.id : Number(server.id);
            const numericEntryId = typeof entry.id === "number" ? entry.id : Number(entry.id);
            dhcpEntries.push({
              device: deviceName,
              interfaceName: iface || `dhcp-${serverId}`,
              ipAddress: rIp,
              macAddress: rMac,
              hostname: entry.description || "",
              type: "dhcp-reservation",
              scopeId: Number.isFinite(numericScopeId) ? numericScopeId : undefined,
              entryId: Number.isFinite(numericEntryId) ? numericEntryId : undefined,
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

      // ── Inside Chain A: 3a (live monitor) + 3b (interfaces) run in
      // parallel once Step 3 has populated `discovered` + `dhcpInterfaceNames`.
      await Promise.all([
        // Step 3a: Live DHCP table (reservations + leases) via monitor endpoint
        (async () => {
          try {
            const leases = await fgRequest<any[]>(config, "GET", "/api/v2/monitor/system/dhcp", {
      query: { ...queryBase, format: "ip|mac|hostname|interface|reserved|expire_time|access_point|ssid|vci" },
      signal,
    });
    didDhcpLeasesQuery = true;

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

    // Merge monitor data INTO the CMDB-derived list rather than wiping it.
    // /api/v2/monitor/system/dhcp only returns reservations whose target client
    // is currently online and holding a lease. Static reservations whose
    // target is offline are in CMDB but not in monitor; wiping the CMDB list
    // would silently drop them. CMDB is the base set; monitor adds new IPs
    // (live leases) and stamps `seenLeased=true` on overlapping CMDB entries
    // so the stale-reservation job can tell which static reservations have
    // ever been seen actively held by their target.

    let deviceEntryCount = 0;
    for (const lease of flatLeases) {
      const leaseIp = lease.ip;
      const leaseMac = lease.mac || "";
      let leaseIface = lease.interface || lease._serverIface || "";
      if (!leaseIp || leaseIp === "0.0.0.0") continue;

      const existingIdx = dhcpEntries.findIndex((e) => e.ipAddress === leaseIp && e.device === deviceName);
      if (existingIdx >= 0) {
        // CMDB already has this static reservation — mark it as currently
        // leased so the stale job knows the target has been seen online.
        dhcpEntries[existingIdx].seenLeased = true;
        continue;
      }

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
        // Monitor confirms the IP is being actively leased by a client right
        // now — enables the stale-reservation job's "still online" signal.
        seenLeased: true,
      });
      deviceEntryCount++;
    }
    log("discover.leases", "info", `${deviceHostname}: Found ${deviceEntryCount} DHCP entry/entries from monitor`, deviceHostname);
  } catch (err: any) {
    log("discover.leases", "error", `${deviceHostname}: Failed to query DHCP monitor — ${err.message || "Unknown error"}`, deviceHostname);
  }
        })(),
        // Step 3b: Interface IPs + VLAN IDs
        // Walk every interface (not just DHCP-bound ones) so WAN / non-RFC1918
        // addresses also flow into Asset.associatedIps via Phase 4b. The mgmt
        // interface is already pushed above as role:"management"; everything
        // else passes the same interfaceInclude/interfaceExclude filter the FMG
        // proxy path applies, and lands as role:"interface".
        (async () => {
          try {
            const ifaceData = await fgRequest<any[]>(config, "GET", "/api/v2/cmdb/system/interface", { query: queryBase, signal });
    const ifaceVlanMap = new Map<string, number>();
    let ifaceIpCount = 0;
    let secondaryIpCount = 0;
    if (Array.isArray(ifaceData)) {
      const parseVid = (v: unknown): number => {
        const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
        return !isNaN(n) && n > 0 ? n : 0;
      };
      for (const iface of ifaceData) {
        const ifaceName = iface.name || "";
        const vid = parseVid(iface.vlanid) || parseVid(iface["switch-controller-mgmt-vlan"]);
        if (vid > 0) ifaceVlanMap.set(ifaceName, vid);

        if (!ifaceName) continue;
        if (ifaceName === mgmtIfaceName) continue;
        if (!matchesInterfaceFilter(ifaceName, config)) continue;

        const rawIp = Array.isArray(iface.ip)
          ? iface.ip[0]
          : (typeof iface.ip === "string" ? iface.ip.split(" ")[0] : "");
        if (rawIp && rawIp !== "0.0.0.0" && isValidIpv4(rawIp)) {
          interfaceIps.push({
            device: deviceName,
            interfaceName: ifaceName,
            ipAddress: rawIp,
            role: "interface",
          });
          ifaceIpCount++;
        }
        // Secondary IPs: nested mkey table on the interface. Each row carries
        // its own `ip` in either "x.x.x.x y.y.y.y" string form or as a [ip,
        // mask] array. Push one DiscoveredInterfaceIp per entry with
        // role="secondary" so Phase 4 labels the reservation appropriately.
        const secondaries = iface["secondary-ip"];
        if (Array.isArray(secondaries)) {
          for (const sec of secondaries) {
            const rawSec = Array.isArray(sec?.ip)
              ? (sec.ip[0] || "")
              : (typeof sec?.ip === "string" ? sec.ip.split(" ")[0] : "");
            if (rawSec && rawSec !== "0.0.0.0" && isValidIpv4(rawSec)) {
              interfaceIps.push({
                device: deviceName,
                interfaceName: ifaceName,
                ipAddress: rawSec,
                role: "secondary",
              });
              secondaryIpCount++;
            }
          }
        }
      }
    }

    for (const sub of discovered) {
      const vid = ifaceVlanMap.get(sub.name);
      if (vid) sub.vlan = vid;
    }
    log("discover.interfaces", "info", `${deviceHostname}: Resolved ${ifaceIpCount} interface IP(s)${secondaryIpCount > 0 ? ` + ${secondaryIpCount} secondary IP(s)` : ""}`, deviceHostname);
  } catch (err: any) {
    log("discover.interfaces", "error", `${deviceHostname}: Failed to query interfaces — ${err.message || "Unknown error"}`, deviceHostname);
  }
        })(),
      ]); // end Promise.all([Step 3a, Step 3b])
    })(), // end Chain A
    // ─── Chain B: Device inventory ───────────────────────────────────────
    (async () => {
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
    })(), // end Chain B
    // ─── Chain C: Switches → APs → AP-port mapping (serial intra-chain) ──
    (async () => {
      // Step 3d: Managed FortiSwitches
      try {
        const swResults = await fgRequest<any[]>(config, "GET", "/api/v2/monitor/switch-controller/managed-switch/status", {
          query: { ...queryBase, format: "connecting_from|fgt_peer_intf_name|join_time|os_version|serial|switch-id|state|status" },
          signal,
        });
    didSwitchQuery = true;
    // Switch-side physical uplink ports + admin descriptions come from the
    // managed-switch CMDB (the status endpoint only carries
    // fgt_peer_intf_name = "fortilink"). One extra read per controller per
    // run; serial → single uplink port (skip ambiguous multi-uplink switches,
    // leaving those to LLDP) + description (location codes). Best-effort: a
    // failure just leaves both null and the FG↔switch edge falls back.
    const cmdbMetaBySerial = await fetchFortiswitchCmdbMeta(config, queryBase, signal);
    let switchCount = 0;
    if (Array.isArray(swResults)) {
      for (const sw of swResults) {
        const cmdbMeta = cmdbMetaBySerial.get((sw.serial || "").toUpperCase());
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
          uplinkPhysicalPort: cmdbMeta?.uplinkPort ?? null,
          description: cmdbMeta?.description ?? null,
        });
        switchCount++;
      }
    }
    log("discover.fortiswitches", "info", `${deviceHostname}: Found ${switchCount} managed FortiSwitch(es)`, deviceHostname);
  } catch (err: any) {
    // 404 means switch-controller not licensed/available — downgrade to info.
    // Treat 404 as "query succeeded with empty result" so the decommission
    // sweep can act on stale switches behind this controller.
    const isNotFound = err instanceof AppError && err.httpStatus === 404;
    if (isNotFound) didSwitchQuery = true;
    log("discover.fortiswitches", isNotFound ? "info" : "error", `${deviceHostname}: ${isNotFound ? "switch-controller not available — skipping" : `Failed to query managed FortiSwitches — ${err.message || "Unknown error"}`}`, deviceHostname);
  }

  // Step 3e: Managed FortiAPs
  try {
    const apResults = await fgRequest<any[]>(config, "GET", "/api/v2/monitor/wifi/managed_ap", {
      query: { ...queryBase, format: FORTIAP_MONITOR_FORMAT },
      signal,
    });
    didApQuery = true;
    let apCount = 0;
    if (Array.isArray(apResults)) {
      // AP admin descriptions live in the wtp CMDB (`location`, `comment`
      // fallback), not the monitor endpoint — one extra best-effort read per run.
      const descriptionBySerial = await fetchFortiapDescriptions(config, queryBase, signal);
      for (const ap of apResults) {
        // Shared parser — same shape across FMG proxy and standalone
        // FortiGate REST paths. See utils/fortiapMonitorRow.ts.
        const parsed = parseFortiapMonitorRow(ap as Record<string, unknown>);
        fortiAps.push({
          device: deviceName,
          ...parsed,
          description: descriptionBySerial.get((parsed.serial || "").toUpperCase()) ?? null,
        });
        apCount++;
      }
    }
    log("discover.fortiaps", "info", `${deviceHostname}: Found ${apCount} managed FortiAP(s)`, deviceHostname);
  } catch (err: any) {
    const isNotFound = err instanceof AppError && err.httpStatus === 404;
    if (isNotFound) didApQuery = true;
    log("discover.fortiaps", isNotFound ? "info" : "error", `${deviceHostname}: ${isNotFound ? "wifi/managed_ap not available — skipping" : `Failed to query managed FortiAPs — ${err.message || "Unknown error"}`}`, deviceHostname);
  }

  // Step 3e.5: FortiAP → FortiSwitch port mapping via detected-device MAC table
  try {
    const detected = await fgRequest<any[]>(config, "GET", "/api/v2/monitor/switch-controller/detected-device", {
      query: { ...queryBase, format: "mac|switch_id|port_name|vlan_id|last_seen|ipv4_address|ipv6_address|device_name|host_src|device_type|os_name|is_fortilink_peer" },
      signal,
    });
    if (Array.isArray(detected)) {
      const macMap = new Map<string, { switchId: string; portName: string; vlan?: number }>();
      // FortiLink-peer rows carry each managed FortiSwitch's own
      // management MAC, keyed on switch_id. Used below to stamp baseMac
      // onto every DiscoveredFortiSwitch in fortiSwitches.
      const switchMacByName = new Map<string, string>();
      for (const d of detected) {
        const mac = String(d.mac || "").toUpperCase().replace(/-/g, ":");
        if (!mac) continue;
        const switchId = String(d.switch_id || "");
        const portName = String(d.port_name || "");
        const vlanId = Number.isFinite(d.vlan_id) ? Number(d.vlan_id) : undefined;
        const isFortilinkPeer = d.is_fortilink_peer === true || d.is_fortilink_peer === 1;
        if (isFortilinkPeer && switchId && !switchMacByName.has(switchId)) {
          switchMacByName.set(switchId, mac);
        }
        // Surface every learned MAC to the sync layer for endpoint-asset
        // attribution (mirrors the fortimanagerService implementation).
        switchMacTable.push({
          fortigateDevice: deviceName,
          switchId,
          portName,
          mac,
          vlanId,
          lastSeen: Number.isFinite(d.last_seen) ? Number(d.last_seen) : undefined,
          ipv4Address: typeof d.ipv4_address === "string" && d.ipv4_address ? d.ipv4_address : undefined,
          ipv6Address: typeof d.ipv6_address === "string" && d.ipv6_address ? d.ipv6_address : undefined,
          deviceName: typeof d.device_name === "string" && d.device_name ? d.device_name : undefined,
          deviceType: typeof d.device_type === "string" && d.device_type ? d.device_type : undefined,
          osName: typeof d.os_name === "string" && d.os_name ? d.os_name : undefined,
          hostSrc: typeof d.host_src === "string" && d.host_src ? d.host_src : undefined,
          isFortilinkPeer,
        });
        if (!macMap.has(mac)) {
          macMap.set(mac, { switchId, portName, vlan: vlanId });
        }
      }
      let pairedCount = 0;
      let lldpAlreadyCount = 0;
      for (const ap of fortiAps) {
        // Skip APs already resolved via LLDP — see fortimanagerService for
        // the rationale (LLDP is authoritative; detected-device may filter
        // managed-AP MACs out on some FortiOS releases).
        if (ap.peerSource === "lldp") {
          lldpAlreadyCount++;
          continue;
        }
        // Mesh leaf — a switch seeing this AP's MAC is bridged behind the AP,
        // not its uplink. Mirrors the fortimanagerService skip.
        if (ap.meshUplink === "mesh") continue;
        if (!ap.baseMac) continue;
        const norm = ap.baseMac.toUpperCase().replace(/-/g, ":");
        const hit = macMap.get(norm);
        if (hit) {
          ap.peerSwitch = hit.switchId;
          ap.peerPort = hit.portName;
          ap.peerVlan = hit.vlan;
          ap.peerSource = "detected-device";
          pairedCount++;
        }
      }
      const totalResolved = pairedCount + lldpAlreadyCount;
      log("discover.ap-uplinks", "info", `${deviceHostname}: Resolved ${totalResolved}/${fortiAps.length} AP→switch-port uplinks (${lldpAlreadyCount} via LLDP, ${pairedCount} via detected-device)`, deviceHostname);

      // Stamp each managed FortiSwitch's management MAC onto its
      // DiscoveredFortiSwitch entry using the FortiLink-peer rows
      // collected above. Lets the sync layer dedup against
      // DHCP/ARP-discovered orphan endpoint assets at the switch's
      // mgmt IP.
      let switchMacResolved = 0;
      for (const sw of fortiSwitches) {
        if (sw.device !== deviceName || !sw.name) continue;
        const mac = switchMacByName.get(sw.name);
        if (mac) {
          sw.baseMac = mac;
          switchMacResolved++;
        }
      }
      if (switchMacByName.size > 0) {
        log("discover.fortiswitches.mac", "info", `${deviceHostname}: Resolved ${switchMacResolved} FortiSwitch base MAC(s) from detected-device fortilink-peer rows`, deviceHostname);
      }
    }
  } catch (err: any) {
    const isNotFound = err instanceof AppError && err.httpStatus === 404;
    log("discover.ap-uplinks", "info", `${deviceHostname}: ${isNotFound ? "detected-device not available — skipping" : `AP uplink query skipped — ${err.message || "Unknown error"}`}`, deviceHostname);
  }
    })(), // end Chain C
    // ─── Chain D: ARP table ──────────────────────────────────────────────
    (async () => {
      // Step 3e.54: ARP presence sweep (opt-in). Prime the gate's ARP cache
      // for every reserved IP, then settle briefly so resolutions land
      // before the table read below. Sweep targets come from the caller
      // (Polaris reservation rows) rather than Chain A's DHCP data — the
      // chains run in parallel, so Chain A's entries aren't ready here.
      if (config.arpSweepIps?.length && !signal?.aborted) {
        const { sent, dropped } = await primeArpCache(config.arpSweepIps);
        if (sent > 0) {
          log("discover.arp", "info", `${deviceHostname}: ARP presence sweep — probed ${sent} reserved IP(s)${dropped > 0 ? ` (${dropped} over cap, skipped)` : ""}`, deviceHostname);
          await new Promise((resolve) => setTimeout(resolve, ARP_SETTLE_MS));
        }
      }
      // Step 3e.55: FortiGate ARP table (mirrors fortimanagerService).
      try {
        const arpResults = await fgRequest<any[]>(config, "GET", "/api/v2/monitor/network/arp", {
          query: queryBase,
          signal,
        });
    if (Array.isArray(arpResults)) {
      for (const a of arpResults) {
        const ip = typeof a.ip === "string" ? a.ip.trim() : "";
        const macRaw = typeof a.mac === "string" ? a.mac.trim() : "";
        if (!ip || !macRaw) continue;
        const mac = macRaw.toUpperCase().replace(/-/g, ":");
        if (mac === "00:00:00:00:00:00" || mac === "FF:FF:FF:FF:FF:FF") continue;
        arpTable.push({
          fortigateDevice: deviceName,
          ip,
          mac,
          interface: typeof a.interface === "string" ? a.interface : "",
          age: Number.isFinite(a.age) ? Number(a.age) : undefined,
        });
      }
      log("discover.arp", "info", `${deviceHostname}: ARP table — ${arpTable.length} entries`, deviceHostname);
    }
  } catch (err: any) {
    const isNotFound = err instanceof AppError && err.httpStatus === 404;
    log("discover.arp", "info", `${deviceHostname}: ${isNotFound ? "ARP endpoint not available — skipping" : `ARP query skipped — ${err.message || "Unknown error"}`}`, deviceHostname);
  }
    })(), // end Chain D
    // ─── Chain E: Geo coordinates ────────────────────────────────────────
    (async () => {
      // Step 3e.6: Geo coordinates from `config system global`.
      // CMDB endpoints use `?fields=` (not `?format=`, which is monitor-only).
      // Dropping the filter entirely — the full system/global object is small,
      // and pulling every key means we log them when lat/lng are absent so the
      // operator can see exactly where the gate does (or doesn't) store coords.
      try {
        const sysGlobal = await fgRequest<any>(config, "GET", "/api/v2/cmdb/system/global", {
          query: queryBase,
      signal,
    });
    const globalObj = sysGlobal && typeof sysGlobal === "object" && !Array.isArray(sysGlobal)
      ? sysGlobal
      : null;
    if (globalObj && devices[0]) {
      const lat = parseFloat(String(globalObj["gui-device-latitude"] ?? globalObj.latitude ?? ""));
      const lng = parseFloat(String(globalObj["gui-device-longitude"] ?? globalObj.longitude ?? ""));
      if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
        devices[0].latitude = lat;
        devices[0].longitude = lng;
        if (!skipGeoLog) {
          log("discover.geo", "info", `${deviceHostname}: Resolved coordinates ${lat.toFixed(4)}, ${lng.toFixed(4)}`, deviceHostname);
        }
      } else {
        const keys = Object.keys(globalObj).slice(0, 30).join(", ");
        log("discover.geo", "info", `${deviceHostname}: No latitude/longitude in system/global (keys: ${keys || "(empty)"})`, deviceHostname);
      }
    }
  } catch (err: any) {
    log("discover.geo", "info", `${deviceHostname}: Geo lookup skipped — ${err.message || "Unknown error"}`, deviceHostname);
  }
    })(), // end Chain E
    // ─── Chain F: Firewall VIPs ──────────────────────────────────────────
    (async () => {
      // Step 3f: Firewall VIPs
      try {
        const vipData = await fgRequest<any[]>(config, "GET", "/api/v2/cmdb/firewall/vip", { query: queryBase, signal });
    didVipQuery = true;
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

        const { isVirtualServer, realservers } = parseVipServerInfo(vip);
        vips.push({
          device: deviceName,
          name,
          extip,
          mappedips,
          extintf: vip.extintf || "",
          isVirtualServer,
          realservers,
        });
        vipCount++;
      }
    }
    log("discover.vips", "info", `${deviceHostname}: Found ${vipCount} firewall VIP(s)`, deviceHostname);
  } catch (err: any) {
    log("discover.vips", "error", `${deviceHostname}: Failed to query firewall VIPs — ${err.message || "Unknown error"}`, deviceHostname);
  }
    })(), // end Chain F
    // ─── Chain G: HA peer info ──────────────────────────────────────────
    // GET /api/v2/monitor/system/ha-peer returns the calling unit's serial
    // plus each peer member. Standalone (non-HA) gates return 404 or empty
    // results — both are normalized to `haMode: "standalone"` so downstream
    // code has a single branch. The "current primary" member's serial is the
    // calling unit (we only reach this REST endpoint via the cluster IP,
    // which always routes to whichever member is currently active).
    (async () => {
      try {
        const haPeer = await fgRequest<any>(config, "GET", "/api/v2/monitor/system/ha-peer", { query: queryBase, signal });
        // Response envelope varies across FortiOS versions: sometimes
        // { serial_no, results: [...] }, sometimes a bare array. Normalize.
        const callerSerial: string = String(haPeer?.serial_no || haPeer?.serial || deviceSerial || "");
        const rawPeers: any[] = Array.isArray(haPeer?.results)
          ? haPeer.results
          : Array.isArray(haPeer)
            ? haPeer
            : [];
        const peerMembers = rawPeers
          .map((p) => ({
            serial: String(p.serial_no || p.serial || ""),
            name: typeof p.hostname === "string" && p.hostname.length > 0 ? p.hostname : undefined,
            priority: Number.isFinite(p.priority) ? Number(p.priority) : undefined,
            isPrimary: false as const,
            // ha-peer only lists members currently participating in the
            // cluster — being listed IS the health signal (a dead standby
            // drops out of the roster and falls to the Phase 2a stale-
            // firewall sweep). FMG's ha_slave[].status carries the richer
            // present-but-failed state; FortiOS REST has no equivalent here.
            status: "up" as const,
          }))
          .filter((p) => p.serial && p.serial !== callerSerial);
        if (callerSerial && peerMembers.length > 0 && devices[0]) {
          devices[0].haMode = "a-p";
          devices[0].haMembers = [
            { serial: callerSerial, name: deviceHostname || undefined, isPrimary: true, status: "up" },
            ...peerMembers,
          ];
          log("discover.ha", "info", `${deviceHostname}: HA cluster — ${devices[0].haMembers.length} member(s), primary=${callerSerial}`, deviceHostname);
        } else if (devices[0]) {
          devices[0].haMode = "standalone";
          log("discover.ha", "info", `${deviceHostname}: not in HA cluster`, deviceHostname);
        }
      } catch (err: any) {
        // 404 = HA endpoint not available on this FortiOS build, OR the device
        // is genuinely standalone (some builds 404 instead of returning empty).
        // Both treated as standalone so the downstream sync doesn't fork.
        const isNotFound = err instanceof AppError && err.httpStatus === 404;
        if (isNotFound && devices[0]) {
          devices[0].haMode = "standalone";
          log("discover.ha", "info", `${deviceHostname}: not in HA cluster (ha-peer endpoint unavailable)`, deviceHostname);
        } else {
          log("discover.ha", "info", `${deviceHostname}: HA query skipped — ${err.message || "Unknown error"}`, deviceHostname);
        }
      }
    })(), // end Chain G
  ]); // end Promise.all of 7 per-FortiGate query chains

  // Filter
  const filteredSubnets = filterDhcpResults(discovered, config.dhcpInclude, config.dhcpExclude);
  const includedIfaceNames = new Set(filteredSubnets.map((s) => s.name));
  // Drop interface IPs whose DHCP scope was filtered out by dhcpInclude/exclude,
  // but always keep mgmt and any interface that isn't DHCP-bound (those aren't
  // subject to the DHCP filter — they were collected for associatedIps purposes).
  const dhcpInterfaceNameSet = new Set(dhcpInterfaceNames);
  const filteredIps = interfaceIps.filter((ip) => {
    if (ip.role === "management") return true;
    if (dhcpInterfaceNameSet.has(ip.interfaceName)) return includedIfaceNames.has(ip.interfaceName);
    return true;
  });

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
    switchMacTable,
    arpTable,
    // Standalone FortiGate: the live monitor/switch-controller/managed-switch/
    // status query already returns disconnected switches with status="Disconnected"
    // (the FortiGate is its own CMDB and live source), so the CMDB roster
    // is redundant here. We surface empty arrays to satisfy the shared
    // DiscoveryResult shape; FMG mode uses the dedicated CMDB queries.
    cmdbSwitchSerials: [],
    cmdbApSerials: [],
    switchInventoriedDevices: didSwitchQuery ? [deviceName] : [],
    apInventoriedDevices:     didApQuery     ? [deviceName] : [],
    vipInventoriedDevices:                 didVipQuery                 ? [deviceName] : [],
    dhcpReservationsInventoriedDevices:    didDhcpReservationsQuery    ? [deviceName] : [],
    dhcpLeasesInventoriedDevices:          didDhcpLeasesQuery          ? [deviceName] : [],
  };
}


// matchesWildcard is imported from ../utils/integrationFilter.js — the
// canonical glob-lite matcher shared by every device/VM/interface filter.

function matchesInterfaceFilter(interfaceName: string, config: FortiGateConfig): boolean {
  const includeList = config.interfaceInclude ?? [];
  const excludeList = config.interfaceExclude ?? [];
  if (includeList.length > 0) return includeList.some((p) => matchesWildcard(p, interfaceName));
  if (excludeList.length > 0) return !excludeList.some((p) => matchesWildcard(p, interfaceName));
  return true;
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
