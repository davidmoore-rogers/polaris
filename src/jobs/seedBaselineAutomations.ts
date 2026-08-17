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
 * SEED-ONCE, NOT self-heal: each seed SET is guarded by its own marker key in
 * Setting (`seedBaselineAutomationsSeededAt` for the original widget-mirror
 * set; `seedBaselineAutomationsV2SeededAt` for the event-based set). Once a
 * marker is stamped, that set is never touched again — so a rule the operator
 * edits or DELETES stays edited/deleted. Later sets ship behind NEW marker
 * keys (per the _runOnce contract: a shipped marker key never changes), which
 * is how existing installs pick up new baseline rules without duplicating the
 * ones they already have. (Contrast seedAssetTypes, which re-heals protected
 * built-ins every boot.) Every rule is fully editable + deletable; none are
 * protected.
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
 * The V2 EVENT SET gives operators an automation per notable system-generated
 * event family (discovery failures, push failures, agent drop-offs, capacity
 * escalations, conflicts, lockouts…) so the alert text, delivery, and
 * escalation for those events are operator-controllable from the Automations
 * page. All are event triggers with timed reset + a cooldown — the engine's
 * event-tail cooldown + timed-clear passes keep them storm-proof.
 *
 * To force a re-seed of a set (e.g. to restore a deleted baseline rule), run:
 *   DELETE FROM "settings" WHERE key = 'seedBaselineAutomationsSeededAt';   -- widget set
 *   DELETE FROM "settings" WHERE key = 'seedBaselineAutomationsV2SeededAt'; -- event set
 * then restart. (This resurrects that ENTIRE set, including rules you deleted.)
 */

import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";
import { ruleInputSchema } from "../services/notificationTypes.js";
import { createRule } from "../services/notificationRuleService.js";

