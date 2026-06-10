/**
 * tests/unit/hardwareSensors.test.ts
 *
 * Covers the Hardware Sensors classification + alarm-normalization helpers.
 * The name-heuristic cases are drawn from a real FortiGate-201G fgHwSensorTable
 * walk (the device that motivated the feature): TMP/VOL/FAN/PSU/DISK/MV rows.
 */

import { describe, it, expect } from "vitest";
import {
  classifyHardwareSensor,
  normalizeFgAlarmStatus,
  normalizeRestAlarmStatus,
} from "../../src/utils/hardwareSensors.js";

describe("classifyHardwareSensor", () => {
  it("prefers the FortiOS REST type field when present", () => {
    expect(classifyHardwareSensor("anything", "temperature")).toEqual({ sensorClass: "temperature", unit: "°C" });
    expect(classifyHardwareSensor("anything", "fan")).toEqual({ sensorClass: "fan", unit: "RPM" });
    expect(classifyHardwareSensor("anything", "voltage")).toEqual({ sensorClass: "voltage", unit: "V" });
    expect(classifyHardwareSensor("anything", "power")).toEqual({ sensorClass: "power", unit: null });
  });

  it("classifies FortiGate-201G fgHwSensorTable names by heuristic", () => {
    // The exact rows from the SNMP walk that produced no temperatures before.
    expect(classifyHardwareSensor("TMP 1 CPUTIN").sensorClass).toBe("temperature");
    expect(classifyHardwareSensor("TMP 2 PECI").sensorClass).toBe("temperature");
    expect(classifyHardwareSensor("FAN 1 CPU FAN").sensorClass).toBe("fan");
    expect(classifyHardwareSensor("FAN 3 SYS FAN2").sensorClass).toBe("fan");
    expect(classifyHardwareSensor("VOL 1 PVCCIN_CPU").sensorClass).toBe("voltage");
    expect(classifyHardwareSensor("VOL 7 P3V3_STBY_A").sensorClass).toBe("voltage");
    expect(classifyHardwareSensor("PSU [1]").sensorClass).toBe("power");
    expect(classifyHardwareSensor("DISK NVMe1").sensorClass).toBe("disk");
    expect(classifyHardwareSensor("mvlgen_0").sensorClass).toBe("temperature");
    expect(classifyHardwareSensor("MV_88E1782").sensorClass).toBe("temperature");
  });

  it("assigns the right unit per class", () => {
    expect(classifyHardwareSensor("TMP 1 CPUTIN").unit).toBe("°C");
    expect(classifyHardwareSensor("FAN 1 CPU FAN").unit).toBe("RPM");
    expect(classifyHardwareSensor("VOL 1 PVCCIN_CPU").unit).toBe("V");
    expect(classifyHardwareSensor("DISK NVMe1").unit).toBe("°C");
  });

  it("falls back to 'other' with no unit for unrecognized names", () => {
    expect(classifyHardwareSensor("WIDGET 7")).toEqual({ sensorClass: "other", unit: null });
    expect(classifyHardwareSensor("")).toEqual({ sensorClass: "other", unit: null });
  });

  it("matches standard temperature-sensor names (ENTITY-MIB style)", () => {
    expect(classifyHardwareSensor("DTS CPU0").sensorClass).toBe("temperature");
    expect(classifyHardwareSensor("LM75 Board").sensorClass).toBe("temperature");
    expect(classifyHardwareSensor("Chassis Thermal").sensorClass).toBe("temperature");
  });
});

describe("normalizeFgAlarmStatus", () => {
  it("maps the fgHwSensorEntAlarmStatus integer", () => {
    expect(normalizeFgAlarmStatus(0)).toBe("ok");
    expect(normalizeFgAlarmStatus(1)).toBe("alarm");
    expect(normalizeFgAlarmStatus(null)).toBeNull();
    expect(normalizeFgAlarmStatus(undefined)).toBeNull();
  });
});

describe("normalizeRestAlarmStatus", () => {
  it("normalizes boolean / numeric / string alarm fields", () => {
    expect(normalizeRestAlarmStatus(true)).toBe("alarm");
    expect(normalizeRestAlarmStatus(false)).toBe("ok");
    expect(normalizeRestAlarmStatus(0)).toBe("ok");
    expect(normalizeRestAlarmStatus(1)).toBe("alarm");
    expect(normalizeRestAlarmStatus("false")).toBe("ok");
    expect(normalizeRestAlarmStatus("normal")).toBe("ok");
    expect(normalizeRestAlarmStatus("critical")).toBe("alarm");
    expect(normalizeRestAlarmStatus(null)).toBeNull();
    expect(normalizeRestAlarmStatus("")).toBeNull();
  });
});
