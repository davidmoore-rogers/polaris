/**
 * Asset monitor-override semantics.
 *
 * `Asset.monitorOverride` is an EXPLICIT operator-intent bit: it records
 * that an operator deliberately set this asset's `monitored` state to
 * something other than its discovering integration's per-class
 * `addAsMonitored` default. Discovery sweeps `monitored` to match the flag
 * on every cycle EXCEPT when the override is set — the override is what
 * protects an explicit operator choice from being clobbered.
 *
 * The value is the (monitored XOR addAsMonitored) divergence, but it is
 * only ever WRITTEN at the moment of an operator action — the asset-write
 * paths (`PUT /assets/:id`, `POST /assets/bulk-monitor`, the status-pill
 * toggle) call `recomputeMonitorOverrideForAssets` for the touched ids, and
 * the Reset-to-integration-default action clears it. Nothing re-derives it
 * from incidental state: discovery, the create path, the decommission clamp,
 * and HA-standby seeding all leave it alone. This is the critical fix over
 * the original convergent model — a divergence that arose for an INCIDENTAL
 * reason (a decommission forcing `monitored=false`, an asset created while
 * the flag was off, a standby member) must NOT masquerade as an operator
 * override, or discovery would refuse to ever auto-manage it again. Because
 * incidental divergence leaves the bit false, those cases self-heal: the
 * next discovery sweep retakes the asset to the flag's value.
 *
 * Integration-flag flips (`addAsMonitored` ON↔OFF) sweep only
 * override-false assets and respect pins — see `sweepMonitoredForIntegration`
 * + the integration-save handler, which deliberately does NOT recompute
 * overrides.
 *
 * Replaces the legacy `monitoredOperatorSet` one-way sticky flag, and the
 * subsequent convergent model whose every-boot/every-save re-derivation
 * stamped incidental divergence as override.
 */
export type AddAsMonitoredAssetType =
  | "firewall"
  | "switch"
  | "access_point"
  | "workstation"
  | "server";

const FORTINET_TYPES = new Set(["fortimanager", "fortigate"]);
const WORKSTATION_SERVER_TYPES = new Set([
  "activedirectory",
  "entraid",
  "windowsserver",
]);

/**
 * Per-class addAsMonitored is read from the integration's config blob at
 * a stable JSON path. Each path corresponds to one Asset.assetType:
 *
 *   firewall      → fortigateMonitor.addAsMonitored      (fortimanager/fortigate)
 *   switch        → fortiswitchMonitor.addAsMonitored    (fortimanager/fortigate)
 *   access_point  → fortiapMonitor.addAsMonitored        (fortimanager/fortigate)
 *   workstation   → workstationMonitor.addAsMonitored    (activedirectory/entraid/windowsserver)
 *   server        → serverMonitor.addAsMonitored         (activedirectory/entraid/windowsserver)
 *
 * Returns null when:
 *  - the asset type doesn't map to a per-class block
 *  - the integration type doesn't carry that block
 *  - the integration is null (manually-created asset)
 *
 * Null means "override doesn't apply to this asset"; callers should leave
 * monitorOverride at its existing value (typically false).
 */
export function getAddAsMonitoredFromConfig(
  integrationType: string | null | undefined,
  integrationConfig: Record<string, unknown> | null | undefined,
  assetType: string | null | undefined,
): boolean | null {
  if (!integrationType || !integrationConfig || !assetType) return null;

  let blockKey: string | null = null;
  switch (assetType) {
    case "firewall":
      if (!FORTINET_TYPES.has(integrationType)) return null;
      blockKey = "fortigateMonitor";
      break;
    case "switch":
      if (!FORTINET_TYPES.has(integrationType)) return null;
      blockKey = "fortiswitchMonitor";
      break;
    case "access_point":
      if (!FORTINET_TYPES.has(integrationType)) return null;
      blockKey = "fortiapMonitor";
      break;
    case "workstation":
      if (!WORKSTATION_SERVER_TYPES.has(integrationType)) return null;
      blockKey = "workstationMonitor";
      break;
    case "server":
      if (!WORKSTATION_SERVER_TYPES.has(integrationType)) return null;
      blockKey = "serverMonitor";
      break;
    default:
      return null;
  }

  const block = (integrationConfig as Record<string, unknown>)[blockKey];
  if (!block || typeof block !== "object") return false;
  const flag = (block as Record<string, unknown>).addAsMonitored;
  return flag === true;
}

