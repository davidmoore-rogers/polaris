/**
 * tests/unit/monitorStatusStateMachine.test.ts
 *
 * Coverage for the SIX-state monitor status machine in `recordProbeResult`.
 *
 *   States: unknown / recovering / up / warning / down / passive
 *
 * The counter it runs on is a LEAKY BUCKET, not a run length (business rule
 * 30): a missed poll adds one to `consecutiveFailures`, an answered poll takes
 * one back, floored at zero. The verdict is then a pure function of the level:
 *
 *   cf >= threshold              → down
 *   cf > 0, this probe missed    → warning     ("Missed N")
 *   cf > 0, this probe answered  → recovering  (answering, misses outstanding)
 *   cf == 0, run not yet served  → recovering  (confirming — see below)
 *   cf == 0                      → up
 *
 * The LEVEL decides and this probe's outcome only breaks the tie below the
 * threshold, so one answered packet cannot repaint a deep outage.
 *
 * The one place the SUCCESS counter decides anything is the confirmation run:
 * a covering automation whose reset asks for more answered polls than the drain
 * provides ("down after 3 missed, reset after 5 received") holds the asset in
 * `recovering` until `cs` reaches that count — business rule 36, the predicate
 * being `owesRecoveryConfirmation` in utils/monitorStatus.ts. Below the missed
 * count it changes nothing, which covers every automation authored before it
 * and every one that resets immediately.
 *
 * The threshold is the missed-poll count from the covering down-detection
 * automation (downDetectionService), NOT a Monitor Settings value. A NULL
 * threshold means no automation covers the asset: Polaris renders no verdict
 * and the asset reads "passive".
 *
 * WHY THERE IS A PARITY GUARD AT THE BOTTOM: the transitions live inline in an
 * async Prisma-touching function with no pure helper to import, so `step()`
 * below is a hand-copy. A copy cannot catch drift on its own — this file passed
 * unchanged through the rewrite that introduced the bucket, still pinning the
 * old run-length machine while production ran the new one. The last describe
 * block reads monitoringService.ts and fails if the real expressions move.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { owesRecoveryConfirmation } from "../../src/utils/monitorStatus.js";

type Status = "up" | "warning" | "recovering" | "down" | "unknown" | "passive";

interface MachineState {
  status: Status;
  cf:     number;  // consecutiveFailures — the bucket
  cs:     number;  // consecutiveSuccesses — decides only the confirmation run
  /** Asset.awaitingRecoveryConfirm — has read `down` since it last read `up`. */
  awaiting: boolean;
}

/** Pure transition — same logic as recordProbeResult, counts parameterized. */
function step(
  prev: MachineState,
  success: boolean,
  threshold: number | null,
  recoveryPolls = 0,
): MachineState {
  const newCf = success ? Math.max(0, prev.cf - 1) : prev.cf + 1;
  const newCs = success ? prev.cs + 1 : 0;
  let next: Status;
  if (threshold === null)      next = "passive";
  else if (newCf >= threshold) next = "down";
  else if (newCf > 0)          next = success ? "recovering" : "warning";
  else if (owesRecoveryConfirmation(prev.awaiting, newCf, newCs, recoveryPolls)) next = "recovering";
  else                         next = "up";
  // Armed on the way down, disarmed once the asset is genuinely back; every
  // other outcome carries the prior value, which is what survives a mid-run
  // miss parking the asset in `warning`.
  const awaiting = next === "down" ? true : next === "up" ? false : prev.awaiting;
  return { status: next, cf: newCf, cs: newCs, awaiting };
}

/** A device sitting at `cf` outstanding misses. The prior STATUS is deliberately
 *  not an input any more — the bucket carries all the history the verdict needs. */
function at(cf: number): MachineState {
  return { status: "up", cf, cs: 0, awaiting: false };
}

/** Drive a pattern: "." answered, "x" missed. Returns the state after the run. */
function drive(pattern: string, threshold: number | null, from = at(0)): MachineState {
  return pattern.split("").reduce((s, c) => step(s, c === ".", threshold), from);
}

