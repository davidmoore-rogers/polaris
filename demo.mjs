/**
 * demo.mjs — Standalone demo server with mock data (no PostgreSQL required)
 *
 * Run:  node demo.mjs
 * Then: http://localhost:3000
 */

import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createGzip, createGunzip, gzipSync, gunzipSync } from "node:zlib";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash, X509Certificate } from "node:crypto";
import { Netmask } from "netmask";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = 3000;
const PUBLIC = join(__dirname, "public");
const APP_VERSION = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8")).version || "0.0.0";

// ─── Real FortiManager API Client ───────────────────────────────────────────
// Used when non-mock FMG integrations are added to the demo.

const MOCK_FMG_HOSTS = ["fmg.example.com", "lab-fmg.example.com", "10.0.50.1"];

function _isMockFmg(config) {
  return !config?.host || MOCK_FMG_HOSTS.includes(config.host);
}

async function _fmgRpc(url, payload, apiUser, apiToken, verifySsl, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  // Temporarily disable TLS verification for self-signed FMG certs when verifySsl is false
  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (verifySsl === false) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` };
    if (apiUser) headers["access_user"] = apiUser;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) throw new Error("Authentication failed — check your API token");
    if (!res.ok) throw new Error(`FortiManager returned HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    if (verifySsl === false) {
      if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
    }
  }
}

async function _fmgTestConnection(config) {
  if (!config.host || !config.apiToken) return { ok: false, message: "Host and API token are required" };
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  try {
    const res = await _fmgRpc(baseUrl, { id: 1, method: "get", params: [{ url: "/sys/status" }] }, config.apiUser, config.apiToken, config.verifySsl);
    const code = res.result?.[0]?.status?.code;
    if (code !== 0) {
      const msg = res.result?.[0]?.status?.message || "Request failed";
      if (code === -11) return { ok: false, message: "Invalid or expired API token" };
      return { ok: false, message: msg };
    }
    const data = res.result?.[0]?.data;
    const version = data?.Version ? String(data.Version) : undefined;
    return { ok: true, message: version ? `Connected — FortiManager ${version}` : "Connected successfully", version };
  } catch (err) {
    if (err.cause?.code === "ECONNREFUSED") return { ok: false, message: `Connection refused — ${config.host}:${config.port || 443}` };
    if (err.cause?.code === "ENOTFOUND") return { ok: false, message: `Host not found — ${config.host}` };
    if (err.cause?.code === "ETIMEDOUT" || err.name === "TimeoutError") return { ok: false, message: `Connection timed out — ${config.host}:${config.port || 443}` };
    if (err.cause?.code === "CERT_HAS_EXPIRED" || err.cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || err.cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
      return { ok: false, message: `SSL certificate error — ${err.cause.code}. Try disabling "Verify SSL certificate".` };
    }
    return { ok: false, message: err.message || "Unknown error" };
  }
}

async function _fmgDiscover(config, log) {
  if (!log) log = () => {};
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const adom = config.adom || "root";
  const { apiUser, apiToken, verifySsl } = config;

  // Step 1: List managed devices
  let devicesRes;
  try {
    devicesRes = await _fmgRpc(baseUrl, { id: 1, method: "get", params: [{ url: `/dvmdb/adom/${adom}/device` }] }, apiUser, apiToken, verifySsl);
  } catch (err) {
    log("discover.devices", "error", `Failed to list managed devices: ${err.message}`);
    throw err;
  }
  const devicesData = devicesRes.result?.[0]?.data;
  if (!Array.isArray(devicesData) || devicesData.length === 0) {
    log("discover.devices", "info", `No managed devices found in ADOM "${adom}"`);
    return { subnets: [], devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [] };
  }
  log("discover.devices", "info", `Found ${devicesData.length} managed device(s) in ADOM "${adom}"`);

  const discovered = [], devices = [], interfaceIps = [], dhcpEntries = [], deviceInventory = [];

  for (const device of devicesData) {
    const deviceName = device.name || device.hostname;
    if (!deviceName) continue;

    const mgmtIp = device.ip || "";
    devices.push({ name: deviceName, hostname: device.hostname || deviceName, serial: device.sn || "", model: device.platform_str || "", mgmtIp });

    if (mgmtIp && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mgmtIp)) {
      interfaceIps.push({ device: deviceName, interfaceName: config.mgmtInterface || "mgmt", ipAddress: mgmtIp, role: "management" });
    }

    const dhcpInterfaceNames = [];
    try {
      const dhcpRes = await _fmgRpc(baseUrl, { id: 2, method: "get", params: [{ url: `/pm/config/device/${deviceName}/vdom/root/system/dhcp/server` }] }, apiUser, apiToken, verifySsl);
      const dhcpData = dhcpRes.result?.[0]?.data;
      if (!Array.isArray(dhcpData)) { log("discover.dhcp", "info", `${deviceName}: No DHCP servers configured`); continue; }

      let subnetCount = 0, resCount = 0;
      for (const server of dhcpData) {
        const iface = server.interface || "";
        const serverId = String(server.id || iface);
        const netmaskStr = server.netmask;
        const ranges = server["ip-range"];
        if (!netmaskStr || !Array.isArray(ranges) || ranges.length === 0) continue;
        const startIp = ranges[0]["start-ip"];
        if (!startIp) continue;
        try {
          const block = new Netmask(`${startIp}/${netmaskStr}`);
          discovered.push({ cidr: `${block.base}/${block.bitmask}`, name: iface || `dhcp-${serverId}`, fortigateDevice: deviceName, dhcpServerId: serverId });
          subnetCount++;
          if (iface) dhcpInterfaceNames.push(iface);
        } catch {}

        const reservedAddrs = server["reserved-address"];
        if (Array.isArray(reservedAddrs)) {
          for (const entry of reservedAddrs) {
            if (!entry.ip || entry.ip === "0.0.0.0") continue;
            dhcpEntries.push({ device: deviceName, interfaceName: iface || `dhcp-${serverId}`, ipAddress: entry.ip, macAddress: entry.mac || "", hostname: entry.description || "", type: "dhcp-reservation" });
            resCount++;
          }
        }
      }
      log("discover.dhcp", "info", `${deviceName}: Found ${subnetCount} DHCP subnet(s) and ${resCount} static reservation(s)`);

      // DHCP leases
      try {
        const leaseRes = await _fmgRpc(baseUrl, { id: 4, method: "exec", params: [{ url: "/sys/proxy/json", data: { target: [`/adom/${adom}/device/${deviceName}`], action: "get", resource: "/api/v2/monitor/dhcp/server-leases" } }] }, apiUser, apiToken, verifySsl);
        const leaseData = leaseRes.result?.[0]?.data;
        const results = Array.isArray(leaseData) ? leaseData[0]?.response?.results : leaseData?.response?.results;
        let leaseCount = 0;
        if (Array.isArray(results)) {
          for (const lease of results) {
            if (!lease.ip || lease.ip === "0.0.0.0") continue;
            if (dhcpEntries.some((e) => e.ipAddress === lease.ip && e.device === deviceName)) continue;
            if (lease.interface && !dhcpInterfaceNames.includes(lease.interface)) continue;
            dhcpEntries.push({ device: deviceName, interfaceName: lease.interface || "unknown", ipAddress: lease.ip, macAddress: lease.mac || "", hostname: lease.hostname || "", type: "dhcp-lease" });
            leaseCount++;
          }
        }
        log("discover.leases", "info", `${deviceName}: Found ${leaseCount} dynamic DHCP lease(s)`);
      } catch (err) { log("discover.leases", "error", `${deviceName}: Failed to query DHCP leases — ${err.message}`); }

      // Interface IPs
      if (dhcpInterfaceNames.length > 0) {
        try {
          const ifaceRes = await _fmgRpc(baseUrl, { id: 3, method: "get", params: [{ url: `/pm/config/device/${deviceName}/vdom/root/system/interface` }] }, apiUser, apiToken, verifySsl);
          const ifaceData = ifaceRes.result?.[0]?.data;
          let ipCount = 0;
          if (Array.isArray(ifaceData)) {
            for (const iface of ifaceData) {
              if (!dhcpInterfaceNames.includes(iface.name || "")) continue;
              const ipArr = iface.ip;
              if (Array.isArray(ipArr) && ipArr[0] && ipArr[0] !== "0.0.0.0") {
                interfaceIps.push({ device: deviceName, interfaceName: iface.name, ipAddress: ipArr[0], role: "dhcp-server" });
                ipCount++;
              }
            }
          }
          log("discover.interfaces", "info", `${deviceName}: Resolved ${ipCount} DHCP interface IP(s)`);
        } catch (err) { log("discover.interfaces", "error", `${deviceName}: Failed to query interfaces — ${err.message}`); }
      }

      // Device inventory
      try {
        const invRes = await _fmgRpc(baseUrl, { id: 5, method: "exec", params: [{ url: "/sys/proxy/json", data: { target: [`/adom/${adom}/device/${deviceName}`], action: "get", resource: "/api/v2/monitor/user/device/query" } }] }, apiUser, apiToken, verifySsl);
        const invData = invRes.result?.[0]?.data;
        const results = Array.isArray(invData) ? invData[0]?.response?.results : invData?.response?.results;
        let invCount = 0;
        if (Array.isArray(results)) {
          for (const c of results) {
            if (!c.mac && !c.ip) continue;
            deviceInventory.push({ device: deviceName, macAddress: c.mac || "", ipAddress: c.ip || "", hostname: c.hostname || c.host || "", os: c.os || c.type || "", osVersion: c.os_version || "", hardwareVendor: c.hardware_vendor || "", interfaceName: c.interface || "", switchName: c.switch_fortilink || c.fortiswitch || "", switchPort: c.switch_port != null ? String(c.switch_port) : "", apName: c.ap_name || c.fortiap || "", user: c.user || c.detected_user || "", isOnline: !!c.is_online, lastSeen: c.last_seen ? new Date(c.last_seen * 1000).toISOString() : new Date().toISOString() });
            invCount++;
          }
        }
        log("discover.inventory", "info", `${deviceName}: Found ${invCount} device inventory client(s)`);
      } catch (err) { log("discover.inventory", "error", `${deviceName}: Failed to query device inventory — ${err.message}`); }
    } catch (err) { log("discover.device", "error", `${deviceName}: Failed to query device — ${err.message}`); }
  }

  // Filter by include/exclude
  let filteredSubnets = discovered;
  if (config.dhcpInclude?.length) {
    filteredSubnets = filteredSubnets.filter((s) => config.dhcpInclude.some((p) => s.name.toLowerCase().includes(p.toLowerCase()) || s.dhcpServerId.toLowerCase().includes(p.toLowerCase())));
  }
  if (config.dhcpExclude?.length) {
    filteredSubnets = filteredSubnets.filter((s) => !config.dhcpExclude.some((p) => s.name.toLowerCase().includes(p.toLowerCase()) || s.dhcpServerId.toLowerCase().includes(p.toLowerCase())));
  }

  const includedIfaces = new Set(filteredSubnets.map((s) => s.name));
  const filteredIps = interfaceIps.filter((ip) => ip.role === "management" || includedIfaces.has(ip.interfaceName));
  const filteredDhcp = dhcpEntries.filter((e) => includedIfaces.has(e.interfaceName));
  const excludedIfaces = new Set(discovered.filter((s) => !filteredSubnets.includes(s)).map((s) => `${s.fortigateDevice}/${s.name}`));
  const filteredInv = deviceInventory.filter((d) => !excludedIfaces.has(`${d.device}/${d.interfaceName}`));

  log("discover.filter", "info", `Filter complete: ${filteredSubnets.length} subnet(s), ${filteredDhcp.length} DHCP entries, ${filteredInv.length} inventory`);
  return { subnets: filteredSubnets, devices, interfaceIps: filteredIps, dhcpEntries: filteredDhcp, deviceInventory: filteredInv };
}

// ─── Mock Data ───────────────────────────────────────────────────────────────

const BLOCKS = [
  {
    id: "b1000000-0000-0000-0000-000000000001",
    name: "Corporate Datacenter",
    cidr: "10.0.0.0/8",
    ipVersion: "v4",
    description: "Primary RFC-1918 space for internal infrastructure",
    tags: ["datacenter", "internal"],
    createdAt: "2025-11-15T08:00:00.000Z",
    updatedAt: "2025-11-15T08:00:00.000Z",
    _count: { subnets: 4 },
  },
  {
    id: "b2000000-0000-0000-0000-000000000002",
    name: "Management Network",
    cidr: "172.16.0.0/12",
    ipVersion: "v4",
    description: "Out-of-band management and BMC access",
    tags: ["management", "oob"],
    createdAt: "2025-11-15T08:05:00.000Z",
    updatedAt: "2025-11-15T08:05:00.000Z",
    _count: { subnets: 1 },
  },
  {
    id: "b3000000-0000-0000-0000-000000000003",
    name: "Cloud VPN",
    cidr: "192.168.0.0/16",
    ipVersion: "v4",
    description: "Site-to-site VPN tunnels to AWS and Azure",
    tags: ["cloud", "vpn"],
    createdAt: "2026-01-20T14:30:00.000Z",
    updatedAt: "2026-01-20T14:30:00.000Z",
    _count: { subnets: 2 },
  },
  {
    id: "b4000000-0000-0000-0000-000000000004",
    name: "IPv6 Global",
    cidr: "2001:db8::/32",
    ipVersion: "v6",
    description: "Public IPv6 allocation",
    tags: ["ipv6", "public"],
    createdAt: "2026-03-01T10:00:00.000Z",
    updatedAt: "2026-03-01T10:00:00.000Z",
    _count: { subnets: 1 },
  },
];

const SUBNETS = [
  {
    id: "s1000000-0000-0000-0000-000000000001",
    blockId: BLOCKS[0].id,
    block: { name: "Corporate Datacenter", cidr: "10.0.0.0/8" },
    cidr: "10.0.1.0/24",
    name: "K8s Node Pool",
    purpose: "Production Kubernetes worker nodes",
    status: "available",
    vlan: 100,
    tags: ["kubernetes", "prod"],
    discoveredBy: "i1000000-0000-0000-0000-000000000001",
    integration: { id: "i1000000-0000-0000-0000-000000000001", name: "Production FortiManager", type: "fortimanager" },
    fortigateDevice: "FGT-DC1-01",
    createdAt: "2025-11-15T09:00:00.000Z",
    updatedAt: "2025-11-15T09:00:00.000Z",
    _count: { reservations: 3 },
  },
  {
    id: "s2000000-0000-0000-0000-000000000002",
    blockId: BLOCKS[0].id,
    block: { name: "Corporate Datacenter", cidr: "10.0.0.0/8" },
    cidr: "10.0.2.0/24",
    name: "Database Tier",
    purpose: "PostgreSQL and Redis clusters",
    status: "reserved",
    vlan: 200,
    tags: ["database", "prod"],
    discoveredBy: "i1000000-0000-0000-0000-000000000001",
    integration: { id: "i1000000-0000-0000-0000-000000000001", name: "Production FortiManager", type: "fortimanager" },
    fortigateDevice: "FGT-DC1-01",
    createdAt: "2025-11-15T09:05:00.000Z",
    updatedAt: "2025-11-15T09:05:00.000Z",
    _count: { reservations: 2 },
  },
  {
    id: "s3000000-0000-0000-0000-000000000003",
    blockId: BLOCKS[0].id,
    block: { name: "Corporate Datacenter", cidr: "10.0.0.0/8" },
    cidr: "10.0.3.0/24",
    name: "Monitoring Stack",
    purpose: "Prometheus, Grafana, Loki",
    status: "available",
    vlan: 300,
    tags: ["monitoring", "prod"],
    discoveredBy: "i1000000-0000-0000-0000-000000000001",
    integration: { id: "i1000000-0000-0000-0000-000000000001", name: "Production FortiManager", type: "fortimanager" },
    fortigateDevice: "FGT-DC1-02",
    createdAt: "2026-01-10T11:00:00.000Z",
    updatedAt: "2026-01-10T11:00:00.000Z",
    _count: { reservations: 1 },
  },
  {
    id: "s4000000-0000-0000-0000-000000000004",
    blockId: BLOCKS[0].id,
    block: { name: "Corporate Datacenter", cidr: "10.0.0.0/8" },
    cidr: "10.0.4.0/24",
    name: "CI/CD Runners",
    purpose: "GitLab runners and build agents",
    status: "deprecated",
    vlan: 400,
    tags: ["ci", "internal"],
    discoveredBy: null,
    integration: null,
    fortigateDevice: null,
    createdAt: "2025-12-01T08:00:00.000Z",
    updatedAt: "2026-02-15T16:00:00.000Z",
    _count: { reservations: 0 },
  },
  {
    id: "s5000000-0000-0000-0000-000000000005",
    blockId: BLOCKS[1].id,
    block: { name: "Management Network", cidr: "172.16.0.0/12" },
    cidr: "172.16.0.0/24",
    name: "BMC / IPMI",
    purpose: "Baseboard management controllers",
    status: "available",
    vlan: 999,
    tags: ["management", "bmc"],
    discoveredBy: null,
    integration: null,
    fortigateDevice: null,
    createdAt: "2025-11-15T09:10:00.000Z",
    updatedAt: "2025-11-15T09:10:00.000Z",
    _count: { reservations: 1 },
  },
  {
    id: "s6000000-0000-0000-0000-000000000006",
    blockId: BLOCKS[2].id,
    block: { name: "Cloud VPN", cidr: "192.168.0.0/16" },
    cidr: "192.168.1.0/24",
    name: "AWS Tunnel A",
    purpose: "Primary VPN tunnel to us-east-1",
    status: "reserved",
    vlan: 501,
    tags: ["aws", "vpn"],
    discoveredBy: null,
    integration: null,
    fortigateDevice: null,
    createdAt: "2026-01-20T15:00:00.000Z",
    updatedAt: "2026-01-20T15:00:00.000Z",
    _count: { reservations: 1 },
  },
  {
    id: "s7000000-0000-0000-0000-000000000007",
    blockId: BLOCKS[2].id,
    block: { name: "Cloud VPN", cidr: "192.168.0.0/16" },
    cidr: "192.168.2.0/24",
    name: "Azure Tunnel B",
    purpose: "Site-to-site to Azure East US",
    status: "available",
    vlan: 502,
    tags: ["azure", "vpn"],
    discoveredBy: null,
    integration: null,
    fortigateDevice: null,
    createdAt: "2026-02-05T09:30:00.000Z",
    updatedAt: "2026-02-05T09:30:00.000Z",
    _count: { reservations: 0 },
  },
  {
    id: "s9000000-0000-0000-0000-000000000009",
    blockId: BLOCKS[0].id,
    block: { name: "Corporate Datacenter", cidr: "10.0.0.0/8" },
    cidr: "10.0.20.0/24",
    name: "Dev Lab Network",
    purpose: "Developer lab environment",
    status: "available",
    vlan: 600,
    tags: ["dev", "lab"],
    discoveredBy: null,
    integration: null,
    fortigateDevice: null,
    createdAt: "2026-03-10T10:00:00.000Z",
    updatedAt: "2026-03-10T10:00:00.000Z",
    _count: { reservations: 0 },
  },
  {
    id: "s8000000-0000-0000-0000-000000000008",
    blockId: BLOCKS[3].id,
    block: { name: "IPv6 Global", cidr: "2001:db8::/32" },
    cidr: "2001:db8:1::/48",
    name: "Public Web Services",
    purpose: "IPv6-enabled public-facing services",
    status: "available",
    vlan: null,
    tags: ["ipv6", "web"],
    discoveredBy: null,
    integration: null,
    fortigateDevice: null,
    createdAt: "2026-03-01T10:30:00.000Z",
    updatedAt: "2026-03-01T10:30:00.000Z",
    _count: { reservations: 1 },
  },
];

const RESERVATIONS = [
  {
    id: "r1000000-0000-0000-0000-000000000001",
    subnetId: SUBNETS[0].id,
    subnet: { name: "K8s Node Pool", cidr: "10.0.1.0/24" },
    ipAddress: "10.0.1.10",
    hostname: "k8s-worker-01",
    owner: "platform-team",
    projectRef: "INFRA-001",
    expiresAt: null,
    notes: "Primary worker node — MAC: AA:BB:CC:DD:10:10",
    status: "active",
    createdBy: "admin",
    createdAt: "2025-11-16T10:00:00.000Z",
    updatedAt: "2025-11-16T10:00:00.000Z",
  },
  {
    id: "r2000000-0000-0000-0000-000000000002",
    subnetId: SUBNETS[0].id,
    subnet: { name: "K8s Node Pool", cidr: "10.0.1.0/24" },
    ipAddress: "10.0.1.11",
    hostname: "k8s-worker-02",
    owner: "platform-team",
    projectRef: "INFRA-001",
    expiresAt: null,
    notes: "Secondary worker node — MAC: AA:BB:CC:DD:10:11",
    status: "active",
    createdBy: "admin",
    createdAt: "2025-11-16T10:05:00.000Z",
    updatedAt: "2025-11-16T10:05:00.000Z",
  },
  {
    id: "r3000000-0000-0000-0000-000000000003",
    subnetId: SUBNETS[0].id,
    subnet: { name: "K8s Node Pool", cidr: "10.0.1.0/24" },
    ipAddress: "10.0.1.12",
    hostname: "k8s-worker-03",
    owner: "platform-team",
    projectRef: "INFRA-002",
    expiresAt: "2026-06-01T00:00:00.000Z",
    notes: "Temporary burst node for Q2 load testing — MAC: AA:BB:CC:DD:10:12",
    status: "active",
    createdBy: "jsmith",
    createdAt: "2026-03-20T14:00:00.000Z",
    updatedAt: "2026-03-20T14:00:00.000Z",
  },
  {
    id: "r4000000-0000-0000-0000-000000000004",
    subnetId: SUBNETS[1].id,
    subnet: { name: "Database Tier", cidr: "10.0.2.0/24" },
    ipAddress: "10.0.2.10",
    hostname: "postgres-primary",
    owner: "data-team",
    projectRef: "DB-001",
    expiresAt: null,
    notes: "Primary PostgreSQL instance — MAC: AA:BB:CC:DD:20:10",
    status: "active",
    createdBy: "dmoore",
    createdAt: "2025-11-17T08:00:00.000Z",
    updatedAt: "2025-11-17T08:00:00.000Z",
  },
  {
    id: "r5000000-0000-0000-0000-000000000005",
    subnetId: SUBNETS[1].id,
    subnet: { name: "Database Tier", cidr: "10.0.2.0/24" },
    ipAddress: "10.0.2.11",
    hostname: "redis-primary",
    owner: "data-team",
    projectRef: "DB-002",
    expiresAt: null,
    notes: "Redis cache cluster leader",
    status: "active",
    createdBy: "dmoore",
    createdAt: "2026-01-05T09:00:00.000Z",
    updatedAt: "2026-01-05T09:00:00.000Z",
  },
  {
    id: "r6000000-0000-0000-0000-000000000006",
    subnetId: SUBNETS[2].id,
    subnet: { name: "Monitoring Stack", cidr: "10.0.3.0/24" },
    ipAddress: "10.0.3.10",
    hostname: "grafana-01",
    owner: "sre-team",
    projectRef: "MON-001",
    expiresAt: null,
    notes: "Grafana + Prometheus — MAC: AA:BB:CC:DD:03:10",
    status: "active",
    createdBy: "admin",
    createdAt: "2026-01-12T13:00:00.000Z",
    updatedAt: "2026-01-12T13:00:00.000Z",
  },
  {
    id: "r7000000-0000-0000-0000-000000000007",
    subnetId: SUBNETS[4].id,
    subnet: { name: "BMC / IPMI", cidr: "172.16.0.0/24" },
    ipAddress: "172.16.0.50",
    hostname: "bmc-rack-a1",
    owner: "infra-team",
    projectRef: "HW-010",
    expiresAt: null,
    notes: "Rack A1 baseboard management",
    status: "active",
    createdBy: "jsmith",
    createdAt: "2025-12-10T16:00:00.000Z",
    updatedAt: "2025-12-10T16:00:00.000Z",
  },
  {
    id: "r8000000-0000-0000-0000-000000000008",
    subnetId: SUBNETS[5].id,
    subnet: { name: "AWS Tunnel A", cidr: "192.168.1.0/24" },
    ipAddress: "192.168.1.1",
    hostname: "vpn-gw-aws",
    owner: "network-team",
    projectRef: "NET-005",
    expiresAt: null,
    notes: "AWS VPN gateway endpoint",
    status: "active",
    createdBy: "admin",
    createdAt: "2026-01-20T15:30:00.000Z",
    updatedAt: "2026-01-20T15:30:00.000Z",
  },
  {
    id: "r9000000-0000-0000-0000-000000000009",
    subnetId: SUBNETS[0].id,
    subnet: { name: "K8s Node Pool", cidr: "10.0.1.0/24" },
    ipAddress: "10.0.1.50",
    hostname: "k8s-temp-node",
    owner: "platform-team",
    projectRef: "INFRA-001",
    expiresAt: "2026-01-01T00:00:00.000Z",
    notes: "Holiday traffic surge node",
    status: "expired",
    createdBy: "admin",
    createdAt: "2025-12-15T12:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
  },
  {
    id: "ra000000-0000-0000-0000-000000000010",
    subnetId: SUBNETS[7].id,
    subnet: { name: "Public Web Services", cidr: "2001:db8:1::/48" },
    ipAddress: "2001:db8:1::1",
    hostname: "web-frontend-v6",
    owner: "web-team",
    projectRef: "WEB-020",
    expiresAt: null,
    notes: "IPv6 frontend load balancer",
    status: "active",
    createdBy: "dmoore",
    createdAt: "2026-03-05T11:00:00.000Z",
    updatedAt: "2026-03-05T11:00:00.000Z",
  },
];

