/**
 * widgets/downNodes.js — monitored assets currently down, grouped by site or
 * division (SolarWinds "Down Nodes" panel). Severity-first: nodes carrying an
 * active automation alert lead (feed sorts alertRank desc), then youngest
 * outage first (monitorStatusChangedAt desc — server-side, so the newest
 * outages survive the cap). Reuses the monitorAlerts row markup (dash-alert
 * classes + alert-severity pill). Data from noc-summary downNodes[].
 */

(function () {
  var TYPE_LABELS = PolarisWidgets.ASSET_TYPE_LABELS;

  function groupKey(node, groupBy) {
    if (groupBy === "division") return node.division || "Ungrouped";
    if (groupBy === "none") return null;
    return node.site || "(unknown)";
  }

  function nodeRowHTML(n) {
    var typeLabel = TYPE_LABELS[n.assetType] || n.assetType || "asset";
    var name = n.hostname || n.ipAddress || "(unnamed)";
    var sub = [escapeHtml(typeLabel)];
    if (n.ipAddress) sub.push('<span class="dash-alert-ip">' + escapeHtml(n.ipAddress) + '</span>');
    var href = '/assets.html#view=asset:' + encodeURIComponent(n.id);
    return '<a class="dash-alert-item" href="' + href + '" data-asset-id="' + escapeHtml(n.id) + '" style="text-decoration:none">' +
      '<div class="dash-alert-row" style="width:100%">' +
        '<div class="dash-alert-body">' +
          '<div class="dash-alert-title">' + (PolarisWidgets.alertSeverityPill ? PolarisWidgets.alertSeverityPill(n.alertSeverity) : "") + escapeHtml(name) + '</div>' +
          '<div class="dash-alert-sub">' + sub.join(" · ") + '</div>' +
        '</div>' +
        '<div class="dash-alert-time" data-changed-at="' + (n.monitorStatusChangedAt || "") + '">' + PolarisWidgets.durationSince(n.monitorStatusChangedAt) + '</div>' +
      '</div>' +
    '</a>';
  }

  // `data` is { nodes, total } — total is the server's TRUE down count
  // (uncapped), stamped on the widget header as a red pill so the operator
  // gets one overall number without summing the per-group pills.
  function render(el, data, config) {
    var nodes = (data && data.nodes) || [];
    var total = (data && data.total != null) ? data.total : nodes.length;
    // Gear "Minimum severity": narrow to nodes carrying an active alert at or
    // above the configured tier, before the count / export / clip. With a filter
    // on, the server's uncapped down total no longer describes what's shown, so
    // the header pill counts the filtered rows instead.
    if (PolarisWidgets.minSeverityRank(config)) {
      nodes = PolarisWidgets.filterByMinSeverity(nodes, config);
      total = nodes.length;
    }
    PolarisWidgets.setHeaderCount(el, total);
    // Header export: the full fetched list (pre-clip), severity-tiered on each
    // node's active automation alert (alertSeverity).
    PolarisWidgets.setHeaderExport(el, {
      filename: "down-nodes",
      columns: [
        { header: "Hostname", get: function (n) { return n.hostname || ""; } },
        { header: "IP Address", get: function (n) { return n.ipAddress || ""; } },
        { header: "Type", get: function (n) { return TYPE_LABELS[n.assetType] || n.assetType || ""; } },
        { header: "Site", get: function (n) { return n.site || ""; } },
        { header: "Division", get: function (n) { return n.division || ""; } },
        { header: "Down Since", get: function (n) { return n.monitorStatusChangedAt ? new Date(n.monitorStatusChangedAt).toISOString() : ""; } },
      ],
      rows: nodes,
    });
    if (!nodes.length) {
      var empty = PolarisWidgets.minSeverityEmptyText(config) || "No nodes down";
      el.innerHTML = '<p class="empty-state">' + escapeHtml(empty) + '</p>';
      return;
    }
    var groupBy = (config && config.groupBy) || "site";
    var clipped = PolarisWidgets.clip(nodes, config && config.rowLimit);

    if (groupBy === "none") {
      el.innerHTML = clipped.map(nodeRowHTML).join("");
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
      '</div>' + list.map(nodeRowHTML).join("");
    }).join("");
  }

  PolarisWidgets.register({
    type: "downNodes",
    category: "Monitoring",
    label: "Down Nodes",
    description: "Monitored assets currently down — newest outages first, grouped by site or division.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { groupBy: "site", rowLimit: 10, regionScope: "mine" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["downNodes"]).then(function (d) {
        return { nodes: (d && d.downNodes) || [], total: d && d.downNodesTotal != null ? d.downNodesTotal : null };
      }).catch(function () { return { nodes: [], total: null }; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, data, config);
      // Click a node → open its asset details slide-in in place (over the
      // dashboard) when openViewModal is loaded; fall back to navigation. Plain
      // left-clicks open in place; ctrl/meta/middle-click keep the href so the
      // operator can still open the Assets page in a new tab. Delegated on el
      // so it survives the 30s re-render (which replaces el's children).
      var onClick = function (ev) {
        if (ev.defaultPrevented || ev.button === 1 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        var link = ev.target.closest(".dash-alert-item[data-asset-id]");
        if (!link || !el.contains(link)) return;
        ev.preventDefault();
        PolarisWidgets.openAssetDetail(link.getAttribute("data-asset-id"));
      };
      el.addEventListener("click", onClick);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["downNodes"]).then(function (d) {
          render(el, { nodes: (d && d.downNodes) || [], total: d && d.downNodesTotal != null ? d.downNodesTotal : null }, config);
        }).catch(function () {});
      }, 30000);
      ctx.onUnmount(function () { clearInterval(timer); el.removeEventListener("click", onClick); });
    },

    renderPreview: function (el) {
      var now = Date.now();
      render(el, { nodes: [
        { id: "p1", hostname: "fs-aisle-3", ipAddress: "10.1.2.5", assetType: "switch", site: "Plant A", division: "Ops", monitorStatus: "down", monitorStatusChangedAt: new Date(now - 9 * 60000).toISOString() },
        { id: "p2", hostname: "fap-conf-rm", ipAddress: "10.1.2.42", assetType: "access_point", site: "Plant A", division: "Ops", monitorStatus: "down", monitorStatusChangedAt: new Date(now - 22 * 60000).toISOString() },
        { id: "p3", hostname: "rtr-wan-2", ipAddress: "10.9.0.1", assetType: "router", site: "DC West", division: "Core", monitorStatus: "down", monitorStatusChangedAt: new Date(now - 2 * 3600000).toISOString() },
      ], total: 3 }, { groupBy: "site", rowLimit: 5 });
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label>Group by</label>' +
        '<select data-k="groupBy">' +
          '<option value="site"' + ((config.groupBy || "site") === "site" ? " selected" : "") + '>Site</option>' +
          '<option value="division"' + (config.groupBy === "division" ? " selected" : "") + '>Division</option>' +
          '<option value="none"' + (config.groupBy === "none" ? " selected" : "") + '>None</option>' +
        '</select>' +
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit) + '</select>';
      el.querySelectorAll("[data-k]").forEach(function (s) {
        s.addEventListener("change", function () {
          var k = s.getAttribute("data-k");
          onChange(k, k === "rowLimit" ? PolarisWidgets.parseRowLimit(s.value) : s.value);
        });
      });
      PolarisWidgets.renderMinSeverityConfig(el, config, onChange,
        "Only nodes with an active alert at or above this severity are shown.");
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
