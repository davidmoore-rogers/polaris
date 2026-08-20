/**
 * tests/unit/fortiapLldp.test.ts
 */

import { describe, it, expect } from "vitest";
import { extractApLldpAndMesh, parseApLldpNeighbors } from "../../src/utils/fortiapLldp.js";

describe("extractApLldpAndMesh", () => {
  it("returns empty result for a row with no lldp/mesh fields", () => {
    expect(extractApLldpAndMesh({})).toEqual({});
  });

  it("ignores lldp when not an array", () => {
    expect(extractApLldpAndMesh({ lldp: "garbage" } as any)).toEqual({});
  });

  it("picks the FortiSwitch wired uplink LLDP entry", () => {
    const row = {
      lldp: [
        {
          local_port: "lan1",
          chassis_id: "mac e0:23:ff:00:00:01",
          system_name: "CEDARS-148E-1",
          system_description: "FortiSwitch-148E-POE v7.4.8,build0929,250909 (GA)",
          port_id: "port9",
          port_description: "CEDARS-221E-1",
        },
      ],
    };
    expect(extractApLldpAndMesh(row)).toEqual({
      lldpUplinkSwitch: "CEDARS-148E-1",
      lldpUplinkPort: "port9",
      lldpLocalPort: "lan1",
    });
  });

  it("picks the FortiSwitch Rugged wired uplink (system_description starts FortiSwitchRugged-)", () => {
    // Real data from a washplant floor: the FSR family advertises
    // "FortiSwitchRugged-112F-POE …", which the old "FortiSwitch-" prefix
    // check dropped — the AP's wired uplink then went unresolved.
    const row = {
      lldp: [
        {
          local_port: "lan1",
          chassis_id: "mac 1c:d1:1a:00:00:01",
          system_name: "RIVERBEND-112F-WASHPLANT",
          system_description: "FortiSwitchRugged-112F-POE v7.6.5,build1136,251201 (GA)",
          port_id: "port7",
          port_description: "RVBD-432F-WASHPLANT",
        },
      ],
    };
    expect(extractApLldpAndMesh(row)).toEqual({
      lldpUplinkSwitch: "RIVERBEND-112F-WASHPLANT",
      lldpUplinkPort: "port7",
      lldpLocalPort: "lan1",
    });
  });

  it("skips wireless-mesh peer LLDP rows (FortiAP system_description)", () => {
    const row = {
      lldp: [
        {
          local_port: "wbh1",
          chassis_id: "mac 80:80:2c:00:00:01",
          system_name: "CEDARS-234F-1",
          system_description: "FortiAP-234F v7.4.6,build0771,250814 (GA)",
          port_id: "80:80:2c:00:00:01",
          port_description: "m10.0",
        },
      ],
    };
    expect(extractApLldpAndMesh(row)).toEqual({});
  });

  it("picks the wired FortiSwitch row out of a mixed wired+mesh array", () => {
    // CEDARS-234F-1 in real data has both a wired uplink (FortiSwitch) and a
    // wireless backhaul peer (FortiAP). The extractor picks the FortiSwitch
    // and ignores the FortiAP.
    const row = {
      lldp: [
        {
          local_port: "lan1",
          chassis_id: "mac 94:f3:92:00:00:01",
          system_name: "CEDARS-124F-1",
          system_description: "FortiSwitch-124F-POE v7.4.8,build0929,250909 (GA)",
          port_id: "port12",
        },
        {
          local_port: "w10.0",
          chassis_id: "mac 80:80:2c:00:00:02",
          system_name: "CEDARS-234F-2",
          system_description: "FortiAP-234F v7.4.6,build0771,250814 (GA)",
          port_id: "80:80:2c:00:00:03",
        },
      ],
    };
    expect(extractApLldpAndMesh(row)).toEqual({
      lldpUplinkSwitch: "CEDARS-124F-1",
      lldpUplinkPort: "port12",
      lldpLocalPort: "lan1",
    });
  });

  it("skips entries with empty system_name or port_id", () => {
    const row = {
      lldp: [
        {
          local_port: "lan1",
          system_name: "",
          system_description: "FortiSwitch-148E-POE v7.4.8",
          port_id: "port9",
        },
      ],
    };
    expect(extractApLldpAndMesh(row)).toEqual({});
  });

  it("captures mesh_uplink and parent_wtp_id for mesh leaves", () => {
    const row = {
      mesh_uplink: "mesh",
      parent_wtp_id: "FP234FTF23000001",
    };
    expect(extractApLldpAndMesh(row)).toEqual({
      meshUplink: "mesh",
      parentApSerial: "FP234FTF23000001",
    });
  });

  it("captures mesh_uplink ethernet for wired-uplink APs", () => {
    const row = { mesh_uplink: "ethernet" };
    expect(extractApLldpAndMesh(row)).toEqual({ meshUplink: "ethernet" });
  });

  it("rejects unknown mesh_uplink values defensively", () => {
    const row = { mesh_uplink: "unicorn" };
    expect(extractApLldpAndMesh(row)).toEqual({});
  });

  it("ignores empty parent_wtp_id (wired APs have it set to empty string)", () => {
    const row = { mesh_uplink: "ethernet", parent_wtp_id: "" };
    expect(extractApLldpAndMesh(row)).toEqual({ meshUplink: "ethernet" });
  });

  it("full mesh-leaf scenario (matches CEDARS-234F-2 in the real payload)", () => {
    const row = {
      mesh_uplink: "mesh",
      parent_wtp_id: "FP234FTF23000001",
      lldp: [
        {
          local_port: "lan1",
          chassis_id: "mac e0:23:ff:00:00:02",
          system_name: "CEDARS-108E-3",
          system_description: "FortiSwitch-108E-POE v7.4.8,build0929,250909 (GA)",
          port_id: "port4",
        },
        {
          local_port: "wbh1",
          chassis_id: "mac 80:80:2c:00:00:01",
          system_name: "CEDARS-234F-1",
          system_description: "FortiAP-234F v7.4.6,build0771,250814 (GA)",
          port_id: "80:80:2c:00:00:01",
        },
      ],
    };
    // Even when an AP is a mesh leaf, if it ALSO has a wired uplink active
    // we still prefer the LLDP-resolved wired path. parentApSerial is the
    // mesh peer; the topology layer can render both edges.
    expect(extractApLldpAndMesh(row)).toEqual({
      lldpUplinkSwitch: "CEDARS-108E-3",
      lldpUplinkPort: "port4",
      lldpLocalPort: "lan1",
      meshUplink: "mesh",
      parentApSerial: "FP234FTF23000001",
    });
  });
});

