/**
 * tests/unit/monitorStatusStateMachine.test.ts
 *
 * Coverage for the five-state monitor status machine in
 * `recordProbeResult`. The transitions live inline in the function (no
 * separate pure helper to test directly), so we drive them via a stub of
 * the function's transition logic — keeping the tests fast and independent
 * of Prisma.
 *
 *   States: unknown / pending / up / warning / down
 *   failureThreshold doubles as the recovery threshold.
 *
 * If the inline transition logic in monitoringService.ts changes, mirror
 * the change here and in CLAUDE.md.
 */

import { describe, it, expect } from "vitest";

type Status = "up" | "warning" | "pending" | "down" | "unknown";

interface MachineState {
  status: Status;
  cf:     number;  // consecutiveFailures
  cs:     number;  // consecutiveSuccesses
}

/** Pure transition — same logic as recordProbeResult, threshold parameterized. */
function step(prev: MachineState, success: boolean, threshold: number): MachineState {
  const newCf = success ? 0           : prev.cf + 1;
  const newCs = success ? prev.cs + 1 : 0;
  let next: Status;
  if (success) {
    if (prev.status === "up")                                            next = "up";
    else if (prev.status === "warning" || prev.status === "pending")     next = newCs >= threshold ? "up" : prev.status;
    else                                                                  next = newCs >= threshold ? "up" : "pending";
  } else {
    if (newCf >= threshold)                                                                  next = "down";
    else if (prev.status === "up" || prev.status === "unknown")                              next = "warning";
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

  it("pending + threshold fails → down (pending exits to down on failure cascade)", () => {
    let s: MachineState = { status: "pending", cf: 0, cs: 1 };
    s = step(s, false, 3); expect(s.status).toBe("pending"); // cf=1, cs reset
    s = step(s, false, 3); expect(s.status).toBe("pending"); // cf=2
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

  it("down + first success → pending (recovery starts counting)", () => {
    expect(step(start("down"), true, 3).status).toBe("pending");
  });

  it("pending + (threshold) consecutive successes → up", () => {
    let s = start("down");
    s = step(s, true, 3); expect(s.status).toBe("pending"); // cs=1
    s = step(s, true, 3); expect(s.status).toBe("pending"); // cs=2
    s = step(s, true, 3); expect(s.status).toBe("up");      // cs=3
  });

  it("unknown + first success → pending (not up — needs to confirm)", () => {
    expect(step(start("unknown"), true, 3).status).toBe("pending");
  });

  it("threshold=1 collapses pending into immediate up on first success", () => {
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

  it("pending gets reset to fresh pending when a failure interrupts recovery", () => {
    let s: MachineState = { status: "pending", cf: 0, cs: 1 };
    s = step(s, true,  3); // pending cs=2
    s = step(s, false, 3); // failure: cs zeros, cf=1 — still pending
    expect(s.status).toBe("pending");
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

  it("recovery requires UNINTERRUPTED success run to clear warning/pending", () => {
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
