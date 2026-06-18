/**
 * tests/unit/osEventLogService.test.ts
 *
 * Pure-helper coverage for the OS event-log → audit Event ingest. The DB-bound
 * ingestOsEventLog (rate cap + createMany) is exercised by integration tests;
 * here we lock down the level mapping, dedupe, channel sanitization, and audit
 * input shaping that determine what an operator sees in the Events tab.
 */

import { describe, it, expect } from "vitest";
import {
  mapOsLevelToAudit,
  meetsMinAuditLevel,
  dedupeEntries,
  sanitizeChannel,
  buildAuditInputs,
  type OsEventLogEntry,
} from "../../src/services/osEventLogService.js";

describe("mapOsLevelToAudit", () => {
  it("folds critical/error/alert/emerg → error", () => {
    ["critical", "error", "err", "alert", "emerg", "ERROR", "Critical"].forEach((l) =>
      expect(mapOsLevelToAudit(l)).toBe("error"));
  });
  it("maps warning/warn → warning", () => {
    expect(mapOsLevelToAudit("warning")).toBe("warning");
    expect(mapOsLevelToAudit("Warn")).toBe("warning");
  });
  it("maps everything else → info", () => {
    ["info", "notice", "debug", "verbose", "", "weird"].forEach((l) =>
      expect(mapOsLevelToAudit(l)).toBe("info"));
  });
});

describe("meetsMinAuditLevel", () => {
  it("error meets every threshold", () => {
    ["info", "warning", "error"].forEach((min) => expect(meetsMinAuditLevel("error", min)).toBe(true));
  });
  it("warning meets info+warning but not error", () => {
    expect(meetsMinAuditLevel("warning", "info")).toBe(true);
    expect(meetsMinAuditLevel("warning", "warning")).toBe(true);
    expect(meetsMinAuditLevel("warning", "error")).toBe(false);
  });
  it("info only meets info", () => {
    expect(meetsMinAuditLevel("info", "info")).toBe(true);
    expect(meetsMinAuditLevel("info", "warning")).toBe(false);
    expect(meetsMinAuditLevel("info", "error")).toBe(false);
  });
});

describe("dedupeEntries", () => {
  it("collapses identical (channel,eventId,level,message) summing count", () => {
    const entries: OsEventLogEntry[] = [
      { channel: "System", eventId: 7034, level: "error", message: "svc crashed" },
      { channel: "System", eventId: 7034, level: "error", message: "svc crashed", count: 2 },
      { channel: "Application", eventId: 1000, level: "warning", message: "slow" },
    ];
    const out = dedupeEntries(entries);
    expect(out).toHaveLength(2);
    expect(out[0].count).toBe(3); // 1 + 2
    expect(out[1].count).toBe(1);
  });
  it("treats different eventId or message as distinct", () => {
    const entries: OsEventLogEntry[] = [
      { channel: "System", eventId: 1, level: "error", message: "a" },
      { channel: "System", eventId: 2, level: "error", message: "a" },
      { channel: "System", eventId: 1, level: "error", message: "b" },
    ];
    expect(dedupeEntries(entries)).toHaveLength(3);
  });
});

describe("sanitizeChannel", () => {
  it("lowercases + collapses non-alphanumerics to underscores", () => {
    expect(sanitizeChannel("System")).toBe("system");
    expect(sanitizeChannel("Microsoft-Windows-Security-Auditing")).toBe("microsoft_windows_security_auditing");
    expect(sanitizeChannel("  Application  ")).toBe("application");
  });
  it("falls back to 'other' for empty/garbage", () => {
    expect(sanitizeChannel("")).toBe("other");
    expect(sanitizeChannel("///")).toBe("other");
  });
});

describe("buildAuditInputs", () => {
  it("namespaces the action, sets asset resource, maps level, and embeds details", () => {
    const out = buildAuditInputs("asset-1", "host-a", [
      { channel: "System", provider: "Service Control Manager", eventId: 7034, level: "error", message: "The X service terminated", count: 1 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe("os_event.system");
    expect(out[0].resourceType).toBe("asset");
    expect(out[0].resourceId).toBe("asset-1");
    expect(out[0].resourceName).toBe("host-a");
    expect(out[0].level).toBe("error");
    expect(out[0].message).toContain("[System/Service Control Manager]");
    expect(out[0].details).toMatchObject({ channel: "System", eventId: 7034, osLevel: "error", count: 1, source: "os-event-log" });
  });
  it("appends a ×N multiplier to the message when count > 1", () => {
    const out = buildAuditInputs("a", null, [
      { channel: "Application", level: "warning", message: "disk slow", count: 5 },
    ]);
    expect(out[0].message).toContain("(×5)");
    expect(out[0].resourceName).toBeUndefined();
  });
});
