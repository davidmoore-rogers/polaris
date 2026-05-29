/**
 * src/setup/setupServer.ts — Minimal Express server for first-run setup
 *
 * This runs instead of the normal app when DATABASE_URL is not configured.
 * It serves setup.html and the setup API endpoints only.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import setupRoutes from "./setupRoutes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startSetupServer(): void {
  const app = express();
  app.use(express.json());

  const publicDir = path.resolve(__dirname, "..", "..", "public");

  // Setup API routes
  app.use("/api/setup", setupRoutes);

  // Pre-static guard: redirect any HTML page request (login.html, index.html,
  // assets.html, etc.) to setup.html so operators can't accidentally land on
  // a half-functional app screen while DATABASE_URL is unset. Asset requests
  // (CSS/JS/images/fonts) fall through to express.static below so setup.html
  // itself can render. setup.html serves directly.
  app.get(/\.html$/, (req, res, next) => {
    if (req.path === "/setup.html") return next();
    return res.redirect(302, "/setup.html");
  });

  // Serve static assets (CSS, JS, images, fonts, setup.html). index:false
  // disables the default index.html resolution so GET / falls through to
  // the catch-all below and serves setup.html instead of the dashboard's
  // index.html.
  app.use(express.static(publicDir, { index: false }));

  // All non-API, non-asset requests fall through to setup.html
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "Not found" });
    }
    res.sendFile(path.join(publicDir, "setup.html"));
  });

  const PORT = 3000;
  app.listen(PORT, () => {
    console.log("");
    console.log("  ┌─────────────────────────────────────────────┐");
    console.log("  │                                             │");
    console.log("  │   Polaris — First-Run Setup                 │");
    console.log("  │                                             │");
    console.log(`  │   Open \x1b[36mhttp://localhost:${PORT}/setup.html\x1b[0m    │`);
    console.log("  │   to configure the application.             │");
    console.log("  │                                             │");
    console.log("  └─────────────────────────────────────────────┘");
    console.log("");
  });
}
