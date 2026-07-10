/**
 * tests/unit/descriptionSyncDecide.test.ts
 *
 * Pure-function coverage for the three-way-merge (newest-wins) description-sync
 * decision: normalization (trim / empty → null), the 2-arg Polaris-primary
 * bootstrap matrix (no baseline), the 3-arg newest-wins matrix (push/adopt/
 * conflict against a baseline), the non-destructive guards (a device clear
 * never wipes a Polaris value; an empty Polaris side always adopts), and the
 * per-target device-side length caps.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn() }));
vi.mock("../../src/services/reservationPushService.js", () => ({
  buildTransportForIntegration: vi.fn(),
  callFortiOs: vi.fn(),
  classifyPushError: vi.fn(() => "transient"),
}));

import {
  normalizeDescription,
  decideDescriptionSync,
  capDescriptionForTarget,
  DESCRIPTION_CAPS,
  BASELINE_UNKNOWN,
} from "../../src/services/descriptionSyncService.js";

describe("normalizeDescription", () => {
  it("trims and passes through non-empty strings", () => {
    expect(normalizeDescription("  uplink to core  ")).toBe("uplink to core");
    expect(normalizeDescription("x")).toBe("x");
  });

  it("maps empty / whitespace-only / non-string to null", () => {
    expect(normalizeDescription("")).toBeNull();
    expect(normalizeDescription("   ")).toBeNull();
    expect(normalizeDescription(null)).toBeNull();
    expect(normalizeDescription(undefined)).toBeNull();
    expect(normalizeDescription(42)).toBeNull();
    expect(normalizeDescription({})).toBeNull();
  });
});

describe("decideDescriptionSync — bootstrap (no baseline / 2-arg)", () => {
  it("both empty → none", () => {
    expect(decideDescriptionSync(null, null)).toBe("none");
    expect(decideDescriptionSync("", "  ")).toBe("none");
    expect(decideDescriptionSync(undefined, "")).toBe("none");
  });

  it("Polaris empty + device value → adopt (seed from device)", () => {
    expect(decideDescriptionSync(null, "WAN uplink")).toBe("adopt");
    expect(decideDescriptionSync("  ", "WAN uplink")).toBe("adopt");
  });

  it("equal values → none (write nothing)", () => {
    expect(decideDescriptionSync("core switch", "core switch")).toBe("none");
    // Whitespace differences normalize away — still equal.
    expect(decideDescriptionSync(" core switch ", "core switch")).toBe("none");
  });

  it("Polaris value differs from device, no baseline → push (Polaris-primary)", () => {
    // This is exactly the "sync just enabled after manual Polaris edits" case:
    // Polaris wins and pushes to the device.
    expect(decideDescriptionSync("polaris says", "device says")).toBe("push");
    expect(decideDescriptionSync("polaris says", "device says", BASELINE_UNKNOWN)).toBe("push");
  });

  it("Polaris value + empty device → push (device clear never loses Polaris)", () => {
    expect(decideDescriptionSync("polaris says", null)).toBe("push");
    expect(decideDescriptionSync("polaris says", "  ")).toBe("push");
    // …even with a baseline (device-side clear is treated as drift, not a win).
    expect(decideDescriptionSync("polaris says", null, "polaris says")).toBe("push");
  });
});

describe("decideDescriptionSync — newest-wins (three-way, with baseline)", () => {
  it("only Polaris changed since baseline → push", () => {
    // baseline "A", Polaris edited to "A2", device still "A".
    expect(decideDescriptionSync("A2", "A", "A")).toBe("push");
  });

  it("only device changed since baseline → adopt (device edit is newer)", () => {
    // baseline "A", Polaris still "A", device edited to "B".
    expect(decideDescriptionSync("A", "B", "A")).toBe("adopt");
  });

  it("both changed since baseline → conflict", () => {
    // baseline "A", Polaris → "P", device → "D".
    expect(decideDescriptionSync("P", "D", "A")).toBe("conflict");
  });

  it("both changed to the SAME value → none (converged, not a conflict)", () => {
    expect(decideDescriptionSync("same", "same", "A")).toBe("none");
  });

  it("empty Polaris still adopts a device value regardless of baseline", () => {
    expect(decideDescriptionSync(null, "device value", "old baseline")).toBe("adopt");
  });

  it("a baseline recorded as empty behaves like bootstrap for a fresh push", () => {
    // baseline null (last agreed empty), Polaris set, device still empty → push.
    expect(decideDescriptionSync("new polaris", null, null)).toBe("push");
    // baseline null, device gained a value, Polaris empty → adopt.
    expect(decideDescriptionSync(null, "new device", null)).toBe("adopt");
    // baseline null, both gained a (different) value → conflict.
    expect(decideDescriptionSync("P", "D", null)).toBe("conflict");
  });
});

describe("capDescriptionForTarget", () => {
  it("leaves values at or under the cap untouched", () => {
    expect(capDescriptionForTarget("short", "fortigate-interface")).toBe("short");
    const exact = "x".repeat(DESCRIPTION_CAPS["fortigate-global"]);
    expect(capDescriptionForTarget(exact, "fortigate-global")).toBe(exact);
  });

  it("truncates to the per-target cap", () => {
    const long = "y".repeat(300);
    expect(capDescriptionForTarget(long, "fortigate-interface")).toHaveLength(255);
    expect(capDescriptionForTarget(long, "fortigate-global")).toHaveLength(35);
    expect(capDescriptionForTarget(long, "managed-switch")).toHaveLength(63);
    expect(capDescriptionForTarget(long, "switch-port")).toHaveLength(63);
    expect(capDescriptionForTarget(long, "wtp")).toHaveLength(35); // wtp `location`
  });
});
