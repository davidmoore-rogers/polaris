/**
 * tests/unit/discoveryAutoAbortService.test.ts
 *
 * Covers the pure loop-breaker decision (decideAutoAbort). The Setting-backed
 * wrappers (evaluateAutoAbort / clearAutoAbortState) hit Prisma and follow the
 * same read/decide/write shape as discoveryDurationService's storage layer.
 *
 * Invariant under test: auto-aborts and exemptions alternate — abort, exempt,
 * abort, exempt — until a successful run clears the state, so a fleet that
 * legitimately outgrew its baseline always gets every other run to completion
 * (which records the fresh duration sample that re-baselines it).
 */

import { describe, it, expect } from "vitest";
import { decideAutoAbort, type AutoAbortUnitState } from "../../src/services/discoveryAutoAbortService.js";

const NOW = "2026-08-03T18:00:00.000Z";
const RUN_A = "2026-08-03T17:00:00.000Z";
const RUN_B = "2026-08-03T17:30:00.000Z";

describe("decideAutoAbort", () => {
  it("aborts when there is no prior state", () => {
    const r = decideAutoAbort(undefined, RUN_A, NOW);
    expect(r.decision).toEqual({ action: "abort" });
    expect(r.nextState).toEqual({ lastAbortAt: NOW });
    expect(r.unchanged).toBe(false);
  });

  it("exempts the first overlong run after an abort, and marks the grant", () => {
    const state: AutoAbortUnitState = { lastAbortAt: NOW };
    const r = decideAutoAbort(state, RUN_A, NOW);
    expect(r.decision).toEqual({ action: "exempt", granted: true });
    expect(r.nextState).toEqual({ lastAbortAt: NOW, exemptStartedAt: RUN_A });
    expect(r.unchanged).toBe(false);
  });

  it("keeps exempting the same run on repeated ticks without re-granting", () => {
    const state: AutoAbortUnitState = { lastAbortAt: NOW, exemptStartedAt: RUN_A };
    const r = decideAutoAbort(state, RUN_A, NOW);
    expect(r.decision).toEqual({ action: "exempt", granted: false });
    expect(r.unchanged).toBe(true);
  });

  it("aborts a later run when the exempted run never completed, freeing the next exemption", () => {
    // Run A held the exemption but errored/aborted (state was never cleared);
    // run B must not inherit it — abort B, and leave the state ready to
    // exempt run C.
    const state: AutoAbortUnitState = { lastAbortAt: NOW, exemptStartedAt: RUN_A };
    const r = decideAutoAbort(state, RUN_B, NOW);
    expect(r.decision).toEqual({ action: "abort" });
    expect(r.nextState.exemptStartedAt).toBeUndefined();
    expect(r.unchanged).toBe(false);
  });

  it("alternates abort/exempt across a sequence of failing overlong runs", () => {
    let state: AutoAbortUnitState | undefined;
    const actions: string[] = [];
    for (let i = 0; i < 6; i++) {
      const startedAt = `2026-08-03T1${i}:00:00.000Z`;
      const r = decideAutoAbort(state, startedAt, NOW);
      actions.push(r.decision.action);
      state = r.nextState;
    }
    expect(actions).toEqual(["abort", "exempt", "abort", "exempt", "abort", "exempt"]);
  });
});
