/**
 * tests/unit/agentUnit.test.ts
 *
 * The privilege-tier → systemd [Service]-block mapping for the Linux agent:
 *   - unprivileged (default) — hardened DynamicUser, NO capabilities
 *   - ptrace                 — same hardened base + AmbientCapabilities=CAP_SYS_PTRACE
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

  it("only the ptrace tier grants CAP_SYS_PTRACE", () => {
    expect(unpriv).not.toContain("CAP_SYS_PTRACE");
    expect(unpriv).not.toContain("AmbientCapabilities");
    expect(ptrace).toContain("AmbientCapabilities=CAP_SYS_PTRACE");
    expect(ptrace).toContain("CapabilityBoundingSet=CAP_SYS_PTRACE");
  });

  it("both are valid [Service] blocks pointing at the agent binary", () => {
    for (const block of [unpriv, ptrace]) {
      expect(block.startsWith("[Service]")).toBe(true);
      expect(block).toContain("ExecStart=/usr/local/bin/polaris-agent -conf /var/lib/polaris-agent/agent.conf");
    }
  });
});
