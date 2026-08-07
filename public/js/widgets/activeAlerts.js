/**
 * widgets/activeAlerts.js — recent warning/error events as an alert feed
 * (SolarWinds "Needs Attention"). Each row carries a left severity color bar +
 * a level pill, newest first. Data from /dashboard/noc-summary activeAlerts[].
 *
 * Severity filtering rides the shared "Minimum severity" gear control
 * (config.minSeverity), same as every other severity-carrying widget. These
 * rows hold the audit-Event level (info/warning/error), which the shared ladder
 * ranks at informational/warning/critical — so on this widget the notice and
 * serious tiers behave as informational and critical respectively.
 */

(function () {
  var LEVEL_PILL = { info: "widget-pill-watch", warning: "widget-pill-amber", error: "widget-pill-red" };
  var LEVEL_BAR = { info: "#4fc3f7", warning: "#ffa726", error: "#ef5350" };
  var RANK = PolarisWidgets.ALERT_SEVERITY_RANK;
  var DEFAULT_TIER = "warning"; // pre-control default was ["warning","error"]

  function severityOf(r) { return r.severity; }

  // The rank floor to display at. Reads config.minSeverity when present, else
  // folds a pre-control `severities` checkbox array into its lowest rank (so a
  // saved ["info","warning","error"] keeps showing info rows) — an unrepresentable
  // gapped set like ["info","error"] widens to "info and up".
  function minRankOf(config) {
    if (config && config.minSeverity) return PolarisWidgets.minSeverityRank(config);
    if (config && Array.isArray(config.severities) && config.severities.length) {
      return config.severities.reduce(function (lo, s) {
        var r = RANK[s] || 0;
        return r && (lo === 0 || r < lo) ? r : lo;
      }, 0);
    }
    return RANK[DEFAULT_TIER];
  }

  function render(el, rows, config) {
    rows = rows || [];
    var min = minRankOf(config);
    var filtered = rows.filter(function (r) { return (RANK[severityOf(r)] || 0) >= min; });
    // Header export: the configured-severity listing pre the 25-row display
    // slice. These rows carry the audit-Event level (info/warning/error) —
    // ranked by the shared ladder, so "Critical only" = error events.
    PolarisWidgets.setHeaderExport(el, {
      filename: "active-alerts",
      severityOf: severityOf,
      columns: [
        { header: "Hostname", get: function (r) { return r.hostname || ""; } },
        { header: "Message", get: function (r) { return r.message || ""; } },
        { header: "Raised At", get: function (r) { return r.raisedAt ? new Date(r.raisedAt).toISOString() : ""; } },
      ],
      rows: filtered,
    });
    if (!filtered.length) {
      var empty = rows.length ? PolarisWidgets.minSeverityEmptyText({ minSeverity: PolarisWidgets.severityTierForRank(min) }) : null;
      el.innerHTML = '<p class="empty-state">' + escapeHtml(empty || "No active alerts") + '</p>';
      return;
    }
    el.innerHTML = filtered.slice(0, 25).map(function (r) {
      var sev = r.severity || "info";
      var pillCls = LEVEL_PILL[sev] || "widget-pill-watch";
      var bar = LEVEL_BAR[sev] || "#4fc3f7";
      var who = r.hostname ? '<span style="margin-right:6px">' + escapeHtml(r.hostname) + '</span>' : "";
      return '<div class="recent-item" style="border-left:3px solid ' + bar + ';padding-left:8px;cursor:default">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="recent-item-title"><span class="widget-pill ' + pillCls + '" style="margin-right:6px">' + escapeHtml(sev) + '</span>' + who + '</div>' +
          '<div class="recent-item-meta">' + escapeHtml(r.message || "") + '</div>' +
        '</div>' +
        '<span class="recent-item-time">' + timeAgo(r.raisedAt) + '</span>' +
      '</div>';
    }).join("");
  }

  PolarisWidgets.register({
    type: "activeAlerts",
    category: "NOC",
    label: "Active Alerts",
    description: "Recent warning/error events needing attention, newest first.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { minSeverity: DEFAULT_TIER, regionScope: "mine" },
    requiredPermission: { key: "events", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["activeAlerts"]).then(function (d) { return (d && d.activeAlerts) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, data, config);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["activeAlerts"]).then(function (d) { render(el, (d && d.activeAlerts) || [], config); }).catch(function () {});
      }, 30000);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      var now = Date.now();
      render(el, [
        { id: "a1", hostname: "fgt-branch-12", message: "Monitor: fgt-branch-12 up → down", severity: "warning", raisedAt: new Date(now - 6 * 60000).toISOString() },
        { id: "a2", hostname: null, message: "FortiManager DC discovery aborted", severity: "error", raisedAt: new Date(now - 40 * 60000).toISOString() },
      ], { minSeverity: DEFAULT_TIER });
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML = "";
      // Seed the shared control from the effective floor so a pre-control
      // `severities` config renders as the tier it actually behaves like; the
      // first change writes `minSeverity` and the legacy key stops mattering.
      var seed = { minSeverity: PolarisWidgets.severityTierForRank(minRankOf(config)) };
      PolarisWidgets.renderMinSeverityConfig(el, seed, onChange, "Only events at or above this level are listed.");
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
