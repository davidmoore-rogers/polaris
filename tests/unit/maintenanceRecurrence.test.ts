/**
 * tests/unit/maintenanceRecurrence.test.ts
 *
 * Pure-function coverage for the maintenance-schedule recurrence math:
 * shape validation, one-shot bounds, daily/weekly/monthly/yearly matching,
 * midnight-crossing time ranges (start-day semantics), all-day occurrences,
 * activeFrom/activeUntil bounds, short-month day clamping, and the
 * currentWindow occurrence identity used by the operator-release check.
 * All times are server-local by design — tests construct local Dates.
 */

import { describe, it, expect } from "vitest";

import {
  validateScheduleShape,
  resolveStartNow,
  formatLocalIsoMinute,
  isInWindow,
  currentWindow,
  nextWindow,
  type MaintenanceScheduleShape,
} from "../../src/utils/maintenanceRecurrence.js";

// Local-time helper: (y, m 1-based, d, hh, mm)
function at(y: number, m: number, d: number, hh = 0, mm = 0): Date {
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

const oneshot = (startAt: string, endAt: string): MaintenanceScheduleShape =>
  validateScheduleShape({ version: 1, kind: "oneshot", startAt, endAt });

const recurring = (extra: Record<string, unknown>): MaintenanceScheduleShape =>
  validateScheduleShape({ version: 1, kind: "recurring", ...extra });

// ─── validateScheduleShape ──────────────────────────────────────────────────

describe("validateScheduleShape", () => {
  it("accepts a one-shot and rejects end-before-start", () => {
    expect(() => oneshot("2026-07-12T22:00", "2026-07-13T02:00")).not.toThrow();
    expect(() => oneshot("2026-07-13T02:00", "2026-07-12T22:00")).toThrow();
  });

  it("rejects timezone-suffixed datetimes (server-local only)", () => {
    expect(() =>
      validateScheduleShape({ version: 1, kind: "oneshot", startAt: "2026-07-12T22:00:00Z", endAt: "2026-07-13T02:00:00Z" }),
    ).toThrow();
  });

  it("requires daysOfWeek for weekly, dayOfMonth for monthly, month+day for yearly", () => {
    expect(() => recurring({ freq: "weekly" })).toThrow();
    expect(() => recurring({ freq: "weekly", daysOfWeek: [0, 6] })).not.toThrow();
    expect(() => recurring({ freq: "monthly" })).toThrow();
    expect(() => recurring({ freq: "monthly", dayOfMonth: 15 })).not.toThrow();
    expect(() => recurring({ freq: "yearly", month: 7 })).toThrow();
    expect(() => recurring({ freq: "yearly", month: 7, day: 4 })).not.toThrow();
  });

  it("requires startTime and endTime together", () => {
    expect(() => recurring({ freq: "daily", startTime: "22:00" })).toThrow();
    expect(() => recurring({ freq: "daily", startTime: "22:00", endTime: "02:00" })).not.toThrow();
  });

  it("rejects inverted active bounds", () => {
    expect(() =>
      recurring({ freq: "daily", activeFrom: "2026-08-01", activeUntil: "2026-07-01" }),
    ).toThrow();
  });
});

// ─── one-shot ───────────────────────────────────────────────────────────────

describe("oneshot windows", () => {
  const s = oneshot("2026-07-12T22:00", "2026-07-13T02:00");

  it("is active inside [start, end) and inactive outside", () => {
    expect(isInWindow(s, at(2026, 7, 12, 21, 59))).toBe(false);
    expect(isInWindow(s, at(2026, 7, 12, 22, 0))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 13, 1, 59))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 13, 2, 0))).toBe(false); // half-open
  });

  it("currentWindow returns the literal bounds", () => {
    const w = currentWindow(s, at(2026, 7, 12, 23, 0))!;
    expect(w.start).toEqual(at(2026, 7, 12, 22, 0));
    expect(w.end).toEqual(at(2026, 7, 13, 2, 0));
  });

  it("nextWindow returns the window while upcoming/active, null after it passes", () => {
    expect(nextWindow(s, at(2026, 7, 1))!.start).toEqual(at(2026, 7, 12, 22, 0));
    expect(nextWindow(s, at(2026, 7, 13, 1, 0))!.end).toEqual(at(2026, 7, 13, 2, 0));
    expect(nextWindow(s, at(2026, 7, 13, 3, 0))).toBeNull();
  });
});

