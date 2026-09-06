# Merge protocol

Triggered by the user saying "merge" (in any chat, about any worktree). Merging never pushes.

## 1. Inventory the worktrees

From the main checkout (`C:\Users\dmoore\VSCode\polaris`):

```
git worktree list --porcelain
```

For every entry except the main checkout, collect: path, branch, whether `WORKLOCK` or
`DEVLOCK` exists at the path (and each lock's first line + file mtime), `git -C <path> status
--porcelain` (dirty?), `git rev-list --count main..<branch>` (commits ahead), and
`git -C <path> log -1 --format=%s`.

## 2. Present the menu

Print a **numbered** list of the worktrees with **no** lock file:

```
Ready to merge:
  1. worktree-fix-arp-tab        3 ahead   clean   "fix(arp): …"
  2. worktree-perf-engine-n2-join 1 ahead  dirty   "perf(engine): …"
Locked (skipped):
  - worktree-skills-conversion   WORKLOCK  2h old   "2026-09-06T06:10Z skills-conversion: …"
  - worktree-mobile-charts       DEVLOCK   3d old   "… dev stack polaris-mobile-charts pg=5433 app=3100"
```

A lock that is days old on a worktree whose chat has ended is stale; say so. The user decides
whether to clear it (`rm <path>/WORKLOCK`) and re-run the menu. Never delete a lock on your own.

A worktree with zero commits ahead and a clean tree has nothing to merge — list it, but mark it
"nothing to merge" so the user can choose to have it cleaned up at push time instead.

## 3. Merge the chosen ones, in the order given

For each selected worktree:

1. If dirty: commit the pending changes **in that worktree** (`git -C <path> add -A && git -C
   <path> commit -m "wip: pending changes at merge time"`), so nothing is lost and the merge
   is of a real commit.
2. From the main checkout, on `main`: `git merge --no-ff worktree-<slug>` (a merge commit per
   worktree keeps each unit of work identifiable in history; use the branch's own subjects in
   the merge message body).
3. On conflict: **stop**. Do not resolve silently. Report the conflicting files and ask; the
   common conflict is the same skill reference file edited by two branches, which is resolved
   by keeping both entries.
4. Continue with the next selection only after the previous merge is clean.

## 4. Verify main

After the last merge: `npm run check:docs`, `npm run typecheck`, and the unit suite
(`npx vitest run tests/unit --no-file-parallelism`) on `main`. Report the results. Do not push;
the user says "push" separately, which runs `push-protocol.md`.

## The DEVLOCK variant (the chat's own worktree)

When the user has been working in a dev environment in THIS chat and says they are satisfied
and want to merge:

1. `podman compose -f compose.dev.yml -p polaris-<slug> down -v`
2. `rm DEVLOCK` (and `WORKLOCK` if still present)
3. commit anything pending in the worktree
4. merge it to main as in step 3 above, verify as in step 4.

Then offer the numbered menu for any OTHER unlocked worktrees before finishing.
