#!/usr/bin/env node
/**
 * scripts/check-fmg-tokens.ts
 *
 * Prints the stored apiToken length and first-few characters for every
 * FortiManager/FortiGate integration. Used to diagnose "token expired again"
 * scenarios — if length is 8 and the prefix is a mask character, the token
 * was corrupted by a save path. If length/prefix looks like a real token,
 * the rotation is happening on the FMG side.
 *
 * Run from the project root:
 *   node --env-file=.env --import tsx/esm scripts/check-fmg-tokens.ts
 */

import { prisma } from "../src/db.js";

try {
  const rows = await prisma.integration.findMany({
    where: { type: { in: ["fortimanager", "fortigate"] } },
    select: { name: true, type: true, config: true, lastTestOk: true, lastTestAt: true },
  });

  if (rows.length === 0) {
    console.log("No FortiManager or FortiGate integrations found.");
    process.exit(0);
  }

  console.log("");
  for (const r of rows) {
    const token = (r.config && typeof r.config === "object" && "apiToken" in r.config)
      ? String((r.config as Record<string, unknown>).apiToken ?? "")
      : "";
    const len = token.length;
    const prefix = token.slice(0, 8);
    const looksMasked = /^[•*●]+$/.test(token);
    const looksEmpty = len === 0;
    const verdict = looksEmpty
      ? "EMPTY — token missing, integration won't work"
      : looksMasked
        ? "MASK — token was corrupted by a save path (this is the bug)"
        : `OK — ${len} chars, starts "${prefix}…"`;

    console.log(`[${r.type}] ${r.name}`);
    console.log(`  token:     ${verdict}`);
    console.log(`  lastTest:  ${r.lastTestOk === null ? "never" : (r.lastTestOk ? "OK" : "FAIL")} ${r.lastTestAt ? "at " + r.lastTestAt.toISOString() : ""}`);
    console.log("");
  }
} finally {
  await prisma.$disconnect();
}
