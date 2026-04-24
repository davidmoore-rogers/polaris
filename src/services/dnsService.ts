/**
 * src/services/dnsService.ts — DNS resolver configuration
 *
 * Supports three modes:
 *   - standard: plain DNS (UDP/TCP) via Node's built-in dns.Resolver
 *   - dot:      DNS over TLS (RFC 7858) on port 853
 *   - doh:      DNS over HTTPS (RFC 8484) using the JSON API
 *
 * Uses an isolated resolver so custom servers don't affect the rest of
 * the process's DNS resolution.
 *
 * All resolvers return PtrRecord[] so callers can cache results with TTL.
 * Standard mode cannot retrieve TTL from Node's built-in API and returns
 * ttl: null — callers should apply a sensible default (e.g. 3600s).
 */

import dns from "node:dns/promises";
import https from "node:https";
import tls from "node:tls";
import { prisma } from "../db.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface DnsSettings {
  servers: string[];
  mode: "standard" | "dot" | "doh";
  dohUrl: string;
}

/** A single PTR answer. ttl is null when the resolver cannot retrieve it (standard mode). */
export interface PtrRecord {
  name: string;
  ttl: number | null;
}

export interface ResolverLike {
  reverse(ip: string): Promise<PtrRecord[]>;
}

// ─── Settings CRUD ─────────────────────────────────────────────────────────

export async function getDnsSettings(): Promise<DnsSettings> {
  const row = await prisma.setting.findUnique({ where: { key: "dnsSettings" } });
  if (!row?.value) return { servers: [], mode: "standard", dohUrl: "" };
  const val = row.value as any;
  return {
    servers: val.servers || [],
    mode: val.mode || "standard",
    dohUrl: val.dohUrl || "",
  };
}

export async function updateDnsSettings(settings: Partial<DnsSettings>): Promise<DnsSettings> {
  const current = await getDnsSettings();
  const value: DnsSettings = {
    servers: (settings.servers ?? current.servers).filter(Boolean),
    mode: settings.mode ?? current.mode,
    dohUrl: settings.dohUrl ?? current.dohUrl,
  };
  await prisma.setting.upsert({
    where: { key: "dnsSettings" },
    update: { value: value as any },
    create: { key: "dnsSettings", value: value as any },
  });
  return value;
}

// ─── Resolver Factory ──────────────────────────────────────────────────────

/**
 * Resolve any hostnames in a server list to IP addresses so they can be
 * passed to dns.Resolver.setServers() (which only accepts IPs).
 * Entries that are already IPs pass through unchanged.
 */
async function resolveServerNames(servers: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const s of servers) {
    // Strip optional :port suffix for the hostname check
    const portMatch = s.match(/^(.+):(\d+)$/);
    const host = portMatch ? portMatch[1] : s;
    const port = portMatch ? portMatch[2] : null;

    // If it looks like an IP (v4 or v6) pass through as-is
    if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) {
      resolved.push(s);
      continue;
    }

    // It's a hostname — resolve to IP via system DNS
    try {
      const { address } = await dns.lookup(host);
      resolved.push(port ? `${address}:${port}` : address);
    } catch {
      // If resolution fails, skip this entry rather than breaking all lookups
    }
  }
  return resolved;
}

/**
 * Build a resolver from explicit settings (used by the test endpoint).
 */
export async function createResolver(settings: DnsSettings): Promise<ResolverLike> {
  if (settings.mode === "doh" && settings.dohUrl) {
    return { reverse: (ip: string) => dohReverse(ip, settings.dohUrl) };
  }
  if (settings.mode === "dot" && settings.servers.length > 0) {
    // DoT: tls.connect() resolves hostnames natively — pass through as-is
    return { reverse: (ip: string) => dotReverse(ip, settings.servers) };
  }
  // Standard mode — setServers() requires IPs, so resolve any hostnames first.
  // Node's dns.Resolver.reverse() does not expose TTL, so we wrap it and return ttl: null.
  const resolver = new dns.Resolver();
  if (settings.servers.length > 0) {
    const ips = await resolveServerNames(settings.servers);
    if (ips.length > 0) resolver.setServers(ips);
  }
  return {
    reverse: async (ip: string): Promise<PtrRecord[]> => {
      const names = await resolver.reverse(ip);
      return names.map((name) => ({ name, ttl: null }));
    },
  };
}

