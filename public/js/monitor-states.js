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
 * decide "is this probe amber or red, green or purple" for itself, which is how
 * a strip and the chart under it can end up describing the same probe
 * differently. There is a fourth copy on the server —
 * `replayProbeStates` in src/services/probeOutageService.ts, for the charts
 * rasterized into alert emails — kept in step by a parity test
 * (tests/unit/assetIntermittencyBar.test.ts) rather than by an import, since
 * nothing crosses that boundary.
 *
 * This is a MIRROR of recordProbeResult in src/services/monitoringService.ts,
 * and it is only useful if it agrees cell-for-cell with the pill above the
 * strip. The rule, in full (business rule 30):
 *
 *   cf = miss ? cf + 1 : max(0, cf - 1)          ← leaky bucket, not a run
 *   cf >= threshold                  → down       (red)
 *   cf > 0  and this probe missed    → warning    (amber, "Missed N")
 *   cf > 0  and this probe answered  → recovering (purple, paying the debt)
 *   cf == 0                          → up         (green)
 *
 * The level decides; this probe's outcome only breaks the tie below the
 * threshold. Worked examples at threshold 3 — one missed poll is green, amber,
 * green (a blip still never smears); a device going down and coming back is
 * green, amber, amber, RED, purple, purple, green, because paying three misses
 * back takes three answers.
 *
 * A failure during the climb back out re-fills the bucket, so it can go red
 * again on the way home. That is the point: the old run-length machine reset
 * the counter to zero on any single success, so an alternating device never
 * reached a verdict in either direction.
 *
 * The pre-window state is assumed fully recovered (cf = 0): only an outage
 * visible in the sample stream produces amber, red or purple cells.
 *
 * `threshold === null` is the PASSIVE case (business rule 36): no automation
 * defines Down for this device, so nothing may go red — that would assert a
 * verdict Polaris deliberately never reaches — but the bucket still runs, so a
 * passive device quietly accumulating misses still reads as one. `Infinity` is
 * how "never red" is spelled without a second loop.
 *
 * Pure and DOM-free. Exposed as window.PolarisMonitorStates.
 */
(function () {
  "use strict";

  function replay(samples, threshold, recoveryPolls) {
    var thr = threshold === null ? Infinity
      : (Number.isFinite(threshold) && threshold >= 1) ? Math.floor(threshold) : 3;
    // How many probes must ANSWER before the asset reads Up again — the covering
    // automation's reset count, already converted to polls by the server. Below
    // the missed-poll count it changes nothing: the bucket's drain is the floor.
    var rec = (Number.isFinite(recoveryPolls) && recoveryPolls > 0) ? Math.floor(recoveryPolls) : 0;
    var cf = 0;
    var cs = 0;
    // Whether this replay has SEEN the device go down. The server infers the same
    // fact arithmetically (owesRecoveryConfirmation: at cf 0, a success run of
    // `cs` means the bucket stood at `cs` when the run began), which it must,
    // having no memory beyond the two counters. The replay has the whole window
    // in hand, so it uses the observation directly — the inference needs a run
    // that STARTED inside the window, and a bar whose first cells predate the
    // outage would otherwise paint a healthy device amber on its third cell.
    var sawDown = false;
    return (samples || []).map(function (s) {
      // Mirrors recordProbeResult exactly: a miss adds one, a success takes one
      // back, floored at 0 — and the LEVEL decides the color, with this probe's
      // outcome only breaking the tie below the threshold. If these two ever
      // disagree the bar is telling the operator a different story than the pill.
      cf = s.success ? Math.max(0, cf - 1) : cf + 1;
      cs = s.success ? cs + 1 : 0;
      var display;
      if (cf >= thr) { display = "down"; sawDown = true; }
      else if (cf > 0) display = s.success ? "recovering" : "warning";
      else if (sawDown && cs < rec) display = "recovering";
      else { display = "up"; sawDown = false; }
      return {
        timestamp: s.timestamp,
        status: display,
        missed: cf,
        success: !!s.success,
        // Only meaningful while the debt is paid but the confirmation run is not.
        confirming: display === "recovering" && cf === 0 ? { done: cs, need: rec } : null,
      };
    });
  }

  /**
   * The two counts a chart needs, read off a monitor-history payload's
   * `downDetection` block, normalized for `replay` above.
   *
   * Three distinct answers, and collapsing any two of them is a bug:
   *   • an automation covers the device      → its counts, amber below / red at
   *   • `passive`                            → threshold null, nothing goes red
   *   • the block is ABSENT                  → UNKNOWN, and `known:false` tells
   *     the caller to keep every miss red rather than invent a threshold to be
   *     amber about (an older payload, or a resolve that failed).
   */
  function fromPayload(downDetection) {
    if (!downDetection) return { known: false, threshold: null, recoveryPolls: 0 };
    if (downDetection.passive) return { known: true, threshold: null, recoveryPolls: 0 };
    return {
      known: true,
      threshold: Number.isFinite(downDetection.missedPolls) ? downDetection.missedPolls : null,
      recoveryPolls: Number.isFinite(downDetection.recoveryPolls) ? downDetection.recoveryPolls : 0,
    };
  }

  window.PolarisMonitorStates = { replay: replay, fromPayload: fromPayload };
})();
