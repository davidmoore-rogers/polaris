/**
 * tests/unit/snmpInventory.test.ts — `parseScanInterfaces` / `parseScanStorage`
 * (src/utils/snmpInventory.ts) and the extracted IF-MIB decoders
 * (src/utils/ifMib.ts).
 *
 * The scan collects this inventory during its identification pass because the
 * wizard's monitoring step offers pins by NAME and, unlike the integration
 * pickers, has no polled asset to read them off yet.
 *
 * What's pinned:
 *  - **ifName beats ifDescr.** ifXTable's ifName is the short form a config and
 *    an operator both use ("port3"); ifDescr is often a sentence. Selections
 *    store names, and the normal collector prefers ifName too — pinning by
 *    ifDescr would produce pins that match nothing once the device is polled.
 *  - a row with neither name is DROPPED, never given a synthetic "ifIndex 7"
 *    label a pin set could never match;
 *  - ordering is numeric by ifIndex, so the picker reads like the device's own
 *    port list instead of port10 before port2;
 *  - an unknown ifType decodes to null, not "physical" — the canonical
 *    vocabulary has five values and hundreds are registered, so a default
 *    would drop virtual interfaces into a byTypes pin set;
 *  - hrStorageTable's MEMORY rows are excluded by an allow-list, but a device
 *    that published descriptions and no types keeps every row rather than
 *    leaving the picker empty.
 */

import { describe, it, expect } from "vitest";
import {
  parseScanInterfaces,
  parseScanStorage,
  INVENTORY_OIDS,
  MAX_SCAN_INTERFACES,
  type SnmpRow,
} from "../../src/utils/snmpInventory.js";
import { ifStatusLabel, snmpIfTypeLabel } from "../../src/utils/ifMib.js";

/** Rows for one column, keyed by ifIndex. */
function col(column: string, byIdx: Record<string, string>): SnmpRow[] {
  return Object.entries(byIdx).map(([idx, value]) => ({ oid: `${column}.${idx}`, value }));
}

describe("ifMib decoders", () => {
  it("decodes the interface statuses", () => {
    expect(ifStatusLabel(1)).toBe("up");
    expect(ifStatusLabel(2)).toBe("down");
    expect(ifStatusLabel(7)).toBe("lowerLayerDown");
  });

  it("returns null for an unknown status rather than guessing", () => {
    expect(ifStatusLabel(99)).toBeNull();
    expect(ifStatusLabel(null)).toBeNull();
    expect(ifStatusLabel(undefined)).toBeNull();
  });

  it("maps the ifTypes seen on network gear onto the canonical vocabulary", () => {
    expect(snmpIfTypeLabel(6)).toBe("physical");
    expect(snmpIfTypeLabel(24)).toBe("loopback");
    expect(snmpIfTypeLabel(135)).toBe("vlan");
    expect(snmpIfTypeLabel(161)).toBe("aggregate");
    expect(snmpIfTypeLabel(131)).toBe("tunnel");
    expect(snmpIfTypeLabel(166)).toBe("tunnel");
  });

  it("returns null for an unmapped ifType, NOT physical", () => {
    // ifType has hundreds of registered values; the pin vocabulary has five.
    // A default of "physical" would put propVirtual (53) into a byTypes pin set.
    expect(snmpIfTypeLabel(53)).toBeNull();
    expect(snmpIfTypeLabel(1)).toBeNull();
    expect(snmpIfTypeLabel(null)).toBeNull();
  });
});

