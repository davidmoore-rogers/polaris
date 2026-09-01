/**
 * tests/unit/monitorStatusStateMachine.test.ts
 *
 * Coverage for the SIX-state monitor status machine that `recordProbeResult`
 * runs.
 *
 *   States: unknown / recovering / up / warning / down / passive
 *
 * The counter it runs on is a LEAKY BUCKET WITH A CEILING (business rule 30):
 * a missed poll adds one to `consecutiveFailures`, an answered poll takes one
 * back floored at zero, and the level LOCKS at `max(threshold, recoveryPolls)`
 * the moment a miss declares the outage. The verdict is then:
 *
 *   cf == 0                      → up
 *   this probe ANSWERED          → recovering  (climbing back, misses left)
 *   missed, cf >= threshold      → down
 *   missed, cf <  threshold      → warning     ("Missed N")
 *
 * THE LEVEL DECIDES WHAT A MISS MEANS; the outcome decides everything else.
 *
 * The threshold is the missed-poll count from the covering down-detection
 * automation (downDetectionService), NOT a Monitor Settings value. A NULL
 * threshold means no automation covers the asset: Polaris renders no verdict
 * and the asset reads "passive".
 *
 * NO HAND-COPY ANY MORE. This file used to carry its own transcription of an
 * inline block in `recordProbeResult`, and that copy silently pinned the old
 * run-length machine through the rewrite that introduced the bucket. The
 * machine is now two exported pure functions — `nextFailureBucket` and
 * `monitorStatusFor` — which these tests import directly, so drift is
 * impossible by construction. The parity block at the bottom is reduced to
 * what an import cannot check: that the probe path actually CALLS them, and
 * that it resolves both counts from the same automation.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MAX_MISSED_POLL_BUCKET,
  bucketCapFor,
  monitorStatusFor,
  nextFailureBucket,
  type MonitorStatus,
} from "../../src/utils/monitorStatus.js";

interface MachineState {
  status: MonitorStatus;
  cf:     number;  // consecutiveFailures — the bucket
  cs:     number;  // consecutiveSuccesses — maintained, decides nothing
}

/** One probe, through the real machine. */
function step(
  prev: MachineState,
  success: boolean,
  threshold: number | null,
  recoveryPolls = 0,
): MachineState {
  const cf = nextFailureBucket(prev.cf, success, threshold, recoveryPolls);
  return {
    status: monitorStatusFor(cf, success, threshold),
    cf,
    cs: success ? prev.cs + 1 : 0,
  };
}

/** A device sitting at `cf` outstanding misses. The prior STATUS is deliberately
 *  not an input — the bucket carries all the history the verdict needs. */
function at(cf: number): MachineState {
  return { status: "up", cf, cs: 0 };
}

/** Drive a pattern: "." answered, "x" missed. Returns the state after the run. */
function drive(pattern: string, threshold: number | null, from = at(0), rec = 0): MachineState {
  return pattern.split("").reduce((s, c) => step(s, c === ".", threshold, rec), from);
}

/** How many answered polls it takes to get back to `up` from here. */
function answersToUp(from: MachineState, threshold: number | null, rec = 0): number {
  let s = from;
  let n = 0;
  while (s.status !== "up" && n < 500) { s = step(s, true, threshold, rec); n++; }
  return n;
}

