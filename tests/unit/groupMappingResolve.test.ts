/**
 * tests/unit/groupMappingResolve.test.ts — resolveGroupsToAccess + normalizeGroupKey
 *
 * Covers the security/correctness-sensitive bits: highest-privilege-wins,
 * tag union, provider isolation, LDAP DN case-insensitivity, OIDC exact-case,
 * disabled rows excluded, tags-only (null-role) mappings.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/api/routes/events.js", () => ({ logEvent: vi.fn() }));

// Fixed dataset shared across the file so the 30s enabled-mappings cache stays
// coherent (same provider → same rows on every call).
const NETADMIN_DN = "cn=netadmins,ou=g,dc=corp,dc=local";
const ADMIN_DN = "cn=admins,ou=g,dc=corp,dc=local";
const TAGSONLY_DN = "cn=tagsonly,ou=g,dc=corp,dc=local";

const MAPPINGS = [
  { provider: "ldap", enabled: true, groupKey: NETADMIN_DN, roleId: "role-net", regionTags: ["east"], otherTags: ["vlan10"] },
  { provider: "ldap", enabled: true, groupKey: ADMIN_DN, roleId: "role-admin", regionTags: ["west"], otherTags: [] },
  { provider: "ldap", enabled: true, groupKey: TAGSONLY_DN, roleId: null, regionTags: ["south"], otherTags: ["t1"] },
  { provider: "ldap", enabled: false, groupKey: "cn=disabled,ou=g,dc=corp,dc=local", roleId: "role-admin", regionTags: ["nope"], otherTags: [] },
  { provider: "oidc", enabled: true, groupKey: "Engineering", roleId: "role-net", regionTags: ["eu"], otherTags: [] },
  // entra-proxy keys are stored pre-normalized (lowercased GUID), as
  // createGroupMapping's normalizeGroupKey would persist them.
  { provider: "entra-proxy", enabled: true, groupKey: "5f2cded1-40d9-43a4-a091-b92a80a3c7bb", roleId: "role-net", regionTags: ["hq"], otherTags: [] },
];

const ROLES = [
  { id: "role-admin", permissions: { users: "fullwrite", roles: "fullwrite" } },
  { id: "role-net", permissions: { subnets: "write", reservations: "write" } },
];

vi.mock("../../src/db.js", () => ({
  prisma: {
    groupMapping: {
      findMany: vi.fn(async (args: any) => {
        const where = args?.where ?? {};
        return MAPPINGS.filter((m) => m.provider === where.provider && m.enabled === where.enabled).map((m) => ({
          groupKey: m.groupKey,
          roleId: m.roleId,
          regionTags: m.regionTags,
          otherTags: m.otherTags,
        }));
      }),
    },
    role: {
      findMany: vi.fn(async (args: any) => {
        const ids: string[] = args?.where?.id?.in ?? [];
        return ROLES.filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id, permissions: r.permissions }));
      }),
    },
  },
}));

import { resolveGroupsToAccess, normalizeGroupKey } from "../../src/services/groupMappingService.js";

describe("normalizeGroupKey", () => {
  it("lowercases + trims LDAP DNs", () => {
    expect(normalizeGroupKey("ldap", "  CN=NetAdmins,OU=G,DC=corp,DC=local ")).toBe(NETADMIN_DN);
  });
  it("trims but preserves case for OIDC/SAML", () => {
    expect(normalizeGroupKey("oidc", "  Engineering ")).toBe("Engineering");
    expect(normalizeGroupKey("saml", "Engineering")).toBe("Engineering");
  });
  it("lowercases + trims entra-proxy group GUIDs", () => {
    expect(normalizeGroupKey("entra-proxy", " 5F2CDED1-40D9-43A4-A091-B92A80A3C7BB ")).toBe("5f2cded1-40d9-43a4-a091-b92a80a3c7bb");
  });
  it("returns empty for blanks / non-strings", () => {
    expect(normalizeGroupKey("ldap", "   ")).toBe("");
    expect(normalizeGroupKey("oidc", 5 as unknown)).toBe("");
  });
});

describe("resolveGroupsToAccess", () => {
  it("returns empty for an unknown provider, no groups, or no match", async () => {
    expect(await resolveGroupsToAccess("bogus", ["x"])).toEqual({ roleId: null, regionTags: [], otherTags: [], matchedGroups: [] });
    expect(await resolveGroupsToAccess("ldap", [])).toEqual({ roleId: null, regionTags: [], otherTags: [], matchedGroups: [] });
    expect(await resolveGroupsToAccess("ldap", ["cn=nope,dc=x"])).toEqual({ roleId: null, regionTags: [], otherTags: [], matchedGroups: [] });
  });

  it("matches a single LDAP group (case-insensitive DN)", async () => {
    const r = await resolveGroupsToAccess("ldap", ["CN=NetAdmins,OU=G,DC=corp,DC=local"]);
    expect(r.roleId).toBe("role-net");
    expect(r.regionTags).toEqual(["east"]);
    expect(r.otherTags).toEqual(["vlan10"]);
    expect(r.matchedGroups).toEqual([NETADMIN_DN]);
  });

  it("highest-privilege role wins; tags from all matched groups union", async () => {
    const r = await resolveGroupsToAccess("ldap", [NETADMIN_DN, ADMIN_DN]);
    expect(r.roleId).toBe("role-admin"); // admin-equivalent outranks the writer
    expect(r.regionTags).toEqual(["east", "west"]);
    expect(r.otherTags).toEqual(["vlan10"]);
  });

  it("a null-role (tags-only) mapping contributes tags but no role", async () => {
    const r = await resolveGroupsToAccess("ldap", [TAGSONLY_DN]);
    expect(r.roleId).toBeNull();
    expect(r.regionTags).toEqual(["south"]);
    expect(r.otherTags).toEqual(["t1"]);
  });

  it("excludes disabled mappings", async () => {
    const r = await resolveGroupsToAccess("ldap", ["cn=disabled,ou=g,dc=corp,dc=local"]);
    expect(r.matchedGroups).toEqual([]);
    expect(r.roleId).toBeNull();
  });

  it("isolates providers — an LDAP DN never matches under OIDC", async () => {
    const r = await resolveGroupsToAccess("oidc", [NETADMIN_DN]);
    expect(r.matchedGroups).toEqual([]);
  });

  it("OIDC matching is exact-case", async () => {
    expect((await resolveGroupsToAccess("oidc", ["Engineering"])).roleId).toBe("role-net");
    expect((await resolveGroupsToAccess("oidc", ["engineering"])).matchedGroups).toEqual([]);
  });

  it("entra-proxy matches group GUIDs case-insensitively", async () => {
    const r = await resolveGroupsToAccess("entra-proxy", ["5F2CDED1-40D9-43A4-A091-B92A80A3C7BB"]);
    expect(r.roleId).toBe("role-net");
    expect(r.regionTags).toEqual(["hq"]);
    expect(r.matchedGroups).toEqual(["5f2cded1-40d9-43a4-a091-b92a80a3c7bb"]);
  });
});
