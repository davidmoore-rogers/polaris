/**
 * tests/unit/agentSigningService.test.ts
 *
 * Pure + Setting-backed pieces of the Azure Trusted Signing service:
 * mask/merge secret discipline, token-request shaping, jsign argv building
 * (env: storepass indirection — token never on argv), jar resolution order,
 * secret scrubbing, failure-stamp persistence, and config-driven availability
 * gating.
 *
 * NOT testable here (needs Azure / a host toolchain — covered by the manual
 * verification steps instead): live Entra ID token fetch, an actual jsign
 * signing run, signature/timestamp validity, and the `java -version` probe.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  },
}));

import {
  MASK,
  SIGNING_TOKEN_ENV,
  SIGNING_TOKEN_SCOPE,
  AGENT_SIGNING_SETTING_KEY,
  SIGNING_FAILURE_SETTING_KEY,
  JSIGN_JAR_CANDIDATES,
  DEFAULT_SIGNING_CONFIG,
  maskSigningConfig,
  mergeSigningConfig,
  isSigningConfigured,
  buildTokenRequest,
  buildJsignArgs,
  scrubSecrets,
  resolveJsignJar,
  getSigningConfigRaw,
  updateSigningConfig,
  recordSigningFailure,
  clearSigningFailure,
  getSigningAlert,
  type AgentSigningConfig,
} from "../../src/services/agentSigningService.js";
import { prisma } from "../../src/db.js";

type Mock = ReturnType<typeof vi.fn>;
const findUnique = prisma.setting.findUnique as unknown as Mock;
const upsert = prisma.setting.upsert as unknown as Mock;
const del = prisma.setting.delete as unknown as Mock;

const FULL_CONFIG: AgentSigningConfig = {
  enabled: true,
  endpoint: "https://eus.codesigning.azure.net",
  accountName: "acme-signing",
  profileName: "polaris-agent",
  tenantId: "11111111-2222-3333-4444-555555555555",
  clientId: "66666666-7777-8888-9999-000000000000",
  clientSecret: "super-secret-value",
  jsignJarPath: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  del.mockResolvedValue({});
  upsert.mockResolvedValue({});
});

describe("maskSigningConfig", () => {
  it("masks a stored secret and flags it set", () => {
    const m = maskSigningConfig(FULL_CONFIG);
    expect(m.clientSecret).toBe(MASK);
    expect(m.clientSecretSet).toBe(true);
    expect(m.endpoint).toBe(FULL_CONFIG.endpoint); // non-secret fields pass through
  });

  it("reports empty secret as unset", () => {
    const m = maskSigningConfig({ ...FULL_CONFIG, clientSecret: "" });
    expect(m.clientSecret).toBe("");
    expect(m.clientSecretSet).toBe(false);
  });
});

describe("mergeSigningConfig", () => {
  it("keeps the stored secret when incoming echoes the mask", () => {
    const next = mergeSigningConfig({ clientSecret: MASK }, FULL_CONFIG);
    expect(next.clientSecret).toBe("super-secret-value");
  });

  it("keeps the stored secret when incoming is blank", () => {
    const next = mergeSigningConfig({ clientSecret: "  " }, FULL_CONFIG);
    expect(next.clientSecret).toBe("super-secret-value");
  });

  it("replaces the secret when a new one is typed", () => {
    const next = mergeSigningConfig({ clientSecret: "new-secret" }, FULL_CONFIG);
    expect(next.clientSecret).toBe("new-secret");
  });

  it("never persists the clientSecretSet UI marker", () => {
    const next = mergeSigningConfig({ clientSecretSet: true }, FULL_CONFIG);
    expect((next as Record<string, unknown>).clientSecretSet).toBeUndefined();
  });

  it("trims strings and strips the endpoint's trailing slash", () => {
    const next = mergeSigningConfig(
      { endpoint: " https://eus.codesigning.azure.net/ ", accountName: " acme " },
      DEFAULT_SIGNING_CONFIG,
    );
    expect(next.endpoint).toBe("https://eus.codesigning.azure.net");
    expect(next.accountName).toBe("acme");
  });

  it("leaves omitted fields at their current values", () => {
    const next = mergeSigningConfig({ profileName: "other" }, FULL_CONFIG);
    expect(next.profileName).toBe("other");
    expect(next.tenantId).toBe(FULL_CONFIG.tenantId);
    expect(next.enabled).toBe(true);
  });

  it("tolerates garbage input", () => {
    expect(mergeSigningConfig(null as unknown as Record<string, unknown>, DEFAULT_SIGNING_CONFIG)).toEqual(
      DEFAULT_SIGNING_CONFIG,
    );
  });
});

describe("isSigningConfigured", () => {
  it("true only when every credential field is present", () => {
    expect(isSigningConfigured(FULL_CONFIG)).toBe(true);
    for (const key of ["endpoint", "accountName", "profileName", "tenantId", "clientId", "clientSecret"] as const) {
      expect(isSigningConfigured({ ...FULL_CONFIG, [key]: "" })).toBe(false);
    }
  });
});

describe("buildTokenRequest", () => {
  it("targets the tenant's v2 token endpoint with the Trusted Signing scope", () => {
    const { url, body } = buildTokenRequest(FULL_CONFIG);
    expect(url).toBe(`https://login.microsoftonline.com/${FULL_CONFIG.tenantId}/oauth2/v2.0/token`);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe(FULL_CONFIG.clientId);
    expect(body.get("client_secret")).toBe(FULL_CONFIG.clientSecret);
    expect(body.get("scope")).toBe(SIGNING_TOKEN_SCOPE);
  });
});

describe("buildJsignArgs", () => {
  const args = buildJsignArgs({
    jarPath: "/opt/polaris/tools/jsign.jar",
    endpoint: "https://eus.codesigning.azure.net",
    accountName: "acme-signing",
    profileName: "polaris-agent",
    filePath: "/data/agents/0.12.0/polaris-agent-windows-amd64.exe",
  });

  it("builds the TRUSTEDSIGNING argv with the file last", () => {
    expect(args[0]).toBe("-jar");
    expect(args[1]).toBe("/opt/polaris/tools/jsign.jar");
    expect(args).toContain("--storetype");
    expect(args[args.indexOf("--storetype") + 1]).toBe("TRUSTEDSIGNING");
    expect(args[args.indexOf("--keystore") + 1]).toBe("https://eus.codesigning.azure.net");
    expect(args[args.indexOf("--alias") + 1]).toBe("acme-signing/polaris-agent");
    expect(args[args.length - 1]).toBe("/data/agents/0.12.0/polaris-agent-windows-amd64.exe");
  });

  it("passes the token via env: indirection — never a literal token on argv", () => {
    expect(args[args.indexOf("--storepass") + 1]).toBe(`env:${SIGNING_TOKEN_ENV}`);
  });
});

describe("scrubSecrets", () => {
  it("redacts every occurrence of each secret", () => {
    const out = scrubSecrets("failed: token abc123token in header abc123token", ["abc123token"]);
    expect(out).not.toContain("abc123token");
    expect(out).toContain("[redacted]");
  });

  it("ignores undefined and too-short values (avoids redacting common substrings)", () => {
    expect(scrubSecrets("error code 5", [undefined, "5"])).toBe("error code 5");
  });
});

describe("resolveJsignJar", () => {
  it("honors an explicit path without probing the candidates", async () => {
    // A path that certainly doesn't exist → null, and candidates are NOT consulted.
    const p = await resolveJsignJar({ jsignJarPath: "Z:/definitely/not/here/jsign.jar" });
    expect(p).toBeNull();
  });

  it("exports a non-empty default candidate list ending with the /opt/polaris location", () => {
    expect(JSIGN_JAR_CANDIDATES.length).toBeGreaterThanOrEqual(2);
    expect(JSIGN_JAR_CANDIDATES[JSIGN_JAR_CANDIDATES.length - 1]).toBe("/opt/polaris/tools/jsign.jar");
  });
});

describe("Setting persistence", () => {
  it("returns defaults when no row exists", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getSigningConfigRaw()).toEqual(DEFAULT_SIGNING_CONFIG);
  });

  it("tolerates a garbage row", async () => {
    findUnique.mockResolvedValue({ key: AGENT_SIGNING_SETTING_KEY, value: "oops" });
    expect(await getSigningConfigRaw()).toEqual(DEFAULT_SIGNING_CONFIG);
  });

  it("updateSigningConfig merges + upserts and clears the failure stamp on disable", async () => {
    findUnique.mockResolvedValue({ key: AGENT_SIGNING_SETTING_KEY, value: FULL_CONFIG });
    const masked = await updateSigningConfig({ enabled: false });
    expect(masked.enabled).toBe(false);
    expect(masked.clientSecret).toBe(MASK); // secret preserved through the merge
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].where).toEqual({ key: AGENT_SIGNING_SETTING_KEY });
    // enabled true → false must clear the alert stamp
    expect(del).toHaveBeenCalledWith({ where: { key: SIGNING_FAILURE_SETTING_KEY } });
  });

  it("updateSigningConfig does NOT clear the stamp when staying enabled", async () => {
    findUnique.mockResolvedValue({ key: AGENT_SIGNING_SETTING_KEY, value: FULL_CONFIG });
    await updateSigningConfig({ profileName: "renamed" });
    expect(del).not.toHaveBeenCalled();
  });
});

describe("failure stamp", () => {
  const FAILURE = {
    at: "2026-07-09T12:00:00.000Z",
    buildId: "b-1",
    version: "0.12.0",
    files: ["polaris-agent-windows-amd64.exe"],
    error: "token expired",
  };

  it("recordSigningFailure upserts the stamp row", async () => {
    await recordSigningFailure(FAILURE);
    expect(upsert.mock.calls[0][0].where).toEqual({ key: SIGNING_FAILURE_SETTING_KEY });
    expect(upsert.mock.calls[0][0].create.value).toEqual(FAILURE);
  });

  it("clearSigningFailure deletes and swallows a missing row", async () => {
    del.mockRejectedValue(new Error("not found"));
    await expect(clearSigningFailure()).resolves.toBeUndefined();
  });

  it("getSigningAlert round-trips a stamp and nulls on absence/garbage", async () => {
    findUnique.mockResolvedValue({ key: SIGNING_FAILURE_SETTING_KEY, value: FAILURE });
    expect((await getSigningAlert()).failure).toEqual(FAILURE);

    findUnique.mockResolvedValue(null);
    expect((await getSigningAlert()).failure).toBeNull();

    findUnique.mockResolvedValue({ key: SIGNING_FAILURE_SETTING_KEY, value: { nonsense: true } });
    expect((await getSigningAlert()).failure).toBeNull();
  });
});
