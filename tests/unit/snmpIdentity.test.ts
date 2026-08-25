/**
 * tests/unit/snmpIdentity.test.ts — `parseSnmpIdentity` (src/utils/snmpIdentity.ts).
 *
 * Turning "this address answered SNMP" into asset fields is new ground: every
 * existing system-group reader in the repo takes exactly one object
 * (`sysUpTime` for the probe, `sysLocation` over FortiOS REST), and the only
 * sysDescr/sysName anywhere else are LLDP *remote*-neighbour columns, which
 * describe someone else's device.
 *
 * What's pinned, and why each is a decision rather than an implementation
 * detail:
 *
 *  - **An unknown enterprise arc yields NO manufacturer.** The vendor table is
 *    small on purpose. A wrong manufacturer is a field an operator never
 *    re-checks; an empty one is a field they fill in.
 *  - **sysObjectID outranks sysDescr, except for the generic agent arc.** The
 *    arc is a registered assignment; a vendor word in the description can name
 *    the OS on someone else's hardware, or the agent rather than the box. But
 *    Net-SNMP's own arc names the agent by definition, so there the
 *    description wins — that inversion is the whole reason the rule is not
 *    just "arc first".
 *  - **Unconfigured-agent placeholders are dropped.** "Sitting on the Dock of
 *    the Bay" in an asset's Location reads as data, and an operator filtering
 *    by location would see a site that does not exist (the
 *    utils/hardwareIdentity.ts placeholder-serial precedent).
 *  - **A partial answer yields a partial identity.** A device that responds to
 *    half the group must show up on the Results step, not fail the hit.
 *  - **No `model`.** The system group has no model object, and deriving one
 *    from sysDescr works per-vendor and fails silently across vendors.
 */

import { describe, it, expect } from "vitest";
import {
  parseSnmpIdentity,
  hasSnmpIdentity,
  vendorFromSysObjectId,
  vendorFromSysDescr,
  enterpriseFromSysObjectId,
  SYS_OIDS,
  type SnmpIdentityRow,
} from "../../src/utils/snmpIdentity.js";

/** Build a walk from a partial system group. */
function walk(over: Partial<Record<keyof typeof SYS_OIDS, string>>): SnmpIdentityRow[] {
  return Object.entries(over).map(([k, value]) => ({
    oid: SYS_OIDS[k as keyof typeof SYS_OIDS],
    value: value as string,
    type: "OctetString",
  }));
}

describe("enterpriseFromSysObjectId", () => {
  it("reads the enterprise number under the enterprises arc", () => {
    expect(enterpriseFromSysObjectId("1.3.6.1.4.1.12356.101.1.1000")).toBe(12356);
    expect(enterpriseFromSysObjectId("1.3.6.1.4.1.9")).toBe(9);
  });

  it("tolerates a leading dot, which plenty of agents emit", () => {
    expect(enterpriseFromSysObjectId(".1.3.6.1.4.1.2636.1.1.1.2.29")).toBe(2636);
  });

  it("returns null for anything not under enterprises", () => {
    expect(enterpriseFromSysObjectId("1.3.6.1.2.1.1.1")).toBeNull();
    expect(enterpriseFromSysObjectId("garbage")).toBeNull();
    expect(enterpriseFromSysObjectId("")).toBeNull();
    expect(enterpriseFromSysObjectId(undefined)).toBeNull();
  });
});

describe("vendorFromSysObjectId", () => {
  it("names the arcs it knows", () => {
    expect(vendorFromSysObjectId("1.3.6.1.4.1.12356.101.1.1000")).toBe("Fortinet");
    expect(vendorFromSysObjectId("1.3.6.1.4.1.318.1.3.2.10")).toBe("APC");
    expect(vendorFromSysObjectId("1.3.6.1.4.1.14988.1")).toBe("MikroTik");
  });

  it("returns undefined for an arc it does not name, rather than guessing", () => {
    expect(vendorFromSysObjectId("1.3.6.1.4.1.99999999.1")).toBeUndefined();
  });

  it("agrees with oidRegistry about who 12356 is", () => {
    // The table is seeded from BUILT_IN_OIDS precisely so the two can't drift.
    expect(vendorFromSysObjectId("1.3.6.1.4.1.12356")).toBe("Fortinet");
  });
});