const USERS = [
  { id: "u1", username: "admin", role: "admin", authProvider: "local", createdAt: "2025-11-15T08:00:00.000Z", updatedAt: "2025-11-15T08:00:00.000Z", lastLogin: "2026-04-17T07:30:00.000Z" },
  { id: "u2", username: "jsmith", role: "networkadmin", authProvider: "local", createdAt: "2026-01-10T09:00:00.000Z", updatedAt: "2026-01-10T09:00:00.000Z", lastLogin: "2026-04-16T12:00:00.000Z" },
  { id: "u3", username: "kbrown", role: "assetsadmin", authProvider: "local", createdAt: "2026-02-20T14:00:00.000Z", updatedAt: "2026-02-20T14:00:00.000Z", lastLogin: null },
  { id: "u4", username: "dmoore", role: "admin", authProvider: "local", createdAt: "2026-03-01T08:00:00.000Z", updatedAt: "2026-03-01T08:00:00.000Z", lastLogin: "2026-04-17T08:15:00.000Z" },
  { id: "u5", username: "rjones", role: "readonly", authProvider: "azure", displayName: "Robert Jones", email: "rjones@rogersgroup.com", createdAt: "2026-04-10T10:00:00.000Z", updatedAt: "2026-04-10T10:00:00.000Z", lastLogin: "2026-04-16T09:00:00.000Z" },
  { id: "u6", username: "mwilson", role: "user", authProvider: "azure", displayName: "Maria Wilson", email: "mwilson@rogersgroup.com", createdAt: "2026-04-12T09:00:00.000Z", updatedAt: "2026-04-12T09:00:00.000Z", lastLogin: "2026-04-17T08:00:00.000Z" },
];

const INTEGRATIONS = [
  {
    id: "i1000000-0000-0000-0000-000000000001",
    type: "fortimanager",
    name: "Production FortiManager",
    config: {
      host: "fmg.example.com",
      port: 443,
      apiUser: "api-readonly",
      apiToken: "••••••••",
      adom: "root",
      verifySsl: true,
      mgmtInterface: "port1",
      dhcpInclude: ["dhcp-prod-01", "dhcp-prod-02", "dhcp-monitor", "dhcp-k8s", "dhcp-database", "dhcp-lab-01"],
      dhcpExclude: [],
      // Auto-Monitor Interfaces — pick a different mode per class to demo
      // all three. FortiGates pin two named WAN uplinks; FortiSwitches use a
      // wildcard to cover access ports 47–48 (the typical uplink pair) only
      // when up; FortiAPs grab every "physical" interface that's online.
      fortigateMonitor:   { addAsMonitored: true, autoMonitorInterfaces: { mode: "names",    names: ["wan1", "wan2"] } },
      fortiswitchMonitor: { enabled: false, snmpCredentialId: null, addAsMonitored: false, autoMonitorInterfaces: { mode: "wildcard", patterns: ["port4[7-8]"], onlyUp: true } },
      fortiapMonitor:     { enabled: false, snmpCredentialId: null, addAsMonitored: false, autoMonitorInterfaces: { mode: "type",     types: ["physical"], onlyUp: true } },
    },
    enabled: true,
    pollInterval: 12,
    lastTestAt: "2026-04-10T14:30:00.000Z",
    lastTestOk: true,
    createdAt: "2026-03-15T09:00:00.000Z",
    updatedAt: "2026-04-10T14:30:00.000Z",
  },
  {
    id: "i2000000-0000-0000-0000-000000000002",
    type: "fortimanager",
    name: "Lab FortiManager",
    config: {
      host: "10.0.1.10",
      port: 8443,
      apiUser: "admin",
      apiToken: "••••••••",
      adom: "lab",
      verifySsl: false,
      mgmtInterface: "mgmt",
      dhcpInclude: [],
      dhcpExclude: ["lab-test-dhcp"],
      deviceInclude: [],
      deviceExclude: ["FG-LAB-*"],
    },
    enabled: false,
    pollInterval: 12,
    lastTestAt: "2026-02-28T11:00:00.000Z",
    lastTestOk: false,
    createdAt: "2026-02-01T10:00:00.000Z",
    updatedAt: "2026-02-28T11:00:00.000Z",
  },
  {
    id: "i4000000-0000-0000-0000-000000000004",
    type: "fortigate",
    name: "Branch Office FortiGate",
    config: {
      host: "10.0.50.1",
      port: 443,
      apiUser: "api-readonly",
      apiToken: "••••••••",
      vdom: "root",
      verifySsl: false,
      mgmtInterface: "port1",
      dhcpInclude: [],
      dhcpExclude: [],
      inventoryIncludeInterfaces: [],
      inventoryExcludeInterfaces: ["guest*"],
      // Auto-Monitor Interfaces on the standalone FortiGate path too.
      fortigateMonitor: { addAsMonitored: false, autoMonitorInterfaces: { mode: "names", names: ["wan1"] } },
    },
    enabled: true,
    pollInterval: 12,
    lastTestAt: "2026-04-18T08:15:00.000Z",
    lastTestOk: true,
    createdAt: "2026-04-05T10:00:00.000Z",
    updatedAt: "2026-04-18T08:15:00.000Z",
  },
  {
    id: "i3000000-0000-0000-0000-000000000003",
    type: "windowsserver",
    name: "DC1 DHCP Server",
    config: {
      host: "10.0.1.50",
      port: 5985,
      username: "Administrator",
      password: "••••••••",
      useSsl: false,
      domain: "CORP",
      dhcpInclude: [],
      dhcpExclude: [],
    },
    enabled: true,
    pollInterval: 6,
    lastTestAt: "2026-04-12T10:00:00.000Z",
    lastTestOk: true,
    createdAt: "2026-04-01T09:00:00.000Z",
    updatedAt: "2026-04-12T10:00:00.000Z",
  },
  {
    id: "i5000000-0000-0000-0000-000000000005",
    type: "entraid",
    name: "Corporate Entra ID",
    config: {
      tenantId: "00000000-0000-0000-0000-000000000000",
      clientId: "11111111-1111-1111-1111-111111111111",
      clientSecret: "••••••••",
      enableIntune: true,
      deviceInclude: [],
      deviceExclude: [],
    },
    enabled: true,
    pollInterval: 12,
    lastTestAt: "2026-04-20T09:00:00.000Z",
    lastTestOk: true,
    createdAt: "2026-04-10T09:00:00.000Z",
    updatedAt: "2026-04-20T09:00:00.000Z",
  },
];

// Mock Entra ID / Intune devices — exercised by demo discover handler below
const MOCK_ENTRA_DEVICES = [
  {
    deviceId: "e1111111-1111-1111-1111-aaaaaaaaaaaa",
    displayName: "LAPTOP-JDOE",
    operatingSystem: "Windows",
    operatingSystemVersion: "10.0.22631",
    trustType: "AzureAd",
    serialNumber: "5CD12345AB",
    macAddress: "AA:BB:CC:11:22:33",
    manufacturer: "Dell",
    model: "Latitude 7440",
    userPrincipalName: "jdoe@corp.example.com",
    chassisType: "laptop",
    complianceState: "compliant",
    lastSyncDateTime: "2026-04-22T13:45:00.000Z",
    registrationDateTime: "2025-09-12T14:00:00.000Z",
  },
  {
    deviceId: "e2222222-2222-2222-2222-bbbbbbbbbbbb",
    displayName: "LAPTOP-ASMITH",
    operatingSystem: "Windows",
    operatingSystemVersion: "10.0.22631",
    trustType: "AzureAd",
    serialNumber: "5CD67890CD",
    macAddress: "AA:BB:CC:44:55:66",
    manufacturer: "Lenovo",
    model: "ThinkPad X1 Carbon Gen 11",
    userPrincipalName: "asmith@corp.example.com",
    chassisType: "laptop",
    complianceState: "compliant",
    lastSyncDateTime: "2026-04-22T10:20:00.000Z",
    registrationDateTime: "2025-11-03T09:30:00.000Z",
  },
  {
    deviceId: "e3333333-3333-3333-3333-cccccccccccc",
    displayName: "DESK-RECEPTION",
    operatingSystem: "Windows",
    operatingSystemVersion: "10.0.19045",
    trustType: "Workplace",
    serialNumber: "HP-DESK-7410",
    macAddress: "AA:BB:CC:77:88:99",
    manufacturer: "HP",
    model: "EliteDesk 800 G9",
    userPrincipalName: "reception@corp.example.com",
    chassisType: "desktop",
    complianceState: "noncompliant",
    lastSyncDateTime: "2026-04-19T16:00:00.000Z",
    registrationDateTime: "2024-07-22T11:00:00.000Z",
  },
  {
    deviceId: "e4444444-4444-4444-4444-dddddddddddd",
    displayName: "IPAD-FIELD-03",
    operatingSystem: "iOS",
    operatingSystemVersion: "17.4",
    trustType: "AzureAd",
    serialNumber: "DNPC12AABC",
    macAddress: "",
    manufacturer: "Apple",
    model: "iPad Air (5th generation)",
    userPrincipalName: "field-tech3@corp.example.com",
    chassisType: "tablet",
    complianceState: "compliant",
    lastSyncDateTime: "2026-04-21T08:15:00.000Z",
    registrationDateTime: "2025-01-15T10:00:00.000Z",
  },
];

const ASSETS = [
  {
    id: "a1000000-0000-0000-0000-000000000001",
    ipAddress: "10.0.1.10",
    macAddress: "00:1A:2B:3C:4D:01",
    macAddresses: [
      { mac: "00:1A:2B:3C:4D:01", lastSeen: "2026-04-15T12:00:00.000Z", source: "manual" },
      { mac: "00:1A:2B:3C:4E:01", lastSeen: "2026-04-10T08:30:00.000Z", source: "dhcp-lease" },
    ],
    hostname: "k8s-worker-01",
    dnsName: "k8s-worker-01.corp.example.com",
    assetTag: "RGI-00101",
    serialNumber: "SN-DELL-R740-001",
    manufacturer: "Dell",
    model: "PowerEdge R740",
    assetType: "server",
    status: "active",
    location: "DC1 Rack A3",
    learnedLocation: null,
    department: "Platform Engineering",
    assignedTo: "platform-team",
    os: "RHEL 9.3",
    osVersion: null,
    lastSeenSwitch: "FS-248E-DC1-01/port15",
    lastSeenAp: null,
    associatedUsers: [],
    acquiredAt: "2025-06-15T00:00:00.000Z",
    warrantyExpiry: "2028-06-15T00:00:00.000Z",
    purchaseOrder: "PO-2025-0042",
    notes: "Primary K8s worker node, 256GB RAM, 2x Xeon Gold",
    tags: ["kubernetes", "prod", "critical"],
    createdAt: "2025-11-16T10:00:00.000Z",
    updatedAt: "2026-01-10T09:00:00.000Z",
  },
  {
    id: "a2000000-0000-0000-0000-000000000002",
    ipAddress: "10.0.1.11",
    macAddress: "00:1A:2B:3C:4D:02",
    macAddresses: [
      { mac: "00:1A:2B:3C:4D:02", lastSeen: "2026-04-15T12:00:00.000Z", source: "manual" },
      { mac: "00:1A:2B:3C:4E:02", lastSeen: "2026-04-14T09:00:00.000Z", source: "dhcp-lease" },
      { mac: "00:1A:2B:3C:4F:02", lastSeen: "2026-03-20T14:00:00.000Z", source: "dhcp-lease" },
    ],
    hostname: "k8s-worker-02",
    dnsName: "k8s-worker-02.corp.example.com",
    assetTag: "RGI-00102",
    serialNumber: "SN-DELL-R740-002",
    manufacturer: "Dell",
    model: "PowerEdge R740",
    assetType: "server",
    status: "active",
    location: "DC1 Rack A3",
    learnedLocation: null,
    department: "Platform Engineering",
    assignedTo: "platform-team",
    os: "RHEL 9.3",
    osVersion: null,
    lastSeenSwitch: "FS-248E-DC1-01/port16",
    lastSeenAp: null,
    associatedUsers: [],
    acquiredAt: "2025-06-15T00:00:00.000Z",
    warrantyExpiry: "2028-06-15T00:00:00.000Z",
    purchaseOrder: "PO-2025-0042",
    notes: "Secondary K8s worker node",
    tags: ["kubernetes", "prod"],
    createdAt: "2025-11-16T10:05:00.000Z",
    updatedAt: "2026-01-10T09:00:00.000Z",
  },
  {
    id: "a3000000-0000-0000-0000-000000000003",
    ipAddress: "10.0.2.10",
    macAddress: "00:1A:2B:3C:4D:10",
    macAddresses: [
      { mac: "00:1A:2B:3C:4D:10", lastSeen: "2026-04-15T11:00:00.000Z", source: "manual" },
      { mac: "00:1A:2B:3C:4E:10", lastSeen: "2026-04-15T11:00:00.000Z", source: "manual" },
    ],
    hostname: "postgres-primary",
    dnsName: "postgres-primary.corp.example.com",
    assetTag: "RGI-00200",
    serialNumber: "SN-DELL-R750-010",
    manufacturer: "Dell",
    model: "PowerEdge R750",
    assetType: "server",
    status: "active",
    location: "DC1 Rack B1",
    learnedLocation: null,
    department: "Data Engineering",
    assignedTo: "data-team",
    os: "RHEL 9.3",
    osVersion: null,
    lastSeenSwitch: "FS-248E-DC1-02/port1",
    lastSeenAp: null,
    associatedUsers: [],
    acquiredAt: "2025-08-01T00:00:00.000Z",
    warrantyExpiry: "2028-08-01T00:00:00.000Z",
    purchaseOrder: "PO-2025-0078",
    notes: "Primary PostgreSQL instance — 512GB RAM, NVMe storage",
    tags: ["database", "prod", "critical"],
    createdAt: "2025-11-17T08:00:00.000Z",
    updatedAt: "2025-11-17T08:00:00.000Z",
  },
  {
    id: "a4000000-0000-0000-0000-000000000004",
    ipAddress: "10.0.3.10",
    macAddress: "00:1A:2B:3C:4D:20",
    macAddresses: [{ mac: "00:1A:2B:3C:4D:20", lastSeen: "2026-04-15T10:00:00.000Z", source: "manual" }],
    hostname: "grafana-01",
    dnsName: "grafana-01.corp.example.com",
    assetTag: "RGI-00305",
    serialNumber: "SN-HP-DL380-005",
    manufacturer: "HPE",
    model: "ProLiant DL380 Gen10",
    assetType: "server",
    status: "active",
    location: "DC1 Rack C2",
    learnedLocation: null,
    department: "SRE",
    assignedTo: "sre-team",
    os: "Ubuntu 22.04 LTS",
    osVersion: null,
    lastSeenSwitch: null,
    lastSeenAp: null,
    associatedUsers: [],
    acquiredAt: "2025-03-20T00:00:00.000Z",
    warrantyExpiry: "2028-03-20T00:00:00.000Z",
    purchaseOrder: "PO-2025-0015",
    notes: "Monitoring stack — Grafana, Prometheus, Loki",
    tags: ["monitoring", "prod"],
    createdAt: "2026-01-12T13:00:00.000Z",
    updatedAt: "2026-01-12T13:00:00.000Z",
  },
  {
    id: "a5000000-0000-0000-0000-000000000005",
    ipAddress: "172.16.0.1",
    macAddress: "00:50:56:AA:BB:01",
    macAddresses: [
      { mac: "00:50:56:AA:BB:01", lastSeen: "2026-04-15T12:00:00.000Z", source: "manual" },
      { mac: "00:50:56:AA:BB:02", lastSeen: "2026-04-15T12:00:00.000Z", source: "manual" },
      { mac: "00:50:56:AA:BB:03", lastSeen: "2026-04-12T08:00:00.000Z", source: "manual" },
    ],
    hostname: "core-sw-01",
    dnsName: "core-sw-01.mgmt.example.com",
    assetTag: "RGI-00500",
    serialNumber: "SN-CISCO-9300-001",
    manufacturer: "Cisco",
    model: "Catalyst 9300-48P",
    assetType: "switch",
    status: "active",
    location: "DC1 MDF",
    learnedLocation: null,
    department: "Network Operations",
    assignedTo: "network-team",
    os: "IOS-XE",
    osVersion: "17.9.4",
    lastSeenSwitch: null,
    lastSeenAp: null,
    associatedUsers: [],
    acquiredAt: "2024-11-01T00:00:00.000Z",
    warrantyExpiry: "2029-11-01T00:00:00.000Z",
    purchaseOrder: "PO-2024-0230",
    notes: "Core distribution switch — 48 PoE+ ports",
    tags: ["network", "core", "critical"],
    createdAt: "2025-11-15T09:10:00.000Z",
    updatedAt: "2025-11-15T09:10:00.000Z",
  },
  {
    id: "a6000000-0000-0000-0000-000000000006",
    ipAddress: "192.168.1.1",
    macAddress: "00:50:56:CC:DD:01",
    macAddresses: [{ mac: "00:50:56:CC:DD:01", lastSeen: "2026-04-15T10:00:00.000Z", source: "manual" }],
    hostname: "fw-edge-01",
    dnsName: "fw-edge-01.mgmt.example.com",
    assetTag: "RGI-00600",
    serialNumber: "SN-FG-3700F-001",
    manufacturer: "Fortinet",
    model: "FortiGate 3700F",
    assetType: "firewall",
    status: "active",
    location: "DC1 Security Rack",
    learnedLocation: null,
    department: "Network Security",
    assignedTo: "network-team",
    os: "FortiOS",
    osVersion: "7.4.3",
    lastSeenSwitch: null,
    lastSeenAp: null,
    associatedUsers: [],
    acquiredAt: "2025-01-15T00:00:00.000Z",
    warrantyExpiry: "2028-01-15T00:00:00.000Z",
    purchaseOrder: "PO-2025-0005",
    notes: "Edge firewall — AWS VPN termination",
    tags: ["firewall", "edge", "critical"],
    // Pre-pinned by the integration's Auto-Monitor Interfaces selection
    // ({mode:"names", names:["wan1","wan2"]}). Fast-cadence polling for the
    // two WAN uplinks on top of the regular ~10 min full system-info pass.
    monitoredInterfaces: ["wan1", "wan2"],
    createdAt: "2026-01-20T15:30:00.000Z",
    updatedAt: "2026-01-20T15:30:00.000Z",
  },
  {
    id: "a7000000-0000-0000-0000-000000000007",
    ipAddress: "10.0.4.50",
    macAddress: "00:1A:2B:3C:4D:50",
    macAddresses: [{ mac: "00:1A:2B:3C:4D:50", lastSeen: "2026-02-15T16:00:00.000Z", source: "manual" }],
    hostname: "ci-runner-old",
    dnsName: "ci-runner-old.corp.example.com",
    assetTag: "RGI-00410",
    serialNumber: "SN-DELL-R630-010",
    manufacturer: "Dell",
    model: "PowerEdge R630",
    assetType: "server",
    status: "decommissioned",
    location: "DC1 Rack D4",
    learnedLocation: null,
    department: "DevOps",
    assignedTo: "devops-team",
    os: "RHEL 8.6",
    osVersion: null,
    lastSeenSwitch: null,
    lastSeenAp: null,
    associatedUsers: [],
    acquiredAt: "2022-03-01T00:00:00.000Z",
    warrantyExpiry: "2025-03-01T00:00:00.000Z",
    purchaseOrder: "PO-2022-0088",
    notes: "Decommissioned CI runner — warranty expired, replaced by cloud runners",
    tags: ["ci", "decommissioned"],
    createdAt: "2025-12-01T08:00:00.000Z",
    updatedAt: "2026-02-15T16:00:00.000Z",
  },
  {
    id: "a8000000-0000-0000-0000-000000000008",
    ipAddress: null,
    macAddress: "00:1A:2B:3C:4D:99",
    macAddresses: [{ mac: "00:1A:2B:3C:4D:99", lastSeen: "2026-03-01T10:00:00.000Z", source: "manual" }],
    hostname: "spare-r740-01",
    dnsName: null,
    assetTag: "RGI-00999",
    serialNumber: "SN-DELL-R740-099",
    manufacturer: "Dell",
    model: "PowerEdge R740",
    assetType: "server",
    status: "storage",
    location: "Warehouse B",
    learnedLocation: null,
    department: "IT Operations",
    assignedTo: null,
    os: null,
    osVersion: null,
    lastSeenSwitch: null,
    lastSeenAp: null,
    associatedUsers: [],
    acquiredAt: "2025-06-15T00:00:00.000Z",
    warrantyExpiry: "2028-06-15T00:00:00.000Z",
    purchaseOrder: "PO-2025-0042",
    notes: "Spare server — available for deployment",
    tags: ["spare", "inventory"],
    createdAt: "2026-03-01T10:00:00.000Z",
    updatedAt: "2026-03-01T10:00:00.000Z",
  },
];

// ─── Tags ───────────────────────────────────────────────────────────────────

