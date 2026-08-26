/**
 * tests/unit/monitorStatusStateMachine.test.ts
 *
 * Coverage for the SIX-state monitor status machine in `recordProbeResult`.
 * The transitions live inline in the function (no separate pure helper to test
 * directly), so we drive them via a stub of the function's transition logic —
 * keeping the tests fast and independent of Prisma.
 *
 *   States: unknown / recovering / up / warning / down / passive
 *
 * The threshold is the missed-poll count from the covering down-detection
 * automation (downDetectionService), NOT a Monitor Settings value any more. It
 * doubles as the recovery threshold, same as failureThreshold used to. A NULL
 * threshold means no automation covers the asset: Polaris renders no verdict
 * and the asset reads "passive".
 *
 * If the inline transition logic in monitoringService.ts changes, mirror
 * the change here and in CLAUDE.md.
 */

import { describe, it, expect } from "vitest";

type Status = "up" | "warning" | "recovering" | "down" | "unknown" | "passive";

interface MachineState {
  status: Status;
  cf:     number;  // consecutiveFailures
  cs:     number;  // consecutiveSuccesses
}

/** Pure transition — same logic as recordProbeResult, threshold parameterized.
 *  `threshold === null` is the passive case: no down-detection automation
 *  covers the asset. */
function step(prev: MachineState, success: boolean, threshold: number | null): MachineState {
  const newCf = success ? 0           : prev.cf + 1;
  const newCs = success ? prev.cs + 1 : 0;
  let next: Status;
  if (threshold === null) {
    next = "passive";
  } else if (success) {
    if (prev.status === "up")                                            next = "up";
    else if (prev.status === "warning" || prev.status === "recovering")     next = newCs >= threshold ? "up" : prev.status;
    else                                                                  next = newCs >= threshold ? "up" : "recovering";
  } else {
    if (newCf >= threshold)                                                                  next = "down";
    else if (prev.status === "up" || prev.status === "unknown" || prev.status === "passive")  next = "warning";
    else                                                                                     next = prev.status;
  }
  return { status: next, cf: newCf, cs: newCs };
}

function start(status: Status = "unknown"): MachineState {
  return { status, cf: 0, cs: 0 };
}

describe("monitor status state machine — failure paths", () => {
  it("up + 1 fail → warning", () => {
    expect(step(start("up"), false, 3).status).toBe("warning");
  });

  it("up + N consecutive fails (where N === threshold) → down", () => {
    let s = start("up");
    s = step(s, false, 3); expect(s.status).toBe("warning"); // cf=1
    s = step(s, false, 3); expect(s.status).toBe("warning"); // cf=2
    s = step(s, false, 3); expect(s.status).toBe("down");    // cf=3
  });

  it("warning + (threshold-1) more fails crosses to down", () => {
    let s = start("up");
    s = step(s, false, 4); // warning, cf=1
    s = step(s, false, 4); // warning, cf=2
    s = step(s, false, 4); // warning, cf=3
    s = step(s, false, 4); expect(s.status).toBe("down"); // cf=4
  });

  it("recovering + threshold fails → down (recovering exits to down on failure cascade)", () => {
    let s: MachineState = { status: "recovering", cf: 0, cs: 1 };
    s = step(s, false, 3); expect(s.status).toBe("recovering"); // cf=1, cs reset
    s = step(s, false, 3); expect(s.status).toBe("recovering"); // cf=2
    s = step(s, false, 3); expect(s.status).toBe("down");    // cf=3
  });

  it("down + fail → stays down", () => {
    let s = start("down");
    s = step(s, false, 3);
    expect(s.status).toBe("down");
  });

  it("unknown + fail → warning (treated as fresh up that just failed)", () => {
    expect(step(start("unknown"), false, 3).status).toBe("warning");
  });
});

describe("monitor status state machine — success paths", () => {
  it("up + success → stays up (no counter pressure)", () => {
    expect(step(start("up"), true, 3).status).toBe("up");
  });

  it("warning + 1 success → stays warning until cs >= threshold", () => {
    let s: MachineState = { status: "warning", cf: 1, cs: 0 };
    s = step(s, true, 3); expect(s.status).toBe("warning"); // cs=1
    s = step(s, true, 3); expect(s.status).toBe("warning"); // cs=2
    s = step(s, true, 3); expect(s.status).toBe("up");      // cs=3
  });

  it("down + first success → recovering (recovery starts counting)", () => {
    expect(step(start("down"), true, 3).status).toBe("recovering");
  });

  it("recovering + (threshold) consecutive successes → up", () => {
    let s = start("down");
    s = step(s, true, 3); expect(s.status).toBe("recovering"); // cs=1
    s = step(s, true, 3); expect(s.status).toBe("recovering"); // cs=2
    s = step(s, true, 3); expect(s.status).toBe("up");      // cs=3
  });

  it("unknown + first success → recovering (not up — needs to confirm)", () => {
    expect(step(start("unknown"), true, 3).status).toBe("recovering");
  });

  it("threshold=1 collapses recovering into immediate up on first success", () => {
    expect(step(start("down"), true, 1).status).toBe("up");
    expect(step(start("unknown"), true, 1).status).toBe("up");
  });
});

