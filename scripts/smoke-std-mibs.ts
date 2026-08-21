/**
 * scripts/smoke-std-mibs.ts — quick verification that each bundled
 * std MIB parses cleanly and that key well-known symbols resolve to
 * their canonical OIDs. Run with:
 *
 *   npx tsx scripts/smoke-std-mibs.ts
 */
import { STD_MIBS, getStdMibStructure } from "../src/services/stdMibLibrary.js";

const EXPECTED: Record<string, Record<string, string>> = {
  "std:system": {
    sysDescr:    "1.3.6.1.2.1.1.1",
    sysObjectID: "1.3.6.1.2.1.1.2",
    sysUpTime:   "1.3.6.1.2.1.1.3",
    sysName:     "1.3.6.1.2.1.1.5",
  },
  "std:interfaces": {
    ifTable:     "1.3.6.1.2.1.2.2",
    ifDescr:     "1.3.6.1.2.1.2.2.1.2",
    ifType:      "1.3.6.1.2.1.2.2.1.3",
    ifOperStatus:"1.3.6.1.2.1.2.2.1.8",
  },
  "std:if-ext": {
    ifXTable:    "1.3.6.1.2.1.31.1.1",
    ifName:      "1.3.6.1.2.1.31.1.1.1.1",
    ifHCInOctets:"1.3.6.1.2.1.31.1.1.1.6",
    ifAlias:     "1.3.6.1.2.1.31.1.1.1.18",
  },
  "std:host-resources": {
    hrStorageTable: "1.3.6.1.2.1.25.2.3",
    hrStorageDescr: "1.3.6.1.2.1.25.2.3.1.3",
    hrProcessorLoad: "1.3.6.1.2.1.25.3.3.1.2",
  },
  "std:entity": {
    entPhysicalTable: "1.3.6.1.2.1.47.1.1.1",
    entPhysicalDescr: "1.3.6.1.2.1.47.1.1.1.1.2",
    entPhysicalName:  "1.3.6.1.2.1.47.1.1.1.1.7",
  },
  "std:entity-sensor": {
    entPhySensorTable: "1.3.6.1.2.1.99.1.1",
    entPhySensorType:  "1.3.6.1.2.1.99.1.1.1.1",
    entPhySensorValue: "1.3.6.1.2.1.99.1.1.1.4",
  },
  "std:lldp": {
    lldpMIB:         "1.0.8802.1.1.2",
    lldpRemTable:    "1.0.8802.1.1.2.1.4.1",
    lldpRemSysName:  "1.0.8802.1.1.2.1.4.1.1.9",
    lldpRemManAddrTable: "1.0.8802.1.1.2.1.4.2",
  },
  "std:poe": {
    pethPsePortTable:                "1.3.6.1.2.1.105.1.1",
    pethPsePortDetectionStatus:      "1.3.6.1.2.1.105.1.1.1.6",
    pethPsePortPowerClassifications: "1.3.6.1.2.1.105.1.1.1.10",
    // Note the extra pethMainPseObjects level: pethObjects(.1) →
    // pethMainPseObjects(.3) → Table(.1) → Entry(.1) → column(.4). Easy to
    // write as ...105.1.3.1.4 from memory and be silently wrong.
    pethMainPseConsumptionPower:     "1.3.6.1.2.1.105.1.3.1.1.4",
  },
  "std:bridge": {
    dot1dBridge:          "1.3.6.1.2.1.17",
    // The basePort→ifIndex join every FDB and STP row has to go through:
    // dot1dTpFdbPort / dot1dStpPort are dot1dBasePort values, NOT ifIndex.
    dot1dBasePortIfIndex: "1.3.6.1.2.1.17.1.4.1.2",
    dot1dTpFdbPort:       "1.3.6.1.2.1.17.4.3.1.2",
    dot1dTpFdbStatus:     "1.3.6.1.2.1.17.4.3.1.3",
    dot1dStpPortState:    "1.3.6.1.2.1.17.2.15.1.3",
  },
  "std:q-bridge": {
    // Anchored on BRIDGE-MIB's dot1dBridge via IMPORTS — resolves only
    // because that symbol is seeded in BUILT_IN_OIDS. Without it this
    // module resolves 0 of 129 assignments.
    dot1qTpFdbPort:   "1.3.6.1.2.1.17.7.1.2.2.1.2",
    dot1qTpFdbStatus: "1.3.6.1.2.1.17.7.1.2.2.1.3",
  },
  "std:rstp": {
    // Likewise anchored on BRIDGE-MIB's dot1dStp.
    dot1dStpVersion:         "1.3.6.1.2.1.17.2.16",
    dot1dStpExtPortTable:    "1.3.6.1.2.1.17.2.19",
  },
  "std:ip": {
    // The neighbour cache, both generations. ipNetToPhysical is RFC 4293's
    // replacement for the RFC 1213 ipNetToMedia table, which IP-MIB still
    // carries as deprecated -- a collector wants the new one and the old one
    // as fallback, so both have to resolve.
    ipNetToPhysicalPhysAddress: "1.3.6.1.2.1.4.35.1.4",
    ipNetToPhysicalLastUpdated: "1.3.6.1.2.1.4.35.1.5",
    ipNetToPhysicalState:       "1.3.6.1.2.1.4.35.1.7",
    ipNetToMediaPhysAddress:    "1.3.6.1.2.1.4.22.1.2",
    ipNetToMediaNetAddress:     "1.3.6.1.2.1.4.22.1.3",
    ipNetToMediaType:           "1.3.6.1.2.1.4.22.1.4",
    // Not the neighbour cache, but the other reason to bundle this module:
    // the addresses the device itself holds.
    ipAdEntNetMask:             "1.3.6.1.2.1.4.20.1.3",
  },
};

let pass = 0;
let fail = 0;

for (const def of STD_MIBS) {
  console.log(`\n=== ${def.key} (${def.moduleName}, ${def.filename}) ===`);
  try {
    const s = getStdMibStructure(def.key);
    console.log(`  symbols=${s.symbols.length} tables=${s.tables.length} unresolved=${s.unresolvedCount}`);
    const expect = EXPECTED[def.key] || {};
    for (const [name, wanted] of Object.entries(expect)) {
      const sym = s.symbols.find((x) => x.name === name);
      const got = sym?.fullOid ?? null;
      if (got === wanted) {
        console.log(`  ✓ ${name} = ${got}`);
        pass++;
      } else {
        console.log(`  ✗ ${name} expected ${wanted}, got ${got ?? "(unresolved or missing)"}`);
        fail++;
      }
    }
    // Sanity: ifOperStatus should have enum values
    if (def.key === "std:interfaces") {
      const ifOper = s.symbols.find((x) => x.name === "ifOperStatus");
      if (ifOper?.enumValues && ifOper.enumValues.find((e) => e.label === "up" && e.value === 1)) {
        console.log(`  ✓ ifOperStatus enum has up(1)`);
        pass++;
      } else {
        console.log(`  ✗ ifOperStatus enum values missing or wrong: ${JSON.stringify(ifOper?.enumValues)}`);
        fail++;
      }
    }
    // Sanity: ifTable should be detected as a table
    if (def.key === "std:interfaces") {
      const t = s.tables.find((x) => x.name === "ifTable");
      if (t && t.columns.includes("ifDescr") && t.columns.includes("ifOperStatus")) {
        console.log(`  ✓ ifTable detected with ${t.columns.length} columns`);
        pass++;
      } else {
        console.log(`  ✗ ifTable not detected or missing columns`);
        fail++;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ THROW: ${msg}`);
    fail++;
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
