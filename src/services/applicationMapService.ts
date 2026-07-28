/**
 * src/services/applicationMapService.ts — the Application Map graph builder,
 * per-asset connection reads, and the shared page layout.
 *
 * Data source: AssetProcessConnection (accumulate+age socket facts collected
 * per-minute for MAPPED processes — Asset.mappedProcesses — AND for the units
 * an operator maps from the Services tab — Asset.mappedServices, matched on the
 * row's owning `unit`). The graph:
 *
 *   nodes — one compound-parent node per asset with mapped processes/services,
 *     one child node per mapped process AND per mapped service unit (both
 *     render even with zero connections — they come from the mapped list, not
 *     from connection rows), plus grey "unknown" nodes for external
 *     IPs (grouped per /24 (v6: /64) when >5 unknowns share the subnet,
 *     hard-capped at 100 after grouping + one overflow node).
 *   edges — outbound rows resolve remoteIp against known assets
 *     (Asset.ipAddress → AssetAssociatedIp.ip; AssetIpHistory is deliberately
 *     EXCLUDED — a rotated-off IP would draw the edge to the wrong former
 *     holder). A resolved destination with a mapped process LISTENING on that
 *     (proto, port) lands process→process; otherwise process→asset; otherwise
 *     process→unknown-ip. Inbound rows fill the reverse direction and are
 *     deduped against outbound-derived edges (outbound wins — it knows the
 *     source process). One rendered edge per (source, target) carrying a
 *     per-port breakdown (cap 16 + overflow count).
 *
 * Node ids are DETERMINISTIC (asset:<id>, proc:<assetId>:<b64url(name)>,
 * ip:<ip>, ipgroup:<cidr>) so saved layouts survive refresh.
 *
 * buildGraphFromRows is pure (no prisma) and unit-tested directly;
 * buildApplicationMapGraph is the DB-touching orchestrator behind
 * GET /api/v1/application-map.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import type { Prisma } from "../generated/prisma/client.js";
import { loadIconResolutionCache, resolveIconUrl } from "./deviceIconService.js";
import { sanitizePositions, type TopologyPositions } from "./topologyLayoutService.js";
import { getAppMapConnectionRetentionDays, FOREVER } from "./sampleRetentionService.js";

// ─── Shapes ───────────────────────────────────────────────────────────

export interface MappedAssetLite {
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  assetType: string | null;
  monitorStatus: string | null;
  manufacturer: string | null;
  model: string | null;
  mappedProcesses: string[];
  mappedServices: string[];
}

export interface ProcessConnectionRow {
  assetId: string;
  processName: string;
  unit: string | null; // owning systemd unit / Windows service, if resolved
  kind: string;   // listen | outbound | inbound
  proto: string;  // tcp | udp
  localAddr: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  firstSeen: Date;
  lastSeen: Date;
}

export interface AppMapNode {
  id: string;
  kind: "asset" | "process" | "service" | "unknown-ip" | "unknown-ip-group" | "unknown-overflow";
  parent?: string;
  assetId?: string;
  hostname?: string | null;
  ipAddress?: string | null;
  assetType?: string | null;
  monitorStatus?: string | null;
  iconUrl?: string | null;
  /** True on asset nodes that have mapped processes/services of their own
   * (compound parents); false on assets that appear only as resolved edge
   * targets. */
  hasMappedProcesses?: boolean;
  processName?: string;
  serviceUnit?: string;
  listenPorts?: Array<{ proto: string; port: number }>;
  ip?: string;
  cidr?: string;
  ips?: string[];
  connCount?: number;
  overflowCount?: number;
}

