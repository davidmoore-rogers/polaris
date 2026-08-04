/**
 * src/api/router.ts
 */

import { Router } from "express";
import authRouter from "./routes/auth.js";
import blocksRouter from "./routes/blocks.js";
import subnetsRouter from "./routes/subnets.js";
import reservationsRouter from "./routes/reservations.js";
import utilizationRouter from "./routes/utilization.js";
import usersRouter from "./routes/users.js";
import integrationsRouter from "./routes/integrations.js";
import assetsRouter from "./routes/assets.js";
import logFlagRulesRouter from "./routes/logFlagRules.js";
import eventsRouter from "./routes/events.js";
import notificationsRouter from "./routes/notifications.js";
import notificationRulesRouter from "./routes/notificationRules.js";
import automationScriptsRouter from "./routes/automationScripts.js";
import maintenanceSchedulesRouter from "./routes/maintenanceSchedules.js";
import notificationChannelsRouter from "./routes/notificationChannels.js";
import pushSubscriptionsRouter from "./routes/pushSubscriptions.js";
import conflictsRouter from "./routes/conflicts.js";
import serverSettingsRouter from "./routes/serverSettings.js";
import proxySettingsRouter from "./routes/proxySettings.js";
import mibsRouter from "./routes/mibs.js";
import manufacturerProfilesRouter from "./routes/manufacturerProfiles.js";
import deviceIconsRouter from "./routes/deviceIcons.js";
import searchRouter from "./routes/search.js";
import mapRouter from "./routes/map.js";
import applicationMapRouter from "./routes/applicationMap.js";
import weatherRouter from "./routes/weather.js";
import mapRegionsRouter from "./routes/mapRegions.js";
import allocationTemplatesRouter from "./routes/allocationTemplates.js";
import credentialsRouter from "./routes/credentials.js";
import manufacturerAliasesRouter from "./routes/manufacturerAliases.js";
import assetTypesRouter from "./routes/assetTypes.js";
import monitorSettingsRouter from "./routes/monitorSettings.js";
import apiTokensRouter from "./routes/apiTokens.js";
import dashboardRouter from "./routes/dashboard.js";
import userDashboardRouter from "./routes/userDashboard.js";
import { agentsEnrollRouter, agentsRouter, agentsBinaryRouter } from "./routes/agents.js";
import rolesRouter from "./routes/roles.js";
import groupMappingsRouter from "./routes/groupMappings.js";
import { requireAuth, attachApiToken } from "./middleware/auth.js";
import { requirePermission } from "./middleware/permissions.js";

export const router = Router();

// Resolve any presented bearer token before any auth gate runs. Sets
// req.apiToken when valid; never enforces on its own.
router.use(attachApiToken);

// Auth routes are public (login, logout, session check)
router.use("/auth", authRouter);

// Branding is public so the login page can display custom name/logo
router.get("/server-settings/branding", async (_req, res, next) => {
  try {
    const { getBranding } = await import("./routes/serverSettings.js");
    res.json(await getBranding());
  } catch (err) { next(err); }
});

// Polaris Agent — /enroll and /binary/:filename are public (no bearer
// yet; the body or path carries everything needed). The rest of
// /agents/* is gated by the requireAgentBearer middleware mounted
// inside agentsRouter itself. Mounted here BEFORE the blanket
// requireAuth so /enroll + /binary are reachable without a session.
// /binary mounts BEFORE /enroll because both must be parsed before the
// /agents catch-all; Express's first-match routing handles ordering.
router.use("/agents/binary", agentsBinaryRouter);
router.use("/agents/enroll", agentsEnrollRouter);
router.use("/agents", agentsRouter);

// Everything below requires an active session OR a valid bearer token.
// Both caller kinds pass the same requirePermission(...) gates: sessions
// resolve their login-stamped role snapshot, tokens resolve the Role they
// were bound to at mint time. A token reaches exactly what its role grants.
router.use(requireAuth);
router.use("/blocks", blocksRouter);
router.use("/subnets", subnetsRouter);
router.use("/allocation-templates", allocationTemplatesRouter);
router.use("/reservations", reservationsRouter);
// Utilization reports enumerate the IP space, so they carry the same read
// gate as the blocks they describe. Blanket-gated at the mount: bearer tokens
// (no role snapshot) and ipBlocks=none roles get a 403.
router.use("/utilization", requirePermission("ipBlocks", "read"), utilizationRouter);
// /dashboard/summary is deliberately NOT 403-gated — it's the redirect target
// for users bounced off gated pages. The handler filters sections by the
// caller's per-function read access instead (denied sections come back empty).
router.use("/dashboard", dashboardRouter);
router.use("/me/dashboard", userDashboardRouter);
router.use("/users", requirePermission("users", "read"), usersRouter);
router.use("/roles", rolesRouter);
router.use("/group-mappings", requirePermission("users", "fullwrite"), groupMappingsRouter);
router.use("/integrations", requirePermission("integrations", "read"), integrationsRouter);
// asset-types is mounted BEFORE /assets so Express's first-match routing
// picks the registry endpoint instead of treating "types" as an asset id.
// Reads gated by assets=read; writes by assets=write (admin + assetsadmin
// in the default role matrix). Custom-type CRUD lives here; the eight
// built-ins are seeded as isProtected=true and reject rename/delete.
router.use("/asset-types", assetTypesRouter);
router.use("/assets", assetsRouter);
router.use("/log-flag-rules", logFlagRulesRouter);
router.use("/events", eventsRouter);
// ─── Automations (canonical) + notification-era aliases ─────────────────
// The Automations redesign renamed the user-facing API surface. Canonical
// paths are /automations (rules), /alerts (triggered instances), and
// /delivery-channels (outbound channels); the pre-rename paths stay mounted
// on the SAME routers as deprecated aliases so existing API clients and
// already-delivered web-push payloads keep working. Alias mounts carry
// Deprecation/Link headers pointing at the successor path.
const deprecatedAlias = (successor: string) =>
  ((req, res, next) => {
    res.setHeader("Deprecation", "true");
    res.setHeader("Link", `<${successor}>; rel="successor-version"`);
    next();
  }) as import("express").RequestHandler;
