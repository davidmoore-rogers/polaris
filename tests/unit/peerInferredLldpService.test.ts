/**
 * tests/unit/peerInferredLldpService.test.ts
 *
 * Pure-function coverage for the dedupe helper. The synthesis paths
 * (`buildInferredNeighborsForAsset`) hit Prisma directly and are
 * exercised by integration tests against /assets/:id/system-info.
 */

import { describe, it, expect } from "vitest";

import {
  dedupeInferredNeighbors,
  type InferredLldpNeighbor,
} from "../../src/services/peerInferredLldpService.js";

function inferred(localIfName: string, matchedId: string): InferredLldpNeighbor {
  return {
    localIfName,
    chassisIdSubtype: null,
    chassisId: null,
    portIdSubtype: null,
    portId: null,
    portDescription: null,
    systemName: "peer-" + matchedId,
    systemDescription: null,
    managementIp: null,
    capabilities: [],
    source: "peer-inferred",
    firstSeen: new Date(0),
    lastSeen: new Date(0),
    matchedAsset: { id: matchedId, hostname: null, ipAddress: null, assetType: "access_point" },
  };
}

function real(localIfName: string, matchedId: string | null) {
  return {
    localIfName,
    matchedAsset: matchedId ? { id: matchedId } : null,
  };
}

describe("dedupeInferredNeighbors", () => {
  it("returns all inferred when no real rows exist", () => {
    const out = dedupeInferredNeighbors([], [inferred("port1", "ap-a"), inferred("port2", "ap-b")]);
    expect(out).toHaveLength(2);
  });

  it("drops an inferred row when a real row exists on same (localIfName, matchedAssetId)", () => {
    const out = dedupeInferredNeighbors(
      [real("port1", "ap-a")],
      [inferred("port1", "ap-a"), inferred("port2", "ap-b")],
    );
    expect(out).toHaveLength(1);
    expect(out[0].matchedAsset.id).toBe("ap-b");
  });

  it("keeps inferred when a real row exists on the same port but for a different matched asset", () => {
    const out = dedupeInferredNeighbors(
      [real("port1", "switch-x")],
      [inferred("port1", "ap-a")],
    );
    expect(out).toHaveLength(1);
    expect(out[0].matchedAsset.id).toBe("ap-a");
  });

  it("keeps inferred when a real row on the same port has no matchedAsset (shared media)", () => {
    const out = dedupeInferredNeighbors(
      [real("port1", null)],
      [inferred("port1", "ap-a")],
    );
    expect(out).toHaveLength(1);
  });

  it("does not match across different ports even with same matchedAssetId", () => {
    const out = dedupeInferredNeighbors(
      [real("port1", "ap-a")],
      [inferred("port2", "ap-a")],
    );
    expect(out).toHaveLength(1);
    expect(out[0].localIfName).toBe("port2");
  });

  it("real rows with null localIfName don't suppress anything", () => {
    const out = dedupeInferredNeighbors(
      [{ localIfName: null, matchedAsset: { id: "ap-a" } }],
      [inferred("port1", "ap-a")],
    );
    expect(out).toHaveLength(1);
  });
});
