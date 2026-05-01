/**
 * src/api/routes/map.ts — Device Map endpoints
 *
 * Three read-only endpoints, all behind requireAuth (registered in router.ts):
 *   GET /map/sites              — every firewall asset with lat/lng coords
 *   GET /map/search?q=<query>   — autocomplete over firewall hostnames
 *   GET /map/sites/:id/topology — FortiGate + its FortiSwitches + FortiAPs + edges
 *
 * Coordinates and topology metadata are populated by the FortiManager / FortiGate
 * discovery pipelines (see fortimanagerService.ts step 3d.5/3d.6 and
 * fortigateService.ts step 3e.5/3e.6). The `fortinetTopology` JSON field on each
 * Asset drives the edge construction — nothing here queries a live device.
 */

import { Router } from "express";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { loadIconResolutionCache, resolveIconUrl } from "../../services/deviceIconService.js";
import { inferInterfaceTopology } from "../../services/interfaceTopologyService.js";

const router = Router();

type TopologyMeta = {
  role?: "fortigate" | "fortiswitch" | "fortiap";
  controllerFortigate?: string | null;
  uplinkInterface?: string | null;
  parentSwitch?: string | null;
  parentPort?: string | null;
  parentVlan?: number | null;
};

function readTopology(raw: unknown): TopologyMeta {
  if (raw && typeof raw === "object") return raw as TopologyMeta;
  return {};
}

type MonitorHealth = "up" | "degraded" | "down" | "unknown";

// Map view's traffic-light: examines the last 10 AssetMonitorSample rows for
// the asset (independent of the global failureThreshold used by the rest of
// the app — the map intentionally uses a fixed 10-sample window for a stable
// at-a-glance signal).
//   - all 10 failed                → down (red)
//   - some failed, not all         → degraded (amber, "packet loss")
//   - all succeeded                → up (green)
//   - no samples or fewer than 10  → degraded if any failed, up if all good,
//                                    unknown if zero samples
function computeMonitorHealth(samples: { success: boolean }[]): MonitorHealth {
  if (samples.length === 0) return "unknown";
  const failed = samples.reduce((n, s) => n + (s.success ? 0 : 1), 0);
  if (samples.length >= 10 && failed === samples.length) return "down";
  if (failed === 0) return "up";
  return "degraded";
}

// Fetch last-10 samples per asset and return a Map keyed by assetId. Issued
// in parallel — N round-trips, but N is the FortiGate count and the endpoint
// is rarely hit (one call per map page load).
async function fetchRecentSampleStats(
  assetIds: string[],
): Promise<Map<string, { samples: number; failures: number; health: MonitorHealth }>> {
  const out = new Map<string, { samples: number; failures: number; health: MonitorHealth }>();
  await Promise.all(
    assetIds.map(async (id) => {
      const rows = await prisma.assetMonitorSample.findMany({
        where: { assetId: id },
        orderBy: { timestamp: "desc" },
        take: 10,
        select: { success: true },
      });
      const failures = rows.reduce((n, s) => n + (s.success ? 0 : 1), 0);
      out.set(id, { samples: rows.length, failures, health: computeMonitorHealth(rows) });
    }),
  );
  return out;
}

// ─── GET /map/sites ────────────────────────────────────────────────────────────
// Every firewall asset with non-null lat/lng — one pin per managed FortiGate.
router.get("/sites", async (_req, res, next) => {
  try {
    const sites = await prisma.asset.findMany({
      where: {
        assetType: "firewall",
        latitude: { not: null },
        longitude: { not: null },
      },
      select: {
        id: true,
        hostname: true,
        serialNumber: true,
        model: true,
        ipAddress: true,
        latitude: true,
        longitude: true,
        status: true,
        lastSeen: true,
        learnedLocation: true,
        monitored: true,
      },
      orderBy: { hostname: "asc" },
    });

    const monitorStats = await fetchRecentSampleStats(
      sites.filter((s) => s.monitored).map((s) => s.id),
    );

    // Subnet counts per FortiGate — the `fortigateDevice` column on Subnet
    // stores the FMG-side device name, which (for auto-discovered FortiGates)
    // matches the Asset's hostname or learnedLocation. One query, grouped.
    const hostnames = sites.map((s) => s.hostname).filter((h): h is string => !!h);
    const subnetCounts = hostnames.length
      ? await prisma.subnet.groupBy({
          by: ["fortigateDevice"],
          where: { fortigateDevice: { in: hostnames } },
          _count: { _all: true },
        })
      : [];
    const countByName = new Map<string, number>();
    for (const row of subnetCounts) {
      if (row.fortigateDevice) countByName.set(row.fortigateDevice, row._count._all);
    }

    res.json(
      sites.map((s) => {
        const stats = s.monitored ? monitorStats.get(s.id) : null;
        return {
          ...s,
          subnetCount: s.hostname ? countByName.get(s.hostname) ?? 0 : 0,
          monitorHealth: s.monitored ? stats?.health ?? "unknown" : null,
          monitorRecentSamples: stats?.samples ?? 0,
          monitorRecentFailures: stats?.failures ?? 0,
        };
      }),
    );
  } catch (err) {
    next(err);
  }
});

