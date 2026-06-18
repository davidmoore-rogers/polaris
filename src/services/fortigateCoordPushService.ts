/**
 * src/services/fortigateCoordPushService.ts
 *
 * Push geocoded coords back to the FortiGate/FortiManager once the SNMP
 * fallback path in syncDhcpSubnets Phase 11.5 has resolved a lat/lng for a
 * device whose CMDB `gui-device-*` was missing or malformed.
 *
 * Behavior per integration type:
 *   - `fortimanager`: writes BOTH targets natively against FMG:
 *       1. Per-device coordinate metadata variables (named by `latMetavar` /
 *          `lngMetavar`, defaulting to `Latitude` / `Longitude`) as
 *          `dynamic_mapping` entries on
 *          `/pm/config/adom/<adom>/obj/fmg/variable/<name>` — the Policy &
 *          Objects metadata-variable location modern FMG uses (NOT the legacy
 *          `dvmdb` device "meta fields", which returns -10/-3 on those installs)
 *       2. CMDB GUI coords `gui-device-latitude` / `gui-device-longitude` on
 *          `/pm/config/device/<n>/global/system/global` (drives FMG's map +
 *          the FortiGate's GUI map after an operator-initiated Install
 *          Device Configuration in FMG — Polaris does not trigger installs)
 *
 *   - `fortigate` (standalone): writes only CMDB GUI coords via FortiOS REST
 *     `PUT /api/v2/cmdb/system/global`. No FMG layer, no metavars.
 *
 * Best-effort: failures are logged + reflected in the returned status but
 * never throw. The geocoded coords have already landed on the Polaris Asset
 * row regardless of write-back success, so the operator's view in Polaris
 * is consistent even when the device-side write fails.
 *
 * Audit: callers (syncDhcpSubnets) emit `integration.coords.pushed` /
 * `integration.coords.push_failed` Events based on the returned status.
 */
import { logger } from "../utils/logger.js";
import {
  setFmgDeviceMetavarCoords,
  setFmgDeviceCmdbGuiCoords,
  type FortiManagerConfig,
} from "./fortimanagerService.js";
import { fgRequest, type FortiGateConfig } from "./fortigateService.js";

export type CoordPushResult =
  | { ok: true; targets: string[] }
  | { ok: false; targets: string[]; error: string };

export async function pushCoordsToFortigate(
  integration: { id: string; type: string; config: unknown },
  deviceName: string,
  latitude: number,
  longitude: number,
  // FMG metavar names to write. Default to the common convention; operators can
  // rename them per integration. Ignored by the standalone FortiGate path.
  latMetavar = "Latitude",
  lngMetavar = "Longitude",
): Promise<CoordPushResult> {
  const latStr = latitude.toFixed(6);
  const lngStr = longitude.toFixed(6);

  if (integration.type === "fortimanager") {
    const cfg = integration.config as FortiManagerConfig;
    const targets: string[] = [];
    let metavarErr: string | null = null;
    let cmdbErr: string | null = null;
    const latKey = latMetavar.trim() || "Latitude";
    const lngKey = lngMetavar.trim() || "Longitude";

    try {
      await setFmgDeviceMetavarCoords(
        cfg,
        deviceName,
        latitude,
        longitude,
        latKey,
        lngKey,
        integration.id,
      );
      targets.push("fmg_metavars");
    } catch (err: any) {
      metavarErr = err?.message || "metavar write failed";
      logger.warn(
        { integrationId: integration.id, deviceName, err: metavarErr },
        "coord_push.fmg_metavars_failed",
      );
    }

    try {
      await setFmgDeviceCmdbGuiCoords(cfg, deviceName, latitude, longitude, integration.id);
      targets.push("fmg_cmdb");
    } catch (err: any) {
      cmdbErr = err?.message || "CMDB write failed";
      logger.warn(
        { integrationId: integration.id, deviceName, err: cmdbErr },
        "coord_push.fmg_cmdb_failed",
      );
    }

    if (targets.length === 0) {
      return {
        ok: false,
        targets: [],
        error: `metavars: ${metavarErr ?? "unknown"}; cmdb: ${cmdbErr ?? "unknown"}`,
      };
    }
    // Partial success is still considered ok at the orchestrator level —
    // operators see the per-target outcome via the Event payload below.
    return { ok: true, targets };
  }

  if (integration.type === "fortigate") {
    const cfg = integration.config as FortiGateConfig;
    if (!cfg?.host || !cfg?.apiToken) {
      return {
        ok: false,
        targets: [],
        error: "Standalone FortiGate integration missing host or apiToken",
      };
    }
    try {
      await fgRequest(
        { ...cfg, vdom: cfg.vdom || "root" },
        "PUT",
        "/api/v2/cmdb/system/global",
        {
          query: { vdom: cfg.vdom || "root" },
          body: {
            "gui-device-latitude": latStr,
            "gui-device-longitude": lngStr,
          },
        },
      );
      return { ok: true, targets: ["fortigate_cmdb"] };
    } catch (err: any) {
      const msg = err?.message || "CMDB write failed";
      logger.warn(
        { integrationId: integration.id, deviceName, err: msg },
        "coord_push.fortigate_cmdb_failed",
      );
      return { ok: false, targets: [], error: msg };
    }
  }

  return {
    ok: false,
    targets: [],
    error: `Coord write-back is not supported for integration type "${integration.type}"`,
  };
}
