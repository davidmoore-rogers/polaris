## cross-cutting/verbose-debug-mode

**What it is:** A per-integration `config.verboseLogging` boolean that, when true, surfaces step-by-step discovery + sync + monitor-worker logs to pino at info level (tagged `verbose: true`) so an operator can `journalctl -u polaris -f` and watch one integration's behavior in real time. Off by default; toggled per integration from the edit modal.

**The four touchpoints** (changing any one requires keeping the others consistent):

1. **Integration config schemas** ([src/api/routes/integrations.ts](src/api/routes/integrations.ts)) — every integration type's Zod schema (`FortiManagerConfigSchema`, `FortiGateConfigSchema`, `WindowsServerConfigSchema`, `EntraIdConfigSchema`, `ActiveDirectoryConfigSchema`) carries `verboseLogging: z.boolean().optional().default(false)`. New integration types added in the future must follow the same pattern.

2. **Discovery `onProgress` consumer** ([src/services/discovery/discoveryEngine.ts](src/services/discovery/discoveryEngine.ts) `onProgress` closure inside `runDiscovery`) — reads `integration.config.verboseLogging` once at discovery start. When true, every callback emits `logger.info({ verbose: true, integrationId, integrationName, step, level, device }, message)` in addition to the existing `logEvent()`.

3. **Sync phase markers** ([src/services/discovery/discoveryEngine.ts](src/services/discovery/discoveryEngine.ts) `syncDhcpSubnets` — `phaseMark(name)` helper) — when verbose is on, each `phaseMark()` call logs the elapsed time of the previous phase + starts the new phase's timer. A final `phaseMark("__end__")` closes the last phase right before the function returns.

4. **Worker handlers** ([src/services/queueService.ts](src/services/queueService.ts) `runDedicatedWorker` and `dispatchFloatingJob`) — read `job.data.verboseDebug` (stamped by the publisher in `monitorAssets.publishDueWork` when `discoveredByIntegration.config.verboseLogging === true`). When true, emit `monitor.worker.pickup` on entry + `monitor.worker.finish` on exit, with slot id, jobId, cadence, assetId, outcome, elapsedMs.

**Worker slot id scheme:** [src/utils/workerSlotPool.ts](src/utils/workerSlotPool.ts) hands out `<prefix>-W01..NN` for dedicated cadence pools (probe / fast / telemetry / sysinfo) and `floating-F01..NN` for the floating pool. Slot acquired on handler entry, released on exit so the same slot is reused across jobs — operators can trace one slot's lifecycle through journalctl. Slot bookkeeping runs every tick regardless of verbose mode; only the *logging* of slot ids is gated on the flag.

**Structured log payload contract:** every verbose line emits these fields — `verbose: true`, `integrationId` + `integrationName` (when scoped to an integration), `step` or `phase` (for discovery/sync), `workerSlot` + `jobId` + `cadence` (for workers), `assetId`, `elapsedMs` (when measured), `outcome` (for worker.finish: `"success" | "failure"`). The contract is what makes `journalctl -o json | jq 'select(.verbose==true)'` filtering work reliably; do not strip these fields when adding a new verbose log call.

**When changing this:**
- Adding a new integration type → add `verboseLogging` to its config schema, its frontend form helper, its `getXxxFormConfig` reader, and a Debug section to its General tab. See the 5 existing pairs for the template.
- Adding a new discovery step → it inherits verbose logging for free via the existing `onProgress` route. No code change required if the step uses the standard callback.
- Adding a new pg-boss queue → add a slot pool entry in `startPgbossWorkers` and use `runDedicatedWorker` (or pattern-match `dispatchFloatingJob`) so pickup/finish lines land for free.
- Adding a new sync phase → insert one `phaseMark("X")` call right under the `// Phase X — ...` comment. The previous phase's elapsed time is logged at the next phaseMark call; the final phase is closed by the `phaseMark("__end__")` at the bottom of `syncDhcpSubnets`. **Also decide the phase's `"finalize-scoped"` behavior** (single-FortiGate re-discovery): a sweep/apply phase in the `mode !== "skip-deprecation"` block must be added to the `sweepPhaseEnabled` matrix (and its unit test `tests/unit/syncSweepPhaseGate.test.ts`) — default it to OFF for scoped runs unless it is provably per-controller-safe like Phase 2b; a roster-based sweep run scoped would see a one-device fleet and mass-deprecate/decommission.

---
