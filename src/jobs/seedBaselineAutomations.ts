/**
 * src/jobs/seedBaselineAutomations.ts
 *
 * One-shot startup that seeds a set of BASELINE automations (NotificationRule
 * rows) mirroring the alertable dashboard widgets — down assets, high
 * CPU/memory/temperature/disk, slow response, packet loss, storage-fills-soon,
 * down interfaces / IPsec tunnels, and recent reboots. They exist so a fresh
 * install has sensible monitoring out of the box AND so operators have worked
 * examples of every trigger/reset shape to copy from.
 *
 * SEED-ONCE, NOT self-heal: guarded by a marker key in Setting
 * (`seedBaselineAutomationsSeededAt`). Once stamped, this job never touches the
 * data again — so a rule the operator edits or DELETES stays edited/deleted.
 * (Contrast seedAssetTypes, which re-heals protected built-ins every boot.)
 * Every rule is fully editable + deletable; none are protected.
 *
 * Rules are built as raw input bodies and run through `ruleInputSchema` +
 * `createRule` — the exact path the Automations API uses — so they carry the
 * canonical v2 shape (reset + actions + legacy mirror) and can never drift from
 * what the validator accepts. In-app delivery only (no NotificationChannel
 * required); numeric rules auto-clear with hysteresis at the widget's WARNING
 * level (e.g. CPU fires >90%, clears <75%).
 *
 * Thresholds are the values the dashboard widgets use for their red/yellow
 * coloring (public/js/widgets/*.js). They live only in the frontend today, so
 * these are a deliberate server-side baseline — operators are expected to tune
 * them per environment.
 *
 * To force a re-seed (e.g. to restore a deleted baseline rule), run:
 *   DELETE FROM "settings" WHERE key = 'seedBaselineAutomationsSeededAt';
 * then restart. (This resurrects ALL baseline rules, including any you deleted.)
 */

import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";
import { ruleInputSchema } from "../services/notificationTypes.js";
import { createRule } from "../services/notificationRuleService.js";

const MARKER_KEY = "seedBaselineAutomationsSeededAt";
const SEED_ACTOR = "system:seed-baseline-automations";

