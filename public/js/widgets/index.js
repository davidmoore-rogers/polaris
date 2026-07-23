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
 *     fetchData?:      (config) => Promise<any>            // optional — widgets fetch their own feed/section
 *                                                          // (getNocSummary(opts, feeds) / getSummary(opts))
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

  // Shared NOC-summary accessor. Each widget fetches ONLY its own feed(s)
  // (?feeds=topCpu) so it renders as soon as its data exists instead of
  // gating on the slowest feed in a monolithic payload. Results are memoized
  // for a short TTL keyed by (feeds, filter, limit) with in-flight dedupe, so
  // two widgets sharing a feed + filter still make one fetch. The server adds
  // its own short per-feed cache on top, so extra requests from many widgets /
  // tabs / kiosk walls stay cheap. Pass the opts object from
  // PolarisWidgets.nocFilterOpts(config); omit it for the unfiltered payload.
  var _nocCache = {}; // key -> { at, data, inflight }
  var NOC_TTL_MS = 15000;

  // Translate a widget config into a stable query string for /noc-summary.
  // assetTypes is sent only when it's a strict subset of the eight built-ins
  // (all-on = omit = unfiltered). regionScope "mine" expands to the caller's
  // effective region names (app.js global currentEffectiveRegions); "custom"
  // uses the widget's own picked region list (config.regions). An empty list
  // either way means "unrestricted", so no param is sent.
  function nocQueryString(opts) {
    opts = opts || {};
    var parts = [];
    if (Array.isArray(opts.assetTypes)
        && opts.assetTypes.length > 0
        && opts.assetTypes.length < window.PolarisWidgets.BUILTIN_ASSET_TYPES.length) {
      parts.push("assetTypes=" + encodeURIComponent(opts.assetTypes.slice().sort().join(",")));
    }
    var regions = null;
    if (opts.regionScope === "custom") regions = Array.isArray(opts.regions) ? opts.regions : [];
    else if (opts.regionScope === "mine") regions = (typeof currentEffectiveRegions !== "undefined" && currentEffectiveRegions) || [];
    if (regions && regions.length) parts.push("regionTags=" + encodeURIComponent(regions.slice().sort().join(",")));
    // Ask the server for a larger cap only when a widget wants more than the
    // default payload holds (>100 → the 1000-row option). Numeric limits ≤100
    // are omitted so those widgets keep sharing the one default-capped payload
    // and clip client-side; only the 1000-row widgets fetch their own.
    if (opts.limit) parts.push("limit=" + encodeURIComponent(opts.limit));
    // Per-asset averaging count for the sample-averaged top-N feeds (Highest
    // Avg CPU/Memory). Only sent when it differs from the server default (10)
    // so default-config widgets keep sharing one cached payload.
    if (opts.samples) parts.push("samples=" + encodeURIComponent(opts.samples));
    return parts.join("&");
  }

  // feeds: array of feed names the caller renders (e.g. ["topCpu"], or
  // ["downInterfaces","downIpsecTunnels"]). Omit/empty = the full payload.
  window.PolarisWidgets.getNocSummary = function (opts, feeds) {
    var qs = nocQueryString(opts);
    if (Array.isArray(feeds) && feeds.length) {
      qs = (qs ? qs + "&" : "") + "feeds=" + encodeURIComponent(feeds.slice().sort().join(","));
    }
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

  // Shared /dashboard/summary accessor for the IP-space widgets, same memo +
  // in-flight-dedupe pattern as getNocSummary. Widgets fetch only their own
  // section (?sections=blocks|recent|assetTypes) so each renders as soon as
  // its data exists — nothing depends on the dashboard orchestrator having
  // pre-fetched a shared payload. opts: { sections, sourceTypes, recentLimit }.
  var _summaryCache = {}; // key -> { at, data, inflight }
  window.PolarisWidgets.getSummary = function (opts) {
    opts = opts || {};
    var key = JSON.stringify([opts.sections || [], opts.sourceTypes || [], opts.recentLimit == null ? "" : opts.recentLimit]);
    var now = Date.now();
    var slot = _summaryCache[key];
    if (slot && slot.data && now - slot.at < NOC_TTL_MS) return Promise.resolve(slot.data);
    if (slot && slot.inflight) return slot.inflight;
    slot = _summaryCache[key] = slot || { at: 0, data: null, inflight: null };
    slot.inflight = api.dashboard.summary(opts)
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
  // own fetch. Centralized so every widget reads the same config keys.
  window.PolarisWidgets.nocFilterOpts = function (config) {
    config = config || {};
    var n = window.PolarisWidgets.serverRowLimit(config.rowLimit);
    // sampleCount (Highest Avg CPU/Memory "Average over" control): sent only
    // when it deviates from the server default of 10, so default-config
    // widgets share the one cached payload. Other widgets carry no
    // sampleCount config and omit the param entirely.
    var s = parseInt(config.sampleCount, 10);
    return {
      assetTypes: config.assetTypes,
      regionScope: config.regionScope,
      regions: config.regions,
      // Only widgets wanting MORE than the default payload holds (the 1000-row
      // option) request a larger server cap; ≤100 shares the default payload.
      limit: n > 100 ? n : undefined,
      samples: s > 0 && s !== 10 ? s : undefined,
    };
  };

  // ─── Shared row-limit control ───────────────────────────────────────────
  // Every list widget's "Row limit" dropdown uses the same numeric options
  // (5/10/20/50/100/1000). Helpers centralize option HTML, parsing, client-side
  // clipping, and the server-limit translation. 1000 is the hard ceiling — the
  // server sends at most that many rows per feed.
  window.PolarisWidgets.ROW_LIMIT_OPTIONS = [
    { value: "5", label: "5 rows" },
    { value: "10", label: "10 rows" },
    { value: "20", label: "20 rows" },
    { value: "50", label: "50 rows" },
    { value: "100", label: "100 rows" },
    { value: "1000", label: "1000 rows" },
  ];

  // Build the <option> tags for a Row-limit <select>, marking the current value.
  window.PolarisWidgets.rowLimitOptionsHTML = function (current) {
    var cur = current == null ? 10 : current;
    return window.PolarisWidgets.ROW_LIMIT_OPTIONS.map(function (o) {
      return '<option value="' + o.value + '"' + (String(cur) === o.value ? " selected" : "") + '>' + o.label + '</option>';
    }).join("");
  };

  // Parse a Row-limit <select> value into the stored config form (a number).
  window.PolarisWidgets.parseRowLimit = function (v) {
    return parseInt(v, 10);
  };

  // Clip a row array to a rowLimit config value; null/NaN = no clip.
  window.PolarisWidgets.clip = function (rows, rowLimit) {
    rows = rows || [];
    if (rowLimit == null) return rows.slice();
    var n = parseInt(rowLimit, 10);
    return isNaN(n) ? rows.slice() : rows.slice(0, n);
  };

  // Translate a rowLimit config value into a server-side row cap (the number).
  window.PolarisWidgets.serverRowLimit = function (rowLimit) {
    return parseInt(rowLimit, 10) || 0;
  };

  // Stamp (or clear) a red count pill on the widget's header title — the same
  // widget-pill-red style the group headers use, so "Down Nodes (Firewall) [4]"
  // reads as the overall total. `el` is the widget body; resolves the shell
  // header via closest(). No-ops outside a dashboard shell (e.g. the widget
  // library preview renders without the .dashboard-widget wrapper). Count of
  // 0/null removes the pill. Re-call on every render tick — updateConfig
  // rewrites the title's textContent, which drops the pill until the next
  // render re-stamps it.
  window.PolarisWidgets.setHeaderCount = function (el, count) {
    var article = el && el.closest ? el.closest(".dashboard-widget") : null;
    var title = article ? article.querySelector(".dashboard-widget-title") : null;
    if (!title) return;
    var pill = title.querySelector(".widget-header-count");
    if (!count) { if (pill) pill.remove(); return; }
    if (!pill) {
      pill = document.createElement("span");
      pill.className = "widget-pill widget-pill-red widget-header-count";
      pill.style.marginLeft = "8px";
      title.appendChild(pill);
    }
    pill.textContent = String(count);
  };

  // The caller's effective region names, or [] when unrestricted. Used by the
  // Status Map (which fetches /map/sites, not /noc-summary).
  window.PolarisWidgets.myRegionNames = function () {
    return ((typeof currentEffectiveRegions !== "undefined" && currentEffectiveRegions) || []).slice();
  };

  // Resolve a widget config's region scope into the region-name list its own
  // fetch should filter by: "custom" → the widget's picked regions, "mine" →
  // the caller's effective regions, else null (= unfiltered). Used by the
  // Status Map / Device Map widgets, which fetch /map/sites directly instead
  // of riding getNocSummary.
  window.PolarisWidgets.regionNamesForConfig = function (config) {
    config = config || {};
    if (config.regionScope === "custom") return Array.isArray(config.regions) ? config.regions.slice() : [];
    if (config.regionScope === "mine") return window.PolarisWidgets.myRegionNames();
    return null;
  };

  // Created-region names for the "Selected regions" picker, memoized for the
  // page lifetime (retried on failure). Sourced from /dashboard/filter-options
  // — the distinct region:<name> tags reconcileMapRegions keeps stamped on
  // live assets — which is mounted on the dash listener's API allowlist, so
  // the picker also works on the unauthenticated /dash wallboard.
  var _regionOptionsPromise = null;
  window.PolarisWidgets.getRegionOptions = function () {
    if (_regionOptionsPromise) return _regionOptionsPromise;
    _regionOptionsPromise = api.dashboard.filterOptions()
      .then(function (d) { return (d && d.regions) || []; })
      .catch(function () { _regionOptionsPromise = null; return []; });
    return _regionOptionsPromise;
  };

  // Open an asset's details slide-in in place when the canonical slide-over
  // (openViewModal from assets.js) is loaded on the page — it is on the
  // dashboard (index.html pulls assets.js + deps), map, and assets pages.
  // Falls back to navigating to the Assets page with the view hash. Returns
  // true when it opened in place.
  window.PolarisWidgets.openAssetDetail = function (id) {
    if (!id) return false;
    if (typeof window.openViewModal === "function") { window.openViewModal(id); return true; }
    // Dash wallboard (dash.html): the asset slide-over isn't loaded and there
    // is no session — navigating would bounce the kiosk to the login page.
    // Make the click a no-op instead.
    if (window.POLARIS_DASH_LOCAL) return false;
    window.location.href = "/assets.html#view=asset:" + encodeURIComponent(id);
    return false;
  };

  // Append the shared per-widget filter controls into a gear-popover container.
  // Region scope (All / My regions / Selected regions) goes on every NOC
  // widget; "Selected regions" reveals a checkbox list of the created regions
  // (none checked = unfiltered, mirroring the asset-type grid). On the
  // unauthenticated /dash wallboard "My regions" is hidden — there is no
  // viewer identity for it to resolve against (a saved "mine" renders and
  // behaves as "all" there). The asset-type toggle grid is added only when
  // includeAssetTypes is true (every NOC widget except the maps).
  // onChange(key, value) is the widget's config setter — key is "regionScope"
  // (string), "regions" (string[]), or "assetTypes" (string[]). Appends, so a
  // widget can render its own controls first, then call this.
  window.PolarisWidgets.renderNocFilterConfig = function (el, config, onChange, includeAssetTypes) {
    config = config || {};
    var labels = window.PolarisWidgets.ASSET_TYPE_LABELS;
    var BUILTIN = window.PolarisWidgets.BUILTIN_ASSET_TYPES;
    var onDash = window.POLARIS_DASH_LOCAL === true;
    var scope = config.regionScope === "custom" ? "custom"
      : (config.regionScope === "mine" && !onDash) ? "mine"
      : "all";
    var html = ''
      + '<label class="widget-config-label">Regions</label>'
      + '<select class="widget-config-select" data-nocf="regionScope">'
      +   '<option value="all"' + (scope === "all" ? " selected" : "") + '>All regions</option>'
      +   (onDash ? '' : '<option value="mine"' + (scope === "mine" ? " selected" : "") + '>My regions</option>')
      +   '<option value="custom"' + (scope === "custom" ? " selected" : "") + '>Selected regions…</option>'
      + '</select>'
      + '<div class="widget-config-typegrid" data-nocf="regionList" style="display:none"></div>';
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
    var regionListEl = el.querySelector('[data-nocf="regionList"]');

    // Show/populate the region checkbox list only while scope is "custom".
    // The list is painted once per popover open (region names don't change
    // under it); checkbox handlers re-read the live DOM, so the stale
    // `config` snapshot the popover closed over never matters.
    function paintRegionList() {
      if (!regionListEl) return;
      if (sel.value !== "custom") { regionListEl.style.display = "none"; return; }
      regionListEl.style.display = "";
      if (regionListEl.childElementCount) return;
      window.PolarisWidgets.getRegionOptions().then(function (names) {
        if (!regionListEl.isConnected || sel.value !== "custom" || regionListEl.childElementCount) return;
        if (!names.length) {
          regionListEl.innerHTML = '<p style="grid-column:1/-1;font-size:0.8rem;color:var(--color-text-secondary);margin:2px 0">'
            + 'No regions found — draw regions on the Device Map first.</p>';
          return;
        }
        var selected = Array.isArray(config.regions) ? config.regions : [];
        regionListEl.innerHTML = names.map(function (name, i) {
          return '<label class="widget-config-typeopt">'
            + '<input type="checkbox" data-nocregion="' + i + '"' + (selected.indexOf(name) !== -1 ? " checked" : "") + '> '
            + escapeHtml(name) + '</label>';
        }).join("");
        var boxes = regionListEl.querySelectorAll("[data-nocregion]");
        Array.prototype.forEach.call(boxes, function (cb) {
          cb.addEventListener("change", function () {
            var current = [];
            Array.prototype.forEach.call(boxes, function (b) {
              if (b.checked) current.push(names[parseInt(b.getAttribute("data-nocregion"), 10)]);
            });
            onChange("regions", current);
          });
        });
      });
    }

    if (sel) {
      sel.addEventListener("change", function () {
        onChange("regionScope", sel.value);
        paintRegionList();
      });
      paintRegionList();
    }

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
    hypervisor: "Hypervisor",
  };
  window.PolarisWidgets.ASSET_TYPE_COLORS = {
    server: "#4fc3f7", switch: "#26c6da", router: "#7e57c2", firewall: "#ef5350",
    workstation: "#66bb6a", printer: "#ffa726", access_point: "#ab47bc", other: "#90a4ae",
    hypervisor: "#5c6bc0",
  };

  // Severity pill for rows whose asset carries an active automation alert
  // (feeds attach alertSeverity/alertRank and sort severity-first). Palette
  // mirrors the canonical badge-level-* scale used on the Automations page /
  // wizard / Alerts tab so a severity reads identically everywhere: notice →
  // grey, informational → blue, warning → yellow, serious → ORANGE,
  // critical → RED. (Previously serious collapsed into the same red as
  // critical, which disagreed with the Automations page.)
  var ALERT_SEV_PILL = {
    notice: "widget-pill-neutral",
    informational: "widget-pill-watch", info: "widget-pill-watch",
    warning: "widget-pill-amber",
    serious: "widget-pill-orange",
    critical: "widget-pill-red", error: "widget-pill-red",
  };
  window.PolarisWidgets.alertSeverityPill = function (sev) {
    if (!sev) return "";
    var cls = ALERT_SEV_PILL[sev] || "widget-pill-watch";
    return '<span class="widget-pill ' + cls + '" title="Highest active alert: ' + escapeHtml(sev) + '" style="margin-right:4px;flex:0 0 auto">' + escapeHtml(String(sev)) + '</span>';
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
