/**
 * scripts/seed-topology-mock.ts — Mock multi-tier Fortinet site for validating
 * the Device Map topology column layout (Dijkstra-weighted even/odd columns).
 *
 * Run:  node --env-file=.env --import tsx/esm scripts/seed-topology-mock.ts
 *
 * Creates one FortiGate site exercising every column tier:
 *
 *   FGT-MOCK-DC1 (firewall, col 0)
 *     └─ FSW-MOCK-A1 (switch, directly cabled, col 2)
 *          └─ FSW-MOCK-A2 (switch, chained behind A1, col 4)
 *               └─ FAP-MOCK-A1 (access point, col 6)
 *                    └─ 3 wireless stations (leaf, odd col 7)
 *     plus a few wired endpoints learned on FSW-MOCK-A2 (hidden by default;
 *     appear in odd columns via the endpoint search → connection-path overlay).
 *
 * The chain edge A1↔A2 (and A1↔FG) is produced by inferInterfaceTopology from
 * AssetInterfaceSample peer-aggregate interface names that encode the peer's
 * serial. Those samples are timestamped NOW(); the inference query only looks
 * back 1 hour, so re-run this script if you validate more than an hour later.
 *
 * Idempotent: wipes any prior MOCK assets (cascades their samples/stations)
 * before recreating.
 */

import { prisma } from "../src/db.js";

const FG_HOST = "FGT-MOCK-DC1";
const SW1_HOST = "FSW-MOCK-A1";
const SW2_HOST = "FSW-MOCK-A2";
const AP_HOST = "FAP-MOCK-A1"; // mesh root (lists the leaf AP as a station)
const APB_HOST = "FAP-MOCK-A2"; // mesh leaf (wireless backhaul off A1)
const SWB_HOST = "FSW-MOCK-B1"; // FortiLink-fallback switch (no physical proof)
const SWD1_HOST = "FSW-MOCK-D1"; // sibling of A1 — same distance (col 2)
const SWD2_HOST = "FSW-MOCK-D2"; // sibling of A1 — same distance (col 2), dependency-suppressed
const SWC1_HOST = "FSW-MOCK-C1"; // FortiLink switch bridged behind FAP-MOCK-A2 (LLDP-detected)

const FG_SERIAL = "FGTMOCK00000001";
const SW1_SERIAL = "S100MOCKSWA0001";
const SW2_SERIAL = "S100MOCKSWA0002";
const AP_SERIAL = "FAPMOCK0000001";
const APB_SERIAL = "FAPMOCK0000002";
const APB_MAC = "AA:BB:CC:A2:00:02"; // leaf AP base MAC — seen as a station on A1
const SWB_SERIAL = "S100MOCKSWB0001";
const SWD1_SERIAL = "S100MOCKSWD0001";
const SWD2_SERIAL = "S100MOCKSWD0002";
const SWC1_SERIAL = "S100MOCKSWC0001";

