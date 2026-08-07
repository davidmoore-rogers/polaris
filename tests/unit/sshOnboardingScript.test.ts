/**
 * Unit tests for the Windows SSH onboarding script generator.
 *
 * The emitted PowerShell runs FLEET-WIDE as SYSTEM, so these tests weight two
 * things heavily: that operator-supplied values can never inject code, and
 * that the script is genuinely idempotent (both in what it emits and in the
 * detection predicate that decides whether to run it again).
 */

import { describe, it, expect } from "vitest";
import ssh2 from "ssh2";
const sshUtils = ssh2.utils;

import {
  buildWindowsOnboardingScript,
  buildWindowsOnboardingDetectionScript,
  assertValidPublicKey,
  assertValidUsername,
  assertValidServerIp,
} from "../../src/services/sshOnboardingScript.js";

/** A real generated key, so the tests exercise the actual shape we emit. */
const KEYPAIR = sshUtils.generateKeyPairSync("ed25519", { comment: "polaris-agent-deploy" });
const PUBLIC_KEY = String(KEYPAIR.public).trim();

const BASE = {
  publicKey: PUBLIC_KEY,
  username: "polaris-agent",
  accountMode: "existing" as const,
};

describe("assertValidPublicKey", () => {
  it("accepts a real generated ed25519 public key", () => {
    expect(assertValidPublicKey(PUBLIC_KEY)).toBe(PUBLIC_KEY);
  });

  it("accepts rsa and ecdsa key types", () => {
    expect(() => assertValidPublicKey("ssh-rsa AAAAB3NzaC1yc2E= host")).not.toThrow();
    expect(() => assertValidPublicKey("ecdsa-sha2-nistp256 AAAAE2VjZHNh= host")).not.toThrow();
  });

  it("rejects an empty key with an actionable message", () => {
    expect(() => assertValidPublicKey("")).toThrow(/generated yet/i);
  });

  it("rejects an unknown algorithm", () => {
    expect(() => assertValidPublicKey("ssh-dss AAAAB3NzaC1kc3M= host")).toThrow(/well-formed/i);
  });

  it("rejects a key whose comment carries a quote or newline", () => {
    expect(() => assertValidPublicKey(PUBLIC_KEY + "'; Invoke-Bad; #")).toThrow(/well-formed/i);
    expect(() => assertValidPublicKey(PUBLIC_KEY + "\nssh-ed25519 AAAA= attacker")).toThrow(/well-formed/i);
  });
});

describe("assertValidUsername", () => {
  it("accepts a plain local name", () => {
    expect(assertValidUsername("polaris-agent", "create")).toBe("polaris-agent");
  });

  it("accepts DOMAIN\\user for an existing account", () => {
    expect(assertValidUsername("CORP\\svc-polaris", "existing")).toBe("CORP\\svc-polaris");
  });

  it("refuses to emit a script that would create a domain account locally", () => {
    // New-LocalUser cannot do this, so failing at authoring time beats failing
    // on every endpoint in the fleet.
    expect(() => assertValidUsername("CORP\\svc-polaris", "create")).toThrow(/cannot be created locally/i);
  });

  it("rejects an empty username", () => {
    expect(() => assertValidUsername("   ", "existing")).toThrow(/required/i);
  });

  it.each([
    ["quote break-out", "user'; Invoke-WebRequest evil.example; #"],
    ["subexpression",   "user$(whoami)"],
    ["newline",         "user\nInvoke-Bad"],
    ["semicolon",       "user;calc"],
    ["backtick",        "user`n"],
    ["space",           "user name"],
  ])("rejects an injection attempt via %s", (_label, value) => {
    expect(() => assertValidUsername(value, "existing")).toThrow();
  });

  it("rejects a username longer than 64 characters", () => {
    expect(() => assertValidUsername("a".repeat(65), "existing")).toThrow();
  });
});

describe("assertValidServerIp", () => {
  it("treats blank as 'not configured' rather than an error", () => {
    expect(assertValidServerIp("")).toBe("");
    expect(assertValidServerIp(undefined)).toBe("");
    expect(assertValidServerIp(null)).toBe("");
  });

  it("accepts an address and a CIDR", () => {
    expect(assertValidServerIp("10.0.0.42")).toBe("10.0.0.42");
    expect(assertValidServerIp("10.0.0.0/24")).toBe("10.0.0.0/24");
  });

  it("rejects a non-address, including injection attempts", () => {
    expect(() => assertValidServerIp("10.0.0.42'; calc; #")).toThrow();
    expect(() => assertValidServerIp("not-an-ip")).toThrow();
  });
});

