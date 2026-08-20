/**
 * tests/unit/entraProxyAuthService.test.ts — settings validation + identity
 * extraction + trust gate for the Entra App Proxy header-SSO provider.
 *
 * Everything here is security-sensitive: the headers are unsigned, so the
 * settings normalization (header-name denylist, allowlist validation) and the
 * fail-closed defaults ARE the security model.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/api/routes/events.js", () => ({ logEvent: vi.fn() }));

// In-memory Setting row store.
let settingRow: { value: Record<string, unknown> } | null = null;

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: {
      findUnique: vi.fn(async () => settingRow),
      upsert: vi.fn(async (args: any) => {
        settingRow = { value: args.update.value };
        return settingRow;
      }),
    },
  },
}));

import {
  getEntraProxySettings,
  updateEntraProxySettings,
  isEntraProxyEnabled,
  isTrustedEntraProxySource,
  extractEntraProxyIdentity,
  identityHeaderNames,
  defaultIdentityHeaderNames,
  testEntraProxyRequest,
  clearEntraProxySettingsCache,
} from "../../src/services/entraProxyAuthService.js";

const GUID = "7c9e6b10-4a3d-4f21-9c0e-1b2d3e4f5a60";

function seed(value: Record<string, unknown>): void {
  settingRow = { value };
  clearEntraProxySettingsCache();
}

beforeEach(() => {
  settingRow = null;
  clearEntraProxySettingsCache();
});

describe("getEntraProxySettings", () => {
  it("returns fail-closed defaults when no row exists", async () => {
    const s = await getEntraProxySettings();
    expect(s.enabled).toBe(false);
    expect(s.trustedSourceIps).toEqual([]);
    expect(s.objectIdHeader).toBe("x-entra-object-id");
    expect(s.usernameHeader).toBe("x-entra-upn");
  });

  it("merges a stored row over the defaults", async () => {
    seed({ enabled: true, trustedSourceIps: ["10.0.0.5"] });
    const s = await getEntraProxySettings();
    expect(s.enabled).toBe(true);
    expect(s.trustedSourceIps).toEqual(["10.0.0.5"]);
    expect(s.groupsHeader).toBe("x-entra-groups"); // default preserved
  });
});

describe("updateEntraProxySettings", () => {
  it("lowercases header names and persists", async () => {
    const s = await updateEntraProxySettings({
      enabled: false,
      trustedSourceIps: [],
      objectIdHeader: "X-Entra-OBJECT-ID",
    });
    expect(s.objectIdHeader).toBe("x-entra-object-id");
  });

  it("rejects header names outside [a-z0-9-]", async () => {
    await expect(updateEntraProxySettings({ objectIdHeader: "x entra id" })).rejects.toThrow(/header name/i);
    await expect(updateEntraProxySettings({ usernameHeader: "x_entra_upn" })).rejects.toThrow(/header name/i);
  });

  it("rejects reserved infrastructure header names", async () => {
    for (const name of ["authorization", "cookie", "x-forwarded-for", "host"]) {
      await expect(updateEntraProxySettings({ groupsHeader: name })).rejects.toThrow(/reserved/i);
    }
  });

  it("requires the object-id and username headers", async () => {
    await expect(updateEntraProxySettings({ objectIdHeader: "" })).rejects.toThrow(/required/i);
    await expect(updateEntraProxySettings({ usernameHeader: "  " })).rejects.toThrow(/required/i);
  });

  it("allows clearing the optional headers", async () => {
    const s = await updateEntraProxySettings({ emailHeader: "", displayNameHeader: "", groupsHeader: "" });
    expect(s.emailHeader).toBe("");
    expect(identityHeaderNames(s)).toEqual(["x-entra-object-id", "x-entra-upn"]);
  });

  it("validates trusted source entries and dedupes", async () => {
    const s = await updateEntraProxySettings({ trustedSourceIps: ["10.0.0.5", " 10.0.0.5 ", "10.1.0.0/16"] });
    expect(s.trustedSourceIps).toEqual(["10.0.0.5", "10.1.0.0/16"]);
    await expect(updateEntraProxySettings({ trustedSourceIps: ["connector-host"] })).rejects.toThrow(/Invalid trusted source/i);
  });

  it("refuses enabling with an empty allowlist", async () => {
    await expect(updateEntraProxySettings({ enabled: true, trustedSourceIps: [] })).rejects.toThrow(/trusted source/i);
  });
});

describe("isEntraProxyEnabled / isTrustedEntraProxySource", () => {
  it("is disabled by default and with an empty allowlist", async () => {
    expect(await isEntraProxyEnabled()).toBe(false);
    seed({ enabled: true, trustedSourceIps: [] });
    expect(await isEntraProxyEnabled()).toBe(false);
  });

  it("is enabled with config + allowlist", async () => {
    seed({ enabled: true, trustedSourceIps: ["10.0.0.5"] });
    expect(await isEntraProxyEnabled()).toBe(true);
  });

  it("trusts only allowlisted sources, and only while enabled", async () => {
    seed({ enabled: true, trustedSourceIps: ["10.0.0.5", "192.168.0.0/24"] });
    expect(await isTrustedEntraProxySource("10.0.0.5")).toBe(true);
    expect(await isTrustedEntraProxySource("192.168.0.77")).toBe(true);
    expect(await isTrustedEntraProxySource("10.0.0.6")).toBe(false);
    expect(await isTrustedEntraProxySource(undefined)).toBe(false);
    seed({ enabled: false, trustedSourceIps: ["10.0.0.5"] });
    expect(await isTrustedEntraProxySource("10.0.0.5")).toBe(false);
  });
});

describe("extractEntraProxyIdentity", () => {
  beforeEach(() => {
    seed({ enabled: true, trustedSourceIps: ["10.0.0.5"] });
  });

  it("returns null when no identity headers are present", async () => {
    expect(await extractEntraProxyIdentity({ headers: {} })).toBeNull();
  });

  it("extracts and lowercases the GUID; splits groups on comma/semicolon", async () => {
    const id = await extractEntraProxyIdentity({
      headers: {
        "x-entra-object-id": GUID.toUpperCase(),
        "x-entra-upn": "jsmith@example.com",
        "x-entra-email": "jsmith@example.com",
        "x-entra-display-name": "Jordan Smith",
        "x-entra-groups": `AAAAAAAA-0000-0000-0000-000000000001, ${GUID};  `,
      },
    });
    expect(id).not.toBeNull();
    expect(id!.objectId).toBe(GUID);
    expect(id!.upn).toBe("jsmith@example.com");
    expect(id!.displayName).toBe("Jordan Smith");
    expect(id!.groups).toEqual(["AAAAAAAA-0000-0000-0000-000000000001", GUID]);
  });

  it("rejects a malformed object ID", async () => {
    await expect(
      extractEntraProxyIdentity({ headers: { "x-entra-object-id": "not-a-guid", "x-entra-upn": "u@x" } }),
    ).rejects.toThrow(/object ID/i);
  });

  it("rejects a missing username when the object ID is present", async () => {
    await expect(
      extractEntraProxyIdentity({ headers: { "x-entra-object-id": GUID } }),
    ).rejects.toThrow(/missing/i);
  });

  it("rejects array-valued (duplicated) identity headers", async () => {
    await expect(
      extractEntraProxyIdentity({
        headers: { "x-entra-object-id": [GUID, GUID] as any, "x-entra-upn": "u@x" },
      }),
    ).rejects.toThrow(/Duplicate/i);
  });
});

describe("testEntraProxyRequest", () => {
  it("reports an empty allowlist as not-ok", async () => {
    const r = await testEntraProxyRequest({ headers: {}, ip: "10.0.0.9" });
    expect(r.ok).toBe(false);
    expect(r.details.allowlistEmpty).toBe(true);
  });

  it("reports trust + present header NAMES only (never values)", async () => {
    seed({ enabled: true, trustedSourceIps: ["10.0.0.5"] });
    const r = await testEntraProxyRequest({
      headers: { "x-entra-object-id": GUID, "x-entra-upn": "u@x" },
      ip: "10.0.0.5",
    });
    expect(r.ok).toBe(true);
    expect(r.details.trusted).toBe(true);
    expect(r.details.headersPresent).toEqual(["x-entra-object-id", "x-entra-upn"]);
    expect(JSON.stringify(r)).not.toContain(GUID);
  });

  it("explains an untrusted internal-network test", async () => {
    seed({ enabled: true, trustedSourceIps: ["10.0.0.5"] });
    const r = await testEntraProxyRequest({ headers: {}, ip: "172.16.1.20" });
    expect(r.details.trusted).toBe(false);
    expect(r.message).toMatch(/EXPECTED/);
    expect(r.details.requestIp).toBe("172.16.1.20");
  });
});

describe("defaultIdentityHeaderNames", () => {
  it("covers all five default headers (the fail-closed strip set)", () => {
    expect(defaultIdentityHeaderNames()).toEqual([
      "x-entra-object-id",
      "x-entra-upn",
      "x-entra-email",
      "x-entra-display-name",
      "x-entra-groups",
    ]);
  });
});
