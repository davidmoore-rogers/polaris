/**
 * widgets/activeAlerts.js — recent warning/error events as an alert feed
 * (SolarWinds "Needs Attention"). Each row carries a left severity color bar +
 * a level pill, newest first. Data from /dashboard/noc-summary activeAlerts[].
 */

(function () {
  var LEVEL_PILL = { info: "widget-pill-watch", warning: "widget-pill-amber", error: "widget-pill-red" };
  var LEVEL_BAR = { info: "#4fc3f7", warning: "#ffa726", error: "#ef5350" };

  function render(el, rows, config) {
    rows = rows || [];
    var allowed = (config && Array.isArray(config.severities) && config.severities.length) ? config.severities : ["warning", "error"];
    var filtered = rows.filter(function (r) { return allowed.indexOf(r.severity) !== -1; });
    // Header export: the configured-severity listing pre the 25-row display
    // slice. These rows carry the audit-Event level (info/warning/error) —
    // ranked by the shared ladder, so "Critical only" = error events.
    PolarisWidgets.setHeaderExport(el, {
      filename: "active-alerts",
      severityOf: function (r) { return r.severity; },
      columns: [
        { header: "Hostname", get: function (r) { return r.hostname || ""; } },
        { header: "Message", get: function (r) { return r.message || ""; } },
        { header: "Raised At", get: function (r) { return r.raisedAt ? new Date(r.raisedAt).toISOString() : ""; } },
      ],
      rows: filtered,
    });
    if (!filtered.length) { el.innerHTML = '<p class="empty-state">No active alerts</p>'; return; }
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
    defaultConfig: { severities: ["warning", "error"], regionScope: "mine" },
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
      ], { severities: ["warning", "error"] });
    },

    renderConfig: function (el, config, onChange) {
      var current = new Set((config && config.severities) || ["warning", "error"]);
      el.innerHTML =
        '<label>Show severities</label>' +
        ["info", "warning", "error"].map(function (lv) {
          return '<label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;margin:3px 0">' +
            '<input type="checkbox" data-sev="' + lv + '"' + (current.has(lv) ? " checked" : "") + '> ' + escapeHtml(lv) +
          '</label>';
        }).join("");
      el.querySelectorAll("input[data-sev]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          if (cb.checked) current.add(cb.getAttribute("data-sev"));
          else current.delete(cb.getAttribute("data-sev"));
          onChange("severities", Array.from(current));
        });
      });
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
