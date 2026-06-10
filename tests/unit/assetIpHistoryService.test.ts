/**
 * tests/unit/assetIpHistoryService.test.ts
 *
 * Covers the pure batch-prep logic. The DB-touching writer
 * (recordIpHistoryEntries) is best-effort raw SQL exercised via integration.
 */

import { describe, it, expect } from "vitest";
import { prepareIpHistoryEntries } from "../../src/services/assetIpHistoryService.js";

describe("prepareIpHistoryEntries", () => {
  it("returns an empty array for no entries", () => {
    expect(prepareIpHistoryEntries([], null)).toEqual([]);
  });

  it("drops blank / whitespace-only IPs and trims", () => {
    const out = prepareIpHistoryEntries(
      [
        { ip: "", source: "x" },
        { ip: "   ", source: "x" },
        { ip: null, source: "x" },
        { ip: undefined, source: "x" },
        { ip: " 203.0.113.5 ", source: "monitor-system-info" },
      ],
      null,
    );
    expect(out).toEqual([{ ip: "203.0.113.5", source: "monitor-system-info" }]);
  });

  it("skips the asset's primary IP (owned by the db.ts extension)", () => {
    const out = prepareIpHistoryEntries(
      [
        { ip: "10.0.0.1", source: "monitor-system-info" },
        { ip: "203.0.113.5", source: "monitor-system-info" },
      ],
      "10.0.0.1",
    );
    expect(out).toEqual([{ ip: "203.0.113.5", source: "monitor-system-info" }]);
  });

  it("keeps public IPs that are not the primary", () => {
    const out = prepareIpHistoryEntries(
      [{ ip: "8.8.8.8", source: "monitor-system-info" }],
      "192.168.1.1",
    );
    expect(out).toEqual([{ ip: "8.8.8.8", source: "monitor-system-info" }]);
  });

  it("dedupes within a batch, last source wins", () => {
    const out = prepareIpHistoryEntries(
      [
        { ip: "203.0.113.5", source: "first" },
        { ip: "203.0.113.5", source: "second" },
      ],
      null,
    );
    expect(out).toEqual([{ ip: "203.0.113.5", source: "second" }]);
  });

  it("defaults a blank source to monitor-system-info", () => {
    const out = prepareIpHistoryEntries(
      [
        { ip: "203.0.113.5", source: "" },
        { ip: "203.0.113.6", source: null },
        { ip: "203.0.113.7", source: undefined },
      ],
      null,
    );
    expect(out).toEqual([
      { ip: "203.0.113.5", source: "monitor-system-info" },
      { ip: "203.0.113.6", source: "monitor-system-info" },
      { ip: "203.0.113.7", source: "monitor-system-info" },
    ]);
  });
});
