import { describe, it, expect } from "vitest";

import {
  normalizeWindowsOs,
  normalizeOsInData,
  windowsBuildFrom,
  WINDOWS_11_MIN_BUILD,
} from "../../src/utils/osNormalize.js";

describe("windowsBuildFrom", () => {
  it("reads the dotted 4-part form Intune / Entra / Arc report", () => {
    expect(windowsBuildFrom("10.0.22631.7219")).toBe(22631);
  });

  it("reads the dotted 3-part form", () => {
    expect(windowsBuildFrom("10.0.19045")).toBe(19045);
  });

  it("reads AD's parenthesized operatingSystemVersion", () => {
    expect(windowsBuildFrom("10.0 (22631)")).toBe(22631);
  });

  it("reads gopsutil's 'Build N' suffix (the agent's shape)", () => {
    expect(windowsBuildFrom("10.0.22631 Build 22631")).toBe(22631);
  });

  it("reads a bare build only when it is the entire string", () => {
    expect(windowsBuildFrom("22631")).toBe(22631);
    // A 5-digit run inside other text is too weak a signal to act on — only
    // the "Build <n>" form (digits directly after the keyword) counts.
    expect(windowsBuildFrom("Build 22631")).toBe(22631);
    expect(windowsBuildFrom("build number is 22631 or so")).toBeNull();
    expect(windowsBuildFrom("serial 22631X")).toBeNull();
  });

  it("tries candidates in order and skips empty ones", () => {
    expect(windowsBuildFrom(null, "", "Windows 10 Pro 10.0.22631")).toBe(22631);
  });

  it("returns null rather than guessing on non-Windows versions", () => {
    expect(windowsBuildFrom("8.10")).toBeNull();
    expect(windowsBuildFrom("14.4.1")).toBeNull();
    expect(windowsBuildFrom("7.4.4")).toBeNull();
    expect(windowsBuildFrom(undefined)).toBeNull();
  });
});

describe("normalizeWindowsOs — the ProductName bug", () => {
  it("corrects the reported case: Windows 10 Pro on build 22631", () => {
    expect(normalizeWindowsOs({ os: "Windows 10 Pro", osVersion: "10.0.22631.7219" })).toEqual({
      os: "Windows 11 Pro",
      osVersion: "23H2 (10.0.22631.7219)",
    });
  });

  it("keeps the edition intact while swapping the family", () => {
    expect(normalizeWindowsOs({ os: "Windows 10 Enterprise", osVersion: "10.0.26100" }).os).toBe(
      "Windows 11 Enterprise",
    );
    expect(normalizeWindowsOs({ os: "Microsoft Windows 10 Pro", osVersion: "10.0.22000" }).os).toBe(
      "Microsoft Windows 11 Pro",
    );
  });

  it("leaves a genuine Windows 10 alone", () => {
    expect(normalizeWindowsOs({ os: "Windows 10 Pro", osVersion: "10.0.19045.4291" })).toEqual({
      os: "Windows 10 Pro",
      osVersion: "22H2 (10.0.19045.4291)",
    });
  });

  it("corrects a mislabeled Windows 11 downward too (same table, both directions)", () => {
    expect(normalizeWindowsOs({ os: "Windows 11 Pro", osVersion: "10.0.19045" }).os).toBe(
      "Windows 10 Pro",
    );
  });

  it("names the family for Intune / Entra's bare 'Windows'", () => {
    expect(normalizeWindowsOs({ os: "Windows", osVersion: "10.0.22631.7219" }).os).toBe("Windows 11");
    expect(normalizeWindowsOs({ os: "Windows", osVersion: "10.0.19045" }).os).toBe("Windows 10");
  });

  it("canonicalizes AD's parenthesized version instead of nesting parens", () => {
    expect(normalizeWindowsOs({ os: "Windows 10 Pro", osVersion: "10.0 (22631)" })).toEqual({
      os: "Windows 11 Pro",
      osVersion: "23H2 (10.0.22631)",
    });
  });
});

