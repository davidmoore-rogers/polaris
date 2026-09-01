import { describe, it, expect } from "vitest";
import { foldProbeOutages, foldProbeRecoveries, replayProbeStates, serializeOutages } from "../../src/services/probeOutageService.js";

const at = (min: number) => new Date(Date.UTC(2026, 7, 27, 12, min, 0));
const v = (min: number, failed: boolean) => ({ timestamp: at(min), failed });

describe("foldProbeOutages", () => {
  it("returns nothing when every probe succeeded", () => {
    expect(foldProbeOutages([v(0, false), v(1, false), v(2, false)])).toEqual([]);
  });

  it("returns nothing for an empty series", () => {
    expect(foldProbeOutages([])).toEqual([]);
  });

  it("collapses a single failure to a point so it renders as one red dot", () => {
    const out = foldProbeOutages([v(0, false), v(1, true), v(2, false)]);
    expect(out).toHaveLength(1);
    expect(out[0].from).toEqual(at(1));
    expect(out[0].to).toEqual(at(1));
  });

  it("spans a contiguous run from its first to its last failed probe", () => {
    const out = foldProbeOutages([v(0, false), v(1, true), v(2, true), v(3, true), v(4, false)]);
    expect(out).toEqual([{ from: at(1), to: at(3), kind: "outage" }]);
  });

  it("splits runs separated by a success", () => {
    const out = foldProbeOutages([v(0, true), v(1, false), v(2, true), v(3, true)]);
    expect(out).toEqual([
      { from: at(0), to: at(0), kind: "outage" },
      { from: at(2), to: at(3), kind: "outage" },
    ]);
  });

  it("closes a run still failing at the end of the window", () => {
    expect(foldProbeOutages([v(0, false), v(1, true), v(2, true)])).toEqual([{ from: at(1), to: at(2), kind: "outage" }]);
  });

  it("closes a run that was already failing at the start of the window", () => {
    expect(foldProbeOutages([v(0, true), v(1, true), v(2, false)])).toEqual([{ from: at(0), to: at(1), kind: "outage" }]);
  });

  it("rides a still-failing run out to the window end when given one", () => {
    // A device that is down as the chart is drawn is down up to the right
    // edge, not up to its last poll.
    const out = foldProbeOutages([v(0, false), v(1, true), v(2, true)], 0, +at(30));
    expect(out).toEqual([{ from: at(1), to: at(30), kind: "outage" }]);
  });

  it("extends only the FINAL run, never one a later success already closed", () => {
    const out = foldProbeOutages(
      [v(0, false), v(1, true), v(2, false), v(3, true)],
      0,
      +at(30),
    );
    expect(out).toEqual([
      { from: at(1), to: at(1), kind: "outage" },
      { from: at(3), to: at(30), kind: "outage" },
    ]);
  });

  it("leaves the run where it ended when no window end is given", () => {
    expect(foldProbeOutages([v(0, false), v(1, true), v(2, true)])).toEqual([
      { from: at(1), to: at(2), kind: "outage" },
    ]);
  });

  it("never pulls a run BACKWARDS to an earlier window end", () => {
    // Guards the Math.max: a window end older than the last failure (a clock
    // skew, or a range whose `until` predates the newest sample) must not
    // shorten the outage.
    expect(foldProbeOutages([v(0, false), v(5, true)], 0, +at(2))).toEqual([
      { from: at(5), to: at(5), kind: "outage" },
    ]);
  });

  it("extends a rollup run to the end of its last bucket", () => {
    // Two consecutive fully-failed hourly buckets describe two full hours,
    // not the instant each bucketStart names.
    const hour = 3600;
    const out = foldProbeOutages([v(0, false), v(60, true), v(120, true), v(180, false)], hour);
    expect(out).toEqual([{ from: at(60), to: at(180), kind: "outage" }]);
  });

  it("extends a single rollup bucket by exactly one bucket width", () => {
    const out = foldProbeOutages([v(60, true)], 3600);
    expect(out).toEqual([{ from: at(60), to: at(120), kind: "outage" }]);
  });
});

describe("foldProbeOutages — dependency classification", () => {
  const dep = (min: number) => ({ timestamp: at(min), failed: true, dependency: true });

  it("marks a run whose every failure was dependency-suppressed", () => {
    const out = foldProbeOutages([v(0, false), dep(1), dep(2), v(3, false)]);
    expect(out).toEqual([{ from: at(1), to: at(2), kind: "dependency" }]);
  });

  it("splits at the moment the parent goes dark", () => {
    // The two misses before the parent went down were unexplained AT THE TIME.
    // Backdating the explanation over them would claim Polaris knew why the
    // device was quiet when it did not.
    const out = foldProbeOutages([v(0, true), v(1, true), dep(2), dep(3), v(4, false)]);
    expect(out).toEqual([
      { from: at(0), to: at(1), kind: "outage" },
      { from: at(2), to: at(3), kind: "dependency" },
    ]);
  });

  it("splits again when the parent comes back but the device stays dark", () => {
    // The tail is a real outage: the upstream is fine now and this device
    // still is not answering.
    const out = foldProbeOutages([dep(0), dep(1), v(2, true), v(3, true)]);
    expect(out).toEqual([
      { from: at(0), to: at(1), kind: "dependency" },
      { from: at(2), to: at(3), kind: "outage" },
    ]);
  });

  it("carries the kind onto a still-open run extended to the window end", () => {
    const out = foldProbeOutages([v(0, false), dep(1), dep(2)], 0, +at(30));
    expect(out).toEqual([{ from: at(1), to: at(30), kind: "dependency" }]);
  });

  it("treats a verdict with no dependency flag as a plain outage", () => {
    expect(foldProbeOutages([v(1, true)])[0].kind).toBe("outage");
  });
});

