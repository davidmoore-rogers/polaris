/**
 * tests/unit/fortiapMonitorRow.test.ts
 */

import { describe, it, expect } from "vitest";
import { deriveFortiapModelFromSerial, parseFortiapMonitorRow, isFortiapStatusOnline, isCanonicalFortiapVersion, FORTIAP_MONITOR_FORMAT } from "../../src/utils/fortiapMonitorRow.js";

describe("deriveFortiapModelFromSerial", () => {
  it("returns empty for missing/blank serial", () => {
    expect(deriveFortiapModelFromSerial("")).toBe("");
    expect(deriveFortiapModelFromSerial("   ")).toBe("");
  });

  it("returns empty for a serial that is not a FortiAP", () => {
    expect(deriveFortiapModelFromSerial("FGT60FTK19000000")).toBe("");
    expect(deriveFortiapModelFromSerial("S124DN3X16000000")).toBe("");
  });

  // The reported bug: the per-unit serial body starts with a digit, and the
  // old greedy {3,5} window swallowed it (231K5 instead of 231K).
  it("stops at the model code when the serial body starts with a digit", () => {
    expect(deriveFortiapModelFromSerial("FP231K5XYZ12345")).toBe("FortiAP-231K");
  });

  // The docstring's own example — broken under the old regex (gave 234FT).
  it("stops at the model code when the serial body starts with a letter", () => {
    expect(deriveFortiapModelFromSerial("FP234FTF21000000")).toBe("FortiAP-234F");
  });

  it("handles common indoor/outdoor models (3 digits + 1 letter)", () => {
    expect(deriveFortiapModelFromSerial("FP221E3X14000000")).toBe("FortiAP-221E");
    expect(deriveFortiapModelFromSerial("FP431G1A99000000")).toBe("FortiAP-431G");
    expect(deriveFortiapModelFromSerial("FP243KTF22000000")).toBe("FortiAP-243K");
  });

  it("handles the J-series (digits + J + letter)", () => {
    expect(deriveFortiapModelFromSerial("FP23JFTF21000000")).toBe("FortiAP-23JF");
  });

  it("handles U- and S-series with a leading family letter", () => {
    expect(deriveFortiapModelFromSerial("FPU431F3X16000000")).toBe("FortiAP-U431F");
    expect(deriveFortiapModelFromSerial("FPU421EV3X16000000")).toBe("FortiAP-U421EV");
    expect(deriveFortiapModelFromSerial("FPS321C3X16000000")).toBe("FortiAP-S321C");
  });

  it("uppercases lowercase input", () => {
    expect(deriveFortiapModelFromSerial("fp231k5xyz12345")).toBe("FortiAP-231K");
  });
});

describe("parseFortiapMonitorRow model derivation", () => {
  it("prefers the live model field over serial derivation", () => {
    const parsed = parseFortiapMonitorRow({ serial: "FP231K5XYZ12345", model: "FortiAP 231K" });
    expect(parsed.model).toBe("FortiAP 231K");
  });

  it("falls back to wtp_profile before serial derivation", () => {
    const parsed = parseFortiapMonitorRow({ serial: "FP231K5XYZ12345", wtp_profile: "office-231k" });
    expect(parsed.model).toBe("office-231k");
  });

  it("derives the model from the serial when model + wtp_profile are blank", () => {
    const parsed = parseFortiapMonitorRow({ serial: "FP231K5XYZ12345" });
    expect(parsed.model).toBe("FortiAP-231K");
  });
});

