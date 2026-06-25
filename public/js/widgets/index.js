/**
 * public/js/widgets/index.js — Dashboard widget registry + small shared helpers.
 *
 * Each widget module self-registers via PolarisWidgets.register({...}). The
 * dashboard orchestrator (public/js/dashboard.js) reads getAll() for the
 * library catalog and getByType(type) for instance rendering on the canvas.
 *
 * Widget module shape:
 *   {
 *     type:            string                              // stable id, used in saved layouts
 *     label:           string                              // display name
 *     description:     string                              // 1-line library blurb
 *     category?:       string                              // picker Group-By bucket (default "Other")
 *     defaultSize:     { width, height }                   // grid cells (width ∈ 3|4|6|12, height ∈ 1|2)
 *     minSize?:        { width, height }                   // optional resize floor
 *     requiredPermission?: { key, level }                  // gates library visibility AND instance render
 *     fetchData?:      (config, summary) => Promise<any>   // optional — most widgets read pre-fetched summary
 *     renderInstance:  (el, config, data, ctx)             // full render
 *     renderPreview:   (el, ctx)                           // mock-data mini for library
 *     renderConfig?:   (el, config, onChange)              // gear popover
 *     defaultConfig?:  object                              // seed config on add
 *     onMount?:        (el, ctx)                           // optional post-mount hook (timers etc.)
 *     onUnmount?:      (el, ctx)                           // cleanup hook
 *   }
 */

