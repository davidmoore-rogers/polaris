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

  function lineChart(opts) {
    opts = opts || {};
    var series = opts.series || [];
    var totalHeight = opts.height || 80;
    var viewWidth   = opts.width  || 600;     // viewBox width — scales to 100% in CSS
    var pad = opts.padding || 2;              // breathing room inside the plot
    var yUnit = opts.yUnit || "";

    // Figure out the y-axis range across all visible points.
    var yMin = (opts.yMin != null) ? opts.yMin : Infinity;
    var yMax = (opts.yMax != null) ? opts.yMax : -Infinity;
    var anyPoints = false;
    series.forEach(function (s) {
      (s.values || []).forEach(function (p) {
        if (p == null || p.v == null) return;
        anyPoints = true;
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
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    if (opts.yMin == null) yMin = Math.min(yMin, 0);

    // Time axis from the union of all series.
    var tMin = Infinity, tMax = -Infinity;
    series.forEach(function (s) {
      (s.values || []).forEach(function (p) {
        if (p == null || p.ts == null) return;
        var t = +new Date(p.ts);
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
      });
    });
    if (tMin === tMax) tMax = tMin + 1;

    // Plot area in viewBox space — leave gutters at top/bottom for breathing
    // room (the actual axis labels are HTML, sitting in the wrapper's
    // padding around the SVG).
    var plotHeight = totalHeight - TOP_GUTTER - BOTTOM_GUTTER;
    function x(t) { return pad + (viewWidth - 2 * pad) * ((+new Date(t) - tMin) / (tMax - tMin)); }
    function y(v) { return plotHeight - pad - (plotHeight - 2 * pad) * ((v - yMin) / (yMax - yMin)); }

    var svgParts = [];
    svgParts.push('<svg class="chart-svg" viewBox="0 0 ' + viewWidth + ' ' + plotHeight + '" preserveAspectRatio="none" role="img" aria-label="' + escapeAttr(opts.ariaLabel || "Chart") + '">');

    // Faint y midline so the eye has something to anchor on.
    svgParts.push('<line x1="0" x2="' + viewWidth + '" y1="' + (plotHeight / 2).toFixed(1) + '" y2="' + (plotHeight / 2).toFixed(1) + '" stroke="var(--md-outline-variant)" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.5"/>');

    series.forEach(function (s) {
      var pts = (s.values || [])
        .filter(function (p) { return p != null && p.ts != null && p.v != null; })
        .map(function (p) { return x(p.ts).toFixed(1) + "," + y(p.v).toFixed(1); })
        .join(" ");
      if (!pts) return;
      var color = s.color || "var(--md-primary)";

      if (s.fill) {
        var pointsArr = (s.values || []).filter(function (p) { return p != null && p.ts != null && p.v != null; });
        var first = pointsArr[0];
        var last  = pointsArr[pointsArr.length - 1];
        if (first && last) {
          var fillPts = pts + " " + x(last.ts).toFixed(1) + "," + (plotHeight - pad).toFixed(1) + " " + x(first.ts).toFixed(1) + "," + (plotHeight - pad).toFixed(1);
          svgParts.push('<polygon points="' + fillPts + '" fill="' + color + '" opacity="0.12"/>');
        }
      }
      svgParts.push('<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>');
    });

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

  window.PolarisCharts = { lineChart: lineChart };
})();