const TAGS = [
  { id: "tag-001", name: "prod",           category: "Environment", color: "#4caf50", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-002", name: "staging",        category: "Environment", color: "#ff9800", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-003", name: "dev",            category: "Environment", color: "#2196f3", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-004", name: "critical",       category: "Priority",    color: "#f44336", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-005", name: "kubernetes",     category: "Function",    color: "#326ce5", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-006", name: "database",       category: "Function",    color: "#e91e63", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-007", name: "monitoring",     category: "Function",    color: "#9c27b0", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-008", name: "network",        category: "Function",    color: "#00bcd4", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-009", name: "firewall",       category: "Function",    color: "#ff5722", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-010", name: "ci",             category: "Function",    color: "#795548", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-011", name: "internal",       category: "Network",     color: "#607d8b", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-012", name: "vpn",            category: "Network",     color: "#3f51b5", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-013", name: "datacenter",     category: "Location",    color: "#009688", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-014", name: "cloud",          category: "Location",    color: "#03a9f4", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-015", name: "dhcp-discovered",category: "System",      color: "#78909c", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-016", name: "auto-registered",category: "System",      color: "#78909c", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-017", name: "auto-discovered",category: "System",      color: "#78909c", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-018", name: "spare",          category: "Status",      color: "#bdbdbd", createdAt: "2026-01-10T09:00:00.000Z" },
  { id: "tag-019", name: "decommissioned", category: "Status",      color: "#9e9e9e", createdAt: "2026-01-10T09:00:00.000Z" },
];

const TAG_SETTINGS = { enforce: false };

// ─── Events ─────────────────────────────────────────────────────────────────

const EVENTS = [
  { id: "ev01", timestamp: "2026-04-16T08:00:00.000Z", level: "info", action: "block.created", resourceType: "block", resourceId: BLOCKS[0].id, resourceName: "Corporate Datacenter", actor: "admin", message: 'Block "Corporate Datacenter" (10.0.0.0/8) created' },
  { id: "ev02", timestamp: "2026-04-16T08:01:00.000Z", level: "info", action: "block.created", resourceType: "block", resourceId: BLOCKS[1].id, resourceName: "Management Network", actor: "admin", message: 'Block "Management Network" (172.16.0.0/12) created' },
  { id: "ev03", timestamp: "2026-04-16T08:05:00.000Z", level: "info", action: "subnet.created", resourceType: "subnet", resourceId: SUBNETS[0].id, resourceName: "K8s Node Pool", actor: "admin", message: 'Subnet "K8s Node Pool" (10.0.1.0/24) created' },
  { id: "ev04", timestamp: "2026-04-16T08:06:00.000Z", level: "info", action: "subnet.created", resourceType: "subnet", resourceId: SUBNETS[1].id, resourceName: "Database Tier", actor: "admin", message: 'Subnet "Database Tier" (10.0.2.0/24) created' },
  { id: "ev05", timestamp: "2026-04-16T08:10:00.000Z", level: "info", action: "reservation.created", resourceType: "reservation", resourceId: RESERVATIONS[0].id, resourceName: "k8s-worker-01", actor: "admin", message: 'Reservation created for 10.0.1.10 (platform-team)' },
  { id: "ev06", timestamp: "2026-04-16T08:11:00.000Z", level: "info", action: "reservation.created", resourceType: "reservation", resourceId: RESERVATIONS[3].id, resourceName: "postgres-primary", actor: "dmoore", message: 'Reservation created for 10.0.2.10 (data-team)' },
  { id: "ev07", timestamp: "2026-04-16T09:00:00.000Z", level: "info", action: "integration.created", resourceType: "integration", resourceId: INTEGRATIONS[0].id, resourceName: "Production FortiManager", actor: "admin", message: 'Integration "Production FortiManager" (fortimanager) created' },
  { id: "ev08", timestamp: "2026-04-16T09:01:00.000Z", level: "info", action: "integration.discover.started", resourceType: "integration", resourceId: INTEGRATIONS[0].id, resourceName: "Production FortiManager", actor: "admin", message: 'DHCP discovery started for "Production FortiManager"' },
  { id: "ev09", timestamp: "2026-04-16T09:01:30.000Z", level: "info", action: "integration.discover.completed", resourceType: "integration", resourceId: INTEGRATIONS[0].id, resourceName: "Production FortiManager", actor: "admin", message: 'DHCP discovery completed for "Production FortiManager" \u2014 2 created, 0 updated, 0 skipped' },
  { id: "ev09b", timestamp: "2026-04-16T09:01:32.000Z", level: "info", action: "integration.auto_monitor_interfaces.applied", resourceType: "integration", resourceId: INTEGRATIONS[0].id, resourceName: "Production FortiManager", actor: "admin", message: 'Auto-monitor interfaces applied for "Production FortiManager" (fortigate) \u2014 1 device(s), 2 interface(s) added', details: { class: "fortigate", devices: 1, interfacesAdded: 2 } },
  { id: "ev10", timestamp: "2026-04-16T09:15:00.000Z", level: "info", action: "integration.test.started", resourceType: "integration", resourceId: INTEGRATIONS[0].id, resourceName: "Production FortiManager", actor: "admin", message: 'Connection test started for "Production FortiManager"' },
  { id: "ev11", timestamp: "2026-04-16T09:15:02.000Z", level: "info", action: "integration.test.completed", resourceType: "integration", resourceId: INTEGRATIONS[0].id, resourceName: "Production FortiManager", actor: "admin", message: 'Connection test succeeded for "Production FortiManager": Connected \u2014 FortiManager v7.4.3' },
  { id: "ev12", timestamp: "2026-04-16T10:00:00.000Z", level: "info", action: "asset.created", resourceType: "asset", resourceId: ASSETS[0].id, resourceName: "k8s-worker-01", actor: "dmoore", message: 'Asset "k8s-worker-01" created' },
  { id: "ev13", timestamp: "2026-04-16T10:05:00.000Z", level: "info", action: "asset.updated", resourceType: "asset", resourceId: ASSETS[0].id, resourceName: "k8s-worker-01", actor: "dmoore", message: 'Asset "k8s-worker-01" updated' },
  { id: "ev14", timestamp: "2026-04-16T11:00:00.000Z", level: "info", action: "integration.created", resourceType: "integration", resourceId: INTEGRATIONS[2].id, resourceName: "DC1 DHCP Server", actor: "admin", message: 'Integration "DC1 DHCP Server" (windowsserver) created' },
  { id: "ev15", timestamp: "2026-04-16T11:01:00.000Z", level: "info", action: "integration.discover.started", resourceType: "integration", resourceId: INTEGRATIONS[2].id, resourceName: "DC1 DHCP Server", actor: "admin", message: 'DHCP discovery started for "DC1 DHCP Server"' },
  { id: "ev16", timestamp: "2026-04-16T11:01:15.000Z", level: "info", action: "integration.discover.completed", resourceType: "integration", resourceId: INTEGRATIONS[2].id, resourceName: "DC1 DHCP Server", actor: "admin", message: 'DHCP discovery completed for "DC1 DHCP Server" \u2014 4 created, 0 updated, 0 skipped' },
  { id: "ev17", timestamp: "2026-04-16T12:00:00.000Z", level: "warning", action: "integration.test.completed", resourceType: "integration", resourceId: INTEGRATIONS[1].id, resourceName: "Lab FortiManager", actor: "jsmith", message: 'Connection test failed for "Lab FortiManager": Connection refused' },
  { id: "ev18", timestamp: "2026-04-16T12:30:00.000Z", level: "error", action: "integration.discover.error", resourceType: "integration", resourceId: INTEGRATIONS[1].id, resourceName: "Lab FortiManager", actor: "jsmith", message: 'DHCP discovery failed for "Lab FortiManager": Connection timeout after 30s' },
  { id: "ev19", timestamp: "2026-04-16T13:00:00.000Z", level: "info", action: "subnet.updated", resourceType: "subnet", resourceId: SUBNETS[3].id, resourceName: "CI/CD Runners", actor: "dmoore", message: 'Subnet "CI/CD Runners" updated' },
  { id: "ev20", timestamp: "2026-04-16T13:30:00.000Z", level: "info", action: "reservation.released", resourceType: "reservation", resourceId: RESERVATIONS[8].id, resourceName: "k8s-temp-node", actor: "admin", message: 'Reservation released' },
  { id: "ev21", timestamp: "2026-04-16T14:00:00.000Z", level: "info", action: "block.updated", resourceType: "block", resourceId: BLOCKS[2].id, resourceName: "Cloud VPN", actor: "dmoore", message: 'Block "Cloud VPN" updated' },
  { id: "ev22", timestamp: "2026-04-16T14:30:00.000Z", level: "info", action: "integration.updated", resourceType: "integration", resourceId: INTEGRATIONS[0].id, resourceName: "Production FortiManager", actor: "admin", message: 'Integration "Production FortiManager" updated' },
];

// ─── Conflicts (discovery conflict review) ────────────────────────────────

let CONFLICTS = [
  {
    id: "c5000000-0000-0000-0000-000000000001",
    entityType: "asset",
    reservationId: null,
    reservation: null,
    assetId: "a1000000-0000-0000-0000-000000000001",  // k8s-worker-01 seed asset
    asset: null, // filled in on GET
    integrationId: "i5000000-0000-0000-0000-000000000005",  // Corporate Entra ID
    proposedHostname: null,
    proposedOwner: null,
    proposedProjectRef: null,
    proposedNotes: null,
    proposedSourceType: null,
    proposedDeviceId: "eab53210-dead-beef-cafe-000000000001",
    proposedAssetFields: {
      deviceId: "eab53210-dead-beef-cafe-000000000001",
      hostname: "k8s-worker-01",
      serialNumber: "5CD-ENTRA-001",
      macAddress: "AA:BB:CC:DE:AD:01",
      manufacturer: "Dell",
      model: "Latitude 7440",
      os: "Windows",
      osVersion: "10.0.22631",
      assignedTo: "platform-team@corp.example.com",
      chassisType: "laptop",
      complianceState: "compliant",
      trustType: "AzureAd",
      assetType: "workstation",
      lastSeen: "2026-04-22T09:30:00.000Z",
      registrationDateTime: "2025-08-01T14:00:00.000Z",
    },
    conflictFields: ["hostname"],
    status: "pending",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "2026-04-22T10:00:00.000Z",
    updatedAt: "2026-04-22T10:00:00.000Z",
  },
];

// ─── Archive Settings ──────────────────────────────────────────────────────

let ARCHIVE_SETTINGS = {
  enabled: false,
  protocol: "scp",
  host: "",
  port: 22,
  username: "",
  password: "",
  keyPath: "",
  remotePath: "/var/archive/polaris",
};

let SYSLOG_SETTINGS = {
  enabled: false,
  protocol: "udp",
  host: "",
  port: 514,
  facility: "local0",
  severity: "info",
  format: "rfc5424",
  tlsCaPath: "",
  tlsCertPath: "",
  tlsKeyPath: "",
};

// ─── Server Settings (NTP + Certificates) ─────────────────────────────────

let NTP_SETTINGS = {
  enabled: false,
  mode: "ntp",
  servers: [],
  timezoneOverride: null,
};

let CERTIFICATES = [];
let BACKUP_HISTORY = [];
const API_TOKENS = [];  // in-memory for demo; reset on server restart
let BACKUP_BLOBS = {};  // id → Buffer, kept in memory for demo re-downloads

let HTTPS_SETTINGS = {
  enabled: false,
  port: 3443,
  httpPort: 3000,
  certId: null,
  keyId: null,
  redirectHttp: false,
};

let SSO_SETTINGS = {
  enabled: false,
  spEntityId: "",
  idpEntityId: "",
  idpLoginUrl: "",
  idpLogoutUrl: "",
  idpCertificate: "",
  wantResponseSigned: false,
  skipLoginPage: false,
  autoLogoutMinutes: 0,
};

let OIDC_SETTINGS = {
  enabled: false,
  discoveryUrl: "",
  clientId: "",
  clientSecret: "",
  scopes: "openid profile email",
};

let LDAP_SETTINGS = {
  enabled: false,
  url: "",
  bindDn: "",
  bindPassword: "",
  searchBase: "",
  searchFilter: "(sAMAccountName={{username}})",
  tlsVerify: true,
  displayNameAttr: "displayName",
  emailAttr: "mail",
};

const TAG_COLORS = ["#4fc3f7","#4ade80","#f59e0b","#f472b6","#a78bfa","#fb923c","#38bdf8","#34d399","#e879f9","#facc15","#f87171","#2dd4bf","#818cf8","#c084fc"];
function randomTagColor() { return TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)]; }

let PG_TUNING_SNOOZE = { until: null };

let DEMO_UPDATE_STATUS = { state: "idle" };

function _bumpPatch(version) {
  const parts = (version || "0.0.0").split(".");
  parts[2] = String((parseInt(parts[2], 10) || 0) + 1);
  return parts.join(".");
}

let DNS_SETTINGS = { servers: [], mode: "standard", dohUrl: "" };
let OUI_STATUS = { loaded: true, entries: 31265, refreshedAt: new Date(Date.now() - 2 * 86400000).toISOString() };
let OUI_OVERRIDES = [
  { prefix: "AA:BB:CC", manufacturer: "Custom Internal Switch" },
  { prefix: "DE:AD:BE", manufacturer: "Lab Test Device" },
];

// Mock OUI lookup table — maps common MAC prefixes to vendors
const _MOCK_OUI_MAP = {
  "00:1A:2B": "Ayecom Technology", "00:50:56": "VMware, Inc.", "00:0C:29": "VMware, Inc.",
  "00:25:90": "Super Micro Computer", "3C:EC:EF": "Dell Technologies", "B4:96:91": "Intel Corporate",
  "D8:9E:F3": "Dell Inc.", "98:90:96": "Dell Inc.", "F0:1F:AF": "Dell Inc.",
  "00:1E:67": "Intel Corporate", "00:1B:21": "Intel Corporate", "A0:36:9F": "Intel Corporate",
  "00:23:24": "Cisco Systems", "00:1A:A1": "Cisco Systems", "58:AC:78": "Cisco Systems",
  "AC:17:C8": "Cisco Systems", "34:56:FE": "Cisco Systems",
  "00:1A:6B": "Universal Global Scientific Ind.", "3C:D9:2B": "Hewlett Packard",
  "00:17:A4": "Hewlett Packard", "94:57:A5": "Hewlett Packard Enterprise",
  "1C:98:EC": "Hewlett Packard Enterprise",
  "F8:75:A4": "LCFC(HeFei) Electronics",
  "00:26:B9": "Dell Inc.",
};
function _mockOuiLookup(mac) {
  if (!mac) return null;
  const prefix = mac.toUpperCase().replace(/[-]/g, ":").slice(0, 8);
  return _MOCK_OUI_MAP[prefix] || "Unknown Vendor Inc.";
}

let BRANDING = {
  appName: "Polaris",
  subtitle: "Network Management Tool",
  logoUrl: "/logo.png",
};
let _httpsServer = null;

function extractSubjectDemo(pem) {
  const match = pem.match(/subject\s*[:=]\s*(.+)/i);
  if (match) return match[1].trim();
  if (pem.includes("CERTIFICATE")) return "X.509 Certificate";
  if (pem.includes("PRIVATE KEY")) return "Private Key";
  return null;
}

function parseMultipart(buf, contentType) {
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) return { fields: {}, file: null };
  const boundary = boundaryMatch[1].replace(/^["']|["']$/g, "");
  const raw = typeof buf === "string" ? buf : buf.toString("binary");
  const parts = raw.split("--" + boundary).slice(1, -1);
  const fields = {};
  let file = null;

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.substring(0, headerEnd);
    const body = part.substring(headerEnd + 4).replace(/\r\n$/, "");
    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    if (filenameMatch) {
      file = { fieldname: nameMatch?.[1], originalname: filenameMatch[1], content: body };
    } else if (nameMatch) {
      fields[nameMatch[1]] = body.trim();
    }
  }
  return { fields, file };
}

function logEventDemo(input) {
  EVENTS.push({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level: input.level || "info",
    action: input.action,
    resourceType: input.resourceType || null,
    resourceId: input.resourceId || null,
    resourceName: input.resourceName || null,
    actor: input.actor || "admin",
    message: input.message,
  });
}

// ─── Utilization ─────────────────────────────────────────────────────────────

function buildUtilization() {
  const subnetsByStatus = { available: 0, reserved: 0, deprecated: 0 };
  SUBNETS.forEach((s) => subnetsByStatus[s.status]++);

  const blockUtilization = BLOCKS.map((b) => {
    const subs = SUBNETS.filter((s) => s.blockId === b.id);
    const disc = subs.filter((s) => s.status === "available" && s.discoveredBy != null).length;
    const avail = subs.filter((s) => s.status === "available" && s.discoveredBy == null).length;
    const res = subs.filter((s) => s.status === "reserved").length;
    const dep = subs.filter((s) => s.status === "deprecated").length;
    const cidrCount = (cidr) => { const p = parseInt(cidr.split("/")[1], 10); return cidr.includes(":") ? Math.pow(2, Math.min(128 - p, 52)) : Math.pow(2, 32 - p); };
    const blockAddresses = cidrCount(b.cidr);
    const allocatedAddresses = subs.reduce((sum, s) => sum + cidrCount(s.cidr), 0);
    const usedPercent = blockAddresses === 0 ? 0 : Math.round((allocatedAddresses / blockAddresses) * 100);
    return {
      blockId: b.id, name: b.name, cidr: b.cidr,
      totalSubnets: subs.length,
      availableSubnets: avail, discoveredSubnets: disc, reservedSubnets: res, deprecatedSubnets: dep,
      blockAddresses, allocatedAddresses, usedPercent,
    };
  });

  const active = RESERVATIONS.filter((r) => r.status === "active");
  const recent = [...RESERVATIONS]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5)
    .map((r) => {
      const subnet = SUBNETS.find((s) => s.id === r.subnetId);
      return {
        ...r,
        subnetCidr: subnet?.cidr,
        subnetName: subnet?.name,
        subnetPurpose: subnet?.purpose,
        vlan: subnet?.vlan,
      };
    });

  return {
    totalBlocks: BLOCKS.length,
    totalSubnets: SUBNETS.length,
    totalActiveReservations: active.length,
    subnetsByStatus,
    blockUtilization,
    recentReservations: recent,
  };
}

// ─── Auto-register FortiManager IP ──────────────────────────────────────────

