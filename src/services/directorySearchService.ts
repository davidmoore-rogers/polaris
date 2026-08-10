/**
 * src/services/directorySearchService.ts
 *
 * Live GAL lookup for the address book: fans one typeahead query out across
 * every directory integration that opted in, and merges the hits.
 *
 * LIVE, NOT SYNCED. Nothing here is written to the Polaris database. Directory
 * results exist for the life of one request (plus a short cache) and only an
 * address an operator actually picks becomes a rule recipient or a saved
 * Contact. That is deliberate: a bulk sync would land the organization's entire
 * employee roster — names, addresses, titles, departments — in Polaris with its
 * own retention, backup and audit-exposure surface, to make a typeahead
 * marginally faster.
 *
 * PII posture: query strings and results are never written to Events.
 * `Event.details` is readable by anyone with events access and is shipped
 * off-host by the syslog/SFTP archivers, so a search term naming a person must
 * not land there.
 *
 * Opt-in per integration (`config.enableDirectorySearch`, default false)
 * because both backends need permissions the device-discovery integration has
 * never required — Graph User.Read.All / Group.Read.All / OrgContact.Read.All
 * (or Directory.Read.All), and an AD bind that can read user objects. Without
 * the grant every keystroke would 403, so the gate keeps a broken typeahead off
 * installs that haven't set it up.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { createTtlCache } from "../utils/ttlCache.js";
import { searchDirectoryEntra, type DirectoryHit } from "./entraIdService.js";
import { searchDirectoryAd } from "./activeDirectoryService.js";

/** A directory hit tagged with the backend that produced it. */
export interface DirectorySearchEntry extends DirectoryHit {
  source: "entra" | "ad";
}

/** Shortest query worth sending upstream — a 1-char term against a 50k-user
 *  tenant is a lot of work for a list nobody can use. */
export const MIN_DIRECTORY_QUERY = 2;

const PER_SOURCE_CAP = 25;

// Keystroke-driven and proxied to an external API, so identical prefixes
// (backspace, retype, two operators searching the same team) must not each hit
// the directory. Short enough that a newly-created mailbox appears promptly.
const CACHE_TTL_MS = 60_000;
const _cache = createTtlCache<DirectorySearchEntry[]>({ ttlMs: CACHE_TTL_MS, maxEntries: 200 });

/** Drop the cached directory results (integration config change). */
export function bumpDirectoryCache(): void {
  _cache.invalidate();
}

interface DirectoryIntegration {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
}

async function enabledDirectoryIntegrations(): Promise<DirectoryIntegration[]> {
  const rows = await prisma.integration.findMany({
    where: { enabled: true, type: { in: ["entraid", "activedirectory"] } },
    select: { id: true, name: true, type: true, config: true },
  });
  return rows
    .map((r) => ({ ...r, config: (r.config ?? {}) as Record<string, unknown> }))
    .filter((r) => r.config.enableDirectorySearch === true);
}

/** True when at least one integration has directory search switched on — lets
 *  a caller skip the whole path (and the UI hide the affordance). */
export async function directorySearchAvailable(): Promise<boolean> {
  return (await enabledDirectoryIntegrations()).length > 0;
}

/**
 * Search every opted-in directory. Failures DEGRADE: one integration erroring
 * (a revoked grant, an unreachable DC) yields the others' results rather than a
 * 500, because a half-populated typeahead is far more useful than an error
 * toast on every keystroke.
 */
export async function searchDirectory(query: string, limit = 25): Promise<DirectorySearchEntry[]> {
  const q = String(query ?? "").trim();
  if (q.length < MIN_DIRECTORY_QUERY) return [];

  const integrations = await enabledDirectoryIntegrations();
  if (integrations.length === 0) return [];

  return _cache.getOrCompute(q.toLowerCase() + "|" + limit, async () => {
    const settled = await Promise.allSettled(
      integrations.map(async (i): Promise<DirectorySearchEntry[]> => {
        if (i.type === "entraid") {
          const hits = await searchDirectoryEntra(i.config as never, q, PER_SOURCE_CAP);
          return hits.map((h) => ({ ...h, source: "entra" as const }));
        }
        const hits = await searchDirectoryAd(i.config as never, q, PER_SOURCE_CAP);
        return hits.map((h) => ({ ...h, source: "ad" as const }));
      }),
    );

    const out: DirectorySearchEntry[] = [];
    settled.forEach((r, idx) => {
      if (r.status === "fulfilled") {
        out.push(...r.value);
      } else {
        // Log WITHOUT the query string — see the PII note in the header.
        logger.warn(
          { err: r.reason, integrationId: integrations[idx].id, integrationType: integrations[idx].type },
          "Directory search failed for one integration; returning the others' results",
        );
      }
    });

    // Dedupe by address — a hybrid-joined person is in both AD and Entra.
    const seen = new Set<string>();
    return out
      .filter((e) => {
        const key = e.email.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
  });
}
