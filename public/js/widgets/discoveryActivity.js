/**
 * widgets/discoveryActivity.js — in-flight discoveries. Refreshes every 10s
 * while the widget is mounted so an operator can watch the progress count
 * climb without leaving the page. Permission-gated on integrations:read.
 */

(function () {
  function fmtElapsed(ms) {
    if (ms == null) return "—";
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    return m + "m " + ((s % 60) < 10 ? "0" : "") + (s % 60) + "s";
  }

  function renderRows(el, runs) {
    if (!runs.length) { el.innerHTML = '<p class="empty-state">No discoveries running</p>'; return; }
    el.innerHTML = runs.map(function (r) {
      var pillCls = r.slow ? "widget-pill-amber" : "widget-pill-watch";
      var progress = "";
      if (r.totalDevices != null) {
        var done = (r.completedCount || 0) + (r.skippedOfflineCount || 0) + (r.skippedErrorCount || 0);
        var pct = Math.min(100, Math.round((done / Math.max(1, r.totalDevices)) * 100));
        progress = '<div class="util-bar-track" style="margin-top:4px"><div class="util-bar-fill" style="width:' + pct + '%;background:#4fc3f7"></div></div>' +
          '<div style="font-size:0.72rem;color:var(--color-text-tertiary);margin-top:2px">' + done + ' / ' + r.totalDevices + (r.skippedOfflineCount ? ' · ' + r.skippedOfflineCount + ' offline' : '') + '</div>';
      }
      return '<div class="recent-item" style="cursor:default">' +
        '<div style="flex:1">' +
          '<div class="recent-item-title"><span>' + escapeHtml(r.name || "(unnamed)") + '</span><span class="widget-pill ' + pillCls + '" style="margin-left:6px">' + escapeHtml(r.type) + '</span></div>' +
          '<div class="recent-item-meta">' + fmtElapsed(r.elapsedMs) + (r.slow ? ' · running slow' : '') + '</div>' +
          progress +
        '</div>' +
      '</div>';
    }).join("");
  }

  PolarisWidgets.register({
    type: "discoveryActivity",
    category: "Discovery",
    label: "Discovery activity",
    description: "In-flight integration discoveries with per-run progress and slow-run amber telemetry.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: {},
    requiredPermission: { key: "integrations", level: "read" },

    fetchData: function () {
      return api.integrations.discoveries().catch(function () { return []; });
    },

    renderInstance: function (el, _config, data, ctx) {
      var runs = data || [];
      renderRows(el, runs);
      var timer = setInterval(function () {
        api.integrations.discoveries().then(function (next) { renderRows(el, next || []); }).catch(function () {});
      }, PolarisWidgets.REFRESH.fast);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      renderRows(el, [
        { name: "Main DC FortiManager", type: "fortimanager", elapsedMs: 47000, slow: false, totalDevices: 86, completedCount: 41, skippedOfflineCount: 2, skippedErrorCount: 0 },
        { name: "Corp Active Directory", type: "activedirectory", elapsedMs: 12000, slow: false, totalDevices: null },
      ]);
    },
  });
})();
