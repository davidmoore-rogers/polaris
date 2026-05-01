/**
 * src/services/interfaceTopologyService.ts
 *
 * Inter-Fortinet topology inference from interface naming conventions.
 *
 * When FortiOS auto-builds a peer aggregate (FortiLink trunks between
 * managed FortiSwitches and their controller FortiGate, or between
 * stacked / MCLAG-paired FortiSwitches), it stamps the aggregate's
 * interface name with the peer device's serial fragment — a stronger
 * signal than LLDP because it's CMDB-stamped on the local device, not
 * inferred from optional peer-side LLDP TLVs that branch FortiGates
 * sometimes filter or fail to expose.
 *
 * Operators occasionally hand-build aggregates (true MCLAG between two
 * peer-stacks at distinct serials) and name them after the peer device's
 * hostname instead. Those are caught by the hostname-match fallback.
 *
 * No new discovery queries — this service reads the most recent
 * `AssetInterfaceSample` rows already collected by the monitoring
 * pipeline, parses interface names through `fortinetSerialPattern`, and
 * resolves matches against the in-memory Fortinet asset inventory.
 */

import { prisma } from "../db.js";
import {
  hostnameMatchesPeerInterface,
  parseFortinetPeerInterface,
  serialMatchesPeerInterface,
  type ParsedPeerInterface,
} from "../utils/fortinetSerialPattern.js";

export interface InterfaceInferredEdge {
  sourceAssetId: string;
  sourceIfName: string;
  targetAssetId: string;
  matchVia: "serial" | "hostname";
  aggregateIndex: number | null;
}

export interface InterfaceInferredRemote {
  id: string;
  hostname: string | null;
  serialNumber: string | null;
  ipAddress: string | null;
  assetType: string | null;
  manufacturer: string | null;
  model: string | null;
}

export interface InterfaceInferenceResult {
  edges: InterfaceInferredEdge[];
  remoteAssets: Map<string, InterfaceInferredRemote>;
}

/**
 * Infer inter-Fortinet topology edges from each seed asset's most recent
 * interface scrape.
 *
 * @param seedAssetIds  Assets the topology graph is centered on. Edges
 *                      sourced from any of these whose peer ALSO falls in
 *                      this set are sibling edges; peers outside the set
 *                      are returned in `remoteAssets` (cross-site).
 *
 * Skips:
 *   - interface names that fail the loose pattern (port1, fortilink, etc.)
 *   - serial-match candidates with multiple inventory hits (ambiguous)
 *   - hostname-match candidates with multiple inventory hits (ambiguous)
 *   - self-loops (asset's own serial would match its own truncation)
 */
export async function inferInterfaceTopology(
  seedAssetIds: string[],
): Promise<InterfaceInferenceResult> {
  if (seedAssetIds.length === 0) {
    return { edges: [], remoteAssets: new Map() };
  }

  // Latest AssetInterfaceSample per (assetId, ifName) for the seed set.
  // DISTINCT ON requires the ORDER BY to start with the same columns.
  // The Prisma model name is `AssetInterfaceSample` but the underlying
  // table is `asset_interface_samples` via the @@map in schema.prisma.
  const interfaceRows = await prisma.$queryRaw<
    Array<{ assetId: string; ifName: string; ifType: string | null }>
  >`
    SELECT DISTINCT ON ("assetId", "ifName") "assetId", "ifName", "ifType"
    FROM asset_interface_samples
    WHERE "assetId" = ANY(${seedAssetIds}::uuid[])
    ORDER BY "assetId", "ifName", "timestamp" DESC
  `;

  type Candidate = {
    sourceAssetId: string;
    ifName: string;
    parsed: ParsedPeerInterface;
  };
  const candidates: Candidate[] = [];
  for (const row of interfaceRows) {
    const parsed = parseFortinetPeerInterface(row.ifName);
    if (parsed) {
      candidates.push({ sourceAssetId: row.assetId, ifName: row.ifName, parsed });
    }
  }
  if (candidates.length === 0) {
    return { edges: [], remoteAssets: new Map() };
  }

  // Pull every Fortinet infrastructure asset's identity once. Inventory
  // is small (hundreds at most) so an in-memory scan per candidate is
  // cheaper than per-candidate SQL.
  const inventory = await prisma.asset.findMany({
    where: {
      assetType: { in: ["firewall", "switch", "access_point"] },
    },
    select: {
      id: true,
      hostname: true,
      serialNumber: true,
      ipAddress: true,
      assetType: true,
      manufacturer: true,
      model: true,
    },
  });

  type Inv = (typeof inventory)[number];

  const seedSet = new Set(seedAssetIds);
  const edges: InterfaceInferredEdge[] = [];
  const remoteAssets = new Map<string, InterfaceInferredRemote>();
  const emitted = new Set<string>();

  for (const c of candidates) {
    // Try serial match first — FortiOS-auto path, deterministic.
    const serialMatches = inventory.filter((a) =>
      serialMatchesPeerInterface(c.parsed, a.serialNumber),
    );

    let matched: Inv | null = null;
    let matchVia: "serial" | "hostname" = "serial";

    if (serialMatches.length === 1) {
      matched = serialMatches[0];
      matchVia = "serial";
    } else if (serialMatches.length === 0) {
      // Operator-named aggregate — fall back to hostname match.
      const hostnameMatches = inventory.filter((a) =>
        hostnameMatchesPeerInterface(c.parsed, a.hostname),
      );
      if (hostnameMatches.length === 1) {
        matched = hostnameMatches[0];
        matchVia = "hostname";
      } else {
        // 0 hits: probably a generic port name we let through the loose
        // pattern (e.g. `8FFTV23025884` with no matching peer in inventory).
        // >1 hits: ambiguous; refuse rather than draw a misleading edge.
        continue;
      }
    } else {
      // >1 serial match — extremely unlikely (would require multiple
      // inventory rows whose serials all end with the same fragment) but
      // skip rather than guess.
      continue;
    }

    if (!matched) continue;
    if (matched.id === c.sourceAssetId) continue;

    const dedupeKey = `${c.sourceAssetId}|${matched.id}`;
    const reverseKey = `${matched.id}|${c.sourceAssetId}`;
    if (emitted.has(dedupeKey) || emitted.has(reverseKey)) continue;
    emitted.add(dedupeKey);

    edges.push({
      sourceAssetId: c.sourceAssetId,
      sourceIfName: c.ifName,
      targetAssetId: matched.id,
      matchVia,
      aggregateIndex: c.parsed.aggregateIndex,
    });

    if (!seedSet.has(matched.id)) {
      remoteAssets.set(matched.id, {
        id: matched.id,
        hostname: matched.hostname,
        serialNumber: matched.serialNumber,
        ipAddress: matched.ipAddress,
        assetType: matched.assetType,
        manufacturer: matched.manufacturer,
        model: matched.model,
      });
    }
  }

  return { edges, remoteAssets };
}
