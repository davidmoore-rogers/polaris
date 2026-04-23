/**
 * src/index.ts — Application entry point
 *
 * Checks if the app needs first-run setup (no DATABASE_URL configured).
 * If so, starts a lightweight setup wizard server.
 * Otherwise, starts the full application.
 */

import { getSetupState, markSetupComplete } from "./setup/detectSetup.js";

(async () => {
  const state = getSetupState();

  if (state === "locked") {
    console.error("");
    console.error("  ERROR: DATABASE_URL is missing but this host has already");
    console.error("  been configured (.setup-complete marker is present).");
    console.error("");
    console.error("  Restore .env or pass DATABASE_URL via the environment.");
    console.error("  To re-run first-run setup, delete .setup-complete — but");
    console.error("  only do that if you intend to reconfigure from scratch.");
    console.error("");
    process.exit(1);
  }

  if (state === "needs-setup") {
    const { startSetupServer } = await import("./setup/setupServer.js");
    startSetupServer();
    return;
  }

  // Back-fill the marker on already-configured installs.
  markSetupComplete();
  const { startApp } = await import("./app.js");
  startApp();
})();