describe("monitor status state machine — flapping recovery", () => {
  it("warning gets reset to fresh warning when a failure interrupts a partial recovery", () => {
    let s: MachineState = { status: "warning", cf: 1, cs: 0 };
    s = step(s, true,  3); // warning cs=1, cf zeroed by success
    s = step(s, true,  3); // warning cs=2, cf still 0
    s = step(s, false, 3); // failure: cs zeros, cf increments from 0 to 1 — still warning
    expect(s.status).toBe("warning");
    expect(s.cf).toBe(1);
    expect(s.cs).toBe(0);
  });

  it("recovering gets reset to fresh recovering when a failure interrupts recovery", () => {
    let s: MachineState = { status: "recovering", cf: 0, cs: 1 };
    s = step(s, true,  3); // recovering cs=2
    s = step(s, false, 3); // failure: cs zeros, cf=1 — still recovering
    expect(s.status).toBe("recovering");
    expect(s.cf).toBe(1);
    expect(s.cs).toBe(0);
  });

  it("a steady stream of alternating success/fail from up never settles to down", () => {
    let s = start("up");
    for (let i = 0; i < 20; i++) {
      s = step(s, false, 3); // warning (cf=1)
      s = step(s, true,  3); // warning (cs=1; not enough to recover)
    }
    // We end on success → cs=1 in warning. Threshold is 3, so still warning.
    expect(s.status).toBe("warning");
  });

  it("recovery requires UNINTERRUPTED success run to clear warning/recovering", () => {
    let s: MachineState = { status: "warning", cf: 1, cs: 0 };
    s = step(s, true,  3); // cs=1
    s = step(s, true,  3); // cs=2
    s = step(s, false, 3); // cf=2, cs=0 — interrupted
    s = step(s, true,  3); // cs=1
    s = step(s, true,  3); // cs=2
    s = step(s, true,  3); // cs=3 — finally up
    expect(s.status).toBe("up");
  });
});

describe("passive — no down-detection automation covers the asset", () => {
  it("a null threshold yields passive from EVERY prior state", () => {
    const states: Status[] = ["unknown", "up", "warning", "recovering", "down", "passive"];
    for (const from of states) {
      expect(step(start(from), true, null).status).toBe("passive");
      expect(step(start(from), false, null).status).toBe("passive");
    }
  });

  it("still advances the counters while passive", () => {
    // Deliberate: consecutiveFailures is itself an automatable field, it is what
    // lets a surface distinguish "passive and answering" from "passive and
    // dark", and it is what makes the convergence below possible.
    let s = start("passive");
    s = step(s, false, null); expect(s).toMatchObject({ status: "passive", cf: 1, cs: 0 });
    s = step(s, false, null); expect(s).toMatchObject({ status: "passive", cf: 2, cs: 0 });
    s = step(s, true,  null); expect(s).toMatchObject({ status: "passive", cf: 0, cs: 1 });
  });

  it("an asset that GAINS coverage converges on its very next probe", () => {
    // Two misses accumulated while passive; the operator then creates a
    // down-detection automation at 3. The warm counter means the next miss
    // takes it straight to down rather than restarting the run at 1.
    let s = start("passive");
    s = step(s, false, null); // cf=1
    s = step(s, false, null); // cf=2
    s = step(s, false, 3);    // cf=3 — covered now
    expect(s.status).toBe("down");
  });

  it("leaving passive on a FAILURE behaves like leaving unknown", () => {
    // No prior verdict, so one miss under a threshold of 3 is a warning, not a
    // continuation of anything.
    const s = step(start("passive"), false, 3);
    expect(s).toMatchObject({ status: "warning", cf: 1 });
  });

  it("leaving passive on a SUCCESS starts the recovery run", () => {
    let s = step(start("passive"), true, 3);
    expect(s).toMatchObject({ status: "recovering", cs: 1 });
    s = step(s, true, 3); expect(s.status).toBe("recovering");
    s = step(s, true, 3); expect(s.status).toBe("up");
  });

  it("a threshold of 1 makes a passive asset down on its first miss", () => {
    expect(step(start("passive"), false, 1).status).toBe("down");
  });
});
