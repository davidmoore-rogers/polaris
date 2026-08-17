/**
 * src/jobs/backfillDependencyTree.ts
 *
 * One-shot startup job: rebuilds the dependency DAG once on boot so
 * existing installs don't have to wait for the next scheduled discovery
 * cycle (default 4 hours) before the dependency-suppression feature has
 * data to work with.
 *
 * Idempotent — `recomputeDependencyTree()` deletes the source="computed"
 * rows for in-scope assets and re-inserts from the current discovery
 * signals every run. Operator overrides (source="override") are never
 * touched.
 *
 * Failures are logged but never fatal — the next discovery cycle will
 * rebuild from real source-side writes regardless.
 *
 * Import this from src/app.ts to activate.
 */

import { logger } from "../utils/logger.js";
import { recomputeDependencyTree } from "../services/dependencyTreeService.js";
import { runInstrumentedJob } from "./_metrics.js";

async function backfillDependencyTree(): Promise<void> {
  const start = Date.now();
  try {
    await runInstrumentedJob("backfillDependencyTree", async () => {
      const result = await recomputeDependencyTree();
      if (result.scoped > 0) {
        logger.info(
          {
            assets:        result.scoped,
            edges:         result.edgesWritten,
            unresolved:    result.unresolved,
            endpointEdges: result.endpointEdges,
            elapsedMs:     Date.now() - start,
          },
          "Backfilled dependency tree on startup",
        );
      }
    });
  } catch (err: any) {
    logger.error({ err: err?.message ?? String(err) }, "Dependency-tree backfill failed (next discovery cycle will retry)");
  }
}

// Short delay so the DB pool is warm and the FortiSwitch / FortiAP
// inventory has settled — keeps boot logs uncluttered on slow hosts.
setTimeout(backfillDependencyTree, 30_000);
