import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  STD_MIBS,
  listStdMibs,
  getStdMibDef,
  getStdMibStructure,
  resolveStdSymbol,
} from "../../src/services/stdMibLibrary.js";

describe("stdMibLibrary", () => {
  describe("registry", () => {
    it("lists 11 standard MIBs", () => {
      expect(listStdMibs().length).toBe(11);
    });

    // Guards the build/deploy bug where the bundled .txt files never made it
    // into dist/ (tsc doesn't copy assets), so every std walk failed with
    // "Standard MIB ... is not installed on the server". Every distinct
    // filename a STD_MIBS def references must exist on disk; the copy step in
    // scripts/copy-build-assets.mjs then mirrors exactly these into dist/.
    it("has every declared std MIB file present on disk", () => {
      const stdMibsDir = join(
        dirname(fileURLToPath(import.meta.url)),
        "../../src/services/stdMibs",
      );
      const filenames = [...new Set(STD_MIBS.map((m) => m.filename))];
      expect(filenames.length).toBeGreaterThan(0);
      for (const filename of filenames) {
        expect(existsSync(join(stdMibsDir, filename)), `missing std MIB file: ${filename}`).toBe(true);
      }
    });

    it("returns null for unknown keys", () => {
      expect(getStdMibDef("std:bogus")).toBeNull();
      expect(getStdMibDef("uploaded-uuid")).toBeNull();
    });

    it("looks up each std key by id", () => {
      for (const m of STD_MIBS) {
        expect(getStdMibDef(m.key)?.moduleName).toBe(m.moduleName);
      }
    });
  });

  describe("getStdMibStructure", () => {
    it("throws 404 for unknown keys", () => {
      expect(() => getStdMibStructure("std:bogus")).toThrow(/Unknown standard MIB/);
    });

    it("parses SNMPv2-MIB and resolves system-group OIDs", () => {
      const s = getStdMibStructure("std:system");
      expect(s.moduleName).toBe("SNMPv2-MIB");
      expect(s.symbols.length).toBeGreaterThan(20);

      const sysDescr = s.symbols.find((x) => x.name === "sysDescr");
      expect(sysDescr?.fullOid).toBe("1.3.6.1.2.1.1.1");

      const sysUpTime = s.symbols.find((x) => x.name === "sysUpTime");
      expect(sysUpTime?.fullOid).toBe("1.3.6.1.2.1.1.3");
      expect(sysUpTime?.baseType).toBe("TimeTicks");
    });

    it("detects ifTable as a table with the expected columns", () => {
      const s = getStdMibStructure("std:interfaces");
      const ifTable = s.tables.find((t) => t.name === "ifTable");
      expect(ifTable).toBeDefined();
      expect(ifTable!.columns).toContain("ifDescr");
      expect(ifTable!.columns).toContain("ifType");
      expect(ifTable!.columns).toContain("ifOperStatus");
    });

    it("extracts ifOperStatus enum values up(1)/down(2)/testing(3)", () => {
      const s = getStdMibStructure("std:interfaces");
      const sym = s.symbols.find((x) => x.name === "ifOperStatus");
      expect(sym?.enumValues).toBeDefined();
      const enums = sym!.enumValues!;
      expect(enums.find((e) => e.label === "up")?.value).toBe(1);
      expect(enums.find((e) => e.label === "down")?.value).toBe(2);
      expect(enums.find((e) => e.label === "testing")?.value).toBe(3);
    });

    it("resolves ifXTable in the same file at the 64-bit-counter scope", () => {
      const s = getStdMibStructure("std:if-ext");
      const ifXTable = s.symbols.find((x) => x.name === "ifXTable");
      expect(ifXTable?.fullOid).toBe("1.3.6.1.2.1.31.1.1");

      const ifHCInOctets = s.symbols.find((x) => x.name === "ifHCInOctets");
      expect(ifHCInOctets?.fullOid).toBe("1.3.6.1.2.1.31.1.1.1.6");
    });

    it("resolves HOST-RESOURCES-MIB top-level tables", () => {
      const s = getStdMibStructure("std:host-resources");
      expect(s.symbols.find((x) => x.name === "hrStorageTable")?.fullOid).toBe("1.3.6.1.2.1.25.2.3");
      expect(s.symbols.find((x) => x.name === "hrStorageDescr")?.fullOid).toBe("1.3.6.1.2.1.25.2.3.1.3");
      expect(s.symbols.find((x) => x.name === "hrProcessorLoad")?.fullOid).toBe("1.3.6.1.2.1.25.3.3.1.2");
    });

    it("resolves ENTITY-MIB physical inventory table", () => {
      const s = getStdMibStructure("std:entity");
      expect(s.symbols.find((x) => x.name === "entPhysicalTable")?.fullOid).toBe("1.3.6.1.2.1.47.1.1.1");
      expect(s.symbols.find((x) => x.name === "entPhysicalName")?.fullOid).toBe("1.3.6.1.2.1.47.1.1.1.1.7");
    });

    it("resolves ENTITY-SENSOR-MIB sensor table", () => {
      const s = getStdMibStructure("std:entity-sensor");
      expect(s.symbols.find((x) => x.name === "entPhySensorTable")?.fullOid).toBe("1.3.6.1.2.1.99.1.1");
      expect(s.symbols.find((x) => x.name === "entPhySensorValue")?.fullOid).toBe("1.3.6.1.2.1.99.1.1.1.4");
    });

    it("resolves LLDP-MIB through ASN.1 named-number syntax in the root anchor", () => {
      // LLDP-MIB anchors at `{ iso std(0) iso8802(8802) ieee802dot1(1) ieee802dot1mibs(1) 2 }`.
      // Validates the named-number extension to tryResolveParts in oidRegistry.
      const s = getStdMibStructure("std:lldp");
      expect(s.symbols.find((x) => x.name === "lldpMIB")?.fullOid).toBe("1.0.8802.1.1.2");
      expect(s.symbols.find((x) => x.name === "lldpObjects")?.fullOid).toBe("1.0.8802.1.1.2.1");
      expect(s.symbols.find((x) => x.name === "lldpRemTable")?.fullOid).toBe("1.0.8802.1.1.2.1.4.1");
      expect(s.symbols.find((x) => x.name === "lldpRemSysName")?.fullOid).toBe("1.0.8802.1.1.2.1.4.1.1.9");
    });

    it("resolves POWER-ETHERNET-MIB PoE port + PSE tables", () => {
      const s = getStdMibStructure("std:poe");
      const oid = (n: string) => s.symbols.find((x) => x.name === n)?.fullOid;
      expect(oid("pethPsePortDetectionStatus")).toBe("1.3.6.1.2.1.105.1.1.1.6");
      expect(oid("pethPsePortPowerClassifications")).toBe("1.3.6.1.2.1.105.1.1.1.10");
      // Guards a real mistake: the chain carries an extra pethMainPseObjects
      // level (pethObjects.3 → Table.1 → Entry.1 → column.4), so writing this
      // as ...105.1.3.1.4 from memory yields a silently-empty walk.
      expect(oid("pethMainPseConsumptionPower")).toBe("1.3.6.1.2.1.105.1.3.1.1.4");
    });

    it("resolves BRIDGE-MIB forwarding, STP and the basePort→ifIndex join", () => {
      const s = getStdMibStructure("std:bridge");
      const oid = (n: string) => s.symbols.find((x) => x.name === n)?.fullOid;
      expect(oid("dot1dBasePortIfIndex")).toBe("1.3.6.1.2.1.17.1.4.1.2");
      expect(oid("dot1dTpFdbPort")).toBe("1.3.6.1.2.1.17.4.3.1.2");
      expect(oid("dot1dTpFdbStatus")).toBe("1.3.6.1.2.1.17.4.3.1.3");
      expect(oid("dot1dStpPortState")).toBe("1.3.6.1.2.1.17.2.15.1.3");
    });

    // Q-BRIDGE and RSTP anchor on symbols IMPORTed from BRIDGE-MIB, and
    // stdMibLibrary resolves each module independently against BUILT_IN_OIDS
    // with no cross-MIB visibility — so bundling BRIDGE-MIB alongside them is
    // NOT what makes these resolve; the seeded `dot1dBridge` / `dot1dStp`
    // anchors are. Drop those seeds and Q-BRIDGE resolves 0 of 129
    // assignments and RSTP 9 of 19, which is what these two pin.
    it("resolves Q-BRIDGE-MIB's VLAN-aware forwarding table via the seeded dot1dBridge anchor", () => {
      const s = getStdMibStructure("std:q-bridge");
      const oid = (n: string) => s.symbols.find((x) => x.name === n)?.fullOid;
      expect(oid("dot1qTpFdbPort")).toBe("1.3.6.1.2.1.17.7.1.2.2.1.2");
      expect(oid("dot1qTpFdbStatus")).toBe("1.3.6.1.2.1.17.7.1.2.2.1.3");
      expect(s.unresolvedCount).toBe(0);
    });

    it("resolves RSTP-MIB via the seeded dot1dStp anchor", () => {
      const s = getStdMibStructure("std:rstp");
      const oid = (n: string) => s.symbols.find((x) => x.name === n)?.fullOid;
      expect(oid("dot1dStpVersion")).toBe("1.3.6.1.2.1.17.2.16");
      expect(oid("dot1dStpExtPortTable")).toBe("1.3.6.1.2.1.17.2.19");
      expect(s.unresolvedCount).toBe(0);
    });

    it("returns the same cached object on second call (no re-parse)", () => {
      const a = getStdMibStructure("std:system");
      const b = getStdMibStructure("std:system");
      expect(a).toBe(b);
    });
  });

  describe("resolveStdSymbol", () => {
    it("looks up a symbol within a MIB by name", () => {
      const sym = resolveStdSymbol("std:system", "sysDescr");
      expect(sym?.fullOid).toBe("1.3.6.1.2.1.1.1");
    });

    it("returns null for unknown symbol names", () => {
      expect(resolveStdSymbol("std:system", "notARealSymbol")).toBeNull();
    });

    it("throws on unknown MIB keys (via getStdMibStructure)", () => {
      expect(() => resolveStdSymbol("std:bogus", "anything")).toThrow(/Unknown standard MIB/);
    });
  });
});
