/**
 * widgets/assetTypes.js — Assets by Type. SVG pie chart by default; bar style
 * is available via the gear menu. Click a slice / bar / legend item to
 * navigate to the assets list filtered by that type.
 */

(function () {
  function renderPie(el, rows, hiddenTypes) {
    var lbls = PolarisWidgets.ASSET_TYPE_LABELS;
    var cols = PolarisWidgets.ASSET_TYPE_COLORS;
    var hidden = new Set(hiddenTypes || []);
    var filtered = rows.filter(function (r) { return !hidden.has(r.assetType); });
    var total = filtered.reduce(function (s, r) { return s + r.count; }, 0);
    if (!total) { el.innerHTML = '<p class="empty-state">No assets to show</p>'; return; }

    var ordered = Object.keys(lbls).map(function (k) {
      var hit = filtered.find(function (r) { return r.assetType === k; });
      return { assetType: k, count: hit ? hit.count : 0 };
    }).filter(function (r) { return r.count > 0; });

    var size = 200, r = 80, cx = size / 2, cy = size / 2;
    var startAngle = -Math.PI / 2;
    var slices = ordered.map(function (row) {
      var frac = row.count / total;
      var endAngle = startAngle + frac * Math.PI * 2;
      var x1 = cx + r * Math.cos(startAngle);
      var y1 = cy + r * Math.sin(startAngle);
      var x2 = cx + r * Math.cos(endAngle);
      var y2 = cy + r * Math.sin(endAngle);
      var largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;
      var d = 'M ' + cx + ' ' + cy + ' L ' + x1 + ' ' + y1 + ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' 1 ' + x2 + ' ' + y2 + ' Z';
      var color = cols[row.assetType] || "#9e9e9e";
      var label = lbls[row.assetType] || row.assetType;
      startAngle = endAngle;
      return { d: d, color: color, label: label, assetType: row.assetType, count: row.count, pct: Math.round(frac * 100) };
    });

    var svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" width="100%" style="max-width:200px;display:block;margin:0 auto">' +
      slices.map(function (s) {
        // Slice separator stroke matches the widget card surface
        // (--color-bg-primary); --color-bg doesn't exist in the theme.
        return '<path d="' + s.d + '" fill="' + s.color + '" stroke="var(--color-bg-primary)" stroke-width="2" class="dash-pie-slice" data-type="' + escapeHtml(s.assetType) + '"><title>' + escapeHtml(s.label) + ' — ' + s.count + ' (' + s.pct + '%)</title></path>';
      }).join("") +
      '</svg>';

    var legend = '<div class="dash-pie-legend">' + slices.map(function (s) {
      var nav = "/assets.html#type=" + encodeURIComponent(s.assetType);
      return '<a class="dash-pie-legend-item" href="' + nav + '" data-type="' + escapeHtml(s.assetType) + '">' +
        '<span class="legend-dot" style="background:' + s.color + '"></span>' +
        '<span class="dash-pie-legend-label">' + escapeHtml(s.label) + '</span>' +
        '<span class="dash-pie-legend-count">' + s.count + '</span>' +
      '</a>';
    }).join("") + '</div>';

    el.innerHTML = '<div class="dash-pie-wrap">' + svg + legend + '</div>';
    Array.prototype.forEach.call(el.querySelectorAll(".dash-pie-slice"), function (path) {
      path.addEventListener("click", function () {
        window.location.href = "/assets.html#type=" + encodeURIComponent(path.getAttribute("data-type"));
      });
    });
  }

  function renderBar(el, rows, hiddenTypes) {
    var lbls = PolarisWidgets.ASSET_TYPE_LABELS;
    var cols = PolarisWidgets.ASSET_TYPE_COLORS;
    var hidden = new Set(hiddenTypes || []);
    var filtered = rows.filter(function (r) { return !hidden.has(r.assetType); });
    if (!filtered.length) { el.innerHTML = '<p class="empty-state">No assets to show</p>'; return; }
    var max = Math.max.apply(null, filtered.map(function (r) { return r.count; }));
    var ordered = Object.keys(lbls).map(function (k) {
      var hit = filtered.find(function (r) { return r.assetType === k; });
      return hit ? hit : null;
    }).filter(Boolean);
    el.innerHTML = '<div style="display:flex;flex-direction:column;gap:6px;padding:4px 0">' +
      ordered.map(function (r) {
        var pct = Math.round((r.count / max) * 100);
        var color = cols[r.assetType] || "#9e9e9e";
        var label = lbls[r.assetType] || r.assetType;
        var nav = "/assets.html#type=" + encodeURIComponent(r.assetType);
        return '<a class="block-util-link" href="' + nav + '" style="display:grid;grid-template-columns:90px 1fr 40px;align-items:center;gap:8px;text-decoration:none">' +
          '<span style="font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(label) + '</span>' +
          '<div class="util-bar-track"><div class="util-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
          '<span style="font-size:0.82rem;text-align:right;color:var(--color-text-secondary)">' + r.count + '</span>' +
        '</a>';
      }).join("") + '</div>';
  }

  // Shared by fetchData and the refresh timer so the two can't drift.
  function fetchCounts() {
    return PolarisWidgets.getSummary({ sections: ["assetTypes"] })
      .then(function (d) { return (d && d.assetTypeCounts) || []; })
      .catch(function () { return []; });
  }

  function render(el, config, rows) {
    el.innerHTML = "";
    if ((config && config.chartStyle) === "bar") renderBar(el, rows || [], config.hiddenTypes);
    else renderPie(el, rows || [], config.hiddenTypes);
  }

  PolarisWidgets.register({
    type: "assetTypes",
    category: "Assets",
    label: "Assets by type",
    description: "Breakdown of monitored assets by type. Click a slice to drill into the matching asset list.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { chartStyle: "pie", hiddenTypes: [] },
    // /dashboard/summary gates the assetTypes section on assets:read, so the
    // widget gates on the same key — without it a role with no asset access
    // could add this and read "No assets to show", which is a false statement
    // about the fleet rather than an empty one.
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (_config) {
      return fetchCounts();
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, config, data);
      var timer = setInterval(function () {
        fetchCounts().then(function (rows) { render(el, config, rows); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      var mock = [
        { assetType: "workstation", count: 312 },
        { assetType: "firewall",    count: 14 },
        { assetType: "switch",      count: 62 },
        { assetType: "access_point", count: 144 },
        { assetType: "server",      count: 38 },
      ];
      renderPie(el, mock, []);
    },

    renderConfig: function (el, config, onChange) {
      var lbls = PolarisWidgets.ASSET_TYPE_LABELS;
      var hidden = new Set(config.hiddenTypes || []);
      el.innerHTML =
        '<label>Chart style</label>' +
        '<select data-k="chartStyle">' +
          '<option value="pie"' + (config.chartStyle !== "bar" ? " selected" : "") + '>Pie</option>' +
          '<option value="bar"' + (config.chartStyle === "bar" ? " selected" : "") + '>Bar</option>' +
        '</select>' +
        '<label>Hide types</label>' +
        '<div style="display:flex;flex-direction:column;gap:3px;max-height:120px;overflow:auto;border:1px solid var(--color-border,rgba(255,255,255,0.1));border-radius:4px;padding:6px;">' +
          Object.keys(lbls).map(function (k) {
            return '<label style="display:flex;gap:6px;align-items:center;font-size:0.8rem;margin:0">' +
              '<input type="checkbox" data-hide="' + k + '"' + (hidden.has(k) ? " checked" : "") + '> ' + escapeHtml(lbls[k]) +
            '</label>';
          }).join("") +
        '</div>';
      el.querySelector('[data-k="chartStyle"]').addEventListener("change", function (e) {
        onChange("chartStyle", e.target.value);
      });
      el.querySelectorAll('input[data-hide]').forEach(function (cb) {
        cb.addEventListener("change", function () {
          if (cb.checked) hidden.add(cb.getAttribute("data-hide"));
          else hidden.delete(cb.getAttribute("data-hide"));
          onChange("hiddenTypes", Array.from(hidden));
        });
      });
    },
  });
})();
