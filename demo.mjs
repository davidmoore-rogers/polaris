/**
 * demo.mjs — Standalone demo server with mock data (no PostgreSQL required)
 *
 * Run:  node demo.mjs
 * Then: http://localhost:3000
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
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
    createdAt: "2026-02-05T09:30:00.000Z",
    updatedAt: "2026-02-05T09:30:00.000Z",
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
    notes: "Primary worker node",
    status: "active",
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
    notes: "Secondary worker node",
    status: "active",
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
    notes: "Temporary burst node for Q2 load testing",
    status: "active",
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
    notes: "Primary PostgreSQL instance",
    status: "active",
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
    notes: "Grafana + Prometheus",
    status: "active",
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
    createdAt: "2026-03-05T11:00:00.000Z",
    updatedAt: "2026-03-05T11:00:00.000Z",
  },
];

const USERS = [
  { id: "u1", username: "admin", role: "admin", createdAt: "2025-11-15T08:00:00.000Z", updatedAt: "2025-11-15T08:00:00.000Z" },
  { id: "u2", username: "jsmith", role: "user", createdAt: "2026-01-10T09:00:00.000Z", updatedAt: "2026-01-10T09:00:00.000Z" },
  { id: "u3", username: "kbrown", role: "user", createdAt: "2026-02-20T14:00:00.000Z", updatedAt: "2026-02-20T14:00:00.000Z" },
  { id: "u4", username: "dmoore", role: "admin", createdAt: "2026-03-01T08:00:00.000Z", updatedAt: "2026-03-01T08:00:00.000Z" },
];

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
};

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

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  // ── API routes ──
  if (path.startsWith("/api/v1/")) {
    // Collect body for POST/PUT
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        routeAPI(method, path, url.searchParams, body ? JSON.parse(body) : {}, res);
      } catch (err) {
        json(res, { error: err.message }, 400);
      }
    });
    return;
  }

  // ── Static files ──
  serveStatic(res, path);
});

function routeAPI(method, path, params, body, res) {
  // Auth
  if (path === "/api/v1/auth/login" && method === "POST") {
    return json(res, { ok: true, username: "admin", role: "admin" });
  }
  if (path === "/api/v1/auth/logout" && method === "POST") {
    return json(res, { ok: true });
  }
  if (path === "/api/v1/auth/me") {
    return json(res, { authenticated: true, username: "admin", role: "admin" });
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
    return json(res, { id: crypto.randomUUID(), ...body, ipVersion: "v4", _count: { subnets: 0 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 201);
  }
  if (path.match(/^\/api\/v1\/blocks\/[\w-]+$/) && method === "PUT") {
    return json(res, { ...body, updatedAt: new Date().toISOString() });
  }
  if (path.match(/^\/api\/v1\/blocks\/[\w-]+$/) && method === "DELETE") {
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
  if (path.match(/^\/api\/v1\/subnets\/[\w-]+$/) && method === "GET") {
    const id = path.split("/").pop();
    const subnet = SUBNETS.find((s) => s.id === id);
    return subnet ? json(res, subnet) : json(res, { error: "Not found" }, 404);
  }
  if (path === "/api/v1/subnets" && method === "POST") {
    return json(res, { id: crypto.randomUUID(), ...body, status: "available", _count: { reservations: 0 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 201);
  }
  if (path === "/api/v1/subnets/next-available" && method === "POST") {
    return json(res, { id: crypto.randomUUID(), cidr: "10.0.99.0/24", ...body, status: "available", _count: { reservations: 0 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 201);
  }
  if (path.match(/^\/api\/v1\/subnets\/[\w-]+$/) && method === "PUT") {
    return json(res, { ...body, updatedAt: new Date().toISOString() });
  }
  if (path.match(/^\/api\/v1\/subnets\/[\w-]+$/) && method === "DELETE") {
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
    return json(res, { id: crypto.randomUUID(), ...body, status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 201);
  }
  if (path.match(/^\/api\/v1\/reservations\/[\w-]+$/) && method === "PUT") {
    return json(res, { ...body, updatedAt: new Date().toISOString() });
  }
  if (path.match(/^\/api\/v1\/reservations\/[\w-]+$/) && method === "DELETE") {
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

  json(res, { error: "Not found" }, 404);
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