describe("normalizeWindowsOs — what it must not touch", () => {
  it("leaves Windows Server alone (correct already, and build 26100 collides)", () => {
    // 26100 is BOTH Windows 11 24H2 and Windows Server 2025.
    expect(normalizeWindowsOs({ os: "Windows Server 2025 Datacenter", osVersion: "10.0.26100" })).toEqual({
      os: "Windows Server 2025 Datacenter",
      osVersion: "10.0.26100",
    });
    expect(normalizeWindowsOs({ os: "Windows Server 2022 Standard", osVersion: "10.0.20348.2402" })).toEqual({
      os: "Windows Server 2022 Standard",
      osVersion: "10.0.20348.2402",
    });
  });

  it("leaves Linux and macOS alone", () => {
    expect(normalizeWindowsOs({ os: "Red Hat Enterprise Linux 8.10", osVersion: "8.10" })).toEqual({
      os: "Red Hat Enterprise Linux 8.10",
      osVersion: "8.10",
    });
    expect(normalizeWindowsOs({ os: "macOS 14.4.1", osVersion: "14.4.1" })).toEqual({
      os: "macOS 14.4.1",
      osVersion: "14.4.1",
    });
  });

  it("leaves Fortinet infra alone (os null, osVersion is firmware)", () => {
    expect(normalizeWindowsOs({ os: null, osVersion: "7.4.4" })).toEqual({
      os: null,
      osVersion: "7.4.4",
    });
  });

  it("corrects the family but not the version for an unknown future build", () => {
    // The family threshold never goes stale; the release table does, so an
    // unlisted build keeps its raw version rather than being guessed at.
    expect(normalizeWindowsOs({ os: "Windows 10 Pro", osVersion: "10.0.27890.1000" })).toEqual({
      os: "Windows 11 Pro",
      osVersion: "10.0.27890.1000",
    });
  });

  it("leaves the pair alone when no build can be determined", () => {
    expect(normalizeWindowsOs({ os: "Windows 10 Pro", osVersion: null })).toEqual({
      os: "Windows 10 Pro",
      osVersion: null,
    });
    expect(normalizeWindowsOs({ os: "Windows", osVersion: "" })).toEqual({
      os: "Windows",
      osVersion: "",
    });
  });

  it("does not invent an edition for a Windows string with no family token", () => {
    expect(normalizeWindowsOs({ os: "Windows Embedded Standard", osVersion: "10.0.22631" }).os).toBe(
      "Windows Embedded Standard",
    );
  });

  it("does not treat a bare version string as Windows without an os name", () => {
    expect(normalizeWindowsOs({ os: null, osVersion: "10.0.22631.7219" })).toEqual({
      os: null,
      osVersion: "10.0.22631.7219",
    });
  });
});

describe("normalizeWindowsOs — idempotency", () => {
  it("is a no-op on its own output (every discovery cycle re-writes the pair)", () => {
    const once = normalizeWindowsOs({ os: "Windows 10 Pro", osVersion: "10.0.22631.7219" });
    const twice = normalizeWindowsOs(once);
    expect(twice).toEqual(once);
    expect(normalizeWindowsOs(twice)).toEqual(once);
  });

  it("does not double-label a version already carrying a release", () => {
    expect(normalizeWindowsOs({ os: "Windows 11 Pro", osVersion: "23H2 (10.0.22631.7219)" }).osVersion).toBe(
      "23H2 (10.0.22631.7219)",
    );
    // Pre-Win10-2004 labels are 4-digit ("1809"), matched by the same guard.
    expect(normalizeWindowsOs({ os: "Windows 10 Pro", osVersion: "1809 (10.0.17763)" }).osVersion).toBe(
      "1809 (10.0.17763)",
    );
  });

  it("does not produce '23H2 (23H2)' when a source reports only the release", () => {
    expect(normalizeWindowsOs({ os: "Windows 10 Pro", osVersion: "23H2" })).toEqual({
      os: "Windows 10 Pro",
      osVersion: "23H2",
    });
  });
});

describe("normalizeOsInData — the Prisma write-hook shape", () => {
  it("rewrites the plain form in place", () => {
    const data: any = { os: "Windows 10 Pro", osVersion: "10.0.22631.7219", hostname: "PC-1" };
    normalizeOsInData(data);
    expect(data).toEqual({
      os: "Windows 11 Pro",
      osVersion: "23H2 (10.0.22631.7219)",
      hostname: "PC-1",
    });
  });

  it("rewrites Prisma's nested set form in place", () => {
    const data: any = { os: { set: "Windows 10 Pro" }, osVersion: { set: "10.0.22631" } };
    normalizeOsInData(data);
    expect(data.os.set).toBe("Windows 11 Pro");
    expect(data.osVersion.set).toBe("23H2 (10.0.22631)");
  });

  it("handles a mixed plain/nested pair", () => {
    const data: any = { os: "Windows 10 Pro", osVersion: { set: "10.0.22631.7219" } };
    normalizeOsInData(data);
    expect(data.os).toBe("Windows 11 Pro");
    expect(data.osVersion.set).toBe("23H2 (10.0.22631.7219)");
  });

  it("no-ops when the write does not stage os (the monitor hot path)", () => {
    const data: any = { lastMonitorAt: new Date(0), monitorStatus: "up", consecutiveFailures: 0 };
    const before = { ...data };
    normalizeOsInData(data);
    expect(data).toEqual(before);
  });

  it("does not add an osVersion key the write did not stage", () => {
    const data: any = { os: "Windows 10 Pro" };
    normalizeOsInData(data);
    expect("osVersion" in data).toBe(false);
    // No build available from `os` alone, so the name is left alone too.
    expect(data.os).toBe("Windows 10 Pro");
  });

  it("survives null / unset / non-object args", () => {
    expect(() => normalizeOsInData(null)).not.toThrow();
    expect(() => normalizeOsInData(undefined)).not.toThrow();
    expect(() => normalizeOsInData("nope")).not.toThrow();
    const nulled: any = { os: null, osVersion: null };
    normalizeOsInData(nulled);
    expect(nulled).toEqual({ os: null, osVersion: null });
  });
});

describe("the family threshold", () => {
  it("is build 22000 — the Windows 11 21H2 RTM build", () => {
    expect(WINDOWS_11_MIN_BUILD).toBe(22000);
    expect(normalizeWindowsOs({ os: "Windows 10 Pro", osVersion: "10.0.21999" }).os).toBe("Windows 10 Pro");
    expect(normalizeWindowsOs({ os: "Windows 10 Pro", osVersion: "10.0.22000" }).os).toBe("Windows 11 Pro");
  });
});
