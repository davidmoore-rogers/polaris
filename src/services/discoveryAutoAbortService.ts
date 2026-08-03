/**
 * src/services/discoveryAutoAbortService.ts
 *
 * State behind the discovery auto-abort loop-breaker.
 *
 * checkForSlowRuns cancels a run whose elapsed time exceeds its baseline's
 * autoAbortMs (~2x the rolling average duration). Aborted runs never record a
 * duration sample, so a fleet that legitimately outgrew its baseline (e.g. a
 * few hundred new APs) would otherwise be aborted forever: every run dies at
 * 2x a stale average that never refreshes. The loop-breaker alternates: after
 * an auto-abort, the NEXT overlong run is exempt and allowed to finish (its
 * success records a fresh sample and clears this state); if the exempt run
 * also fails to complete, the run after it is aborted again, and so on —
 * abort, exempt, abort, exempt — until one completes and re-baselines.
 *
 * State lives in one Setting row (`discoveryAutoAbortState`), keyed by
 * integrationId; an entry exists only between an auto-abort and the next
 * successful full run. The pure decision is `decideAutoAbort` (unit-tested);
 * `evaluateAutoAbort` wraps it with the Setting read/write. Readers/writers:
 * checkForSlowRuns in integrations.ts (evaluate) and runDiscovery's completed
 * branch (clearAutoAbortState). Both roles reach it through the DB, so the
 * web-role checker and the discovery-role worker stay coherent.
 */

import { prisma } from "../db.js";

const SETTINGS_KEY = "discoveryAutoAbortState";

export interface AutoAbortUnitState {
  /** When the last auto-abort for this integration fired (ISO). */
  lastAbortAt: string;
  /** startedAt (ISO) of the run granted the post-abort exemption, if any. */
  exemptStartedAt?: string;
}

export type AutoAbortDecision =
  | { action: "abort" }
  /** `granted` is true only on the tick that first grants the exemption —
   *  callers log once on grant, silently skip on subsequent ticks. */
  | { action: "exempt"; granted: boolean };

interface StateDoc {
  units: Record<string, AutoAbortUnitState>;
}

function emptyDoc(): StateDoc {
  return { units: {} };
}

async function readDoc(): Promise<StateDoc> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  const v = row?.value as any;
  if (!v || typeof v !== "object" || !v.units || typeof v.units !== "object") return emptyDoc();
  const units: Record<string, AutoAbortUnitState> = {};
  for (const [k, u] of Object.entries(v.units as Record<string, any>)) {
    if (typeof u?.lastAbortAt !== "string") continue;
    units[k] = {
      lastAbortAt: u.lastAbortAt,
      ...(typeof u.exemptStartedAt === "string" ? { exemptStartedAt: u.exemptStartedAt } : {}),
    };
  }
  return { units };
}

async function writeDoc(doc: StateDoc): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: doc as any },
    create: { key: SETTINGS_KEY, value: doc as any },
  });
}

/**
 * Pure decision for a run that has exceeded its auto-abort threshold.
 * Returns the decision plus the state to persist (null = delete the entry;
 * `unchanged` = skip the write).
 */
export function decideAutoAbort(
  state: AutoAbortUnitState | undefined,
  runStartedAtIso: string,
  nowIso: string = new Date().toISOString(),
): { decision: AutoAbortDecision; nextState: AutoAbortUnitState; unchanged: boolean } {
  // No prior auto-abort on record -> abort this run.
  if (!state) {
    return { decision: { action: "abort" }, nextState: { lastAbortAt: nowIso }, unchanged: false };
  }
  // This run already holds the exemption (stable across repeated ticks).
  if (state.exemptStartedAt === runStartedAtIso) {
    return { decision: { action: "exempt", granted: false }, nextState: state, unchanged: true };
  }
  // Previous run was auto-aborted and no exemption granted yet -> this run
  // gets to finish so a success can refresh the baseline.
  if (!state.exemptStartedAt) {
    return {
      decision: { action: "exempt", granted: true },
      nextState: { ...state, exemptStartedAt: runStartedAtIso },
      unchanged: false,
    };
  }
  // An earlier run held the exemption and still didn't complete successfully
  // (a success would have cleared the entry) -> abort again, and free the
  // exemption for the run after this one.
  return { decision: { action: "abort" }, nextState: { lastAbortAt: nowIso }, unchanged: false };
}

/**
 * Evaluate + persist the auto-abort decision for an over-threshold run.
 * Called only when elapsed > autoAbortMs, so reads are rare.
 */
export async function evaluateAutoAbort(integrationId: string, runStartedAtIso: string): Promise<AutoAbortDecision> {
  const doc = await readDoc();
  const { decision, nextState, unchanged } = decideAutoAbort(doc.units[integrationId], runStartedAtIso);
  if (!unchanged) {
    doc.units[integrationId] = nextState;
    await writeDoc(doc);
  }
  return decision;
}

/**
 * A successful full (non-scoped) run clears the integration's loop-breaker
 * state — recordSample just refreshed the baseline, so the next auto-abort
 * evaluation starts from a clean slate.
 */
export async function clearAutoAbortState(integrationId: string): Promise<void> {
  const doc = await readDoc();
  if (!(integrationId in doc.units)) return;
  delete doc.units[integrationId];
  await writeDoc(doc);
}