describe("vendorFromSysDescr", () => {
  it("matches a whole word only", () => {
    expect(vendorFromSysDescr("Cisco IOS Software, C2960X")).toBe("Cisco");
    expect(vendorFromSysDescr("Cisconnect appliance")).toBeUndefined();
  });

  it("prefers the longest matching vendor name", () => {
    expect(vendorFromSysDescr("Hewlett Packard Enterprise ArubaOS")).toBe("Hewlett Packard Enterprise");
  });

  it("is case-insensitive and survives punctuation", () => {
    expect(vendorFromSysDescr("APC Web/SNMP Management Card")).toBe("APC");
    expect(vendorFromSysDescr("linux ups-1 5.4.0 (eaton)")).toBe("Eaton");
  });

  it("returns undefined when no vendor word is present", () => {
    expect(vendorFromSysDescr("Linux gw 5.15.0-78-generic x86_64")).toBeUndefined();
    expect(vendorFromSysDescr("")).toBeUndefined();
    expect(vendorFromSysDescr(undefined)).toBeUndefined();
  });
});

describe("parseSnmpIdentity — vendor precedence", () => {
  it("takes the registered arc over a vendor word in the description", () => {
    // "Cisco IOS" running on a Juniper-arc device is not a Cisco box. The arc
    // is an assignment; the description is prose.
    const id = parseSnmpIdentity(walk({
      sysObjectID: "1.3.6.1.4.1.2636.1.1.1.2.29",
      sysDescr: "Juniper Networks, Inc. ex2200 Ethernet Switch",
    }));
    expect(id.manufacturer).toBe("Juniper");
  });

  it("falls back to the description when the arc is unnamed", () => {
    const id = parseSnmpIdentity(walk({
      sysObjectID: "1.3.6.1.4.1.99999999.1.2",
      sysDescr: "Raritan Dominion PX2 PDU",
    }));
    expect(id.manufacturer).toBe("Raritan");
    // The arc is still recorded even though it isn't named — it identifies the
    // exact model row and is what a later lookup would key on.
    expect(id.enterpriseNumber).toBe(99999999);
  });

  it("prefers the description over the GENERIC AGENT arc", () => {
    // A Linux-based PDU running net-snmp answers with net-snmp's own arc.
    // Trusting it would label every such device "Net-SNMP".
    const id = parseSnmpIdentity(walk({
      sysObjectID: "1.3.6.1.4.1.8072.3.2.10",
      sysDescr: "Linux pdu-a1 5.10.0 #1 SMP Eaton ePDU",
    }));
    expect(id.manufacturer).toBe("Eaton");
  });

  it("keeps the generic agent name when the description offers nothing better", () => {
    const id = parseSnmpIdentity(walk({
      sysObjectID: "1.3.6.1.4.1.8072.3.2.10",
      sysDescr: "Linux gw 5.15.0-78-generic x86_64",
    }));
    expect(id.manufacturer).toBe("Net-SNMP");
  });

  it("leaves manufacturer unset when neither source names one", () => {
    const id = parseSnmpIdentity(walk({
      sysObjectID: "1.3.6.1.4.1.99999999.1",
      sysDescr: "embedded controller v2",
    }));
    expect(id.manufacturer).toBeUndefined();
  });
});

describe("parseSnmpIdentity — fields", () => {
  it("reads a full system group", () => {
    const id = parseSnmpIdentity(walk({
      sysDescr: "FortiSwitch-148F v7.2.5,build0453,230511 (GA)",
      sysObjectID: "1.3.6.1.4.1.12356.106.1.1",
      sysUpTime: "123456789",
      sysContact: "netops@example.com",
      sysName: "SW-ASHFIELD-01",
      sysLocation: "a:north b:12 f:1 r:104",
    }));
    expect(id).toMatchObject({
      hostname: "SW-ASHFIELD-01",
      manufacturer: "Fortinet",
      snmpLocation: "a:north b:12 f:1 r:104",
      contact: "netops@example.com",
      sysObjectId: "1.3.6.1.4.1.12356.106.1.1",
      enterpriseNumber: 12356,
      uptimeSec: 1234567,
    });
    expect(id.os).toContain("FortiSwitch-148F");
  });

  it("never reports a model — the system group has none", () => {
    const id = parseSnmpIdentity(walk({ sysDescr: "FortiSwitch-148F v7.2.5" })) as Record<string, unknown>;
    expect(id.model).toBeUndefined();
  });

  it("collapses a multi-line sysDescr", () => {
    // Cisco IOS routinely answers with several lines and a trailing copyright.
    const id = parseSnmpIdentity(walk({
      sysDescr: "Cisco IOS Software, C2960X Software\r\nVersion 15.2(4)E10\nCopyright (c) 1986-2019",
    }));
    expect(id.os).toBe("Cisco IOS Software, C2960X Software Version 15.2(4)E10 Copyright (c) 1986-2019");
  });

  it("bounds a pathologically long sysDescr", () => {
    const id = parseSnmpIdentity(walk({ sysDescr: "x".repeat(5000) }));
    expect(id.os!.length).toBe(512);
  });

  it("keeps an FQDN sysName verbatim — the projection layer decides", () => {
    const id = parseSnmpIdentity(walk({ sysName: "sw-01.corp.example.com" }));
    expect(id.hostname).toBe("sw-01.corp.example.com");
  });
});

