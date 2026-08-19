/**
 * prisma/seed-review-assets.ts — SYNTHETIC devices for reviewing the device
 * filter locally. Not part of `npm run db:seed`; run it by hand:
 *
 *   node --env-file=.env --import tsx/esm prisma/seed-review-assets.ts
 *
 * `npm run db:seed` creates the admin user and some IP space but no assets, so
 * every device-filter preview reads "0 devices" and the monitored-vs-unmonitored
 * split has nothing to show. These rows exercise exactly the surfaces the
 * address-book and automations device filters touch:
 *
 *   - a mix of MONITORED and unmonitored devices, so the previews' two counts
 *     and the monitored-only value pickers are visibly different;
 *   - manufacturers / models / OS versions / departments / locations, one per
 *     picker;
 *   - region: tags and a `learnedLocation` FortiGate, for the region pill and
 *     the "behind FortiGate" condition;
 *   - pinned interfaces + storage mounts, for the trigger step's dimension
 *     pickers.
 *
 * Every value is invented. Idempotent: keyed on hostname, so re-running updates
 * rather than duplicating.
 */

import { prisma } from "../src/db.js";

interface Row {
  hostname: string;
  ipAddress: string;
  assetType: string;
  manufacturer: string;
  model: string;
  os: string;
  osVersion: string;
  department: string;
  location: string;
  tags: string[];
  monitored: boolean;
  learnedLocation?: string;
  monitoredInterfaces?: string[];
  monitoredStorage?: string[];
}

const ROWS: Row[] = [
  {
    hostname: "NASH-CORE-SW1", ipAddress: "10.20.1.11", assetType: "switch",
    manufacturer: "Fortinet", model: "FS-448D", os: "FortiSwitch", osVersion: "7.4.2",
    department: "Plant Ops", location: "Nashville Plant", tags: ["region:Nashville", "core"],
    monitored: true, learnedLocation: "NASH-EDGE-FG1",
    monitoredInterfaces: ["port1", "port2", "port47"],
  },
  {
    hostname: "NASH-CORE-SW2", ipAddress: "10.20.1.12", assetType: "switch",
    manufacturer: "Fortinet", model: "FS-448D", os: "FortiSwitch", osVersion: "7.4.2",
    department: "Plant Ops", location: "Nashville Plant", tags: ["region:Nashville", "core"],
    monitored: true, learnedLocation: "NASH-EDGE-FG1",
    monitoredInterfaces: ["port1", "port2"],
  },
  {
    hostname: "NASH-EDGE-FG1", ipAddress: "10.20.1.1", assetType: "firewall",
    manufacturer: "Fortinet", model: "FG-101F", os: "FortiOS", osVersion: "7.4.4",
    department: "IT", location: "Nashville Plant", tags: ["region:Nashville", "edge"],
    monitored: true, monitoredInterfaces: ["wan1", "internal"],
  },
  {
    hostname: "NASH-FILE-01", ipAddress: "10.20.4.20", assetType: "server",
    manufacturer: "Dell Inc.", model: "PowerEdge R650", os: "Windows Server 2022", osVersion: "10.0.20348.2402",
    department: "IT", location: "Nashville Plant", tags: ["region:Nashville", "file-server"],
    monitored: true, monitoredStorage: ["C:", "D:"], monitoredInterfaces: ["Ethernet0"],
  },
  {
    hostname: "MEMP-EDGE-FG1", ipAddress: "10.30.1.1", assetType: "firewall",
    manufacturer: "Fortinet", model: "FG-61F", os: "FortiOS", osVersion: "7.2.9",
    department: "IT", location: "Memphis Yard", tags: ["region:Memphis", "edge"],
    monitored: true, monitoredInterfaces: ["wan1"],
  },
  {
    hostname: "MEMP-SCALE-PC", ipAddress: "10.30.6.44", assetType: "workstation",
    manufacturer: "HP", model: "EliteDesk 800 G9", os: "Windows 11 Pro", osVersion: "23H2 (10.0.22631.7219)",
    department: "Scales", location: "Memphis Yard", tags: ["region:Memphis", "scalehouse"],
    monitored: true, monitoredStorage: ["C:"],
  },
  // ── Unmonitored: these must NOT appear in the pickers, and must be COUNTED
  // (not listed) by both previews.
  {
    hostname: "OLD-LAB-SW9", ipAddress: "10.99.1.9", assetType: "switch",
    manufacturer: "Netgear", model: "GS724T", os: "Netgear Smart Switch", osVersion: "5.4.2",
    department: "Lab", location: "Knoxville Depot", tags: ["region:Knoxville", "decomm-candidate"],
    monitored: false,
  },
  {
    hostname: "OLD-LAB-PC3", ipAddress: "10.99.6.3", assetType: "workstation",
    manufacturer: "Lenovo", model: "ThinkCentre M700", os: "Windows 10 Pro", osVersion: "10.0.19045.4291",
    department: "Lab", location: "Knoxville Depot", tags: ["region:Knoxville"],
    monitored: false,
  },
  {
    hostname: "SPARE-PRINTER-2", ipAddress: "10.99.7.2", assetType: "printer",
    manufacturer: "Zebra Technologies", model: "ZT411", os: "Link-OS", osVersion: "6.5",
    department: "Shipping", location: "Knoxville Depot", tags: [],
    monitored: false,
  },
];

async function main(): Promise<void> {
  const now = new Date();
  for (const r of ROWS) {
    const existing = await prisma.asset.findFirst({ where: { hostname: r.hostname }, select: { id: true } });
    const data = {
      hostname: r.hostname,
      ipAddress: r.ipAddress,
      assetType: r.assetType,
      manufacturer: r.manufacturer,
      model: r.model,
      os: r.os,
      osVersion: r.osVersion,
      department: r.department,
      location: r.location,
      tags: r.tags,
      monitored: r.monitored,
      status: "active" as const,
      learnedLocation: r.learnedLocation ?? null,
      monitoredInterfaces: r.monitoredInterfaces ?? [],
      monitoredStorage: r.monitoredStorage ?? [],
      lastSeen: r.monitored ? now : null,
      notes: "Synthetic review data (prisma/seed-review-assets.ts) — not a real device.",
    };
    if (existing) await prisma.asset.update({ where: { id: existing.id }, data });
    else await prisma.asset.create({ data });
  }
  const monitored = ROWS.filter((r) => r.monitored).length;
  console.log(`Review assets: ${ROWS.length} devices (${monitored} monitored, ${ROWS.length - monitored} not).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
