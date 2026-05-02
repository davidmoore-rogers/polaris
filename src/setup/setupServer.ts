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

  // Serve static assets (CSS, images, setup.html itself when requested by name).
  // index:false disables the default index.html resolution so `GET /` falls
  // through to the catch-all below and serves setup.html instead of the
  // dashboard's index.html.
  app.use(express.static(publicDir, { index: false }));

  // Setup API routes
  app.use("/api/setup", setupRoutes);

  // All non-API, non-asset requests redirect to setup.html
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "Not found" });
    }
    // Let static middleware handle known files; fall through to setup.html
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
