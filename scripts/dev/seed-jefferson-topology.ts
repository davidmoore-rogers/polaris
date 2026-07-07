/**
 * scripts/dev/seed-jefferson-topology.ts — JEFFERSON demo site for the
 * Device Map quotient layout.
 *
 * Recreates the real-world JEFFERSON-101F-1 site shape (one FortiGate, ~28
 * managed FortiSwitches daisy-chained across Scale House / QC Lab / Hoist /
 * Pugmill / Mine buildings, ~25 FortiAPs, three FortiLink-fallback switches)
 * with a:/b:/f:/r:/jb: location codes in each asset's description, so the
 * topology modal exercises grouping hulls, floor views, and the quotient
 * layout against a realistic fleet.
 *
 * Edge mechanics (matching what real discovery produces):
 *   - FG→switch + switch→switch links = AssetInterfaceSample rows whose
 *     ifName encodes the PEER's serial fragment ("<serial13>-0"), which
 *     interfaceTopologyService.inferInterfaceTopology resolves into
 *     interface edges. NOTE: the inference only reads samples < 1 hour old —
 *     re-run this script when the map goes edge-less.
 *   - AP uplinks = fortinetTopology.parentSwitch/parentPort.
 *   - Wireless mesh (Hoist, Wash Plant) = an AssetWirelessStation row on the
 *     mesh ROOT AP matched to the leaf AP + meshUplink:"mesh" on the leaf.
 *   - The three fallback switches carry only the controller link (no
 *     samples), so they exile to the negative columns like the real ones.
 *
 * Idempotent: wipes assets tagged `jefferson-demo` first. Dev-only.
 *
 * Run (containerized dev stack):
 *   podman compose -p polaris -f compose.dev.yml exec app \
 *     node --env-file=.env --import tsx/esm scripts/dev/seed-jefferson-topology.ts
 */

import { prisma } from "../../src/db.js";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo topology with NODE_ENV=production.");
  process.exit(1);
}

const FG_NAME = "JEFFERSON-101F-1";
const DEMO_TAG = "jefferson-demo";

type SwitchDef = {
  name: string;
  desc: string;          // location codes
  parent?: string;       // upstream switch (or FG) — becomes an interface-inferred link
  fallback?: boolean;    // FortiLink fallback: controller edge only, no samples
  model?: string;
};
type ApDef = {
  name: string;
  desc: string;
  parent?: string;       // wired uplink switch
  port?: string;
  meshParent?: string;   // mesh ROOT AP name (wireless backhaul instead of wired)
  model?: string;
};

