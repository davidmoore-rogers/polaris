/**
 * src/services/apRadioService.ts — FortiAP radio + broadcast-SSID inventory.
 *
 * The two levels ABOVE a wireless station: which radios an AP has (channel,
 * width, power, PHY) and which SSIDs each one broadcasts. Together with
 * AssetWirelessStation they render the Stations tab as a radio → SSID →
 * station tree, and AssetApVap is the inventory behind the "Broadcast SSID"
 * device-filter condition field.
 *
 * TWO SOURCES, one row per radio. The controller's
 * /api/v2/monitor/wifi/managed_ap `radio[]` array (source "fortios") reaches
 * every managed AP — including the many with SNMP disabled, which is why it
 * is the primary — and carries the SSIDs, the BSSIDs and a power PERCENTAGE.
 * The AP's own FORTINET-FORTIAP-MIB fapRadioTable (source "snmp") carries the
 * power in dBm plus the floor and ceiling the controller never publishes.
 *
 * So the write MERGES per column rather than replacing the row: a null from a
 * source that does not collect a column never erases what the other source
 * established. The cost of that choice, stated plainly: a column cannot be
 * cleared back to null by a scrape — a stored tx-power floor survives until
 * some source reports a different one. That is the right trade for inventory
 * two sources describe from different angles, and the wrong one for a
 * reading, which is why nothing fluctuating (channel utilization, noise
 * floor) is stored here at all.
 *
 * Radio IDENTITY is not merged. Both sources enumerate every radio, so a
 * radioIndex absent from a scrape is a radio that is genuinely gone and its
 * row (and its VAPs) are deleted. VAPs follow the codebase's usual
 * undefined-vs-empty contract one level down: a radio whose sample carries no
 * `vaps` field was not asked about its SSIDs and keeps the ones it has, while
 * an empty array means it was asked and is broadcasting nothing.
 */

import { prisma } from "../db.js";
import type { ApRadioSample } from "../utils/fortiapMonitorRow.js";

export type ApInventorySource = "fortios" | "snmp";

/** One SSID as the API returns it. */
export interface ApVapView {
  vapName: string;
  ssid: string | null;
  bssid: string | null;
  vlanId: number | null;
  clientCount: number | null;
  source: string;
  lastSeen: Date;
}

/** One radio with the SSIDs it broadcasts — the shape the API returns. */
export interface ApRadioWithVaps {
  radioIndex: number;
  radioType: string | null;
  band: string | null;
  mode: string | null;
  channel: number | null;
  bandwidthMhz: number | null;
  txPowerPct: number | null;
  txPowerDbm: number | null;
  txPowerMinDbm: number | null;
  txPowerMaxDbm: number | null;
  txPowerMode: string | null;
  baseBssid: string | null;
  clientCount: number | null;
  countryCode: string | null;
  source: string;
  lastSeen: Date;
  vaps: ApVapView[];
}

/** The mergeable (nullable) columns of a radio row. */
const RADIO_MERGE_FIELDS = [
  "radioType", "band", "mode", "channel", "bandwidthMhz",
  "txPowerPct", "txPowerDbm", "txPowerMinDbm", "txPowerMaxDbm", "txPowerMode",
  "baseBssid", "clientCount", "countryCode",
] as const;

/** The mergeable (nullable) columns of a VAP row. */
const VAP_MERGE_FIELDS = ["ssid", "bssid", "vlanId", "clientCount"] as const;

/**
 * Merge an incoming sample over a stored row: any non-null incoming value
 * wins, a null leaves the stored value in place. Returns only the columns
 * that actually change, so a steady-state scrape issues an UPDATE carrying
 * nothing but `lastSeen`.
 */
function mergeFields(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown> | undefined,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = incoming[f];
    if (v === null || v === undefined) continue;
    if (stored && stored[f] === v) continue;
    out[f] = v;
  }
  return out;
}

/** Business key for a VAP within one asset. */
function vapKey(radioIndex: number, vapName: string): string {
  return `${radioIndex} ${vapName}`;
}

/**
 * Persist one AP's radio inventory. An `undefined` radio list is not a valid
 * input — callers skip the call entirely when the source said nothing, exactly
 * as the system-info persist layer does for LLDP and stations.
 */
