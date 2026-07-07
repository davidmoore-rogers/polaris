/**
 * tests/unit/updateTrain.test.ts
 *
 * update.train Setting persistence: default to "nightly", read "release" only
 * on the exact stored value, tolerate a missing row / DB error, and normalize
 * unknown values to "nightly" on write. Prisma is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import { getUpdateTrain, setUpdateTrain } from "../../src/services/updateService.js";
import { prisma } from "../../src/db.js";

type Mock = ReturnType<typeof vi.fn>;
const findUnique = prisma.setting.findUnique as unknown as Mock;
const upsert = prisma.setting.upsert as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getUpdateTrain", () => {
  it("defaults to nightly when no row exists", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getUpdateTrain()).toBe("nightly");
  });

  it("returns release when the stored value is exactly \"release\"", async () => {
    findUnique.mockResolvedValue({ key: "update.train", value: "release" });
    expect(await getUpdateTrain()).toBe("release");
  });

  it("falls back to nightly for any non-release value", async () => {
    findUnique.mockResolvedValue({ key: "update.train", value: "stable" });
    expect(await getUpdateTrain()).toBe("nightly");
  });

  it("tolerates a DB error and returns nightly", async () => {
    findUnique.mockRejectedValue(new Error("db down"));
    expect(await getUpdateTrain()).toBe("nightly");
  });
});

describe("setUpdateTrain", () => {
  it("upserts the release value", async () => {
    upsert.mockResolvedValue({});
    await setUpdateTrain("release");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "update.train" },
        update: { value: "release" },
        create: { key: "update.train", value: "release" },
      }),
    );
  });

  it("normalizes an unknown train to nightly on write", async () => {
    upsert.mockResolvedValue({});
    // @ts-expect-error — exercising the runtime normalization guard
    await setUpdateTrain("bogus");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { value: "nightly" } }),
    );
  });
});
