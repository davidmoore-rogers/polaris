import { describe, it, expect } from "vitest";
import { foldProbeOutages, serializeOutages } from "../../src/services/probeOutageService.js";

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
    expect(out).toEqual([{ from: at(1), to: at(3) }]);
  });

  it("splits runs separated by a success", () => {
    const out = foldProbeOutages([v(0, true), v(1, false), v(2, true), v(3, true)]);
    expect(out).toEqual([
      { from: at(0), to: at(0) },
      { from: at(2), to: at(3) },
    ]);
  });

  it("closes a run still failing at the end of the window", () => {
    expect(foldProbeOutages([v(0, false), v(1, true), v(2, true)])).toEqual([{ from: at(1), to: at(2) }]);
  });

  it("closes a run that was already failing at the start of the window", () => {
    expect(foldProbeOutages([v(0, true), v(1, true), v(2, false)])).toEqual([{ from: at(0), to: at(1) }]);
  });

  it("rides a still-failing run out to the window end when given one", () => {
    // A device that is down as the chart is drawn is down up to the right
    // edge, not up to its last poll.
    const out = foldProbeOutages([v(0, false), v(1, true), v(2, true)], 0, +at(30));
    expect(out).toEqual([{ from: at(1), to: at(30) }]);
  });

  it("extends only the FINAL run, never one a later success already closed", () => {
    const out = foldProbeOutages(
      [v(0, false), v(1, true), v(2, false), v(3, true)],
      0,
      +at(30),
    );
    expect(out).toEqual([
      { from: at(1), to: at(1) },
      { from: at(3), to: at(30) },
    ]);
  });

  it("leaves the run where it ended when no window end is given", () => {
    expect(foldProbeOutages([v(0, false), v(1, true), v(2, true)])).toEqual([
      { from: at(1), to: at(2) },
    ]);
  });

  it("never pulls a run BACKWARDS to an earlier window end", () => {
    // Guards the Math.max: a window end older than the last failure (a clock
    // skew, or a range whose `until` predates the newest sample) must not
    // shorten the outage.
    expect(foldProbeOutages([v(0, false), v(5, true)], 0, +at(2))).toEqual([
      { from: at(5), to: at(5) },
    ]);
  });

  it("extends a rollup run to the end of its last bucket", () => {
    // Two consecutive fully-failed hourly buckets describe two full hours,
    // not the instant each bucketStart names.
    const hour = 3600;
    const out = foldProbeOutages([v(0, false), v(60, true), v(120, true), v(180, false)], hour);
    expect(out).toEqual([{ from: at(60), to: at(180) }]);
  });

  it("extends a single rollup bucket by exactly one bucket width", () => {
    const out = foldProbeOutages([v(60, true)], 3600);
    expect(out).toEqual([{ from: at(60), to: at(120) }]);
  });
});

describe("serializeOutages", () => {
  it("emits ISO strings", () => {
    expect(serializeOutages([{ from: at(1), to: at(2) }])).toEqual([
      { from: at(1).toISOString(), to: at(2).toISOString() },
    ]);
  });
});
