---
name: polaris-worktree-workflow
description: "Polaris session workflow: start every task in its own git worktree under .claude/worktrees/, create WORKLOCK before the first edit and DEVLOCK when a dev environment is running, finish by deleting WORKLOCK and committing; spin up or tear down a per-worktree podman dev stack; on 'merge' list the unlocked worktrees as a numbered menu and merge the chosen ones to main; on 'push' push main and clean up the merged worktrees. Load at the start of any coding task, whenever the user says worktree, lock, dev environment, dev stack, podman, merge, or push, and when a WORKLOCK/DEVLOCK question comes up."
---

# Session workflow — worktrees, locks, dev stacks, merge, push

## The five rules (also in CLAUDE.md, always in force)

1. **Never edit the main checkout.** Before the first edit of a task, create a worktree
   (`EnterWorktree` → `.claude/worktrees/<slug>` on branch `worktree-<slug>`) and write
   `WORKLOCK` at its root. A PreToolUse hook refuses Edit/Write inside the repo otherwise.
2. **Finishing = delete `WORKLOCK`, then commit everything in the worktree.** That
   end-of-work commit does not wait for approval (run `/polaris-docs-sync` first). Merging to
   main and pushing happen only when the user says "merge" / "push".
3. **A dev environment = `DEVLOCK` at the worktree root + one podman stack per worktree.**
4. **"merge"** → the merge protocol below (numbered menu of unlocked worktrees).
   **"push"** → the push protocol below (push main, clean up what was merged).
5. **Lock files are gitignored and never committed.** Content: one line, ISO timestamp +
   purpose. A lock older than the chat that made it is stale; the merge menu shows its age.

## Which file

| Step | Read |
|---|---|
| creating and preparing a worktree (own `npm install`, `prisma generate`, no junctions), committing safely beside other sessions | [references/worktree-setup.md](references/worktree-setup.md) |
| bringing up / tearing down the per-worktree podman stack (`podman machine start`, `-p polaris-<slug>`, port offsets, `.env`, seed) | [references/dev-environment.md](references/dev-environment.md) |
| the merge menu and merge steps, including the DEVLOCK variant | [references/merge-protocol.md](references/merge-protocol.md) |
| the push and clean-up steps | [references/push-protocol.md](references/push-protocol.md) |
| the enforcement hook and how it is registered | [scripts/require-worklock.mjs](scripts/require-worklock.mjs) |

## Start of a task (short form)

```
EnterWorktree name=<slug>                     # branch worktree-<slug>, cwd switches
printf '%s %s\n' "$(date -u +%FT%TZ)" "<purpose>" > WORKLOCK
cp <main-checkout>/.env .env                  # gitignored; only needed for prisma generate / tests
npm install --no-audit --no-fund              # own node_modules + generated Prisma client
```

## End of a task (short form)

```
/polaris-docs-sync                            # refresh the skill entries the change touched
npm run check:docs && npm run typecheck && npx vitest run tests/unit
rm WORKLOCK
git add -A && git commit                      # one logical change per commit; last one closes the work
```
Report the branch name and say the worktree is ready to merge. Do not merge or push.

## "merge" (short form; full steps in merge-protocol.md)

1. `git worktree list --porcelain`; for each non-main worktree check for `WORKLOCK` / `DEVLOCK`.
2. Print a **numbered list of the unlocked worktrees** (branch · commits ahead of main · last
   subject · dirty?) and, un-numbered, the locked ones with each lock's age.
3. The user picks numbers. For each pick, in order: commit anything pending in that worktree;
   from the main checkout `git merge --no-ff worktree-<slug>`; on conflict stop and report.
4. After the last merge: `npm run check:docs` + `npm run typecheck` on main. **Do not push.**
5. If the chat's own worktree holds a `DEVLOCK` and the user asks to merge it: tear the stack
   down (`podman compose -p polaris-<slug> down -v`), delete `DEVLOCK`, commit pending, then merge.

## "push" (short form; full steps in push-protocol.md)

1. Run `/polaris-deploy`'s pre-push audit; stage fixes as their own commit.
2. `git push origin main`.
3. For each worktree merged in this session (plus any `worktree-*` branch already fully merged,
   `git branch --merged main`): refuse if a lock file is present; check for directory junctions;
   `podman compose -p polaris-<slug> down -v` if a stack lingers; `git worktree remove <path>`;
   `git branch -d worktree-<slug>`. Report what was removed.

## Why it is shaped this way

Two or three chats work this repo at once. A worktree per chat keeps their indexes apart
(the shared-tree landing incidents of 2026-08 are in `worktree-setup.md`); the lock files let
a merge session tell "finished" from "someone is still typing" without asking; the numbered
menu keeps the merge decision human; and cleaning up on push, not on merge, leaves a merged
worktree inspectable until the code has actually left the machine.