const SWITCHES: SwitchDef[] = [
  // ── Scale House ──
  { name: "JEFFERSON-248E-1", desc: "b:Scale House r:Wiring Closet", parent: FG_NAME, model: "FortiSwitch-248E" },
  { name: "JEFFERSON-248E-3", desc: "b:Scale House r:Wiring Closet", parent: FG_NAME, model: "FortiSwitch-248E" },
  { name: "JEFF-112D-11", desc: "b:Scale House r:Outside jb:Entrace Reader Board", parent: "JEFFERSON-248E-1" },
  { name: "JEFFERSON-108F-1", desc: "b:Scale House r:Outside jb:Scale", parent: "JEFFERSON-248E-1", model: "FortiSwitch-108F" },
  { name: "JEFFERSON-108E-1", desc: "b:Scale House r:Weigh Room", parent: "JEFFERSON-248E-3", model: "FortiSwitch-108E" },
  // ── Pugmill ──
  { name: "JEFFERSON-112D-1", desc: "b:Pugmill r:Building", parent: "JEFFERSON-248E-3" },
  { name: "JEFFERSON-112D-2", desc: "b:Pugmill r:Scale", parent: "JEFFERSON-112D-1" },
  // ── Mine / Surface ──
  { name: "JEFFERSON-108F-3", desc: "b:Mine f:Surface r:Aaron Saline's Office", parent: "JEFFERSON-248E-3", model: "FortiSwitch-108F" },
  { name: "JEFFERSON-112D-7", desc: "b:Mine f:Surface r:Fuel Station", parent: "JEFFERSON-108F-3" },
  { name: "JEFFERSON-108F-SMCC", desc: "b:Mine f:Surface r:MCC", parent: "JEFFERSON-112D-7", model: "FortiSwitch-108F" },
  { name: "JEFFERSON-112F-2", desc: "b:Mine f:Surface r:Tower 1", parent: "JEFFERSON-108F-SMCC", model: "FortiSwitch-112F" },
  { name: "JEFFERSON-108E-3", desc: "b:Mine f:Surface r:Shop", parent: "JEFFERSON-108F-SMCC", model: "FortiSwitch-108E" },
  { name: "JEFFERSON-112F-7", desc: "b:Mine f:Surface jb:Cow Lake", parent: "JEFFERSON-108E-3", model: "FortiSwitch-112F" },
  { name: "JEFFERSON-112D-3", desc: "b:Mine f:Surface r:Behind DGA Tunnel", parent: "JEFFERSON-248E-3" },
  { name: "JEFF-112D-15", desc: "b:Mine f:Surface r:Cinderblock Building", parent: "JEFFERSON-112D-3" },
  { name: "JEFF-112D-12", desc: "b:Mine f:Surface jb:UG1 Head", parent: "JEFF-112D-15" },
  { name: "JEFFERSON-112F-WASHPLANT", desc: "b:Mine f:Surface jb:Wash Plant", parent: "JEFF-112D-12", model: "FortiSwitch-112F" },
  { name: "JEFFERSON-112F-1", desc: "b:Mine f:Surface jb:Wash Plant MCC", parent: "JEFFERSON-112F-WASHPLANT", model: "FortiSwitch-112F" },
  { name: "JEFFERSON-112D-9", desc: "b:Mine f:Surface jb:Mud Lake", parent: "JEFF-112D-12" },
  // ── Mine / Slope ──
  { name: "JEFF-112D-19", desc: "b:Mine f:Slope jb:Switchback", parent: "JEFF-112D-15" },
  { name: "JEFF-112D-18", desc: "b:Mine f:Slope jb:Slope", parent: "JEFF-112D-19" },
  { name: "JEFF-112D-14", desc: "b:Mine f:Slope jb:Tail of 5", parent: "JEFF-112D-18" },
  // ── Mine / Camp Nelson ──
  { name: "JEFF-112D-17", desc: "b:Mine f:Camp Nelson jb:Fuel Station", parent: "JEFF-112D-15" },
  { name: "JEFF-112D-16", desc: "b:Mine f:Camp Nelson jb:Valke Shack", parent: "JEFF-112D-17" },
  { name: "JEFF-112D-21", desc: "b:Mine f:Camp Nelson r:Crusher Booth", parent: "JEFF-112D-16" },
  { name: "JEFF-112D-13", desc: "b:Mine f:Camp Nelson r:Office", parent: "JEFF-112D-21" },
  { name: "JEFF-112D-22", desc: "b:Mine f:Camp Nelson jb:Main", parent: "JEFF-112D-13" },
  { name: "JEFF-112D-20", desc: "b:Mine f:Camp Nelson jb:Buffalo Pump", parent: "JEFF-112D-13" },
  // ── FortiLink fallbacks (controller edge only — exile to negative columns) ──
  { name: "JEFFERSON-112F-4", desc: "", fallback: true, model: "FortiSwitch-112F" },
  { name: "JEFFERSON-124E-1", desc: "", fallback: true, model: "FortiSwitch-124E" },
  { name: "JEFFERSON-112F-3", desc: "", fallback: true, model: "FortiSwitch-112F" },
];