/**
 * Pure compute: does the operator's `monitored` choice diverge from the
 * integration's `addAsMonitored`? Pass `null` for `addAsMonitored` when
 * the asset has no per-class block (returns false — no override possible).
 */
export function computeMonitorOverride(
  monitored: boolean,
  addAsMonitored: boolean | null,
): boolean {
  if (addAsMonitored === null) return false;
  return monitored !== addAsMonitored;
}

/**
 * Convenience helper used by operator write paths (PUT /assets/:id,
 * POST /assets/bulk-monitor, status pill toggle) — pulls the asset's
 * type + integration config and returns the override value to stamp.
 *
 * Pass `{integrationConfig, integrationType}` already resolved (cheap if
 * the caller has them; otherwise the caller should load Integration and
 * pass the fields).
 */
export function resolveMonitorOverride(input: {
  monitored: boolean;
  assetType: string | null;
  integrationType: string | null;
  integrationConfig: Record<string, unknown> | null;
}): boolean {
  const flag = getAddAsMonitoredFromConfig(
    input.integrationType,
    input.integrationConfig,
    input.assetType,
  );
  return computeMonitorOverride(input.monitored, flag);
}

/**
 * The set of asset types that participate in the auto-monitor-asset sweep.
 * Anything outside this set leaves monitorOverride at its existing value
 * and is invisible to the per-class addAsMonitored flag.
 */
export const AUTO_MONITOR_ASSET_TYPES: ReadonlySet<AddAsMonitoredAssetType> =
  new Set(["firewall", "switch", "access_point", "workstation", "server"]);

/** Maps Asset.assetType to its per-class config block key, when one applies. */
export function classBlockKeyForAssetType(
  assetType: string | null | undefined,
): string | null {
  switch (assetType) {
    case "firewall":     return "fortigateMonitor";
    case "switch":       return "fortiswitchMonitor";
    case "access_point": return "fortiapMonitor";
    case "workstation":  return "workstationMonitor";
    case "server":       return "serverMonitor";
    default:             return null;
  }
}

/**
 * Snapshot helper for the integration-save sweep + preflight endpoint.
 * Given an integration's config, returns the per-class addAsMonitored
 * flag for each of the five participating asset types (null when the
 * integration's type doesn't carry that block).
 */
export function snapshotAddAsMonitoredByAssetType(
  integrationType: string | null,
  integrationConfig: Record<string, unknown> | null,
): Record<AddAsMonitoredAssetType, boolean | null> {
  return {
    firewall:     getAddAsMonitoredFromConfig(integrationType, integrationConfig, "firewall"),
    switch:       getAddAsMonitoredFromConfig(integrationType, integrationConfig, "switch"),
    access_point: getAddAsMonitoredFromConfig(integrationType, integrationConfig, "access_point"),
    workstation:  getAddAsMonitoredFromConfig(integrationType, integrationConfig, "workstation"),
    server:       getAddAsMonitoredFromConfig(integrationType, integrationConfig, "server"),
  };
}

/**
 * Recompute `Asset.monitorOverride` for one or more asset ids via a single
 * SQL UPDATE — the operator-write-path post-hook. Reads each asset's
 * current `monitored` and `assetType` and the matching integration's
 * per-class `addAsMonitored` from `Integration.config`, sets override =
 * (monitored XOR addAsMonitored). Used by `PUT /assets/:id`,
 * `POST /assets/bulk-monitor`, and the status-pill toggle so the override
 * flag stays current after every operator action without per-row JS.
 *
 * Assets with no `discoveredByIntegrationId`, or whose assetType doesn't
 * map to a per-class block, are excluded by the WHERE clause and keep
 * their default (false). Same JSON-path logic as the cutover migration —
 * keep these two in sync.
 */
export async function recomputeMonitorOverrideForAssets(
  prismaClient: { $executeRaw: (template: TemplateStringsArray, ...args: unknown[]) => Promise<number> },
  assetIds: string[],
): Promise<void> {
  if (assetIds.length === 0) return;
  // Tagged-template raw SQL: Prisma parameterizes the assetIds array safely.
  await prismaClient.$executeRaw`
    UPDATE "assets" a
    SET "monitorOverride" = (
      a."monitored" IS DISTINCT FROM COALESCE(
        CASE a."assetType"
          WHEN 'firewall'     THEN (i."config" #>> '{fortigateMonitor,addAsMonitored}')::boolean
          WHEN 'switch'       THEN (i."config" #>> '{fortiswitchMonitor,addAsMonitored}')::boolean
          WHEN 'access_point' THEN (i."config" #>> '{fortiapMonitor,addAsMonitored}')::boolean
          WHEN 'workstation'  THEN (i."config" #>> '{workstationMonitor,addAsMonitored}')::boolean
          WHEN 'server'       THEN (i."config" #>> '{serverMonitor,addAsMonitored}')::boolean
          ELSE NULL
        END,
        false
      )
    )
    FROM "integrations" i
    WHERE a."discoveredByIntegrationId" = i."id"
      AND a."id" = ANY(${assetIds}::text[])
      AND a."assetType" IN ('firewall', 'switch', 'access_point', 'workstation', 'server')
  `;
}