describe("buildWindowsOnboardingScript", () => {
  it("embeds the public key and targets the administrators_authorized_keys file", () => {
    const script = buildWindowsOnboardingScript(BASE);
    expect(script).toContain(PUBLIC_KEY);
    // The whole point of the feature: NOT %USERPROFILE%\.ssh\authorized_keys,
    // which Windows OpenSSH ignores for administrators.
    expect(script).toContain("administrators_authorized_keys");
    expect(script).not.toContain(".ssh\\authorized_keys'");
  });

  it("appends rather than overwrites, so other keys in the file survive", () => {
    const script = buildWindowsOnboardingScript(BASE);
    expect(script).toContain("Add-Content");
    expect(script).not.toContain("Set-Content -LiteralPath $authKeys");
  });

  it("guards the key write behind the presence check so re-runs don't duplicate", () => {
    const script = buildWindowsOnboardingScript(BASE);
    expect(script).toContain("if (Test-PolarisKeyPresent");
    expect(script).toContain("function Test-PolarisKeyPresent");
  });

  it("locks the ACL down by well-known SID, not localized group name", () => {
    const script = buildWindowsOnboardingScript(BASE);
    expect(script).toContain("S-1-5-32-544");
    expect(script).toContain("S-1-5-18");
    expect(script).toContain("SetAccessRuleProtection($true, $false)");
  });

  it("exits 0 with a clear marker on a build that has no OpenSSH capability", () => {
    // Returning non-zero would loop a detection/remediation pair forever
    // against a machine that can never be fixed.
    const script = buildWindowsOnboardingScript(BASE);
    expect(script).toMatch(/unsupported:/);
  });

  describe("account mode", () => {
    it("emits account creation only for mode=create", () => {
      const created = buildWindowsOnboardingScript({ ...BASE, accountMode: "create" });
      expect(created).toContain("New-LocalUser");
      expect(created).toContain("Add-LocalGroupMember");
      // Resolve the group by SID — "Administrators" is localized.
      expect(created).toContain("Get-LocalGroup -SID");
    });

    it("emits no account mutation for mode=existing", () => {
      const existing = buildWindowsOnboardingScript({ ...BASE, accountMode: "existing" });
      expect(existing).not.toContain("New-LocalUser");
      expect(existing).not.toContain("Add-LocalGroupMember");
      expect(existing).toContain("not created by this script");
    });

    it("never emits a literal password value", () => {
      const created = buildWindowsOnboardingScript({ ...BASE, accountMode: "create" });
      // The password is generated on the endpoint from a CSPRNG and discarded.
      expect(created).toContain("RandomNumberGenerator");
      expect(created).toContain("Remove-Variable pwPlain");
    });

    it("rejects an unknown account mode", () => {
      expect(() =>
        buildWindowsOnboardingScript({ ...BASE, accountMode: "wibble" as never }),
      ).toThrow();
    });
  });

  describe("firewall block", () => {
    it("scopes TCP/22 to the configured address", () => {
      const script = buildWindowsOnboardingScript({ ...BASE, polarisServerIp: "10.0.0.42" });
      expect(script).toContain("New-NetFirewallRule");
      expect(script).toContain("'10.0.0.42'");
      expect(script).toContain("-LocalPort 22");
    });

    it("replaces an existing rule of the same name so re-runs stay idempotent", () => {
      const script = buildWindowsOnboardingScript({ ...BASE, polarisServerIp: "10.0.0.42" });
      expect(script).toContain("Remove-NetFirewallRule");
    });

    it("touches nothing and says so when no address is configured", () => {
      const script = buildWindowsOnboardingScript(BASE);
      expect(script).not.toContain("New-NetFirewallRule");
      expect(script).toContain("not modified");
    });
  });

  it("summarizes the chosen options in the header", () => {
    const script = buildWindowsOnboardingScript({
      ...BASE,
      accountMode: "create",
      username: "svc-polaris",
      polarisServerIp: "192.168.1.5",
    });
    expect(script).toContain("creates the local administrator account 'svc-polaris'");
    expect(script).toContain("scopes inbound TCP/22 to 192.168.1.5");
    // No placeholder may survive into the emitted script.
    expect(script).not.toMatch(/__[A-Z_]+__/);
  });

  it("propagates validation failures instead of emitting a script", () => {
    expect(() => buildWindowsOnboardingScript({ ...BASE, username: "bad;name" })).toThrow();
    expect(() => buildWindowsOnboardingScript({ ...BASE, publicKey: "garbage" })).toThrow();
  });
});

describe("buildWindowsOnboardingDetectionScript", () => {
  it("shares the key-presence predicate with the remediation script", () => {
    // Same function text in both — detection cannot drift from what
    // remediation writes.
    const detect = buildWindowsOnboardingDetectionScript({ publicKey: PUBLIC_KEY });
    const remediate = buildWindowsOnboardingScript(BASE);
    const fn = "function Test-PolarisKeyPresent";
    expect(detect).toContain(fn);
    expect(remediate).toContain(fn);

    const extract = (s: string) => s.slice(s.indexOf(fn), s.indexOf("function Get-PolarisAuthorizedKeysPath"));
    expect(extract(detect)).toBe(extract(remediate));
  });

  it("exits 1 for each remediable condition and 0 when satisfied", () => {
    const script = buildWindowsOnboardingDetectionScript({ publicKey: PUBLIC_KEY });
    expect(script).toContain("remediate: OpenSSH Server not installed");
    expect(script).toContain("remediate: sshd not running");
    expect(script).toContain("remediate: Polaris key not authorized");
    expect(script).toContain("ok: Polaris SSH onboarding present");
  });

  it("does not check the account or firewall", () => {
    // Neither is reliably observable as 'wrong', and a false positive would
    // re-run the full remediation on every cycle forever.
    const script = buildWindowsOnboardingDetectionScript({ publicKey: PUBLIC_KEY });
    expect(script).not.toContain("Get-LocalUser");
    expect(script).not.toContain("Get-NetFirewallRule");
  });

  it("treats an unsupported build as exit 0 so the pair doesn't loop", () => {
    const script = buildWindowsOnboardingDetectionScript({ publicKey: PUBLIC_KEY });
    const idx = script.indexOf("unsupported: no OpenSSH Server capability");
    expect(idx).toBeGreaterThan(-1);
    expect(script.slice(idx, idx + 200)).toContain("exit 0");
  });

  it("fails closed on an unexpected error rather than reporting compliant", () => {
    const script = buildWindowsOnboardingDetectionScript({ publicKey: PUBLIC_KEY });
    expect(script).toContain("remediate: detection error");
  });

  it("rejects an invalid public key", () => {
    expect(() => buildWindowsOnboardingDetectionScript({ publicKey: "nope" })).toThrow();
  });
});
