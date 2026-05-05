/**
 * tests/integration/monitorSettings.test.ts
 *
 * Integration coverage for the four-tier monitor-settings hierarchy. Tests
 * are placeholders matching the existing it.todo() convention used by
 * blocks.test.ts / subnets.test.ts / reservations.test.ts. Implement against
 * a running PostgreSQL pointed to by DATABASE_URL.
 */

import { describe, it } from "vitest";

// ─── Manual tier ───────────────────────────────────────────────────────────

describe("GET /api/v1/monitor-settings/manual", () => {
  it.todo("returns null when the manualMonitorSettings Setting row hasn't been seeded");
  it.todo("returns the saved settings when the row exists");
  it.todo("requires authentication");
});

describe("PUT /api/v1/monitor-settings/manual", () => {
  it.todo("requires assetsadmin (admin also passes)");
  it.todo("upserts the manualMonitorSettings Setting and returns the saved values");
  it.todo("invalidates the resolver cache for the manual tier");
  it.todo("rejects probeTimeoutMs below 100 or above 60000");
  it.todo("emits a monitor_settings.manual.updated audit Event");
});

// ─── Integration tier ──────────────────────────────────────────────────────

describe("GET /api/v1/monitor-settings/integration/:id", () => {
  it.todo("returns settings: null when the integration's config has no monitorSettings");
  it.todo("returns the integration's monitorSettings when present");
  it.todo("returns 404 for an unknown integration id");
});

describe("PUT /api/v1/monitor-settings/integration/:id", () => {
  it.todo("requires assetsadmin");
  it.todo("writes Integration.config.monitorSettings without clobbering other config keys");
  it.todo("invalidates the resolver cache for that integration");
  it.todo("emits a monitor_settings.integration.updated audit Event");
});

// ─── Class overrides ───────────────────────────────────────────────────────

describe("GET /api/v1/monitor-settings/class-overrides", () => {
  it.todo("lists every class override with the integration name + type joined in");
  it.todo("filters by integrationId (use 'null' string for the manual scope)");
  it.todo("filters by assetType");
});

describe("POST /api/v1/monitor-settings/class-overrides", () => {
  it.todo("requires assetsadmin");
  it.todo("creates an override with integrationId + assetType + nullable settings");
  it.todo("supports null integrationId for the manual-tier class scope");
  it.todo("returns 409 when an override already exists for the (integrationId, assetType) pair");
  it.todo("returns 400 when integrationId references a non-existent integration");
  it.todo("invalidates the resolver cache for the (integrationId, assetType) scope");
});

describe("PUT /api/v1/monitor-settings/class-overrides/:id", () => {
  it.todo("requires assetsadmin");
  it.todo("updates only the fields supplied; null clears a field");
  it.todo("invalidates the resolver cache for the row's existing scope");
});

describe("DELETE /api/v1/monitor-settings/class-overrides/:id", () => {
  it.todo("requires assetsadmin");
  it.todo("removes the row and invalidates the resolver cache");
  it.todo("returns 404 for an unknown id");
});

// ─── Reverse lookup ────────────────────────────────────────────────────────

describe("GET /api/v1/monitor-settings/asset-overrides", () => {
  it.todo("lists assets with at least one of monitorIntervalSec / telemetryIntervalSec / systemInfoIntervalSec / probeTimeoutMs set");
  it.todo("filters by integrationId (use 'null' for the manual scope)");
  it.todo("filters by assetType");
  it.todo("caps response at 500 rows");
});

// ─── Effective settings on the asset row ───────────────────────────────────

describe("GET /api/v1/assets/:id/effective-monitor-settings", () => {
  it.todo("returns resolved values + per-field provenance + tier3Source");
  it.todo("returns classOverrideId when a class override applies, null otherwise");
  it.todo("flips probeTimeoutMs provenance to 'asset' when probeTimeoutMs is set on the row");
  it.todo("returns 404 for an unknown asset id");
});

// ─── Sticky monitoredOperatorSet flag ──────────────────────────────────────

describe("PUT /api/v1/assets/:id with monitored field flips monitoredOperatorSet", () => {
  it.todo("sets monitoredOperatorSet=true on every PUT that includes monitored");
  it.todo("leaves monitoredOperatorSet alone when the PUT body omits monitored");
  it.todo("survives a subsequent FortiSwitch/FortiAP discovery cycle (monitored is not auto-flipped)");
});

// ─── Migration idempotency ─────────────────────────────────────────────────

describe("migrateMonitorSettingsHierarchy startup job", () => {
  it.todo("on first boot with a legacy monitorSettings row: seeds manualMonitorSettings + every integration's config.monitorSettings");
  it.todo("creates a MonitorClassOverride(switch, integration) row only when the legacy fortiswitch block diverged from top-level — and only with the differing fields");
  it.todo("creates a MonitorClassOverride(access_point, integration) row only when fortiap diverged");
  it.todo("deletes the legacy monitorSettings Setting row at the end");
  it.todo("stamps monitorSettingsHierarchyMigratedAt and refuses to re-run on subsequent boots");
  it.todo("on a fresh install (no legacy row): just stamps the marker, makes no other writes");
  it.todo("is safe to re-run after a partial failure (recovery path: delete the marker and restart)");
});