/**
 * Integration-save sweep — runs when an operator saves an integration whose
 * per-class `addAsMonitored` flag changed. Walks every Asset whose
 * `discoveredByIntegrationId` points at this integration AND whose
 * `monitorOverride=false`, and writes `monitored = <new addAsMonitored>` per
 * the asset's class. Override-true assets are left alone — operator pins win,
 * and a flag flip never re-derives or clears them (operators re-align a
 * pinned asset per-asset via the Reset-to-integration-default action).
 *
 * Returns the count of rows whose `monitored` value actually changed (used
 * by the route handler to emit an Event with the touched-asset count).
 */
export async function sweepMonitoredForIntegration(
  prismaClient: { $executeRaw: (template: TemplateStringsArray, ...args: unknown[]) => Promise<number> },
  integrationId: string,
): Promise<number> {
  return await prismaClient.$executeRaw`
    UPDATE "assets" a
    SET "monitored" = COALESCE(
      CASE a."assetType"
        WHEN 'firewall'     THEN (i."config" #>> '{fortigateMonitor,addAsMonitored}')::boolean
        WHEN 'switch'       THEN (i."config" #>> '{fortiswitchMonitor,addAsMonitored}')::boolean
        WHEN 'access_point' THEN (i."config" #>> '{fortiapMonitor,addAsMonitored}')::boolean
        WHEN 'workstation'  THEN (i."config" #>> '{workstationMonitor,addAsMonitored}')::boolean
        WHEN 'server'       THEN (i."config" #>> '{serverMonitor,addAsMonitored}')::boolean
      END,
      false
    )
    FROM "integrations" i
    WHERE a."discoveredByIntegrationId" = i."id"
      AND i."id" = ${integrationId}::text
      AND a."monitorOverride" = false
      AND a."assetType" IN ('firewall', 'switch', 'access_point', 'workstation', 'server')
      AND a."monitored" IS DISTINCT FROM COALESCE(
        CASE a."assetType"
          WHEN 'firewall'     THEN (i."config" #>> '{fortigateMonitor,addAsMonitored}')::boolean
          WHEN 'switch'       THEN (i."config" #>> '{fortiswitchMonitor,addAsMonitored}')::boolean
          WHEN 'access_point' THEN (i."config" #>> '{fortiapMonitor,addAsMonitored}')::boolean
          WHEN 'workstation'  THEN (i."config" #>> '{workstationMonitor,addAsMonitored}')::boolean
          WHEN 'server'       THEN (i."config" #>> '{serverMonitor,addAsMonitored}')::boolean
        END,
        false
      )
  `;
}

/**
/**
 * Discovery-side sweep helper. Given the integration's resolved per-class
 * `addAsMonitored` and the existing asset's `monitored` + `monitorOverride`,
 * returns the partial update data to merge into the asset write — either
 * `{ monitored: true }`, `{ monitored: false }`, or `{}` (no change).
 *
 *  - `addAsMonitored === null` → asset type isn't subject to the sweep; no-op
 *  - `existing.monitorOverride === true` → operator wins; no-op
 *  - otherwise enforce `monitored = addAsMonitored`
 *
 * Caller is responsible for excluding ineligible assets (e.g. HA standby
 * FortiGate members, which buildFortigateMonitorStamp filters separately).
 */
export function buildMonitoredSweep(
  addAsMonitored: boolean | null,
  existing: { monitored?: boolean | null; monitorOverride?: boolean | null },
): { monitored?: boolean } {
  if (addAsMonitored === null) return {};
  if (existing.monitorOverride === true) return {};
  if (addAsMonitored && existing.monitored !== true) return { monitored: true };
  if (!addAsMonitored && existing.monitored === true) return { monitored: false };
  return {};
}
