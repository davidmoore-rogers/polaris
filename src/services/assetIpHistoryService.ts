/**
 * src/services/assetIpHistoryService.ts — Asset IP address history
 *
 * History is auto-populated from two writers:
 *   1. The Prisma query extension in db.ts (recordIpHistory) on every Asset
 *      write that touches the primary `ipAddress`.
 *   2. recordIpHistoryEntries() below, called from the systemInfo scrape
 *      persist in monitoringService — folds in the asset's *associated*
 *      interface IPs (incl. public WAN / secondary addresses) so the timeline
 *      captures every IP the device has held, not just the primary one.
 *
 * Beyond those writers this service handles reads, settings, and pruning only.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";

const SETTINGS_KEY = "assetIpHistorySettings";

export interface IpHistorySettings {
  retentionDays: number; // 0 = keep forever
}

const DEFAULTS: IpHistorySettings = { retentionDays: 0 };

export async function getHistorySettings(): Promise<IpHistorySettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { ...DEFAULTS };
  const v = row.value as any;
  const d = Number(v?.retentionDays);
  return { retentionDays: Number.isFinite(d) && d >= 0 ? Math.floor(d) : DEFAULTS.retentionDays };
}

export async function updateHistorySettings(settings: IpHistorySettings): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: settings as any },
    create: { key: SETTINGS_KEY, value: settings as any },
  });
}

export async function getIpHistory(assetId: string) {
  const { retentionDays } = await getHistorySettings();
  const where: Record<string, unknown> = { assetId };
  if (retentionDays > 0) {
    where.lastSeen = { gte: new Date(Date.now() - retentionDays * 86_400_000) };
  }
  return prisma.assetIpHistory.findMany({ where, orderBy: { lastSeen: "desc" } });
}

/**
 * Pure helper: turn a batch of candidate (ip, source) entries into the deduped
 * row set to upsert. Drops blank IPs, drops the asset's primary `ipAddress`
 * (already owned by the db.ts extension — recording it here too would flip the
 * `source` back and forth between the two writers and churn `firstSeen` on the
 * shared management address), and dedupes within the batch (last source wins).
 *
 * Exported for unit testing; recordIpHistoryEntries() is the DB-touching caller.
 */
export function prepareIpHistoryEntries(
  entries: Array<{ ip: string | null | undefined; source: string | null | undefined }>,
  primaryIp: string | null | undefined,
): Array<{ ip: string; source: string }> {
  const byIp = new Map<string, string>();
  for (const e of entries) {
    const ip = (e.ip ?? "").trim();
    if (!ip) continue;
    if (primaryIp && ip === primaryIp) continue;
    byIp.set(ip, (e.source ?? "").trim() || "monitor-system-info");
  }
  return [...byIp].map(([ip, source]) => ({ ip, source }));
}

/**
 * Batch-record associated/interface IPs into the asset's IP history. One
 * multi-row INSERT … ON CONFLICT per call (single round-trip regardless of how
 * many interfaces the device has — scale-safe on the systemInfo cadence at
 * thousands of assets). Mirrors recordIpHistory()'s upsert semantics: bump
 * lastSeen + source, reset firstSeen only when the source actually changes.
 *
 * Best-effort: swallows errors so a transient DB issue can't break the
 * systemInfo scrape that calls it. Callers fire-and-forget (no await needed).
 */
export async function recordIpHistoryEntries(
  assetId: string,
  entries: Array<{ ip: string | null | undefined; source: string | null | undefined }>,
  primaryIp: string | null | undefined,
): Promise<void> {
  const rows = prepareIpHistoryEntries(entries, primaryIp);
  if (rows.length === 0) return;

  // $2 = shared timestamp (firstSeen + lastSeen on insert). Each row supplies
  // its own client-generated id ($default(uuid()) is client-side in Prisma; we
  // mint it ourselves for the raw path) plus ip + source placeholders.
  const now = new Date().toISOString();
  const params: unknown[] = [assetId, now];
  const valueGroups: string[] = [];
  for (const r of rows) {
    const idP = params.push(randomUUID());
    const ipP = params.push(r.ip);
    const srcP = params.push(r.source);
    valueGroups.push(`($${idP}, $1, $${ipP}, $${srcP}, $2::timestamp, $2::timestamp)`);
  }
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "asset_ip_history" ("id", "assetId", "ip", "source", "firstSeen", "lastSeen")
       VALUES ${valueGroups.join(", ")}
       ON CONFLICT ("assetId", "ip") DO UPDATE SET
         "lastSeen" = EXCLUDED."lastSeen",
         "source" = EXCLUDED."source",
         "firstSeen" = CASE
           WHEN "asset_ip_history"."source" <> EXCLUDED."source" THEN EXCLUDED."firstSeen"
           ELSE "asset_ip_history"."firstSeen"
         END`,
      ...params,
    );
  } catch {
    // Best-effort; history must never break the scrape.
  }
}

export async function pruneOldHistory(): Promise<number> {
  const { retentionDays } = await getHistorySettings();
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const { count } = await prisma.assetIpHistory.deleteMany({ where: { lastSeen: { lt: cutoff } } });
  return count;
}
