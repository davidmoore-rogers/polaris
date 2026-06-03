# Polaris Security Review Log

This is the running index of full security reviews. **Newest first.** Each row
records the date, the commit the review was performed against, the scope, and a
link to the full report.

## How to run the next review

1. Read the **top row** below — that commit SHA is your baseline.
2. Scope yourself to the delta since then:

   ```bash
   git log <baseline-sha>..HEAD --stat
   # security-relevant path filter:
   git log <baseline-sha>..HEAD -- src/ deploy/ agent/ prisma/ public/js/
   ```

3. Review the changed surface (plus anything the previous report listed as
   "tracked / accepted-risk" that may have shifted), write a new
   `review-YYYY-MM-DD.md`, and prepend a new row here.

A full from-scratch sweep is only needed if the previous report is stale or the
threat model changed materially (new auth method, new privileged path, new
externally-reachable endpoint).

| Date       | Commit    | Scope          | Findings (C/H/M/L) | Report                                       |
|------------|-----------|----------------|--------------------|----------------------------------------------|
| 2026-06-03 | `8e09f68` | whole codebase | 0 / 1 / 7 / 5      | [review-2026-06-03.md](review-2026-06-03.md) |

> **Note on the 2026-06-03 baseline:** this was the *first* systematic
> whole-codebase review. The prior security work was a point-fix hardening
> cluster on 2026-04-24 (`fa047c8`, `13b3bb9`) — CSRF middleware, CSP inline-script
> lockdown, HSTS, `/health` gating — not a full review. Treat `8e09f68` as the
> first true baseline.
