import { describe, it, expect } from "vitest";
import { clampAcquiredToLastSeen, bumpLastSeen } from "../../src/utils/assetInvariants.js";

const T0 = new Date("2026-01-01T00:00:00Z");
const T1 = new Date("2026-02-01T00:00:00Z");
const T2 = new Date("2026-03-01T00:00:00Z");

describe("clampAcquiredToLastSeen", () => {
  it("clamps acquiredAt down to lastSeen when later", () => {
    const data: Record<string, unknown> = { acquiredAt: T2, lastSeen: T1 };
    clampAcquiredToLastSeen(data);
    expect(data.acquiredAt).toEqual(T1);
  });

  it("leaves acquiredAt alone when already ≤ lastSeen", () => {
    const data: Record<string, unknown> = { acquiredAt: T0, lastSeen: T1 };
    clampAcquiredToLastSeen(data);
    expect(data.acquiredAt).toEqual(T0);
  });

  it("pulls missing side from existing", () => {
    const data: Record<string, unknown> = { lastSeen: T0 };
    clampAcquiredToLastSeen(data, { acquiredAt: T1 });
    expect(data.acquiredAt).toEqual(T0);
  });
});

describe("bumpLastSeen", () => {
  it("advances lastSeen and stamps the source", () => {
    const data: Record<string, unknown> = {};
    const applied = bumpLastSeen(data, { lastSeen: T0 }, T1, "dhcp-lease");
    expect(applied).toBe(true);
    expect(data.lastSeen).toEqual(T1);
    expect(data.lastSeenSource).toBe("dhcp-lease");
  });

  it("sets lastSeen when the row has none", () => {
    const data: Record<string, unknown> = {};
    expect(bumpLastSeen(data, { lastSeen: null }, T1, "ping")).toBe(true);
    expect(data.lastSeen).toEqual(T1);
    expect(bumpLastSeen({}, null, T1, "ping")).toBe(true);
  });

  it("never regresses: older evidence is a no-op", () => {
    const data: Record<string, unknown> = {};
    const applied = bumpLastSeen(data, { lastSeen: T2 }, T1, "device-inventory");
    expect(applied).toBe(false);
    expect("lastSeen" in data).toBe(false);
    expect("lastSeenSource" in data).toBe(false);
  });

  it("equal evidence is a no-op (no source churn)", () => {
    const data: Record<string, unknown> = {};
    expect(bumpLastSeen(data, { lastSeen: T1 }, new Date(T1), "agent")).toBe(false);
    expect("lastSeenSource" in data).toBe(false);
  });

  it("compares against a value already staged on the payload", () => {
    const data: Record<string, unknown> = { lastSeen: T2, lastSeenSource: "agent" };
    const applied = bumpLastSeen(data, { lastSeen: T0 }, T1, "ping");
    expect(applied).toBe(false);
    expect(data.lastSeen).toEqual(T2);
    expect(data.lastSeenSource).toBe("agent");
  });

  it("accepts ISO-string evidence and string row values", () => {
    const data: Record<string, unknown> = {};
    expect(bumpLastSeen(data, { lastSeen: T0.toISOString() }, T1.toISOString(), "probe")).toBe(true);
    expect(data.lastSeen).toEqual(T1);
  });

  it("rejects invalid evidence dates", () => {
    const data: Record<string, unknown> = {};
    expect(bumpLastSeen(data, { lastSeen: T0 }, "not-a-date", "ping")).toBe(false);
    expect("lastSeen" in data).toBe(false);
  });
});