// host → switch it's learned on. ws-01..03 hang off the verified chain (A2);
// ws-04 hangs off the fallback switch (B1) to exercise the col -3 placement.
const ENDPOINTS = [
  { host: "mock-ws-01", sw: SW2_HOST, port: 11 },
  { host: "mock-ws-02", sw: SW2_HOST, port: 12 },
  { host: "mock-ws-03", sw: SW2_HOST, port: 13 },
  { host: "mock-ws-04", sw: SWB_HOST, port: 7 },
];

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed mock topology in production.");
    process.exit(1);
  }

  const now = new Date();
  const acquired = new Date(now.getTime() - 90 * 24 * 3600 * 1000); // 90d ago

  // ── Wipe prior mock data (cascades interface samples + wireless stations) ──
  const wipeHosts = [FG_HOST, SW1_HOST, SW2_HOST, AP_HOST, APB_HOST, SWB_HOST, SWD1_HOST, SWD2_HOST, SWC1_HOST, ...ENDPOINTS.map((e) => e.host)];
  await prisma.asset.deleteMany({ where: { hostname: { in: wipeHosts } } });

  // ── FortiGate (col 0) ──────────────────────────────────────────────────
  const fg = await prisma.asset.create({
    data: {
      hostname: FG_HOST,
      serialNumber: FG_SERIAL,
      assetType: "firewall",
      manufacturer: "Fortinet",
      model: "FortiGate-100F",
      ipAddress: "10.90.0.1",
      status: "active",
      monitored: true,
      monitorStatus: "up",
      latitude: 36.1627,
      longitude: -86.7816,
      acquiredAt: acquired,
      lastSeen: now,
      fortinetTopology: { role: "fortigate" },
    },
  });

  // ── FortiSwitch A1 — directly cabled to the FortiGate (col 2) ────────────
  const sw1 = await prisma.asset.create({
    data: {
      hostname: SW1_HOST,
      serialNumber: SW1_SERIAL,
      assetType: "switch",
      manufacturer: "Fortinet",
      model: "FortiSwitch-148F",
      ipAddress: "10.90.0.11",
      status: "active",
      monitored: true,
      monitorStatus: "up",
      acquiredAt: acquired,
      lastSeen: now,
      fortinetTopology: { role: "fortiswitch", controllerFortigate: FG_HOST, uplinkInterface: "fortilink" },
    },
  });

  // ── FortiSwitch A2 — chained behind A1 (col 4) ───────────────────────────
  const sw2 = await prisma.asset.create({
    data: {
      hostname: SW2_HOST,
      serialNumber: SW2_SERIAL,
      assetType: "switch",
      manufacturer: "Fortinet",
      model: "FortiSwitch-148F",
      ipAddress: "10.90.0.12",
      status: "active",
      monitored: true,
      monitorStatus: "up",
      acquiredAt: acquired,
      lastSeen: now,
      fortinetTopology: { role: "fortiswitch", controllerFortigate: FG_HOST, uplinkInterface: "fortilink" },
    },
  });

  // ── FortiAP on A2 (col 6) ────────────────────────────────────────────────
  const ap = await prisma.asset.create({
    data: {
      hostname: AP_HOST,
      serialNumber: AP_SERIAL,
      assetType: "access_point",
      manufacturer: "Fortinet",
      model: "FortiAP-431F",
      ipAddress: "10.90.0.21",
      status: "active",
      monitored: true,
      monitorStatus: "up",
      acquiredAt: acquired,
      lastSeen: now,
      fortinetTopology: {
        role: "fortiap",
        controllerFortigate: FG_HOST,
        parentSwitch: SW2_HOST,
        parentPort: "port5",
        peerSource: "lldp",
      },
    },
  });

  // ── FortiAP A2 — wireless MESH leaf off A1. No parentSwitch (its uplink is
  //    wireless to A1), so discovery would draw a bogus FG-fallback edge; the
  //    mesh signal (A2 appears as a station on A1, seeded below) overrides it
  //    and routes A2 through A1 → col 8. ────────────────────────────────────
  const apB = await prisma.asset.create({
    data: {
      hostname: APB_HOST,
      serialNumber: APB_SERIAL,
      macAddress: APB_MAC,
      assetType: "access_point",
      manufacturer: "Fortinet",
      model: "FortiAP-431F",
      ipAddress: "10.90.0.22",
      status: "active",
      monitored: true,
      monitorStatus: "up",
      acquiredAt: acquired,
      lastSeen: now,
      fortinetTopology: { role: "fortiap", controllerFortigate: FG_HOST },
    },
  });

  // ── FortiSwitch B1 — FortiLink fallback: controller edge to the FortiGate
  //    but NO interface sample / LLDP, so its physical uplink can't be
  //    verified. Lands in column -2 (its endpoints in -3). ────────────────────
  await prisma.asset.create({
    data: {
      hostname: SWB_HOST,
      serialNumber: SWB_SERIAL,
      assetType: "switch",
      manufacturer: "Fortinet",
      model: "FortiSwitch-124F",
      ipAddress: "10.90.0.31",
      status: "active",
      monitored: true,
      monitorStatus: "up",
      acquiredAt: acquired,
      lastSeen: now,
      fortinetTopology: { role: "fortiswitch", controllerFortigate: FG_HOST, uplinkInterface: "fortilink" },
    },
  });

  // ── Sibling switches D1/D2 — both directly cabled to the FortiGate, so they
  //    share A1's weighted distance and stack in the same column (col 2). D2 is
  //    dependency-suppressed to exercise the gray "Dep. Down" node color. ──────
  const swD1 = await prisma.asset.create({
    data: {
      hostname: SWD1_HOST, serialNumber: SWD1_SERIAL, assetType: "switch",
      manufacturer: "Fortinet", model: "FortiSwitch-148F", ipAddress: "10.90.0.41",
      status: "active", monitored: true, monitorStatus: "up", acquiredAt: acquired, lastSeen: now,
      fortinetTopology: { role: "fortiswitch", controllerFortigate: FG_HOST, uplinkInterface: "fortilink" },
    },
  });
  const swD2 = await prisma.asset.create({
    data: {
      hostname: SWD2_HOST, serialNumber: SWD2_SERIAL, assetType: "switch",
      manufacturer: "Fortinet", model: "FortiSwitch-148F", ipAddress: "10.90.0.42",
      status: "active", monitored: true, monitorStatus: "up",
      dependencySuppressed: true, dependencySuppressedAt: now, // → gray node
      acquiredAt: acquired, lastSeen: now,
      fortinetTopology: { role: "fortiswitch", controllerFortigate: FG_HOST, uplinkInterface: "fortilink" },
    },
  });

  // ── FortiSwitch C1 — FortiLink-managed but physically BEHIND the mesh-leaf
  //    AP (FAP-MOCK-A2) across its wireless bridge. Discovered via LLDP (seeded
  //    below): the AP reports C1 as a neighbor on a LAN port, and C1 is not the
  //    AP's controller parent, so it's routed behind the AP and its FortiLink
  //    edge is demoted. ────────────────────────────────────────────────────────
  const swC1 = await prisma.asset.create({
    data: {
      hostname: SWC1_HOST, serialNumber: SWC1_SERIAL, assetType: "switch",
      manufacturer: "Fortinet", model: "FortiSwitch-108F", ipAddress: "10.90.0.43",
      status: "active", monitored: true, monitorStatus: "up", acquiredAt: acquired, lastSeen: now,
      fortinetTopology: { role: "fortiswitch", controllerFortigate: FG_HOST, uplinkInterface: "fortilink" },
    },
  });

  // ── Interface samples that encode the chain via peer-serial aggregates ───
  // A1 names an aggregate after the FortiGate serial (drops the leading "F");
  // A2 names one after A1's serial (drops the leading "S"). inferInterface-
  // Topology serial-matches these to draw A1↔FG and A1↔A2 edges. D1/D2 also
  // name the FortiGate serial → verified direct uplinks (same column as A1).
  const ifaceRows = [
    { assetId: sw1.id,  ifName: "GTMOCK00000001", inErrors: 0n,  outErrors: 0n }, // → FG serial FGTMOCK00000001
    { assetId: sw2.id,  ifName: "100MOCKSWA0001", inErrors: 12n, outErrors: 3n }, // → A1 serial S100MOCKSWA0001
    { assetId: swD1.id, ifName: "GTMOCK00000001", inErrors: 0n,  outErrors: 0n }, // → FG serial (direct uplink)
    { assetId: swD2.id, ifName: "GTMOCK00000001", inErrors: 0n,  outErrors: 0n }, // → FG serial (direct uplink)
  ];
  for (const r of ifaceRows) {
    await prisma.assetInterfaceSample.create({
      data: {
        assetId: r.assetId, ifName: r.ifName, ifType: "aggregate", operStatus: "up",
        speedBps: 10_000_000_000n, // 10 Gbps — exercises the tooltip speed line
        inErrors: r.inErrors, outErrors: r.outErrors,
        timestamp: now,
      },
    });
  }

  // ── Wireless stations on the AP (leaf nodes → odd column) ────────────────
  const stations = [
    { staMacAddr: "AA:BB:CC:00:00:01", staIpAddr: "10.90.5.51", ssid: "MOCK-CORP", band: "5GHz" },
    { staMacAddr: "AA:BB:CC:00:00:02", staIpAddr: "10.90.5.52", ssid: "MOCK-CORP", band: "5GHz" },
    { staMacAddr: "AA:BB:CC:00:00:03", staIpAddr: "10.90.5.53", ssid: "MOCK-GUEST", band: "2.4GHz" },
  ];
  for (const s of stations) {
    await prisma.assetWirelessStation.create({
      data: { apAssetId: ap.id, source: "snmp", lastSeen: now, ...s },
    });
  }

  // ── Mesh signal: the leaf AP (A2) shows up as a station on the root AP (A1),
  //    matched to A2's asset. The topology layer reads this as root→leaf mesh. ─
  await prisma.assetWirelessStation.create({
    data: {
      apAssetId: ap.id, // root A1's station table
      staMacAddr: APB_MAC,
      matchedAssetId: apB.id, // resolves to the leaf AP A2
      ssid: "MOCK-MESH",
      band: "5GHz",
      source: "snmp",
      lastSeen: now,
    },
  });

  // ── Bridge signal: the mesh-leaf AP (A2) reports switch C1 as an LLDP
  //    neighbor on a LAN port. C1 is not A2's controller parent → bridged switch. ─
  await prisma.assetLldpNeighbor.create({
    data: {
      assetId: apB.id, // FAP-MOCK-A2's LLDP table
      localIfName: "lan2",
      portId: "port1",
      portIdSubtype: "interfaceName",
      systemName: SWC1_HOST,
      matchedAssetId: swC1.id,
      source: "fortios",
      lastSeen: now,
    },
  });

  // ── Wired endpoints (hidden by default; searchable). ws-04 is on the
  //    fallback switch B1, so searching it should land it in column -3. ──────
  for (const e of ENDPOINTS) {
    await prisma.asset.create({
      data: {
        hostname: e.host,
        assetType: "workstation",
        manufacturer: "Dell",
        model: "OptiPlex 7090",
        ipAddress: `10.90.10.${e.port}`,
        macAddress: `AA:BB:CC:10:00:${String(e.port).padStart(2, "0")}`,
        status: "active",
        monitored: false,
        acquiredAt: acquired,
        lastSeen: now,
        lastSeenSwitch: `${e.sw}/port${e.port}`,
      },
    });
  }

  console.log("Mock topology seeded:");
  console.log(`  FortiGate    ${FG_HOST} (${fg.id})`);
  console.log(`  FortiSwitch  ${SW1_HOST} → ${SW2_HOST} (verified chain, cols 2/4)`);
  console.log(`  Same-dist sw ${SWD1_HOST}, ${SWD2_HOST} (siblings of A1 → col 2; D2 dependency-suppressed → gray)`);
  console.log(`  FortiAP      ${AP_HOST} (root) + ${stations.length} wireless stations`);
  console.log(`  Mesh leaf AP ${APB_HOST} (seen as a station on ${AP_HOST} → meshed off it)`);
  console.log(`  Bridged sw   ${SWC1_HOST} (LLDP neighbor of ${APB_HOST} → switch across the AP bridge)`);
  console.log(`  Fallback sw  ${SWB_HOST} (FortiLink-only → col -2)`);
  console.log(`  Endpoints    ${ENDPOINTS.map((e) => e.host).join(", ")} (search to reveal)`);
  console.log("");
  console.log(`Open the Device Map, find ${FG_HOST}, and view its topology.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
