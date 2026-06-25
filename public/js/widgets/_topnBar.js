/**
 * widgets/_topnBar.js — shared renderer for the NOC top-N metric widgets
 * (Highest CPU, Highest Memory, Slowest Response, Packet Loss). These four are
 * structurally identical: a ranked list of { id, hostname, ipAddress, value }
 * rows drawn as a name + utilization bar + value, with per-widget units, color
 * thresholds, and an optional value floor. Underscore-prefixed = internal
 * helper; it registers no widget of its own.
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
    return value + "%";
  }

  /**
   * el       — widget body
   * rows     — [{ id, hostname, ipAddress, value }]
   * opts     — { unit:"%"|"ms", thresholds, baseColor, emptyText, config, fillTo }
   *            config: { rowLimit, threshold }
   *            fillTo: when set (e.g. 20), guarantee a floor of that many rows —
   *            if the threshold filter leaves fewer, pad up to `fillTo` with the
   *            next-highest below-threshold rows so the widget never looks empty.
   *            When more rows pass the threshold than `fillTo`, all of them show
   *            (height + auto-scroll governs). Omit to leave the threshold as a
   *            hard filter (e.g. Packet Loss, where padding 0%-loss rows misleads).
   */
  function renderRows(el, rows, opts) {
    opts = opts || {};
    var cfg = opts.config || {};
    var sorted = (rows || []).slice().sort(function (a, b) { return (b.value || 0) - (a.value || 0); });
    var shown = sorted;
    if (cfg.threshold != null) {
      var passing = sorted.filter(function (r) { return (r.value || 0) >= cfg.threshold; });
      // fillTo: pad up to the floor with the next-highest rows (sorted is desc,
      // so the top `fillTo` already = all passing + the next-highest below it).
      shown = (opts.fillTo && passing.length < opts.fillTo) ? sorted.slice(0, opts.fillTo) : passing;
    }
    // No upper row cap — the widget's fixed height (1×/2×/3×) plus auto-scroll
    // governs how much is visible; all qualifying rows are rendered.
    if (!shown.length) {
      el.innerHTML = '<p class="empty-state">' + escapeHtml(opts.emptyText || "Nothing to show") + '</p>';
      return;
    }
    // Percentages scale against a fixed 100; latency scales against the max in
    // the visible set so the slowest node fills the bar.
    var scaleMax = opts.unit === "%"
      ? 100
      : (Math.max.apply(null, shown.map(function (r) { return r.value || 0; })) || 1);

    el.innerHTML = shown.map(function (r) {
      var v = r.value || 0;
      var pct = Math.min(100, Math.round((v / scaleMax) * 100));
      var color = pickColor(v, opts.thresholds, opts.baseColor);
      var name = escapeHtml(r.hostname || r.ipAddress || "(unnamed)");
      var label = formatValue(v, opts.unit);
      var tag = r.id ? "a" : "div";
      var nav = r.id ? ' href="/assets.html#view=asset:' + encodeURIComponent(r.id) + '"' : "";
      return "<" + tag + ' class="recent-item' + (r.id ? " recent-item-link" : "") + '"' + nav +
        ' style="display:grid;grid-template-columns:1fr 90px 48px;align-items:center;gap:8px;text-decoration:none">' +
        '<span class="recent-item-title" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + name + '</span>' +
        '<div class="util-bar-track"><div class="util-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
        '<span style="font-size:0.82rem;text-align:right;color:var(--color-text-secondary)">' + label + '</span>' +
      "</" + tag + ">";
    }).join("");
  }

  /**
   * Shared gear config: row limit + an optional numeric threshold floor.
   * opts.thresholdOptions — [{ value, label }] for the threshold select; omit
   * to hide the threshold control entirely.
   */
  function renderConfig(el, config, onChange, opts) {
    opts = opts || {};
    // No row-limit control — height (1×/2×/3×) + auto-scroll governs visible
    // rows. Only the optional threshold floor remains.
    var html = "";
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
        } else {
          onChange("rowLimit", parseInt(s.value, 10));
        }
      });
    });
  }

  window.PolarisTopN = { renderRows: renderRows, renderConfig: renderConfig, pickColor: pickColor };
})();