// ─── daily ──────────────────────────────────────────────────────────────────

describe("daily recurrence", () => {
  it("all-day daily is always in window", () => {
    const s = recurring({ freq: "daily" });
    expect(isInWindow(s, at(2026, 7, 10, 0, 0))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 10, 23, 59))).toBe(true);
  });

  it("time-ranged daily matches only inside the range", () => {
    const s = recurring({ freq: "daily", startTime: "22:00", endTime: "23:00" });
    expect(isInWindow(s, at(2026, 7, 10, 21, 59))).toBe(false);
    expect(isInWindow(s, at(2026, 7, 10, 22, 30))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 10, 23, 0))).toBe(false);
  });

  it("midnight-crossing range ends the FOLLOWING day", () => {
    const s = recurring({ freq: "daily", startTime: "22:00", endTime: "02:00" });
    expect(isInWindow(s, at(2026, 7, 10, 23, 30))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 11, 1, 30))).toBe(true); // yesterday's occurrence
    expect(isInWindow(s, at(2026, 7, 11, 2, 0))).toBe(false);
    // the occurrence containing 01:30 STARTED yesterday
    const w = currentWindow(s, at(2026, 7, 11, 1, 30))!;
    expect(w.start).toEqual(at(2026, 7, 10, 22, 0));
    expect(w.end).toEqual(at(2026, 7, 11, 2, 0));
  });
});

// ─── weekly ─────────────────────────────────────────────────────────────────

describe("weekly recurrence", () => {
  // 2026-07-11 is a Saturday (6); 2026-07-12 is a Sunday (0).
  const s = recurring({ freq: "weekly", daysOfWeek: [6, 0], startTime: "22:00", endTime: "02:00" });

  it("matches only listed days (window start day)", () => {
    expect(isInWindow(s, at(2026, 7, 10, 23, 0))).toBe(false); // Friday
    expect(isInWindow(s, at(2026, 7, 11, 23, 0))).toBe(true); // Saturday
    expect(isInWindow(s, at(2026, 7, 12, 23, 0))).toBe(true); // Sunday
    expect(isInWindow(s, at(2026, 7, 13, 23, 0))).toBe(false); // Monday
  });

  it("midnight span is matched on the START day: Sun 01:00 belongs to Saturday's window", () => {
    // Sunday 01:00 — inside Saturday 22:00 → Sunday 02:00
    expect(isInWindow(s, at(2026, 7, 12, 1, 0))).toBe(true);
    // Monday 01:00 — inside Sunday's window (Sunday is listed)
    expect(isInWindow(s, at(2026, 7, 13, 1, 0))).toBe(true);
    // Tuesday 01:00 — Monday isn't listed
    expect(isInWindow(s, at(2026, 7, 14, 1, 0))).toBe(false);
  });

  it("nextWindow scans forward to the next listed day", () => {
    const w = nextWindow(s, at(2026, 7, 8, 12, 0))!; // Wednesday
    expect(w.start).toEqual(at(2026, 7, 11, 22, 0)); // Saturday
  });
});

// ─── monthly ────────────────────────────────────────────────────────────────

describe("monthly recurrence", () => {
  it("matches the configured day of month", () => {
    const s = recurring({ freq: "monthly", dayOfMonth: 15 });
    expect(isInWindow(s, at(2026, 7, 15, 12, 0))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 14, 12, 0))).toBe(false);
  });

  it("clamps day 31 to short months (Feb 28 in non-leap years)", () => {
    const s = recurring({ freq: "monthly", dayOfMonth: 31 });
    expect(isInWindow(s, at(2026, 2, 28, 12, 0))).toBe(true); // 2026 non-leap
    expect(isInWindow(s, at(2026, 4, 30, 12, 0))).toBe(true); // April
    expect(isInWindow(s, at(2026, 4, 29, 12, 0))).toBe(false);
    expect(isInWindow(s, at(2028, 2, 29, 12, 0))).toBe(true); // 2028 leap
    expect(isInWindow(s, at(2028, 2, 28, 12, 0))).toBe(false);
  });
});

