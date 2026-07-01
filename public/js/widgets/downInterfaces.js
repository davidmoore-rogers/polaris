/**
 * widgets/downInterfaces.js — interfaces that are administratively up but
 * operationally down (a real link fault, not an operator-disabled port),
 * grouped by the gate they live on. Mirrors the Down Nodes widget: same
 * statusDot + dash-alert row markup, same group-header + count-pill grouping,
 * click a row to open the owning asset's details. Data from noc-summary
 * downInterfaces[].
 */

(function () {
  var TYPE_LABELS = PolarisWidgets.ASSET_TYPE_LABELS;

  function groupKey(iface, groupBy) {
    if (groupBy === "none") return null;
    return iface.gate || "(unknown)";
  }

  function ifaceRowHTML(n) {
    var typeLabel = TYPE_LABELS[n.assetType] || n.assetType || "asset";
    var host = n.hostname || n.ipAddress || "(unnamed)";
    var title = escapeHtml(n.ifName || "(interface)");
    if (n.ifLabel) title += ' <span class="dash-alert-ip">' + escapeHtml(n.ifLabel) + '</span>';
    var sub = [escapeHtml(host), escapeHtml(typeLabel)];
    var href = '/assets.html#view=asset:' + encodeURIComponent(n.assetId);
    return '<a class="dash-alert-item" href="' + href + '" data-asset-id="' + escapeHtml(n.assetId) + '" style="text-decoration:none">' +
      '<div class="dash-alert-row" style="width:100%">' +
        '<span class="dash-alert-dot dash-alert-down" title="Interface down"></span>' +
        '<div class="dash-alert-body">' +
          '<div class="dash-alert-title">' + title + '</div>' +
          '<div class="dash-alert-sub">' + sub.join(" · ") + '</div>' +
        '</div>' +
        '<div class="dash-alert-time" data-changed-at="' + (n.lastUpAt || "") + '" title="Down since last seen up">' +
          (n.lastUpAt ? PolarisWidgets.durationSince(n.lastUpAt) : "—") +
        '</div>' +
      '</div>' +
    '</a>';
  }

  function render(el, ifaces, config) {
    ifaces = ifaces || [];
    if (!ifaces.length) { el.innerHTML = '<p class="empty-state">No interfaces down</p>'; return; }
    var rowLimit = (config && config.rowLimit) || 10;
    var groupBy = (config && config.groupBy) || "gate";
    var clipped = ifaces.slice(0, rowLimit);

    if (groupBy === "none") {
      el.innerHTML = clipped.map(ifaceRowHTML).join("");
      return;
    }
    // Bucket into groups preserving first-seen order; sort groups by size desc.
    var groups = {};
    var order = [];
    clipped.forEach(function (n) {
      var k = groupKey(n, groupBy);
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(n);
    });
    order.sort(function (a, b) { return groups[b].length - groups[a].length; });
    el.innerHTML = order.map(function (k) {
      var list = groups[k];
      return '<div class="dash-alert-group-header" style="display:flex;align-items:center;gap:8px;margin:6px 0 4px;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.03em;color:var(--color-text-secondary)">' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(k) + '</span>' +
        '<span class="widget-pill widget-pill-red">' + list.length + '</span>' +
      '</div>' + list.map(ifaceRowHTML).join("");
    }).join("");
  }

  PolarisWidgets.register({
    type: "downInterfaces",
    category: "Monitoring",
    label: "Down Interfaces",
    description: "Interfaces admin-up but operationally down, grouped by the gate they're on.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { groupBy: "gate", rowLimit: 10, regionScope: "mine" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config)).then(function (d) { return (d && d.downInterfaces) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, data, config);
      // Click a row → open the owning asset's details slide-in in place. Plain
      // left-clicks open in place; ctrl/meta/middle-click keep the href so the
      // operator can open the Assets page in a new tab. Delegated on el so it
      // survives the 30s re-render.
      var onClick = function (ev) {
        if (ev.defaultPrevented || ev.button === 1 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        var link = ev.target.closest(".dash-alert-item[data-asset-id]");
        if (!link || !el.contains(link)) return;
        ev.preventDefault();
        PolarisWidgets.openAssetDetail(link.getAttribute("data-asset-id"));
      };
      el.addEventListener("click", onClick);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config)).then(function (d) { render(el, (d && d.downInterfaces) || [], config); }).catch(function () {});
      }, 30000);
      ctx.onUnmount(function () { clearInterval(timer); el.removeEventListener("click", onClick); });
    },

    renderPreview: function (el) {
      var now = Date.now();
      render(el, [
        { assetId: "p1", hostname: "fs-aisle-3", ipAddress: "10.1.2.5", assetType: "switch", ifName: "port12", ifLabel: "AP uplink", gate: "fgt-plant-a", lastUpAt: new Date(now - 9 * 60000).toISOString() },
        { assetId: "p2", hostname: "fs-aisle-3", ipAddress: "10.1.2.5", assetType: "switch", ifName: "port24", ifLabel: null, gate: "fgt-plant-a", lastUpAt: new Date(now - 41 * 60000).toISOString() },
        { assetId: "p3", hostname: "fgt-dc-west", ipAddress: "10.9.0.1", assetType: "firewall", ifName: "wan2", ifLabel: "Backup ISP", gate: "fgt-dc-west", lastUpAt: new Date(now - 3 * 3600000).toISOString() },
      ], { groupBy: "gate", rowLimit: 5 });
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label>Group by</label>' +
        '<select data-k="groupBy">' +
          '<option value="gate"' + ((config.groupBy || "gate") === "gate" ? " selected" : "") + '>Gate</option>' +
          '<option value="none"' + (config.groupBy === "none" ? " selected" : "") + '>None</option>' +
        '</select>' +
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' +
          [5, 10, 20].map(function (n) { return '<option value="' + n + '"' + (config.rowLimit === n ? " selected" : "") + '>' + n + '</option>'; }).join("") +
        '</select>';
      el.querySelectorAll("[data-k]").forEach(function (s) {
        s.addEventListener("change", function () {
          var k = s.getAttribute("data-k");
          onChange(k, k === "rowLimit" ? parseInt(s.value, 10) : s.value);
        });
      });
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
