/**
 * tests/unit/assetSourceDerivation.test.ts
 *
 * Behavior tests for the pure (no-DB) `deriveAssetSources` helper.
 */

import { describe, it, expect } from "vitest";
import {
  deriveAssetSources,
  type AssetSnapshot,
  type DerivedSource,
} from "../../src/utils/assetSourceDerivation.js";

/** Build a fully-null AssetSnapshot, overriding only what a test cares about. */
function makeAsset(overrides: Partial<AssetSnapshot> = {}): AssetSnapshot {
  return {
    id: "asset-id-1",
    assetTag: null,
    tags: [],
    discoveredByIntegrationId: null,
    hostname: null,
    ipAddress: null,
    os: null,
    osVersion: null,
    serialNumber: null,
    manufacturer: null,
    model: null,
    assetType: null,
    status: null,
    learnedLocation: null,
    dnsName: null,
    latitude: null,
    longitude: null,
    acquiredAt: null,
    lastSeen: null,
    createdBy: null,
    ...overrides,
  };
}

function primary(sources: DerivedSource[]): DerivedSource {
  return sources[0];
}

describe("deriveAssetSources — assetTag prefix parsing", () => {
  it("derives an entra source from an `entra:` tag, lowercasing the deviceId", () => {
    const sources = deriveAssetSources(
      makeAsset({ assetTag: "entra:ABC-123-DEF", discoveredByIntegrationId: "int-entra" }),
    );
    expect(sources).toHaveLength(1);
    const s = primary(sources);
    expect(s.sourceKind).toBe("entra");
    expect(s.externalId).toBe("abc-123-def");
    expect(s.integrationId).toBe("int-entra");
    expect(s.inferred).toBe(false);
  });

  it("derives an ad source from an `ad:` tag, lowercasing the GUID", () => {
    const sources = deriveAssetSources(
      makeAsset({ assetTag: "ad:GUID-XYZ", discoveredByIntegrationId: "int-ad" }),
    );
    expect(sources).toHaveLength(1);
    const s = primary(sources);
    expect(s.sourceKind).toBe("ad");
    expect(s.externalId).toBe("guid-xyz");
    expect(s.integrationId).toBe("int-ad");
    expect(s.inferred).toBe(false);
  });

  it("derives a fortigate-firewall source from an `fgt:` tag, preferring the canonical serialNumber", () => {
    const sources = deriveAssetSources(
      makeAsset({
        assetTag: "fgt:FG-TAGSERIAL",
        serialNumber: "FG-REALSERIAL",
        discoveredByIntegrationId: "int-fgt",
      }),
    );
    expect(sources).toHaveLength(1);
    const s = primary(sources);
    expect(s.sourceKind).toBe("fortigate-firewall");
    // serialNumber field wins over the tag-embedded serial, and is NOT lowercased.
    expect(s.externalId).toBe("FG-REALSERIAL");
    expect(s.inferred).toBe(false);
  });

  it("falls back to the tag-embedded serial when the asset has no serialNumber", () => {
    const sources = deriveAssetSources(
      makeAsset({ assetTag: "fgt:FG-FROMTAG", serialNumber: null }),
    );
    expect(primary(sources).sourceKind).toBe("fortigate-firewall");
    expect(primary(sources).externalId).toBe("FG-FROMTAG");
  });
});

describe("deriveAssetSources — empty / unrecognized tags fall through to manual", () => {
  it("treats an `entra:` tag with no deviceId as no primary source (manual fallback)", () => {
    const sources = deriveAssetSources(makeAsset({ assetTag: "entra:   ", id: "a1" }));
    expect(sources).toHaveLength(1);
    expect(primary(sources).sourceKind).toBe("manual");
    expect(primary(sources).externalId).toBe("a1");
  });

  it("treats an `ad:` tag with no GUID as manual fallback", () => {
    const sources = deriveAssetSources(makeAsset({ assetTag: "ad:", id: "a2" }));
    expect(sources).toHaveLength(1);
    expect(primary(sources).sourceKind).toBe("manual");
    expect(primary(sources).externalId).toBe("a2");
  });

  it("treats an `fgt:` tag with no serial and no serialNumber as manual fallback", () => {
    const sources = deriveAssetSources(makeAsset({ assetTag: "fgt:", serialNumber: null, id: "a3" }));
    expect(sources).toHaveLength(1);
    expect(primary(sources).sourceKind).toBe("manual");
    expect(primary(sources).externalId).toBe("a3");
  });

  it("treats an unrecognized prefix as manual fallback", () => {
    const sources = deriveAssetSources(makeAsset({ assetTag: "vmware:vm-99", id: "a4" }));
    expect(sources).toHaveLength(1);
    expect(primary(sources).sourceKind).toBe("manual");
    expect(primary(sources).externalId).toBe("a4");
  });

  it("treats a whitespace-only assetTag as no tag (manual fallback)", () => {
    const sources = deriveAssetSources(makeAsset({ assetTag: "   ", id: "a5" }));
    expect(primary(sources).sourceKind).toBe("manual");
    expect(primary(sources).externalId).toBe("a5");
  });
});