function isPrivateIp(ip) {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [, a, b] = m.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function buildProposed(host, name) {
  const hostname = name.toLowerCase().replace(/\s+/g, "-");
  return {
    reservation: {
      ipAddress: host,
      hostname,
      owner: "network-team",
      projectRef: "FortiManager Integration",
      notes: `Auto-registered from FortiManager integration: ${name}`,
      status: "active",
    },
    asset: {
      ipAddress: host,
      hostname,
      manufacturer: "Fortinet",
      model: "FortiManager",
      assetType: "server",
      status: "active",
      department: "Network Security",
      notes: `Auto-registered from FortiManager integration: ${name}`,
    },
  };
}

function registerFortiManagerDemo(host, name, force, fields) {
  if (!host || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return { conflicts: [], created: [] };
  }

  const subnet = SUBNETS.find((s) => {
    const subnetPrefix = s.cidr.replace(/\.\d+\/\d+$/, "");
    return host.startsWith(subnetPrefix + ".");
  });

  if (!subnet && !isPrivateIp(host)) return { conflicts: [], created: [] };

  const conflicts = [];
  const created = [];
  const proposed = buildProposed(host, name);
  const now = new Date().toISOString();

  // ── Reservation ──
  if (subnet) {
    const existIdx = RESERVATIONS.findIndex((r) => r.ipAddress === host && r.status === "active");
    if (existIdx !== -1) {
      if (force) {
        // Only overwrite admin-selected fields
        const allowedFields = ["hostname", "owner", "projectRef", "notes", "status"];
        const selectedFields = Array.isArray(fields) ? fields : [];
        selectedFields.forEach((f) => {
          if (allowedFields.includes(f) && f in proposed.reservation) {
            RESERVATIONS[existIdx][f] = proposed.reservation[f];
          }
        });
        RESERVATIONS[existIdx].updatedAt = now;
        created.push("reservation");
      } else {
        const e = RESERVATIONS[existIdx];
        conflicts.push({
          type: "reservation",
          existing: { id: e.id, ipAddress: e.ipAddress, hostname: e.hostname, owner: e.owner, projectRef: e.projectRef, notes: e.notes, status: e.status, subnetCidr: subnet.cidr },
          proposed: { ...proposed.reservation, subnetCidr: subnet.cidr },
        });
      }
    } else {
      RESERVATIONS.push({
        id: crypto.randomUUID(),
        subnetId: subnet.id,
        subnet: { name: subnet.name, cidr: subnet.cidr },
        ...proposed.reservation,
        expiresAt: null,
        createdBy: sessionUser?.username || "system",
        createdAt: now,
        updatedAt: now,
      });
      created.push("reservation");
    }
  }

  // ── Asset (always create — multiple assets may share an IP) ──
  ASSETS.push({
    id: crypto.randomUUID(),
    ...proposed.asset,
    macAddress: null, dnsName: null, assetTag: null, serialNumber: null,
    location: null, learnedLocation: null, assignedTo: null, os: null, acquiredAt: null,
    warrantyExpiry: null, purchaseOrder: null,
    tags: ["fortimanager", "auto-registered"],
    createdAt: now, updatedAt: now,
  });
  created.push("asset");

  return { conflicts, created };
}

// ─── DHCP Discovery (mock) ───────────────────────────────────────────────────

const MOCK_DEVICES = [
  { name: "FGT-DC1-01", hostname: "FGT-DC1-01", serial: "FGT60F0000000001", model: "FortiGate 60F", mgmtIp: "10.0.1.1" },
  { name: "FGT-DC1-02", hostname: "FGT-DC1-02", serial: "FGT60F0000000002", model: "FortiGate 60F", mgmtIp: "10.0.1.2" },
];

const MOCK_DHCP_SERVERS = [
  { device: "FGT-DC1-01", iface: "port1",  id: "4", cidr: "10.0.1.0/24",  name: "dhcp-k8s", ifaceIp: "10.0.1.1" },
  { device: "FGT-DC1-01", iface: "port2",  id: "5", cidr: "10.0.2.0/24",  name: "dhcp-database", ifaceIp: "10.0.2.1" },
  { device: "FGT-DC1-01", iface: "port5",  id: "1", cidr: "10.0.10.0/24", name: "dhcp-prod-01", ifaceIp: "10.0.10.1" },
  { device: "FGT-DC1-01", iface: "port6",  id: "2", cidr: "10.0.11.0/24", name: "dhcp-prod-02", ifaceIp: "10.0.11.1" },
  { device: "FGT-DC1-02", iface: "port2",  id: "1", cidr: "10.0.3.0/24",  name: "dhcp-monitor", ifaceIp: "10.0.3.1" },
  { device: "FGT-DC1-02", iface: "port3",  id: "2", cidr: "10.0.20.0/24", name: "dhcp-lab-01", ifaceIp: "10.0.20.1" },
  { device: "FGT-DC1-02", iface: "port7",  id: "3", cidr: "10.0.21.0/24", name: "lab-test-dhcp", ifaceIp: "10.0.21.1" },
];

// Mock DHCP entries: static reservations and dynamic leases
const MOCK_DHCP_ENTRIES = [
  // Entries that overlap with manual reservations (conflict test cases)
  // Case 1: DHCP reservation + same IP + same MAC → promote to "DHCP Reservation"
  { device: "FGT-DC1-01", iface: "port1", ip: "10.0.1.10", mac: "AA:BB:CC:DD:10:10", hostname: "k8s-worker-01", type: "dhcp-reservation" },
  // Case 2: DHCP reservation + same IP + different MAC → "Conflict: MAC address reservation doesn't match"
  { device: "FGT-DC1-01", iface: "port1", ip: "10.0.1.12", mac: "FF:FF:FF:DD:10:12", hostname: "k8s-worker-03", type: "dhcp-reservation" },
  // Case 3: DHCP lease + same IP + different MAC → "Conflict: MAC address lease doesn't match reservation"
  { device: "FGT-DC1-01", iface: "port1", ip: "10.0.1.11", mac: "FF:FF:FF:DD:10:11", hostname: "k8s-worker-02", type: "dhcp-lease" },
  // Case 4: DHCP lease + same IP + same MAC → "Conflict: Lease should be reserved on FGT-DC1-01"
  { device: "FGT-DC1-01", iface: "port2", ip: "10.0.2.10", mac: "AA:BB:CC:DD:20:10", hostname: "postgres-primary", type: "dhcp-lease" },
  // Monitoring Stack conflict: DHCP lease + different MAC on grafana-01 IP
  { device: "FGT-DC1-02", iface: "port2", ip: "10.0.3.10", mac: "FF:FF:FF:DD:03:10", hostname: "unknown-device", type: "dhcp-lease" },
  // Static reservations on FGT-DC1-01
  { device: "FGT-DC1-01", iface: "port5", ip: "10.0.10.10", mac: "AA:BB:CC:01:10:0A", hostname: "k8s-master-01", type: "dhcp-reservation" },
  { device: "FGT-DC1-01", iface: "port5", ip: "10.0.10.11", mac: "AA:BB:CC:01:10:0B", hostname: "k8s-master-02", type: "dhcp-reservation" },
  { device: "FGT-DC1-01", iface: "port5", ip: "10.0.10.12", mac: "AA:BB:CC:01:10:0C", hostname: "k8s-master-03", type: "dhcp-reservation" },
  { device: "FGT-DC1-01", iface: "port6", ip: "10.0.11.10", mac: "AA:BB:CC:01:11:0A", hostname: "db-primary", type: "dhcp-reservation" },
  { device: "FGT-DC1-01", iface: "port6", ip: "10.0.11.11", mac: "AA:BB:CC:01:11:0B", hostname: "db-replica-01", type: "dhcp-reservation" },
  // Dynamic leases on FGT-DC1-01
  { device: "FGT-DC1-01", iface: "port5", ip: "10.0.10.100", mac: "DE:AD:BE:EF:01:01", hostname: "k8s-worker-01", type: "dhcp-lease" },
  { device: "FGT-DC1-01", iface: "port5", ip: "10.0.10.101", mac: "DE:AD:BE:EF:01:02", hostname: "k8s-worker-02", type: "dhcp-lease" },
  { device: "FGT-DC1-01", iface: "port5", ip: "10.0.10.102", mac: "DE:AD:BE:EF:01:03", hostname: "k8s-worker-03", type: "dhcp-lease" },
  { device: "FGT-DC1-01", iface: "port6", ip: "10.0.11.100", mac: "DE:AD:BE:EF:02:01", hostname: "cache-01", type: "dhcp-lease" },
  // Static reservations on FGT-DC1-02
  { device: "FGT-DC1-02", iface: "port3", ip: "10.0.20.10", mac: "AA:BB:CC:02:20:0A", hostname: "lab-server-01", type: "dhcp-reservation" },
  { device: "FGT-DC1-02", iface: "port3", ip: "10.0.20.11", mac: "AA:BB:CC:02:20:0B", hostname: "lab-server-02", type: "dhcp-reservation" },
  // Dynamic leases on FGT-DC1-02
  { device: "FGT-DC1-02", iface: "port3", ip: "10.0.20.100", mac: "DE:AD:BE:EF:03:01", hostname: "dev-laptop-01", type: "dhcp-lease" },
  { device: "FGT-DC1-02", iface: "port3", ip: "10.0.20.101", mac: "DE:AD:BE:EF:03:02", hostname: "dev-laptop-02", type: "dhcp-lease" },
  { device: "FGT-DC1-02", iface: "port7", ip: "10.0.21.100", mac: "DE:AD:BE:EF:04:01", hostname: "test-vm-01", type: "dhcp-lease" },
  { device: "FGT-DC1-02", iface: "port7", ip: "10.0.21.101", mac: "DE:AD:BE:EF:04:02", hostname: "", type: "dhcp-lease" },
];

const MOCK_DEVICE_INVENTORY = [
  // Devices on FGT-DC1-01 — some overlap with DHCP entries, some are new
  // k8s-worker-01 already in DHCP leases (port5) — inventory fills in OS, switch info
  { device: "FGT-DC1-01", iface: "port5", mac: "DE:AD:BE:EF:01:01", ip: "10.0.10.100", hostname: "k8s-worker-01", os: "Linux", osVersion: "RHEL 9.3", vendor: "Dell Inc.", switchName: "FS-248E-DC1-01", switchPort: "15", apName: "", user: "", online: true, lastSeen: "2026-04-16T08:30:00.000Z" },
  // k8s-worker-02 in DHCP leases — inventory fills in OS, switch info
  { device: "FGT-DC1-01", iface: "port5", mac: "DE:AD:BE:EF:01:02", ip: "10.0.10.101", hostname: "k8s-worker-02", os: "Linux", osVersion: "RHEL 9.3", vendor: "Dell Inc.", switchName: "FS-248E-DC1-01", switchPort: "16", apName: "", user: "", online: true, lastSeen: "2026-04-16T08:30:00.000Z" },
  // k8s-worker-03 in DHCP leases — inventory fills in details
  { device: "FGT-DC1-01", iface: "port5", mac: "DE:AD:BE:EF:01:03", ip: "10.0.10.102", hostname: "k8s-worker-03", os: "Linux", osVersion: "RHEL 9.3", vendor: "Dell Inc.", switchName: "FS-248E-DC1-01", switchPort: "17", apName: "", user: "", online: true, lastSeen: "2026-04-16T08:30:00.000Z" },
  // db-primary in DHCP reservations (port6) — inventory adds switch info
  { device: "FGT-DC1-01", iface: "port6", mac: "AA:BB:CC:01:11:0A", ip: "10.0.11.10", hostname: "db-primary", os: "Linux", osVersion: "Ubuntu 22.04.3 LTS", vendor: "Dell Inc.", switchName: "FS-248E-DC1-02", switchPort: "1", apName: "", user: "ROGERS\\svc-postgres", online: true, lastSeen: "2026-04-16T09:00:00.000Z" },
  // Entirely new device — printer not in DHCP at all, on port5
  { device: "FGT-DC1-01", iface: "port5", mac: "00:1E:8F:AA:BB:01", ip: "10.0.10.200", hostname: "hp-printer-dc1", os: "Embedded", osVersion: "HP FutureSmart 5.6", vendor: "HP Inc.", switchName: "FS-248E-DC1-01", switchPort: "24", apName: "", user: "", online: true, lastSeen: "2026-04-16T07:15:00.000Z" },
  // Wireless laptop on port5 — connected via FortiAP
  { device: "FGT-DC1-01", iface: "port5", mac: "F8:FF:C2:01:02:03", ip: "10.0.10.201", hostname: "laptop-jsmith", os: "Windows", osVersion: "Windows 11 23H2", vendor: "Lenovo", switchName: "", switchPort: "", apName: "FAP-431F-DC1-01", user: "ROGERS\\jsmith", online: true, lastSeen: "2026-04-16T10:00:00.000Z" },
  // Devices on FGT-DC1-02
  // dev-laptop-01 in DHCP leases (port3)
  { device: "FGT-DC1-02", iface: "port3", mac: "DE:AD:BE:EF:03:01", ip: "10.0.20.100", hostname: "dev-laptop-01", os: "macOS", osVersion: "macOS 15.2 Sequoia", vendor: "Apple Inc.", switchName: "", switchPort: "", apName: "FAP-431F-DC1-02", user: "ROGERS\\tchen", online: true, lastSeen: "2026-04-16T09:45:00.000Z" },
  // New: IP phone on port3
  { device: "FGT-DC1-02", iface: "port3", mac: "00:04:F2:CC:DD:01", ip: "10.0.20.202", hostname: "phone-conf-room-a", os: "Embedded", osVersion: "Polycom UC 7.1", vendor: "Poly", switchName: "FS-124E-DC1-01", switchPort: "8", apName: "", user: "", online: true, lastSeen: "2026-04-16T06:00:00.000Z" },
  // New: security camera on port7 (excluded interface if user excludes port7)
  { device: "FGT-DC1-02", iface: "port7", mac: "70:B3:D5:01:02:03", ip: "10.0.21.200", hostname: "cam-lobby-01", os: "Embedded", osVersion: "Hikvision 4.30", vendor: "Hikvision", switchName: "FS-124E-DC1-01", switchPort: "20", apName: "", user: "", online: true, lastSeen: "2026-04-16T08:00:00.000Z" },
];

const MOCK_WIN_DHCP_SCOPES = [
  { scopeId: "10.0.30.0", subnetMask: "255.255.255.0", name: "Office-Floor1" },
  { scopeId: "10.0.31.0", subnetMask: "255.255.255.0", name: "Office-Floor2" },
  { scopeId: "10.0.32.0", subnetMask: "255.255.255.0", name: "Guest-WiFi" },
  { scopeId: "10.0.33.0", subnetMask: "255.255.255.0", name: "VoIP-Phones" },
];

function discoverWinDhcpDemo(config) {
  let scopes = [...MOCK_WIN_DHCP_SCOPES];
  const include = config.dhcpInclude || [];
  const exclude = config.dhcpExclude || [];

  if (include.length > 0) {
    scopes = scopes.filter((s) =>
      include.some((p) => s.name.toLowerCase().includes(p.toLowerCase()) || s.scopeId.includes(p))
    );
  }
  if (exclude.length > 0) {
    scopes = scopes.filter((s) =>
      !exclude.some((p) => s.name.toLowerCase().includes(p.toLowerCase()) || s.scopeId.includes(p))
    );
  }

  const subnets = scopes.map((s) => ({
    cidr: s.scopeId + "/24",
    name: s.name,
    fortigateDevice: config.host,
    dhcpServerId: s.scopeId,
  }));

  return { subnets, devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [] };
}

function _ipInCidrDemo(ip, cidr) {
  try { return new Netmask(cidr).contains(ip); } catch { return false; }
}

function matchesWildcardDemo(pattern, value) {
  const p = String(pattern || "").toLowerCase();
  const v = String(value || "").toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return v.includes(p.slice(1, -1));
  if (p.startsWith("*")) return v.endsWith(p.slice(1));
  if (p.endsWith("*")) return v.startsWith(p.slice(0, -1));
  return v === p;
}

function discoverEntraDevicesDemo(config, log) {
  if (!log) log = () => {};
  let devices = MOCK_ENTRA_DEVICES.map((d) => ({ ...d }));

  // If Intune sync is off, clear Intune-only fields to mirror real behaviour
  if (!config.enableIntune) {
    devices = devices.map((d) => ({
      deviceId: d.deviceId,
      displayName: d.displayName,
      operatingSystem: d.operatingSystem,
      operatingSystemVersion: d.operatingSystemVersion,
      trustType: d.trustType,
      registrationDateTime: d.registrationDateTime,
      approximateLastSignInDateTime: d.lastSyncDateTime,
    }));
  }

  // Apply include/exclude filter on displayName
  const include = config.deviceInclude || [];
  const exclude = config.deviceExclude || [];
  if (include.length > 0) {
    devices = devices.filter((d) => include.some((p) => matchesWildcardDemo(p, d.displayName)));
  } else if (exclude.length > 0) {
    devices = devices.filter((d) => !exclude.some((p) => matchesWildcardDemo(p, d.displayName)));
  }

  log("discover.entra.devices", "info", `Entra ID (demo): retrieved ${MOCK_ENTRA_DEVICES.length} device(s)`);
  if (config.enableIntune) {
    log("discover.intune.devices", "info", `Intune (demo): retrieved ${MOCK_ENTRA_DEVICES.filter((d) => d.chassisType).length} managed device(s)`);
  }
  log("discover.filter", "info", `Merged total: ${devices.length} device(s)`);

  return { devices };
}

const ENTRA_ASSET_TAG_PREFIX_DEMO = "entra:";

function entraAssetTypeDemo(chassis, os) {
  const c = String(chassis || "").toLowerCase();
  if (["desktop", "laptop", "convertible", "detachable"].includes(c)) return "workstation";
  if (["tablet", "phone"].includes(c)) return "other";
  const lower = String(os || "").toLowerCase();
  if (lower.includes("ios") || lower.includes("android")) return "other";
  return "workstation";
}

function syncEntraDevicesDemo(integrationId, integrationName, result, syncLog) {
  const log = syncLog || (() => {});
  const created = [];
  const updated = [];
  const skipped = [];
  const now = new Date().toISOString();

  const byTag = new Map();
  const byHostnameNoTag = new Map();
  for (const a of ASSETS) {
    const tag = a.assetTag || "";
    if (tag.startsWith(ENTRA_ASSET_TAG_PREFIX_DEMO)) {
      byTag.set(tag.slice(ENTRA_ASSET_TAG_PREFIX_DEMO.length).toLowerCase(), a);
    } else if (!tag && a.hostname) {
      byHostnameNoTag.set(a.hostname.toLowerCase(), a);
    }
  }

  for (const dev of result.devices) {
    const key = String(dev.deviceId || "").toLowerCase();
    if (!key) { skipped.push(`${dev.displayName || "<unnamed>"} (missing deviceId)`); continue; }
    const tags = ["entraid", "auto-discovered"];
    if (dev.trustType) tags.push(dev.trustType.toLowerCase());
    if (dev.complianceState) tags.push(`intune-${dev.complianceState.toLowerCase()}`);

    const existing = byTag.get(key);
    if (existing) {
      existing.hostname = dev.displayName || existing.hostname;
      existing.os = dev.operatingSystem || existing.os;
      existing.osVersion = dev.operatingSystemVersion || existing.osVersion;
      existing.lastSeen = dev.lastSyncDateTime || dev.approximateLastSignInDateTime || existing.lastSeen;
      if (dev.serialNumber) existing.serialNumber = dev.serialNumber;
      if (dev.macAddress) existing.macAddress = dev.macAddress;
      if (dev.manufacturer) existing.manufacturer = dev.manufacturer;
      if (dev.model) existing.model = dev.model;
      if (dev.userPrincipalName) existing.assignedTo = dev.userPrincipalName;
      existing.updatedAt = now;
      existing.tags = tags;
      updated.push(dev.displayName || dev.deviceId);
      continue;
    }

    if (dev.displayName) {
      const collision = byHostnameNoTag.get(dev.displayName.toLowerCase());
      if (collision) {
        log("warning", `Hostname collision — Entra device "${dev.displayName}" matches existing asset ${collision.id}. Skipped.`);
        skipped.push(`${dev.displayName} (hostname collision)`);
        continue;
      }
    }

    const newAsset = {
      id: crypto.randomUUID(),
      ipAddress: null,
      macAddress: dev.macAddress || null,
      macAddresses: [],
      hostname: dev.displayName || null,
      dnsName: null,
      assetTag: `${ENTRA_ASSET_TAG_PREFIX_DEMO}${dev.deviceId}`,
      serialNumber: dev.serialNumber || null,
      manufacturer: dev.manufacturer || null,
      model: dev.model || null,
      assetType: entraAssetTypeDemo(dev.chassisType, dev.operatingSystem),
      status: "active",
      location: null,
      learnedLocation: null,
      department: null,
      assignedTo: dev.userPrincipalName || null,
      os: dev.operatingSystem || null,
      osVersion: dev.operatingSystemVersion || null,
      lastSeenSwitch: null,
      lastSeenAp: null,
      associatedUsers: [],
      acquiredAt: dev.registrationDateTime || null,
      warrantyExpiry: null,
      purchaseOrder: null,
      notes: `Auto-discovered from Entra ID integration "${integrationName}"`,
      tags,
      lastSeen: dev.lastSyncDateTime || dev.approximateLastSignInDateTime || null,
      createdAt: now,
      updatedAt: now,
    };
    ASSETS.push(newAsset);
    byTag.set(key, newAsset);
    created.push(dev.displayName || dev.deviceId);
  }

  return { created, updated, skipped };
}

function discoverDhcpDemo(config, log) {
  if (!log) log = () => {};
  let servers = [...MOCK_DHCP_SERVERS];

  const include = config.dhcpInclude || [];
  const exclude = config.dhcpExclude || [];

  if (include.length > 0) {
    servers = servers.filter((s) =>
      include.some((p) => s.name.toLowerCase().includes(p.toLowerCase()) || s.id === p)
    );
  }
  if (exclude.length > 0) {
    servers = servers.filter((s) =>
      !exclude.some((p) => s.name.toLowerCase().includes(p.toLowerCase()) || s.id === p)
    );
  }

  // FortiGate-level filter — drop managed FortiGates entirely, then drop DHCP servers on them
  let devices = MOCK_DEVICES.map((d) => ({ ...d }));
  const devInclude = config.deviceInclude || [];
  const devExclude = config.deviceExclude || [];
  const matchDev = (d, p) => {
    const name = String(d.name || "").toLowerCase();
    const host = String(d.hostname || "").toLowerCase();
    const pat = p.toLowerCase();
    return name.includes(pat) || (host && host.includes(pat));
  };
  if (devInclude.length > 0) {
    devices = devices.filter((d) => devInclude.some((p) => matchDev(d, p)));
  } else if (devExclude.length > 0) {
    devices = devices.filter((d) => !devExclude.some((p) => matchDev(d, p)));
  }
  const allowedDeviceNames = new Set(devices.map((d) => d.name));
  servers = servers.filter((s) => allowedDeviceNames.has(s.device));
  log("discover.devices", "info", `Found ${devices.length} managed device(s) in ADOM "${config.adom || "root"}"`);

  const subnets = servers.map((s) => ({
    cidr: s.cidr,
    name: s.iface,
    fortigateDevice: s.device,
    dhcpServerId: s.id,
  }));

  const interfaceIps = [];
  // Management IPs
  for (const d of MOCK_DEVICES) {
    if (d.mgmtIp) {
      interfaceIps.push({
        device: d.name,
        interfaceName: config.mgmtInterface || "mgmt",
        ipAddress: d.mgmtIp,
        role: "management",
      });
    }
  }
  // DHCP server interface IPs (only for included/filtered servers)
  for (const s of servers) {
    if (s.ifaceIp) {
      interfaceIps.push({
        device: s.device,
        interfaceName: s.iface,
        ipAddress: s.ifaceIp,
        role: "dhcp-server",
      });
    }
  }

  // Filter DHCP entries to only include those from filtered servers
  const includedIfaces = new Set(servers.map((s) => s.device + "/" + s.iface));
  const dhcpEntries = MOCK_DHCP_ENTRIES.filter((e) => includedIfaces.has(e.device + "/" + e.iface)).map((e) => ({
    device: e.device,
    interfaceName: e.iface,
    ipAddress: e.ip,
    macAddress: e.mac,
    hostname: e.hostname,
    type: e.type,
  }));

  // Per-device step logging
  const deviceNames = [...new Set(MOCK_DEVICES.map((d) => d.name))];
  for (const devName of deviceNames) {
    const devSubnets = subnets.filter((s) => s.fortigateDevice === devName);
    const devReservations = dhcpEntries.filter((e) => e.device === devName && e.type === "dhcp-reservation");
    const devLeases = dhcpEntries.filter((e) => e.device === devName && e.type === "dhcp-lease");
    const devIfaceIps = interfaceIps.filter((ip) => ip.device === devName && ip.role === "dhcp-server");
    log("discover.dhcp", "info", `${devName}: Found ${devSubnets.length} DHCP subnet(s) and ${devReservations.length} static reservation(s)`);
    log("discover.leases", "info", `${devName}: Found ${devLeases.length} dynamic DHCP lease(s)`);
    log("discover.interfaces", "info", `${devName}: Resolved ${devIfaceIps.length} DHCP interface IP(s)`);
  }

  // Filter device inventory: drop devices on excluded DHCP interfaces
  // All DHCP interfaces we discovered (before filtering)
  const allDhcpIfaces = new Set(MOCK_DHCP_SERVERS.map((s) => s.device + "/" + s.iface));
  const excludedIfaces = new Set();
  for (const key of allDhcpIfaces) {
    if (!includedIfaces.has(key)) excludedIfaces.add(key);
  }
  const deviceInventory = MOCK_DEVICE_INVENTORY
    .filter((d) => !excludedIfaces.has(d.device + "/" + d.iface))
    .map((d) => ({
      device: d.device,
      macAddress: d.mac,
      ipAddress: d.ip,
      hostname: d.hostname,
      os: d.os,
      osVersion: d.osVersion,
      hardwareVendor: d.vendor,
      interfaceName: d.iface,
      switchName: d.switchName,
      switchPort: d.switchPort,
      apName: d.apName,
      user: d.user || "",
      isOnline: d.online,
      lastSeen: d.lastSeen,
    }));

  // Per-device inventory logging
  for (const devName of deviceNames) {
    const devInventory = deviceInventory.filter((d) => d.device === devName);
    log("discover.inventory", "info", `${devName}: Found ${devInventory.length} device inventory client(s)`);
  }

  const excluded = MOCK_DHCP_SERVERS.length - servers.length;
  log("discover.filter", "info", `Filter complete: ${subnets.length} subnet(s) included, ${excluded} excluded, ${dhcpEntries.length} DHCP entries, ${deviceInventory.length} inventory device(s)`);

  return { subnets, devices, interfaceIps, dhcpEntries, deviceInventory };
}

function syncDhcpSubnetsDemo(integrationId, integrationName, integrationType, result, syncLog) {
  if (!syncLog) syncLog = () => {};
  const created = [];
  const updated = [];
  const skipped = [];
  const deprecated = [];
  const assets = [];
  const reservations = [];
  const now = new Date().toISOString();

  const discovered = result.subnets || result;

  // Collect device names from this discovery
  const discoveredDeviceNames = new Set((result.devices || []).map((d) => d.name));

  for (const entry of discovered) {
    // Check if a non-deprecated subnet with this CIDR already exists
    const existing = SUBNETS.find((s) => s.cidr === entry.cidr && s.status !== "deprecated");
    if (existing) {
      if (existing.discoveredBy) {
        // Already integration-managed — update ownership
        existing.discoveredBy = integrationId;
        existing.integration = { id: integrationId, name: integrationName, type: integrationType };
        existing.fortigateDevice = entry.fortigateDevice;
        existing.conflictMessage = null;
      } else {
        // Manually created — flag as conflict, don't take ownership
        const source = integrationType === "windowsserver"
          ? `Network learned from ${integrationName}`
          : `Network learned from ${integrationName} on ${entry.fortigateDevice}`;
        existing.conflictMessage = source;
        existing.pendingIntegration = {
          integrationId,
          integrationName,
          integrationType,
          fortigateDevice: entry.fortigateDevice,
        };
      }
      existing.updatedAt = now;
      updated.push(entry.cidr);
      continue;
    }

    // Find parent block
    const block = BLOCKS.find((b) => {
      const blockPrefix = b.cidr.replace(/\.\d+\/\d+$/, "");
      return entry.cidr.startsWith(blockPrefix.split(".").slice(0, -1).join(".") + ".") ||
        entry.cidr.startsWith(blockPrefix + ".");
    });

    if (!block) {
      skipped.push(`${entry.cidr} (no matching parent block)`);
      continue;
    }

    // Check for overlaps with non-deprecated siblings
    const overlap = SUBNETS.find((s) => s.blockId === block.id && s.cidr === entry.cidr && s.status !== "deprecated");
    if (overlap) {
      skipped.push(`${entry.cidr} (overlaps ${overlap.cidr})`);
      continue;
    }

    SUBNETS.push({
      id: crypto.randomUUID(),
      blockId: block.id,
      block: { name: block.name, cidr: block.cidr },
      cidr: entry.cidr,
      name: `DHCP: ${entry.name} (${entry.fortigateDevice})`,
      purpose: `Discovered from ${integrationType === "windowsserver" ? "Windows Server" : "FortiManager"} DHCP`,
      status: "available",
      vlan: null,
      tags: ["dhcp-discovered", integrationType || "fortimanager"],
      discoveredBy: integrationId,
      integration: { id: integrationId, name: integrationName, type: integrationType },
      fortigateDevice: entry.fortigateDevice,
      createdAt: now,
      updatedAt: now,
      _count: { reservations: 0 },
    });
    created.push(entry.cidr);
  }

  // ── Deprecate subnets from FortiGates no longer in the device list ──
  if (discoveredDeviceNames.size > 0) {
    for (const subnet of SUBNETS) {
      if (
        subnet.discoveredBy === integrationId &&
        subnet.status !== "deprecated" &&
        subnet.fortigateDevice &&
        !discoveredDeviceNames.has(subnet.fortigateDevice)
      ) {
        subnet.status = "deprecated";
        subnet.updatedAt = now;
        deprecated.push(subnet.cidr);
      }
    }
  }

  // ── Create FortiGate assets ──
  if (result.devices) {
    for (const device of result.devices) {
      // Check if asset already exists by serial number
      const existingAsset = device.serial
        ? ASSETS.find((a) => a.serialNumber === device.serial)
        : null;

      if (existingAsset) {
        existingAsset.ipAddress = device.mgmtIp || existingAsset.ipAddress;
        existingAsset.hostname = device.hostname || existingAsset.hostname;
        existingAsset.model = device.model || existingAsset.model;
        existingAsset.updatedAt = now;
        assets.push(`${device.name} (updated)`);
      } else {
        ASSETS.push({
          id: crypto.randomUUID(),
          ipAddress: device.mgmtIp || null,
          macAddress: null,
          macAddresses: [],
          hostname: device.hostname || device.name,
          dnsName: null,
          assetTag: null,
          serialNumber: device.serial || null,
          manufacturer: "Fortinet",
          model: device.model || "FortiGate",
          assetType: "firewall",
          status: "active",
          location: null,
          learnedLocation: null,
          department: "Network Security",
          assignedTo: null,
          os: null,
          osVersion: null,
          lastSeenSwitch: null,
          lastSeenAp: null,
          associatedUsers: [],
          acquiredAt: null,
          warrantyExpiry: null,
          purchaseOrder: null,
          notes: "Auto-discovered from FortiManager integration",
          tags: ["fortigate", "auto-discovered"],
          createdAt: now,
          updatedAt: now,
        });
        assets.push(device.name);
      }
    }
  }

  // ── Create reservations for interface IPs ──
  if (result.interfaceIps) {
    for (const ifaceIp of result.interfaceIps) {
      if (!ifaceIp.ipAddress) continue;

      // Find which subnet this IP belongs to
      const matchingSubnet = SUBNETS.find((s) => {
        const subnetBase = s.cidr.replace(/\/\d+$/, "").replace(/\.\d+$/, "");
        return ifaceIp.ipAddress.startsWith(subnetBase + ".");
      });
      if (!matchingSubnet) continue;

      // Check for existing active reservation
      const existingRes = RESERVATIONS.find(
        (r) => r.ipAddress === ifaceIp.ipAddress && r.status === "active"
      );
      if (existingRes) continue;

      RESERVATIONS.push({
        id: crypto.randomUUID(),
        subnetId: matchingSubnet.id,
        subnet: { name: matchingSubnet.name, cidr: matchingSubnet.cidr },
        ipAddress: ifaceIp.ipAddress,
        hostname: ifaceIp.device,
        owner: "network-team",
        projectRef: "FortiManager Integration",
        notes: `${ifaceIp.role === "management" ? "Management" : "DHCP server"} interface (${ifaceIp.interfaceName}) on ${ifaceIp.device}`,
        status: "active",
        expiresAt: null,
        createdBy: "system",
        createdAt: now,
        updatedAt: now,
      });

      // Update subnet reservation count
      matchingSubnet._count = matchingSubnet._count || { reservations: 0 };
      matchingSubnet._count.reservations++;

      reservations.push(`${ifaceIp.ipAddress} (${ifaceIp.device}/${ifaceIp.interfaceName})`);
    }
  }

  // ── Create reservations for DHCP leases and static reservations ──
  let dhcpLeaseCount = 0;
  let dhcpReservationCount = 0;
  if (result.dhcpEntries) {
    for (const entry of result.dhcpEntries) {
      if (!entry.ipAddress) continue;

      const matchingSubnet = SUBNETS.find((s) => {
        const subnetBase = s.cidr.replace(/\/\d+$/, "").replace(/\.\d+$/, "");
        return entry.ipAddress.startsWith(subnetBase + ".");
      });
      if (!matchingSubnet) continue;

      const isDhcpReservation = entry.type === "dhcp-reservation";
      const existingRes = RESERVATIONS.find(
        (r) => r.ipAddress === entry.ipAddress && r.status === "active"
      );
      if (existingRes) {
        // Already a DHCP-owned reservation — skip
        if (existingRes.owner === "dhcp-reservation" || existingRes.owner === "dhcp-lease") continue;

        // Compare MACs: get existing MAC from reservation notes or asset lookup
        const existingMacMatch = existingRes.notes ? existingRes.notes.match(/MAC:\s*([\w:]+)/) : null;
        let existingMac = existingMacMatch ? existingMacMatch[1].toUpperCase() : null;
        if (!existingMac) {
          const matchedAsset = ASSETS.find((a) => a.ipAddress === entry.ipAddress);
          if (matchedAsset && matchedAsset.macAddress) existingMac = matchedAsset.macAddress.toUpperCase();
        }
        const incomingMac = entry.macAddress ? entry.macAddress.toUpperCase().replace(/-/g, ":") : null;
        const macsMatch = existingMac && incomingMac && existingMac === incomingMac;

        if (isDhcpReservation && macsMatch) {
          // DHCP reservation + same MAC → promote to DHCP Reservation
          existingRes.owner = "dhcp-reservation";
          existingRes.notes = `DHCP reservation on ${entry.device} (${entry.interfaceName})${entry.macAddress ? " — MAC: " + entry.macAddress : ""}`;
          existingRes.conflictMessage = null;
          existingRes.updatedAt = now;
          dhcpReservationCount++;
        } else if (isDhcpReservation && !macsMatch) {
          // DHCP reservation + different MAC → conflict
          existingRes.conflictMessage = "MAC address reservation doesn't match";
          existingRes.updatedAt = now;
        } else if (!isDhcpReservation && !macsMatch) {
          // DHCP lease + different MAC → conflict
          existingRes.conflictMessage = "MAC address lease doesn't match reservation";
          existingRes.updatedAt = now;
        } else if (!isDhcpReservation && macsMatch) {
          // DHCP lease + same MAC → should be reserved
          existingRes.conflictMessage = `Lease should be reserved on ${entry.device}`;
          existingRes.updatedAt = now;
        }
        continue;
      }
      // Look up matching asset by MAC to populate hostname and owner
      const incomingMacNorm = entry.macAddress ? entry.macAddress.toUpperCase().replace(/-/g, ":") : null;
      const matchedAsset = incomingMacNorm ? ASSETS.find((a) => {
        if (a.macAddress && a.macAddress.toUpperCase() === incomingMacNorm) return true;
        if (Array.isArray(a.macAddresses) && a.macAddresses.some((m) => m.mac === incomingMacNorm)) return true;
        return false;
      }) : null;

      RESERVATIONS.push({
        id: crypto.randomUUID(),
        subnetId: matchingSubnet.id,
        subnet: { name: matchingSubnet.name, cidr: matchingSubnet.cidr },
        ipAddress: entry.ipAddress,
        hostname: (matchedAsset && matchedAsset.hostname) || entry.hostname || null,
        owner: (matchedAsset && matchedAsset.assignedTo) || (isDhcpReservation ? "dhcp-reservation" : "dhcp-lease"),
        projectRef: "FortiManager Integration",
        notes: `${isDhcpReservation ? "DHCP reservation" : "DHCP lease"} on ${entry.device} (${entry.interfaceName})${entry.macAddress ? " — MAC: " + entry.macAddress : ""}`,
        status: "active",
        expiresAt: null,
        createdBy: "system",
        createdAt: now,
        updatedAt: now,
      });

      matchingSubnet._count = matchingSubnet._count || { reservations: 0 };
      matchingSubnet._count.reservations++;

      if (isDhcpReservation) dhcpReservationCount++;
      else dhcpLeaseCount++;
    }
  }

  // ── Associate DHCP entry MACs with matching assets & cross-update ──
  if (result.dhcpEntries) {
    for (const entry of result.dhcpEntries) {
      if (!entry.macAddress || !entry.ipAddress) continue;
      const normalized = entry.macAddress.toUpperCase().replace(/-/g, ":");

      // Match asset by MAC address, hostname, or IP
      const asset = ASSETS.find((a) => {
        if (a.macAddress && a.macAddress.toUpperCase() === normalized) return true;
        if (Array.isArray(a.macAddresses) && a.macAddresses.some((m) => m.mac === normalized)) return true;
        if (entry.hostname && a.hostname && a.hostname.toLowerCase() === entry.hostname.toLowerCase()) return true;
        if (a.ipAddress && a.ipAddress === entry.ipAddress) return true;
        return false;
      });
      if (!asset) continue;

      // Update asset MAC list
      _addMacToAsset(asset, entry.macAddress, entry.type, now);

      // Update asset IP address, learned location, and activate
      asset.ipAddress = entry.ipAddress;
      if (entry.device) asset.learnedLocation = entry.device;
      if (asset.status !== "active") {
        asset.status = "active";
      }

      // Update the reservation hostname and owner from the asset
      const res = RESERVATIONS.find(
        (r) => r.ipAddress === entry.ipAddress && r.status === "active"
      );
      if (res) {
        let changed = false;
        if (asset.hostname && res.hostname !== asset.hostname) {
          res.hostname = asset.hostname;
          changed = true;
        }
        if (asset.assignedTo && res.owner !== asset.assignedTo) {
          res.owner = asset.assignedTo;
          changed = true;
        }
        if (changed) res.updatedAt = now;
      }
    }
  }

  // ── Process device inventory — fill in gaps not covered by DHCP ──
  let inventoryDeviceCount = 0;
  if (result.deviceInventory) {
    // Collect MACs already handled by DHCP
    const dhcpMacs = new Set();
    if (result.dhcpEntries) {
      for (const e of result.dhcpEntries) {
        if (e.macAddress) dhcpMacs.add(e.macAddress.toUpperCase().replace(/-/g, ":"));
      }
    }

    for (const inv of result.deviceInventory) {
      if (!inv.macAddress && !inv.ipAddress) continue;
      const normalizedMac = inv.macAddress ? inv.macAddress.toUpperCase().replace(/-/g, ":") : "";
      const handledByDhcp = normalizedMac && dhcpMacs.has(normalizedMac);

      // Find existing asset by MAC, hostname, or IP
      const existingAsset = ASSETS.find((a) => {
        if (normalizedMac) {
          if (a.macAddress && a.macAddress.toUpperCase() === normalizedMac) return true;
          if (Array.isArray(a.macAddresses) && a.macAddresses.some((m) => m.mac === normalizedMac)) return true;
        }
        if (inv.hostname && a.hostname && a.hostname.toLowerCase() === inv.hostname.toLowerCase()) return true;
        if (inv.ipAddress && a.ipAddress && a.ipAddress === inv.ipAddress) return true;
        return false;
      });

      const switchConn = inv.switchName
        ? (inv.switchPort ? `${inv.switchName}/port${inv.switchPort}` : inv.switchName)
        : null;
      const apConn = inv.apName || null;

      if (existingAsset) {
        // Update existing asset — DHCP fields take precedence
        if (!handledByDhcp && inv.ipAddress) existingAsset.ipAddress = inv.ipAddress;
        if (inv.os && !existingAsset.os) existingAsset.os = inv.os;
        if (inv.osVersion) existingAsset.osVersion = inv.osVersion;
        if (inv.hardwareVendor && !existingAsset.manufacturer) existingAsset.manufacturer = inv.hardwareVendor;
        if (switchConn) existingAsset.lastSeenSwitch = switchConn;
        if (apConn) existingAsset.lastSeenAp = apConn;
        if (normalizedMac && !handledByDhcp) {
          _addMacToAsset(existingAsset, inv.macAddress, "device-inventory", now);
        }
        // Track associated user
        if (inv.user) {
          const userList = Array.isArray(existingAsset.associatedUsers) ? [...existingAsset.associatedUsers] : [];
          const parts = inv.user.includes("\\") ? inv.user.split("\\") : [null, inv.user];
          const domain = parts[0] || undefined;
          const username = parts[1] || inv.user;
          const existing = userList.find((u) => u.user === username && u.domain === domain);
          if (existing) { existing.lastSeen = now; existing.source = "device-inventory"; }
          else { userList.push({ user: username, domain, lastSeen: now, source: "device-inventory" }); }
          userList.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
          existingAsset.associatedUsers = userList;
        }
        existingAsset.updatedAt = now;
        inventoryDeviceCount++;
      } else {
        // Create new asset from inventory
        ASSETS.push({
          id: crypto.randomUUID(),
          ipAddress: inv.ipAddress || null,
          macAddress: normalizedMac || null,
          macAddresses: normalizedMac ? [{ mac: normalizedMac, lastSeen: now, source: "device-inventory" }] : [],
          hostname: inv.hostname || null,
          dnsName: null,
          assetTag: null,
          serialNumber: null,
          manufacturer: inv.hardwareVendor || null,
          model: null,
          assetType: "other",
          status: "active",
          location: null,
          learnedLocation: null,
          department: null,
          assignedTo: null,
          os: inv.os || null,
          osVersion: inv.osVersion || null,
          lastSeenSwitch: switchConn,
          lastSeenAp: apConn,
          associatedUsers: inv.user ? [{ user: inv.user.includes("\\") ? inv.user.split("\\")[1] : inv.user, domain: inv.user.includes("\\") ? inv.user.split("\\")[0] : undefined, lastSeen: now, source: "device-inventory" }] : [],
          acquiredAt: null,
          warrantyExpiry: null,
          purchaseOrder: null,
          notes: `Auto-discovered from FortiGate device inventory (${inv.device})`,
          tags: ["device-inventory", "auto-discovered"],
          createdAt: now,
          updatedAt: now,
        });
        inventoryDeviceCount++;
      }
    }
  }

  // ── Clear stale subnet-level conflicts for CIDRs no longer discovered ──
  const discoveredCidrs = new Set(discovered.map((e) => e.cidr));
  for (const subnet of SUBNETS) {
    if (subnet.pendingIntegration && subnet.pendingIntegration.integrationId === integrationId && !discoveredCidrs.has(subnet.cidr)) {
      subnet.conflictMessage = null;
      subnet.pendingIntegration = null;
      subnet.updatedAt = now;
    }
  }

  // ── Clear stale IP-level DHCP conflicts for IPs no longer in DHCP entries ──
  if (result.dhcpEntries) {
    const dhcpIps = new Set(result.dhcpEntries.map((e) => e.ipAddress));
    // Only clear conflicts on subnets covered by this integration's discovered CIDRs
    const coveredSubnetIds = new Set(
      SUBNETS.filter((s) => discoveredCidrs.has(s.cidr)).map((s) => s.id)
    );
    for (const res of RESERVATIONS) {
      if (res.conflictMessage && res.status === "active" && coveredSubnetIds.has(res.subnetId) && !dhcpIps.has(res.ipAddress)) {
        res.conflictMessage = null;
        res.updatedAt = now;
      }
    }
  }

  // ── Flag subnets that contain conflicting reservations or have subnet-level conflicts ──
  for (const subnet of SUBNETS) {
    const hasIpConflict = RESERVATIONS.some(
      (r) => r.subnetId === subnet.id && r.status === "active" && r.conflictMessage
    );
    subnet.hasConflict = hasIpConflict || !!subnet.conflictMessage;
  }

  return { created, updated, skipped, deprecated, assets, reservations, dhcpLeases: dhcpLeaseCount, dhcpReservations: dhcpReservationCount, inventoryDevices: inventoryDeviceCount };
}

function _addMacToAsset(asset, mac, source, now) {
  const normalized = mac.toUpperCase().replace(/-/g, ":");
  if (!asset.macAddresses) asset.macAddresses = [];
  const existing = asset.macAddresses.find((m) => m.mac === normalized);
  if (existing) {
    existing.lastSeen = now;
    existing.source = source;
  } else {
    asset.macAddresses.push({ mac: normalized, lastSeen: now, source: source });
  }
  // Update primary macAddress to most recently seen
  asset.macAddresses.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
  asset.macAddress = asset.macAddresses[0].mac;
  asset.updatedAt = now;
}

// ─── MIME types ──────────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

// ─── IP Helpers ─────────────────────────────────────────────────────────────

function _estimateSize(arr) {
  const bytes = JSON.stringify(arr).length;
  return _formatBytes(bytes);
}
function _formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " kB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
function _parseSize(sizeStr) {
  const m = sizeStr.match(/([\d.]+)\s*(B|kB|MB|GB)/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (m[2] === "B") return n;
  if (m[2] === "kB") return n * 1024;
  if (m[2] === "MB") return n * 1024 * 1024;
  if (m[2] === "GB") return n * 1024 * 1024 * 1024;
  return 0;
}

function _ipToInt(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}
function _intToIp(int) {
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join(".");
}

// ─── Router ──────────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function serveStatic(res, urlPath) {
  let filePath = join(PUBLIC, urlPath === "/" ? "index.html" : urlPath);
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = extname(filePath);
  const mime = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime });
  res.end(readFileSync(filePath));
}

