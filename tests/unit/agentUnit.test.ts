/**
 * tests/unit/agentUnit.test.ts
 *
 * The privilege-tier → systemd [Service]-block mapping for the Linux agent:
 *   - unprivileged (default) — hardened DynamicUser, NO capabilities
 *   - ptrace                 — same hardened base + AmbientCapabilities=
 *                              CAP_SYS_PTRACE CAP_DAC_READ_SEARCH. The PAIR is
 *                              load-bearing: /proc/<pid>/fd of a foreign process
 *                              is a 0500 dir whose open is a pure DAC check
 *                              (only DAC_READ_SEARCH passes), while readlinking
 *                              entries is the ptrace check. SYS_PTRACE alone
 *                              collected zero connection rows fleet-wide
 *                              (prod, 2026-07-29).
 *   - normalizePrivilegeTier — legacy "root" / unknown values collapse to unprivileged
 */

import { describe, it, expect } from "vitest";
import { linuxServiceBlock, normalizePrivilegeTier } from "../../src/utils/agentUnit.js";

describe("normalizePrivilegeTier", () => {
  it("keeps ptrace", () => {
    expect(normalizePrivilegeTier("ptrace")).toBe("ptrace");
  });
  it("collapses legacy root, unknown, and empty to unprivileged", () => {
    for (const v of ["root", "unprivileged", "", null, undefined, "nonsense", 123]) {
      expect(normalizePrivilegeTier(v)).toBe("unprivileged");
    }
  });
});

describe("linuxServiceBlock", () => {
  const unpriv = linuxServiceBlock("unprivileged");
  const ptrace = linuxServiceBlock("ptrace");

  it("both tiers share the hardened unprivileged base", () => {
    for (const block of [unpriv, ptrace]) {
      expect(block).toContain("User=polaris-agent");
      expect(block).toContain("DynamicUser=yes");
      expect(block).toContain("ProtectSystem=strict");
      expect(block).toContain("ProtectHome=true");
      expect(block).toContain("PrivateTmp=true");
      expect(block).toContain("NoNewPrivileges=true");
      // Never full root.
      expect(block).not.toContain("User=root");
    }
  });

  it("only the ptrace tier grants capabilities — and grants the full pair", () => {
    expect(unpriv).not.toContain("CAP_SYS_PTRACE");
    expect(unpriv).not.toContain("CAP_DAC_READ_SEARCH");
    expect(unpriv).not.toContain("AmbientCapabilities");
    // The PAIR, in both Ambient and BoundingSet. CAP_SYS_PTRACE alone cannot
    // open a foreign /proc/<pid>/fd (0500 dir, DAC check) — the regression
    // that shipped as zero Application Map rows fleet-wide.
    expect(ptrace).toContain("AmbientCapabilities=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH");
    expect(ptrace).toContain("CapabilityBoundingSet=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH");
  });

  it("both are valid [Service] blocks pointing at the agent binary", () => {
    for (const block of [unpriv, ptrace]) {
      expect(block.startsWith("[Service]")).toBe(true);
      expect(block).toContain("ExecStart=/usr/local/bin/polaris-agent -conf /var/lib/polaris-agent/agent.conf");
    }
  });
});
