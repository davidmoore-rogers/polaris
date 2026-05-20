/**
 * src/services/paloaltoService.ts — Single Palo Alto firewall REST API client
 *
 * Talks directly to a standalone Palo Alto firewall (not managed by Panorama).
 * Uses the PAN-OS REST API (PAN-OS 9.0+, /restapi/v10.1/) with an API key in
 * the X-PAN-KEY header for JSON-typed config/CMDB-equivalent endpoints. Live
 * monitor data that has no REST equivalent — DHCP leases, ARP table, HA state,
 * system info — uses XML "op" commands at /api/?type=op&cmd=<...>&key=... and
 * decodes the response via xml2js.
 *
 * Mirrors fortigateService.ts shape so the existing sync pipeline in
 * integrations.ts consumes both integrations identically. Concepts that have
 * no Palo Alto analog (FortiSwitch, FortiAP, switch-port MAC table) return
 * empty arrays — syncDhcpSubnets Phase 5b sweeps consult the per-query
 * success flags and skip the corresponding stale-row deprecation.
 *
 * Read-only v1: no DHCP reservation push, no quarantine push. The DHCP Push
 * and Quarantine Push tabs are intentionally hidden on the integration modal.
 */

import { Netmask } from "netmask";
import { parseStringPromise as parseXml } from "xml2js";
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
  DiscoveredSwitchMacEntry,
  DiscoveredArpEntry,
  DiscoveryResult,
  DiscoveryProgressCallback,
} from "./fortimanagerService.js";

export interface PaloAltoConfig {
  host: string;
  port?: number;            // Default 443
  apiKey: string;           // Required; generated in PAN-OS UI under Operations → Generate API Key
  vsys?: string;            // Virtual System (default: "vsys1")
  verifySsl?: boolean;      // Skip TLS verification (default: false = verify ON)
  mgmtInterface?: string;
  interfaceInclude?: string[];
  interfaceExclude?: string[];
  dhcpInclude?: string[];
  dhcpExclude?: string[];
}

/**
 * Test connectivity to a Palo Alto firewall.
 * Runs `<show><system><info/></system></show>` via the XML op command path —
 * works on every PAN-OS version that supports an API key (8.x+), so the test
 * is more forgiving than a REST `/restapi/v10.1/...` call which only works
 * on 9.0+.
 */