// ─── yearly ─────────────────────────────────────────────────────────────────

describe("yearly recurrence", () => {
  it("matches month+day each year", () => {
    const s = recurring({ freq: "yearly", month: 7, day: 4, startTime: "06:00", endTime: "18:00" });
    expect(isInWindow(s, at(2026, 7, 4, 12, 0))).toBe(true);
    expect(isInWindow(s, at(2027, 7, 4, 12, 0))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 5, 12, 0))).toBe(false);
    expect(isInWindow(s, at(2026, 8, 4, 12, 0))).toBe(false);
  });

  it("nextWindow crosses a year boundary", () => {
    const s = recurring({ freq: "yearly", month: 1, day: 1 });
    const w = nextWindow(s, at(2026, 7, 10))!;
    expect(w.start).toEqual(at(2027, 1, 1));
  });
});

// ─── active bounds ──────────────────────────────────────────────────────────

describe("activeFrom / activeUntil", () => {
  const s = recurring({ freq: "daily", activeFrom: "2026-07-10", activeUntil: "2026-07-12" });

  it("inactive before activeFrom and after activeUntil (inclusive bounds)", () => {
    expect(isInWindow(s, at(2026, 7, 9, 12, 0))).toBe(false);
    expect(isInWindow(s, at(2026, 7, 10, 0, 0))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 12, 23, 59))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 13, 0, 0))).toBe(false);
  });

  it("nextWindow returns null after activeUntil", () => {
    expect(nextWindow(s, at(2026, 7, 14))).toBeNull();
  });

  it("bounds apply to the occurrence START day for midnight spans", () => {
    const t = recurring({
      freq: "daily", startTime: "22:00", endTime: "02:00",
      activeFrom: "2026-07-10", activeUntil: "2026-07-10",
    });
    // Jul 10 22:00 → Jul 11 02:00 runs to completion even though activeUntil is Jul 10
    expect(isInWindow(t, at(2026, 7, 11, 1, 0))).toBe(true);
    // …but no Jul 11 occurrence starts
    expect(isInWindow(t, at(2026, 7, 11, 23, 0))).toBe(false);
  });
});

describe("resolveStartNow", () => {
  it("stamps a oneshot startNow blob with the supplied server clock and strips the marker", () => {
    const now = new Date(2026, 6, 15, 13, 42, 30); // seconds truncate away
    const out = resolveStartNow({ version: 1, kind: "oneshot", startNow: true, endAt: "2026-07-15T19:00" }, now) as any;
    expect(out.startAt).toBe("2026-07-15T13:42");
    expect(out.startNow).toBeUndefined();
    expect(out.endAt).toBe("2026-07-15T19:00");
    // The resolved blob validates as a plain oneshot.
    expect(validateScheduleShape(out).kind).toBe("oneshot");
  });

  it("passes through non-oneshot, non-startNow, and non-object blobs untouched", () => {
    const recurring = { version: 1, kind: "recurring", freq: "daily" };
    expect(resolveStartNow(recurring)).toBe(recurring);
    const concrete = { version: 1, kind: "oneshot", startAt: "2026-07-15T09:00", endAt: "2026-07-15T10:00" };
    expect(resolveStartNow(concrete)).toBe(concrete);
    expect(resolveStartNow(null)).toBeNull();
    expect(resolveStartNow("x")).toBe("x");
  });
});

describe("formatLocalIsoMinute", () => {
  it("zero-pads and truncates to the minute", () => {
    expect(formatLocalIsoMinute(new Date(2026, 0, 5, 8, 7, 59))).toBe("2026-01-05T08:07");
  });
});
