/**
 * src/services/discoveryDurationService.ts
 *
 * Tracks rolling discovery-duration samples per "unit" and computes a
 * "slow-run" threshold from the recent history.
 *
 * A unit is either an integrationId (overall run duration) or
 * `${integrationId}:${fortigateName}` for per-FortiGate FMG runs.
 *
 * Only successful (non-aborted, non-errored) runs are recorded — failed runs
 * would poison the average. Abort and error paths skip recordSample.
 */

import { prisma } from "../db.js";

const SETTINGS_KEY = "discoveryDurationStats";

// Rolling window size. Small enough to adapt to environment changes quickly,
// large enough to smooth one-off outliers.
const WINDOW = 10;

// Minimum samples before we're willing to flag a run as "slow".
const MIN_SAMPLES = 3;

// Absolute headroom added on top of avg — avoids false-positives on small
// or fast runs where even +2σ can be a handful of seconds.
const FLOOR_HEADROOM_MS = 60_000;

// Multiplier headroom (avg * MULT) — catches "clearly longer than normal"
// even when stddev collapses on a very uniform history.
const MULT_HEADROOM = 1.5;

// Variance multiplier for the stddev-based threshold.
const STDDEV_MULT = 2;

interface UnitStats {
  samples: number[];
  updatedAt: string; // ISO timestamp
}

interface StatsDoc {
  units: Record<string, UnitStats>;
}

export interface Baseline {
  sampleCount: number;
  avgMs: number;
  stddevMs: number;
  thresholdMs: number;
}

function emptyDoc(): StatsDoc {
  return { units: {} };
}

async function readDoc(): Promise<StatsDoc> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return emptyDoc();
  const v = row.value as any;
  if (!v || typeof v !== "object" || !v.units || typeof v.units !== "object") {
    return emptyDoc();
  }
  // Defensive: coerce shapes from disk in case an older version wrote something stale.
  const units: Record<string, UnitStats> = {};
  for (const [k, u] of Object.entries(v.units as Record<string, any>)) {
    const samples = Array.isArray(u?.samples)
      ? u.samples.filter((n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0).slice(-WINDOW)
      : [];
    if (samples.length === 0) continue;
    units[k] = { samples, updatedAt: typeof u?.updatedAt === "string" ? u.updatedAt : new Date().toISOString() };
  }
  return { units };
}

async function writeDoc(doc: StatsDoc): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: doc as any },
    create: { key: SETTINGS_KEY, value: doc as any },
  });
}

/**
 * Record a successful run duration (ms) for a unit. Trims the samples array
 * to the last WINDOW entries.
 */
export async function recordSample(unitKey: string, durationMs: number): Promise<void> {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const doc = await readDoc();
  const existing = doc.units[unitKey];
  const samples = existing ? [...existing.samples, durationMs].slice(-WINDOW) : [durationMs];
  doc.units[unitKey] = { samples, updatedAt: new Date().toISOString() };
  await writeDoc(doc);
}

export function computeBaseline(samples: number[]): Baseline | null {
  if (!samples || samples.length < MIN_SAMPLES) return null;
  const n = samples.length;
  const avg = samples.reduce((a, b) => a + b, 0) / n;
  const variance = samples.reduce((acc, x) => acc + (x - avg) * (x - avg), 0) / n;
  const stddev = Math.sqrt(variance);
  const threshold = Math.max(
    avg + STDDEV_MULT * stddev,
    avg * MULT_HEADROOM,
    avg + FLOOR_HEADROOM_MS,
  );
  return { sampleCount: n, avgMs: avg, stddevMs: stddev, thresholdMs: threshold };
}

/**
 * Returns the computed baseline for a unit, or null if there aren't enough
 * samples yet (or the unit has never been recorded).
 */
export async function getBaseline(unitKey: string): Promise<Baseline | null> {
  const doc = await readDoc();
  const u = doc.units[unitKey];
  if (!u) return null;
  return computeBaseline(u.samples);
}

/**
 * Batch variant: returns baselines for several unit keys in one read.
 * Useful for the slow-check loop that iterates over many active units.
 */
export async function getBaselines(unitKeys: string[]): Promise<Map<string, Baseline | null>> {
  const doc = await readDoc();
  const out = new Map<string, Baseline | null>();
  for (const k of unitKeys) {
    const u = doc.units[k];
    out.set(k, u ? computeBaseline(u.samples) : null);
  }
  return out;
}
