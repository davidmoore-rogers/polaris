/**
 * tests/unit/permissionLevelLadders.test.ts
 *
 * The per-key access ladder (2026-09-04). Most function keys hold the full
 * none < read < write < fullwrite ladder; a key may declare a SHORTER one
 * when the levels above its top would be indistinguishable from it.
 * `assetsProbe` is the first: a probe dials the device and writes nothing in
 * Polaris, so Read is the whole grant and the two cells above it were dead
 * radio buttons an operator could nonetheless set.
 *
 * Three failure modes are pinned, all of them silent:
 *
 *  - clamping UPWARD. A stored `fullwrite` on a read-only key means "as much
 *    as possible"; rounding it up (or resolving it to none) would either
 *    grant more than the ladder admits or revoke a capability the role had.
 *  - a route asking for a level the key cannot hold. That route would be
 *    permanently unreachable — nothing can grant it — so it has to fail at
 *    module load, not 403 at 3am.
 *  - the ownership dimension drifting off `credentials`, which is what makes
 *    `write` mean "your own rows" there rather than "every row".
 */

import { describe, expect, it } from "vitest";
import {
  ACCESS_LEVELS,
  FUNCTION_KEYS,
  clampLevelToKey,
  keySupportsLevel,
  levelsFor,
  normalizePermissions,
  permissionOf,
  requirePermission,
} from "../../src/api/middleware/permissions.js";

describe("per-key access ladders", () => {
  it("assetsProbe holds none|read and nothing above", () => {
    expect(levelsFor("assetsProbe")).toEqual(["none", "read"]);
    expect(keySupportsLevel("assetsProbe", "read")).toBe(true);
    expect(keySupportsLevel("assetsProbe", "write")).toBe(false);
    expect(keySupportsLevel("assetsProbe", "fullwrite")).toBe(false);
  });

  it("a key without a declared ladder holds all four levels", () => {
    expect(levelsFor("assets")).toEqual(ACCESS_LEVELS);
    for (const lvl of ACCESS_LEVELS) expect(keySupportsLevel("assets", lvl)).toBe(true);
  });

  it("an unknown key answers the full ladder rather than throwing", () => {
    expect(levelsFor("notAKey")).toEqual(ACCESS_LEVELS);
  });

  it("clamps DOWN into the ladder, never up", () => {
    expect(clampLevelToKey("assetsProbe", "fullwrite")).toBe("read");
    expect(clampLevelToKey("assetsProbe", "write")).toBe("read");
    expect(clampLevelToKey("assetsProbe", "read")).toBe("read");
    expect(clampLevelToKey("assetsProbe", "none")).toBe("none");
    // Untouched on a full-ladder key.
    expect(clampLevelToKey("assets", "fullwrite")).toBe("fullwrite");
  });

  it("normalizePermissions folds a stored over-level value", () => {
    const out = normalizePermissions({ assetsProbe: "fullwrite", assets: "write" });
    expect(out.assetsProbe).toBe("read");
    expect(out.assets).toBe("write");
  });

  it("permissionOf folds a pre-deploy session snapshot too", () => {
    // A session stamped before the ladder narrowed carries the old value and
    // is trusted at boot (cold role-version cache), so the read path clamps.
    expect(permissionOf({ assetsProbe: "write" }, "assetsProbe")).toBe("read");
  });

  it("requirePermission refuses to build a gate the key can never satisfy", () => {
    expect(() => requirePermission("assetsProbe", "write")).toThrow(/cannot hold/i);
    expect(() => requirePermission("assetsProbe", "read")).not.toThrow();
  });
});

describe("ownership-dimensioned keys", () => {
  it("credentials carries the ownership dimension", () => {
    const def = FUNCTION_KEYS.find(f => f.key === "credentials");
    expect(def).toBeDefined();
    expect(def?.hasOwnershipDimension).toBe(true);
  });

  it("the ownership set includes the four keys whose routes call assertOwnership", () => {
    // Deliberately a CONTAINS check, not an exact set: the dimension keeps
    // being added to more keys (networkScan took it in the Discovery
    // visibility cutover), and pinning the whole list turns every future
    // addition into an unrelated red test.
    const owned = FUNCTION_KEYS.filter(f => f.hasOwnershipDimension).map(f => f.key);
    for (const key of ["subnets", "reservations", "contacts", "credentials"]) {
      expect(owned).toContain(key);
    }
  });

  it("an ownership-dimensioned key must be able to hold both write and fullwrite", () => {
    // The dimension IS the distinction between the two levels, so a shortened
    // ladder on one of these keys would silently collapse it.
    for (const def of FUNCTION_KEYS.filter(f => f.hasOwnershipDimension)) {
      expect(keySupportsLevel(def.key, "write")).toBe(true);
      expect(keySupportsLevel(def.key, "fullwrite")).toBe(true);
    }
  });
});
