/**
 * tests/unit/dashSettingsService.test.ts
 *
 * dashConfig Setting-row persistence: safe-off defaults, tolerant parsing of
 * garbage rows, partial-merge save semantics, and the TTL cache (+ explicit
 * invalidate). Prisma is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import {
  getDashSettings,
  saveDashSettings,
  invalidateDashSettingsCache,
  defaultDashSettings,
  DASH_SETTING_KEY,
} from "../../src/services/dashSettingsService.js";
import { prisma } from "../../src/db.js";

type Mock = ReturnType<typeof vi.fn>;
const findUnique = prisma.setting.findUnique as unknown as Mock;
const upsert = prisma.setting.upsert as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateDashSettingsCache();
});

describe("defaults + parsing", () => {
  it("defaults to disabled + rfc1918Only", () => {
    expect(defaultDashSettings()).toEqual({ enabled: false, rfc1918Only: true });
  });

  it("returns defaults when no row exists", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getDashSettings()).toEqual({ enabled: false, rfc1918Only: true });
    expect(findUnique).toHaveBeenCalledWith({ where: { key: DASH_SETTING_KEY } });
  });

  it("tolerates a garbage row (non-object / wrong-typed fields)", async () => {
    findUnique.mockResolvedValue({ key: DASH_SETTING_KEY, value: "oops" });
    expect(await getDashSettings()).toEqual({ enabled: false, rfc1918Only: true });

    invalidateDashSettingsCache();
    findUnique.mockResolvedValue({ key: DASH_SETTING_KEY, value: { enabled: "yes", rfc1918Only: 0 } });
    expect(await getDashSettings()).toEqual({ enabled: false, rfc1918Only: true });
  });

  it("reads a valid row", async () => {
    findUnique.mockResolvedValue({ key: DASH_SETTING_KEY, value: { enabled: true, rfc1918Only: false } });
    expect(await getDashSettings()).toEqual({ enabled: true, rfc1918Only: false });
  });
});

describe("TTL cache", () => {
  it("serves from cache within the TTL and refetches after invalidate", async () => {
    findUnique.mockResolvedValue({ key: DASH_SETTING_KEY, value: { enabled: true, rfc1918Only: true } });
    await getDashSettings();
    await getDashSettings();
    expect(findUnique).toHaveBeenCalledTimes(1);

    invalidateDashSettingsCache();
    await getDashSettings();
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});

describe("saveDashSettings", () => {
  it("merges a partial input over the current value and upserts", async () => {
    findUnique.mockResolvedValue({ key: DASH_SETTING_KEY, value: { enabled: false, rfc1918Only: true } });
    upsert.mockResolvedValue({});
    const saved = await saveDashSettings({ enabled: true });
    expect(saved).toEqual({ enabled: true, rfc1918Only: true });
    expect(upsert).toHaveBeenCalledWith({
      where: { key: DASH_SETTING_KEY },
      update: { value: { enabled: true, rfc1918Only: true } },
      create: { key: DASH_SETTING_KEY, value: { enabled: true, rfc1918Only: true } },
    });
  });

  it("ignores wrong-typed fields in the input", async () => {
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({});
    const saved = await saveDashSettings({ enabled: "true" as unknown as boolean });
    expect(saved).toEqual({ enabled: false, rfc1918Only: true });
  });

  it("invalidates the cache so the next read sees the new value", async () => {
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({});
    await getDashSettings();
    await saveDashSettings({ enabled: true });
    findUnique.mockResolvedValue({ key: DASH_SETTING_KEY, value: { enabled: true, rfc1918Only: true } });
    expect((await getDashSettings()).enabled).toBe(true);
  });
});
