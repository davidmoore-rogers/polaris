/**
 * src/jobs/mergeFortiswitchEndpointGhosts.ts
 *
 * One-shot startup cleanup. Before the FortiSwitch baseMac capture landed
 * (see DiscoveredFortiSwitch.baseMac in fortimanagerService.ts and the
 * `is_fortilink_peer` join in detected-device), a managed FortiSwitch was
 * discovered by serial (assetType="switch", no MAC) while its own
 * management MAC was independently learned by the FortiGate's DHCP / ARP /
 * MAC-table pathway and created a SEPARATE Asset (assetType="other" or
 * "workstation", sourceKind="fortigate-endpoint"). Both referred to the
 * same physical device but had no overlapping identifier the dedup logic
 * used.
 *
 * This sweep:
 *   1. Pages through Asset rows where assetType="switch" AND macAddress IS NULL.
 *   2. For each, looks up its fortiswitch AssetSource to recover the
 *      switch's mgmt IP, then searches for sibling endpoint assets whose
 *      `ipAddress` matches AND whose `lastSeenSwitch` starts with
 *      `<switch.hostname>/` (the FortiLink-port sighting pattern).
 *   3. When exactly one orphan matches, merges it into the switch via
 *      `mergeEndpointGhostIntoAsset` (assetGhostMergeService — side-table
 *      transfer, MAC stamp, orphan delete). Skip when multiple orphans
 *      match (operator review).
 *
 * Pairs with the inline MAC-fallback lookup + ghost sweep in the
 * FortiSwitch update path in `syncDhcpSubnets`, which prevent the
 * duplication on future discoveries.
 *
 * Idempotent: re-running finds zero candidates once convergent.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { mergeEndpointGhostIntoAsset } from "../services/assetGhostMergeService.js";
import { runInstrumentedJob } from "./_metrics.js";

const PAGE_SIZE = 200;

(async () => {
  try {
    await runInstrumentedJob("mergeFortiswitchEndpointGhosts", async () => {
      let cursor: { id: string } | undefined = undefined;
      let scannedCount = 0;
      let mergedCount = 0;
      let skippedAmbiguousCount = 0;

      while (true) {
        const switches: Array<{
          id: string;
          hostname: string | null;
          ipAddress: string | null;
          sources: Array<{ observed: unknown }>;
        }> = await prisma.asset.findMany({
          where: { assetType: "switch", macAddress: null },
          select: {
            id: true,
            hostname: true,
            ipAddress: true,
            sources: {
              where: { sourceKind: "fortiswitch" },
              select: { observed: true },
              take: 1,
            },
          },
          orderBy: { id: "asc" },
          take: PAGE_SIZE,
          ...(cursor ? { cursor, skip: 1 } : {}),
        });
        if (switches.length === 0) break;
        cursor = { id: switches[switches.length - 1].id };
        scannedCount += switches.length;

        for (const sw of switches) {
          const observed = (sw.sources[0]?.observed ?? null) as Record<string, unknown> | null;
          const mgmtIp = (typeof observed?.mgmtIp === "string" && observed.mgmtIp) || sw.ipAddress || null;
          const hostname = sw.hostname;
          if (!mgmtIp || !hostname) continue;

          const orphans = await prisma.asset.findMany({
            where: {
              id: { not: sw.id },
              ipAddress: mgmtIp,
              assetType: { in: ["other", "workstation"] }, // FortiGate device-inventory defaults
              lastSeenSwitch: { startsWith: `${hostname}/` },
              sources: { some: { sourceKind: "fortigate-endpoint" } },
            },
            select: { id: true, macAddress: true, hostname: true, lastSeenSwitch: true },
            take: 2, // 2 to detect ambiguity
          });

          if (orphans.length === 0) continue;
          if (orphans.length > 1) {
            skippedAmbiguousCount++;
            logger.warn(
              {
                switchId: sw.id,
                switchHostname: hostname,
                mgmtIp,
                orphanIds: orphans.map((o) => o.id),
              },
              "FortiSwitch ghost-merge: multiple orphan candidates — skipping (operator review)",
            );
            continue;
          }

          const orphan = orphans[0];
          try {
            await mergeEndpointGhostIntoAsset(sw.id, orphan.id);
            mergedCount++;
            logger.info(
              { switchId: sw.id, switchHostname: hostname, orphanId: orphan.id, adoptedMac: orphan.macAddress },
              "FortiSwitch ghost-merge: merged orphan endpoint into switch",
            );
          } catch (err) {
            logger.warn(
              { err, switchId: sw.id, orphanId: orphan.id },
              "FortiSwitch ghost-merge: failed to merge orphan (will retry next boot)",
            );
          }
        }

        if (switches.length < PAGE_SIZE) break;
      }

      if (scannedCount > 0 || mergedCount > 0) {
        logger.info(
          { scanned: scannedCount, merged: mergedCount, skippedAmbiguous: skippedAmbiguousCount },
          "FortiSwitch ghost-merge complete",
        );
      }
    });
  } catch (err) {
    logger.error({ err }, "mergeFortiswitchEndpointGhosts failed (will retry next boot)");
  }
})();
