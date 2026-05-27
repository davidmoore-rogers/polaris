#!/usr/bin/env node
// Doc-drift guard for the project-memory files (CLAUDE.md, ARCHITECTURE.md,
// TOUCHES.md, TEMPLATES.md). Catches the *mechanically-checkable* drift that
// accumulated badly before the 2026-05 docs overhaul — it CANNOT judge whether
// prose is still accurate, only structural coverage + reference hygiene.
//
// Run:  npm run check:docs    (or: node scripts/check-docs.mjs)
// Wired as a pre-commit hook via .githooks/pre-commit and as a CI job.
// Bypass a single commit with:  git commit --no-verify
//
// Exit 0 = all checks pass; exit 1 = at least one failure (with a report).
//
// Checks:
//   1. No `file.ext:NNN` line-number references in TOUCHES.md / TEMPLATES.md
//      (line numbers drift on every edit; the convention is `file -> symbol`).
//   2. Every Prisma model in schema.prisma is named in ARCHITECTURE.md.
//   3. Every src/ service, job, route, util (and route/middleware) file is
//      named somewhere in ARCHITECTURE.md. (Skips `_`-prefixed helpers + .d.ts.)
//   4. Every concrete src/ or public/ file path referenced in the four docs
//      exists on disk. (Templated paths like `<type>Service.ts` are ignored.)
//   5. No lowercase `touches.md` / `primaries.md` references survive in the
//      four docs (the files are TOUCHES.md / TEMPLATES.md).

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const r = (p) => join(ROOT, p);
const read = (p) => readFileSync(r(p), "utf8");
const exists = (p) => existsSync(r(p));

const DOCS = ["CLAUDE.md", "ARCHITECTURE.md", "TOUCHES.md", "TEMPLATES.md"];
const failures = [];
const fail = (check, msg) => failures.push({ check, msg });

// --- load docs once (fail loudly if a doc is missing entirely) ---
const docText = {};
for (const d of DOCS) {
  if (!exists(d)) {
    fail("docs-present", `${d} is missing from the repo root.`);
    docText[d] = "";
  } else {
    docText[d] = read(d);
  }
}
const ARCH = docText["ARCHITECTURE.md"];

// --- helper: list *.ts basenames in a dir, skipping _helpers and .d.ts ---
function tsFiles(dir) {
  if (!exists(dir)) return [];
  return readdirSync(r(dir))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.startsWith("_"))
    .map((f) => f.replace(/\.ts$/, ""));
}

// === Check 1: no file:line refs in the index files ===
const LINE_REF = /\.(ts|js|tsx|jsx|mjs|prisma|sql|sh|ps1):\d+/g;
for (const d of ["TOUCHES.md", "TEMPLATES.md"]) {
  const hits = [...docText[d].matchAll(LINE_REF)].map((m) => m[0]);
  if (hits.length) {
    fail(
      "no-line-numbers",
      `${d} has ${hits.length} stale file:line reference(s) (e.g. ${[...new Set(hits)].slice(0, 5).join(", ")}). ` +
        `Use "path/file.ts -> symbolName()" instead — line numbers drift.`,
    );
  }
}

// === Check 2: every Prisma model is documented in ARCHITECTURE.md ===
if (exists("prisma/schema.prisma")) {
  const models = [...read("prisma/schema.prisma").matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
  const undocModels = models
    // *Hourly / *Daily rollup companions are intentionally summarized as a
    // group in ARCHITECTURE.md, not given 12 separate blocks. The base sample
    // model (e.g. AssetMonitorSample) is still required to be documented.
    .filter((name) => !/(Hourly|Daily)$/.test(name))
    .filter((name) => !new RegExp(`\\b${name}\\b`).test(ARCH));
  if (undocModels.length) {
    fail(
      "models-documented",
      `${undocModels.length} Prisma model(s) not named in ARCHITECTURE.md: ${undocModels.join(", ")}. ` +
        `Add a domain-model entry under "Core Entities".`,
    );
  }
}

// === Check 3: every significant src/ file is named in ARCHITECTURE.md ===
const codeDirs = [
  ["src/services", "service"],
  ["src/jobs", "job"],
  ["src/api/routes", "route"],
  ["src/utils", "util"],
];
const undocFiles = [];
for (const [dir, kind] of codeDirs) {
  for (const base of tsFiles(dir)) {
    if (!ARCH.includes(`${base}.ts`) && !ARCH.includes(base)) {
      undocFiles.push(`${kind}: ${dir}/${base}.ts`);
    }
  }
}
if (undocFiles.length) {
  fail(
    "files-documented",
    `${undocFiles.length} source file(s) not named in ARCHITECTURE.md:\n      ` +
      undocFiles.join("\n      ") +
      `\n    Add them to the file tree (and the jobs table / relevant section).`,
  );
}

// === Check 4: every concrete src/ or public/ path in the docs exists ===
// Templated paths (containing < > or *) are skipped — they're illustrative.
// Lookbehind `(?<![\w/.])` prevents matching a path-root keyword in the MIDDLE
// of a longer path (e.g. `./generated/prisma/client.js` must not yield the
// non-existent `prisma/client.js`).
const PATH_REF = /(?<![\w/.])(?:src|public|prisma|scripts|deploy)\/[A-Za-z0-9_./-]+\.(?:ts|js|tsx|jsx|mjs|prisma|sql|sh|ps1|html|css|json)\b/g;
const deadPaths = new Set();
for (const d of DOCS) {
  for (const m of docText[d].matchAll(PATH_REF)) {
    const p = m[0];
    if (p.includes("<") || p.includes(">") || p.includes("*")) continue;
    if (!exists(p)) deadPaths.add(`${p}  (referenced in ${d})`);
  }
}
if (deadPaths.size) {
  fail(
    "paths-exist",
    `${deadPaths.size} doc-referenced path(s) don't exist on disk:\n      ` + [...deadPaths].join("\n      "),
  );
}

// === Check 5: no lowercase touches.md / primaries.md in the docs ===
for (const d of DOCS) {
  const bad = [...docText[d].matchAll(/\b(touches|primaries)\.md\b/g)].map((m) => m[0]);
  if (bad.length) {
    fail(
      "index-casing",
      `${d} references the old lowercase name(s): ${[...new Set(bad)].join(", ")}. ` +
        `The files are TOUCHES.md / TEMPLATES.md.`,
    );
  }
}

// --- report ---
if (failures.length === 0) {
  console.log("✓ check-docs: all structural doc checks passed.");
  process.exit(0);
}

console.error(`\n✗ check-docs: ${failures.length} issue(s) found.\n`);
for (const { check, msg } of failures) {
  console.error(`  [${check}] ${msg}\n`);
}
console.error(
  "These are structural checks (coverage + reference hygiene) — they don't judge prose accuracy.\n" +
    "Fix the docs, or bypass this one commit with:  git commit --no-verify\n",
);
process.exit(1);
