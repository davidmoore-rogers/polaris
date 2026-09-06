# Runbook: FortiManager RPC `-11` "no valid session" churn

**Symptom:** FortiManager-backed discovery and monitoring intermittently fail with RPC code `-11` ("no valid session" / "invalid or expired API token"). Errors cluster on a roughly hourly cadence and hit both the discovery and monitor processes at once.

---

## Background — cause

Polaris authenticates to FortiManager with a **predefined REST API Admin api-key** (Bearer `Authorization` header). Per Fortinet's *FortiManager API Best Practices Guide*, that key is permanent and **all callers share one FMG session per user** — the login/logout endpoints exist only for session-based (username/password) auth.

The historical incident: a job called `/sys/logout` on an hourly cadence (commit `3e70476`). Because the api-key session is shared, that logout tore the session out from under the split-role `polaris-monitor@N` and `polaris-discovery` processes still mid-flight against the same FMG — every in-flight and subsequent RPC came back `-11` until the next call happened to re-establish a session, producing recurring hourly churn.

The fix already in place: **Polaris never calls `/sys/logout`.** The hourly logout job was removed. The transport layer also distinguishes transient from permanent faults so a real `-11` fails fast instead of being retried into a storm.

---

## How the current transport behaves

`src/services/fortimanagerService.ts -> rpcInner()` wraps `rpcAttempt()` with a bounded retry:

- **Transient faults** (HTTP 5xx, network timeout/reset) — retried, max 3 attempts total (1 + 2 retries), backoff 500ms then 1500ms. Marked via `markRetryable()`.
- **Permanent faults** (HTTP 401 / 403 / 404 / 405, and the FMG RPC `-11` surfaced by callers) — thrown immediately, never retried.

Retries run **inside** the caller's `FmgWorker` lane slot (`src/services/fmgWorker.ts -> FmgWorker.submitProxy()` / `submitNative()`), so the proxy lane stays serialized at concurrency 1 and a struggling FMG isn't piled on. The proxy lane (`/sys/proxy/json` passthrough to FortiGates) is single-consumer FIFO; native FMG endpoints (`/pm/config`, `/dvmdb`, auth) run on the unbounded native lane.

The `-11` surfaces to operators as `FortiManager: invalid or expired API token` from `src/services/fortimanagerService.ts -> fmgProxyRest()`.

---

## Diagnose

### 1. Confirm the error and its cadence

```bash
# Split-role layout — check both consumer processes
sudo journalctl -u polaris-discovery -u 'polaris-monitor@*' --since '6 hours ago' --no-pager \
  | grep -Ei 'fmg|fortimanager|no valid session|-11|invalid or expired API token'
```

A roughly hourly burst hitting both processes simultaneously is the signature of a session being torn down out from under shared callers. A one-off `-11` (e.g. right after a key rotation) is just a stale credential, not churn.

### 2. Confirm Polaris is not the one calling logout

This should return nothing in current code — verify no custom job, fork, or local patch reintroduced it:

```bash
grep -rn "sys/logout" src/
```

Expected: only the explanatory comments in `src/services/fortimanagerService.ts` (the "No /sys/logout" note). Any actual `exec` of `/sys/logout` is the regression — remove it.

### 3. Check the api-key / API user validity

`-11` with no logout in the codebase means the credential itself is invalid or expired, or the API user lost its admin profile:

- On the FortiManager: confirm the REST API Admin user still exists, the api-key matches what Polaris stores, and the admin profile grants the needed RPC scopes. (FMG 7.4.7+ / 7.6.2+ removed `access_token` query-string support — Polaris correctly uses the Bearer header only, so don't "fix" this by adding a query token.)
- In Polaris: Integrations → the FMG integration → re-test connectivity. A 401/403 from `rpcAttempt()` points at the credential/profile; a clean test that later churns points at session interference.

### 4. Rule out a competing API consumer

Anything else authenticating as the **same FMG API user** (a script, another tool, a second Polaris install) can perform a logout that tears down the shared session. Give Polaris its own dedicated API user.

---

## Recover

1. If a regression reintroduced `/sys/logout`, remove that call and redeploy (in-app update on prod). Churn stops once no caller logs out the shared session.
2. If the api-key is stale/expired: generate a fresh REST API Admin api-key on the FortiManager, update it in the Polaris integration config, and re-test. The next RPC re-establishes the session with the new key.
3. If a competing consumer shares the API user: move it to its own FMG API user, or move Polaris to a dedicated one.
4. Transient `-11`/5xx bursts during an FMG reboot or failover are self-correcting — the bounded retry + the next successful call re-establish the session. No action needed beyond confirming it clears.

---

## Prevent

- **Never call `/sys/logout`** (or `/sys/login`) from Polaris code — the api-key session is permanent and shared. This is a hard rule; treat any PR that adds a logout call as a regression.
- Keep `-11` / 401 / 403 / 404 / 405 on the **fail-fast** path (`rpcInner`). Retrying a permanent auth fault just amplifies churn.
- Give Polaris a **dedicated** FMG REST API Admin user so no other tool can disturb its shared session.
- Apply the same rules to the standalone FortiGate integration (`src/services/fortigateService.ts`) — it uses the identical Bearer pattern.

---

## Related

- `polling-methods-streams.md` → "FortiManager authentication" (the FMG auth note) (never call `/sys/logout`; commit `3e70476`; the `rpcInner` transient-vs-permanent retry policy).
- `CLAUDE.md` → Key Coding Conventions → "FortiManager ↔ standalone FortiGate parity".
- `polaris-change-impact` → `services/discovery-fortinet.md` (`fortimanagerService.ts` and `fmgWorker.ts` entries).
- Code: `src/services/fortimanagerService.ts` (`rpcInner()`, `rpcAttempt()`, `fmgProxyRest()`), `src/services/fmgWorker.ts`, `src/services/fortigateService.ts`.