describe("parseFortiapMonitorRow IP picker", () => {
  it("prefers ip_addr over every other variant", () => {
    const parsed = parseFortiapMonitorRow({
      ip_addr: "10.0.0.1", local_addr: "10.0.0.2", connecting_from: "10.0.0.3",
    });
    expect(parsed.ipAddress).toBe("10.0.0.1");
  });

  // The reported bug: some FortiOS releases only populate local_addr /
  // connecting_from, which were not in the picker — the AP projected no IP.
  it("picks up local_addr when the ipv4 variants are absent", () => {
    const parsed = parseFortiapMonitorRow({ local_addr: "172.23.19.34" });
    expect(parsed.ipAddress).toBe("172.23.19.34");
  });

  it("falls back to connecting_from when nothing else is present", () => {
    const parsed = parseFortiapMonitorRow({ connecting_from: "172.23.19.34" });
    expect(parsed.ipAddress).toBe("172.23.19.34");
  });

  it("prefers local_addr over connecting_from", () => {
    const parsed = parseFortiapMonitorRow({ local_addr: "10.1.1.1", connecting_from: "203.0.113.9" });
    expect(parsed.ipAddress).toBe("10.1.1.1");
  });

  it("normalizes 0.0.0.0 to empty", () => {
    const parsed = parseFortiapMonitorRow({ local_addr: "0.0.0.0" });
    expect(parsed.ipAddress).toBe("");
  });

  it("returns empty when no IP field is present", () => {
    const parsed = parseFortiapMonitorRow({ name: "AP-1" });
    expect(parsed.ipAddress).toBe("");
  });

  // The format= filter must request every key the picker reads, or FortiOS
  // strips it from the response before the parser ever sees it.
  it("requests local_addr and connecting_from in the format= filter", () => {
    const fields = FORTIAP_MONITOR_FORMAT.split("|");
    expect(fields).toContain("local_addr");
    expect(fields).toContain("connecting_from");
  });
});

