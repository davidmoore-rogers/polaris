/**
 * src/utils/maintenanceRecurrence.ts
 *
 * Pure recurrence math for MaintenanceSchedule.schedule JSON — no DB imports.
 * The maintenanceScheduler job evaluates `isInWindow(schedule, now)` on every
 * tick, so there is no next-fire precomputation to invalidate: all times are
 * SERVER-LOCAL wall-clock and DST shifts are absorbed automatically (a window
 * is "active" exactly when the wall clock says it is).
 *
 * Schedule JSON shapes (validated by `scheduleShapeSchema`):
 *
 *   { version: 1, kind: "oneshot",
 *     startAt: "2026-07-12T22:00",       // local ISO, NO timezone suffix
 *     endAt:   "2026-07-13T02:00" }
 *
 *   { version: 1, kind: "recurring",
 *     freq: "daily" | "weekly" | "monthly" | "yearly",
 *     daysOfWeek: [0, 6],                // weekly only; 0 = Sunday
 *     dayOfMonth: 31,                    // monthly; clamped to month length
 *     month: 7, day: 4,                  // yearly (day clamped too)
 *     startTime: "22:00", endTime: "02:00",  // both or neither (neither = all-day);
 *                                        // endTime <= startTime spans midnight and
 *                                        // the day-of-* selector matches the START day
 *     activeFrom: "2026-07-01", activeUntil: "2026-12-31" }  // optional recurrence
 *                                        // bounds (local dates, inclusive, checked
 *                                        // against the occurrence's START day)
 *
 * Occurrences are half-open intervals [start, end): a window ending 02:00 is
 * no longer active at exactly 02:00, so a window starting 02:00 can hand over
 * without a double-active instant.
 */

import { z } from "zod";

// Local date-time without timezone suffix ("2026-07-12T22:00" or with :ss).
// A trailing Z / ±hh:mm offset is rejected — everything is server-local.
const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const localDateTime = z.string().regex(LOCAL_DATETIME_RE, "expected local date-time like 2026-07-12T22:00 (no timezone suffix)");
const localDate = z.string().regex(LOCAL_DATE_RE, "expected local date like 2026-07-12");
const timeOfDay = z.string().regex(TIME_RE, "expected 24h time like 22:00");

const oneshotSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("oneshot"),
    startAt: localDateTime,
    endAt: localDateTime,
  })
  .strict()
  .refine(s => parseLocalDateTime(s.endAt).getTime() > parseLocalDateTime(s.startAt).getTime(), {
    message: "endAt must be after startAt",
  });

const recurringSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("recurring"),
    freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    month: z.number().int().min(1).max(12).optional(),
    day: z.number().int().min(1).max(31).optional(),
    startTime: timeOfDay.optional(),
    endTime: timeOfDay.optional(),
    activeFrom: localDate.optional(),
    activeUntil: localDate.optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.freq === "weekly" && (!s.daysOfWeek || s.daysOfWeek.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "weekly recurrence requires daysOfWeek" });
    }
    if (s.freq === "monthly" && s.dayOfMonth == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "monthly recurrence requires dayOfMonth" });
    }
    if (s.freq === "yearly" && (s.month == null || s.day == null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "yearly recurrence requires month + day" });
    }
    if ((s.startTime == null) !== (s.endTime == null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "startTime and endTime must be set together (omit both for all-day)" });
    }
    if (s.activeFrom && s.activeUntil && s.activeUntil < s.activeFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "activeUntil must not be before activeFrom" });
    }
  });

// Plain union (not discriminatedUnion): both members carry .refine/.superRefine
// wrappers (ZodEffects), which discriminatedUnion rejects. The `kind` literal
// still narrows the inferred type.
export const scheduleShapeSchema = z.union([oneshotSchema, recurringSchema]);

export type MaintenanceScheduleShape = z.infer<typeof scheduleShapeSchema>;
export type OneshotSchedule = z.infer<typeof oneshotSchema>;
export type RecurringSchedule = z.infer<typeof recurringSchema>;

export interface MaintenanceOccurrence {
  start: Date;
  end: Date;
}

/** Zod-validate an unknown schedule blob; throws ZodError on mismatch. */
export function validateScheduleShape(raw: unknown): MaintenanceScheduleShape {
  return scheduleShapeSchema.parse(raw);
}

