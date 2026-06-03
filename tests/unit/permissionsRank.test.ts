/**
 * tests/unit/permissionsRank.test.ts — rankRole + pickHighestPrivilegeRoleId
 */

import { describe, it, expect, vi } from "vitest";

// permissions.ts imports prisma at module load (used only by the snapshot
// loader, not by the ranking functions under test).
vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  rankRole,
  pickHighestPrivilegeRoleId,
  isAdminEquivalentPermissions,
} from "../../src/api/middleware/permissions.js";

const adminEquiv = { users: "fullwrite", roles: "fullwrite" };
const writer = { subnets: "write", reservations: "write" };
const reader = { subnets: "read" };
const none = {};

describe("isAdminEquivalentPermissions", () => {
  it("is true only when both users and roles are fullwrite", () => {
    expect(isAdminEquivalentPermissions(adminEquiv as any)).toBe(true);
    expect(isAdminEquivalentPermissions({ users: "fullwrite", roles: "write" } as any)).toBe(false);
    expect(isAdminEquivalentPermissions(writer as any)).toBe(false);
  });
});

describe("rankRole", () => {
  it("ranks an admin-equivalent role above any non-admin role", () => {
    expect(rankRole(adminEquiv)).toBe(Number.MAX_SAFE_INTEGER);
    expect(rankRole(adminEquiv)).toBeGreaterThan(rankRole(writer));
  });

  it("ranks by weighted sum for non-admin roles", () => {
    expect(rankRole(writer)).toBeGreaterThan(rankRole(reader));
    expect(rankRole(reader)).toBeGreaterThan(rankRole(none));
    expect(rankRole(none)).toBe(0);
  });
});

describe("pickHighestPrivilegeRoleId", () => {
  it("returns null for an empty list", () => {
    expect(pickHighestPrivilegeRoleId([])).toBeNull();
  });

  it("picks the most-privileged role", () => {
    const roles = [
      { id: "r-read", permissions: reader },
      { id: "r-admin", permissions: adminEquiv },
      { id: "r-write", permissions: writer },
    ];
    expect(pickHighestPrivilegeRoleId(roles)).toBe("r-admin");
  });

  it("breaks ties deterministically by lexicographically-smallest id", () => {
    const roles = [
      { id: "zeta", permissions: writer },
      { id: "alpha", permissions: writer },
      { id: "mid", permissions: writer },
    ];
    expect(pickHighestPrivilegeRoleId(roles)).toBe("alpha");
  });
});
