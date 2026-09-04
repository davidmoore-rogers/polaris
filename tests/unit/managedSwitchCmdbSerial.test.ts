/**
 * tests/unit/managedSwitchCmdbSerial.test.ts
 *
 * `switch-id` is the managed-switch CMDB mkey and only DEFAULTS to the switch
 * serial; FortiLink setups frequently rename it to the hostname. Reading the
 * mkey alone therefore collects HOSTNAMES on a renamed fleet, and the FMG
 * roster's decommission protection compares what it collects against
 * `Asset.serialNumber` -- so it silently stopped matching, and a switch
 * authorized at FMG but absent from the live status query was decommissioned
 * rather than protected. Found 2026-09-03 against a live FortiManager.
 */

import { describe, it, expect } from "vitest";
import { readManagedSwitchCmdbSerial } from "../../src/utils/fortiswitchCmdb.js";

describe("readManagedSwitchCmdbSerial", () => {
  it("prefers sn when the mkey has been renamed to the hostname", () => {
    // The prod shape: switch-id carries the operator hostname.
    expect(readManagedSwitchCmdbSerial({
      "switch-id": "CARMOBILE-124F-1",
      sn: "S248EPTF0001",
      name: "CARMOBILE-124F-1",
    })).toBe("S248EPTF0001");
  });

  it("falls back to the mkey on a fleet that never renamed it", () => {
    // Default FortiOS: switch-id IS the serial and no sn is projected.
    expect(readManagedSwitchCmdbSerial({ "switch-id": "S248EPTF0002" })).toBe("S248EPTF0002");
  });

  it("prefers sn even when both are serial-shaped", () => {
    expect(readManagedSwitchCmdbSerial({ "switch-id": "S248EPTF0003", sn: "S248EPTF0003" }))
      .toBe("S248EPTF0003");
  });

  it("never accepts `name` as a serial", () => {
    // name is the operator display label. Accepting it is how a hostname
    // becomes a serial, which is the bug this helper exists to stop.
    expect(readManagedSwitchCmdbSerial({ name: "CARMOBILE-124F-1" })).toBeNull();
  });

  it("ignores an empty or whitespace sn and falls through", () => {
    expect(readManagedSwitchCmdbSerial({ sn: "   ", "switch-id": "S248EPTF0004" }))
      .toBe("S248EPTF0004");
  });

  it("trims surrounding whitespace", () => {
    expect(readManagedSwitchCmdbSerial({ sn: "  S248EPTF0005  " })).toBe("S248EPTF0005");
  });

  it("returns null for rows carrying neither key", () => {
    expect(readManagedSwitchCmdbSerial({ description: "spare" })).toBeNull();
    expect(readManagedSwitchCmdbSerial({ "switch-id": "", sn: "" })).toBeNull();
  });

  it("returns null for non-object input rather than throwing", () => {
    expect(readManagedSwitchCmdbSerial(null)).toBeNull();
    expect(readManagedSwitchCmdbSerial(undefined)).toBeNull();
    expect(readManagedSwitchCmdbSerial("S248EPTF0006")).toBeNull();
    expect(readManagedSwitchCmdbSerial(42)).toBeNull();
  });

  it("ignores non-string values in either field", () => {
    expect(readManagedSwitchCmdbSerial({ sn: 12345, "switch-id": "S248EPTF0007" }))
      .toBe("S248EPTF0007");
  });
});