describe("monitor status state machine — the bucket fills", () => {
  it("one missed poll is warning, not down", () => {
    const s = step(at(0), false, 3);
    expect(s).toMatchObject({ status: "warning", cf: 1 });
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

  it("keeps climbing while down — the debt is not capped at the threshold", () => {
    const s = drive("xxxxx", 3);
    expect(s).toMatchObject({ status: "down", cf: 5 });
  });
});

describe("monitor status state machine — the bucket drains", () => {
  it("an answer takes ONE back and does not wipe the count", () => {
    // The whole point of the rewrite. The run-length machine zeroed cf here,
    // handing a device that had already missed twice a completely clean slate
    // for one lucky poll.
    const s = step(at(2), true, 3);
    expect(s).toMatchObject({ status: "recovering", cf: 1 });
  });

  it("remembers the debt, so the next miss lands where it left off", () => {
    // Two misses, one answer, one miss → back to 2 outstanding, NOT 1.
    expect(drive("xx.x", 3)).toMatchObject({ status: "warning", cf: 2 });
    // And at threshold 3 the third miss in that pattern is what declares down.
    expect(drive("xx.xx", 3)).toMatchObject({ status: "down", cf: 3 });
  });

  it("takes as many answers to clear as it took misses to accrue", () => {
    let s = drive("xxx", 3);
    expect(s.status).toBe("down");
    s = step(s, true, 3); expect(s).toMatchObject({ status: "recovering", cf: 2 });
    s = step(s, true, 3); expect(s).toMatchObject({ status: "recovering", cf: 1 });
    s = step(s, true, 3); expect(s).toMatchObject({ status: "up", cf: 0 });
  });

  it("does not let one answered packet lift a deep outage out of down", () => {
    // A device dark for a long stretch owes far more than the threshold. If a
    // success won outright it would read `recovering` — and clear its down
    // alert, which tests monitorStatus == down — on a single packet.
    let s = drive("xxxxxxxx", 3); // cf=8
    s = step(s, true, 3); expect(s).toMatchObject({ status: "down", cf: 7 });
    s = step(s, true, 3); expect(s).toMatchObject({ status: "down", cf: 6 });
    // Three more answers only bring it to the threshold — still down.
    expect(drive("...", 3, s)).toMatchObject({ status: "down", cf: 3 });
    // The fourth is what finally drops it under, and only then is it climbing.
    expect(drive("....", 3, s)).toMatchObject({ status: "recovering", cf: 2 });
    // Six answers for six misses: the debt is paid off exactly.
    expect(drive("......", 3, s)).toMatchObject({ status: "up", cf: 0 });
  });

  it("never drives the bucket below zero", () => {
    const s = drive("..........", 3);
    expect(s).toMatchObject({ status: "up", cf: 0 });
    expect(step(s, true, 3).cf).toBe(0);
  });

  it("goes straight up at threshold 1 — no recovery window to show", () => {
    expect(drive("x.", 1)).toMatchObject({ status: "up", cf: 0 });
  });
});

describe("monitor status state machine — flapping", () => {
  it("alternating miss/answer hovers at one and never reaches a verdict", () => {
    // This is the behavior the bucket preserves from the old machine: a device
    // losing every other packet is annoying, not down.
    const s = drive("x.".repeat(40), 3);
    expect(s.status).toBe("up");
    expect(s.cf).toBe(0);
  });

  it("but two misses per answer DOES eventually reach down", () => {
    // Net +1 per cycle. The run-length machine never got there at all, because
    // every single answer reset the run — which is what made a chronically
    // lossy device invisible to down detection.
    const s = drive("xx.".repeat(10), 3);
    expect(s.status).toBe("down");
  });

  it("a blip during the climb out re-fills the bucket and can go back to down", () => {
    let s = drive("xxx", 3);       // down, cf=3
    s = step(s, true,  3);          // recovering, cf=2
    s = step(s, false, 3);          // back to cf=3
    expect(s).toMatchObject({ status: "down", cf: 3 });
  });

  it("consecutiveSuccesses decides nothing while the bucket still has debt", () => {
    // It is a true fact about the device and is charted; while the bucket has
    // debt the LEVEL alone picks the verdict. The success counter gets a say in
    // exactly one place, the confirmation run below.
    let s = at(5);
    s = step(s, true, 3); expect(s.cs).toBe(1);
    s = step(s, true, 3); expect(s.cs).toBe(2);
    expect(s.status).toBe("down"); // cf=3, still at the threshold
    s = step(s, false, 3); expect(s.cs).toBe(0);
  });
});

describe("the covering automation's recovery count (business rule 36)", () => {
  it("holds recovering until the reset's count of answers is served", () => {
    let s = drive("xxx", 3);                                      // down, cf=3
    s = step(s, true, 3, 5); expect(s.status).toBe("recovering");  // cf=2
    s = step(s, true, 3, 5); expect(s.status).toBe("recovering");  // cf=1
    s = step(s, true, 3, 5); expect(s).toMatchObject({ status: "recovering", cf: 0, cs: 3 });
    s = step(s, true, 3, 5); expect(s).toMatchObject({ status: "recovering", cf: 0, cs: 4 });
    s = step(s, true, 3, 5); expect(s).toMatchObject({ status: "up", cf: 0, cs: 5 });
  });

  it("counts the drain toward the run rather than restarting it after", () => {
    // "5 received" means five probes, not the three that paid the debt plus
    // five more — the operator is describing the device coming back, once.
    let s = drive("xxx", 3);
    let answers = 0;
    while (s.status !== "up" && answers < 20) { s = step(s, true, 3, 5); answers++; }
    expect(answers).toBe(5);
  });

  it("only a device that actually went DOWN owes the run", () => {
    // Two misses against a threshold of 3 never reached down. The second answer
    // is `up` exactly as it was before the count existed.
    let s = drive("xx", 3);
    s = step(s, true, 3, 5); expect(s).toMatchObject({ status: "recovering", cf: 1 });
    s = step(s, true, 3, 5); expect(s).toMatchObject({ status: "up", cf: 0, cs: 2 });
  });

  it("leaves a device that never left up alone, however long its success run", () => {
    // The guard that keeps a healthy device from turning amber on its Nth
    // answer: its run began at cf 0, not at cf >= threshold.
    let s: MachineState = { status: "up", cf: 0, cs: 0, awaiting: false };
    for (let i = 0; i < 10; i++) {
      s = step(s, true, 3, 5);
      expect(s.status).toBe("up");
    }
  });

  it("is a no-op when the reset asks for no more than the drain", () => {
    for (const rec of [0, 1, 3]) {
      let s = drive("xxx", 3);
      s = step(s, true, 3, rec);
      s = step(s, true, 3, rec);
      s = step(s, true, 3, rec);
      expect(s).toMatchObject({ status: "up", cf: 0 });
    }
  });

  it("does not extend a deep outage that already out-drained the count", () => {
    let s = drive("xxxxxxx", 3);   // cf=7
    let answers = 0;
    while (s.status !== "up" && answers < 20) { s = step(s, true, 3, 5); answers++; }
    expect(answers).toBe(7);       // the debt, not the reset, governs here
  });

  it("a miss during the confirmation run sends it back through the bucket", () => {
    let s = drive("xxx", 3);
    s = step(s, true, 3, 5);
    s = step(s, true, 3, 5);
    s = step(s, true, 3, 5);       // cf=0, cs=3 — confirming
    s = step(s, false, 3, 5);      // cf=1, cs=0
    expect(s).toMatchObject({ status: "warning", cf: 1, cs: 0 });
    // The run restarts from zero, so the asset cannot reach up by having
    // answered five times across an interrupted stretch.
    s = step(s, true, 3, 5); expect(s).toMatchObject({ status: "recovering", cf: 0, cs: 1 });
  });

  it("goes straight up at threshold 1 only when the reset asks for nothing", () => {
    // Threshold 1 has no drain to speak of — one miss is down, one answer pays
    // it off — so it is the case where the reset count is the ONLY thing still
    // holding the asset back. Driven rather than hand-built, because the run is
    // owed by having actually reached down.
    const down = step(at(0), false, 1);
    expect(down).toMatchObject({ status: "down", awaiting: true });
    expect(step(down, true, 1).status).toBe("up");
    expect(step(down, true, 1, 3).status).toBe("recovering");
  });
});

describe("passive — no down-detection automation covers the asset", () => {
  it("a null threshold yields passive whatever the bucket says", () => {
    for (const cf of [0, 1, 5, 99]) {
      expect(step(at(cf), true, null).status).toBe("passive");
      expect(step(at(cf), false, null).status).toBe("passive");
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
    // Two misses accumulated while passive; the operator then creates a
    // down-detection automation at 3. The warm bucket means the next miss takes
    // it straight to down rather than restarting the count at 1.
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
  // `step()` above is a hand-copy. These assertions are what make the copy
  // trustworthy: if the inline logic is edited without mirroring it here, the
  // suite fails loudly instead of silently pinning a machine that no longer runs.
  const src = readFileSync(
    resolve(__dirname, "../../src/services/monitoringService.ts"),
    "utf8",
  );

  it("still decrements the bucket on a success rather than zeroing it", () => {
    expect(src).toContain("Math.max(0, (asset.consecutiveFailures ?? 0) - 1)");
    // The old run-length assignment must be gone, or both could coexist.
    expect(src).not.toContain("const newCf = result.success ? 0 ");
  });

  it("still lets the LEVEL decide, with the outcome only breaking the tie", () => {
    expect(src).toContain("} else if (newCf >= threshold) {");
    expect(src).toContain("} else if (newCf > 0) {");
    expect(src).toContain('nextStatus = result.success ? "recovering" : "warning"');
    // Order is the substance of the rule: the threshold test has to come FIRST,
    // or a success would lift a device out of down before the debt is paid.
    const downAt = src.indexOf("} else if (newCf >= threshold) {");
    const tieAt  = src.indexOf("} else if (newCf > 0) {");
    expect(downAt).toBeGreaterThan(-1);
    expect(tieAt).toBeGreaterThan(downAt);
  });

  it("still short-circuits to passive on a null threshold", () => {
    expect(src).toContain("if (threshold === null)");
    expect(src).toContain('nextStatus = "passive"');
  });

  it("arms the confirmation bit on down and disarms it on up, nowhere else", () => {
    // The stored bit is the whole reason a healthy device's success run and a
    // drained bucket stay distinguishable, and the reason a mid-run miss does
    // not release the asset early. Both halves have to be in the patch.
    expect(src).toContain('nextStatus === "down" ? true : nextStatus === "up" ? false : undefined,');
    // And the machine must READ the stored bit rather than re-deriving it,
    // which is the entire reason the column exists.
    expect(src).toContain("awaitingRecoveryConfirm: true,");
  });

  it("reaches a verdict from consecutiveSuccesses in exactly one place", () => {
    // `newCs` decides nothing on its own — the ONE arrow that reads it is the
    // confirmation run, and it reads it through the shared predicate rather
    // than by comparing against the threshold inline, which is what the old
    // run-length machine did and what this guard was written to keep out.
    expect(src).not.toContain("newCs >= threshold");
    expect(src).toContain(
      "owesRecoveryConfirmation(asset.awaitingRecoveryConfirm, newCf, newCs, recoveryPolls)",
    );
  });

  it("resolves the recovery count from the SAME automation as the threshold", () => {
    // Two lookups would let the two directions drift onto different rules.
    expect(src).toContain("const verdict = await resolveDownDetection(assetId);");
    expect(src).toContain("recoveryPollsFor(verdict, effective.intervalSeconds)");
  });

  it("orders the confirmation arrow AFTER the bucket's own three", () => {
    // It may only decide at cf 0. Ahead of the `newCf > 0` tie it would hold a
    // device with outstanding misses in recovering on a missed probe.
    const tieAt     = src.indexOf("} else if (newCf > 0) {");
    const confirmAt = src.indexOf("} else if (owesRecoveryConfirmation(");
    expect(confirmAt).toBeGreaterThan(tieAt);
  });
});
