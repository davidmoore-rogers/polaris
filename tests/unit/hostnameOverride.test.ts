/**
 * tests/unit/hostnameOverride.test.ts
 *
 * applyHostnameOverride — the pure re-assertion guard behind the operator
 * hostname pin (Asset.hostnameOverride). The db.ts Prisma extension calls it
 * on every asset update/upsert that stages `hostname`, passing the row's
 * current override; it must rewrite the staged hostname back to the override
 * in both Prisma data shapes, and must never touch the operator's own
 * set/clear write (which stages `hostnameOverride` itself).
 */

import { describe, it, expect } from "vitest";
import { applyHostnameOverride } from "../../src/utils/assetInvariants.js";

describe("applyHostnameOverride", () => {
  it("rewrites a plain staged hostname to the override", () => {
    const data: Record<string, unknown> = { hostname: "projected-name", os: "RHEL 9" };
    expect(applyHostnameOverride(data, "operator-name")).toBe(true);
    expect(data.hostname).toBe("operator-name");
    expect(data.os).toBe("RHEL 9"); // untouched
  });

  it("rewrites the nested { set } shape in place", () => {
    const data: Record<string, unknown> = { hostname: { set: "projected-name" } };
    expect(applyHostnameOverride(data, "operator-name")).toBe(true);
    expect(data.hostname).toEqual({ set: "operator-name" });
  });

  it("rewrites a staged null (discovery clearing the hostname)", () => {
    const data: Record<string, unknown> = { hostname: null };
    expect(applyHostnameOverride(data, "operator-name")).toBe(true);
    expect(data.hostname).toBe("operator-name");
  });

  it("is a no-op when the row has no override", () => {
    for (const override of [null, undefined, ""] as const) {
      const data: Record<string, unknown> = { hostname: "projected-name" };
      expect(applyHostnameOverride(data, override)).toBe(false);
      expect(data.hostname).toBe("projected-name");
    }
  });

  it("is a no-op when the write does not stage hostname", () => {
    const data: Record<string, unknown> = { lastSeen: new Date() };
    expect(applyHostnameOverride(data, "operator-name")).toBe(false);
    expect(data).not.toHaveProperty("hostname");
  });

  it("never rewrites the operator set/clear path (write stages hostnameOverride)", () => {
    // Set: PUT pins a new override alongside hostname.
    const setData: Record<string, unknown> = { hostname: "new-pin", hostnameOverride: "new-pin" };
    expect(applyHostnameOverride(setData, "old-pin")).toBe(false);
    expect(setData.hostname).toBe("new-pin");

    // Clear: PUT releases the pin and reverts hostname to the projection.
    const clearData: Record<string, unknown> = { hostname: "projected-name", hostnameOverride: null };
    expect(applyHostnameOverride(clearData, "old-pin")).toBe(false);
    expect(clearData.hostname).toBe("projected-name");
  });

  it("tolerates non-object data", () => {
    expect(applyHostnameOverride(null as unknown as Record<string, unknown>, "x")).toBe(false);
    expect(applyHostnameOverride(undefined as unknown as Record<string, unknown>, "x")).toBe(false);
  });
});
