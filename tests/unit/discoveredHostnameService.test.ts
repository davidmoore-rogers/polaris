/**
 * tests/unit/discoveredHostnameService.test.ts
 *
 * The discovery-projected hostname behind an operator hostname pin — the value
 * the assets list prints as a second line under an overridden hostname.
 *
 * Covers the pure grouping/projection core (which source wins per asset, and
 * the three "nothing to show" cases) plus the batched DB wrapper's contract:
 * no query for an empty id set, and ids with no sources absent from the map.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetSource: { findMany: vi.fn() },
  },
}));

import { prisma } from "../../src/db.js";
import {
  projectHostnamesFromSourceRows,
  getDiscoveredHostnames,
  getDiscoveredHostname,
  type HostnameSourceRow,
} from "../../src/services/discoveredHostnameService.js";

const findMany = prisma.assetSource.findMany as unknown as ReturnType<typeof vi.fn>;

function row(over: Partial<HostnameSourceRow> & { assetId: string }): HostnameSourceRow {
  return { sourceKind: "ad", inferred: false, observed: {}, ...over };
}

describe("projectHostnamesFromSourceRows", () => {
  it("groups by asset and projects each independently", () => {
    const out = projectHostnamesFromSourceRows([
      row({ assetId: "a1", sourceKind: "ad", observed: { dnsHostName: "PC-ONE.corp.local" } }),
      row({ assetId: "a2", sourceKind: "ad", observed: { dnsHostName: "PC-TWO.corp.local" } }),
    ]);
    expect(out.get("a1")).toBe("PC-ONE.corp.local");
    expect(out.get("a2")).toBe("PC-TWO.corp.local");
  });

  it("honors the projection priority — agent host-truth beats a directory record", () => {
    const out = projectHostnamesFromSourceRows([
      row({ assetId: "a1", sourceKind: "ad", observed: { dnsHostName: "OLD-NAME.corp.local" } }),
      row({ assetId: "a1", sourceKind: "polaris-agent", observed: { hostname: "REAL-NAME" } }),
    ]);
    expect(out.get("a1")).toBe("REAL-NAME");
  });

  it("returns null when no source has a hostname opinion", () => {
    const out = projectHostnamesFromSourceRows([
      row({ assetId: "a1", sourceKind: "manual", observed: {} }),
    ]);
    expect(out.get("a1")).toBeNull();
  });

  it("ignores inferred phase-1 skeleton rows", () => {
    const out = projectHostnamesFromSourceRows([
      row({ assetId: "a1", sourceKind: "ad", inferred: true, observed: { dnsHostName: "GHOST.corp.local" } }),
    ]);
    expect(out.get("a1")).toBeNull();
  });

  it("omits assets it was given no rows for", () => {
    const out = projectHostnamesFromSourceRows([]);
    expect(out.size).toBe(0);
  });
});

describe("getDiscoveredHostnames", () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it("issues no query for an empty id set", async () => {
    const out = await getDiscoveredHostnames([]);
    expect(out.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("scopes the read to the requested ids", async () => {
    findMany.mockResolvedValue([
      { assetId: "a1", sourceKind: "entra", inferred: false, observed: { displayName: "LAPTOP-7" } },
    ]);
    const out = await getDiscoveredHostnames(["a1", "a2"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ assetId: { in: ["a1", "a2"] } });
    expect(out.get("a1")).toBe("LAPTOP-7");
    // a2 reported no sources — absent, which the caller reads as "nothing to show".
    expect(out.has("a2")).toBe(false);
  });

  it("single-asset helper flattens a miss to null", async () => {
    findMany.mockResolvedValue([]);
    expect(await getDiscoveredHostname("a1")).toBeNull();
  });
});