// Raw input bodies (what a POST to /automations looks like). ruleInputSchema
// fills every default (enabled, channels=["in_app"], aggregation, etc.) and
// normalizes reset/actions to the canonical v2 shape.
const BASELINE_RULES: Record<string, unknown>[] = [
  // ── State conditions (mirror the Down Nodes / Down Interfaces widgets) ──
  {
    name: "Asset down",
    description:
      "Fires when a monitored asset stops responding. Mirrors the dashboard's Down Nodes widget. Baseline example — edit or delete freely.",
    severity: "critical",
    trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
    scope: { allAssets: true },
    reset: { mode: "auto" },
    messageTemplate: "{asset} is down",
  },
  {
    name: "Monitored interface down",
    description:
      "Fires when a pinned interface is admin-up but operationally down. Mirrors the Down Interfaces widget. Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" },
    scope: { allAssets: true },
    reset: { mode: "auto" },
    messageTemplate: "{asset}: monitored interface {dimension} is down",
  },
  {
    name: "IPsec tunnel down",
    description:
      "Fires when a monitored IPsec tunnel drops. Mirrors the IPsec portion of the Down Interfaces widget. Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "asset_state", field: "ipsecStatus", operator: "==", value: "down" },
    scope: { allAssets: true },
    reset: { mode: "auto" },
    messageTemplate: "{asset}: IPsec tunnel {dimension} is down",
  },

  // ── Numeric thresholds (fire at CRITICAL, auto-clear at WARNING) ──
  {
    name: "High CPU utilization",
    description:
      "Fires when average CPU stays above 90% and clears below 75%. Mirrors the Highest Avg CPU widget. Baseline example — edit or delete freely.",
    severity: "critical",
    trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 75 },
    messageTemplate: "{asset} CPU at {value}% (fires above {threshold}%)",
  },
  {
    name: "High memory utilization",
    description:
      "Fires when average memory stays above 90% and clears below 75%. Mirrors the Highest Avg Memory widget. Baseline example — edit or delete freely.",
    severity: "critical",
    trigger: { type: "asset_metric", metric: "memPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 75 },
    messageTemplate: "{asset} memory at {value}% (fires above {threshold}%)",
  },
  {
    name: "High device temperature",
    description:
      "Fires when a hardware temperature sensor stays above 80°C and clears below 65°C. Mirrors the Highest Temperature widget. Baseline example — edit or delete freely.",
    severity: "critical",
    trigger: {
      type: "asset_metric",
      metric: "hwSensorValue",
      aggregation: "avg",
      windowSec: 300,
      operator: ">",
      threshold: 80,
      dimensionFilter: { sensorClass: "temperature" },
    },
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 65 },
    messageTemplate: "{asset} temperature at {value}°C (fires above {threshold}°C)",
  },
  {
    name: "High disk usage",
    description:
      "Fires when a filesystem is above 90% used and clears below 75%. Mirrors the Highest Disk Usage widget. Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "asset_metric", metric: "storageUsedPct", aggregation: "latest", operator: ">", threshold: 90 },
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 75 },
    messageTemplate: "{asset} disk at {value}% used (fires above {threshold}%)",
  },
  {
    name: "Slow response time",
    description:
      "Fires when average probe response time stays above 500ms and clears below 200ms. Mirrors the Slowest Response widget. Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "asset_metric", metric: "responseTimeMs", aggregation: "avg", windowSec: 300, operator: ">", threshold: 500 },
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 200 },
    messageTemplate: "{asset} response time at {value}ms (fires above {threshold}ms)",
  },
  {
    name: "High packet loss",
    description:
      "Fires when an asset's probe packet loss (failed probes / total probes over 15 min) exceeds 25% and clears below 5%. Mirrors the Packet Loss widget — works for any monitored asset. Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "asset_metric", metric: "probeLossPct", windowSec: 900, operator: ">", threshold: 25 },
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 5 },
    messageTemplate: "{asset} packet loss at {value}% (fires above {threshold}%)",
  },
  {
    name: "Storage filling soon",
    description:
      "Fires when a filesystem is projected to fill within 7 days and clears when the projection recovers past 30 days. Mirrors the Storage Forecast widget. Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "asset_metric", metric: "storageDaysUntilFull", aggregation: "latest", operator: "<", threshold: 7 },
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 30 },
    messageTemplate: "{asset} storage projected to fill in {value} days",
  },

  // ── Event condition (mirrors the Recent Reboots widget) ──
  {
    name: "Device recently rebooted",
    description:
      "Fires when a monitored device's uptime resets (a reboot). Mirrors the Recent Reboots widget. Example of an event-based automation — edit or delete freely.",
    severity: "notice",
    trigger: { type: "event", actionPattern: "device.reboot" },
    scope: { allAssets: true },
    reset: { mode: "manual" },
  },
];

export async function seedBaselineAutomations(): Promise<{ created: number; skipped: boolean }> {
  if (await hasRunMarker(MARKER_KEY)) {
    return { created: 0, skipped: true };
  }

  let created = 0;
  for (const raw of BASELINE_RULES) {
    try {
      const input = ruleInputSchema.parse(raw);
      await createRule(input, SEED_ACTOR);
      created += 1;
    } catch (err) {
      // A single malformed/edge rule must never abort the rest of the seed.
      logger.warn({ err, rule: (raw as { name?: string }).name }, "Failed to seed baseline automation");
    }
  }

  // Stamp regardless of per-rule failures: this is seed-ONCE. Re-running would
  // re-create rules the operator may have deliberately deleted. A partial seed
  // is recoverable via the documented DELETE-the-marker escape hatch.
  await stampRunMarker(MARKER_KEY, { created });
  return { created, skipped: false };
}

(async () => {
  try {
    await runInstrumentedJob("seedBaselineAutomations", async () => {
      const result = await seedBaselineAutomations();
      if (!result.skipped) {
        logger.info(result, "Seeded baseline automations");
      }
    });
  } catch (err) {
    logger.error({ err }, "seedBaselineAutomations startup task failed");
  }
})();