describe("parseScanInterfaces", () => {
  it("prefers ifName over ifDescr", () => {
    const { interfaces } = parseScanInterfaces({
      ifName: col(INVENTORY_OIDS.ifName, { "1": "Gi1/0/1" }),
      ifDescr: col(INVENTORY_OIDS.ifDescr, { "1": "GigabitEthernet1/0/1 Interface, Hardware is 1000BaseTX" }),
      ifType: col(INVENTORY_OIDS.ifType, { "1": "6" }),
      ifOperStatus: col(INVENTORY_OIDS.ifOperStatus, { "1": "1" }),
    });
    expect(interfaces).toEqual([{ ifName: "Gi1/0/1", ifType: "physical", operStatus: "up" }]);
  });

  it("falls back to ifDescr for an agent with no ifXTable", () => {
    const { interfaces } = parseScanInterfaces({
      ifDescr: col(INVENTORY_OIDS.ifDescr, { "1": "eth0", "2": "eth1" }),
      ifType: col(INVENTORY_OIDS.ifType, { "1": "6", "2": "6" }),
    });
    expect(interfaces.map((i) => i.ifName)).toEqual(["eth0", "eth1"]);
    expect(interfaces[0].operStatus).toBeNull(); // status walk answered nothing
  });

  it("orders numerically by ifIndex, not lexically", () => {
    const { interfaces } = parseScanInterfaces({
      ifName: col(INVENTORY_OIDS.ifName, { "1": "port1", "2": "port2", "10": "port10" }),
    });
    expect(interfaces.map((i) => i.ifName)).toEqual(["port1", "port2", "port10"]);
  });

  it("drops a row with neither ifName nor ifDescr", () => {
    // A synthetic label would produce a pin that matches nothing on the device.
    const { interfaces } = parseScanInterfaces({
      ifName: col(INVENTORY_OIDS.ifName, { "1": "port1", "2": "  " }),
      ifType: col(INVENTORY_OIDS.ifType, { "1": "6", "2": "6", "3": "6" }),
    });
    expect(interfaces.map((i) => i.ifName)).toEqual(["port1"]);
  });

  it("collapses two ifIndexes reporting one name", () => {
    const { interfaces } = parseScanInterfaces({
      ifName: col(INVENTORY_OIDS.ifName, { "1": "mgmt", "2": "mgmt" }),
    });
    expect(interfaces).toHaveLength(1);
  });

  it("collapses whitespace in a name and bounds its length", () => {
    const { interfaces } = parseScanInterfaces({
      ifName: col(INVENTORY_OIDS.ifName, { "1": "  Vlan  200 \n", "2": "x".repeat(300) }),
    });
    expect(interfaces[0].ifName).toBe("Vlan 200");
    expect(interfaces[1].ifName.length).toBe(128);
  });

  it("caps the list and says it truncated", () => {
    const many: Record<string, string> = {};
    for (let i = 1; i <= MAX_SCAN_INTERFACES + 20; i++) many[String(i)] = `port${i}`;
    const r = parseScanInterfaces({ ifName: col(INVENTORY_OIDS.ifName, many) });
    expect(r.interfaces).toHaveLength(MAX_SCAN_INTERFACES);
    expect(r.truncated).toBe(true);
  });

  it("tolerates a leading dot on the row OIDs and empty input", () => {
    const dotted = [{ oid: `.${INVENTORY_OIDS.ifName}.4`, value: "port4" }];
    expect(parseScanInterfaces({ ifName: dotted }).interfaces[0].ifName).toBe("port4");
    expect(parseScanInterfaces({}).interfaces).toEqual([]);
    expect(parseScanInterfaces({}).truncated).toBe(false);
  });

  it("ignores rows from another column that leaked into the walk", () => {
    const { interfaces } = parseScanInterfaces({
      ifName: [
        { oid: `${INVENTORY_OIDS.ifName}.1`, value: "port1" },
        { oid: "1.3.6.1.2.1.1.5.0", value: "SW-01" },
      ],
    });
    expect(interfaces.map((i) => i.ifName)).toEqual(["port1"]);
  });
});

describe("parseScanStorage", () => {
  const T = INVENTORY_OIDS.hrStorageType;
  const D = INVENTORY_OIDS.hrStorageDescr;

  it("keeps disks and drops the memory rows sharing the table", () => {
    const { storage } = parseScanStorage({
      hrStorageDescr: col(D, { "1": "Physical memory", "2": "/", "3": "Virtual memory", "4": "/var" }),
      hrStorageType: col(T, {
        "1": "1.3.6.1.2.1.25.2.1.2",  // hrStorageRam
        "2": "1.3.6.1.2.1.25.2.1.4",  // hrStorageFixedDisk
        "3": "1.3.6.1.2.1.25.2.1.3",  // hrStorageVirtualMemory
        "4": "1.3.6.1.2.1.25.2.1.4",
      }),
    });
    expect(storage.map((s) => s.mountPath)).toEqual(["/", "/var"]);
  });

  it("keeps network and removable disks too", () => {
    const { storage } = parseScanStorage({
      hrStorageDescr: col(D, { "1": "//nas/share", "2": "D:\\" }),
      hrStorageType: col(T, { "1": "1.3.6.1.2.1.25.2.1.10", "2": "1.3.6.1.2.1.25.2.1.5" }),
    });
    expect(storage).toHaveLength(2);
  });

  it("keeps every row when the type walk answered nothing", () => {
    // Plenty of agents publish hrStorageDescr and little else; dropping them
    // would leave the picker empty on a device that reported its volumes.
    const { storage } = parseScanStorage({
      hrStorageDescr: col(D, { "1": "/", "2": "/boot" }),
    });
    expect(storage.map((s) => s.mountPath)).toEqual(["/", "/boot"]);
  });

  it("keeps a row whose type value is unparseable", () => {
    const { storage } = parseScanStorage({
      hrStorageDescr: col(D, { "1": "/", "2": "/data" }),
      hrStorageType: col(T, { "1": "1.3.6.1.2.1.25.2.1.4", "2": "nonsense" }),
    });
    expect(storage.map((s) => s.mountPath)).toEqual(["/", "/data"]);
  });

  it("dedupes and handles empty input", () => {
    expect(parseScanStorage({ hrStorageDescr: col(D, { "1": "/", "2": "/" }) }).storage).toHaveLength(1);
    expect(parseScanStorage({}).storage).toEqual([]);
  });
});
