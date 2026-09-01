/**
 * public/js/monitor-states.js
 *
 * Replays the monitor state machine over a probe-sample stream and returns one
 * display state per sample, in order, each carrying the missed-poll count as it
 * stood after that probe.
 *
 * THREE browser surfaces read the answer and must not disagree: the asset
 * System tab's Last-30-min strip, the desktop response-time chart directly
 * below it, and the phone app's response-time chart. Each of the three used to
 * decide "is this probe amber or red, green or blue" for itself, which is how
 * a strip and the chart under it can end up describing the same probe
 * differently. There is a fourth copy on the server —
 * `replayProbeStates` in src/services/probeOutageService.ts, for the charts
 * rasterized into alert emails — and the machine itself lives in
 * `nextFailureBucket` + `monitorStatusFor` in src/utils/monitorStatus.ts, which
 * is what the probe loop runs. All four are kept in step by a parity test
 * (tests/unit/assetIntermittencyBar.test.ts) rather than by an import, since
 * nothing crosses those boundaries.
 *
 * The rule, in full (business rules 30 and 36):
 *
 *   cap = max(threshold, recoveryPolls)          ← what a declared outage owes
 *   miss:   cf = min(cap, cf + 1), then cf = cap once cf reaches threshold
 *   answer: cf = max(0, min(cap, cf) - 1)
 *
 *   cf = 0                      → up          (green)
 *   this probe ANSWERED         → recovering  (blue, paying the debt)
 *   missed, cf >= threshold     → down        (the covering automation's
 *                                              SEVERITY colour — red only when
 *                                              that automation is critical)
 *   missed, cf <  threshold     → warning     (amber, "Missed N")
 *
 * THE LEVEL DECIDES WHAT A MISS MEANS; the outcome decides everything else.
 *
 * Two properties are load-bearing, and both were bugs until 2026-09-01:
 *
 *   • THE BUCKET IS CAPPED. It used to climb without limit, so a device dark
 *     overnight owed one answered poll per minute it had been dark — hundreds —
 *     before it could read `up`. Recovery is bounded by what the operator asked
 *     for, never by how long the outage ran.
 *   • AN ANSWERED PROBE IS ALWAYS `recovering`. The answered branch used to sit
 *     below the threshold test, so a probe that answered while the bucket was
 *     still at or above the threshold read `down` — and since the chart cannot
 *     paint an `ok` point in the down colour, it fell through to the plain
 *     series green. A long outage drew red → GREEN → blue → green and read as
 *     though the device had recovered twice.
 *
 * A failure during the climb back out re-locks the bucket at the cap, so it can
 * go down again on the way home. That is the point: the old run-length machine
 * reset the counter to zero on any single success, so an alternating device
 * never reached a verdict in either direction.
 *
 * The pre-window state is assumed fully recovered (cf = 0): only an outage
 * visible in the sample stream produces amber, down or blue cells.
 *
 * `threshold === null` is the PASSIVE case (business rule 36): no automation
 * defines Down for this device, so nothing may reach `down` — that would assert
 * a verdict Polaris deliberately never reaches — but the bucket still runs, so
 * a passive device quietly accumulating misses still reads as one. `Infinity`
 * is how "never down" is spelled without a second loop.
 *
 * Pure and DOM-free. Exposed as window.PolarisMonitorStates.
 */
(function () {
  "use strict";

  /** Absolute ceiling on the bucket — mirrors MAX_MISSED_POLL_BUCKET in
   *  src/utils/monitorStatus.ts. Also the cap a PASSIVE device gets, since it
   *  has no automation to supply one. */
  var MAX_BUCKET = 100;

  function replay(samples, threshold, recoveryPolls) {
    var thr = threshold === null ? Infinity
      : (Number.isFinite(threshold) && threshold >= 1) ? Math.floor(threshold) : 3;
    // How many probes must ANSWER before the asset reads Up again — the covering
    // automation's reset count, already converted to polls by the server. Below
    // the missed-poll count it changes nothing: the bucket's drain is the floor.
    var rec = (Number.isFinite(recoveryPolls) && recoveryPolls > 0) ? Math.floor(recoveryPolls) : 0;
    // What a DECLARED outage owes, and the level the bucket locks at.
    var cap = thr === Infinity ? MAX_BUCKET : Math.min(MAX_BUCKET, Math.max(thr, rec));
    var cf = 0;
    var cs = 0;
    return (samples || []).map(function (s) {
      // Mirrors nextFailureBucket exactly. If these two ever disagree the bar is
      // telling the operator a different story than the pill above it.
      if (s.success) {
        cf = Math.max(0, Math.min(cap, cf) - 1);
        cs = cs + 1;
      } else {
        var raised = Math.min(cap, cf + 1);
        cf = (thr !== Infinity && raised >= thr) ? cap : raised;
        cs = 0;
      }
      var display;
      if (cf === 0) display = "up";
      else if (s.success) display = "recovering";
      else display = cf >= thr ? "down" : "warning";
      return {
        timestamp: s.timestamp,
        status: display,
        missed: cf,
        success: !!s.success,
        // How far through the climb this probe is, for the strip's tooltip:
        // `cap` answers pay an outage off, and `cap - cf` have been served.
        confirming: display === "recovering" ? { done: cap - cf, need: cap } : null,
      };
    });
  }

  /**
   * The counts and the colour a chart needs, read off a monitor-history
   * payload's `downDetection` block, normalized for `replay` above.
   *
   * Three distinct answers, and collapsing any two of them is a bug:
   *   • an automation covers the device      → its counts, amber below / its own
   *     severity colour at the threshold
   *   • `passive`                            → threshold null, nothing goes down
   *   • the block is ABSENT                  → UNKNOWN, and `known:false` tells
   *     the caller to keep every miss red rather than invent a threshold to be
   *     amber about (an older payload, or a resolve that failed).
   */
  function fromPayload(downDetection) {
    if (!downDetection) return { known: false, threshold: null, recoveryPolls: 0, severity: null };
    if (downDetection.passive) return { known: true, threshold: null, recoveryPolls: 0, severity: null };
    return {
      known: true,
      threshold: Number.isFinite(downDetection.missedPolls) ? downDetection.missedPolls : null,
      recoveryPolls: Number.isFinite(downDetection.recoveryPolls) ? downDetection.recoveryPolls : 0,
      // The covering automation's severity — what the operator said this outage
      // is worth, and therefore the colour every surface paints `down` in.
      severity: typeof downDetection.severity === "string" ? downDetection.severity : null,
    };
  }

  window.PolarisMonitorStates = { replay: replay, fromPayload: fromPayload, MAX_BUCKET: MAX_BUCKET };
})();
