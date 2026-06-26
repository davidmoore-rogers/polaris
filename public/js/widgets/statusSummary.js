/**
 * widgets/statusSummary.js — NOC status tiles. Compact color-coded counts of
 * monitored assets by state (Total / Up / Down / Warning / Unknown), plus an
 * infra Uptime% gauge and an active-Alerts count. Data from
 * /dashboard/noc-summary. The gear toggles which tiles appear.
 */

(function () {
  // Tile catalog: id → { label, color, value(data) }. Color drives the tile's
  // left border + number. Uptime / alerts colors are computed per-value.
  var TILE_DEFS = [
    { id: "total",   label: "Total",   color: "#90a4ae", val: function (d) { return d.statusCounts.total; } },
    { id: "up",      label: "Up",      color: "#66bb6a", val: function (d) { return d.statusCounts.up; } },
    { id: "down",    label: "Down",    color: "#ef5350", val: function (d) { return d.statusCounts.down; } },
    { id: "warning", label: "Warning", color: "#ffa726", val: function (d) { return d.statusCounts.warning; } },
    { id: "unknown", label: "Unknown", color: "#90a4ae", val: function (d) { return d.statusCounts.unknown; } },
    { id: "uptime",  label: "Uptime",  color: null,      val: function (d) { return d.uptimePercent; } },
    { id: "alerts",  label: "Alerts",  color: null,      val: function (d) { return d.activeAlertCount; } },
  ];
  var ALL_IDS = TILE_DEFS.map(function (t) { return t.id; });

  function uptimeColor(pct) { return pct >= 98 ? "#66bb6a" : pct >= 95 ? "#ffa726" : "#ef5350"; }

  function tileHTML(def, data) {
    var raw = def.val(data);
    var color = def.color;
    var display;
    if (def.id === "uptime") {
      display = raw == null ? "—" : raw + "%";
      color = raw == null ? "#90a4ae" : uptimeColor(raw);
    } else if (def.id === "alerts") {
      display = raw == null ? 0 : raw;
      color = raw > 0 ? "#ef5350" : "#66bb6a";
    } else {
      display = raw == null ? 0 : raw;
    }
    return '<div style="border-left:3px solid ' + color + ';padding:6px 10px;background:var(--color-surface-2,rgba(255,255,255,0.03));border-radius:4px;min-width:0">' +
      '<div style="font-size:1.5rem;font-weight:600;line-height:1.1;color:' + color + '">' + escapeHtml(String(display)) + '</div>' +
      '<div style="font-size:0.72rem;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.03em">' + escapeHtml(def.label) + '</div>' +
    '</div>';
  }

  function renderTiles(el, data, config) {
    if (!data || !data.statusCounts) { el.innerHTML = '<p class="empty-state">No monitored assets</p>'; return; }
    var wanted = (config && Array.isArray(config.tiles) && config.tiles.length) ? config.tiles : ALL_IDS;
    var defs = TILE_DEFS.filter(function (t) { return wanted.indexOf(t.id) !== -1; });
    el.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(82px,1fr));gap:8px">' +
      defs.map(function (def) { return tileHTML(def, data); }).join("") +
    '</div>';
  }

  PolarisWidgets.register({
    type: "statusSummary",
    category: "Monitoring",
    label: "Status summary",
    description: "At-a-glance counts of monitored assets by state, plus infra uptime % and active alerts.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { tiles: ALL_IDS.slice(), regionScope: "mine" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config)).catch(function () { return null; });
    },

    renderInstance: function (el, config, data, ctx) {
      renderTiles(el, data, config);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config)).then(function (d) { renderTiles(el, d, config); }).catch(function () {});
      }, 30000);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      renderTiles(el, { statusCounts: { total: 312, up: 298, down: 4, warning: 7, unknown: 3, recovering: 0 }, uptimePercent: 99.2, activeAlertCount: 11 }, null);
    },

    renderConfig: function (el, config, onChange) {
      var current = new Set((config && config.tiles) || ALL_IDS);
      el.innerHTML =
        '<label>Show tiles</label>' +
        TILE_DEFS.map(function (t) {
          return '<label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;margin:3px 0">' +
            '<input type="checkbox" data-tile="' + t.id + '"' + (current.has(t.id) ? " checked" : "") + '> ' + escapeHtml(t.label) +
          '</label>';
        }).join("");
      el.querySelectorAll("input[data-tile]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          if (cb.checked) current.add(cb.getAttribute("data-tile"));
          else current.delete(cb.getAttribute("data-tile"));
          onChange("tiles", Array.from(current));
        });
      });
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
