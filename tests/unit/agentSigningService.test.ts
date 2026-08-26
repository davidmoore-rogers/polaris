/**
 * tests/unit/agentSigningService.test.ts
 *
 * Pure + Setting-backed pieces of the internal-CA code-signing service:
 * mask/merge secret discipline, jsign argv building (env: storepass
 * indirection — the keystore password never on argv; explicit RFC3161
 * timestamping), keytool output parsing, the alias advisory, jar resolution
 * order, secret scrubbing, failure-stamp persistence, and config-driven
 * availability gating.
 *
 * NOT testable here (needs a real keystore / host toolchain — covered by the
 * manual verification steps instead): an actual jsign signing run, signature
 * and timestamp validity, the `java -version` probe, and a live keytool open.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  },
}));

import {
  MASK,
  SIGNING_PASSWORD_ENV,
  DEFAULT_TSA_URL,
  AGENT_SIGNING_SETTING_KEY,
  SIGNING_FAILURE_SETTING_KEY,
  JSIGN_JAR_CANDIDATES,
  DEFAULT_SIGNING_CONFIG,
  maskSigningConfig,
  mergeSigningConfig,
  isSigningConfigured,
  buildJsignArgs,
  parseKeytoolAliases,
  parseJavaHome,
  aliasAdvisory,
  isKeytoolMissing,
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
  keystorePath: "/opt/polaris/tools/codesign.pfx",
  keystorePassword: "super-secret-value",
  alias: "",
  tsaUrl: "http://timestamp.digicert.com",
  jsignJarPath: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  del.mockResolvedValue({});
  upsert.mockResolvedValue({});
});

describe("maskSigningConfig", () => {
  it("masks a stored password and flags it set", () => {
    const m = maskSigningConfig(FULL_CONFIG);
    expect(m.keystorePassword).toBe(MASK);
    expect(m.keystorePasswordSet).toBe(true);
    expect(m.keystorePath).toBe(FULL_CONFIG.keystorePath); // non-secret fields pass through
  });

  it("reports empty password as unset", () => {
    const m = maskSigningConfig({ ...FULL_CONFIG, keystorePassword: "" });
    expect(m.keystorePassword).toBe("");
    expect(m.keystorePasswordSet).toBe(false);
  });
});

describe("mergeSigningConfig", () => {
  it("keeps the stored password when incoming echoes the mask", () => {
    expect(mergeSigningConfig({ keystorePassword: MASK }, FULL_CONFIG).keystorePassword).toBe("super-secret-value");
  });

  it("keeps the stored password when incoming is blank", () => {
    expect(mergeSigningConfig({ keystorePassword: "  " }, FULL_CONFIG).keystorePassword).toBe("super-secret-value");
  });

  it("replaces the password when a new one is typed", () => {
    expect(mergeSigningConfig({ keystorePassword: "new-pw" }, FULL_CONFIG).keystorePassword).toBe("new-pw");
  });

  it("never persists the keystorePasswordSet UI marker", () => {
    const next = mergeSigningConfig({ keystorePasswordSet: true }, FULL_CONFIG);
    expect((next as Record<string, unknown>).keystorePasswordSet).toBeUndefined();
  });

  it("trims strings and strips the TSA's trailing slash", () => {
    const next = mergeSigningConfig(
      { keystorePath: " /srv/cs.pfx ", tsaUrl: " http://tsa.example.com/ " },
      DEFAULT_SIGNING_CONFIG,
    );
    expect(next.keystorePath).toBe("/srv/cs.pfx");
    expect(next.tsaUrl).toBe("http://tsa.example.com");
  });

  // Clearing the TSA field must not silently disable signing (it's part of
  // isSigningConfigured) — it falls back to the documented default instead.
  it("falls back to the default TSA when the field is cleared", () => {
    expect(mergeSigningConfig({ tsaUrl: "" }, FULL_CONFIG).tsaUrl).toBe(DEFAULT_TSA_URL);
    expect(mergeSigningConfig({ tsaUrl: "   " }, FULL_CONFIG).tsaUrl).toBe(DEFAULT_TSA_URL);
  });

  it("leaves omitted fields at their current values", () => {
    const next = mergeSigningConfig({ alias: "codesign" }, FULL_CONFIG);
    expect(next.alias).toBe("codesign");
    expect(next.keystorePath).toBe(FULL_CONFIG.keystorePath);
    expect(next.enabled).toBe(true);
  });

  it("tolerates garbage input", () => {
    expect(mergeSigningConfig(null as unknown as Record<string, unknown>, DEFAULT_SIGNING_CONFIG)).toEqual(
      DEFAULT_SIGNING_CONFIG,
    );
  });
});

describe("isSigningConfigured", () => {
  it("requires keystore path, password and TSA", () => {
    expect(isSigningConfigured(FULL_CONFIG)).toBe(true);
    for (const key of ["keystorePath", "keystorePassword", "tsaUrl"] as const) {
      expect(isSigningConfigured({ ...FULL_CONFIG, [key]: "" })).toBe(false);
    }
  });

  it("does NOT require alias or an explicit jar path", () => {
    expect(isSigningConfigured({ ...FULL_CONFIG, alias: "", jsignJarPath: "" })).toBe(true);
  });
});

describe("buildJsignArgs", () => {
  const base = {
    jarPath: "/opt/polaris/tools/jsign.jar",
    keystorePath: "/opt/polaris/tools/codesign.pfx",
    tsaUrl: "http://timestamp.digicert.com",
    filePath: "/data/agents/0.17.1/polaris-agent-windows-amd64.exe",
  };

  it("builds the PKCS12 argv with the file last", () => {
    const args = buildJsignArgs(base);
    expect(args[0]).toBe("-jar");
    expect(args[1]).toBe("/opt/polaris/tools/jsign.jar");
    expect(args[args.indexOf("--storetype") + 1]).toBe("PKCS12");
    expect(args[args.indexOf("--keystore") + 1]).toBe("/opt/polaris/tools/codesign.pfx");
    expect(args[args.length - 1]).toBe(base.filePath);
  });

  it("passes the password via env: indirection — never a literal password on argv", () => {
    const args = buildJsignArgs({ ...base, keystorePath: "/x.pfx" });
    expect(args[args.indexOf("--storepass") + 1]).toBe(`env:${SIGNING_PASSWORD_ENV}`);
    expect(args).not.toContain("super-secret-value");
  });

  // PKCS12 gets no automatic timestamping (unlike a hosted store type), so an
  // explicit tsaurl + RFC3161 mode is what keeps signatures valid past cert
  // expiry. Regressing this silently invalidates the whole fleet at once.
  it("always sets an explicit RFC3161 timestamp authority", () => {
    const args = buildJsignArgs(base);
    expect(args[args.indexOf("--tsaurl") + 1]).toBe("http://timestamp.digicert.com");
    expect(args[args.indexOf("--tsmode") + 1]).toBe("RFC3161");
  });

  it("omits --alias entirely when unset, and includes it when set", () => {
    expect(buildJsignArgs(base)).not.toContain("--alias");
    const withAlias = buildJsignArgs({ ...base, alias: "codesign" });
    expect(withAlias[withAlias.indexOf("--alias") + 1]).toBe("codesign");
  });
});

describe("parseKeytoolAliases", () => {
  it("extracts private-key and trusted-cert alias names", () => {
    const out = parseKeytoolAliases(
      [
        "Keystore type: PKCS12",
        "Keystore provider: SUN",
        "",
        "Your keystore contains 2 entries",
        "",
        "codesign, Jan 1, 2026, PrivateKeyEntry, ",
        "Certificate fingerprint (SHA-256): AB:CD",
        "oldsign, Feb 2, 2025, trustedCertEntry, ",
      ].join("\n"),
    );
    expect(out).toEqual(["codesign", "oldsign"]);
  });

  it("returns an empty list for output with no entries", () => {
    expect(parseKeytoolAliases("Your keystore contains 0 entries")).toEqual([]);
    expect(parseKeytoolAliases("")).toEqual([]);
  });
});

describe("parseJavaHome", () => {
  // The fallback this feeds exists because java-17-openjdk-headless ships
  // keytool NEXT TO THE JVM rather than necessarily on PATH — so a PATH miss
  // must not be read as "keytool is absent".
  it("extracts java.home from -XshowSettings output", () => {
    const out = [
      "Property settings:",
      "    file.encoding = UTF-8",
      "    java.home = /usr/lib/jvm/java-17-openjdk-17.0.12.0.7-2.el9.x86_64",
      "    java.io.tmpdir = /tmp",
      "",
      'openjdk version "17.0.12" 2026-07-16',
    ].join("\n");
    expect(parseJavaHome(out)).toBe("/usr/lib/jvm/java-17-openjdk-17.0.12.0.7-2.el9.x86_64");
  });

  it("handles a Windows path with spaces", () => {
    expect(parseJavaHome("    java.home = C:\\Program Files\\Microsoft\\jdk-17.0.12\\")).toBe(
      "C:\\Program Files\\Microsoft\\jdk-17.0.12\\",
    );
  });

  it("returns null when the property is absent or the output is empty", () => {
    expect(parseJavaHome("openjdk version \"17.0.12\"")).toBeNull();
    expect(parseJavaHome("")).toBeNull();
  });
});

describe("aliasAdvisory", () => {
  // The failure this exists to surface: an alias that isn't in the keystore
  // otherwise only shows up as a jsign error mid-build.
  it("warns loudly when the configured alias is absent", () => {
    const msg = aliasAdvisory("typo", ["codesign"]);
    expect(msg).toContain("WARNING");
    expect(msg).toContain("typo");
    expect(msg).toContain("codesign");
  });

  it("confirms a configured alias that is present", () => {
    expect(aliasAdvisory("codesign", ["codesign"])).toContain('Alias "codesign" found');
  });

  it("nudges toward setting an alias only for a multi-entry keystore", () => {
    expect(aliasAdvisory("", ["a", "b"])).toContain("set an alias");
    expect(aliasAdvisory("", ["only"])).toBe("");
    expect(aliasAdvisory("", [])).toBe("");
  });
});

describe("isKeytoolMissing", () => {
  it("distinguishes the degraded no-keytool case from a real open failure", () => {
    expect(isKeytoolMissing("keytool not available — password not verified")).toBe(true);
    expect(isKeytoolMissing("keystore password was incorrect")).toBe(false);
    expect(isKeytoolMissing(undefined)).toBe(false);
  });
});

describe("scrubSecrets", () => {
  it("redacts every occurrence of each secret", () => {
    const out = scrubSecrets("failed: pw abc123pass in header abc123pass", ["abc123pass"]);
    expect(out).not.toContain("abc123pass");
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

  it("defaults ship signing disabled but with a usable TSA", () => {
    expect(DEFAULT_SIGNING_CONFIG.enabled).toBe(false);
    expect(DEFAULT_SIGNING_CONFIG.tsaUrl).toBe(DEFAULT_TSA_URL);
  });

  it("tolerates a garbage row", async () => {
    findUnique.mockResolvedValue({ key: AGENT_SIGNING_SETTING_KEY, value: "oops" });
    expect(await getSigningConfigRaw()).toEqual(DEFAULT_SIGNING_CONFIG);
  });

  it("updateSigningConfig merges + upserts and clears the failure stamp on disable", async () => {
    findUnique.mockResolvedValue({ key: AGENT_SIGNING_SETTING_KEY, value: FULL_CONFIG });
    const masked = await updateSigningConfig({ enabled: false });
    expect(masked.enabled).toBe(false);
    expect(masked.keystorePassword).toBe(MASK); // password preserved through the merge
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].where).toEqual({ key: AGENT_SIGNING_SETTING_KEY });
    // enabled true → false must clear the alert stamp
    expect(del).toHaveBeenCalledWith({ where: { key: SIGNING_FAILURE_SETTING_KEY } });
  });

  it("updateSigningConfig does NOT clear the stamp when staying enabled", async () => {
    findUnique.mockResolvedValue({ key: AGENT_SIGNING_SETTING_KEY, value: FULL_CONFIG });
    await updateSigningConfig({ alias: "renamed" });
    expect(del).not.toHaveBeenCalled();
  });

  it("persists the plaintext password (sealing is the db.ts extension's job)", async () => {
    findUnique.mockResolvedValue({ key: AGENT_SIGNING_SETTING_KEY, value: FULL_CONFIG });
    await updateSigningConfig({ keystorePassword: "typed-pw" });
    const written = upsert.mock.calls[0][0].update.value as AgentSigningConfig;
    expect(written.keystorePassword).toBe("typed-pw");
  });
});

describe("failure stamp", () => {
  const FAILURE = {
    at: "2026-08-25T12:00:00.000Z",
    buildId: "b-1",
    version: "0.17.1",
    files: ["polaris-agent-windows-amd64.exe"],
    error: "keystore password was incorrect",
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
