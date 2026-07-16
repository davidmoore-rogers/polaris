/**
 * tests/unit/queueDiscovery.test.ts — discovery-queue publish helper.
 *
 * Verifies the producer no-ops (returns false → caller uses the in-process
 * cursor-mode fallback) when pg-boss isn't running, which is the state in a
 * unit test with no boss started.
 */
import { describe, it, expect } from "vitest";
import { publishDiscoveryJob, isPgbossRunning, DISCOVERY_QUEUE_NAME } from "../../src/services/queueService.js";

describe("queueService — discovery queue", () => {
  it("exposes the discovery queue name", () => {
    expect(DISCOVERY_QUEUE_NAME).toBe("polaris-discovery-run");
  });

  it("pg-boss is not running in a bare unit test", () => {
    expect(isPgbossRunning()).toBe(false);
  });

  it("publishDiscoveryJob returns false when pg-boss is off (caller falls back to in-process)", async () => {
    await expect(publishDiscoveryJob("itg-1", "tester")).resolves.toBe(false);
  });

  it("accepts the scoped-device param (single-FortiGate re-discovery payload)", async () => {
    await expect(publishDiscoveryJob("itg-1", "tester", "FGT-X")).resolves.toBe(false);
  });
});
