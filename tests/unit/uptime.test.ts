import { describe, it, expect } from "vitest";
import { snmpTicksToSeconds, formatUptime } from "../../src/utils/uptime.js";

// Pure helpers — no DB, no network.

describe("snmpTicksToSeconds", () => {
  it("converts centiseconds to whole seconds", () => {
    expect(snmpTicksToSeconds(100)).toBe(1);
    expect(snmpTicksToSeconds(12345)).toBe(123);
    expect(snmpTicksToSeconds(0)).toBe(0);
  });

  it("accepts numeric strings", () => {
    expect(snmpTicksToSeconds("4200")).toBe(42);
  });

  it("returns null for invalid / negative input", () => {
    expect(snmpTicksToSeconds(null)).toBeNull();
    expect(snmpTicksToSeconds(undefined)).toBeNull();
    expect(snmpTicksToSeconds(-5)).toBeNull();
    expect(snmpTicksToSeconds("abc")).toBeNull();
    expect(snmpTicksToSeconds(NaN)).toBeNull();
  });
});

describe("formatUptime", () => {
  it("renders days + hours", () => {
    expect(formatUptime(42 * 86400 + 6 * 3600)).toBe("42d 6h");
  });

  it("drops a zero hours component", () => {
    expect(formatUptime(3 * 86400)).toBe("3d");
  });

  it("renders hours + minutes when under a day", () => {
    expect(formatUptime(6 * 3600 + 12 * 60)).toBe("6h 12m");
    expect(formatUptime(2 * 3600)).toBe("2h");
  });

  it("renders minutes when under an hour", () => {
    expect(formatUptime(12 * 60)).toBe("12m");
    expect(formatUptime(60)).toBe("1m");
  });

  it("renders <1m for sub-minute", () => {
    expect(formatUptime(0)).toBe("<1m");
    expect(formatUptime(59)).toBe("<1m");
  });

  it("returns em-dash for null / invalid", () => {
    expect(formatUptime(null)).toBe("—");
    expect(formatUptime(undefined)).toBe("—");
    expect(formatUptime(-1)).toBe("—");
    expect(formatUptime(NaN)).toBe("—");
  });
});
