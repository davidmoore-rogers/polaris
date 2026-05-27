/**
 * tests/unit/fortiapMonitorRow.test.ts
 */

import { describe, it, expect } from "vitest";
import { deriveFortiapModelFromSerial, parseFortiapMonitorRow } from "../../src/utils/fortiapMonitorRow.js";

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
