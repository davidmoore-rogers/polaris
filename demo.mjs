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

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = 3000;
const PUBLIC = join(__dirname, "public");

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
  { id: "u1", username: "admin", role: "admin", createdAt: "2025-11-15T08:00:00.000Z", updatedAt: "2025-11-15T08:00:00.000Z", lastLogin: "2026-04-17T07:30:00.000Z" },
  { id: "u2", username: "jsmith", role: "networkadmin", createdAt: "2026-01-10T09:00:00.000Z", updatedAt: "2026-01-10T09:00:00.000Z", lastLogin: "2026-04-16T12:00:00.000Z" },
  { id: "u3", username: "kbrown", role: "assetsadmin", createdAt: "2026-02-20T14:00:00.000Z", updatedAt: "2026-02-20T14:00:00.000Z", lastLogin: null },
  { id: "u4", username: "dmoore", role: "admin", createdAt: "2026-03-01T08:00:00.000Z", updatedAt: "2026-03-01T08:00:00.000Z", lastLogin: "2026-04-17T08:15:00.000Z" },
  { id: "u5", username: "rjones", role: "readonly", createdAt: "2026-04-10T10:00:00.000Z", updatedAt: "2026-04-10T10:00:00.000Z", lastLogin: "2026-04-16T09:00:00.000Z" },
  { id: "u6", username: "mwilson", role: "user", createdAt: "2026-04-12T09:00:00.000Z", updatedAt: "2026-04-12T09:00:00.000Z", lastLogin: "2026-04-17T08:00:00.000Z" },
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
    },
    enabled: true,
    pollInterval: 4,
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
    },
    enabled: false,
    pollInterval: 12,
    lastTestAt: "2026-02-28T11:00:00.000Z",
    lastTestOk: false,
    createdAt: "2026-02-01T10:00:00.000Z",
    updatedAt: "2026-02-28T11:00:00.000Z",
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

// ─── Archive Settings ──────────────────────────────────────────────────────

