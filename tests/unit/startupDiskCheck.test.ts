/**
 * tests/unit/startupDiskCheck.test.ts — probeDiskFree (the shared statfs math).
 */

import { describe, it, expect } from "vitest";
import { probeDiskFree } from "../../src/utils/startupDiskCheck.js";

describe("probeDiskFree", () => {
  it("probes a real path and returns coherent numbers", async () => {
    const p = await probeDiskFree(process.cwd());
    expect(p).not.toBeNull();
    expect(p!.totalBytes).toBeGreaterThan(0);
    expect(p!.freeBytes).toBeGreaterThanOrEqual(0);
    expect(p!.freeBytes).toBeLessThanOrEqual(p!.totalBytes);
    expect(p!.freePct).toBeGreaterThanOrEqual(0);
    expect(p!.freePct).toBeLessThanOrEqual(1);
  });

  it("returns null for a nonexistent path", async () => {
    expect(await probeDiskFree("/definitely/not/a/real/path/xyz")).toBeNull();
  });
});
