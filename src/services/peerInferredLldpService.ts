// Peer-inferred LLDP neighbor synthesis.
//
// Real LLDP scrapes (FortiOS REST, SNMP, or the managed_ap `lldp` table
// persisted per discovery run via
// monitoringService.persistManagedApLldpNeighbors, source "managed-ap")
// populate `AssetLldpNeighbor`, but some links never make it into that
// table — most notably FortiSwitch ports facing managed FortiAPs: the AP
// reports its uplink to the FortiGate via /api/v2/monitor/wifi/managed_ap
// (captured during FMG/FortiGate discovery into
// `Asset.fortinetTopology.parentSwitch` + `parentPort`), but the
// FortiSwitch's own SNMP LLDP-MIB doesn't re-publish the neighbor in
// managed/FortiLink mode.
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
//      (lan1 / wbh0 / ...) pointing at its `parentSwitch`. Since the
//      managed-ap persist landed this mostly covers APs whose firmware
//      omits the `lldp` array from managed_ap (or whose discovery hasn't
//      re-run yet) — real "managed-ap" rows dedupe it away otherwise.
//
// Direct-attached FortiAPs (controllerFortigate set, no parentSwitch) are
// intentionally skipped — we'd need to know the FortiGate's physical port
// and `uplinkInterface` on the AP is its OWN port, not the FortiGate's.