let _httpPort = PORT;
const _httpHandler = (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  // ── HTTP → HTTPS redirect (skip API so admin can still manage settings) ──
  if (HTTPS_SETTINGS.redirectHttp && _httpsServer && _httpsServer.listening && !path.startsWith("/api/")) {
    const host = (req.headers.host || "localhost").replace(/:\d+$/, "");
    const httpsPort = HTTPS_SETTINGS.port;
    const target = "https://" + host + (httpsPort === 443 ? "" : ":" + httpsPort) + req.url;
    res.writeHead(301, { Location: target });
    return res.end();
  }

  // ── Health check ──
  if (path === "/health") {
    return json(res, { status: "ok" });
  }

  // ── Setup wizard stubs (demo mode) ──
  if (path === "/api/setup/status") {
    return json(res, { needsSetup: false });
  }
  if (path.startsWith("/api/setup/") && method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (path === "/api/setup/test-connection") {
        return json(res, {
          ok: true,
          version: "PostgreSQL 15.4 (Demo)",
          databaseExists: true,
          message: "Connected — PostgreSQL 15.4 (Demo)",
        });
      }
      if (path === "/api/setup/generate-secret") {
        return json(res, { secret: randomBytes(32).toString("hex") });
      }
      if (path === "/api/setup/finalize") {
        return json(res, { ok: true, message: "Setup complete. (Demo mode — no changes were made.)" });
      }
      json(res, { error: "Not found" }, 404);
    });
    return;
  }

  // ── API routes ──
  if (path.startsWith("/api/v1/")) {
    const ct = req.headers["content-type"] || "";
    if (ct.includes("multipart/form-data")) {
      // Handle multipart file uploads (certificate upload)
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const buf = Buffer.concat(chunks).toString("binary");
          routeMultipart(method, path, buf, ct, res);
        } catch (err) {
          json(res, { error: err.message }, 400);
        }
      });
      return;
    }
    // Collect body for POST/PUT (JSON)
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        routeAPI(method, path, url.searchParams, parsed, res, req).catch((err) => {
          json(res, { error: err.message }, 500);
        });
      } catch (err) {
        json(res, { error: err.message }, 400);
      }
    });
    return;
  }

  // ── Static files ──
  // Redirect unauthenticated users to login for HTML pages (except login itself)
  if (path !== "/login.html" && path !== "/setup.html" && (path === "/" || path.endsWith(".html"))) {
    const cookies = (req.headers.cookie || "").split(";").reduce((m, c) => {
      const [k, v] = c.trim().split("=");
      if (k) m[k] = v;
      return m;
    }, {});
    if (!cookies["polaris-session"] || !USERS.find((u) => u.username === decodeURIComponent(cookies["polaris-session"]))) {
      res.writeHead(302, { Location: "/login.html" });
      return res.end();
    }
  }
  serveStatic(res, path);
};
let server = createServer(_httpHandler);

function restartDemoHttp(newPort) {
  return new Promise((resolve) => {
    server.close(() => {
      _httpPort = newPort;
      server = createServer(_httpHandler);
      server.listen(_httpPort, () => {
        console.log("  \x1b[32m✓\x1b[0m HTTP server restarted on \x1b[36mhttp://localhost:" + _httpPort + "\x1b[0m");
        resolve({ ok: true, message: "HTTP server restarted on port " + _httpPort });
      });
      server.on("error", (err) => {
        resolve({ ok: false, message: "Failed to restart HTTP: " + err.message });
      });
    });
    setTimeout(() => server.closeAllConnections?.(), 1000);
  });
}