const APS: ApDef[] = [
  { name: "JEFFERSON-222E-6", desc: "b:Scale House r:Wiring Closet", parent: "JEFFERSON-248E-1", port: "port10", model: "FortiAP-222E" },
  { name: "JEFFERSON-231F-1", desc: "b:Scale House r:Wiring Closet", parent: "JEFFERSON-248E-1", port: "port44", model: "FortiAP-231F" },
  { name: "JEFFERSON-432F-1", desc: "b:Scale House r:Outside jb:Rear Building", parent: "JEFF-112D-11", port: "port9", model: "FortiAP-432F" },
  { name: "JEFFERSON-234F-3", desc: "b:QC Lab", parent: "JEFF-112D-11", port: "port7", model: "FortiAP-234F" },
  { name: "JEFFERSON-222E-4", desc: "b:Hoist", meshParent: "JEFFERSON-432F-1", model: "FortiAP-222E" },
  { name: "JEFFERSON-222E-7", desc: "b:Mine f:Surface r:Aaron Saline's Office", parent: "JEFFERSON-108F-3", port: "port6", model: "FortiAP-222E" },
  { name: "JEFFERSON-222E-3", desc: "b:Mine f:Surface r:MCC", parent: "JEFFERSON-108F-SMCC", port: "port8", model: "FortiAP-222E" },
  { name: "JEFFERSON-23JF-2", desc: "b:Mine f:Surface r:MCC", parent: "JEFFERSON-108F-SMCC", port: "port2", model: "FortiAP-23JF" },
  { name: "JEFFERSON-222E-8", desc: "b:Mine f:Surface r:Shop", parent: "JEFFERSON-108E-3", port: "port6", model: "FortiAP-222E" },
  { name: "JEFFERSON-234F-4", desc: "b:Mine f:Surface jb:Cow Lake", parent: "JEFFERSON-112F-7", port: "port5", model: "FortiAP-234F" },
  { name: "JEFFERSON-234F-1", desc: "b:Mine f:Surface r:Cinderblock Building", parent: "JEFF-112D-15", port: "port8", model: "FortiAP-234F" },
  { name: "JEFFERSON-432F-2", desc: "b:Mine f:Surface jb:UG1 Head", parent: "JEFF-112D-12", port: "port1", model: "FortiAP-432F" },
  { name: "JEFF-432F-WASH", desc: "b:Mine f:Surface jb:Wash Plant", meshParent: "JEFFERSON-432F-2", model: "FortiAP-432F" },
  { name: "JEFFERSON-231K-2", desc: "b:Mine f:Surface jb:Wash Plant MCC", parent: "JEFFERSON-112F-1", port: "port5", model: "FortiAP-231K" },
  { name: "JEFFERSON-222E-9", desc: "b:Mine f:Surface jb:Mud Lake", parent: "JEFFERSON-112D-9", port: "port7", model: "FortiAP-222E" },
  { name: "JEFFERSON-224E-2", desc: "b:Mine f:Slope jb:Switchback", parent: "JEFF-112D-19", port: "port2", model: "FortiAP-224E" },
  { name: "JEFFERSON-224E-1", desc: "b:Mine f:Slope jb:Slope", parent: "JEFF-112D-18", port: "port8", model: "FortiAP-224E" },
  { name: "JEFFERSON-224E-3", desc: "b:Mine f:Slope jb:Tail of 5", parent: "JEFF-112D-14", port: "port1", model: "FortiAP-224E" },
  { name: "JEFFERSON-234F-2", desc: "b:Mine f:Camp Nelson jb:Fuel Station", parent: "JEFF-112D-17", port: "port2", model: "FortiAP-234F" },
  { name: "JEFFERSON-224E-5", desc: "b:Mine f:Camp Nelson jb:Valke Shack", parent: "JEFF-112D-16", port: "port1", model: "FortiAP-224E" },
  { name: "JEFFERSON-224E-6", desc: "b:Mine f:Camp Nelson jb:Service Bay", parent: "JEFF-112D-16", port: "port2", model: "FortiAP-224E" },
  { name: "JEFFERSON-23JF-1", desc: "b:Mine f:Camp Nelson r:Crusher Booth", parent: "JEFF-112D-21", port: "port8", model: "FortiAP-23JF" },
  { name: "JEFFERSON-224E-7", desc: "b:Mine f:Camp Nelson r:Office", parent: "JEFF-112D-13", port: "port8", model: "FortiAP-224E" },
  { name: "JEFFERSON-231F-2", desc: "b:Mine f:Camp Nelson jb:Main", parent: "JEFF-112D-22", port: "port1", model: "FortiAP-231F" },
  { name: "JEFFERSON-224E-8", desc: "b:Mine f:Camp Nelson jb:Buffalo Pump", parent: "JEFF-112D-20", port: "port5", model: "FortiAP-224E" },
];

// 13-char uppercase serials — the peer-aggregate interface name is
// "<serial>-0" (15 chars, inside the ifname limit) and inferInterfaceTopology
// resolves it via serialMatchesPeerInterface (endsWith, case-insensitive).
const serialOf = new Map<string, string>();
function assignSerial(name: string, i: number): string {
  const s = "SJFDEMO" + String(i).padStart(6, "0");
  serialOf.set(name, s);
  return s;
}
function peerIfName(peer: string): string {
  return serialOf.get(peer)! + "-0";
}
function macOf(i: number): string {
  const hex = i.toString(16).padStart(4, "0").toUpperCase();
  return `DE:AD:5F:00:${hex.slice(0, 2)}:${hex.slice(2)}`;
}