describe("parseApLldpNeighbors", () => {
  it("returns undefined when the row has no lldp array (don't-wipe signal)", () => {
    expect(parseApLldpNeighbors({})).toBeUndefined();
    expect(parseApLldpNeighbors({ lldp: "garbage" } as any)).toBeUndefined();
  });

  it("returns [] for a present-but-empty lldp array (real no-neighbors scrape)", () => {
    expect(parseApLldpNeighbors({ lldp: [] })).toEqual([]);
  });

  it("parses a wired FortiSwitch entry, splitting the FortiOS 'mac <value>' chassis_id packing", () => {
    const rows = parseApLldpNeighbors({
      lldp: [
        {
          local_port: "lan1",
          chassis_id: "mac e0:23:ff:00:00:01",
          system_name: "CEDARS-148E-1",
          system_description: "FortiSwitch-148E-POE v7.4.8,build0929,250909 (GA)",
          port_id: "port9",
          port_description: "CEDARS-221E-1",
        },
      ],
    });
    expect(rows).toEqual([
      {
        localIfName:       "lan1",
        chassisIdSubtype:  "macAddress",
        chassisId:         "E0:23:FF:00:00:01",
        portIdSubtype:     "interfaceName",
        portId:            "port9",
        portDescription:   "CEDARS-221E-1",
        systemName:        "CEDARS-148E-1",
        systemDescription: "FortiSwitch-148E-POE v7.4.8,build0929,250909 (GA)",
        managementIp:      null,
        capabilities:      [],
      },
    ]);
  });

  it("keeps ALL entries — mesh FortiAP peers included, unlike the uplink summary", () => {
    const rows = parseApLldpNeighbors({
      lldp: [
        {
          local_port: "lan1",
          chassis_id: "mac 94:f3:92:00:00:01",
          system_name: "CEDARS-124F-1",
          system_description: "FortiSwitch-124F-POE v7.4.8,build0929,250909 (GA)",
          port_id: "port12",
        },
        {
          local_port: "wbh1",
          chassis_id: "mac 80:80:2c:00:00:01",
          system_name: "CEDARS-234F-1",
          system_description: "FortiAP-234F v7.4.6,build0771,250814 (GA)",
          port_id: "80:80:2c:00:00:01",
        },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows![0].systemName).toBe("CEDARS-124F-1");
    // Mesh peer: bare-MAC port_id is inferred as macAddress and normalized
    // colon-uppercase so persist-time MAC matching can resolve the peer AP.
    expect(rows![1]).toMatchObject({
      localIfName:      "wbh1",
      chassisIdSubtype: "macAddress",
      chassisId:        "80:80:2C:00:00:01",
      portIdSubtype:    "macAddress",
      portId:           "80:80:2C:00:00:01",
      systemName:       "CEDARS-234F-1",
    });
  });

  it("infers macAddress for a bare-MAC chassis_id (no FortiOS token prefix)", () => {
    const rows = parseApLldpNeighbors({
      lldp: [{ local_port: "lan1", chassis_id: "e0-23-ff-00-00-01", system_name: "SW1" }],
    });
    expect(rows![0].chassisIdSubtype).toBe("macAddress");
    expect(rows![0].chassisId).toBe("E0:23:FF:00:00:01");
  });

  it("falls back to 'local' subtype for a non-MAC chassis_id (hostname-style)", () => {
    const rows = parseApLldpNeighbors({
      lldp: [{ local_port: "lan1", chassis_id: "core-switch-01", port_id: "Gi1/0/12" }],
    });
    expect(rows![0]).toMatchObject({
      chassisIdSubtype: "local",
      chassisId:        "core-switch-01",
      portIdSubtype:    "interfaceName",
      portId:           "Gi1/0/12",
    });
  });

  it("skips entries with no local_port and entries with no identity fields", () => {
    const rows = parseApLldpNeighbors({
      lldp: [
        { chassis_id: "mac e0:23:ff:00:00:01", system_name: "NO-ANCHOR" }, // no local_port
        { local_port: "lan1" },                                            // no identity at all
        { local_port: "lan1", system_name: "KEEP-ME" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows![0].systemName).toBe("KEEP-ME");
  });

  it("parses capability tokens when present (CSV string form)", () => {
    const rows = parseApLldpNeighbors({
      lldp: [{ local_port: "lan1", system_name: "SW1", capability: "Bridge, Router" }],
    });
    expect(rows![0].capabilities).toEqual(["bridge", "router"]);
  });
});
