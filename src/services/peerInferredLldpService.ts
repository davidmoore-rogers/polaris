// Peer-inferred LLDP neighbor synthesis.
//
// Real LLDP scrapes (FortiOS REST or SNMP) populate `AssetLldpNeighbor`,
// but some links never make it into that table — most notably FortiSwitch
// ports facing managed FortiAPs: the AP reports its uplink to the FortiGate
// via /api/v2/monitor/wifi/managed_ap (captured during FMG/FortiGate
// discovery into `Asset.fortinetTopology.parentSwitch` + `parentPort`),
// but the FortiSwitch's own SNMP LLDP-MIB doesn't re-publish the neighbor
// in managed/FortiLink mode.
//
// This service synthesizes neighbor entries at read time from
// `Asset.fortinetTopology` so the System tab's Neighbor column reflects
// the topology Polaris already knows about. Results are merged into the
// real LLDP set by route handlers via `mergeInferredNeighbors`.
//
// Three cases produce inferred rows:
//   1. Asset is a FortiSwitch → emit a row on the switch's `parentPort`
//      for every FortiAP that names this switch as `parentSwitch`.
//   2. Asset is a FortiGate → emit a row on the FortiGate's
//      `uplinkInterface` for every FortiSwitch that names this FortiGate
//      as `controllerFortigate`. (`uplinkInterface` on a switch is the
//      FortiGate-side interface from `fgt_peer_intf_name`, not the
//      switch's own port.)
//   3. Asset is a FortiAP → emit a row on the AP's own `uplinkInterface`
//      (lan1 / wbh0 / ...) pointing at its `parentSwitch`. Covers the
//      case where REST LLDP came back empty but we still know who the
//      AP is plugged into.
//
// Direct-attached FortiAPs (controllerFortigate set, no parentSwitch) are
// intentionally skipped — we'd need to know the FortiGate's physical port
// and `uplinkInterface` on the AP is its OWN port, not the FortiGate's.

import { prisma } from "../db.js";

interface FortinetTopology {
  role?: string;
  controllerFortigate?: string;
  parentSwitch?: string;
  parentPort?: string;
  uplinkInterface?: string;
}

export interface InferredLldpNeighbor {
  localIfName: string;
  chassisIdSubtype: null;
  chassisId: null;
  portIdSubtype: null;
  portId: string | null;
  portDescription: null;
  systemName: string | null;
  systemDescription: string | null;
  managementIp: string | null;
  capabilities: string[];
  source: "peer-inferred";
  firstSeen: Date;
  lastSeen: Date;
  matchedAsset: {
    id: string;
    hostname: string | null;
    ipAddress: string | null;
    assetType: string;
  };
}

const PEER_SELECT = {
  id: true,
  hostname: true,
  ipAddress: true,
  assetType: true,
  model: true,
  fortinetTopology: true,
} as const;

export async function buildInferredNeighborsForAsset(assetId: string): Promise<InferredLldpNeighbor[]> {
  const self = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { id: true, hostname: true, assetType: true, fortinetTopology: true },
  });
  if (!self || !self.hostname) return [];
  const selfFt = (self.fortinetTopology as FortinetTopology | null) ?? null;

  const now = new Date();
  const inferred: InferredLldpNeighbor[] = [];

  if (self.assetType === "switch") {
    const aps = await prisma.asset.findMany({
      where: {
        assetType: "access_point",
        fortinetTopology: { path: ["parentSwitch"], equals: self.hostname },
      },
      select: PEER_SELECT,
    });
    for (const ap of aps) {
      const apFt = (ap.fortinetTopology as FortinetTopology | null) ?? null;
      const parentPort = apFt?.parentPort;
      if (!parentPort) continue;
      inferred.push({
        localIfName: parentPort,
        chassisIdSubtype: null,
        chassisId: null,
        portIdSubtype: null,
        portId: apFt?.uplinkInterface ?? null,
        portDescription: null,
        systemName: ap.hostname,
        systemDescription: ap.model ? `FortiAP-${ap.model}` : null,
        managementIp: ap.ipAddress,
        capabilities: ["wlan-access-point"],
        source: "peer-inferred",
        firstSeen: now,
        lastSeen: now,
        matchedAsset: {
          id: ap.id,
          hostname: ap.hostname,
          ipAddress: ap.ipAddress,
          assetType: ap.assetType,
        },
      });
    }
  } else if (self.assetType === "firewall") {
    const switches = await prisma.asset.findMany({
      where: {
        assetType: "switch",
        fortinetTopology: { path: ["controllerFortigate"], equals: self.hostname },
      },
      select: PEER_SELECT,
    });
    for (const sw of switches) {
      const swFt = (sw.fortinetTopology as FortinetTopology | null) ?? null;
      const fgInterface = swFt?.uplinkInterface;
      if (!fgInterface) continue;
      inferred.push({
        localIfName: fgInterface,
        chassisIdSubtype: null,
        chassisId: null,
        portIdSubtype: null,
        portId: null,
        portDescription: null,
        systemName: sw.hostname,
        systemDescription: sw.model ? `FortiSwitch-${sw.model}` : null,
        managementIp: sw.ipAddress,
        capabilities: ["bridge"],
        source: "peer-inferred",
        firstSeen: now,
        lastSeen: now,
        matchedAsset: {
          id: sw.id,
          hostname: sw.hostname,
          ipAddress: sw.ipAddress,
          assetType: sw.assetType,
        },
      });
    }
  } else if (self.assetType === "access_point") {
    const parentSwitchName = selfFt?.parentSwitch;
    const apLocalPort = selfFt?.uplinkInterface;
    if (parentSwitchName && apLocalPort) {
      const sw = await prisma.asset.findFirst({
        where: { hostname: parentSwitchName, assetType: "switch" },
        select: PEER_SELECT,
      });
      if (sw) {
        inferred.push({
          localIfName: apLocalPort,
          chassisIdSubtype: null,
          chassisId: null,
          portIdSubtype: null,
          portId: selfFt?.parentPort ?? null,
          portDescription: null,
          systemName: sw.hostname,
          systemDescription: sw.model ? `FortiSwitch-${sw.model}` : null,
          managementIp: sw.ipAddress,
          capabilities: ["bridge"],
          source: "peer-inferred",
          firstSeen: now,
          lastSeen: now,
          matchedAsset: {
            id: sw.id,
            hostname: sw.hostname,
            ipAddress: sw.ipAddress,
            assetType: sw.assetType,
          },
        });
      }
    }
  }

  return inferred;
}

// Drop any inferred neighbor that's already covered by a real LLDP row
// on the same (assetId, localIfName, matchedAssetId). Real LLDP wins;
// inferred fills the gap. A real row with no matchedAsset.id does not
// suppress inferred rows for that port — different peers on shared media.
export function dedupeInferredNeighbors<T extends { localIfName: string | null; matchedAsset?: { id: string } | null }>(
  real: T[],
  inferred: InferredLldpNeighbor[],
): InferredLldpNeighbor[] {
  const realKeys = new Set<string>();
  for (const r of real) {
    if (r.matchedAsset?.id && r.localIfName) {
      realKeys.add(`${r.localIfName}|${r.matchedAsset.id}`);
    }
  }
  return inferred.filter((i) => !realKeys.has(`${i.localIfName}|${i.matchedAsset.id}`));
}