describe("monitor status state machine — the bucket fills", () => {
  it("one missed poll is warning, not down", () => {
    expect(step(at(0), false, 3)).toMatchObject({ status: "warning", cf: 1 });
  });

  it("reaches down on the Nth outstanding miss, where N is the threshold", () => {
    let s = at(0);
    s = step(s, false, 3); expect(s.status).toBe("warning"); // cf=1
    s = step(s, false, 3); expect(s.status).toBe("warning"); // cf=2
    s = step(s, false, 3); expect(s.status).toBe("down");    // cf=3
  });

  it("honors a threshold other than 3", () => {
    expect(drive("xxx", 4).status).toBe("warning");
    expect(drive("xxxx", 4).status).toBe("down");
    expect(drive("x", 1).status).toBe("down");
  });

  it("LOCKS at the cap once down — the debt no longer tracks the outage's length", () => {
    // This is the 2026-09-01 change. Unbounded, a device dark overnight at a
    // 60 s cadence reached cf around 480 and then owed 480 answered polls
    // before it could read `up` — eight hours of a down alert repeating and
    // escalating after the device had demonstrably come back.
    expect(drive("xxxxx", 3)).toMatchObject({ status: "down", cf: 3 });
    expect(drive("x".repeat(500), 3)).toMatchObject({ status: "down", cf: 3 });
  });

  it("locks at the RESET count when that is larger than the threshold", () => {
    // "down after 3 missed, up after 5 received": the third miss jumps the
    // bucket straight to 5, so the drain itself serves the operator's number.
    expect(drive("xxx", 3, at(0), 5)).toMatchObject({ status: "down", cf: 5 });
  });

  it("caps a passive device too, so gaining coverage cannot inherit a huge debt", () => {
    expect(drive("x".repeat(500), null).cf).toBe(MAX_MISSED_POLL_BUCKET);
  });

  it("bucketCapFor takes the larger of the two counts, bounded by the ceiling", () => {
    expect(bucketCapFor(3, 0)).toBe(3);
    expect(bucketCapFor(3, 2)).toBe(3);   // a shorter reset never lowers the drain
    expect(bucketCapFor(3, 5)).toBe(5);
    expect(bucketCapFor(null, 0)).toBe(MAX_MISSED_POLL_BUCKET);
    expect(bucketCapFor(999, 999)).toBe(MAX_MISSED_POLL_BUCKET);
  });
});

describe("monitor status state machine — the bucket drains", () => {
  it("an answer takes ONE back and does not wipe the count", () => {
    // The run-length machine zeroed cf here, handing a device that had already
    // missed twice a completely clean slate for one lucky poll.
    expect(step(at(2), true, 3)).toMatchObject({ status: "recovering", cf: 1 });
  });

  it("remembers the debt, so the next miss lands where it left off", () => {
    expect(drive("xx.x", 3)).toMatchObject({ status: "warning", cf: 2 });
    expect(drive("xx.xx", 3)).toMatchObject({ status: "down", cf: 3 });
  });

  it("takes as many answers to clear as the cap, never more", () => {
    let s = drive("xxx", 3);
    expect(s.status).toBe("down");
    s = step(s, true, 3); expect(s).toMatchObject({ status: "recovering", cf: 2 });
    s = step(s, true, 3); expect(s).toMatchObject({ status: "recovering", cf: 1 });
    s = step(s, true, 3); expect(s).toMatchObject({ status: "up", cf: 0 });
  });

  it("recovery cost is the operator's number, not the outage's length", () => {
    // Four minutes dark and four days dark cost the same three answers.
    expect(answersToUp(drive("xxx", 3), 3)).toBe(3);
    expect(answersToUp(drive("x".repeat(500), 3), 3)).toBe(3);
  });

  it("an ANSWERED probe reads recovering whatever the level says", () => {
    // The answered branch used to sit below the threshold test, so these probes
    // read `down` — and since a chart cannot paint an `ok` point in the down
    // colour, the response-time chart drew them in the plain series green. An
    // outage came out red then GREEN then blue then green, and looked like the
    // device had recovered twice.
    let s = drive("xxx", 3, at(0), 5);   // cf=5, down
    s = step(s, true, 3, 5); expect(s).toMatchObject({ status: "recovering", cf: 4 });
    s = step(s, true, 3, 5); expect(s).toMatchObject({ status: "recovering", cf: 3 });
    s = step(s, true, 3, 5); expect(s).toMatchObject({ status: "recovering", cf: 2 });
    s = step(s, true, 3, 5); expect(s).toMatchObject({ status: "recovering", cf: 1 });
    s = step(s, true, 3, 5); expect(s).toMatchObject({ status: "up", cf: 0 });
  });

  it("never drives the bucket below zero", () => {
    const s = drive("..........", 3);
    expect(s).toMatchObject({ status: "up", cf: 0 });
    expect(step(s, true, 3).cf).toBe(0);
  });

  it("goes straight up at threshold 1 with no reset — no recovery window to show", () => {
    expect(drive("x.", 1)).toMatchObject({ status: "up", cf: 0 });
  });

  it("pulls an over-cap bucket in on the next probe of either outcome", () => {
    // What makes jobs/clampFailureBucket a convenience rather than a
    // correctness requirement: a row written before the ceiling existed
    // converges on its own automation's number at its very next probe.
    expect(step(at(480), true, 3, 0).cf).toBe(2);
    expect(step(at(480), false, 3, 0).cf).toBe(3);
  });
});

