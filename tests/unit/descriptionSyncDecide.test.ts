/**
 * tests/unit/descriptionSyncDecide.test.ts
 *
 * Pure-function coverage for the Polaris-primary description-sync decision:
 * normalization (trim / empty → null), the decide matrix (empty Polaris
 * adopts a device value; a non-empty Polaris value always wins), and the
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

describe("decideDescriptionSync (Polaris-primary matrix)", () => {
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

  it("Polaris value differs from device → push (Polaris wins)", () => {
    expect(decideDescriptionSync("polaris says", "device says")).toBe("push");
  });

  it("Polaris value + empty device → push (device never had one)", () => {
    expect(decideDescriptionSync("polaris says", null)).toBe("push");
    expect(decideDescriptionSync("polaris says", "  ")).toBe("push");
  });

  it("device edits never win once Polaris holds a value", () => {
    // Polaris previously pushed "A"; someone edited the device to "B".
    // Polaris-primary means the decision is push (revert), never adopt.
    expect(decideDescriptionSync("A", "B")).toBe("push");
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
    expect(capDescriptionForTarget(long, "wtp")).toHaveLength(255);
  });
});
