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
import serverSettingsRouter from "./routes/serverSettings.js";
import { requireAuth, requireAdmin, requireNetworkAdmin } from "./middleware/auth.js";

export const router = Router();

// Auth routes are public (login, logout, session check)
router.use("/auth", authRouter);

// Branding is public so the login page can display custom name/logo
router.get("/server-settings/branding", async (_req, res, next) => {
  try {
    const { getBranding } = await import("./routes/serverSettings.js");
    res.json(await getBranding());
  } catch (err) { next(err); }
});

// Everything below requires an active session
router.use(requireAuth);
router.use("/blocks", blocksRouter);
router.use("/subnets", subnetsRouter);
router.use("/reservations", reservationsRouter);
router.use("/utilization", utilizationRouter);
router.use("/users", requireAdmin, usersRouter);
router.use("/integrations", requireNetworkAdmin, integrationsRouter);
router.use("/assets", assetsRouter);
router.use("/events", eventsRouter);
router.use("/server-settings", requireAdmin, serverSettingsRouter);