describe("monitor status state machine — flapping", () => {
  it("alternating miss/answer hovers at one and never reaches a verdict", () => {
    expect(drive("x.".repeat(40), 3)).toMatchObject({ status: "up", cf: 0 });
  });

  it("but two misses per answer DOES eventually reach down", () => {
    // Net +1 per cycle. The run-length machine never got there at all, because
    // every single answer reset the run.
    //
    // Asserted on the bucket and on a MISSED probe rather than on the state
    // after the run: "xx." ends on an answer, and an answered probe reads
    // `recovering` whatever the level. That is the point of the state — the
    // device is climbing — and it is the verdict a MISS carries that says down.
    // Steady state is an oscillation against the cap: miss, miss (locks at 3),
    // answer (2), and round again — so the run ends one short of the threshold
    // on its answered probe, and every second miss of the cycle is a verdict.
    const s = drive("xx.".repeat(10), 3);
    expect(s).toMatchObject({ status: "recovering", cf: 2 });
    expect(step(s, false, 3)).toMatchObject({ status: "down", cf: 3 });
  });

  it("a blip during the climb out RE-LOCKS the bucket at the cap", () => {
    // A flapping device cannot walk itself out of an outage: any miss that
    // reaches the threshold puts the whole debt back.
    let s = drive("xxx", 3, at(0), 5);  // cf=5
    s = drive("....", 3, s, 5);          // cf=1, one answer short of up
    expect(s).toMatchObject({ status: "recovering", cf: 1 });
    s = step(s, false, 3, 5);            // cf=2 — still below the threshold
    expect(s).toMatchObject({ status: "warning", cf: 2 });
    s = step(s, false, 3, 5);            // cf=3 reaches it → straight back to 5
    expect(s).toMatchObject({ status: "down", cf: 5 });
  });

  it("consecutiveSuccesses decides nothing", () => {
    // It is a true fact about the device and it is charted; the bucket's own
    // level is the whole of the verdict AND of the recovery arithmetic now.
    let s = at(5);
    s = step(s, true, 3); expect(s).toMatchObject({ cs: 1, status: "recovering" });
    s = step(s, true, 3); expect(s.cs).toBe(2);
    s = step(s, false, 3); expect(s.cs).toBe(0);
  });
});

describe("the covering automation's recovery count (business rule 36)", () => {
  it("serves the reset count through the drain, in exactly that many answers", () => {
    expect(answersToUp(drive("xxx", 3, at(0), 5), 3, 5)).toBe(5);
  });

  it("counts the drain toward the run rather than restarting it after", () => {
    // "5 received" means five probes, not the three that paid the debt plus
    // five more — the operator is describing the device coming back, once.
    expect(answersToUp(drive("xxxxxxxx", 3, at(0), 5), 3, 5)).toBe(5);
  });

  it("only a device that actually went DOWN owes the run", () => {
    // Two misses against a threshold of 3 never reached down, so the bucket
    // never jumped to the cap and the second answer is `up`.
    let s = drive("xx", 3, at(0), 5);
    expect(s).toMatchObject({ status: "warning", cf: 2 });
    s = step(s, true, 3, 5); expect(s).toMatchObject({ status: "recovering", cf: 1 });
    s = step(s, true, 3, 5); expect(s).toMatchObject({ status: "up", cf: 0 });
  });

  it("leaves a device that never left up alone, however long its success run", () => {
    let s = at(0);
    for (let i = 0; i < 10; i++) {
      s = step(s, true, 3, 5);
      expect(s.status).toBe("up");
    }
  });

  it("is a no-op when the reset asks for no more than the drain", () => {
    // Every automation authored before recovery counts existed lands here.
    for (const rec of [0, 1, 3]) {
      expect(answersToUp(drive("xxx", 3, at(0), rec), 3, rec)).toBe(3);
    }
  });

  it("holds at threshold 1 only when the reset asks for more", () => {
    expect(drive("x", 1, at(0), 0)).toMatchObject({ status: "down", cf: 1 });
    expect(step(drive("x", 1, at(0), 0), true, 1, 0).status).toBe("up");
    // With a 3-poll reset the same single miss owes three answers.
    const down = drive("x", 1, at(0), 3);
    expect(down).toMatchObject({ status: "down", cf: 3 });
    expect(answersToUp(down, 1, 3)).toBe(3);
  });
});