async function routeAPI(method, path, params, body, res, req) {
  // ── Auth ──
  // Simple cookie-based session so the login page actually works in demo
  const cookies = (req.headers.cookie || "").split(";").reduce((m, c) => {
    const [k, v] = c.trim().split("=");
    if (k) m[k] = v;
    return m;
  }, {});
  const sessionUser = cookies["polaris-session"] ? USERS.find((u) => u.username === cookies["polaris-session"]) : null;
  const isLoggedIn = !!sessionUser;

  if (path === "/api/v1/auth/login" && method === "POST") {
    const loginUser = USERS.find((u) => u.username === (body.username || "admin")) || USERS[0];
    loginUser.lastLogin = new Date().toISOString();
    res.setHeader("Set-Cookie", "polaris-session=" + encodeURIComponent(loginUser.username) + "; Path=/; HttpOnly; SameSite=Lax");
    return json(res, { ok: true, username: loginUser.username, role: loginUser.role });
  }
  if (path === "/api/v1/auth/logout" && method === "POST") {
    res.setHeader("Set-Cookie", "polaris-session=; Path=/; HttpOnly; Max-Age=0");
    return json(res, { ok: true });
  }
  if (path === "/api/v1/auth/me") {
    if (!isLoggedIn) return json(res, { authenticated: false });
    return json(res, { authenticated: true, username: sessionUser.username, role: sessionUser.role, authProvider: sessionUser.authProvider || "local" });
  }

  // SAML SSO stubs
  if (path === "/api/v1/auth/azure/config") {
    const enabled = !!(SSO_SETTINGS.enabled && SSO_SETTINGS.idpEntityId && SSO_SETTINGS.idpLoginUrl && SSO_SETTINGS.idpCertificate);
    let brand = "generic";
    if (SSO_SETTINGS.idpLoginUrl && /microsoftonline\.com|login\.microsoft\.com/i.test(SSO_SETTINGS.idpLoginUrl)) brand = "microsoft";
    else if (SSO_SETTINGS.idpLoginUrl && /accounts\.google\.com/i.test(SSO_SETTINGS.idpLoginUrl)) brand = "google";
    else if (SSO_SETTINGS.idpLoginUrl && /okta\.com/i.test(SSO_SETTINGS.idpLoginUrl)) brand = "okta";
    return json(res, { enabled, brand, skipLoginPage: SSO_SETTINGS.skipLoginPage, autoLogoutMinutes: SSO_SETTINGS.autoLogoutMinutes });
  }
  if (path === "/api/v1/auth/azure/settings" && method === "GET") {
    return json(res, { ...SSO_SETTINGS });
  }
  if (path === "/api/v1/auth/azure/settings" && method === "PUT") {
    if (body.enabled !== undefined) SSO_SETTINGS.enabled = body.enabled;
    if (body.spEntityId !== undefined) SSO_SETTINGS.spEntityId = body.spEntityId.trim();
    if (body.idpEntityId !== undefined) SSO_SETTINGS.idpEntityId = body.idpEntityId.trim();
    if (body.idpLoginUrl !== undefined) SSO_SETTINGS.idpLoginUrl = body.idpLoginUrl.trim();
    if (body.idpLogoutUrl !== undefined) SSO_SETTINGS.idpLogoutUrl = body.idpLogoutUrl.trim();
    if (body.idpCertificate !== undefined) SSO_SETTINGS.idpCertificate = body.idpCertificate.trim();
    if (body.wantResponseSigned !== undefined) SSO_SETTINGS.wantResponseSigned = body.wantResponseSigned;
    if (body.skipLoginPage !== undefined) SSO_SETTINGS.skipLoginPage = body.skipLoginPage;
    if (body.autoLogoutMinutes !== undefined) SSO_SETTINGS.autoLogoutMinutes = Math.max(0, Math.min(1440, body.autoLogoutMinutes));
    return json(res, { ...SSO_SETTINGS });
  }
  // OIDC settings
  if (path === "/api/v1/auth/oidc/settings" && method === "GET") {
    return json(res, { ...OIDC_SETTINGS });
  }
  if (path === "/api/v1/auth/oidc/settings" && method === "PUT") {
    OIDC_SETTINGS.enabled = !!body.enabled;
    OIDC_SETTINGS.discoveryUrl = (body.discoveryUrl || "").trim();
    OIDC_SETTINGS.clientId = (body.clientId || "").trim();
    OIDC_SETTINGS.clientSecret = (body.clientSecret || "").trim();
    OIDC_SETTINGS.scopes = (body.scopes || "openid profile email").trim();
    return json(res, { ...OIDC_SETTINGS });
  }
  // LDAP settings
  if (path === "/api/v1/auth/ldap/settings" && method === "GET") {
    return json(res, { ...LDAP_SETTINGS, bindPassword: LDAP_SETTINGS.bindPassword ? "********" : "" });
  }
  if (path === "/api/v1/auth/ldap/settings" && method === "PUT") {
    LDAP_SETTINGS.enabled = !!body.enabled;
    LDAP_SETTINGS.url = (body.url || "").trim();
    LDAP_SETTINGS.bindDn = (body.bindDn || "").trim();
    LDAP_SETTINGS.bindPassword = body.bindPassword === "********" ? LDAP_SETTINGS.bindPassword : (body.bindPassword || "").trim();
    LDAP_SETTINGS.searchBase = (body.searchBase || "").trim();
    LDAP_SETTINGS.searchFilter = (body.searchFilter || "(sAMAccountName={{username}})").trim();
    LDAP_SETTINGS.tlsVerify = body.tlsVerify !== false;
    LDAP_SETTINGS.displayNameAttr = (body.displayNameAttr || "displayName").trim();
    LDAP_SETTINGS.emailAttr = (body.emailAttr || "mail").trim();
    return json(res, { ...LDAP_SETTINGS, bindPassword: LDAP_SETTINGS.bindPassword ? "********" : "" });
  }
  if (path === "/api/v1/auth/azure/test" && method === "POST") {
    const results = {
      certificate: { ok: false, message: "No certificate provided" },
      idpLoginUrl: { ok: false, message: "No IdP Login URL provided" },
    };
    if (SSO_SETTINGS.idpCertificate) {
      try {
        let pem = SSO_SETTINGS.idpCertificate.trim();
        if (!pem.startsWith("-----BEGIN")) {
          pem = `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----`;
        }
        const cert = new X509Certificate(pem);
        const now = new Date();
        const validTo = new Date(cert.validTo);
        const expired = now > validTo;
        const notYetValid = now < new Date(cert.validFrom);
        const daysLeft = Math.floor((validTo.getTime() - now.getTime()) / 86400000);
        results.certificate = {
          ok: !expired && !notYetValid,
          subject: cert.subject,
          issuer: cert.issuer,
          validFrom: cert.validFrom,
          validTo: cert.validTo,
          expired,
          daysLeft,
          message: expired
            ? `Certificate expired on ${cert.validTo}`
            : notYetValid
            ? `Certificate not valid until ${cert.validFrom}`
            : `Valid — expires in ${daysLeft} days (${cert.validTo})`,
        };
      } catch (e) {
        results.certificate = { ok: false, message: `Invalid certificate: ${e.message}` };
      }
    }
    if (SSO_SETTINGS.idpLoginUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(SSO_SETTINGS.idpLoginUrl, { method: "HEAD", signal: controller.signal, redirect: "manual" });
        clearTimeout(timeout);
        results.idpLoginUrl = { ok: true, status: resp.status, message: `Reachable (HTTP ${resp.status})` };
      } catch (e) {
        const msg = e.name === "AbortError" ? "Connection timed out (8s)" : e.cause?.code === "ENOTFOUND" ? `Host not found` : e.message || "Connection failed";
        results.idpLoginUrl = { ok: false, message: msg };
      }
    }
    const allOk = results.certificate.ok && results.idpLoginUrl.ok;
    return json(res, { ok: allOk, results });
  }

  // Branding endpoint is public (login page needs it)
  if (path.startsWith("/api/v1/server-settings/branding")) {
    // fall through — handled below
  } else if (!isLoggedIn) {
    return json(res, { error: "Unauthorized" }, 401);
  }

  // Conflicts — role-scoped list + resolve
  if (path.startsWith("/api/v1/conflicts")) {
    const role = sessionUser?.role || "admin";
    const visibleTypes =
      role === "admin" ? ["reservation", "asset"] :
      role === "networkadmin" ? ["reservation"] :
      role === "assetsadmin" ? ["asset"] : [];
    const canResolveFn = (etype) =>
      role === "admin" ||
      (role === "networkadmin" && etype === "reservation") ||
      (role === "assetsadmin" && etype === "asset");

    if (path === "/api/v1/conflicts" && method === "GET") {
      if (visibleTypes.length === 0) return json(res, { conflicts: [], total: 0, limit: 100, offset: 0 });
      const status = params.get("status") || "pending";
      let list = CONFLICTS.filter((c) => visibleTypes.includes(c.entityType));
      if (status !== "all") list = list.filter((c) => c.status === status);
      // Hydrate related entities
      const hydrated = list.map((c) => {
        const out = { ...c };
        if (c.entityType === "asset" && c.assetId) {
          out.asset = ASSETS.find((a) => a.id === c.assetId) || null;
        }
        if (c.entityType === "reservation" && c.reservationId) {
          out.reservation = RESERVATIONS.find((r) => r.id === c.reservationId) || null;
        }
        return out;
      });
      return json(res, { conflicts: hydrated, total: hydrated.length, limit: 100, offset: 0 });
    }
    if (path === "/api/v1/conflicts/count" && method === "GET") {
      if (visibleTypes.length === 0) return json(res, { count: 0 });
      const count = CONFLICTS.filter((c) => c.status === "pending" && visibleTypes.includes(c.entityType)).length;
      return json(res, { count });
    }
    const resolveMatch = path.match(/^\/api\/v1\/conflicts\/([\w-]+)\/(accept|reject)$/);
    if (resolveMatch && method === "POST") {
      const id = resolveMatch[1];
      const action = resolveMatch[2];
      const conflict = CONFLICTS.find((c) => c.id === id);
      if (!conflict) return json(res, { error: "Not found" }, 404);
      if (conflict.status !== "pending") return json(res, { error: "Already resolved" }, 409);
      if (!canResolveFn(conflict.entityType)) return json(res, { error: "Forbidden" }, 403);

      if (conflict.entityType === "asset" && action === "accept") {
        const asset = ASSETS.find((a) => a.id === conflict.assetId);
        if (asset) {
          const p = conflict.proposedAssetFields || {};
          asset.assetTag = "entra:" + conflict.proposedDeviceId;
          if (!asset.serialNumber && p.serialNumber) asset.serialNumber = p.serialNumber;
          if (!asset.macAddress && p.macAddress) asset.macAddress = p.macAddress;
          if (!asset.manufacturer && p.manufacturer) asset.manufacturer = p.manufacturer;
          if (!asset.model && p.model) asset.model = p.model;
          if (!asset.os && p.os) asset.os = p.os;
          if (!asset.osVersion && p.osVersion) asset.osVersion = p.osVersion;
          if (!asset.assignedTo && p.assignedTo) asset.assignedTo = p.assignedTo;
          const tags = Array.isArray(asset.tags) ? [...asset.tags] : [];
          ["entraid", "auto-discovered", (p.trustType || "").toLowerCase(), p.complianceState ? "intune-" + p.complianceState.toLowerCase() : ""].forEach((t) => { if (t && !tags.includes(t)) tags.push(t); });
          asset.tags = tags;
        }
      } else if (conflict.entityType === "asset" && action === "reject") {
        const p = conflict.proposedAssetFields || {};
        ASSETS.push({
          id: crypto.randomUUID(),
          ipAddress: null,
          macAddress: p.macAddress || null,
          macAddresses: [],
          hostname: p.hostname || null,
          dnsName: null,
          assetTag: "entra:" + conflict.proposedDeviceId,
          serialNumber: p.serialNumber || null,
          manufacturer: p.manufacturer || null,
          model: p.model || null,
          assetType: p.assetType || "workstation",
          status: "active",
          location: null,
          learnedLocation: null,
          department: null,
          assignedTo: p.assignedTo || null,
          os: p.os || null,
          osVersion: p.osVersion || null,
          lastSeenSwitch: null,
          lastSeenAp: null,
          associatedUsers: [],
          acquiredAt: p.registrationDateTime || null,
          warrantyExpiry: null,
          purchaseOrder: null,
          notes: "Auto-created after hostname collision was rejected (demo)",
          tags: ["entraid", "auto-discovered"],
          lastSeen: p.lastSeen || null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      // Reservation conflicts in demo: simpler — just mark resolved for now
      conflict.status = action === "accept" ? "accepted" : "rejected";
      conflict.resolvedBy = sessionUser?.username || "admin";
      conflict.resolvedAt = new Date().toISOString();
      logEventDemo({ action: "conflict." + (action === "accept" ? "accepted" : "rejected"), resourceType: conflict.entityType, resourceId: conflict.entityType === "asset" ? conflict.assetId : conflict.reservationId, actor: conflict.resolvedBy, message: "Conflict " + action + "ed (demo)" });
      return json(res, { ok: true });
    }
  }

  // Global search — mirrors /api/v1/search in the real service
  if (path === "/api/v1/search" && method === "GET") {
    const q = (params.get("q") || "").trim();
    if (q.length < 2) {
      return json(res, { query: q, blocks: [], subnets: [], reservations: [], assets: [], ips: [] });
    }
    const LIMIT = 8;
    const lq = q.toLowerCase();
    const compactMac = q.replace(/[\s:\-.]/g, "").toLowerCase();
    const mac = /^[0-9a-f]{12}$/.test(compactMac) ? compactMac.toUpperCase().match(/.{2}/g).join(":") : null;
    const contains = (v) => typeof v === "string" && v.toLowerCase().includes(lq);

    const blocks = BLOCKS.filter((b) => contains(b.name) || contains(b.description) || contains(b.cidr)).slice(0, LIMIT)
      .map((b) => ({ type: "block", id: b.id, title: b.name, subtitle: b.cidr + (b.description ? " — " + b.description : "") }));
    const subnets = SUBNETS.filter((s) => contains(s.name) || contains(s.cidr) || contains(s.purpose) || contains(s.fortigateDevice)).slice(0, LIMIT)
      .map((s) => ({ type: "subnet", id: s.id, title: s.name, subtitle: s.cidr + (s.purpose ? " — " + s.purpose : ""), context: { cidr: s.cidr } }));
    const reservations = RESERVATIONS.filter((r) => r.status === "active" && (
      contains(r.hostname) || contains(r.owner) || contains(r.projectRef) || contains(r.notes) || contains(r.ipAddress)
    )).slice(0, LIMIT).map((r) => {
      const sub = SUBNETS.find((s) => s.id === r.subnetId);
      return {
        type: "reservation",
        id: r.id,
        title: r.hostname || r.ipAddress || "reservation",
        subtitle: [r.ipAddress, sub?.cidr, r.owner].filter(Boolean).join(" — "),
        context: { subnetId: sub?.id || null, ipAddress: r.ipAddress },
      };
    });
    const assets = ASSETS.filter((a) => {
      if (mac && a.macAddress === mac) return true;
      return contains(a.hostname) || contains(a.dnsName) || contains(a.assetTag) || contains(a.serialNumber) ||
        contains(a.ipAddress) || contains(a.macAddress) || contains(a.manufacturer) || contains(a.model);
    }).slice(0, LIMIT).map((a) => ({
      type: "asset",
      id: a.id,
      title: a.hostname || a.assetTag || "asset",
      subtitle: [a.ipAddress, a.macAddress, [a.manufacturer, a.model].filter(Boolean).join(" ")].filter(Boolean).join(" — ") || a.assetType,
    }));

    const ips = [];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(q)) {
      const containing = SUBNETS.find((s) => {
        try { return _ipInCidrDemo(q, s.cidr); } catch { return false; }
      });
      if (containing) {
        const r = RESERVATIONS.find((x) => x.subnetId === containing.id && x.ipAddress === q && x.status === "active");
        ips.push({
          type: "ip",
          id: containing.id + "|" + q,
          title: q,
          subtitle: r
            ? ((r.hostname || r.owner || "reserved") + " — in " + containing.cidr)
            : ("free — in " + containing.cidr + " (" + containing.name + ")"),
          context: { subnetId: containing.id, subnetCidr: containing.cidr, subnetName: containing.name, ipAddress: q, reservationId: r ? r.id : null },
        });
      }
    }

    return json(res, { query: q, blocks, subnets, reservations, assets, ips });
  }

  // Blocks
  if (path === "/api/v1/blocks" && method === "GET") {
    let result = [...BLOCKS];
    const ver = params.get("ipVersion");
    const tag = params.get("tag");
    if (ver) result = result.filter((b) => b.ipVersion === ver);
    if (tag) result = result.filter((b) => b.tags.includes(tag));
    return json(res, result);
  }
  if (path.match(/^\/api\/v1\/blocks\/[\w-]+$/) && method === "GET") {
    const id = path.split("/").pop();
    const block = BLOCKS.find((b) => b.id === id);
    return block ? json(res, block) : json(res, { error: "Not found" }, 404);
  }
  if (path === "/api/v1/blocks" && method === "POST") {
    const newId = crypto.randomUUID();
    logEventDemo({ action: "block.created", resourceType: "block", resourceId: newId, resourceName: body.name, message: `Block "${body.name}" (${body.cidr}) created` });
    return json(res, { id: newId, ...body, ipVersion: "v4", _count: { subnets: 0 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 201);
  }
  if (path.match(/^\/api\/v1\/blocks\/[\w-]+$/) && method === "PUT") {
    const id = path.split("/").pop();
    logEventDemo({ action: "block.updated", resourceType: "block", resourceId: id, resourceName: body.name, message: `Block "${body.name || "unknown"}" updated` });
    return json(res, { ...body, updatedAt: new Date().toISOString() });
  }
  if (path.match(/^\/api\/v1\/blocks\/[\w-]+$/) && method === "DELETE") {
    const id = path.split("/").pop();
    const block = BLOCKS.find((b) => b.id === id);
    logEventDemo({ action: "block.deleted", resourceType: "block", resourceId: id, resourceName: block?.name, message: `Block "${block?.name || "unknown"}" deleted` });
    res.writeHead(204);
    return res.end();
  }

  // Subnets
  if (path === "/api/v1/subnets" && method === "GET") {
    let result = [...SUBNETS];
    const blockId = params.get("blockId");
    const status = params.get("status");
    const tag = params.get("tag");
    if (blockId) result = result.filter((s) => s.blockId === blockId);
    if (status) result = result.filter((s) => s.status === status);
    if (tag) result = result.filter((s) => s.tags.includes(tag));
    const total = result.length;
    const limit = Math.min(parseInt(params.get("limit")) || 50, 200);
    const offset = parseInt(params.get("offset")) || 0;
    result = result.slice(offset, offset + limit);
    return json(res, { subnets: result, total, limit, offset });
  }
  if (path.match(/^\/api\/v1\/subnets\/[\w-]+\/ips$/) && method === "GET") {
    const id = path.split("/").slice(-2, -1)[0];
    const subnet = SUBNETS.find((s) => s.id === id);
    if (!subnet) return json(res, { error: "Not found" }, 404);
    const page = parseInt(params.get("page")) || 1;
    const pageSize = Math.min(parseInt(params.get("pageSize")) || 256, 1024);
    const isV6 = subnet.cidr.includes(":");
    const subnetReservations = RESERVATIONS.filter((r) => r.subnetId === id && r.status !== "released");
    if (isV6) {
      return json(res, { subnet, totalIps: 0, page: 1, pageSize, ipv6: true, ips: subnetReservations.map((r) => ({ address: r.ipAddress, type: "host", reservation: r })) });
    }
    const cidrParts = subnet.cidr.split("/");
    const prefix = parseInt(cidrParts[1]);
    const baseInt = _ipToInt(cidrParts[0]);
    const size = Math.pow(2, 32 - prefix);
    const networkAddr = baseInt;
    const broadcastAddr = baseInt + size - 1;
    const totalIps = size;
    const resMap = {};
    subnetReservations.forEach((r) => { if (r.ipAddress) resMap[r.ipAddress] = r; });
    const startIdx = (page - 1) * pageSize;
    const endIdx = Math.min(startIdx + pageSize, totalIps);
    const ips = [];
    for (let i = startIdx; i < endIdx; i++) {
      const addr = _intToIp(networkAddr + i);
      var type = "host";
      if (i === 0) type = "network";
      else if (i === size - 1) type = "broadcast";
      ips.push({ address: addr, type, reservation: resMap[addr] || null });
    }
    return json(res, { subnet, totalIps, page, pageSize, ipv6: false, ips });
  }
  if (path.match(/^\/api\/v1\/subnets\/[\w-]+$/) && method === "GET") {
    const id = path.split("/").pop();
    const subnet = SUBNETS.find((s) => s.id === id);
    return subnet ? json(res, subnet) : json(res, { error: "Not found" }, 404);
  }
  if (path === "/api/v1/subnets" && method === "POST") {
    const newId = crypto.randomUUID();
    logEventDemo({ action: "subnet.created", resourceType: "subnet", resourceId: newId, resourceName: body.name, message: `Subnet "${body.name}" (${body.cidr}) created` });
    return json(res, { id: newId, ...body, status: "available", _count: { reservations: 0 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 201);
  }
  if (path === "/api/v1/subnets/next-available" && method === "POST") {
    const newId = crypto.randomUUID();
    logEventDemo({ action: "subnet.created", resourceType: "subnet", resourceId: newId, resourceName: body.name, message: `Subnet "${body.name}" (10.0.99.0/24) auto-allocated` });
    return json(res, { id: newId, cidr: "10.0.99.0/24", ...body, status: "available", _count: { reservations: 0 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 201);
  }
  if (path.match(/^\/api\/v1\/subnets\/[\w-]+$/) && method === "PUT") {
    const id = path.split("/").pop();
    const subnet = SUBNETS.find((s) => s.id === id);
    if (subnet) {
      if (body.name !== undefined) subnet.name = body.name;
      if (body.purpose !== undefined) subnet.purpose = body.purpose;
      if (body.status !== undefined) subnet.status = body.status;
      if (body.vlan !== undefined) subnet.vlan = body.vlan;
      if (body.tags !== undefined) subnet.tags = body.tags;
      if (body.convertToManual) {
        subnet.discoveredBy = null;
        subnet.integration = null;
        subnet.fortigateDevice = null;
        subnet.conflictMessage = null;
        subnet.pendingIntegration = null;
        subnet.hasConflict = false;
      }
      if (body.mergeIntegration && subnet.pendingIntegration) {
        const pi = subnet.pendingIntegration;
        subnet.discoveredBy = pi.integrationId;
        subnet.integration = { id: pi.integrationId, name: pi.integrationName, type: pi.integrationType };
        subnet.fortigateDevice = pi.fortigateDevice;
        subnet.conflictMessage = null;
        subnet.pendingIntegration = null;
        subnet.hasConflict = RESERVATIONS.some(
          (r) => r.subnetId === subnet.id && r.status === "active" && r.conflictMessage
        );
      }
      subnet.updatedAt = new Date().toISOString();
    }
    logEventDemo({ action: "subnet.updated", resourceType: "subnet", resourceId: id, resourceName: body.name || subnet?.name, message: `Subnet "${body.name || subnet?.name || "unknown"}" updated` });
    return json(res, subnet || { ...body, updatedAt: new Date().toISOString() });
  }
  if (path.match(/^\/api\/v1\/subnets\/[\w-]+$/) && method === "DELETE") {
    const id = path.split("/").pop();
    const subnet = SUBNETS.find((s) => s.id === id);
    logEventDemo({ action: "subnet.deleted", resourceType: "subnet", resourceId: id, resourceName: subnet?.name, message: `Subnet "${subnet?.name || "unknown"}" deleted` });
    res.writeHead(204);
    return res.end();
  }

  // Reservations
  if (path === "/api/v1/reservations" && method === "GET") {
    let result = [...RESERVATIONS];
    const status = params.get("status");
    const owner = params.get("owner");
    const proj = params.get("projectRef");
    if (status) result = result.filter((r) => r.status === status);
    if (owner) result = result.filter((r) => r.owner.toLowerCase().includes(owner.toLowerCase()));
    if (proj) result = result.filter((r) => r.projectRef.toLowerCase().includes(proj.toLowerCase()));
    const total = result.length;
    const limit = Math.min(parseInt(params.get("limit")) || 50, 200);
    const offset = parseInt(params.get("offset")) || 0;
    result = result.slice(offset, offset + limit);
    return json(res, { reservations: result, total, limit, offset });
  }
  if (path.match(/^\/api\/v1\/reservations\/[\w-]+$/) && method === "GET") {
    const id = path.split("/").pop();
    const r = RESERVATIONS.find((r) => r.id === id);
    return r ? json(res, r) : json(res, { error: "Not found" }, 404);
  }
  if (path === "/api/v1/reservations" && method === "POST") {
    const role = sessionUser ? sessionUser.role : "admin";
    if (role !== "admin" && role !== "networkadmin" && role !== "user" && role !== "assetsadmin") {
      return json(res, { error: "Forbidden — you do not have permission to create reservations" }, 403);
    }
    const now = new Date().toISOString();
    const newId = crypto.randomUUID();
    const subnet = SUBNETS.find((s) => s.id === body.subnetId);
    const newRes = {
      id: newId,
      subnetId: body.subnetId,
      subnet: subnet ? { name: subnet.name, cidr: subnet.cidr } : null,
      ipAddress: body.ipAddress || null,
      hostname: body.hostname || null,
      owner: body.owner || "",
      projectRef: body.projectRef || "",
      notes: body.notes || null,
      expiresAt: body.expiresAt || null,
      status: "active",
      createdBy: sessionUser ? sessionUser.username : null,
      createdAt: now,
      updatedAt: now,
    };
    RESERVATIONS.push(newRes);
    if (subnet) {
      subnet._count = subnet._count || { reservations: 0 };
      subnet._count.reservations++;
    }
    logEventDemo({ action: "reservation.created", resourceType: "reservation", resourceId: newId, resourceName: body.hostname || body.ipAddress, actor: sessionUser?.username, message: `Reservation created for ${body.ipAddress || "subnet"} (${body.owner})` });
    return json(res, newRes, 201);
  }
  if (path.match(/^\/api\/v1\/reservations\/[\w-]+$/) && method === "PUT") {
    const role = sessionUser ? sessionUser.role : "admin";
    if (role !== "admin" && role !== "networkadmin" && role !== "user" && role !== "assetsadmin") {
      return json(res, { error: "Forbidden — you do not have permission to edit reservations" }, 403);
    }
    const id = path.split("/").pop();
    const existing = RESERVATIONS.find((r) => r.id === id);
    if (!existing) return json(res, { error: "Not found" }, 404);
    // User and assetsadmin roles can only edit their own reservations
    if ((role === "user" || role === "assetsadmin") && existing.createdBy !== sessionUser?.username) {
      return json(res, { error: "Forbidden — you can only edit reservations you created" }, 403);
    }
    if (body.hostname !== undefined) existing.hostname = body.hostname;
    if (body.owner !== undefined) existing.owner = body.owner;
    if (body.projectRef !== undefined) existing.projectRef = body.projectRef;
    if (body.expiresAt !== undefined) existing.expiresAt = body.expiresAt;
    if (body.notes !== undefined) existing.notes = body.notes;
    existing.updatedAt = new Date().toISOString();
    logEventDemo({ action: "reservation.updated", resourceType: "reservation", resourceId: id, resourceName: existing.hostname || existing.ipAddress, actor: sessionUser?.username, message: `Reservation updated for ${existing.ipAddress || "subnet"}` });
    return json(res, existing);
  }
  if (path.match(/^\/api\/v1\/reservations\/[\w-]+$/) && method === "DELETE") {
    const role = sessionUser ? sessionUser.role : "admin";
    if (role !== "admin" && role !== "networkadmin" && role !== "user" && role !== "assetsadmin") {
      return json(res, { error: "Forbidden — you do not have permission to release reservations" }, 403);
    }
    const id = path.split("/").pop();
    const existing = RESERVATIONS.find((r) => r.id === id);
    if (existing) {
      // User and assetsadmin roles can only release their own reservations
      if ((role === "user" || role === "assetsadmin") && existing.createdBy !== sessionUser?.username) {
        return json(res, { error: "Forbidden — you can only release reservations you created" }, 403);
      }
      existing.status = "released";
      existing.updatedAt = new Date().toISOString();
      const subnet = SUBNETS.find((s) => s.id === existing.subnetId);
      if (subnet && subnet._count && subnet._count.reservations > 0) {
        subnet._count.reservations--;
      }
      logEventDemo({ action: "reservation.released", resourceType: "reservation", resourceId: id, resourceName: existing.hostname || existing.ipAddress, message: `Reservation released for ${existing.ipAddress || "subnet"}` });
    }
    res.writeHead(204);
    return res.end();
  }

  // Utilization
  if (path === "/api/v1/utilization" && method === "GET") {
    return json(res, buildUtilization());
  }

  // Users
  if (path === "/api/v1/users" && method === "GET") {
    return json(res, USERS);
  }
  if (path === "/api/v1/users" && method === "POST") {
    return json(res, { id: crypto.randomUUID(), ...body, authProvider: "local", createdAt: new Date().toISOString() }, 201);
  }
  if (path.match(/\/password$/) && method === "PUT") {
    // Find the user and check if Azure (block password reset for Azure users)
    const pwUserId = path.split("/").slice(-2, -1)[0];
    const pwUser = USERS.find((u) => u.id === pwUserId);
    if (pwUser && pwUser.authProvider === "azure") {
      return json(res, { error: "Cannot reset password for Azure SSO users" }, 400);
    }
    return json(res, { ok: true });
  }
  if (path.match(/\/role$/) && method === "PUT") {
    return json(res, { ok: true, role: body.role });
  }
  if (path.match(/^\/api\/v1\/users\/[\w-]+$/) && method === "DELETE") {
    res.writeHead(204);
    return res.end();
  }

  // Assets
  if (path === "/api/v1/assets" && method === "GET") {
    let result = [...ASSETS];
    const status = params.get("status");
    const assetType = params.get("assetType");
    const search = params.get("search");
    if (status) result = result.filter((a) => a.status === status);
    if (assetType) result = result.filter((a) => a.assetType === assetType);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((a) =>
        (a.hostname && a.hostname.toLowerCase().includes(q)) ||
        (a.dnsName && a.dnsName.toLowerCase().includes(q)) ||
        (a.ipAddress && a.ipAddress.toLowerCase().includes(q)) ||
        (a.macAddress && a.macAddress.toLowerCase().includes(q)) ||
        (a.assetTag && a.assetTag.toLowerCase().includes(q)) ||
        (a.assignedTo && a.assignedTo.toLowerCase().includes(q))
      );
    }
    const total = result.length;
    const limit = Math.min(parseInt(params.get("limit")) || 50, 200);
    const offset = parseInt(params.get("offset")) || 0;
    result = result.slice(offset, offset + limit);
    return json(res, { assets: result, total, limit, offset });
  }
  if (path.match(/^\/api\/v1\/assets\/[\w-]+$/) && method === "GET") {
    const id = path.split("/").pop();
    const asset = ASSETS.find((a) => a.id === id);
    return asset ? json(res, asset) : json(res, { error: "Not found" }, 404);
  }
  if (path === "/api/v1/assets" && method === "POST") {
    const now = new Date().toISOString();
    const newId = crypto.randomUUID();
    const macAddresses = body.macAddress
      ? [{ mac: body.macAddress.toUpperCase().replace(/-/g, ":"), lastSeen: now, source: "manual" }]
      : [];
    const newAsset = { id: newId, ...body, macAddresses, createdAt: now, updatedAt: now };
    ASSETS.push(newAsset);
    logEventDemo({ action: "asset.created", resourceType: "asset", resourceId: newId, resourceName: body.hostname || body.ipAddress, message: `Asset "${body.hostname || body.ipAddress || "unknown"}" created` });
    return json(res, newAsset, 201);
  }
  if (path.match(/^\/api\/v1\/assets\/[\w-]+$/) && method === "PUT") {
    const id = path.split("/").pop();
    const asset = ASSETS.find((a) => a.id === id);
    if (!asset) return json(res, { error: "Not found" }, 404);
    const now = new Date().toISOString();
    // If MAC changed, update macAddresses list
    if (body.macAddress && body.macAddress !== asset.macAddress) {
      _addMacToAsset(asset, body.macAddress, "manual", now);
    }
    Object.assign(asset, body, { updatedAt: now });
    logEventDemo({ action: "asset.updated", resourceType: "asset", resourceId: id, resourceName: body.hostname || asset.hostname, message: `Asset "${body.hostname || asset.hostname || "unknown"}" updated` });
    return json(res, asset);
  }
  // DNS Lookup — bulk
  if (path === "/api/v1/assets/dns-lookup" && method === "POST") {
    const missing = ASSETS.filter((a) => a.ipAddress && !a.dnsName && a.status !== "decommissioned");
    let resolved = 0;
    const results = [];
    for (const asset of missing) {
      // Mock: generate a plausible FQDN from hostname or IP
      const dnsName = asset.hostname
        ? asset.hostname + ".corp.example.com"
        : asset.ipAddress.split(".").reverse().join(".") + ".in-addr.arpa";
      asset.dnsName = dnsName;
      asset.updatedAt = new Date().toISOString();
      results.push({ id: asset.id, ip: asset.ipAddress, dnsName });
      resolved++;
    }
    logEventDemo({ action: "asset.dns.bulk", resourceType: "asset", message: `Bulk DNS lookup: ${resolved} resolved, 0 failed out of ${missing.length} assets` });
    return json(res, { total: missing.length, resolved, failed: 0, results });
  }
  // DNS Lookup — single asset
  if (path.match(/^\/api\/v1\/assets\/[\w-]+\/dns-lookup$/) && method === "POST") {
    const id = path.split("/")[4];
    const asset = ASSETS.find((a) => a.id === id);
    if (!asset) return json(res, { error: "Not found" }, 404);
    if (!asset.ipAddress) return json(res, { error: "Asset has no IP address" }, 400);
    // Mock: generate FQDN from hostname
    const dnsName = asset.hostname
      ? asset.hostname + ".corp.example.com"
      : asset.ipAddress.split(".").reverse().join(".") + ".in-addr.arpa";
    asset.dnsName = dnsName;
    asset.updatedAt = new Date().toISOString();
    logEventDemo({ action: "asset.dns.resolved", resourceType: "asset", resourceId: id, resourceName: asset.hostname || asset.ipAddress, message: `DNS resolved: ${asset.ipAddress} → ${dnsName}` });
    return json(res, { ok: true, dnsName, message: `${asset.ipAddress} → ${dnsName}` });
  }
  // OUI Lookup — bulk
  if (path === "/api/v1/assets/oui-lookup" && method === "POST") {
    const missing = ASSETS.filter((a) => a.macAddress && !a.manufacturer && a.status !== "decommissioned");
    let resolved = 0;
    const results = [];
    for (const asset of missing) {
      const vendor = _mockOuiLookup(asset.macAddress);
      if (vendor) {
        asset.manufacturer = vendor;
        asset.updatedAt = new Date().toISOString();
        results.push({ id: asset.id, mac: asset.macAddress, manufacturer: vendor });
        resolved++;
      }
    }
    logEventDemo({ action: "asset.oui.bulk", resourceType: "asset", message: `Bulk OUI lookup: ${resolved} resolved, ${missing.length - resolved} unmatched out of ${missing.length} assets` });
    return json(res, { total: missing.length, resolved, failed: missing.length - resolved, results });
  }
  // OUI Lookup — single asset
  if (path.match(/^\/api\/v1\/assets\/[\w-]+\/oui-lookup$/) && method === "POST") {
    const id = path.split("/")[4];
    const asset = ASSETS.find((a) => a.id === id);
    if (!asset) return json(res, { error: "Not found" }, 404);
    if (!asset.macAddress) return json(res, { error: "Asset has no MAC address" }, 400);
    const vendor = _mockOuiLookup(asset.macAddress);
    if (!vendor) return json(res, { ok: false, message: `No OUI match for ${asset.macAddress}` });
    asset.manufacturer = vendor;
    asset.updatedAt = new Date().toISOString();
    logEventDemo({ action: "asset.oui.resolved", resourceType: "asset", resourceId: id, resourceName: asset.hostname || asset.ipAddress, message: `OUI resolved: ${asset.macAddress} → ${vendor}` });
    return json(res, { ok: true, manufacturer: vendor, message: `${asset.macAddress} → ${vendor}` });
  }
  if (path.match(/^\/api\/v1\/assets\/[\w-]+$/) && method === "DELETE") {
    const id = path.split("/").pop();
    const asset = ASSETS.find((a) => a.id === id);
    logEventDemo({ action: "asset.deleted", resourceType: "asset", resourceId: id, resourceName: asset?.hostname || asset?.ipAddress, message: `Asset "${asset?.hostname || asset?.ipAddress || "unknown"}" deleted` });
    res.writeHead(204);
    return res.end();
  }

  // ── Quarantine sighting settings ──────────────────────────────────────────
  if (path === "/api/v1/assets/sighting-settings") {
    if (method === "GET") return json(res, { sightingMaxAgeDays: 180 });
    if (method === "PUT") return json(res, { sightingMaxAgeDays: body.sightingMaxAgeDays ?? 180 });
  }
  // ── Quarantine sightings (per asset) ──────────────────────────────────────
  if (path.match(/^\/api\/v1\/assets\/[\w-]+\/sightings$/) && method === "GET") {
    return json(res, { sightings: [] });
  }
  // ── Quarantine status (per asset) ─────────────────────────────────────────
  if (path.match(/^\/api\/v1\/assets\/[\w-]+\/quarantine-status$/) && method === "GET") {
    const id = path.split("/")[4];
    const asset = ASSETS.find((a) => a.id === id);
    if (!asset) return json(res, { error: "Not found" }, 404);
    return json(res, {
      status: asset.status,
      quarantineReason: asset.quarantineReason || null,
      quarantinedAt: asset.quarantinedAt || null,
      quarantinedBy: asset.quarantinedBy || null,
      quarantineTargets: asset.quarantineTargets || [],
    });
  }
  // ── Quarantine push ────────────────────────────────────────────────────────
  if (path.match(/^\/api\/v1\/assets\/[\w-]+\/quarantine$/) && method === "POST") {
    const id = path.split("/")[4];
    const asset = ASSETS.find((a) => a.id === id);
    if (!asset) return json(res, { error: "Not found" }, 404);
    if (!asset.macAddress) return json(res, { error: "Asset has no MAC address" }, 400);
    asset.statusBeforeQuarantine = asset.status;
    asset.status = "quarantined";
    asset.quarantineReason = body.reason || null;
    asset.quarantinedAt = new Date().toISOString();
    asset.quarantinedBy = "demo";
    asset.quarantineTargets = [];
    asset.updatedAt = new Date().toISOString();
    logEventDemo({ action: "asset.quarantined", resourceType: "asset", resourceId: id, resourceName: asset.hostname || asset.ipAddress, message: `Asset "${asset.hostname || id}" quarantined (demo — no FortiGate push)` });
    return json(res, { message: "Asset quarantined (demo — no FortiGate push)", succeededCount: 0, failedCount: 0, targets: [] });
  }
  // ── Quarantine release ─────────────────────────────────────────────────────
  if (path.match(/^\/api\/v1\/assets\/[\w-]+\/quarantine$/) && method === "DELETE") {
    const id = path.split("/")[4];
    const asset = ASSETS.find((a) => a.id === id);
    if (!asset) return json(res, { error: "Not found" }, 404);
    asset.status = asset.statusBeforeQuarantine || "active";
    asset.quarantineReason = null;
    asset.quarantinedAt = null;
    asset.quarantinedBy = null;
    asset.quarantineTargets = [];
    asset.updatedAt = new Date().toISOString();
    logEventDemo({ action: "asset.quarantine_released", resourceType: "asset", resourceId: id, resourceName: asset.hostname || asset.ipAddress, message: `Quarantine released on "${asset.hostname || id}" (demo)` });
    return json(res, { message: "Quarantine released (demo — no FortiGate unpush)" });
  }
  // ── Quarantine verify ─────────────────────────────────────────────────────
  if (path.match(/^\/api\/v1\/assets\/[\w-]+\/quarantine\/verify$/) && method === "POST") {
    return json(res, { driftDetected: false, targets: [] });
  }
  // ── Bulk quarantine ────────────────────────────────────────────────────────
  if (path === "/api/v1/assets/bulk-quarantine" && method === "POST") {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const results = ids.map((id) => {
      const asset = ASSETS.find((a) => a.id === id);
      if (!asset) return { id, ok: false, message: "Not found" };
      asset.statusBeforeQuarantine = asset.status;
      asset.status = "quarantined";
      asset.quarantineReason = body.reason || null;
      asset.quarantinedAt = new Date().toISOString();
      asset.quarantinedBy = "demo";
      asset.quarantineTargets = [];
      asset.updatedAt = new Date().toISOString();
      return { id, ok: true, message: "Quarantined (demo)", succeededCount: 0, failedCount: 0 };
    });
    return json(res, { results });
  }
  if (path === "/api/v1/assets/bulk-quarantine/release" && method === "POST") {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const results = ids.map((id) => {
      const asset = ASSETS.find((a) => a.id === id);
      if (!asset) return { id, ok: false, message: "Not found" };
      asset.status = asset.statusBeforeQuarantine || "active";
      asset.quarantineTargets = [];
      asset.updatedAt = new Date().toISOString();
      return { id, ok: true, message: "Released (demo)" };
    });
    return json(res, { results });
  }

  // ── API Tokens ─────────────────────────────────────────────────────────────
  if (path === "/api/v1/api-tokens" && method === "GET") {
    return json(res, { tokens: API_TOKENS, knownScopes: ["assets:quarantine", "assets:read"] });
  }
  if (path === "/api/v1/api-tokens" && method === "POST") {
    const token = {
      id: crypto.randomUUID(),
      name: body.name,
      tokenPrefix: "polaris_demoXXXX",
      scopes: body.scopes || [],
      createdBy: "demo",
      createdAt: new Date().toISOString(),
      expiresAt: body.expiresAt || null,
      lastUsedAt: null,
      lastUsedIp: null,
      revokedAt: null,
      revokedBy: null,
    };
    API_TOKENS.push(token);
    return json(res, { token, rawToken: "polaris_demoXXXXXXXXXXXXXXXXXXXXXXXX" }, 201);
  }
  if (path.match(/^\/api\/v1\/api-tokens\/[\w-]+\/revoke$/) && method === "POST") {
    const id = path.split("/")[4];
    const t = API_TOKENS.find((x) => x.id === id);
    if (!t) return json(res, { error: "Not found" }, 404);
    t.revokedAt = new Date().toISOString();
    t.revokedBy = "demo";
    return json(res, { ok: true });
  }
  if (path.match(/^\/api\/v1\/api-tokens\/[\w-]+$/) && method === "DELETE") {
    const id = path.split("/")[4];
    const idx = API_TOKENS.findIndex((x) => x.id === id);
    if (idx === -1) return json(res, { error: "Not found" }, 404);
    API_TOKENS.splice(idx, 1);
    res.writeHead(204);
    return res.end();
  }

  // Integrations
  if (path === "/api/v1/integrations" && method === "GET") {
    // Strip secrets from list response
    const safe = INTEGRATIONS.map((i) => {
      const c = { ...i.config };
      if (c.apiToken) c.apiToken = "••••••••";
      if (c.password) c.password = "••••••••";
      if (c.clientSecret) c.clientSecret = "••••••••";
      return { ...i, config: c };
    });
    const total = safe.length;
    const limit = Math.min(parseInt(params.get("limit")) || 50, 200);
    const offset = parseInt(params.get("offset")) || 0;
    return json(res, { integrations: safe.slice(offset, offset + limit), total, limit, offset });
  }
  if (path === "/api/v1/integrations/test" && method === "POST") {
    const isWin = body.type === "windowsserver";
    const isEntra = body.type === "entraid";
    if (isEntra) {
      const delay = 700 + Math.random() * 300;
      return setTimeout(() => {
        const ok = !!(body.config?.tenantId && body.config?.clientId && body.config?.clientSecret);
        const msg = ok ? 'Connected — tenant "Corporate Demo" (demo)' : "Tenant ID, Client ID, and Client Secret are required";
        logEventDemo({ action: "integration.test.completed", resourceType: "integration", resourceName: body.name, level: ok ? "info" : "warning", message: `Connection test ${ok ? "succeeded" : "failed"} for "${body.name || "new integration"}": ${msg}` });
        json(res, { ok, message: msg });
      }, delay);
    }
    // Real FortiManager test for non-mock hosts
    if (!isWin && !_isMockFmg(body.config)) {
      logEventDemo({ action: "integration.test.started", resourceType: "integration", resourceName: body.name, message: `Connection test started for "${body.name || "new integration"}"` });
      _fmgTestConnection(body.config).then((result) => {
        logEventDemo({ action: "integration.test.completed", resourceType: "integration", resourceName: body.name, level: result.ok ? "info" : "warning", message: `Connection test ${result.ok ? "succeeded" : "failed"} for "${body.name || "new integration"}": ${result.message}` });
        json(res, result);
      }).catch((err) => {
        logEventDemo({ action: "integration.test.completed", resourceType: "integration", resourceName: body.name, level: "error", message: `Connection test failed for "${body.name || "new integration"}": ${err.message}` });
        json(res, { ok: false, message: err.message || "Unknown error" });
      });
      return;
    }
    const delay = 800 + Math.random() * 400;
    return setTimeout(() => {
      const msg = isWin
        ? "Connected — DHCP Server is running on " + (body.config?.host || "server") + " (demo)"
        : "Connected — FortiManager v7.4.3 (demo)";
      logEventDemo({ action: "integration.test.completed", resourceType: "integration", resourceName: body.name, message: `Connection test succeeded for "${body.name || "new integration"}": ${msg}` });
      json(res, { ok: true, message: msg });
    }, delay);
  }
  if (path.match(/^\/api\/v1\/integrations\/[\w-]+\/test$/) && method === "POST") {
    const id = path.split("/")[4];
    const intg = INTEGRATIONS.find((i) => i.id === id);
    if (!intg) return json(res, { error: "Not found" }, 404);
    const isWin = intg.type === "windowsserver";
    const isEntra = intg.type === "entraid";
    if (isEntra) {
      const delay = 700 + Math.random() * 300;
      logEventDemo({ action: "integration.test.started", resourceType: "integration", resourceId: id, resourceName: intg.name, message: `Connection test started for "${intg.name}"` });
      return setTimeout(() => {
        const ok = intg.enabled && !!(intg.config?.tenantId && intg.config?.clientId && intg.config?.clientSecret);
        const msg = ok ? 'Connected — tenant "Corporate Demo" (demo)' : "Connection failed — check tenant/client/secret configuration";
        intg.lastTestOk = ok;
        intg.lastTestAt = new Date().toISOString();
        logEventDemo({ action: "integration.test.completed", resourceType: "integration", resourceId: id, resourceName: intg.name, level: ok ? "info" : "warning", message: `Connection test ${ok ? "succeeded" : "failed"} for "${intg.name}": ${msg}` });
        json(res, { ok, message: msg });
      }, delay);
    }
    // Real FortiManager test for non-mock hosts
    if (!isWin && !_isMockFmg(intg.config)) {
      logEventDemo({ action: "integration.test.started", resourceType: "integration", resourceId: id, resourceName: intg.name, message: `Connection test started for "${intg.name}"` });
      _fmgTestConnection(intg.config).then((result) => {
        intg.lastTestOk = result.ok;
        intg.lastTestAt = new Date().toISOString();
        logEventDemo({ action: "integration.test.completed", resourceType: "integration", resourceId: id, resourceName: intg.name, level: result.ok ? "info" : "warning", message: `Connection test ${result.ok ? "succeeded" : "failed"} for "${intg.name}": ${result.message}` });
        json(res, result);
      }).catch((err) => {
        intg.lastTestOk = false;
        intg.lastTestAt = new Date().toISOString();
        logEventDemo({ action: "integration.test.completed", resourceType: "integration", resourceId: id, resourceName: intg.name, level: "error", message: `Connection test failed for "${intg.name}": ${err.message}` });
        json(res, { ok: false, message: err.message || "Unknown error" });
      });
      return;
    }
    const delay = 800 + Math.random() * 400;
    logEventDemo({ action: "integration.test.started", resourceType: "integration", resourceId: id, resourceName: intg.name, message: `Connection test started for "${intg.name}"` });
    return setTimeout(() => {
      const ok = intg.enabled;
      const msg = ok
        ? (isWin
            ? "Connected — DHCP Server is running on " + (intg.config?.host || "server") + " (demo)"
            : "Connected — FortiManager v7.4.3 (demo)")
        : "Connection failed — integration is disabled";
      logEventDemo({ action: "integration.test.completed", resourceType: "integration", resourceId: id, resourceName: intg.name, level: ok ? "info" : "warning", message: `Connection test ${ok ? "succeeded" : "failed"} for "${intg.name}": ${msg}` });
      json(res, { ok, message: msg });
    }, delay);
  }
  if (path.match(/^\/api\/v1\/integrations\/[\w-]+\/register$/) && method === "POST") {
    const id = path.split("/")[4];
    const intg = INTEGRATIONS.find((i) => i.id === id);
    if (!intg) return json(res, { error: "Not found" }, 404);
    const host = intg.config?.host;
    if (!host) return json(res, { error: "Integration has no host configured" }, 400);
    const fields = Array.isArray(body?.fields) ? body.fields : [];
    const result = registerFortiManagerDemo(host, intg.name, true, fields);
    return json(res, result);
  }
  if (path.match(/^\/api\/v1\/integrations\/[\w-]+\/discover$/) && method === "POST") {
    const id = path.split("/")[4];
    const intg = INTEGRATIONS.find((i) => i.id === id);
    if (!intg) return json(res, { error: "Not found" }, 404);
    if (intg.type === "entraid") {
      if (!intg.config?.tenantId || !intg.config?.clientId || !intg.config?.clientSecret) {
        return json(res, { error: "Entra ID integration is missing tenantId, clientId, or clientSecret" }, 400);
      }
      logEventDemo({ action: "integration.discover.started", resourceType: "integration", resourceId: id, resourceName: intg.name, message: `Manual Entra ID discovery started for "${intg.name}"` });
      const pLog = (step, level, message) => {
        logEventDemo({ action: "integration." + step, resourceType: "integration", resourceId: id, resourceName: intg.name, level, message: "[" + intg.name + "] " + message });
      };
      const sLog = (level, message) => {
        logEventDemo({ action: "integration.sync", resourceType: "integration", resourceId: id, resourceName: intg.name, level, message: "[" + intg.name + "] " + message });
      };
      const discovered = discoverEntraDevicesDemo(intg.config, pLog);
      const result = syncEntraDevicesDemo(intg.id, intg.name, discovered, sLog);
      logEventDemo({ action: "integration.discover.completed", resourceType: "integration", resourceId: id, resourceName: intg.name, message: `Entra ID discovery completed for "${intg.name}" — ${result.created.length} created, ${result.updated.length} updated, ${result.skipped.length} skipped` });
      intg.lastDiscoveryAt = new Date().toISOString();
      return json(res, result);
    }
    if (!intg.config?.host) return json(res, { error: "Integration has no host configured" }, 400);
    logEventDemo({ action: "integration.discover.started", resourceType: "integration", resourceId: id, resourceName: intg.name, message: `Manual DHCP discovery started for "${intg.name}"` });
    const progressLog = (step, level, message) => {
      logEventDemo({ action: "integration." + step, resourceType: "integration", resourceId: id, resourceName: intg.name, level, message: "[" + intg.name + "] " + message });
    };
    const syncLog = (level, message) => {
      logEventDemo({ action: "integration.sync", resourceType: "integration", resourceId: id, resourceName: intg.name, level, message: "[" + intg.name + "] " + message });
    };
    // Real FortiManager discovery for non-mock hosts
    if (intg.type !== "windowsserver" && !_isMockFmg(intg.config)) {
      _fmgDiscover(intg.config, progressLog).then((discovered) => {
        const result = syncDhcpSubnetsDemo(intg.id, intg.name, intg.type, discovered, syncLog);
        logEventDemo({ action: "integration.discover.completed", resourceType: "integration", resourceId: id, resourceName: intg.name, message: `DHCP discovery completed for "${intg.name}" — ${result.created.length} created, ${result.updated.length} updated, ${result.skipped.length} skipped, ${(result.assets || []).length} assets, ${(result.reservations || []).length} reservations` });
        json(res, result);
      }).catch((err) => {
        logEventDemo({ action: "integration.discover.completed", resourceType: "integration", resourceId: id, resourceName: intg.name, level: "error", message: `DHCP discovery failed for "${intg.name}": ${err.message}` });
        json(res, { error: err.message }, 502);
      });
      return;
    }
    const discovered = intg.type === "windowsserver"
      ? discoverWinDhcpDemo(intg.config)
      : discoverDhcpDemo(intg.config, progressLog);
    const result = syncDhcpSubnetsDemo(intg.id, intg.name, intg.type, discovered, syncLog);
    logEventDemo({ action: "integration.discover.completed", resourceType: "integration", resourceId: id, resourceName: intg.name, message: `DHCP discovery completed for "${intg.name}" — ${result.created.length} created, ${result.updated.length} updated, ${result.skipped.length} skipped, ${(result.assets || []).length} assets, ${(result.reservations || []).length} reservations` });
    return json(res, result);
  }
  if (path.match(/^\/api\/v1\/integrations\/[\w-]+$/) && method === "GET") {
    const id = path.split("/").pop();
    const intg = INTEGRATIONS.find((i) => i.id === id);
    if (!intg) return json(res, { error: "Not found" }, 404);
    const c = { ...intg.config };
    if (c.apiToken) c.apiToken = "••••••••";
    if (c.password) c.password = "••••••••";
    if (c.clientSecret) c.clientSecret = "••••••••";
    return json(res, { ...intg, config: c });
  }
  if (path === "/api/v1/integrations" && method === "POST") {
    const now = new Date().toISOString();
    const intgType = body.type || "fortimanager";
    const isWin = intgType === "windowsserver";
    const safeConfig = { ...body.config };
    if (safeConfig.apiToken) safeConfig.apiToken = "••••••••";
    if (safeConfig.password) safeConfig.password = "••••••••";
    if (safeConfig.clientSecret) safeConfig.clientSecret = "••••••••";
    const pollInterval = Math.min(24, Math.max(1, parseInt(body.pollInterval, 10) || 4));
    const newIntg = {
      id: crypto.randomUUID(),
      type: intgType,
      name: body.name,
      config: safeConfig,
      enabled: body.enabled !== false,
      pollInterval,
      lastTestAt: null,
      lastTestOk: null,
      createdAt: now,
      updatedAt: now,
    };
    INTEGRATIONS.push({ ...newIntg, config: { ...body.config } });
    logEventDemo({ action: "integration.created", resourceType: "integration", resourceId: newIntg.id, resourceName: body.name, message: `Integration "${body.name}" (${intgType}) created` });
    const response = { ...newIntg };
    // Auto-register FortiManager IP
    if (!isWin && body.config?.host) {
      const registration = registerFortiManagerDemo(body.config.host, body.name || "FortiManager", false);
      if (registration.conflicts.length) response.conflicts = registration.conflicts;
    }
    // DHCP discovery
    const canDiscover = newIntg.enabled && body.config?.host &&
      (isWin ? body.config?.username : body.config?.apiToken);
    if (canDiscover) {
      const pLog = (step, level, message) => {
        logEventDemo({ action: "integration." + step, resourceType: "integration", resourceId: newIntg.id, resourceName: body.name, level, message: "[" + body.name + "] " + message });
      };
      // Real FortiManager discovery for non-mock hosts
      if (!isWin && !_isMockFmg(body.config)) {
        _fmgDiscover(body.config, pLog).then((discovered) => {
          const syncResult = syncDhcpSubnetsDemo(newIntg.id, body.name || newIntg.type, intgType, discovered);
          response.dhcpDiscovery = syncResult;
          json(res, response, 201);
        }).catch((err) => {
          pLog("discover.completed", "error", `DHCP discovery failed: ${err.message}`);
          response.dhcpDiscovery = { error: err.message };
          json(res, response, 201);
        });
        return;
      }
      const discovered = isWin
        ? discoverWinDhcpDemo(body.config)
        : discoverDhcpDemo(body.config, pLog);
      const syncResult = syncDhcpSubnetsDemo(newIntg.id, body.name || newIntg.type, intgType, discovered);
      response.dhcpDiscovery = syncResult;
    }
    return json(res, response, 201);
  }
  if (path.match(/^\/api\/v1\/integrations\/[\w-]+$/) && method === "PUT") {
    const id = path.split("/").pop();
    const intg = INTEGRATIONS.find((i) => i.id === id);
    if (!intg) return json(res, { error: "Not found" }, 404);
    const isWin = intg.type === "windowsserver";
    const mergedConfig = { ...intg.config, ...(body.config || {}) };
    // Preserve secrets if not re-submitted
    if (!body.config?.apiToken && intg.config.apiToken) mergedConfig.apiToken = intg.config.apiToken;
    if (!body.config?.password && intg.config.password) mergedConfig.password = intg.config.password;
    if (!body.config?.clientSecret && intg.config.clientSecret) mergedConfig.clientSecret = intg.config.clientSecret;
    const safeConfig = { ...mergedConfig };
    if (safeConfig.apiToken) safeConfig.apiToken = "••••••••";
    if (safeConfig.password) safeConfig.password = "••••••••";
    if (safeConfig.clientSecret) safeConfig.clientSecret = "••••••••";
    const updated = {
      ...intg,
      ...body,
      config: safeConfig,
      pollInterval: body.pollInterval !== undefined
        ? Math.min(24, Math.max(1, parseInt(body.pollInterval, 10) || 4))
        : intg.pollInterval,
      updatedAt: new Date().toISOString(),
    };
    // Persist real config (with secrets) back to the in-memory integration
    Object.assign(intg, { ...updated, config: mergedConfig });
    logEventDemo({ action: "integration.updated", resourceType: "integration", resourceId: intg.id, resourceName: updated.name || intg.name, message: `Integration "${updated.name || intg.name}" updated` });
    const response = { ...updated };
    // Auto-register FortiManager IP
    if (!isWin && mergedConfig.host) {
      const registration = registerFortiManagerDemo(mergedConfig.host, updated.name || intg.name, false);
      if (registration.conflicts.length) response.conflicts = registration.conflicts;
    }
    // DHCP discovery
    const canDiscover = updated.enabled !== false && mergedConfig.host &&
      (isWin ? mergedConfig.username : mergedConfig.apiToken);
    if (canDiscover) {
      const pLog = (step, level, message) => {
        logEventDemo({ action: "integration." + step, resourceType: "integration", resourceId: intg.id, resourceName: updated.name || intg.name, level, message: "[" + (updated.name || intg.name) + "] " + message });
      };
      // Real FortiManager discovery for non-mock hosts
      if (!isWin && !_isMockFmg(mergedConfig)) {
        _fmgDiscover(mergedConfig, pLog).then((discovered) => {
          const syncResult = syncDhcpSubnetsDemo(intg.id, updated.name || intg.name, intg.type, discovered);
          response.dhcpDiscovery = syncResult;
          json(res, response);
        }).catch((err) => {
          pLog("discover.completed", "error", `DHCP discovery failed: ${err.message}`);
          response.dhcpDiscovery = { error: err.message };
          json(res, response);
        });
        return;
      }
      const discovered = isWin
        ? discoverWinDhcpDemo(mergedConfig)
        : discoverDhcpDemo(mergedConfig, pLog);
      const syncResult = syncDhcpSubnetsDemo(intg.id, updated.name || intg.name, intg.type, discovered);
      response.dhcpDiscovery = syncResult;
    }
    return json(res, response);
  }
  if (path.match(/^\/api\/v1\/integrations\/[\w-]+$/) && method === "DELETE") {
    const id = path.split("/").pop();
    const intg = INTEGRATIONS.find((i) => i.id === id);
    if (intg) {
      logEventDemo({ action: "integration.deleted", resourceType: "integration", resourceId: id, resourceName: intg.name, message: `Integration "${intg.name}" deleted` });
    }
    res.writeHead(204);
    return res.end();
  }

  // Event archive settings
  if (path === "/api/v1/events/archive-settings" && method === "GET") {
    const safe = { ...ARCHIVE_SETTINGS };
    if (safe.password) safe.password = "••••••••";
    return json(res, safe);
  }
  if (path === "/api/v1/events/archive-settings" && method === "PUT") {
    if (body.password === "••••••••") delete body.password;
    ARCHIVE_SETTINGS = { ...ARCHIVE_SETTINGS, ...body };
    const safe = { ...ARCHIVE_SETTINGS };
    if (safe.password) safe.password = "••••••••";
    return json(res, safe);
  }
  if (path === "/api/v1/events/archive-test" && method === "POST") {
    const s = body;
    if (!s.host || !s.username) {
      return json(res, { ok: false, message: "Host and username are required" });
    }
    const delay = 600 + Math.random() * 400;
    return setTimeout(() => {
      json(res, { ok: true, message: "Connected to " + s.host + " via " + (s.protocol || "scp").toUpperCase() + " (demo)" });
    }, delay);
  }

  // Syslog settings
  if (path === "/api/v1/events/syslog-settings" && method === "GET") {
    return json(res, { ...SYSLOG_SETTINGS });
  }
  if (path === "/api/v1/events/syslog-settings" && method === "PUT") {
    SYSLOG_SETTINGS = { ...SYSLOG_SETTINGS, ...body };
    return json(res, { ...SYSLOG_SETTINGS });
  }
  if (path === "/api/v1/events/syslog-test" && method === "POST") {
    const s = body;
    if (!s.host) {
      return json(res, { ok: false, message: "Host is required" });
    }
    const delay = 400 + Math.random() * 300;
    return setTimeout(() => {
      json(res, { ok: true, message: "Test message sent to " + s.host + ":" + (s.port || 514) + " via " + (s.protocol || "udp").toUpperCase() + " (demo)" });
    }, delay);
  }

  // Server Settings — NTP
  if (path === "/api/v1/server-settings/ntp" && method === "GET") {
    return json(res, { ...NTP_SETTINGS });
  }
  if (path === "/api/v1/server-settings/ntp" && method === "PUT") {
    NTP_SETTINGS = { ...NTP_SETTINGS, ...body };
    return json(res, { ...NTP_SETTINGS });
  }
  if (path === "/api/v1/server-settings/ntp/test" && method === "POST") {
    const servers = body.servers || [];
    if (servers.length === 0) {
      return json(res, { ok: false, message: "No NTP servers configured" });
    }
    const delay = 500 + Math.random() * 500;
    return setTimeout(() => {
      json(res, { ok: true, message: "Synchronized with " + servers[0] + " (offset: +0.003s, " + (body.mode || "NTP").toUpperCase() + ")" });
    }, delay);
  }

  // Server Settings — DNS
  if (path === "/api/v1/server-settings/dns" && method === "GET") {
    return json(res, { ...DNS_SETTINGS });
  }
  if (path === "/api/v1/server-settings/dns" && method === "PUT") {
    DNS_SETTINGS.servers = (body.servers || []).map(s => s.trim()).filter(Boolean);
    DNS_SETTINGS.mode = body.mode || "standard";
    DNS_SETTINGS.dohUrl = (body.dohUrl || "").trim();
    return json(res, { ...DNS_SETTINGS });
  }
  if (path === "/api/v1/server-settings/dns/test" && method === "POST") {
    const servers = (body.servers || []).filter(Boolean);
    const mode = body.mode || "standard";
    const dohUrl = (body.dohUrl || "").trim();
    const testIp = body.testIp || "8.8.8.8";

    if (mode === "doh" && !dohUrl) {
      return json(res, { ok: false, message: "No DoH URL configured" });
    }
    if (mode !== "doh" && servers.length === 0) {
      return json(res, { ok: false, message: "No DNS servers configured" });
    }

    const delay = 200 + Math.random() * 300;
    const via = mode === "doh" ? "DoH (" + dohUrl + ")"
              : mode === "dot" ? "DoT (" + servers[0] + ":853)"
              : servers[0];
    return setTimeout(() => {
      json(res, { ok: true, message: "Resolved " + testIp + " → dns.google in " + Math.round(delay) + "ms via " + via });
    }, delay);
  }

  // Server Settings — OUI Database
  if (path === "/api/v1/server-settings/oui" && method === "GET") {
    return json(res, { loaded: OUI_STATUS.loaded, entries: OUI_STATUS.entries, refreshedAt: OUI_STATUS.refreshedAt });
  }
  if (path === "/api/v1/server-settings/oui/refresh" && method === "POST") {
    OUI_STATUS.loaded = true;
    OUI_STATUS.entries = 31265;
    OUI_STATUS.refreshedAt = new Date().toISOString();
    return setTimeout(() => {
      json(res, { entries: OUI_STATUS.entries, sizeKb: 2843 });
    }, 800);
  }
  if (path === "/api/v1/server-settings/oui/overrides" && method === "GET") {
    return json(res, OUI_OVERRIDES);
  }
  if (path === "/api/v1/server-settings/oui/overrides" && method === "POST") {
    const clean = (body.prefix || "").replace(/[:\-.\s]/g, "").toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(clean)) return json(res, { error: "prefix must be 6 hex characters (e.g. AA:BB:CC)" }, 400);
    if (!body.manufacturer) return json(res, { error: "manufacturer is required" }, 400);
    const formatted = clean.match(/.{2}/g).join(":");
    const existing = OUI_OVERRIDES.findIndex(o => o.prefix === formatted);
    if (existing >= 0) OUI_OVERRIDES[existing].manufacturer = body.manufacturer.trim();
    else OUI_OVERRIDES.push({ prefix: formatted, manufacturer: body.manufacturer.trim() });
    // Update matching assets in-memory
    let assetsUpdated = 0;
    ASSETS.forEach(a => {
      if (a.macAddress && a.macAddress.toUpperCase().startsWith(formatted)) {
        a.manufacturer = body.manufacturer.trim();
        a.updatedAt = new Date().toISOString();
        assetsUpdated++;
      }
    });
    return json(res, { prefix: formatted, manufacturer: body.manufacturer.trim(), assetsUpdated });
  }
  if (path.match(/^\/api\/v1\/server-settings\/oui\/overrides\/[\w:%]+$/) && method === "DELETE") {
    const prefix = decodeURIComponent(path.split("/").pop());
    OUI_OVERRIDES = OUI_OVERRIDES.filter(o => o.prefix !== prefix);
    res.writeHead(204); return res.end();
  }

  // Server Settings — PostgreSQL Tuning Check
  if (path === "/api/v1/server-settings/pg-tuning" && method === "GET") {
    const thresholds = { assets: 160, subnets: 1600, reservations: 160000 };
    // Demo uses mock counts above thresholds to showcase the alert
    const counts = { assets: 185, subnets: 1820, reservations: 12400 };
    const triggered = ["assets", "subnets"];

    const isSnoozed = PG_TUNING_SNOOZE.until && new Date(PG_TUNING_SNOOZE.until) > new Date();

    // Mock PG settings that are below recommended (for demo)
    const settings = [
      { name: "shared_buffers",      current: "128MB",  recommended: "2GB",  ok: false },
      { name: "work_mem",            current: "4MB",    recommended: "32MB", ok: false },
      { name: "effective_cache_size", current: "4GB",    recommended: "4GB",  ok: true },
      { name: "random_page_cost",    current: "4",      recommended: "1.1",  ok: false },
    ];

    return json(res, {
      needed: true,
      triggered,
      counts,
      thresholds,
      settings,
      snoozedUntil: isSnoozed ? PG_TUNING_SNOOZE.until : null,
    });
  }

  if (path === "/api/v1/server-settings/pg-tuning/snooze" && method === "POST") {
    const days = Math.min(30, Math.max(1, parseInt(body?.days, 10) || 7));
    PG_TUNING_SNOOZE.until = new Date(Date.now() + days * 86400000).toISOString();
    return json(res, { ok: true, snoozedUntil: PG_TUNING_SNOOZE.until });
  }

  // Server Settings — Application Updates
  if (path === "/api/v1/server-settings/updates/check" && method === "GET") {
    // Simulate checking for updates — alternate between up-to-date and available
    if (DEMO_UPDATE_STATUS.state === "complete" || DEMO_UPDATE_STATUS.state === "failed") {
      return json(res, DEMO_UPDATE_STATUS);
    }
    DEMO_UPDATE_STATUS = {
      state: "available",
      currentVersion: BRANDING.version || "1.0.5",
      latestVersion: _bumpPatch(BRANDING.version || "1.0.5"),
      currentCommit: "27d7c6f",
      latestCommit: "a1b2c3d",
      commitsBehind: 3,
      changes: [
        "a1b2c3d Add searchable timezone dropdown",
        "e4f5g6h Add deployment scripts for Ubuntu and Windows",
        "i7j8k9l Update README with multi-platform docs",
      ],
    };
    return json(res, DEMO_UPDATE_STATUS);
  }

  if (path === "/api/v1/server-settings/updates/status" && method === "GET") {
    return json(res, DEMO_UPDATE_STATUS);
  }

  if (path === "/api/v1/server-settings/updates/apply" && method === "POST") {
    // Simulate a multi-step update process
    const steps = [
      { name: "Backup database", status: "pending" },
      { name: "Pull latest code", status: "pending" },
      { name: "Install dependencies", status: "pending" },
      { name: "Build TypeScript", status: "pending" },
      { name: "Run migrations", status: "pending" },
      { name: "Restart service", status: "pending" },
    ];
    DEMO_UPDATE_STATUS = {
      state: "applying",
      currentVersion: BRANDING.version || "1.0.5",
      latestVersion: _bumpPatch(BRANDING.version || "1.0.5"),
      startedAt: new Date().toISOString(),
      steps,
    };

    // Simulate progress over time
    let stepIdx = 0;
    const interval = setInterval(() => {
      if (stepIdx < steps.length) {
        if (stepIdx > 0) steps[stepIdx - 1].status = "done";
        steps[stepIdx].status = "running";
        if (stepIdx === 0) steps[0].message = "Backup created (42 KB)";
        DEMO_UPDATE_STATUS.steps = steps;
      }
      stepIdx++;
      if (stepIdx > steps.length) {
        clearInterval(interval);
        steps[steps.length - 1].status = "done";
        DEMO_UPDATE_STATUS = {
          ...DEMO_UPDATE_STATUS,
          state: "complete",
          completedAt: new Date().toISOString(),
          steps,
        };
        // Update branding version
        BRANDING.version = DEMO_UPDATE_STATUS.latestVersion;
      }
    }, 1500);

    return json(res, { started: true, message: "Update started" });
  }

  if (path === "/api/v1/server-settings/updates/dismiss" && method === "POST") {
    DEMO_UPDATE_STATUS = { state: "idle" };
    return json(res, { ok: true });
  }

  // Server Settings — Database
  if (path === "/api/v1/server-settings/database" && method === "GET") {
    const totalRows = BLOCKS.length + SUBNETS.length + RESERVATIONS.length + ASSETS.length +
      INTEGRATIONS.length + EVENTS.length + USERS.length + CERTIFICATES.length;
    const tables = [
      { name: "ip_blocks",     rows: BLOCKS.length,       size: _estimateSize(BLOCKS) },
      { name: "subnets",       rows: SUBNETS.length,      size: _estimateSize(SUBNETS) },
      { name: "reservations",  rows: RESERVATIONS.length,  size: _estimateSize(RESERVATIONS) },
      { name: "assets",        rows: ASSETS.length,        size: _estimateSize(ASSETS) },
      { name: "integrations",  rows: INTEGRATIONS.length,  size: _estimateSize(INTEGRATIONS) },
      { name: "events",        rows: EVENTS.length,        size: _estimateSize(EVENTS) },
      { name: "users",         rows: USERS.length,         size: _estimateSize(USERS) },
      { name: "certificates",  rows: CERTIFICATES.length,  size: _estimateSize(CERTIFICATES) },
      { name: "_prisma_migrations", rows: 12,              size: "48 kB" },
    ];
    const totalSize = tables.reduce((sum, t) => sum + _parseSize(t.size), 0);
    return json(res, {
      type: "PostgreSQL",
      version: "15.4",
      host: "localhost",
      port: 5432,
      database: "polaris",
      ssl: "Disabled",
      databaseSize: _formatBytes(totalSize),
      tableCount: tables.length,
      tables: tables.sort((a, b) => b.rows - a.rows),
      activeConnections: 3,
      maxConnections: 100,
      uptime: "14 days, 7 hours",
    });
  }

  // Server Settings — Database Backup
  if (path === "/api/v1/server-settings/database/backup" && method === "POST") {
    const password = body?.password || null;
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `polaris-backup-${APP_VERSION}-${ts}${password ? ".enc" : ""}.gz`;

    // Serialize all in-memory data
    const snapshot = {
      _polaris_backup: true,
      version: "1.0",
      createdAt: now.toISOString(),
      data: {
        blocks: BLOCKS,
        subnets: SUBNETS,
        reservations: RESERVATIONS,
        assets: ASSETS,
        integrations: INTEGRATIONS.map((i) => {
          const c = { ...i.config };
          if (c.apiToken) c.apiToken = "••••••••";
          if (c.password) c.password = "••••••••";
          return { ...i, config: c };
        }),
        events: EVENTS.slice(-5000),
        users: USERS.map((u) => ({ ...u, passwordHash: undefined })),
        tags: TAGS,
        settings: { archive: { ...ARCHIVE_SETTINGS, password: undefined }, syslog: SYSLOG_SETTINGS, ntp: NTP_SETTINGS, branding: BRANDING },
      },
    };

    let payload = Buffer.from(JSON.stringify(snapshot), "utf-8");

    // Compress with gzip
    payload = gzipSync(payload);

    // Encrypt if password provided
    if (password) {
      const salt = randomBytes(32);
      const key = scryptSync(password, salt, 32);
      const iv = randomBytes(16);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
      const authTag = cipher.getAuthTag();
      // Format: POLARIS + salt(32) + iv(16) + authTag(16) + ciphertext
      const magic = Buffer.from("POLARIS\0");
      payload = Buffer.concat([magic, salt, iv, authTag, encrypted]);
    }

    // Record in backup history and store blob for re-download
    const backupId = crypto.randomUUID();
    BACKUP_HISTORY.push({
      id: backupId,
      filename,
      size: _formatBytes(payload.length),
      sizeBytes: payload.length,
      encrypted: !!password,
      createdAt: now.toISOString(),
      tables: Object.keys(snapshot.data).length,
      rows: BLOCKS.length + SUBNETS.length + RESERVATIONS.length + ASSETS.length + INTEGRATIONS.length + EVENTS.length + USERS.length + TAGS.length,
    });
    BACKUP_BLOBS[backupId] = payload;

    // Keep at most 10 blobs in memory
    const blobIds = BACKUP_HISTORY.map((b) => b.id);
    for (const id of Object.keys(BACKUP_BLOBS)) {
      if (!blobIds.includes(id)) delete BACKUP_BLOBS[id];
    }
    if (Object.keys(BACKUP_BLOBS).length > 10) {
      const oldest = blobIds.filter((id) => BACKUP_BLOBS[id]);
      while (oldest.length > 10) delete BACKUP_BLOBS[oldest.shift()];
    }

    logEventDemo({ action: "database.backup.completed", resourceType: "database", message: `Database backup created: ${filename} (${_formatBytes(payload.length)}${password ? ", encrypted" : ""})` });

    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": payload.length,
    });
    res.end(payload);
    return;
  }

  // Server Settings — Database Restore
  if (path === "/api/v1/server-settings/database/restore" && method === "POST") {
    // This is handled in routeMultipart for multipart uploads
    return json(res, { error: "Expected multipart/form-data upload" }, 400);
  }

  // Server Settings — Backup History
  if (path === "/api/v1/server-settings/database/backups" && method === "GET") {
    return json(res, [...BACKUP_HISTORY].reverse().map((b) => ({ ...b, downloadable: !!BACKUP_BLOBS[b.id] })));
  }

  // Server Settings — Download a backup from history
  if (path.match(/^\/api\/v1\/server-settings\/database\/backups\/[\w-]+\/download$/) && method === "GET") {
    const id = path.split("/")[6];
    const record = BACKUP_HISTORY.find((b) => b.id === id);
    if (!record) return json(res, { error: "Backup not found" }, 404);
    const blob = BACKUP_BLOBS[id];
    if (!blob) return json(res, { error: "Backup file is no longer available — it was created in a previous session" }, 410);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${record.filename}"`,
      "Content-Length": blob.length,
    });
    res.end(blob);
    return;
  }

  // Server Settings — Delete a backup
  if (path.match(/^\/api\/v1\/server-settings\/database\/backups\/[\w-]+$/) && method === "DELETE") {
    const id = path.split("/").pop();
    const idx = BACKUP_HISTORY.findIndex((b) => b.id === id);
    if (idx === -1) return json(res, { error: "Backup not found" }, 404);
    BACKUP_HISTORY.splice(idx, 1);
    delete BACKUP_BLOBS[id];
    res.writeHead(204);
    return res.end();
  }

  // Server Settings — Tags
  if (path === "/api/v1/server-settings/tags" && method === "GET") {
    return json(res, [...TAGS].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)));
  }
  if (path === "/api/v1/server-settings/tags" && method === "POST") {
    const name = (body.name || "").trim().toLowerCase().replace(/\s+/g, "-");
    if (!name) return json(res, { error: "Tag name is required" }, 400);
    if (TAGS.find((t) => t.name === name)) return json(res, { error: `Tag "${name}" already exists` }, 409);
    const newTag = {
      id: crypto.randomUUID(),
      name,
      category: body.category || "General",
      color: body.color || randomTagColor(),
      createdAt: new Date().toISOString(),
    };
    TAGS.push(newTag);
    logEventDemo({ action: "tag.created", resourceType: "tag", resourceId: newTag.id, resourceName: name, message: `Tag "${name}" created in category "${newTag.category}"` });
    return json(res, newTag, 201);
  }
  if (path === "/api/v1/server-settings/tags/settings" && method === "GET") {
    return json(res, TAG_SETTINGS);
  }
  if (path === "/api/v1/server-settings/tags/settings" && method === "PUT") {
    TAG_SETTINGS.enforce = body.enforce === true;
    return json(res, TAG_SETTINGS);
  }
  if (path.match(/^\/api\/v1\/server-settings\/tags\/[\w-]+$/) && method === "PUT") {
    const id = path.split("/").pop();
    const tag = TAGS.find((t) => t.id === id);
    if (!tag) return json(res, { error: "Tag not found" }, 404);
    const oldName = tag.name;
    if (body.name !== undefined) {
      const newName = body.name.trim();
      if (newName && newName !== oldName && TAGS.find((t) => t.name === newName)) return json(res, { error: `Tag "${newName}" already exists` }, 409);
      if (newName) {
        tag.name = newName;
        [BLOCKS, SUBNETS, ASSETS].forEach((arr) => arr.forEach((r) => { if (r.tags) r.tags = r.tags.map((t) => t === oldName ? newName : t); }));
      }
    }
    if (body.category !== undefined) tag.category = body.category.trim() || "General";
    if (body.color !== undefined) tag.color = body.color;
    logEventDemo({ action: "tag.updated", resourceType: "tag", resourceId: id, resourceName: tag.name, message: `Tag "${tag.name}" updated` });
    return json(res, { ...tag });
  }
  if (path.match(/^\/api\/v1\/server-settings\/tags\/[\w-]+$/) && method === "DELETE") {
    const id = path.split("/").pop();
    const idx = TAGS.findIndex((t) => t.id === id);
    if (idx === -1) return json(res, { error: "Tag not found" }, 404);
    const removed = TAGS.splice(idx, 1)[0];
    logEventDemo({ action: "tag.deleted", resourceType: "tag", resourceId: id, resourceName: removed.name, message: `Tag "${removed.name}" deleted` });
    res.writeHead(204);
    return res.end();
  }

  // Server Settings — Branding
  if (path === "/api/v1/server-settings/branding" && method === "GET") {
    return json(res, { ...BRANDING, version: APP_VERSION });
  }
  if (path === "/api/v1/server-settings/branding" && method === "PUT") {
    if (body.appName !== undefined) BRANDING.appName = String(body.appName).trim() || "Polaris";
    if (body.subtitle !== undefined) BRANDING.subtitle = String(body.subtitle).trim();
    logEventDemo({ action: "branding.updated", resourceType: "settings", resourceId: "branding", resourceName: "Branding", message: `Branding updated: "${BRANDING.appName}"` });
    return json(res, { ...BRANDING });
  }
  if (path === "/api/v1/server-settings/branding/logo" && method === "DELETE") {
    BRANDING.logoUrl = "/logo.png";
    logEventDemo({ action: "branding.logo.reset", resourceType: "settings", resourceId: "branding", resourceName: "Logo", message: "Logo reset to default" });
    return json(res, { ...BRANDING });
  }

  // Server Settings — Certificates
  if (path === "/api/v1/server-settings/certificates" && method === "GET") {
    const strip = (c) => ({ ...c, pem: undefined });
    return json(res, {
      trustedCAs: CERTIFICATES.filter((c) => c.category === "ca").map(strip),
      serverCerts: CERTIFICATES.filter((c) => c.category === "server").map(strip),
    });
  }
  if (path === "/api/v1/server-settings/certificates/generate" && method === "POST") {
    const cn = body.commonName || "localhost";
    const days = Math.min(3650, Math.max(1, parseInt(body.days, 10) || 365));
    const now = new Date().toISOString();
    const expiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    const tmp = mkdtempSync(join(tmpdir(), "polaris-cert-"));
    const keyPath = join(tmp, "server.key");
    const certPath = join(tmp, "server.crt");
    try {
      const subj = "/CN=" + cn.replace(/['"\\]/g, "");
      const san = "subjectAltName=DNS:" + cn.replace(/['"\\]/g, "");
      execSync(
        'openssl req -x509 -newkey rsa:2048 -keyout "' + keyPath + '" -out "' + certPath +
        '" -days ' + days + ' -nodes -subj "' + subj + '" -addext "' + san + '"',
        { stdio: "pipe" },
      );
      const certPem = readFileSync(certPath, "utf-8");
      const keyPem = readFileSync(keyPath, "utf-8");

      const certRecord = {
        id: crypto.randomUUID(), category: "server", type: "cert",
        name: cn + ".crt", subject: "CN=" + cn, issuer: "CN=" + cn,
        expiresAt: expiry, uploadedAt: now, pem: certPem,
      };
      const keyRecord = {
        id: crypto.randomUUID(), category: "server", type: "key",
        name: cn + ".key", subject: "Private Key", issuer: null,
        expiresAt: null, uploadedAt: now, pem: keyPem,
      };
      CERTIFICATES.push(certRecord, keyRecord);
      return json(res, {
        cert: { ...certRecord, pem: undefined },
        key: { ...keyRecord, pem: undefined },
      }, 201);
    } catch (err) {
      return json(res, { error: "Failed to generate certificate: " + (err.message || err) }, 500);
    } finally {
      try { unlinkSync(keyPath); } catch (_) {}
      try { unlinkSync(certPath); } catch (_) {}
      try { unlinkSync(tmp); } catch (_) {}
    }
  }
  if (path.match(/^\/api\/v1\/server-settings\/certificates\/[\w-]+$/) && method === "DELETE") {
    const id = path.split("/").pop();
    CERTIFICATES = CERTIFICATES.filter((c) => c.id !== id);
    // If the deleted cert was selected for HTTPS, clear the reference
    if (HTTPS_SETTINGS.certId === id) HTTPS_SETTINGS.certId = null;
    if (HTTPS_SETTINGS.keyId === id) HTTPS_SETTINGS.keyId = null;
    res.writeHead(204);
    return res.end();
  }

  // Server Settings — HTTPS
  if (path === "/api/v1/server-settings/https" && method === "GET") {
    return json(res, { ...HTTPS_SETTINGS, running: !!(_httpsServer && _httpsServer.listening) });
  }
  if (path === "/api/v1/server-settings/https" && method === "PUT") {
    HTTPS_SETTINGS = { ...HTTPS_SETTINGS, ...body };
    return json(res, { ...HTTPS_SETTINGS, running: !!(_httpsServer && _httpsServer.listening) });
  }
  if (path === "/api/v1/server-settings/https/apply" && method === "POST") {
    // Stop any existing HTTPS server first
    await stopDemoHttps();

    if (!HTTPS_SETTINGS.enabled) {
      const result = { ok: true, message: "HTTPS disabled", running: false };
      // Defer HTTP restart until after response is sent
      const wantHttpPort = HTTPS_SETTINGS.httpPort || PORT;
      if (wantHttpPort !== _httpPort) {
        json(res, result);
        setTimeout(() => restartDemoHttp(wantHttpPort), 200);
        return;
      }
      return json(res, result);
    }
    if (!HTTPS_SETTINGS.certId || !HTTPS_SETTINGS.keyId) {
      return json(res, { ok: false, message: "HTTPS enabled but certificate or key is missing", running: false });
    }
    const cert = CERTIFICATES.find((c) => c.id === HTTPS_SETTINGS.certId);
    const key = CERTIFICATES.find((c) => c.id === HTTPS_SETTINGS.keyId);
    if (!cert || !key) {
      return json(res, { ok: false, message: "Selected certificate or key not found", running: false });
    }
    try {
      const result = await startDemoHttps(cert.pem, key.pem, HTTPS_SETTINGS.port);
      // Defer HTTP restart until after response is sent
      const wantHttpPort = HTTPS_SETTINGS.httpPort || PORT;
      if (wantHttpPort !== _httpPort) {
        json(res, result);
        setTimeout(() => restartDemoHttp(wantHttpPort), 200);
        return;
      }
      return json(res, result);
    } catch (err) {
      return json(res, { ok: false, message: err.message || "Failed to start HTTPS", running: false });
    }
  }

  // Events
  if (path === "/api/v1/events" && method === "GET") {
    const limit = Math.min(parseInt(params.get("limit")) || 50, 200);
    const offset = parseInt(params.get("offset")) || 0;
    const level = params.get("level");
    const action = params.get("action");
    const resourceType = params.get("resourceType");
    const actor = params.get("actor");

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let filtered = EVENTS.filter((e) => e.timestamp >= cutoff);
    if (level) filtered = filtered.filter((e) => e.level === level);
    if (action) filtered = filtered.filter((e) => e.action && e.action.includes(action));
    if (resourceType) filtered = filtered.filter((e) => e.resourceType === resourceType);
    if (actor) filtered = filtered.filter((e) => e.actor && e.actor.toLowerCase().includes(actor.toLowerCase()));

    // Sort newest first
    filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const total = filtered.length;
    const events = filtered.slice(offset, offset + limit);

    return json(res, { events, total, limit, offset });
  }

  json(res, { error: "Not found" }, 404);
}

// ─── Demo HTTPS Server ──────────────────────────────────────────────────────

function handleDemoRequest(req, res) {
  const url = new URL(req.url, `https://localhost:${HTTPS_SETTINGS.port}`);
  const path = url.pathname;
  const method = req.method;

  if (path.startsWith("/api/v1/")) {
    const ct = req.headers["content-type"] || "";
    if (ct.includes("multipart/form-data")) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const buf = Buffer.concat(chunks).toString("binary");
          routeMultipart(method, path, buf, ct, res);
        } catch (err) {
          json(res, { error: err.message }, 400);
        }
      });
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        routeAPI(method, path, url.searchParams, parsed, res, req).catch((err) => {
          json(res, { error: err.message }, 500);
        });
      } catch (err) {
        json(res, { error: err.message }, 400);
      }
    });
    return;
  }
  serveStatic(res, path);
}

