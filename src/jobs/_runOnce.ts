/**
 * src/jobs/_runOnce.ts — shared idempotency marker for the one-shot startup
 * jobs (schema-shape migrations + seed-once jobs).
 *
 * Every one-shot job opens with `if (await hasRunMarker(KEY)) return;` and
 * ends with `await stampRunMarker(KEY, stats)` so it runs exactly once per
 * install, stamping the marker with a small stats blob. The stamp is
 * write-only bookkeeping — nothing reads it back, and deleting the marker row
 * is the documented re-run escape hatch — but the KEY is the contract: once a
 * marker key has shipped it must never change, or every existing install
 * re-runs the job on its next boot.
 */

import { prisma } from "../db.js";

/** True when the marker row exists (the job already ran on this install). */
export async function hasRunMarker(markerKey: string): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: markerKey }, select: { key: true } });
  return row !== null;
}

/** Stamp the marker. Upsert, not create — safe against a double-boot race. */
export async function stampRunMarker(markerKey: string, stats?: Record<string, unknown>): Promise<void> {
  const value = { ranAt: new Date().toISOString(), ...(stats ?? {}) };
  await prisma.setting.upsert({
    where:  { key: markerKey },
    update: { value: value as never },
    create: { key: markerKey, value: value as never },
  });
}

