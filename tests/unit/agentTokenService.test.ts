/**
 * tests/unit/agentTokenService.test.ts
 *
 * Pure-function coverage for the enroll-time monitoring auto-enable
 * decision. The DB-bound token mint/consume/verify path is exercised by
 * the integration suite (agent-cert-pins).
 */

import { describe, it, expect } from "vitest";
import { shouldEnableMonitoringOnEnroll } from "../../src/services/agentTokenService.js";

describe("shouldEnableMonitoringOnEnroll", () => {
  it("enables monitoring on an unmonitored active asset", () => {
    expect(shouldEnableMonitoringOnEnroll({ monitored: false, status: "active" })).toBe(true);
  });

  it("no-ops when the asset is already monitored (Reinstall path)", () => {
    expect(shouldEnableMonitoringOnEnroll({ monitored: true, status: "active" })).toBe(false);
  });

  it("never enables on decommissioned or disabled assets (business rule 10)", () => {
    expect(shouldEnableMonitoringOnEnroll({ monitored: false, status: "decommissioned" })).toBe(false);
    expect(shouldEnableMonitoringOnEnroll({ monitored: false, status: "disabled" })).toBe(false);
  });

  it("enables on the other statuses (maintenance polling is gated by status, not the flag)", () => {
    expect(shouldEnableMonitoringOnEnroll({ monitored: false, status: "maintenance" })).toBe(true);
    expect(shouldEnableMonitoringOnEnroll({ monitored: false, status: "storage" })).toBe(true);
    expect(shouldEnableMonitoringOnEnroll({ monitored: false, status: "quarantined" })).toBe(true);
  });
});