function startDemoHttps(certPem, keyPem, port) {
  return new Promise((resolve, reject) => {
    try {
      _httpsServer = createHttpsServer({ cert: certPem, key: keyPem }, handleDemoRequest);

      _httpsServer.on("error", (err) => {
        _httpsServer = null;
        if (err.code === "EADDRINUSE") {
          resolve({ ok: false, message: "Port " + port + " is already in use", running: false });
        } else {
          resolve({ ok: false, message: err.message || "HTTPS server error", running: false });
        }
      });

      _httpsServer.listen(port, () => {
        console.log("  \x1b[32m✓\x1b[0m HTTPS server listening on \x1b[36mhttps://localhost:" + port + "\x1b[0m");
        resolve({ ok: true, message: "HTTPS server listening on port " + port, running: true });
      });
    } catch (err) {
      _httpsServer = null;
      resolve({ ok: false, message: err.message || "Failed to create HTTPS server", running: false });
    }
  });
}

function stopDemoHttps() {
  return new Promise((resolve) => {
    if (!_httpsServer) return resolve();
    _httpsServer.close(() => {
      console.log("  \x1b[33m⏹\x1b[0m HTTPS server stopped");
      _httpsServer = null;
      resolve();
    });
    setTimeout(() => {
      if (_httpsServer) _httpsServer.closeAllConnections?.();
    }, 1000);
  });
}