async function main() {
  console.log("Seeding JEFFERSON demo topology…");

  // Idempotent wipe: everything tagged jefferson-demo (cascades cover the
  // side tables that matter; interface samples are hypertable rows keyed by
  // assetId only — the new asset ids won't match, and the 1-hour inference
  // window ages the old rows out anyway).
  const stale = await prisma.asset.findMany({ where: { tags: { has: DEMO_TAG } }, select: { id: true } });
  if (stale.length) {
    await prisma.asset.deleteMany({ where: { id: { in: stale.map((a) => a.id) } } });
    console.log(`  wiped ${stale.length} previous demo assets`);
  }

  let serialIdx = 1;
  let ipIdx = 10;
  const idOf = new Map<string, string>();

  // FortiGate
  const fgSerial = assignSerial(FG_NAME, serialIdx++);
  const fg = await prisma.asset.create({
    data: {
      hostname: FG_NAME,
      ipAddress: "10.90.0.1",
      assetType: "firewall",
      status: "active",
      manufacturer: "Fortinet",
      model: "FortiGate-101F",
      serialNumber: fgSerial,
      description: "b:Scale House r:Wiring Closet",
      // Coordinates so the Device Map renders a clickable site pin.
      latitude: 38.1934,
      longitude: -85.7096,
      fortinetTopology: { role: "fortigate" },
      tags: [DEMO_TAG],
      notes: "JEFFERSON quotient-layout demo (seed script)",
    },
  });
  idOf.set(FG_NAME, fg.id);

  for (const sw of SWITCHES) {
    const serial = assignSerial(sw.name, serialIdx++);
    const a = await prisma.asset.create({
      data: {
        hostname: sw.name,
        ipAddress: `10.90.1.${ipIdx++}`,
        assetType: "switch",
        status: "active",
        manufacturer: "Fortinet",
        model: sw.model || "FortiSwitch-112D",
        serialNumber: serial,
        description: sw.desc || null,
        fortinetTopology: {
          role: "fortiswitch",
          controllerFortigate: FG_NAME,
          uplinkInterface: "fortilink",
        },
        tags: [DEMO_TAG],
      },
    });
    idOf.set(sw.name, a.id);
  }

  for (const ap of APS) {
    const serial = assignSerial(ap.name, serialIdx++);
    const a = await prisma.asset.create({
      data: {
        hostname: ap.name,
        ipAddress: `10.90.2.${ipIdx++}`,
        assetType: "access_point",
        status: "active",
        manufacturer: "Fortinet",
        model: ap.model || "FortiAP-224E",
        serialNumber: serial,
        description: ap.desc || null,
        fortinetTopology: {
          role: "fortiap",
          controllerFortigate: FG_NAME,
          ...(ap.parent ? { parentSwitch: ap.parent, parentPort: ap.port || "port1", peerSource: "lldp" } : {}),
          ...(ap.meshParent
            ? { meshUplink: "mesh", parentApSerial: serialOf.get(ap.meshParent) }
            : { meshUplink: "ethernet" }),
          uplinkInterface: "lan1",
        },
        tags: [DEMO_TAG],
      },
    });
    idOf.set(ap.name, a.id);
  }

  // Interface samples for the switch fabric: each chained device carries an
  // aggregate named for its parent's serial, and the parent carries the
  // reciprocal — inferInterfaceTopology then draws one verified edge per
  // link (and the FG→chain-head edges dedupe into verified controller edges).
  const now = new Date();
  const samples: Array<{ assetId: string; ifName: string; timestamp: Date; ifType: string; operStatus: string }> = [];
  for (const sw of SWITCHES) {
    if (!sw.parent || sw.fallback) continue;
    samples.push({ assetId: idOf.get(sw.name)!, ifName: peerIfName(sw.parent), timestamp: now, ifType: "aggregate", operStatus: "up" });
    samples.push({ assetId: idOf.get(sw.parent)!, ifName: peerIfName(sw.name), timestamp: now, ifType: "aggregate", operStatus: "up" });
  }
  await prisma.assetInterfaceSample.createMany({ data: samples });

  // Mesh backhauls: leaf AP appears as a matched wireless station on its
  // root AP → the renderer draws the violet mesh edge root → leaf.
  let macIdx = 1;
  for (const ap of APS) {
    if (!ap.meshParent) continue;
    await prisma.assetWirelessStation.create({
      data: {
        apAssetId: idOf.get(ap.meshParent)!,
        staMacAddr: macOf(macIdx++),
        matchedAssetId: idOf.get(ap.name)!,
        ssid: "RGMesh",
        source: "seed",
        firstSeen: now,
        lastSeen: now,
      },
    });
  }

  console.log(`  created 1 FortiGate, ${SWITCHES.length} switches, ${APS.length} APs, ${samples.length} interface samples`);
  console.log("Done. Open the Device Map and click the JEFFERSON-101F-1 site.");
  console.log("(Interface-inferred edges read samples < 1h old — re-run this script if the map loses its switch links.)");
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
