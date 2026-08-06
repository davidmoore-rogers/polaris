/**
 * tests/integration/ssoProvisioning.test.ts — the shared SSO find-or-provision
 * path, written alongside the 2026-08 fold of findOrProvisionSamlUser onto
 * provisionExternalUser. Pins: username derivation + the provider collision
 * suffixes (the "azure" provider reproduces the historical SAML naming
 * byte-for-byte), the existing-user role-keep rule, group-mapped role
 * assignment, the SAML→"saml" mapping-provider translation (including the
 * groups-claim string-vs-array shapes), and resolveTagScopesForUser's
 * re-resolution of an azure user's stored groups under "saml" mappings.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { provisionExternalUser } from "../../src/services/ssoProvisioning.js";
import { findOrProvisionSamlUser } from "../../src/services/azureAuthService.js";
import { resolveTagScopesForUser } from "../../src/services/regionScopeService.js";
import { invalidateGroupMappingCacheForTests } from "../../src/services/groupMappingService.js";

const d = dbDescribe;
const PFX = "ssoprov";
const GROUP_GUID = "11111111-2222-3333-4444-555555555555";

async function wipe(): Promise<void> {
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: "azure-" } } });
  await prisma.groupMapping.deleteMany({ where: { groupKey: GROUP_GUID } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  try {
    await wipe();
    await prisma.$disconnect();
  } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
  await wipe();
  invalidateGroupMappingCacheForTests();
});

d("provisionExternalUser", () => {
  it("creates a new user with derived username, readonly default, and needsRoleReview", async () => {
    const u = await provisionExternalUser({
      provider: "oidc",
      externalIdField: "oidcSubject",
      externalId: `${PFX}-sub-1`,
      usernameHint: `${PFX}.alex@example.com`,
      displayName: "Alex Example",
      email: `${PFX}.alex@example.com`,
      groups: [],
    });
    expect(u.username).toBe(`${PFX}.alex`);
    expect(u.role.name).toBe("readonly");
    expect(u.needsRoleReview).toBe(true);
    expect(u.authProvider).toBe("oidc");
  });

  it("suffixes the provider on username collision", async () => {
    const readonly = await prisma.role.findUniqueOrThrow({ where: { name: "readonly" } });
    await prisma.user.create({
      data: { username: `${PFX}.taken`, passwordHash: "x", roleId: readonly.id },
    });
    const u = await provisionExternalUser({
      provider: "ldap",
      externalIdField: "ldapUid",
      externalId: `${PFX}-uid-1`,
      usernameHint: `${PFX}.taken@corp.local`,
      groups: [],
    });
    expect(u.username).toBe(`${PFX}.taken-ldap`);
  });

  it("keeps an existing user's admin-assigned role when no group resolves one", async () => {
    const admin = await prisma.role.findUniqueOrThrow({ where: { name: "admin" } });
    await prisma.user.create({
      data: {
        username: `${PFX}.promoted`, passwordHash: "x", roleId: admin.id,
        authProvider: "oidc", oidcSubject: `${PFX}-sub-keep`, lastLogin: new Date(),
      },
    });
    const u = await provisionExternalUser({
      provider: "oidc",
      externalIdField: "oidcSubject",
      externalId: `${PFX}-sub-keep`,
      usernameHint: `${PFX}.promoted@example.com`,
      groups: ["some-unmapped-group"],
    });
    expect(u.role.name).toBe("admin");
  });
});

d("findOrProvisionSamlUser (folded onto provisionExternalUser)", () => {
  it("provisions with the historical SAML naming and authProvider azure", async () => {
    const u = await findOrProvisionSamlUser({
      issuer: "x", nameID: `${PFX}.saml@example.com`, nameIDFormat: "x", sessionIndex: "s",
      "http://schemas.microsoft.com/identity/claims/objectidentifier": `${PFX}-oid-1`,
      "http://schemas.microsoft.com/identity/claims/displayname": "Saml Person",
    } as never);
    expect(u.username).toBe(`${PFX}.saml`);
    expect(u.authProvider).toBe("azure");
    expect(u.azureOid).toBe(`${PFX}-oid-1`);
    expect(u.role.name).toBe("readonly");
    expect(u.needsRoleReview).toBe(true);
  });

  it("collision suffix is -azure, matching the pre-fold naming", async () => {
    const readonly = await prisma.role.findUniqueOrThrow({ where: { name: "readonly" } });
    await prisma.user.create({
      data: { username: `${PFX}.dup`, passwordHash: "x", roleId: readonly.id },
    });
    const u = await findOrProvisionSamlUser({
      issuer: "x", nameID: `${PFX}.dup@example.com`, nameIDFormat: "x", sessionIndex: "s",
      "http://schemas.microsoft.com/identity/claims/objectidentifier": `${PFX}-oid-2`,
    } as never);
    expect(u.username).toBe(`${PFX}.dup-azure`);
  });

  it("applies a saml-provider group mapping (single-string groups claim) and stores ssoGroups", async () => {
    const netadmin = await prisma.role.findUniqueOrThrow({ where: { name: "networkadmin" } });
    await prisma.groupMapping.create({
      data: { provider: "saml", groupKey: GROUP_GUID, roleId: netadmin.id, regionTags: ["atl"], enabled: true },
    });
    const u = await findOrProvisionSamlUser({
      issuer: "x", nameID: `${PFX}.mapped@example.com`, nameIDFormat: "x", sessionIndex: "s",
      "http://schemas.microsoft.com/identity/claims/objectidentifier": `${PFX}-oid-3`,
      "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups": GROUP_GUID,
    } as never);
    expect(u.role.name).toBe("networkadmin");
    expect(u.ssoGroups).toEqual([GROUP_GUID]);

    // Tag re-resolution translates authProvider "azure" → mapping provider
    // "saml", so the stored groups yield the mapping's region tags.
    const scopes = await resolveTagScopesForUser(u);
    expect(scopes.regionTags.group).toEqual(["atl"]);
  });

  it("an existing SAML user with no groups claim keeps their role", async () => {
    const assetsadmin = await prisma.role.findUniqueOrThrow({ where: { name: "assetsadmin" } });
    await prisma.user.create({
      data: {
        username: `${PFX}.existing`, passwordHash: "x", roleId: assetsadmin.id,
        authProvider: "azure", azureOid: `${PFX}-oid-4`, lastLogin: new Date(),
      },
    });
    const u = await findOrProvisionSamlUser({
      issuer: "x", nameID: `${PFX}.existing@example.com`, nameIDFormat: "x", sessionIndex: "s",
      "http://schemas.microsoft.com/identity/claims/objectidentifier": `${PFX}-oid-4`,
    } as never);
    expect(u.role.name).toBe("assetsadmin");
    expect(u.username).toBe(`${PFX}.existing`);
  });
});
