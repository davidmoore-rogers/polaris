/**
 * tests/unit/agentAutoDeployService.test.ts
 *
 * Pure-function coverage for the agent auto-deploy platform/transport
 * inference. The DB-bound eligibility + kickoff path (runAutoDeployForClass)
 * is exercised by the integration suite.
 */

import { describe, it, expect } from "vitest";
import {
  inferAgentPlatform,
  pickTransportAndCredential,
  type AgentDeployClassConfig,
} from "../../src/services/agentAutoDeployService.js";

describe("inferAgentPlatform", () => {
  it("maps Windows OS strings to windows", () => {
    expect(inferAgentPlatform("Windows Server 2022")).toBe("windows");
    expect(inferAgentPlatform("Windows 10 Enterprise")).toBe("windows");
    expect(inferAgentPlatform("Microsoft Windows 11")).toBe("windows");
  });

  it("maps macOS strings to darwin", () => {
    expect(inferAgentPlatform("macOS 14.2")).toBe("darwin");
    expect(inferAgentPlatform("Mac OS X")).toBe("darwin");
    expect(inferAgentPlatform("Darwin")).toBe("darwin");
  });

  it("defaults everything else (incl. blank/unknown) to linux", () => {
    expect(inferAgentPlatform("Ubuntu 22.04")).toBe("linux");
    expect(inferAgentPlatform("Red Hat Enterprise Linux 9")).toBe("linux");
    expect(inferAgentPlatform("")).toBe("linux");
    expect(inferAgentPlatform(null)).toBe("linux");
    expect(inferAgentPlatform(undefined)).toBe("linux");
  });
});

describe("pickTransportAndCredential", () => {
  const ssh: AgentDeployClassConfig = { enabled: true, sshCredentialId: "ssh-1" };
  const winrm: AgentDeployClassConfig = { enabled: true, winrmCredentialId: "winrm-1" };
  const both: AgentDeployClassConfig = { enabled: true, sshCredentialId: "ssh-1", winrmCredentialId: "winrm-1" };
  const none: AgentDeployClassConfig = { enabled: true };

  it("windows prefers WinRM when available", () => {
    expect(pickTransportAndCredential("windows", both)).toEqual({ osPlatform: "windows", transport: "winrm", credentialId: "winrm-1" });
  });

  it("windows falls back to SSH (OpenSSH) when no WinRM credential", () => {
    expect(pickTransportAndCredential("windows", ssh)).toEqual({ osPlatform: "windows", transport: "ssh", credentialId: "ssh-1" });
  });

  it("windows skips when neither credential is set", () => {
    const r = pickTransportAndCredential("windows", none);
    expect("skip" in r).toBe(true);
  });

  it("linux/darwin use SSH", () => {
    expect(pickTransportAndCredential("linux", ssh)).toEqual({ osPlatform: "linux", transport: "ssh", credentialId: "ssh-1" });
    expect(pickTransportAndCredential("darwin", ssh)).toEqual({ osPlatform: "darwin", transport: "ssh", credentialId: "ssh-1" });
  });

  it("linux/darwin skip when no SSH credential (even if WinRM is set)", () => {
    expect("skip" in pickTransportAndCredential("linux", winrm)).toBe(true);
    expect("skip" in pickTransportAndCredential("darwin", none)).toBe(true);
  });
});
