/**
 * tests/unit/notificationPollHolds.test.ts
 *
 * The pure half of poll-counted holds: a hold written as `forPolls` is
 * satisfied by N consecutive qualifying READINGS, not by N × cadence seconds of
 * engine ticks (FOR_POLLS_NOTE in notificationTypes). These are the four
 * functions the engine's two families of source resolve through — the series
 * family through `leadingRun`, the current-state family through `advanceRun`,
 * severity ladders through `sustainedSeverityByRun`, and both through the
 * `resolveTierLadder` inheritance that decides which tiers count at all.
 *
 * The DB-bound half (does the engine actually fire on the third reading?) is
 * tests/integration/pollCountedHolds.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  leadingRun,
  advanceRun,
  sustainedSeverityByRun,
  resolveTierLadder,
  triggerHoldPolls,
  resetSustainPolls,
  numMeets,
} from "../../src/services/notificationTypes.js";

const over90 = (v: unknown): boolean => typeof v === "number" && v >= 90;

describe("leadingRun", () => {
  it("counts the consecutive qualifying readings at the head of the series", () => {
    expect(leadingRun([95, 93, 91, 50, 99], over90)).toBe(3);
  });

  it("stops at the first reading that doesn't qualify — a run is CONSECUTIVE", () => {
    // The 50 ends it however long the run behind it was: nine readings over the
    // line mean nothing once one lands under it.
    expect(leadingRun([50, 99, 99, 99, 99, 99, 99, 99, 99, 99], over90)).toBe(0);
  });

  it("counts every reading when they all qualify, and zero on an empty series", () => {
    expect(leadingRun([91, 92, 93], over90)).toBe(3);
    expect(leadingRun([], over90)).toBe(0);
  });

  it("treats a null reading as non-qualifying rather than skipping it", () => {
    // A gap in the samples is not evidence the condition held across it.
    expect(leadingRun([95, null, 95], over90)).toBe(1);
  });
});

describe("advanceRun", () => {
  const t1 = new Date("2026-08-29T10:00:00Z");
  const t2 = new Date("2026-08-29T10:05:00Z");

  it("extends the run on a qualifying reading and zeroes it on one that isn't", () => {
    expect(advanceRun(2, true, t2, t1)).toEqual({ run: 3, advanced: true });
    expect(advanceRun(2, false, t2, t1)).toEqual({ run: 0, advanced: true });
  });

  it("does NOT count the same poll twice — the engine's tick is faster than most cadences", () => {
    // 60s tick, 5-minute cadence: four of every five ticks see the same poll,
    // and counting those would make "3 polls" mean three minutes.
    expect(advanceRun(2, true, t1, t1)).toEqual({ run: 2, advanced: false });
    const older = new Date(t1.getTime() - 1000);
    expect(advanceRun(2, true, older, t1)).toEqual({ run: 2, advanced: false });
  });

  it("counts once when there is no anchor at all — a hold must still be reachable", () => {
    expect(advanceRun(0, true, null, null)).toEqual({ run: 1, advanced: true });
    expect(advanceRun(1, true, null, t1)).toEqual({ run: 2, advanced: true });
  });

  it("normalizes a missing or nonsense stored run to zero", () => {
    expect(advanceRun(NaN as unknown as number, true, t2, t1).run).toBe(1);
    expect(advanceRun(-4, true, t2, t1).run).toBe(1);
  });

  it("does not decay: it is a consecutive run, not the probe loop's leaky bucket", () => {
    // Business rule 30's counter takes one back per answered poll; this one
    // resets outright, because it is counting a condition holding rather than
    // misses outstanding.
    expect(advanceRun(9, false, t2, t1).run).toBe(0);
  });
});

describe("resolveTierLadder with a poll-counted hold", () => {
  const bands = [
    { threshold: 85, severity: "serious" as const },
    { threshold: 95, severity: "critical" as const, forDurationSec: 60 },
  ];

  it("inherits the trigger's count into every tier that carries no hold of its own", () => {
    const ladder = resolveTierLadder(">=", 70, "warning", 300, bands, 3);
    expect(ladder.map((t) => t.forPolls)).toEqual([3, 3, undefined]);
  });

  it("leaves a tier that states its own SECONDS on the wall clock", () => {
    // An API-authored band said "60 seconds", so it is measured in seconds —
    // a per-tier count would need a per-tier run map the wizard can't produce.
    const ladder = resolveTierLadder(">=", 70, "warning", 300, bands, 3);
    expect(ladder[2]).toMatchObject({ severity: "critical", forDurationSec: 60, forPolls: undefined });
  });

  it("carries no counts at all for a rule that states only seconds", () => {
    const ladder = resolveTierLadder(">=", 70, "warning", 300, bands);
    expect(ladder.every((t) => t.forPolls === undefined)).toBe(true);
  });
});

describe("sustainedSeverityByRun", () => {
  const tiers = resolveTierLadder(">=", 70, "warning", 300, [
    { threshold: 85, severity: "serious" },
    { threshold: 95, severity: "critical" },
  ], 3);

  it("takes the most-severe tier whose OWN run has reached the count", () => {
    expect(sustainedSeverityByRun({ warning: 5, serious: 4, critical: 3 }, tiers)).toBe("critical");
  });

  it("holds at the lower tier while the higher one is still short", () => {
    // A value that just climbed into critical has been critical for one reading.
    expect(sustainedSeverityByRun({ warning: 5, serious: 4, critical: 1 }, tiers)).toBe("serious");
  });

  it("returns null while nothing has sustained yet", () => {
    expect(sustainedSeverityByRun({ warning: 2 }, tiers)).toBeNull();
    expect(sustainedSeverityByRun({}, tiers)).toBeNull();
    expect(sustainedSeverityByRun(null, tiers)).toBeNull();
  });

  it("skips wall-clock tiers entirely — sustainedSeverity owns those", () => {
    const mixed = resolveTierLadder(">=", 70, "warning", 300, [
      { threshold: 95, severity: "critical", forDurationSec: 60 },
    ], 2);
    expect(sustainedSeverityByRun({ warning: 9, critical: 9 }, mixed)).toBe("warning");
  });

  it("fires a zero-count tier on its first qualifying reading", () => {
    const now = resolveTierLadder(">=", 70, "warning", 0, null, 0);
    // forPolls 0 normalizes away (a hold of none), so this ladder is wall-clock
    // and this function declines to answer for it.
    expect(now[0]!.forPolls).toBeUndefined();
    expect(sustainedSeverityByRun({ warning: 1 }, now)).toBeNull();
  });

  it("uses each tier's own operator, the way severityForValue does", () => {
    const ladder = resolveTierLadder(">=", 70, "warning", 0, [
      { threshold: 50, severity: "critical", operator: "<=" },
    ], 2);
    expect(ladder[1]).toMatchObject({ operator: "<=", forPolls: 2 });
    expect(numMeets(40, ladder[1]!.operator, ladder[1]!.threshold)).toBe(true);
  });
});

describe("triggerHoldPolls / resetSustainPolls", () => {
  it("read a positive count and nothing else", () => {
    expect(triggerHoldPolls({ forPolls: 3 })).toBe(3);
    expect(triggerHoldPolls({ forPolls: 0 })).toBe(0);
    expect(triggerHoldPolls({})).toBe(0);
    expect(triggerHoldPolls(null)).toBe(0);
    expect(resetSustainPolls({ sustainPolls: 5 })).toBe(5);
    expect(resetSustainPolls({ sustainPolls: null })).toBe(0);
    expect(resetSustainPolls(undefined)).toBe(0);
  });

  it("rounds rather than truncating — half a reading is not a thing", () => {
    expect(triggerHoldPolls({ forPolls: 2.6 })).toBe(3);
  });
});