describe("foldProbeRecoveries", () => {
  // The same leaky bucket the monitor state machine runs (business rule 30),
  // read back off the probe stream so the alert email can colour the climb out
  // of an outage the way the device page does.
  it("finds nothing when nothing was ever outstanding", () => {
    expect(foldProbeRecoveries([v(0, false), v(1, false), v(2, false)])).toEqual([]);
    expect(foldProbeRecoveries([])).toEqual([]);
  });

  it("ends the climb at the answer that drains the bucket, not at the first one", () => {
    // Two misses, three answers: the first answer leaves one outstanding and is
    // recovering, the second empties the bucket and is already Up. Purple stops
    // at the first — the poll that pays the debt off is not still paying it.
    const out = foldProbeRecoveries([v(0, true), v(1, true), v(2, false), v(3, false), v(4, false)]);
    expect(out).toEqual([{ from: at(2), to: at(2) }]);
  });

  it("covers every answered poll while the debt is still large", () => {
    const out = foldProbeRecoveries([v(0, true), v(1, true), v(2, true), v(3, false), v(4, false), v(5, false)]);
    expect(out).toEqual([{ from: at(3), to: at(4) }]);
  });

  it("breaks the climb when the device drops out again", () => {
    // A relapse is not one long recovery: the second stretch is a separate
    // climb, and joining them would paint the outage between them purple.
    const out = foldProbeRecoveries([v(0, true), v(1, true), v(2, false), v(3, true), v(4, false), v(5, false)]);
    expect(out).toEqual([{ from: at(2), to: at(2) }, { from: at(4), to: at(4) }]);
  });

  it("assumes no debt before the window rather than inventing one", () => {
    // A chart that opens mid-outage counts only the misses it can see — the
    // same assumption the in-app chart's _lpCf makes.
    expect(foldProbeRecoveries([v(0, false), v(1, false)])).toEqual([]);
  });

  it("keeps climbing past the drain when the reset asks for more answers", () => {
    // "Down after 3 missed, up after 5 received": three misses take the device
    // down, three answers pay the bucket off — and the automation still wants
    // two more before it hands back Up. Stopping the purple at the drain would
    // say the device was Up two polls before Polaris said so.
    const probes = [
      v(0, true), v(1, true), v(2, true),                    // 3 misses -> down
      v(3, false), v(4, false), v(5, false),                 // bucket drains
      v(6, false),                                           // confirmation run
      v(7, false),                                           // 5th answer = Up
      v(8, false),
    ];
    // Purple covers answers 1–4; the FIFTH is the one that hands back Up, so it
    // is already green — "up after 5 received" counts the poll that gets there.
    expect(foldProbeRecoveries(probes, 3, 5)).toEqual([{ from: at(3), to: at(6) }]);
  });

  it("changes nothing when the reset asks for no more than the drain costs", () => {
    // Every automation authored before the reset became a poll count — the
    // drain is the floor, so a reset at or below it is inert.
    const probes = [v(0, true), v(1, true), v(2, true), v(3, false), v(4, false), v(5, false), v(6, false)];
    expect(foldProbeRecoveries(probes, 3, 3)).toEqual([{ from: at(3), to: at(4) }]);
  });
});

describe("replayProbeStates", () => {
  it("walks a whole outage through the four states in order", () => {
    // The arithmetic an operator reading the strip against their automation
    // should be able to follow: down at 3 missed, up after 5 received.
    const probes = [
      v(0, false),                                  // up
      v(1, true), v(2, true),                       // missed 1, 2
      v(3, true),                                   // missed 3 -> down
      v(4, false), v(5, false), v(6, false),        // bucket drains 2,1,0
      v(7, false),                                  // confirming 4/5
      v(8, false),                                  // 5th answer -> up
      v(9, false),
    ];
    expect(replayProbeStates(probes, 3, 5)).toEqual([
      "up", "warning", "warning", "down",
      "recovering", "recovering", "recovering", "recovering",
      "up", "up",
    ]);
  });

  it("locks the bucket at the cap, so a long outage costs no more than a short one", () => {
    // The fourth miss adds nothing: the third already declared the outage and
    // the level holds at the cap. Unbounded, this is where a device dark
    // overnight accrued the hundreds of answered polls it then had to serve.
    // The answer at the end is `recovering` — the LEVEL still decides what a
    // MISS means, but a probe that answered is the device climbing back, and
    // painting it `down` is what left the chart no colour to draw it in.
    expect(replayProbeStates([v(0, true), v(1, true), v(2, true), v(3, true), v(4, false)], 3, 0))
      .toEqual(["warning", "warning", "down", "down", "recovering"]);
    // Four answers would have been owed before the cap; the threshold's three
    // are now, however many misses ran past it.
    expect(replayProbeStates(
      [v(0, true), v(1, true), v(2, true), v(3, true), v(4, false), v(5, false), v(6, false)], 3, 0,
    )).toEqual(["warning", "warning", "down", "down", "recovering", "recovering", "up"]);
  });

  it("never reaches down for a passive device", () => {
    // No automation defines down here (business rule 36), so the bucket still
    // runs and the misses still show — Polaris just renders no verdict.
    expect(replayProbeStates([v(0, true), v(1, true), v(2, true), v(3, true)], null, 0))
      .toEqual(["warning", "warning", "warning", "warning"]);
  });
});



describe("serializeOutages", () => {
  it("emits ISO strings", () => {
    expect(serializeOutages([{ from: at(1), to: at(2), kind: "outage" }])).toEqual([
      { from: at(1).toISOString(), to: at(2).toISOString(), kind: "outage" },
    ]);
  });
});
