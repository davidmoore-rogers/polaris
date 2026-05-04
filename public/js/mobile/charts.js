// public/js/mobile/charts.js — Tiny SVG line-chart helper.
//
// All charts in the mobile app are simple polyline overlays on a flexible-
// width SVG box. No fancy axes, no library — same visual language as the
// desktop response-time chart but simpler. Multiple series are supported so
// the same helper drives the response-time chart, the CPU+Memory chart, and
// future per-interface throughput charts.
//
// usage:
//   PolarisCharts.lineChart({
//     series: [
//       { values: [{ts, v}, ...], color: "var(--md-primary)", fill: true, label: "RTT" },
//     ],
//     yMin: 0, yMax: 100,    // optional — auto-derived if absent
//     height: 80,            // px
//     ariaLabel: "Response time over the last 24 hours",
//   })
//   → returns SVG string ready to drop into innerHTML

(function () {
  function lineChart(opts) {
    opts = opts || {};
    var series = opts.series || [];
    var height = opts.height || 80;
    var width = opts.width || 600;        // viewBox width — scales to 100% in CSS
    var pad = opts.padding || 4;          // px inside viewBox

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
        + '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" width="100%" height="' + height + '" role="img" aria-label="' + (opts.ariaLabel || "Empty chart") + '">'
        + '  <text x="' + (width / 2) + '" y="' + (height / 2 + 4) + '" text-anchor="middle" fill="var(--md-on-surface-variant)" font-size="11">No data</text>'
        + '</svg>';
    }
    if (yMin === yMax) { yMin -= 1; yMax += 1; } // flat line — give it a tiny range
    if (opts.yMin == null) yMin = Math.min(yMin, 0); // start from zero unless explicit

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

    function x(t) { return pad + (width - 2 * pad) * ((+new Date(t) - tMin) / (tMax - tMin)); }
    function y(v) { return height - pad - (height - 2 * pad) * ((v - yMin) / (yMax - yMin)); }

    var svgParts = [];
    svgParts.push('<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" width="100%" height="' + height + '" role="img" aria-label="' + (opts.ariaLabel || "Chart") + '">');

    series.forEach(function (s) {
      var pts = (s.values || [])
        .filter(function (p) { return p != null && p.ts != null && p.v != null; })
        .map(function (p) { return x(p.ts).toFixed(1) + "," + y(p.v).toFixed(1); })
        .join(" ");
      if (!pts) return;
      var color = s.color || "var(--md-primary)";

      if (s.fill) {
        // Build a closed polygon for the area fill — first point on the
        // baseline, then the series, then back to baseline at the last x.
        var first = (s.values || []).filter(function (p) { return p != null && p.ts != null && p.v != null; })[0];
        var last  = (s.values || []).filter(function (p) { return p != null && p.ts != null && p.v != null; }).slice(-1)[0];
        if (first && last) {
          var fillPts = pts + " " + x(last.ts).toFixed(1) + "," + (height - pad).toFixed(1) + " " + x(first.ts).toFixed(1) + "," + (height - pad).toFixed(1);
          svgParts.push('<polygon points="' + fillPts + '" fill="' + color + '" opacity="0.12"/>');
        }
      }
      svgParts.push('<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>');
    });

    svgParts.push('</svg>');
    return svgParts.join("\n");
  }

  window.PolarisCharts = { lineChart: lineChart };
})();
