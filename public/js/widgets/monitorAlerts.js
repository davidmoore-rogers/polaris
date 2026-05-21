/**
 * widgets/monitorAlerts.js — assets currently in warning / down. Each row
 * shows hostname / type / IP / discovery source; clicking a row expands it
 * inline to show the dependency tree (parents → self → children) from the
 * asset's /dependencies endpoint plus a link to the full asset modal.
 *
 * Data source: dashboard summary's monitorAlerts[] — pre-fetched by the
 * orchestrator and handed in via the `summary` argument to fetchData.
 */

(function () {
  // Per-widget-instance state lives in a closure keyed by widget element so
  // re-rendering on durations tick doesn't blow away the expanded row.
  var _state = new WeakMap(); // el → { expandedId, depCache: { [assetId]: payload | "loading" | "error" } }

  function getState(el) {
    var s = _state.get(el);
    if (!s) { s = { expandedId: null, depCache: {} }; _state.set(el, s); }
    return s;
  }

  function statusDot(status) {
    if (status === "down") return '<span class="dash-alert-dot dash-alert-down" title="Down"></span>';
    if (status === "warning") return '<span class="dash-alert-dot dash-alert-warning" title="Warning"></span>';
    return '<span class="dash-alert-dot" title="' + escapeHtml(status) + '"></span>';
  }

  function filterBySeverity(rows, severity) {
    if (severity === "downOnly") return rows.filter(function (r) { return r.monitorStatus === "down"; });
    return rows;
  }

  function sourceLabel(a) {
    if (a.discoveredByIntegration && a.discoveredByIntegration.name) return a.discoveredByIntegration.name;
    return "Manual";
  }

  function subtitleHTML(a, typeLabel) {
    var parts = [escapeHtml(typeLabel), escapeHtml(a.monitorStatus)];
    if (a.ipAddress) parts.push('<span class="dash-alert-ip">' + escapeHtml(a.ipAddress) + '</span>');
    parts.push('<span class="dash-alert-source">' + escapeHtml(sourceLabel(a)) + '</span>');
    return parts.join(" · ");
  }

  function statusPip(node) {
    if (!node || node.monitored === false) return '<span class="dep-tree-pip dep-tree-pip-unmon" title="Unmonitored">●</span>';
    if (node.dependencySuppressed && node.monitorStatus !== "down") {
      return '<span class="dep-tree-pip dep-tree-pip-dep" title="Dep. Down — upstream parent is offline">●</span>';
    }
    switch (node.monitorStatus) {
      case "up":         return '<span class="dep-tree-pip dep-tree-pip-up"   title="Up">▲</span>';
      case "warning":    return '<span class="dep-tree-pip dep-tree-pip-warn" title="Warning">▲</span>';
      case "recovering": return '<span class="dep-tree-pip dep-tree-pip-rec"  title="Recovering">▲</span>';
      case "down":       return '<span class="dep-tree-pip dep-tree-pip-down" title="Down">▼</span>';
      default:           return '<span class="dep-tree-pip dep-tree-pip-unk"  title="Pending">●</span>';
    }
  }

  var TYPE_LABEL = { firewall: "firewall", switch: "switch", access_point: "access point" };

  function depRow(node, opts) {
    opts = opts || {};
    var name = node.hostname || node.id;
    var typeLabel = TYPE_LABEL[node.assetType] || node.assetType || "asset";
    var hostHTML;
    if (opts.self) {
      var layerBit = (node.dependencyLayer != null) ? ' <span class="dep-tree-self-meta">— level ' + node.dependencyLayer + '</span>' : "";
      hostHTML = '<strong class="dep-tree-self">' + escapeHtml(name) + '</strong>' + layerBit;
    } else {
      var href = '/assets.html#view=asset:' + encodeURIComponent(node.id);
      hostHTML = '<a class="dep-tree-link" href="' + href + '" title="Open ' + escapeHtml(name) + '">' + escapeHtml(name) + '</a>';
    }
    var depthClass = opts.depth ? ' dep-tree-row-depth-' + opts.depth : '';
    return '<div class="dep-tree-row' + (opts.self ? ' dep-tree-row-self' : '') + depthClass + '">' +
      statusPip(node) + ' ' + hostHTML +
      ' <span class="dep-tree-type">' + escapeHtml(typeLabel) + '</span>' +
    '</div>';
  }

  function renderDepTree(payload, assetId) {
    if (payload === "loading") return '<div class="empty-state" style="text-align:left;padding:0.5rem 0">Loading dependency tree…</div>';
    if (payload === "error" || !payload) return '<div class="empty-state" style="text-align:left;padding:0.5rem 0">Couldn\'t load dependency tree.</div>';
    var parents  = Array.isArray(payload.effectiveParents) ? payload.effectiveParents : [];
    var children = Array.isArray(payload.children)         ? payload.children         : [];
    var self     = payload.asset || { id: assetId };
    var openHref = '/assets.html#view=asset:' + encodeURIComponent(assetId);
    var openLink = '<a class="dash-alert-open" href="' + openHref + '">Open asset details →</a>';

    if (parents.length === 0 && children.length === 0) {
      return '<div class="dep-tree-empty" style="margin:0 0 0.5rem">Standalone — not part of any discovered dependency chain.</div>' + openLink;
    }

    var parentsHTML = "";
    if (parents.length > 0) {
      parentsHTML = parents.map(function (p) { return depRow({
        id: p.parent.id, hostname: p.parent.hostname, assetType: p.parent.assetType,
        dependencyLayer: p.parent.dependencyLayer, monitorStatus: p.parent.monitorStatus,
        monitored: p.parent.monitored,
      }); }).join("");
      parentsHTML += '<div class="dep-tree-connector">│</div>';
    }
    var selfHTML = depRow({
      id: self.id, hostname: self.hostname, assetType: self.assetType,
      dependencyLayer: self.dependencyLayer,
      monitorStatus: null, monitored: true,
      dependencySuppressed: !!self.dependencySuppressed,
    }, { self: true });
    var childrenHTML = "";
    if (children.length > 0) {
      childrenHTML += '<div class="dep-tree-connector">│</div>';
      childrenHTML += children.map(function (c) {
        var row = depRow(c, { depth: 1 });
        var gcs = Array.isArray(c.grandchildren) ? c.grandchildren : [];
        if (gcs.length === 0) return row;
        return row + gcs.map(function (gc) { return depRow(gc, { depth: 2 }); }).join("");
      }).join("");
    }
    return '<div class="dep-tree-body" style="margin-bottom:0.5rem">' + parentsHTML + selfHTML + childrenHTML + '</div>' + openLink;
  }

  function renderRows(el, alerts, overflow, config) {
    var st = getState(el);
    var rowLimit = (config && config.rowLimit) || 10;
    var visible = filterBySeverity(alerts, (config && config.severity) || "warningAndDown");
    var clipped = visible.slice(0, rowLimit);
    var lbls = PolarisWidgets.ASSET_TYPE_LABELS;
    if (!clipped.length) {
      el.innerHTML = '<p class="empty-state">All monitored assets healthy</p>';
      return;
    }
    // If the previously-expanded row is no longer visible, drop the expansion.
    if (st.expandedId && !clipped.some(function (a) { return a.id === st.expandedId; })) {
      st.expandedId = null;
    }
    var rows = clipped.map(function (a) {
      var typeLabel = lbls[a.assetType] || a.assetType;
      var hostname = a.hostname || a.ipAddress || "(unnamed)";
      var isExpanded = st.expandedId === a.id;
      var expandedHTML = "";
      if (isExpanded) {
        var dep = st.depCache[a.id];
        expandedHTML = '<div class="dash-alert-expand" data-expand-for="' + escapeHtml(a.id) + '">' +
          renderDepTree(dep, a.id) +
        '</div>';
      }
      return '<div class="dash-alert-item' + (isExpanded ? ' is-expanded' : '') + '">' +
        '<button type="button" class="dash-alert-row" data-asset-id="' + escapeHtml(a.id) + '" aria-expanded="' + (isExpanded ? "true" : "false") + '">' +
          statusDot(a.monitorStatus) +
          '<div class="dash-alert-body">' +
            '<div class="dash-alert-title">' + escapeHtml(hostname) + '</div>' +
            '<div class="dash-alert-sub">' + subtitleHTML(a, typeLabel) + '</div>' +
          '</div>' +
          '<div class="dash-alert-time" data-changed-at="' + (a.monitorStatusChangedAt || "") + '">' + PolarisWidgets.durationSince(a.monitorStatusChangedAt) + '</div>' +
        '</button>' +
        expandedHTML +
      '</div>';
    }).join("");
    var more = (visible.length > clipped.length) || overflow
      ? '<p class="empty-state" style="text-align:left;margin-top:8px">+ more — see <a href="/assets.html">Assets</a></p>'
      : "";
    el.innerHTML = rows + more;
  }

  function wireClicks(el, alerts, overflow, config) {
    el.addEventListener("click", function (ev) {
      // Clicks on links inside the expanded panel (Open asset details, hostname pivots)
      // should navigate normally and not toggle the row.
      if (ev.target.closest(".dash-alert-expand a")) return;
      var btn = ev.target.closest(".dash-alert-row");
      if (!btn || !el.contains(btn)) return;
      var id = btn.getAttribute("data-asset-id");
      if (!id) return;
      var st = getState(el);
      if (st.expandedId === id) {
        st.expandedId = null;
      } else {
        st.expandedId = id;
        if (!st.depCache[id]) {
          st.depCache[id] = "loading";
          renderRows(el, alerts, overflow, config);
          api.assets.getDependencies(id)
            .then(function (payload) { st.depCache[id] = payload || null; })
            .catch(function () { st.depCache[id] = "error"; })
            .then(function () {
              // Only re-render if this asset is still the expanded one.
              if (st.expandedId === id) renderRows(el, alerts, overflow, config);
            });
          return; // initial render above already shows "Loading…"
        }
      }
      renderRows(el, alerts, overflow, config);
    });
  }

  PolarisWidgets.register({
    type: "monitorAlerts",
    label: "Monitor alerts",
    description: "Monitored assets currently in warning or down state, newest transitions first.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { rowLimit: 10, severity: "warningAndDown" },

    fetchData: function (_config, summary) {
      return Promise.resolve({
        alerts:   (summary && summary.monitorAlerts) || [],
        overflow: !!(summary && summary.monitorAlertsOverflow),
      });
    },

    renderInstance: function (el, config, data, ctx) {
      el.innerHTML = "";
      renderRows(el, data.alerts || [], data.overflow, config);
      wireClicks(el, data.alerts || [], data.overflow, config);
      // Re-tick durations every 30s without re-fetching. Preserves expanded state
      // via the WeakMap in getState().
      var timer = setInterval(function () { renderRows(el, data.alerts || [], data.overflow, config); }, 30000);
      ctx.onUnmount(function () { clearInterval(timer); _state.delete(el); });
    },

    renderPreview: function (el) {
      var mock = [
        { id: "m1", hostname: "fgt-branch-12",  assetType: "firewall",     ipAddress: "10.1.0.1", discoveredByIntegration: { name: "FMG-Main", type: "fortimanager" }, monitorStatus: "down",    monitorStatusChangedAt: new Date(Date.now() - 18 * 60 * 1000).toISOString() },
        { id: "m2", hostname: "fs-1024d-aisle-3", assetType: "switch",     ipAddress: "10.1.2.5", discoveredByIntegration: { name: "FMG-Main", type: "fortimanager" }, monitorStatus: "warning", monitorStatusChangedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString() },
        { id: "m3", hostname: "fap-231f-conf-rm",  assetType: "access_point", ipAddress: "10.1.2.42", discoveredByIntegration: { name: "FMG-Main", type: "fortimanager" }, monitorStatus: "down", monitorStatusChangedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString() },
      ];
      renderRows(el, mock, false, { rowLimit: 3, severity: "warningAndDown" });
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label>Show</label>' +
        '<select data-k="severity">' +
          '<option value="warningAndDown"' + (config.severity === "warningAndDown" ? " selected" : "") + '>Warning + Down</option>' +
          '<option value="downOnly"' + (config.severity === "downOnly" ? " selected" : "") + '>Down only</option>' +
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
    },
  });
})();
