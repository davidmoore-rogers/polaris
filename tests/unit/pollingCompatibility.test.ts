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
  isMethodValidForStream,
  methodsForStream,
} from "../../src/utils/pollingCompatibility.js";

describe("compatibility matrix — locked values per asset source", () => {
  it("FortiManager: REST API + SNMP + SSH + ICMP + Disabled, no WinRM or Agent", () => {
    expect(compatibleMethodsFor("fortimanager")).toEqual(["rest_api", "snmp", "ssh", "icmp", "disabled"]);
    expect(isPollingMethodCompatible("fortimanager", "winrm")).toBe(false);
    expect(isPollingMethodCompatible("fortimanager", "agent")).toBe(false);
    expect(isPollingMethodCompatible("fortimanager", "disabled")).toBe(true);
  });
  it("FortiGate: same as FortiManager", () => {
    expect(compatibleMethodsFor("fortigate")).toEqual(["rest_api", "snmp", "ssh", "icmp", "disabled"]);
    expect(isPollingMethodCompatible("fortigate", "winrm")).toBe(false);
    expect(isPollingMethodCompatible("fortigate", "agent")).toBe(false);
    expect(isPollingMethodCompatible("fortigate", "disabled")).toBe(true);
  });
  it("Active Directory: WinRM + SSH + ICMP + Disabled + Agent (display order), no REST API or SNMP", () => {
    expect(compatibleMethodsFor("activedirectory")).toEqual(["winrm", "ssh", "icmp", "disabled", "agent"]);
    expect(isPollingMethodCompatible("activedirectory", "rest_api")).toBe(false);
    expect(isPollingMethodCompatible("activedirectory", "snmp")).toBe(false);
    expect(isPollingMethodCompatible("activedirectory", "winrm")).toBe(true);
    expect(isPollingMethodCompatible("activedirectory", "ssh")).toBe(true);
    expect(isPollingMethodCompatible("activedirectory", "icmp")).toBe(true);
    expect(isPollingMethodCompatible("activedirectory", "disabled")).toBe(true);
    expect(isPollingMethodCompatible("activedirectory", "agent")).toBe(true);
  });
  it("Entra ID: same as AD", () => {
    expect(isPollingMethodCompatible("entraid", "rest_api")).toBe(false);
    expect(isPollingMethodCompatible("entraid", "snmp")).toBe(false);
    expect(isPollingMethodCompatible("entraid", "winrm")).toBe(true);
    expect(isPollingMethodCompatible("entraid", "ssh")).toBe(true);
    expect(isPollingMethodCompatible("entraid", "icmp")).toBe(true);
    expect(isPollingMethodCompatible("entraid", "disabled")).toBe(true);
    expect(isPollingMethodCompatible("entraid", "agent")).toBe(true);
  });
  it("Windows Server: same as AD", () => {
    expect(isPollingMethodCompatible("windowsserver", "rest_api")).toBe(false);
    expect(isPollingMethodCompatible("windowsserver", "winrm")).toBe(true);
    expect(isPollingMethodCompatible("windowsserver", "icmp")).toBe(true);
    expect(isPollingMethodCompatible("windowsserver", "disabled")).toBe(true);
    expect(isPollingMethodCompatible("windowsserver", "agent")).toBe(true);
  });
  it("Manual: every method valid", () => {
    expect(compatibleMethodsFor("manual")).toEqual(["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled", "agent"]);
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
    ["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled", "agent"].forEach((m) => {
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

describe("per-stream method restrictions (cross-transport streams)", () => {
  it("original six streams impose no per-stream restriction (any method allowed)", () => {
    (["responseTime", "cpuMemory", "temperature", "interfaces", "lldp", "storage"] as const).forEach((s) => {
      allPollingMethods().forEach((m) => expect(isMethodValidForStream(s, m)).toBe(true));
      expect(methodsForStream(s)).toEqual(allPollingMethods());
    });
  });
  it("processes: agent/SNMP/SSH/WinRM only — no REST or ICMP", () => {
    expect(methodsForStream("processes")).toEqual(["snmp", "winrm", "ssh", "disabled", "agent"]);
    expect(isMethodValidForStream("processes", "agent")).toBe(true);
    expect(isMethodValidForStream("processes", "snmp")).toBe(true);
    expect(isMethodValidForStream("processes", "ssh")).toBe(true);
    expect(isMethodValidForStream("processes", "winrm")).toBe(true);
    expect(isMethodValidForStream("processes", "rest_api")).toBe(false);
    expect(isMethodValidForStream("processes", "icmp")).toBe(false);
  });
  it("eventLog: agent/SSH/WinRM/REST only — no SNMP or ICMP", () => {
    expect(methodsForStream("eventLog")).toEqual(["rest_api", "winrm", "ssh", "disabled", "agent"]);
    expect(isMethodValidForStream("eventLog", "agent")).toBe(true);
    expect(isMethodValidForStream("eventLog", "ssh")).toBe(true);
    expect(isMethodValidForStream("eventLog", "winrm")).toBe(true);
    expect(isMethodValidForStream("eventLog", "rest_api")).toBe(true);
    expect(isMethodValidForStream("eventLog", "snmp")).toBe(false);
    expect(isMethodValidForStream("eventLog", "icmp")).toBe(false);
  });
});

describe("pollingMethodLabel — UI strings", () => {
  it("renders the operator-friendly forms (locked terminology)", () => {
    expect(pollingMethodLabel("rest_api")).toBe("REST API");
    expect(pollingMethodLabel("snmp")).toBe("SNMP");
    expect(pollingMethodLabel("winrm")).toBe("WinRM");
    expect(pollingMethodLabel("ssh")).toBe("SSH");
    expect(pollingMethodLabel("icmp")).toBe("ICMP");
    expect(pollingMethodLabel("disabled")).toBe("Disabled");
    expect(pollingMethodLabel("agent")).toBe("Polaris Agent");
  });
});
