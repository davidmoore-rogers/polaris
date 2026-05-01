/**
 * tests/unit/assetProjection.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  projectAssetFromSources,
  type AssetSourceForProjection,
} from "../../src/utils/assetProjection.js";

function src(
  sourceKind: string,
  observed: Record<string, unknown>,
  inferred = false,
): AssetSourceForProjection {
  return { sourceKind, observed, inferred };
}

describe("projectAssetFromSources — empty + edge cases", () => {
  it("returns all-null projection for an asset with no sources", () => {
    const { projected, provenance } = projectAssetFromSources([]);
    expect(projected).toEqual({
      hostname: null,
      serialNumber: null,
      manufacturer: null,
      model: null,
      os: null,
      osVersion: null,
      learnedLocation: null,
      ipAddress: null,
      latitude: null,
      longitude: null,
    });
    expect(provenance).toEqual({});
  });

  it("ignores inferred sources entirely (phase-1 backfill skeletons)", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("ad", { dnsHostName: "old-laptop.contoso.com", operatingSystem: "Windows 10" }, true),
    ]);
    expect(projected.hostname).toBeNull();
    expect(projected.os).toBeNull();
    expect(provenance).toEqual({});
  });

  it("treats empty strings as no-opinion (falls through to next priority)", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { deviceName: "   " }), // whitespace-only
      src("entra", { displayName: "LAPTOP-01" }),
    ]);
    expect(projected.hostname).toBe("LAPTOP-01");
    expect(provenance.hostname).toBe("entra");
  });
});

describe("projectAssetFromSources — hostname priority", () => {
  it("intune wins over entra", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { deviceName: "INTUNE-NAME" }),
      src("entra", { displayName: "ENTRA-NAME" }),
    ]);
    expect(projected.hostname).toBe("INTUNE-NAME");
    expect(provenance.hostname).toBe("intune");
  });

  it("falls through to entra when intune deviceName is missing", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { serialNumber: "ABC123" }), // no deviceName
      src("entra", { displayName: "ENTRA-NAME" }),
    ]);
    expect(projected.hostname).toBe("ENTRA-NAME");
    expect(provenance.hostname).toBe("entra");
  });

  it("AD prefers dnsHostName over cn", () => {
    const { projected } = projectAssetFromSources([
      src("ad", { cn: "SHORTNAME", dnsHostName: "shortname.contoso.com" }),
    ]);
    expect(projected.hostname).toBe("shortname.contoso.com");
  });

  it("AD falls back to cn when dnsHostName is missing", () => {
    const { projected } = projectAssetFromSources([
      src("ad", { cn: "SHORTNAME" }),
    ]);
    expect(projected.hostname).toBe("SHORTNAME");
  });

  it("FortiGate firewall hostname when no other source contributes", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-firewall", { hostname: "fw-jefferson", serial: "FGT60FTK22000001" }),
    ]);
    expect(projected.hostname).toBe("fw-jefferson");
    expect(provenance.hostname).toBe("fortigate-firewall");
  });
});

describe("projectAssetFromSources — manufacturer + model + serial", () => {
  it("intune supplies hardware identity for endpoints", () => {
    const { projected } = projectAssetFromSources([
      src("intune", {
        serialNumber: "MP2YZAC2",
        manufacturer: "LENOVO",
        model: "83DG",
      }),
      src("entra", { displayName: "MP2YZAC2" }),
    ]);
    expect(projected.serialNumber).toBe("MP2YZAC2");
    expect(projected.manufacturer).toBe("LENOVO");
    expect(projected.model).toBe("83DG");
  });

  it("Fortinet manufacturer is always 'Fortinet' for firewall/switch/AP sources", () => {
    expect(
      projectAssetFromSources([src("fortigate-firewall", { serial: "FGT001" })]).projected.manufacturer,
    ).toBe("Fortinet");
    expect(
      projectAssetFromSources([src("fortiswitch", { serial: "S001" })]).projected.manufacturer,
    ).toBe("Fortinet");
    expect(
      projectAssetFromSources([src("fortiap", { serial: "AP001" })]).projected.manufacturer,
    ).toBe("Fortinet");
  });

  it("intune manufacturer wins over Fortinet fallback when both present", () => {
    // Hypothetical edge case — same asset has both sources. Intune wins.
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { manufacturer: "LENOVO" }),
      src("fortigate-firewall", { serial: "FGT001" }),
    ]);
    expect(projected.manufacturer).toBe("LENOVO");
    expect(provenance.manufacturer).toBe("intune");
  });
});

describe("projectAssetFromSources — os + osVersion", () => {
  it("intune wins over entra wins over AD on OS+version", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { operatingSystem: "Windows", osVersion: "10.0.26100" }),
      src("entra", { operatingSystem: "Windows", operatingSystemVersion: "10.0.22000" }),
      src("ad", { operatingSystem: "Windows 11 Pro", operatingSystemVersion: "10.0 (22621)" }),
    ]);
    expect(projected.os).toBe("Windows");
    expect(projected.osVersion).toBe("10.0.26100");
    expect(provenance.os).toBe("intune");
    expect(provenance.osVersion).toBe("intune");
  });

  it("FortiGate firewall osVersion when no Microsoft sources", () => {
    const { projected } = projectAssetFromSources([
      src("fortigate-firewall", { serial: "FGT001", osVersion: "v7.4.5" }),
    ]);
    expect(projected.osVersion).toBe("v7.4.5");
  });
});

describe("projectAssetFromSources — learnedLocation", () => {
  it("AD ouPath wins for endpoints", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("ad", { ouPath: "OU=HQ/OU=Workstations" }),
      src("entra", { displayName: "WS-01" }),
    ]);
    expect(projected.learnedLocation).toBe("OU=HQ/OU=Workstations");
    expect(provenance.learnedLocation).toBe("ad");
  });

  it("FortiSwitch reports controllerFortigate as location", () => {
    const { projected } = projectAssetFromSources([
      src("fortiswitch", { serial: "S001", controllerFortigate: "fw-jefferson" }),
    ]);
    expect(projected.learnedLocation).toBe("fw-jefferson");
  });

  it("FortiGate firewall does NOT project learnedLocation", () => {
    // The firewall's learnedLocation in legacy code is its own hostname,
    // which is already on Asset.hostname — projection deliberately leaves
    // learnedLocation null for firewalls so legacy "set when null"
    // behaviour continues to work.
    const { projected } = projectAssetFromSources([
      src("fortigate-firewall", { hostname: "fw-jefferson", serial: "FGT001" }),
    ]);
    expect(projected.learnedLocation).toBeNull();
  });
});

describe("projectAssetFromSources — ipAddress + lat/long", () => {
  it("FortiGate firewall mgmtIp + coordinates come from fortigate-firewall source", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-firewall", {
        serial: "FGT001",
        mgmtIp: "10.0.0.1",
        latitude: 38.123,
        longitude: -85.678,
      }),
    ]);
    expect(projected.ipAddress).toBe("10.0.0.1");
    expect(projected.latitude).toBe(38.123);
    expect(projected.longitude).toBe(-85.678);
    expect(provenance.ipAddress).toBe("fortigate-firewall");
    expect(provenance.latitude).toBe("fortigate-firewall");
  });

  it("endpoints (entra/intune/ad-only) get null ipAddress — DHCP-set values stay on Asset", () => {
    const { projected } = projectAssetFromSources([
      src("intune", { deviceName: "LAPTOP-01", serialNumber: "ABC123" }),
      src("entra", { displayName: "LAPTOP-01" }),
      src("ad", { dnsHostName: "laptop-01.contoso.com" }),
    ]);
    expect(projected.ipAddress).toBeNull();
    expect(projected.latitude).toBeNull();
    expect(projected.longitude).toBeNull();
  });

  it("non-numeric latitude/longitude is treated as missing", () => {
    const { projected } = projectAssetFromSources([
      src("fortigate-firewall", {
        serial: "FGT001",
        latitude: "38.123", // string, not number
        longitude: null,
      }),
    ]);
    expect(projected.latitude).toBeNull();
    expect(projected.longitude).toBeNull();
  });
});

describe("projectAssetFromSources — hybrid Windows laptop (full integration scenario)", () => {
  it("merges entra + intune + ad correctly with priorities", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("entra", {
        deviceId: "8f4e-...",
        displayName: "MP2YZAC2",
        operatingSystem: "Windows",
        operatingSystemVersion: "10.0",
        accountEnabled: true,
        onPremisesSecurityIdentifier: "S-1-5-21-...",
      }),
      src("intune", {
        azureADDeviceId: "8f4e-...",
        deviceName: "MP2YZAC2",
        operatingSystem: "Windows",
        osVersion: "10.0.26200.8246",
        serialNumber: "MP2YZAC2",
        manufacturer: "LENOVO",
        model: "83DG",
        userPrincipalName: "alice@contoso.com",
      }),
      src("ad", {
        objectGuid: "1234abcd...",
        cn: "MP2YZAC2",
        dnsHostName: "mp2yzac2.contoso.com",
        ouPath: "OU=HQ/OU=Workstations",
        operatingSystem: "Windows 11 Pro",
        operatingSystemVersion: "10.0 (26200)",
      }),
    ]);
    expect(projected).toEqual({
      hostname: "MP2YZAC2", // intune wins
      serialNumber: "MP2YZAC2",
      manufacturer: "LENOVO",
      model: "83DG",
      os: "Windows", // intune wins
      osVersion: "10.0.26200.8246", // intune wins
      learnedLocation: "OU=HQ/OU=Workstations", // ad
      ipAddress: null, // no source carries endpoint IP
      latitude: null,
      longitude: null,
    });
    expect(provenance.hostname).toBe("intune");
    expect(provenance.os).toBe("intune");
    expect(provenance.learnedLocation).toBe("ad");
  });
});