describe("parseFortiapMonitorRow lldpNeighbors pass-through", () => {
  it("carries the full parsed lldp table alongside the uplink summary", () => {
    const parsed = parseFortiapMonitorRow({
      name: "AP-1",
      lldp: [
        {
          local_port: "lan1",
          chassis_id: "mac e0:23:ff:00:00:01",
          system_name: "CEDARS-148E-1",
          system_description: "FortiSwitch-148E-POE v7.4.8,build0929,250909 (GA)",
          port_id: "port9",
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
    // Summary still distills the FortiSwitch uplink only…
    expect(parsed.peerSwitch).toBe("CEDARS-148E-1");
    expect(parsed.peerPort).toBe("port9");
    // …while lldpNeighbors carries every entry, mesh peer included.
    expect(parsed.lldpNeighbors).toHaveLength(2);
    expect(parsed.lldpNeighbors![1].systemName).toBe("CEDARS-234F-1");
  });

  it("omits lldpNeighbors entirely when the row has no lldp array (don't-wipe signal)", () => {
    const parsed = parseFortiapMonitorRow({ name: "AP-1" });
    expect(parsed.lldpNeighbors).toBeUndefined();
    expect("lldpNeighbors" in parsed).toBe(false);
  });

  it("carries an empty array for a present-but-empty lldp table", () => {
    const parsed = parseFortiapMonitorRow({ name: "AP-1", lldp: [] });
    expect(parsed.lldpNeighbors).toEqual([]);
  });
});

describe("parseFortiapMonitorRow mesh-leaf uplink inversion", () => {
  // A wireless-mesh leaf's uplink is its parent AP over the mesh backhaul.
  // A FortiSwitch visible in its LLDP table is a switch bridged BEHIND the
  // AP's LAN port — stamping it as peerSwitch would invert the topology
  // (the switch would render uplinked to the FortiGate instead of hanging
  // behind the AP on the Device Map).
  const meshLeafRow = {
    name: "FP234FTF21000002",
    mesh_uplink: "mesh",
    parent_wtp_id: "FP234FTF21001111",
    lldp: [
      {
        local_port: "eth0",
        chassis_id: "mac 94:ff:3c:00:00:01",
        system_name: "S108EFTQ21000001",
        system_description: "FortiSwitch-108E-POE v7.4.8,build0929,250909 (GA)",
        port_id: "port8",
      },
    ],
  };

  it("does NOT stamp a mesh leaf's LLDP-visible FortiSwitch as peerSwitch", () => {
    const parsed = parseFortiapMonitorRow(meshLeafRow);
    expect(parsed.meshUplink).toBe("mesh");
    expect(parsed.parentApSerial).toBe("FP234FTF21001111");
    expect(parsed.peerSwitch).toBeUndefined();
    expect(parsed.peerPort).toBeUndefined();
    expect(parsed.peerSource).toBeUndefined();
  });

  it("still carries the bridged switch in lldpNeighbors for bridge-edge detection", () => {
    const parsed = parseFortiapMonitorRow(meshLeafRow);
    expect(parsed.lldpNeighbors).toHaveLength(1);
    expect(parsed.lldpNeighbors![0].systemName).toBe("S108EFTQ21000001");
    expect(parsed.lldpNeighbors![0].portId).toBe("port8");
  });

  it("keeps stamping peerSwitch for an ethernet-uplink AP", () => {
    const parsed = parseFortiapMonitorRow({ ...meshLeafRow, mesh_uplink: "ethernet", parent_wtp_id: "" });
    expect(parsed.meshUplink).toBe("ethernet");
    expect(parsed.peerSwitch).toBe("S108EFTQ21000001");
    expect(parsed.peerPort).toBe("port8");
    expect(parsed.peerSource).toBe("lldp");
  });

  it("keeps stamping peerSwitch when mesh_uplink is absent (firmware omits the field)", () => {
    const { mesh_uplink: _m, parent_wtp_id: _p, ...bare } = meshLeafRow;
    const parsed = parseFortiapMonitorRow(bare);
    expect(parsed.peerSwitch).toBe("S108EFTQ21000001");
    expect(parsed.peerSource).toBe("lldp");
  });
});

describe("parseFortiapMonitorRow authorization state", () => {
  it("captures `state` separately from `status` (FortiOS 7.6.x shape)", () => {
    const parsed = parseFortiapMonitorRow({ name: "AP-1", status: "connected", state: "authorized" });
    expect(parsed.status).toBe("connected");
    expect(parsed.authorizationState).toBe("authorized");
  });

  it("still falls back status←state on firmware that omits status, while keeping authorizationState", () => {
    const parsed = parseFortiapMonitorRow({ name: "AP-1", state: "authorized" });
    expect(parsed.status).toBe("authorized");
    expect(parsed.authorizationState).toBe("authorized");
  });

  it("leaves authorizationState empty when the field is absent", () => {
    const parsed = parseFortiapMonitorRow({ name: "AP-1", status: "connected" });
    expect(parsed.authorizationState).toBe("");
  });
});

describe("parseFortiapMonitorRow profile", () => {
  it("captures wtp_profile as the AP profile", () => {
    const parsed = parseFortiapMonitorRow({ name: "AP-1", wtp_profile: "FAP231F-office" });
    expect(parsed.profile).toBe("FAP231F-office");
  });

  it("accepts the hyphenated CMDB spelling, preferring it when both are present", () => {
    expect(parseFortiapMonitorRow({ "wtp-profile": "warehouse" }).profile).toBe("warehouse");
    expect(parseFortiapMonitorRow({ "wtp-profile": "warehouse", wtp_profile: "office" }).profile)
      .toBe("warehouse");
  });

  it("is empty when the firmware omits the field", () => {
    expect(parseFortiapMonitorRow({ name: "AP-1", status: "connected" }).profile).toBe("");
  });

  // The profile doubles as the model fallback for rows with no model of their
  // own — carrying it in its own right must not disturb that.
  it("still stands in for a missing model without losing the profile", () => {
    const parsed = parseFortiapMonitorRow({ name: "AP-1", wtp_profile: "FAP231F-office" });
    expect(parsed.model).toBe("FAP231F-office");
    expect(parsed.profile).toBe("FAP231F-office");
  });
});

describe("parseFortiapMonitorRow osVersion (cached-fallback rejection)", () => {
  // Production incident 2026-07: FortiOS managed_ap rows carry TWO version
  // representations — os_version (live running firmware, canonical
  // "FP432F-v7.6.5-build1105") and version/firmware_version (a cached
  // display-format value like "7.4.5 Build 0734" that lags upgrades, or a
  // bare "FortiAP" placeholder). Whenever a scrape caught a row without
  // os_version, the old fallback wrote the stale cached value over the
  // canonical one — APs upgraded a week earlier still showed pre-upgrade
  // firmware in Polaris.
  it("prefers the canonical live os_version", () => {
    const parsed = parseFortiapMonitorRow({
      serial: "FP432FTF22000001",
      os_version: "FP432F-v7.6.5-build1105",
      version: "7.4.5 Build 0734",
    });
    expect(parsed.osVersion).toBe("FP432F-v7.6.5-build1105");
  });

  it("rejects a cached display-format fallback when os_version is absent", () => {
    const parsed = parseFortiapMonitorRow({
      serial: "FP432FTF22000001",
      version: "7.4.5 Build 0734",
      firmware_version: "7.4.5 Build 0734",
    });
    expect(parsed.osVersion).toBe("");
  });

  it("rejects the bare 'FortiAP' placeholder some rows carry", () => {
    const parsed = parseFortiapMonitorRow({ serial: "FP231K5N250000AE", version: "FortiAP" });
    expect(parsed.osVersion).toBe("");
  });

  it("accepts a canonical-shaped fallback when os_version is absent", () => {
    const parsed = parseFortiapMonitorRow({
      serial: "FP231K5N250000AH",
      firmware_version: "FP231K-v7.6.5-build1105",
    });
    expect(parsed.osVersion).toBe("FP231K-v7.6.5-build1105");
  });
});

describe("isCanonicalFortiapVersion", () => {
  it("matches live os_version shapes across model families", () => {
    expect(isCanonicalFortiapVersion("FP432F-v7.6.5-build1105")).toBe(true);
    expect(isCanonicalFortiapVersion("FP231K-v7.6.2-build0972")).toBe(true);
    expect(isCanonicalFortiapVersion("FP23JF-v7.6.5-build1105")).toBe(true);
    expect(isCanonicalFortiapVersion("FPU431F-v7.4.6-build0771")).toBe(true);
  });

  it("rejects cached display-format and placeholder values", () => {
    expect(isCanonicalFortiapVersion("7.4.5 Build 0734")).toBe(false);
    expect(isCanonicalFortiapVersion("7.6.2 Build 0972")).toBe(false);
    expect(isCanonicalFortiapVersion("FortiAP")).toBe(false);
    expect(isCanonicalFortiapVersion("")).toBe(false);
    expect(isCanonicalFortiapVersion(null)).toBe(false);
    expect(isCanonicalFortiapVersion(undefined)).toBe(false);
  });
});

describe("isFortiapStatusOnline", () => {
  // The production bug: FortiOS reports "online" on most releases (the
  // controller-status probe documents "online" | "offline" | "discovered"),
  // and the old /^connected$/-only gate evaluated every healthy AP on an
  // "online"-reporting fleet as offline — freezing lastSeen and gating off
  // the managed-ap LLDP persist fleet-wide.
  it("accepts 'online' (the common FortiOS value)", () => {
    expect(isFortiapStatusOnline("online")).toBe(true);
    expect(isFortiapStatusOnline("Online")).toBe(true);
  });

  it("accepts 'connected' (firmware-variant value)", () => {
    expect(isFortiapStatusOnline("connected")).toBe(true);
    expect(isFortiapStatusOnline("Connected")).toBe(true);
  });

  it("gives empty/missing status the benefit of the doubt", () => {
    expect(isFortiapStatusOnline("")).toBe(true);
    expect(isFortiapStatusOnline("   ")).toBe(true);
    expect(isFortiapStatusOnline(null)).toBe(true);
    expect(isFortiapStatusOnline(undefined)).toBe(true);
  });

  it("rejects offline / discovered / other states", () => {
    expect(isFortiapStatusOnline("offline")).toBe(false);
    expect(isFortiapStatusOnline("discovered")).toBe(false);
    expect(isFortiapStatusOnline("disconnected")).toBe(false);
    expect(isFortiapStatusOnline("connecting")).toBe(false);
  });
});