/** Format a Date as the local-ISO minute string the schedule shapes carry. */
export function formatLocalIsoMinute(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Pre-validation resolution for the ad-hoc `startNow` marker: a oneshot blob
 * carrying `startNow: true` gets `startAt` stamped from the SERVER clock (the
 * marker is stripped — stored shapes are always concrete). Trusting a
 * browser-supplied startAt breaks "enter maintenance now" whenever the
 * operator's clock runs ahead of the server (clock skew, or an operator in a
 * timezone ahead of the server's): the window sits in the server's future and
 * the asset doesn't enter until the skew elapses. Non-oneshot / non-startNow
 * blobs pass through untouched.
 */
export function resolveStartNow(raw: unknown, now: Date = new Date()): unknown {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== "oneshot" || obj.startNow !== true) return raw;
  const { startNow: _drop, ...rest } = obj;
  return { ...rest, startAt: formatLocalIsoMinute(now) };
}

/** Parse "YYYY-MM-DDTHH:MM(:SS)" as server-local time. */
function parseLocalDateTime(s: string): Date {
  const [datePart, timePart] = s.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi, sec] = timePart.split(":").map(Number);
  return new Date(y, mo - 1, d, h, mi, sec || 0, 0);
}

/** Parse "YYYY-MM-DD" as server-local midnight. */
function parseLocalDate(s: string): Date {
  const [y, mo, d] = s.split("-").map(Number);
  return new Date(y, mo - 1, d, 0, 0, 0, 0);
}

/**
 * Public form of parseLocalDate for callers that hold an operator-supplied
 * day string ("YYYY-MM-DD"): the calendar range endpoints. Server-local
 * midnight, matching how every other time in this module is interpreted.
 */