export interface AppMapEdgePort {
  proto: string;
  port: number;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface AppMapEdge {
  id: string;
  source: string;
  target: string;
  kind: "process" | "asset" | "external" | "external-inbound";
  ports: AppMapEdgePort[];
  portOverflow: number;
  lastSeen: string;
}

export interface AppMapStats {
  assetCount: number;
  processCount: number;
  serviceCount: number;
  unknownIpCount: number;
  edgeCount: number;
  truncated: { unknownIps: number };
}

export interface AppMapLayoutDto {
  view: string;
  positions: TopologyPositions;
  updatedBy: string | null;
  updatedAt: string;
}

export interface AppMapGraph {
  generatedAt: string;
  nodes: AppMapNode[];
  edges: AppMapEdge[];
  savedLayout: AppMapLayoutDto | null;
  stats: AppMapStats;
  /** Configured `appMapConnections` retention window in days (FOREVER = -1).
   *  The client builds its "Seen within" range from this, so the widest option
   *  reflects what is actually retained instead of a hardcoded guess. */
  retentionDays: number;
}
// Unknown-IP hygiene.
const UNKNOWN_GROUP_THRESHOLD = 5;   // >5 unknowns in one subnet → group node
const UNKNOWN_NODE_CAP = 100;        // after grouping; overflow collapses
const EDGE_PORT_CAP = 16;

// ─── Node-id helpers (deterministic — saved layouts key on these) ──────

export function assetNodeId(assetId: string): string {
  return `asset:${assetId}`;
}

export function processNodeId(assetId: string, processName: string): string {
  return `proc:${assetId}:${Buffer.from(processName, "utf8").toString("base64url")}`;
}

export function serviceNodeId(assetId: string, unit: string): string {
  return `svc:${assetId}:${Buffer.from(unit, "utf8").toString("base64url")}`;
}

// ─── Noise filter ─────────────────────────────────────────────────────

// Loopback, unspecified, link-local, multicast, broadcast — never map-worthy.
export function isNoiseIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (!v) return true;
  if (v === "::1" || v === "::" || v === "0.0.0.0" || v === "255.255.255.255") return true;
  if (v.startsWith("127.")) return true;
  if (v.startsWith("169.254.")) return true;
  if (v.startsWith("fe80:")) return true;
  if (v.startsWith("ff")) {
    // v6 multicast ff00::/8 — only when it's actually a v6 literal.
    if (v.includes(":")) return true;
  }
  const firstOctet = Number(v.split(".")[0]);
  if (Number.isFinite(firstOctet) && firstOctet >= 224 && firstOctet <= 239 && v.includes(".")) return true;
  return false;
}

/** /24 for v4, /64 for v6 — the unknown-IP grouping bucket. */
export function subnetKeyOf(ip: string): string {
  if (ip.includes(":")) {
    // First four hextets of the expanded form ≈ /64. Cheap textual expansion:
    // split on "::" and pad.
    const [head, tail] = ip.split("::");
    const headParts = head ? head.split(":") : [];
    const tailParts = tail ? tail.split(":") : [];
    const missing = 8 - headParts.length - tailParts.length;
    const full = [...headParts, ...Array(Math.max(0, missing)).fill("0"), ...tailParts];
    return full.slice(0, 4).map((h) => h || "0").join(":") + "::/64";
  }
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : ip;
}

// ─── Bulk IP → asset resolution ───────────────────────────────────────

const ASSET_LITE_SELECT = {
  id: true, hostname: true, ipAddress: true, assetType: true,
  monitorStatus: true, manufacturer: true, model: true,
} as const;

export type ResolvedAssetLite = Omit<MappedAssetLite, "mappedProcesses" | "mappedServices">;

/**
 * Resolve remote IPs to known assets: primary Asset.ipAddress first, then the
 * AssetAssociatedIp side table (multi-NIC / VIP addresses). AssetIpHistory is
 * deliberately excluded — a since-rotated-off IP would attribute live traffic
 * to the wrong (former) holder. Two findMany-in queries total.
 */
export async function resolveIpsToAssets(ips: string[]): Promise<Map<string, ResolvedAssetLite>> {
  const out = new Map<string, ResolvedAssetLite>();
  if (ips.length === 0) return out;
  const primary = await prisma.asset.findMany({
    where: { ipAddress: { in: ips } },
    select: ASSET_LITE_SELECT,
  });
  for (const a of primary) {
    if (a.ipAddress && !out.has(a.ipAddress)) out.set(a.ipAddress, a);
  }
  const remaining = ips.filter((ip) => !out.has(ip));
  if (remaining.length > 0) {
    const assoc = await prisma.assetAssociatedIp.findMany({
      where: { ip: { in: remaining } },
      select: { ip: true, assetId: true },
    });
    if (assoc.length > 0) {
      const byId = new Map(
        (await prisma.asset.findMany({
          where: { id: { in: [...new Set(assoc.map((r) => r.assetId))] } },
          select: ASSET_LITE_SELECT,
        })).map((a) => [a.id, a]),
      );
      for (const r of assoc) {
        const a = byId.get(r.assetId);
        if (a && !out.has(r.ip)) out.set(r.ip, a);
      }
    }
  }
  return out;
}

