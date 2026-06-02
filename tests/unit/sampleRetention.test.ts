/**
 * tests/unit/sampleRetention.test.ts
 *
 * Pure-logic coverage for the per-entity retention model and the tier router's
 * FOREVER/off encoding. DB-backed reads/writes (getSampleRetention /
 * updateSampleRetention) are not exercised here — only the pure functions.
 */

import { describe, it, expect, vi } from "vitest";

// sampleRetentionService imports prisma at module load; stub it so importing
// the pure helpers doesn't open a DB connection.
vi.mock("../../src/db.js", () => ({
  prisma: { setting: { findUnique: vi.fn(), upsert: vi.fn() } },
}));

import {
  defaultSampleRetention,
  getRetentionDays,
  FOREVER,
  UNSELECTED_DETAIL_HOURS,
  RETENTION_ENTITIES,
  SELECTION_AWARE_ENTITIES,
} from "../../src/services/sampleRetentionService.js";
import { pickSampleTier } from "../../src/services/sampleQueryRouter.js";

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600 * 1000);

describe("sampleRetentionService — entity model + encoding", () => {
  it("exposes the six entities, three of them selection-aware", () => {
    expect(RETENTION_ENTITIES).toEqual(["assets", "cpuMem", "temperature", "interfaces", "storage", "ipsec"]);
    expect(SELECTION_AWARE_ENTITIES).toEqual(["interfaces", "storage", "ipsec"]);
    expect(FOREVER).toBe(-1);
    expect(UNSELECTED_DETAIL_HOURS).toBe(24);
  });

  it("defaults every entity to 7/30/365", () => {
    const def = defaultSampleRetention();
    for (const e of RETENTION_ENTITIES) {
      expect(def[e]).toEqual({ detail: 7, hourly: 30, daily: 365 });
    }
  });

  it("getRetentionDays returns the stored value, including 0 (off) and FOREVER", () => {
    const r = defaultSampleRetention();
    r.interfaces = { detail: 3, hourly: 0, daily: FOREVER };
    expect(getRetentionDays(r, "interfaces", "detail")).toBe(3);
    expect(getRetentionDays(r, "interfaces", "hourly")).toBe(0);
    expect(getRetentionDays(r, "interfaces", "daily")).toBe(FOREVER);
  });
});

describe("pickSampleTier — FOREVER / off encoding", () => {
  it("reads detail when the window is within detailDays", () => {
    expect(pickSampleTier(daysAgo(3), { detailDays: 7, hourlyDays: 30 }).tier).toBe("detail");
  });

  it("drops to hourly when older than detail but within hourly", () => {
    expect(pickSampleTier(daysAgo(10), { detailDays: 7, hourlyDays: 30 }).tier).toBe("hourly");
  });

  it("drops to daily when older than hourly", () => {
    expect(pickSampleTier(daysAgo(100), { detailDays: 7, hourlyDays: 30 }).tier).toBe("daily");
  });

  it("FOREVER detail always reads detail, however old the query", () => {
    expect(pickSampleTier(daysAgo(9999), { detailDays: FOREVER, hourlyDays: 30 }).tier).toBe("detail");
  });

  it("detail=0 (tier off) falls through to hourly even for recent queries", () => {
    expect(pickSampleTier(daysAgo(1), { detailDays: 0, hourlyDays: 30 }).tier).toBe("hourly");
  });

  it("detail=0 and hourly=0 falls all the way to daily", () => {
    expect(pickSampleTier(daysAgo(1), { detailDays: 0, hourlyDays: 0 }).tier).toBe("daily");
  });

  it("FOREVER hourly covers an old query when detail doesn't", () => {
    expect(pickSampleTier(daysAgo(50), { detailDays: 7, hourlyDays: FOREVER }).tier).toBe("hourly");
  });
});
