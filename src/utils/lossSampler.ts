/**
 * src/utils/lossSampler.ts
 *
 * The ICMP **packet-loss sampler**: a second, cheap probe that runs ONLY while
 * the monitor state machine is mid-run, purely to give the packet-loss ratio
 * more than a handful of samples to divide.
 *
 * Why it exists. `probeLossPct` is failed/total over `AssetMonitorSample` rows
 * in the automation's History window, and those rows arrive at the
 * response-time cadence — so a 15-minute window on a 60s-cadence asset holds
 * ~15 samples and loss can only read in ~7% steps (at 300s: 3 samples, 33%
 * steps). Sampling at 10s during the window that matters lifts that to ~90
 * samples without touching the response-time stream's cadence, credentials, or
 * transport.
 *
 * What it deliberately is NOT. It never calls `recordProbeResult`, so it cannot
 * move `consecutiveFailures` / `consecutiveSuccesses` and cannot influence
 * `monitorStatus`. Down is still declared by the response-time poll on the
 * operator's configured method, at the operator's configured cadence. This
 * matters because ICMP does not authenticate the device it is talking to (see
 * the window rule below) and because mixing two transports' verdicts into one
 * counter would make "down" mean whichever of them happened to answer last.
 *
 * THE WINDOW: `warning` and `recovering` ONLY — never `down`.
 *
 *   - `warning` / `recovering` — the response-time poll is still succeeding
 *     intermittently, so ICMP replies are CORROBORATED: something at that
 *     address is demonstrably the monitored device. These are also exactly the
 *     states where extra resolution pays: `warning` is read live by loss
 *     automations (`assetIsAnsweringProbes` admits it), and `recovering`'s
 *     samples are still inside the History window when the asset reaches `up`,
 *     which is the first moment its loss reading is read again.
 *
 *   - `down` — every response-time poll is failing, so ICMP would be the only
 *     thing answering, with nothing to corroborate it. A host that has taken
 *     over the monitored address (DHCP reuse, a misconfigured static, an
 *     appliance swap) would answer those pings and drag a dead device's loss
 *     down from 100% to something that reads like mere congestion. A fully-down
 *     asset should read 100% loss, which is what the response-time poll's own
 *     failures already say.
 *
 *   - `up` — nothing to measure; every probe is succeeding and loss is 0%.
 *
 *   - `unknown` — never probed, so there is no run to add resolution to.
 *
 * Dependency-suppressed assets are excluded for the same reason the probe slows
 * to 2× interval there (business rule 30's first clamp): when the parent is
 * dark the asset is expected unreachable, and a site outage would otherwise put
 * every asset behind the dead gate into a 10s ping loop at exactly the moment
 * the monitor pool is busiest.
 */

/** Spacing between loss samples, in seconds. */
export const LOSS_SAMPLER_INTERVAL_SEC = 10;

/**
 * Per-ping timeout. Deliberately independent of the response-time stream's
 * `probeTimeoutMs`: an SNMP stream may sit at 30s, and a sampler inheriting
 * that could not honor a 10s spacing (its own probe would still be in flight).
 * 5s is well above any LAN/WAN round trip and below the spacing.
 */
export const LOSS_SAMPLER_TIMEOUT_MS = 5000;

/** The two monitor states in which ICMP replies are corroborated. */
const SAMPLED_STATES = new Set(["warning", "recovering"]);

export interface LossSamplerAsset {
  monitorStatus: string | null;
  /** Lifecycle status — a maintenance asset is polled by nothing. */
  status?: string | null;
  dependencySuppressed?: boolean | null;
  ipAddress?: string | null;
  dnsName?: string | null;
  hostname?: string | null;
}

export interface LossSamplerSettings {
  /**
   * Resolved response-time polling method. `null`/`"disabled"` means nothing is
   * driving the state machine, so there is no run to sample; `"agent"` means
   * the host pushes its own samples and the server must not reach out to it
   * (the same exclusion `resolveProbeIntervalSec` makes).
   */
  responseTimePolling: string | null;
}

/**
 * The ICMP target for an asset, or null when there is nothing to ping. Mirrors
 * `probeAsset`'s fallback: `ping` resolves a name perfectly well, and
 * directory-discovered hosts often carry only a DNS name.
 */
export function lossSamplerTarget(a: LossSamplerAsset): string | null {
  return a.ipAddress || a.dnsName || a.hostname || null;
}

/**
 * Should the loss sampler run for this asset at all right now? Pure — the
 * caller supplies resolved settings. Cadence is a separate question
 * (`lossSampleIsDue`).
 */
export function lossSamplerAppliesTo(a: LossSamplerAsset, eff: LossSamplerSettings): boolean {
  if (!SAMPLED_STATES.has(String(a.monitorStatus ?? ""))) return false;
  if (a.dependencySuppressed === true) return false;
  if (String(a.status ?? "") === "maintenance") return false;
  const polling = eff.responseTimePolling;
  if (polling === null || polling === "disabled" || polling === "agent") return false;
  return lossSamplerTarget(a) !== null;
}

/**
 * Cadence half of the decision, split out so the due-set builders can reuse the
 * same arithmetic they use for every other stream. `intervalSec <= 0` disables.
 */
export function lossSampleIsDue(
  last: Date | null | undefined,
  now: Date,
  intervalSec: number = LOSS_SAMPLER_INTERVAL_SEC,
): boolean {
  if (intervalSec <= 0) return false;
  if (!last) return true;
  return now.getTime() - last.getTime() >= intervalSec * 1000;
}