// ─── GET /map/search?q=<query> ─────────────────────────────────────────────────
// Autocomplete endpoint for the map page's search box. Matches the query as a
// case-insensitive substring of hostname OR serialNumber on firewall assets
// that have coordinates set — no point suggesting a site we can't pin.
router.get("/search", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.json([]);

    const matches = await prisma.asset.findMany({
      where: {
        assetType: "firewall",
        latitude: { not: null },
        longitude: { not: null },
        OR: [
          { hostname: { contains: q, mode: "insensitive" } },
          { serialNumber: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        hostname: true,
        serialNumber: true,
        latitude: true,
        longitude: true,
      },
      orderBy: { hostname: "asc" },
      take: 12,
    });
    res.json(matches);
  } catch (err) {
    next(err);
  }
});

// ─── GET /map/sites/:id/topology ───────────────────────────────────────────────
// Graph payload for the click-through modal. Shape:
//   {
//     fortigate: { id, hostname, serial, model, ip, status, lastSeen, subnets: [...] },
//     switches:  [{ id, hostname, serial, ip, uplinkInterface, status, model }, ...],
//     aps:       [{ id, hostname, serial, ip, model, status, peerSwitchId, peerPort,
//                   peerVlan, peerAssetId }, ...],
//     edges:     [{ source, target, label? }, ...]
//   }
//
// Every edge references an asset id in this payload, so the frontend can hand
// the whole object to a graph renderer (Cytoscape) without doing any extra
// lookups. APs that could not be paired to a switch port fall back to a direct
// edge from the FortiGate.
router.get("/sites/:id/topology", async (req, res, next) => {
  try {
    const id = req.params.id;
    const fg = await prisma.asset.findUnique({
      where: { id },
      select: {
        id: true,
        hostname: true,
        serialNumber: true,
        manufacturer: true,
        model: true,
        ipAddress: true,
        status: true,
        lastSeen: true,
        latitude: true,
        longitude: true,
        assetType: true,
        fortinetTopology: true,
        monitored: true,
      },
    });
    if (!fg || fg.assetType !== "firewall") {
      throw new AppError(404, "FortiGate not found");
    }

    const fgMonitorStats = fg.monitored
      ? (await fetchRecentSampleStats([fg.id])).get(fg.id) ?? null
      : null;

    // Pre-load every uploaded device icon once so per-node resolution
    // below is sync + cache-hit (no per-asset DB roundtrip).
    const iconCache = await loadIconResolutionCache();

    const fgHostname = fg.hostname || "";

    // Siblings: every FortiSwitch + FortiAP whose fortinetTopology points at
    // this FortiGate by hostname. We match by hostname (not id) because the
    // discovery pipeline stamps controllerFortigate with the device name, and
    // the FortiGate asset may or may not share its id across environments.
    const siblings = fgHostname
      ? await prisma.asset.findMany({
          where: {
            OR: [{ assetType: "switch" }, { assetType: "access_point" }],
            fortinetTopology: { path: ["controllerFortigate"], equals: fgHostname },
          },
          select: {
            id: true,
            hostname: true,
            serialNumber: true,
            manufacturer: true,
            model: true,
            ipAddress: true,
            status: true,
            assetType: true,
            fortinetTopology: true,
            learnedLocation: true,
            lastSeen: true,
          },
        })
      : [];

    const switches = siblings
      .filter((s) => s.assetType === "switch")
      .map((s) => {
        const t = readTopology(s.fortinetTopology);
        return {
          id: s.id,
          hostname: s.hostname,
          serial: s.serialNumber,
          model: s.model,
          ip: s.ipAddress,
          status: s.status,
          lastSeen: s.lastSeen,
          uplinkInterface: t.uplinkInterface ?? null,
          iconUrl: resolveIconUrl({ manufacturer: s.manufacturer, model: s.model, assetType: "switch" }, iconCache),
        };
      });

    const switchByName = new Map<string, string /* assetId */>();
    for (const s of switches) {
      if (s.hostname) switchByName.set(s.hostname, s.id);
    }

    const aps = siblings
      .filter((s) => s.assetType === "access_point")
      .map((s) => {
        const t = readTopology(s.fortinetTopology);
        const peerAssetId = t.parentSwitch ? switchByName.get(t.parentSwitch) ?? null : null;
        return {
          id: s.id,
          hostname: s.hostname,
          serial: s.serialNumber,
          model: s.model,
          ip: s.ipAddress,
          status: s.status,
          lastSeen: s.lastSeen,
          peerSwitch: t.parentSwitch ?? null,
          peerSwitchId: peerAssetId,
          peerPort: t.parentPort ?? null,
          peerVlan: t.parentVlan ?? null,
          iconUrl: resolveIconUrl({ manufacturer: s.manufacturer, model: s.model, assetType: "access_point" }, iconCache),
        };
      });

    // Subnets behind this FortiGate — shown in the modal sidebar, not as graph
    // nodes (a site with 30 subnets would blow up the graph). Include VLAN so
    // the UI can show the mapping at a glance.
    const subnets = fgHostname
      ? await prisma.subnet.findMany({
          where: { fortigateDevice: fgHostname },
          select: { id: true, cidr: true, name: true, vlan: true, status: true },
          orderBy: { cidr: "asc" },
        })
      : [];

    // Edges — FG→switch by uplinkInterface, AP→switch by peerPort, AP→FG for
    // unpaired APs. Uplink label is the interface name; AP label is the port.
    type Edge = { source: string; target: string; label?: string };
    const edges: Edge[] = [];
    for (const s of switches) {
      edges.push({ source: fg.id, target: s.id, label: s.uplinkInterface || undefined });
    }
    for (const ap of aps) {
      if (ap.peerSwitchId) {
        edges.push({ source: ap.peerSwitchId, target: ap.id, label: ap.peerPort || undefined });
      } else {
        edges.push({ source: fg.id, target: ap.id });
      }
    }

    const siteAssetIds = [fg.id, ...switches.map((s) => s.id), ...aps.map((a) => a.id)];

    // CMDB-inferred edges from FortiOS interface naming conventions —
    // peer-serial aggregates (FortiLink-auto) plus operator-named
    // hostname aggregates (custom MCLAG between non-stacked pairs). Run
    // first so interface edges populate `existingEdge` before LLDP de-dup
    // and so the LLDP path can reuse the same dedupe set.
    const ifaceInference = await inferInterfaceTopology(siteAssetIds);
    type InterfaceEdge = {
      source: string;
      target: string;
      sourceIfName: string;
      label: string;
      via: "interface";
      matchVia: "serial" | "hostname";
    };
    const interfaceEdges: InterfaceEdge[] = [];
    const seenIfacePair = new Set<string>();
    for (const e of ifaceInference.edges) {
      // Don't redraw an edge that fortinetTopology already covered.
      const key = `${e.sourceAssetId}|${e.targetAssetId}`;
      const reverseKey = `${e.targetAssetId}|${e.sourceAssetId}`;
      if (seenIfacePair.has(key) || seenIfacePair.has(reverseKey)) continue;
      // Skip if controller-data already gave us this pair (FortiLink uplink
      // covered by `edges` above). The interface name still appears in the
      // edge's label there, just from a different code path.
      // existingEdge isn't built yet at this point — check `edges` directly.
      const dup = edges.some(
        (g) =>
          (g.source === e.sourceAssetId && g.target === e.targetAssetId) ||
          (g.source === e.targetAssetId && g.target === e.sourceAssetId),
      );
      if (dup) continue;
      seenIfacePair.add(key);
      interfaceEdges.push({
        source: e.sourceAssetId,
        target: e.targetAssetId,
        sourceIfName: e.sourceIfName,
        label: e.sourceIfName,
        via: "interface",
        matchVia: e.matchVia,
      });
    }

    // Cross-site assets matched via interface name — registered as
    // remoteAssetNodes (same surface used for cross-site LLDP matches) so
    // the frontend has a real node to draw the edge to.
    type RemoteAssetNode = {
      id: string;
      hostname: string | null;
      ipAddress: string | null;
      assetType: string | null;
      model: string | null;
      iconUrl: string | null;
    };
    const remoteAssetNodes = new Map<string, RemoteAssetNode>();
    for (const r of ifaceInference.remoteAssets.values()) {
      remoteAssetNodes.set(r.id, {
        id: r.id,
        hostname: r.hostname,
        ipAddress: r.ipAddress,
        assetType: r.assetType,
        model: r.model,
        iconUrl: resolveIconUrl(
          { manufacturer: r.manufacturer, model: r.model, assetType: r.assetType },
          iconCache,
        ),
      });
    }

    // LLDP-derived neighbors. We pull neighbors for the FortiGate plus every
    // switch in this site, then build:
    //   - A "ghost" node for any neighbor that did NOT match a Polaris asset
    //     (e.g. an upstream ISP router, a third-party access switch). These
    //     are uniquely identified by chassisId; multiple ports onto the same
    //     remote chassis collapse to a single node.
    //   - One LLDP edge per neighbor row, source = local asset, target =
    //     matched asset OR the ghost node. Edges are de-duped against
    //     fortinetTopology edges AND interface-inferred edges so a peer
    //     link confirmed by both signals only renders once (the
    //     authoritative one wins).
    const lldpRows = await prisma.assetLldpNeighbor.findMany({
      where: { assetId: { in: siteAssetIds } },
      include: {
        matchedAsset: {
          select: { id: true, hostname: true, ipAddress: true, assetType: true, manufacturer: true, model: true },
        },
      },
    });

    type LldpNode = {
      id: string;
      hostname: string | null;
      managementIp: string | null;
      chassisId: string | null;
      systemDescription: string | null;
      capabilities: string[];
    };
    // Synthesized "ghost" nodes for non-Polaris LLDP neighbors. Stable
    // ids prefixed with `lldp:` so they don't collide with real asset
    // UUIDs, and dedup'd by chassisId so multi-link aggregates collapse.
    const lldpNodes = new Map<string, LldpNode>();
    // Cross-site LLDP-matched Polaris assets are added to `remoteAssetNodes`
    // (declared above alongside interface-inferred remotes) so cross-site
    // assets matched by EITHER pathway end up in the same node list.
    const siblingIds = new Set(siteAssetIds);
    // Seed the LLDP dedupe set with both controller edges AND interface-
    // inferred edges so a peer link confirmed by multiple signals only
    // renders once (interface > LLDP because interface is CMDB-stamped).
    const existingEdge = new Set([
      ...edges.map((e) => `${e.source}|${e.target}`),
      ...interfaceEdges.map((e) => `${e.source}|${e.target}`),
    ]);
    type LldpEdge = {
      source: string;
      target: string;
      label?: string;
      via: "lldp";
      /** Friendly label for the right-hand side panel — hostname / IP / chassis ID. */
      targetLabel: string;
      /** True when target is a Polaris asset (clickable); false for ghost neighbors. */
      targetIsAsset: boolean;
    };
    const lldpEdges: LldpEdge[] = [];

    // Render-time fallback for stale LLDP rows whose `matchedAssetId` is
    // null but whose `systemName` actually corresponds to a sibling we
    // already have on the graph. The persist-time match in
    // `monitoringService.persistLldpNeighbors` resolves these via an
    // FQDN/short-form-aware index, but rows persisted before that fix
    // landed will keep showing as ghost nodes until the next system-info
    // pass overwrites them. This map covers the gap so a duplicate-named
    // sibling is dropped instead of double-rendered as an orange ghost.
    const siblingByHostname = new Map<string, string /* assetId */>();
    const idxSibling = (raw: string | null | undefined, assetId: string) => {
      if (!raw) return;
      const lower = raw.toLowerCase().trim();
      if (!lower) return;
      if (!siblingByHostname.has(lower)) siblingByHostname.set(lower, assetId);
      const dotIdx = lower.indexOf(".");
      if (dotIdx > 0) {
        const shortForm = lower.slice(0, dotIdx);
        if (!siblingByHostname.has(shortForm)) siblingByHostname.set(shortForm, assetId);
      }
    };
    idxSibling(fg.hostname, fg.id);
    for (const s of switches) idxSibling(s.hostname, s.id);
    for (const a of aps) idxSibling(a.hostname, a.id);

    for (const n of lldpRows) {
      let targetId: string;
      let targetLabel: string;
      let targetIsAsset: boolean;
      // Stale-row fallback: persist-time match returned null, but the
      // systemName resolves to a sibling now (FQDN ↔ short-form). Treat
      // exactly like a sibling-match — controller data has the edge.
      if (!(n.matchedAsset && n.matchedAsset.id) && n.systemName) {
        const lower = n.systemName.toLowerCase().trim();
        const siblingId = siblingByHostname.get(lower)
          ?? (lower.includes(".") ? siblingByHostname.get(lower.split(".")[0]) : undefined);
        if (siblingId) continue;
      }
      if (n.matchedAsset && n.matchedAsset.id) {
        // Skip neighbors that resolve back to a sibling node — fortinetTopology
        // has already drawn that edge from authoritative controller data, so a
        // duplicate LLDP edge would just clutter the graph. We still emit the
        // LLDP edge when the matched asset is OUTSIDE this site (e.g. a
        // separate firewall) — that's the whole point.
        if (siblingIds.has(n.matchedAsset.id)) continue;
        targetId = n.matchedAsset.id;
        targetLabel = n.matchedAsset.hostname || n.matchedAsset.ipAddress || n.matchedAsset.id;
        targetIsAsset = true;
        // Record the cross-site node so the topology payload's edge target
        // resolves to a real node on the frontend (Cytoscape errors on
        // edges referencing nonexistent nodes). Dedup'd by asset id so a
        // multi-link cross-site uplink collapses to one node.
        if (!remoteAssetNodes.has(targetId)) {
          remoteAssetNodes.set(targetId, {
            id: targetId,
            hostname: n.matchedAsset.hostname,
            ipAddress: n.matchedAsset.ipAddress,
            assetType: n.matchedAsset.assetType,
            model: n.matchedAsset.model,
            iconUrl: resolveIconUrl(
              { manufacturer: n.matchedAsset.manufacturer, model: n.matchedAsset.model, assetType: n.matchedAsset.assetType },
              iconCache,
            ),
          });
        }
      } else {
        // Synthesize a stable ghost id from chassisId (preferred) or system
        // name. This collapses multi-link aggregates to one node so the graph
        // stays readable.
        const key = n.chassisId || n.systemName || `${n.assetId}|${n.localIfName}|${n.portId ?? ""}`;
        targetId = `lldp:${key}`;
        if (!lldpNodes.has(targetId)) {
          lldpNodes.set(targetId, {
            id: targetId,
            hostname: n.systemName,
            managementIp: n.managementIp,
            chassisId: n.chassisId,
            systemDescription: n.systemDescription,
            capabilities: n.capabilities,
          });
        }
        targetLabel = n.systemName || n.managementIp || n.chassisId || "Unknown neighbor";
        targetIsAsset = false;
      }
      const key = `${n.assetId}|${targetId}`;
      const reverseKey = `${targetId}|${n.assetId}`;
      if (existingEdge.has(key) || existingEdge.has(reverseKey)) continue;
      existingEdge.add(key);
      lldpEdges.push({
        source: n.assetId,
        target: targetId,
        label:  n.localIfName + (n.portId ? ` ↔ ${n.portId}` : ""),
        via:    "lldp",
        targetLabel,
        targetIsAsset,
      });
    }

    res.json({
      fortigate: {
        id: fg.id,
        hostname: fg.hostname,
        serial: fg.serialNumber,
        model: fg.model,
        ip: fg.ipAddress,
        status: fg.status,
        lastSeen: fg.lastSeen,
        latitude: fg.latitude,
        longitude: fg.longitude,
        monitored: fg.monitored,
        monitorHealth: fg.monitored ? fgMonitorStats?.health ?? "unknown" : null,
        monitorRecentSamples: fgMonitorStats?.samples ?? 0,
        monitorRecentFailures: fgMonitorStats?.failures ?? 0,
        iconUrl: resolveIconUrl({ manufacturer: fg.manufacturer, model: fg.model, assetType: "firewall" }, iconCache),
      },
      switches,
      aps,
      subnets,
      edges,
      // CMDB-inferred edges from FortiOS interface naming conventions —
      // peer-serial aggregates (FortiLink-auto) plus operator-named
      // hostname aggregates. Authoritative because they're stamped by
      // FortiOS itself; rendered with their own visual style on the
      // topology graph. Each edge references nodes already in this
      // payload (siblings or `remoteAssetNodes`).
      interfaceEdges,
      // LLDP additions: rendered separately by the topology modal so the
      // styling can distinguish authoritative fortinetTopology edges from
      // observed LLDP edges. `lldpNodes` is the array form of the Map above.
      lldpNodes: Array.from(lldpNodes.values()),
      // Cross-site Polaris assets observed via LLDP OR via interface-name
      // inference from this site — separate from `lldpNodes` (ghost
      // neighbors) so the frontend can render them with a "real asset,
      // just elsewhere" style and a click-through to the asset details
      // page. Without this, edges in `lldpEdges` / `interfaceEdges` whose
      // target is a cross-site asset id would reference nonexistent
      // Cytoscape nodes and the graph would error out on load.
      remoteAssetNodes: Array.from(remoteAssetNodes.values()),
      lldpEdges,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
