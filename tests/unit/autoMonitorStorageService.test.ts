/**
 * tests/unit/autoMonitorStorageService.test.ts
 *
 * Pure-function coverage for the storage auto-monitor resolver. No DB calls;
 * the DB-bound functions (apply/preview/aggregate) are exercised by the
 * integration test suite. Mirrors autoMonitorInterfacesService.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  resolvePinnedStorage,
  type ResolverMount,
  type AutoMonitorStorageSelection,
} from "../../src/services/autoMonitorStorageService.js";

function mount(p: string): ResolverMount {
  return { mountPath: p };
}

const MOUNTS: ResolverMount[] = [
  mount("/"),
  mount("/var"),
  mount("/var/log"),
  mount("/boot/efi"),
  mount("C:"),
  mount("D:"),
];

describe("resolvePinnedStorage", () => {
  it("returns [] for null selection", () => {
    expect(resolvePinnedStorage(null, MOUNTS)).toEqual([]);
  });

  it("returns [] when there are no mounts", () => {
    expect(resolvePinnedStorage({ all: { all: true } }, [])).toEqual([]);
  });

  it("byNames matches exact mountPaths only", () => {
    const sel: AutoMonitorStorageSelection = { byNames: { names: ["/", "/var", "/missing"] } };
    expect(resolvePinnedStorage(sel, MOUNTS).sort()).toEqual(["/", "/var"]);
  });

  it("byPatterns wildcard matches", () => {
    const sel: AutoMonitorStorageSelection = { byPatterns: { patterns: ["/var*"], regex: false } };
    // Anchored wildcard: /var and /var/log both start with /var.
    expect(resolvePinnedStorage(sel, MOUNTS).sort()).toEqual(["/var", "/var/log"]);
  });

  it("byPatterns wildcard matches a Windows drive", () => {
    const sel: AutoMonitorStorageSelection = { byPatterns: { patterns: ["C:"], regex: false } };
    expect(resolvePinnedStorage(sel, MOUNTS)).toEqual(["C:"]);
  });

  it("byPatterns regex matches", () => {
    const sel: AutoMonitorStorageSelection = { byPatterns: { patterns: ["^/var(/.*)?$"], regex: true } };
    expect(resolvePinnedStorage(sel, MOUNTS).sort()).toEqual(["/var", "/var/log"]);
  });

  it("all pins every observed mount", () => {
    const sel: AutoMonitorStorageSelection = { all: { all: true } };
    expect(resolvePinnedStorage(sel, MOUNTS).sort()).toEqual(["/", "/boot/efi", "/var", "/var/log", "C:", "D:"].sort());
  });

  it("unions across blocks and de-dupes", () => {
    const sel: AutoMonitorStorageSelection = {
      byNames: { names: ["/"] },
      byPatterns: { patterns: ["/var*"], regex: false },
    };
    // "/var" appears via pattern; "/" via names — union, no dupes.
    expect(resolvePinnedStorage(sel, MOUNTS).sort()).toEqual(["/", "/var", "/var/log"]);
  });

  it("empty byNames / empty byPatterns contribute nothing", () => {
    const sel: AutoMonitorStorageSelection = { byNames: { names: [] }, byPatterns: { patterns: [], regex: false } };
    expect(resolvePinnedStorage(sel, MOUNTS)).toEqual([]);
  });
});