const MARKER_KEY = "seedBaselineAutomationsSeededAt";
const MARKER_KEY_V2 = "seedBaselineAutomationsV2SeededAt";
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
  // Packet loss climbs a severity ladder rather than firing one flat alert: loss
  // is a spectrum, so 12% and 45% on the same switch are different problems and
  // an operator wants them paged differently. Tiers share the 15-minute history
  // window (rule 19 — sampling is per trigger, only threshold/severity vary);
  // "truly down" is deliberately NOT the top rung, because it's a different
  // measurement — consecutive total failures, minutes faster than any window can
  // be — and the Asset down rule above owns it (business rule 29).
  {
    name: "High packet loss",
    description:
      "Fires at three levels over the last 15 minutes of probe history: warning above 10% loss, serious above 20%, critical above 30%, clearing below 5%. Only devices that are currently answering are measured, counting from their first successful probe in the window — a full outage alerts as Asset down instead, so one outage never raises two alerts. Mirrors the Packet Loss widget — works for any monitored asset. Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "asset_metric", metric: "probeLossPct", windowSec: 900, operator: ">", threshold: 10 },
    severityBands: [
      { threshold: 20, severity: "serious" },
      { threshold: 30, severity: "critical" },
    ],
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

// ── V2: event-based automations over the system-generated Event families ──
// One automation per notable event family Polaris already writes, so operators
// control (and customize) the alerting for those events from the Automations
// page. Every actionPattern below is verified against a real logEvent call
// site (tests/unit/seedBaselineAutomations.test.ts pins each glob to fixture
// action strings). {value} is the event's own message on the event path, so
// the default templates surface the source event's text verbatim.
const EVENT_BASELINE_RULES: Record<string, unknown>[] = [
  {
    name: "Integration discovery failed",
    description:
      "Fires when an integration's discovery run fails (integration.discover.error). One alert per integration per hour; auto-clears after 4 hours. Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "event", actionPattern: "integration.discover.error" },
    reset: { mode: "timed", afterSec: 14400 },
    cooldownSec: 3600,
    messageTemplate: "{value}",
  },
  {
    name: "Integration discovery aborted",
    description:
      "Fires when a discovery run is aborted — by an operator or the auto-abort watchdog (integration.discover.aborted / .auto_aborted). Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "event", actionPattern: "integration.discover.*aborted" },
    reset: { mode: "timed", afterSec: 14400 },
    cooldownSec: 3600,
    messageTemplate: "{value}",
  },
  {
    name: "Quarantine push failed",
    description:
      "Fires when pushing (or releasing) an asset quarantine to its FortiGates fails (asset.quarantine.failed / .unpush.failed). Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "event", actionPattern: "asset.quarantine.*failed" },
    reset: { mode: "timed", afterSec: 14400 },
    cooldownSec: 1800,
    messageTemplate: "{value}",
  },
  {
    name: "Reservation push failed",
    description:
      "Fires when pushing a DHCP reservation to a FortiGate fails and the push is queued for retry (reservation.push.failed). Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "event", actionPattern: "reservation.push.failed" },
    reset: { mode: "timed", afterSec: 14400 },
    cooldownSec: 1800,
    messageTemplate: "{value}",
  },
  {
    name: "Reservation push permanently failed",
    description:
      "Fires when a queued reservation push exhausts its retries (reservation.push.queued.failed_permanent) — operator action needed. Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "event", actionPattern: "reservation.push.queued.failed_permanent" },
    reset: { mode: "timed", afterSec: 86400 },
    cooldownSec: 1800,
    messageTemplate: "{value}",
  },
  {
    name: "Agent disconnected",
    description:
      "Fires when a Polaris Agent's WebSocket drops (agent.disconnected). Brief reconnects are absorbed by the 30-minute cooldown. Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "event", actionPattern: "agent.disconnected" },
    reset: { mode: "timed", afterSec: 14400 },
    cooldownSec: 1800,
    messageTemplate: "{value}",
  },
  {
    name: "Agent upgrade failed",
    description:
      "Fires when a Polaris Agent upgrade fails (agent.upgrade_failed). Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "event", actionPattern: "agent.upgrade_failed" },
    reset: { mode: "timed", afterSec: 86400 },
    cooldownSec: 3600,
    messageTemplate: "{value}",
  },
  {
    name: "Capacity severity escalated",
    description:
      "Fires when the Polaris host's capacity severity worsens (capacity.severity_changed with direction=escalated — recoveries never alert). Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "event", actionPattern: "capacity.severity_changed", detailsMatch: { direction: "escalated" } },
    reset: { mode: "timed", afterSec: 86400 },
    cooldownSec: 600,
    messageTemplate: "{value}",
  },
  {
    name: "IP conflict detected",
    description:
      "Fires when discovery raises an ip-override conflict — a discovered IP disagreeing with an operator IP pin (conflict.detected; other conflict flavors surface on the Conflicts page without an Event today). Baseline example — edit or delete freely.",
    severity: "notice",
    trigger: { type: "event", actionPattern: "conflict.detected" },
    reset: { mode: "timed", afterSec: 86400 },
    cooldownSec: 3600,
    messageTemplate: "{value}",
  },
  {
    name: "Asset auto-decommissioned",
    description:
      "Fires when the stale-asset sweep decommissions a device that hasn't been seen past the cutoff (asset.auto_decommissioned). Baseline example — edit or delete freely.",
    severity: "notice",
    trigger: { type: "event", actionPattern: "asset.auto_decommissioned" },
    reset: { mode: "timed", afterSec: 86400 },
    cooldownSec: 600,
    messageTemplate: "{value}",
  },
  {
    name: "HA standby down",
    description:
      "Fires when an HA cluster's standby member stops answering while the primary is still up (asset.ha.standby_down) — redundancy is degraded. Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "event", actionPattern: "asset.ha.standby_down" },
    reset: { mode: "timed", afterSec: 14400 },
    cooldownSec: 3600,
    messageTemplate: "{value}",
  },
  {
    name: "Login lockout engaged",
    description:
      "Fires when repeated failed logins trip the lockout (auth.login.lockout). Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "event", actionPattern: "auth.login.lockout" },
    reset: { mode: "timed", afterSec: 86400 },
    cooldownSec: 900,
    messageTemplate: "{value}",
  },
];

async function seedRuleSet(markerKey: string, ruleBodies: Record<string, unknown>[]): Promise<{ created: number; skipped: boolean }> {
  if (await hasRunMarker(markerKey)) {
    return { created: 0, skipped: true };
  }

  let created = 0;
  for (const raw of ruleBodies) {
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
  await stampRunMarker(markerKey, { created });
  return { created, skipped: false };
}

export async function seedBaselineAutomations(): Promise<{ created: number; skipped: boolean }> {
  // Independent markers: a pre-V2 install has the first marker stamped and
  // still picks up the event set; a fresh install seeds both.
  const v1 = await seedRuleSet(MARKER_KEY, BASELINE_RULES);
  const v2 = await seedRuleSet(MARKER_KEY_V2, EVENT_BASELINE_RULES);
  return { created: v1.created + v2.created, skipped: v1.skipped && v2.skipped };
}

/** Exported for the seed unit test (glob-vs-fixture pinning). */
export { BASELINE_RULES, EVENT_BASELINE_RULES };

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
