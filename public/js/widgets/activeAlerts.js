/**
 * widgets/activeAlerts.js — the ACTIVE ALERTS feed (SolarWinds "Needs
 * Attention"). One row per uncleared Notification, severity-first then newest,
 * each with a left severity color bar + a severity pill. Data from
 * /dashboard/noc-summary activeAlerts[].
 *
 * These are ALERTS, not audit Events. The widget used to list every warning/
 * error Event, which made it wrong twice over: raw discovery/sync failures no
 * automation covered appeared as permanent alerts (nothing clears an Event, so
 * they sat for the full 7-day retention), and the pill showed `Event.level`,
 * which collapses critical AND serious into "error" — so a `serious` automation
 * read as "error". A row now appears only because an automation raised it,
 * wears that automation's own severity (notice / warning / serious / critical),
 * and leaves when the alert clears.
 *
 * Severity filtering rides the shared "Minimum severity" gear control
 * (config.minSeverity), same as every other severity-carrying widget — and now
 * against the automation ladder these rows are actually built from, so
 * "Serious and up" means serious-and-up rather than the Event-level
 * approximation it used to.
 */

(function () {
  // The automation ladder's own pills/bars. Event levels stay mapped at their
  // pill-equivalent ranks (index.js ALERT_SEVERITY_RANK / ALERT_SEV_PILL) so a
  // pre-upgrade cached payload still renders.
  var SEV_PILL = {
    notice: "widget-pill-neutral",
    informational: "widget-pill-watch", info: "widget-pill-watch",
    warning: "widget-pill-amber",
    serious: "widget-pill-orange",
    critical: "widget-pill-red", error: "widget-pill-red",
  };
  var SEV_BAR = {
    notice: "#9e9e9e",
    informational: "#4fc3f7", info: "#4fc3f7",
    warning: "#ffa726",
    serious: "#ff7043",
    critical: "#ef5350", error: "#ef5350",
  };
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
    // slice. Severity is the raising automation's own tier, so "Critical only"
    // = critical automations rather than the old error-level Events.
    PolarisWidgets.setHeaderExport(el, {
      filename: "active-alerts",
      severityOf: severityOf,
      columns: [
        { header: "Hostname", get: function (r) { return r.hostname || ""; } },
        { header: "Automation", get: function (r) { return r.ruleName || ""; } },
        { header: "Message", get: function (r) { return r.message || ""; } },
        { header: "Acknowledged By", get: function (r) { return r.acknowledgedBy || ""; } },
        { header: "Raised At", get: function (r) { return r.raisedAt ? new Date(r.raisedAt).toISOString() : ""; } },
      ],
      rows: filtered,
    });
    // Header severity breakdown of the alerts on screen — the 25-row display
    // slice, not the whole configured-severity listing. Every alert HAS a
    // severity, so nothing lands in a grey bucket and "omit" only guards a row
    // with an unknown one.
    var displayed = filtered.slice(0, 25);
    PolarisWidgets.setHeaderSeverityCounts(el, displayed, { unalerted: "omit", severityOf: severityOf });
    if (!filtered.length) {
      var empty = rows.length ? PolarisWidgets.minSeverityEmptyText({ minSeverity: PolarisWidgets.severityTierForRank(min) }) : null;
      el.innerHTML = '<p class="empty-state">' + escapeHtml(empty || "No active alerts") + '</p>';
      return;
    }
    el.innerHTML = displayed.map(function (r) {
      var sev = r.severity || "info";
      var pillCls = SEV_PILL[sev] || "widget-pill-watch";
      var bar = SEV_BAR[sev] || "#4fc3f7";
      // The automation's name is the row's title — it says what KIND of problem
      // this is, which the message alone often doesn't. The device follows it.
      var title = r.ruleName ? '<span style="margin-right:6px">' + escapeHtml(r.ruleName) + '</span>' : "";
      var who = r.hostname ? '<span style="margin-right:6px;color:var(--color-text-secondary)">' + escapeHtml(r.hostname) + '</span>' : "";
      // An acknowledged alert is still active — hiding it would surprise, so it
      // stays listed and says who has it, and the row dims to push the
      // unhandled alerts forward on a wallboard.
      var ack = r.acknowledged
        ? '<span class="widget-pill widget-pill-neutral" style="margin-left:4px" title="' +
          escapeHtml("Acknowledged" + (r.acknowledgedBy ? " by " + r.acknowledgedBy : "")) + '">ack</span>'
        : "";
      return '<div class="recent-item" style="border-left:3px solid ' + bar + ';padding-left:8px;cursor:default' +
        (r.acknowledged ? ";opacity:.6" : "") + '">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="recent-item-title"><span class="widget-pill ' + pillCls + '" style="margin-right:6px">' + escapeHtml(sev) + '</span>' + title + who + ack + '</div>' +
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
    description: "Alerts your automations have raised and nothing has cleared, most severe first.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { minSeverity: DEFAULT_TIER, regionScope: "mine" },
    // The feed reads Notification rows, so this is alerts:read, not events:read.
    // Every role was seeded that key at read, so no dashboard loses the widget.
    requiredPermission: { key: "alerts", level: "read" },

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
        { id: "a1", hostname: "fgt-branch-12", ruleName: "Asset down", message: "fgt-branch-12 is down", severity: "critical", acknowledged: false, raisedAt: new Date(now - 6 * 60000).toISOString() },
        { id: "a2", hostname: "core-sw-1", ruleName: "IPsec tunnel down", message: "core-sw-1: IPsec tunnel Overlay-2 is down", severity: "serious", acknowledged: true, acknowledgedBy: "dmoore", raisedAt: new Date(now - 40 * 60000).toISOString() },
      ], { minSeverity: DEFAULT_TIER });
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML = "";
      // Seed the shared control from the effective floor so a pre-control
      // `severities` config renders as the tier it actually behaves like; the
      // first change writes `minSeverity` and the legacy key stops mattering.
      var seed = { minSeverity: PolarisWidgets.severityTierForRank(minRankOf(config)) };
      PolarisWidgets.renderMinSeverityConfig(el, seed, onChange, "Only alerts at or above this severity are listed.");
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