export function parseLocalDay(s: string): Date {
  return parseLocalDate(s);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** Local midnight of the given date. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function addDays(d: Date, n: number): Date {
  // Construct via Y/M/D so DST-shortened/lengthened days can't drift the clock.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 0, 0, 0, 0);
}

/** Does the recurrence's day selector match local day D (a local midnight)? */
function dayMatches(s: RecurringSchedule, day: Date): boolean {
  switch (s.freq) {
    case "daily":
      return true;
    case "weekly":
      return (s.daysOfWeek ?? []).includes(day.getDay());
    case "monthly": {
      const clamped = Math.min(s.dayOfMonth!, daysInMonth(day.getFullYear(), day.getMonth()));
      return day.getDate() === clamped;
    }
    case "yearly": {
      if (day.getMonth() !== s.month! - 1) return false;
      const clamped = Math.min(s.day!, daysInMonth(day.getFullYear(), day.getMonth()));
      return day.getDate() === clamped;
    }
  }
}

/** Is local day D (a local midnight) within the activeFrom/activeUntil bounds? */
function withinActiveBounds(s: RecurringSchedule, day: Date): boolean {
  if (s.activeFrom && day.getTime() < parseLocalDate(s.activeFrom).getTime()) return false;
  if (s.activeUntil && day.getTime() > parseLocalDate(s.activeUntil).getTime()) return false;
  return true;
}

function setTime(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
}

/**
 * The occurrence STARTING on local day `day`, or null if the day selector /
 * active bounds don't match. All-day = [00:00, next-day 00:00). A time range
 * with endTime <= startTime ends on the FOLLOWING day (spans midnight).
 */
function occurrenceStartingOn(s: RecurringSchedule, day: Date): MaintenanceOccurrence | null {
  if (!dayMatches(s, day) || !withinActiveBounds(s, day)) return null;
  if (s.startTime == null || s.endTime == null) {
    return { start: day, end: addDays(day, 1) };
  }
  const start = setTime(day, s.startTime);
  const end = s.endTime > s.startTime ? setTime(day, s.endTime) : setTime(addDays(day, 1), s.endTime);
  return { start, end };
}

/**
 * The occurrence containing `date` ([start, end) half-open), or null.
 * Needed by the scheduler's operator-release check: "did the operator end
 * maintenance during THIS occurrence?" identifies the occurrence by its start.
 */
export function currentWindow(schedule: MaintenanceScheduleShape, date: Date): MaintenanceOccurrence | null {
  if (schedule.kind === "oneshot") {
    const start = parseLocalDateTime(schedule.startAt);
    const end = parseLocalDateTime(schedule.endAt);
    return date.getTime() >= start.getTime() && date.getTime() < end.getTime() ? { start, end } : null;
  }
  // An occurrence is at most 24h (all-day) so only ones starting today or
  // yesterday can contain `date`. Check today last so it wins on the
  // boundary instant where yesterday's midnight-spanning window ends
  // exactly as today's begins (half-open intervals make both checks exact).
  const today = startOfDay(date);
  for (const day of [addDays(today, -1), today]) {
    const occ = occurrenceStartingOn(schedule, day);
    if (occ && date.getTime() >= occ.start.getTime() && date.getTime() < occ.end.getTime()) return occ;
  }
  return null;
}

/** True when `date` falls inside an active occurrence of the schedule. */
export function isInWindow(schedule: MaintenanceScheduleShape, date: Date): boolean {
  return currentWindow(schedule, date) !== null;
}

// Scan horizon for nextWindow: two years covers the worst legitimate gap
// (yearly recurrence just missed + activeFrom pushing the first occurrence
// out) without risking an unbounded loop on a dead schedule.
const NEXT_WINDOW_SCAN_DAYS = 731;

/**
 * The current-or-next occurrence whose end is after `date`, or null when the
 * schedule will never be active again (oneshot passed / activeUntil elapsed /
 * nothing within the two-year scan horizon). Powers UI summaries.
 */
// Day-scan cap for expandOccurrences. The calendar's month grid asks for 42
// days and its "whole year" reach is 366, so 400 bounds the loop without
// truncating any range the UI can request (the route caps the span too).
const EXPAND_MAX_DAYS = 400;

/**
 * Every occurrence OVERLAPPING the half-open range [rangeStart, rangeEnd) —
 * what the Maintenance modal's calendar tab paints. Expansion happens
 * server-side precisely because occurrences are SERVER-LOCAL wall-clock: a
 * browser in another timezone re-deriving them from the recurrence blob would
 * draw windows on the wrong days.
 *
 * The scan starts one day BEFORE the range so a midnight-spanning occurrence
 * (22:00 → 02:00) whose start day sits outside the range still shows up on the
 * day it bleeds into. `maxOccurrences` bounds an all-day daily schedule over a
 * long range; hitting it truncates rather than throws (the caller's range is
 * already capped, so this is a backstop, not a paging contract).
 */
export function expandOccurrences(
  schedule: MaintenanceScheduleShape,
  rangeStart: Date,
  rangeEnd: Date,
  maxOccurrences = 500,
): MaintenanceOccurrence[] {
  if (rangeEnd.getTime() <= rangeStart.getTime() || maxOccurrences <= 0) return [];
  if (schedule.kind === "oneshot") {
    const start = parseLocalDateTime(schedule.startAt);
    const end = parseLocalDateTime(schedule.endAt);
    return end.getTime() > rangeStart.getTime() && start.getTime() < rangeEnd.getTime()
      ? [{ start, end }]
      : [];
  }
  const out: MaintenanceOccurrence[] = [];
  let day = addDays(startOfDay(rangeStart), -1);
  for (let i = 0; i <= EXPAND_MAX_DAYS && day.getTime() < rangeEnd.getTime(); i++) {
    const occ = occurrenceStartingOn(schedule, day);
    if (occ && occ.end.getTime() > rangeStart.getTime() && occ.start.getTime() < rangeEnd.getTime()) {
      out.push(occ);
      if (out.length >= maxOccurrences) break;
    }
    day = addDays(day, 1);
  }
  return out;
}

export function nextWindow(schedule: MaintenanceScheduleShape, date: Date): MaintenanceOccurrence | null {
  if (schedule.kind === "oneshot") {
    const start = parseLocalDateTime(schedule.startAt);
    const end = parseLocalDateTime(schedule.endAt);
    return end.getTime() > date.getTime() ? { start, end } : null;
  }
  const active = currentWindow(schedule, date);
  if (active) return active;
  const today = startOfDay(date);
  for (let i = 0; i <= NEXT_WINDOW_SCAN_DAYS; i++) {
    const day = addDays(today, i);
    if (schedule.activeUntil && day.getTime() > parseLocalDate(schedule.activeUntil).getTime()) return null;
    const occ = occurrenceStartingOn(schedule, day);
    if (occ && occ.end.getTime() > date.getTime()) return occ;
  }
  return null;
}
