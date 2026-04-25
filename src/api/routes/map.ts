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
      },
      switches,
      aps,
      subnets,
      edges,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
