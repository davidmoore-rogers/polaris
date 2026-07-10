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
      snmpLocation: null,
      learnedAddress: null,
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
  it("AD's FQDN wins over Intune+Entra short forms (hybrid Windows endpoint)", () => {
    // Tuned from production drift: ~7k entries/24h showed Asset.hostname
    // (FQDN) drifting against an Intune/Entra-preferred projection (short).
    // AD's FQDN is more useful — operators search for it in DNS / logs.
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { deviceName: "MP2YZAC2" }),
      src("entra", { displayName: "MP2YZAC2" }),
      src("ad", { dnsHostName: "mp2yzac2.contoso.com", cn: "MP2YZAC2" }),
    ]);
    expect(projected.hostname).toBe("mp2yzac2.contoso.com");
    expect(provenance.hostname).toBe("ad");
  });

  it("intune wins over entra when no AD source", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { deviceName: "INTUNE-NAME" }),
      src("entra", { displayName: "ENTRA-NAME" }),
    ]);
    expect(projected.hostname).toBe("INTUNE-NAME");
    expect(provenance.hostname).toBe("intune");
  });

  it("intune wins when AD's dnsHostName is short-form (no dot — not FQDN)", () => {
    // The FQDN-first rule only kicks in when AD's dnsHostName contains a
    // dot. Short-form dnsHostName falls through to the regular priority.
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { deviceName: "LAPTOP-01" }),
      src("ad", { dnsHostName: "LAPTOP-01" }), // no dot
    ]);
    expect(projected.hostname).toBe("LAPTOP-01");
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

  it("AD-only device: dnsHostName preferred (FQDN form)", () => {
    const { projected } = projectAssetFromSources([
      src("ad", { cn: "SHORTNAME", dnsHostName: "shortname.contoso.com" }),
    ]);
    expect(projected.hostname).toBe("shortname.contoso.com");
  });

  it("AD-only device: falls back to cn when dnsHostName is missing", () => {
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
    // manufacturer flows through normalizeManufacturer; for inputs not in
    // the alias cache (which is empty in tests), it returns the value
    // unchanged. Real production has "Dell Inc." → "Dell" canonicalization
    // — covered by the manufacturerAliasService tests separately.
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
  it("AD wins on os when present (verbose Windows edition); Intune wins on osVersion (specific build)", () => {
    // Tuned from production drift: AD's verbose `operatingSystem` ("Windows
    // 10 Pro") carries the edition info Intune/Entra collapse out. For
    // version, Intune's 4-part build is more specific than AD's "10.0
    // (build)".
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { operatingSystem: "Windows", osVersion: "10.0.26100" }),
      src("entra", { operatingSystem: "Windows", operatingSystemVersion: "10.0.22000" }),
      src("ad", { operatingSystem: "Windows 11 Pro", operatingSystemVersion: "10.0 (22621)" }),
    ]);
    expect(projected.os).toBe("Windows 11 Pro");
    expect(projected.osVersion).toBe("10.0.26100");
    expect(provenance.os).toBe("ad");
    expect(provenance.osVersion).toBe("intune");
  });

  it("Intune wins on os when no AD source", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { operatingSystem: "iOS" }),
      src("entra", { operatingSystem: "iPadOS" }),
    ]);
    expect(projected.os).toBe("iOS");
    expect(provenance.os).toBe("intune");
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

  it("fortigate-endpoint DHCP/ARP binding wins for plain endpoints (no infra source)", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { deviceName: "LAPTOP-01" }),
      src("fortigate-endpoint", { ipAddress: "10.0.200.55", learnedLocation: "CKYSMA-91G-1" }),
    ]);
    expect(projected.ipAddress).toBe("10.0.200.55");
    expect(provenance.ipAddress).toBe("fortigate-endpoint");
    expect(projected.learnedLocation).toBe("CKYSMA-91G-1");
  });

  it("infrastructure mgmtIp beats a stale pre-adoption fortigate-endpoint sighting", () => {
    // The deployed-then-adopted scenario: a new FortiGate is first sighted
    // as a DHCP client of an existing gate (endpoint source with the leased
    // IP), then adopted into FMG (firewall source with the mgmt IP). The
    // mgmt IP must win or monitoring keeps probing the pre-adoption lease.
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-endpoint", { ipAddress: "10.0.200.30", learnedLocation: "CKYSMA-91G-1", hostname: "JEFFERSON-201G-1" }),
      src("fortigate-firewall", { serial: "FG2H1GT0000", mgmtIp: "10.255.250.201", hostname: "JEFFERSON-201G-1" }),
    ]);
    expect(projected.ipAddress).toBe("10.255.250.201");
    expect(provenance.ipAddress).toBe("fortigate-firewall");
    // And the sighting gate must not become the firewall's site label —
    // a firewall's learnedLocation is its own hostname, stamped inline by
    // the firewall sync (projection stays silent).
    expect(projected.learnedLocation).toBeNull();
  });

  it("adopted FortiSwitch: mgmtIp + controllerFortigate beat the endpoint sighting", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-endpoint", { ipAddress: "10.0.200.40", learnedLocation: "SOME-OTHER-GATE" }),
      src("fortiswitch", { switchId: "SW-LAB", serial: "S124FLAB", mgmtIp: "10.255.250.60", controllerFortigate: "CKYSMA-91G-1" }),
    ]);
    expect(projected.ipAddress).toBe("10.255.250.60");
    expect(provenance.ipAddress).toBe("fortiswitch");
    expect(projected.learnedLocation).toBe("CKYSMA-91G-1");
    expect(provenance.learnedLocation).toBe("fortiswitch");
  });

  it("infra source without a mgmtIp falls back to the endpoint sighting", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-firewall", { serial: "FGT002" }), // no mgmtIp observed
      src("fortigate-endpoint", { ipAddress: "10.0.200.30" }),
    ]);
    expect(projected.ipAddress).toBe("10.0.200.30");
    expect(provenance.ipAddress).toBe("fortigate-endpoint");
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

