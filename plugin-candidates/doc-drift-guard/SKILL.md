---
name: doc-drift-guard
description: "A structural doc-drift guard for a repository whose project memory lives in CLAUDE.md plus .claude/skills: a node script run as a pre-commit hook and CI job that fails when a schema model, service, job, route or util is named in no doc, when a doc cites a dead path or a line number, when a reference file is oversized or orphaned, or when a skill's frontmatter is malformed. Load when setting up or extending documentation checks, adding a check for a new doc convention, or deciding what a commit-time doc review should enforce mechanically versus by reading."
---

# Doc-drift guard

Documentation indexes only stay trustworthy if every commit refreshes them. Two halves keep
that honest: a **mechanical** guard (this) that fails the commit on what a script can check,
and a **human/agent review** (a docs-sync skill) for what it cannot — whether the prose is
still true.

## What the guard checks (all pure file reads — no DB, no install)

| Check | Rule |
|---|---|
| docs-present | the always-loaded file and every expected `.claude/skills/<name>/SKILL.md` exist |
| no-line-numbers | no `file.ext:NNN` and no prose "(line N)" citations — cite `path → symbol()`; line numbers drift on every edit |
| models-documented | every `model X {` in the schema is named in some doc (rollup companions may be summarized as a group) |
| files-documented | every service / job / route / util source file is named in some doc (skip `_`-prefixed helpers and `.d.ts`) |
| paths-exist | every concrete repo path a doc names exists on disk (templated `<x>` / `*` paths skipped) |
| retired-doc | no pointers to retired doc names, except a provenance phrase ("verbatim from …") and an allow-listed history note |
| per-service coverage | every service source file has a `## services/<name>.ts` entry in the relationship index (mention-only → warn) |
| skill-frontmatter | `name:` equals the directory, `description:` present and non-trivial, only known keys |
| reference-size | reference files ≤ 1500 lines (fail), ≈ 100 KB warns — a "1500-line" cap alone does not bound context when lines average 1 KB |
| orphan-reference | every `references/**` and `scripts/*` file is linked from its skill's `SKILL.md` |
| always-loaded size | the always-loaded file stays small (warn 15 KB, fail 25 KB) |
| util-tests (warn) | a util with runtime exports has a matching unit test file |

## Wiring

- `scripts/check-docs.mjs`, `"check:docs": "node scripts/check-docs.mjs"`.
- `.githooks/pre-commit` (version-controlled) runs it only when code or docs changed; activate
  with `git config core.hooksPath .githooks` from `postinstall` so every clone gets it.
- A CI job on push/PR runs the same command with nothing but a Node setup step.
- `git commit --no-verify` is the documented one-commit bypass; say so in the hand-off.

## Design notes that mattered

- **Loose vs strict coverage.** "Named anywhere" is easy to satisfy and hides gaps; "has a
  heading of its own" is the real bar. Fail on the loose test, warn on the strict one, so
  tightening does not block unrelated commits but the gap is visible every run.
- **Fence-aware parsing.** Headings inside code blocks (shell comments `# …`) must not count.
- **Provenance vs pointer.** After retiring a doc, its name still appears legitimately in
  "verbatim from X" headers; strip those phrases before counting dead pointers.
- **Working tree, not index.** The hook checks files on disk, so another session's untracked
  file in the same tree can fail your commit — that is the legitimate `--no-verify` case.
- **Line-ending traps.** CRLF checkouts and a single NUL byte make git treat a doc as binary;
  the guard reads with `utf8` and normalizes, and reviewers should check the diffstat per file.
- Keep the guard's own error messages prescriptive: name the file to edit, not just the rule.