let ARCHIVE_SETTINGS = {
  enabled: false,
  protocol: "scp",
  host: "",
  port: 22,
  username: "",
  password: "",
  keyPath: "",
  remotePath: "/var/archive/shelob",
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

let HTTPS_SETTINGS = {
  enabled: false,
  port: 3443,
  httpPort: 3000,
  certId: null,
  keyId: null,
  redirectHttp: false,
};

let BRANDING = {
  appName: "Shelob",
  subtitle: "Network Management Tool",
  logoUrl: "/logo.webp",
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
    const avail = subs.filter((s) => s.status === "available").length;
    const res = subs.filter((s) => s.status === "reserved").length;
    const dep = subs.filter((s) => s.status === "deprecated").length;
    return {
      blockId: b.id, name: b.name, cidr: b.cidr,
      totalSubnets: subs.length,
      availableSubnets: avail, reservedSubnets: res, deprecatedSubnets: dep,
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

  // Build device list
  const devices = MOCK_DEVICES.map((d) => ({ ...d }));
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
  if (path !== "/login.html" && (path === "/" || path.endsWith(".html"))) {
    const cookies = (req.headers.cookie || "").split(";").reduce((m, c) => {
      const [k, v] = c.trim().split("=");
      if (k) m[k] = v;
      return m;
    }, {});
    if (!cookies["shelob-session"] || !USERS.find((u) => u.username === decodeURIComponent(cookies["shelob-session"]))) {
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
  const sessionUser = cookies["shelob-session"] ? USERS.find((u) => u.username === cookies["shelob-session"]) : null;
  const isLoggedIn = !!sessionUser;

  if (path === "/api/v1/auth/login" && method === "POST") {
    const loginUser = USERS.find((u) => u.username === (body.username || "admin")) || USERS[0];
    loginUser.lastLogin = new Date().toISOString();
    res.setHeader("Set-Cookie", "shelob-session=" + encodeURIComponent(loginUser.username) + "; Path=/; HttpOnly; SameSite=Lax");
    return json(res, { ok: true, username: loginUser.username, role: loginUser.role });
  }
  if (path === "/api/v1/auth/logout" && method === "POST") {
    res.setHeader("Set-Cookie", "shelob-session=; Path=/; HttpOnly; Max-Age=0");
    return json(res, { ok: true });
  }
  if (path === "/api/v1/auth/me") {
    if (!isLoggedIn) return json(res, { authenticated: false }, 401);
    return json(res, { authenticated: true, username: sessionUser.username, role: sessionUser.role });
  }
  // Branding endpoint is public (login page needs it)
  if (path.startsWith("/api/v1/server-settings/branding")) {
    // fall through — handled below
  } else if (!isLoggedIn) {
    return json(res, { error: "Unauthorized" }, 401);
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
    return json(res, result);
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
    return json(res, result);
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
    return json(res, { id: crypto.randomUUID(), ...body, createdAt: new Date().toISOString() }, 201);
  }
  if (path.match(/\/password$/) && method === "PUT") {
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
    return json(res, result);
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
  if (path.match(/^\/api\/v1\/assets\/[\w-]+$/) && method === "DELETE") {
    const id = path.split("/").pop();
    const asset = ASSETS.find((a) => a.id === id);
    logEventDemo({ action: "asset.deleted", resourceType: "asset", resourceId: id, resourceName: asset?.hostname || asset?.ipAddress, message: `Asset "${asset?.hostname || asset?.ipAddress || "unknown"}" deleted` });
    res.writeHead(204);
    return res.end();
  }

  // Integrations
  if (path === "/api/v1/integrations" && method === "GET") {
    // Strip secrets from list response
    return json(res, INTEGRATIONS.map((i) => {
      const c = { ...i.config };
      if (c.apiToken) c.apiToken = "••••••••";
      if (c.password) c.password = "••••••••";
      return { ...i, config: c };
    }));
  }
  if (path === "/api/v1/integrations/test" && method === "POST") {
    const delay = 800 + Math.random() * 400;
    const isWin = body.type === "windowsserver";
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
    if (!intg.config?.host) return json(res, { error: "Integration has no host configured" }, 400);
    logEventDemo({ action: "integration.discover.started", resourceType: "integration", resourceId: id, resourceName: intg.name, message: `Manual DHCP discovery started for "${intg.name}"` });
    const progressLog = (step, level, message) => {
      logEventDemo({ action: "integration." + step, resourceType: "integration", resourceId: id, resourceName: intg.name, level, message: "[" + intg.name + "] " + message });
    };
    const syncLog = (level, message) => {
      logEventDemo({ action: "integration.sync", resourceType: "integration", resourceId: id, resourceName: intg.name, level, message: "[" + intg.name + "] " + message });
    };
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
    return json(res, { ...intg, config: c });
  }
  if (path === "/api/v1/integrations" && method === "POST") {
    const now = new Date().toISOString();
    const intgType = body.type || "fortimanager";
    const isWin = intgType === "windowsserver";
    const safeConfig = { ...body.config };
    if (safeConfig.apiToken) safeConfig.apiToken = "••••••••";
    if (safeConfig.password) safeConfig.password = "••••••••";
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
    const safeConfig = { ...mergedConfig };
    if (safeConfig.apiToken) safeConfig.apiToken = "••••••••";
    if (safeConfig.password) safeConfig.password = "••••••••";
    const updated = {
      ...intg,
      ...body,
      config: safeConfig,
      pollInterval: body.pollInterval !== undefined
        ? Math.min(24, Math.max(1, parseInt(body.pollInterval, 10) || 4))
        : intg.pollInterval,
      updatedAt: new Date().toISOString(),
    };
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
      database: "shelob",
      ssl: "Disabled",
      databaseSize: _formatBytes(totalSize),
      tableCount: tables.length,
      tables: tables.sort((a, b) => b.rows - a.rows),
      activeConnections: 3,
      maxConnections: 100,
      uptime: "14 days, 7 hours",
    });
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
      color: body.color || "#4fc3f7",
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
    return json(res, { ...BRANDING });
  }
  if (path === "/api/v1/server-settings/branding" && method === "PUT") {
    if (body.appName !== undefined) BRANDING.appName = String(body.appName).trim() || "Shelob";
    if (body.subtitle !== undefined) BRANDING.subtitle = String(body.subtitle).trim();
    logEventDemo({ action: "branding.updated", resourceType: "settings", resourceId: "branding", resourceName: "Branding", message: `Branding updated: "${BRANDING.appName}"` });
    return json(res, { ...BRANDING });
  }
  if (path === "/api/v1/server-settings/branding/logo" && method === "DELETE") {
    BRANDING.logoUrl = "/logo.webp";
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

    const tmp = mkdtempSync(join(tmpdir(), "shelob-cert-"));
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
  console.log("  \x1b[32m✓\x1b[0m Shelob demo server running");
  console.log("");
  console.log("    \x1b[36mhttp://localhost:" + PORT + "\x1b[0m");
  console.log("");
  console.log("  No database required — all data is mocked.");
  console.log("  Login accepts any credentials.");
  console.log("");
});
