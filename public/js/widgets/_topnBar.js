/**
 * widgets/_topnBar.js — shared renderer for the NOC top-N metric widgets
 * (Highest CPU, Highest Memory, Slowest Response, Packet Loss, Highest Disk
 * Usage, Highest Temperature). These are structurally identical: a ranked
 * list of { id, hostname, ipAddress, value, detail?, site? }
 * rows drawn as a name + utilization bar + value, with per-widget units, color
 * thresholds, an optional value floor, and an optional Group-by-Site view
 * (gear option; buckets the ranked rows under site headers, groups ordered
 * by their hottest row). Underscore-prefixed = internal helper; it registers
 * no widget of its own.
 *
 * Exposes window.PolarisTopN.{ renderRows, renderConfig, pickColor }.
 */

(function () {
  // thresholds: highest-first [{ over, color }]. First match wins; else base.
  function pickColor(value, thresholds, baseColor) {
    var list = thresholds || [];
    for (var i = 0; i < list.length; i++) {
      if (value >= list[i].over) return list[i].color;
    }
    return baseColor || "#4fc3f7";
  }

  function formatValue(value, unit) {
    if (unit === "ms") return Math.round(value) + " ms";
    if (unit === "°C") return Math.round(value) + " °C";
    return value + "%";
  }

  /**
   * el       — widget body
   * rows     — [{ id, hostname, ipAddress, value }]
   * opts     — { unit:"%"|"ms"|"°C", thresholds, baseColor, emptyText, config, fillTo }
   *            config: { rowLimit, threshold }
   *            fillTo: red-guarantee mode (Highest CPU/Memory/Disk, Slowest
   *            Response). The operator's Row limit governs how many rows show
   *            (top-N by value), EXCEPT that every RED row (at/above the top
   *            color threshold, thresholds[0].over) is always shown even past
   *            the limit — an alert must never be clipped away. fillTo is the
   *            fallback row count when the config carries no usable rowLimit.
   *            The gear "Hide below" threshold does NOT apply in this mode.
   *            Omit fillTo to leave the threshold as a hard filter + rowLimit
   *            as a plain cap (e.g. Packet Loss).
   */
  function renderRows(el, rows, opts) {
    opts = opts || {};
    var cfg = opts.config || {};
    var sorted = (rows || []).slice().sort(function (a, b) { return (b.value || 0) - (a.value || 0); });
    var shown;
    if (opts.fillTo) {
      // sorted is desc, so the red rows (≥ the top color threshold) are the
      // contiguous head — count them, then take max(rowLimit, redCount) from
      // the top: the operator's limit of rows, extended when there are more
      // red rows than the limit holds.
      var redOver = (opts.thresholds && opts.thresholds.length) ? opts.thresholds[0].over : Infinity;
      var redCount = 0;
      while (redCount < sorted.length && (sorted[redCount].value || 0) >= redOver) redCount++;
      var limitN = parseInt(cfg.rowLimit, 10);
      if (isNaN(limitN) || limitN <= 0) limitN = opts.fillTo;
      shown = sorted.slice(0, Math.max(limitN, redCount));
    } else if (cfg.threshold != null) {
      shown = PolarisWidgets.clip(sorted.filter(function (r) { return (r.value || 0) >= cfg.threshold; }), cfg.rowLimit);
    } else {
      shown = PolarisWidgets.clip(sorted, cfg.rowLimit);
    }
    if (!shown.length) {
      el.innerHTML = '<p class="empty-state">' + escapeHtml(opts.emptyText || "Nothing to show") + '</p>';
      return;
    }
    // Percentages scale against a fixed 100; latency scales against the max in
    // the visible set so the slowest node fills the bar. Computed over the
    // FULL visible set (not per group) so bars stay comparable across groups.
    var scaleMax = opts.unit === "%"
      ? 100
      : (Math.max.apply(null, shown.map(function (r) { return r.value || 0; })) || 1);

    function rowHTML(r) {
      var v = r.value || 0;
      var pct = Math.min(100, Math.round((v / scaleMax) * 100));
      var color = pickColor(v, opts.thresholds, opts.baseColor);
      var name = escapeHtml(r.hostname || r.ipAddress || "(unnamed)");
      // Optional secondary label (e.g. the mount path for Highest Disk Usage),
      // shown muted after the hostname in the same cell.
      var detail = r.detail ? ' <span style="color:var(--color-text-tertiary);font-size:0.8rem">' + escapeHtml(r.detail) + '</span>' : "";
      // The name cell ellipsizes — a native tooltip carries the full name (and
      // mount detail when present) for rows the column is too narrow to show.
      var tip = escapeHtml((r.hostname || r.ipAddress || "(unnamed)") + (r.detail ? " — " + r.detail : ""));
      var label = formatValue(v, opts.unit);
      var tag = r.id ? "a" : "div";
      var nav = r.id ? ' href="/assets.html#view=asset:' + encodeURIComponent(r.id) + '"' : "";
      return "<" + tag + ' class="recent-item' + (r.id ? " recent-item-link" : "") + '"' + nav +
        ' style="display:grid;grid-template-columns:1fr 90px 48px;align-items:center;gap:8px;text-decoration:none">' +
        '<span class="recent-item-title" title="' + tip + '" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + name + detail + '</span>' +
        '<div class="util-bar-track"><div class="util-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
        '<span style="font-size:0.82rem;text-align:right;color:var(--color-text-secondary)">' + label + '</span>' +
      "</" + tag + ">";
    }

    // Group by site (gear option, default off): bucket the already-ranked
    // rows preserving first-seen order, so groups sort by their hottest row
    // — the site with the worst offender leads. Row limit / red guarantee /
    // threshold were all applied BEFORE grouping (grouping only changes
    // presentation, never which rows qualify). Same group-header markup as
    // Down Nodes / Down Interfaces, with a neutral count pill (these are
    // rankings, not alarms).
    if ((cfg.groupBy || "none") === "site") {
      var groups = {};
      var order = [];
      shown.forEach(function (r) {
        var k = r.site || "(unknown)";
        if (!groups[k]) { groups[k] = []; order.push(k); }
        groups[k].push(r);
      });
      el.innerHTML = order.map(function (k) {
        var list = groups[k];
        return '<div class="dash-alert-group-header" style="display:flex;align-items:center;gap:8px;margin:6px 0 4px;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.03em;color:var(--color-text-secondary)">' +
          '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(k) + '</span>' +
          '<span class="widget-pill">' + list.length + '</span>' +
        '</div>' + list.map(rowHTML).join("");
      }).join("");
      return;
    }

    el.innerHTML = shown.map(rowHTML).join("");
  }

  /**
   * Shared gear config: row limit + an optional numeric threshold floor.
   * opts.thresholdOptions — [{ value, label }] for the threshold select; omit
   * to hide the threshold control entirely.
   */
  function renderConfig(el, config, onChange, opts) {
    opts = opts || {};
    // Group-by (site buckets, default off) + row-limit control (defaults to
    // the 20-row NOC view) plus the optional threshold floor.
    var html =
      '<label>Group by</label>' +
      '<select data-k="groupBy">' +
        '<option value="none"' + ((config.groupBy || "none") === "none" ? " selected" : "") + '>None</option>' +
        '<option value="site"' + (config.groupBy === "site" ? " selected" : "") + '>Site</option>' +
      '</select>' +
      '<label>Row limit</label>' +
      '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit == null ? 20 : config.rowLimit) + '</select>';
    if (opts.thresholdOptions) {
      html +=
        '<label>' + escapeHtml(opts.thresholdLabel || "Hide below") + '</label>' +
        '<select data-k="threshold">' +
          opts.thresholdOptions.map(function (o) {
            return '<option value="' + o.value + '"' + ((config.threshold == null ? "" : String(config.threshold)) === String(o.value) ? " selected" : "") + '>' + escapeHtml(o.label) + '</option>';
          }).join("") +
        '</select>';
    }
    el.innerHTML = html;
    el.querySelectorAll("[data-k]").forEach(function (s) {
      s.addEventListener("change", function () {
        var k = s.getAttribute("data-k");
        if (k === "threshold") {
          onChange("threshold", s.value === "" ? null : parseFloat(s.value));
        } else if (k === "groupBy") {
          onChange("groupBy", s.value);
        } else {
          onChange("rowLimit", PolarisWidgets.parseRowLimit(s.value));
        }
      });
    });
  }

  window.PolarisTopN = { renderRows: renderRows, renderConfig: renderConfig, pickColor: pickColor };
})();
