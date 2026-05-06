/**
 * tests/unit/pollingCompatibility.test.ts
 *
 * Locks down the compatibility matrix between asset sources and polling
 * methods. The matrix is operator-confirmed (see CLAUDE.md) and has
 * direct UX consequences — getting a value wrong here would silently
 * disable a working method on the asset edit modal or class-override
 * editor.
 */

import { describe, it, expect } from "vitest";
import {
  isPollingMethodCompatible,
  compatibleMethodsFor,
  allPollingMethods,
  isPollingMethod,
  pollingMethodLabel,
  assetSourceKindFromIntegrationType,
} from "../../src/utils/pollingCompatibility.js";

describe("compatibility matrix — locked values per asset source", () => {
  it("FortiManager: REST API + SNMP + SSH + ICMP, no WinRM", () => {
    expect(compatibleMethodsFor("fortimanager")).toEqual(["rest_api", "snmp", "ssh", "icmp"]);
    expect(isPollingMethodCompatible("fortimanager", "winrm")).toBe(false);
  });
  it("FortiGate: same as FortiManager", () => {
    expect(compatibleMethodsFor("fortigate")).toEqual(["rest_api", "snmp", "ssh", "icmp"]);
    expect(isPollingMethodCompatible("fortigate", "winrm")).toBe(false);
  });
  it("Active Directory: WinRM + SSH + ICMP (display order), no REST API or SNMP", () => {
    expect(compatibleMethodsFor("activedirectory")).toEqual(["winrm", "ssh", "icmp"]);
    expect(isPollingMethodCompatible("activedirectory", "rest_api")).toBe(false);
    expect(isPollingMethodCompatible("activedirectory", "snmp")).toBe(false);
    expect(isPollingMethodCompatible("activedirectory", "winrm")).toBe(true);
    expect(isPollingMethodCompatible("activedirectory", "ssh")).toBe(true);
    expect(isPollingMethodCompatible("activedirectory", "icmp")).toBe(true);
  });
  it("Entra ID: same as AD", () => {
    expect(isPollingMethodCompatible("entraid", "rest_api")).toBe(false);
    expect(isPollingMethodCompatible("entraid", "snmp")).toBe(false);
    expect(isPollingMethodCompatible("entraid", "winrm")).toBe(true);
    expect(isPollingMethodCompatible("entraid", "ssh")).toBe(true);
    expect(isPollingMethodCompatible("entraid", "icmp")).toBe(true);
  });
  it("Windows Server: same as AD", () => {
    expect(isPollingMethodCompatible("windowsserver", "rest_api")).toBe(false);
    expect(isPollingMethodCompatible("windowsserver", "winrm")).toBe(true);
    expect(isPollingMethodCompatible("windowsserver", "icmp")).toBe(true);
  });
  it("Manual: every method valid", () => {
    expect(compatibleMethodsFor("manual")).toEqual(["rest_api", "snmp", "winrm", "ssh", "icmp"]);
    allPollingMethods().forEach((m) => {
      expect(isPollingMethodCompatible("manual", m)).toBe(true);
    });
  });
});

describe("integrationType -> AssetSourceKind mapping", () => {
  it("recognized integration types map cleanly", () => {
    expect(assetSourceKindFromIntegrationType("fortimanager")).toBe("fortimanager");
    expect(assetSourceKindFromIntegrationType("fortigate")).toBe("fortigate");
    expect(assetSourceKindFromIntegrationType("activedirectory")).toBe("activedirectory");
    expect(assetSourceKindFromIntegrationType("entraid")).toBe("entraid");
    expect(assetSourceKindFromIntegrationType("windowsserver")).toBe("windowsserver");
  });
  it("null / undefined / unknown integration types fall back to manual", () => {
    expect(assetSourceKindFromIntegrationType(null)).toBe("manual");
    expect(assetSourceKindFromIntegrationType(undefined)).toBe("manual");
    expect(assetSourceKindFromIntegrationType("")).toBe("manual");
    expect(assetSourceKindFromIntegrationType("some-future-type")).toBe("manual");
  });
});

describe("isPollingMethod type guard", () => {
  it("accepts every valid polling method", () => {
    ["rest_api", "snmp", "winrm", "ssh", "icmp"].forEach((m) => {
      expect(isPollingMethod(m)).toBe(true);
    });
  });
  it("rejects non-method strings", () => {
    expect(isPollingMethod("rest")).toBe(false);          // legacy wire value, intentionally rejected
    expect(isPollingMethod("REST_API")).toBe(false);
    expect(isPollingMethod("fortimanager")).toBe(false);  // integration type, not a polling method
    expect(isPollingMethod("")).toBe(false);
  });
  it("rejects non-strings", () => {
    expect(isPollingMethod(null)).toBe(false);
    expect(isPollingMethod(undefined)).toBe(false);
    expect(isPollingMethod(42)).toBe(false);
    expect(isPollingMethod({})).toBe(false);
  });
});

describe("pollingMethodLabel — UI strings", () => {
  it("renders the operator-friendly forms (locked terminology)", () => {
    expect(pollingMethodLabel("rest_api")).toBe("REST API");
    expect(pollingMethodLabel("snmp")).toBe("SNMP");
    expect(pollingMethodLabel("winrm")).toBe("WinRM");
    expect(pollingMethodLabel("ssh")).toBe("SSH");
    expect(pollingMethodLabel("icmp")).toBe("ICMP");
  });
});
