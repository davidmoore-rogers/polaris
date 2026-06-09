/**
 * tests/unit/addMacAddresses.test.ts — additive AssetMacAddress upsert helper.
 *
 * Verifies the system-info "fold monitored-interface MACs into Associated
 * MACs" path: normalization, dedupe, invalid-skip, no-op on empty, and the
 * additive ON CONFLICT shape (bumps lastSeen only, never deletes).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  executeRawUnsafe: vi.fn(async () => 1),
}));

vi.mock("../../src/db.js", () => ({
  prisma: { $executeRawUnsafe: mocks.executeRawUnsafe },
}));

// retryOnDeadlock just invokes the thunk; run the real (trivial) helper.
import { addMacAddresses } from "../../src/utils/macAddresses.js";

const now = new Date("2026-06-09T12:00:00.000Z");

beforeEach(() => {
  mocks.executeRawUnsafe.mockClear();
});

/** Pull the (sql, ...params) of the single executeRawUnsafe call. */
function lastCall() {
  expect(mocks.executeRawUnsafe).toHaveBeenCalledTimes(1);
  const [sql, ...params] = mocks.executeRawUnsafe.mock.calls[0] as [string, ...unknown[]];
  return { sql, params };
}

describe("addMacAddresses", () => {
  it("is a no-op (no DB round-trip) on an empty list", async () => {
    await addMacAddresses("a1", [], now);
    expect(mocks.executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("is a no-op when every MAC is invalid/empty", async () => {
    await addMacAddresses(
      "a1",
      [{ mac: null }, { mac: "" }, { mac: "not-a-mac" }, { mac: "00:11:22" }],
      now,
    );
    expect(mocks.executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("normalizes lowercase / dash / dot forms to upper-colon", async () => {
    await addMacAddresses(
      "a1",
      [
        { mac: "aa:bb:cc:dd:ee:ff", source: "monitor-interface" },
        { mac: "00-11-22-33-44-55", source: "monitor-interface" },
        { mac: "1234.5678.9abc", source: "monitor-interface" },
      ],
      now,
    );
    const { params } = lastCall();
    // params are flat tuples of (assetId, mac, source, lastSeen, firstSeen)
    expect(params).toContain("AA:BB:CC:DD:EE:FF");
    expect(params).toContain("00:11:22:33:44:55");
    expect(params).toContain("12:34:56:78:9A:BC");
  });

  it("dedupes the same MAC across different text formats", async () => {
    await addMacAddresses(
      "a1",
      [
        { mac: "aa:bb:cc:dd:ee:ff" },
        { mac: "AABBCCDDEEFF" },
        { mac: "aa-bb-cc-dd-ee-ff" },
      ],
      now,
    );
    const { params } = lastCall();
    const macs = params.filter((p) => p === "AA:BB:CC:DD:EE:FF");
    expect(macs).toHaveLength(1);
  });

  it("carries the provided source and defaults to 'unknown'", async () => {
    await addMacAddresses(
      "a1",
      [
        { mac: "aa:bb:cc:dd:ee:01", source: "monitor-interface" },
        { mac: "aa:bb:cc:dd:ee:02" },
      ],
      now,
    );
    const { params } = lastCall();
    expect(params).toContain("monitor-interface");
    expect(params).toContain("unknown");
  });

  it("emits an additive ON CONFLICT that bumps only lastSeen (never deletes)", async () => {
    await addMacAddresses("a1", [{ mac: "aa:bb:cc:dd:ee:ff" }], now);
    const { sql } = lastCall();
    expect(sql).toContain('INSERT INTO "asset_mac_addresses"');
    expect(sql).toContain('ON CONFLICT ("assetId", "mac") DO UPDATE SET "lastSeen" = EXCLUDED."lastSeen"');
    // It must NOT touch source/device on conflict, and must not delete.
    expect(sql).not.toMatch(/DELETE/i);
    expect(sql).not.toContain('"source" = EXCLUDED');
  });

  it("stamps lastSeen and firstSeen from the supplied clock", async () => {
    await addMacAddresses("a1", [{ mac: "aa:bb:cc:dd:ee:ff" }], now);
    const { params } = lastCall();
    const iso = now.toISOString();
    // Both timestamp slots use the same supplied `now`.
    expect(params.filter((p) => p === iso)).toHaveLength(2);
  });
});
