// public/js/mobile/charts.js — Tiny SVG line-chart helper.
//
// All charts in the mobile app are simple polyline overlays on a flexible-
// width SVG box. Multiple series are supported so the same helper drives
// the response-time chart, the CPU+Memory chart, and future per-interface
// throughput charts.
//
// The SVG plot uses `preserveAspectRatio="none"` so the polyline stretches
// to fill the container — that scales any text inside, which is why the
// axis labels are HTML positioned around the SVG rather than <text> nodes
// inside it. The wrapper is `.chart-wrap` (see mobile.css).
//
// usage:
//   PolarisCharts.lineChart({
//     series: [
//       { values: [{ts, v}, ...], color: "var(--md-primary)", fill: true, label: "RTT" },
//     ],
//     yMin: 0, yMax: 100,    // optional — auto-derived if absent
//     yUnit: "%",            // appended to y-axis tick labels
//     height: 80,            // total px including axis gutters
//     ariaLabel: "Response time over the last 24 hours",
//   })
//   → returns HTML string ready to drop into innerHTML
//
// Missed polls read the same way they do on the desktop charts: a failed poll
// sits at the chart baseline in red and stays connected to its neighbors, with
// the transition segment fading between the series color and red so an outage
// looks like the line diving to zero instead of a straight bridge over the
// hole. Two ways to feed that in per series:
//
//   • `{ ts, v: null, ok: false }` points — for streams that carry an explicit
//     per-sample success flag (the monitor/response-time stream).
//   • `gapFade: true` on the series — for streams where a failed poll simply
//     leaves no row (CPU/memory telemetry); gaps are inferred from the
//     series' own median cadence.