export async function persistApRadioInventory(
  assetId: string,
  radios: ApRadioSample[],
  source: ApInventorySource,
  now: Date = new Date(),
): Promise<{ radios: number; vaps: number; removedRadios: number }> {
  const [storedRadios, storedVaps] = await Promise.all([
    prisma.assetApRadio.findMany({ where: { assetId } }),
    prisma.assetApVap.findMany({ where: { assetId } }),
  ]);
  const storedRadioByIndex = new Map(storedRadios.map((r) => [r.radioIndex, r]));
  const storedVapByKey = new Map(storedVaps.map((v) => [vapKey(v.radioIndex, v.vapName), v]));

  const seenRadios = new Set<number>();
  const seenVaps = new Set<string>();
  const writes: any[] = [];
  let vapCount = 0;

  for (const radio of radios) {
    seenRadios.add(radio.radioIndex);
    const stored = storedRadioByIndex.get(radio.radioIndex);
    const merged = mergeFields(radio as unknown as Record<string, unknown>, stored ?? undefined, RADIO_MERGE_FIELDS);
    if (stored) {
      writes.push(prisma.assetApRadio.update({
        where: { id: stored.id },
        data: { ...merged, source, lastSeen: now },
      }));
    } else {
      writes.push(prisma.assetApRadio.create({
        data: { assetId, radioIndex: radio.radioIndex, ...merged, source, firstSeen: now, lastSeen: now },
      }));
    }

    // A radio that reported no VAP list keeps the SSIDs it already has — the
    // source was not asked, which is not the same as "broadcasting nothing".
    if (radio.vaps === undefined) {
      for (const v of storedVaps) {
        if (v.radioIndex === radio.radioIndex) seenVaps.add(vapKey(v.radioIndex, v.vapName));
      }
      continue;
    }
    for (const vap of radio.vaps) {
      const key = vapKey(radio.radioIndex, vap.vapName);
      seenVaps.add(key);
      vapCount++;
      const storedVap = storedVapByKey.get(key);
      const mergedVap = mergeFields(vap as unknown as Record<string, unknown>, storedVap ?? undefined, VAP_MERGE_FIELDS);
      if (storedVap) {
        writes.push(prisma.assetApVap.update({
          where: { id: storedVap.id },
          data: { ...mergedVap, source, lastSeen: now },
        }));
      } else {
        writes.push(prisma.assetApVap.create({
          data: {
            assetId,
            radioIndex: radio.radioIndex,
            vapName: vap.vapName,
            ...mergedVap,
            source,
            firstSeen: now,
            lastSeen: now,
          },
        }));
      }
    }
  }

  // A radio the scrape did not mention is gone — and so are its SSIDs, which
  // hang off (assetId, radioIndex) with no FK of their own to cascade from.
  const removedRadioIds = storedRadios.filter((r) => !seenRadios.has(r.radioIndex)).map((r) => r.id);
  const removedVapIds = storedVaps
    .filter((v) => !seenVaps.has(vapKey(v.radioIndex, v.vapName)))
    .map((v) => v.id);
  if (removedRadioIds.length > 0) {
    writes.push(prisma.assetApRadio.deleteMany({ where: { id: { in: removedRadioIds } } }));
  }
  if (removedVapIds.length > 0) {
    writes.push(prisma.assetApVap.deleteMany({ where: { id: { in: removedVapIds } } }));
  }

  // One transaction per AP: a handful of statements (a FortiAP carries two or
  // three radios), and the tree must never be read half-replaced.
  if (writes.length > 0) await prisma.$transaction(writes);
  return { radios: radios.length, vaps: vapCount, removedRadios: removedRadioIds.length };
}

/**
 * One AP's radios with their SSIDs nested, ordered the way the tree renders:
 * radio index, then SSID. Returns [] for an asset with no radio inventory —
 * every non-AP asset, and any AP a discovery cycle has not reached yet.
 */
export async function getApRadioInventory(assetId: string): Promise<ApRadioWithVaps[]> {
  const [radios, vaps] = await Promise.all([
    prisma.assetApRadio.findMany({ where: { assetId }, orderBy: { radioIndex: "asc" } }),
    prisma.assetApVap.findMany({
      where: { assetId },
      orderBy: [{ radioIndex: "asc" }, { ssid: "asc" }, { vapName: "asc" }],
    }),
  ]);
  if (radios.length === 0) return [];
  const byRadio = new Map<number, ApVapView[]>();
  for (const v of vaps) {
    const list = byRadio.get(v.radioIndex) ?? [];
    list.push({
      vapName: v.vapName,
      ssid: v.ssid,
      bssid: v.bssid,
      vlanId: v.vlanId,
      clientCount: v.clientCount,
      source: v.source,
      lastSeen: v.lastSeen,
    });
    byRadio.set(v.radioIndex, list);
  }
  return radios.map((r) => ({
    radioIndex: r.radioIndex,
    radioType: r.radioType,
    band: r.band,
    mode: r.mode,
    channel: r.channel,
    bandwidthMhz: r.bandwidthMhz,
    txPowerPct: r.txPowerPct,
    txPowerDbm: r.txPowerDbm,
    txPowerMinDbm: r.txPowerMinDbm,
    txPowerMaxDbm: r.txPowerMaxDbm,
    txPowerMode: r.txPowerMode,
    baseBssid: r.baseBssid,
    clientCount: r.clientCount,
    countryCode: r.countryCode,
    source: r.source,
    lastSeen: r.lastSeen,
    vaps: byRadio.get(r.radioIndex) ?? [],
  }));
}