// Script registry — MUST mount before /automations so "scripts" is never
// captured as a rule id. Gated automationScripts (RCE-equivalent key).
router.use("/automations/scripts", automationScriptsRouter);
// Rules CRUD/schema/preview.
router.use("/automations", notificationRulesRouter);
router.use("/notification-rules", deprecatedAlias("/api/v1/automations"), notificationRulesRouter);
// Maintenance schedules (Assets page → Maintenance modal); per-route gates
// on the maintenanceManagement function key.
router.use("/maintenance-schedules", maintenanceSchedulesRouter);
// Outbound delivery channels (Automations → Delivery tab).
router.use("/delivery-channels", notificationChannelsRouter);
router.use("/notification-channels", deprecatedAlias("/api/v1/delivery-channels"), notificationChannelsRouter);
// Triggered automation instances ("alerts": list + acknowledge/clear).
// /notification-rules stays mounted before /notifications (shadowing).
router.use("/alerts", notificationsRouter);
router.use("/notifications", deprecatedAlias("/api/v1/alerts"), notificationsRouter);
router.use("/push-subscriptions", pushSubscriptionsRouter);
router.use("/search", searchRouter);
// Region routes are mounted BEFORE /map so Express's first-match routing picks
// the more-specific path. Region CRUD is gated by the mapRegions function key;
// the rest of /map is read-only and open to any authenticated user with at
// least deviceMap=read.
router.use("/map/regions", requirePermission("mapRegions", "read"), mapRegionsRouter);
router.use("/map", mapRouter);
// Application Map: process-connectivity graph + shared layout. Per-route
// gates on the applicationMap function key (read = graph, write = layout).
router.use("/application-map", applicationMapRouter);
// Status Map weather proxy — public weather data (RainViewer radar tiles +
// Open-Meteo temps) cached server-side; any authenticated caller. The widget
// falls back to the CDNs directly when these fail.
router.use("/weather", weatherRouter);
router.use("/conflicts", conflictsRouter);
router.use("/credentials", credentialsRouter);
router.use("/manufacturer-aliases", requirePermission("manufacturerAliases", "read"), manufacturerAliasesRouter);
// monitor-settings: reads open to any auth caller (asset-modal tier badges
// need them); writes guarded per-route by requirePermission(assetMonitorSettings, write).
router.use("/monitor-settings", monitorSettingsRouter);
router.use("/api-tokens", requirePermission("apiTokens", "read"), apiTokensRouter);
// MIBs surface mounted BEFORE /server-settings so its per-route guards
// (mibDatabase read on browse/walk, mibDatabase write on upload/delete)
// take precedence over the blanket serverSettingsSystem gate on the rest
// of /server-settings. Express first-match routing handles the rest — any
// path under /server-settings that doesn't start with /server-settings/mibs
// falls through to the serverSettingsRouter below.
router.use("/server-settings/mibs", mibsRouter);
// Same precedent — per-route guards (manufacturerProfiles read on browse,
// write on edits). Mounted before the blanket so reads reach roles that
// have manufacturerProfiles=read but not serverSettingsSystem.
router.use("/server-settings/manufacturer-profiles", manufacturerProfilesRouter);
// nginx GUI surface mounted BEFORE /server-settings so the proxy-mode gate
// and explicit per-route serverSettingsSystem guards (read on GET, fullwrite
// on PUT/apply/rotate/adopt) apply. Apply + rotate are high-blast-radius —
// they can lock out the operator from the UI if mis-set — so fullwrite is
// the right floor regardless of the blanket gate's read level.
router.use("/server-settings/proxy", proxySettingsRouter);
// Blanket /server-settings gate: serverSettingsSystem read floor for the
// whole surface. Mutating routes inside additionally carry per-route
// requirePermission escalations (serverSettingsSystem fullwrite for the
// system cards, serverSettingsData read/fullwrite for backup download /
// backup-restore / queue-mode / security tokens / restart / updates) —
// so a Data-scoped role still needs serverSettingsSystem read to reach
// its routes through this mount.
router.use("/server-settings", requirePermission("serverSettingsSystem", "read"), serverSettingsRouter);
// device-icons applies its own per-route guards (deviceIcons write on CRUD;
// auth-only for image-serve since the asset details modal embeds icon URLs).
router.use("/device-icons", deviceIconsRouter);
