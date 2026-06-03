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
import eventsRouter from "./routes/events.js";
import conflictsRouter from "./routes/conflicts.js";
import serverSettingsRouter from "./routes/serverSettings.js";
import proxySettingsRouter from "./routes/proxySettings.js";
import mibsRouter from "./routes/mibs.js";
import manufacturerProfilesRouter from "./routes/manufacturerProfiles.js";
import deviceIconsRouter from "./routes/deviceIcons.js";
import searchRouter from "./routes/search.js";
import mapRouter from "./routes/map.js";
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
// Token callers reach further role gates only when a route opts in via
// requireSessionOrTokenPermission; the standard requirePermission(...)
// middleware 403s token callers because they have no role snapshot.
router.use(requireAuth);
router.use("/blocks", blocksRouter);
router.use("/subnets", subnetsRouter);
router.use("/allocation-templates", allocationTemplatesRouter);
router.use("/reservations", reservationsRouter);
router.use("/utilization", utilizationRouter);
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
router.use("/events", eventsRouter);
router.use("/search", searchRouter);
// Region routes are mounted BEFORE /map so Express's first-match routing picks
// the more-specific path. Region CRUD is gated by the mapRegions function key;
// the rest of /map is read-only and open to any authenticated user with at
// least deviceMap=read.
router.use("/map/regions", requirePermission("mapRegions", "read"), mapRegionsRouter);
router.use("/map", mapRouter);
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
// Blanket /server-settings gate: requires at least serverSettingsSystem
// OR serverSettingsData read (today the OR is implicit — every route
// inside currently uses serverSettingsSystem; a future per-route split
// can break this into two gates without changing the mount).
router.use("/server-settings", requirePermission("serverSettingsSystem", "read"), serverSettingsRouter);
// device-icons applies its own per-route guards (deviceIcons write on CRUD;
// auth-only for image-serve since the asset details modal embeds icon URLs).
router.use("/device-icons", deviceIconsRouter);