describe("deriveAssetSources — manual fallback", () => {
  it("synthesizes a manual source keyed on asset id for a tag-less asset", () => {
    const sources = deriveAssetSources(makeAsset({ id: "the-asset", assetTag: null }));
    expect(sources).toHaveLength(1);
    const s = primary(sources);
    expect(s.sourceKind).toBe("manual");
    expect(s.externalId).toBe("the-asset");
    expect(s.integrationId).toBeNull();
    expect(s.inferred).toBe(false);
    expect(s.observed).toEqual({});
  });

  it("records createdBy in the manual observed blob when present", () => {
    const sources = deriveAssetSources(makeAsset({ assetTag: null, createdBy: "alice" }));
    expect(primary(sources).observed).toEqual({ createdBy: "alice" });
  });
});

describe("deriveAssetSources — Fortinet infra fallback (no assetTag prefix)", () => {
  it("derives fortigate-firewall for a Fortinet firewall with a serial and no tag", () => {
    const sources = deriveAssetSources(
      makeAsset({ manufacturer: "Fortinet", assetType: "firewall", serialNumber: "FG-1" }),
    );
    expect(sources).toHaveLength(1);
    expect(primary(sources).sourceKind).toBe("fortigate-firewall");
    expect(primary(sources).externalId).toBe("FG-1");
  });

  it("derives fortiswitch for a Fortinet switch with a serial and no tag", () => {
    const sources = deriveAssetSources(
      makeAsset({ manufacturer: "fortinet", assetType: "switch", serialNumber: "FS-1" }),
    );
    expect(primary(sources).sourceKind).toBe("fortiswitch");
    expect(primary(sources).externalId).toBe("FS-1");
  });

  it("derives fortiap for a Fortinet access_point with a serial and no tag", () => {
    const sources = deriveAssetSources(
      makeAsset({ manufacturer: "FORTINET", assetType: "access_point", serialNumber: "FAP-1" }),
    );
    expect(primary(sources).sourceKind).toBe("fortiap");
    expect(primary(sources).externalId).toBe("FAP-1");
  });

  it("falls back to manual for a Fortinet device of an unhandled assetType", () => {
    const sources = deriveAssetSources(
      makeAsset({ manufacturer: "Fortinet", assetType: "router", serialNumber: "FR-1", id: "fr" }),
    );
    expect(primary(sources).sourceKind).toBe("manual");
    expect(primary(sources).externalId).toBe("fr");
  });

  it("falls back to manual for a Fortinet firewall with no serial", () => {
    const sources = deriveAssetSources(
      makeAsset({ manufacturer: "Fortinet", assetType: "firewall", serialNumber: null, id: "ns" }),
    );
    expect(primary(sources).sourceKind).toBe("manual");
    expect(primary(sources).externalId).toBe("ns");
  });

  it("falls back to manual for a non-Fortinet switch even with a serial", () => {
    const sources = deriveAssetSources(
      makeAsset({ manufacturer: "Cisco", assetType: "switch", serialNumber: "CS-1", id: "cs" }),
    );
    expect(primary(sources).sourceKind).toBe("manual");
    expect(primary(sources).externalId).toBe("cs");
  });

  it("does NOT use the Fortinet fallback when an assetTag prefix already produced a source", () => {
    // entra: tag produces an entra source; the Fortinet-firewall fallback must not also fire.
    const sources = deriveAssetSources(
      makeAsset({
        assetTag: "entra:dev-1",
        manufacturer: "Fortinet",
        assetType: "firewall",
        serialNumber: "FG-X",
      }),
    );
    expect(sources.some((s) => s.sourceKind === "fortigate-firewall")).toBe(false);
    expect(primary(sources).sourceKind).toBe("entra");
  });
});

describe("deriveAssetSources — inferred AD recovery from ad-guid: breadcrumb", () => {
  it("emits an inferred AD source alongside the entra primary when an ad-guid: tag exists", () => {
    const sources = deriveAssetSources(
      makeAsset({
        assetTag: "entra:dev-1",
        tags: ["ad-guid:RECOVER-GUID"],
        discoveredByIntegrationId: "int-entra",
      }),
    );
    expect(sources).toHaveLength(2);
    expect(sources[0].sourceKind).toBe("entra");

    const ad = sources.find((s) => s.sourceKind === "ad");
    expect(ad).toBeDefined();
    expect(ad!.externalId).toBe("recover-guid");
    expect(ad!.inferred).toBe(true);
    expect(ad!.integrationId).toBeNull(); // linkage not reconstructable
    expect(ad!.observed).toEqual({ objectGuid: "recover-guid", recovered: "ad-guid-tag" });
  });

  it("does NOT recover an AD source from an ad-guid: tag when the primary is not entra", () => {
    const sources = deriveAssetSources(
      makeAsset({ assetTag: "ad:primary-guid", tags: ["ad-guid:other"] }),
    );
    // Only the primary ad source — the recovery block is gated on an entra: tag.
    expect(sources).toHaveLength(1);
    expect(primary(sources).sourceKind).toBe("ad");
    expect(primary(sources).externalId).toBe("primary-guid");
    expect(primary(sources).inferred).toBe(false);
  });

  it("ignores an empty ad-guid: breadcrumb", () => {
    const sources = deriveAssetSources(
      makeAsset({ assetTag: "entra:dev-1", tags: ["ad-guid:  "] }),
    );
    expect(sources).toHaveLength(1);
    expect(primary(sources).sourceKind).toBe("entra");
  });

  it("recovers multiple distinct ad-guid: breadcrumbs", () => {
    const sources = deriveAssetSources(
      makeAsset({ assetTag: "entra:dev-1", tags: ["ad-guid:g1", "ad-guid:g2"] }),
    );
    const adIds = sources.filter((s) => s.sourceKind === "ad").map((s) => s.externalId).sort();
    expect(adIds).toEqual(["g1", "g2"]);
  });
});