/**
 * Build a resolver from the saved database settings.
 */
export async function getConfiguredResolver(): Promise<ResolverLike> {
  return createResolver(await getDnsSettings());
}

// ─── IP → PTR Name ─────────────────────────────────────────────────────────

function ipToPtrName(ip: string): string {
  if (ip.includes(":")) {
    // IPv6: expand, strip colons, reverse nibbles
    const full = expandIpv6(ip);
    const hex = full.replace(/:/g, "");
    return hex.split("").reverse().join(".") + ".ip6.arpa";
  }
  return ip.split(".").reverse().join(".") + ".in-addr.arpa";
}

function expandIpv6(ip: string): string {
  const halves = ip.split("::");
  let groups: string[];
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    groups = [...left, ...Array(missing).fill("0000"), ...right];
  } else {
    groups = ip.split(":");
  }
  return groups.map((g) => g.padStart(4, "0")).join(":");
}

// ─── DNS over HTTPS (DoH) ──────────────────────────────────────────────────
//
// Uses the JSON API supported by Google, Cloudflare, Quad9, and others.
// The user supplies a base URL (e.g. https://dns.google/resolve) and we
// append ?name=<ptr>&type=PTR with Accept: application/dns-json.
// ────────────────────────────────────────────────────────────────────────────

async function dohReverse(ip: string, dohUrl: string): Promise<PtrRecord[]> {
  const ptrName = ipToPtrName(ip);
  const sep = dohUrl.includes("?") ? "&" : "?";
  const url = `${dohUrl}${sep}ct=application/dns-json&name=${encodeURIComponent(ptrName)}&type=PTR`;

  const body = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(Object.assign(new Error("DoH request timed out (5s)"), { code: "DOH_TIMEOUT" }));
    }, 5000);

    const req = https.get(url, { headers: { Accept: "application/dns-json" }, rejectUnauthorized: false }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        clearTimeout(timer);
        res.resume();
        reject(Object.assign(new Error(`DoH query failed (HTTP ${res.statusCode})`), { code: "DOH_HTTP_ERROR" }));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf-8")); });
    });

    req.on("error", (err: any) => {
      clearTimeout(timer);
      const detail = err.code === "ENOTFOUND" ? "Cannot resolve hostname in DoH URL"
        : err.code === "ECONNREFUSED" ? "Connection refused by DoH server"
        : err.message || String(err);
      reject(Object.assign(new Error(detail), { code: "DOH_CONNECT_ERROR" }));
    });
  });

  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    throw Object.assign(new Error("DoH server did not return JSON — check the URL uses the JSON API endpoint"), { code: "DOH_PARSE_ERROR" });
  }
  if (!data.Answer || !Array.isArray(data.Answer)) return [];
  return data.Answer
    .filter((a: any) => a.type === 12)
    .map((a: any) => ({
      name: (a.data || "").replace(/\.$/, ""),
      ttl: typeof a.TTL === "number" ? a.TTL : null,
    }));
}

// ─── DNS over TLS (DoT) ────────────────────────────────────────────────────
//
// Connects to each configured server on port 853 (or custom port) using TLS,
// sends a standard DNS query in TCP wire format, and parses the response.
// Falls through to the next server on failure.
// ────────────────────────────────────────────────────────────────────────────

async function dotReverse(ip: string, servers: string[]): Promise<PtrRecord[]> {
  const ptrName = ipToPtrName(ip);
  const query = buildDnsQuery(ptrName, 12); // QTYPE 12 = PTR

  let lastErr: Error | null = null;
  for (const server of servers) {
    try {
      const { host, port } = parseDotServer(server);
      const response = await sendTlsQuery(host, port, query);
      return parseDnsResponse(response);
    } catch (err: any) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("No DoT servers available");
}

function parseDotServer(server: string): { host: string; port: number } {
  // Handle [ipv6]:port, ipv4:port, or bare host
  if (server.startsWith("[")) {
    const close = server.indexOf("]");
    const host = server.slice(1, close);
    const rest = server.slice(close + 1);
    const port = rest.startsWith(":") ? parseInt(rest.slice(1), 10) : 853;
    return { host, port };
  }
  const parts = server.split(":");
  if (parts.length === 2 && !server.includes("::")) {
    return { host: parts[0], port: parseInt(parts[1], 10) || 853 };
  }
  return { host: server, port: 853 };
}

// ─── DNS Wire Format ────────────────────────────────────────────────────────

function buildDnsQuery(name: string, qtype: number): Buffer {
  const id = Math.floor(Math.random() * 0xffff);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);      // ID
  header.writeUInt16BE(0x0100, 2);  // Flags: RD (recursion desired)
  header.writeUInt16BE(1, 4);       // QDCOUNT = 1

  const qname = encodeDnsName(name);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtype, 0);     // QTYPE
  tail.writeUInt16BE(1, 2);         // QCLASS = IN

  return Buffer.concat([header, qname, tail]);
}

