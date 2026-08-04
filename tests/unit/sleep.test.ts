/**
 * tests/unit/sleep.test.ts
 */

import { describe, it, expect } from "vitest";
import { sleep } from "../../src/utils/sleep.js";

describe("sleep", () => {
  it("resolves after roughly the requested delay", async () => {
    const start = Date.now();
    await sleep(25);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });

  it("resolves immediately for 0", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});
