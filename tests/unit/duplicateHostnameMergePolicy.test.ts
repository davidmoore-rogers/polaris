/**
 * tests/unit/duplicateHostnameMergePolicy.test.ts — the canonical-pick policy
 * behind the mergeDuplicateHostnameAssets sweep (extracted to
 * assetGhostMergeService by the 2026-08 audit precisely so it's testable).
 */

import { describe, it, expect } from "vitest";
import {
  decideDuplicateHostnameGroup,
  type DuplicateHostnameAssetRow,
} from "../../src/services/assetGhostMergeService.js";

function row(over: Partial<DuplicateHostnameAssetRow> & { id: string }): DuplicateHostnameAssetRow {
  return {
    hostname: "dup-host",
    ipAddress: null,
    macAddress: null,
    serialNumber: null,
    manufacturer: null,
    model: null,
    os: null,
    osVersion: null,
    assignedTo: null,
    notes: null,
    learnedLocation: null,
    acquiredAt: null,
    lastSeen: null,
    lastSeenSource: null,
    monitored: false,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    tags: [],
    sources: [],
    ...over,
  };
}

describe("decideDuplicateHostnameGroup", () => {
  it("identity-tagged (entra) beats fortigate-endpoint regardless of recency", () => {
    const endpoint = row({ id: "e", sources: [{ sourceKind: "fortigate-endpoint" }], lastSeen: new Date("2026-06-01") });
    const entra = row({ id: "a", sources: [{ sourceKind: "entra" }], lastSeen: new Date("2026-01-01") });
    const d = decideDuplicateHostnameGroup([endpoint, entra]);
    expect(d.kind).toBe("merge");
    if (d.kind === "merge") {
      expect(d.canonical.id).toBe("a");
      expect(d.ghosts.map((g) => g.id)).toEqual(["e"]);
      expect(d.tiers).toEqual([1, 5]);
    }
  });

  it("managed switch (tier 2) beats firewall (4), endpoint (5), manual (6), orphan (7)", () => {
    const d = decideDuplicateHostnameGroup([
      row({ id: "orphan" }),
      row({ id: "manual", sources: [{ sourceKind: "manual" }] }),
      row({ id: "fw", sources: [{ sourceKind: "fortigate-firewall" }] }),
      row({ id: "sw", sources: [{ sourceKind: "fortiswitch" }] }),
      row({ id: "ep", sources: [{ sourceKind: "fortigate-endpoint" }] }),
    ]);
    expect(d.kind).toBe("merge");
    if (d.kind === "merge") expect(d.canonical.id).toBe("sw");
  });

  it("the best tier across an asset's sources wins (endpoint+ad row ranks tier 1)", () => {
    const d = decideDuplicateHostnameGroup([
      row({ id: "hybrid", sources: [{ sourceKind: "fortigate-endpoint" }, { sourceKind: "ad" }] }),
      row({ id: "plain", sources: [{ sourceKind: "fortigate-endpoint" }] }),
    ]);
    expect(d.kind).toBe("merge");
    if (d.kind === "merge") expect(d.canonical.id).toBe("hybrid");
  });

  it("same tier: most-recent lastSeen wins, then most-recent updatedAt", () => {
    const older = row({ id: "old", sources: [{ sourceKind: "ad" }], lastSeen: new Date("2026-02-01") });
    const newer = row({ id: "new", sources: [{ sourceKind: "entra" }], lastSeen: new Date("2026-03-01") });
    const d1 = decideDuplicateHostnameGroup([older, newer]);
    expect(d1.kind === "merge" && d1.canonical.id).toBe("new");

    const a = row({ id: "a", sources: [{ sourceKind: "ad" }], updatedAt: new Date("2026-02-01") });
    const b = row({ id: "b", sources: [{ sourceKind: "ad" }], updatedAt: new Date("2026-03-01") });
    const d2 = decideDuplicateHostnameGroup([a, b]);
    expect(d2.kind === "merge" && d2.canonical.id).toBe("b");
  });

  it("skips a group where same-tier siblings carry conflicting non-null MACs", () => {
    const d = decideDuplicateHostnameGroup([
      row({ id: "x", sources: [{ sourceKind: "entra" }], macAddress: "AA:BB:CC:DD:EE:01" }),
      row({ id: "y", sources: [{ sourceKind: "ad" }], macAddress: "AA:BB:CC:DD:EE:02" }),
    ]);
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") expect(d.reason).toContain("conflicting MACs");
  });

  it("does NOT skip when the conflicting-MAC sibling sits at a lower tier", () => {
    const d = decideDuplicateHostnameGroup([
      row({ id: "x", sources: [{ sourceKind: "entra" }], macAddress: "AA:BB:CC:DD:EE:01" }),
      row({ id: "y", sources: [{ sourceKind: "fortigate-endpoint" }], macAddress: "AA:BB:CC:DD:EE:02" }),
    ]);
    expect(d.kind).toBe("merge");
  });

  it("matching MACs in different formats do not trigger the skip", () => {
    const d = decideDuplicateHostnameGroup([
      row({ id: "x", sources: [{ sourceKind: "entra" }], macAddress: "AA:BB:CC:DD:EE:01" }),
      row({ id: "y", sources: [{ sourceKind: "ad" }], macAddress: "aa-bb-cc-dd-ee-01" }),
    ]);
    expect(d.kind).toBe("merge");
  });

  it("all-zero MACs never count as conflicting (rejected by the match key)", () => {
    const d = decideDuplicateHostnameGroup([
      row({ id: "x", sources: [{ sourceKind: "entra" }], macAddress: "00:00:00:00:00:00" }),
      row({ id: "y", sources: [{ sourceKind: "ad" }], macAddress: "AA:BB:CC:DD:EE:02" }),
    ]);
    expect(d.kind).toBe("merge");
  });
});