(function () {
  // Gutter widths chosen so axis labels fit without crowding the plot at
  // the default 80px chart height.
  var LEFT_GUTTER   = 36;
  var RIGHT_GUTTER  = 8;
  var BOTTOM_GUTTER = 18;
  var TOP_GUTTER    = 4;

  // The returned markup lands in innerHTML, and ariaLabel can carry
  // API-sourced names (e.g. SD-WAN health-check names) — escape anything
  // interpolated into an attribute.
  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Failed-poll color — the same hue the desktop charts use
  // (`_CHART_FAIL_COLOR` in public/js/assets.js), so a missed poll reads
  // identically on both surfaces.
  var FAIL_COLOR = "#d32f2f";

  // Gradient ids must be unique per rendered chart — several charts share the
  // asset sheet's DOM (response time, CPU/memory, three SD-WAN charts).
  var _chartSeq = 0;

  // Detect missed-poll gaps in a time-ordered list of sample timestamps (ms),
  // for streams with no per-sample success flag — a failed poll simply leaves
  // no row. Returns synthetic marker timestamps to plot as failures: one just
  // after the last good sample and one just before the next, so the line dives
  // to the baseline across the gap instead of drawing a straight bridge over
  // it. A gap counts when it exceeds 2.5× the series' median cadence (needs ≥3
  // samples for a meaningful median; rollup tiers work the same way — a missing
  // bucket is a gap in bucket-sized steps). Port of `_pollGapMarkers` in
  // public/js/assets.js — keep the two in step.
  function pollGapMarkers(timestampsMs) {
    if (!timestampsMs || timestampsMs.length < 3) return [];
    var dts = [];
    for (var i = 1; i < timestampsMs.length; i++) {
      var dt = timestampsMs[i] - timestampsMs[i - 1];
      if (dt > 0) dts.push(dt);
    }
    if (!dts.length) return [];
    dts.sort(function (a, b) { return a - b; });
    var median = dts[Math.floor(dts.length / 2)];
    if (!(median > 0)) return [];
    var threshold = median * 2.5;
    var markers = [];
    for (i = 1; i < timestampsMs.length; i++) {
      var gap = timestampsMs[i] - timestampsMs[i - 1];
      if (gap <= threshold) continue;
      var a = timestampsMs[i - 1] + median;
      var b = timestampsMs[i] - median;
      if (b <= a) markers.push(timestampsMs[i - 1] + gap / 2);
      else markers.push(a, b);
    }
    return markers;
  }

  // Normalize one series' `values` into time-ordered { ts (ms), v, ok } points:
  // drops junk and coerces explicit `ok:false` failures into valueless
  // baseline points.
  function seriesPoints(s) {
    var pts = [];
    (s.values || []).forEach(function (p) {
      if (p == null || p.ts == null) return;
      var failed = p.ok === false;
      if (p.v == null && !failed) return;
      var t = +new Date(p.ts);
      if (!isFinite(t)) return;
      pts.push({ ts: t, v: failed ? null : p.v, ok: !failed });
    });
    pts.sort(function (a, b) { return a.ts - b.ts; });
    return pts;
  }

  // Inferred missed-poll markers for the `gapFade` series, derived ONCE from
  // the union of their good timestamps and applied to all of them — the same
  // rule the desktop CPU/memory + interface charts use. Union rather than
  // per-series because CPU and memory ride the same telemetry row: a transport
  // that reports one but not the other is a data-availability difference (that
  // series bridges), not an outage, and shared markers keep both lines diving
  // at the same x instead of drawing two offset red notches.
  function applySharedGapMarkers(prepared) {
    var seen = {};
    var any = false;
    prepared.forEach(function (e) {
      if (!e.s.gapFade) return;
      any = true;
      e.pts.forEach(function (p) { if (p.ok) seen[p.ts] = true; });
    });
    if (!any) return [];
    var union = Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
    var marks = pollGapMarkers(union);
    if (!marks.length) return marks;
    prepared.forEach(function (e) {
      if (!e.s.gapFade || !e.pts.length) return;
      marks.forEach(function (t) { e.pts.push({ ts: t, v: null, ok: false }); });
      e.pts.sort(function (a, b) { return a.ts - b.ts; });
    });
    return marks;
  }

  // Failure-aware line rendering over plot-space { x, y, ok } points. Runs of
  // same-state points collapse into one polyline (a phone can hold a day of
  // per-minute samples, so per-segment <line> elements the way the desktop
  // chart emits them would be thousands of nodes); each OK↔fail transition
  // gets its own userSpaceOnUse linearGradient so the stroke visibly fades
  // between the series color and red instead of jumping.
  function failureAwareSegments(pts, seriesColor, idPrefix) {
    var defs = "";
    var out = "";
    function strokeFor(ok) { return ok ? seriesColor : FAIL_COLOR; }
    function polyline(slice, ok) {
      if (slice.length < 2) return "";
      return '<polyline points="' + slice.map(function (p) { return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" ") +
        '" fill="none" stroke="' + strokeFor(ok) + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    }
    var runStart = 0;
    for (var i = 1; i <= pts.length; i++) {
      var atEnd = i === pts.length;
      if (!atEnd && pts[i].ok === pts[i - 1].ok) continue;
      out += polyline(pts.slice(runStart, i), pts[runStart].ok);
      if (atEnd) break;
      var a = pts[i - 1], b = pts[i];
      var gid = idPrefix + "-g" + i;
      defs += '<linearGradient id="' + gid + '" gradientUnits="userSpaceOnUse"' +
        ' x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '">' +
        '<stop offset="0%" stop-color="' + strokeFor(a.ok) + '"/>' +
        '<stop offset="100%" stop-color="' + strokeFor(b.ok) + '"/>' +
        '</linearGradient>';
      out += '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) +
        '" stroke="url(#' + gid + ')" stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
      runStart = i;
    }
    return { defs: defs, segments: out };
  }

  // Red baseline dots for failed polls, so a lone missed poll is visible and
  // not just a hairline notch. Drawn as a near-zero-length round-capped stroke
  // rather than a <circle>: the plot uses preserveAspectRatio="none", which
  // squashes circles into ellipses, while a non-scaling stroke stays round in
  // screen space at whatever width the phone renders the chart.
  function failureDots(pts) {
    return pts.filter(function (p) { return !p.ok; }).map(function (p) {
      // Both endpoints round at the same precision so the stub always runs
      // forward by exactly 0.01 user units.
      return '<line x1="' + p.x.toFixed(2) + '" y1="' + p.y.toFixed(2) + '" x2="' + (p.x + 0.01).toFixed(2) + '" y2="' + p.y.toFixed(2) +
        '" stroke="' + FAIL_COLOR + '" stroke-width="4" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    }).join("");
  }

  function lineChart(opts) {
    opts = opts || {};
    var series = opts.series || [];
    var totalHeight = opts.height || 80;
    var viewWidth   = opts.width  || 600;     // viewBox width — scales to 100% in CSS
    var pad = opts.padding || 2;              // breathing room inside the plot
    var yUnit = opts.yUnit || "";

    // Normalize every series up front so the range/axis passes and the render
    // pass agree on exactly which points exist (gap markers included).
    var prepared = series.map(function (s) { return { s: s, pts: seriesPoints(s) }; });
    applySharedGapMarkers(prepared);

    // Figure out the y-axis range across all visible points. Failed polls carry
    // no value — they plot at the baseline — so they never widen the range.
    var yMin = (opts.yMin != null) ? opts.yMin : Infinity;
    var yMax = (opts.yMax != null) ? opts.yMax : -Infinity;
    var anyValues = false, anyPoints = false;
    prepared.forEach(function (e) {
      e.pts.forEach(function (p) {
        anyPoints = true;
        if (p.v == null) return;
        anyValues = true;
        if (opts.yMin == null && p.v < yMin) yMin = p.v;
        if (opts.yMax == null && p.v > yMax) yMax = p.v;
      });
    });
    if (!anyPoints) {
      return ''
        + '<div class="chart-wrap" style="height:' + totalHeight + 'px;">'
        + '  <div class="chart-empty">No data</div>'
        + '</div>';
    }
    // A window with nothing but failed polls (device down the whole time) still
    // has something to say — plot the red baseline on a nominal 0–1 axis rather
    // than falling through to "No data".
    if (!anyValues) {
      if (opts.yMin == null) yMin = 0;
      if (opts.yMax == null) yMax = 1;
    }
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    if (opts.yMin == null) yMin = Math.min(yMin, 0);

    // Time axis from the union of all series.
    var tMin = Infinity, tMax = -Infinity;
    prepared.forEach(function (e) {
      e.pts.forEach(function (p) {
        if (p.ts < tMin) tMin = p.ts;
        if (p.ts > tMax) tMax = p.ts;
      });
    });
    if (tMin === tMax) tMax = tMin + 1;

    // Plot area in viewBox space — leave gutters at top/bottom for breathing
    // room (the actual axis labels are HTML, sitting in the wrapper's
    // padding around the SVG).
    var plotHeight = totalHeight - TOP_GUTTER - BOTTOM_GUTTER;
    function x(t) { return pad + (viewWidth - 2 * pad) * ((+new Date(t) - tMin) / (tMax - tMin)); }
    function y(v) { return plotHeight - pad - (plotHeight - 2 * pad) * ((v - yMin) / (yMax - yMin)); }
    var baselineY = plotHeight - pad;   // where failed polls sit

    _chartSeq += 1;
    var idPrefix = "pc-" + _chartSeq;

    var defs = "";
    var body = [];

    // Faint y midline so the eye has something to anchor on.
    body.push('<line x1="0" x2="' + viewWidth + '" y1="' + (plotHeight / 2).toFixed(1) + '" y2="' + (plotHeight / 2).toFixed(1) + '" stroke="var(--md-outline-variant)" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.5"/>');

    prepared.forEach(function (e, si) {
      var color = e.s.color || "var(--md-primary)";
      var plot = e.pts.map(function (p) {
        return { x: x(p.ts), y: p.ok ? y(p.v) : baselineY, ok: p.ok };
      });
      if (!plot.length) return;

      if (e.s.fill) {
        var first = plot[0], last = plot[plot.length - 1];
        var fillPts = plot.map(function (p) { return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" ")
          + " " + last.x.toFixed(1) + "," + baselineY.toFixed(1)
          + " " + first.x.toFixed(1) + "," + baselineY.toFixed(1);
        body.push('<polygon points="' + fillPts + '" fill="' + color + '" opacity="0.12"/>');
      }

      var seg = failureAwareSegments(plot, color, idPrefix + "-s" + si);
      defs += seg.defs;
      body.push(seg.segments);
      body.push(failureDots(plot));
    });

    var svgParts = [];
    svgParts.push('<svg class="chart-svg" viewBox="0 0 ' + viewWidth + ' ' + plotHeight + '" preserveAspectRatio="none" role="img" aria-label="' + escapeAttr(opts.ariaLabel || "Chart") + '">');
    if (defs) svgParts.push('<defs>' + defs + '</defs>');
    svgParts.push(body.join(""));
    svgParts.push('</svg>');

    // Y-axis labels — three ticks (max / mid / min) on the left gutter.
    var yMid = (yMin + yMax) / 2;
    var yLabels = ''
      + '<div class="chart-y-labels">'
      + '  <span class="chart-y-tick" style="top:0;">'                 + formatY(yMax, yUnit) + '</span>'
      + '  <span class="chart-y-tick" style="top:50%;transform:translateY(-50%);">' + formatY(yMid, yUnit) + '</span>'
      + '  <span class="chart-y-tick" style="bottom:0;">'              + formatY(yMin, yUnit) + '</span>'
      + '</div>';

    // X-axis labels — start time at left, end time at right.
    var xLabels = ''
      + '<div class="chart-x-labels">'
      + '  <span class="chart-x-tick">' + formatX(tMin, tMax - tMin) + '</span>'
      + '  <span class="chart-x-tick">' + formatX(tMax, tMax - tMin) + '</span>'
      + '</div>';

    return ''
      + '<div class="chart-wrap" style="height:' + totalHeight + 'px;padding:' + TOP_GUTTER + 'px ' + RIGHT_GUTTER + 'px ' + BOTTOM_GUTTER + 'px ' + LEFT_GUTTER + 'px;">'
      +   yLabels
      +   svgParts.join("")
      +   xLabels
      + '</div>';
  }

  function formatY(v, unit) {
    if (v == null) return "";
    var n = Number(v);
    if (!isFinite(n)) return "";
    var fmt;
    if (Math.abs(n) >= 1000) fmt = Math.round(n).toString();
    else if (Math.abs(n) >= 100) fmt = n.toFixed(0);
    else if (Math.abs(n) >= 10)  fmt = n.toFixed(1);
    else                         fmt = n.toFixed(2);
    return fmt + (unit ? " " + unit : "");
  }

  // Picks an appropriate label format based on the total window duration:
  // sub-day windows show HH:MM, sub-month show "MMM D", larger show "MMM YYYY".
  function formatX(ts, spanMs) {
    if (ts == null || !isFinite(ts)) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    if (spanMs < 36 * 3600 * 1000) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (spanMs < 31 * 86400 * 1000) {
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    }
    return d.toLocaleDateString([], { month: "short", year: "numeric" });
  }

  window.PolarisCharts = {
    lineChart: lineChart,
    // exported for unit tests
    _pollGapMarkers: pollGapMarkers,
    _seriesPoints: seriesPoints,
    _applySharedGapMarkers: applySharedGapMarkers,
  };
})();