describe("parseSnmpIdentity — placeholders", () => {
  it("drops net-snmp's compiled-in location and contact defaults", () => {
    const id = parseSnmpIdentity(walk({
      sysName: "gw",
      sysLocation: "Sitting on the Dock of the Bay",
      sysContact: "Me <me@example.org>",
    }));
    expect(id.snmpLocation).toBeUndefined();
    expect(id.contact).toBeUndefined();
    expect(id.hostname).toBe("gw"); // the real value survives
  });

  it("drops the other common unset markers, case-insensitively", () => {
    for (const v of ["unknown", "Not Set", "N/A", "none", "<private>", "System Location Not Set"]) {
      expect(parseSnmpIdentity(walk({ sysLocation: v })).snmpLocation, v).toBeUndefined();
    }
  });

  it("keeps a real location that merely looks terse", () => {
    expect(parseSnmpIdentity(walk({ sysLocation: "MDF" })).snmpLocation).toBe("MDF");
  });

  it("drops a placeholder sysName rather than storing it as a hostname", () => {
    expect(parseSnmpIdentity(walk({ sysName: "unknown" })).hostname).toBeUndefined();
  });
});

describe("parseSnmpIdentity — partial and malformed input", () => {
  it("yields a partial identity from half a group", () => {
    const id = parseSnmpIdentity(walk({ sysName: "cam-14" }));
    expect(id).toEqual({ hostname: "cam-14" });
    expect(hasSnmpIdentity(id)).toBe(true);
  });

  it("returns an empty identity for an empty walk", () => {
    expect(parseSnmpIdentity([])).toEqual({});
    expect(hasSnmpIdentity({})).toBe(false);
    expect(parseSnmpIdentity(undefined as unknown as SnmpIdentityRow[])).toEqual({});
  });

  it("treats whitespace-only values as absent", () => {
    const id = parseSnmpIdentity(walk({ sysName: "   ", sysLocation: "\t\n" }));
    expect(id.hostname).toBeUndefined();
    expect(id.snmpLocation).toBeUndefined();
  });

  it("drops a non-numeric or negative sysUpTime rather than storing 0", () => {
    // "up for no time at all" is a claim; absence is not.
    expect(parseSnmpIdentity(walk({ sysUpTime: "" })).uptimeSec).toBeUndefined();
    expect(parseSnmpIdentity(walk({ sysUpTime: "(nothing)" })).uptimeSec).toBeUndefined();
    expect(parseSnmpIdentity(walk({ sysUpTime: "-5" })).uptimeSec).toBeUndefined();
    expect(parseSnmpIdentity(walk({ sysUpTime: "0" })).uptimeSec).toBe(0);
  });

  it("tolerates a leading dot on the row OIDs", () => {
    const id = parseSnmpIdentity([{ oid: ".1.3.6.1.2.1.1.5.0", value: "rtr-1" }]);
    expect(id.hostname).toBe("rtr-1");
  });

  it("keeps the first row when an OID appears twice", () => {
    // A re-walk that appended rows must not let a later, emptier answer
    // overwrite a good one.
    const id = parseSnmpIdentity([
      { oid: SYS_OIDS.sysName, value: "rtr-1" },
      { oid: SYS_OIDS.sysName, value: "" },
    ]);
    expect(id.hostname).toBe("rtr-1");
  });

  it("ignores rows outside the system group", () => {
    const id = parseSnmpIdentity([
      { oid: "1.3.6.1.2.1.2.2.1.2.1", value: "port1" },
      { oid: SYS_OIDS.sysName, value: "sw-9" },
    ]);
    expect(id).toEqual({ hostname: "sw-9" });
  });
});