describe("deriveAssetSources — observed payloads", () => {
  it("populates the entra observed blob with sid from a sid: tag and accountEnabled from status", () => {
    const sources = deriveAssetSources(
      makeAsset({
        assetTag: "entra:dev-9",
        tags: ["sid:S-1-5-99"],
        hostname: "HOST9",
        os: "Windows",
        osVersion: "11",
        status: "active",
      }),
    );
    const obs = primary(sources).observed;
    expect(obs.deviceId).toBe("dev-9");
    expect(obs.displayName).toBe("HOST9");
    expect(obs.operatingSystem).toBe("Windows");
    expect(obs.operatingSystemVersion).toBe("11");
    expect(obs.accountEnabled).toBe(true);
    expect(obs.onPremisesSecurityIdentifier).toBe("S-1-5-99");
  });

  it("marks accountEnabled=false for a disabled entra device and omits sid when absent", () => {
    const sources = deriveAssetSources(
      makeAsset({ assetTag: "entra:dev-9", status: "disabled" }),
    );
    const obs = primary(sources).observed;
    expect(obs.accountEnabled).toBe(false);
    expect(obs).not.toHaveProperty("onPremisesSecurityIdentifier");
  });

  it("populates the ad observed blob, defaulting dnsHostName to hostname and serializing dates", () => {
    const acquired = new Date("2026-01-01T00:00:00.000Z");
    const seen = new Date("2026-06-01T12:00:00.000Z");
    const sources = deriveAssetSources(
      makeAsset({
        assetTag: "ad:guid-7",
        tags: ["sid:S-1-5-7"],
        hostname: "PC7",
        dnsName: null,
        learnedLocation: "OU=Sales",
        status: "decommissioned",
        acquiredAt: acquired,
        lastSeen: seen,
      }),
    );
    const obs = primary(sources).observed;
    expect(obs.objectGuid).toBe("guid-7");
    expect(obs.cn).toBe("PC7");
    expect(obs.dnsHostName).toBe("PC7"); // falls back to hostname when dnsName null
    expect(obs.ouPath).toBe("OU=Sales");
    expect(obs.accountDisabled).toBe(true);
    expect(obs.whenCreated).toBe(acquired.toISOString());
    expect(obs.lastLogonTimestamp).toBe(seen.toISOString());
    expect(obs.objectSid).toBe("S-1-5-7");
  });

  it("nulls ad date fields when acquiredAt / lastSeen are absent", () => {
    const sources = deriveAssetSources(makeAsset({ assetTag: "ad:guid-7" }));
    const obs = primary(sources).observed;
    expect(obs.whenCreated).toBeNull();
    expect(obs.lastLogonTimestamp).toBeNull();
  });

  it("populates the fortigate-firewall observed blob with geo + mgmt fields", () => {
    const sources = deriveAssetSources(
      makeAsset({
        assetTag: "fgt:ignored",
        serialNumber: "FG-100",
        hostname: "edge-fw",
        model: "FG-100F",
        osVersion: "7.4.3",
        ipAddress: "10.0.0.1",
        latitude: 36.1,
        longitude: -86.7,
      }),
    );
    expect(primary(sources).observed).toEqual({
      serial: "FG-100",
      hostname: "edge-fw",
      model: "FG-100F",
      osVersion: "7.4.3",
      mgmtIp: "10.0.0.1",
      latitude: 36.1,
      longitude: -86.7,
    });
  });
});

describe("deriveAssetSources — defensive input handling", () => {
  it("tolerates a non-array tags value", () => {
    const asset = makeAsset({ assetTag: "entra:dev-1" });
    // Force a malformed tags value the way a legacy row might carry it.
    (asset as unknown as { tags: unknown }).tags = null;
    const sources = deriveAssetSources(asset);
    expect(sources).toHaveLength(1);
    expect(primary(sources).sourceKind).toBe("entra");
  });
});