import { prisma } from "../db.js";
import { normalizeFortiapInterfaceName } from "../utils/fortiapInterfaceAlias.js";
import { inferDirectAttachments, type MatchedFdbEntry } from "../utils/macForwarding.js";
import {
  controllerStampWhereOr,
  topologyStampWhereOr,
  readFirewallDeviceName,
} from "../utils/fortinetParentKey.js";

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
  /**
   * Which inference produced the row. "peer-inferred" is derived from
   * Asset.fortinetTopology (what Polaris already knows about the fabric);
   * "mac-inferred" is derived from the switch's own forwarding database and
   * therefore covers links no Fortinet topology stamp describes.
   */
  source: "peer-inferred" | "mac-inferred" | "trunk-mapped";
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
    select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true },
  });
  // Either identity is enough to find peers — the stamps below are matched
  // serial-first with the name as fallback (utils/fortinetParentKey.ts), so a
  // hostname-less asset with a serial is no longer a dead end.
  if (!self || (!self.hostname && !self.serialNumber)) return [];
  const selfFt = (self.fortinetTopology as FortinetTopology | null) ?? null;

  const now = new Date();
  const inferred: InferredLldpNeighbor[] = [];

  if (self.assetType === "switch") {
    // An AP stamps parentSwitch from its own LLDP table, which reports the
    // switch's system name — usually the switch-id (= the serial), while
    // Asset.hostname may be an operator label. Match either.
    const aps = await prisma.asset.findMany({
      where: {
        assetType: "access_point",
        AND: [{ OR: topologyStampWhereOr("parentSwitch", [self.hostname, self.serialNumber]) }],
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
        AND: [{ OR: controllerStampWhereOr({
          hostname: self.hostname,
          serialNumber: self.serialNumber,
          deviceName: readFirewallDeviceName(self.fortinetTopology),
        }) }],
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
      // Load the switch + the AP's most recent ifNames in parallel so we can
      // normalize lan1↔eth0 — discovery stamps uplinkInterface from the
      // FortiGate's managed_ap response (FortiAP-CLI naming like "lan1") but
      // the AP's own SNMP IF-MIB exposes the same port as "eth0". The
      // System tab interface table uses the SNMP name; an inferred row on
      // "lan1" wouldn't line up with any visible interface row. See
      // src/utils/fortiapInterfaceAlias.ts.
      const [sw, knownIfRows] = await Promise.all([
        prisma.asset.findFirst({
          where: { hostname: parentSwitchName, assetType: "switch" },
          select: PEER_SELECT,
        }),
        // Current-state inventory: needs the FULL interface set (the eth0 being
        // normalized to is typically unpinned), so it cannot read the
        // pinned-only sample table. Replaces a timestamp-ordered take:64 scan.
        prisma.assetInterface.findMany({
          where: { assetId: self.id },
          select: { ifName: true },
        }),
      ]);
      if (sw) {
        const knownIfNames = new Set(knownIfRows.map((r) => r.ifName));
        const localIfName = normalizeFortiapInterfaceName(apLocalPort, knownIfNames);
        inferred.push({
          localIfName,
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

  // Trunk-derived adjacencies. Strongest of the three: the switch NAMES its
  // peer by serial, so this is device-stated rather than inferred -- hence
  // "trunk-mapped" and not "-inferred". It also covers precisely the FortiLink
  // switch<->switch and switch<->FortiGate links LLDP does not republish in
  // managed mode, which is the gap this service exists for.
  if (self.assetType === "switch") {
    const trunks = await prisma.assetTrunkMember.findMany({
      where: { assetId, matchedAssetId: { not: null } },
      select: { localPort: true, matchedAssetId: true },
    });
    if (trunks.length > 0) {
      const peers = await prisma.asset.findMany({
        where: { id: { in: trunks.map((t) => t.matchedAssetId!) } },
        select: PEER_SELECT,
      });
      const peerById = new Map(peers.map((p) => [p.id, p]));
      for (const t of trunks) {
        const peer = peerById.get(t.matchedAssetId!);
        if (!peer) continue;
        inferred.push({
          localIfName: t.localPort,
          chassisIdSubtype: null,
          chassisId: null,
          portIdSubtype: null,
          portId: null,
          portDescription: null,
          systemName: peer.hostname,
          systemDescription: "Trunk reported by the switch (peer identified by serial)",
          managementIp: peer.ipAddress,
          capabilities: [],
          source: "trunk-mapped",
          firstSeen: now,
          lastSeen: now,
          matchedAsset: {
            id: peer.id,
            hostname: peer.hostname,
            ipAddress: peer.ipAddress,
            assetType: peer.assetType,
          },
        });
      }
    }
  }

  // MAC-derived attachments. Additive to everything above: the FDB sees links
  // no Fortinet topology stamp describes (a third-party switch, an unmanaged
  // device, a port whose neighbour speaks no LLDP), which is the whole point of
  // not inferring topology from LLDP alone.
  //
  // DISPLAY-ONLY BY DESIGN. These rows are synthesized at read time and merged
  // into the neighbour list; nothing here writes AssetLldpNeighbor, and nothing
  // here writes AssetDependencyParent. Dependency edges feed all-down
  // suppression, so a wrong edge silences real alerts — that step waits for
  // bidirectional confirmation validated against a real fleet, and is
  // deliberately not attempted from one switch's table.
  if (self.assetType === "switch") {
    const fdb = await prisma.assetMacTableEntry.findMany({
      where: { assetId, status: "learned", matchedAssetId: { not: null }, ifName: { not: null } },
      select: { ifName: true, macAddress: true, vlanId: true, basePort: true, status: true, matchedAssetId: true },
    });
    const attachments = inferDirectAttachments(fdb as MatchedFdbEntry[]);
    if (attachments.length > 0) {
      const peers = await prisma.asset.findMany({
        where: { id: { in: attachments.map((a) => a.assetId) } },
        select: PEER_SELECT,
      });
      const peerById = new Map(peers.map((p) => [p.id, p]));
      for (const att of attachments) {
        const peer = peerById.get(att.assetId);
        if (!peer) continue;
        inferred.push({
          localIfName: att.ifName,
          chassisIdSubtype: null,
          chassisId: null,
          portIdSubtype: null,
          portId: null,
          portDescription: null,
          systemName: peer.hostname,
          systemDescription: "Inferred from the MAC forwarding table (sole device learned on this port)",
          managementIp: peer.ipAddress,
          capabilities: [],
          source: "mac-inferred",
          firstSeen: now,
          lastSeen: now,
          matchedAsset: {
            id: peer.id,
            hostname: peer.hostname,
            ipAddress: peer.ipAddress,
            assetType: peer.assetType,
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
//
// `aggregateParentByMember` (member ifName → parent aggregate ifName) lets a
// real LLDP row learned on an aggregate's *member* port suppress an inferred
// row emitted on the *aggregate* itself. FortiLink is the canonical case: the
// FortiGate→FortiSwitch uplink is synthesized on the aggregate ("fortilink")
// from `fgt_peer_intf_name`, but the FortiGate's real LLDP lands on the
// physical member port ("a") — same physical link, so the learned row should
// win. We register the parent-aggregate key for every real row sitting on a
// known member port so the inferred-on-aggregate row dedupes against it.
export function dedupeInferredNeighbors<T extends { localIfName: string | null; matchedAsset?: { id: string } | null }>(
  real: T[],
  inferred: InferredLldpNeighbor[],
  aggregateParentByMember?: Map<string, string> | null,
): InferredLldpNeighbor[] {
  const realKeys = new Set<string>();
  for (const r of real) {
    if (r.matchedAsset?.id && r.localIfName) {
      realKeys.add(`${r.localIfName}|${r.matchedAsset.id}`);
      const parent = aggregateParentByMember?.get(r.localIfName);
      if (parent) realKeys.add(`${parent}|${r.matchedAsset.id}`);
    }
  }
  return inferred.filter((i) => !realKeys.has(`${i.localIfName}|${i.matchedAsset.id}`));
}

// Build a member-ifName → aggregate-ifName map from a set of interface rows.
// Only true aggregate members are included (the parent's ifType is
// "aggregate"), so VLAN sub-interfaces — which also carry `ifParent` — don't
// leak in. Shared by both LLDP-merge call sites.
export function aggregateMembershipMap(
  interfaces: { ifName: string; ifType: string | null; ifParent: string | null }[],
): Map<string, string> {
  const aggregateNames = new Set<string>();
  for (const i of interfaces) {
    if (i.ifType === "aggregate") aggregateNames.add(i.ifName);
  }
  const map = new Map<string, string>();
  for (const i of interfaces) {
    if (i.ifParent && aggregateNames.has(i.ifParent)) map.set(i.ifName, i.ifParent);
  }
  return map;
}