describe("passive — no down-detection automation covers the asset", () => {
  it("a null threshold yields passive whatever the bucket says", () => {
    for (const cf of [0, 1, 5, 99]) {
      expect(monitorStatusFor(cf, true, null)).toBe("passive");
      expect(monitorStatusFor(cf, false, null)).toBe("passive");
    }
  });

  it("still runs the bucket while passive", () => {
    // Deliberate: consecutiveFailures is itself an automatable field, it is what
    // lets a surface distinguish "passive and answering" from "passive and
    // dark", and it is what makes the convergence below possible.
    let s = at(0);
    s = step(s, false, null); expect(s).toMatchObject({ status: "passive", cf: 1 });
    s = step(s, false, null); expect(s).toMatchObject({ status: "passive", cf: 2 });
    s = step(s, true,  null); expect(s).toMatchObject({ status: "passive", cf: 1 });
  });

  it("an asset that GAINS coverage converges on its very next probe", () => {
    let s = at(0);
    s = step(s, false, null); // cf=1
    s = step(s, false, null); // cf=2
    s = step(s, false, 3);    // cf=3 — covered now
    expect(s.status).toBe("down");
  });

  it("an asset that LOSES coverage keeps its bucket for whoever covers it next", () => {
    let s = drive("xx", 3);
    expect(s.cf).toBe(2);
    s = step(s, false, null);
    expect(s).toMatchObject({ status: "passive", cf: 3 });
  });
});

describe("parity with the real transition in monitoringService.ts", () => {
  // The transitions themselves are imported above, so this block only has to
  // check what an import cannot: that the probe path runs THESE functions, and
  // that it feeds them from one automation rather than two lookups that could
  // drift onto different rules.
  const src = readFileSync(
    resolve(__dirname, "../../src/services/monitoringService.ts"),
    "utf8",
  );

  it("computes the bucket through nextFailureBucket, not inline arithmetic", () => {
    expect(src).toContain(
      "const newCf = nextFailureBucket(asset.consecutiveFailures ?? 0, result.success, threshold, recoveryPolls);",
    );
    // The old inline forms must be gone, or two machines could coexist.
    expect(src).not.toContain("Math.max(0, (asset.consecutiveFailures ?? 0) - 1)");
    expect(src).not.toContain("const newCf = result.success ? 0 ");
  });

  it("picks the status through monitorStatusFor, not an inline arrow chain", () => {
    expect(src).toContain(
      "const nextStatus: MonitorStatus = monitorStatusFor(newCf, result.success, threshold);",
    );
    expect(src).not.toContain("} else if (newCf >= threshold) {");
    expect(src).not.toContain("} else if (newCf > 0) {");
  });

  it("no longer consults the retired confirmation bit", () => {
    // The bucket cap serves the reset count on its own, so reading a stored bit
    // as well would be two mechanisms for one hold — and the column is dormant.
    expect(src).not.toContain("owesRecoveryConfirmation(");
    expect(src).not.toContain("awaitingRecoveryConfirm: true,");
  });

  it("reaches a verdict from consecutiveSuccesses nowhere at all", () => {
    expect(src).not.toContain("newCs >= threshold");
    expect(src).not.toContain("newCs, recoveryPolls");
  });

  it("resolves the recovery count from the SAME automation as the threshold", () => {
    // Two lookups would let the two directions drift onto different rules.
    expect(src).toContain("const verdict = await resolveDownDetection(assetId);");
    expect(src).toContain("recoveryPollsFor(verdict, effective.intervalSeconds)");
  });
});
