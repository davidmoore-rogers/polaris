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

    type EndpointSummary = {
      id: string;
      hostname: string | null;
      ipAddress: string | null;
      macAddress: string | null;
      assetType: string | null;
      assignedTo: string | null;
      port: string;
      lastSeen: Date | null;
    };
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
          endpointCount: 0,
          endpoints: [] as EndpointSummary[],
        };
      });

    const switchByName = new Map<string, string /* assetId */>();
    for (const s of switches) {
      if (s.hostname) switchByName.set(s.hostname, s.id);
    }

    // Endpoints attached to any of this site's FortiSwitches. We populate
    // `Asset.lastSeenSwitch = "<switchHostname>/<portName>"` from the
    // FortiSwitch MAC table during discovery (see Phase 7.5 in the FMG
    // sync), so prefix-matching against each switch hostname yields every
    // endpoint currently learned on that switch's ports. Returns top-25
    // by recency per switch + the total count, so the modal info panel
    // can show "12 endpoints" with a sample list while the search
    // endpoint (slice 2) handles wildcards over the full set.
    const switchHostnames = switches.map((s) => s.hostname).filter((h): h is string => !!h);
    if (switchHostnames.length > 0) {
      const [endpointSamples, countRows] = await Promise.all([
        prisma.asset.findMany({
          where: {
            assetType: { notIn: ["firewall", "switch", "access_point"] },
            OR: switchHostnames.map((h) => ({ lastSeenSwitch: { startsWith: `${h}/` } })),
          },
          select: {
            id: true,
            hostname: true,
            ipAddress: true,
            macAddress: true,
            assetType: true,
            assignedTo: true,
            lastSeenSwitch: true,
            lastSeen: true,
          },
          orderBy: { lastSeen: "desc" },
          take: switchHostnames.length * 25,
        }),
        prisma.$queryRaw<Array<{ swhost: string; cnt: bigint }>>`
          SELECT split_part("lastSeenSwitch", '/', 1) AS swhost, COUNT(*)::bigint AS cnt
          FROM assets
          WHERE "lastSeenSwitch" IS NOT NULL
            AND "assetType" NOT IN ('firewall', 'switch', 'access_point')
            AND split_part("lastSeenSwitch", '/', 1) = ANY(${switchHostnames}::text[])
          GROUP BY swhost
        `,
      ]);
      const countByHost = new Map<string, number>();
      for (const r of countRows) countByHost.set(r.swhost, Number(r.cnt));
      const switchByHost = new Map<string, typeof switches[number]>();
      for (const s of switches) if (s.hostname) switchByHost.set(s.hostname, s);
      for (const ep of endpointSamples) {
        const lss = ep.lastSeenSwitch || "";
        const slashIdx = lss.indexOf("/");
        if (slashIdx <= 0) continue;
        const swHost = lss.slice(0, slashIdx);
        const port = lss.slice(slashIdx + 1);
        const sw = switchByHost.get(swHost);
        if (!sw) continue;
        if (sw.endpoints.length >= 25) continue; // per-switch cap
        sw.endpoints.push({
          id: ep.id,
          hostname: ep.hostname,
          ipAddress: ep.ipAddress,
          macAddress: ep.macAddress,
          assetType: String(ep.assetType),
          assignedTo: ep.assignedTo,
          port,
          lastSeen: ep.lastSeen,
        });
      }
      for (const s of switches) {
        s.endpointCount = s.hostname ? (countByHost.get(s.hostname) ?? 0) : 0;
      }
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
          // peerSource: "lldp" if the AP itself reported its uplink via
          // LLDP on its lan1 interface; "detected-device" if resolved
          // via the FortiSwitch MAC-table fallback. Drives the
          // edge-tooltip wording on the topology graph.
          peerSource: (t as any).peerSource ?? null,
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
    // `reason` populates the hover tooltip on the topology graph so the
    // operator can see EXACTLY which rule + which evidence drew each edge.
    // If an edge is wrong, the tooltip should be enough to point at either
    // the bad data (FortiOS reported X but reality is Y) or the bad rule
    // (the matcher is too loose / too strict).
    type Edge = { source: string; target: string; label?: string; reason?: string };
    let edges: Edge[] = [];
    const switchHostById = new Map<string, string | null>();
    for (const s of switches) switchHostById.set(s.id, s.hostname);
    const apHostById = new Map<string, string | null>();
    for (const a of aps) apHostById.set(a.id, a.hostname);
    for (const s of switches) {
      const ifLabel = s.uplinkInterface || "fortilink";
      const swLabel = s.hostname || s.id;
      const fgLabel = fg.hostname || fg.id;
      edges.push({
        source: fg.id,
        target: s.id,
        label: s.uplinkInterface || undefined,
        reason:
          `Rule: controller-data FG→switch edge.\n` +
          `Evidence: switch ${swLabel} carries Asset.fortinetTopology.controllerFortigate = "${fgLabel}" ` +
          `and uplinkInterface = "${ifLabel}" (sourced from managed-switch/status.fgt_peer_intf_name during discovery).\n` +
          `Caveat: FortiOS reports "fortilink" on every managed switch — direct or chained — so this signal alone over-connects multi-switch fleets. ` +
          `If a more specific signal (interface-name peer-aggregate, see teal edges) marks a different switch as the direct uplink, this edge is demoted automatically.`,
      });
    }
    for (const ap of aps) {
      const apLabel = ap.hostname || ap.id;
      if (ap.peerSwitchId) {
        const peerSwLabel = switchHostById.get(ap.peerSwitchId) || ap.peerSwitchId;
        edges.push({
          source: ap.peerSwitchId,
          target: ap.id,
          label: ap.peerPort || undefined,
          reason:
            `Rule: AP→switch edge from FortiSwitch MAC learning.\n` +
            `Evidence: AP ${apLabel}'s base MAC was seen on switch ${peerSwLabel} port "${ap.peerPort || "?"}" ` +
            `(switch-controller/detected-device, learned at discovery). ` +
            (ap.peerSource === "lldp"
              ? `Confirmed by LLDP advertisement on the AP's lan1 interface.`
              : `Resolved via the detected-device MAC table fallback path.`),
        });
      } else {
        edges.push({
          source: fg.id,
          target: ap.id,
          reason:
            `Rule: AP→FortiGate fallback edge.\n` +
            `Evidence: AP ${apLabel}'s base MAC was NOT found on any managed FortiSwitch's MAC table at last discovery, ` +
            `and no LLDP neighbor was reported on its lan1 interface. ` +
            `Drawing a direct AP→FG edge so the AP still appears on the graph; real attachment unknown.`,
        });
      }
    }

    const siteAssetIds = [fg.id, ...switches.map((s) => s.id), ...aps.map((a) => a.id)];

    // CMDB-inferred edges from FortiOS interface naming conventions —
    // peer-serial aggregates (FortiLink-auto) plus operator-named
    // hostname aggregates (custom MCLAG between non-stacked pairs). Run
    // first so interface edges populate `existingEdge` before LLDP de-dup
    // and so the LLDP path can reuse the same dedupe set.
    const ifaceInference = await inferInterfaceTopology(siteAssetIds);

    // Refine the controller-data FG→switch edges using interface-naming
    // signal. FortiOS reports `fortilink` on every managed switch's
    // `fgt_peer_intf_name` regardless of whether it's directly cabled or
    // chained behind another FortiSwitch — so the controller-data edges
    // can over-connect a multi-switch fleet (e.g. a stacked pair where
    // only one switch is directly cabled to the FG ends up with two
    // FG→switch edges). The fix: a switch with a FortiOS-auto aggregate
    // whose name encodes the FG's serial is a confirmed-direct uplink;
    // siblings reachable from a confirmed-direct switch through inter-
    // switch interface edges are downstream and don't get a direct FG
    // edge. Switches with NO interface-edge to a confirmed-direct
    // sibling fall through and keep their controller edge — we don't
    // want to silently disconnect a switch whose aggregates we couldn't
    // parse (custom names, older firmware, etc).
    const interfaceConfirmedFgPeers = new Set<string>();
    for (const e of ifaceInference.edges) {
      if (e.sourceAssetId === fg.id) interfaceConfirmedFgPeers.add(e.targetAssetId);
      if (e.targetAssetId === fg.id) interfaceConfirmedFgPeers.add(e.sourceAssetId);
    }
    if (interfaceConfirmedFgPeers.size > 0) {
      // Build an inter-switch adjacency map from interface-only edges so we
      // can BFS from each confirmed-direct switch and find downstream
      // siblings through arbitrary chain depth.
      const interfacePeersOf = new Map<string, Set<string>>();
      for (const e of ifaceInference.edges) {
        if (e.sourceAssetId === fg.id || e.targetAssetId === fg.id) continue;
        if (!interfacePeersOf.has(e.sourceAssetId)) interfacePeersOf.set(e.sourceAssetId, new Set());
        if (!interfacePeersOf.has(e.targetAssetId)) interfacePeersOf.set(e.targetAssetId, new Set());
        interfacePeersOf.get(e.sourceAssetId)!.add(e.targetAssetId);
        interfacePeersOf.get(e.targetAssetId)!.add(e.sourceAssetId);
      }
      const reachableFromConfirmed = new Set<string>(interfaceConfirmedFgPeers);
      const queue = [...interfaceConfirmedFgPeers];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const n of interfacePeersOf.get(cur) ?? []) {
          if (!reachableFromConfirmed.has(n)) {
            reachableFromConfirmed.add(n);
            queue.push(n);
          }
        }
      }
      const switchIds = new Set(switches.map((s) => s.id));
      edges = edges.filter((e) => {
        if (e.source !== fg.id) return true;            // not an FG-out edge
        if (!switchIds.has(e.target)) return true;      // FG→AP keep as-is
        if (interfaceConfirmedFgPeers.has(e.target)) return true;
        // Demote when reachable through a confirmed-direct sibling; otherwise
        // keep as fallback to avoid orphaning an unparseable switch.
        return !reachableFromConfirmed.has(e.target);
      });
    }
    type InterfaceEdge = {
      source: string;
      target: string;
      sourceIfName: string;
      label: string;
      via: "interface";
      matchVia: "serial" | "hostname";
      reason: string;
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
      const sourceLabel =
        switchHostById.get(e.sourceAssetId) ||
        apHostById.get(e.sourceAssetId) ||
        (e.sourceAssetId === fg.id ? (fg.hostname || fg.id) : e.sourceAssetId);
      const reason = e.matchVia === "serial"
        ? `Rule: interface-name peer-serial match (interfaceTopologyService).\n` +
          `Evidence: device ${sourceLabel} has interface "${e.sourceIfName}". ` +
          `The pattern matches FortiOS's auto-named peer aggregate (uppercase alnum, optional trailing -<digits>). ` +
          `Stripping any "-N" aggregate suffix gives the peer-fragment, which case-insensitively matches the END of the target asset's serial number.\n` +
          `Skipped if multiple inventory assets end with the same fragment (ambiguous) or if the match is the source asset itself.`
        : `Rule: interface-name peer-hostname match (interfaceTopologyService, fallback when serial match yielded nothing).\n` +
          `Evidence: device ${sourceLabel} has interface "${e.sourceIfName}" — uppercase with internal dashes (operator-typed, not FortiOS-auto). ` +
          `Hostname match: target asset's hostname equals the fragment exactly OR starts with "${e.sourceIfName}-" / "${e.sourceIfName}.".\n` +
          `Skipped if multiple inventory hostnames qualify (ambiguous prefix collision).`;
      seenIfacePair.add(key);
      interfaceEdges.push({
        source: e.sourceAssetId,
        target: e.targetAssetId,
        sourceIfName: e.sourceIfName,
        label: e.sourceIfName,
        via: "interface",
        matchVia: e.matchVia,
        reason,
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
      /** Operator-readable explanation of why this LLDP edge was drawn. */
      reason: string;
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
      const sourceLabel =
        switchHostById.get(n.assetId) ||
        apHostById.get(n.assetId) ||
        (n.assetId === fg.id ? (fg.hostname || fg.id) : n.assetId);
      const matchBy = n.matchedAsset
        ? (n.managementIp ? `management IP ${n.managementIp}` :
           (n.chassisIdSubtype === "macAddress" && n.chassisId) ? `chassis MAC ${n.chassisId}` :
           n.systemName ? `system name "${n.systemName}"` :
           "stored matchedAssetId")
        : "no Polaris asset matched";
      const lldpReason = n.matchedAsset
        ? `Rule: LLDP edge — observed advertisement, matched to a Polaris asset.\n` +
          `Evidence: ${sourceLabel} received an LLDP frame on local port "${n.localIfName || "?"}". ` +
          `Remote chassis-id ${n.chassisId || "(unknown)"}, port-id ${n.portId || "(unknown)"}, system name "${n.systemName || "?"}", management IP ${n.managementIp || "?"}.\n` +
          `Match resolved at persist time via ${matchBy}.\n` +
          `Source transport: ${n.source || "?"} (FortiOS REST or SNMP LLDP-MIB walk).\n` +
          `Sibling-match LLDP edges are skipped — controller-data already covers them.`
        : `Rule: LLDP edge — observed advertisement, no matching Polaris asset (rendered as a ghost node).\n` +
          `Evidence: ${sourceLabel} received an LLDP frame on local port "${n.localIfName || "?"}". ` +
          `Remote chassis-id ${n.chassisId || "(unknown)"}, port-id ${n.portId || "(unknown)"}, system name "${n.systemName || "?"}", management IP ${n.managementIp || "?"}.\n` +
          `No asset in the inventory matched by management IP, chassis MAC, or hostname (case-insensitive, FQDN-aware).\n` +
          `Source transport: ${n.source || "?"}.`;
      lldpEdges.push({
        source: n.assetId,
        target: targetId,
        label:  n.localIfName + (n.portId ? ` ↔ ${n.portId}` : ""),
        via:    "lldp",
        targetLabel,
        targetIsAsset,
        reason: lldpReason,
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

// ─── GET /map/sites/:id/topology/search?q=<query> ──────────────────────────────
// Site-scoped endpoint search for the topology modal. Matches the query as a
// case-insensitive substring of hostname / IP / MAC / assignedTo, scoped to
// endpoints whose `lastSeenSwitch` references one of THIS site's switches
// (or LLDP-confirmed neighbors of those switches via the existing matched
// asset cross-link). Returns the matching endpoint + which switch it's on
// so the frontend can pulse-highlight that switch on the graph and pivot
// to asset details on click.
router.get("/sites/:id/topology/search", async (req, res, next) => {
  try {
    const id = req.params.id;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.json({ q: "", results: [] });

    const fg = await prisma.asset.findUnique({
      where: { id },
      select: { id: true, hostname: true, assetType: true },
    });
    if (!fg || fg.assetType !== "firewall") throw new AppError(404, "FortiGate not found");

    const fgHostname = fg.hostname || "";
    const siblingSwitches = fgHostname
      ? await prisma.asset.findMany({
          where: {
            assetType: "switch",
            fortinetTopology: { path: ["controllerFortigate"], equals: fgHostname },
          },
          select: { id: true, hostname: true },
        })
      : [];
    const switchHostnames = siblingSwitches.map((s) => s.hostname).filter((h): h is string => !!h);
    if (switchHostnames.length === 0) return res.json({ q, results: [] });

    // Anchored prefix-OR for switch attribution AND substring match across
    // common identity fields. Capped at 25 results — search is for finding
    // a specific endpoint, not for browsing.
    const matches = await prisma.asset.findMany({
      where: {
        assetType: { notIn: ["firewall", "switch", "access_point"] },
        OR: switchHostnames.map((h) => ({ lastSeenSwitch: { startsWith: `${h}/` } })),
        AND: [
          {
            OR: [
              { hostname:    { contains: q, mode: "insensitive" } },
              { ipAddress:   { contains: q, mode: "insensitive" } },
              { macAddress:  { contains: q, mode: "insensitive" } },
              { assignedTo:  { contains: q, mode: "insensitive" } },
              { dnsName:     { contains: q, mode: "insensitive" } },
            ],
          },
        ],
      },
      select: {
        id: true, hostname: true, ipAddress: true, macAddress: true,
        assetType: true, assignedTo: true, lastSeenSwitch: true, lastSeen: true,
      },
      orderBy: { lastSeen: "desc" },
      take: 25,
    });

    const switchIdByHost = new Map<string, string>();
    for (const s of siblingSwitches) {
      if (s.hostname) switchIdByHost.set(s.hostname, s.id);
    }
    const results = matches.map((m) => {
      const lss = m.lastSeenSwitch || "";
      const slashIdx = lss.indexOf("/");
      const swHost  = slashIdx > 0 ? lss.slice(0, slashIdx) : "";
      const port    = slashIdx > 0 ? lss.slice(slashIdx + 1) : "";
      return {
        id:         m.id,
        hostname:   m.hostname,
        ipAddress:  m.ipAddress,
        macAddress: m.macAddress,
        assetType:  String(m.assetType),
        assignedTo: m.assignedTo,
        switchId:   switchIdByHost.get(swHost) ?? null,
        switchHostname: swHost || null,
        port,
        lastSeen:   m.lastSeen,
      };
    });
    res.json({ q, results });
  } catch (err) {
    next(err);
  }
});

export default router;