(function () {
  var registry = [];

  window.PolarisWidgets = {
    register: function (widget) {
      // Defensive: replace if same type re-registered (hot reload, dup includes).
      registry = registry.filter(function (w) { return w.type !== widget.type; });
      registry.push(widget);
    },
    getAll: function () { return registry.slice(); },
    getByType: function (type) {
      for (var i = 0; i < registry.length; i++) if (registry[i].type === type) return registry[i];
      return null;
    },
    // Filter to widgets the current user is allowed to see. Uses the
    // permAtLeast() helper exposed by app.js.
    getAllowed: function () {
      return registry.filter(function (w) {
        if (!w.requiredPermission) return true;
        if (typeof permAtLeast !== "function") return true;
        return permAtLeast(w.requiredPermission.key, w.requiredPermission.level || "read");
      });
    },
  };

  // The eight built-in asset types, in display order. A widget's asset-type
  // filter is "all eight on" by default; only a strict subset is sent to the
  // server (so operator-added custom types always show through).
  window.PolarisWidgets.BUILTIN_ASSET_TYPES = [
    "server", "switch", "router", "firewall", "workstation", "printer", "access_point", "other",
  ];

  // Shared NOC-summary accessor. Many NOC widgets read the same
  // /dashboard/noc-summary payload on their own refresh timers; this memoizes
  // the result for a short TTL and dedupes concurrent in-flight requests so a
  // dashboard full of NOC widgets makes one fetch per window, not one per
  // widget. Now keyed by the per-widget filter (asset types + region scope):
  // each distinct filter gets its own cache slot + in-flight dedupe, so two
  // widgets sharing a filter still make one fetch, while differently-filtered
  // widgets each fetch their own narrowed payload. Pass the opts object from
  // PolarisWidgets.nocFilterOpts(config); omit it for the unfiltered payload.
  var _nocCache = {}; // key -> { at, data, inflight }
  var NOC_TTL_MS = 15000;

  // Translate a widget config into a stable query string for /noc-summary.
  // assetTypes is sent only when it's a strict subset of the eight built-ins
  // (all-on = omit = unfiltered). regionScope "mine" expands to the caller's
  // effective region names (app.js global currentEffectiveRegions); an empty
  // effective set means "unrestricted", so no param is sent.
  function nocQueryString(opts) {
    opts = opts || {};
    var parts = [];
    if (Array.isArray(opts.assetTypes)
        && opts.assetTypes.length > 0
        && opts.assetTypes.length < window.PolarisWidgets.BUILTIN_ASSET_TYPES.length) {
      parts.push("assetTypes=" + encodeURIComponent(opts.assetTypes.slice().sort().join(",")));
    }
    if (opts.regionScope === "mine") {
      var regions = (typeof currentEffectiveRegions !== "undefined" && currentEffectiveRegions) || [];
      if (regions.length) parts.push("regionTags=" + encodeURIComponent(regions.slice().sort().join(",")));
    }
    return parts.join("&");
  }

  window.PolarisWidgets.getNocSummary = function (opts) {
    var qs = nocQueryString(opts);
    var key = qs || "_default";
    var now = Date.now();
    var slot = _nocCache[key];
    if (slot && slot.data && now - slot.at < NOC_TTL_MS) return Promise.resolve(slot.data);
    if (slot && slot.inflight) return slot.inflight;
    slot = _nocCache[key] = slot || { at: 0, data: null, inflight: null };
    slot.inflight = api.dashboard.nocSummary(qs)
      .then(function (data) {
        slot.at = Date.now();
        slot.data = data;
        slot.inflight = null;
        return data;
      })
      .catch(function (err) {
        slot.inflight = null;
        throw err;
      });
    return slot.inflight;
  };

  // Extract the NOC filter opts a widget should pass to getNocSummary / its
  // own fetch. Centralized so every widget reads the same two config keys.
  window.PolarisWidgets.nocFilterOpts = function (config) {
    config = config || {};
    return { assetTypes: config.assetTypes, regionScope: config.regionScope };
  };

  // The caller's effective region names, or [] when unrestricted. Used by the
  // Status Map (which fetches /map/sites, not /noc-summary).
  window.PolarisWidgets.myRegionNames = function () {
    return ((typeof currentEffectiveRegions !== "undefined" && currentEffectiveRegions) || []).slice();
  };

  // Open an asset's details slide-in in place when the canonical slide-over
  // (openViewModal from assets.js) is loaded on the page — it is on the
  // dashboard (index.html pulls assets.js + deps), map, and assets pages.
  // Falls back to navigating to the Assets page with the view hash. Returns
  // true when it opened in place.
  window.PolarisWidgets.openAssetDetail = function (id) {
    if (!id) return false;
    if (typeof window.openViewModal === "function") { window.openViewModal(id); return true; }
    window.location.href = "/assets.html#view=asset:" + encodeURIComponent(id);
    return false;
  };

  // Append the shared per-widget filter controls into a gear-popover container.
  // Region scope (All / My regions) goes on every NOC widget; the asset-type
  // toggle grid is added only when includeAssetTypes is true (every NOC widget
  // except the Status Map). onChange(key, value) is the widget's config setter
  // — key is "regionScope" (string) or "assetTypes" (string[]). Appends, so a
  // widget can render its own controls first, then call this.
  window.PolarisWidgets.renderNocFilterConfig = function (el, config, onChange, includeAssetTypes) {
    config = config || {};
    var labels = window.PolarisWidgets.ASSET_TYPE_LABELS;
    var BUILTIN = window.PolarisWidgets.BUILTIN_ASSET_TYPES;
    var scope = config.regionScope === "mine" ? "mine" : "all";
    var html = ''
      + '<label class="widget-config-label">Regions</label>'
      + '<select class="widget-config-select" data-nocf="regionScope">'
      +   '<option value="all"' + (scope === "all" ? " selected" : "") + '>All regions</option>'
      +   '<option value="mine"' + (scope === "mine" ? " selected" : "") + '>My regions</option>'
      + '</select>';
    if (includeAssetTypes) {
      var enabled = Array.isArray(config.assetTypes) ? config.assetTypes : BUILTIN.slice();
      html += '<label class="widget-config-label">Asset types</label>'
        + '<div class="widget-config-typegrid">'
        + BUILTIN.map(function (t) {
            return '<label class="widget-config-typeopt">'
              + '<input type="checkbox" data-noctype="' + t + '"' + (enabled.indexOf(t) !== -1 ? " checked" : "") + '> '
              + (labels[t] || t) + '</label>';
          }).join("")
        + '</div>';
    }
    el.insertAdjacentHTML("beforeend", html);

    var sel = el.querySelector('[data-nocf="regionScope"]');
    if (sel) sel.addEventListener("change", function () { onChange("regionScope", sel.value); });

    if (includeAssetTypes) {
      var boxes = el.querySelectorAll("[data-noctype]");
      Array.prototype.forEach.call(boxes, function (cb) {
        cb.addEventListener("change", function () {
          var current = [];
          Array.prototype.forEach.call(boxes, function (b) {
            if (b.checked) current.push(b.getAttribute("data-noctype"));
          });
          onChange("assetTypes", current);
        });
      });
    }
  };

  // RFC4122 v4 (good-enough; not crypto). Used for widget instance ids.
  window.PolarisWidgets.uuid = function () {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  };

  // Shared label/color maps for asset types (used by Monitor Alerts + Assets by Type).
  window.PolarisWidgets.ASSET_TYPE_LABELS = {
    server: "Server", switch: "Switch", router: "Router", firewall: "Firewall",
    workstation: "Workstation", printer: "Printer", access_point: "AP", other: "Other",
  };
  window.PolarisWidgets.ASSET_TYPE_COLORS = {
    server: "#4fc3f7", switch: "#26c6da", router: "#7e57c2", firewall: "#ef5350",
    workstation: "#66bb6a", printer: "#ffa726", access_point: "#ab47bc", other: "#90a4ae",
  };

  // "5m 03s" / "2h 17m" / "3d 4h" — same shape the legacy dashboard used.
  window.PolarisWidgets.durationSince = function (iso) {
    if (!iso) return "—";
    var diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60) return diff + "s";
    if (diff < 3600) {
      var m = Math.floor(diff / 60);
      var s = diff % 60;
      return m + "m " + (s < 10 ? "0" + s : s) + "s";
    }
    if (diff < 86400) {
      var h = Math.floor(diff / 3600);
      var rm = Math.floor((diff % 3600) / 60);
      return h + "h " + (rm < 10 ? "0" + rm : rm) + "m";
    }
    var d = Math.floor(diff / 86400);
    var rh = Math.floor((diff % 86400) / 3600);
    return d + "d " + rh + "h";
  };
})();
