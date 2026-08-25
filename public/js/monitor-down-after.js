/**
 * public/js/monitor-down-after.js
 *
 * The shared arithmetic behind "how long until this device is called Down":
 * how long a device really takes to reach Down, given how many consecutive
 * missed polls it needs and how fast those polls happen.
 *
 * The COUNT is no longer a Monitor Settings value — it belongs to the
 * `monitor status is down` automation covering the device (business rule 34),
 * so this helper's `thr` argument now comes from the automation while the
 * interval and timeout still come from the monitor-settings hierarchy. That
 * split is exactly why this is its own file: the automations wizard, the asset
 * detail surfaces and the settings cards all need the same number, and the
 * wizard's DOM tests eval only the wizard file, so leaving it inside
 * integrations.js (7,500+ lines) made it untestable from there.
 *
 * Pure. Exposed as window.PolarisMonitorDownAfter; the legacy
 * window._polarisMonDownAfterCalc alias stays for one release.
 */
(function () {
  "use strict";

  function calc(thr, intervalSec, timeoutMs) {
    thr = Math.min(100, Math.max(1, Number(thr) > 0 ? Math.round(Number(thr)) : 3));
    var interval = Number(intervalSec) > 0 ? Math.round(Number(intervalSec)) : 60;
    var timeoutSec = Math.ceil((Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000) / 1000);
    // Every miss after the first waits a FULL poll interval — there is no
    // confirmation re-probe (that was the fast-confirm cadence, removed
    // 2026-08-19; in-run resolution is the ICMP loss sampler's job now and it
    // feeds packet loss only, never this decision). The first miss itself costs
    // up to the probe timeout.
    var realSec = interval * Math.max(0, thr - 1) + timeoutSec;
    return {
      threshold: thr,
      interval: interval,
      timeoutSec: timeoutSec,
      realSec: realSec,
      note: "= " + thr + " consecutive missed poll" + (thr === 1 ? "" : "s") +
        " ≈ " + realSec + "s from the first miss" +
        (thr > 1
          ? " (" + (thr - 1) + " × the " + interval + "s interval, plus up to the " + timeoutSec + "s timeout on the first)"
          : " (up to the " + timeoutSec + "s probe timeout)") + "." +
        " Recovery to Up needs " + thr + " consecutive success" + (thr === 1 ? "" : "es") + "." +
        " Measured from the first missed poll — the wait for that first poll is another poll interval on top.",
    };
  }

  /** Human "2m 5s" for a second count. Short-form, for inline captions. */
  function human(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    if (sec < 60) return sec + "s";
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    if (m < 60) return s ? m + "m " + s + "s" : m + "m";
    var h = Math.floor(m / 60);
    var rm = m % 60;
    return rm ? h + "h " + rm + "m" : h + "h";
  }

  window.PolarisMonitorDownAfter = { calc: calc, human: human };
  // Legacy alias — integrations.js and the asset surfaces still call this name.
  window._polarisMonDownAfterCalc = calc;
})();
