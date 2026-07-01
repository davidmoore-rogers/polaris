/**
 * tests/unit/fortiapMonitorRow.test.ts
 */

import { describe, it, expect } from "vitest";
import { deriveFortiapModelFromSerial, parseFortiapMonitorRow, FORTIAP_MONITOR_FORMAT } from "../../src/utils/fortiapMonitorRow.js";

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
          chassis_id: "mac e0:23:ff:36:26:ee",
          system_name: "MORGAN-148E-1",
          system_description: "FortiSwitch-148E-POE v7.4.8,build0929,250909 (GA)",
          port_id: "port9",
        },
        {
          local_port: "wbh1",
          chassis_id: "mac 80:80:2c:ae:99:58",
          system_name: "MORGAN-234F-1",
          system_description: "FortiAP-234F v7.4.6,build0771,250814 (GA)",
          port_id: "80:80:2c:ae:99:58",
        },
      ],
    });
    // Summary still distills the FortiSwitch uplink only…
    expect(parsed.peerSwitch).toBe("MORGAN-148E-1");
    expect(parsed.peerPort).toBe("port9");
    // …while lldpNeighbors carries every entry, mesh peer included.
    expect(parsed.lldpNeighbors).toHaveLength(2);
    expect(parsed.lldpNeighbors![1].systemName).toBe("MORGAN-234F-1");
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