describe("projectAssetFromSources — learnedAddress", () => {
  it("comes from the fortigate-firewall metavarAddress", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-firewall", { serial: "FGT001", metavarAddress: "421 Great Circle Rd, Nashville TN" }),
    ]);
    expect(projected.learnedAddress).toBe("421 Great Circle Rd, Nashville TN");
    expect(provenance.learnedAddress).toBe("fortigate-firewall");
  });

  it("is null when no source carries an address metavar", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-firewall", { serial: "FGT001", mgmtIp: "10.0.0.1" }),
      src("ad", { dnsHostName: "fw.contoso.com" }),
    ]);
    expect(projected.learnedAddress).toBeNull();
    expect(provenance.learnedAddress).toBeUndefined();
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
      hostname: "mp2yzac2.contoso.com", // ad FQDN wins
      serialNumber: "MP2YZAC2",
      manufacturer: "LENOVO",
      model: "83DG",
      os: "Windows 11 Pro", // ad wins (edition info)
      osVersion: "10.0.26200.8246", // intune wins (specific build)
      learnedLocation: "OU=HQ/OU=Workstations", // ad
      ipAddress: null, // no source carries endpoint IP
      latitude: null,
      longitude: null,
      snmpLocation: null, // not a fortigate-firewall source
      learnedAddress: null, // not a fortigate-firewall source
    });
    expect(provenance.hostname).toBe("ad");
    expect(provenance.os).toBe("ad");
    expect(provenance.osVersion).toBe("intune");
    expect(provenance.learnedLocation).toBe("ad");
  });
});

// ─── vCenter sources (definitive below the agent) ───────────────────────────

describe("projectAssetFromSources — vCenter priority", () => {
  it("vcenter-vm beats AD / Intune / Entra / fortigate-endpoint on every field it carries", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("ad", { dnsHostName: "sql01.corp.local", operatingSystem: "Windows Server 2019 Standard" }),
      src("intune", { deviceName: "SQL01", operatingSystem: "Windows", manufacturer: "Dell Inc.", model: "PowerEdge R750" }),
      src("fortigate-endpoint", { hostname: "sql01-dhcp", ipAddress: "10.1.1.50", os: "Windows" }),
      src("vcenter-vm", {
        guestHostname: "sql01.corp.local",
        name: "prod-sql01",
        guestOsFullName: "Microsoft Windows Server 2022 (64-bit)",
        guestIp: "10.1.1.51",
      }),
    ]);
    expect(projected.hostname).toBe("sql01.corp.local");
    expect(provenance.hostname).toBe("vcenter-vm");
    expect(projected.os).toBe("Microsoft Windows Server 2022 (64-bit)");
    expect(provenance.os).toBe("vcenter-vm");
    // Live Tools-reported IP beats the DHCP sighting.
    expect(projected.ipAddress).toBe("10.1.1.51");
    expect(provenance.ipAddress).toBe("vcenter-vm");
    // Constant manufacturer/model for VMs (normalizeManufacturer preserves
    // the raw vendor string here; the ManufacturerAlias registry canonicalizes
    // at runtime when the operator has an alias configured).
    expect(projected.manufacturer).toBe("VMware, Inc.");
    expect(provenance.manufacturer).toBe("vcenter-vm");
    expect(projected.model).toBe("VMware Virtual Platform");
  });

  it("polaris-agent still wins over vcenter-vm (in-guest truth beats hypervisor view)", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("vcenter-vm", { guestHostname: "sql01", guestOsFullName: "Ubuntu Linux (64-bit)" }),
      src("polaris-agent", { hostname: "sql01.internal", os: "Ubuntu 24.04.1 LTS", manufacturer: "VMware, Inc.", model: "VMware Virtual Platform" }),
    ]);
    expect(projected.hostname).toBe("sql01.internal");
    expect(provenance.hostname).toBe("polaris-agent");
    expect(projected.os).toBe("Ubuntu 24.04.1 LTS");
    expect(provenance.os).toBe("polaris-agent");
  });

  it("vcenter-vm falls back to the VM display name when Tools is off (no guestHostname)", () => {
    const { projected } = projectAssetFromSources([
      src("vcenter-vm", { name: "appliance-01", guestHostname: null }),
    ]);
    expect(projected.hostname).toBe("appliance-01");
  });

  it("vcenter-host projects name / constant ESXi os / resolved IP, and never a serial", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("vcenter-host", { name: "esx01.corp.local", resolvedIp: "10.0.0.11" }),
    ]);
    expect(projected.hostname).toBe("esx01.corp.local");
    expect(projected.os).toBe("VMware ESXi");
    expect(projected.ipAddress).toBe("10.0.0.11");
    expect(provenance.ipAddress).toBe("vcenter-host");
    expect(projected.serialNumber).toBeNull();
    expect(projected.osVersion).toBeNull(); // version not exposed by REST — no rule
  });

  it("infrastructure mgmtIp still outranks the vcenter-vm guest IP (virtual FortiGate)", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("vcenter-vm", { guestIp: "10.9.9.9", name: "fgt-vm01" }),
      src("fortigate-firewall", { hostname: "fgt-vm01", mgmtIp: "10.0.0.254" }),
    ]);
    expect(projected.ipAddress).toBe("10.0.0.254");
    expect(provenance.ipAddress).toBe("fortigate-firewall");
  });
});
