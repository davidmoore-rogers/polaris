/**
 * src/jobs/fixInfraAssetTypes.ts
 *
 * One-shot startup cleanup. Earlier code paths created assets via DHCP /
 * device-inventory before FortiGate / FortiSwitch / FortiAP discovery linked
 * them up by serial or hostname. The infra discovery linked the asset (added
 * a `fortigate-firewall` / `fortiswitch` / `fortiap` AssetSource) but did NOT
 * correct the inherited `assetType="other"` or clean up the pre-adoption
 * sighting, leaving:
 *
 *   1. The infrastructure asset possibly still typed as "other" in the UI
 *   2. A stale `fortigate-endpoint` source row hanging around alongside the
 *      authoritative infrastructure source on the Sources tab — the endpoint
 *      pathways skip infra-typed assets, so the row never refreshes or
 *      clears on its own, and (pre-priority-fix) its observed ipAddress
 *      could outrank the infrastructure mgmtIp in projection (a
 *      newly-deployed FortiGate kept its pre-adoption DHCP lease as
 *      Asset.ipAddress instead of the management IP)
 *
 * This job sweeps once at boot, for each infra source kind (fortigate-firewall
 * → "firewall", fortiswitch → "switch", fortiap → "access_point"):
 *   - Delete fortigate-endpoint source rows on ANY asset carrying the infra
 *     source — even when the assetType is already correct, the coexisting
 *     endpoint row is a stale pre-adoption sighting.
 *   - Flip assetType to the infra type where it differs.
 *
 * Idempotent: re-running after convergence is a no-op (no coexisting
 * endpoint rows to drop, no mismatched types to flip).
 *
 * Pairs with the inline corrections in `syncDhcpSubnets` (the FortiGate /
 * FortiSwitch / FortiAP update paths retype + sweep on adoption), which
 * prevent the issue from recurring on future discoveries.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { runInstrumentedJob } from "./_metrics.js";

(async () => {
  try {
    await runInstrumentedJob("fixInfraAssetTypes", async () => {
    const fixOne = async (
      sourceKind: "fortigate-firewall" | "fortiswitch" | "fortiap",
      targetType: "firewall" | "switch" | "access_point",
    ): Promise<{ retyped: number; sourcesDropped: number }> => {
      const infraRows = await prisma.assetSource.findMany({
        where: { sourceKind },
        select: { assetId: true },
      });
      if (infraRows.length === 0) return { retyped: 0, sourcesDropped: 0 };
      const assetIds = Array.from(new Set(infraRows.map((r) => r.assetId)));

      // Drop the stale endpoint source rows first — the assetType update
      // afterward fires through the same DB extension that no other path
      // depends on the endpoint row being present at that point.
      const sourcesDropped = await prisma.assetSource.deleteMany({
        where: {
          assetId: { in: assetIds },
          sourceKind: "fortigate-endpoint",
        },
      });

      const retyped = await prisma.asset.updateMany({
        where: { id: { in: assetIds }, assetType: { not: targetType } },
        data:  { assetType: targetType },
      });

      return { retyped: retyped.count, sourcesDropped: sourcesDropped.count };
    };

    const fw = await fixOne("fortigate-firewall", "firewall");
    const sw = await fixOne("fortiswitch", "switch");
    const ap = await fixOne("fortiap",     "access_point");

    if (fw.retyped > 0 || sw.retyped > 0 || ap.retyped > 0 || fw.sourcesDropped > 0 || sw.sourcesDropped > 0 || ap.sourcesDropped > 0) {
      logger.info(
        {
          firewallsRetyped:       fw.retyped,
          firewallEndpointsSwept: fw.sourcesDropped,
          switchesRetyped:        sw.retyped,
          switchEndpointsSwept:   sw.sourcesDropped,
          apsRetyped:             ap.retyped,
          apEndpointsSwept:       ap.sourcesDropped,
        },
        "Fixed infrastructure assetType + swept stale fortigate-endpoint sources",
      );
    }
    });
  } catch (err) {
    logger.error({ err }, "fixInfraAssetTypes failed (will retry next boot)");
  }
})();
