/**
 * tests/unit/agentInstallService.test.ts
 *
 * Which installStatus values an agent upgrade may be kicked off from.
 *
 * The set is load-bearing in TWO places that must agree — `startUpgrade`'s
 * synchronous guard and `upgradeAllOutdated`'s Prisma filter — which is why
 * it's one exported constant with one predicate over it. When they disagreed,
 * "upgrade_failed" was excluded from both: a host asleep during one auto-
 * upgrade fan-out was dropped from every later one AND its panel's "Retry
 * Upgrade" button 409'd, so uninstall/reinstall was the only way back onto a
 * current agent.
 *
 * `upgrade_failed` is upgradeable because it means the OLD binary is still
 * running: every failure path leaves agent.conf untouched and never completed
 * a binary swap. The in-flight states are not, because an upgrade would race
 * work already running on the host; `failed` never completed an install; and
 * `revoked` has no working bearer for a new binary to come back on.
 */

import { describe, it, expect } from "vitest";
import {
  UPGRADEABLE_INSTALL_STATUSES,
  canUpgradeFromStatus,
} from "../../src/services/agentInstallService.js";

describe("UPGRADEABLE_INSTALL_STATUSES", () => {
  it("is exactly active + upgrade_failed", () => {
    expect([...UPGRADEABLE_INSTALL_STATUSES]).toEqual(["active", "upgrade_failed"]);
  });
});

describe("canUpgradeFromStatus", () => {
  it("accepts a healthy agent", () => {
    expect(canUpgradeFromStatus("active")).toBe(true);
  });

  it("accepts a previously failed upgrade — the old binary is still running", () => {
    expect(canUpgradeFromStatus("upgrade_failed")).toBe(true);
  });

  it.each(["pending", "uploading", "enrolling", "upgrading", "uninstalling"])(
    "refuses the in-flight state %s so it cannot race host-side work",
    (status) => {
      expect(canUpgradeFromStatus(status)).toBe(false);
    },
  );

  it("refuses failed — no install ever completed to upgrade", () => {
    expect(canUpgradeFromStatus("failed")).toBe(false);
  });

  it("refuses uninstall_failed and revoked", () => {
    expect(canUpgradeFromStatus("uninstall_failed")).toBe(false);
    expect(canUpgradeFromStatus("revoked")).toBe(false);
  });

  it("refuses null / undefined / unknown rather than defaulting open", () => {
    expect(canUpgradeFromStatus(null)).toBe(false);
    expect(canUpgradeFromStatus(undefined)).toBe(false);
    expect(canUpgradeFromStatus("")).toBe(false);
    expect(canUpgradeFromStatus("Active")).toBe(false);
  });
});
