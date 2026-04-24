/**
 * src/db.ts — Prisma client singleton
 *
 * Import `prisma` from this module instead of instantiating PrismaClient
 * directly, so the connection pool is shared across the process.
 *
 * The extended client wraps every asset.create and asset.update that sets
 * ipAddress and records the IP in asset_ip_history (one row per
 * assetId+ip). When the source changes (e.g. IP moves to a different
 * FortiGate) firstSeen is reset so first/last seen reflect the current
 * source rather than the original one.
 * The base client (_base) is reused for the history write to avoid a
 * circular import with assetIpHistoryService.
 */

import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { prisma: any; _prismaBase: PrismaClient };

async function recordIpHistory(base: PrismaClient, assetId: string, ip: string, src: string) {
  const now = new Date();
  try {
    const existing = await base.assetIpHistory.findUnique({ where: { assetId_ip: { assetId, ip } } });
    if (existing) {
      const sourceChanged = existing.source !== src;
      await base.assetIpHistory.update({
        where: { assetId_ip: { assetId, ip } },
        data: { lastSeen: now, source: src, ...(sourceChanged ? { firstSeen: now } : {}) },
      });
    } else {
      await base.assetIpHistory.create({
        data: { assetId, ip, source: src, firstSeen: now, lastSeen: now },
      });
    }
  } catch {
    // Fire-and-forget; history is best-effort.
  }
}

function _buildClient(base: PrismaClient) {
  return base.$extends({
    query: {
      asset: {
        async create({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          const result = await query(args);
          const d = args.data as Record<string, unknown> | undefined;
          const ip = typeof d?.ipAddress === "string" ? d.ipAddress : undefined;
          if (ip) {
            const src = typeof d?.ipSource === "string" ? d.ipSource : "manual";
            recordIpHistory(base, (result as any).id, ip, src);
          }
          return result;
        },
        async update({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          const result = await query(args);
          const d = args.data as Record<string, unknown> | undefined;
          const ip = typeof d?.ipAddress === "string" ? d.ipAddress : undefined;
          if (ip) {
            const src = typeof d?.ipSource === "string" ? d.ipSource : "manual";
            recordIpHistory(base, (result as any).id, ip, src);
          }
          return result;
        },
      },
    },
  });
}

const _base: PrismaClient = g._prismaBase ?? new PrismaClient();
export const prisma: ReturnType<typeof _buildClient> = g.prisma ?? _buildClient(_base);

if (process.env.NODE_ENV !== "production") {
  g._prismaBase = _base;
  g.prisma = prisma;
}
