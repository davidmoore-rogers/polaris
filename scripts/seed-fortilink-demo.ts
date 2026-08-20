/**
 * scripts/seed-fortilink-demo.ts — local-dev demo for the FortiSwitch
 * trunk-member topology resolution (feature/fortiswitch-trunk-member).
 *
 * Fabricates the exact scenario from the screenshot so the Device Map
 * FortiLink edge tooltip can be eyeballed WITHOUT a live FortiGate:
 *
 *   RIVERBEND-101F-1 (FortiGate)  ──fortilink──  RIVERBEND-248E-3 (FortiSwitch)
 *
 *   - FG port14  ↔  switch FortiLink uplink trunk "G101FTK23000001" (= serial)
 *   - the trunk's sole physical member is port52
 *
 * What it seeds:
 *   - a FortiGate asset (firewall, with lat/long so it shows on /map/sites)
 *   - a FortiSwitch asset whose fortinetTopology.controllerFortigate points at
 *     the FortiGate and whose uplinkInterface is the serial-named trunk
 *   - AssetInterfaceSample rows (timestamped NOW so they pass the topology
 *     endpoint's 1-hour freshness window): FG port14; switch trunk
 *     "G101FTK23000001" (ifType=aggregate) + port52 (ifType=physical,
 *     ifParent=trunk) — this is the post-overlay state monitoringService
 *     would produce against a real device
 *   - one FG→switch LLDP neighbor (localIfName=port14) so the controller
 *     edge's FG-side backfills to port14, matching the screenshot
 *
 * Result in the UI: hover the fortilink edge → tooltip shows
 *   RIVERBEND-101F-1: port14 · 1 Gbps · up
 *   RIVERBEND-248E-3: port52 · 1 Gbps · up      ← was the opaque serial trunk
 *
 * Idempotent: deletes any prior demo rows (by the two hostnames) first.
 * Refuses to run when NODE_ENV=production.
 *
 * Run:  DATABASE_URL=... node --import tsx/esm scripts/seed-fortilink-demo.ts
 */

import { prisma } from "../src/db.js";

const FG_HOST = "RIVERBEND-101F-1";
const SW_HOST = "RIVERBEND-248E-3";
const SW_SERIAL = "G101FTK23000001"; // the FortiLink uplink trunk is auto-named after this
const FG_SERIAL = "FG101FTK20000001";
const GBPS = 1_000_000_000n;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed demo data: NODE_ENV=production.");
    process.exit(1);
  }

  console.log(`Seeding FortiLink trunk demo (${FG_HOST} ⇄ ${SW_HOST})...`);

  // ── Idempotency: clear any prior demo rows ───────────────────────────────
  const prior = await prisma.asset.findMany({
    where: { hostname: { in: [FG_HOST, SW_HOST] } },
    select: { id: true },
  });
  const priorIds = prior.map((a) => a.id);
  if (priorIds.length > 0) {
    await prisma.assetInterfaceSample.deleteMany({ where: { assetId: { in: priorIds } } });
    await prisma.assetLldpNeighbor.deleteMany({ where: { assetId: { in: priorIds } } });
    await prisma.assetLldpNeighbor.deleteMany({ where: { matchedAssetId: { in: priorIds } } });
    await prisma.asset.deleteMany({ where: { id: { in: priorIds } } });
    console.log(`  cleared ${priorIds.length} prior demo asset(s) + their samples/LLDP`);
  }

  const now = new Date();

  // ── FortiGate (the "site") ───────────────────────────────────────────────
  const fg = await prisma.asset.create({
    data: {
      hostname: FG_HOST,
      serialNumber: FG_SERIAL,
      assetType: "firewall",
      status: "active",
      manufacturer: "Fortinet",
      model: "FortiGate-101F",
      os: "FortiOS",
      ipAddress: "10.101.0.1",
      latitude: 40.71,   // arbitrary — just needs to be non-null to render as a site
      longitude: -74.01,
      monitored: true,
      lastSeen: now,
      learnedLocation: "Riverbend",
      createdBy: "system:fortilink-demo",
      fortinetTopology: { role: "fortigate" },
    },
  });

  // ── FortiSwitch (controlled by the FortiGate via FortiLink) ──────────────
  const sw = await prisma.asset.create({
    data: {
      hostname: SW_HOST,
      serialNumber: SW_SERIAL,
      assetType: "switch",
      status: "active",
      manufacturer: "Fortinet",
      model: "FortiSwitch-248E-FPOE",
      os: "FortiSwitch",
      ipAddress: "10.101.0.2",
      monitored: true,
      lastSeen: now,
      learnedLocation: "Riverbend",
      createdBy: "system:fortilink-demo",
      fortinetTopology: {
        role: "fortiswitch",
        controllerFortigate: FG_HOST,
        // The switch's view of its uplink — FortiOS reports the serial-named
        // FortiLink trunk here (managed-switch/status.fgt_peer_intf_name).
        uplinkInterface: SW_SERIAL,
      },
    },
  });

  // ── Interface samples (timestamped NOW → inside the 1h topology window) ──
  // FG side: the physical uplink port.
  // Switch side: the serial-named trunk (aggregate) + its sole physical
  // member port52 (ifParent → trunk). This is exactly what
  // monitoringService.overlayFortiswitchTrunkMembers produces against a real
  // FortiGate; here we seed it directly so the map.ts ifDetail swap fires.
  await prisma.assetInterfaceSample.createMany({
    data: [
      { assetId: fg.id, ifName: "port14", ifType: "physical", operStatus: "up", speedBps: GBPS, timestamp: now },
      { assetId: sw.id, ifName: SW_SERIAL, ifType: "aggregate", operStatus: "up", speedBps: GBPS, timestamp: now },
      { assetId: sw.id, ifName: "port52", ifType: "physical", ifParent: SW_SERIAL, operStatus: "up", speedBps: GBPS, timestamp: now },
    ],
  });

  // ── LLDP neighbor: FG sees the switch on port14 ──────────────────────────
  // The topology endpoint backfills the controller edge's FG-side "unknown"
  // half from this localIfName, so the tooltip shows port14 on the FG side.
  await prisma.assetLldpNeighbor.create({
    data: {
      assetId: fg.id,
      localIfName: "port14",
      matchedAssetId: sw.id,
      systemName: SW_HOST,
      chassisId: SW_SERIAL,
      chassisIdSubtype: "macAddress",
      source: "fortios",
      firstSeen: now,
      lastSeen: now,
    },
  });

  console.log("Done. Open the Device Map, click the RIVERBEND-101F-1 site,");
  console.log("open its topology, and hover the 'fortilink' edge:");
  console.log(`  ${FG_HOST}: port14 · 1 Gbps · up`);
  console.log(`  ${SW_HOST}: port52 · 1 Gbps · up   (resolved from trunk ${SW_SERIAL})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