export async function testConnection(config: PaloAltoConfig): Promise<{
  ok: boolean;
  message: string;
  version?: string;
}> {
  try {
    const info = await panOpCommand<any>(config, "<show><system><info/></system></show>");
    const sysInfo = info?.system || info;
    const version = sysInfo?.["sw-version"] ? String(sysInfo["sw-version"]) : undefined;
    const hostname = sysInfo?.hostname ? String(sysInfo.hostname) : undefined;
    const model = sysInfo?.model ? String(sysInfo.model) : undefined;
    const label = hostname && version
      ? `Connected — ${hostname}${model ? ` (${model})` : ""} (PAN-OS ${version})`
      : version
        ? `Connected — PAN-OS ${version}`
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
 * Low-level PAN-OS REST request (JSON). Returns the decoded body's `result`
 * field, mirroring how fgRequest returns FortiOS's `results` array. PAN-OS
 * wraps every REST response in `{ "@status": "success", "@code": "19",
 * "result": {...} }`; non-success responses are mapped to AppError.
 */
export async function panRequest<T>(
  config: PaloAltoConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const port = config.port || 443;
  const qs = new URLSearchParams(opts.query || {});
  const url = `https://${config.host}:${port}${path}${qs.toString() ? (path.includes("?") ? "&" : "?") + qs.toString() : ""}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    if (config.verifySsl === false) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-PAN-KEY": config.apiKey,
    };
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (opts.body !== undefined && (method === "POST" || method === "PUT")) {
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, init);

    if (res.status === 401 || res.status === 403) {
      throw new AppError(502, "Authentication failed — check your API key");
    }
    if (res.status === 404) {
      throw new AppError(404, `Endpoint not found: ${path}`);
    }
    if (!res.ok) {
      throw new AppError(502, `Palo Alto returned HTTP ${res.status}`);
    }

    const body = (await res.json()) as any;
    if (body && body["@status"] && body["@status"] !== "success") {
      throw new AppError(502, `Palo Alto error: ${body?.result?.msg ?? body?.message ?? path}`);
    }
    return (body?.result ?? body) as T;
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
 * Run an XML "op" command. PAN-OS returns `<response status="success"><result>...</result></response>`
 * on success. xml2js decodes to `{ response: { $: { status }, result: [...] } }`.
 * We unwrap to the result body for callers.
 */
export async function panOpCommand<T = any>(
  config: PaloAltoConfig,
  cmdXml: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const port = config.port || 443;
  const qs = new URLSearchParams({
    type: "op",
    cmd: cmdXml,
    key: config.apiKey,
  });
  const url = `https://${config.host}:${port}/api/?${qs.toString()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    if (config.verifySsl === false) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const res = await fetch(url, { method: "GET", signal: controller.signal });

    if (res.status === 401 || res.status === 403) {
      throw new AppError(502, "Authentication failed — check your API key");
    }
    if (!res.ok) {
      throw new AppError(502, `Palo Alto returned HTTP ${res.status}`);
    }

    const text = await res.text();
    const parsed = await parseXml(text, { explicitArray: false, mergeAttrs: true });
    const envelope = parsed?.response;
    if (!envelope) {
      throw new AppError(502, "Palo Alto returned an unrecognized XML envelope");
    }
    if (envelope.status && envelope.status !== "success") {
      const msg = envelope.msg?.line || envelope.msg || envelope.result || "Unknown error";
      throw new AppError(502, `Palo Alto error: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
    }
    return (envelope.result ?? envelope) as T;
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
 * Proxy an arbitrary REST or op call to the Palo Alto using stored credentials.
 * Used by the manual API query tool in the UI. Accepts a `kind` field to choose
 * REST (JSON) or XML op transport — Palo Alto's split makes this explicit
 * rather than inferring from path.
 */
export async function proxyQuery(
  config: PaloAltoConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  query?: Record<string, string>,
  body?: unknown,
): Promise<unknown> {
  // If the path starts with /api/?type=op&cmd= or is a bare XML expression,
  // route through panOpCommand. Otherwise treat as REST.
  const opMatch = path.match(/^\/api\/\?type=op&cmd=(.+)$/);
  if (opMatch) {
    return panOpCommand(config, decodeURIComponent(opMatch[1]));
  }
  if (path.startsWith("<") && path.endsWith(">")) {
    return panOpCommand(config, path);
  }
  return panRequest(config, method, path, { query, body });
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/**
 * Helper: wildcard match against the configured include/exclude lists. Mirrors
 * fortigateService.matchAny: `*`, `prefix*`, `*suffix`, `*middle*`, literal.
 * Case-insensitive.
 */
function matchAny(name: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  const lower = name.toLowerCase();
  for (const p of patterns) {
    if (!p) continue;
    const pat = p.toLowerCase();
    if (pat === "*") return true;
    if (pat.startsWith("*") && pat.endsWith("*")) {
      if (lower.includes(pat.slice(1, -1))) return true;
    } else if (pat.startsWith("*")) {
      if (lower.endsWith(pat.slice(1))) return true;
    } else if (pat.endsWith("*")) {
      if (lower.startsWith(pat.slice(0, -1))) return true;
    } else if (lower === pat) {
      return true;
    }
  }
  return false;
}

/**
 * Query a single Palo Alto firewall directly for its DHCP configuration,
 * interfaces, NAT rules, ARP table, and HA state. Mirrors
 * fortigateService.discoverDhcpSubnets shape: produces a DiscoveryResult with
 * a single "device" entry (the firewall itself) and empty arrays for concepts
 * Palo Alto doesn't have (FortiSwitch, FortiAP, switch-port MAC table).
 */
export async function discoverDhcpSubnets(
  config: PaloAltoConfig,
  signal?: AbortSignal,
  onProgress?: DiscoveryProgressCallback,
  _inventoryMaxAgeHours = 24,
  _onDeviceComplete?: (result: DiscoveryResult) => Promise<void>,
  _skipGeoLog = false,
): Promise<DiscoveryResult> {
  const log = onProgress || (() => {});
  const vsys = config.vsys || "vsys1";

  // Step 1: Identify the firewall itself (one "device")
  let deviceName = "";
  let deviceHostname = "";
  let deviceSerial = "";
  let deviceModel = "";
  let deviceOsVersion = "";
  try {
    const info = await panOpCommand<any>(config, "<show><system><info/></system></show>", { signal });
    const sysInfo = info?.system || info;
    deviceName = String(sysInfo?.hostname || sysInfo?.serial || config.host);
    deviceHostname = String(sysInfo?.hostname || deviceName);
    deviceSerial = String(sysInfo?.serial || "");
    deviceModel = String(sysInfo?.model || "Palo Alto");
    deviceOsVersion = String(sysInfo?.["sw-version"] || "");
    log("discover.devices", "info", `Connected to ${deviceHostname} — PAN-OS ${deviceOsVersion}`, deviceHostname);
  } catch (err: any) {
    log("discover.devices", "error", `Failed to query Palo Alto status: ${err.message || "Unknown error"}`);
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

  // Per-query success flags. syncDhcpSubnets Phase 5b consults these so a
  // failed query never causes Polaris to release rows we haven't actually
  // heard the gate disclaim.
  let didVipQuery = false;
  let didDhcpReservationsQuery = false;
  let didDhcpLeasesQuery = false;

  // Step 2: Resolve management IP from the configured interface or fall back
  // to the host we connected to. Palo Alto's management interface is named
  // `management` and lives outside the normal interface tree, but operators
  // can configure an alternate.
  let mgmtIp: string | null = null;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(config.host)) {
    mgmtIp = config.host;
  }

  devices.push({
    name: deviceName,
    hostname: deviceHostname,
    serial: deviceSerial,
    model: deviceModel,
    mgmtIp: mgmtIp || "",
    osVersion: deviceOsVersion,
  });

  if (mgmtIp) {
    interfaceIps.push({
      device: deviceName,
      interfaceName: config.mgmtInterface || "management",
      ipAddress: mgmtIp,
      role: "management",
    });
  }

  if (signal?.aborted) {
    return assembleResult({
      discovered, devices, interfaceIps, dhcpEntries, deviceInventory,
      inventoryDevices, fortiSwitches, fortiAps, vips, switchMacTable, arpTable,
      deviceName, didVipQuery, didDhcpReservationsQuery, didDhcpLeasesQuery,
    });
  }

  // Fan out the four discovery chains in parallel.
  //   Chain A: Layer-3 interfaces → derives subnets + interface IPs + nested DHCP server config (reservations)
  //   Chain B: DHCP leases (XML op)
  //   Chain C: NAT rules (REST JSON) → DiscoveredVip[]
  //   Chain D: ARP table (XML op)
  //   Chain E: HA state (XML op)
  await Promise.all([
    // ─── Chain A: Layer-3 interfaces + nested DHCP server config ───
    (async () => {
      try {
        const ifaceResp = await panRequest<any>(
          config,
          "GET",
          "/restapi/v10.1/Network/EthernetInterfaces",
          { query: { location: "vsys", vsys }, signal },
        );
        const entries = Array.isArray(ifaceResp?.entry) ? ifaceResp.entry : Array.isArray(ifaceResp) ? ifaceResp : [];
        let subnetCount = 0;
        let reservationCount = 0;
        for (const iface of entries) {
          const ifaceName = String(iface?.["@name"] ?? iface?.name ?? "");
          if (!ifaceName) continue;

          // Filter: include wins over exclude. Mirrors fortigateService.
          if (config.interfaceInclude && config.interfaceInclude.length > 0) {
            if (!matchAny(ifaceName, config.interfaceInclude)) continue;
          } else if (config.interfaceExclude && config.interfaceExclude.length > 0) {
            if (matchAny(ifaceName, config.interfaceExclude)) continue;
          }

          // Layer-3 interfaces carry IP + DHCP server config under `layer3`.
          const l3 = iface?.layer3;
          if (!l3) continue;

          // Primary IP: array of "ip/cidr" strings under layer3.ip[].entry[].@name
          const ipEntries = Array.isArray(l3.ip?.entry) ? l3.ip.entry : (l3.ip?.entry ? [l3.ip.entry] : []);
          for (const ipEntry of ipEntries) {
            const ipStr = String(ipEntry?.["@name"] ?? ipEntry ?? "");
            if (!ipStr) continue;
            const [ipOnly, prefix] = ipStr.split("/");
            if (!ipOnly || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipOnly)) continue;
            interfaceIps.push({
              device: deviceName,
              interfaceName: ifaceName,
              ipAddress: ipOnly,
              role: "interface",
            });
            // If this interface hosts a DHCP server, derive the subnet from the
            // interface IP/prefix. PAN-OS DHCP scopes are bound to L3
            // interfaces; the subnet IS the interface's subnet.
            if (prefix && l3["dhcp-server"]) {
              try {
                const block = new Netmask(`${ipOnly}/${prefix}`);
                const cidr = `${block.base}/${block.bitmask}`;
                if (matchesDhcpFilter(ifaceName, cidr, config)) {
                  discovered.push({
                    cidr,
                    name: ifaceName,
                    fortigateDevice: deviceName,
                    dhcpServerId: ifaceName,
                  });
                  subnetCount++;
                }
              } catch {
                // skip malformed
              }
            }
          }

          // DHCP reservations (static): under layer3.dhcp-server.reserved.entry[]
          const dhcpServer = l3["dhcp-server"];
          if (dhcpServer) {
            const reservedEntries = Array.isArray(dhcpServer.reserved?.entry)
              ? dhcpServer.reserved.entry
              : (dhcpServer.reserved?.entry ? [dhcpServer.reserved.entry] : []);
            for (const r of reservedEntries) {
              const rIp = String(r?.["@name"] ?? r?.ip ?? "");
              const rMac = String(r?.mac ?? "");
              const desc = String(r?.description ?? "");
              if (!rIp || rIp === "0.0.0.0") continue;
              dhcpEntries.push({
                device: deviceName,
                interfaceName: ifaceName,
                ipAddress: rIp,
                macAddress: rMac,
                hostname: desc,
                type: "dhcp-reservation",
              });
              reservationCount++;
            }
          }
        }
        didDhcpReservationsQuery = true;
        log("discover.dhcp", "info", `${deviceHostname}: Found ${subnetCount} DHCP subnet(s) and ${reservationCount} static reservation(s)`, deviceHostname);
      } catch (err: any) {
        log("discover.dhcp", "error", `${deviceHostname}: Failed to query interfaces / DHCP config — ${err.message || "Unknown error"}`, deviceHostname);
      }
    })(),

    // ─── Chain B: DHCP leases via XML op command ───
    (async () => {
      try {
        const leases = await panOpCommand<any>(
          config,
          "<show><dhcp><server><lease><interface>all</interface></lease></server></dhcp></show>",
          { signal },
        );
        didDhcpLeasesQuery = true;
        // Response shape: { interface: { @name, lease: [...] } } or array thereof.
        const ifaces = Array.isArray(leases?.interface)
          ? leases.interface
          : (leases?.interface ? [leases.interface] : []);
        let leaseCount = 0;
        for (const iface of ifaces) {
          const ifaceName = String(iface?.["@name"] ?? iface?.name ?? "");
          const leaseRows = Array.isArray(iface?.lease) ? iface.lease : (iface?.lease ? [iface.lease] : []);
          for (const lease of leaseRows) {
            const leaseIp = String(lease?.ip ?? "");
            const leaseMac = String(lease?.mac ?? "");
            if (!leaseIp || leaseIp === "0.0.0.0") continue;

            // Merge into existing CMDB-derived row if present, mirroring
            // fortigateService — preserves the static reservation while
            // marking it as currently leased.
            const existingIdx = dhcpEntries.findIndex(
              (e) => e.ipAddress === leaseIp && e.device === deviceName,
            );
            if (existingIdx >= 0) {
              dhcpEntries[existingIdx].seenLeased = true;
              continue;
            }
            const leaseTimeRaw = lease?.["lease-time"];
            const leaseTimeNum = leaseTimeRaw != null ? Number(leaseTimeRaw) : NaN;
            dhcpEntries.push({
              device: deviceName,
              interfaceName: ifaceName || "unknown",
              ipAddress: leaseIp,
              macAddress: leaseMac,
              hostname: String(lease?.hostname ?? ""),
              type: "dhcp-lease",
              expireTime: Number.isFinite(leaseTimeNum) ? leaseTimeNum : undefined,
            });
            leaseCount++;
          }
        }
        log("discover.leases", "info", `${deviceHostname}: Found ${leaseCount} live DHCP lease(s)`, deviceHostname);
      } catch (err: any) {
        log("discover.leases", "error", `${deviceHostname}: Failed to query DHCP leases — ${err.message || "Unknown error"}`, deviceHostname);
      }
    })(),

    // ─── Chain C: NAT rules (VIP analog) ───
    (async () => {
      try {
        const natResp = await panRequest<any>(
          config,
          "GET",
          "/restapi/v10.1/Policies/NATRules",
          { query: { location: "vsys", vsys }, signal },
        );
        const entries = Array.isArray(natResp?.entry) ? natResp.entry : Array.isArray(natResp) ? natResp : [];
        let vipCount = 0;
        for (const nat of entries) {
          const name = String(nat?.["@name"] ?? nat?.name ?? "");
          if (!name) continue;
          // Static destination-NAT: `destination-translation.translated-address`
          // maps one outside IP to one inside IP — the closest analog to a
          // FortiGate VIP.
          const dstTrans = nat?.["destination-translation"];
          const translatedAddr = dstTrans?.["translated-address"];
          if (!translatedAddr) continue;

          const extDestEntries = Array.isArray(nat?.destination?.member)
            ? nat.destination.member
            : (nat?.destination?.member ? [nat.destination.member] : []);
          const fromZoneEntries = Array.isArray(nat?.to?.member) ? nat.to.member : (nat?.to?.member ? [nat.to.member] : []);

          for (const extIp of extDestEntries) {
            const extIpStr = String(extIp);
            if (!extIpStr || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(extIpStr)) continue;
            vips.push({
              device: deviceName,
              name,
              extip: extIpStr,
              mappedips: [String(translatedAddr)],
              extintf: fromZoneEntries.length > 0 ? String(fromZoneEntries[0]) : "",
            });
            vipCount++;
          }
        }
        didVipQuery = true;
        log("discover.vips", "info", `${deviceHostname}: Found ${vipCount} NAT-mapped VIP(s)`, deviceHostname);
      } catch (err: any) {
        log("discover.vips", "error", `${deviceHostname}: Failed to query NAT rules — ${err.message || "Unknown error"}`, deviceHostname);
      }
    })(),

    // ─── Chain D: ARP table via XML op command ───
    (async () => {
      try {
        const arp = await panOpCommand<any>(
          config,
          "<show><arp><entry name=\"all\"/></arp></show>",
          { signal },
        );
        const arpEntries = Array.isArray(arp?.entries?.entry)
          ? arp.entries.entry
          : (arp?.entries?.entry ? [arp.entries.entry] : []);
        for (const entry of arpEntries) {
          const ip = String(entry?.ip ?? "");
          const mac = String(entry?.mac ?? "");
          const iface = String(entry?.interface ?? "");
          if (!ip || !mac || mac === "(incomplete)") continue;
          arpTable.push({
            fortigateDevice: deviceName,
            ip,
            mac,
            interface: iface,
          });
        }
        log("discover.arp", "info", `${deviceHostname}: Found ${arpTable.length} ARP entrie(s)`, deviceHostname);
      } catch (err: any) {
        log("discover.arp", "info", `${deviceHostname}: ARP table query skipped — ${err.message || "Unknown error"}`, deviceHostname);
      }
    })(),

    // ─── Chain E: HA state via XML op command ───
    // Maps PAN-OS HA mode to the fortinet-shaped DiscoveredDevice.haMembers[]
    // so the existing sync pipeline (Phase 3 fan-out) keys per-member Asset
    // writes off serial — same as FortiGate HA. PAN-OS modes:
    //   "active-passive" → "a-p"
    //   "active-active"  → "a-a"
    //   anything else / disabled → "standalone"
    (async () => {
      try {
        const ha = await panOpCommand<any>(
          config,
          "<show><high-availability><state/></high-availability></show>",
          { signal },
        );
        const enabled = String(ha?.enabled ?? ha?.["ha-state"] ?? "no").toLowerCase();
        if (enabled === "no" || enabled === "disabled" || !ha) {
          devices[0].haMode = "standalone";
          return;
        }
        const localInfo = ha?.["local-info"] ?? ha?.group?.["local-info"];
        const peerInfo = ha?.["peer-info"] ?? ha?.group?.["peer-info"];
        const localState = String(localInfo?.state ?? "").toLowerCase();
        const modeRaw = String(localInfo?.mode ?? ha?.["ha-mode"] ?? "").toLowerCase();
        devices[0].haMode = modeRaw.includes("active-active") ? "a-a" : "a-p";

        const members: NonNullable<DiscoveredDevice["haMembers"]> = [];
        if (deviceSerial) {
          members.push({
            serial: deviceSerial,
            name: deviceHostname,
            isPrimary: localState === "active",
          });
        }
        const peerSerial = peerInfo?.serial ? String(peerInfo.serial) : "";
        if (peerSerial) {
          members.push({
            serial: peerSerial,
            name: peerInfo?.hostname ? String(peerInfo.hostname) : undefined,
            isPrimary: localState !== "active",
          });
        }
        if (members.length > 0) {
          devices[0].haMembers = members;
        }
      } catch (err: any) {
        devices[0].haMode = "standalone";
        log("discover.ha", "info", `${deviceHostname}: HA state query skipped — ${err.message || "Unknown error"}`, deviceHostname);
      }
    })(),
  ]);

  return assembleResult({
    discovered, devices, interfaceIps, dhcpEntries, deviceInventory,
    inventoryDevices, fortiSwitches, fortiAps, vips, switchMacTable, arpTable,
    deviceName, didVipQuery, didDhcpReservationsQuery, didDhcpLeasesQuery,
  });
}

/**
 * Assemble the final DiscoveryResult. Per-query success flags drive Phase 5b
 * sweeps in syncDhcpSubnets — empty arrays for concepts Palo Alto doesn't
 * have (FortiSwitch, FortiAP, switch-port MAC table) AND empty success flags
 * so those sweeps skip.
 */
function assembleResult(args: {
  discovered: DiscoveredSubnet[];
  devices: DiscoveredDevice[];
  interfaceIps: DiscoveredInterfaceIp[];
  dhcpEntries: DiscoveredDhcpEntry[];
  deviceInventory: DiscoveredInventoryDevice[];
  inventoryDevices: Set<string>;
  fortiSwitches: DiscoveredFortiSwitch[];
  fortiAps: DiscoveredFortiAP[];
  vips: DiscoveredVip[];
  switchMacTable: DiscoveredSwitchMacEntry[];
  arpTable: DiscoveredArpEntry[];
  deviceName: string;
  didVipQuery: boolean;
  didDhcpReservationsQuery: boolean;
  didDhcpLeasesQuery: boolean;
}): DiscoveryResult {
  return {
    subnets: args.discovered,
    devices: args.devices,
    interfaceIps: args.interfaceIps,
    dhcpEntries: args.dhcpEntries,
    deviceInventory: args.deviceInventory,
    inventoryDevices: Array.from(args.inventoryDevices),
    knownDeviceNames: [args.deviceName],
    fortiSwitches: args.fortiSwitches,
    fortiAps: args.fortiAps,
    vips: args.vips,
    switchMacTable: args.switchMacTable,
    arpTable: args.arpTable,
    cmdbSwitchSerials: [],
    cmdbApSerials: [],
    // Phase 5b sweep scope flags: present-but-empty means "we checked and
    // there's nothing"; absent means "we didn't check, don't sweep".
    switchInventoriedDevices: [],
    apInventoriedDevices: [],
    vipInventoriedDevices: args.didVipQuery ? [args.deviceName] : [],
    dhcpReservationsInventoriedDevices: args.didDhcpReservationsQuery ? [args.deviceName] : [],
    dhcpLeasesInventoriedDevices: args.didDhcpLeasesQuery ? [args.deviceName] : [],
  };
}

/**
 * Apply the dhcpInclude/dhcpExclude wildcards to a subnet decision. Include
 * wins over exclude (mirrors fortigateService).
 */
function matchesDhcpFilter(ifaceName: string, cidr: string, config: PaloAltoConfig): boolean {
  const haystacks = [ifaceName, cidr];
  if (config.dhcpInclude && config.dhcpInclude.length > 0) {
    return haystacks.some((h) => matchAny(h, config.dhcpInclude!));
  }
  if (config.dhcpExclude && config.dhcpExclude.length > 0) {
    return !haystacks.some((h) => matchAny(h, config.dhcpExclude!));
  }
  return true;
}
