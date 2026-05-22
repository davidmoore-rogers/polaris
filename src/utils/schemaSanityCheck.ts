/**
 * src/utils/schemaSanityCheck.ts — Boot-time Prisma-client-vs-DB sanity check.
 *
 * Catches the failure mode where `prisma migrate deploy` ran but
 * `prisma generate` didn't, leaving the in-memory Prisma client referencing
 * columns that no longer exist (or missing columns the DB now has). Without
 * this check the symptom is every Asset / Integration / Reservation query
 * crashing with P2022 at runtime — exactly what bit us when LLDP jobs
 * started failing 63% because the running dist still selected
 * `assets.monitoredOperatorSet` after the `monitor_override_cutover`
 * migration dropped the column.
 *
 * The check runs one `findFirst({})` per high-traffic model. Prisma
 * translates that to a `SELECT <all-scalars> FROM "Table" LIMIT 1`, so a
 * missing column surfaces immediately even on empty tables. On P2022 we
 * exit(1) with a clear recovery message; systemd's restart loop then makes
 * the broken state visible in journalctl instead of silently grinding
 * through millions of failed jobs.
 */

import { prisma } from "../db.js";
import { logger } from "./logger.js";

// Models scanned via `include` (no select) on hot paths and that have been
// touched by recent column-renaming migrations. Order matters only for log
// readability — failures are independent.
const MODELS_TO_CHECK = [
  "asset",
  "assetSource",
  "integration",
  "subnet",
  "reservation",
  "credential",
  "mibFile",
  "manufacturerProfile",
  "user",
  "role",
] as const;

export async function runSchemaSanityCheck(): Promise<void> {
  const failures: { model: string; column?: string; message: string }[] = [];

  for (const model of MODELS_TO_CHECK) {
    try {
      // @ts-expect-error — dynamic model access, validated by the union above
      await prisma[model].findFirst({});
    } catch (err: any) {
      if (err?.code === "P2022") {
        const column = err?.meta?.driverAdapterError?.cause?.column
          ?? err?.meta?.column
          ?? undefined;
        failures.push({ model, column, message: err.message });
      } else {
        // Anything other than a column mismatch (connection refused, auth
        // failure, etc.) is a different boot problem — let it propagate so
        // the existing error handlers surface it.
        throw err;
      }
    }
  }

  if (failures.length === 0) return;

  logger.fatal(
    { failures },
    "Schema sanity check failed — Prisma client and database schema have drifted",
  );

  console.error("");
  console.error("  FATAL: Prisma client schema does not match the database.");
  console.error("");
  for (const f of failures) {
    const col = f.column ? `column "${f.column}" ` : "";
    console.error(`    - ${f.model}: ${col}missing from database`);
  }
  console.error("");
  console.error("  This usually means `prisma migrate deploy` ran without a");
  console.error("  matching `prisma generate` + service restart. Recovery:");
  console.error("");
  console.error("    systemctl stop polaris");
  console.error("    cd /opt/polaris && npx prisma generate && npm run build");
  console.error("    systemctl start polaris");
  console.error("");
  console.error("  Or re-run Server Settings → Maintenance → Updates, which");
  console.error("  runs generate → build → migrate → restart in order.");
  console.error("");

  process.exit(1);
}
