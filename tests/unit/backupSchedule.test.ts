/**
 * tests/unit/backupSchedule.test.ts
 *
 * Scheduled-backup cadence. `isScheduledBackupDue` is pure so the interesting
 * cases can be asserted without a clock or a database.
 *
 * The behaviours worth locking down are the ones that decide whether an install
 * actually HAS a recovery point:
 *   - enabling produces a backup immediately, not intervalHours from now
 *   - a host that was down through its pinned hour still backs up afterwards
 *     instead of skipping indefinitely
 */

import { describe, it, expect } from "vitest";
import {
  isScheduledBackupDue,
  defaultBackupSchedule,
  type BackupSchedule,
} from "../../src/services/backupScheduleService.js";

function schedule(over: Partial<BackupSchedule> = {}): BackupSchedule {
  return { ...defaultBackupSchedule(), enabled: true, ...over };
}

const AT = (iso: string) => new Date(iso);
const hoursAgo = (from: string, h: number) =>
  new Date(new Date(from).getTime() - h * 3_600_000).toISOString();

describe("isScheduledBackupDue", () => {
  it("is never due while disabled", () => {
    expect(isScheduledBackupDue(schedule({ enabled: false }), AT("2026-08-06T12:00:00Z"))).toBe(false);
    // Even with a long-overdue lastRunAt.
    expect(
      isScheduledBackupDue(
        schedule({ enabled: false, lastRunAt: "2020-01-01T00:00:00Z" }),
        AT("2026-08-06T12:00:00Z"),
      ),
    ).toBe(false);
  });

  it("is due immediately when it has never run", () => {
    // Enabling the feature must produce a recovery point now, not a day later.
    expect(isScheduledBackupDue(schedule({ lastRunAt: null }), AT("2026-08-06T12:00:00Z"))).toBe(true);
  });

  it("waits for the interval to elapse since the last SUCCESS", () => {
    const now = "2026-08-06T12:00:00Z";
    const s = schedule({ intervalHours: 24 });
    expect(isScheduledBackupDue({ ...s, lastRunAt: hoursAgo(now, 23) }, AT(now))).toBe(false);
    expect(isScheduledBackupDue({ ...s, lastRunAt: hoursAgo(now, 24) }, AT(now))).toBe(true);
    expect(isScheduledBackupDue({ ...s, lastRunAt: hoursAgo(now, 30) }, AT(now))).toBe(true);
  });

  it("treats an unparseable lastRunAt as never-run rather than never-due", () => {
    expect(isScheduledBackupDue(schedule({ lastRunAt: "not a date" }), AT("2026-08-06T12:00:00Z"))).toBe(true);
  });

  it("holds an otherwise-due run until the pinned UTC hour", () => {
    const s = schedule({ intervalHours: 24, hourUtc: 3 });
    const at01 = "2026-08-06T01:00:00Z";
    expect(isScheduledBackupDue({ ...s, lastRunAt: hoursAgo(at01, 25) }, AT(at01))).toBe(false);
    const at03 = "2026-08-06T03:00:00Z";
    expect(isScheduledBackupDue({ ...s, lastRunAt: hoursAgo(at03, 25) }, AT(at03))).toBe(true);
  });

  it("runs anyway once double the interval has passed, so a missed window is not skipped forever", () => {
    // A host down through 03:00 UTC every night would otherwise never back up.
    const s = schedule({ intervalHours: 24, hourUtc: 3 });
    const at11 = "2026-08-06T11:00:00Z";
    expect(isScheduledBackupDue({ ...s, lastRunAt: hoursAgo(at11, 49) }, AT(at11))).toBe(true);
  });
});

describe("defaults", () => {
  it("ships disabled, so an upgrade never starts writing backups unasked", () => {
    const d = defaultBackupSchedule();
    expect(d.enabled).toBe(false);
    expect(d.lastRunAt).toBeNull();
    expect(d.copyToDir).toBeNull();
    expect(d.passphrase).toBeNull();
    // Sane cadence for when it is switched on.
    expect(d.intervalHours).toBe(24);
    expect(d.retainCount).toBe(7);
  });
});
