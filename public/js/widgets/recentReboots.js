/**
 * widgets/recentReboots.js — assets that rebooted recently (SolarWinds "Recent
 * Reboots"). Detected from device.reboot Events emitted when an SNMP sysUpTime
 * reading drops. Data from /dashboard/noc-summary recentReboots[].
 */

(function () {
  function render(el, rows) {
    rows = rows || [];
    if (!rows.length) { el.innerHTML = '<p class="empty-state">No recent reboots</p>'; return; }
    el.innerHTML = rows.map(function (r) {
      var name = r.hostname || r.ipAddress || "(unnamed)";
      var meta = r.ipAddress && r.hostname ? escapeHtml(r.ipAddress) : "";
      var nav = r.id ? '/assets.html#view=asset:' + encodeURIComponent(r.id) : null;
      var tag = nav ? "a" : "div";
      var href = nav ? ' href="' + nav + '"' : "";
      return "<" + tag + ' class="recent-item' + (nav ? " recent-item-link" : "") + '"' + href + '><div>' +
        '<div class="recent-item-title"><span>' + escapeHtml(name) + '</span></div>' +
        (meta ? '<div class="recent-item-meta">' + meta + '</div>' : '') +
      '</div><span class="recent-item-time">' + timeAgo(r.rebootedAt) + '</span></' + tag + ">";
    }).join("");
  }

  PolarisWidgets.register({
    type: "recentReboots",
    category: "Monitoring",
    label: "Recent Reboots",
    description: "Devices that rebooted recently (detected from SNMP sysUpTime drops).",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 10, regionScope: "all" },
    requiredPermission: { key: "events", level: "read" },

    fetchData: function (config) {
      var limit = (config && config.rowLimit) || 10;
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config)).then(function (d) { return ((d && d.recentReboots) || []).slice(0, limit); }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, data);
      var timer = setInterval(function () {
        var limit = (config && config.rowLimit) || 10;
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config)).then(function (d) { render(el, ((d && d.recentReboots) || []).slice(0, limit)); }).catch(function () {});
      }, 60000);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      var now = Date.now();
      render(el, [
        { id: "p1", hostname: "core-sw-01", ipAddress: "10.0.0.1", rebootedAt: new Date(now - 35 * 60000).toISOString() },
        { id: "p2", hostname: "edge-fw-02", ipAddress: "10.0.0.2", rebootedAt: new Date(now - 5 * 3600000).toISOString() },
      ]);
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' +
          [5, 10, 20].map(function (n) { return '<option value="' + n + '"' + (config.rowLimit === n ? " selected" : "") + '>' + n + '</option>'; }).join("") +
        '</select>';
      el.querySelector('[data-k="rowLimit"]').addEventListener("change", function (e) {
        onChange("rowLimit", parseInt(e.target.value, 10));
      });
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
