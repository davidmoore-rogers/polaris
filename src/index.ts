/**
 * src/index.ts — Application entry point
 */

import path from "node:path";
import express from "express";
import session from "express-session";
import { router } from "./api/router.js";
import { errorHandler } from "./api/middleware/errorHandler.js";
import { logger } from "./utils/logger.js";
import { initHttps, httpsRedirectMiddleware } from "./httpsManager.js";
import { getHttpsSettings } from "./services/serverSettingsService.js";
import "./jobs/pruneEvents.js";

const app = express();
app.use(express.json());

// Session middleware (MemoryStore is fine for single-process / internal use)
app.use(
  session({
    secret: process.env.SESSION_SECRET || "shelob-dev-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

// HTTP → HTTPS redirect (enabled dynamically via server settings)
app.use(httpsRedirectMiddleware);

// Protect dashboard pages — redirect unauthenticated users to login
const protectedPages = ["/", "/index.html", "/blocks.html", "/subnets.html", "/reservations.html", "/users.html", "/integrations.html", "/assets.html", "/events.html", "/server-settings.html"];
const adminOnlyPages = ["/users.html", "/integrations.html", "/server-settings.html"];
app.use((req, res, next) => {
  if (!protectedPages.includes(req.path)) return next();
  if (!req.session?.userId) return res.redirect("/login.html");
  if (adminOnlyPages.includes(req.path) && req.session.role !== "admin") {
    return res.redirect("/");
  }
  return next();
});

app.use(express.static(path.resolve(import.meta.dirname, "..", "public")));

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api/v1", router);
app.use(errorHandler);

(async () => {
  const httpsSettings = await getHttpsSettings().catch(() => null);
  const PORT = process.env.PORT ?? httpsSettings?.httpPort ?? 3000;
  app.listen(PORT, () => {
    logger.info({ port: PORT }, "Shelob server listening");
    initHttps(app);
  });
})();

export { app };
