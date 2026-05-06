/**
 * tests/setup.ts — Vitest global setup
 *
 * Loads .env so the integration tests pick up DATABASE_URL the same way
 * `npm run dev` does (via Node's --env-file flag in package.json scripts).
 * Pure no-op when .env doesn't exist; tests gated on DATABASE_URL skip
 * themselves below.
 */

import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  loadDotenv({ path: envPath, quiet: true });
}