function encodeDnsName(name: string): Buffer {
  const labels = name.split(".");
  const parts: Buffer[] = [];
  for (const label of labels) {
    if (label.length === 0) continue;
    parts.push(Buffer.from([label.length]));
    parts.push(Buffer.from(label, "ascii"));
  }
  parts.push(Buffer.from([0])); // root label
  return Buffer.concat(parts);
}

function sendTlsQuery(host: string, port: number, query: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lenPrefix = Buffer.alloc(2);
    lenPrefix.writeUInt16BE(query.length, 0);

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("DoT query timed out (5s)"));
    }, 5000);

    const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      socket.write(Buffer.concat([lenPrefix, query]));
    });

    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      // TCP DNS: first 2 bytes are the message length
      if (buf.length >= 2) {
        const msgLen = buf.readUInt16BE(0);
        if (buf.length >= 2 + msgLen) {
          clearTimeout(timeout);
          socket.destroy();
          resolve(buf.subarray(2, 2 + msgLen));
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    socket.on("close", () => {
      clearTimeout(timeout);
      const buf = Buffer.concat(chunks);
      if (buf.length >= 2) {
        const msgLen = buf.readUInt16BE(0);
        if (buf.length >= 2 + msgLen) {
          resolve(buf.subarray(2, 2 + msgLen));
          return;
        }
      }
      reject(new Error("DoT connection closed before complete response"));
    });
  });
}

// ─── DNS Response Parser ────────────────────────────────────────────────────

function parseDnsResponse(buf: Buffer): PtrRecord[] {
  if (buf.length < 12) return [];

  const ancount = buf.readUInt16BE(6);
  if (ancount === 0) return [];

  // Skip header (12 bytes) and question section
  let offset = 12;
  const qdcount = buf.readUInt16BE(4);
  for (let i = 0; i < qdcount; i++) {
    offset = skipDnsName(buf, offset);
    offset += 4; // QTYPE + QCLASS
  }

  // Parse answer records
  // RR layout after name: TYPE(2) CLASS(2) TTL(4) RDLENGTH(2) RDATA(rdlength)
  const results: PtrRecord[] = [];
  for (let i = 0; i < ancount; i++) {
    if (offset >= buf.length) break;
    offset = skipDnsName(buf, offset);
    if (offset + 10 > buf.length) break;
    const rtype = buf.readUInt16BE(offset);
    const ttl = buf.readUInt32BE(offset + 4);
    const rdlength = buf.readUInt16BE(offset + 8);
    offset += 10;

    if (rtype === 12) { // PTR record
      const name = readDnsName(buf, offset);
      if (name) results.push({ name, ttl });
    }
    offset += rdlength;
  }
  return results;
}

function skipDnsName(buf: Buffer, offset: number): number {
  while (offset < buf.length) {
    const len = buf[offset];
    if (len === 0) return offset + 1;
    if ((len & 0xc0) === 0xc0) return offset + 2; // compression pointer
    offset += 1 + len;
  }
  return offset;
}

function readDnsName(buf: Buffer, offset: number): string {
  const labels: string[] = [];
  const seen = new Set<number>(); // prevent infinite loops
  let pos = offset;
  while (pos < buf.length) {
    if (seen.has(pos)) break;
    seen.add(pos);
    const len = buf[pos];
    if (len === 0) break;
    if ((len & 0xc0) === 0xc0) {
      // Compression pointer — follow it
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString("ascii"));
    pos += 1 + len;
  }
  return labels.join(".");
}