function routeMultipart(method, path, rawBody, contentType, res) {
  // Logo upload
  if (path === "/api/v1/server-settings/branding/logo" && method === "POST") {
    const { file } = parseMultipart(rawBody, contentType);
    if (!file) return json(res, { error: "No file uploaded" }, 400);
    const mime = file.contentType || "image/png";
    const b64 = Buffer.from(file.data, "binary").toString("base64");
    BRANDING.logoUrl = "data:" + mime + ";base64," + b64;
    logEventDemo({ action: "branding.logo.uploaded", resourceType: "settings", resourceId: "branding", resourceName: "Logo", message: "Custom logo uploaded" });
    return json(res, { ...BRANDING });
  }
  // Database restore
  if (path === "/api/v1/server-settings/database/restore" && method === "POST") {
    const { fields, file } = parseMultipart(rawBody, contentType);
    if (!file) return json(res, { error: "No backup file uploaded" }, 400);
    const password = fields.password || null;

    try {
      let payload = Buffer.from(file.content, "binary");

      // Check if encrypted (starts with POLARIS magic)
      const magic = Buffer.from("POLARIS\0");
      const isEncrypted = payload.length > 72 && payload.subarray(0, 8).equals(magic);

      if (isEncrypted) {
        if (!password) return json(res, { error: "This backup is encrypted — a password is required to restore it" }, 400);
        const salt = payload.subarray(8, 40);
        const iv = payload.subarray(40, 56);
        const authTag = payload.subarray(56, 72);
        const ciphertext = payload.subarray(72);
        const key = scryptSync(password, salt, 32);
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(authTag);
        try {
          payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        } catch {
          return json(res, { error: "Decryption failed — incorrect password or corrupted file" }, 400);
        }
      }

      // Decompress gzip
      try {
        payload = gunzipSync(payload);
      } catch {
        return json(res, { error: "Decompression failed — file is not a valid gzip archive" }, 400);
      }

      // Parse JSON
      let snapshot;
      try {
        snapshot = JSON.parse(payload.toString("utf-8"));
      } catch {
        return json(res, { error: "Invalid backup file — could not parse JSON data" }, 400);
      }

      if (!snapshot._polaris_backup) {
        return json(res, { error: "Invalid backup file — not a Polaris backup" }, 400);
      }

      const d = snapshot.data;
      if (!d) return json(res, { error: "Invalid backup file — no data section" }, 400);

      // Restore each data set
      const restored = [];
      if (Array.isArray(d.blocks))       { BLOCKS.length = 0; BLOCKS.push(...d.blocks); restored.push("blocks: " + d.blocks.length); }
      if (Array.isArray(d.subnets))      { SUBNETS.length = 0; SUBNETS.push(...d.subnets); restored.push("subnets: " + d.subnets.length); }
      if (Array.isArray(d.reservations)) { RESERVATIONS.length = 0; RESERVATIONS.push(...d.reservations); restored.push("reservations: " + d.reservations.length); }
      if (Array.isArray(d.assets))       { ASSETS.length = 0; ASSETS.push(...d.assets); restored.push("assets: " + d.assets.length); }
      if (Array.isArray(d.events))       { EVENTS.length = 0; EVENTS.push(...d.events); restored.push("events: " + d.events.length); }
      if (Array.isArray(d.tags))         { TAGS.length = 0; TAGS.push(...d.tags); restored.push("tags: " + d.tags.length); }

      logEventDemo({ action: "database.restore.completed", resourceType: "database", message: `Database restored from backup (${file.originalname}) — ${restored.join(", ")}` });
      return json(res, { ok: true, message: "Database restored successfully", restored, backupDate: snapshot.createdAt });
    } catch (err) {
      return json(res, { error: "Restore failed: " + (err.message || "Unknown error") }, 500);
    }
  }

  // Certificate upload
  if (path === "/api/v1/server-settings/certificates" && method === "POST") {
    const { fields, file } = parseMultipart(rawBody, contentType);
    if (!file) {
      return json(res, { error: "No file uploaded" }, 400);
    }
    const category = fields.category === "server" ? "server" : "ca";
    const pem = file.content;
    const isKey = file.originalname.endsWith(".key") || pem.includes("PRIVATE KEY");
    const record = {
      id: crypto.randomUUID(),
      category,
      type: isKey ? "key" : "cert",
      name: file.originalname,
      subject: extractSubjectDemo(pem),
      issuer: null,
      expiresAt: null,
      uploadedAt: new Date().toISOString(),
      pem,
    };
    CERTIFICATES.push(record);
    return json(res, { ...record, pem: undefined }, 201);
  }
  return json(res, { error: "Not found" }, 404);
}

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log("");
  console.log("  \x1b[32m✓\x1b[0m Polaris demo server running");
  console.log("");
  console.log("    \x1b[36mhttp://localhost:" + PORT + "\x1b[0m");
  console.log("");
  console.log("  No database required — all data is mocked.");
  console.log("  Login accepts any credentials.");
  console.log("");
});