// ─── Pure graph core ──────────────────────────────────────────────────

const EDGE_KIND_RANK: Record<AppMapEdge["kind"], number> = {
  process: 3, asset: 2, external: 1, "external-inbound": 1,
};

export function buildGraphFromRows(
  assets: MappedAssetLite[],
  rows: ProcessConnectionRow[],
  ipToAsset: Map<string, ResolvedAssetLite>,
): { nodes: AppMapNode[]; edges: AppMapEdge[]; stats: AppMapStats } {
  const mappedProcByAsset = new Map(assets.map((a) => [a.id, new Set(a.mappedProcesses)]));
  const mappedSvcByAsset = new Map(assets.map((a) => [a.id, new Set(a.mappedServices)]));

  // The child nodes a given row is attributed to. A row can satisfy BOTH a
  // mapped process (by program name) AND a mapped service (by owning unit) —
  // e.g. a Spring app mapped as the `java` process and as `myapp.service`; it
  // then shows on both children. Rows matching neither are dropped (rows for a
  // just-unmapped process/service are deleted at the PUT, but belt-and-
  // suspenders here too).
  const ownerNodeIds = (r: ProcessConnectionRow): string[] => {
    const out: string[] = [];
    if (mappedProcByAsset.get(r.assetId)?.has(r.processName)) out.push(processNodeId(r.assetId, r.processName));
    if (r.unit && mappedSvcByAsset.get(r.assetId)?.has(r.unit)) out.push(serviceNodeId(r.assetId, r.unit));
    return out;
  };
  const liveRows = rows.filter((r) => ownerNodeIds(r).length > 0);

  // Listen index: assetId → "proto/port" → set of listening child-node ids
  // (a port can be attributed to a process node AND a service node). Also
  // per-child listen-port lists for the node payload.
  const listenIndex = new Map<string, Map<string, Set<string>>>();
  const listenPortsByNode = new Map<string, Array<{ proto: string; port: number }>>();
  for (const r of liveRows) {
    if (r.kind !== "listen") continue;
    let m = listenIndex.get(r.assetId);
    if (!m) { m = new Map(); listenIndex.set(r.assetId, m); }
    const key = `${r.proto}/${r.localPort}`;
    let set = m.get(key);
    if (!set) { set = new Set(); m.set(key, set); }
    for (const nodeId of ownerNodeIds(r)) {
      set.add(nodeId);
      let list = listenPortsByNode.get(nodeId);
      if (!list) { list = []; listenPortsByNode.set(nodeId, list); }
      if (!list.some((p) => p.proto === r.proto && p.port === r.localPort)) {
        list.push({ proto: r.proto, port: r.localPort });
      }
    }
  }
  const sortedPorts = (nodeId: string): Array<{ proto: string; port: number }> =>
    (listenPortsByNode.get(nodeId) ?? []).sort((x, y) => x.proto.localeCompare(y.proto) || x.port - y.port);

  // ─ Nodes: mapped assets (compound parents) + process/service children ─
  const nodes: AppMapNode[] = [];
  const nodeIds = new Set<string>();
  const pushNode = (n: AppMapNode): void => {
    if (nodeIds.has(n.id)) return;
    nodeIds.add(n.id);
    nodes.push(n);
  };
  let processCount = 0;
  let serviceCount = 0;
  for (const a of assets) {
    pushNode({
      id: assetNodeId(a.id), kind: "asset", assetId: a.id,
      hostname: a.hostname, ipAddress: a.ipAddress, assetType: a.assetType,
      monitorStatus: a.monitorStatus, hasMappedProcesses: true,
    });
    for (const name of a.mappedProcesses) {
      const pid = processNodeId(a.id, name);
      pushNode({
        id: pid, kind: "process", parent: assetNodeId(a.id), assetId: a.id,
        processName: name, listenPorts: sortedPorts(pid),
      });
      processCount++;
    }
    for (const unit of a.mappedServices) {
      const sid = serviceNodeId(a.id, unit);
      pushNode({
        id: sid, kind: "service", parent: assetNodeId(a.id), assetId: a.id,
        serviceUnit: unit, listenPorts: sortedPorts(sid),
      });
      serviceCount++;
    }
  }
  // Resolved-target assets that have no mapped processes of their own get a
  // plain (childless) asset node on first reference, via ensureTargetAsset.
  const ensureTargetAsset = (a: ResolvedAssetLite): string => {
    const id = assetNodeId(a.id);
    if (!nodeIds.has(id)) {
      pushNode({
        id, kind: "asset", assetId: a.id,
        hostname: a.hostname, ipAddress: a.ipAddress, assetType: a.assetType,
        monitorStatus: a.monitorStatus, hasMappedProcesses: false,
      });
    }
    return id;
  };

  // ─ Edge accumulation (merged per (source, target)) ─
  interface EdgeAcc {
    source: string; target: string; kind: AppMapEdge["kind"];
    ports: Map<string, AppMapEdgePort>;
    lastSeen: number;
  }
  const edgeAcc = new Map<string, EdgeAcc>();
  // Outbound-observation keys for inbound dedup: src|dstNode|proto|port.
  const outboundKeys = new Set<string>();
  const unknownConnCount = new Map<string, number>();

  const addEdge = (
    source: string, target: string, kind: AppMapEdge["kind"],
    proto: string, port: number, firstSeen: Date, lastSeen: Date,
  ): void => {
    const key = `${source}|${target}`;
    let acc = edgeAcc.get(key);
    if (!acc) {
      acc = { source, target, kind, ports: new Map(), lastSeen: 0 };
      edgeAcc.set(key, acc);
    }
    if (EDGE_KIND_RANK[kind] > EDGE_KIND_RANK[acc.kind]) acc.kind = kind;
    const pk = `${proto}/${port}`;
    const existing = acc.ports.get(pk);
    if (existing) {
      existing.count++;
      if (firstSeen.toISOString() < existing.firstSeen) existing.firstSeen = firstSeen.toISOString();
      if (lastSeen.toISOString() > existing.lastSeen) existing.lastSeen = lastSeen.toISOString();
    } else {
      acc.ports.set(pk, { proto, port, count: 1, firstSeen: firstSeen.toISOString(), lastSeen: lastSeen.toISOString() });
    }
    if (lastSeen.getTime() > acc.lastSeen) acc.lastSeen = lastSeen.getTime();
  };

  // Pass 1: outbound rows. Each row has ≥1 source child node (process and/or
  // service); a resolved destination can have >1 listening child node on the
  // port (process + service both attributed) — draw an edge per (source,
  // listener) pair.
  for (const r of liveRows) {
    if (r.kind !== "outbound" || !r.remoteIp || isNoiseIp(r.remoteIp)) continue;
    const sources = ownerNodeIds(r);
    const target = ipToAsset.get(r.remoteIp);
    if (target) {
      const listeners = listenIndex.get(target.id)?.get(`${r.proto}/${r.remotePort}`);
      for (const srcNode of sources) {
        if (listeners && listeners.size > 0) {
          for (const listenerNode of listeners) {
            if (target.id === r.assetId && listenerNode === srcNode) continue; // same-node self-loop
            addEdge(srcNode, listenerNode, "process", r.proto, r.remotePort, r.firstSeen, r.lastSeen);
            outboundKeys.add(`${r.assetId}|${listenerNode}|${r.proto}|${r.remotePort}`);
          }
        } else {
          const targetNode = ensureTargetAsset(target);
          addEdge(srcNode, targetNode, "asset", r.proto, r.remotePort, r.firstSeen, r.lastSeen);
          outboundKeys.add(`${r.assetId}|${targetNode}|${r.proto}|${r.remotePort}`);
        }
      }
    } else {
      unknownConnCount.set(r.remoteIp, (unknownConnCount.get(r.remoteIp) ?? 0) + 1);
      for (const srcNode of sources) {
        addEdge(srcNode, `ip:${r.remoteIp}`, "external", r.proto, r.remotePort, r.firstSeen, r.lastSeen);
      }
    }
  }

  // Pass 2: inbound rows — reverse-direction edges, deduped against outbound
  // observations of the same logical connection (outbound wins: it knows the
  // source child node; the inbound side only knows the peer IP).
  for (const r of liveRows) {
    if (r.kind !== "inbound" || !r.remoteIp || isNoiseIp(r.remoteIp)) continue;
    const dsts = ownerNodeIds(r);
    const peer = ipToAsset.get(r.remoteIp);
    if (!peer) unknownConnCount.set(r.remoteIp, (unknownConnCount.get(r.remoteIp) ?? 0) + 1);
    for (const dstNode of dsts) {
      if (peer) {
        if (outboundKeys.has(`${peer.id}|${dstNode}|${r.proto}|${r.localPort}`)) continue;
        if (peer.id === r.assetId) continue; // self-connection seen from the listen side
        addEdge(ensureTargetAsset(peer), dstNode, "asset", r.proto, r.localPort, r.firstSeen, r.lastSeen);
      } else {
        addEdge(`ip:${r.remoteIp}`, dstNode, "external-inbound", r.proto, r.localPort, r.firstSeen, r.lastSeen);
      }
    }
  }

  // ─ Unknown-IP hygiene: /24 (v6 /64) grouping + hard cap ─
  // Group when a subnet holds more than UNKNOWN_GROUP_THRESHOLD unknowns; a
  // grouped member's edges are re-pointed at the group node.
  const bySubnet = new Map<string, string[]>();
  for (const ip of unknownConnCount.keys()) {
    const key = subnetKeyOf(ip);
    let list = bySubnet.get(key);
    if (!list) { list = []; bySubnet.set(key, list); }
    list.push(ip);
  }
  const ipRedirect = new Map<string, string>(); // ip:<ip> node id → group node id
  interface UnknownNode { id: string; node: AppMapNode; connCount: number }
  const unknownNodes: UnknownNode[] = [];
  for (const [cidr, ips] of bySubnet) {
    if (ips.length > UNKNOWN_GROUP_THRESHOLD) {
      const groupId = `ipgroup:${cidr}`;
      const connCount = ips.reduce((s, ip) => s + (unknownConnCount.get(ip) ?? 0), 0);
      for (const ip of ips) ipRedirect.set(`ip:${ip}`, groupId);
      unknownNodes.push({
        id: groupId, connCount,
        node: { id: groupId, kind: "unknown-ip-group", cidr, ips: ips.sort(), connCount },
      });
    } else {
      for (const ip of ips) {
        const connCount = unknownConnCount.get(ip) ?? 0;
        unknownNodes.push({
          id: `ip:${ip}`, connCount,
          node: { id: `ip:${ip}`, kind: "unknown-ip", ip, connCount },
        });
      }
    }
  }
  unknownNodes.sort((a, b) => b.connCount - a.connCount || a.id.localeCompare(b.id));
  const kept = unknownNodes.slice(0, UNKNOWN_NODE_CAP);
  const dropped = unknownNodes.slice(UNKNOWN_NODE_CAP);
  const OVERFLOW_ID = "ip:overflow";
  for (const d of dropped) {
    // Redirect every edge touching a dropped unknown node to the overflow node.
    if (d.node.kind === "unknown-ip-group") {
      for (const ip of d.node.ips ?? []) ipRedirect.set(`ip:${ip}`, OVERFLOW_ID);
    } else {
      ipRedirect.set(d.id, OVERFLOW_ID);
    }
  }
  for (const k of kept) pushNode(k.node);
  if (dropped.length > 0) {
    pushNode({
      id: OVERFLOW_ID, kind: "unknown-overflow",
      overflowCount: dropped.reduce((s, d) => s + (d.node.kind === "unknown-ip-group" ? (d.node.ips?.length ?? 1) : 1), 0),
      connCount: dropped.reduce((s, d) => s + d.connCount, 0),
    });
  }

  // ─ Finalize edges: apply redirects, re-merge collisions, emit ─
  const finalAcc = new Map<string, EdgeAcc>();
  for (const acc of edgeAcc.values()) {
    const source = ipRedirect.get(acc.source) ?? acc.source;
    const target = ipRedirect.get(acc.target) ?? acc.target;
    const key = `${source}|${target}`;
    const existing = finalAcc.get(key);
    if (!existing) {
      finalAcc.set(key, { ...acc, source, target });
      continue;
    }
    if (EDGE_KIND_RANK[acc.kind] > EDGE_KIND_RANK[existing.kind]) existing.kind = acc.kind;
    for (const [pk, p] of acc.ports) {
      const ep = existing.ports.get(pk);
      if (ep) {
        ep.count += p.count;
        if (p.firstSeen < ep.firstSeen) ep.firstSeen = p.firstSeen;
        if (p.lastSeen > ep.lastSeen) ep.lastSeen = p.lastSeen;
      } else {
        existing.ports.set(pk, { ...p });
      }
    }
    if (acc.lastSeen > existing.lastSeen) existing.lastSeen = acc.lastSeen;
  }
  const edges: AppMapEdge[] = [];
  for (const acc of finalAcc.values()) {
    const ports = [...acc.ports.values()].sort((a, b) => b.count - a.count || a.port - b.port);
    edges.push({
      id: `e:${acc.source}|${acc.target}`,
      source: acc.source,
      target: acc.target,
      kind: acc.kind,
      ports: ports.slice(0, EDGE_PORT_CAP),
      portOverflow: Math.max(0, ports.length - EDGE_PORT_CAP),
      lastSeen: new Date(acc.lastSeen).toISOString(),
    });
  }
  edges.sort((a, b) => a.id.localeCompare(b.id));

  return {
    nodes,
    edges,
    stats: {
      assetCount: nodes.filter((n) => n.kind === "asset").length,
      processCount,
      serviceCount,
      unknownIpCount: kept.length,
      edgeCount: edges.length,
      truncated: { unknownIps: dropped.length },
    },
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────────

export async function buildApplicationMapGraph(): Promise<AppMapGraph> {
  // Only actively-monitored hosts appear as compound-parent nodes. `monitored`
  // is false for stop-monitored assets and for decommissioned/disabled ones
  // (business rule 10), so this drops a host off the map when the operator stops
  // monitoring it (or removes its agent) WITHOUT clearing the map pins — the
  // selection is preserved and the host reappears if monitoring is re-enabled.
  // (Resolved-target assets that are merely edge endpoints are added separately
  // via ipToAsset regardless of this filter — they show only while live traffic
  // references them.)
  const assets: MappedAssetLite[] = await prisma.asset.findMany({
    where: { monitored: true, OR: [{ mappedProcesses: { isEmpty: false } }, { mappedServices: { isEmpty: false } }] },
    select: { ...ASSET_LITE_SELECT, mappedProcesses: true, mappedServices: true },
  });
  // Bound the read by the SAME window the prune uses, so the client's widest
  // "Seen within" option can't promise history that was already deleted (and
  // can't hide history that's still there). FOREVER = no lower bound.
  const retentionDays = await getAppMapConnectionRetentionDays();
  const since = retentionDays === FOREVER
    ? null
    : new Date(Date.now() - Math.max(0, retentionDays) * 24 * 3600 * 1000);
  const rows: ProcessConnectionRow[] = assets.length === 0 ? [] : await prisma.assetProcessConnection.findMany({
    where: {
      assetId: { in: assets.map((a) => a.id) },
      ...(since ? { lastSeen: { gte: since } } : {}),
    },
    select: {
      assetId: true, processName: true, unit: true, kind: true, proto: true,
      localAddr: true, localPort: true, remoteIp: true, remotePort: true,
      firstSeen: true, lastSeen: true,
    },
  });
  const remoteIps = [...new Set(rows.map((r) => r.remoteIp).filter((ip) => ip && !isNoiseIp(ip)))];
  const ipToAsset = await resolveIpsToAssets(remoteIps);
  const graph = buildGraphFromRows(assets, rows, ipToAsset);

  // Device icons for asset nodes (same recipe as the topology endpoint).
  const iconCache = await loadIconResolutionCache();
  const liteById = new Map<string, ResolvedAssetLite>();
  for (const a of assets) liteById.set(a.id, a);
  for (const a of ipToAsset.values()) if (!liteById.has(a.id)) liteById.set(a.id, a);
  for (const n of graph.nodes) {
    if (n.kind !== "asset" || !n.assetId) continue;
    const lite = liteById.get(n.assetId);
    if (!lite) continue;
    n.iconUrl = resolveIconUrl(
      { manufacturer: lite.manufacturer, model: lite.model, assetType: lite.assetType },
      iconCache,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    nodes: graph.nodes,
    edges: graph.edges,
    savedLayout: await getAppMapLayout("global"),
    stats: graph.stats,
    retentionDays,
  };
}

// ─── Per-asset detail (process slide-in "Ports & Connections") ─────────

export interface ProcessConnectionsDto {
  listening: Array<{ processName: string; proto: string; port: number; bindAddr: string; firstSeen: string; lastSeen: string }>;
  outbound:  Array<{ processName: string; proto: string; remoteIp: string; remotePort: number; remoteAssetId: string | null; remoteHostname: string | null; firstSeen: string; lastSeen: string }>;
  inbound:   Array<{ processName: string; proto: string; localPort: number; remoteIp: string; remoteAssetId: string | null; remoteHostname: string | null; firstSeen: string; lastSeen: string }>;
}

const DETAIL_SECTION_CAP = 500;

export async function getAssetProcessConnections(assetId: string, processName?: string, unit?: string): Promise<ProcessConnectionsDto> {
  const rows = await prisma.assetProcessConnection.findMany({
    where: { assetId, ...(processName ? { processName } : {}), ...(unit ? { unit } : {}) },
    orderBy: { lastSeen: "desc" },
  });
  const remoteIps = [...new Set(rows.map((r) => r.remoteIp).filter((ip) => ip.length > 0))];
  const ipToAsset = await resolveIpsToAssets(remoteIps);
  const out: ProcessConnectionsDto = { listening: [], outbound: [], inbound: [] };
  for (const r of rows) {
    if (r.kind === "listen" && out.listening.length < DETAIL_SECTION_CAP) {
      out.listening.push({
        processName: r.processName, proto: r.proto, port: r.localPort, bindAddr: r.localAddr,
        firstSeen: r.firstSeen.toISOString(), lastSeen: r.lastSeen.toISOString(),
      });
    } else if (r.kind === "outbound" && out.outbound.length < DETAIL_SECTION_CAP) {
      const remote = ipToAsset.get(r.remoteIp);
      out.outbound.push({
        processName: r.processName, proto: r.proto, remoteIp: r.remoteIp, remotePort: r.remotePort,
        remoteAssetId: remote?.id ?? null, remoteHostname: remote?.hostname ?? null,
        firstSeen: r.firstSeen.toISOString(), lastSeen: r.lastSeen.toISOString(),
      });
    } else if (r.kind === "inbound" && out.inbound.length < DETAIL_SECTION_CAP) {
      const remote = ipToAsset.get(r.remoteIp);
      out.inbound.push({
        processName: r.processName, proto: r.proto, localPort: r.localPort, remoteIp: r.remoteIp,
        remoteAssetId: remote?.id ?? null, remoteHostname: remote?.hostname ?? null,
        firstSeen: r.firstSeen.toISOString(), lastSeen: r.lastSeen.toISOString(),
      });
    }
  }
  return out;
}

// ─── Shared layout (ApplicationMapLayout) ─────────────────────────────

// One global map today; the view key future-proofs sub-views without a
// migration. Conservative charset, same spirit as isValidViewKey.
const VIEW_KEY_RE = /^[a-z0-9_-]{1,64}$/i;

function assertViewKey(view: string): void {
  if (!VIEW_KEY_RE.test(view)) throw new AppError(400, "Invalid view key");
}

function layoutToDto(row: { view: string; positions: Prisma.JsonValue; updatedBy: string | null; updatedAt: Date }): AppMapLayoutDto {
  return {
    view: row.view,
    positions: row.positions as unknown as TopologyPositions,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getAppMapLayout(view = "global"): Promise<AppMapLayoutDto | null> {
  assertViewKey(view);
  const row = await prisma.applicationMapLayout.findUnique({ where: { view } });
  return row ? layoutToDto(row) : null;
}

export async function saveAppMapLayout(
  view: string,
  positions: unknown,
  actor: string | null,
): Promise<AppMapLayoutDto> {
  assertViewKey(view);
  const clean = sanitizePositions(positions);
  const json = clean as unknown as Prisma.InputJsonValue;
  const row = await prisma.applicationMapLayout.upsert({
    where:  { view },
    create: { view, positions: json, updatedBy: actor },
    update: { positions: json, updatedBy: actor },
  });
  return layoutToDto(row);
}

export async function deleteAppMapLayout(view = "global"): Promise<boolean> {
  assertViewKey(view);
  const res = await prisma.applicationMapLayout.deleteMany({ where: { view } });
  return res.count > 0;
}
