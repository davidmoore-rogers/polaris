/**
 * public/js/assets.js — Asset management page
 */

var _assetsPageSize = 15;
var _assetsPage = 1;
// _assetsData holds ONLY the current page of rows (server-side pagination).
// The assets page runs TableSF in server-side mode — filter/sort/page state is
// translated into API params by _buildAssetsQuery() and only one page is
// fetched, mirroring the Events page. _assetsTotal is the server's full
// matching count, used to render the pagination controls.
var _assetsData = [];
var _assetsTotal = 0;
var _assetsSF = null;
var _assetsLayout = null;
var _assetsSelected = new Set();
// Selection can span pages, but _assetsData only holds the current page, so we
// remember a little metadata (status, assetType) for every selected asset to
// drive the bulk-bar button visibility even after the operator pages away.
var _assetsSelectedMeta = {};

// Monitor-state palette — green=up, red=down, orange=warning/partial. Shared by
// every chart/legend/status-dot builder that renders a monitor or SD-WAN
// up/down/partial state on this page. These are deliberately distinct from the
// CSS --color-* theme variables (which differ per light/dark and per semantic
// context); do NOT remap onto var(--color-*). Extracting these into one place
// only deduplicates the literals — the rendered values are unchanged.
var MONITOR_STATE_COLORS = { up: "#2a9d8f", down: "#d32f2f", warning: "#f4a261" };

function _saveAssetsPrefs() {
  if (!currentUsername) return;
  try {
    localStorage.setItem("polaris-prefs-assets-" + currentUsername, JSON.stringify({
      pageSize: _assetsPageSize,
      sortKey: _assetsSF ? _assetsSF._sortKey : null,
      sortDir: _assetsSF ? _assetsSF._sortDir : "asc",
      sfFilters: _assetsSF ? Object.assign({}, _assetsSF._filters) : {},
      layout: _assetsLayout ? _assetsLayout.getPrefs() : null,
    }));
  } catch (_) {}
}

function _restoreAssetsPrefs() {
  if (!currentUsername) return;
  var raw;
  try { raw = localStorage.getItem("polaris-prefs-assets-" + currentUsername); } catch (_) { return; }
  if (!raw) return;
  try {
    var p = JSON.parse(raw);
    if (p.pageSize) {
      _assetsPageSize = p.pageSize;
      var psSel = document.getElementById("filter-pagesize");
      if (psSel) psSel.value = String(p.pageSize);
    }
    if (_assetsSF) {
      if (p.sortKey) _assetsSF._sortKey = p.sortKey;
      if (p.sortDir) _assetsSF._sortDir = p.sortDir;
      if (p.sfFilters) {
        _assetsSF._filters = p.sfFilters;
        _assetsSF.restoreFilterUI();
      }
      _assetsSF._updateIcons();
    }
    if (_assetsLayout && p.layout) _assetsLayout.setPrefs(p.layout);
  } catch (_) {}
}

// Per-asset-type table-layout key for asset-detail tables (Interfaces, Storage,
// Hardware Sensors, LLDP, Wireless Stations, SD-WAN). These tables differ in
// shape by device class — a FortiGate's interface list looks nothing like a
// switch's, a firewall's sensor set differs from an AP's — so operators want
// column widths/visibility persisted independently per class, not one shared
// view. applyTableLayout() already namespaces by username; this adds the
// asset-type dimension to the typeKey. `assetType` is the registry string;
// null/empty falls back to "other". The Events tab deliberately opts OUT (its
// columns are type-invariant) and keeps a single shared "asset-events" key.
function _assetTableTypeKey(base, asset) {
  return base + "-" + ((asset && asset.assetType) || "other");
}

// Per-chart-type "last selected range" persistence (per-user via localStorage,
// matching the polaris-prefs-<scope>-<username> convention used elsewhere).
// One JSON map per user keyed by chart id (e.g. "assetMonitor", "assetSystem")
// so adding a new chart never collides with existing prefs blobs. "custom"
// ranges are intentionally not persisted — the from/to inputs reset on reopen,
// so restoring "custom" would land on an empty panel.
function _getChartRangePref(key, fallback) {
  if (!currentUsername) return fallback;
  try {
    var raw = localStorage.getItem("polaris-prefs-charts-" + currentUsername);
    var p = raw ? JSON.parse(raw) : null;
    var v = p && p[key];
    return v || fallback;
  } catch (_) { return fallback; }
}
function _setChartRangePref(key, range) {
  if (!currentUsername || !range || range === "custom") return;
  try {
    var raw = localStorage.getItem("polaris-prefs-charts-" + currentUsername);
    var p = raw ? (JSON.parse(raw) || {}) : {};
    p[key] = range;
    localStorage.setItem("polaris-prefs-charts-" + currentUsername, JSON.stringify(p));
  } catch (_) {}
}
// Storage chart view mode (Used % vs Used bytes). Single string per user
// because operators tend to think in one mental model across the whole
// fleet, not per-asset.
function _getStorageViewPref() {
  if (!currentUsername) return "pct";
  try {
    var v = localStorage.getItem("polaris-prefs-storage-view-" + currentUsername);
    return v === "bytes" ? "bytes" : "pct";
  } catch (_) { return "pct"; }
}
function _setStorageViewPref(view) {
  if (!currentUsername) return;
  try {
    localStorage.setItem("polaris-prefs-storage-view-" + currentUsername, view === "bytes" ? "bytes" : "pct");
  } catch (_) {}
}

// Per-(asset, mount) forecast-overlay visibility. Default on; only stored
// when the operator explicitly toggles it off (or back on after toggling
// off) — absent entry = default on.
function _getStorageForecastVisible(assetId, mountPath) {
  if (!currentUsername || !assetId || !mountPath) return true;
  try {
    var raw = localStorage.getItem("polaris-prefs-storage-forecast-" + currentUsername);
    var p = raw ? JSON.parse(raw) : null;
    var v = p && p[assetId + ":" + mountPath];
    return v === false ? false : true;
  } catch (_) { return true; }
}
function _setStorageForecastVisible(assetId, mountPath, visible) {
  if (!currentUsername || !assetId || !mountPath) return;
  try {
    var raw = localStorage.getItem("polaris-prefs-storage-forecast-" + currentUsername);
    var p = raw ? (JSON.parse(raw) || {}) : {};
    p[assetId + ":" + mountPath] = !!visible;
    localStorage.setItem("polaris-prefs-storage-forecast-" + currentUsername, JSON.stringify(p));
  } catch (_) {}
}

// Per-asset collapsed-interface persistence. Storage shape:
//   { "<assetId>": ["wan1", "agg1", ...] }  // collapsed parent ifNames
// Same per-user keying as chart-range prefs. Per-asset because the same parent
// name on different assets can have wildly different children.
function _getCollapsedIfaces(assetId) {
  if (!currentUsername || !assetId) return new Set();
  try {
    var raw = localStorage.getItem("polaris-prefs-iface-collapse-" + currentUsername);
    var p = raw ? JSON.parse(raw) : null;
    var arr = (p && p[assetId]) || [];
    return new Set(arr);
  } catch (_) { return new Set(); }
}
function _setCollapsedIfaces(assetId, collapsedSet) {
  if (!currentUsername || !assetId) return;
  try {
    var raw = localStorage.getItem("polaris-prefs-iface-collapse-" + currentUsername);
    var p = raw ? (JSON.parse(raw) || {}) : {};
    if (collapsedSet.size === 0) delete p[assetId];
    else p[assetId] = Array.from(collapsedSet);
    localStorage.setItem("polaris-prefs-iface-collapse-" + currentUsername, JSON.stringify(p));
  } catch (_) {}
}

// Screenshot-options persistence (the section-picker modal behind the asset
// details Screenshot button). Storage shape, keyed by tab key:
//   { "system": { sections: { interfaces: false, ... }, includeHiddenIfaces: true } }
// A missing section key means checked. Chart ranges are intentionally NOT
// persisted — they default to whatever the live chart shows when the modal
// opens. Writes replace the tab's entry wholesale with only the keys present
// in the live panel, so section keys from assets that no longer render a
// given section age out naturally.
function _getScreenshotPrefs() {
  if (!currentUsername) return {};
  try {
    var raw = localStorage.getItem("polaris-prefs-screenshot-" + currentUsername);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch (_) { return {}; }
}
function _setScreenshotPrefs(tabKey, obj) {
  if (!currentUsername || !tabKey) return;
  try {
    var p = _getScreenshotPrefs();
    p[tabKey] = obj;
    localStorage.setItem("polaris-prefs-screenshot-" + currentUsername, JSON.stringify(p));
  } catch (_) {}
}

// Render a chart range-button bar with the saved (or default) range marked as
// primary. `entries` is a list of { value, label, id? }; each rendered button
// carries `data-range="<value>"` so existing click handlers work unchanged.
function _chartRangeBtnsHTML(barClass, entries, prefKey, fallback) {
  var active = _getChartRangePref(prefKey, fallback);
  return entries.map(function (e) {
    var primary = e.value === active;
    var idAttr = e.id ? ' id="' + e.id + '"' : '';
    return '<button class="btn btn-sm ' + (primary ? 'btn-primary' : 'btn-secondary') + ' ' + barClass +
      '" data-range="' + e.value + '"' + idAttr + '>' + e.label + '</button>';
  }).join("");
}

// Lookback-overflow clipping helpers. The history endpoints fetch ~1 bucket
// of samples BEFORE the visible window so the chart's polyline enters from
// the left edge with continuous data instead of starting partway through;
// see the "Time-series chart (SVG)" section of TEMPLATES.md. The chart
// renderer hides those pre-since samples by wrapping every data-drawing
// element (polyline / dots / failure lines / hit targets) in a <g> bound
// to a per-chart clipPath that matches the inner plot area exactly.
//
// _chartClipDefs returns the <defs>…</defs> string that declares the
// clipPath; _chartClipAttr returns the matching `clip-path="…"` attribute.
// Each chart instance derives a unique id from its container so multiple
// charts on the same page don't collide.
var _chartClipSeq = 0;
function _chartClipId(prefix) {
  _chartClipSeq += 1;
  return "polaris-chart-clip-" + (prefix || "x") + "-" + _chartClipSeq;
}
function _chartClipDefs(id, padL, padT, innerW, innerH) {
  return '<defs><clipPath id="' + id + '">' +
    '<rect x="' + padL + '" y="' + padT + '" width="' + innerW + '" height="' + innerH + '"/>' +
    '</clipPath></defs>';
}
function _chartClipAttr(id) {
  return 'clip-path="url(#' + id + ')"';
}

// Renders a stats line into the given container using the canonical
// Response Time format (see TEMPLATES.md): leading "<count> samples"
// span (count bolded), then one "<Label>: <value>" span per metric.
// Flex gap on the container handles visual separation. Also writes a
// plaintext summary to container.dataset.summary for screenshot
// composers and tooltips. Pass count = 0 to render the empty-state
// message and clear the summary.
//
// parts: [{label: "Avg", value: "83 ms"}, ...] — entries with null/empty
// value are skipped so callers don't have to filter.
// Build a "View: Hourly avg" / "View: Daily avg" stats-line entry from the
// chart history response's tier discriminator. Returns null on the detail
// tier (or when the response predates the tier field) so callers can
// safely unshift the result and skip rendering. Wired through every chart
// loader's _renderChartStats call so operators see at a glance that they
// are looking at rollup aggregates rather than raw samples.
function _tierStatsPart(data) {
  if (!data) return null;
  var tier = data.tier;
  if (!tier || tier === "detail") return null;
  return { label: "View", value: tier === "hourly" ? "Hourly avg" : "Daily avg" };
}

function _renderChartStats(container, count, parts) {
  if (!container) return;
  // Apply the canonical layout styles directly so any stats container
  // looks identical regardless of how it was declared in markup.
  container.style.display = "flex";
  container.style.gap = "1.25rem";
  container.style.flexWrap = "wrap";
  if (!count) {
    container.textContent = "No samples in this range yet.";
    delete container.dataset.summary;
    return;
  }
  parts = Array.isArray(parts) ? parts : [];
  var html = '<span><strong>' + count + '</strong> samples</span>';
  var summary = count + " samples";
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p || p.value == null || p.value === "") continue;
    var label = String(p.label);
    var value = String(p.value);
    html += '<span><strong>' + escapeHtml(label) + ':</strong> ' + escapeHtml(value) + '</span>';
    summary += " · " + label.toLowerCase() + " " + value;
  }
  container.innerHTML = html;
  container.dataset.summary = summary;
}

document.addEventListener("DOMContentLoaded", async function () {
  // Guard: this file is also loaded on map.html so the Device Map can reuse
  // the canonical asset details slide-in. The page-init below assumes the
  // Assets-page DOM (assets-tbody, btn-add-asset, etc.); skip it elsewhere.
  // openViewModal() + _ensureAssetPanelDOM() and friends are page-agnostic
  // (they append to document.body) so the panel still works without this
  // init having run.
  if (!document.getElementById("assets-tbody")) return;
  // Server-side mode: never call sf.apply(). Any filter/sort change resets to
  // page 1 and re-fetches with the new state translated into API params.
  _assetsSF = new TableSF("assets-tbody", function () { _assetsPage = 1; fetchAssetsPage(); _saveAssetsPrefs(); });
  var assetsTable = document.querySelector("#assets-tbody").closest("table");
  _assetsLayout = setupColumnLayout(assetsTable, {
    onChange: _saveAssetsPrefs,
  });
  // MAC tooltips are promoted to <body>, so delegate on document so the
  // delete button works regardless of where the tooltip lives.
  document.addEventListener("click", _handleMacDeleteClick);
  document.getElementById("assets-bulk-delete-btn").addEventListener("click", bulkDeleteAssets);
  document.getElementById("assets-bulk-tags-btn").addEventListener("click", openBulkTagsModal);
  var bCompare = document.getElementById("assets-bulk-compare-btn");
  if (bCompare) bCompare.addEventListener("click", openCompareModal);
  _wireBulkBarDropdowns();
  var bQuarantine   = document.getElementById("assets-bulk-quarantine-btn");
  var bUnquarantine = document.getElementById("assets-bulk-unquarantine-btn");
  if (bQuarantine)   bQuarantine.addEventListener("click", bulkQuarantineAssets);
  if (bUnquarantine) bUnquarantine.addEventListener("click", bulkUnquarantineAssets);
  var bDeselect = document.getElementById("assets-bulk-deselect-btn");
  if (bDeselect) bDeselect.addEventListener("click", function () {
    _assetsSelected.clear();
    _assetsSelectedMeta = {};
    document.querySelectorAll("#assets-tbody input.row-cb").forEach(function (cb) { cb.checked = false; });
    _assetsUpdateSelectAll();
    _assetsUpdateBulkBar();
  });
  var settingsBtn = document.getElementById("btn-asset-settings");
  if (settingsBtn) settingsBtn.addEventListener("click", openAssetSettingsModal);
  var monsetBtn = document.getElementById("btn-monitoring-settings");
  if (monsetBtn) monsetBtn.addEventListener("click", openMonitoringSettingsModal);
  await userReady;
  _restoreAssetsPrefs();
  _applyAssetsHashFilters();
  loadAssets();
  document.getElementById("assets-select-all").addEventListener("change", function () {
    var cbs = document.querySelectorAll("#assets-tbody input.row-cb");
    var chk = this.checked;
    cbs.forEach(function (cb) {
      cb.checked = chk;
      var id = cb.getAttribute("data-id");
      if (chk) { _assetsSelected.add(id); _assetsRememberSelection(id); }
      else { _assetsSelected.delete(id); delete _assetsSelectedMeta[id]; }
    });
    _assetsUpdateBulkBar();
  });
  document.getElementById("assets-tbody").addEventListener("change", function (e) {
    var cb = e.target;
    if (!cb.classList.contains("row-cb")) return;
    var id = cb.getAttribute("data-id");
    if (cb.checked) { _assetsSelected.add(id); _assetsRememberSelection(id); }
    else { _assetsSelected.delete(id); delete _assetsSelectedMeta[id]; }
    _assetsUpdateSelectAll();
    _assetsUpdateBulkBar();
  });
  document.getElementById("assets-tbody").addEventListener("click", function (e) {
    var link = e.target.closest(".asset-name-link");
    if (!link) return;
    e.preventDefault();
    openViewModal(link.getAttribute("data-asset-id"));
  });
  // Favorites-first ordering is resolved server-side, so toggling a star must
  // re-fetch to re-order the page.
  wireFavoriteClicks("assets-tbody", function () { fetchAssetsPage(); });

  var addBtn = document.getElementById("btn-add-asset");
  if (addBtn) addBtn.addEventListener("click", openCreateModal);
  // ── Import dropdown wiring ──
  (function () {
    var importMenu = document.getElementById("import-menu");
    var importBtn  = document.getElementById("btn-import");
    if (importBtn && importMenu) {
      importBtn.addEventListener("click", function (e) { e.stopPropagation(); importMenu.classList.toggle("open"); });
      document.addEventListener("click", function () { importMenu.classList.remove("open"); });
      importMenu.addEventListener("click", function (e) { e.stopPropagation(); });
    }
    var csvBtn   = document.getElementById("btn-import-csv");
    var csvInput = document.getElementById("import-csv-input");
    var pdfBtn   = document.getElementById("btn-import-pdf");
    var pdfInput = document.getElementById("import-pdf-input");
    if (csvBtn && csvInput) {
      csvBtn.addEventListener("click", function () { importMenu && importMenu.classList.remove("open"); csvInput.value = ""; csvInput.click(); });
      csvInput.addEventListener("change", function () { if (this.files[0]) openImportCsvModal(this.files[0]); });
    }
    if (pdfBtn && pdfInput) {
      pdfBtn.addEventListener("click", function () { importMenu && importMenu.classList.remove("open"); pdfInput.value = ""; pdfInput.click(); });
      pdfInput.addEventListener("change", function () { if (this.files[0]) openImportPdfModal(this.files[0]); });
    }
  })();
  var clearFiltersBtn = document.getElementById("btn-clear-filters");
  if (clearFiltersBtn) clearFiltersBtn.addEventListener("click", function () {
    if (_assetsSF) { _assetsSF.clearFilters(); }
    _assetsPage = 1;
    fetchAssetsPage();
    _saveAssetsPrefs();
  });
  document.getElementById("filter-pagesize").addEventListener("change", function () {
    _assetsPageSize = parseInt(this.value, 10) || 15;
    _assetsPage = 1;
    fetchAssetsPage();
    _saveAssetsPrefs();
  });
});

var ASSET_TYPE_LABELS = {
  server: "Server",
  switch: "Switch",
  router: "Router",
  firewall: "Firewall",
  workstation: "Workstation",
  printer: "Printer",
  access_point: "AP",
  other: "Other",
};

// Bulk-bar State dropdown options. quarantined is intentionally omitted —
// quarantine is set/cleared via the dedicated /assets/bulk-quarantine
// endpoint, not the regular asset PUT.
var ASSET_STATUS_LABELS = {
  active: "Active",
  maintenance: "Maintenance",
  storage: "Storage",
  disabled: "Disabled",
  decommissioned: "Decommissioned",
};

// Reads dashboard / global-search deep-link hash params and seeds the
// TableSF filters BEFORE the first loadAssets call so the initial render is
// already narrowed.
//
// Supported hash forms (extends the legacy #view=asset:<id> handled by
// app.js processSearchHash):
//   #type=<assetType>         — pre-filters the Type column to a single value
//   #search=<hostname>        — pre-filters the Hostname column substring
//
// Both forms can co-occur. The values land in TableSF._filters so the smart
// filter UI shows them as if the operator had typed them in.
function _applyAssetsHashFilters() {
  if (!_assetsSF) return;
  var hash = (window.location.hash || "").replace(/^#/, "");
  if (!hash) return;
  var params = {};
  hash.split("&").forEach(function (kv) {
    var p = kv.split("=");
    if (p.length === 2) params[decodeURIComponent(p[0])] = decodeURIComponent(p[1]);
  });
  if (params.type && ASSET_TYPE_LABELS.hasOwnProperty(params.type)) {
    _assetsSF._filters.assetType = [params.type];
  }
  if (params.search) {
    _assetsSF._filters.hostname = params.search;
  }
  if (_assetsSF._filters.assetType || _assetsSF._filters.hostname) {
    if (typeof _assetsSF.restoreFilterUI === "function") _assetsSF.restoreFilterUI();
    if (typeof _assetsSF._updateIcons === "function") _assetsSF._updateIcons();
  }
}

// Translate the live TableSF filter + sort state + pagination + favorites into
// query params for GET /api/v1/assets (server-side mode). Mirrors the Events
// page's _buildEventsQuery. The saved-filter localStorage prefs are unchanged —
// they still live in _assetsSF._filters / _sortKey / _sortDir; this just maps
// that same state onto the wire instead of applying it client-side.
function _buildAssetsQuery() {
  var filters = _assetsSF ? (_assetsSF._filters || {}) : {};
  var params = {
    limit: _assetsPageSize,
    offset: (_assetsPage - 1) * _assetsPageSize,
  };

  // Multi-select enum columns → CSV.
  if (Array.isArray(filters.status) && filters.status.length) params.status = filters.status.join(",");
  if (Array.isArray(filters.assetType) && filters.assetType.length) params.assetType = filters.assetType.join(",");
  if (Array.isArray(filters._monitor) && filters._monitor.length) params.monitor = filters._monitor.join(",");

  // Operator-aware text columns. Param name == column key, except _server→server.
  var textCols = ["hostname", "ipAddress", "serialNumber", "assetTag", "manufacturer",
    "model", "os", "macAddress", "assignedTo", "purchaseOrder", "dnsName"];
  textCols.forEach(function (key) { _pushAssetText(params, key, filters[key]); });
  _pushAssetText(params, "server", filters._server);

  // lastSeen date-range column.
  if (filters.lastSeen && filters.lastSeen.type === "date") {
    if (filters.lastSeen.from) params.lastSeenFrom = filters.lastSeen.from;
    if (filters.lastSeen.to)   params.lastSeenTo = filters.lastSeen.to;
  }

  // Favorites-first ordering: send the operator's starred ids so they float to
  // the top of the whole result set (not just the current page).
  if (typeof getFavorites === "function") {
    var favs = getFavorites("assets");
    if (favs && favs.size) params.favoriteIds = Array.from(favs).join(",");
  }

  // Sort whitelist.
  if (_assetsSF && _assetsSF._sortKey) {
    params.sortBy = _assetsSF._sortKey;
    params.sortDir = _assetsSF._sortDir === "asc" ? "asc" : "desc";
  }
  return params;
}

// Map one TableSF text-filter value onto <param> / <param>Op. Handles the
// plain-string contains form, the "!"-prefix negation, and the object forms
// ({op:"not-contains",q}, {op:"empty"}, {op:"notempty"}) that table-sf stores.
function _pushAssetText(params, paramKey, raw) {
  if (raw == null) return;
  if (typeof raw === "string") {
    var v = raw.trim();
    if (!v) return;
    if (v.charAt(0) === "!") {
      var rest = v.slice(1).trim();
      if (!rest) return;
      params[paramKey] = rest;
      params[paramKey + "Op"] = "not_contains";
    } else {
      params[paramKey] = v; // op defaults to contains server-side
    }
  } else if (typeof raw === "object") {
    if (raw.op === "empty") {
      params[paramKey + "Op"] = "empty";
    } else if (raw.op === "notempty") {
      params[paramKey + "Op"] = "is_not_empty";
    } else if (raw.op === "not-contains") {
      var q = (raw.q || "").trim();
      if (!q) return;
      params[paramKey] = q;
      params[paramKey + "Op"] = "not_contains";
    }
  }
}

// Fetch + render the current page. Preserves the cross-page selection set —
// callers that want a clean slate (post-mutation refresh, Refresh button) go
// through loadAssets() instead, which clears the selection first.
async function fetchAssetsPage() {
  var tbody = document.getElementById("assets-tbody");
  try {
    var data = await api.assets.list(_buildAssetsQuery());
    var all = data.assets || [];
    _assetsTotal = (typeof data.total === "number") ? data.total : all.length;
    // Paged past the end (e.g. after deletions or a narrowing filter while on a
    // high page) → clamp to the last page and refetch once.
    var lastPage = Math.max(1, Math.ceil(_assetsTotal / _assetsPageSize));
    if (all.length === 0 && _assetsTotal > 0 && _assetsPage > lastPage) {
      _assetsPage = lastPage;
      return fetchAssetsPage();
    }
    function _mapAsset(a) {
      a._server = a.location || a.learnedLocation || "";
      // Array so a single row can satisfy multiple filter selections —
      // e.g. a monitored Up asset matches both "Monitored" and "Up". The
      // patched multi-filter in table-sf.js checks membership when the
      // row value is an array.
      if (!a.monitored) {
        a._monitor = ["Unmonitored"];
      } else if (a.monitorStatus === "up") {
        a._monitor = ["Monitored", "Up"];
      } else if (a.monitorStatus === "warning") {
        a._monitor = ["Monitored", "Warning"];
      } else if (a.monitorStatus === "down") {
        a._monitor = ["Monitored", "Down"];
      } else if (a.monitorStatus === "recovering") {
        a._monitor = ["Monitored", "Recovering"];
      } else {
        // "unknown" (never probed) and any unrecognized value fall through
        // here. Filter chip is "Pending" — operators read it as "we don't
        // know yet" rather than the directional "Recovering".
        a._monitor = ["Monitored", "Pending"];
      }
      return a;
    }
    _assetsData = all.map(_mapAsset);
    renderAssetsPage();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="19" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

// Full reload: drop the selection and fetch the current page fresh. Used by the
// Refresh button and by every post-mutation refresh (create / edit / delete /
// bulk / quarantine / import). Page navigation + filter/sort changes call
// fetchAssetsPage() directly so they keep the selection.
async function loadAssets() {
  _assetsSelected.clear();
  _assetsSelectedMeta = {};
  _assetsUpdateBulkBar();
  await fetchAssetsPage();
}

function _copyableCell(value) {
  if (!value) return '-';
  return '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(value) + '">' + escapeHtml(value) + '</span>';
}

var _macTooltipTimer = null;
var _macTooltipShowTimer = null;
var _MAC_TOOLTIP_SHOW_DELAY = 300;

function _showMacTooltip(trigger) {
  clearTimeout(_macTooltipTimer);
  // Hide any other visible tooltip first
  document.querySelectorAll('.mac-tooltip-visible').forEach(function (t) {
    t.classList.remove('mac-tooltip-visible');
  });
  // On first show, lift the tooltip out of its inline parent into <body>.
  // Ancestors like .modal use transform/overflow, which would otherwise
  // reparent position:fixed onto the modal and clip the tooltip.
  var tooltip = trigger._tooltip || trigger.querySelector('.mac-tooltip');
  if (!tooltip) return;
  if (tooltip.parentNode !== document.body) {
    document.body.appendChild(tooltip);
    trigger._tooltip = tooltip;
  }
  // Measure offscreen
  tooltip.style.visibility = 'hidden';
  tooltip.style.display = 'block';
  var triggerRect = trigger.getBoundingClientRect();
  var tipH = tooltip.offsetHeight;
  tooltip.style.display = '';
  tooltip.style.visibility = '';
  // Position: prefer above, flip below if not enough room
  var above = triggerRect.top - tipH - 8;
  if (above < 8) {
    tooltip.style.top = (triggerRect.bottom + 8) + 'px';
  } else {
    tooltip.style.top = above + 'px';
  }
  tooltip.style.left = triggerRect.left + 'px';
  tooltip.classList.add('mac-tooltip-visible');

  // Wire mouseleave on tooltip itself (once)
  if (!tooltip._wired) {
    tooltip._wired = true;
    tooltip.addEventListener('mouseenter', function () { clearTimeout(_macTooltipTimer); });
    tooltip.addEventListener('mouseleave', function () { _scheduleMacHide(tooltip); });
  }
}

function _scheduleMacHide(tooltip) {
  _macTooltipTimer = setTimeout(function () {
    tooltip.classList.remove('mac-tooltip-visible');
  }, 100);
}

function _handleMacEnter(e) {
  clearTimeout(_macTooltipShowTimer);
  var trigger = e.currentTarget;
  _macTooltipShowTimer = setTimeout(function () {
    _showMacTooltip(trigger);
  }, _MAC_TOOLTIP_SHOW_DELAY);
}

function _handleMacLeave(e) {
  clearTimeout(_macTooltipShowTimer);
  var tooltip = e.currentTarget._tooltip || e.currentTarget.querySelector('.mac-tooltip');
  if (tooltip) _scheduleMacHide(tooltip);
}

function _handleCopyClick(e) {
  var el = e.target.closest('.copy-cell');
  if (!el) return;
  var text = el.getAttribute('data-copy');
  if (!text) return;
  navigator.clipboard.writeText(text).then(function () {
    el.classList.add('copy-cell-flash');
    setTimeout(function () { el.classList.remove('copy-cell-flash'); }, 600);
  });
}

// Singleton dropdown element used by the clickable Type pill. Created lazily
// on first open, appended to document.body so it floats over the table
// without being clipped by row overflow, repositioned per-click. One global
// instance keeps the DOM clean even when an operator clicks rapidly across
// rows.
var _typeDropdown = null;
var _typeDropdownOutsideHandler = null;

function _closeTypeDropdown() {
  if (!_typeDropdown) return;
  if (_typeDropdownOutsideHandler) {
    document.removeEventListener("mousedown", _typeDropdownOutsideHandler, true);
    _typeDropdownOutsideHandler = null;
  }
  _typeDropdown.classList.remove("open");
  _typeDropdown.style.display = "none";
}

function _ensureTypeDropdown() {
  if (_typeDropdown) return _typeDropdown;
  var el = document.createElement("div");
  el.className = "btn-dropdown-menu type-pill-dropdown";
  el.style.position = "absolute";
  el.style.display = "none";
  el.style.minWidth = "140px";
  document.body.appendChild(el);
  _typeDropdown = el;
  return el;
}

// Delegated click handler for the Type column pill. Opens a dropdown of the
// 8 AssetType values; clicking an option PUTs the change inline with the same
// optimistic / rollback pattern as the Status pill.
async function _handleTypePillClick(e) {
  var pill = e.target.closest('[data-asset-type-toggle]');
  if (!pill) return;
  e.preventDefault();
  e.stopPropagation();
  if (typeof canManageAssets === "function" && !canManageAssets()) return;
  var assetId    = pill.getAttribute('data-asset-type-toggle');
  var currentType = pill.getAttribute('data-asset-type') || "other";

  var dd = _ensureTypeDropdown();
  // Build dropdown content fresh each open — the option list is small (8
  // entries) and the active highlight changes per asset.
  var html = ['<div class="dropdown-heading">Asset type</div>'];
  Object.keys(ASSET_TYPE_LABELS).forEach(function (key) {
    var active = key === currentType ? ' style="font-weight:600;"' : '';
    html.push('<button type="button" data-type-option="' + escapeHtml(key) + '"' + active + '>' + escapeHtml(ASSET_TYPE_LABELS[key]) + (key === currentType ? ' ✓' : '') + '</button>');
  });
  dd.innerHTML = html.join("");

  // Position below the pill, aligned to its left edge. Document scroll
  // offsets matter when the table is scrolled; getBoundingClientRect returns
  // viewport coords, so add window.scrollX/Y to land in document coords.
  var rect = pill.getBoundingClientRect();
  dd.style.left = (rect.left + window.scrollX) + "px";
  dd.style.top  = (rect.bottom + window.scrollY + 4) + "px";
  dd.style.right = "auto";
  dd.style.display = "block";
  dd.classList.add("open");

  // Close on outside click. Capture phase so it fires before the inner
  // option-button click bubbles back here.
  if (_typeDropdownOutsideHandler) {
    document.removeEventListener("mousedown", _typeDropdownOutsideHandler, true);
  }
  _typeDropdownOutsideHandler = function (ev) {
    if (!dd.contains(ev.target)) _closeTypeDropdown();
  };
  // Defer attaching the outside handler one tick so the click that opened
  // us doesn't immediately close us.
  setTimeout(function () {
    document.addEventListener("mousedown", _typeDropdownOutsideHandler, true);
  }, 0);

  // Wire option buttons. Reattach each open since innerHTML replaced them.
  dd.querySelectorAll('button[data-type-option]').forEach(function (btn) {
    btn.addEventListener("click", async function (evt) {
      evt.preventDefault();
      evt.stopPropagation();
      var nextType = btn.getAttribute("data-type-option");
      _closeTypeDropdown();
      if (!nextType || nextType === currentType) return;
      await _setAssetType(assetId, nextType);
    });
  });
}

async function _setAssetType(assetId, nextType) {
  var idx = (_assetsData || []).findIndex(function (a) { return a.id === assetId; });
  if (idx === -1) return;
  var prevType = _assetsData[idx].assetType;
  // Optimistic flip + re-render; rollback below if the PUT fails.
  _assetsData[idx].assetType = nextType;
  renderAssetsPage();
  try {
    await api.assets.update(assetId, { assetType: nextType });
    showToast("Type changed to " + (ASSET_TYPE_LABELS[nextType] || nextType));
  } catch (err) {
    _assetsData[idx].assetType = prevType;
    renderAssetsPage();
    showToast((err && err.message) || "Failed to update type", "error");
  }
}

// Delegated click handler for the Status column pill. Toggles the asset's
// `monitored` flag through PUT /assets/:id; the route then recomputes
// `monitorOverride` against the discovering integration's per-class
// `addAsMonitored` so the System tab's Asset Override badge stays current.
//
// Disabling monitoring opens a small inline confirm popover anchored to
// the pill — operators were tripping the toggle accidentally while
// scanning the column. Re-enabling stays a one-click action since it's
// low-risk (worst case the asset starts probing and is flipped off again).
function _handleMonitorPillClick(e) {
  var pill = e.target.closest('[data-monitor-toggle]');
  if (!pill) return;
  e.preventDefault();
  e.stopPropagation();
  if (typeof canManageAssets === "function" && !canManageAssets()) return;
  var assetId = pill.getAttribute('data-monitor-toggle');
  var currentlyMonitored = pill.getAttribute('data-monitored') === "true";

  if (currentlyMonitored) {
    _showMonitorDisableConfirm(pill, function () { _flipAssetMonitor(assetId, false); });
  } else {
    _flipAssetMonitor(assetId, true);
  }
}

// Inline confirmation popover for the "disable monitoring" direction.
// Anchored in viewport coordinates so the parent <td>'s overflow:hidden
// doesn't clip it. Closes on outside click, Escape, or button click.
function _showMonitorDisableConfirm(anchorEl, onConfirm) {
  // Drop any earlier popover first — clicking another pill while one is
  // open should swap, not stack.
  var existing = document.querySelector(".monitor-confirm-popover");
  if (existing) existing.remove();

  var popover = document.createElement("div");
  popover.className = "monitor-confirm-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Disable monitoring");
  popover.innerHTML =
    '<div class="mcp-message">Disable monitoring on this asset?</div>' +
    '<div class="mcp-actions">' +
      '<button type="button" class="mcp-cancel">Cancel</button>' +
      '<button type="button" class="mcp-confirm">Disable</button>' +
    '</div>';
  document.body.appendChild(popover);

  // Position: prefer below the pill; fall back to above if it would clip
  // the bottom edge. Horizontal alignment defaults to the pill's left
  // edge; nudge left if it would overrun the right viewport edge.
  var anchor = anchorEl.getBoundingClientRect();
  var pop = popover.getBoundingClientRect();
  var top = anchor.bottom + 6;
  if (top + pop.height > window.innerHeight - 8) top = anchor.top - pop.height - 6;
  var left = anchor.left;
  if (left + pop.width > window.innerWidth - 8) left = window.innerWidth - pop.width - 8;
  if (left < 8) left = 8;
  popover.style.top  = top  + "px";
  popover.style.left = left + "px";

  function close() {
    popover.remove();
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown",   onKey,     true);
  }
  function onOutside(ev) {
    if (popover.contains(ev.target)) return;
    close();
  }
  function onKey(ev) {
    if (ev.key === "Escape") { ev.preventDefault(); close(); }
  }
  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown",   onKey,     true);

  popover.querySelector(".mcp-cancel").addEventListener("click", close);
  popover.querySelector(".mcp-confirm").addEventListener("click", function () {
    close();
    onConfirm();
  });
  // Focus Cancel by default — accidental Enter shouldn't disable monitoring.
  setTimeout(function () { popover.querySelector(".mcp-cancel").focus(); }, 0);
}

// Optimistic-update helper extracted from the click handler so the
// confirmed-disable and immediate-enable paths share a single network +
// rollback flow.
async function _flipAssetMonitor(assetId, nextMonitored) {
  var idx = (_assetsData || []).findIndex(function (a) { return a.id === assetId; });
  if (idx === -1) return;
  var prevSnapshot = Object.assign({}, _assetsData[idx]);
  _assetsData[idx].monitored = nextMonitored;
  if (!nextMonitored) {
    _assetsData[idx].monitorStatus = null;
    _assetsData[idx].lastResponseTimeMs = null;
  } else {
    _assetsData[idx].monitorStatus = "recovering";
    _assetsData[idx].consecutiveFailures = 0;
    _assetsData[idx].consecutiveSuccesses = 0;
  }
  renderAssetsPage();
  try {
    await api.assets.update(assetId, { monitored: nextMonitored });
    showToast(nextMonitored ? "Monitoring enabled" : "Monitoring disabled");
  } catch (err) {
    _assetsData[idx].monitored          = prevSnapshot.monitored;
    _assetsData[idx].monitorStatus      = prevSnapshot.monitorStatus;
    _assetsData[idx].lastResponseTimeMs = prevSnapshot.lastResponseTimeMs;
    renderAssetsPage();
    showToast((err && err.message) || "Failed to update monitoring", "error");
  }
}

async function _handleMacDeleteClick(e) {
  var btn = e.target.closest('.mac-tooltip-delete');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  var assetId = btn.getAttribute('data-asset-id');
  var mac = btn.getAttribute('data-mac');
  if (!assetId || !mac) return;
  var ok = await showConfirm('Remove MAC ' + mac + ' from this asset?');
  if (!ok) return;
  btn.disabled = true;
  try {
    await api.assets.removeMac(assetId, mac);
    showToast('MAC removed');
    loadAssets();
  } catch (err) {
    btn.disabled = false;
    showToast(err.message, 'error');
  }
}

function renderAssetsPage() {
  var tbody = document.getElementById("assets-tbody");
  tbody.removeEventListener("click", _handleCopyClick);
  tbody.addEventListener("click", _handleCopyClick);
  tbody.removeEventListener("click", _handleMonitorPillClick);
  tbody.addEventListener("click", _handleMonitorPillClick);
  tbody.removeEventListener("click", _handleTypePillClick);
  tbody.addEventListener("click", _handleTypePillClick);
  // Server-side mode: _assetsData is already the filtered, sorted, favorites-
  // first current page. Don't re-filter / re-sort / re-slice it client-side.
  if (_assetsData.length === 0) {
    var hasFilters = _assetsSF && _assetsSF._filters && Object.keys(_assetsSF._filters).length > 0;
    tbody.innerHTML = hasFilters
      ? '<tr><td colspan="19" class="empty-state">No results match the current filters.</td></tr>'
      : '<tr><td colspan="19" class="empty-state">No assets found. Add one to get started.</td></tr>';
    clearPageControls("pagination");
    _assetsUpdateSelectAll();
    return;
  }
  var page = _assetsData;
  tbody.innerHTML = page.map(function (a) {
    var checked = _assetsSelected.has(a.id) ? ' checked' : '';
    if (checked) _assetsRememberSelection(a.id);
    return '<tr>' +
      '<td class="cb-col"><input type="checkbox" class="row-cb"' + checked + ' data-id="' + a.id + '"></td>' +
      starCellHTML("assets", a.id) +
      '<td><a href="#" class="asset-name-link" data-asset-id="' + a.id + '"><strong>' + escapeHtml(a.hostname || "-") + '</strong></a>' +
        (a.assetTag ? '<br><span class="asset-tag-label">' + escapeHtml(a.assetTag) + '</span>' : '') +
      '</td>' +
      '<td class="mono">' + ipCellHTML(a) + '</td>' +
      '<td>' + _copyableCell(a.serialNumber) + '</td>' +
      '<td>' + assetTypeBadge(a.assetType, a) + '</td>' +
      '<td>' + assetStatusBadge(a) + '</td>' +
      '<td>' + assetMonitorBadge(a) + '</td>' +
      '<td>' + escapeHtml(a.location || a.learnedLocation || "-") + '</td>' +
      '<td>' + _copyableCell(a.assetTag) + '</td>' +
      '<td>' + escapeHtml(a.manufacturer || "-") + '</td>' +
      '<td>' + escapeHtml(a.model || "-") + '</td>' +
      '<td>' + escapeHtml([a.os, a.osVersion].filter(Boolean).join(" ") || "-") + '</td>' +
      '<td>' + macCellHTML(a) + '</td>' +
      '<td>' + escapeHtml(a.assignedTo || "-") + '</td>' +
      '<td>' + _copyableCell(a.purchaseOrder) + '</td>' +
      '<td>' + _copyableCell(a.dnsName) + '</td>' +
      '<td>' + (a.lastSeen ? formatDate(a.lastSeen) : "-") + '</td>' +
      '<td class="actions">' +
        (canManageAssets() ? '<button class="btn btn-sm btn-secondary" onclick="openEditModal(\'' + a.id + '\')">Edit</button>' : '') +
        _viewLeaseActionHTML(a) +
        _quarantineActionHTML(a) +
        (canManageAssets() ?
          (a.macAddress && !a.manufacturer ? '<button class="btn btn-sm btn-secondary" onclick="singleOuiLookup(\'' + a.id + '\', \'' + escapeHtml(a.macAddress) + '\')" title="OUI manufacturer lookup">OUI</button>' : '') +
          '<button class="btn btn-sm btn-danger" onclick="confirmDelete(\'' + a.id + '\', \'' + escapeHtml(a.hostname || a.assetTag || a.ipAddress || "this asset") + '\')">Del</button>'
        : '') +
      '</td></tr>';
  }).join("");
  tbody.querySelectorAll('.mac-hover-trigger').forEach(function (el) {
    el.addEventListener('mouseenter', _handleMacEnter);
    el.addEventListener('mouseleave', _handleMacLeave);
  });
  _assetsUpdateSelectAll();
  renderPageControls("pagination", _assetsTotal, _assetsPageSize, _assetsPage, function (p) {
    _assetsPage = p;
    fetchAssetsPage();
  }, null, {
    actionButtons: [
      {
        label: "Refresh",
        onClick: loadAssets,
      },
      {
        label: "Clear Filters",
        onClick: function () {
          if (_assetsSF) _assetsSF.clearFilters();
          _assetsPage = 1;
          fetchAssetsPage();
          _saveAssetsPrefs();
        },
      },
    ],
  });
}

// Capture lightweight metadata for a selected asset from the current page, so
// the bulk bar's quarantine/release button logic still works after the operator
// pages away from the row (selection spans pages; _assetsData does not).
function _assetsRememberSelection(id) {
  var a = _assetsData.find(function (x) { return x.id === id; });
  if (a) _assetsSelectedMeta[id] = { status: a.status, assetType: a.assetType };
}

function _assetsUpdateSelectAll() {
  var allCbs = document.querySelectorAll("#assets-tbody input.row-cb");
  var checked = Array.from(allCbs).filter(function (cb) { return cb.checked; }).length;
  var sa = document.getElementById("assets-select-all");
  if (!sa) return;
  sa.checked = allCbs.length > 0 && checked === allCbs.length;
  sa.indeterminate = checked > 0 && checked < allCbs.length;
}

function _assetsUpdateBulkBar() {
  var bar = document.getElementById("assets-bulk-bar");
  if (!bar) return;
  var count = _assetsSelected.size;
  bar.style.display = count > 0 ? "flex" : "none";
  var el = bar.querySelector(".bulk-bar-count");
  if (el) el.textContent = count + " selected";

  // Compare needs at least two assets to overlay. Available to any role that
  // can view assets — comparing telemetry is read-only.
  var bCompare = document.getElementById("assets-bulk-compare-btn");
  if (bCompare) bCompare.style.display = count >= 2 ? "" : "none";

  // Show quarantine/release buttons only for assets-admins. Determine which
  // buttons are relevant based on the statuses of the selected assets.
  // Infrastructure types (firewall/switch/access_point) are excluded from the
  // Quarantine button — they can't be quarantined — but stay eligible for
  // Release in case one was quarantined before this guard was added.
  if (canManageAssets()) {
    // Use the remembered selection metadata (not _assetsData, which is only the
    // current page) so the buttons stay correct across paged-away selections.
    var selected = Object.keys(_assetsSelectedMeta)
      .filter(function (id) { return _assetsSelected.has(id); })
      .map(function (id) { return _assetsSelectedMeta[id]; });
    var hasQuarantineable = selected.some(function (a) {
      return a.status !== "quarantined"
        && a.assetType !== "firewall"
        && a.assetType !== "switch"
        && a.assetType !== "access_point";
    });
    var hasQuarantined = selected.some(function (a) { return a.status === "quarantined"; });
    var bQ  = document.getElementById("assets-bulk-quarantine-btn");
    var bUQ = document.getElementById("assets-bulk-unquarantine-btn");
    if (bQ)  bQ.style.display  = count > 0 && hasQuarantineable ? "" : "none";
    if (bUQ) bUQ.style.display = count > 0 && hasQuarantined    ? "" : "none";
  }
}

// View Lease cell. Renders a button that opens a lightweight reservation
// slide-over right on the Assets page — the user gets the lease details for
// this one IP without losing their place in the asset list. The footer's
// "Open in Networks" button is the escape hatch when they want the full
// subnet IP table. Hidden when the asset has no IP or no non-deprecated
// containing subnet — there is nothing to look at.
function _viewLeaseActionHTML(a) {
  if (!a.ipAddress) return '';
  var ctx = a.ipContext;
  if (!ctx || !ctx.subnetId) return '';
  var title = 'View this IP in ' + (ctx.subnetCidr || 'its network');
  return '<button class="btn btn-sm btn-secondary" onclick="viewAssetLease(\'' + a.id + '\')" title="' + escapeHtml(title) + '">View Lease</button>';
}

function viewAssetLease(id) {
  var a = (_assetsData || []).find(function (x) { return x.id === id; });
  // Fall back to the asset currently shown in the details slide-over — it
  // carries a fresh ipContext and covers the case where the asset was opened
  // via deep-link rather than the table (so it isn't in _assetsData).
  if ((!a || !a.ipContext) && _currentAssetForRefresh && _currentAssetForRefresh.id === id) {
    a = _currentAssetForRefresh;
  }
  if (!a || !a.ipAddress || !a.ipContext || !a.ipContext.subnetId) return;
  openLeasePanel(a);
}

// ─── Lightweight reservation slide-over (Assets page) ─────────────────────
//
// Shows just the lease details for one IP — no full subnet table. Used by
// the "View Lease" row action. Reuses the asset details slide-over CSS.
// When the asset has no active reservation we still open the panel and tell
// the user the IP is unreserved; the footer link to Networks is always
// present for operators who need the full panel.

function _ensureLeasePanelDOM() {
  if (document.getElementById("lease-panel-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "lease-panel-overlay";
  overlay.className = "slideover-overlay";
  overlay.innerHTML =
    '<div class="slideover" id="lease-panel">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="lease-panel-title">Lease</h3>' +
          '<button class="btn-icon" id="lease-panel-close" title="Close">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta" id="lease-panel-meta"></div>' +
      '</div>' +
      '<div class="slideover-body" id="lease-panel-body"><p class="empty-state" style="padding:1rem 1.25rem">Loading…</p></div>' +
      '<div class="slideover-footer" id="lease-panel-footer"></div>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeLeasePanel();
  });
  document.getElementById("lease-panel-close").addEventListener("click", closeLeasePanel);
  initSlideoverResize(document.getElementById("lease-panel"), "polaris.panel.width.lease");
}

function closeLeasePanel() {
  var ov = document.getElementById("lease-panel-overlay");
  if (ov) ov.classList.remove("open");
}

async function openLeasePanel(asset) {
  _ensureLeasePanelDOM();
  var titleEl  = document.getElementById("lease-panel-title");
  var metaEl   = document.getElementById("lease-panel-meta");
  var bodyEl   = document.getElementById("lease-panel-body");
  var footerEl = document.getElementById("lease-panel-footer");
  var ctx = asset.ipContext || {};

  titleEl.textContent = "Lease — " + asset.ipAddress;
  metaEl.textContent = (asset.hostname || asset.assetTag || asset.id) + (ctx.subnetCidr ? "  ·  " + ctx.subnetCidr : "");
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>';
  var openInNetworks =
    '<button class="btn btn-sm btn-secondary" id="btn-lease-open-networks">Open in Networks</button>';
  footerEl.innerHTML =
    openInNetworks +
    ' <button class="btn btn-sm btn-secondary" id="btn-lease-close">Close</button>';
  requestAnimationFrame(function () {
    document.getElementById("lease-panel-overlay").classList.add("open");
  });
  document.getElementById("btn-lease-close").addEventListener("click", closeLeasePanel);
  document.getElementById("btn-lease-open-networks").addEventListener("click", function () {
    var hash = '#ip=' + encodeURIComponent(ctx.subnetId) + '@' + encodeURIComponent(asset.ipAddress);
    window.location.href = '/subnets.html' + hash;
  });

  if (!ctx.reservation || !ctx.reservation.id) {
    bodyEl.innerHTML =
      '<div style="padding:1rem 1.25rem">' +
        '<p style="margin:0 0 0.5rem 0">No active reservation for <code>' + escapeHtml(asset.ipAddress) + '</code>.</p>' +
        '<p class="empty-state" style="margin:0">This IP sits inside <strong>' + escapeHtml(ctx.subnetCidr || 'its subnet') + '</strong> but has no Polaris reservation. Use <em>Open in Networks</em> to reserve it.</p>' +
      '</div>';
    return;
  }

  try {
    var r = await api.reservations.get(ctx.reservation.id);
    bodyEl.innerHTML = _renderLeaseBody(r, ctx);
  } catch (err) {
    bodyEl.innerHTML =
      '<div style="padding:1rem 1.25rem">' +
        '<p class="empty-state" style="margin:0">Failed to load reservation: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</p>' +
      '</div>';
  }
}

function _renderLeaseBody(r, ctx) {
  function row(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return '<div style="display:grid;grid-template-columns:140px 1fr;gap:0.5rem;padding:0.35rem 0;border-bottom:1px solid var(--color-border)">' +
             '<div style="color:var(--color-text-secondary);font-size:0.85rem">' + escapeHtml(label) + '</div>' +
             '<div>' + value + '</div>' +
           '</div>';
  }
  var pushBadge = '';
  if (r.pushStatus) {
    var cls = r.pushStatus === 'synced' ? 'badge-success' : (r.pushStatus === 'drift' ? 'badge-warning' : 'badge-secondary');
    pushBadge = '<span class="badge ' + cls + '">' + escapeHtml(r.pushStatus) + '</span>';
  }
  return '<div style="padding:1rem 1.25rem">' +
    row('IP Address',   '<code>' + escapeHtml(r.ipAddress || '') + '</code>') +
    row('Status',       statusBadge(r.status)) +
    row('Source',       '<span class="badge">' + escapeHtml(r.sourceType || 'manual') + '</span>') +
    row('Hostname',     r.hostname     ? escapeHtml(r.hostname)     : '<span class="empty-state">—</span>') +
    row('MAC Address',  r.macAddress   ? '<code>' + escapeHtml(r.macAddress) + '</code>' : '<span class="empty-state">—</span>') +
    row('Owner',        r.owner        ? escapeHtml(r.owner)        : '<span class="empty-state">—</span>') +
    row('Project Ref',  r.projectRef   ? escapeHtml(r.projectRef)   : '') +
    row('Expires',      r.expiresAt    ? formatDate(r.expiresAt)    : '<span class="empty-state">never</span>') +
    row('Created By',   r.createdBy    ? escapeHtml(r.createdBy)    : '') +
    row('Subnet',       escapeHtml(ctx.subnetCidr || '')) +
    (pushBadge ? row('FortiGate Push', pushBadge + (r.pushedAt ? ' <span style="color:var(--color-text-secondary);font-size:0.8rem">' + formatDate(r.pushedAt) + '</span>' : '')) : '') +
    row('Notes',        r.notes        ? '<div style="white-space:pre-wrap">' + escapeHtml(r.notes) + '</div>' : '') +
  '</div>';
}

// Quarantine action button in asset row. Only shown to assets-admins; only
// shown when the asset has a MAC (no MAC → no FortiGate target to push).
// Infrastructure assets (firewalls, switches, access points) cannot be
// quarantined — quarantining the device that does the quarantining would
// lock the operator out of the network. Release stays available for assets
// already in the quarantined state regardless of type, so a misclassified
// quarantine can still be undone.
function _quarantineActionHTML(a) {
  if (!canManageAssets()) return '';
  if (!a.macAddress && (!a.macAddresses || !a.macAddresses.length)) return '';
  if (a.status === 'quarantined') {
    return '<button class="btn btn-sm btn-secondary" onclick="releaseAssetQuarantine(\'' + a.id + '\')" title="Release quarantine — removes MAC block from FortiGate(s)">Release Quarantine</button>';
  }
  if (a.assetType === 'firewall' || a.assetType === 'switch' || a.assetType === 'access_point') return '';
  return '<button class="btn btn-sm btn-danger" onclick="quarantineAssetRow(\'' + a.id + '\')" title="Quarantine — push MAC block to FortiGate(s) that have seen this asset">Quarantine</button>';
}

async function quarantineAssetRow(id) {
  var reason = window.prompt('Reason for quarantine (optional):');
  if (reason === null) return; // cancelled
  try {
    var result = await api.assets.quarantine(id, reason || undefined);
    showToast(result.message || 'Asset quarantined');
    loadAssets();
  } catch (err) {
    showToast(err.message || 'Quarantine failed', 'error');
  }
}

async function releaseAssetQuarantine(id) {
  var ok = await showConfirm('Release quarantine on this asset?');
  if (!ok) return;
  try {
    var result = await api.assets.unquarantine(id);
    showToast(result.message || 'Quarantine released');
    loadAssets();
  } catch (err) {
    showToast(err.message || 'Release failed', 'error');
  }
}

// Admin-only Dependency Test simulation. Backend route is gated; we duplicate
// the gate here for UX so non-admins never see the trigger button. Default
// duration matches the backend default (30 min); the prompt accepts 1..240.
async function startDependencyTestPrompt(id) {
  if (typeof isAdmin !== "function" || !isAdmin()) return;
  var raw = window.prompt(
    "Simulate this asset going DOWN for how many minutes? (1–240)\n\n" +
    "Children with this asset in their dependency chain will be marked Dep. Suppressed " +
    "as if it had really failed. Real probes against this asset keep running. The " +
    "simulation auto-expires at the deadline.",
    "30"
  );
  if (raw === null) return; // cancelled
  var minutes = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) {
    showToast("Duration must be a whole number between 1 and 240 minutes", "error");
    return;
  }
  try {
    await api.assets.startDependencyTest(id, minutes);
    showToast("Dependency Test started — auto-clears in " + minutes + " min");
    // Refresh both the list (Status pill flips) and the open details panel
    // (the Dep Test button flips to "Clear" + the dep-tree block reflects).
    await loadAssets();
    await openViewModal(id);
  } catch (err) {
    showToast(err.message || "Failed to start Dependency Test", "error");
  }
}

async function clearDependencyTestNow(id) {
  if (typeof isAdmin !== "function" || !isAdmin()) return;
  var ok = await showConfirm("Clear the Dependency Test on this asset now? Children will resume normal monitoring within ~60 seconds.");
  if (!ok) return;
  try {
    await api.assets.clearDependencyTest(id);
    showToast("Dependency Test cleared");
    await loadAssets();
    await openViewModal(id);
  } catch (err) {
    showToast(err.message || "Failed to clear Dependency Test", "error");
  }
}

// Phase 3a recovery action — admin-only Split button on each Sources card.
// Detaches the chosen source onto a freshly-created asset; downstream FKs
// (monitoring, IP history, sightings, quarantine) stay on the original.
async function splitAssetSource(assetId, sourceId, sourceLabel) {
  var ok = await showConfirm(
    'Split "' + sourceLabel + '" off onto a new asset?\n\n' +
    'A new asset will be created with this source\'s data only. ' +
    'Monitoring, IP history, sightings, and quarantine settings stay on the current asset.\n\n' +
    'Use this to undo a bad merge — the new asset starts clean.'
  );
  if (!ok) return;
  try {
    var result = await api.assets.splitSource(assetId, sourceId);
    showToast('Source split — new asset created');
    // Refresh the assets table and re-open the asset details modal so the
    // operator can verify the moved source landed on the new row.
    await loadAssets();
    if (result && result.newAssetId) {
      window.location.hash = 'view=asset:' + result.newAssetId;
      openViewModal(result.newAssetId);
    }
  } catch (err) {
    showToast(err.message || 'Split failed', 'error');
  }
}

// ─── Asset merge (admin) — inverse of Split ─────────────────────────────────
// Absorbs another asset into the one being viewed. The operator searches for
// the other asset, sees an extensive field-by-field comparison marking every
// difference, picks which side survives + which value wins per differing
// field, then confirms. Backend: POST /assets/:id/merge (assetMergeService).

// Fields the comparison diffs and the operator can pick a winner for. Kept in
// sync with MERGEABLE_FIELDS in src/services/assetMergeService.ts. `date:true`
// formats with formatDate; everything else is shown as-is.
var _mergeCompareFields = [
  { key: "hostname",        label: "Hostname" },
  { key: "dnsName",         label: "DNS Name" },
  { key: "ipAddress",       label: "IP Address" },
  { key: "macAddress",      label: "MAC Address" },
  { key: "serialNumber",    label: "Serial Number" },
  { key: "manufacturer",    label: "Manufacturer" },
  { key: "model",           label: "Model" },
  { key: "assetType",       label: "Type" },
  { key: "status",          label: "Status" },
  { key: "location",        label: "Location" },
  { key: "learnedLocation", label: "Learned Location" },
  { key: "department",      label: "Department" },
  { key: "assignedTo",      label: "Assigned To" },
  { key: "os",              label: "OS" },
  { key: "osVersion",       label: "OS Version" },
  { key: "snmpLocation",    label: "SNMP Location" },
  { key: "learnedAddress",  label: "Address" },
  { key: "purchaseOrder",   label: "Purchase Order" },
  { key: "notes",           label: "Notes" },
  { key: "acquiredAt",      label: "Acquired",        date: true },
  { key: "warrantyExpiry",  label: "Warranty Expiry", date: true }
];

// Module-level state for the open merge modal.
var _mergeThisAsset = null;        // the asset whose modal is open ("this"/A)
var _mergeOtherAsset = null;       // the selected merge target ("other"/B)
var _mergeThisSources = [];
var _mergeOtherSources = [];
var _mergeSearchTimer = null;

function _mergeFieldVal(asset, f) {
  var v = asset ? asset[f.key] : null;
  if (v === null || v === undefined || v === "") return "";
  if (f.date) return formatDate(v);
  return String(v);
}

function _mergeIsEmpty(v) { return v === null || v === undefined || (typeof v === "string" && v.trim() === ""); }

async function openAssetMergeModal(assetId) {
  if (!isAdmin()) return;
  _mergeThisAsset = null; _mergeOtherAsset = null;
  _mergeThisSources = []; _mergeOtherSources = [];

  // xl modals zero out .modal-body padding (`.modal.modal-xl .modal-body` in
  // styles.css — other xl modals run full-bleed tables / sticky tab strips),
  // so wrap our content in our own padded container to keep text off the edges.
  var body =
    '<div style="padding:1.25rem">' +
      '<p style="margin:0 0 0.75rem;color:var(--color-text-secondary);font-size:0.85rem">' +
        'Merge another asset into this one. Search for the duplicate, review the differences, ' +
        'choose which asset survives and which value wins for each field, then confirm.' +
      '</p>' +
      '<div class="form-group" style="margin-bottom:0.5rem">' +
        '<input type="text" id="merge-search" placeholder="Search hostname, IP, MAC, serial, asset tag, owner..." autocomplete="off" style="width:100%">' +
      '</div>' +
      '<div id="merge-search-results" style="max-height:280px;overflow:auto"></div>' +
      '<div id="merge-compare"></div>' +
    '</div>';

  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="merge-confirm-btn" style="display:none">Merge</button>';

  openModal("Merge Asset", body, footer, { xl: true });

  // Load the current ("this") asset + its sources up front so the comparison
  // renders the moment a target is chosen.
  try {
    var fetched = await Promise.all([
      api.assets.get(assetId),
      api.assets.getSources(assetId).catch(function () { return []; })
    ]);
    _mergeThisAsset = fetched[0];
    _mergeThisSources = Array.isArray(fetched[1]) ? fetched[1] : [];
  } catch (err) {
    var rs = document.getElementById("merge-search-results");
    if (rs) rs.innerHTML = '<div class="empty-state" style="padding:1rem">Failed to load this asset: ' + escapeHtml(err.message || "error") + '</div>';
    return;
  }

  var input = document.getElementById("merge-search");
  if (input) {
    input.addEventListener("input", function () {
      if (_mergeSearchTimer) clearTimeout(_mergeSearchTimer);
      var q = this.value.trim();
      _mergeSearchTimer = setTimeout(function () { _mergeRunSearch(assetId, q); }, 250);
    });
    input.focus();
  }
}

async function _mergeRunSearch(thisId, q) {
  var box = document.getElementById("merge-search-results");
  if (!box) return;
  if (q.length < 2) { box.innerHTML = '<div class="empty-state" style="padding:0.75rem;font-size:0.85rem">Type at least 2 characters to search.</div>'; return; }
  box.innerHTML = '<div class="empty-state" style="padding:0.75rem;font-size:0.85rem">Searching...</div>';
  try {
    var rows = await api.assets.list({ search: q, limit: 25 });
    var list = Array.isArray(rows) ? rows : (rows && rows.assets) || [];
    list = list.filter(function (a) { return a.id !== thisId; });
    if (!list.length) { box.innerHTML = '<div class="empty-state" style="padding:0.75rem;font-size:0.85rem">No other assets match.</div>'; return; }
    box.innerHTML = list.map(function (a) {
      var sub = [a.ipAddress, a.macAddress, a.serialNumber, a.assetType].filter(Boolean).map(escapeHtml).join(" · ");
      return '<div class="merge-result-row" onclick="selectMergeTarget(\'' + a.id + '\')" ' +
        'style="padding:0.45rem 0.6rem;border:1px solid var(--color-border);border-radius:6px;margin-bottom:0.35rem;cursor:pointer">' +
        '<div style="font-weight:600">' + escapeHtml(a.hostname || a.dnsName || a.ipAddress || "(unnamed)") + '</div>' +
        (sub ? '<div style="font-size:0.78rem;color:var(--color-text-secondary)">' + sub + '</div>' : '') +
      '</div>';
    }).join("");
  } catch (err) {
    box.innerHTML = '<div class="empty-state" style="padding:0.75rem">Search failed: ' + escapeHtml(err.message || "error") + '</div>';
  }
}

async function selectMergeTarget(otherId) {
  var box = document.getElementById("merge-search-results");
  var cmp = document.getElementById("merge-compare");
  if (cmp) cmp.innerHTML = '<div class="empty-state" style="padding:1rem">Loading comparison...</div>';
  try {
    var fetched = await Promise.all([
      api.assets.get(otherId),
      api.assets.getSources(otherId).catch(function () { return []; })
    ]);
    _mergeOtherAsset = fetched[0];
    _mergeOtherSources = Array.isArray(fetched[1]) ? fetched[1] : [];
  } catch (err) {
    if (cmp) cmp.innerHTML = '<div class="empty-state" style="padding:1rem">Failed to load asset: ' + escapeHtml(err.message || "error") + '</div>';
    return;
  }
  // Collapse the search list once a target is chosen; offer a way back.
  if (box) box.innerHTML = '<button class="btn btn-sm btn-secondary" onclick="_mergeReopenSearch()">&larr; Choose a different asset</button>';
  _renderMergeComparison();
  var btn = document.getElementById("merge-confirm-btn");
  if (btn) btn.style.display = "";
}

function _mergeReopenSearch() {
  _mergeOtherAsset = null; _mergeOtherSources = [];
  var cmp = document.getElementById("merge-compare");
  if (cmp) cmp.innerHTML = "";
  var btn = document.getElementById("merge-confirm-btn");
  if (btn) btn.style.display = "none";
  var box = document.getElementById("merge-search-results");
  if (box) box.innerHTML = "";
  var input = document.getElementById("merge-search");
  if (input) { input.value = ""; input.focus(); }
}

function _mergeAssetLabel(a) {
  return escapeHtml(a.hostname || a.dnsName || a.ipAddress || a.id);
}

function _mergeSourcesSummary(sources) {
  if (!sources || !sources.length) return '<em style="color:var(--color-text-secondary)">none</em>';
  return sources.map(function (s) {
    var lbl = (_assetSourceLabels && _assetSourceLabels[s.sourceKind]) || s.sourceKind;
    return '<span class="badge badge-active" style="margin:0 0.2rem 0.2rem 0">' + escapeHtml(lbl) + '</span>';
  }).join("");
}

function _renderMergeComparison() {
  var cmp = document.getElementById("merge-compare");
  if (!cmp || !_mergeThisAsset || !_mergeOtherAsset) return;
  var A = _mergeThisAsset, B = _mergeOtherAsset;

  // Survivor selector — which row's identity, monitoring history, dependency
  // edges and FKs are kept. The absorbed row's sample history is deleted.
  var survivorHTML =
    '<div class="section-block" style="margin-bottom:0.75rem;padding:0.6rem 0.75rem">' +
      '<div class="section-label" style="margin-bottom:0.4rem">Which asset survives?</div>' +
      '<label style="display:block;margin-bottom:0.25rem;cursor:pointer">' +
        '<input type="radio" name="merge-survivor" value="this" checked> Keep <strong>' + _mergeAssetLabel(A) + '</strong> (this asset)' +
      '</label>' +
      '<label style="display:block;cursor:pointer">' +
        '<input type="radio" name="merge-survivor" value="other"> Keep <strong>' + _mergeAssetLabel(B) + '</strong> (the other asset)' +
      '</label>' +
      '<p class="hint" style="margin:0.4rem 0 0">The survivor keeps its monitoring history, dependency edges and quarantine state. ' +
        'The absorbed asset\'s sample/telemetry history and interface-comment overrides are <strong>permanently deleted</strong>. ' +
        'Discovery sources, MAC / IP / sighting history from both assets are combined onto the survivor.</p>' +
    '</div>';

  // Context rows (no winner choice) — help the operator pick the survivor.
  function ctxRow(label, av, bv) {
    return '<tr>' +
      '<th style="text-align:left;padding:0.3rem 0.6rem 0.3rem 0;color:var(--color-text-secondary);font-weight:500;vertical-align:top;white-space:nowrap">' + escapeHtml(label) + '</th>' +
      '<td style="padding:0.3rem 0.6rem;vertical-align:top">' + av + '</td>' +
      '<td style="padding:0.3rem 0.6rem;vertical-align:top">' + bv + '</td>' +
      '<td></td>' +
    '</tr>';
  }
  var monA = A.monitored ? '<span class="badge badge-active">monitored</span>' + (A.monitorStatus ? ' ' + escapeHtml(A.monitorStatus) : "") : '<span style="color:var(--color-text-secondary)">not monitored</span>';
  var monB = B.monitored ? '<span class="badge badge-active">monitored</span>' + (B.monitorStatus ? ' ' + escapeHtml(B.monitorStatus) : "") : '<span style="color:var(--color-text-secondary)">not monitored</span>';
  var contextRows =
    ctxRow("Monitored", monA, monB) +
    ctxRow("Sources", _mergeSourcesSummary(_mergeThisSources), _mergeSourcesSummary(_mergeOtherSources)) +
    ctxRow("Last Seen", escapeHtml(A.lastSeen ? formatDate(A.lastSeen) : "-"), escapeHtml(B.lastSeen ? formatDate(B.lastSeen) : "-")) +
    ctxRow("Tags", (A.tags && A.tags.length ? A.tags.map(escapeHtml).join(", ") : "-"), (B.tags && B.tags.length ? B.tags.map(escapeHtml).join(", ") : "-"));

  // Field rows — every mergeable field. Differences get a highlight + winner
  // radios; equal values render plainly. Empty-vs-value also counts as a diff.
  var diffCount = 0;
  var fieldRows = _mergeCompareFields.map(function (f) {
    var avRaw = _mergeFieldVal(A, f), bvRaw = _mergeFieldVal(B, f);
    var differs = avRaw !== bvRaw;
    if (differs) diffCount++;
    var av = avRaw === "" ? '<em style="color:var(--color-text-secondary)">empty</em>' : escapeHtml(avRaw);
    var bv = bvRaw === "" ? '<em style="color:var(--color-text-secondary)">empty</em>' : escapeHtml(bvRaw);
    var winnerCell = "";
    if (differs) {
      // Default winner: the side with a value; if both have values, default to
      // "this". Stored as data-field so confirm can gather them.
      var defThis = _mergeIsEmpty(B[f.key]) || !_mergeIsEmpty(A[f.key]);
      winnerCell =
        '<div style="display:flex;gap:0.5rem;white-space:nowrap">' +
          '<label style="cursor:pointer"><input type="radio" name="mw-' + f.key + '" value="this"' + (defThis ? " checked" : "") + '> A</label>' +
          '<label style="cursor:pointer"><input type="radio" name="mw-' + f.key + '" value="other"' + (!defThis ? " checked" : "") + '> B</label>' +
        '</div>';
    }
    var rowStyle = differs ? ' style="background:var(--color-warning-bg, rgba(255,193,7,0.12))"' : '';
    return '<tr' + rowStyle + '>' +
      '<th style="text-align:left;padding:0.3rem 0.6rem 0.3rem 0;color:var(--color-text-secondary);font-weight:500;vertical-align:top;white-space:nowrap">' + escapeHtml(f.label) + (differs ? ' <span title="Differs">&#9679;</span>' : '') + '</th>' +
      '<td style="padding:0.3rem 0.6rem;vertical-align:top;word-break:break-word">' + av + '</td>' +
      '<td style="padding:0.3rem 0.6rem;vertical-align:top;word-break:break-word">' + bv + '</td>' +
      '<td style="padding:0.3rem 0;vertical-align:top">' + winnerCell + '</td>' +
    '</tr>';
  }).join("");

  cmp.innerHTML =
    survivorHTML +
    '<div style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.4rem">' +
      (diffCount === 0 ? 'No field differences — the two assets agree on every field.' : diffCount + ' field' + (diffCount === 1 ? '' : 's') + ' differ (highlighted). Pick the winning value for each.') +
    '</div>' +
    '<div style="overflow:auto">' +
      '<table style="width:100%;font-size:0.85rem;border-collapse:collapse">' +
        '<thead><tr>' +
          '<th style="text-align:left;padding:0 0.6rem 0.4rem 0">Field</th>' +
          '<th style="text-align:left;padding:0 0.6rem 0.4rem">A: ' + _mergeAssetLabel(A) + '</th>' +
          '<th style="text-align:left;padding:0 0.6rem 0.4rem">B: ' + _mergeAssetLabel(B) + '</th>' +
          '<th style="text-align:left;padding:0 0 0.4rem">Keep</th>' +
        '</tr></thead>' +
        '<tbody>' + contextRows + fieldRows + '</tbody>' +
      '</table>' +
    '</div>';

  var btn = document.getElementById("merge-confirm-btn");
  if (btn && !btn._mergeBound) {
    btn._mergeBound = true;
    btn.addEventListener("click", _confirmMerge);
  }
}

// Resolve the merge plan from the operator's survivor + per-field winner
// choices. Mirrors the server's resolution (assetMergeService.mergeAssets):
// a field only OVERWRITES the survivor when the winning side has a non-empty
// value that differs from the survivor's current value. Picking the empty
// side never blanks the survivor (the backend guards this), so we don't show
// it as a change either.
function _buildMergePlan(survivor, fieldWinners) {
  var survivorAsset = survivor === "this" ? _mergeThisAsset : _mergeOtherAsset;
  var absorbedAsset = survivor === "this" ? _mergeOtherAsset : _mergeThisAsset;
  var absorbedSources = survivor === "this" ? _mergeOtherSources : _mergeThisSources;

  var overwrites = [];
  _mergeCompareFields.forEach(function (f) {
    var who = fieldWinners[f.key];           // "this" | "other" | undefined
    if (!who) return;                        // field didn't differ → no radio
    var winnerAsset = who === "this" ? _mergeThisAsset : _mergeOtherAsset;
    var winRaw = winnerAsset[f.key];
    // Empty winner can't overwrite a value (backend keeps the survivor's).
    var toAsset = _mergeIsEmpty(winRaw) ? survivorAsset : winnerAsset;
    var fromVal = _mergeFieldVal(survivorAsset, f);
    var toVal = _mergeFieldVal(toAsset, f);
    if (fromVal !== toVal) {
      overwrites.push({ label: f.label, from: fromVal, to: toVal });
    }
  });

  // Tags the union will ADD to the survivor (absorbed tags not already held).
  var survTags = (survivorAsset.tags || []);
  var have = {};
  survTags.forEach(function (t) { have[t] = true; });
  var tagsAdded = (absorbedAsset.tags || []).filter(function (t) { return !have[t]; });

  return {
    survivorAsset: survivorAsset,
    absorbedAsset: absorbedAsset,
    absorbedSources: absorbedSources || [],
    overwrites: overwrites,
    tagsAdded: tagsAdded
  };
}

// Stacked confirmation modal (own overlay at a higher z-index, like
// showConfirm) so the comparison modal underneath stays intact — "Back"
// just dismisses this layer. Resolves true on confirm, false otherwise.
function _showMergeReviewModal(survivor, fieldWinners) {
  return new Promise(function (resolve) {
    var plan = _buildMergePlan(survivor, fieldWinners);
    var survLabel = _mergeAssetLabel(plan.survivorAsset);
    var absLabel = _mergeAssetLabel(plan.absorbedAsset);

    var overwriteHTML;
    if (plan.overwrites.length === 0) {
      overwriteHTML = '<p style="margin:0;color:var(--color-text-secondary);font-size:0.85rem">No fields on <strong>' + survLabel + '</strong> will change — every winning value matches what it already has.</p>';
    } else {
      overwriteHTML =
        '<table style="width:100%;font-size:0.85rem;border-collapse:collapse">' +
          '<thead><tr>' +
            '<th style="text-align:left;padding:0 0.6rem 0.35rem 0">Field</th>' +
            '<th style="text-align:left;padding:0 0.6rem 0.35rem">Current</th>' +
            '<th style="text-align:left;padding:0 0 0.35rem">New value</th>' +
          '</tr></thead><tbody>' +
          plan.overwrites.map(function (o) {
            var from = o.from === "" ? '<em style="color:var(--color-text-secondary)">empty</em>' : escapeHtml(o.from);
            var to = o.to === "" ? '<em style="color:var(--color-text-secondary)">empty</em>' : escapeHtml(o.to);
            return '<tr>' +
              '<th style="text-align:left;padding:0.25rem 0.6rem 0.25rem 0;color:var(--color-text-secondary);font-weight:500;white-space:nowrap;vertical-align:top">' + escapeHtml(o.label) + '</th>' +
              '<td style="padding:0.25rem 0.6rem;vertical-align:top;word-break:break-word;color:var(--color-danger)">' + from + '</td>' +
              '<td style="padding:0.25rem 0;vertical-align:top;word-break:break-word;color:var(--color-success)">' + to + '</td>' +
            '</tr>';
          }).join("") +
          '</tbody></table>';
    }

    var combinedBits = [];
    if (plan.absorbedSources.length) {
      var kinds = plan.absorbedSources.map(function (s) { return (_assetSourceLabels && _assetSourceLabels[s.sourceKind]) || s.sourceKind; });
      combinedBits.push(plan.absorbedSources.length + ' discovery source' + (plan.absorbedSources.length === 1 ? '' : 's') + ' (' + escapeHtml(kinds.join(", ")) + ')');
    }
    combinedBits.push('MAC, IP and firewall-sighting history');
    if (plan.tagsAdded.length) {
      combinedBits.push('tags: ' + plan.tagsAdded.map(escapeHtml).join(", "));
    }

    var bodyHTML =
      '<p style="margin:0 0 0.85rem;font-size:0.9rem">Merging <strong>' + absLabel + '</strong> into <strong>' + survLabel + '</strong>. Review the changes before confirming.</p>' +

      '<div class="section-block" style="margin-bottom:0.75rem;padding:0.6rem 0.75rem">' +
        '<div class="section-label" style="margin-bottom:0.4rem">Will be overwritten on ' + survLabel + (plan.overwrites.length ? ' (' + plan.overwrites.length + ')' : '') + '</div>' +
        overwriteHTML +
      '</div>' +

      '<div class="section-block" style="margin-bottom:0.75rem;padding:0.6rem 0.75rem">' +
        '<div class="section-label" style="margin-bottom:0.4rem">Combined onto ' + survLabel + '</div>' +
        '<ul style="margin:0;padding-left:1.1rem;font-size:0.85rem;color:var(--color-text-secondary)">' +
          combinedBits.map(function (b) { return '<li>' + b + '</li>'; }).join("") +
        '</ul>' +
      '</div>' +

      '<div class="section-block" style="margin-bottom:0;padding:0.6rem 0.75rem;border-left:3px solid var(--color-danger)">' +
        '<div class="section-label" style="margin-bottom:0.4rem;color:var(--color-danger)">Permanently deleted</div>' +
        '<ul style="margin:0;padding-left:1.1rem;font-size:0.85rem;color:var(--color-text-secondary)">' +
          '<li>The absorbed asset <strong>' + absLabel + '</strong> (its row is removed)</li>' +
          '<li>Its monitoring / telemetry / sample history and interface-comment overrides</li>' +
        '</ul>' +
        '<p style="margin:0.5rem 0 0;font-size:0.82rem;color:var(--color-text-secondary)">This cannot be undone. Use <strong>Split</strong> afterward if you need to separate a source again.</p>' +
      '</div>';

    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "1300";
    overlay.innerHTML =
      '<div class="modal modal-wide">' +
        '<div class="modal-header"><h3>Confirm merge</h3></div>' +
        '<div class="modal-body">' + bodyHTML + '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn btn-secondary" data-merge-review="back">Back</button>' +
          '<button class="btn btn-danger" data-merge-review="ok">Confirm merge</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    function done(val) {
      overlay.classList.remove("open");
      overlay.addEventListener("transitionend", function () { if (overlay.parentNode) overlay.remove(); }, { once: true });
      setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 400);
      resolve(val);
    }
    overlay.querySelector('[data-merge-review="back"]').onclick = function () { done(false); };
    overlay.querySelector('[data-merge-review="ok"]').onclick = function () { done(true); };
    overlay.addEventListener("click", function (e) { if (e.target === overlay) done(false); });
    requestAnimationFrame(function () { overlay.classList.add("open"); });
  });
}

async function _confirmMerge() {
  if (!_mergeThisAsset || !_mergeOtherAsset) return;
  var survEl = document.querySelector('input[name="merge-survivor"]:checked');
  var survivor = survEl ? survEl.value : "this";
  var fieldWinners = {};
  _mergeCompareFields.forEach(function (f) {
    var sel = document.querySelector('input[name="mw-' + f.key + '"]:checked');
    if (sel) fieldWinners[f.key] = sel.value; // "this" | "other"
  });

  // Open the review modal: it shows exactly what will be overwritten on the
  // survivor (given the per-field winners), what gets combined, and what is
  // permanently deleted. Returns true only when the operator confirms.
  var ok = await _showMergeReviewModal(survivor, fieldWinners);
  if (!ok) return;

  var btn = document.getElementById("merge-confirm-btn");
  if (btn) btn.disabled = true;
  try {
    var result = await api.assets.merge(_mergeThisAsset.id, {
      otherAssetId: _mergeOtherAsset.id,
      survivor: survivor,
      fieldWinners: fieldWinners
    });
    closeModal();
    showToast('Assets merged — moved ' + result.movedSources + ' source(s)');
    await loadAssets();
    // Re-open the survivor so the operator sees the combined record.
    window.location.hash = 'view=asset:' + result.survivorId;
    openViewModal(result.survivorId);
  } catch (err) {
    if (btn) btn.disabled = false;
    showToast(err.message || 'Merge failed', 'error');
  }
}

async function bulkQuarantineAssets() {
  var ids = Array.from(_assetsSelected);
  if (!ids.length) return;
  var reason = window.prompt('Reason for quarantine (optional, applies to all selected):');
  if (reason === null) return;
  try {
    var r = await api.assets.bulkQuarantine(ids, reason || undefined);
    var ok = r.results.filter(function (x) { return x.ok; }).length;
    var fail = r.results.length - ok;
    showToast('Quarantined ' + ok + ' asset(s)' + (fail ? '; ' + fail + ' failed' : ''), fail ? 'warning' : 'success');
    _assetsSelected.clear();
    loadAssets();
  } catch (err) {
    showToast(err.message || 'Bulk quarantine failed', 'error');
  }
}

async function bulkUnquarantineAssets() {
  var ids = Array.from(_assetsSelected);
  if (!ids.length) return;
  var ok2 = await showConfirm('Release quarantine on ' + ids.length + ' asset(s)?');
  if (!ok2) return;
  try {
    var r = await api.assets.bulkUnquarantine(ids);
    var ok = r.results.filter(function (x) { return x.ok; }).length;
    var fail = r.results.length - ok;
    showToast('Released ' + ok + ' quarantine(s)' + (fail ? '; ' + fail + ' failed' : ''), fail ? 'warning' : 'success');
    _assetsSelected.clear();
    loadAssets();
  } catch (err) {
    showToast(err.message || 'Bulk release failed', 'error');
  }
}

async function openAssetSettingsModal() {
  var defaults = { inactivityMonths: 0, historyRetentionDays: 0 };
  try {
    var s = await api.events.getAssetDecommissionSettings();
    var m = Number(s.inactivityMonths);
    defaults.inactivityMonths = Number.isFinite(m) && m >= 0 ? Math.floor(m) : 0;
  } catch (_) {}
  try {
    var hs = await api.assets.getHistorySettings();
    var d = Number(hs.retentionDays);
    defaults.historyRetentionDays = Number.isFinite(d) && d >= 0 ? Math.floor(d) : 0;
  } catch (_) {}

  var body =
    '<div class="form-group">' +
      '<label>Auto-Decommission Threshold (months)</label>' +
      '<input type="number" id="f-assets-inactivity-months" value="' + escapeHtml(String(defaults.inactivityMonths)) + '" min="0" max="120" style="max-width:120px">' +
      '<p class="hint">Assets whose <strong>Last Seen</strong> date is older than this many months are automatically moved to <strong>decommissioned</strong> status. ' +
        'Set to <strong>0</strong> to disable. The job runs every 24 hours.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>IP History Retention (days)</label>' +
      '<input type="number" id="f-assets-history-retention" value="' + escapeHtml(String(defaults.historyRetentionDays)) + '" min="0" max="3650" style="max-width:120px">' +
      '<p class="hint">IP address history older than this many days is removed. ' +
        'Set to <strong>0</strong> to disable retention limits and keep history indefinitely.</p>' +
    '</div>';

  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-asset-settings-save">Save</button>';

  openModal("Asset Settings", body, footer);

  document.getElementById("btn-asset-settings-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var v = parseInt(document.getElementById("f-assets-inactivity-months").value, 10);
      var r = parseInt(document.getElementById("f-assets-history-retention").value, 10);
      await Promise.all([
        api.events.updateAssetDecommissionSettings({
          inactivityMonths: Number.isFinite(v) && v >= 0 ? v : 0,
        }),
        api.assets.updateHistorySettings({
          retentionDays: Number.isFinite(r) && r >= 0 ? r : 0,
        }),
      ]);
      closeModal();
      showToast("Asset settings saved");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// Bulk-bar dropdown wiring. Three dropdowns share one "only-one-open" model
// + outside-click-closes pattern: opening one closes the others, and a
// document-level mousedown handler closes the active menu when the click
// lands outside it. The Type and State menus are populated from the label
// maps so the option list isn't duplicated in HTML.
var _bulkBarOpenMenu = null;
var _bulkBarOutsideHandler = null;

function _closeBulkBarMenu() {
  if (_bulkBarOpenMenu) {
    _bulkBarOpenMenu.classList.remove("open");
    _bulkBarOpenMenu = null;
  }
  if (_bulkBarOutsideHandler) {
    document.removeEventListener("mousedown", _bulkBarOutsideHandler, true);
    _bulkBarOutsideHandler = null;
  }
}

function _openBulkBarMenu(menu) {
  _closeBulkBarMenu();
  menu.classList.add("open");
  _bulkBarOpenMenu = menu;
  _bulkBarOutsideHandler = function (ev) {
    if (!menu.contains(ev.target) && !menu.previousElementSibling.contains(ev.target)) {
      _closeBulkBarMenu();
    }
  };
  setTimeout(function () {
    document.addEventListener("mousedown", _bulkBarOutsideHandler, true);
  }, 0);
}

function _wireBulkBarDropdowns() {
  // Populate Type menu from ASSET_TYPE_LABELS.
  var typeMenu = document.getElementById("assets-bulk-type-menu");
  if (typeMenu) {
    var typeHtml = ['<div class="dropdown-heading">Change type</div>'];
    Object.keys(ASSET_TYPE_LABELS).forEach(function (key) {
      typeHtml.push('<button type="button" data-bulk-type="' + escapeHtml(key) + '">' + escapeHtml(ASSET_TYPE_LABELS[key]) + '</button>');
    });
    typeMenu.innerHTML = typeHtml.join("");
    typeMenu.querySelectorAll('button[data-bulk-type]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-bulk-type");
        _closeBulkBarMenu();
        bulkChangeType(key);
      });
    });
  }

  // Populate State menu from ASSET_STATUS_LABELS.
  var stateMenu = document.getElementById("assets-bulk-state-menu");
  if (stateMenu) {
    var stateHtml = ['<div class="dropdown-heading">Change state</div>'];
    Object.keys(ASSET_STATUS_LABELS).forEach(function (key) {
      stateHtml.push('<button type="button" data-bulk-state="' + escapeHtml(key) + '">' + escapeHtml(ASSET_STATUS_LABELS[key]) + '</button>');
    });
    stateMenu.innerHTML = stateHtml.join("");
    stateMenu.querySelectorAll('button[data-bulk-state]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-bulk-state");
        _closeBulkBarMenu();
        bulkChangeState(key);
      });
    });
  }

  // Monitoring menu options are static HTML; just wire the click handlers.
  var monOn  = document.getElementById("assets-bulk-monitor-on");
  var monOff = document.getElementById("assets-bulk-monitor-off");
  if (monOn)  monOn.addEventListener("click",  function () { _closeBulkBarMenu(); bulkSetMonitoring(true);  });
  if (monOff) monOff.addEventListener("click", function () { _closeBulkBarMenu(); bulkSetMonitoring(false); });

  // Open/close on trigger click. Toggling the same trigger closes the menu.
  [
    ["assets-bulk-type-btn", "assets-bulk-type-menu"],
    ["assets-bulk-state-btn", "assets-bulk-state-menu"],
    ["assets-bulk-monitor-btn", "assets-bulk-monitor-menu"],
  ].forEach(function (pair) {
    var trigger = document.getElementById(pair[0]);
    var menu    = document.getElementById(pair[1]);
    if (!trigger || !menu) return;
    trigger.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (_bulkBarOpenMenu === menu) {
        _closeBulkBarMenu();
      } else {
        _openBulkBarMenu(menu);
      }
    });
  });
}

// Bulk type change. No bulk endpoint exists — loop per-asset PUT, same as
// the legacy "Edit Type & Tags" modal's submit path.
async function bulkChangeType(nextType) {
  var ids = Array.from(_assetsSelected);
  if (!ids.length || !nextType) return;
  var label = ASSET_TYPE_LABELS[nextType] || nextType;
  var ok = await showConfirm("Change type to " + label + " for " + ids.length + " asset" + (ids.length !== 1 ? "s" : "") + "?");
  if (!ok) return;
  var btn = document.getElementById("assets-bulk-type-btn");
  if (btn) btn.disabled = true;
  var successCount = 0;
  var errorCount = 0;
  for (var i = 0; i < ids.length; i++) {
    try {
      await api.assets.update(ids[i], { assetType: nextType });
      successCount++;
    } catch (_e) {
      errorCount++;
    }
  }
  if (btn) btn.disabled = false;
  if (errorCount === 0) {
    showToast("Changed type to " + label + " on " + successCount + " asset" + (successCount !== 1 ? "s" : ""));
  } else {
    showToast("Updated " + successCount + ", " + errorCount + " failed", errorCount === ids.length ? "error" : "");
  }
  _assetsSelected.clear();
  loadAssets();
}

// Bulk state change. The Prisma extension at src/db.ts handles the
// "decommissioned/disabled → monitored=false" cascade, so no special-casing
// here. quarantined is intentionally not in ASSET_STATUS_LABELS.
async function bulkChangeState(nextStatus) {
  var ids = Array.from(_assetsSelected);
  if (!ids.length || !nextStatus) return;
  var label = ASSET_STATUS_LABELS[nextStatus] || nextStatus;
  var ok = await showConfirm("Change state to " + label + " for " + ids.length + " asset" + (ids.length !== 1 ? "s" : "") + "?");
  if (!ok) return;
  var btn = document.getElementById("assets-bulk-state-btn");
  if (btn) btn.disabled = true;
  var successCount = 0;
  var errorCount = 0;
  for (var i = 0; i < ids.length; i++) {
    try {
      await api.assets.update(ids[i], { status: nextStatus });
      successCount++;
    } catch (_e) {
      errorCount++;
    }
  }
  if (btn) btn.disabled = false;
  if (errorCount === 0) {
    showToast("Changed state to " + label + " on " + successCount + " asset" + (successCount !== 1 ? "s" : ""));
  } else {
    showToast("Updated " + successCount + ", " + errorCount + " failed", errorCount === ids.length ? "error" : "");
  }
  _assetsSelected.clear();
  loadAssets();
}

async function bulkDeleteAssets() {
  var ids = Array.from(_assetsSelected);
  if (!ids.length) return;
  var ok = await showConfirm("Delete " + ids.length + " asset" + (ids.length !== 1 ? "s" : "") + "? This cannot be undone.");
  if (!ok) return;
  var btn = document.getElementById("assets-bulk-delete-btn");
  if (btn) btn.disabled = true;
  try {
    var result = await api.assets.bulkDelete(ids);
    _assetsSelected.clear();
    showToast("Deleted " + (result.deleted || ids.length) + " asset" + (ids.length !== 1 ? "s" : ""));
  } catch (e) {
    showToast("Deletion failed", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
  loadAssets();
}

async function openBulkTagsModal() {
  var ids = Array.from(_assetsSelected);
  if (!ids.length) return;
  await _ensureTagCache();

  var body =
    '<p style="color:var(--color-text-secondary);margin-bottom:1.25rem">Editing tags on <strong>' + ids.length + '</strong> asset' + (ids.length !== 1 ? 's' : '') + '.</p>' +
    '<div class="form-group"><label>Tags</label>' +
      '<div style="display:flex;gap:16px;margin-bottom:0.5rem">' +
        '<label style="display:flex;gap:6px;align-items:center;cursor:pointer;font-weight:normal"><input type="radio" name="bulk-tag-mode" value="add" checked> Add tags</label>' +
        '<label style="display:flex;gap:6px;align-items:center;cursor:pointer;font-weight:normal"><input type="radio" name="bulk-tag-mode" value="replace"> Replace tags</label>' +
      '</div>' +
      '<div id="bulk-tag-picker-wrap">' + tagFieldHTML([]) + '</div>' +
    '</div>';

  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="bulk-edit-save-btn">Apply to ' + ids.length + ' Asset' + (ids.length !== 1 ? 's' : '') + '</button>';

  openModal("Edit Tags", body, footer);
  wireTagPicker();

  document.getElementById("bulk-edit-save-btn").addEventListener("click", async function () {
    var btn = this;
    var tagModeEl = document.querySelector('input[name="bulk-tag-mode"]:checked');
    var tagMode = tagModeEl ? tagModeEl.value : "add";
    var selectedTags = getTagFieldValue() || [];

    if (!selectedTags.length && tagMode === "add") {
      showToast("Pick at least one tag to add", "error");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Applying…";

    var successCount = 0;
    var errorCount = 0;

    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var payload = {};
      if (tagMode === "add") {
        var existing = _assetsData.find(function (a) { return a.id === id; });
        var existingTags = existing && existing.tags ? existing.tags : [];
        payload.tags = Array.from(new Set(existingTags.concat(selectedTags)));
      } else {
        var existingForReplace = _assetsData.find(function (a) { return a.id === id; });
        var preserved = (existingForReplace && existingForReplace.tags ? existingForReplace.tags : [])
          .filter(isProtectedTag);
        payload.tags = Array.from(new Set(selectedTags.concat(preserved)));
      }
      try {
        await api.assets.update(id, payload);
        successCount++;
      } catch (_e) {
        errorCount++;
      }
    }

    closeModal();
    if (errorCount === 0) {
      showToast("Updated tags on " + successCount + " asset" + (successCount !== 1 ? "s" : ""));
    } else {
      showToast("Updated " + successCount + ", " + errorCount + " failed", errorCount === ids.length ? "error" : "");
    }
    _assetsSelected.clear();
    loadAssets();
  });
}

function assetTypeBadge(type, asset) {
  var label = ASSET_TYPE_LABELS[type] || type || "-";
  // Clickable for admin/assetsadmin — opens a dropdown of the 8 AssetType
  // values; selecting one PUTs the change inline. Same data-attribute pattern
  // as the Status pill so the delegated handler can dispatch without lookups.
  var canToggle = typeof canManageAssets === "function" && canManageAssets() && asset && asset.id;
  if (!canToggle) {
    return '<span class="badge badge-asset-type">' + escapeHtml(label) + '</span>';
  }
  if (isAssetTypeLocked(asset)) {
    return '<span class="badge badge-asset-type" title="Locked — discovered as ' + escapeHtml(label) + ' by an integration">' + escapeHtml(label) + '</span>';
  }
  return '<span class="badge badge-asset-type badge-clickable"' +
    ' data-asset-type-toggle="' + escapeHtml(asset.id) + '"' +
    ' data-asset-type="' + escapeHtml(type || "other") + '"' +
    ' role="button" tabindex="0"' +
    ' title="Click to change type">' +
    escapeHtml(label) + ' ▾</span>';
}

// Fortinet infrastructure (firewall/switch/access_point) discovered via an
// integration is not reclassifiable — the next discovery cycle would revert
// any change. Mirrored on the backend in PUT /assets/:id.
function isAssetTypeLocked(asset) {
  if (!asset || !asset.discoveredByIntegrationId) return false;
  var t = asset.assetType;
  return t === "firewall" || t === "switch" || t === "access_point";
}

function assetStatusBadge(asset) {
  var status = typeof asset === "string" ? asset : (asset.status || "");
  var cls = "badge-" + status;
  var label = status.charAt(0).toUpperCase() + status.slice(1);
  var title = "";
  if (typeof asset === "object" && asset) {
    var parts = [];
    if (asset.statusChangedBy) parts.push("Changed by: " + asset.statusChangedBy);
    if (asset.statusChangedAt) {
      var d = new Date(asset.statusChangedAt);
      parts.push(d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }));
    }
    if (parts.length) title = ' title="' + parts.join("\n") + '"';
  }
  return '<span class="badge ' + cls + '"' + title + '>' + escapeHtml(label) + '</span>';
}

// Five-state monitoring pill. "Monitored" is never shown directly — when an
// asset is being monitored we surface the actual probe outcome so operators
// don't have to drill in to discover the state.
//   monitored=false                          → grey   "Unmonitored"
//   monitored=true, status="up"              → green  "Up"
//   monitored=true, status="warning"         → amber  "Warning"     (was up, currently failing but below threshold)
//   monitored=true, status="recovering"      → blue   "Recovering"  (was down, now succeeding; below threshold)
//   monitored=true, status="down"            → red    "Down"
//   monitored=true, status="unknown"/null    → blue   "Pending"     (never probed — same blue treatment as "Recovering" but a different label)
//
// For admin/assetsadmin callers the pill is clickable: a single click
// toggles monitored. The server recomputes `monitorOverride` against the
// discovering integration's per-class `addAsMonitored` after the write —
// override goes true when the operator's new choice diverges from the
// integration default, clears when they re-converge. The pill carries
// `data-monitor-toggle="<asset-id>"` and `data-monitored="true|false"` so
// the delegated handler in `_handleMonitorPillClick` can flip it without
// re-querying.
function assetMonitorBadge(asset) {
  var canToggle = typeof canManageAssets === "function" && canManageAssets() && asset && asset.id;
  var toggleAttrs = canToggle
    ? ' data-monitor-toggle="' + escapeHtml(asset.id) + '" data-monitored="' + (asset.monitored ? "true" : "false") + '" role="button" tabindex="0"'
    : "";
  if (!asset || asset.monitored === false || asset.monitored == null) {
    var unmonTitle = canToggle ? ' title="Click to enable monitoring"' : "";
    return '<span class="badge badge-unmonitored' + (canToggle ? " badge-clickable" : "") + '"' + unmonTitle + toggleAttrs + '>Unmonitored</span>';
  }
  var s = asset.monitorStatus || "unknown";
  var bits = [];
  if (asset.responseTimePolling) bits.push("Method: " + asset.responseTimePolling);
  if (typeof asset.lastResponseTimeMs === "number") bits.push("Last RTT: " + asset.lastResponseTimeMs + " ms");
  if (asset.lastMonitorAt) bits.push("Last poll: " + new Date(asset.lastMonitorAt).toLocaleString());
  if (canToggle) bits.push("Click to disable monitoring");
  var clickCls = canToggle ? " badge-clickable" : "";
  // Admin-only "Dependency Test" overlay takes priority over every other
  // pill state — the operator explicitly asked us to simulate this device
  // going down, so show the simulation label even when the real probe is
  // succeeding underneath. The expiration timestamp goes in the tooltip
  // so admins can see how long is left without opening the asset.
  var depTestUntil = asset.dependencyTestUntil ? new Date(asset.dependencyTestUntil) : null;
  if (depTestUntil && depTestUntil.getTime() > Date.now()) {
    var dtBits = ["Simulated as DOWN by an admin (real probes still running)"];
    dtBits.push("Auto-clears: " + depTestUntil.toLocaleString());
    if (asset.dependencyTestStartedBy) dtBits.push("Started by: " + asset.dependencyTestStartedBy);
    var dtTitle = ' title="' + escapeHtml(dtBits.join("\n")) + '"';
    return '<span class="badge badge-monitor-dep-test"' + dtTitle + '>Dependency Test</span>';
  }
  // Dependency-suppressed takes precedence over the five-state machine
  // label. The asset's own probe may still be succeeding (redundant L3
  // path / out-of-band management) — that's why monitorStatus AND
  // dependencySuppressed are separate columns. Down + suppressed shows
  // "Down" since the probe proves it; otherwise "Dep. Down" with the
  // level in the tooltip.
  if (asset.dependencySuppressed && s !== "down") {
    var depBits = bits.slice();
    if (asset.dependencyLayer != null) depBits.unshift("Level " + asset.dependencyLayer + " — upstream parent is down");
    else                                depBits.unshift("Upstream dependency is down");
    var depTitle = ' title="' + escapeHtml(depBits.join("\n")) + '"';
    return '<span class="badge badge-monitor-dep-down' + clickCls + '"' + depTitle + toggleAttrs + '>Dep. Down</span>';
  }
  var title = bits.length ? ' title="' + escapeHtml(bits.join("\n")) + '"' : "";
  if (s === "up")         return '<span class="badge badge-monitored'        + clickCls + '"' + title + toggleAttrs + '>Up</span>';
  if (s === "warning")    return '<span class="badge badge-monitor-warning'  + clickCls + '"' + title + toggleAttrs + '>Warning</span>';
  if (s === "down")       return '<span class="badge badge-monitor-down'     + clickCls + '"' + title + toggleAttrs + '>Down</span>';
  if (s === "recovering") return '<span class="badge badge-monitor-recovering' + clickCls + '"' + title + toggleAttrs + '>Recovering</span>';
  // unknown / null / unrecognized → Pending. Same blue treatment as
  // Recovering (different label).
  return '<span class="badge badge-monitor-recovering' + clickCls + '"' + title + toggleAttrs + '>Pending</span>';
}

function ipCellHTML(asset) {
  var primary = asset.ipAddress;
  var ips = Array.isArray(asset.associatedIps) ? asset.associatedIps : [];
  if (!primary && ips.length === 0) return '-';
  if (ips.length === 0) {
    return '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(primary) + '">' + escapeHtml(primary) + '</span>';
  }

  var displayIp = primary || ips[0].ip;
  var tooltipRows = ips.map(function (entry) {
    var metaBits = [];
    if (entry.ptrName) metaBits.push('<span class="mac-tooltip-subnet">' + escapeHtml(entry.ptrName) + '</span>');
    if (entry.interfaceName) metaBits.push('<span class="mac-tooltip-subnet">' + escapeHtml(entry.interfaceName) + '</span>');
    var sourceLine = (entry.source ? escapeHtml(entry.source) : '') +
      (entry.lastSeen ? ' &middot; ' + formatDate(entry.lastSeen) : '');
    return '<div class="mac-tooltip-row">' +
      '<span class="mono copy-cell" title="Click to copy" data-copy="' + escapeHtml(entry.ip) + '">' + escapeHtml(entry.ip) + '</span>' +
      '<span class="mac-tooltip-meta">' +
        metaBits.join('') +
        '<span class="mac-tooltip-source">' + sourceLine + '</span>' +
      '</span>' +
    '</div>';
  }).join("");

  return '<span class="mac-hover-trigger">' +
    '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(displayIp) + '">' + escapeHtml(displayIp) + '</span>' +
    '<span class="mac-badge-count">+' + ips.length + '</span>' +
    '<div class="mac-tooltip">' +
      '<div class="mac-tooltip-header">Associated IPs</div>' +
      tooltipRows +
    '</div>' +
  '</span>';
}

function macCellHTML(asset) {
  var macs = asset.macAddresses || [];
  var primary = asset.macAddress;
  if (!primary && macs.length === 0) return '-';

  var displayMac = primary || (macs.length > 0 ? macs[0].mac : "-");
  if (macs.length <= 1) return '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(displayMac) + '">' + escapeHtml(displayMac) + '</span>';

  var canDelete = canManageNetworks();

  // Multiple MACs — show primary with hover tooltip
  var tooltipRows = macs.map(function (m) {
    var isLatest = m.mac === displayMac;
    var sourceLine = escapeHtml(m.source || "") + (m.lastSeen ? ' &middot; ' + formatDate(m.lastSeen) : '');
    var subnetLine = '';
    if (m.subnetName || m.subnetCidr) {
      subnetLine = '<span class="mac-tooltip-subnet">';
      if (m.subnetName) subnetLine += escapeHtml(m.subnetName);
      if (m.subnetCidr) {
        subnetLine += (m.subnetName ? ' ' : '') +
          '<span class="mac-tooltip-cidr">' + escapeHtml(m.subnetCidr) + '</span>';
      }
      subnetLine += '</span>';
    }
    var deviceLine = m.device
      ? '<span class="mac-tooltip-subnet">' + escapeHtml(m.device) + '</span>'
      : '';
    var deleteBtn = canDelete
      ? '<button type="button" class="mac-tooltip-delete" title="Remove this MAC from the asset" data-asset-id="' +
          escapeHtml(asset.id) + '" data-mac="' + escapeHtml(m.mac) + '">&times;</button>'
      : '';
    return '<div class="mac-tooltip-row' + (isLatest ? ' mac-tooltip-latest' : '') + '">' +
      '<span class="mono copy-cell" title="Click to copy" data-copy="' + escapeHtml(m.mac) + '">' + escapeHtml(m.mac) + '</span>' +
      '<span class="mac-tooltip-meta">' +
        subnetLine +
        deviceLine +
        '<span class="mac-tooltip-source">' + sourceLine + '</span>' +
      '</span>' +
      deleteBtn +
    '</div>';
  }).join("");

  return '<span class="mac-hover-trigger">' +
    '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(displayMac) + '">' + escapeHtml(displayMac) + '</span>' +
    '<span class="mac-badge-count">' + macs.length + '</span>' +
    '<div class="mac-tooltip">' +
      '<div class="mac-tooltip-header">Associated MACs</div>' +
      tooltipRows +
    '</div>' +
  '</span>';
}

function assetFormHTML(defaults) {
  var d = defaults || {};
  var identitySection = d._editing
    ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
        '<div class="form-group"><label>Hostname</label><div class="form-value">' + escapeHtml(d.hostname || "-") + '</div></div>' +
        '<div class="form-group"><label>DNS Name</label><div class="form-value">' + escapeHtml(d.dnsName || "-") + '</div></div>' +
        '<div class="form-group" style="grid-column:1 / -1"><label>Serial Number</label><input type="text" id="f-serialNumber" value="' + escapeHtml(d.serialNumber || "") + '" placeholder="e.g. SN-DELL-001"></div>' +
      '</div>'
    : '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
        '<div class="form-group"><label>Hostname</label><input type="text" id="f-hostname" value="' + escapeHtml(d.hostname || "") + '" placeholder="e.g. server-01"></div>' +
        '<div class="form-group"><label>DNS Name</label><input type="text" id="f-dnsName" value="' + escapeHtml(d.dnsName || "") + '" placeholder="e.g. server-01.corp.local"></div>' +
        '<div class="form-group"><label>IP Address</label><input type="text" id="f-ipAddress" value="' + escapeHtml(d.ipAddress || "") + '" placeholder="e.g. 10.0.1.50"></div>' +
        '<div class="form-group"><label>MAC Address</label><input type="text" id="f-macAddress" value="' + escapeHtml(d.macAddress || "") + '" placeholder="e.g. 00:1A:2B:3C:4D:5E"></div>' +
        '<div class="form-group"><label>Serial Number</label><input type="text" id="f-serialNumber" value="' + escapeHtml(d.serialNumber || "") + '" placeholder="e.g. SN-DELL-001"></div>' +
      '</div>';
  return identitySection +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Asset Details</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Asset Tag</label><input type="text" id="f-assetTag" value="' + escapeHtml(d.assetTag || "") + '" placeholder="e.g. RGI-00421"></div>' +
    '<div class="form-group"><label>Manufacturer</label><input type="text" id="f-manufacturer" value="' + escapeHtml(d.manufacturer || "") + '" placeholder="e.g. Dell, Cisco, HP"></div>' +
    '<div class="form-group"><label>Model</label><input type="text" id="f-model" value="' + escapeHtml(d.model || "") + '" placeholder="e.g. PowerEdge R740"></div>' +
    '<div class="form-group"><label>Type' + (isAssetTypeLocked(d) ? ' <span style="font-weight:normal;color:var(--color-text-tertiary);font-size:0.75rem">(locked — discovered by integration)</span>' : '') + '</label><select id="f-assetType"' + (isAssetTypeLocked(d) ? ' disabled' : '') + '>' +
      '<option value="server"' + (d.assetType === "server" ? " selected" : "") + '>Server</option>' +
      '<option value="switch"' + (d.assetType === "switch" ? " selected" : "") + '>Switch</option>' +
      '<option value="router"' + (d.assetType === "router" ? " selected" : "") + '>Router</option>' +
      '<option value="firewall"' + (d.assetType === "firewall" ? " selected" : "") + '>Firewall</option>' +
      '<option value="workstation"' + (d.assetType === "workstation" ? " selected" : "") + '>Workstation</option>' +
      '<option value="printer"' + (d.assetType === "printer" ? " selected" : "") + '>Printer</option>' +
      '<option value="access_point"' + (d.assetType === "access_point" ? " selected" : "") + '>Access Point</option>' +
      '<option value="other"' + (d.assetType === "other" || !d.assetType ? " selected" : "") + '>Other</option>' +
    '</select></div>' +
    '<div class="form-group"><label>Status</label><select id="f-status">' +
      '<option value="storage"' + (d.status === "storage" || !d.status ? " selected" : "") + '>Storage</option>' +
      '<option value="active"' + (d.status === "active" ? " selected" : "") + '>Active</option>' +
      '<option value="maintenance"' + (d.status === "maintenance" ? " selected" : "") + '>Maintenance</option>' +
      '<option value="decommissioned"' + (d.status === "decommissioned" ? " selected" : "") + '>Decommissioned</option>' +
      '<option value="disabled"' + (d.status === "disabled" ? " selected" : "") + '>Disabled</option>' +
    '</select></div>' +
  '</div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Location & Ownership</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Location</label><input type="text" id="f-location" value="' + escapeHtml(d.location || "") + '" placeholder="e.g. DC1 Rack A3">' + (d.learnedLocation ? '<p class="hint">Learned: ' + escapeHtml(d.learnedLocation) + '</p>' : '') + '</div>' +
    '<div class="form-group"><label>Department</label><input type="text" id="f-department" value="' + escapeHtml(d.department || "") + '" placeholder="e.g. Infrastructure"></div>' +
    '<div class="form-group"><label>Assigned To</label><input type="text" id="f-assignedTo" value="' + escapeHtml(d.assignedTo || "") + '" placeholder="e.g. platform-team"></div>' +
    '<div class="form-group"><label>Operating System</label><input type="text" id="f-os" value="' + escapeHtml(d.os || "") + '" placeholder="e.g. RHEL 9, Windows Server 2022"></div>' +
  '</div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Procurement</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Acquired</label><input type="date" id="f-acquiredAt" value="' + dateInputVal(d.acquiredAt) + '"></div>' +
    '<div class="form-group"><label>Warranty Expires</label><input type="date" id="f-warrantyExpiry" value="' + dateInputVal(d.warrantyExpiry) + '"></div>' +
    '<div class="form-group"><label>Purchase Order</label><input type="text" id="f-purchaseOrder" value="' + escapeHtml(d.purchaseOrder || "") + '" placeholder="PO-12345"></div>' +
  '</div>' +
  '<div class="form-group"><label>Notes</label><textarea id="f-notes" rows="2" placeholder="Optional notes">' + escapeHtml(d.notes || "") + '</textarea></div>' +
  tagFieldHTML(d.tags || []);
}

function getAssetFormData() {
  var acq = document.getElementById("f-acquiredAt").value;
  var war = document.getElementById("f-warrantyExpiry").value;
  var data = {
    assetTag:      val("f-assetTag") || undefined,
    manufacturer:  val("f-manufacturer") || undefined,
    model:         val("f-model") || undefined,
    assetType:     document.getElementById("f-assetType").value,
    status:        document.getElementById("f-status").value,
    location:      val("f-location") || undefined,
    department:    val("f-department") || undefined,
    assignedTo:    val("f-assignedTo") || undefined,
    os:            val("f-os") || undefined,
    acquiredAt:    acq ? new Date(acq).toISOString() : undefined,
    warrantyExpiry:war ? new Date(war).toISOString() : undefined,
    purchaseOrder: val("f-purchaseOrder") || undefined,
    notes:         val("f-notes") || undefined,
    tags:          getTagFieldValue(),
  };
  // These fields are only editable on create, not edit
  if (document.getElementById("f-hostname"))     data.hostname     = val("f-hostname") || undefined;
  if (document.getElementById("f-dnsName"))      data.dnsName      = val("f-dnsName") || undefined;
  if (document.getElementById("f-ipAddress"))    data.ipAddress    = val("f-ipAddress") || undefined;
  if (document.getElementById("f-macAddress"))   data.macAddress   = val("f-macAddress") || undefined;
  if (document.getElementById("f-serialNumber")) data.serialNumber = val("f-serialNumber") || undefined;

  // Monitoring fields (only present when the Monitoring tab is rendered)
  var mon = document.getElementById("f-monitored");
  if (mon) {
    data.monitored = mon.checked;
    // Default Credential field removed — per-stream credential pickers on each
    // polling-method row are the right place for credentials. Clear any stale
    // monitorCredentialId that may have been set before this change.
    data.monitorCredentialId = null;
    var ivEl = document.getElementById("f-monitorInterval");
    if (ivEl) {
      var iv = parseInt(ivEl.value, 10);
      data.monitorIntervalSec = Number.isFinite(iv) && iv >= 5 ? iv : null;
    }
    var ptEl = document.getElementById("f-probeTimeoutMs");
    if (ptEl) {
      // Empty string = inherit (null). Out-of-range values get clamped by Zod
      // server-side, but be defensive here too — null on bad input.
      var ptRaw = ptEl.value === "" ? null : parseInt(ptEl.value, 10);
      data.probeTimeoutMs = (Number.isFinite(ptRaw) && ptRaw >= 100 && ptRaw <= 60000) ? ptRaw : null;
    }
    var telTimeoutEl = document.getElementById("f-cpuMemoryTimeoutMs");
    if (telTimeoutEl) {
      var telRaw = telTimeoutEl.value === "" ? null : parseInt(telTimeoutEl.value, 10);
      data.cpuMemoryTimeoutMs = (Number.isFinite(telRaw) && telRaw >= 1000 && telRaw <= 120000) ? telRaw : null;
    }
    var tempTimeoutEl = document.getElementById("f-temperatureTimeoutMs");
    if (tempTimeoutEl) {
      var tempRaw = tempTimeoutEl.value === "" ? null : parseInt(tempTimeoutEl.value, 10);
      data.temperatureTimeoutMs = (Number.isFinite(tempRaw) && tempRaw >= 1000 && tempRaw <= 120000) ? tempRaw : null;
    }
    var sysTimeoutEl = document.getElementById("f-systemInfoTimeoutMs");
    if (sysTimeoutEl) {
      var sysRaw = sysTimeoutEl.value === "" ? null : parseInt(sysTimeoutEl.value, 10);
      data.systemInfoTimeoutMs = (Number.isFinite(sysRaw) && sysRaw >= 1000 && sysRaw <= 120000) ? sysRaw : null;
    }
    // Per-stream polling-method overrides. Each select returns null
    // (= inherit) or one of "rest_api"/"snmp"/"winrm"/"ssh"/"icmp".
    var polling = _polarisReadPollingFourStream("f-");
    if (document.getElementById("f-responseTimePolling")) {
      data.responseTimePolling = polling.responseTimePolling;
      data.cpuMemoryPolling    = polling.cpuMemoryPolling;
      data.temperaturePolling  = polling.temperaturePolling;
      data.interfacesPolling   = polling.interfacesPolling;
      data.lldpPolling         = polling.lldpPolling;
      data.storagePolling      = polling.storagePolling;
    }
    // Per-stream credential overrides. Empty string → null (source default).
    var rtCredEl   = document.getElementById("f-responseTimeCredential");
    var telCredEl  = document.getElementById("f-cpuMemoryCredential");
    var tempCredEl = document.getElementById("f-temperatureCredential");
    var ifCredEl   = document.getElementById("f-interfacesCredential");
    var lldpCredEl = document.getElementById("f-lldpCredential");
    data.responseTimeCredentialId = rtCredEl   ? (rtCredEl.value   || null) : undefined;
    data.cpuMemoryCredentialId    = telCredEl  ? (telCredEl.value  || null) : undefined;
    data.temperatureCredentialId  = tempCredEl ? (tempCredEl.value || null) : undefined;
    data.interfacesCredentialId   = ifCredEl   ? (ifCredEl.value   || null) : undefined;
    data.lldpCredentialId         = lldpCredEl ? (lldpCredEl.value || null) : undefined;
    // Per-stream MIB overrides. Empty string → null (Automatic).
    var rtMibEl   = document.getElementById("f-responseTimeMib");
    var telMibEl  = document.getElementById("f-telemetryMib");
    var tempMibEl = document.getElementById("f-temperatureMib");
    var ifMibEl   = document.getElementById("f-interfacesMib");
    var lldpMibEl = document.getElementById("f-lldpMib");
    data.responseTimeMibId = rtMibEl   ? (rtMibEl.value   || null) : undefined;
    data.cpuMemoryMibId    = telMibEl  ? (telMibEl.value  || null) : undefined;
    data.temperatureMibId  = tempMibEl ? (tempMibEl.value || null) : undefined;
    data.interfacesMibId   = ifMibEl   ? (ifMibEl.value   || null) : undefined;
    data.lldpMibId         = lldpMibEl ? (lldpMibEl.value || null) : undefined;
  }
  return data;
}

// ─── Tabbed asset modal scaffolding ────────────────────────────────────────

function assetMonitoringFormHTML(asset, managedAgent) {
  var interval = asset && asset.monitorIntervalSec != null ? asset.monitorIntervalSec : "";
  var probeTimeout = asset && asset.probeTimeoutMs != null ? asset.probeTimeoutMs : "";
  var telemetryTimeout   = asset && asset.cpuMemoryTimeoutMs   != null ? asset.cpuMemoryTimeoutMs   : "";
  var temperatureTimeout = asset && asset.temperatureTimeoutMs != null ? asset.temperatureTimeoutMs : "";
  var systemInfoTimeout  = asset && asset.systemInfoTimeoutMs  != null ? asset.systemInfoTimeoutMs  : "";
  var monitored = asset && asset.monitored ? " checked" : "";
  // Asset id is needed to fetch effective settings + populate the Asset
  // Overrides button — empty on the create flow.
  var assetIdAttr = (asset && asset.id) ? ' data-asset-id="' + escapeHtml(asset.id) + '"' : "";

  // Per-stream polling-method overrides. Compat-aware — methods that don't
  // apply to this asset's source are hidden inside the helper. Always
  // visible when monitoring is enabled (every asset has at least the
  // response-time stream); the resolver labels each "Inherit" option with
  // the source default (REST API / ICMP / Not delivered).
  var integrationType = (asset && asset.discoveredByIntegration && asset.discoveredByIntegration.type) || null;
  var assetSourceKind = integrationType || "manual";
  if (!_POLLING_COMPAT[assetSourceKind]) assetSourceKind = "manual";
  var pollingCurrent = {
    responseTimePolling: asset && asset.responseTimePolling,
    cpuMemoryPolling:    asset && asset.cpuMemoryPolling,
    temperaturePolling:  asset && asset.temperaturePolling,
    interfacesPolling:   asset && asset.interfacesPolling,
    lldpPolling:         asset && asset.lldpPolling,
    storagePolling:      asset && asset.storagePolling,
  };
  // Per-stream credential IDs (null = use source default at runtime).
  var rtCredId   = (asset && asset.responseTimeCredentialId)  || "";
  var telCredId  = (asset && asset.cpuMemoryCredentialId)     || "";
  var tempCredId = (asset && asset.temperatureCredentialId)   || "";
  var ifCredId   = (asset && asset.interfacesCredentialId)    || "";
  var lldpCredId = (asset && asset.lldpCredentialId)          || "";

  // Per-stream MIB IDs (null = Automatic).
  var rtMibId   = (asset && asset.responseTimeMibId)  || "";
  var telMibId  = (asset && asset.cpuMemoryMibId)     || "";
  var tempMibId = (asset && asset.temperatureMibId)   || "";
  var ifMibId   = (asset && asset.interfacesMibId)    || "";
  var lldpMibId = (asset && asset.lldpMibId)          || "";

  // Auto MIB names for the "Automatic" option label — vendor-aware for CPU/memory.
  var _mfr = ((asset && asset.manufacturer) || "").toLowerCase();
  var _autoTelMib = "HOST-RESOURCES-MIB";
  if (/fortinet/.test(_mfr))          _autoTelMib = "FORTINET-FORTIGATE-MIB";
  else if (/cisco/.test(_mfr))        _autoTelMib = "CISCO-PROCESS-MIB";
  else if (/juniper/.test(_mfr))      _autoTelMib = "JUNIPER-MIB";
  else if (/mikrotik/.test(_mfr))     _autoTelMib = "MIKROTIK-MIB";
  else if (/hp|aruba|hewlett/.test(_mfr)) _autoTelMib = "HP-ICF-OID-MIB";
  else if (/dell/.test(_mfr))         _autoTelMib = "DELL-MIB";
  // Temperature MIB default — ENTITY-SENSOR-MIB across the board; Fortinet's
  // fgHwSensorTable lives in FORTINET-FORTIGATE-MIB (the collector tries it
  // before falling back to ENTITY-SENSOR-MIB).
  var _autoTempMib = /fortinet/.test(_mfr) ? "FORTINET-FORTIGATE-MIB" : "ENTITY-SENSOR-MIB";
  var _autoMibNames = {
    responseTime: "SNMPv2-MIB",
    telemetry:    _autoTelMib,
    temperature:  _autoTempMib,
    interfaces:   "IF-MIB",
    lldp:         "LLDP-MIB",
  };

  // Per-stream subtab body: polling-method dropdown (with credential + MIB
  // sub-rows beneath that show/hide based on selected method), then a per-
  // stream cadence + timeout block, then on Response Time only the failure
  // threshold. Preserves the legacy DOM ids the save reader in
  // extractAssetEditData() reads (`f-responseTimePolling` /
  // `f-responseTimeCredential` / `f-responseTimeMib` / `f-monitorInterval` /
  // `f-probeTimeoutMs` / etc.). LLDP + Storage subtabs share the system-info
  // cadence + timeout with the Interfaces subtab — the input lives in
  // Interfaces and the LLDP/Storage subtabs render a hint pointing operators
  // there (Asset row only carries 4 cadence columns: monitorIntervalSec,
  // cpuMemoryIntervalSec, temperatureIntervalSec, systemInfoIntervalSec).
  //
  // "icmp" and "disabled" never need a credential; "agent" doesn't either —
  // the Polaris Agent's own per-asset bearer (issued at install time) is
  // implicit and never picked from the credential store.
  function streamPollingBlock(streamName, pollingId, credSelectId, mibSelectId, currentPoll, currentCredId, currentMibId, autoMibName) {
    var needsCred = currentPoll && currentPoll !== "icmp" && currentPoll !== "disabled" && currentPoll !== "agent";
    var isSnmp    = currentPoll === "snmp";
    var credDisplay = needsCred ? "flex" : "none";
    var mibDisplay  = isSnmp   ? "flex" : "none";
    // Storage has no per-stream MIB column on Asset — HOST-RESOURCES-MIB +
    // the vendor disk fallback in pickVendorProfileMerged covers it without
    // operator input. Skip the MIB sub-row when no mibSelectId was passed.
    var mibSubRow = mibSelectId
      ? '<div class="form-group" id="' + pollingId + '-mib-wrap" style="display:' + mibDisplay + ';align-items:center;gap:0.5rem;margin-top:0.5rem">' +
          '<label style="margin:0;font-size:0.85rem;color:var(--color-text-secondary);min-width:90px">MIB</label>' +
          '<select id="' + mibSelectId + '" data-current-id="' + escapeHtml(currentMibId) + '" data-auto-mib-name="' + escapeHtml(autoMibName || "") + '" data-mib-picker="1" style="flex:1">' +
            _mibOptionsHTML(currentMibId, autoMibName) +
          '</select>' +
        '</div>'
      : '';
    return '<div class="form-group"><label>Polling method</label>' +
        _polarisPollingDropdownHTML(pollingId, assetSourceKind, streamName, currentPoll) +
        '<p class="hint">Select the protocol Polaris uses for this stream. "Inherit" falls through to the resolved class / integration / manual / source-default tiers.</p>' +
      '</div>' +
      '<div class="form-group" id="' + pollingId + '-cred-wrap" style="display:' + credDisplay + ';align-items:center;gap:0.5rem;margin-top:0.5rem">' +
        '<label style="margin:0;font-size:0.85rem;color:var(--color-text-secondary);min-width:90px">Credential</label>' +
        '<select id="' + credSelectId + '" data-current-id="' + escapeHtml(currentCredId) + '" style="flex:1"></select>' +
      '</div>' +
      mibSubRow;
  }

  // Each interval/timeout input keeps its legacy DOM id + tier-badge span id
  // so _populateAssetMonitorTierBadges() and the save reader keep working
  // unchanged.
  function intervalInput(id, label, value, min, max, hint) {
    return '<div class="form-group">' +
      '<label>' + escapeHtml(label) + ' <span class="tier-badge" id="' + id + '-tier" style="margin-left:0.5rem;font-size:0.78rem;font-weight:normal;color:var(--color-text-tertiary)"></span></label>' +
      '<input type="number" id="' + id + '" min="' + min + '" max="' + max + '" value="' + escapeHtml(String(value)) + '" placeholder="leave blank to inherit" style="max-width:240px">' +
      (hint ? '<p class="hint">' + hint + '</p>' : '') +
    '</div>';
  }
  function probeTimeoutInput() {
    return '<div class="form-group">' +
      '<label>Probe Timeout Override (ms) <span class="tier-badge" id="f-probeTimeoutMs-tier" style="margin-left:0.5rem;font-size:0.78rem;font-weight:normal;color:var(--color-text-tertiary)"></span></label>' +
      '<input type="number" id="f-probeTimeoutMs" min="100" max="60000" value="' + escapeHtml(String(probeTimeout)) + '" placeholder="leave blank to inherit" style="max-width:240px">' +
      '<p class="hint" id="f-probeTimeoutMs-warn" style="display:none;color:var(--color-warning)">⚠ Below 500 ms — probes will likely false-fail under healthy network conditions.</p>' +
      '<p class="hint">Range 100..60000 ms; default is 5000 ms. Inherits from the resolved tier when blank.</p>' +
    '</div>';
  }
  function failureThresholdInput() {
    // Per-asset failure threshold isn't a column on Asset — it resolves from
    // the class / integration / manual tier. Render the input read-only here
    // with a hint so operators see it in the right place but edit it at the
    // tier where it lives.
    return '<div class="form-group">' +
      '<label>Failure Threshold</label>' +
      '<p class="hint">Inherited from the resolved tier. Edit at the integration\'s Monitoring tab or via the Monitoring Settings button (Assets page).</p>' +
    '</div>';
  }

  // Subtab body builders — one per stream. LLDP + Storage share systemInfo
  // cadence with Interfaces at the asset tier (Asset row has no separate
  // lldpIntervalSec / storageIntervalSec columns); their subtabs link to
  // Interfaces for those inputs.
  function bodyResponseTime() {
    return streamPollingBlock("responseTime", "f-responseTimePolling", "f-responseTimeCredential", "f-responseTimeMib", pollingCurrent.responseTimePolling, rtCredId, rtMibId, _autoMibNames.responseTime) +
      intervalInput("f-monitorInterval", "Poll Interval Override (seconds)", interval, 5, 86400, "Minimum 5 seconds. Inherits from the resolved tier when blank.") +
      probeTimeoutInput() +
      failureThresholdInput();
  }
  function bodyCpuMemory() {
    return streamPollingBlock("telemetry", "f-cpuMemoryPolling", "f-cpuMemoryCredential", "f-telemetryMib", pollingCurrent.cpuMemoryPolling, telCredId, telMibId, _autoMibNames.telemetry) +
      intervalInput("f-cpuMemoryTimeoutMs", "CPU/Memory Timeout Override (ms)", telemetryTimeout, 1000, 120000, "Per-request timeout for the CPU/memory collector (FortiOS REST + SNMP). Range 1000..120000 ms; default 10000 ms. Inherits when blank.");
  }
  function bodyTemperature() {
    return streamPollingBlock("temperature", "f-temperaturePolling", "f-temperatureCredential", "f-temperatureMib", pollingCurrent.temperaturePolling, tempCredId, tempMibId, _autoMibNames.temperature) +
      intervalInput("f-temperatureTimeoutMs", "Hardware Sensor Timeout Override (ms)", temperatureTimeout, 1000, 120000, "Per-request timeout for the hardware-sensor collector (FortiOS sensor-info / SNMP fgHwSensorTable / ENTITY-SENSOR-MIB). Range 1000..120000 ms; default 10000 ms. Inherits when blank.");
  }
  function bodyInterfaces() {
    return streamPollingBlock("interfaces", "f-interfacesPolling", "f-interfacesCredential", "f-interfacesMib", pollingCurrent.interfacesPolling, ifCredId, ifMibId, _autoMibNames.interfaces) +
      intervalInput("f-systemInfoTimeoutMs", "System Info Timeout Override (ms)", systemInfoTimeout, 1000, 120000, "Per-request timeout for the interface / storage / LLDP collector. Range 1000..120000 ms; default 10000 ms. Inherits when blank.");
  }
  function bodyStorage() {
    return streamPollingBlock("storage", "f-storagePolling", "f-storageCredential", null, pollingCurrent.storagePolling, "", "", null) +
      '<p class="hint" style="margin:0.5rem 0 0;padding:0.5rem 0.65rem;background:var(--color-bg-tertiary);border-radius:var(--radius-sm);color:var(--color-text-secondary)">Cadence + timeout for this stream are shared with the <strong>Interfaces</strong> subtab at the per-asset tier — edit them there.</p>';
  }
  function bodyLldp() {
    return streamPollingBlock("lldp", "f-lldpPolling", "f-lldpCredential", "f-lldpMib", pollingCurrent.lldpPolling, lldpCredId, lldpMibId, _autoMibNames.lldp) +
      '<p class="hint" style="margin:0.5rem 0 0;padding:0.5rem 0.65rem;background:var(--color-bg-tertiary);border-radius:var(--radius-sm);color:var(--color-text-secondary)">Cadence + timeout for this stream are shared with the <strong>Interfaces</strong> subtab at the per-asset tier — edit them there.</p>';
  }

  var streamTabs = [
    { key: "responseTime", label: "Response Time", html: bodyResponseTime() },
    { key: "cpuMemory",    label: "CPU/Memory",    html: bodyCpuMemory()    },
    { key: "temperature",  label: "Hardware Sensors", html: bodyTemperature()  },
    { key: "interfaces",   label: "Interfaces",    html: bodyInterfaces()   },
    { key: "lldp",         label: "LLDP",          html: bodyLldp()         },
    { key: "storage",      label: "Storage",       html: bodyStorage()      },
  ];

  // _intRenderTabbedBody + _intWireModalTabs are global helpers from
  // integrations.js (loaded before assets.js on assets.html). The tab key
  // namespaces the strip so it doesn't collide with the Integration modal's
  // stream-tab strips when both pages share a session.
  var transportBlockHtml =
    '<div id="f-transport-wrap" style="margin-top:0.5rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0.5rem 0 0.5rem 0">Polling Methods</p>' +
      _intRenderTabbedBody("asset-mon-streams", streamTabs) +
      '<p class="hint" style="margin-top:0.5rem">Per-asset overrides win over class / integration / source-default tiers. When a method needs a credential, "Source default" lets the asset inherit the integration\'s configured credential at runtime.</p>' +
    '</div>';

  // ─── Polaris Agent block ───────────────────────────────────────────
  //
  // Three states:
  //   - No agent + source supports agent  → "Install Polaris Agent…" button
  //   - Agent in flight (pending/uploading/enrolling/upgrading/uninstalling)
  //                                       → status pill + read-only banner
  //   - Agent active                      → status pill + Upgrade / Uninstall
  //
  // When the agent is active OR in flight, the Polling Methods section
  // is suppressed — the agent owns all four streams. The four *Polling
  // fields on the Asset are stamped to "agent" server-side at enrollment
  // time so the periodic puller cleanly no-ops; clicking Save on this
  // modal does NOT overwrite them (the form ignores the dropdowns when
  // the polling section is hidden).
  var sourceSupportsAgent = (assetSourceKind === "manual" ||
                             assetSourceKind === "activedirectory" ||
                             assetSourceKind === "entraid" ||
                             assetSourceKind === "windowsserver");
  var agentInFlight = managedAgent && (
    managedAgent.installStatus === "pending"      ||
    managedAgent.installStatus === "uploading"    ||
    managedAgent.installStatus === "enrolling"    ||
    managedAgent.installStatus === "upgrading"    ||
    managedAgent.installStatus === "uninstalling"
  );
  var agentActive = managedAgent && managedAgent.installStatus === "active";
  var agentBlockHtml = "";
  if (agentActive) {
    agentBlockHtml =
      '<div class="form-group" style="margin-top:1rem;padding:1rem;border:1px solid var(--color-border);border-radius:6px;background:var(--color-surface-1)">' +
        '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem">' +
          '<strong>Polaris Agent</strong>' +
          '<span style="font-size:0.75rem;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,0.06);color:var(--color-success)">Active</span>' +
        '</div>' +
        '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin:0 0 0.5rem">' +
          'Agent v' + escapeHtml(managedAgent.agentVersion || "?") + ' is installed on this host and owns all four monitoring streams. ' +
          'The polling-methods section is hidden — the agent pushes samples directly. Manage the agent from the asset details modal → System tab.' +
        '</p>' +
        '<div style="font-size:0.78rem;color:var(--color-text-tertiary)">' +
          'Platform: ' + escapeHtml(managedAgent.osPlatform || "?") + '/' + escapeHtml(managedAgent.arch || "?") +
          (managedAgent.lastSeenAt ? ' · Last seen: ' + escapeHtml(new Date(managedAgent.lastSeenAt).toLocaleString()) : '') +
        '</div>' +
      '</div>';
  } else if (agentInFlight) {
    agentBlockHtml =
      '<div class="form-group" style="margin-top:1rem;padding:1rem;border:1px solid var(--color-border);border-radius:6px;background:var(--color-surface-1)">' +
        '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem">' +
          '<strong>Polaris Agent</strong>' +
          '<span style="font-size:0.75rem;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,0.06);color:var(--color-text-secondary)">' +
            escapeHtml(_agentStatusLabel(managedAgent.installStatus)) + '</span>' +
        '</div>' +
        '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin:0">' +
          'An install or uninstall is in flight. Watch progress on the asset details modal → System tab.' +
        '</p>' +
      '</div>';
  } else if (sourceSupportsAgent && asset && asset.id) {
    // No agent installed yet + asset already exists (we have an id to
    // install on). On the CREATE flow asset.id is undefined; we hide
    // the button there because the install service needs the row to
    // exist first.
    agentBlockHtml =
      '<div class="form-group" style="margin-top:1rem;padding:1rem;border:1px dashed var(--color-border);border-radius:6px;background:var(--color-surface-1)">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:0">' +
            '<strong>Polaris Agent</strong>' +
            '<p class="hint" style="margin:0.25rem 0 0">Install a lightweight agent on this host. The agent pushes monitoring samples back to Polaris directly and replaces the polling-methods section below entirely.</p>' +
          '</div>' +
          '<button type="button" class="btn btn-secondary" id="btn-edit-modal-install-agent" data-asset-id="' + escapeHtml(asset.id) + '">Install Polaris Agent…</button>' +
        '</div>' +
      '</div>';
  }

  // Hide the polling-methods section entirely when an agent is active
  // or in flight. Otherwise the operator could pick a method that gets
  // ignored at resolution time + see misleading dropdown state.
  var transportBlockShown = !(agentActive || agentInFlight);

  return (
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" id="f-monitored"' + monitored + '>' +
        '<span>Enable monitoring for this asset</span>' +
      '</label>' +
      '<p class="hint">A successful probe means the credential authenticated. Probes write a sample row each cycle; failed probes count as packet loss.</p>' +
    '</div>' +
    agentBlockHtml +
    (transportBlockShown ? transportBlockHtml : '') +
    '<div class="form-group" id="f-asset-overrides-wrap"' + assetIdAttr + ' style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--color-border);display:none">' +
      '<button type="button" class="btn btn-secondary" id="btn-asset-overrides-list">Show other asset overrides under this scope</button>' +
      '<p class="hint" id="f-asset-overrides-hint">Lists every asset under the same (class, asset source) scope that has its own per-asset overrides.</p>' +
    '</div>'
  );
}

// Map polling method → which credential type it needs (null = no credential).
function _credTypeForPolling(method) {
  if (method === "snmp")     return "snmp";
  if (method === "winrm")    return "winrm";
  if (method === "ssh")      return "ssh";
  if (method === "rest_api") return "restapi";
  return null;
}

// Options for a per-stream credential picker: "Source default" first (value=""),
// then credentials matching credType. When credType is null, just the default.
function _credentialOptionsForStream(selectedId, credType) {
  var opts = '<option value="">— Source default —</option>';
  if (!credType) return opts;
  _credentialCache.list.forEach(function (c) {
    if (c.type !== credType) return;
    opts += '<option value="' + escapeHtml(c.id) + '"' +
      (selectedId === c.id ? " selected" : "") + '>' +
      escapeHtml(c.name) +
      '</option>';
  });
  return opts;
}

async function _wireMonitorEditTab(asset) {
  await _ensureCredentials();
  var monChk = document.getElementById("f-monitored");
  var intervalEl = document.getElementById("f-monitorInterval");
  var probeTimeoutEl = document.getElementById("f-probeTimeoutMs");
  var probeTimeoutWarn = document.getElementById("f-probeTimeoutMs-warn");

  var transportWrap = document.getElementById("f-transport-wrap");

  // Wire the per-stream subtab strip inside the Polling Methods block so
  // clicking a stream tab actually swaps the body. _intWireModalTabs is a
  // global helper from integrations.js (loaded before assets.js on every
  // page that needs the asset modal).
  if (transportWrap && typeof _intWireModalTabs === "function") {
    _intWireModalTabs("asset-mon-streams");
  }

  // Per-stream selects and their corresponding polling selects. Storage has
  // no MIB picker (HOST-RESOURCES-MIB + vendor fallback covers it without
  // operator input), so mibId is null and the wiring helper below skips the
  // MIB-show/hide step for that row.
  var streamDefs = [
    { pollId: "f-responseTimePolling", credId: "f-responseTimeCredential", mibId: "f-responseTimeMib" },
    { pollId: "f-cpuMemoryPolling",    credId: "f-cpuMemoryCredential",    mibId: "f-telemetryMib"    },
    { pollId: "f-temperaturePolling",  credId: "f-temperatureCredential",  mibId: "f-temperatureMib"  },
    { pollId: "f-interfacesPolling",   credId: "f-interfacesCredential",   mibId: "f-interfacesMib"   },
    { pollId: "f-storagePolling",      credId: "f-storageCredential",      mibId: null                },
    { pollId: "f-lldpPolling",         credId: "f-lldpCredential",         mibId: "f-lldpMib"         },
  ];

  function refreshStreamCred(streamDef) {
    var pollEl    = document.getElementById(streamDef.pollId);
    var credEl    = document.getElementById(streamDef.credId);
    var credWrap  = document.getElementById(streamDef.pollId + "-cred-wrap");
    var mibWrap   = document.getElementById(streamDef.pollId + "-mib-wrap");
    if (!pollEl) return;
    var method   = pollEl.value || null;
    var credType = _credTypeForPolling(method);
    if (credEl && credWrap) {
      if (credType) {
        var current = credEl.getAttribute("data-current-id") || "";
        credEl.innerHTML = _credentialOptionsForStream(current, credType);
        credWrap.style.display = "flex";
      } else {
        credWrap.style.display = "none";
      }
    }
    // MIB sub-row appears only when the stream is set to SNMP. Streams that
    // don't carry a MIB picker (storage) have no wrap div to toggle.
    if (mibWrap && streamDef.mibId) mibWrap.style.display = (method === "snmp") ? "flex" : "none";
  }

  function refresh() {
    var enabled = !!(monChk && monChk.checked);
    if (intervalEl) intervalEl.disabled = !enabled;
    if (probeTimeoutEl) probeTimeoutEl.disabled = !enabled;
    if (transportWrap) {
      transportWrap.style.display = enabled ? "block" : "none";
    }
    // Populate / show-hide per-stream credential and MIB pickers.
    streamDefs.forEach(refreshStreamCred);
  }
  if (monChk) monChk.addEventListener("change", refresh);

  // Wire per-stream polling dropdowns so credential and MIB sub-rows update on change.
  streamDefs.forEach(function (sd) {
    var pollEl = document.getElementById(sd.pollId);
    if (pollEl) {
      pollEl.addEventListener("change", function () {
        // Clear the stored "current" so switching methods doesn't carry over
        // a credential from a different type.
        var credEl = document.getElementById(sd.credId);
        if (credEl) credEl.setAttribute("data-current-id", "");
        refreshStreamCred(sd);
      });
    }
  });

  refresh();

  // Soft warning when probe timeout drops below 500 ms — Zod still allows
  // 100, but at that range probes false-fail under healthy network conditions.
  function checkProbeTimeoutWarn() {
    if (!probeTimeoutEl || !probeTimeoutWarn) return;
    var v = parseInt(probeTimeoutEl.value, 10);
    var show = Number.isFinite(v) && v > 0 && v < 500;
    probeTimeoutWarn.style.display = show ? "block" : "none";
  }
  if (probeTimeoutEl) {
    probeTimeoutEl.addEventListener("input", checkProbeTimeoutWarn);
    checkProbeTimeoutWarn();
  }

  // Tier badges + Asset Overrides button — only meaningful on edit (existing
  // asset). The create flow has no asset id and skips both.
  if (asset && asset.id) {
    _populateAssetMonitorTierBadges(asset);
    _wireAssetOverridesButton(asset);
  }
}

/**
 * Fetches the per-asset effective monitor settings and stamps a small
 * "(from class override: 60s)" badge next to each cadence/timeout label.
 * Best-effort — failure leaves the badges blank.
 */
async function _populateAssetMonitorTierBadges(asset) {
  var eff;
  try { eff = await api.assets.effectiveMonitorSettings(asset.id); } catch (e) { return; }
  if (!eff || !eff.provenance || !eff.resolved) return;
  // Cache resolved settings so stale-banner slots can re-evaluate against the
  // class/integration tier the sync render couldn't see, and fire that
  // re-evaluation immediately for any slots already in the DOM.
  _effectiveResolvedByAssetId.set(asset.id, eff.resolved);
  _updateStaleBannersFromEffective(asset.id, asset);

  function tierLabel(tier) {
    if (tier === "asset")       return null; // own override — no badge needed; the input itself IS the value
    if (tier === "class")       return "from class override";
    if (tier === "integration") return "from integration tier";
    if (tier === "manual")      return "from manual tier";
    return null;
  }
  function setBadge(spanId, fieldKey, suffix) {
    var span = document.getElementById(spanId);
    if (!span) return;
    var prov  = eff.provenance[fieldKey];
    var label = tierLabel(prov);
    if (!label) {
      // "asset" (per-asset override is set) — no inherited badge to show.
      // Clear the span in case a stale value is hanging around.
      span.textContent = "";
      return;
    }
    span.textContent = "(" + label + ": " + eff.resolved[fieldKey] + (suffix || "") + ")";
  }
  setBadge("f-monitorInterval-tier",       "intervalSeconds",       " s");
  setBadge("f-probeTimeoutMs-tier",        "probeTimeoutMs",        " ms");
  setBadge("f-cpuMemoryTimeoutMs-tier",    "cpuMemoryTimeoutMs",    " ms");
  setBadge("f-temperatureTimeoutMs-tier",  "temperatureTimeoutMs",  " ms");
  setBadge("f-systemInfoTimeoutMs-tier",   "systemInfoTimeoutMs",   " ms");

  // Update each polling dropdown's "Inherit" option to show the actual resolved
  // method and which tier it comes from, instead of the hardcoded source default.
  // Only applies when the asset has no per-asset override (provenance != "asset");
  // when the asset has its own override we don't know the next-tier fallback.
  function updatePollingInheritLabel(selectId, fieldKey) {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    var prov = eff.provenance[fieldKey];
    if (!prov || prov === "asset") return;
    var resolved = eff.resolved[fieldKey];
    var inheritOpt = sel.querySelector('option[value=""]');
    if (!inheritOpt) return;
    if (!resolved) {
      // No explicit method set at any tier — source default applies at runtime.
      // Leave the hardcoded "Source default: X" label the HTML was built with.
      return;
    }
    var methodLabel = _POLLING_LABELS[resolved] || resolved;
    var integName = asset && asset.discoveredByIntegration && asset.discoveredByIntegration.name;
    var tierStr = prov === "integration" && integName
      ? integName
      : { "class": "class override", "integration": "integration tier", "manual": "manual tier" }[prov] || prov;
    inheritOpt.textContent = "Inherit (" + tierStr + ": " + methodLabel + ")";
  }
  updatePollingInheritLabel("f-responseTimePolling", "responseTimePolling");
  updatePollingInheritLabel("f-cpuMemoryPolling",    "cpuMemoryPolling");
  updatePollingInheritLabel("f-temperaturePolling",  "temperaturePolling");
  updatePollingInheritLabel("f-interfacesPolling",   "interfacesPolling");
  updatePollingInheritLabel("f-lldpPolling",         "lldpPolling");
  updatePollingInheritLabel("f-storagePolling",      "storagePolling");
}

/**
 * Reveal + wire the "Show other asset overrides" button. Click opens a
 * slide-over modal listing assets under the same (assetType, integrationId)
 * scope that have at least one per-asset override set.
 */
function _wireAssetOverridesButton(asset) {
  var wrap = document.getElementById("f-asset-overrides-wrap");
  var btn  = document.getElementById("btn-asset-overrides-list");
  if (!wrap || !btn) return;
  wrap.style.display = "block";
  btn.addEventListener("click", function () {
    _openAssetOverridesSlideover({
      integrationId: asset.discoveredByIntegrationId || null,
      assetType:     asset.assetType,
      thisAssetId:   asset.id,
      sourceLabel:   asset.discoveredByIntegration ? asset.discoveredByIntegration.name : "Manual",
    });
  });
}

async function _openAssetOverridesSlideover(scope) {
  var classLabel = ASSET_TYPE_LABELS[scope.assetType] || scope.assetType;
  var titleScope = classLabel + " @ " + (scope.sourceLabel || "Manual");
  openModal(
    "Asset Overrides — " + titleScope,
    '<div class="empty-state" style="padding:2rem 0">Loading…</div>',
    '<button class="btn btn-secondary" onclick="closeModal()">Close</button>'
  );
  var rows;
  try {
    rows = await api.monitorSettings.assetOverrides({
      integrationId: scope.integrationId,
      assetType:     scope.assetType,
    });
  } catch (err) {
    var bodyEl = document.querySelector("#modal-overlay .modal-body");
    if (bodyEl) bodyEl.innerHTML = '<div class="empty-state" style="padding:2rem 0;color:var(--color-danger)">Failed to load: ' + escapeHtml(err.message || "unknown error") + '</div>';
    return;
  }
  // Exclude the asset whose modal is being viewed — the operator's already
  // looking at it. Showing it again would just be visual noise.
  var others = (rows || []).filter(function (r) { return r.id !== scope.thisAssetId; });
  var bodyEl = document.querySelector("#modal-overlay .modal-body");
  if (!bodyEl) return;
  if (others.length === 0) {
    bodyEl.innerHTML = '<div class="empty-state" style="padding:2rem 0">No other ' +
      escapeHtml(classLabel.toLowerCase()) +
      ' assets under this source have per-asset overrides.</div>';
    return;
  }
  bodyEl.innerHTML = '<p class="hint" style="margin-bottom:0.75rem">Other ' +
    escapeHtml(classLabel.toLowerCase()) +
    ' assets discovered by ' + escapeHtml(scope.sourceLabel || "Manual") +
    ' that have at least one per-asset monitor override. Click a row to open the asset.</p>' +
    '<table style="width:100%;border-collapse:collapse">' +
      '<thead><tr>' +
        '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border)">Hostname</th>' +
        '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border)">IP</th>' +
        '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border)">Overrides</th>' +
      '</tr></thead>' +
      '<tbody>' +
      others.map(function (a) {
        var bits = [];
        if (a.monitorIntervalSec     != null) bits.push("interval=" + a.monitorIntervalSec + "s");
        if (a.cpuMemoryIntervalSec   != null) bits.push("cpu-mem=" + a.cpuMemoryIntervalSec + "s");
        if (a.temperatureIntervalSec != null) bits.push("temp=" + a.temperatureIntervalSec + "s");
        if (a.systemInfoIntervalSec  != null) bits.push("sysinfo=" + a.systemInfoIntervalSec + "s");
        if (a.probeTimeoutMs         != null) bits.push("probe-timeout=" + a.probeTimeoutMs + "ms");
        if (a.cpuMemoryTimeoutMs     != null) bits.push("cpu-mem-timeout=" + a.cpuMemoryTimeoutMs + "ms");
        if (a.temperatureTimeoutMs   != null) bits.push("temp-timeout=" + a.temperatureTimeoutMs + "ms");
        if (a.systemInfoTimeoutMs    != null) bits.push("sysinfo-timeout=" + a.systemInfoTimeoutMs + "ms");
        return '<tr style="cursor:pointer" data-asset-link="' + escapeHtml(a.id) + '">' +
          '<td style="padding:6px 8px"><a href="#" onclick="return false">' + escapeHtml(a.hostname || "(no hostname)") + '</a></td>' +
          '<td style="padding:6px 8px;font-family:var(--font-mono)">' + escapeHtml(a.ipAddress || "-") + '</td>' +
          '<td style="padding:6px 8px;font-size:0.78rem;color:var(--color-text-tertiary)">' + escapeHtml(bits.join(", ")) + '</td>' +
        '</tr>';
      }).join("") +
      '</tbody>' +
    '</table>';
  bodyEl.querySelectorAll("[data-asset-link]").forEach(function (row) {
    row.addEventListener("click", function () {
      var id = row.getAttribute("data-asset-link");
      closeModal();
      // Defer one tick so the close animation doesn't fight the open below.
      setTimeout(function () { openViewModal(id); }, 100);
    });
  });
}

function _renderTabbedBody(prefix, tabs) {
  // tabs: [{key, label, html}]
  var tabBar = '<div class="page-tabs" id="' + prefix + '-tabs" style="margin-bottom:1rem">' +
    tabs.map(function (t, i) {
      return '<button type="button" class="page-tab' + (i === 0 ? " active" : "") + '" data-tab="' + t.key + '">' + escapeHtml(t.label) + '</button>';
    }).join("") +
    '</div>';
  var panels = tabs.map(function (t, i) {
    return '<div class="page-tab-panel' + (i === 0 ? " active" : "") + '" id="' + prefix + '-tab-' + t.key + '">' + t.html + '</div>';
  }).join("");
  return tabBar + panels;
}

function _wireModalTabs(prefix) {
  document.querySelectorAll("#" + prefix + "-tabs .page-tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.getAttribute("data-tab");
      document.querySelectorAll("#" + prefix + "-tabs .page-tab").forEach(function (b) { b.classList.remove("active"); });
      document.querySelectorAll('[id^="' + prefix + '-tab-"]').forEach(function (p) { p.classList.remove("active"); });
      btn.classList.add("active");
      var panel = document.getElementById(prefix + "-tab-" + key);
      if (panel) panel.classList.add("active");
    });
  });
}

async function openCreateModal() {
  await _ensureTagCache();
  var body = _renderTabbedBody("asset-edit", [
    { key: "general",    label: "General",    html: assetFormHTML({}) },
    { key: "monitoring", label: "Monitoring", html: assetMonitoringFormHTML({}) },
  ]);
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">Create Asset</button>';
  openModal("Add Asset", body, footer);
  _wireModalTabs("asset-edit");
  wireTagPicker();
  _wireMonitorEditTab({});
  _populateUploadedMibsInDropdowns();
  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      await api.assets.create(getAssetFormData());
      closeModal();
      showToast("Asset created");
      loadAssets();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function openEditModal(id) {
  try {
    // Fetch in parallel: asset, tag cache, and the agent state. The
    // Monitoring tab branches on whether an agent is installed (active
    // or in-flight) — when one is, we hide the per-stream polling
    // dropdowns and show a status block instead, since the agent owns
    // all four streams. api.assets.agent resolves to null on 404.
    var results = await Promise.all([
      api.assets.get(id),
      _ensureTagCache(),
      api.assets.agent(id).catch(function () { return null; }),
    ]);
    var asset = results[0];
    var managedAgent = results[2];
    asset._editing = true;
    var body = _renderTabbedBody("asset-edit", [
      { key: "general",    label: "General",    html: assetFormHTML(asset) },
      { key: "monitoring", label: "Monitoring", html: assetMonitoringFormHTML(asset, managedAgent) },
    ]);
    var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="btn-save">Save Changes</button>';
    var title = "Edit Asset" + (asset.hostname ? " — " + asset.hostname : "");
    openModal(title, body, footer, { wide: true });
    _wireModalTabs("asset-edit");
    wireTagPicker();
    _wireMonitorEditTab(asset);
    _populateUploadedMibsInDropdowns();

    // Wire the "Install Polaris Agent…" button when present (no agent
    // installed + source supports agent). Reuses the same install modal
    // the asset details panel surfaces, so the operator flow is
    // consistent regardless of entry point. Closes this edit modal
    // before opening the install modal so the operator doesn't end up
    // with stacked modals; their unsaved changes would be lost, but
    // the install flow is the meaningful work here.
    var editInstallBtn = document.getElementById("btn-edit-modal-install-agent");
    if (editInstallBtn) {
      editInstallBtn.addEventListener("click", function () {
        closeModal();
        _openInstallAgentModal(asset);
      });
    }
    document.getElementById("btn-save").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      try {
        await api.assets.update(id, getAssetFormData());
        closeModal();
        showToast("Asset updated");
        loadAssets();
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── Asset details panel auto-refresh ──────────────────────────────────────
//
// Three independent self-rescheduling setTimeout chains keep the panel's
// charts current without polling when nothing is visible:
//   • Response-time chart (Monitoring tab)  — response-time cadence
//   • System tab (CPU/Mem, temps, ifaces, storage) — telemetry cadence
//   • Per-interface slide-over charts        — response-time cadence
// Each tick checks that the relevant overlay is still open before fetching
// and defers (re-checks in 30 s) when the browser tab is hidden so we don't
// hammer the API for a panel the user can't see. Custom date ranges on the
// Monitoring tab opt out of refresh entirely (the user picked a fixed window).

var _assetMonitorRefreshTimer = null;
var _assetSystemRefreshTimer  = null;
// Most-recent /system-info payload for the open asset details modal. Reused
// by chart-only re-renders (range-button click on the CPU & Memory chart) so
// they don't have to re-fetch system-info just to repaint the chart's stale
// banner and the latest-reading rows in the summary. Cleared whenever the
// modal closes or switches assets via _resetAssetSystemRefresh.
var _assetSystemSiCache       = null;
var _ifaceRefreshTimer        = null;
var _sensorRefreshTimer       = null;
var _ipsecRefreshTimer        = null;
var _monitorSettingsCache     = null;  // global monitor settings, fetched once per session
var _currentAssetForRefresh   = null;  // asset object cached so refresh schedulers can read its per-asset intervals
// Per-asset cache of /effective-monitor-settings's `resolved` block. Both
// _populateAssetMonitorTierBadges and _updateStreamSourceBadgesFromEffective
// write here on success so the stale-banner slot has access to the truly-
// resolved cadence (covers class / integration / manual tiers) without a
// third fetch. Keyed by assetId; never invalidated within a session — the
// modal lifecycle is short enough that staleness isn't a concern.
var _effectiveResolvedByAssetId = new Map();

function _refreshIntervalMs(perAssetSec, globalSec, defaultSec) {
  var s = (typeof perAssetSec === "number" && perAssetSec > 0) ? perAssetSec
        : (typeof globalSec   === "number" && globalSec   > 0) ? globalSec
        : defaultSec;
  return Math.max(15, Math.floor(s)) * 1000;
}

function _isOverlayOpen(id) {
  var el = document.getElementById(id);
  return !!(el && el.classList.contains("open"));
}

function _clearAssetRefreshTimers() {
  if (_assetMonitorRefreshTimer) { clearTimeout(_assetMonitorRefreshTimer); _assetMonitorRefreshTimer = null; }
  if (_assetSystemRefreshTimer)  { clearTimeout(_assetSystemRefreshTimer);  _assetSystemRefreshTimer  = null; }
  if (_ifaceRefreshTimer)        { clearTimeout(_ifaceRefreshTimer);        _ifaceRefreshTimer        = null; }
  if (_sensorRefreshTimer)       { clearTimeout(_sensorRefreshTimer);       _sensorRefreshTimer       = null; }
  if (_ipsecRefreshTimer)        { clearTimeout(_ipsecRefreshTimer);        _ipsecRefreshTimer        = null; }
  _assetSystemSiCache = null;
}

function _clearIfaceRefreshTimer() {
  if (_ifaceRefreshTimer) { clearTimeout(_ifaceRefreshTimer); _ifaceRefreshTimer = null; }
}

function _isCurrentAsset(assetId) {
  return !!(_currentAssetForRefresh && _currentAssetForRefresh.id === assetId);
}

function _scheduleAssetMonitorRefresh(assetId, ms) {
  if (_assetMonitorRefreshTimer) clearTimeout(_assetMonitorRefreshTimer);
  _assetMonitorRefreshTimer = setTimeout(function tick() {
    if (!_isOverlayOpen("asset-panel-overlay") || !_isCurrentAsset(assetId)) { _assetMonitorRefreshTimer = null; return; }
    if (document.hidden) { _assetMonitorRefreshTimer = setTimeout(tick, 30000); return; }
    _loadMonitorHistoryFor(assetId, _currentMonitorSelection(), { silent: true });
  }, ms);
}

function _scheduleAssetSystemRefresh(assetId, asset, ms) {
  if (_assetSystemRefreshTimer) clearTimeout(_assetSystemRefreshTimer);
  _assetSystemRefreshTimer = setTimeout(function tick() {
    if (!_isOverlayOpen("asset-panel-overlay") || !_isCurrentAsset(assetId)) { _assetSystemRefreshTimer = null; return; }
    if (document.hidden) { _assetSystemRefreshTimer = setTimeout(tick, 30000); return; }
    _loadSystemTabFor(assetId, _currentSystemTabRange(), asset, { silent: true });
  }, ms);
}

function _scheduleIfaceRefresh(assetId, ifName, ms) {
  if (_ifaceRefreshTimer) clearTimeout(_ifaceRefreshTimer);
  _ifaceRefreshTimer = setTimeout(function tick() {
    // The iface slide-over is anchored to the current asset; if either is gone we drop the chain.
    if (!_isOverlayOpen("iface-panel-overlay") || !_isCurrentAsset(assetId)) { _ifaceRefreshTimer = null; return; }
    if (document.hidden) { _ifaceRefreshTimer = setTimeout(tick, 30000); return; }
    _loadInterfaceHistoryFor(assetId, ifName, _currentIfaceRange(), { silent: true });
  }, ms);
}

function _scheduleSensorRefresh(assetId, sensorName, ms) {
  if (_sensorRefreshTimer) clearTimeout(_sensorRefreshTimer);
  _sensorRefreshTimer = setTimeout(function tick() {
    if (!_isOverlayOpen("sensor-panel-overlay") || !_isCurrentAsset(assetId)) { _sensorRefreshTimer = null; return; }
    if (document.hidden) { _sensorRefreshTimer = setTimeout(tick, 30000); return; }
    _loadSensorHistoryFor(assetId, sensorName, _currentSensorRange(), { silent: true });
  }, ms);
}

function _scheduleIpsecRefresh(assetId, tunnelName, ms) {
  if (_ipsecRefreshTimer) clearTimeout(_ipsecRefreshTimer);
  _ipsecRefreshTimer = setTimeout(function tick() {
    if (!_isOverlayOpen("ipsec-panel-overlay") || !_isCurrentAsset(assetId)) { _ipsecRefreshTimer = null; return; }
    if (document.hidden) { _ipsecRefreshTimer = setTimeout(tick, 30000); return; }
    _loadIpsecHistoryFor(assetId, tunnelName, _currentIpsecRange(), { silent: true });
  }, ms);
}

// Auto-refresh ticks must not yank the user back to the top of the panel.
// Showing "Loading…" placeholders collapses the slideover body's scrollHeight,
// which clamps scrollTop. Silent callers skip the placeholders and capture +
// restore scrollTop around the swap (see the silent branches in
// _loadSystemTabFor / _loadMonitorHistoryFor / _loadInterfaceHistoryFor).

function _currentIfaceRange() {
  var btn = document.querySelector(".iface-range-btn.btn-primary");
  return (btn && btn.getAttribute("data-range")) || "1h";
}

function _currentSensorRange() {
  var btn = document.querySelector(".sensor-range-btn.btn-primary");
  return (btn && btn.getAttribute("data-range")) || "1h";
}

function _currentIpsecRange() {
  var btn = document.querySelector(".ipsec-range-btn.btn-primary");
  return (btn && btn.getAttribute("data-range")) || "1h";
}

function _ensureAssetPanelDOM() {
  if (document.getElementById("asset-panel-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "asset-panel-overlay";
  overlay.className = "slideover-overlay";
  overlay.innerHTML =
    '<div class="slideover" id="asset-panel" role="dialog" aria-labelledby="asset-panel-title" tabindex="-1">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="asset-panel-title">Asset Details</h3>' +
          '<button class="btn-icon" id="asset-panel-close" title="Close" aria-label="Close asset details">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta" id="asset-panel-meta"></div>' +
      '</div>' +
      '<div class="slideover-body" id="asset-panel-body"><p class="empty-state">Loading...</p></div>' +
      '<div class="slideover-footer" id="asset-panel-footer"></div>' +
    '</div>';
  document.body.appendChild(overlay);

  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeAssetPanel();
  });
  document.getElementById("asset-panel-close").addEventListener("click", closeAssetPanel);

  // Escape closes the panel — but only when it's the topmost layer. Nested
  // drilldowns (interface / storage / sensor / IPsec slide-overs) install their
  // own capture-phase Escape handlers that close themselves first; this guard
  // keeps Escape from closing the whole asset panel out from under an open
  // nested panel. Not a hard focus trap: the asset panel is a resizable side
  // panel meant to coexist with the page, so role="dialog" without aria-modal.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!overlay.classList.contains("open")) return;
    if (document.querySelector(".slideover-overlay.slideover-nested.open")) return;
    if (document.getElementById("modal-overlay") && document.getElementById("modal-overlay").classList.contains("open")) return;
    closeAssetPanel();
  });

  initSlideoverResize(document.getElementById("asset-panel"), "polaris.panel.width.asset");
}

var _assetPanelReturnFocus = null;  // element refocused when the asset panel closes

function closeAssetPanel() {
  var overlay = document.getElementById("asset-panel-overlay");
  if (overlay) overlay.classList.remove("open");
  _clearAssetRefreshTimers();
  _currentAssetForRefresh = null;
  if (_assetPanelReturnFocus && typeof _assetPanelReturnFocus.focus === "function") {
    try { _assetPanelReturnFocus.focus(); } catch (_) { /* element gone */ }
  }
  _assetPanelReturnFocus = null;
}

// Open the asset details modal by serial number — used by HA peer links on
// the General tab to pivot between cluster members. Falls back to a no-op
// (with a console hint) when no match is found so the link doesn't appear
// broken if discovery hasn't recorded the standby yet.
window.openAssetBySerial = async function (serial) {
  if (!serial) return;
  try {
    var rows = await api.assets.list({ search: serial, limit: 25 });
    var list = Array.isArray(rows) ? rows : (rows && rows.assets) || [];
    var match = list.find(function (a) { return a.serialNumber === serial; });
    if (match) {
      await openViewModal(match.id);
    } else {
      console.warn("No asset with serial", serial);
    }
  } catch (err) {
    console.warn("openAssetBySerial failed", err);
  }
};

async function openViewModal(id) {
  _ensureAssetPanelDOM();
  // Remember the trigger (table row action, search hit, etc.) so closing the
  // panel returns focus there.
  _assetPanelReturnFocus = document.activeElement;
  var titleEl  = document.getElementById("asset-panel-title");
  var metaEl   = document.getElementById("asset-panel-meta");
  var bodyEl   = document.getElementById("asset-panel-body");
  var footerEl = document.getElementById("asset-panel-footer");
  titleEl.textContent = "Asset Details";
  metaEl.innerHTML = "";
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading...</p>';
  footerEl.innerHTML = "";
  requestAnimationFrame(function () {
    var ov = document.getElementById("asset-panel-overlay");
    ov.classList.add("open");
    var panel = document.getElementById("asset-panel");
    if (panel) panel.focus();
  });

  try {
    // Fetch the asset in parallel with a one-shot manual-tier read used as a
    // generic auto-refresh cadence fallback. Step 9 will replace this with the
    // per-asset effective-monitor-settings call so each asset's auto-refresh
    // matches its resolved tier; for now the manual tier is a "good enough"
    // default that keeps the schedulers from hard-coding 60s.
    var fetches = [api.assets.get(id)];
    if (!_monitorSettingsCache) {
      fetches.push(api.monitorSettings.getManual().catch(function () { return null; }));
    }
    var fetched = await Promise.all(fetches);
    var a = fetched[0];
    if (fetched[1]) _monitorSettingsCache = fetched[1];
    _currentAssetForRefresh = a;
    // Dependency tree block (General tab) — populated asynchronously after
    // openViewModal awaits api.assets.getDependencies(id) below. Rendered
    // beneath the details table so the at-a-glance facts (hostname / IP /
    // status) come first.
    var dependencyTreeMountHTML = '<div data-shot-section="depTree" data-shot-label="Dependency Tree"><div id="asset-dep-tree-mount-' + escapeHtml(a.id) + '"></div></div>';

    var generalHTML = '<div data-shot-section="details" data-shot-label="Details"><div class="asset-view-grid">' +
      (a.ipAddress && !a.hostname
        ? '<div class="detail-row"><span class="detail-label">Hostname</span><span class="detail-value">- <button class="btn btn-sm btn-secondary" onclick="singleDnsLookup(\'' + a.id + '\')" title="Reverse DNS lookup (PTR record)">PTR Lookup</button></span></div>'
        : viewRow("Hostname", a.hostname, false, false, true)) +
      viewRow("DNS Name", a.dnsName, false, false, true) +
      ipViewRow(a) +
      viewRow("MAC Address", a.macAddress, true, false, true) +
      macAddressesViewHTML(a.macAddresses) +
      viewRow("Asset Tag", a.assetTag) +
      viewRow("Serial Number", a.serialNumber, false, false, true) +
      (a.macAddress && !a.manufacturer
        ? '<div class="detail-row"><span class="detail-label">Manufacturer</span><span class="detail-value">- <button class="btn btn-sm btn-secondary" onclick="singleOuiLookup(\'' + a.id + '\')" title="OUI manufacturer lookup from MAC address">OUI Lookup</button></span></div>'
        : viewRow("Manufacturer", a.manufacturer)) +
      viewRow("Model", a.model) +
      viewRow("Type", ASSET_TYPE_LABELS[a.assetType] || a.assetType) +
      viewRow("Status", a.status ? a.status.charAt(0).toUpperCase() + a.status.slice(1) : "-") +
      disabledInHTML(a.tags) +
      viewRow("Location", a.location || a.learnedLocation) +
      ((a.latitude != null && a.longitude != null)
        ? viewRow("Coordinates", a.latitude.toFixed(4) + ", " + a.longitude.toFixed(4), true)
        : "") +
      (a.learnedAddress ? viewRow("Address", a.learnedAddress) : "") +
      (a.snmpLocation ? viewRow("SNMP Location", a.snmpLocation) : "") +
      viewRow("Department", a.department) +
      viewRow("Assigned To", a.assignedTo) +
      viewRow("OS / Firmware", a.osVersion || a.os) +
      haTopologyHTML(a) +
      viewRow("Last Seen Switch", a.lastSeenSwitch) +
      viewRow("Last Seen AP", a.lastSeenAp) +
      '<div class="detail-row"><span class="detail-label">Last Seen Firewall</span><span class="detail-value" id="asset-last-fw-' + escapeHtml(a.id) + '">-</span></div>' +
      associatedUsersViewHTML(a.associatedUsers) +
      lastSeenRowHTML(a) +
      '<div id="asset-dir-activity-mount-' + escapeHtml(a.id) + '" style="display:contents"></div>' +
      viewRow("Acquired", (a.acquiredAt || a.createdAt) ? formatDate(a.acquiredAt || a.createdAt) : null) +
      viewRow("Warranty Expires", a.warrantyExpiry ? formatDate(a.warrantyExpiry) : null) +
      viewRow("Purchase Order", a.purchaseOrder) +
      viewRow("Tags", (a.tags || []).join(", ") || null, false, true) +
      viewRow("Notes", a.notes, false, true) +
      viewRow("Created", formatDate(a.createdAt)) +
      viewRow("Updated", formatDate(a.updatedAt)) +
    '</div></div>' + dependencyTreeMountHTML;

    var monitoringHTML = assetMonitoringViewHTML(a);
    var agentSubpanelHTML = ""; // filled in after the parallel load below
    var agentMountHTML = '<div data-shot-section="agent" data-shot-label="Polaris Agent"><div id="asset-agent-panel-mount"></div></div>';
    var systemHTML     = a.monitored
      ? monitoringHTML +
        '<hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--color-border)">' +
        agentMountHTML +
        assetSystemViewHTML(a)
      : monitoringHTML +
        agentMountHTML; // unmonitored assets still see the panel when an agent is mid-install
    var tabs = [
      { key: "general", label: "General", html: generalHTML },
      { key: "system",  label: "System",  html: systemHTML },
    ];
    // Sources tab + dependency tree block fetched in parallel — both feed
    // the General-tab area and the Sources tab on first paint. Polaris
    // Agent install state is fetched alongside on the same parallel pass;
    // failures everywhere fall through to empty-state so the rest of the
    // modal still works.
    var auxResults = await Promise.all([
      api.assets.getSources(a.id).catch(function (err) { console.warn("Failed to load asset sources", err); return []; }),
      api.assets.getDependencies(a.id).catch(function (err) { console.warn("Failed to load asset dependencies", err); return null; }),
      api.assets.agent(a.id).catch(function (err) { console.warn("Failed to load managed agent", err); return null; }),
      api.assets.getSightings(a.id).catch(function (err) { console.warn("Failed to load asset sightings", err); return []; }),
      api.assets.getIpHistory(a.id).catch(function (err) { console.warn("Failed to load asset IP history", err); return []; }),
      a.manufacturer
        ? api.assets.customWidgets(a.id).catch(function (err) { console.warn("Failed to load custom widgets", err); return null; })
        : Promise.resolve(null),
    ]);
    var sources         = auxResults[0] || [];
    var dependencies    = auxResults[1];
    var managedAgent    = auxResults[2];
    var sightings       = Array.isArray(auxResults[3]) ? auxResults[3] : (auxResults[3] && auxResults[3].sightings) || [];
    var ipHistory       = auxResults[4] || [];
    var customWidgetPayload = auxResults[5];
    agentSubpanelHTML   = assetAgentSubpanelHTML(a, managedAgent);
    // Stations tab — visible on FortiAPs that have wireless clients
    // reported by the most recent SNMP fapStationTable scrape. The
    // content is loaded async from /system-info so initial render is a
    // placeholder; _loadSystemTabFor() reuses the same endpoint, so
    // when the operator clicks Stations the data is already in cache
    // from the System tab's first fetch.
    if (a.assetType === "access_point" && a.monitored) {
      tabs.push({ key: "stations", label: "Stations", html: _assetStationsTabHTML(a) });
    }
    // SD-WAN tab — FortiGate firewalls discovered via FortiManager/FortiGate
    // with the pullSdwan toggle on. Shown only when the device actually
    // reported SD-WAN data (rules or health-check links exist). Fetched here so
    // the tab is present (and pre-populated) on first paint.
    var sdwanRules = [];
    var sdwanLinks = [];
    var sdwanMembers = [];
    if (a.monitored && a.assetType === "firewall" &&
        (function () { var sk = (a.discoveredByIntegration && a.discoveredByIntegration.type) || "manual"; return sk === "fortimanager" || sk === "fortigate"; }())) {
      var sdwanAux = await Promise.all([
        api.assets.sdwanRules(a.id).catch(function (err) { console.warn("Failed to load SD-WAN rules", err); return { rules: [] }; }),
        api.assets.perfSlaLinks(a.id).catch(function (err) { console.warn("Failed to load SD-WAN perf-SLA links", err); return { links: [] }; }),
        api.assets.sdwanMembers(a.id).catch(function (err) { console.warn("Failed to load SD-WAN members", err); return { members: [] }; }),
      ]);
      sdwanRules = (sdwanAux[0] && sdwanAux[0].rules) || [];
      sdwanLinks = (sdwanAux[1] && sdwanAux[1].links) || [];
      sdwanMembers = (sdwanAux[2] && sdwanAux[2].members) || [];
    }
    if (sdwanRules.length || sdwanLinks.length || sdwanMembers.length) {
      tabs.push({ key: "sdwan", label: "SD-WAN", html: _assetSdwanTabHTML(a, sdwanRules, sdwanLinks, sdwanMembers) });
    }
    tabs.push({ key: "sources", label: "Sources", html: _assetSourcesTabHTML(sources, a.id, sightings, ipHistory) });
    // Processes tab — current-state process inventory + the Monitor/Alert pin
    // checkboxes. Lazy-loaded on first click (see _wireAssetProcessesTab). Not
    // shown on Fortinet infrastructure (firewall/switch/access_point) — those
    // appliances don't report a host process table.
    var isInfraProc = a.assetType === "firewall" || a.assetType === "switch" || a.assetType === "access_point";
    if (!isInfraProc) {
      tabs.push({ key: "processes", label: "Processes", html: _assetProcessesTabHTML(a.id) });
    }
    // Events tab — audit history scoped to this asset (resourceType=asset,
    // resourceId=a.id). Lazy-loaded on first tab click (see _wireAssetEventsTab)
    // so the modal doesn't fire an extra /events query on every open. Gated on
    // events-read to mirror the GET /events backend permission.
    if (permAtLeast("events", "read")) {
      tabs.push({ key: "events", label: "Events", html: _assetEventsTabHTML(a.id) });
    }
    // Custom MIB tab — shown only when the asset's manufacturer actually has
    // at least one ManufacturerCustomWidget defined under its
    // ManufacturerProfile. The widget payload is fetched up front in the
    // parallel auxResults pass (above), so the tab is present + pre-populated
    // on first paint and never flashes-then-vanishes for manufacturers with
    // no custom widgets. Mirrors the SD-WAN tab's prefetch-then-conditional
    // pattern.
    if (customWidgetPayload && customWidgetPayload.widgets && customWidgetPayload.widgets.length) {
      tabs.push({ key: "customMib", label: "Custom MIB", html: _customMibTabHTML(customWidgetPayload) });
    }
    // SNMP Walk tab — admin-only, mirrors the backend gate. Loads credentials
    // before render so the picker isn't empty on first paint.
    if (isAdmin()) {
      await _ensureCredentials();
      tabs.push({ key: "snmp", label: "SNMP Walk", html: assetSnmpWalkViewHTML(a) });
    }
    // Quarantine tab — assets-admin only, shown for any asset that has MACs or is quarantined.
    // Infrastructure assets (firewall/switch/access_point) only get the tab if they're
    // already quarantined (so Release stays reachable); they can't be newly quarantined.
    var isInfraQ = a.assetType === "firewall" || a.assetType === "switch" || a.assetType === "access_point";
    var hasMac = !!(a.macAddress || (a.macAddresses && a.macAddresses.length));
    if (canManageAssets() && (a.status === "quarantined" || (hasMac && !isInfraQ))) {
      tabs.push({ key: "quarantine", label: a.status === "quarantined" ? "Quarantine ⚠" : "Quarantine", html: _assetQuarantineTabHTML(a) });
    }
    var tabsHTML = _renderTabbedBody("asset-view", tabs);
    bodyEl.innerHTML = '<div class="asset-panel-content">' + tabsHTML + '</div>';

    titleEl.innerHTML = 'Asset Details' + (a.hostname
      ? ' <span style="color:var(--color-text-secondary);font-weight:400;margin-left:6px">— ' + escapeHtml(a.hostname) + '</span>'
      : '');

    // IP history + firewall sightings now live in the Sources tab (no longer a
    // standalone modal). See _assetSourcesTabHTML.
    // On the Events tab the Screenshot button gives way to an Export dropdown
    // (same page/all × CSV/PDF shape as the Events page export, scoped to
    // this asset). Both are rendered up front; _syncAssetFooterButtons flips
    // visibility on tab clicks. The menu opens upward (drop-up) since the
    // footer sits at the bottom of the viewport, and anchors left so it
    // stays inside the slide-over.
    var copyBtns =
      '<button type="button" class="btn btn-sm btn-secondary" id="btn-asset-copy">Copy</button>' +
      '<button type="button" class="btn btn-sm btn-secondary" id="btn-asset-screenshot">Screenshot</button>' +
      '<span class="btn-dropdown-wrap" id="asset-export-wrap" style="display:none">' +
        '<button type="button" class="btn btn-sm btn-secondary" id="btn-asset-export">Export &#9662;</button>' +
        '<div class="btn-dropdown-menu drop-up anchor-left" id="asset-export-menu">' +
          '<div class="dropdown-heading">PDF</div>' +
          '<button data-export="page" data-fmt="pdf">Current page</button>' +
          '<button data-export="all" data-fmt="pdf">All events for this asset</button>' +
          '<div class="dropdown-divider"></div>' +
          '<div class="dropdown-heading">CSV</div>' +
          '<button data-export="page" data-fmt="csv">Current page</button>' +
          '<button data-export="all" data-fmt="csv">All events for this asset</button>' +
        '</div>' +
      '</span>';
    var leftBtns = copyBtns;
    var rightBtns = '<button class="btn btn-sm btn-secondary" id="btn-asset-panel-close-btn">Close</button>' +
      (canManageAssets() ? '<button class="btn btn-sm btn-primary" id="btn-asset-panel-edit-btn">Edit</button>' : '');
    footerEl.innerHTML = leftBtns + '<span style="flex:1"></span>' + rightBtns;

    _wireModalTabs("asset-view");
    // Footer button swap (Screenshot ↔ Export) rides on every tab click;
    // _wireModalTabs has no change hook, so a delegated listener on the tab
    // bar does it. The immediate call covers the initial (General) state.
    var assetTabBar = document.getElementById("asset-view-tabs");
    if (assetTabBar) {
      assetTabBar.addEventListener("click", function (e) {
        if (e.target.closest(".page-tab")) _syncAssetFooterButtons();
      });
    }
    _syncAssetFooterButtons();
    if (isAdmin()) _wireSnmpWalkTab(a);
    if (canManageAssets()) _wireQuarantineTab(a);
    if (sdwanRules.length || sdwanLinks.length || sdwanMembers.length) _wireSdwanTab(a, sdwanRules, sdwanLinks, sdwanMembers);
    if (!isInfraProc) _wireAssetProcessesTab(a);
    if (permAtLeast("events", "read")) _wireAssetEventsTab(a.id);
    // Mount the dependency tree into its placeholder div on the General tab.
    var depMount = document.getElementById("asset-dep-tree-mount-" + a.id);
    if (depMount) {
      depMount.innerHTML = renderDependencyTreeBlock(dependencies, a.id);
      _wireDependencyTreeLinks(depMount);
    }
    // Last Directory Activity row (General tab) — freshest entra/intune/ad
    // AssetSource lastSeen. Deliberately separate from Last Seen: directory
    // activity (an Intune sync, an AD logon) proves the device is alive, not
    // that it's on the network. Hidden when the asset has no directory source.
    var dirMount = document.getElementById("asset-dir-activity-mount-" + a.id);
    if (dirMount) {
      var dirActivityMs = 0;
      (sources || []).forEach(function (s) {
        if ((s.sourceKind === "entra" || s.sourceKind === "intune" || s.sourceKind === "ad") && s.lastSeen) {
          var t = new Date(s.lastSeen).getTime();
          if (t > dirActivityMs) dirActivityMs = t;
        }
      });
      if (dirActivityMs > 0) {
        dirMount.innerHTML = viewRow("Last Directory Activity", formatDate(new Date(dirActivityMs).toISOString()));
      }
    }
    // Last Seen Firewall row (General tab) — the FortiGate device from the
    // most-recent AssetFortigateSighting. Mirrors lastSeenSwitch/lastSeenAp
    // (which name the upstream switch/AP from discovery); this names the
    // upstream firewall. The exact timestamp + every firewall that has seen
    // the asset live in the Sources tab's sightings table. Left as "-" when no
    // firewall has ever sighted the asset.
    var fwCell = document.getElementById("asset-last-fw-" + a.id);
    if (fwCell) {
      var bestFw = null, bestMs = -1;
      (sightings || []).forEach(function (s) {
        if (!s.fortigateDevice) return;
        var t = s.lastSeen ? new Date(s.lastSeen).getTime() : 0;
        if (t >= bestMs) { bestMs = t; bestFw = s.fortigateDevice; }
      });
      if (bestFw) fwCell.textContent = bestFw;
    }
    // Mount the Polaris Agent panel into the System tab placeholder + wire
    // its buttons. The wiring helper also starts the install-progress
    // polling loop when the agent is in a transient state.
    var agentMount = document.getElementById("asset-agent-panel-mount");
    if (agentMount) {
      agentMount.innerHTML = agentSubpanelHTML;
      _wireAgentSubpanel(a, managedAgent);
    }
    _wireHoverTriggersIn(bodyEl);
    bodyEl.addEventListener("click", _handleCopyClick);
    document.getElementById("btn-asset-copy").addEventListener("click", _copyAssetDetails);
    document.getElementById("btn-asset-screenshot").addEventListener("click", function () {
      _openScreenshotOptions(a);
    });
    // Export dropdown (Events tab) — same open/close mechanics as the Events
    // page export menu. The document-level closer is registered once per
    // page load (module guard), not once per modal open.
    var exportBtn = document.getElementById("btn-asset-export");
    var exportMenu = document.getElementById("asset-export-menu");
    if (exportBtn && exportMenu) {
      exportBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        exportMenu.classList.toggle("open");
      });
      exportMenu.addEventListener("click", function (e) { e.stopPropagation(); });
      exportMenu.querySelectorAll("button[data-export]").forEach(function (b) {
        b.addEventListener("click", function () {
          exportMenu.classList.remove("open");
          _handleAssetEventExport(b.getAttribute("data-export"), b.getAttribute("data-fmt"), a);
        });
      });
      if (!_assetExportCloserWired) {
        _assetExportCloserWired = true;
        document.addEventListener("click", function () {
          var m = document.getElementById("asset-export-menu");
          if (m) m.classList.remove("open");
        });
      }
    }
    document.getElementById("btn-asset-panel-close-btn").addEventListener("click", closeAssetPanel);
    var editBtn = document.getElementById("btn-asset-panel-edit-btn");
    if (editBtn) {
      editBtn.addEventListener("click", function () {
        closeAssetPanel();
        openEditModal(a.id);
      });
    }
    if (a.monitored) _loadMonitorHistoryFor(a.id, _getChartRangePref("assetMonitor", "24h"));
    if (a.monitored) _loadSystemTabFor(a.id, _getChartRangePref("assetSystem", "1h"), a);
    if (a.monitored) _renderIntermittencyBar(a.id);
    if (a.monitored) _updateStreamSourceBadgesFromEffective(a.id, a);
    document.querySelectorAll(".asset-system-range-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var range = b.getAttribute("data-range");
        var panel = document.getElementById("asset-system-custom-panel");
        if (range === "custom") {
          if (!panel) return;
          var willOpen = panel.style.display === "none";
          panel.style.display = willOpen ? "flex" : "none";
          if (willOpen) {
            var toInput = document.getElementById("asset-system-to");
            var fromInput = document.getElementById("asset-system-from");
            if (toInput && !toInput.value) toInput.value = _toLocalDatetimeInput(new Date());
            if (fromInput && !fromInput.value) fromInput.value = _toLocalDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000));
          }
          return;
        }
        if (panel) panel.style.display = "none";
        document.querySelectorAll(".asset-system-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
        b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
        _setChartRangePref("assetSystem", range);
        _loadSystemTabFor(a.id, range, a, { chartOnly: true });
      });
    });
    var sysApplyBtn = document.getElementById("btn-asset-system-custom-apply");
    if (sysApplyBtn) {
      sysApplyBtn.addEventListener("click", function () {
        var fromInput = document.getElementById("asset-system-from");
        var toInput   = document.getElementById("asset-system-to");
        if (!fromInput.value || !toInput.value) { showToast("Enter both From and To", "error"); return; }
        var fromIso = new Date(fromInput.value).toISOString();
        var toIso   = new Date(toInput.value).toISOString();
        if (new Date(fromIso) >= new Date(toIso)) { showToast("From must be before To", "error"); return; }
        document.querySelectorAll(".asset-system-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
        var customBtn = document.getElementById("btn-asset-system-custom");
        if (customBtn) { customBtn.classList.remove("btn-secondary"); customBtn.classList.add("btn-primary"); }
        _loadSystemTabFor(a.id, { from: fromIso, to: toIso }, a, { chartOnly: true });
      });
    }
    var probeBtn = document.getElementById("btn-asset-probe-now");
    if (probeBtn) {
      probeBtn.addEventListener("click", async function () {
        probeBtn.disabled = true;
        probeBtn.textContent = "Polling…";
        try {
          var r = await api.assets.probeNow(a.id);
          // Build a per-stream summary so the toast names exactly which streams
          // polled and which failed (and why). The probe-now endpoint returns:
          //   { success, responseTimeMs, error?,
          //     telemetry: {supported,collected,error?},
          //     temperature: {supported,collected,error?},
          //     systemInfo: {…} }
          var parts = [];
          var failures = [];
          if (r.success) parts.push("probe " + r.responseTimeMs + " ms");
          else failures.push("probe: " + (r.error || "unknown"));

          var tel = r.telemetry || {};
          if (tel.collected) parts.push("telemetry");
          else if (tel.supported && tel.error) failures.push("telemetry: " + tel.error);

          // Hardware sensors dispatch on their own polling method. supported-
          // but-empty (sensor-less device) is not a failure — collected===false
          // with no error means "device exposes no sensors", so skip it.
          var tmp = r.hardware || {};
          if (tmp.collected) parts.push("hardware");
          else if (tmp.supported && tmp.error) failures.push("hardware: " + tmp.error);

          var si = r.systemInfo || {};
          if (si.collected) parts.push("interfaces");
          else if (si.supported && si.error) failures.push("interfaces: " + si.error);

          var anyFail = failures.length > 0;
          var label = anyFail ? "Poll partial" : "Polled";
          var msg = label + (parts.length ? " (" + parts.join(" · ") + ")" : "");
          if (anyFail) msg += " — " + failures.join("; ");
          // No "warning" toast class exists — fall back to "error" on any
          // failure so the user sees the red treatment they expect.
          var kind = anyFail ? "error" : "success";
          showToast(msg, kind);

          await Promise.all([
            _loadMonitorHistoryFor(a.id, _currentMonitorSelection(), { silent: true }),
            _loadSystemTabFor(a.id, _currentSystemTabRange(), a, { silent: true }),
          ]);

          // Re-render the Status pill from the freshly-probed asset. probeNow
          // ran the state machine in recordProbeResult, so monitorStatus may
          // have flipped (e.g. down → recovering/up). Without this, the pill
          // keeps showing the stale state the modal opened with even though
          // everything else on the panel refreshed. Mutate `a` in place so the
          // cached object every handler closes over (and _currentAssetForRefresh,
          // which points at it) stays consistent.
          try {
            var fresh = await api.assets.get(a.id);
            if (fresh && _isCurrentAsset(a.id)) {
              Object.assign(a, fresh);
              var pillWrap = document.getElementById("asset-status-pill-wrap");
              if (pillWrap) pillWrap.innerHTML = assetMonitorBadge(a) + _assetOverrideBadge(a);
            }
          } catch (e) { /* pill stays as-is; chart/system already refreshed */ }
        } catch (err) {
          showToast(err.message || "Poll failed", "error");
        } finally {
          probeBtn.disabled = false;
          probeBtn.textContent = "Poll Now";
        }
      });
    }
    document.querySelectorAll(".asset-monitor-range-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var range = b.getAttribute("data-range");
        var panel = document.getElementById("asset-monitor-custom-panel");
        if (range === "custom") {
          if (!panel) return;
          var willOpen = panel.style.display === "none";
          panel.style.display = willOpen ? "flex" : "none";
          if (willOpen) {
            var toInput = document.getElementById("asset-monitor-to");
            var fromInput = document.getElementById("asset-monitor-from");
            if (toInput && !toInput.value) toInput.value = _toLocalDatetimeInput(new Date());
            if (fromInput && !fromInput.value) fromInput.value = _toLocalDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000));
          }
          return;
        }
        if (panel) panel.style.display = "none";
        document.querySelectorAll(".asset-monitor-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
        b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
        _setChartRangePref("assetMonitor", range);
        _loadMonitorHistoryFor(a.id, range);
      });
    });
    var applyBtn = document.getElementById("btn-asset-monitor-custom-apply");
    if (applyBtn) {
      applyBtn.addEventListener("click", function () {
        var fromInput = document.getElementById("asset-monitor-from");
        var toInput   = document.getElementById("asset-monitor-to");
        if (!fromInput.value || !toInput.value) { showToast("Enter both From and To", "error"); return; }
        var fromIso = new Date(fromInput.value).toISOString();
        var toIso   = new Date(toInput.value).toISOString();
        if (new Date(fromIso) >= new Date(toIso)) { showToast("From must be before To", "error"); return; }
        document.querySelectorAll(".asset-monitor-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
        var customBtn = document.getElementById("btn-asset-monitor-custom");
        if (customBtn) { customBtn.classList.remove("btn-secondary"); customBtn.classList.add("btn-primary"); }
        _loadMonitorHistoryFor(a.id, { from: fromIso, to: toIso });
      });
    }
  } catch (err) {
    showToast(err.message, "error");
    closeAssetPanel();
  }
}

// ─── Polaris Agent sub-panel (System tab) ─────────────────────────────────
//
// Renders only when the operator has expressed agent-intent: either an
// agent is already installed, OR at least one per-asset *Polling column
// is "agent". Otherwise hidden — we don't want an "Install Agent" CTA
// on every Linux/Windows asset for operators who haven't opted in.
//
// The panel's three states map to ManagedAgent.installStatus values:
//   - No row at all                      → "Install Agent" button + cred picker.
//   - pending / uploading / enrolling    → spinner + status text + Force-Remove (admin).
//   - active                             → version + last-seen + WS state + Uninstall.
//   - failed / uninstall_failed          → red banner + error text + Retry / Force-Remove.
//   - revoked                            → "bearer revoked" notice + Force-Remove (admin).
//
// We poll GET /:id/agent every 3s while the row's state is one of the
// transient install/uninstall ones, then stop. The poll is tied to a
// data-asset-id sentinel on the panel so it auto-cancels when the modal
// is closed.

function _agentStatusLabel(s) {
  switch (s) {
    case "pending":          return "Pending — install queued";
    case "uploading":        return "Uploading binary";
    case "enrolling":        return "Awaiting enrollment";
    case "active":           return "Active";
    case "failed":           return "Install failed";
    case "upgrading":        return "Upgrading";
    case "upgrade_failed":   return "Upgrade failed";
    case "uninstalling":     return "Uninstalling";
    case "uninstall_failed": return "Uninstall failed";
    case "revoked":          return "Revoked (bearer killed)";
    default:                 return s || "—";
  }
}

function _agentStatusColor(s) {
  if (s === "active") return "var(--color-success)";
  if (s === "failed" || s === "uninstall_failed") return "var(--color-danger)";
  if (s === "revoked") return "var(--color-warning)";
  return "var(--color-text-secondary)";
}

// Decide whether the panel should render at all for this asset.
function _assetHasAgentIntent(a, agent) {
  if (agent) return true;
  if (!a) return false;
  return a.responseTimePolling === "agent" ||
         a.cpuMemoryPolling    === "agent" ||
         a.interfacesPolling   === "agent" ||
         a.lldpPolling         === "agent" ||
         a.storagePolling      === "agent";
}

function assetAgentSubpanelHTML(a, agent) {
  if (!_assetHasAgentIntent(a, agent)) return "";

  var headerBadge = agent
    ? '<span style="font-size:0.75rem;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,0.06);color:' +
        _agentStatusColor(agent.installStatus) + '">' +
        escapeHtml(_agentStatusLabel(agent.installStatus)) + '</span>'
    : '';

  var inFlight = agent && (
    agent.installStatus === "pending"      ||
    agent.installStatus === "uploading"    ||
    agent.installStatus === "enrolling"    ||
    agent.installStatus === "uninstalling"
  );

  var body;
  if (!agent) {
    // No row yet — operator opted in via a polling-method dropdown but
    // hasn't kicked off the install. Single big CTA.
    body =
      '<p style="color:var(--color-text-secondary);margin:0 0 0.75rem">' +
        'You picked "Polaris Agent" as a polling method but no agent is installed yet. ' +
        'Click below to push the agent to this host via a stored SSH or WinRM credential.' +
      '</p>' +
      '<button type="button" class="btn btn-primary" id="btn-agent-install" data-asset-id="' + escapeHtml(a.id) + '">Install Agent…</button>';
  } else {
    // Row exists — show the diagnostic strip + action buttons relevant to
    // the current state. We render the strip uniformly regardless of state
    // so a transitioning row doesn't make UI elements jump.
    var versionRow = agent.agentVersion
      ? '<div>Version: <strong>' + escapeHtml(agent.agentVersion) + '</strong></div>'
      : '<div style="color:var(--color-text-tertiary)">Version: not yet reported</div>';
    var platformRow = '<div>Platform: <strong>' + escapeHtml(agent.osPlatform) + '/' + escapeHtml(agent.arch) + '</strong></div>';
    var lastSeenRow = agent.lastSeenAt
      ? '<div>Last seen: <strong>' + escapeHtml(timeAgo(agent.lastSeenAt)) + '</strong>' +
        ' <span style="color:var(--color-text-tertiary)">(' + escapeHtml(new Date(agent.lastSeenAt).toLocaleString()) + ')</span></div>'
      : '<div style="color:var(--color-text-tertiary)">Last seen: never</div>';
    // WS state heuristic: connected if wsConnectedAt > wsDisconnectedAt (or
    // disconnect is null). Not perfectly authoritative but cheap and right
    // 99% of the time; the server's `agentChannelService.isAttached` is
    // the source of truth but isn't exposed on this endpoint.
    var wsConnected = agent.wsConnectedAt &&
      (!agent.wsDisconnectedAt || new Date(agent.wsConnectedAt) > new Date(agent.wsDisconnectedAt));
    var wsRow = '<div>WebSocket: <strong style="color:' + (wsConnected ? 'var(--color-success)' : 'var(--color-text-secondary)') + '">' +
      (wsConnected ? 'Connected' : 'Disconnected') + '</strong></div>';

    var errBlock = agent.installError
      ? '<div style="margin:0.5rem 0;padding:0.5rem 0.75rem;background:rgba(255,80,80,0.08);' +
        'border-left:3px solid var(--color-danger);border-radius:4px;font-family:monospace;font-size:0.8rem;' +
        'color:var(--color-danger);white-space:pre-wrap;word-break:break-word">' +
        escapeHtml(agent.installError) + '</div>'
      : '';

    var actions = '';
    if (agent.installStatus === "active") {
      // Upgrade is always shown on active agents. If the agent is already
      // at manifest.currentVersion the route 409s with a clear message;
      // we'd need a separate /inventory fetch to gate this client-side
      // and the round-trip isn't worth it for a button operators rarely
      // click on a current agent.
      actions =
        '<button type="button" class="btn btn-secondary" id="btn-agent-upgrade" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Upgrade…</button>' +
        ' <button type="button" class="btn btn-secondary" id="btn-agent-uninstall" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Uninstall</button>';
    } else if (agent.installStatus === "failed") {
      // Retry uses the credential + os/arch stored on the row, so the
      // operator doesn't have to re-pick them in a modal. When the row
      // has no installCredentialId on file (credential was deleted),
      // fall back to the full install modal so they can choose a new one.
      var retryId = agent.installCredentialId ? "btn-agent-install-retry" : "btn-agent-install";
      actions =
        '<button type="button" class="btn btn-primary" id="' + retryId + '" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Retry Install…</button>' +
        ' <button type="button" class="btn btn-secondary" id="btn-agent-force-remove" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Force Remove</button>';
    } else if (agent.installStatus === "upgrade_failed") {
      actions =
        '<button type="button" class="btn btn-primary" id="btn-agent-upgrade" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Retry Upgrade</button>' +
        ' <button type="button" class="btn btn-secondary" id="btn-agent-uninstall" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Uninstall</button>' +
        ' <button type="button" class="btn btn-secondary" id="btn-agent-force-remove" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Force Remove</button>';
    } else if (agent.installStatus === "uninstall_failed") {
      actions =
        '<button type="button" class="btn btn-secondary" id="btn-agent-uninstall" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Retry Uninstall</button>' +
        ' <button type="button" class="btn btn-secondary" id="btn-agent-force-remove" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Force Remove</button>';
    } else if (agent.installStatus === "revoked") {
      actions =
        '<button type="button" class="btn btn-secondary" id="btn-agent-force-remove" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Force Remove</button>';
    } else if (inFlight) {
      // Operator can always bail out via force-remove while a transient
      // state is in flight. The async work continues server-side; force-
      // remove just drops the local row.
      actions =
        '<span style="color:var(--color-text-tertiary);font-size:0.85rem">Working…</span>' +
        ' <button type="button" class="btn btn-secondary" id="btn-agent-force-remove" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Force Remove</button>';
    }

    body =
      errBlock +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.4rem 1.25rem;margin:0.5rem 0">' +
        versionRow + platformRow + lastSeenRow + wsRow +
      '</div>' +
      '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.5rem">' + actions + '</div>';
  }

  return '<div id="asset-agent-panel" data-asset-id="' + escapeHtml(a.id) + '" style="margin:0 0 1.5rem;padding:1rem;border:1px solid var(--color-border);border-radius:6px;background:var(--color-surface-1)">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;margin-bottom:0.5rem">' +
      '<h4 style="margin:0;display:flex;align-items:baseline;gap:0.5rem">Polaris Agent ' + headerBadge + '</h4>' +
    '</div>' +
    body +
  '</div>';
}

// Install-progress poll handle (one per modal open). Keyed on assetId so
// reopening the same modal doesn't double-poll.
var _agentPollAssetId = null;

function _isTransientAgentState(s) {
  return s === "pending" || s === "uploading" || s === "enrolling" ||
         s === "uninstalling" || s === "upgrading";
}

function _wireAgentSubpanel(a, agent) {
  var panel = document.getElementById("asset-agent-panel");
  if (!panel) return;

  var installBtn = document.getElementById("btn-agent-install");
  if (installBtn) {
    installBtn.addEventListener("click", function () { _openInstallAgentModal(a); });
  }

  var retryBtn = document.getElementById("btn-agent-install-retry");
  if (retryBtn) {
    retryBtn.addEventListener("click", function () {
      _confirmRetryInstallAgent(a, agent);
    });
  }

  var uninstallBtn = document.getElementById("btn-agent-uninstall");
  if (uninstallBtn) {
    uninstallBtn.addEventListener("click", function () {
      _confirmUninstallAgent(a, /* force */ false);
    });
  }

  var forceBtn = document.getElementById("btn-agent-force-remove");
  if (forceBtn) {
    forceBtn.addEventListener("click", function () {
      _confirmUninstallAgent(a, /* force */ true);
    });
  }

  var upgradeBtn = document.getElementById("btn-agent-upgrade");
  if (upgradeBtn) {
    upgradeBtn.addEventListener("click", function () {
      _confirmUpgradeAgent(a, agent);
    });
  }

  // Start the progress poll if the row is in a transient state. Stops
  // automatically when state stabilizes or the modal closes (we re-check
  // that the panel sentinel is still in the DOM each tick).
  if (agent && _isTransientAgentState(agent.installStatus)) {
    _startAgentPoll(a);
  }
}

function _confirmRetryInstallAgent(a, agent) {
  // Retry reuses the credential + os/arch stored on the row at the
  // original install — no modal. Shows a confirm so a misclick can
  // back out, since this will re-attempt SSH/WinRM against the host.
  var prompt =
    "Retry the Polaris Agent install on " + (a.hostname || a.ipAddress || "this asset") + "?\n\n" +
    "Polaris will reconnect over " + (agent && agent.osPlatform === "windows" ? "WinRM" : "SSH") +
    " using the same credential as the previous attempt, re-upload the agent binary, and run the installer.";
  showConfirm(prompt).then(function (ok) {
    if (!ok) return;
    api.assets.retryInstallAgent(a.id).then(function () {
      showToast("Retry started — watch progress in the Agent panel", "success");
      api.assets.agent(a.id).then(function (ag) {
        _rerenderAgentSubpanel(a, ag);
      });
    }).catch(function (err) {
      showToast("Retry failed: " + err.message, "error");
    });
  });
}

function _confirmUpgradeAgent(a, agent) {
  // Upgrade reuses the credential stored at install time; no new modal
  // needed. We do show a confirm so an operator who reflexively clicked
  // can back out (the upgrade WILL bounce the agent service briefly).
  var prompt =
    "Upgrade the Polaris Agent on " + (a.hostname || a.ipAddress || "this asset") + "?\n\n" +
    "Polaris will SSH/WinRM into the host using the install credential, " +
    "stop the agent service, replace the binary, and restart. The agent's " +
    "bearer and cert pin are preserved — no re-enrollment required. The " +
    "agent will be offline for ~2 seconds while the service restarts.";
  showConfirm(prompt).then(function (ok) {
    if (!ok) return;
    api.assets.upgradeAgent(a.id, {}).then(function (r) {
      showToast("Upgrade started — v" + (r.fromVersion || "?") + " → v" + r.toVersion, "success");
      api.assets.agent(a.id).then(function (ag) {
        _rerenderAgentSubpanel(a, ag);
      });
    }).catch(function (err) {
      showToast("Upgrade failed: " + err.message, "error");
    });
  });
}

function _startAgentPoll(a) {
  if (_agentPollAssetId === a.id) return; // already polling
  _agentPollAssetId = a.id;
  var tick = function () {
    // Bail if the modal closed or the user navigated away.
    var stillOpen = document.getElementById("asset-agent-panel");
    if (!stillOpen || stillOpen.getAttribute("data-asset-id") !== a.id) {
      _agentPollAssetId = null;
      return;
    }
    api.assets.agent(a.id).then(function (agent) {
      // Re-check we're still rendering the same asset.
      var stillOpen2 = document.getElementById("asset-agent-panel");
      if (!stillOpen2 || stillOpen2.getAttribute("data-asset-id") !== a.id) {
        _agentPollAssetId = null;
        return;
      }
      _rerenderAgentSubpanel(a, agent);
      if (agent && _isTransientAgentState(agent.installStatus)) {
        setTimeout(tick, 3000);
      } else {
        _agentPollAssetId = null;
      }
    }).catch(function () {
      // Network blip — try again on the next tick.
      setTimeout(tick, 5000);
    });
  };
  setTimeout(tick, 3000);
}

function _rerenderAgentSubpanel(a, agent) {
  var mount = document.getElementById("asset-agent-panel-mount");
  if (!mount) return;
  mount.innerHTML = assetAgentSubpanelHTML(a, agent);
  _wireAgentSubpanel(a, agent);
}

function _openInstallAgentModal(a) {
  // OS pre-fill: best-effort from Asset.os. Treat empty / unknown as
  // Linux since that's the most common case operators install agents on;
  // they can flip the dropdown if wrong.
  var inferredOs = "linux";
  var osText = (a.os || "").toLowerCase();
  if (osText.indexOf("windows") >= 0)            inferredOs = "windows";
  else if (osText.indexOf("mac") >= 0 ||
           osText.indexOf("darwin") >= 0)         inferredOs = "darwin";

  // Load credentials list so the picker isn't empty on open. Filter to
  // ssh + winrm types — restapi/snmp credentials aren't relevant here.
  _ensureCredentials().then(function () {
    var sshOpts   = (_credentialCache.list || []).filter(function (c) { return c.type === "ssh"; });
    var winrmOpts = (_credentialCache.list || []).filter(function (c) { return c.type === "winrm"; });
    function credOptions(list) {
      if (list.length === 0) {
        return '<option value="">— No credentials of this type —</option>';
      }
      return '<option value="">— Select credential —</option>' +
        list.map(function (c) {
          return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + '</option>';
        }).join("");
    }

    var modalBody =
      '<p style="color:var(--color-text-secondary)">Polaris will SSH or WinRM into the host using the chosen credential, upload the agent binary, and register it as a system service. Status updates appear in the Agent panel while the install runs.</p>' +
      '<div class="form-group" style="margin-top:0.75rem">' +
        '<label for="agent-install-os">Operating system</label>' +
        '<select id="agent-install-os">' +
          '<option value="linux"' +   (inferredOs === "linux" ? " selected" : "") +   '>Linux</option>' +
          '<option value="darwin"' +  (inferredOs === "darwin" ? " selected" : "") +  '>macOS</option>' +
          '<option value="windows"' + (inferredOs === "windows" ? " selected" : "") + '>Windows</option>' +
        '</select>' +
        (a.os ? '' : '<p class="hint" style="color:var(--color-warning)">Asset OS is unknown — confirm the choice above before installing.</p>') +
      '</div>' +
      '<div class="form-group">' +
        '<label for="agent-install-arch">CPU architecture</label>' +
        '<select id="agent-install-arch">' +
          '<option value="amd64" selected>amd64 (x86_64)</option>' +
          '<option value="arm64">arm64</option>' +
        '</select>' +
        '<p class="hint">Pick arm64 only for actually-ARM hosts (Apple Silicon, Raspberry Pi, AWS Graviton, etc.). Most x86 servers and most older Windows hosts are amd64.</p>' +
      '</div>' +
      '<div class="form-group" id="agent-install-transport-wrap" style="display:none">' +
        '<label>Transport</label>' +
        '<div style="display:flex;gap:1rem;align-items:center;padding:0.25rem 0">' +
          '<label style="display:flex;align-items:center;gap:0.35rem;font-weight:normal;cursor:pointer">' +
            '<input type="radio" name="agent-install-transport" value="winrm" checked> WinRM' +
          '</label>' +
          '<label style="display:flex;align-items:center;gap:0.35rem;font-weight:normal;cursor:pointer">' +
            '<input type="radio" name="agent-install-transport" value="ssh"> SSH' +
          '</label>' +
        '</div>' +
        '<p class="hint" id="agent-install-transport-hint">WinRM must be enabled and reachable on port 5986 (HTTPS) or 5985 (HTTP).</p>' +
      '</div>' +
      '<div class="form-group" id="agent-install-cred-ssh-wrap">' +
        '<label for="agent-install-cred-ssh">SSH credential</label>' +
        '<select id="agent-install-cred-ssh">' + credOptions(sshOpts) + '</select>' +
      '</div>' +
      '<div class="form-group" id="agent-install-cred-winrm-wrap">' +
        '<label for="agent-install-cred-winrm">WinRM credential</label>' +
        '<select id="agent-install-cred-winrm">' + credOptions(winrmOpts) + '</select>' +
        '<p class="hint">The credential needs admin rights on the target host (the installer creates a Windows Service and writes under <code>%ProgramFiles%\\Polaris\\Agent\\</code>).</p>' +
      '</div>';

    // Match the canonical modal pattern (TEMPLATES.md → Modal): build the
    // body + a footer string + use openModal directly, then bind the
    // primary button's onclick. showFormModal is the right helper-of-
    // last-resort for plain OK/Cancel forms, but we need to KEEP the
    // modal open on validation failure (no credential picked) without
    // dismissing it on every click, which showFormModal doesn't allow.
    var modalTitle = "Install Polaris Agent on " + (a.hostname || a.ipAddress || "this asset");
    var footerHTML =
      '<button class="btn btn-secondary" id="btn-agent-install-cancel">Cancel</button>' +
      '<button class="btn btn-primary"   id="btn-agent-install-go">Install</button>';
    openModal(modalTitle, modalBody, footerHTML);

    // Toggle credential row visibility based on OS + transport pickers.
    // On Windows, both transports are available and the radio group decides
    // which credential picker is active. On Linux/macOS the transport row is
    // hidden and SSH is the only choice.
    function selectedTransport() {
      var checked = document.querySelector('input[name="agent-install-transport"]:checked');
      return checked ? checked.value : "winrm";
    }
    function refreshCredRows() {
      var os = document.getElementById("agent-install-os").value;
      var transportWrap = document.getElementById("agent-install-transport-wrap");
      var sshWrap   = document.getElementById("agent-install-cred-ssh-wrap");
      var winrmWrap = document.getElementById("agent-install-cred-winrm-wrap");
      var hint      = document.getElementById("agent-install-transport-hint");

      if (os === "windows") {
        transportWrap.style.display = "block";
        var t = selectedTransport();
        sshWrap.style.display   = (t === "ssh")   ? "block" : "none";
        winrmWrap.style.display = (t === "winrm") ? "block" : "none";
        hint.textContent = (t === "ssh")
          ? "SSH requires OpenSSH Server enabled on the Windows host. The credential needs admin rights to register the polaris-agent Windows Service."
          : "WinRM must be enabled and reachable on port 5986 (HTTPS) or 5985 (HTTP).";
      } else {
        transportWrap.style.display = "none";
        sshWrap.style.display   = "block";
        winrmWrap.style.display = "none";
      }
    }
    document.getElementById("agent-install-os").addEventListener("change", refreshCredRows);
    Array.prototype.forEach.call(
      document.querySelectorAll('input[name="agent-install-transport"]'),
      function (el) { el.addEventListener("change", refreshCredRows); }
    );
    refreshCredRows();

    document.getElementById("btn-agent-install-cancel").onclick = closeModal;
    document.getElementById("btn-agent-install-go").onclick = function () {
      var osSel    = document.getElementById("agent-install-os");
      var archSel  = document.getElementById("agent-install-arch");
      var sshSel   = document.getElementById("agent-install-cred-ssh");
      var winrmSel = document.getElementById("agent-install-cred-winrm");
      var os = osSel.value;
      var transport = (os === "windows") ? selectedTransport() : "ssh";
      var credentialId = (transport === "winrm") ? winrmSel.value : sshSel.value;
      if (!credentialId) {
        showToast("Pick a credential first", "error");
        return; // keep modal open
      }
      api.assets.installAgent(a.id, {
        credentialId: credentialId,
        osPlatform:   os,
        arch:         archSel.value,
        transport:    transport,
      }).then(function (r) {
        showToast("Install started — watch progress on the System tab", "success");
        closeModal();
        // Auto-open the asset details modal on the System tab so the
        // operator sees the live install-progress strip without having
        // to navigate. openViewModal renders the Agent sub-panel as part
        // of its body, and the sub-panel's poll loop starts on its own
        // when installStatus is in a transient state. Works regardless
        // of entry point (asset list click, edit modal install button,
        // or the details-modal install button reopening on the same
        // panel — idempotent re-render in that case).
        openViewModal(a.id).then(function () {
          var sysBtn = document.querySelector('#asset-view-tabs [data-tab="system"]');
          if (sysBtn && !sysBtn.classList.contains("active")) sysBtn.click();
        }).catch(function () { /* openViewModal already surfaces its own errors */ });
      }).catch(function (err) {
        showToast("Install failed: " + err.message, "error");
      });
    };
  });
}

function _confirmUninstallAgent(a, force) {
  // showConfirm returns a Promise<boolean>; never use window.confirm
  // (per TEMPLATES.md → Modal canonical pattern).
  var prompt = force
    ? "Force-remove drops the local ManagedAgent row immediately without contacting the host. The agent's bearer has already been revoked, but the binary + service will remain on the host as an orphan — you'll need to clean those up manually. Continue?"
    : "Polaris will SSH into the host using the credential stored at install time, stop the agent, and remove the binary + service. The local row will be hard-deleted on success.";
  showConfirm(prompt).then(function (ok) {
    if (!ok) return;
    api.assets.deleteAgent(a.id, { force: !!force }).then(function () {
      showToast(force ? "Agent force-removed" : "Uninstall started", "success");
      api.assets.agent(a.id).then(function (agent) {
        _rerenderAgentSubpanel(a, agent);
      });
    }).catch(function (err) {
      showToast("Uninstall failed: " + err.message, "error");
    });
  });
}

// ─── System tab (system info section) ──────────────────────────────────────
//
// Renders the CPU/memory chart, temperatures, interfaces (with IPsec tunnels
// nested under the FortiOS phase1-interface they're bound to), and storage.
// Telemetry is collected every ~60s, system info every ~10min, so
// these are sparse compared to the response-time chart that sits above it
// (rendered by assetMonitoringViewHTML). ICMP/SSH-monitored assets render an
// empty-state message because those probes can't deliver this data.
//
// Callers (openViewModal) only invoke this function when the asset is
// monitored — the not-monitored case is handled by the monitoring section
// above. The early-return below is defensive.

function assetSystemViewHTML(a) {
  if (!a) return '<p class="empty-state">No data.</p>';
  if (!a.monitored) {
    return '<div style="padding:1rem 0;color:var(--color-text-secondary)">' +
      'Enable monitoring on this asset (Edit → Monitoring tab) to start collecting CPU/memory and interface data.' +
    '</div>';
  }
  // Heavy-cadence streams (telemetry / interfaces / storage) are only
  // delivered when the resolved interfacesPolling is REST API, SNMP, or
  // Polaris Agent. ICMP / SSH / WinRM don't carry the data shapes yet.
  var ifPolling = a.interfacesPolling;
  if (!ifPolling) {
    var integ = a.discoveredByIntegration;
    var sk = (integ && integ.type) || "manual";
    if (sk !== "fortimanager" && sk !== "fortigate") ifPolling = null;
    else ifPolling = "rest_api";
  }
  if (ifPolling !== "rest_api" && ifPolling !== "snmp" && ifPolling !== "agent") {
    return '<div style="padding:1rem 0;color:var(--color-text-secondary)">' +
      "System metrics (CPU / memory / interfaces / storage) require REST API, SNMP, or Polaris Agent on the Interfaces stream. Install the Polaris Agent (Edit → Monitoring) or switch the polling method to enable." +
    '</div>';
  }
  var rangeBtns =
    _chartRangeBtnsHTML("asset-system-range-btn", [
      { value: "1h",  label: "1h" },
      { value: "24h", label: "24h" },
      { value: "7d",  label: "7d" },
      { value: "30d", label: "30d" },
      { value: "custom", label: "Custom…", id: "btn-asset-system-custom" },
    ], "assetSystem", "1h");
  // CPU/Memory and Temperatures dispatch on their own streams now — operators
  // can run CPU/mem over REST while temperature scrapes over SNMP (the
  // branch-class FortiGate workaround). Each section gets its own badge so
  // the per-stream polling method, credential, MIB, and cadence are visible
  // at a glance. Interfaces and Storage share the Interfaces stream. LLDP is
  // its own stream (per-integration/class/asset REST or SNMP) so it also
  // gets its own badge.
  var telemetryBadge   = _streamSourceBadgeHTML(a, "telemetry");
  var temperatureBadge = _streamSourceBadgeHTML(a, "temperature");
  var interfacesBadge  = _streamSourceBadgeHTML(a, "interfaces");
  var lldpBadge        = _streamSourceBadgeHTML(a, "lldp");
  var telUpdatedAt = a.lastTelemetryAt
    ? ('<span style="font-size:0.72rem;color:var(--color-text-tertiary)" title="' + escapeHtml(new Date(a.lastTelemetryAt).toLocaleString()) + '">updated ' + timeAgo(a.lastTelemetryAt) + '</span>')
    : '';
  var sysInfoUpdatedAt = a.lastSystemInfoAt
    ? ('<span style="font-size:0.72rem;color:var(--color-text-tertiary)" title="' + escapeHtml(new Date(a.lastSystemInfoAt).toLocaleString()) + '">updated ' + timeAgo(a.lastSystemInfoAt) + '</span>')
    : '';
  var telemetryBadgeFull  = telemetryBadge  + (telemetryBadge  && telUpdatedAt     ? " " : "") + telUpdatedAt;
  var interfacesBadgeFull = interfacesBadge + (interfacesBadge && sysInfoUpdatedAt ? " " : "") + sysInfoUpdatedAt;
  var lldpBadgeFull       = lldpBadge       + (lldpBadge       && sysInfoUpdatedAt ? " " : "") + sysInfoUpdatedAt;
  // Temperatures uses its own table-specific timestamp (si.lastTemperatureAt)
  // which can diverge from lastTelemetryAt when the CPU/memory pull succeeds
  // but the sensor pull fails. The header's updated stamp lives in an id'd
  // slot so _renderTemperatures can rewrite it from si data once loaded and
  // flip it amber + "last successful update X ago" when the temp data is
  // stale relative to the resolved cadence. Initial value mirrors telemetry
  // so the placeholder isn't blank during the first paint.
  var temperatureBadgeFull = temperatureBadge + (temperatureBadge ? " " : "") +
    '<span id="asset-system-temps-updated">' + telUpdatedAt + '</span>';
  // FortiOS REST API never exposes storage — hide Storage for any asset on the
  // REST API interfaces stream (firewalls as well as managed switches/APs).
  var isRestApiInterfaces = (function () {
    var p = a.interfacesPolling;
    if (!p) {
      var sk = (a.discoveredByIntegration && a.discoveredByIntegration.type) || "manual";
      return sk === "fortimanager" || sk === "fortigate";
    }
    return p === "rest_api";
  }());
  function sectionHeader(title, badgeHTML, withRangeButtons) {
    return '<div style="display:flex;align-items:center;justify-content:space-between;margin:1.25rem 0 0.5rem">' +
      '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
        '<h4 style="margin:0">' + title + '</h4>' +
        (badgeHTML || '') +
      '</div>' +
      (withRangeButtons ? ('<div style="display:flex;gap:6px">' + rangeBtns + '</div>') : '') +
    '</div>';
  }
  return (
    '<div data-shot-section="cpuMemory" data-shot-label="CPU &amp; Memory" data-shot-chart="assetSystem">' +
    sectionHeader("CPU &amp; Memory", telemetryBadgeFull, true) +
    '<div id="asset-system-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
      '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="asset-system-from" class="form-input" style="padding:2px 6px"></label>' +
      '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="asset-system-to" class="form-input" style="padding:2px 6px"></label>' +
      '<button class="btn btn-sm btn-primary" id="btn-asset-system-custom-apply">Apply</button>' +
    '</div>' +
    '<div id="asset-system-summary" style="display:flex;gap:1.25rem;flex-wrap:wrap;font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">' +
      '<span>Loading…</span>' +
    '</div>' +
    '<div id="asset-system-chart" style="background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;padding:0.5rem;min-height:200px;display:flex;align-items:center;justify-content:center;color:var(--color-text-secondary);font-size:0.85rem">' +
      'Loading samples…' +
    '</div>' +
    '</div>' +
    '<div data-shot-section="sensors" data-shot-label="Hardware Sensors">' +
    sectionHeader("Hardware Sensors", temperatureBadgeFull, false) +
    '<div id="asset-system-temps"><span class="empty-state">Loading…</span></div>' +
    '</div>' +
    '<div data-shot-section="interfaces" data-shot-label="Interfaces" data-shot-sub="hiddenIfaces">' +
    sectionHeader("Interfaces", interfacesBadgeFull, false) +
    '<div id="asset-system-interfaces"><span class="empty-state">Loading…</span></div>' +
    '</div>' +
    (isRestApiInterfaces ? '' : '<div data-shot-section="storage" data-shot-label="Storage">' +
    sectionHeader("Storage", interfacesBadgeFull, false) +
    '<div id="asset-system-storage"><span class="empty-state">Loading…</span></div>' +
    '</div>') +
    '<div data-shot-section="lldp" data-shot-label="LLDP Neighbors">' +
    sectionHeader("LLDP Neighbors", lldpBadgeFull, false) +
    '<div id="asset-system-lldp"><span class="empty-state">Loading…</span></div>' +
    '</div>'
  );
}

function _currentSystemTabRange() {
  var chart = document.getElementById("asset-system-chart");
  if (!chart) return "24h";
  if (chart.dataset.from && chart.dataset.to) {
    return { from: chart.dataset.from, to: chart.dataset.to };
  }
  return chart.dataset.range || "24h";
}

async function _loadSystemTabFor(assetId, range, asset, opts) {
  // Cancel any pending auto-refresh — a manual range change, probe-now, or
  // re-render shouldn't race a scheduled tick.
  if (_assetSystemRefreshTimer) { clearTimeout(_assetSystemRefreshTimer); _assetSystemRefreshTimer = null; }
  var silent = !!(opts && opts.silent);
  // chartOnly: range-button click on the CPU & Memory chart. The other
  // sections (interfaces, storage, temperatures, LLDP, stations) are
  // current-state and don't depend on `range`, so we skip the systemInfo
  // re-fetch + their re-render and reuse the cached si for the chart's
  // stale banner and the latest-reading rows.
  var chartOnly = !!(opts && opts.chartOnly) && _assetSystemSiCache;
  var chart   = document.getElementById("asset-system-chart");
  var summary = document.getElementById("asset-system-summary");
  var ifaces  = document.getElementById("asset-system-interfaces");
  var storage = document.getElementById("asset-system-storage");
  var temps   = document.getElementById("asset-system-temps");
  var lldp    = document.getElementById("asset-system-lldp");
  var stations = document.getElementById("asset-system-stations"); // FortiAP-only mount inside the Stations tab
  if (!chart) return;
  // Accept a range string ("24h") or a { from, to } object for custom windows.
  var telOpts = (typeof range === "string" || !range) ? { range: range || "24h" } : range;
  if (telOpts.from && telOpts.to) {
    chart.dataset.from = telOpts.from;
    chart.dataset.to = telOpts.to;
    delete chart.dataset.range;
  } else {
    chart.dataset.range = telOpts.range || "24h";
    delete chart.dataset.from;
    delete chart.dataset.to;
  }
  if (!silent) {
    chart.textContent = "Loading samples…";
    if (!chartOnly) {
      if (summary) summary.innerHTML = "<span>Loading…</span>";
      if (ifaces)  ifaces.innerHTML  = '<span class="empty-state">Loading…</span>';
      if (storage) storage.innerHTML = '<span class="empty-state">Loading…</span>';
      if (temps)   temps.innerHTML   = '<span class="empty-state">Loading…</span>';
      if (lldp)    lldp.innerHTML    = '<span class="empty-state">Loading…</span>';
    }
  }

  var panelBody = silent ? document.getElementById("asset-panel-body") : null;
  var savedScroll = panelBody ? panelBody.scrollTop : 0;

  try {
    var tel, si;
    if (chartOnly) {
      tel = await api.assets.telemetryHistory(assetId, telOpts);
      si  = _assetSystemSiCache;
    } else {
      var results = await Promise.all([
        api.assets.telemetryHistory(assetId, telOpts),
        api.assets.systemInfo(assetId),
      ]);
      tel = results[0];
      si  = results[1];
      _assetSystemSiCache = si;
    }

    _renderSystemChart(chart, tel, asset, si);
    _renderSystemSummary(summary, tel, si);
    if (!chartOnly) {
      _renderInterfacesTable(ifaces, si, asset);
      _renderStorageTable(storage, si, asset);
      _renderTemperatures(temps, si, asset);
      _renderLldpNeighborsCard(lldp, si, asset);
      if (stations) _renderWirelessStationsCard(stations, si, asset);
    }
  } catch (err) {
    if (!silent) {
      chart.textContent = "Error: " + (err.message || "failed to load");
      if (!chartOnly) {
        if (summary) summary.innerHTML = "";
        if (ifaces)  ifaces.innerHTML  = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
        if (storage) storage.innerHTML = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
        if (temps)   temps.innerHTML   = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
        if (lldp)    lldp.innerHTML    = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
      }
    }
    // On silent-refresh failure leave the stale content alone so the user
    // doesn't see a transient blip blow away the panel they were reading.
  }
  if (panelBody) {
    panelBody.scrollTop = savedScroll;
    requestAnimationFrame(function () {
      if (panelBody.scrollTop !== savedScroll) panelBody.scrollTop = savedScroll;
    });
  }
  // Custom date ranges are fixed historical windows — do not auto-refresh.
  if (telOpts.from && telOpts.to) return;
  // Schedule next auto-refresh on the telemetry cadence (the fastest of the
  // three System-tab streams). Keep going on error so a transient blip doesn't
  // disable the chain.
  var settings = _monitorSettingsCache || {};
  var refAsset = asset || _currentAssetForRefresh;
  var ms = _refreshIntervalMs(refAsset && refAsset.cpuMemoryIntervalSec, settings.cpuMemoryIntervalSeconds, 60);
  _scheduleAssetSystemRefresh(assetId, refAsset, ms);
}

// Renders the CPU & Memory window summary. The stats container below the
// chart gets the canonical "<count> samples · <Label>: <value> · ..."
// shape via _renderChartStats.
function _renderSystemSummary(container, tel, si) {
  if (!container) return;
  if (!tel || !tel.stats || !tel.stats.total) {
    container.textContent = "No telemetry samples in this range yet.";
    delete container.dataset.summary;
    return;
  }
  var s = tel.stats;
  var telParts = [
    { label: "CPU avg", value: s.avgCpuPct != null ? s.avgCpuPct.toFixed(1) + "%" : "—" },
    { label: "CPU max", value: s.maxCpuPct != null ? s.maxCpuPct.toFixed(1) + "%" : "—" },
    { label: "Mem avg", value: s.avgMemPct != null ? s.avgMemPct.toFixed(1) + "%" : "—" },
    { label: "Mem max", value: s.maxMemPct != null ? s.maxMemPct.toFixed(1) + "%" : "—" },
  ];
  var telTierPart = _tierStatsPart(tel);
  if (telTierPart) telParts.unshift(telTierPart);
  _renderChartStats(container, s.total, telParts);
}

// Returns true when the asset is a managed FortiSwitch or FortiAP whose
// resolved polling method *for the given stream* is REST API. These devices
// aren't directly REST-able — the relevant endpoints live on the parent
// FortiGate, not on the device's own IP — so REST API delivers no telemetry,
// no temperature, no LLDP, and no interface-refresh data for them. Each
// stream has its own polling-method override, so a FortiAP on SNMP for
// temperature must not trip the "not available via REST API" banner just
// because its interfaces stream is still REST.
// Resolves the polling method actually in effect for a stream, preferring the
// cached /effective-monitor-settings walk (which covers the class + integration
// tiers) over the per-asset override, then the source default. Mirrors the
// precedence in _resolveStaleStreamSec so the "not available via REST API"
// empty-state banners agree with the resolved-polling chip. Re-deriving from
// the asset-level *Polling field alone ignored an integration-tier SNMP
// override and produced a bogus "switch to SNMP" nag on FortiGates that were
// already polling temperature via SNMP. Returns null when no method resolves.
function _resolvedStreamPolling(asset, stream) {
  if (!asset) return null;
  var field = _streamFieldPrefix(stream || "interfaces") + "Polling";
  var eff = asset.id ? _effectiveResolvedByAssetId.get(asset.id) : null;
  if (eff && eff[field]) return eff[field];
  if (asset[field]) return asset[field];
  var sk = (asset.discoveredByIntegration && asset.discoveredByIntegration.type) || "manual";
  if (!_POLLING_COMPAT[sk]) sk = "manual";
  return _polarisSourceDefaultPolling(sk, stream || "interfaces");
}

function _isRestApiManagedNetworkDevice(asset, stream) {
  if (!asset) return false;
  var t = asset.assetType;
  if (t !== "switch" && t !== "access_point") return false;
  return _resolvedStreamPolling(asset, stream || "interfaces") === "rest_api";
}

// Resolves the polling interval (in seconds) used to gate the stale-data
// banner for a given stream. Priority — most-authoritative first:
//   1. _effectiveResolvedByAssetId (full /effective-monitor-settings walk —
//      covers per-asset, class override, integration, manual tiers)
//   2. Per-asset override on the loaded asset object
//   3. Manual tier from _monitorSettingsCache
//   4. Hardcoded floor (60s telemetry / 600s systemInfo)
// The first source is missing on first paint (the eff fetch is async). The
// _updateStaleBannersFromEffective post-pass below re-evaluates each slot
// once the cache populates, so a mid-tier interval like a class override is
// honored without waiting for the next full system-info refresh.
function _resolveStaleStreamSec(assetId, asset, streamKey) {
  var effField = streamKey + "IntervalSeconds";
  var perAssetField = streamKey + "IntervalSec";
  var defaultSec = (streamKey === "systemInfo") ? 600 : 60;
  var effResolved = assetId ? _effectiveResolvedByAssetId.get(assetId) : null;
  if (effResolved && typeof effResolved[effField] === "number" && effResolved[effField] > 0) return effResolved[effField];
  if (asset && typeof asset[perAssetField] === "number" && asset[perAssetField] > 0) return asset[perAssetField];
  var settings = _monitorSettingsCache || {};
  if (typeof settings[effField] === "number" && settings[effField] > 0) return settings[effField];
  return defaultSec;
}

// Rewrites the Temperatures section header's updated stamp using the
// table-specific timestamp (si.lastTemperatureAt). Falls back to
// lastTelemetryAt when the temp table has never produced a row (typically
// "no sensors reported"). When the temp data is older than 3× the resolved
// telemetry cadence the stamp turns amber and the label flips to
// "last successful update X ago" so the row-set freshness is unambiguous
// and the previously-separate stale banner can be omitted.
function _updateTemperatureUpdatedStamp(asset, si) {
  var slot = document.getElementById("asset-system-temps-updated");
  if (!slot) return;
  var tempLastAt = (si && (si.lastTemperatureAt || si.lastTelemetryAt)) ||
    (asset && asset.lastTelemetryAt) || null;
  if (!tempLastAt) { slot.innerHTML = ""; return; }
  var resolvedSec = _resolveStaleStreamSec(asset && asset.id, asset, "telemetry");
  var ageMs = Date.now() - new Date(tempLastAt).getTime();
  var isStale = ageMs > resolvedSec * 3 * 1000;
  var color = isStale ? "var(--color-warning)" : "var(--color-text-tertiary)";
  var label = isStale ? "last successful update " : "updated ";
  slot.innerHTML = '<span style="font-size:0.72rem;color:' + color + '" title="' +
    escapeHtml(new Date(tempLastAt).toLocaleString()) + '">' +
    (isStale ? "&#9888; " : "") + label + timeAgo(tempLastAt) + '</span>';
}

function _staleBannerInnerHTML(lastAt, resolvedSec) {
  if (!lastAt) return "";
  var ageMs = Date.now() - new Date(lastAt).getTime();
  var thresholdMs = resolvedSec * 3 * 1000;
  if (ageMs <= thresholdMs) return "";
  return "<div style=\"margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:rgba(245,127,23,0.08);border:1px solid rgba(245,127,23,0.3);border-radius:6px;font-size:0.8rem;color:var(--color-warning)\">&#9888; " + escapeHtml("Information last updated " + timeAgo(lastAt)) + "</div>";
}

// Amber stale-data banner. Emits a slot wrapper carrying the assetId, stream
// key, and lastAt timestamp so _updateStaleBannersFromEffective can rewrite
// the inner content once /effective-monitor-settings lands (covers cases
// where the resolved cadence comes from a class override the sync render
// can't see). Banner appears only when `lastAt` is older than 3× the
// resolved polling interval. `streamKey` is one of: "telemetry"
// (CPU/memory/temps) or "systemInfo" (interfaces/storage/IPsec/LLDP).
function _staleBannerHTML(assetId, asset, streamKey, lastAt) {
  var resolvedSec = _resolveStaleStreamSec(assetId, asset, streamKey);
  var inner = _staleBannerInnerHTML(lastAt, resolvedSec);
  return '<div class="asset-stale-banner-slot" data-asset-id="' + escapeHtml(assetId || "") + '" data-stream="' + escapeHtml(streamKey) + '" data-last-at="' + escapeHtml(lastAt || "") + '">' + inner + '</div>';
}

// Re-evaluates every stale-banner slot for an asset using the now-cached
// /effective-monitor-settings resolved values. Called from
// _updateStreamSourceBadgesFromEffective so badge + banner refresh together.
// Re-checks data-asset-id on each slot so a stale fetch after the modal
// switched assets doesn't write into the wrong row.
function _updateStaleBannersFromEffective(assetId, asset) {
  if (!assetId) return;
  var sel = '.asset-stale-banner-slot[data-asset-id="' + (window.CSS && CSS.escape ? CSS.escape(assetId) : assetId) + '"]';
  var slots = document.querySelectorAll(sel);
  slots.forEach(function (slot) {
    var streamKey = slot.getAttribute("data-stream");
    var lastAt = slot.getAttribute("data-last-at") || null;
    if (!streamKey) return;
    var resolvedSec = _resolveStaleStreamSec(assetId, asset, streamKey);
    slot.innerHTML = _staleBannerInnerHTML(lastAt, resolvedSec);
  });
  // The Temperatures section's "not available via REST API" empty state is
  // decided from the resolved temperature polling method, which the sync
  // render couldn't see before this effective-settings walk landed. Re-render
  // it now so a FortiGate whose temperature resolves to SNMP at the
  // integration tier drops the misleading "switch to SNMP" hint (mirrors the
  // chip refresh in _updateStreamSourceBadgesFromEffective). Only meaningful
  // in the no-readings branch; when sensors exist the table renders regardless.
  // _assetSystemSiCache is nulled on asset switch and only repopulated for the
  // current asset, so the asset.id === assetId guard keeps si aligned.
  var tempsEl = document.getElementById("asset-system-temps");
  if (tempsEl && asset && asset.id === assetId && _assetSystemSiCache) {
    _renderTemperatures(tempsEl, _assetSystemSiCache, asset);
  }
}

// Centred "not available" empty-state for a section whose polling method
// cannot deliver this data stream. `label` is the data-type name (e.g.
// "Telemetry"). `pollingMethod` is the human-readable label (e.g. "REST API").
// Optional `description` overrides the default body text (raw HTML — caller is
// responsible for safety; use when a device-specific note is needed).
function _notAvailableViaPollingHTML(label, pollingMethod, description) {
  var desc = (description !== undefined && description !== null)
    ? description
    : "This data is not collected for this device with the current polling method. Try a different polling method on the Monitoring tab.";
  return "<div style=\"text-align:center\">" +
    "<div style=\"color:var(--color-warning);font-size:0.9rem;margin-bottom:0.4rem\">&#9888; " + escapeHtml(label) + " not available via " + escapeHtml(pollingMethod || "current polling method") + "</div>" +
    "<div style=\"font-size:0.8rem;color:var(--color-text-secondary)\">" + desc + "</div>" +
  "</div>";
}

function _renderInterfacesTable(container, si, asset) {
  if (!container) return;
  var rows = (si && si.interfaces) || [];
  var tunnelsAll = (si && si.ipsecTunnels) || [];
  var lldpAll = (si && si.lldpNeighbors) || [];
  if (rows.length === 0 && tunnelsAll.length === 0) {
    container.innerHTML = '<p class="empty-state">No interface data yet — system info is collected every ~10 minutes after monitoring is enabled.</p>';
    return;
  }
  var staleBanner = _staleBannerHTML(asset && asset.id, asset, "systemInfo", si && si.lastSystemInfoAt);
  var monitored        = new Set(((si && si.monitoredInterfaces)   || (asset && asset.monitoredInterfaces)   || []));
  var monitoredTunnels = new Set(((si && si.monitoredIpsecTunnels) || (asset && asset.monitoredIpsecTunnels) || []));
  var canEdit = canManageAssets();
  // VLAN columns appear only when at least one row in this table actually
  // carries port-VLAN data (managed FortiSwitches overlaid from the parent
  // FortiGate's CMDB). On FortiGates / non-Fortinet hosts the columns would
  // otherwise render as dashes across every row, which is just noise.
  var showVlanCols = rows.some(function (r) {
    return r.nativeVlan != null ||
      (Array.isArray(r.taggedVlans) && r.taggedVlans.length > 0) ||
      r.trunksAllVlans === true;
  });
  // "Inactive" = no traffic ever observed (both cumulative counters are
  // null or zero). User-set rule: ports with any non-zero in/out count
  // are always shown regardless of admin/oper status; everything else
  // gets hidden behind a "Show N inactive interfaces" expander so a
  // 48-port switch with 6 active ports isn't a wall of zeros. Aggregate
  // members, VLAN sub-interfaces, loopbacks, etc. follow the same rule.
  function isInactive(iface) {
    var hasIn  = iface.inOctets  != null && iface.inOctets  > 0;
    var hasOut = iface.outOctets != null && iface.outOctets > 0;
    return !hasIn && !hasOut;
  }
  var COLS = 11 + (showVlanCols ? 2 : 0);
  // Group LLDP neighbors by local interface so the row builder can stamp the
  // first neighbor's label inline. Most ports only ever see one neighbor; a
  // "+N" badge appears when more are present and the slide-over enumerates them.
  var lldpByIf = {};
  lldpAll.forEach(function (n) {
    if (!n || !n.localIfName) return;
    if (!lldpByIf[n.localIfName]) lldpByIf[n.localIfName] = [];
    lldpByIf[n.localIfName].push(n);
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  function statusCell(i) {
    var statusLabel, statusKind;
    if (i.adminStatus && String(i.adminStatus).toLowerCase() === "down") {
      statusLabel = "admin shut"; statusKind = "decommissioned";
    } else if (i.operStatus) {
      statusLabel = String(i.operStatus).toLowerCase();
      statusKind = statusLabel === "up" ? "active" : "decommissioned";
    } else if (i.adminStatus) {
      statusLabel = String(i.adminStatus).toLowerCase();
      statusKind = statusLabel === "up" ? "active" : "decommissioned";
    }
    return statusLabel
      ? '<span class="status-pill status-pill-' + statusKind + '">' + escapeHtml(statusLabel) + '</span>'
      : '—';
  }

  function typeBadge(iface, isChild) {
    var t = iface.ifType;
    // Member port of an aggregate: show "Member" regardless of its stored type.
    if (isChild && t !== "vlan") {
      return '<span style="font-size:0.7rem;padding:1px 5px;border-radius:3px;background:#6b728018;color:#9ca3af;border:1px solid #6b728030;margin-left:5px">Member</span>';
    }
    var cfgs = {
      physical:  ["Physical",  "#6b7280"],
      aggregate: ["Aggregate", "#3b82f6"],
      vlan:      [iface.vlanId ? "VLAN " + iface.vlanId : "VLAN", "#0d9488"],
      loopback:  ["Loopback",  "#6b7280"],
      tunnel:    ["Tunnel",    "#6b7280"],
    };
    var cfg = cfgs[t];
    if (!cfg) return "";
    var c = cfg[1];
    return '<span style="font-size:0.7rem;padding:1px 5px;border-radius:3px;background:' + c + '18;color:' + c + ';border:1px solid ' + c + '30;margin-left:5px;white-space:nowrap">' + escapeHtml(cfg[0]) + '</span>';
  }

  // Native + Tagged VLAN cells for the interfaces table — populated only on
  // managed FortiSwitches where the monitoring path overlaid the parent
  // FortiGate's CMDB ports table. Other rows in the same table get "—".
  // The Tagged column collapses long lists past 6 entries to "<6>, +N more"
  // with the full list in the cell tooltip; trunk-all ports show "all"
  // distinctly from explicit-list trunks, matching the slide-over pill.
  function vlanCellsHTML(iface) {
    if (!showVlanCols) return "";
    var native = (iface.nativeVlan != null) ? iface.nativeVlan : null;
    var tagged = Array.isArray(iface.taggedVlans) ? iface.taggedVlans : [];
    var trunkAll = iface.trunksAllVlans === true;
    var nativeCell = '<td class="mono">' + (native != null ? escapeHtml(String(native)) : "—") + '</td>';
    var taggedHTML, taggedTitle;
    if (trunkAll) {
      taggedHTML = '<span style="font-size:0.7rem;padding:1px 5px;border-radius:3px;background:#0d948818;color:#0d9488;border:1px solid #0d948830">all</span>';
      taggedTitle = "allowed-vlans=all" + (tagged.length > 0 ? " (explicit: " + tagged.join(",") + ")" : "");
    } else if (tagged.length === 0) {
      taggedHTML = "—";
      taggedTitle = "";
    } else if (tagged.length <= 6) {
      taggedHTML = escapeHtml(tagged.join(", "));
      taggedTitle = tagged.join(",");
    } else {
      taggedHTML = escapeHtml(tagged.slice(0, 6).join(", ")) + ' <span style="opacity:0.7">+' + (tagged.length - 6) + ' more</span>';
      taggedTitle = tagged.join(",");
    }
    var taggedCell = '<td class="mono"' + (taggedTitle ? ' title="' + escapeHtml(taggedTitle) + '"' : "") + '>' + taggedHTML + '</td>';
    return nativeCell + taggedCell;
  }

  // L3 addressing mode pill (FortiOS CMDB `system/interface.mode`). Only the
  // FortiOS REST path populates this; SNMP / Polaris Agent rows leave it null
  // and render "—" (same convention as the FortiSwitch-only VLAN columns).
  function addressingCell(iface) {
    var m = iface.addressingMode;
    if (!m) return "<td>—</td>";
    var cfgs = {
      dhcp:   ["DHCP",   "#3b82f6"],
      static: ["Static", "#6b7280"],
      pppoe:  ["PPPoE",  "#8b5cf6"],
    };
    var cfg = cfgs[String(m).toLowerCase()];
    if (!cfg) return '<td>' + escapeHtml(String(m)) + "</td>";
    var c = cfg[1];
    return '<td><span style="font-size:0.7rem;padding:1px 5px;border-radius:3px;background:' + c + '18;color:' + c + ';border:1px solid ' + c + '30;white-space:nowrap">' + cfg[0] + "</span></td>";
  }

  function buildRow(iface, opts) {
    opts = opts || {};
    var checked  = monitored.has(iface.ifName) ? " checked" : "";
    var disabled = canEdit ? "" : " disabled";
    var checkbox = '<input type="checkbox" class="asset-iface-toggle" data-ifname="' + escapeHtml(iface.ifName) + '"' + checked + disabled + ' title="Poll this interface every minute for fast-cadence monitoring">';

    var prefix = "", padStyle = "";
    if (opts.isParent) {
      prefix = '<button class="iface-expand-toggle" data-parent="' + escapeHtml(iface.ifName) + '" style="background:none;border:none;cursor:pointer;color:var(--color-text-secondary);padding:0 3px 0 0;font-size:0.75rem;vertical-align:middle;line-height:1" title="Collapse children">▼</button>';
    }
    if (opts.isChild) {
      padStyle = "padding-left:1.4rem;";
      prefix = '<span style="color:var(--color-text-secondary);opacity:0.5;margin-right:3px;font-size:0.8rem">└</span>';
    }
    // Operator-set alias overrides ifName as the visible label when present.
    // The real ifName is preserved as a tooltip + secondary subtitle so the
    // operator can still correlate to switch port labels in the wild.
    var label = iface.alias && iface.alias.trim() ? iface.alias.trim() : iface.ifName;
    var aliasOverride = !!(iface.alias && iface.alias.trim() && iface.alias.trim() !== iface.ifName);
    var subtitle = aliasOverride
      ? '<span style="display:block;font-size:0.7rem;opacity:0.6;font-weight:normal">' + escapeHtml(iface.ifName) + '</span>'
      : '';
    var nameCell =
      '<td class="mono" style="' + padStyle + '" title="' + escapeHtml(iface.ifName) + '">' + prefix +
      '<a href="#" class="asset-iface-link" data-ifname="' + escapeHtml(iface.ifName) + '" style="color:var(--color-accent);text-decoration:none">' + escapeHtml(label) + '</a>' +
      typeBadge(iface, opts.isChild) +
      subtitle +
      '</td>';

    var speed = iface.speedBps != null ? _fmtSpeed(iface.speedBps) : "—";
    var errs  = ((iface.inErrors != null && iface.inErrors > 0) || (iface.outErrors != null && iface.outErrors > 0))
      ? ((iface.inErrors || 0) + " / " + (iface.outErrors || 0))
      : "0 / 0";
    // Combine child + inactive classes. Inactive rows ship with inline
    // display:none; the expander toggle clears the inline style (and
    // re-applies it if the row's parent is collapsed when re-hiding).
    var classes = [];
    if (opts.isChild) classes.push("iface-child");
    var inactive = isInactive(iface);
    if (inactive) classes.push("iface-inactive");
    var rowAttrs = classes.length > 0 ? ' class="' + classes.join(" ") + '"' : "";
    if (opts.isChild) rowAttrs += ' data-parent="' + escapeHtml(opts.parentName) + '"';
    if (inactive) rowAttrs += ' style="display:none"';
    var neighborCell = '<td>' + _lldpNeighborInlineCell(lldpByIf[iface.ifName] || []) + '</td>';

    return "<tr" + rowAttrs + ">" +
      '<td style="text-align:center;width:1%">' + checkbox + "</td>" +
      nameCell +
      "<td>" + statusCell(iface) + "</td>" +
      "<td>" + speed + "</td>" +
      '<td class="mono">' + escapeHtml(iface.ipAddress  || "—") + "</td>" +
      addressingCell(iface) +
      '<td class="mono">' + escapeHtml(iface.macAddress || "—") + "</td>" +
      vlanCellsHTML(iface) +
      "<td>" + (iface.inOctets  != null ? _fmtBytes(iface.inOctets)  : "—") + "</td>" +
      "<td>" + (iface.outOctets != null ? _fmtBytes(iface.outOctets) : "—") + "</td>" +
      '<td title="In errors / Out errors (cumulative)">' + errs + "</td>" +
      neighborCell +
    "</tr>";
  }

  function sectionRow(label, count) {
    return '<tr style="background:transparent"><td colspan="' + COLS + '" style="padding:0.35rem 0.6rem 0.2rem;font-size:0.71rem;font-weight:600;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid var(--color-border)">' +
      escapeHtml(label) + ' <span style="font-weight:400;opacity:0.7">(' + count + ')</span>' +
    "</td></tr>";
  }

  // IPsec tunnel row, rendered inline with the interfaces table. depth=0 →
  // top-level (orphan/unbound), depth=1 → nested under a top-level interface,
  // depth=2 → nested under a VLAN/aggregate child. `collapseGroupName`, when
  // set, ties the row to a top-level parent's expand/collapse toggle.
  function buildTunnelRow(tn, opts) {
    opts = opts || {};
    var depth = opts.depth || 0;
    var pad = depth > 0 ? "padding-left:" + (1.4 * depth) + "rem;" : "";
    var bullet = depth > 0
      ? '<span style="color:var(--color-text-secondary);opacity:0.5;margin-right:3px;font-size:0.8rem">└</span>'
      : "";
    var checked  = monitoredTunnels.has(tn.tunnelName) ? " checked" : "";
    var disabled = canEdit ? "" : " disabled";
    var checkbox =
      '<input type="checkbox" class="asset-ipsec-toggle" data-name="' + escapeHtml(tn.tunnelName) + '"' + checked + disabled +
      ' title="Poll this tunnel every minute (response-time cadence)">';
    var p2title = tn.proxyIdCount != null ? (tn.proxyIdCount + " phase-2 selector(s)") : "IPsec phase-1 tunnel";
    var ipsecBadge =
      '<span style="font-size:0.7rem;padding:1px 5px;border-radius:3px;background:#f59e0b18;color:#f59e0b;border:1px solid #f59e0b30;margin-left:5px;white-space:nowrap" title="' +
        escapeHtml(p2title) + '">IPsec</span>';
    var nameCell =
      '<td class="mono" style="' + pad + '" title="' + escapeHtml(tn.tunnelName) + '">' + bullet +
        '<a href="#" class="asset-ipsec-link" data-name="' + escapeHtml(tn.tunnelName) + '" style="color:var(--color-accent);text-decoration:none">' +
          escapeHtml(tn.tunnelName) +
        '</a>' + ipsecBadge +
      "</td>";
    // "dynamic" = FortiOS phase1-interface type "dynamic" (dial-up server
    // template). Render as a neutral storage-style pill — not red, since the
    // tunnel is working as configured even when no client is connected.
    var pillKind = tn.status === "up" ? "active"
                 : tn.status === "down" ? "decommissioned"
                 : tn.status === "dynamic" ? "storage"
                 : "maintenance";
    var statusPill = '<span class="status-pill status-pill-' + pillKind + '">' + escapeHtml(tn.status) + "</span>";
    var rowAttr = opts.collapseGroupName
      ? ' class="iface-child" data-parent="' + escapeHtml(opts.collapseGroupName) + '"'
      : "";
    // VLAN columns (when present) sit between MAC and In. IPsec tunnels
    // don't carry per-port VLAN config, so emit empty placeholders so the
    // column count stays consistent across every row in the table.
    var vlanPlaceholders = showVlanCols ? '<td class="mono">—</td><td class="mono">—</td>' : "";
    return "<tr" + rowAttr + ">" +
      '<td style="text-align:center;width:1%">' + checkbox + "</td>" +
      nameCell +
      "<td>" + statusPill + "</td>" +
      "<td>—</td>" +
      '<td class="mono">' + escapeHtml(tn.remoteGateway || "—") + "</td>" +
      "<td>—</td>" +
      '<td class="mono">—</td>' +
      vlanPlaceholders +
      "<td>" + (tn.incomingBytes != null ? _fmtBytes(tn.incomingBytes) : "—") + "</td>" +
      "<td>" + (tn.outgoingBytes != null ? _fmtBytes(tn.outgoingBytes) : "—") + "</td>" +
      "<td>—</td>" +
      "<td>—</td>" +
    "</tr>";
  }

  // ── build tree ─────────────────────────────────────────────────────────────
  // childMap: parentIfName -> sorted [child interfaces]  (members first, VLANs after)
  var childMap = {};
  rows.forEach(function (r) {
    if (r.ifParent) {
      if (!childMap[r.ifParent]) childMap[r.ifParent] = [];
      childMap[r.ifParent].push(r);
    }
  });
  Object.keys(childMap).forEach(function (k) {
    childMap[k].sort(function (a, b) {
      var av = a.ifType === "vlan" ? 1 : 0, bv = b.ifType === "vlan" ? 1 : 0;
      if (av !== bv) return av - bv;
      return String(a.ifName).localeCompare(String(b.ifName), undefined, { numeric: true, sensitivity: "base" });
    });
  });

  // tunnelMap: parentInterface -> sorted [tunnels]; orphanTunnels covers
  // tunnels with no parentInterface OR whose parent isn't in the interface
  // list (CMDB scope mismatch, filtered-out interface, etc.).
  var ifaceNameSet = new Set(rows.map(function (r) { return r.ifName; }));
  var tunnelMap = {};
  var orphanTunnels = [];
  tunnelsAll.forEach(function (tn) {
    if (tn.parentInterface && ifaceNameSet.has(tn.parentInterface)) {
      if (!tunnelMap[tn.parentInterface]) tunnelMap[tn.parentInterface] = [];
      tunnelMap[tn.parentInterface].push(tn);
    } else {
      orphanTunnels.push(tn);
    }
  });
  function _byTunnelName(a, b) {
    return String(a.tunnelName).localeCompare(String(b.tunnelName), undefined, { numeric: true, sensitivity: "base" });
  }
  Object.keys(tunnelMap).forEach(function (k) { tunnelMap[k].sort(_byTunnelName); });
  orphanTunnels.sort(_byTunnelName);

  // Render an interface plus its VLAN/aggregate children plus any IPsec
  // tunnels nested at either level. Tunnel rows reuse the iface-child class
  // and the top-level's data-parent so they collapse together with the
  // existing toggle handler.
  function renderCluster(iface) {
    var kids = childMap[iface.ifName] || [];
    var directTunnels = tunnelMap[iface.ifName] || [];
    var nestedTunnelsCount = directTunnels.length;
    kids.forEach(function (child) {
      nestedTunnelsCount += (tunnelMap[child.ifName] || []).length;
    });
    var hasNested = kids.length > 0 || nestedTunnelsCount > 0;
    var collapseGroup = iface.ifName;
    var out = buildRow(iface, { isParent: hasNested });
    kids.forEach(function (child) {
      out += buildRow(child, { isChild: true, parentName: collapseGroup });
      (tunnelMap[child.ifName] || []).forEach(function (tn) {
        out += buildTunnelRow(tn, { collapseGroupName: collapseGroup, depth: 2 });
      });
    });
    directTunnels.forEach(function (tn) {
      out += buildTunnelRow(tn, { collapseGroupName: collapseGroup, depth: 1 });
    });
    return out;
  }

  // Top-level: no ifParent set
  var topLevel = rows.filter(function (r) { return !r.ifParent; });
  topLevel.sort(function (a, b) {
    return String(a.ifName).localeCompare(String(b.ifName), undefined, { numeric: true, sensitivity: "base" });
  });

  // Group physical + aggregate together so member ports nest under their
  // aggregate inline (a "lag1" row sorts among "port1, port2..." and its
  // member ports indent under it on expand). The previous split — separate
  // "Aggregate Interfaces" and "Physical Interfaces" headers — fragmented
  // the natural reading order and forced the operator to mentally stitch a
  // physical port back to its aggregate two sections apart. "Other" (VLAN,
  // loopback, tunnel) stays in its own group because those are conceptually
  // distinct surfaces, not physical-layer ports.
  var ifaceGroup = topLevel.filter(function (r) {
    return r.ifType === "aggregate" || r.ifType === "physical" || r.ifType == null;
  });
  var otherGroup = topLevel.filter(function (r) {
    return r.ifType && r.ifType !== "physical" && r.ifType !== "aggregate";
  });

  // ── render ─────────────────────────────────────────────────────────────────
  var html = "";

  if (ifaceGroup.length > 0) {
    html += sectionRow("Interfaces", ifaceGroup.length);
    ifaceGroup.forEach(function (iface) { html += renderCluster(iface); });
  }

  if (otherGroup.length > 0) {
    html += sectionRow("Other Interfaces", otherGroup.length);
    otherGroup.forEach(function (iface) { html += renderCluster(iface); });
  }

  // Tunnels with no resolvable parent interface (CMDB unreachable, parent
  // filtered out, etc.) get their own section so they're not lost.
  if (orphanTunnels.length > 0) {
    html += sectionRow("IPsec Tunnels (unbound)", orphanTunnels.length);
    orphanTunnels.forEach(function (tn) { html += buildTunnelRow(tn, { depth: 0 }); });
  }

  // Per-table inactive count drives the trailing toggle row. Excludes
  // tunnels and section rows (those aren't in the .iface-inactive class).
  var inactiveCount = rows.filter(isInactive).length;
  var inactiveRow = inactiveCount > 0
    ? '<tr id="iface-inactive-toggle-row"><td colspan="' + COLS + '" style="padding:0.45rem 0.6rem;text-align:center;background:transparent;border-top:1px solid var(--color-border)">' +
        '<button type="button" id="iface-inactive-toggle" style="background:none;border:none;color:var(--color-text-secondary);font-size:0.78rem;cursor:pointer;padding:0;text-decoration:underline" title="Inactive = no in/out traffic counters">' +
          '▶ Show ' + inactiveCount + ' inactive interface' + (inactiveCount === 1 ? '' : 's') + ' (no traffic)' +
        '</button>' +
      '</td></tr>'
    : "";
  var vlanHeader = showVlanCols
    ? '<th data-col-id="native-vlan" title="Untagged PVID on the FortiSwitch port">Native VLAN</th>' +
      '<th data-col-id="tagged-vlans" title="Tagged VLAN set on the FortiSwitch port (allowed-vlans − untagged-vlans). \"all\" indicates `set allowed-vlans all`.">Tagged VLANs</th>'
    : "";
  container.innerHTML = staleBanner +
    '<p class="hint" style="margin:0 0 0.4rem 0;font-size:0.76rem">The <strong>Poll&nbsp;1m</strong> column selects interfaces for fast-cadence polling and <strong>full-history retention</strong>. Unselected interfaces are kept for 24&nbsp;h only.</p>' +
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th title="Pin this interface for fast-cadence polling + full-history retention (unselected interfaces are kept 24h)" style="width:32px" data-col-id="poll" data-col-required="true"></th>' +
      '<th data-col-id="ifname" data-col-required="true">Interface</th>' +
      '<th data-col-id="status">Status</th>' +
      '<th data-col-id="speed">Speed</th>' +
      '<th data-col-id="ip">IP</th>' +
      '<th data-col-id="addressing" title="L3 addressing mode — FortiOS only (CMDB system/interface mode). DHCP, Static, or PPPoE; other sources show —">Addressing</th>' +
      '<th data-col-id="mac">MAC</th>' +
      vlanHeader +
      '<th data-col-id="in">In</th>' +
      '<th data-col-id="out">Out</th>' +
      '<th data-col-id="errors">Errors (in/out)</th>' +
      '<th title="LLDP neighbor seen on this interface" data-col-id="neighbor">Neighbor</th>' +
    '</tr></thead><tbody>' + html + inactiveRow + "</tbody></table></div>";
  if (typeof applyTableLayout === "function") {
    // Per device-type persistence — FortiGate, FortiSwitch, FortiAP, and
    // generic endpoints have very different interface tables (aggregate
    // names + IPsec rows on firewalls; dozens of `port1..portN` on switches;
    // 2-3 short names on APs) so operators want independent column widths
    // per class. See _assetTableTypeKey.
    var ifaceTypeKey = _assetTableTypeKey("asset-interfaces", asset);
    applyTableLayout(container.querySelector("table"), ifaceTypeKey, {
      onScreenshot: function (t) { _screenshotTableEl(t, "Interfaces", { hiddenNoun: "interface" }); },
    });
  }

  // Restore per-user, per-asset collapsed state for nested rows.
  var assetId = asset && asset.id;
  var collapsed = _getCollapsedIfaces(assetId);
  collapsed.forEach(function (parentName) {
    var btn = container.querySelector('.iface-expand-toggle[data-parent="' + (window.CSS && CSS.escape ? CSS.escape(parentName) : parentName) + '"]');
    if (btn) {
      btn.textContent = "▶";
      btn.title = "Expand children";
    }
    container.querySelectorAll(".iface-child").forEach(function (row) {
      if (row.getAttribute("data-parent") === parentName) row.style.display = "none";
    });
  });

  // Show-inactive toggle. Ephemeral per modal open — operators flip this
  // during an investigation and the table re-builds on every refresh tick
  // anyway, so persistence would mostly create friction. When ON, inactive
  // rows reveal except for ones whose parent is currently collapsed (the
  // collapse-state always wins because the operator just hid that group).
  var showInactive = false;
  function syncInactiveRows() {
    container.querySelectorAll(".iface-inactive").forEach(function (row) {
      if (showInactive) {
        var parent = row.getAttribute("data-parent");
        row.style.display = (parent && collapsed.has(parent)) ? "none" : "";
      } else {
        row.style.display = "none";
      }
    });
  }
  var inactiveBtn = container.querySelector("#iface-inactive-toggle");
  if (inactiveBtn) {
    inactiveBtn.addEventListener("click", function () {
      showInactive = !showInactive;
      inactiveBtn.textContent = showInactive
        ? "▼ Hide " + inactiveCount + " inactive interface" + (inactiveCount === 1 ? "" : "s")
        : "▶ Show " + inactiveCount + " inactive interface" + (inactiveCount === 1 ? "" : "s") + " (no traffic)";
      syncInactiveRows();
    });
  }

  // Expand / collapse aggregate and physical-with-children rows. When
  // expanding, inactive children stay hidden unless show-inactive is on —
  // otherwise the operator's "show only active" preference would silently
  // break every time they click a parent's toggle.
  container.querySelectorAll(".iface-expand-toggle").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var parentName = btn.getAttribute("data-parent");
      var expanded = btn.textContent.trim() === "▼";
      btn.textContent = expanded ? "▶" : "▼";
      btn.title = expanded ? "Expand children" : "Collapse children";
      container.querySelectorAll(".iface-child").forEach(function (row) {
        if (row.getAttribute("data-parent") !== parentName) return;
        if (expanded) {
          row.style.display = "none";
        } else {
          var rowInactive = row.classList.contains("iface-inactive");
          row.style.display = (rowInactive && !showInactive) ? "none" : "";
        }
      });
      if (expanded) collapsed.add(parentName); else collapsed.delete(parentName);
      _setCollapsedIfaces(assetId, collapsed);
    });
  });

  // Poll 1m checkbox — writes monitoredInterfaces; works for top-level and child rows alike
  if (canEdit && asset) {
    container.querySelectorAll(".asset-iface-toggle").forEach(function (cb) {
      cb.addEventListener("change", async function () {
        var name = cb.getAttribute("data-ifname");
        var current = new Set(monitored);
        if (cb.checked) current.add(name); else current.delete(name);
        cb.disabled = true;
        try {
          await api.assets.update(asset.id, { monitoredInterfaces: Array.from(current) });
          monitored = current;
          if (si) si.monitoredInterfaces = Array.from(current);
          if (asset) asset.monitoredInterfaces = Array.from(current);
          showToast(cb.checked ? ("Polling " + name + " every minute") : ("Stopped fast-polling " + name));
        } catch (err) {
          cb.checked = !cb.checked;
          showToast(err.message || "Failed to update", "error");
        } finally {
          cb.disabled = false;
        }
      });
    });
  }

  // Interface name click — opens per-interface history panel. Pass the
  // already-loaded row through so the slide-over can surface current-state
  // fields (VLAN config in particular) that the interface-history endpoint
  // doesn't carry.
  container.querySelectorAll(".asset-iface-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      var ifn = link.getAttribute("data-ifname");
      var row = rows.find(function (r) { return r.ifName === ifn; }) || null;
      openInterfaceDetailPanel(asset, ifn, row);
    });
  });

  // Poll 1m checkbox for nested tunnel rows — writes monitoredIpsecTunnels
  if (canEdit && asset) {
    container.querySelectorAll(".asset-ipsec-toggle").forEach(function (cb) {
      cb.addEventListener("change", async function () {
        var name = cb.getAttribute("data-name");
        var current = new Set(monitoredTunnels);
        if (cb.checked) current.add(name); else current.delete(name);
        cb.disabled = true;
        try {
          await api.assets.update(asset.id, { monitoredIpsecTunnels: Array.from(current) });
          monitoredTunnels = current;
          if (si)    si.monitoredIpsecTunnels    = Array.from(current);
          if (asset) asset.monitoredIpsecTunnels = Array.from(current);
          showToast(cb.checked ? ("Polling " + name + " every minute") : ("Stopped fast-polling " + name));
        } catch (err) {
          cb.checked = !cb.checked;
          showToast(err.message || "Failed to update", "error");
        } finally {
          cb.disabled = false;
        }
      });
    });
  }

  // Tunnel name click — opens per-tunnel history panel
  container.querySelectorAll(".asset-ipsec-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      openIpsecTunnelDetailPanel(asset, link.getAttribute("data-name"));
    });
  });

  // Neighbor link click — open the matched asset's view modal so the operator
  // can pivot from one device to its LLDP peer in one click.
  container.querySelectorAll(".asset-lldp-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      var id = link.getAttribute("data-asset-id");
      if (id) openViewModal(id);
    });
  });
}

// Render the inline "Neighbor" cell for the System tab interface table. Shows
// the first neighbor's system name (falling back to chassisId / managementIp
// when LLDP didn't supply one), plus a "+N" badge when multiple neighbors
// share the local port. Returns "—" when no neighbor is on this interface.
// Peer-inferred entries (source = "peer-inferred", derived from
// Asset.fortinetTopology rather than a direct LLDP scrape) render in italic
// with a tooltip explaining the inference.
function _lldpNeighborInlineCell(neighbors) {
  if (!neighbors || neighbors.length === 0) return "—";
  var first = neighbors[0];
  var inferred = first.source === "peer-inferred";
  var inferredTitle = inferred ? "Inferred from peer's reported uplink (no direct LLDP from this device)" : "";
  var label = (first.systemName && String(first.systemName).trim())
    || first.chassisId
    || first.managementIp
    || "neighbor";
  var port = first.portId || first.portDescription || "";
  var openTag = inferred
    ? '<em style="font-style:italic" title="' + escapeHtml(inferredTitle) + '">'
    : "";
  var closeTag = inferred ? "</em>" : "";
  var labelHtml = first.matchedAsset && first.matchedAsset.id
    ? '<a href="#" class="asset-lldp-link" data-asset-id="' + escapeHtml(first.matchedAsset.id) +
      '" style="color:var(--color-accent);text-decoration:none">' + escapeHtml(label) + '</a>'
    : escapeHtml(label);
  var portStr = port ? ' <span style="opacity:0.7" class="mono">/ ' + escapeHtml(port) + '</span>' : "";
  var more = neighbors.length > 1
    ? ' <span style="font-size:0.7rem;padding:1px 5px;border-radius:3px;background:#6b728018;color:#9ca3af;border:1px solid #6b728030">+' + (neighbors.length - 1) + '</span>'
    : "";
  return openTag + labelHtml + portStr + more + closeTag;
}

function _renderStorageTable(container, si, asset) {
  if (!container) return;
  var rows = (si && si.storage) || [];
  if (rows.length === 0) {
    container.innerHTML = '<p class="empty-state">No storage data yet — only available for SNMP-monitored assets exposing HOST-RESOURCES-MIB.</p>';
    return;
  }
  var monitored = new Set(((si && si.monitoredStorage) || (asset && asset.monitoredStorage) || []));
  var canEdit = canManageAssets();
  var body = rows.map(function (s) {
    var pct = (s.totalBytes && s.usedBytes != null && s.totalBytes > 0) ? ((s.usedBytes / s.totalBytes) * 100) : null;
    var pctStr = pct != null ? pct.toFixed(1) + '%' : '—';
    var checked = monitored.has(s.mountPath) ? ' checked' : '';
    var disabled = canEdit ? '' : ' disabled';
    var checkbox =
      '<input type="checkbox" class="asset-storage-toggle" data-mount="' + escapeHtml(s.mountPath) + '"' + checked + disabled +
      ' title="Poll this mountpoint every minute (response-time cadence)">';
    var nameCell = '<a href="#" class="asset-storage-link" data-mount="' + escapeHtml(s.mountPath) + '" style="color:var(--color-accent);text-decoration:none">' + escapeHtml(s.mountPath) + '</a>';
    return '<tr>' +
      '<td style="text-align:center;width:1%">' + checkbox + '</td>' +
      '<td class="mono">' + nameCell + '</td>' +
      '<td>' + (s.usedBytes  != null ? _fmtBytes(s.usedBytes)  : '—') + '</td>' +
      '<td>' + (s.totalBytes != null ? _fmtBytes(s.totalBytes) : '—') + '</td>' +
      '<td>' + pctStr + '</td>' +
    '</tr>';
  }).join("");
  container.innerHTML =
    '<p class="hint" style="margin:0 0 0.4rem 0;font-size:0.76rem">The <strong>Poll&nbsp;1m</strong> column selects volumes for fast-cadence polling and <strong>full-history retention</strong>. Unselected volumes are kept for 24&nbsp;h only.</p>' +
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th title="Pin this mountpoint for fast-cadence polling + full-history retention (unselected volumes are kept 24h)" style="width:32px" data-col-id="poll" data-col-required="true"></th>' +
      '<th data-col-id="mount" data-col-required="true">Mount</th>' +
      '<th data-col-id="used">Used</th>' +
      '<th data-col-id="total">Total</th>' +
      '<th data-col-id="usedPct">Used %</th>' +
    '</tr></thead><tbody>' + body + '</tbody></table></div>';
  if (typeof applyTableLayout === "function") {
    applyTableLayout(container.querySelector("table"), _assetTableTypeKey("asset-storage", asset), {
      onScreenshot: function (t) { _screenshotTableEl(t, "Storage"); },
    });
  }

  if (canEdit && asset) {
    container.querySelectorAll(".asset-storage-toggle").forEach(function (cb) {
      cb.addEventListener("change", async function () {
        var mount = cb.getAttribute("data-mount");
        var current = new Set(monitored);
        if (cb.checked) current.add(mount); else current.delete(mount);
        cb.disabled = true;
        try {
          await api.assets.update(asset.id, { monitoredStorage: Array.from(current) });
          monitored = current;
          if (si) si.monitoredStorage = Array.from(current);
          if (asset) asset.monitoredStorage = Array.from(current);
          showToast(cb.checked ? ("Polling " + mount + " every minute") : ("Stopped fast-polling " + mount));
        } catch (err) {
          cb.checked = !cb.checked;
          showToast(err.message || "Failed to update", "error");
        } finally {
          cb.disabled = false;
        }
      });
    });
  }
  container.querySelectorAll(".asset-storage-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      openStorageDetailPanel(asset, link.getAttribute("data-mount"), rows);
    });
  });
}

// Latest-snapshot hardware-sensor table (temperature / fan / voltage / power /
// disk) with per-row alarm status. Each sensor name is a clickable link that
// opens the per-sensor history slide-over (see openSensorDetailPanel). The
// device's whole fgHwSensorTable / sensor-info table lands here, not just
// temperatures.
function _hwClassLabel(cls) {
  switch (cls) {
    case "temperature": return "Temp";
    case "fan":         return "Fan";
    case "voltage":     return "Voltage";
    case "power":       return "Power";
    case "disk":        return "Disk";
    default:            return "Other";
  }
}
function _hwReadingText(s) {
  if (typeof s.value !== "number" || !isFinite(s.value)) return "—";
  // Trim trailing zeros for a clean decimal; append the unit when present.
  var v = Math.round(s.value * 1000) / 1000;
  return s.unit ? (v + " " + s.unit) : String(v);
}
function _hwStatusCell(s) {
  if (s.alarmStatus === "alarm") {
    return '<span style="color:var(--color-danger,#e5484d);font-weight:600">⚠ alarm</span>';
  }
  if (s.alarmStatus === "ok") {
    return '<span style="color:var(--color-success,#46a758)">ok</span>';
  }
  return '<span style="color:var(--color-text-tertiary)">—</span>';
}
function _renderTemperatures(container, si, asset) {
  if (!container) return;
  _updateTemperatureUpdatedStamp(asset, si);
  var latestRaw = (si && si.hardwareSensors) || [];
  // Auto-hide sensors with no usable reading (null/NaN value — e.g. an
  // unpopulated SFP cage or a sensor the agent couldn't read). Unlike the old
  // temperature-only table we KEEP exact-zero readings: a 0 V rail or a PSU
  // presence of 0 is meaningful. Hidden sensors stay reachable via the toggle.
  var hasReading = function (s) {
    return typeof s.value === "number" && isFinite(s.value);
  };
  var latest = latestRaw.filter(hasReading);
  var hidden = latestRaw.filter(function (s) { return !hasReading(s); });
  if (latest.length === 0) {
    if (_isRestApiManagedNetworkDevice(asset, "temperature")) {
      var tempPolling = _assetMonitorStreamSource(asset, "temperature").polling || "REST API";
      container.innerHTML = _notAvailableViaPollingHTML("Hardware Sensors", tempPolling);
    } else {
      // Check the hardware-sensor stream specifically — the dispatcher uses
      // temperaturePolling, not cpuMemoryPolling, so a firewall whose
      // CPU/memory is on REST but whose hardware sensors have already been
      // flipped to SNMP shouldn't show the "switch to SNMP" nag.
      var isFortinetRestFirewall = asset && asset.assetType === "firewall" &&
        _resolvedStreamPolling(asset, "temperature") === "rest_api";
      if (isFortinetRestFirewall) {
        var fgTempPolling = _assetMonitorStreamSource(asset, "temperature").polling || "REST API";
        var fgTempDesc = "Lower-end FortiGate models (60F/61F/91G class) do not support the sensor-info endpoint via REST API. " +
          "Upgrade FortiOS or switch the <strong>Hardware Sensors</strong> polling method to <strong>SNMP</strong> on the integration's Monitoring tab to enable collection on affected models.";
        container.innerHTML = _notAvailableViaPollingHTML("Hardware Sensors", fgTempPolling, fgTempDesc);
      } else {
        container.innerHTML = '<p class="empty-state">No hardware sensors reported by this device.</p>';
      }
    }
    return;
  }
  var rowFor = function (s) {
    var name = '<a href="#" class="asset-temp-link" data-name="' + escapeHtml(s.sensorName) + '" style="color:var(--color-accent);text-decoration:none">' + escapeHtml(s.sensorName) + '</a>';
    return '<tr>' +
      '<td>' + name + '</td>' +
      '<td>' + escapeHtml(_hwClassLabel(s.sensorClass)) + '</td>' +
      '<td class="mono">' + escapeHtml(_hwReadingText(s)) + '</td>' +
      '<td>' + _hwStatusCell(s) + '</td>' +
    '</tr>';
  };
  var rows = latest.map(rowFor).join("");
  var hiddenRows = hidden.map(rowFor).join("");
  // Stale-state surfaces in the section header's updated stamp instead of a
  // separate banner — one stamp using the table-specific timestamp is
  // unambiguous when CPU/mem succeeds but the sensor pull fails.
  _updateTemperatureUpdatedStamp(asset, si);
  var headCells =
    '<th data-col-id="sensor" data-col-required="true">Sensor</th>' +
    '<th data-col-id="class">Class</th>' +
    '<th data-col-id="reading">Reading</th>' +
    '<th data-col-id="status">Status</th>';
  var toggleHTML = "";
  if (hidden.length > 0) {
    toggleHTML =
      '<details class="asset-temp-hidden" style="margin-top:0.5rem;font-size:0.82rem">' +
        '<summary style="cursor:pointer;color:var(--color-text-tertiary);user-select:none">' +
          'Show ' + hidden.length + ' sensor' + (hidden.length === 1 ? '' : 's') + ' with no reading' +
        '</summary>' +
        '<div class="table-wrapper" style="margin-top:0.4rem">' +
          '<table class="data-table" style="font-size:0.82rem"><thead><tr>' + headCells +
          '</tr></thead><tbody>' + hiddenRows + '</tbody></table>' +
        '</div>' +
      '</details>';
  }
  container.innerHTML =
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' + headCells +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
    toggleHTML;
  if (typeof applyTableLayout === "function") {
    container.querySelectorAll("table").forEach(function (t) {
      applyTableLayout(t, _assetTableTypeKey("asset-hardware-sensors", asset), {
        onScreenshot: function (tbl) { _screenshotTableEl(tbl, "Hardware Sensors"); },
      });
    });
  }

  container.querySelectorAll(".asset-temp-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      openSensorDetailPanel(asset, link.getAttribute("data-name"));
    });
  });
}

// Standalone LLDP Neighbors roll-up card on the System tab — sits below
// Storage. Same data the per-interface inline column already shows on
// the Interfaces table, but in one consolidated view so operators can
// scan every neighbor without scrolling the interface table. Each row
// shows the local port, the neighbor's chassis/system identity, and a
// click-through to the matched Polaris asset (if the LLDP collector
// resolved one) or a plain label for non-Polaris ghost neighbors.
function _renderLldpNeighborsCard(container, si, asset) {
  if (!container) return;
  var neighbors = (si && si.lldpNeighbors) || [];
  if (neighbors.length === 0) {
    if (_isRestApiManagedNetworkDevice(asset, "lldp")) {
      var lldpPolling = _assetMonitorStreamSource(asset, "lldp").polling || "REST API";
      container.innerHTML = _notAvailableViaPollingHTML("LLDP Neighbors", lldpPolling);
    } else {
      container.innerHTML = "<p class=\"empty-state\">" +
        "No LLDP neighbors collected. Either the device isn’t advertising LLDP, " +
        "the monitoring transport doesn’t support it, or the FortiOS REST endpoint " +
        "returned 404 — try flipping the integration’s LLDP transport to SNMP." +
      "</p>";
    }
    return;
  }
  // Stable presentation: sort by local port, then chassis id.
  neighbors.sort(function (a, b) {
    var la = String(a.localIfName || ""), lb = String(b.localIfName || "");
    if (la !== lb) return la.localeCompare(lb);
    return String(a.chassisId || "").localeCompare(String(b.chassisId || ""));
  });
  var rows = neighbors.map(function (n) {
    var inferred = n.source === "peer-inferred";
    var inferredTitle = inferred ? "Inferred from peer's reported uplink (no direct LLDP from this device)" : "";
    var rowStyle = inferred ? ' style="font-style:italic"' : "";
    var rowTitle = inferred ? ' title="' + escapeHtml(inferredTitle) + '"' : "";
    var primary = n.systemName || n.managementIp || n.chassisId || "(unknown)";
    var primaryHtml = (n.matchedAsset && n.matchedAsset.id)
      ? '<a href="#" class="asset-lldp-link" data-asset-id="' + escapeHtml(n.matchedAsset.id) +
        '" style="color:var(--color-accent);text-decoration:none">' + escapeHtml(primary) + '</a>'
      : escapeHtml(primary);
    var idBits = [];
    if (n.chassisId)    idBits.push("chassis " + n.chassisId);
    if (n.portId)       idBits.push("port "    + n.portId);
    if (n.managementIp) idBits.push("mgmt "    + n.managementIp);
    var caps = (Array.isArray(n.capabilities) && n.capabilities.length > 0)
      ? n.capabilities.join(", ")
      : "—";
    return '<tr' + rowStyle + rowTitle + '>' +
      '<td class="mono">' + escapeHtml(n.localIfName || "—") + '</td>' +
      '<td>' + primaryHtml +
        (idBits.length ? '<div class="mono" style="font-size:0.72rem;color:var(--color-text-tertiary);margin-top:2px">' + escapeHtml(idBits.join(" · ")) + '</div>' : '') +
      '</td>' +
      '<td style="font-size:0.78rem;color:var(--color-text-secondary)">' + escapeHtml(caps) + '</td>' +
    '</tr>';
  }).join("");
  var lldpStaleBanner = _staleBannerHTML(asset && asset.id, asset, "systemInfo", si && si.lastSystemInfoAt);
  container.innerHTML = lldpStaleBanner +
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th data-col-id="localPort" data-col-required="true">Local Port</th>' +
      '<th data-col-id="neighbor" data-col-required="true">Neighbor</th>' +
      '<th data-col-id="capabilities">Capabilities</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  if (typeof applyTableLayout === "function") {
    applyTableLayout(container.querySelector("table"), _assetTableTypeKey("asset-lldp", asset), {
      onScreenshot: function (t) { _screenshotTableEl(t, "LLDP Neighbors"); },
    });
  }

  // Click-through on matched-asset links opens the matched asset's
  // details slide-in directly — same in-place pattern the inline
  // interface-table Neighbor cell uses, no full-page nav.
  container.querySelectorAll(".asset-lldp-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      var assetId = link.getAttribute("data-asset-id");
      if (assetId) openViewModal(assetId);
    });
  });
}

// Stations tab content for FortiAPs. Empty placeholder filled by
// _loadSystemTabFor() on modal open (which fetches /system-info once and
// hydrates every tab's mount, so opening Stations after System never
// re-fetches). Includes a stub message that flips to the populated
// table once the data lands.
function _assetStationsTabHTML(a) {
  if (!a.monitored) {
    return '<p class="empty-state" style="padding:1rem 0">Monitoring is disabled for this AP — enable it to start collecting wireless station data via the FORTINET-FORTIAP-MIB fapStationTable SNMP walk.</p>';
  }
  return '<div data-shot-section="stations" data-shot-label="Wireless Stations"><div id="asset-system-stations">' +
    '<span class="empty-state">Loading wireless stations…</span>' +
    '</div></div>';
}

// Short band label for the Stations table. The backend derives band from the
// FortiAP's fapRadioTable ("2.4GHz" | "5GHz" | "6GHz"); render it compactly.
function _wirelessBandLabel(band) {
  if (band === "2.4GHz") return "2G";
  if (band === "5GHz")   return "5G";
  if (band === "6GHz")   return "6G";
  return "—";
}

// Render the wireless-station table from the system-info response.
// Same shape as _renderLldpNeighborsCard — current-state list, no time
// series. Stations matched to a Polaris asset surface the asset name
// as a clickable link that opens the matched asset's details modal;
// unmatched stations just show the MAC.
function _renderWirelessStationsCard(container, si, asset) {
  if (!container) return;
  var stations = (si && si.wirelessStations) || [];
  if (stations.length === 0) {
    var pollingLabel = _assetMonitorStreamSource(asset, "interfaces").polling || "the configured transport";
    container.innerHTML = '<p class="empty-state" style="padding:1rem 0">' +
      'No wireless stations reported. Either no clients are currently connected, ' +
      'or the SNMP fapStationTable walk hasn’t run yet — confirm interfacesPolling is set to SNMP ' +
      '(currently: ' + escapeHtml(pollingLabel) + ') on this AP.' +
      '</p>';
    return;
  }
  // Stable sort: SSID → MAC. Same order the backend returns, but
  // re-establishing here lets the function stand on its own.
  stations.sort(function (a, b) {
    var sa = String(a.ssid || ""), sb = String(b.ssid || "");
    if (sa !== sb) return sa.localeCompare(sb);
    return String(a.staMacAddr).localeCompare(String(b.staMacAddr));
  });
  var rows = stations.map(function (s) {
    var endpointHtml;
    if (s.matchedAsset && s.matchedAsset.id) {
      endpointHtml = '<a href="#" class="asset-station-link" data-asset-id="' + escapeHtml(s.matchedAsset.id) +
        '" style="color:var(--color-accent);text-decoration:none">' +
        escapeHtml(s.matchedAsset.hostname || s.matchedAsset.ipAddress || s.matchedAsset.id) +
        '</a>';
    } else {
      endpointHtml = '<span style="color:var(--color-text-tertiary)">(not in inventory)</span>';
    }
    var bandLabel   = _wirelessBandLabel(s.band);
    var signalLabel = (s.signalStrength != null) ? (s.signalStrength + " dBm") : "—";
    return '<tr>' +
      '<td>' + escapeHtml(s.ssid || "—") + '</td>' +
      '<td class="mono">' + escapeHtml(s.staMacAddr) + '</td>' +
      '<td class="mono">' + escapeHtml(s.staIpAddr || "—") + '</td>' +
      '<td>' + endpointHtml + '</td>' +
      '<td>' + escapeHtml(bandLabel) + '</td>' +
      '<td style="text-align:right">' + escapeHtml(signalLabel) + '</td>' +
    '</tr>';
  }).join("");
  var staleBanner = _staleBannerHTML(asset && asset.id, asset, "systemInfo", si && si.lastSystemInfoAt);
  container.innerHTML = staleBanner +
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th data-col-id="ssid">SSID</th>' +
      '<th data-col-id="mac" data-col-required="true">MAC</th>' +
      '<th data-col-id="ip">IP</th>' +
      '<th data-col-id="endpoint" data-col-required="true">Endpoint</th>' +
      '<th data-col-id="band">Band</th>' +
      '<th style="text-align:right" data-col-id="signal">Signal</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  if (typeof applyTableLayout === "function") {
    applyTableLayout(container.querySelector("table"), _assetTableTypeKey("asset-wireless-stations", asset), {
      onScreenshot: function (t) { _screenshotTableEl(t, "Wireless Stations"); },
    });
  }

  // Click-through on matched-endpoint links — opens the endpoint asset's
  // own details modal directly. Same pattern as the LLDP neighbor links.
  container.querySelectorAll(".asset-station-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      var assetId = link.getAttribute("data-asset-id");
      if (assetId) openViewModal(assetId);
    });
  });
}

// ─── Custom MIB tab (Slice 7) ────────────────────────────────────────────
// One tab per asset whose manufacturer has at least one
// ManufacturerCustomWidget defined under its ManufacturerProfile. Widgets
// are rendered per `widgetType`:
//   * gauge — compact radial-arc with min/max + threshold ranges
//   * line  — small SVG line chart over the last 60 sample window
//   * table — flat table of the latest row array
// The Polaris collector probes each widget on the customWidget cadence
// (default 60s); the renderer doesn't poll — it shows the freshest sample
// the server has. Operator clicks Poll Now on the System tab to force-fetch.

function _customMibTabHTML(payload) {
  var hint = 'Widgets from <b>' + escapeHtml(payload.manufacturer || "this manufacturer") + '</b> ' +
    '— defined at Server Settings → Identification → Manufacturer Profiles.';
  if (payload.polling === "disabled") {
    hint += ' <span style="color:var(--color-warning)">Polling is disabled for this asset; data may be stale.</span>';
  } else if (!payload.lastCustomWidgetAt) {
    hint += ' <span style="color:var(--color-text-tertiary)">No sample collected yet — waiting for the next probe cycle.</span>';
  }
  var html = '<div style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' + hint + '</div>';
  html += '<div class="custom-mib-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">';
  payload.widgets.forEach(function (w) {
    html += '<div class="custom-mib-card" data-shot-section="mib:' + escapeHtml(w.symbol) + '" data-shot-label="' + escapeHtml(w.name) + '" style="border:1px solid var(--color-border);border-radius:6px;padding:10px;background:var(--color-bg-secondary,rgba(0,0,0,0.03))">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
        '<span style="font-weight:600">' + escapeHtml(w.name) + '</span>' +
        '<span style="font-size:0.72rem;color:var(--color-text-tertiary);font-family:var(--font-mono)">' + escapeHtml(w.symbol) + '</span>' +
      '</div>' +
      _renderCustomWidgetBody(w) +
    '</div>';
  });
  html += '</div>';
  return html;
}

function _renderCustomWidgetBody(w) {
  if (!w.latest) {
    return '<p class="empty-state" style="padding:0.5rem 0;margin:0">No sample yet.</p>';
  }
  if (w.widgetType === "gauge") return _renderCustomWidgetGauge(w);
  if (w.widgetType === "line")  return _renderCustomWidgetLine(w);
  if (w.widgetType === "table") return _renderCustomWidgetTable(w);
  return '<p class="empty-state" style="padding:0.5rem 0;margin:0">Unknown widgetType: ' + escapeHtml(w.widgetType) + '</p>';
}

function _renderCustomWidgetGauge(w) {
  // Compact radial-arc — 180° sweep from min to max with one threshold
  // band drawn at displayOptions.warningAt if set, and the current value
  // labeled. Falls through to a numeric readout when the sample isn't a
  // scalar (e.g. an operator picked widgetType=gauge on a table-typed
  // widget; the editor doesn't yet narrow widgetType by kind).
  var raw = (w.latest && w.latest.value);
  var n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    return '<div style="font-size:0.85rem">' + escapeHtml(String(raw)) + '</div>';
  }
  var opts = w.displayOptions || {};
  var min = Number.isFinite(opts.min) ? opts.min : 0;
  var max = Number.isFinite(opts.max) ? opts.max : 100;
  var pct = max > min ? Math.max(0, Math.min(1, (n - min) / (max - min))) : 0;
  var theta = Math.PI * (1 - pct);  // 180° -> 0°
  var cx = 80, cy = 70, r = 56;
  var startX = cx - r, startY = cy;
  var endX = cx + r * Math.cos(theta);
  var endY = cy - r * Math.sin(theta);
  var largeArc = pct > 0.5 ? 1 : 0;
  var unit = opts.unit ? (" " + opts.unit) : "";
  return '<div style="text-align:center">' +
    '<svg width="160" height="86" viewBox="0 0 160 86" aria-hidden="true">' +
      '<path d="M ' + (cx - r) + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + (cx + r) + ' ' + cy + '" stroke="var(--color-border)" stroke-width="10" fill="none" stroke-linecap="round"/>' +
      '<path d="M ' + startX + ' ' + startY + ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' 1 ' + endX + ' ' + endY + '" stroke="#22d3ee" stroke-width="10" fill="none" stroke-linecap="round"/>' +
      '<text x="' + cx + '" y="' + (cy - 6) + '" text-anchor="middle" font-size="20" font-weight="600" fill="currentColor">' +
        escapeHtml(_formatNumber(n)) + escapeHtml(unit) +
      '</text>' +
      '<text x="' + cx + '" y="' + (cy + 12) + '" text-anchor="middle" font-size="10" fill="var(--color-text-tertiary)">' +
        escapeHtml(_formatNumber(min)) + ' &ndash; ' + escapeHtml(_formatNumber(max)) +
      '</text>' +
    '</svg>' +
  '</div>';
}

function _renderCustomWidgetLine(w) {
  // Minimal inline SVG line chart over the sample window the server
  // returned. We don't reuse the larger System-tab chart helper (which
  // hardcodes axes specific to telemetry / RTT) — custom widgets need to
  // adapt their y-range to the actual data domain.
  var pts = [];
  (w.samples || []).forEach(function (s) {
    var n = typeof s.value === "number" ? s.value : Number(s.value);
    if (Number.isFinite(n)) pts.push({ t: new Date(s.timestamp).getTime(), v: n });
  });
  if (pts.length < 2) {
    return _renderCustomWidgetScalarFallback(w);
  }
  var minV = pts[0].v, maxV = pts[0].v;
  pts.forEach(function (p) { if (p.v < minV) minV = p.v; if (p.v > maxV) maxV = p.v; });
  if (maxV === minV) { maxV = minV + 1; }
  var minT = pts[0].t, maxT = pts[pts.length - 1].t;
  var W = 280, H = 90, P = 4;
  var coords = pts.map(function (p) {
    var x = P + (W - 2 * P) * ((p.t - minT) / Math.max(1, maxT - minT));
    var y = (H - P) - (H - 2 * P) * ((p.v - minV) / (maxV - minV));
    return x.toFixed(1) + "," + y.toFixed(1);
  });
  var unit = (w.displayOptions && w.displayOptions.unit) ? (" " + w.displayOptions.unit) : "";
  return '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
    '<polyline fill="none" stroke="#22d3ee" stroke-width="1.4" points="' + coords.join(" ") + '"/>' +
  '</svg>' +
  '<div style="display:flex;justify-content:space-between;font-size:0.7rem;color:var(--color-text-tertiary);margin-top:2px">' +
    '<span>min ' + escapeHtml(_formatNumber(minV)) + escapeHtml(unit) + '</span>' +
    '<span>latest ' + escapeHtml(_formatNumber(pts[pts.length - 1].v)) + escapeHtml(unit) + '</span>' +
    '<span>max ' + escapeHtml(_formatNumber(maxV)) + escapeHtml(unit) + '</span>' +
  '</div>';
}

function _renderCustomWidgetTable(w) {
  // The collector serializes table-typed widgets as an array of row objects;
  // each row's keys are the column names the operator picked. Empty array
  // = no data this cycle.
  var rows = Array.isArray(w.latest && w.latest.value) ? w.latest.value : [];
  if (rows.length === 0) return '<p class="empty-state" style="padding:0.5rem 0;margin:0">No rows.</p>';
  var cols = Object.keys(rows[0] || {});
  if (cols.length === 0) return '<p class="empty-state" style="padding:0.5rem 0;margin:0">No columns.</p>';
  var html = '<div style="overflow:auto"><table class="ip-table" style="font-size:0.78rem"><thead><tr>';
  cols.forEach(function (c) { html += '<th>' + escapeHtml(c) + '</th>'; });
  html += '</tr></thead><tbody>';
  rows.forEach(function (r) {
    html += '<tr>';
    cols.forEach(function (c) {
      var v = r[c];
      var txt = (v === null || v === undefined) ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v));
      html += '<td>' + escapeHtml(txt) + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
}

function _renderCustomWidgetScalarFallback(w) {
  var v = w.latest && w.latest.value;
  var txt = (v === null || v === undefined) ? "—" :
            (typeof v === "object" ? JSON.stringify(v) : String(v));
  var unit = (w.displayOptions && w.displayOptions.unit) ? (" " + w.displayOptions.unit) : "";
  return '<div style="font-size:1.4rem;font-weight:600">' + escapeHtml(txt) + escapeHtml(unit) + '</div>';
}

function _formatNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 1)    return n.toFixed(1);
  return n.toFixed(2);
}

// Bound a chart's X axis to the *requested* time window (since/until from the
// *History API) rather than the data's first/last timestamp. Without this,
// switching range from 24h to 7d on a host with only 24h of data leaves the
// X axis at 24h — the user can't see "no past data" because the data is
// re-stretched to fill the chart. Falls back to sample-derived bounds when no
// window is supplied.
function _chartTimeBounds(samples, since, until) {
  function ms(v) {
    if (v == null) return null;
    return typeof v === "number" ? v : new Date(v).getTime();
  }
  var t0 = ms(since);
  var t1 = ms(until);
  if (t0 == null && samples && samples.length) t0 = new Date(samples[0].timestamp).getTime();
  if (t1 == null && samples && samples.length) t1 = new Date(samples[samples.length - 1].timestamp).getTime();
  if (t0 == null) t0 = 0;
  if (t1 == null || t1 <= t0) t1 = t0 + 1;
  return { t0: t0, t1: t1 };
}

// Vertical dashed indicator at each local-midnight inside (t0, t1). The
// time-only tick labels on ≤24h ranges hide the day boundary, so without
// this the reader can't tell where the calendar date changes. Beyond 4d
// the tick labels themselves already encode the date, so the per-line
// "M/D" label is suppressed but the dashed line stays as a day separator.
function _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) {
  var first = new Date(t0);
  first.setHours(0, 0, 0, 0);
  if (first.getTime() <= t0) first.setDate(first.getDate() + 1);
  var withLabel = (t1 - t0) <= 4 * 86400000;
  var out = "";
  var d = first;
  var safety = 0;
  while (d.getTime() < t1 && safety++ < 64) {
    var x = padL + ((d.getTime() - t0) / (t1 - t0)) * innerW;
    out +=
      '<line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + (padT + innerH) +
      '" stroke="rgba(127,127,127,0.55)" stroke-width="1" stroke-dasharray="3,3"/>';
    if (withLabel) {
      var label = (d.getMonth() + 1) + "/" + d.getDate();
      out +=
        '<text x="' + (x + 4) + '" y="' + (padT + 11) +
        '" font-size="10" fill="currentColor" opacity="0.7">' + label + '</text>';
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// ─── Per-sensor temperature slide-over ─────────────────────────────────────
//
// Sits on top of the asset details panel like the interface and IPsec slide-
// overs. One sensor per modal — the old shared chart was unreadable when a
// device exposed dozens of sensors.

function _ensureSensorPanelDOM() {
  if (document.getElementById("sensor-panel-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "sensor-panel-overlay";
  overlay.className = "slideover-overlay slideover-nested";
  overlay.style.zIndex = "1099";
  overlay.innerHTML =
    '<div class="slideover" id="sensor-panel" style="z-index:1100">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="sensor-panel-title">Sensor</h3>' +
          '<button class="btn-icon" id="sensor-panel-close" title="Close">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta" id="sensor-panel-meta"></div>' +
      '</div>' +
      '<div class="slideover-body" id="sensor-panel-body"><p class="empty-state" style="padding:1rem 1.25rem">Loading…</p></div>' +
      '<div class="slideover-footer" id="sensor-panel-footer"></div>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeSensorPanel();
  });
  document.getElementById("sensor-panel-close").addEventListener("click", closeSensorPanel);
  initSlideoverResize(document.getElementById("sensor-panel"), "polaris.panel.width.sensor");
}

function closeSensorPanel() {
  var ov = document.getElementById("sensor-panel-overlay");
  if (ov) ov.classList.remove("open");
  if (_sensorRefreshTimer) { clearTimeout(_sensorRefreshTimer); _sensorRefreshTimer = null; }
}

async function openSensorDetailPanel(asset, sensorName) {
  if (!asset || !sensorName) return;
  _ensureSensorPanelDOM();
  var titleEl  = document.getElementById("sensor-panel-title");
  var metaEl   = document.getElementById("sensor-panel-meta");
  var bodyEl   = document.getElementById("sensor-panel-body");
  var footerEl = document.getElementById("sensor-panel-footer");
  titleEl.textContent = "Sensor — " + sensorName;
  metaEl.textContent = asset.hostname || asset.ipAddress || asset.id;
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>';
  footerEl.innerHTML =
    '<button class="btn btn-sm btn-secondary" id="btn-sensor-panel-close-btn">Close</button>';
  requestAnimationFrame(function () {
    document.getElementById("sensor-panel-overlay").classList.add("open");
  });
  document.getElementById("btn-sensor-panel-close-btn").addEventListener("click", closeSensorPanel);

  var rangeBtns = _chartRangeBtnsHTML("sensor-range-btn", [
    { value: "1h",  label: "1h" },
    { value: "24h", label: "24h" },
    { value: "7d",  label: "7d" },
    { value: "30d", label: "30d" },
    { value: "custom", label: "Custom…", id: "btn-sensor-custom" },
  ], "assetSensor", "1h");
  var customPanel =
    '<div id="sensor-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
      '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="sensor-custom-from" class="form-input" style="padding:2px 6px"></label>' +
      '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="sensor-custom-to" class="form-input" style="padding:2px 6px"></label>' +
      '<button class="btn btn-sm btn-primary" id="btn-sensor-custom-apply">Apply</button>' +
    '</div>';

  // Hardware-sensor samples are written by the telemetry pass on the same
  // cadence as CPU/memory, so the section badge tracks the asset's resolved
  // telemetry polling method (matches the System tab Hardware Sensors section).
  var sensorBadge = _streamSourceBadgeHTML(asset, "telemetry");

  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
        '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
          '<h4 style="margin:0">' + escapeHtml(sensorName) + '</h4>' +
          sensorBadge +
        '</div>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
      customPanel +
      '<div id="sensor-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<div id="sensor-chart" class="sensor-chart-box"></div>' +
    '</div>';
  var box = document.getElementById("sensor-chart");
  if (box) {
    box.style.background = "var(--color-bg-elevated)";
    box.style.border = "1px solid var(--color-border)";
    box.style.borderRadius = "6px";
    box.style.padding = "0.5rem";
    box.style.minHeight = "240px";
    box.style.display = "flex";
    box.style.alignItems = "center";
    box.style.justifyContent = "center";
    box.style.color = "var(--color-text-secondary)";
    box.style.fontSize = "0.85rem";
  }

  await _loadSensorHistoryFor(asset.id, sensorName, _getChartRangePref("assetSensor", "1h"));
  // Async overwrite the badge with the authoritative resolved polling method —
  // sync render only sees per-asset overrides; this catches class / integration
  // / manual tier values too.
  _updateStreamSourceBadgesFromEffective(asset.id, asset);
  document.querySelectorAll(".sensor-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      var panel = document.getElementById("sensor-custom-panel");
      if (range === "custom") {
        if (!panel) return;
        var willOpen = panel.style.display === "none";
        panel.style.display = willOpen ? "flex" : "none";
        if (willOpen) {
          var toInput   = document.getElementById("sensor-custom-to");
          var fromInput = document.getElementById("sensor-custom-from");
          if (toInput && !toInput.value) toInput.value = _toLocalDatetimeInput(new Date());
          if (fromInput && !fromInput.value) fromInput.value = _toLocalDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000));
        }
        return;
      }
      if (panel) panel.style.display = "none";
      document.querySelectorAll(".sensor-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _setChartRangePref("assetSensor", range);
      _loadSensorHistoryFor(asset.id, sensorName, range);
    });
  });
  var sensorCustomApply = document.getElementById("btn-sensor-custom-apply");
  if (sensorCustomApply) {
    sensorCustomApply.addEventListener("click", function () {
      var fromInput = document.getElementById("sensor-custom-from");
      var toInput   = document.getElementById("sensor-custom-to");
      if (!fromInput.value || !toInput.value) { showToast("Enter both From and To", "error"); return; }
      var fromIso = new Date(fromInput.value).toISOString();
      var toIso   = new Date(toInput.value).toISOString();
      if (new Date(fromIso) >= new Date(toIso)) { showToast("From must be before To", "error"); return; }
      document.querySelectorAll(".sensor-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      var customBtn = document.getElementById("btn-sensor-custom");
      if (customBtn) { customBtn.classList.remove("btn-secondary"); customBtn.classList.add("btn-primary"); }
      _loadSensorHistoryFor(asset.id, sensorName, { from: fromIso, to: toIso });
    });
  }
}

async function _loadSensorHistoryFor(assetId, sensorName, range, callOpts) {
  // Cancel any pending auto-refresh — manual range change shouldn't race a tick.
  if (_sensorRefreshTimer) { clearTimeout(_sensorRefreshTimer); _sensorRefreshTimer = null; }
  var silent = !!(callOpts && callOpts.silent);
  var chartEl = document.getElementById("sensor-chart");
  var stats   = document.getElementById("sensor-stats");
  if (!chartEl) return;
  if (!silent) {
    chartEl.textContent = "Loading samples…";
    if (stats) stats.textContent = "Loading…";
  }
  var panelBody = silent ? document.getElementById("sensor-panel-body") : null;
  var savedScroll = panelBody ? panelBody.scrollTop : 0;
  // Accept range as a string or `{from, to}` object (canonical convention).
  var opts = (typeof range === "string" || !range) ? { range: range || "1h" } : range;
  opts.sensorName = sensorName;
  try {
    var data = await api.assets.hardwareHistory(assetId, opts);
    var samples = (data.samples || []).filter(function (s) { return typeof s.value === "number"; });
    var unit = (samples[0] && samples[0].unit) || (data.samples && data.samples[0] && data.samples[0].unit) || "";
    var unitSuffix = unit ? " " + unit : "";
    if (stats) {
      var st = data.stats || {};
      var sensorParts = [
        { label: "Avg", value: typeof st.avgValue === "number" ? _hwFmtNum(st.avgValue) + unitSuffix : "—" },
        { label: "Min", value: typeof st.minValue === "number" ? _hwFmtNum(st.minValue) + unitSuffix : "—" },
        { label: "Max", value: typeof st.maxValue === "number" ? _hwFmtNum(st.maxValue) + unitSuffix : "—" },
      ];
      var sensorTierPart = _tierStatsPart(data);
      if (sensorTierPart) sensorParts.unshift(sensorTierPart);
      _renderChartStats(stats, samples.length, sensorParts);
    }
    _renderSensorChart(chartEl, samples, {
      since:   data.since,
      until:   data.until,
      subject: sensorName,
      unit:    unit,
    });
    // Stash the active selection on the chart so silent ticks / probe-now
    // refetch the same view (canonical convention from TEMPLATES.md).
    if (opts.from && opts.to) {
      chartEl.dataset.from = opts.from;
      chartEl.dataset.to   = opts.to;
      delete chartEl.dataset.range;
    } else {
      chartEl.dataset.range = opts.range || "1h";
      delete chartEl.dataset.from;
      delete chartEl.dataset.to;
    }
  } catch (err) {
    if (!silent) {
      chartEl.textContent = "Error: " + (err.message || "failed to load");
      if (stats) stats.textContent = "";
    }
    // Silent ticks leave stale content on transient errors.
  }
  if (panelBody) {
    panelBody.scrollTop = savedScroll;
    requestAnimationFrame(function () {
      if (panelBody.scrollTop !== savedScroll) panelBody.scrollTop = savedScroll;
    });
  }
  // Custom date ranges are fixed historical windows — do not auto-refresh.
  if (opts.from && opts.to) return;
  // Schedule next auto-refresh on the resolved telemetry cadence —
  // hardware-sensor samples ride the telemetry pass, not the response-time probe.
  var settings = _monitorSettingsCache || {};
  var asset = _currentAssetForRefresh;
  var ms = _refreshIntervalMs(asset && asset.cpuMemoryIntervalSec, settings.cpuMemoryIntervalSeconds, 60);
  _scheduleSensorRefresh(assetId, sensorName, ms);
}

function _hwFmtNum(v) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  var a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10)  return v.toFixed(1);
  return v.toFixed(2);
}
function _renderSensorChart(container, samples, opts) {
  opts = opts || {};
  var unit = opts.unit || "";
  var unitTickSuffix = unit ? (unit === "°C" ? "°C" : " " + unit) : "";
  if (samples.length === 0) {
    container.textContent = "No samples in this range yet.";
    return;
  }
  var W = container.clientWidth || 600, H = 240;
  // Extra left/bottom/top padding for the rotated Y-axis label, X-axis label, and chart title.
  var padL = 64, padR = 14, padT = 28, padB = 52;
  var innerW = W - padL - padR, innerH = H - padT - padB;

  var bounds = _chartTimeBounds(samples, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function fmtTick(ts) {
    var d = new Date(ts);
    if (spanMs <= oneDayMs) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  var allC = samples.map(function (s) { return s.value; });
  var minC = Math.min.apply(null, allC);
  var maxC = Math.max.apply(null, allC);
  if (minC === maxC) {
    // Flat series — give it a visible band proportional to the value's scale
    // (works for °C, RPM, V alike, unlike a fixed ±5° pad).
    var pad = Math.max(Math.abs(minC) * 0.05, 1);
    minC -= pad; maxC += pad;
  } else {
    var span = maxC - minC;
    minC -= span * 0.1; maxC += span * 0.1;
  }

  function xFor(ts) { return padL + ((new Date(ts).getTime() - t0) / (t1 - t0)) * innerW; }
  function yFor(c)  { return padT + innerH - ((c - minC) / (maxC - minC)) * innerH; }

  var pts = samples.map(function (s) { return xFor(s.timestamp) + "," + yFor(s.value); }).join(" ");
  var hits = samples.map(function (s) {
    return '<circle class="chart-hit" cx="' + xFor(s.timestamp) + '" cy="' + yFor(s.value) + '" r="6" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(s.timestamp)) + '"' +
      ' data-c="' + s.value + '"/>';
  }).join("");

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = minC + (maxC - minC) * (i / 4);
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + _hwFmtNum(v) + unitTickSuffix + '</text>';
  }
  var xTicks = "";
  for (var j = 0; j <= 5; j++) {
    var tsTick = t0 + (t1 - t0) * (j / 5);
    var xPos = padL + (j / 5) * innerW;
    xTicks +=
      '<line x1="' + xPos + '" y1="' + (padT + innerH) + '" x2="' + xPos + '" y2="' + (padT + innerH + 3) + '" stroke="rgba(127,127,127,0.4)"/>' +
      '<text x="' + xPos + '" y="' + (padT + innerH + 14) + '" text-anchor="middle" font-size="10" fill="currentColor">' + fmtTick(tsTick) + '</text>';
  }

  var titleY = 14;
  var xLabelY = padT + innerH + 38;
  var yLabelX = 14;
  var yLabelY = padT + innerH / 2;
  var labels =
    '<text x="' + (W / 2) + '" y="' + titleY + '" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">' +
      escapeHtml(opts.subject || "Temperature") +
    '</text>' +
    '<text class="chart-axis-title" x="' + (padL + innerW / 2) + '" y="' + xLabelY + '" text-anchor="middle" font-size="11" fill="currentColor">Time</text>' +
    '<text class="chart-axis-title" x="' + yLabelX + '" y="' + yLabelY + '" text-anchor="middle" font-size="11" fill="currentColor"' +
      ' transform="rotate(-90 ' + yLabelX + ' ' + yLabelY + ')">' + escapeHtml(unit ? "Reading (" + unit + ")" : "Reading") + '</text>';

  var clipId = _chartClipId("sensor");
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      labels + ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        '<polyline points="' + pts + '" fill="none" stroke="var(--color-accent)" stroke-width="1.5"/>' +
        samples.map(function (s) { return '<circle cx="' + xFor(s.timestamp) + '" cy="' + yFor(s.value) + '" r="1.5" fill="var(--color-accent)"/>'; }).join("") +
        hits +
      '</g>' +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";

  _wireChartTooltip(container, function (target) {
    var c = Number(target.getAttribute("data-c"));
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>' + _hwFmtNum(c) + (unit ? " " + unit : "") + '</div>';
  });
  _addChartScreenshotButton(container, opts.subject || "Sensor", { yAxis: (unit ? "Reading (" + unit + ")" : "Reading"), subject: opts.subject });
  _observeChartResize(container, function (c) { _renderSensorChart(c, samples, opts); });
}

function _fmtBytes(n) {
  if (n == null || isNaN(n)) return "—";
  var units = ["B","KB","MB","GB","TB","PB"];
  var i = 0, v = Math.abs(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v < 10 && i > 0 ? v.toFixed(2) : v.toFixed(0)) + " " + units[i];
}

function _fmtSpeed(bps) {
  if (bps == null || isNaN(bps)) return "—";
  if (bps >= 1_000_000_000) return (bps / 1_000_000_000) + " Gbps";
  if (bps >= 1_000_000)     return (bps / 1_000_000)     + " Mbps";
  if (bps >= 1_000)         return (bps / 1_000)         + " Kbps";
  return bps + " bps";
}
function _fmtBitsPerSec(bps) {
  if (bps == null || isNaN(bps)) return "—";
  if (bps >= 1_000_000_000) return (bps / 1_000_000_000).toFixed(2) + " Gbps";
  if (bps >= 1_000_000)     return (bps / 1_000_000).toFixed(2)     + " Mbps";
  if (bps >= 1_000)         return (bps / 1_000).toFixed(2)         + " Kbps";
  return Math.round(bps) + " bps";
}
// Compact variant for chart y-axis ticks. Drops trailing ".00" on whole-unit
// values (so "100 Mbps" instead of "100.00 Mbps") and uses one decimal under
// 10 so labels still show enough resolution at small ceilings.
function _fmtBitsPerSecAxis(bps) {
  if (bps == null || isNaN(bps)) return "—";
  function pick(n, unit) {
    var s = n >= 10 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, "");
    return s + " " + unit;
  }
  if (bps >= 1_000_000_000) return pick(bps / 1_000_000_000, "Gbps");
  if (bps >= 1_000_000)     return pick(bps / 1_000_000,     "Mbps");
  if (bps >= 1_000)         return pick(bps / 1_000,         "Kbps");
  return Math.round(bps) + " bps";
}
function _fmtTooltipTs(ts) {
  function p(n) { return n < 10 ? "0" + n : String(n); }
  var d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

/**
 * Wire generic chart-tooltip behavior. Each <circle class="chart-hit"> on the
 * SVG has its data-* attributes formatted by `formatHTML(target)` and rendered
 * inside `tipEl` while the cursor is over that hit. Mirrors the response-time
 * chart's tooltip pattern but works for any line/bar chart.
 */
function _wireChartTooltip(container, formatHTML) {
  var tip = container.querySelector(".chart-tooltip");
  var svgEl = container.querySelector("svg");
  if (!tip || !svgEl) return;
  function showTip(target, evt) {
    tip.innerHTML = formatHTML(target);
    tip.style.display = "block";
    var rect = container.getBoundingClientRect();
    var x = evt.clientX - rect.left + 12;
    var y = evt.clientY - rect.top + 12;
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    if (x + tw > container.clientWidth - 4) x = evt.clientX - rect.left - tw - 12;
    if (y + th > container.clientHeight - 4) y = evt.clientY - rect.top - th - 12;
    if (x < 4) x = 4;
    if (y < 4) y = 4;
    tip.style.left = x + "px";
    tip.style.top  = y + "px";
  }
  svgEl.addEventListener("mousemove", function (evt) {
    var t = evt.target;
    if (t && t.classList && t.classList.contains("chart-hit")) showTip(t, evt);
    else tip.style.display = "none";
  });
  svgEl.addEventListener("mouseleave", function () { tip.style.display = "none"; });
}
var CHART_TOOLTIP_HTML =
  '<div class="chart-tooltip" style="position:absolute;pointer-events:none;display:none;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:4px;padding:6px 8px;font-size:0.75rem;line-height:1.35;color:var(--color-text);box-shadow:0 4px 12px rgba(0,0,0,0.25);white-space:nowrap;z-index:5"></div>';

// Re-runs `rerender(container)` whenever the container's width changes by more
// than a pixel — needed because the chart SVGs use a fixed viewBox computed
// from clientWidth at render time and `preserveAspectRatio="none"`, so any
// later width change would otherwise stretch the labels and ticks. One
// observer per container; rAF-debounced so a drag yields one redraw per frame.
function _observeChartResize(container, rerender) {
  if (!container || !window.ResizeObserver) return;
  if (container._chartResizeObs) container._chartResizeObs.disconnect();
  var lastW = container.clientWidth;
  var pending = false;
  var obs = new ResizeObserver(function () {
    var w = container.clientWidth;
    if (Math.abs(w - lastW) < 2) return;
    lastW = w;
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      if (!container.isConnected) { obs.disconnect(); container._chartResizeObs = null; return; }
      try { rerender(container); } catch (_) {}
    });
  });
  obs.observe(container);
  container._chartResizeObs = obs;
}

// Rasterize the SVG inside `container` to a PNG blob via Image+Canvas. The
// rasterizer can't resolve currentColor or var(--color-*), so we substitute
// the resolved values into the serialized SVG before drawing. The hit-target
// circles and tooltip element are stripped — they're interactive scaffolding,
// not part of the visual. `meta` adds a header (title / subject / asset) and
// axis labels (xAxis / yAxis) drawn in canvas margins around the chart so the
// screenshot is self-identifying once it leaves the page.
function _captureChartAsPng(container, meta, callback) {
  meta = meta || {};
  // Skip any svg that lives inside the screenshot button itself (its camera icon).
  var svgEl = null;
  if (container && container.querySelectorAll) {
    var all = container.querySelectorAll("svg");
    for (var i = 0; i < all.length; i++) {
      if (!all[i].closest(".chart-screenshot-btn")) { svgEl = all[i]; break; }
    }
  }
  if (!svgEl) { callback(null); return; }
  var rect = svgEl.getBoundingClientRect();
  var width = Math.ceil(rect.width);
  var height = Math.ceil(rect.height);
  if (!width || !height) { callback(null); return; }

  var rootCs = getComputedStyle(document.documentElement);
  var pickVar = function (name, fallback) {
    var v = rootCs.getPropertyValue(name).trim();
    return v || fallback;
  };
  // Background matches the page so the screenshot blends with the live UI.
  // (`--color-bg-elevated` was used previously but isn't defined in the CSS,
  // so it always fell back to white regardless of theme.)
  var bgPrimary  = pickVar("--color-bg-primary", "#ffffff");
  var accent     = pickVar("--color-accent", "#4fc3f7");
  var textSec    = pickVar("--color-text-secondary", "#666666");
  var resolvedText = getComputedStyle(svgEl).color || pickVar("--color-text-primary", "#111111");

  var clone = svgEl.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.setAttribute("width", width);
  clone.setAttribute("height", height);
  clone.removeAttribute("style");
  if (!clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", "0 0 " + width + " " + height);
  }
  // Drop transparent hit targets — they don't affect the picture but inflate it.
  // Also strip in-SVG axis titles: the canvas wrapper redraws them in the margins,
  // so leaving them in produces duplicates in the screenshot.
  Array.prototype.forEach.call(clone.querySelectorAll(".chart-hit, .monitor-hit, .chart-axis-title"), function (n) {
    n.parentNode.removeChild(n);
  });

  var serialized = new XMLSerializer().serializeToString(clone);
  serialized = serialized.replace(/currentColor/g, resolvedText);
  serialized = serialized.replace(/var\(--color-accent\)/g, accent);

  var blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var img = new Image();
  img.onload = function () {
    var scale = 2;

    // Build header. Line 1 is "<Title> — <Subject>" (subject = interface or
    // tunnel name when the chart is in a sub-panel). Line 2 is the asset.
    // Line 3 is an optional stats summary (same one shown above the chart).
    var titleParts = [];
    if (meta.title)   titleParts.push(meta.title);
    if (meta.subject) titleParts.push(meta.subject);
    var headerLine1 = titleParts.join(" — ");
    var headerLine2 = meta.asset || "";
    var headerLine3 = meta.stats || "";
    var headerH = 0;
    var lineCount = (headerLine1 ? 1 : 0) + (headerLine2 ? 1 : 0) + (headerLine3 ? 1 : 0);
    if (lineCount === 1) headerH = 24;
    else if (lineCount === 2) headerH = 40;
    else if (lineCount === 3) headerH = 56;

    var footerH  = meta.xAxis ? 22 : 0;
    var leftPadW = meta.yAxis ? 22 : 0;
    var totalW = leftPadW + width;
    var totalH = headerH + height + footerH;

    var canvas = document.createElement("canvas");
    canvas.width  = totalW * scale;
    canvas.height = totalH * scale;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = bgPrimary;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);

    var fontFamily = "system-ui, -apple-system, 'Segoe UI', sans-serif";

    if (headerH > 0) {
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      var headerX = leftPadW + 8;
      var nextY = 8;
      if (headerLine1) {
        ctx.fillStyle = resolvedText;
        ctx.font = "600 13px " + fontFamily;
        ctx.fillText(headerLine1, headerX, nextY);
        nextY += 16;
      }
      if (headerLine2) {
        ctx.fillStyle = textSec;
        ctx.font = "11px " + fontFamily;
        ctx.fillText(headerLine2, headerX, nextY);
        nextY += 16;
      }
      if (headerLine3) {
        ctx.fillStyle = textSec;
        ctx.font = "11px " + fontFamily;
        ctx.fillText(headerLine3, headerX, nextY);
      }
    }

    ctx.drawImage(img, leftPadW, headerH, width, height);
    URL.revokeObjectURL(url);

    if (leftPadW > 0) {
      ctx.save();
      ctx.fillStyle = resolvedText;
      ctx.font = "600 11px " + fontFamily;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.translate(11, headerH + height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(meta.yAxis, 0, 0);
      ctx.restore();
    }

    if (footerH > 0) {
      ctx.fillStyle = resolvedText;
      ctx.font = "600 11px " + fontFamily;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(meta.xAxis, leftPadW + width / 2, headerH + height + footerH / 2);
    }

    canvas.toBlob(function (b) { callback(b); }, "image/png");
  };
  img.onerror = function () { URL.revokeObjectURL(url); callback(null); };
  img.src = url;
}

// Inject a small camera button at the top-right of a chart container. The
// button copies the rendered chart to the clipboard as a PNG, mirroring the
// asset-details screenshot UX. `axisOpts` carries metadata that gets stamped
// onto the screenshot so it self-identifies after copy/paste:
//   { xAxis: "Time", yAxis: "Response time (ms)", subject?: "port15" }
// The asset name is resolved from `_currentAssetForRefresh` at click time.
function _addChartScreenshotButton(container, label, axisOpts) {
  if (!container) return;
  axisOpts = axisOpts || {};
  var existing = container.querySelector(".chart-screenshot-btn");
  if (existing) existing.parentNode.removeChild(existing);

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chart-screenshot-btn";
  btn.title = "Copy chart as image";
  btn.setAttribute("aria-label", "Copy " + label + " chart as image");
  btn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
      '<circle cx="12" cy="13" r="4"/>' +
    '</svg>';
  btn.style.cssText =
    "position:absolute;top:6px;right:6px;background:var(--color-bg-primary);" +
    "border:1px solid var(--color-border);border-radius:4px;padding:4px 6px;" +
    "cursor:pointer;color:var(--color-text-secondary);z-index:6;line-height:0;" +
    "display:inline-flex;align-items:center;justify-content:center";
  btn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    var a = _currentAssetForRefresh;
    var assetName = a ? (a.hostname || a.dnsName || a.ipAddress || a.id || "") : "";
    var statsLine = "";
    if (typeof axisOpts.getStats === "function") {
      try { statsLine = axisOpts.getStats() || ""; } catch (_) { statsLine = ""; }
    }
    var meta = {
      title: label,
      asset: assetName,
      subject: axisOpts.subject || "",
      xAxis: axisOpts.xAxis || "Time",
      yAxis: axisOpts.yAxis || label,
      stats: statsLine,
    };
    _captureChartAsPng(container, meta, function (blob) {
      if (!blob) { showToast("Screenshot failed", "error"); return; }
      if (!navigator.clipboard || typeof ClipboardItem === "undefined" || !navigator.clipboard.write) {
        showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
        return;
      }
      navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(function () {
        showToast(label + " chart copied to clipboard");
      }).catch(function () {
        showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
      });
    });
  });
  container.style.position = "relative";
  container.appendChild(btn);
}

// Rasterize the SVG inside `container` to a fully-loaded HTMLImageElement at
// native size. Mirrors the SVG-prep logic in _captureChartAsPng (strips hit
// targets, substitutes resolved CSS-variable colors) but stops short of
// drawing to canvas — the caller composites multiple images together.
// Calls back with `{ img, width, height, url }` (caller revokes `url`) or null.
function _rasterizeChartSvgToImage(container, callback) {
  var svgEl = null;
  if (container && container.querySelectorAll) {
    var all = container.querySelectorAll("svg");
    for (var i = 0; i < all.length; i++) {
      if (!all[i].closest(".chart-screenshot-btn")) { svgEl = all[i]; break; }
    }
  }
  if (!svgEl) { callback(null); return; }
  var rect = svgEl.getBoundingClientRect();
  var width = Math.ceil(rect.width);
  var height = Math.ceil(rect.height);
  if (!width || !height) { callback(null); return; }

  var rootCs = getComputedStyle(document.documentElement);
  var pickVar = function (name, fallback) {
    var v = rootCs.getPropertyValue(name).trim();
    return v || fallback;
  };
  var accent = pickVar("--color-accent", "#4fc3f7");
  var resolvedText = getComputedStyle(svgEl).color || pickVar("--color-text-primary", "#111111");

  var clone = svgEl.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.setAttribute("width", width);
  clone.setAttribute("height", height);
  clone.removeAttribute("style");
  if (!clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", "0 0 " + width + " " + height);
  }
  Array.prototype.forEach.call(clone.querySelectorAll(".chart-hit, .monitor-hit, .chart-axis-title"), function (n) {
    n.parentNode.removeChild(n);
  });

  var serialized = new XMLSerializer().serializeToString(clone);
  serialized = serialized.replace(/currentColor/g, resolvedText);
  serialized = serialized.replace(/var\(--color-accent\)/g, accent);

  var blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var img = new Image();
  img.onload = function () { callback({ img: img, width: width, height: height, url: url }); };
  img.onerror = function () { URL.revokeObjectURL(url); callback(null); };
  img.src = url;
}

// Captures the interface slide-over (title + asset + resolved comment + both
// charts) as a single PNG and copies it to the clipboard. The per-chart
// camera buttons still exist; this gives one composite for sharing the full
// interface view.
function _screenshotInterfacePanel(asset, ifName) {
  var tputContainer = document.getElementById("iface-tput-chart");
  var errContainer  = document.getElementById("iface-err-chart");
  if (!tputContainer || !errContainer) {
    showToast("Nothing to screenshot", "error");
    return;
  }

  var titleEl = document.getElementById("iface-panel-title");
  var titleText = titleEl ? titleEl.textContent : ("Interface — " + ifName);
  var assetName = asset ? (asset.hostname || asset.dnsName || asset.ipAddress || asset.id || "") : "";
  // Concatenate the throughput + error stats lines so the screenshot
  // captures both. Prefer the dataset.summary plaintext form (set by
  // _renderChartStats) so the screenshot composer doesn't have to parse
  // bold spans out of textContent.
  var tputStatsEl = document.getElementById("iface-tput-stats");
  var errStatsEl  = document.getElementById("iface-err-stats");
  function _ifaceStatsText(el) {
    if (!el) return "";
    var s = (el.dataset && el.dataset.summary) || el.textContent || "";
    s = s.trim();
    return s === "Loading…" ? "" : s;
  }
  var tputStatsText = _ifaceStatsText(tputStatsEl);
  var errStatsText  = _ifaceStatsText(errStatsEl);
  var statsText = [tputStatsText, errStatsText].filter(Boolean).join(" · ");

  // Resolved comment: textarea value if non-empty (covers in-progress edits and
  // saved overrides), else the discovered FortiOS CMDB description.
  var commentInput = document.getElementById("iface-comment-input");
  var commentText = "";
  if (commentInput && commentInput.value && commentInput.value.trim()) {
    commentText = commentInput.value.trim();
  } else if (_ifaceCommentState && _ifaceCommentState.discoveredDescription) {
    commentText = _ifaceCommentState.discoveredDescription;
  }

  _rasterizeChartSvgToImage(tputContainer, function (tput) {
    _rasterizeChartSvgToImage(errContainer, function (errs) {
      if (!tput && !errs) { showToast("Screenshot failed", "error"); return; }
      _composeInterfaceScreenshot({
        title: titleText,
        asset: assetName,
        comment: commentText,
        stats: statsText,
        tput: tput,
        errs: errs,
      });
    });
  });
}

function _composeInterfaceScreenshot(parts) {
  var cs = getComputedStyle(document.documentElement);
  var bgPrimary = cs.getPropertyValue("--color-bg-primary").trim() || "#ffffff";
  var clrText   = cs.getPropertyValue("--color-text-primary").trim() || "#111111";
  var clrSec    = cs.getPropertyValue("--color-text-secondary").trim() || "#666666";

  var scale = 2;
  var pad = 20;
  var fontFamily = "system-ui, -apple-system, 'Segoe UI', sans-serif";

  var chartW = Math.max(parts.tput ? parts.tput.width : 0, parts.errs ? parts.errs.width : 0);
  if (!chartW) chartW = 600;
  var canvasW = chartW + pad * 2;
  var maxLineW = canvasW - pad * 2;

  // Greedy whitespace wrap; long unbreakable tokens get truncated to fit.
  var tmp = document.createElement("canvas").getContext("2d");
  function wrap(font, text) {
    if (!text) return [];
    tmp.font = font;
    var words = String(text).split(/\s+/);
    var lines = [], cur = "";
    for (var i = 0; i < words.length; i++) {
      var trial = cur ? cur + " " + words[i] : words[i];
      if (tmp.measureText(trial).width <= maxLineW) cur = trial;
      else { if (cur) lines.push(cur); cur = words[i]; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  var titleFont   = "600 16px " + fontFamily;
  var assetFont   = "13px " + fontFamily;
  var statsFont   = "11px " + fontFamily;
  var labelFont   = "600 11px " + fontFamily;
  var commentFont = "13px " + fontFamily;

  var titleLines   = wrap(titleFont, parts.title);
  var assetLines   = wrap(assetFont, parts.asset);
  var statsLines   = wrap(statsFont, parts.stats);
  var commentLines = wrap(commentFont, parts.comment);

  var titleLineH = 22, assetLineH = 18, statsLineH = 16, commentLineH = 18;
  var sectionGap = 14, chartGap = 14;

  var totalH = pad
    + titleLines.length * titleLineH
    + (assetLines.length ? 2 + assetLines.length * assetLineH : 0)
    + (statsLines.length ? 4 + statsLines.length * statsLineH : 0)
    + (commentLines.length ? sectionGap + 16 + commentLines.length * commentLineH : 0)
    + (parts.tput ? sectionGap + parts.tput.height : 0)
    + (parts.errs ? chartGap   + parts.errs.height : 0)
    + pad;

  var canvas = document.createElement("canvas");
  canvas.width  = canvasW * scale;
  canvas.height = totalH * scale;
  var ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = bgPrimary;
  ctx.fillRect(0, 0, canvasW, totalH);
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  var y = pad;
  ctx.fillStyle = clrText;
  ctx.font = titleFont;
  titleLines.forEach(function (l) { ctx.fillText(l, pad, y); y += titleLineH; });

  if (assetLines.length) {
    y += 2;
    ctx.fillStyle = clrSec;
    ctx.font = assetFont;
    assetLines.forEach(function (l) { ctx.fillText(l, pad, y); y += assetLineH; });
  }

  if (statsLines.length) {
    y += 4;
    ctx.fillStyle = clrSec;
    ctx.font = statsFont;
    statsLines.forEach(function (l) { ctx.fillText(l, pad, y); y += statsLineH; });
  }

  if (commentLines.length) {
    y += sectionGap;
    ctx.fillStyle = clrSec;
    ctx.font = labelFont;
    ctx.fillText("INTERFACE COMMENTS", pad, y);
    y += 16;
    ctx.fillStyle = clrText;
    ctx.font = commentFont;
    commentLines.forEach(function (l) { ctx.fillText(l, pad, y); y += commentLineH; });
  }

  if (parts.tput) {
    y += sectionGap;
    ctx.drawImage(parts.tput.img, pad + (chartW - parts.tput.width) / 2, y, parts.tput.width, parts.tput.height);
    y += parts.tput.height;
    URL.revokeObjectURL(parts.tput.url);
  }
  if (parts.errs) {
    y += chartGap;
    ctx.drawImage(parts.errs.img, pad + (chartW - parts.errs.width) / 2, y, parts.errs.width, parts.errs.height);
    y += parts.errs.height;
    URL.revokeObjectURL(parts.errs.url);
  }

  canvas.toBlob(function (blob) {
    if (!blob) { showToast("Screenshot failed", "error"); return; }
    if (!navigator.clipboard || typeof ClipboardItem === "undefined" || !navigator.clipboard.write) {
      showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
      return;
    }
    navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(function () {
      showToast("Interface screenshot copied to clipboard");
    }).catch(function () {
      showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
    });
  }, "image/png");
}

// Combined CPU + Memory chart on a single 0–100% y-axis. CPU stays anchored
// at 0–100 so spikes remain meaningful; memory plots over the same axis as
// a percentage (computed from bytes when only bytes were sampled). One hit
// target per timestamp drives a unified tooltip naming both values.
function _renderSystemChart(container, data, asset, si) {
  var samples = (data && data.samples) || [];
  if (samples.length === 0) {
    if (_isRestApiManagedNetworkDevice(asset, "telemetry")) {
      var telPolling = _assetMonitorStreamSource(asset, "telemetry").polling || "REST API";
      container.innerHTML = _notAvailableViaPollingHTML("Telemetry", telPolling);
    } else {
      container.textContent = "No telemetry samples in this range yet.";
    }
    return;
  }

  function memPctFromSample(s) {
    if (typeof s.memPct === "number") return s.memPct;
    if (typeof s.memUsedBytes === "number" && typeof s.memTotalBytes === "number" && s.memTotalBytes > 0) {
      return (s.memUsedBytes / s.memTotalBytes) * 100;
    }
    return null;
  }

  var since = data && data.since;
  var until = data && data.until;
  var W = container.clientWidth || 600;
  var H = 200;
  var padL = 50, padR = 10, padT = 14, padB = 28;
  var innerW = W - padL - padR;
  var innerH = H - padT - padB;

  var bounds = _chartTimeBounds(samples, since, until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function fmtTick(ts) {
    var d = new Date(ts);
    if (spanMs <= oneDayMs) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  var cpuValues = samples.map(function (s) { return { s: s, v: typeof s.cpuPct === "number" ? s.cpuPct : null }; })
                         .filter(function (e) { return typeof e.v === "number"; });
  var memValues = samples.map(function (s) { return { s: s, v: memPctFromSample(s) }; })
                         .filter(function (e) { return typeof e.v === "number"; });

  var yMin = 0, yMax = 100;
  function xFor(ts) { return padL + ((new Date(ts).getTime() - t0) / (t1 - t0)) * innerW; }
  function yFor(v)  { return padT + innerH - ((v - yMin) / (yMax - yMin)) * innerH; }

  var cpuPts = cpuValues.map(function (e) { return xFor(e.s.timestamp) + "," + yFor(e.v); }).join(" ");
  var memPts = memValues.map(function (e) { return xFor(e.s.timestamp) + "," + yFor(e.v); }).join(" ");

  // Build one full-height vertical lane per timestamp so the tooltip fires
  // anywhere in the sample's column — including over a flatlined CPU line at
  // the bottom of a chart whose memory line dominates the visible space.
  // Lane width is the Voronoi span (midpoint to each neighbor) so coverage is
  // continuous across the chart with no dead zones between samples.
  var byTs = {};
  cpuValues.forEach(function (e) {
    var k = String(e.s.timestamp);
    if (!byTs[k]) byTs[k] = { ts: e.s.timestamp, sample: e.s };
    byTs[k].cpu = e.v;
  });
  memValues.forEach(function (e) {
    var k = String(e.s.timestamp);
    if (!byTs[k]) byTs[k] = { ts: e.s.timestamp, sample: e.s };
    byTs[k].mem = e.v;
  });
  var sortedHits = Object.keys(byTs).map(function (k) { return byTs[k]; })
                         .sort(function (a, b) { return new Date(a.ts).getTime() - new Date(b.ts).getTime(); });
  var hits = sortedHits.map(function (h, i) {
    var x = xFor(h.ts);
    var leftEdge  = i === 0 ? padL : (xFor(sortedHits[i - 1].ts) + x) / 2;
    var rightEdge = i === sortedHits.length - 1 ? (W - padR) : (xFor(sortedHits[i + 1].ts) + x) / 2;
    var s = h.sample;
    return '<rect class="chart-hit" x="' + leftEdge + '" y="' + padT + '" width="' + (rightEdge - leftEdge) + '" height="' + innerH + '" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(h.ts)) + '"' +
      ' data-cpu="' + (h.cpu != null ? h.cpu : "") + '"' +
      ' data-mem="' + (h.mem != null ? h.mem : "") + '"' +
      ' data-mb="' + (typeof s.memUsedBytes === "number" ? s.memUsedBytes : "") + '"' +
      ' data-mt="' + (typeof s.memTotalBytes === "number" ? s.memTotalBytes : "") + '"/>';
  }).join("");

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = yMin + (yMax - yMin) * (i / 4);
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + v.toFixed(0) + '%</text>';
  }
  var xTicks = "";
  for (var j = 0; j <= 5; j++) {
    var tsTick = t0 + (t1 - t0) * (j / 5);
    var xPos = padL + (j / 5) * innerW;
    xTicks +=
      '<line x1="' + xPos + '" y1="' + (padT + innerH) + '" x2="' + xPos + '" y2="' + (padT + innerH + 3) + '" stroke="rgba(127,127,127,0.4)"/>' +
      '<text x="' + xPos + '" y="' + (padT + innerH + 14) + '" text-anchor="middle" font-size="10" fill="currentColor">' + fmtTick(tsTick) + '</text>';
  }
  var cpuColor = "var(--color-accent)";
  var memColor = "#f4a261";
  var legend =
    '<g font-size="10" fill="currentColor">' +
      '<rect x="' + (padL + 4)  + '" y="2" width="10" height="10" fill="' + cpuColor + '"/>' +
      '<text x="' + (padL + 18) + '" y="11">CPU</text>' +
      '<rect x="' + (padL + 60) + '" y="2" width="10" height="10" fill="' + memColor + '"/>' +
      '<text x="' + (padL + 74) + '" y="11">Memory</text>' +
    '</g>';

  var chartStaleBanner = _staleBannerHTML(asset && asset.id, asset, "telemetry", si && si.lastTelemetryAt);
  var clipId = _chartClipId("system");
  container.innerHTML =
    chartStaleBanner +
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        (cpuPts ? '<polyline points="' + cpuPts + '" fill="none" stroke="' + cpuColor + '" stroke-width="1.5"/>' : '') +
        (memPts ? '<polyline points="' + memPts + '" fill="none" stroke="' + memColor + '" stroke-width="1.5"/>' : '') +
        cpuValues.map(function (e) { return '<circle cx="' + xFor(e.s.timestamp) + '" cy="' + yFor(e.v) + '" r="1.5" fill="' + cpuColor + '"/>'; }).join("") +
        memValues.map(function (e) { return '<circle cx="' + xFor(e.s.timestamp) + '" cy="' + yFor(e.v) + '" r="1.5" fill="' + memColor + '"/>'; }).join("") +
        hits +
      '</g>' +
      legend +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  container.style.flexDirection = "column";

  _wireChartTooltip(container, function (target) {
    var ts = target.getAttribute("data-ts");
    var cpuRaw = target.getAttribute("data-cpu");
    var memRaw = target.getAttribute("data-mem");
    var mb = target.getAttribute("data-mb");
    var mt = target.getAttribute("data-mt");
    var memLine = '<div>Memory: ' + (memRaw !== "" ? Number(memRaw).toFixed(1) + "%" : "—");
    if (mb !== "" && mt !== "") {
      memLine += " (" + _fmtBytes(Number(mb)) + " / " + _fmtBytes(Number(mt)) + ")";
    }
    memLine += "</div>";
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(ts)) + '</div>' +
      '<div>CPU: ' + (cpuRaw !== "" ? Number(cpuRaw).toFixed(1) + "%" : "—") + '</div>' +
      memLine;
  });
  _addChartScreenshotButton(container, "CPU & Memory", { yAxis: "Utilization (%)" });
  _observeChartResize(container, function (c) { _renderSystemChart(c, data, asset, si); });
}

// Human-readable label for the polling method behind the response-time
// chart. Reads the per-asset responseTimePolling override first; falls
// back to the source default ("rest_api" for Fortinet, "icmp" for the
// rest). Coarse view — full provenance is in /effective-monitor-settings,
// but a label that's right 95% of the time is good enough for a chart
// caption.
function _probeMethodLabel(a) {
  if (!a) return "—";
  var integ = a.discoveredByIntegration;
  var sourceKind = (integ && integ.type) || "manual";
  var polling = a.responseTimePolling
    || (sourceKind === "fortimanager" || sourceKind === "fortigate" ? "rest_api" : "icmp");
  switch (polling) {
    case "rest_api": return "REST API";
    case "snmp":     return "SNMP GET";
    case "winrm":    return "WinRM";
    case "ssh":      return "SSH";
    case "icmp":     return "ICMP ping";
    default:         return polling;
  }
}

// Per-stream polling-method + asset-source resolver used by the chart badges
// in the asset System tab. Each chart shows what protocol is actually moving
// data on its stream and which integration the asset came from. Reads the
// per-asset *Polling override first and falls back to the source default.
// Returns
//   { polling: "REST API" | "SNMP · <cred>" | "WinRM" | "SSH" | "ICMP" | null,
//     source:  "FortiManager · <name>" | "Active Directory · <name>" | "Manual" | ... }
// `polling` is null when the source doesn't deliver that stream (e.g. AD/
// Entra/WinServer hosts have no telemetry/interfaces/lldp stream by
// default); the caller should hide the badge in that case.
// Append the parent FortiGate name when the asset is a managed
// FortiSwitch or FortiAP under an FMG/FortiGate integration. The chain
// "FortiManager · <fmg> → <FortiGate>" tells the operator which
// controller actually answers polls for this device. Returns the bare
// integration name otherwise. `joiner` controls the prefix between the
// integration label and integration name (": " for the Source detail row,
// " · " for the chart-badge style).
function _assetIntegrationLabelWithController(asset, joiner) {
  var integration = asset && asset.discoveredByIntegration;
  if (!integration) return "Manual";
  var typeLabels = {
    fortimanager:    "FortiManager",
    fortigate:       "FortiGate",
    activedirectory: "Active Directory",
    entraid:         "Entra ID",
    windowsserver:   "Windows Server",
  };
  var label = (typeLabels[integration.type] || integration.type) + joiner + integration.name;
  if (asset.assetType !== "switch" && asset.assetType !== "access_point") return label;
  if (integration.type !== "fortimanager" && integration.type !== "fortigate") return label;
  var controller = asset.fortinetTopology && asset.fortinetTopology.controllerFortigate;
  if (!controller) return label;
  // Standalone FortiGate integrations: integration.name IS the controller —
  // suppress the redundant "→ same-name" suffix.
  if (typeof controller === "string" && controller.toLowerCase() === String(integration.name || "").toLowerCase()) {
    return label;
  }
  return label + " → " + controller;
}

// Stream name → Asset/resolver field prefix. Four of the five streams
// (responseTime / temperature / interfaces / lldp) use their stream name as
// the prefix directly; "telemetry" is the odd one out — its persisted
// columns are `cpuMemoryPolling` / `cpuMemoryCredential` / `cpuMemoryMibId`
// / `cpuMemoryCredentialId` / `cpuMemoryMibId` (the System-tab section is
// "CPU & Memory" — "telemetry" is the UI/cadence-bucket label, not a column
// prefix). Every lookup that does `stream + "Polling"` etc. routes through
// this helper so the telemetry badge picks up class-override / per-asset
// values instead of silently falling back to the source default.
function _streamFieldPrefix(stream) {
  return stream === "telemetry" ? "cpuMemory" : stream;
}

function _assetMonitorStreamSource(asset, stream) {
  if (!asset) return { polling: null, source: "—" };
  var integration = asset.discoveredByIntegration;

  // Asset source: which integration discovered this asset (with the parent
  // FortiGate appended for managed switches/APs), or "Manual".
  var sourceName = _assetIntegrationLabelWithController(asset, " · ");

  // Per-asset polling override wins; otherwise show the source default for
  // this stream. This is a coarse view (skips class-override / tier-3 layers
  // — that fidelity comes from /effective-monitor-settings) and is good
  // enough for the at-a-glance chart badge.
  var sourceKind = (integration && integration.type) || "manual";
  if (!_POLLING_COMPAT[sourceKind]) sourceKind = "manual";
  var assetField = _streamFieldPrefix(stream) + "Polling";
  var resolved = asset[assetField] || _polarisSourceDefaultPolling(sourceKind, stream);
  if (!resolved) return { polling: null, source: sourceName };

  var polling = _POLLING_LABELS[resolved] || resolved;
  // Append the credential name on transports that need one — gives the
  // operator a quick visual confirmation of which credential the probe is
  // about to use without opening the edit modal.
  var cred = asset.monitorCredential;
  if ((resolved === "snmp" || resolved === "winrm" || resolved === "ssh" || resolved === "rest_api") && cred && cred.name) {
    polling += " · " + cred.name;
  }
  return { polling: polling, source: sourceName };
}

// Tier labels for the four-tier hierarchy. Provenance values
// ("asset"|"class"|"integration"|"manual") come from /effective-monitor-
// settings. The badge tells the operator where to go to change the value.
var _TIER_LABELS = {
  asset:       "Asset override",
  class:       "Class override",
  integration: "Integration",
  manual:      "Manual",
};

// Transport descriptor for a resolved polling method. Returns the inner
// text (caller wraps in parens). Empty when transport is unambiguous —
// SNMP/ICMP/WinRM/SSH always go directly to the asset's IP, and standalone
// FortiGate REST API has no transport to choose. Returns:
//   "Proxy via <fmg>" / "Direct"   for FMG REST API at the FortiGate
//   "via parent FortiGate"         for managed FortiSwitch/FortiAP REST API
//                                  (probe queries the parent FortiGate's
//                                  controller-status table, not the
//                                  device's own IP).
function _streamTransportLabel(asset, resolvedPolling) {
  if (resolvedPolling !== "rest_api") return "";
  var integ = asset && asset.discoveredByIntegration;
  if (!integ) return "";
  if ((asset.assetType === "switch" || asset.assetType === "access_point") &&
      (integ.type === "fortimanager" || integ.type === "fortigate")) {
    return "via parent FortiGate";
  }
  if (integ.type === "fortimanager") {
    if (integ.useProxy === true)  return "Proxy via " + integ.name;
    if (integ.useProxy === false) return "Direct";
  }
  return "";
}

// Resolves which credential is actually used to authenticate this stream's
// probe so the badge can name it. Resolution mirrors the dispatcher in
// monitoringService.probeAsset: per-stream credential → legacy generic
// monitorCredential → integration's stored credential (SNMP/WinRM/SSH on
// FMG/FortiGate-discovered assets only — REST API on those uses the
// integration's API token, which isn't a Credential row and stays implicit
// in the "Proxy via …" / "Direct" transport label). ICMP doesn't
// authenticate.
function _streamCredential(asset, stream, resolvedPolling, effectiveResolved) {
  if (!asset || resolvedPolling === "icmp" || resolvedPolling === "disabled") return null;
  var prefix = _streamFieldPrefix(stream);
  var perStream = asset[prefix + "Credential"];
  if (perStream && perStream.name) return perStream;
  if (asset.monitorCredential && asset.monitorCredential.name) return asset.monitorCredential;
  // Class-override per-stream credential — only available when the caller
  // passed eff.resolved from /effective-monitor-settings. Look the
  // credential up by id in the credential cache so the badge labels match
  // what the probe actually uses after the resolver fix.
  if (effectiveResolved) {
    var credId = effectiveResolved[prefix + "CredentialId"];
    if (credId && _credentialCache && Array.isArray(_credentialCache.list)) {
      var found = _credentialCache.list.find(function (c) { return c.id === credId; });
      if (found && found.name) return found;
    }
  }
  if ((resolvedPolling === "snmp" || resolvedPolling === "winrm" || resolvedPolling === "ssh") &&
      asset.integrationMonitorCredential && asset.integrationMonitorCredential.name) {
    return asset.integrationMonitorCredential;
  }
  return null;
}

// Maps a stream name to the per-asset interval-override column. The
// per-asset tier exposes only three columns; interfaces/lldp share the
// system-info column since both ride the system-info pass.
function _streamIntervalAssetField(stream) {
  if (stream === "responseTime") return "monitorIntervalSec";
  // Hardware sensors (internal key "temperature") ride the telemetry cadence —
  // they're collected alongside CPU/memory in runTelemetryFor — so the badge
  // shows the telemetry interval as the true poll rate. (If an independent
  // hardware-sensor cadence ever lands, switch this to temperatureIntervalSec.)
  if (stream === "telemetry" || stream === "temperature") return "cpuMemoryIntervalSec";
  if (stream === "interfaces" || stream === "lldp") return "systemInfoIntervalSec";
  return null;
}

// Maps a stream name to the resolved-settings interval field returned by
// /effective-monitor-settings. interfaces/lldp share the system-info
// cadence — same rationale as the per-asset mapping above.
function _streamIntervalEffectiveField(stream) {
  if (stream === "responseTime") return "intervalSeconds";
  // Hardware sensors ride the telemetry cadence (see _streamIntervalAssetField).
  if (stream === "telemetry" || stream === "temperature") return "cpuMemoryIntervalSeconds";
  if (stream === "interfaces" || stream === "lldp") return "systemInfoIntervalSeconds";
  return null;
}

// Humane "every Ns / Nm / Nh" rendering for a polling interval. Returns ""
// when the input isn't a positive finite number so the caller can drop the
// slot from the badge entirely instead of rendering "every NaNs".
function _formatPollingInterval(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return seconds + "s";
  if (seconds % 3600 === 0) return (seconds / 3600) + "h";
  if (seconds % 60 === 0)   return (seconds / 60) + "m";
  return seconds + "s";
}

// Resolve a per-stream MIB id (the resolved value from
// /effective-monitor-settings) into a human-readable label. Returns null
// when the id is falsy. Standard MIBs (`std:<key>`) resolve via the
// frontend-local `_SNMP_STANDARD_MIBS` table; uploaded MIBs (UUIDs) resolve
// via the `mibLookup` map the backend attaches to the response. Returns
// the raw id if neither lookup matches so the operator at least sees
// *something* instead of silently swallowing the chip.
function _resolveStreamMibLabel(mibId, mibLookup) {
  if (!mibId) return null;
  if (typeof mibId === "string" && mibId.indexOf("std:") === 0) {
    var std = _SNMP_STANDARD_MIBS.find(function (m) { return m.id === mibId; });
    if (std) {
      // Strip the parenthetical RFC suffix on the chip — operators care
      // about the module name, not the standards body. The full label
      // remains in `_SNMP_STANDARD_MIBS` for the SNMP Walk dropdown.
      return std.label.split(" (")[0].split(" — ").pop();
    }
    return mibId;
  }
  if (mibLookup && mibLookup[mibId] && mibLookup[mibId].moduleName) {
    return mibLookup[mibId].moduleName;
  }
  return null; // UUID with no lookup entry — backend will fill it in on next refresh
}

// Builds the badge label "<polling>[ (<details>)][ · every <interval>] · <tier>[ · MIB: <name>]"
// used next to each chart header. <details> bundles the transport
// descriptor and the credential name together in one parenthetical,
// comma-separated. `provenanceTier` is one of asset|class|integration|
// manual; pass null to fall back to a coarse sync guess (per-asset field
// set → asset override; integration present → integration tier; otherwise
// → manual tier). The async path passes the real provenance.
// `intervalSeconds` is the resolved cadence for this stream (response-time
// /telemetry/system-info); pass null to omit the slot entirely.
// `mibLabel` is the resolved MIB module name (from
// _resolveStreamMibLabel); pass null to omit the MIB chip — the sync
// render does this, the async refresh fills it in.
function _streamBadgeText(asset, stream, resolvedRaw, provenanceTier, intervalSeconds, effectiveResolved, mibLabel) {
  var pollingLabel = _POLLING_LABELS[resolvedRaw] || resolvedRaw;
  var transport = _streamTransportLabel(asset, resolvedRaw);
  var credential = _streamCredential(asset, stream, resolvedRaw, effectiveResolved);
  var details = [];
  if (transport)  details.push(transport);
  if (credential) details.push(credential.name);
  var detailsStr = details.length ? " (" + details.join(", ") + ")" : "";
  var intervalLabel = _formatPollingInterval(intervalSeconds);
  var intervalStr = intervalLabel ? " · every " + intervalLabel : "";
  var tier;
  if (provenanceTier && _TIER_LABELS[provenanceTier]) {
    tier = _TIER_LABELS[provenanceTier];
  } else {
    var assetField = _streamFieldPrefix(stream) + "Polling";
    if (asset[assetField]) tier = _TIER_LABELS.asset;
    else if (asset.discoveredByIntegration) tier = _TIER_LABELS.integration;
    else tier = _TIER_LABELS.manual;
  }
  var mibStr = mibLabel ? " · MIB: " + mibLabel : "";
  return pollingLabel + detailsStr + intervalStr + " · " + tier + mibStr;
}

// Renders the badge content used next to each chart header. Returns ""
// when the stream isn't delivered for the asset's source kind (caller
// skips the badge entirely). The polling half + tier guess use a coarse
// local resolver at first render so the badge appears synchronously; the
// System tab open path fires _updateStreamSourceBadgesFromEffective()
// right after to overwrite it with the authoritative provenance from
// /effective-monitor-settings (covers class overrides + integration tier).
function _streamSourceBadgeHTML(asset, stream) {
  var integration = asset.discoveredByIntegration;
  var sourceKind  = (integration && integration.type) || "manual";
  if (!_POLLING_COMPAT[sourceKind]) sourceKind = "manual";
  var assetField  = _streamFieldPrefix(stream) + "Polling";
  var resolvedRaw = asset[assetField] || _polarisSourceDefaultPolling(sourceKind, stream);
  if (!resolvedRaw) return "";
  // Coarse interval guess for the sync render: per-asset override only.
  // The async path overwrites with the authoritative resolved value from
  // /effective-monitor-settings (covers class/integration/manual tiers).
  var intervalAssetField = _streamIntervalAssetField(stream);
  var intervalSeconds = (intervalAssetField && asset[intervalAssetField] != null) ? asset[intervalAssetField] : null;
  var label = _streamBadgeText(asset, stream, resolvedRaw, null, intervalSeconds);
  var titleLabel = "Polling method · Where this setting comes from";
  return '<span class="asset-stream-source-badge" data-asset-id="' + escapeHtml(asset.id) + '" data-stream="' + escapeHtml(stream) + '" title="' + escapeHtml(titleLabel) + '" style="font-size:0.75rem;padding:2px 6px;border-radius:10px;background:var(--color-bg-elevated);border:1px solid var(--color-border);color:var(--color-text-secondary);white-space:nowrap">' +
    escapeHtml(label) +
  '</span>';
}

// Fetches /effective-monitor-settings (which walks all four tiers) and
// rewrites each badge's text to reflect the truly-resolved polling method
// AND the actual tier that supplied it. Necessary because the sync render
// can't see class overrides or distinguish the integration tier from a
// source default — the badge would say "REST API · Integration" when the
// operator had set a class override to SNMP. Best-effort; on failure the
// badge keeps its sync value. Re-checks data-asset-id on each span so a
// stale fetch after the modal switched assets doesn't write into the
// wrong row.
async function _updateStreamSourceBadgesFromEffective(assetId, asset) {
  if (!assetId || !asset) return;
  // _streamCredential needs the credential cache to resolve a class-override
  // *CredentialId into a name. Without this the badge silently falls through
  // to the integration's credential when the cache hasn't been warmed by
  // another surface (Server Settings / Monitoring Settings modal).
  if (!_credentialCache.loaded) await _ensureCredentials().catch(function () {});
  var eff;
  try { eff = await api.assets.effectiveMonitorSettings(assetId); } catch (_) { return; }
  if (!eff || !eff.resolved) return;
  // Cache resolved settings so stale-banner slots can re-evaluate against
  // the class/integration tier; rewrite any slots already in the DOM.
  _effectiveResolvedByAssetId.set(assetId, eff.resolved);
  _updateStaleBannersFromEffective(assetId, asset);
  var spans = document.querySelectorAll('.asset-stream-source-badge[data-asset-id="' + (window.CSS && CSS.escape ? CSS.escape(assetId) : assetId) + '"]');
  spans.forEach(function (span) {
    var stream = span.getAttribute("data-stream");
    if (!stream) return;
    var prefix = _streamFieldPrefix(stream);
    var resolved = eff.resolved[prefix + "Polling"];
    // Tier-3 leaves polling null when the operator picked "Inherit" at every
    // tier — fall back to the source default the resolver applies at probe
    // time. The sync render already does this; without the parallel fallback
    // here, the async refresh would early-return and skip the cadence update,
    // leaving the badge stuck on "REST API (Direct) · Integration" without
    // the "every Nm" slot that the telemetry badge gets for free.
    if (!resolved) {
      var integration = asset.discoveredByIntegration;
      var sourceKind = (integration && integration.type) || "manual";
      if (!_POLLING_COMPAT[sourceKind]) sourceKind = "manual";
      resolved = _polarisSourceDefaultPolling(sourceKind, stream);
      if (!resolved) return; // truly not delivered (e.g. AD/Entra telemetry)
    }
    var prov = eff.provenance && eff.provenance[prefix + "Polling"];
    var intervalField = _streamIntervalEffectiveField(stream);
    var intervalSeconds = intervalField ? eff.resolved[intervalField] : null;
    // Per-stream MIB id + provenance — only response-time / telemetry /
    // interfaces / lldp carry a *MibId column. The same provenance tier
    // (asset|class|integration|manual) feeds the tooltip so operators can
    // see at a glance which tier supplied the MIB choice.
    var mibId = eff.resolved[prefix + "MibId"];
    var mibLabel = _resolveStreamMibLabel(mibId, eff.mibLookup);
    var mibProv = eff.provenance && eff.provenance[prefix + "MibId"];
    span.textContent = _streamBadgeText(asset, stream, resolved, prov, intervalSeconds, eff.resolved, mibLabel);
    // Tooltip carries the MIB provenance so the operator doesn't have to
    // open the edit modal to confirm where the MIB pin came from.
    if (mibLabel && mibProv && _TIER_LABELS[mibProv]) {
      span.title = "Polling method · Where this setting comes from · MIB pinned at " + _TIER_LABELS[mibProv].toLowerCase();
    } else {
      span.title = "Polling method · Where this setting comes from";
    }
  });
}

// "Asset Override" badge rendered next to the Monitor Status pill on the
// asset details System tab when the operator's `monitored` choice diverges
// from the discovering integration's per-class addAsMonitored. Replaces
// the legacy sticky monitoredOperatorSet flag with a convergent model: the
// badge shows up the moment the two disagree and disappears when they
// converge (either side moving satisfies the equality). Hidden for assets
// with no discoveredByIntegrationId (manual assets have nothing to override).
function _assetOverrideBadge(a) {
  if (!a || a.monitorOverride !== true) return "";
  var tip = "This asset's monitored state diverges from the discovering integration's Auto-Monitor setting. Discovery won't sweep this asset until the operator re-aligns the choice (or flips Auto-Monitor in the integration).";
  return '<span class="badge badge-warning" title="' + escapeHtml(tip) + '" style="margin-left:6px">Asset Override</span>';
}

function assetMonitoringViewHTML(a) {
  if (!a) return '<p class="empty-state">No data.</p>';
  var pill = assetMonitorBadge(a);
  var overridePill = _assetOverrideBadge(a);
  if (!a.monitored) {
    return '<div style="padding:1rem 0">' +
      pill + overridePill + ' &nbsp; ' +
      '<span style="color:var(--color-text-secondary)">Monitoring is disabled for this asset. Enable it from the Edit modal’s Monitoring tab.</span>' +
    '</div>';
  }
  // Source label: integration name (with parent FortiGate appended for
  // managed switches/APs) when integration-discovered, else credential
  // name + polling method, else bare polling method.
  var sourceLabel;
  if (a.discoveredByIntegration) {
    sourceLabel = _assetIntegrationLabelWithController(a, ": ");
  } else {
    var rtPolling = a.responseTimePolling || "icmp";
    if (a.monitorCredential) sourceLabel = rtPolling.toUpperCase() + " · " + a.monitorCredential.name;
    else sourceLabel = rtPolling.toUpperCase();
  }
  var probeBtn = isUserOrAbove()
    ? '<button class="btn btn-sm btn-primary" id="btn-asset-probe-now" style="margin-right:6px" title="Poll the device now: run a response-time probe and pull fresh telemetry + interface data">Poll Now</button>'
    : '';
  // Admin-only "Dependency Test" trigger lives next to the Status pill on
  // the System tab. Eligible for Fortinet infra only — workstations etc.
  // aren't part of the dependency tree, so the simulation has no children
  // to suppress and the backend rejects the call. Active state shows a
  // "Clear" button instead. Strictly admin-only.
  var depTestBtn = "";
  var isInfraType = a.assetType === "firewall" || a.assetType === "switch" || a.assetType === "access_point";
  var depTestActiveNow = a.dependencyTestUntil && new Date(a.dependencyTestUntil).getTime() > Date.now();
  if (typeof isAdmin === "function" && isAdmin() && a.monitored && isInfraType) {
    if (depTestActiveNow) {
      depTestBtn = '<button class="btn btn-sm btn-secondary" onclick="clearDependencyTestNow(\'' + escapeHtml(a.id) + '\')" style="margin-left:6px" title="Stop the simulation immediately and let children resume">Clear Dep. Test</button>';
    } else {
      depTestBtn = '<button class="btn btn-sm btn-secondary" onclick="startDependencyTestPrompt(\'' + escapeHtml(a.id) + '\')" style="margin-left:6px" title="Admin-only: simulate this device going down to see how children react. Real probes keep running.">Simulate Down…</button>';
    }
  }
  var rangeBtns =
    _chartRangeBtnsHTML("asset-monitor-range-btn", [
      { value: "1h",  label: "1h" },
      { value: "24h", label: "24h" },
      { value: "7d",  label: "7d" },
      { value: "30d", label: "30d" },
      { value: "custom", label: "Custom…", id: "btn-asset-monitor-custom" },
    ], "assetMonitor", "24h");
  var customPanel =
    '<div id="asset-monitor-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
      '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="asset-monitor-from" class="form-input" style="padding:2px 6px"></label>' +
      '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="asset-monitor-to" class="form-input" style="padding:2px 6px"></label>' +
      '<button class="btn btn-sm btn-primary" id="btn-asset-monitor-custom-apply">Apply</button>' +
    '</div>';
  return (
    '<div data-shot-section="status" data-shot-label="Status &amp; Monitoring">' +
    '<div class="asset-view-grid">' +
      // Status uses a raw-HTML row because viewRow() escapes its value and
      // would render the badge markup as text.
      // The pill + override badge live in an id'd wrapper so the Refresh
      // button's probe-now handler can re-render just the Status after a probe
      // (a down→up flip would otherwise leave the pill stale). depTestBtn sits
      // outside the wrapper — a probe never changes the dependency-test state.
      '<div class="detail-row"><span class="detail-label">Status</span>' +
        '<span class="detail-value">' + probeBtn + '<span id="asset-status-pill-wrap">' + pill + overridePill + '</span>' + depTestBtn + '</span></div>' +
      // Last hour intermittency bar — one cell per probe sample, colored
      // by the resolved monitor state at that point. Sits in a single
      // grid column (half the panel); the value cell is flex:1 so the bar
      // fills the column's value-side rather than collapsing to the natural
      // width of the "Nh ago/N samples/now" caption underneath. Loaded
      // asynchronously by _renderIntermittencyBar(). Hidden on unmonitored
      // assets.
      (a.monitored
        ? '<div class="detail-row"><span class="detail-label">Last 30 min</span>' +
            '<span class="detail-value" id="asset-intermittency-bar" data-asset-id="' + escapeHtml(a.id) + '" style="flex:1">' +
              '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Loading…</span>' +
            '</span></div>'
        : '') +
      viewRow("Source", sourceLabel) +
    '</div>' +
    '</div>' +
    '<div data-shot-section="responseTime" data-shot-label="Response Time" data-shot-chart="assetMonitor">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin:1.5rem 0 0.5rem">' +
      '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
        '<h4 style="margin:0">Response time</h4>' +
        _streamSourceBadgeHTML(a, "responseTime") +
      '</div>' +
      '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
    '</div>' +
    customPanel +
    '<div id="asset-monitor-stats" style="display:flex;gap:1.25rem;flex-wrap:wrap;font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem"></div>' +
    '<div id="asset-monitor-chart" style="background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;padding:0.5rem;min-height:200px;display:flex;align-items:center;justify-content:center;color:var(--color-text-secondary);font-size:0.85rem">' +
      'Loading samples…' +
    '</div>' +
    '</div>'
  );
}

/**
 * Renders a thin colored bar under the Status row on the asset System tab.
 * Each cell = one probe sample over the past hour, colored by the resolved
 * monitor state at that point. Replays the five-state machine forward over
 * the samples (starting from "unknown") so the bar matches what the Status
 * pill would have read sample-by-sample. Runs once on tab open; not
 * auto-refreshed (the sample chart above already auto-refreshes and this
 * mostly serves as an at-a-glance intermittency indicator).
 */
async function _renderIntermittencyBar(assetId) {
  var slot = document.getElementById("asset-intermittency-bar");
  if (!slot || slot.getAttribute("data-asset-id") !== assetId) return;
  // Fetch in parallel: 1h sample stream (trimmed to last 30) + the resolved
  // threshold for the state-machine replay. Both are best-effort; if either
  // fails we fall back to a sensible default so the bar still renders.
  var allSamples = [];
  var threshold = 3;
  try {
    var results = await Promise.all([
      api.assets.monitorHistory(assetId, "1h").catch(function () { return null; }),
      api.assets.effectiveMonitorSettings(assetId).catch(function () { return null; }),
    ]);
    allSamples = (results[0] && Array.isArray(results[0].samples)) ? results[0].samples : [];
    if (results[1] && results[1].resolved) {
      if (Number.isFinite(results[1].resolved.failureThreshold)) {
        threshold = results[1].resolved.failureThreshold;
      }
      // Populate the shared cache so stale-banner slots see the resolved
      // class/integration cadence as soon as this fetch lands (covers the
      // case where the response-time chart loads before the System tab is
      // opened).
      _effectiveResolvedByAssetId.set(assetId, results[1].resolved);
      _updateStaleBannersFromEffective(assetId, _currentAssetForRefresh);
    }
  } catch (_) { /* fall through with defaults */ }

  if (allSamples.length === 0) {
    slot.innerHTML = '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">No samples in the last 30 minutes</span>';
    return;
  }
  // Per-sample coloring (NOT a replay of the Status pill's hysteresis state
  // machine): each block reflects that single sample's outcome so the bar
  // reads literally. A success is green immediately — no recovery smear.
  // A failure is yellow (warning); once it's the Nth consecutive failure
  // (N = failureThreshold, the same count the pill uses to declare down) it
  // flips red and stays red while the run continues. Worked examples at
  // threshold 3: one missed poll → green, yellow, green; a device going down
  // → green, yellow, yellow, red. We still walk the FULL hour and slice the
  // trailing 30 so the consecutive-failure counter is warmed up across the
  // 30-sample boundary (a dip that started before the visible window keeps
  // its correct red/yellow color).
  var cf = 0;
  var allStates = allSamples.map(function (s) {
    var status;
    if (s.success) {
      cf = 0;
      status = "up";
    } else {
      cf += 1;
      status = (cf >= threshold) ? "down" : "warning";
    }
    return { timestamp: s.timestamp, status: status };
  });
  var states = allStates.slice(-30);

  // Color map mirrors badge-monitor-* hues so the bar reads as the same
  // visual vocabulary as the pill above it. This bar only ever emits
  // up / warning / down per sample; unknown remains the fallback color.
  var colors = {
    up:         "rgba(0,200,83,0.65)",
    warning:    "rgba(255,193,7,0.75)",
    down:       "rgba(211,47,47,0.75)",
    unknown:    "rgba(117,117,117,0.45)",
  };
  // Each cell flexes to 1fr so the bar always fills the column regardless
  // of how many samples landed in the hour. Tooltip carries the timestamp +
  // status so an operator can hover to inspect a specific dip.
  var cellHTML = states.map(function (st) {
    var ts = new Date(st.timestamp).toLocaleTimeString();
    var color = colors[st.status] || colors.unknown;
    return '<div title="' + escapeHtml(ts + " · " + st.status) + '" style="flex:1;background:' + color + '"></div>';
  }).join("");
  slot.innerHTML =
    '<div style="display:flex;height:14px;width:100%;border:1px solid var(--color-border);border-radius:3px;overflow:hidden;gap:1px;background:var(--color-bg-elevated)">' +
      cellHTML +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;font-size:0.7rem;color:var(--color-text-tertiary);margin-top:2px">' +
      '<span>30m ago</span>' +
      '<span>' + states.length + ' sample' + (states.length === 1 ? '' : 's') + '</span>' +
      '<span>now</span>' +
    '</div>';
}

/**
 * Fetches asset.updated events for one asset within the chart window and
 * returns transition markers — one per event whose change-set touched the
 * polling-method fields (responseTimePolling / cpuMemoryPolling /
 * interfacesPolling / lldpPolling) or monitorCredentialId. Each marker
 * carries { timestamp, label } so the chart can render a vertical line at
 * that timestamp with the human-readable transition string in its tooltip.
 *
 * Bounded by the events table's 7-day rolling retention. Older events
 * have been pruned and won't appear; that's acceptable for an
 * intermittency-investigation tool — the markers are most useful for
 * recent changes anyway.
 */
async function _fetchPollingTransitions(assetId, since, until) {
  var TRACKED = {
    responseTimePolling:       "Response-time polling",
    cpuMemoryPolling:          "Telemetry polling",
    interfacesPolling:         "Interfaces polling",
    lldpPolling:               "LLDP polling",
    storagePolling:            "Storage polling",
    monitorCredentialId:       "Credential",
  };
  var params = {
    resourceType: "asset",
    resourceId:   assetId,
    action:       "asset.updated",
    limit:        200,
  };
  if (since) params.since = since;
  if (until) params.until = until;
  var resp;
  try { resp = await api.events.list(params); }
  catch (_) { return []; }
  var events = (resp && resp.events) || [];
  var markers = [];
  events.forEach(function (e) {
    var changes = e && e.details && e.details.changes;
    if (!changes || typeof changes !== "object") return;
    var bits = [];
    Object.keys(TRACKED).forEach(function (field) {
      var c = changes[field];
      if (!c) return;
      // c is { from, to } per buildChanges() convention.
      var from = c.from === null || c.from === undefined ? "—" : String(c.from);
      var to   = c.to   === null || c.to   === undefined ? "—" : String(c.to);
      bits.push(TRACKED[field] + ": " + from + " → " + to);
    });
    if (bits.length === 0) return;
    markers.push({ timestamp: e.timestamp, label: bits.join("\n") });
  });
  // Server returns newest-first; sort ascending so the chart's left-to-right
  // overlay matches time order regardless.
  markers.sort(function (a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });
  return markers;
}

async function _loadMonitorHistoryFor(assetId, selection, callOpts) {
  // Cancel any pending auto-refresh — a manual range change or probe-now click
  // shouldn't race against an in-flight scheduled tick.
  if (_assetMonitorRefreshTimer) { clearTimeout(_assetMonitorRefreshTimer); _assetMonitorRefreshTimer = null; }
  var silent = !!(callOpts && callOpts.silent);
  var chart = document.getElementById("asset-monitor-chart");
  var stats = document.getElementById("asset-monitor-stats");
  if (!chart) return;
  if (!silent) {
    chart.textContent = "Loading samples…";
    if (stats) { stats.textContent = ""; delete stats.dataset.summary; }
  }
  var opts = (typeof selection === "string" || !selection) ? { range: selection || "24h" } : selection;
  // Persist selection so probe-now can refresh the same view.
  if (opts.from && opts.to) {
    chart.dataset.from = opts.from;
    chart.dataset.to = opts.to;
    delete chart.dataset.range;
  } else {
    chart.dataset.range = opts.range || "24h";
    delete chart.dataset.from;
    delete chart.dataset.to;
  }
  var panelBody = silent ? document.getElementById("asset-panel-body") : null;
  var savedScroll = panelBody ? panelBody.scrollTop : 0;
  try {
    var data = await api.assets.monitorHistory(assetId, opts);
    // Fetch transitions in parallel — failures are non-fatal (chart still
    // renders without markers). Scoped to the chart's window when available
    // so we don't pull every asset.updated event Polaris has ever seen.
    var transitions = [];
    try {
      transitions = await _fetchPollingTransitions(assetId, data && data.since, data && data.until);
    } catch (_) { /* defensive */ }
    _renderMonitorChart(chart, data, transitions);
    if (stats && data.stats) {
      var s = data.stats;
      var monitorParts = [
        { label: "Avg",         value: s.avgMs != null ? s.avgMs + " ms" : "—" },
        { label: "Min",         value: s.minMs != null ? s.minMs + " ms" : "—" },
        { label: "Max",         value: s.maxMs != null ? s.maxMs + " ms" : "—" },
        { label: "Packet loss", value: s.packetLossRate != null ? (s.packetLossRate * 100).toFixed(1) + "%" : "—" },
      ];
      var monitorTierPart = _tierStatsPart(data);
      if (monitorTierPart) monitorParts.unshift(monitorTierPart);
      _renderChartStats(stats, s.total, monitorParts);
    }
  } catch (err) {
    if (!silent) chart.textContent = "Error: " + (err.message || "failed to load history");
    // Silent ticks leave stale content in place on transient errors.
  }
  if (panelBody) {
    panelBody.scrollTop = savedScroll;
    requestAnimationFrame(function () {
      if (panelBody.scrollTop !== savedScroll) panelBody.scrollTop = savedScroll;
    });
  }
  // Custom date ranges are fixed historical windows — do not auto-refresh.
  if (opts.from && opts.to) return;
  var settings = _monitorSettingsCache || {};
  var asset = _currentAssetForRefresh;
  var ms = _refreshIntervalMs(asset && asset.monitorIntervalSec, settings.intervalSeconds, 60);
  _scheduleAssetMonitorRefresh(assetId, ms);
}

function _currentMonitorSelection() {
  var chart = document.getElementById("asset-monitor-chart");
  if (!chart) return "24h";
  if (chart.dataset.from && chart.dataset.to) {
    return { from: chart.dataset.from, to: chart.dataset.to };
  }
  return chart.dataset.range || "24h";
}

function _toLocalDatetimeInput(d) {
  // Render a Date as "YYYY-MM-DDTHH:MM" in the user's local time zone for <input type="datetime-local">.
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function _renderMonitorChart(container, data, transitions) {
  var samples = (data && data.samples) || [];
  if (samples.length === 0) {
    container.textContent = "No samples in this range yet.";
    return;
  }
  transitions = Array.isArray(transitions) ? transitions : [];
  var W = container.clientWidth || 600;
  var H = 200;
  var padL = 56, padR = 10, padT = 10, padB = 56;
  var innerW = W - padL - padR;
  var innerH = H - padT - padB;

  var bounds = _chartTimeBounds(samples, data && data.since, data && data.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0;
  var oneDayMs = 24 * 60 * 60 * 1000;
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function fmtTick(ts) {
    var d = new Date(ts);
    if (spanMs <= oneDayMs) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return (d.getMonth() + 1) + "/" + d.getDate();
  }
  function fmtDate(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + "/" + d.getDate();
  }
  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
  }

  var oks = samples.filter(function (s) { return s.success && typeof s.responseTimeMs === "number"; });
  var maxRtt = oks.length ? Math.max.apply(null, oks.map(function (s) { return s.responseTimeMs; })) : 100;
  if (maxRtt < 50) maxRtt = 50;
  // round up to a tidy ceiling
  var step = maxRtt > 1000 ? 250 : maxRtt > 200 ? 50 : 10;
  var ceil = Math.ceil(maxRtt / step) * step;

  function xFor(ts) { return padL + ((new Date(ts).getTime() - t0) / (t1 - t0)) * innerW; }
  function yFor(ms) { return padT + innerH - (ms / ceil) * innerH; }

  var pointsAttr = oks.map(function (s) { return xFor(s.timestamp) + "," + yFor(s.responseTimeMs); }).join(" ");
  var failureLines = samples.filter(function (s) { return !s.success; }).map(function (s) {
    var x = xFor(s.timestamp);
    return '<line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + (padT + innerH) + '" stroke="rgba(211,47,47,0.35)" stroke-width="1"/>';
  }).join("");

  function fmtTooltipTs(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }
  function hitAttrs(s) {
    return ' data-ts="' + escapeHtml(String(s.timestamp)) +
      '" data-rtt="' + (typeof s.responseTimeMs === "number" ? s.responseTimeMs : "") +
      '" data-ok="' + (s.success ? "1" : "0") +
      '" data-err="' + escapeHtml(s.error || "") + '"';
  }
  // Transparent hit targets so hover is forgiving for the 1.5px dots and the
  // 1px failure lines. Successful samples use a 7px circle centered on the
  // dot; failed samples use a full-height 10px rect centered on the failure
  // line (otherwise the operator has to find the vertical middle of the line
  // for the tooltip to fire — the line spans the chart but the hit target
  // didn't). Same pattern as the polling-method transition rect above.
  var hitTargets = samples.map(function (s) {
    var x = xFor(s.timestamp);
    if (s.success && typeof s.responseTimeMs === "number") {
      return '<circle class="monitor-hit" cx="' + x + '" cy="' + yFor(s.responseTimeMs) + '" r="7" fill="transparent" style="cursor:crosshair"' + hitAttrs(s) + '/>';
    }
    return '<rect class="monitor-hit" x="' + (x - 5) + '" y="' + padT + '" width="10" height="' + innerH + '" fill="transparent" style="cursor:crosshair"' + hitAttrs(s) + '/>';
  }).join("");

  // Y-axis ticks
  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = (ceil * i / 4);
    var y = padT + innerH - (v / ceil) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + Math.round(v) + '</text>';
  }

  // X-axis tick labels. When the window is ≤24h the time-only label loses the
  // date — render the date underneath the first tick and any tick whose day
  // differs from the previous one, so a window that crosses midnight is
  // unambiguous.
  var xTicks = "";
  var xTickCount = 5;
  var dateLabelMode = spanMs <= oneDayMs;
  var prevDayKey = null;
  for (var j = 0; j <= xTickCount; j++) {
    var tsTick = t0 + (t1 - t0) * (j / xTickCount);
    var xPos = padL + (j / xTickCount) * innerW;
    xTicks +=
      '<line x1="' + xPos + '" y1="' + (padT + innerH) + '" x2="' + xPos + '" y2="' + (padT + innerH + 3) + '" stroke="rgba(127,127,127,0.4)"/>' +
      '<text x="' + xPos + '" y="' + (padT + innerH + 14) + '" text-anchor="middle" font-size="10" fill="currentColor">' + fmtTick(tsTick) + '</text>';
    if (dateLabelMode) {
      var k = dayKey(tsTick);
      if (k !== prevDayKey) {
        xTicks +=
          '<text x="' + xPos + '" y="' + (padT + innerH + 26) + '" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">' + fmtDate(tsTick) + '</text>';
        prevDayKey = k;
      }
    }
  }

  // Axis titles
  var yTitleX = 14;
  var yTitleY = padT + innerH / 2;
  var yTitle = '<text class="chart-axis-title" x="' + yTitleX + '" y="' + yTitleY + '" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85" transform="rotate(-90 ' + yTitleX + ' ' + yTitleY + ')">Response time (ms)</text>';
  var xTitle = '<text class="chart-axis-title" x="' + (padL + innerW / 2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85">Time</text>';

  // Polling-method transition markers — vertical amber dashed lines at
  // events where any *Polling field or monitorCredentialId changed. Filter
  // to within the chart window so off-screen transitions
  // don't smear at the edges. A hit-target rectangle around each line
  // makes the hover forgiving without tying tooltip behaviour to the 1.5px
  // stroke. Tooltip text comes from the marker's data-label.
  var transitionLayer = transitions
    .map(function (m) { return { ts: new Date(m.timestamp).getTime(), label: m.label, raw: m.timestamp }; })
    .filter(function (m) { return m.ts >= t0 && m.ts <= t1; })
    .map(function (m) {
      var x = xFor(m.raw);
      return '<line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + (padT + innerH) + '" stroke="rgba(255,193,7,0.55)" stroke-width="1.5" stroke-dasharray="3,3"/>' +
        '<circle cx="' + x + '" cy="' + (padT - 2) + '" r="3" fill="rgba(255,193,7,0.9)" stroke="rgba(0,0,0,0.3)" stroke-width="0.5"/>' +
        '<rect class="monitor-transition" x="' + (x - 5) + '" y="' + padT + '" width="10" height="' + innerH + '" fill="transparent" style="cursor:help"' +
          ' data-ts="' + escapeHtml(String(m.raw)) + '" data-label="' + escapeHtml(m.label) + '"/>';
    }).join("");

  var clipId = _chartClipId("monitor");
  var svg =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      ticks +
      xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      transitionLayer +
      yTitle +
      xTitle +
      '<g ' + _chartClipAttr(clipId) + '>' +
        failureLines +
        (pointsAttr ? '<polyline points="' + pointsAttr + '" fill="none" stroke="var(--color-accent)" stroke-width="1.5"/>' : '') +
        oks.map(function (s) {
          return '<circle cx="' + xFor(s.timestamp) + '" cy="' + yFor(s.responseTimeMs) + '" r="1.5" fill="var(--color-accent)"/>';
        }).join("") +
        hitTargets +
      '</g>' +
    '</svg>' +
    '<div class="monitor-tooltip" style="position:absolute;pointer-events:none;display:none;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:4px;padding:6px 8px;font-size:0.75rem;line-height:1.35;color:var(--color-text);box-shadow:0 4px 12px rgba(0,0,0,0.25);white-space:nowrap;z-index:5"></div>';
  container.innerHTML = svg;
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  container.style.position = "relative";

  var tip = container.querySelector(".monitor-tooltip");
  var svgEl = container.querySelector("svg");
  function positionTip(evt) {
    var rect = container.getBoundingClientRect();
    var x = evt.clientX - rect.left + 12;
    var y = evt.clientY - rect.top + 12;
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    if (x + tw > container.clientWidth - 4) x = evt.clientX - rect.left - tw - 12;
    if (y + th > container.clientHeight - 4) y = evt.clientY - rect.top - th - 12;
    if (x < 4) x = 4;
    if (y < 4) y = 4;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }
  function showTip(target, evt) {
    var ts = target.getAttribute("data-ts");
    var rtt = target.getAttribute("data-rtt");
    var ok = target.getAttribute("data-ok") === "1";
    var err = target.getAttribute("data-err");
    var rttLine = ok && rtt !== "" ? (escapeHtml(rtt) + " ms") : '<span style="color:var(--color-danger,#d32f2f)">no response</span>';
    var lossLine = ok ? "no" : '<span style="color:var(--color-danger,#d32f2f)">yes</span>';
    var errLine = !ok && err ? '<div style="color:var(--color-text-secondary);margin-top:2px">' + escapeHtml(err) + '</div>' : '';
    tip.innerHTML =
      '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(fmtTooltipTs(ts)) + '</div>' +
      '<div>Response: ' + rttLine + '</div>' +
      '<div>Packet loss: ' + lossLine + '</div>' +
      errLine;
    tip.style.display = "block";
    positionTip(evt);
  }
  // Hover tooltip for the amber polling-method transition lines.
  // Multiline labels render with each transition on its own line.
  function showTransitionTip(target, evt) {
    var ts    = target.getAttribute("data-ts");
    var label = target.getAttribute("data-label") || "";
    var lines = label.split("\n").map(function (l) {
      return '<div>' + escapeHtml(l) + '</div>';
    }).join("");
    tip.innerHTML =
      '<div style="font-weight:600;margin-bottom:2px;color:#ffc107">⚙ Polling change</div>' +
      '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(fmtTooltipTs(ts)) + '</div>' +
      lines;
    tip.style.display = "block";
    positionTip(evt);
  }
  svgEl.addEventListener("mousemove", function (evt) {
    var t = evt.target;
    if (!t || !t.classList) { tip.style.display = "none"; return; }
    // Transition rect takes priority — operators investigating intermittency
    // want to see the polling-method change first when their cursor lands on
    // both a sample dot and a transition line.
    if (t.classList.contains("monitor-transition")) {
      showTransitionTip(t, evt);
    } else if (t.classList.contains("monitor-hit")) {
      showTip(t, evt);
    } else {
      tip.style.display = "none";
    }
  });
  svgEl.addEventListener("mouseleave", function () { tip.style.display = "none"; });
  _addChartScreenshotButton(container, "Response time", {
    yAxis: "Response time (ms)",
    getStats: function () {
      var el = document.getElementById("asset-monitor-stats");
      return (el && el.dataset.summary) || "";
    },
  });
  _observeChartResize(container, function (c) { _renderMonitorChart(c, data); });
}

// ─── Nested interface details slide-over ───────────────────────────────────
//
// Sits on top of #asset-panel-overlay. Closing only this overlay returns the
// user to the asset details panel underneath — that's why we do NOT touch
// closeAssetPanel from here. Three charts: input throughput, output
// throughput, and errors. Each chart reuses _wireChartTooltip so hover
// behaviour matches the response-time chart.

function _ensureIfacePanelDOM() {
  if (document.getElementById("iface-panel-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "iface-panel-overlay";
  overlay.className = "slideover-overlay slideover-nested";
  // Sit above the asset panel (z-index 999/1000) so the inner panel is on top.
  overlay.style.zIndex = "1099";
  overlay.innerHTML =
    '<div class="slideover" id="iface-panel" style="z-index:1100">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="iface-panel-title">Interface</h3>' +
          '<button class="btn-icon" id="iface-panel-close" title="Close">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta" id="iface-panel-meta"></div>' +
      '</div>' +
      '<div class="slideover-body" id="iface-panel-body"><p class="empty-state" style="padding:1rem 1.25rem">Loading…</p></div>' +
      '<div class="slideover-footer" id="iface-panel-footer"></div>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeIfacePanel();
  });
  document.getElementById("iface-panel-close").addEventListener("click", closeIfacePanel);
  initSlideoverResize(document.getElementById("iface-panel"), "polaris.panel.width.iface");
}

function closeIfacePanel() {
  var ov = document.getElementById("iface-panel-overlay");
  if (ov) ov.classList.remove("open");
  _clearIfaceRefreshTimer();
}

async function openInterfaceDetailPanel(asset, ifName, ifaceRow) {
  if (!asset || !ifName) return;
  _ensureIfacePanelDOM();
  var titleEl  = document.getElementById("iface-panel-title");
  var metaEl   = document.getElementById("iface-panel-meta");
  var bodyEl   = document.getElementById("iface-panel-body");
  var footerEl = document.getElementById("iface-panel-footer");
  // Title shows whatever label we already know from the system-info row, if any.
  // The interface-history response will refine it once the request lands —
  // operator-set alias overrides ifName, with the real ifName kept as subtitle.
  titleEl.textContent = "Interface — " + ifName;
  metaEl.textContent = asset.hostname || asset.ipAddress || asset.id;
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>';
  footerEl.innerHTML =
    '<button class="btn btn-sm btn-secondary" id="btn-iface-panel-screenshot">Screenshot</button>' +
    '<span style="flex:1"></span>' +
    '<button class="btn btn-sm btn-secondary" id="btn-iface-panel-close-btn">Close</button>';
  requestAnimationFrame(function () {
    document.getElementById("iface-panel-overlay").classList.add("open");
  });
  document.getElementById("btn-iface-panel-close-btn").addEventListener("click", closeIfacePanel);
  document.getElementById("btn-iface-panel-screenshot").addEventListener("click", function () {
    _screenshotInterfacePanel(asset, ifName);
  });

  var rangeBtns = _chartRangeBtnsHTML("iface-range-btn", [
    { value: "1h",  label: "1h" },
    { value: "24h", label: "24h" },
    { value: "7d",  label: "7d" },
    { value: "30d", label: "30d" },
    { value: "custom", label: "Custom…", id: "btn-iface-custom" },
  ], "assetInterface", "1h");
  var ifaceCustomPanel =
    '<div id="iface-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
      '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="iface-custom-from" class="form-input" style="padding:2px 6px"></label>' +
      '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="iface-custom-to" class="form-input" style="padding:2px 6px"></label>' +
      '<button class="btn btn-sm btn-primary" id="btn-iface-custom-apply">Apply</button>' +
    '</div>';

  var canEditComment = canManageAssets();
  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      '<div id="iface-comment-block" style="margin-bottom:0.75rem">' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:0.25rem">' +
          '<label for="iface-comment-input" style="font-size:0.8rem;font-weight:600;color:var(--color-text-secondary)">Interface Comments</label>' +
          '<span id="iface-comment-count" style="font-size:0.75rem;color:var(--color-text-secondary)"></span>' +
        '</div>' +
        '<textarea id="iface-comment-input" rows="2" maxlength="255" placeholder="' +
          (canEditComment ? 'Add a comment for this interface (max 255 chars). Polaris-local — not pushed to the device.' : 'Read-only — requires Assets Admin to edit.') +
          '" style="width:100%;box-sizing:border-box;padding:0.4rem 0.5rem;font-size:0.85rem;font-family:inherit;background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;color:var(--color-text);resize:vertical"' +
          (canEditComment ? '' : ' disabled') +
          '></textarea>' +
        '<div id="iface-comment-source" style="margin-top:0.25rem;font-size:0.75rem;color:var(--color-text-secondary)"></div>' +
        (canEditComment
          ? '<div style="display:flex;justify-content:flex-end;gap:6px;margin-top:0.4rem">' +
              '<button class="btn btn-sm btn-secondary" id="btn-iface-comment-revert" disabled>Revert</button>' +
              '<button class="btn btn-sm btn-primary" id="btn-iface-comment-save" disabled>Save</button>' +
            '</div>'
          : '') +
      '</div>' +
      _ifaceVlanBlockHTML(ifaceRow) +
      '<div id="iface-lldp-block" style="margin-bottom:0.75rem"></div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
        '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
          '<h4 style="margin:0">Throughput &amp; errors</h4>' +
          _streamSourceBadgeHTML(asset, "interfaces") +
        '</div>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
      ifaceCustomPanel +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Throughput (bps)</h5>' +
      '<div id="iface-tput-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<div id="iface-tput-chart" class="iface-chart-box"></div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Errors per interval (in / out)</h5>' +
      '<div id="iface-err-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<div id="iface-err-chart" class="iface-chart-box"></div>' +
    '</div>';
  document.querySelectorAll(".iface-chart-box").forEach(function (el) {
    el.style.background = "var(--color-bg-elevated)";
    el.style.border = "1px solid var(--color-border)";
    el.style.borderRadius = "6px";
    el.style.padding = "0.5rem";
    el.style.minHeight = "180px";
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.color = "var(--color-text-secondary)";
    el.style.fontSize = "0.85rem";
  });

  await _loadInterfaceHistoryFor(asset.id, ifName, _getChartRangePref("assetInterface", "1h"));
  // Async overwrite the badge with the authoritative resolved polling method.
  _updateStreamSourceBadgesFromEffective(asset.id, asset);
  document.querySelectorAll(".iface-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      var panel = document.getElementById("iface-custom-panel");
      if (range === "custom") {
        if (!panel) return;
        var willOpen = panel.style.display === "none";
        panel.style.display = willOpen ? "flex" : "none";
        if (willOpen) {
          var toInput   = document.getElementById("iface-custom-to");
          var fromInput = document.getElementById("iface-custom-from");
          if (toInput && !toInput.value) toInput.value = _toLocalDatetimeInput(new Date());
          if (fromInput && !fromInput.value) fromInput.value = _toLocalDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000));
        }
        return;
      }
      if (panel) panel.style.display = "none";
      document.querySelectorAll(".iface-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _setChartRangePref("assetInterface", range);
      _loadInterfaceHistoryFor(asset.id, ifName, range);
    });
  });
  var ifaceCustomApply = document.getElementById("btn-iface-custom-apply");
  if (ifaceCustomApply) {
    ifaceCustomApply.addEventListener("click", function () {
      var fromInput = document.getElementById("iface-custom-from");
      var toInput   = document.getElementById("iface-custom-to");
      if (!fromInput.value || !toInput.value) { showToast("Enter both From and To", "error"); return; }
      var fromIso = new Date(fromInput.value).toISOString();
      var toIso   = new Date(toInput.value).toISOString();
      if (new Date(fromIso) >= new Date(toIso)) { showToast("From must be before To", "error"); return; }
      document.querySelectorAll(".iface-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      var customBtn = document.getElementById("btn-iface-custom");
      if (customBtn) { customBtn.classList.remove("btn-secondary"); customBtn.classList.add("btn-primary"); }
      _loadInterfaceHistoryFor(asset.id, ifName, { from: fromIso, to: toIso });
    });
  }
}

async function _loadInterfaceHistoryFor(assetId, ifName, range, callOpts) {
  // Cancel any pending auto-refresh — manual range change shouldn't race a tick.
  if (_ifaceRefreshTimer) { clearTimeout(_ifaceRefreshTimer); _ifaceRefreshTimer = null; }
  var silent = !!(callOpts && callOpts.silent);
  var tputEl = document.getElementById("iface-tput-chart");
  var errEl = document.getElementById("iface-err-chart");
  var tputStats = document.getElementById("iface-tput-stats");
  var errStats  = document.getElementById("iface-err-stats");
  if (!tputEl) return;
  if (!silent) {
    tputEl.textContent = errEl.textContent = "Loading samples…";
    if (tputStats) tputStats.textContent = "Loading…";
    if (errStats)  errStats.textContent  = "Loading…";
  }
  var panelBody = silent ? document.getElementById("iface-panel-body") : null;
  var savedScroll = panelBody ? panelBody.scrollTop : 0;
  // Accept range as a string or `{from, to}` object (canonical convention).
  var opts = (typeof range === "string" || !range) ? { range: range || "1h" } : range;
  try {
    var data = await api.assets.interfaceHistory(assetId, ifName, opts);
    var derived = _derivePerIntervalSeries(data.samples || [], data);
    _renderIfaceThroughputStats(tputStats, data.samples || [], derived, data);
    _renderIfaceErrorStats(errStats, data.samples || [], derived, data);
    // Refine the title now that we know the alias; show the operator comment
    // when present.
    var titleEl = document.getElementById("iface-panel-title");
    if (titleEl) {
      titleEl.textContent = "Interface — " + (data.alias && data.alias.trim() ? data.alias.trim() + " (" + ifName + ")" : ifName);
    }
    _populateInterfaceCommentEditor(assetId, ifName, data, { silent: silent });
    _renderIfaceLldpBlock(data.lldpNeighbors || []);
    var ifaceOpts = { since: data.since, until: data.until, subject: ifName };
    _renderIfaceThroughputChart(tputEl, derived, ifaceOpts);
    _renderIfaceErrorChart(errEl, derived, ifaceOpts);
    // Stash the active selection on each chart container so silent ticks /
    // probe-now refetch the same view (canonical convention).
    if (opts.from && opts.to) {
      tputEl.dataset.from = errEl.dataset.from = opts.from;
      tputEl.dataset.to   = errEl.dataset.to   = opts.to;
      delete tputEl.dataset.range; delete errEl.dataset.range;
    } else {
      tputEl.dataset.range = errEl.dataset.range = opts.range || "1h";
      delete tputEl.dataset.from; delete errEl.dataset.from;
      delete tputEl.dataset.to;   delete errEl.dataset.to;
    }
  } catch (err) {
    if (!silent) {
      tputEl.textContent = errEl.textContent = "Error: " + (err.message || "failed to load");
      if (tputStats) tputStats.textContent = "";
      if (errStats)  errStats.textContent  = "";
    }
    // Silent ticks leave stale content in place on transient errors.
  }
  if (panelBody) {
    panelBody.scrollTop = savedScroll;
    requestAnimationFrame(function () {
      if (panelBody.scrollTop !== savedScroll) panelBody.scrollTop = savedScroll;
    });
  }
  // Custom date ranges are fixed historical windows — do not auto-refresh.
  if (opts.from && opts.to) return;
  // Schedule next auto-refresh on the response-time cadence — pinned interfaces
  // ride that cadence on the backend (collectInterfacesFiltered).
  var settings = _monitorSettingsCache || {};
  var asset = _currentAssetForRefresh;
  var ms = _refreshIntervalMs(asset && asset.monitorIntervalSec, settings.intervalSeconds, 60);
  _scheduleIfaceRefresh(assetId, ifName, ms);
}

// Per-panel state for the Interface Comments editor. Tracks the saved value
// so we can detect dirty edits, and the discovered description so the source
// label below the textarea reflects whether the override is hiding a CMDB
// description. Cleared on every panel open.
var _ifaceCommentState = null;

function _populateInterfaceCommentEditor(assetId, ifName, data, opts) {
  var input = document.getElementById("iface-comment-input");
  if (!input) return;
  var countEl  = document.getElementById("iface-comment-count");
  var saveBtn  = document.getElementById("btn-iface-comment-save");
  var revertBtn = document.getElementById("btn-iface-comment-revert");
  var silent = !!(opts && opts.silent);

  var savedValue = (data && typeof data.overrideDescription === "string")
    ? data.overrideDescription
    : (data && typeof data.description === "string" && data.overrideDescription == null
        ? "" /* discovered-only, override is empty */
        : "");
  var discoveredDescription = (data && data.discoveredDescription) || "";

  // Don't clobber in-progress typing on auto-refresh ticks. Range changes
  // (silent=false) always re-populate so the user sees the latest value.
  var stateMatches = _ifaceCommentState
    && _ifaceCommentState.assetId === assetId
    && _ifaceCommentState.ifName === ifName;
  var isDirty = stateMatches && _ifaceCommentState.dirty;

  if (silent && isDirty) {
    // Refresh the discovered description hint silently; leave input alone.
    _ifaceCommentState.savedValue = savedValue;
    _ifaceCommentState.discoveredDescription = discoveredDescription;
    _renderIfaceCommentSource(_ifaceCommentState);
    return;
  }

  _ifaceCommentState = {
    assetId: assetId,
    ifName: ifName,
    savedValue: savedValue,
    discoveredDescription: discoveredDescription,
    dirty: false,
  };
  input.value = savedValue;
  // Show the device-reported description as ghost text when no override is
  // set, so the operator can see what's currently being shown in lists
  // before deciding to type over it.
  if (!input.disabled) {
    input.placeholder = discoveredDescription
      ? "Device says: " + discoveredDescription
      : "Add a comment for this interface (max 255 chars). Polaris-local — not pushed to the device.";
  }
  if (countEl) countEl.textContent = input.value.length + " / 255";
  if (saveBtn) saveBtn.disabled = true;
  if (revertBtn) revertBtn.disabled = true;
  _renderIfaceCommentSource(_ifaceCommentState);

  if (!input._ifaceCommentWired) {
    input._ifaceCommentWired = true;
    input.addEventListener("input", function () {
      if (!_ifaceCommentState) return;
      _ifaceCommentState.dirty = input.value !== _ifaceCommentState.savedValue;
      if (countEl) countEl.textContent = input.value.length + " / 255";
      if (saveBtn) saveBtn.disabled = !_ifaceCommentState.dirty;
      if (revertBtn) revertBtn.disabled = !_ifaceCommentState.dirty;
    });
    if (saveBtn) {
      saveBtn.addEventListener("click", _saveIfaceComment);
    }
    if (revertBtn) {
      revertBtn.addEventListener("click", function () {
        if (!_ifaceCommentState) return;
        input.value = _ifaceCommentState.savedValue;
        _ifaceCommentState.dirty = false;
        if (countEl) countEl.textContent = input.value.length + " / 255";
        if (saveBtn) saveBtn.disabled = true;
        if (revertBtn) revertBtn.disabled = true;
        _renderIfaceCommentSource(_ifaceCommentState);
      });
    }
  }
}

function _renderIfaceCommentSource(state) {
  var sourceEl = document.getElementById("iface-comment-source");
  if (!sourceEl || !state) return;
  if (state.savedValue) {
    if (state.discoveredDescription && state.discoveredDescription !== state.savedValue) {
      sourceEl.textContent = "Override active. Device reports: " + state.discoveredDescription;
    } else {
      sourceEl.textContent = "Polaris-local override (not pushed to device).";
    }
  } else if (state.discoveredDescription) {
    sourceEl.textContent = "Showing device-reported description. Type here to override (Polaris-local only).";
  } else {
    sourceEl.textContent = "No comment set on this interface.";
  }
}

async function _saveIfaceComment() {
  if (!_ifaceCommentState) return;
  var input = document.getElementById("iface-comment-input");
  var saveBtn = document.getElementById("btn-iface-comment-save");
  var revertBtn = document.getElementById("btn-iface-comment-revert");
  if (!input) return;
  var value = input.value;
  if (value.length > 255) {
    showToast("Interface Comments must be 255 characters or fewer", "error");
    return;
  }
  var assetId = _ifaceCommentState.assetId;
  var ifName  = _ifaceCommentState.ifName;
  var prevDisabled = saveBtn ? saveBtn.disabled : false;
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
  try {
    var resp = await api.assets.setInterfaceComment(assetId, ifName, value);
    var newSaved = (resp && typeof resp.description === "string") ? resp.description : (value.trim() ? value : "");
    if (_ifaceCommentState && _ifaceCommentState.assetId === assetId && _ifaceCommentState.ifName === ifName) {
      _ifaceCommentState.savedValue = newSaved;
      _ifaceCommentState.dirty = input.value !== newSaved;
      input.value = newSaved;
      if (revertBtn) revertBtn.disabled = !_ifaceCommentState.dirty;
      _renderIfaceCommentSource(_ifaceCommentState);
    }
    showToast("Interface comment saved", "success");
  } catch (err) {
    showToast("Save failed: " + (err && err.message ? err.message : "unknown error"), "error");
  } finally {
    if (saveBtn) { saveBtn.textContent = "Save"; saveBtn.disabled = _ifaceCommentState ? !_ifaceCommentState.dirty : prevDisabled; }
  }
}

// Convert per-bucket counter endpoints (rollup tier) or cumulative
// octet/error counters (detail tier) into the {timestamp, inBps, outBps,
// inErr, outErr} shape the throughput + error charts consume.
//
// Detail tier (`bucketSeconds === 0` or absent): diff each pair of
// consecutive samples; negative deltas (counter wraps / device reboots)
// are dropped, matching the long-standing detail-tier behavior.
//
// Rollup tier (`bucketSeconds > 0`): the server already pre-computed
// `*BytesPerSec` / `*ErrorsPerSec` from the bucket's first/last counter
// values. We emit one derived point per rollup row — no diff. Bits/sec
// charts multiply bytes-per-sec by 8. The error-count series multiplies
// errors-per-sec by `bucketSeconds` so each derived point shows "errors
// in this bucket" — same semantic as detail tier's "errors in this
// interval", just at a coarser granularity.
function _derivePerIntervalSeries(samples, data) {
  if (data && typeof data.bucketSeconds === "number" && data.bucketSeconds > 0) {
    var bucketSec = data.bucketSeconds;
    return (samples || []).map(function (s) {
      var inBps  = typeof s.inBytesPerSec  === "number" ? s.inBytesPerSec  * 8 : null;
      var outBps = typeof s.outBytesPerSec === "number" ? s.outBytesPerSec * 8 : null;
      var inErr  = typeof s.inErrorsPerSec  === "number" ? Math.round(s.inErrorsPerSec  * bucketSec) : null;
      var outErr = typeof s.outErrorsPerSec === "number" ? Math.round(s.outErrorsPerSec * bucketSec) : null;
      return { timestamp: s.timestamp, inBps: inBps, outBps: outBps, inErr: inErr, outErr: outErr };
    });
  }
  var out = [];
  for (var i = 1; i < samples.length; i++) {
    var prev = samples[i - 1];
    var cur  = samples[i];
    var dtMs = new Date(cur.timestamp) - new Date(prev.timestamp);
    if (dtMs <= 0) continue;
    var dtSec = dtMs / 1000;
    function delta(a, b) {
      if (typeof a !== "number" || typeof b !== "number") return null;
      var d = b - a;
      return d < 0 ? null : d;
    }
    var inOct  = delta(prev.inOctets,  cur.inOctets);
    var outOct = delta(prev.outOctets, cur.outOctets);
    var inErr  = delta(prev.inErrors,  cur.inErrors);
    var outErr = delta(prev.outErrors, cur.outErrors);
    out.push({
      timestamp: cur.timestamp,
      inBps:  inOct  != null ? (inOct  * 8) / dtSec : null,
      outBps: outOct != null ? (outOct * 8) / dtSec : null,
      inErr:  inErr,
      outErr: outErr,
    });
  }
  return out;
}

function _renderIfaceThroughputStats(container, rawSamples, derived, data) {
  if (!container) return;
  var inMax = 0, outMax = 0, inSum = 0, outSum = 0, inN = 0, outN = 0;
  derived.forEach(function (d) {
    if (typeof d.inBps  === "number") { inSum  += d.inBps;  inN++;  if (d.inBps  > inMax)  inMax  = d.inBps; }
    if (typeof d.outBps === "number") { outSum += d.outBps; outN++; if (d.outBps > outMax) outMax = d.outBps; }
  });
  var ifaceTputParts = [
    { label: "In avg",   value: _fmtBitsPerSec(inN  ? inSum  / inN  : 0) },
    { label: "In peak",  value: _fmtBitsPerSec(inMax) },
    { label: "Out avg",  value: _fmtBitsPerSec(outN ? outSum / outN : 0) },
    { label: "Out peak", value: _fmtBitsPerSec(outMax) },
  ];
  var ifaceTputTierPart = _tierStatsPart(data);
  if (ifaceTputTierPart) ifaceTputParts.unshift(ifaceTputTierPart);
  _renderChartStats(container, rawSamples.length, ifaceTputParts);
}

function _renderIfaceErrorStats(container, rawSamples, derived, data) {
  if (!container) return;
  var errIn = 0, errOut = 0;
  derived.forEach(function (d) {
    if (typeof d.inErr  === "number") errIn  += d.inErr;
    if (typeof d.outErr === "number") errOut += d.outErr;
  });
  var ifaceErrParts = [
    { label: "In errors",  value: String(errIn) },
    { label: "Out errors", value: String(errOut) },
    { label: "Total",      value: String(errIn + errOut) },
  ];
  var ifaceErrTierPart = _tierStatsPart(data);
  if (ifaceErrTierPart) ifaceErrParts.unshift(ifaceErrTierPart);
  _renderChartStats(container, rawSamples.length, ifaceErrParts);
}

// Render the LLDP neighbor card inside the interface slide-over. Empty when
// the interface has no neighbors. When the neighbor's chassis/management info
// resolves to an existing Polaris asset, the system-name link opens that
// asset's view modal so the operator can pivot from one device to the next.
// VLAN summary card for the interface slide-over. Renders only when the
// passed-in row carries nativeVlan or taggedVlans (i.e. managed FortiSwitch
// ports overlaid from the parent FortiGate's CMDB). Other asset types and
// SNMP-only paths on non-Fortinet switches return empty markup so the
// surrounding layout stays unchanged.
function _ifaceVlanBlockHTML(iface) {
  if (!iface) return "";
  var native = (iface.nativeVlan != null) ? iface.nativeVlan : null;
  var tagged = Array.isArray(iface.taggedVlans) ? iface.taggedVlans : [];
  var trunkAll = iface.trunksAllVlans === true;
  if (native == null && tagged.length === 0 && !trunkAll) return "";
  // Role pill: trunk-all wins over explicit-list trunk wins over access.
  // Operationally these are three distinct states and the badge must show
  // which one without forcing the operator to read the body of the card.
  var role = trunkAll ? "Trunk (all)" : (tagged.length === 0 ? "Access" : "Trunk");
  var nativeBit = native != null
    ? '<div><span style="font-size:0.75rem;color:var(--color-text-secondary)">Native VLAN</span> ' +
        '<span class="mono" style="margin-left:6px">' + escapeHtml(String(native)) + '</span></div>'
    : "";
  var taggedBit;
  if (trunkAll) {
    taggedBit = '<div style="margin-top:0.25rem"><span style="font-size:0.75rem;color:var(--color-text-secondary)">Allowed VLANs</span> ' +
      '<span class="mono" style="margin-left:6px">all</span>' +
      (tagged.length > 0
        ? ' <span style="font-size:0.7rem;color:var(--color-text-secondary)">(' + tagged.length + ' explicitly listed: ' + escapeHtml(tagged.join(", ")) + ')</span>'
        : "") +
    '</div>';
  } else if (tagged.length > 0) {
    taggedBit = '<div style="margin-top:0.25rem"><span style="font-size:0.75rem;color:var(--color-text-secondary)">Tagged VLANs</span> ' +
      '<span class="mono" style="margin-left:6px">' + escapeHtml(tagged.join(", ")) + '</span> ' +
      '<span style="font-size:0.7rem;color:var(--color-text-secondary)">(' + tagged.length + ')</span>' +
    '</div>';
  } else {
    taggedBit = "";
  }
  return '<div style="margin-bottom:0.75rem;padding:0.5rem 0.65rem;background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px">' +
    '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:0.25rem">' +
      '<span style="font-size:0.8rem;font-weight:600;color:var(--color-text-secondary)">VLAN</span>' +
      '<span style="font-size:0.7rem;padding:1px 5px;border-radius:3px;background:#0d948818;color:#0d9488;border:1px solid #0d948830">' + escapeHtml(role) + '</span>' +
    '</div>' +
    nativeBit +
    taggedBit +
  '</div>';
}

function _renderIfaceLldpBlock(neighbors) {
  var container = document.getElementById("iface-lldp-block");
  if (!container) return;
  if (!neighbors || neighbors.length === 0) {
    container.innerHTML = "";
    return;
  }
  var html =
    '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:0.25rem">' +
      '<label style="font-size:0.8rem;font-weight:600;color:var(--color-text-secondary)">LLDP Neighbor' + (neighbors.length > 1 ? "s" : "") + '</label>' +
      '<span style="font-size:0.7rem;color:var(--color-text-secondary)">' +
        (neighbors[0] && neighbors[0].source ? neighbors[0].source.toUpperCase() : "") +
      '</span>' +
    '</div>';
  html += '<div style="display:flex;flex-direction:column;gap:0.4rem">';
  neighbors.forEach(function (n) {
    var inferred = n.source === "peer-inferred";
    var inferredTitle = "Inferred from peer's reported uplink (no direct LLDP from this device)";
    var cardStyle = "background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;padding:0.5rem 0.6rem";
    if (inferred) cardStyle += ";font-style:italic";
    var cardTitle = inferred ? ' title="' + escapeHtml(inferredTitle) + '"' : "";
    var label = n.systemName || n.chassisId || n.managementIp || "Unknown neighbor";
    var titleHtml = n.matchedAsset && n.matchedAsset.id
      ? '<a href="#" class="iface-lldp-asset-link" data-asset-id="' + escapeHtml(n.matchedAsset.id) + '" style="color:var(--color-accent);text-decoration:none;font-weight:600">' + escapeHtml(label) + '</a>'
      : '<span style="font-weight:600">' + escapeHtml(label) + '</span>';
    var rows = [];
    if (n.portId)               rows.push(["Remote port",     escapeHtml(n.portId) + (n.portDescription ? ' <span style="opacity:0.7">— ' + escapeHtml(n.portDescription) + '</span>' : "")]);
    else if (n.portDescription) rows.push(["Remote port",     escapeHtml(n.portDescription)]);
    if (n.chassisId)            rows.push(["Chassis ID",      '<span class="mono">' + escapeHtml(n.chassisId) + '</span>' + (n.chassisIdSubtype ? ' <span style="opacity:0.7">(' + escapeHtml(n.chassisIdSubtype) + ')</span>' : "")]);
    if (n.managementIp)         rows.push(["Management IP",   '<span class="mono">' + escapeHtml(n.managementIp) + '</span>']);
    if (n.capabilities && n.capabilities.length > 0) {
      rows.push(["Capabilities", n.capabilities.map(function (c) {
        return '<span style="font-size:0.7rem;padding:1px 5px;border-radius:3px;background:#3b82f618;color:#3b82f6;border:1px solid #3b82f630;margin-right:3px">' + escapeHtml(c) + '</span>';
      }).join("")]);
    }
    if (n.systemDescription)    rows.push(["System description", '<span style="font-size:0.8rem">' + escapeHtml(n.systemDescription) + '</span>']);
    if (inferred)               rows.push(["Source", '<span style="font-size:0.78rem;color:var(--color-text-secondary)">Inferred from peer&rsquo;s reported uplink</span>']);
    var rowHtml = rows.map(function (r) {
      return '<div style="display:flex;gap:0.5rem;font-size:0.8rem"><div style="width:140px;color:var(--color-text-secondary);flex-shrink:0">' + r[0] + '</div><div style="flex:1;min-width:0;word-break:break-word">' + r[1] + '</div></div>';
    }).join("");
    var matchHint = n.matchedAsset
      ? ''
      : ' <span style="font-size:0.7rem;padding:1px 5px;border-radius:3px;background:#6b728018;color:#9ca3af;border:1px solid #6b728030;margin-left:6px" title="No Polaris asset matched this neighbor by management IP, chassis MAC, or hostname">unmatched</span>';
    html +=
      '<div style="' + cardStyle + '"' + cardTitle + '>' +
        '<div style="margin-bottom:0.4rem">' + titleHtml + matchHint + '</div>' +
        rowHtml +
      '</div>';
  });
  html += '</div>';
  container.innerHTML = html;
  container.querySelectorAll(".iface-lldp-asset-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      var id = link.getAttribute("data-asset-id");
      if (id) openViewModal(id);
    });
  });
}

// Combined input + output throughput on a single chart. Two color-coded lines
// share one bps y-axis (autoscaled to the higher of the two peaks) and one
// hover tooltip that names both values at the same timestamp.
function _renderIfaceThroughputChart(container, derived, opts) {
  opts = opts || {};
  var inSeries  = derived.filter(function (d) { return typeof d.inBps  === "number"; });
  var outSeries = derived.filter(function (d) { return typeof d.outBps === "number"; });
  if (inSeries.length === 0 && outSeries.length === 0) {
    container.textContent = "No throughput samples yet — fast-cadence polling is required for sub-minute resolution.";
    return;
  }
  var W = container.clientWidth || 600, H = 180;
  var padL = 56, padR = 10, padT = 14, padB = 32;
  var innerW = W - padL - padR, innerH = H - padT - padB;
  var bounds = _chartTimeBounds(derived, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function fmtTick(ts) {
    var d = new Date(ts);
    if (spanMs <= oneDayMs) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return (d.getMonth() + 1) + "/" + d.getDate();
  }
  var maxV = 0;
  inSeries.forEach (function (d) { if (d.inBps  > maxV) maxV = d.inBps;  });
  outSeries.forEach(function (d) { if (d.outBps > maxV) maxV = d.outBps; });
  if (maxV < 1000) maxV = 1000;
  function tidyCeil(n) {
    var exp = Math.pow(10, Math.floor(Math.log10(n)));
    var mant = n / exp;
    var step = mant <= 1 ? 1 : mant <= 2 ? 2 : mant <= 5 ? 5 : 10;
    return step * exp;
  }
  var ceil = tidyCeil(maxV);

  function xFor(ts) { return padL + ((new Date(ts).getTime() - t0) / (t1 - t0)) * innerW; }
  function yFor(v) { return padT + innerH - (v / ceil) * innerH; }

  var inPts  = inSeries .map(function (d) { return xFor(d.timestamp) + "," + yFor(d.inBps);  }).join(" ");
  var outPts = outSeries.map(function (d) { return xFor(d.timestamp) + "," + yFor(d.outBps); }).join(" ");

  // Single hit point per timestamp so the tooltip names both values together.
  var hits = derived.map(function (d) {
    var hasIn  = typeof d.inBps  === "number";
    var hasOut = typeof d.outBps === "number";
    if (!hasIn && !hasOut) return "";
    // Anchor the hit at whichever line is higher so the cursor lands close to a visible curve.
    var hi = hasIn && hasOut ? Math.max(d.inBps, d.outBps) : (hasIn ? d.inBps : d.outBps);
    return '<circle class="chart-hit" cx="' + xFor(d.timestamp) + '" cy="' + yFor(hi) + '" r="6" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(d.timestamp)) + '"' +
      ' data-in="'  + (hasIn  ? d.inBps  : "") + '"' +
      ' data-out="' + (hasOut ? d.outBps : "") + '"/>';
  }).join("");

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = ceil * i / 4;
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + _fmtBitsPerSecAxis(v) + '</text>';
  }
  var xTicks = "";
  for (var j = 0; j <= 5; j++) {
    var tsTick = t0 + (t1 - t0) * (j / 5);
    var xPos = padL + (j / 5) * innerW;
    xTicks +=
      '<line x1="' + xPos + '" y1="' + (padT + innerH) + '" x2="' + xPos + '" y2="' + (padT + innerH + 3) + '" stroke="rgba(127,127,127,0.4)"/>' +
      '<text x="' + xPos + '" y="' + (padT + innerH + 14) + '" text-anchor="middle" font-size="10" fill="currentColor">' + fmtTick(tsTick) + '</text>';
  }
  var inColor  = "var(--color-accent)";
  var outColor = "#f4a261";
  var legend =
    '<g font-size="10" fill="currentColor">' +
      '<rect x="' + (padL + 4)   + '" y="2" width="10" height="10" fill="' + inColor  + '"/>' +
      '<text x="' + (padL + 18)  + '" y="11">Input</text>' +
      '<rect x="' + (padL + 70)  + '" y="2" width="10" height="10" fill="' + outColor + '"/>' +
      '<text x="' + (padL + 84)  + '" y="11">Output</text>' +
    '</g>';
  var clipId = _chartClipId("ifaceTp");
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        (inPts  ? '<polyline points="' + inPts  + '" fill="none" stroke="' + inColor  + '" stroke-width="1.5"/>' : '') +
        (outPts ? '<polyline points="' + outPts + '" fill="none" stroke="' + outColor + '" stroke-width="1.5"/>' : '') +
        inSeries .map(function (d) { return '<circle cx="' + xFor(d.timestamp) + '" cy="' + yFor(d.inBps)  + '" r="1.5" fill="' + inColor  + '"/>'; }).join("") +
        outSeries.map(function (d) { return '<circle cx="' + xFor(d.timestamp) + '" cy="' + yFor(d.outBps) + '" r="1.5" fill="' + outColor + '"/>'; }).join("") +
        hits +
      '</g>' +
      legend +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  _wireChartTooltip(container, function (target) {
    var inV  = target.getAttribute("data-in");
    var outV = target.getAttribute("data-out");
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>Input: '  + (inV  !== "" ? _fmtBitsPerSec(Number(inV))  : "—") + '</div>' +
      '<div>Output: ' + (outV !== "" ? _fmtBitsPerSec(Number(outV)) : "—") + '</div>';
  });
  _addChartScreenshotButton(container, "Throughput", { yAxis: "Throughput (bps)", subject: opts.subject });
  _observeChartResize(container, function (c) { _renderIfaceThroughputChart(c, derived, opts); });
}

function _renderIfaceErrorChart(container, derived, opts) {
  opts = opts || {};
  var inSeries  = derived.filter(function (d) { return typeof d.inErr  === "number"; });
  var outSeries = derived.filter(function (d) { return typeof d.outErr === "number"; });
  if (inSeries.length === 0 && outSeries.length === 0) {
    container.textContent = "No error samples reported by this interface.";
    return;
  }
  var W = container.clientWidth || 600, H = 180;
  var padL = 44, padR = 10, padT = 10, padB = 32;
  var innerW = W - padL - padR, innerH = H - padT - padB;
  var bounds = _chartTimeBounds(derived, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function fmtTick(ts) {
    var d = new Date(ts);
    if (spanMs <= oneDayMs) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return (d.getMonth() + 1) + "/" + d.getDate();
  }
  var maxE = 0;
  derived.forEach(function (d) {
    if (typeof d.inErr  === "number" && d.inErr  > maxE) maxE = d.inErr;
    if (typeof d.outErr === "number" && d.outErr > maxE) maxE = d.outErr;
  });
  if (maxE < 5) maxE = 5;
  var ceil = Math.ceil(maxE * 1.2);
  function xFor(ts) { return padL + ((new Date(ts).getTime() - t0) / (t1 - t0)) * innerW; }
  function yFor(v) { return padT + innerH - (v / ceil) * innerH; }
  function lineFor(arr, key) {
    return arr.map(function (d) { return xFor(d.timestamp) + "," + yFor(d[key]); }).join(" ");
  }
  var inPts  = lineFor(inSeries,  "inErr");
  var outPts = lineFor(outSeries, "outErr");
  var hits = derived.map(function (d) {
    var y = padT + innerH;
    if (typeof d.inErr === "number") y = Math.min(y, yFor(d.inErr));
    if (typeof d.outErr === "number") y = Math.min(y, yFor(d.outErr));
    return '<circle class="chart-hit" cx="' + xFor(d.timestamp) + '" cy="' + y + '" r="6" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(d.timestamp)) + '"' +
      ' data-in="'  + (typeof d.inErr  === "number" ? d.inErr  : "") + '"' +
      ' data-out="' + (typeof d.outErr === "number" ? d.outErr : "") + '"/>';
  }).join("");

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = (ceil * i / 4);
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + Math.round(v) + '</text>';
  }
  var xTicks = "";
  for (var j = 0; j <= 5; j++) {
    var tsTick = t0 + (t1 - t0) * (j / 5);
    var xPos = padL + (j / 5) * innerW;
    xTicks +=
      '<line x1="' + xPos + '" y1="' + (padT + innerH) + '" x2="' + xPos + '" y2="' + (padT + innerH + 3) + '" stroke="rgba(127,127,127,0.4)"/>' +
      '<text x="' + xPos + '" y="' + (padT + innerH + 14) + '" text-anchor="middle" font-size="10" fill="currentColor">' + fmtTick(tsTick) + '</text>';
  }
  var legend =
    '<g font-size="10" fill="currentColor">' +
      '<rect x="' + (padL + 10) + '" y="2" width="10" height="10" fill="#d32f2f"/>' +
      '<text x="' + (padL + 24) + '" y="11">In errors</text>' +
      '<rect x="' + (padL + 110) + '" y="2" width="10" height="10" fill="#9b5de5"/>' +
      '<text x="' + (padL + 124) + '" y="11">Out errors</text>' +
    '</g>';
  var clipId = _chartClipId("ifaceErr");
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        (inPts  ? '<polyline points="' + inPts  + '" fill="none" stroke="#d32f2f" stroke-width="1.5"/>' : '') +
        (outPts ? '<polyline points="' + outPts + '" fill="none" stroke="#9b5de5" stroke-width="1.5"/>' : '') +
        inSeries .map(function (d) { return '<circle cx="' + xFor(d.timestamp) + '" cy="' + yFor(d.inErr)  + '" r="1.5" fill="#d32f2f"/>'; }).join("") +
        outSeries.map(function (d) { return '<circle cx="' + xFor(d.timestamp) + '" cy="' + yFor(d.outErr) + '" r="1.5" fill="#9b5de5"/>'; }).join("") +
        hits +
      '</g>' +
      legend +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  _wireChartTooltip(container, function (target) {
    var inE  = target.getAttribute("data-in");
    var outE = target.getAttribute("data-out");
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>In errors: ' + (inE  !== "" ? inE  : "—") + '</div>' +
      '<div>Out errors: ' + (outE !== "" ? outE : "—") + '</div>';
  });
  _addChartScreenshotButton(container, "Interface errors", { yAxis: "Errors per interval", subject: opts.subject });
  _observeChartResize(container, function (c) { _renderIfaceErrorChart(c, derived, opts); });
}

// ─── IPsec tunnel slide-over ───────────────────────────────────────────────
//
// Sits on top of the asset details panel like the interface slide-over does.
// Shows a status timeline (each sample colored up/partial/down) and per-
// interval throughput derived from the cumulative byte counters. No auto-
// refresh because IPsec rides the system-info cadence (~10 min) — closing
// and reopening the panel is fast enough.

function _ensureIpsecPanelDOM() {
  if (document.getElementById("ipsec-panel-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "ipsec-panel-overlay";
  overlay.className = "slideover-overlay slideover-nested";
  overlay.style.zIndex = "1099";
  overlay.innerHTML =
    '<div class="slideover" id="ipsec-panel" style="z-index:1100">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="ipsec-panel-title">IPsec tunnel</h3>' +
          '<button class="btn-icon" id="ipsec-panel-close" title="Close">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta" id="ipsec-panel-meta"></div>' +
      '</div>' +
      '<div class="slideover-body" id="ipsec-panel-body"><p class="empty-state" style="padding:1rem 1.25rem">Loading…</p></div>' +
      '<div class="slideover-footer" id="ipsec-panel-footer"></div>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeIpsecPanel();
  });
  document.getElementById("ipsec-panel-close").addEventListener("click", closeIpsecPanel);
  initSlideoverResize(document.getElementById("ipsec-panel"), "polaris.panel.width.ipsec");
}

function closeIpsecPanel() {
  var ov = document.getElementById("ipsec-panel-overlay");
  if (ov) ov.classList.remove("open");
  if (_ipsecRefreshTimer) { clearTimeout(_ipsecRefreshTimer); _ipsecRefreshTimer = null; }
}

async function openIpsecTunnelDetailPanel(asset, tunnelName) {
  if (!asset || !tunnelName) return;
  _ensureIpsecPanelDOM();
  var titleEl  = document.getElementById("ipsec-panel-title");
  var metaEl   = document.getElementById("ipsec-panel-meta");
  var bodyEl   = document.getElementById("ipsec-panel-body");
  var footerEl = document.getElementById("ipsec-panel-footer");
  titleEl.textContent = "IPsec — " + tunnelName;
  metaEl.textContent = asset.hostname || asset.ipAddress || asset.id;
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>';
  footerEl.innerHTML =
    '<button class="btn btn-sm btn-secondary" id="btn-ipsec-panel-close-btn">Close</button>';
  requestAnimationFrame(function () {
    document.getElementById("ipsec-panel-overlay").classList.add("open");
  });
  document.getElementById("btn-ipsec-panel-close-btn").addEventListener("click", closeIpsecPanel);

  var rangeBtns = _chartRangeBtnsHTML("ipsec-range-btn", [
    { value: "1h",  label: "1h"  },
    { value: "24h", label: "24h" },
    { value: "7d",  label: "7d"  },
    { value: "30d", label: "30d" },
    { value: "custom", label: "Custom…", id: "btn-ipsec-custom" },
  ], "assetIpsec", "1h");
  var ipsecCustomPanel =
    '<div id="ipsec-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
      '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="ipsec-custom-from" class="form-input" style="padding:2px 6px"></label>' +
      '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="ipsec-custom-to" class="form-input" style="padding:2px 6px"></label>' +
      '<button class="btn btn-sm btn-primary" id="btn-ipsec-custom-apply">Apply</button>' +
    '</div>';

  // IPsec rides the FortiOS REST interfaces stream — even when the operator
  // routes Interfaces to SNMP, IPsec stays on REST since SNMP has no
  // equivalent (see CLAUDE.md). The configurable stream that controls its
  // delivery is `interfaces`.
  var ipsecBadge = _streamSourceBadgeHTML(asset, "interfaces");

  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
        '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
          '<h4 style="margin:0">Tunnel state &amp; throughput</h4>' +
          ipsecBadge +
        '</div>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
      ipsecCustomPanel +
      '<div id="ipsec-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Status</h5>' +
      '<div id="ipsec-status-chart" class="ipsec-chart-box"></div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Incoming (bps)</h5>' +
      '<div id="ipsec-in-chart" class="ipsec-chart-box"></div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Outgoing (bps)</h5>' +
      '<div id="ipsec-out-chart" class="ipsec-chart-box"></div>' +
    '</div>';
  document.querySelectorAll(".ipsec-chart-box").forEach(function (el) {
    el.style.background = "var(--color-bg-elevated)";
    el.style.border = "1px solid var(--color-border)";
    el.style.borderRadius = "6px";
    el.style.padding = "0.5rem";
    el.style.minHeight = "140px";
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.color = "var(--color-text-secondary)";
    el.style.fontSize = "0.85rem";
  });

  await _loadIpsecHistoryFor(asset.id, tunnelName, _getChartRangePref("assetIpsec", "1h"));
  // Async overwrite the badge with the authoritative resolved polling method.
  _updateStreamSourceBadgesFromEffective(asset.id, asset);
  document.querySelectorAll(".ipsec-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      var panel = document.getElementById("ipsec-custom-panel");
      if (range === "custom") {
        if (!panel) return;
        var willOpen = panel.style.display === "none";
        panel.style.display = willOpen ? "flex" : "none";
        if (willOpen) {
          var toInput   = document.getElementById("ipsec-custom-to");
          var fromInput = document.getElementById("ipsec-custom-from");
          if (toInput && !toInput.value) toInput.value = _toLocalDatetimeInput(new Date());
          if (fromInput && !fromInput.value) fromInput.value = _toLocalDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000));
        }
        return;
      }
      if (panel) panel.style.display = "none";
      document.querySelectorAll(".ipsec-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _setChartRangePref("assetIpsec", range);
      _loadIpsecHistoryFor(asset.id, tunnelName, range);
    });
  });
  var ipsecCustomApply = document.getElementById("btn-ipsec-custom-apply");
  if (ipsecCustomApply) {
    ipsecCustomApply.addEventListener("click", function () {
      var fromInput = document.getElementById("ipsec-custom-from");
      var toInput   = document.getElementById("ipsec-custom-to");
      if (!fromInput.value || !toInput.value) { showToast("Enter both From and To", "error"); return; }
      var fromIso = new Date(fromInput.value).toISOString();
      var toIso   = new Date(toInput.value).toISOString();
      if (new Date(fromIso) >= new Date(toIso)) { showToast("From must be before To", "error"); return; }
      document.querySelectorAll(".ipsec-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      var customBtn = document.getElementById("btn-ipsec-custom");
      if (customBtn) { customBtn.classList.remove("btn-secondary"); customBtn.classList.add("btn-primary"); }
      _loadIpsecHistoryFor(asset.id, tunnelName, { from: fromIso, to: toIso });
    });
  }
}

async function _loadIpsecHistoryFor(assetId, tunnelName, range, callOpts) {
  // Cancel any pending auto-refresh — manual range change shouldn't race a tick.
  if (_ipsecRefreshTimer) { clearTimeout(_ipsecRefreshTimer); _ipsecRefreshTimer = null; }
  var silent = !!(callOpts && callOpts.silent);
  var statusEl = document.getElementById("ipsec-status-chart");
  var inEl     = document.getElementById("ipsec-in-chart");
  var outEl    = document.getElementById("ipsec-out-chart");
  var stats    = document.getElementById("ipsec-stats");
  if (!statusEl) return;
  if (!silent) {
    statusEl.textContent = inEl.textContent = outEl.textContent = "Loading samples…";
    if (stats) stats.textContent = "Loading…";
  }
  var panelBody = silent ? document.getElementById("ipsec-panel-body") : null;
  var savedScroll = panelBody ? panelBody.scrollTop : 0;
  // Accept range as a string or `{from, to}` object (canonical convention).
  var opts = (typeof range === "string" || !range) ? { range: range || "1h" } : range;
  try {
    var data = await api.assets.ipsecHistory(assetId, tunnelName, opts);
    var samples = data.samples || [];
    var derived = _deriveIpsecThroughput(samples, data);
    _renderIpsecStats(stats, samples, derived, data);
    var ipsecOpts = { since: data.since, until: data.until, subject: tunnelName };
    _renderIpsecStatusChart(statusEl, samples, ipsecOpts);
    _renderIpsecBpsChart(inEl,  derived, "in",  ipsecOpts);
    _renderIpsecBpsChart(outEl, derived, "out", ipsecOpts);
    if (opts.from && opts.to) {
      statusEl.dataset.from = inEl.dataset.from = outEl.dataset.from = opts.from;
      statusEl.dataset.to   = inEl.dataset.to   = outEl.dataset.to   = opts.to;
      delete statusEl.dataset.range; delete inEl.dataset.range; delete outEl.dataset.range;
    } else {
      statusEl.dataset.range = inEl.dataset.range = outEl.dataset.range = opts.range || "1h";
      delete statusEl.dataset.from; delete inEl.dataset.from; delete outEl.dataset.from;
      delete statusEl.dataset.to;   delete inEl.dataset.to;   delete outEl.dataset.to;
    }
  } catch (err) {
    if (!silent) {
      statusEl.textContent = inEl.textContent = outEl.textContent = "Error: " + (err.message || "failed to load");
      if (stats) stats.textContent = "";
    }
    // Silent ticks leave stale content on transient errors.
  }
  if (panelBody) {
    panelBody.scrollTop = savedScroll;
    requestAnimationFrame(function () {
      if (panelBody.scrollTop !== savedScroll) panelBody.scrollTop = savedScroll;
    });
  }
  // Custom date ranges are fixed historical windows — do not auto-refresh.
  if (opts.from && opts.to) return;
  // Schedule next auto-refresh on the response-time cadence — pinned tunnels
  // ride that cadence on the backend (collectFastFiltered).
  var settings = _monitorSettingsCache || {};
  var asset = _currentAssetForRefresh;
  var ms = _refreshIntervalMs(asset && asset.monitorIntervalSec, settings.intervalSeconds, 60);
  _scheduleIpsecRefresh(assetId, tunnelName, ms);
}

// FortiOS resets phase-1 byte counters when the SA renegotiates, so a
// negative delta is treated as a counter reset (skipped) rather than negative
// throughput. Same convention as _derivePerIntervalSeries for interfaces.
// Rollup tier delivers `incomingBytesPerSec` / `outgoingBytesPerSec` already —
// one derived point per rollup sample, no diff needed.
function _deriveIpsecThroughput(samples, data) {
  if (data && typeof data.bucketSeconds === "number" && data.bucketSeconds > 0) {
    return (samples || []).map(function (s) {
      var inBps  = typeof s.incomingBytesPerSec === "number" ? s.incomingBytesPerSec * 8 : null;
      var outBps = typeof s.outgoingBytesPerSec === "number" ? s.outgoingBytesPerSec * 8 : null;
      return { timestamp: s.timestamp, inBps: inBps, outBps: outBps };
    });
  }
  var out = [];
  for (var i = 1; i < samples.length; i++) {
    var prev = samples[i - 1];
    var cur  = samples[i];
    var dtMs = new Date(cur.timestamp) - new Date(prev.timestamp);
    if (dtMs <= 0) continue;
    var dtSec = dtMs / 1000;
    function delta(a, b) {
      if (typeof a !== "number" || typeof b !== "number") return null;
      var d = b - a;
      return d < 0 ? null : d;
    }
    var inB  = delta(prev.incomingBytes, cur.incomingBytes);
    var outB = delta(prev.outgoingBytes, cur.outgoingBytes);
    out.push({
      timestamp: cur.timestamp,
      inBps:  inB  != null ? (inB  * 8) / dtSec : null,
      outBps: outB != null ? (outB * 8) / dtSec : null,
    });
  }
  return out;
}

function _renderIpsecStats(container, samples, derived, data) {
  if (!container) return;
  var up = 0, down = 0, partial = 0, dynamic = 0;
  if (data && typeof data.bucketSeconds === "number" && data.bucketSeconds > 0) {
    // Rollup tier: each row carries per-status counts across its bucket.
    // Sum them so "Status" reads the same as detail-tier semantics —
    // total samples observed in each state across the whole range.
    samples.forEach(function (s) {
      up      += s.statusUpCount      || 0;
      down    += s.statusDownCount    || 0;
      partial += s.statusPartialCount || 0;
      dynamic += s.statusDynamicCount || 0;
    });
  } else {
    samples.forEach(function (s) {
      if (s.status === "up") up++;
      else if (s.status === "down") down++;
      else if (s.status === "dynamic") dynamic++;
      else partial++;
    });
  }
  var inMax = 0, outMax = 0, inSum = 0, outSum = 0, inN = 0, outN = 0;
  derived.forEach(function (d) {
    if (typeof d.inBps  === "number") { inSum  += d.inBps;  inN++;  if (d.inBps  > inMax)  inMax  = d.inBps; }
    if (typeof d.outBps === "number") { outSum += d.outBps; outN++; if (d.outBps > outMax) outMax = d.outBps; }
  });
  // Dial-up server template — phase-2 children appear as separate `parent`-
  // bearing tunnels that we filter out, so the up/partial/down rollup is
  // meaningless. Status reads "dial-up server"; throughput lines stay.
  var statusValue;
  if (dynamic > 0 && up === 0 && down === 0 && partial === 0) {
    statusValue = "dial-up server";
  } else {
    statusValue = up + " up / " + partial + " partial / " + down + " down";
    if (dynamic > 0) statusValue += " / " + dynamic + " dynamic";
  }
  var ipsecParts = [
    { label: "Status",   value: statusValue },
    { label: "In avg",   value: _fmtBitsPerSec(inN  ? inSum  / inN  : 0) },
    { label: "In peak",  value: _fmtBitsPerSec(inMax) },
    { label: "Out avg",  value: _fmtBitsPerSec(outN ? outSum / outN : 0) },
    { label: "Out peak", value: _fmtBitsPerSec(outMax) },
  ];
  var ipsecTierPart = _tierStatsPart(data);
  if (ipsecTierPart) ipsecParts.unshift(ipsecTierPart);
  _renderChartStats(container, samples.length, ipsecParts);
}

function _renderIpsecStatusChart(container, samples, opts) {
  opts = opts || {};
  if (samples.length === 0) {
    container.textContent = "No samples in this range yet.";
    return;
  }
  var W = container.clientWidth || 600, H = 60;
  var padL = 56, padR = 10, padT = 8, padB = 22;
  var innerW = W - padL - padR, innerH = H - padT - padB;
  var bounds = _chartTimeBounds(samples, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  // Width of the trailing status bar — without this, the last sample stretches
  // to the right edge of the chart, which is misleading when the requested
  // window extends past the last sample.
  var lastStepMs = samples.length > 1
    ? (new Date(samples[samples.length - 1].timestamp).getTime() - new Date(samples[samples.length - 2].timestamp).getTime())
    : 600000;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function fmtTick(ts) {
    var d = new Date(ts);
    if (spanMs <= oneDayMs) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return (d.getMonth() + 1) + "/" + d.getDate();
  }
  function colorFor(s) {
    if (s === "up") return MONITOR_STATE_COLORS.up;
    if (s === "down") return MONITOR_STATE_COLORS.down;
    if (s === "dynamic") return "#7b8794"; // dial-up server template — neutral gray
    return MONITOR_STATE_COLORS.warning;
  }
  function xFor(ts) { return padL + ((new Date(ts).getTime() - t0) / (t1 - t0)) * innerW; }
  // Each sample covers from its own x to the next sample's x (or the chart edge).
  var bars = samples.map(function (s, i) {
    var x  = xFor(s.timestamp);
    var x2;
    if (i + 1 < samples.length) {
      x2 = xFor(samples[i + 1].timestamp);
    } else {
      x2 = Math.min(padL + innerW, xFor(new Date(s.timestamp).getTime() + lastStepMs));
    }
    var w = Math.max(1, x2 - x);
    return '<rect class="chart-hit" x="' + x + '" y="' + padT + '" width="' + w + '" height="' + innerH + '" fill="' + colorFor(s.status) + '" opacity="0.85" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(s.timestamp)) + '"' +
      ' data-status="' + escapeHtml(s.status) + '"/>';
  }).join("");
  var xTicks = "";
  for (var j = 0; j <= 5; j++) {
    var tsTick = t0 + (t1 - t0) * (j / 5);
    var xPos = padL + (j / 5) * innerW;
    xTicks +=
      '<line x1="' + xPos + '" y1="' + (padT + innerH) + '" x2="' + xPos + '" y2="' + (padT + innerH + 3) + '" stroke="rgba(127,127,127,0.4)"/>' +
      '<text x="' + xPos + '" y="' + (padT + innerH + 14) + '" text-anchor="middle" font-size="10" fill="currentColor">' + fmtTick(tsTick) + '</text>';
  }
  var hasDynamic = samples.some(function (s) { return s.status === "dynamic"; });
  var legend =
    '<g font-size="10" fill="currentColor">' +
      '<rect x="' + padL + '" y="2" width="10" height="6" fill="' + MONITOR_STATE_COLORS.up + '"/><text x="' + (padL + 14) + '" y="8">up</text>' +
      '<rect x="' + (padL + 50) + '" y="2" width="10" height="6" fill="' + MONITOR_STATE_COLORS.warning + '"/><text x="' + (padL + 64) + '" y="8">partial</text>' +
      '<rect x="' + (padL + 110) + '" y="2" width="10" height="6" fill="' + MONITOR_STATE_COLORS.down + '"/><text x="' + (padL + 124) + '" y="8">down</text>' +
      (hasDynamic ? '<rect x="' + (padL + 160) + '" y="2" width="10" height="6" fill="#7b8794"/><text x="' + (padL + 174) + '" y="8">dynamic</text>' : '') +
    '</g>';
  var clipId = _chartClipId("ipsecStat");
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        bars +
      '</g>' +
      legend +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  _wireChartTooltip(container, function (target) {
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>Status: ' + escapeHtml(target.getAttribute("data-status")) + '</div>';
  });
  _addChartScreenshotButton(container, "IPsec status", { yAxis: "Status", subject: opts.subject });
  _observeChartResize(container, function (c) { _renderIpsecStatusChart(c, samples, opts); });
}

function _renderIpsecBpsChart(container, derived, side, opts) {
  opts = opts || {};
  var values = derived.map(function (d) { return { ts: d.timestamp, v: side === "in" ? d.inBps : d.outBps }; })
                     .filter(function (e) { return typeof e.v === "number"; });
  if (values.length === 0) {
    container.textContent = "No throughput samples yet — IPsec data is collected on the system-info cadence (~10 min).";
    return;
  }
  var W = container.clientWidth || 600, H = 160;
  var padL = 56, padR = 10, padT = 10, padB = 28;
  var innerW = W - padL - padR, innerH = H - padT - padB;
  var samplesForBounds = values.map(function (e) { return { timestamp: e.ts }; });
  var bounds = _chartTimeBounds(samplesForBounds, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function fmtTick(ts) {
    var d = new Date(ts);
    if (spanMs <= oneDayMs) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return (d.getMonth() + 1) + "/" + d.getDate();
  }
  var maxV = Math.max.apply(null, values.map(function (e) { return e.v; }));
  if (maxV < 1000) maxV = 1000;
  function tidyCeil(n) {
    var exp = Math.pow(10, Math.floor(Math.log10(n)));
    var mant = n / exp;
    var step = mant <= 1 ? 1 : mant <= 2 ? 2 : mant <= 5 ? 5 : 10;
    return step * exp;
  }
  var ceil = tidyCeil(maxV);
  function xFor(ts) { return padL + ((new Date(ts).getTime() - t0) / (t1 - t0)) * innerW; }
  function yFor(v) { return padT + innerH - (v / ceil) * innerH; }
  var pts = values.map(function (e) { return xFor(e.ts) + "," + yFor(e.v); }).join(" ");
  var hits = values.map(function (e) {
    return '<circle class="chart-hit" cx="' + xFor(e.ts) + '" cy="' + yFor(e.v) + '" r="6" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(e.ts)) + '" data-v="' + e.v + '"/>';
  }).join("");
  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = ceil * i / 4;
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + _fmtBitsPerSec(v) + '</text>';
  }
  var xTicks = "";
  for (var j = 0; j <= 5; j++) {
    var tsTick = t0 + (t1 - t0) * (j / 5);
    var xPos = padL + (j / 5) * innerW;
    xTicks +=
      '<line x1="' + xPos + '" y1="' + (padT + innerH) + '" x2="' + xPos + '" y2="' + (padT + innerH + 3) + '" stroke="rgba(127,127,127,0.4)"/>' +
      '<text x="' + xPos + '" y="' + (padT + innerH + 14) + '" text-anchor="middle" font-size="10" fill="currentColor">' + fmtTick(tsTick) + '</text>';
  }
  var color = side === "in" ? "var(--color-accent)" : "#f4a261";
  var clipId = _chartClipId("ipsecBps");
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.5"/>' +
        values.map(function (e) { return '<circle cx="' + xFor(e.ts) + '" cy="' + yFor(e.v) + '" r="1.5" fill="' + color + '"/>'; }).join("") +
        hits +
      '</g>' +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  _wireChartTooltip(container, function (target) {
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>' + (side === "in" ? "Incoming" : "Outgoing") + ': ' + _fmtBitsPerSec(Number(target.getAttribute("data-v"))) + '</div>';
  });
  _addChartScreenshotButton(container, side === "in" ? "IPsec incoming" : "IPsec outgoing", { yAxis: "Throughput (bps)", subject: opts.subject });
  _observeChartResize(container, function (c) { _renderIpsecBpsChart(c, derived, side, opts); });
}

// ─── SD-WAN tab (FortiOS Performance SLA + service rules) ───────────────────
//
// Rendered as a conditional asset-modal tab (not a slide-over) when a FortiGate
// firewall reports SD-WAN data. Two sections: a service-rules table (current
// selected member per rule + click-through to a member-selection timeline) and
// a Performance SLA section (per health-check/member latency / jitter / packet-
// loss charts over time). Data comes from the perf-SLA + sdwan-rule sample
// streams via the asset history endpoints.

var _SDWAN_MEMBER_COLORS = ["#2a9d8f", "#4361ee", "#f4a261", "#9b5de5", "#e76f51", "#43aa8b", "#577590", "#bc6c25"];
function _sdwanMemberColor(name, members) {
  if (!name) return "#7b8794";
  var idx = (members || []).indexOf(name);
  if (idx < 0) idx = 0;
  return _SDWAN_MEMBER_COLORS[idx % _SDWAN_MEMBER_COLORS.length];
}

// Compact green/red "Health Check Status" strip — one segment per recent scrape.
function _sdwanStatusStripHTML(recent) {
  if (!recent || !recent.length) return '<span style="color:var(--color-text-tertiary)">—</span>';
  var segs = recent.map(function (r) {
    var c = r.up ? "#2ecc40" : "#e02020";
    return '<span title="' + escapeHtml(_fmtTooltipTs(r.timestamp)) + (r.up ? ' — up' : ' — down') +
      '" style="flex:1 1 auto;min-width:2px;height:16px;background:' + c + '"></span>';
  }).join("");
  return '<span style="display:flex;gap:1px;align-items:stretch;min-width:120px;max-width:340px">' + segs + '</span>';
}

// SD-WAN Members table body — canonical applyTableLayout column template.
// Members are grouped by SD-WAN zone: a full-width zone header row, then that
// zone's members indented beneath it (dependency-tree style). When no member
// reports a zone the table renders flat with no headers (unchanged behavior).
function _sdwanMembersTableHTML(members) {
  function statusDot(up) {
    return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:' +
      (up ? MONITOR_STATE_COLORS.up : MONITOR_STATE_COLORS.down) + '"></span>';
  }
  // One member row. `indented` adds a faint tree connector + indent in the
  // Member cell when the row sits under a zone header. The connector lives in
  // the cell content (not td padding) so it survives applyTableLayout's
  // column resize/reorder.
  function memberRow(m, indented) {
    var hcChips = (m.healthChecks || []).map(function (h) {
      var c = h.state === "up" ? MONITOR_STATE_COLORS.up : MONITOR_STATE_COLORS.down;
      var lat = (typeof h.latencyMs === "number") ? (Math.round(h.latencyMs * 100) / 100) + "ms" : "—";
      return '<span title="' + escapeHtml(h.healthCheck) +
        ' · jitter ' + (typeof h.jitterMs === "number" ? (Math.round(h.jitterMs * 100) / 100) + "ms" : "—") +
        ' · loss ' + (typeof h.packetLoss === "number" ? h.packetLoss + "%" : "—") +
        '" style="display:inline-block;margin:0 4px 2px 0;padding:1px 6px;border-radius:10px;font-size:0.74rem;background:var(--color-bg-elevated);border:1px solid var(--color-border)">' +
        '<span style="color:' + c + '">●</span> ' + escapeHtml(h.healthCheck) + ' ' + lat + '</span>';
    }).join("") || '<span style="color:var(--color-text-tertiary)">—</span>';
    var link = m.linkUp == null
      ? '<span style="color:var(--color-text-tertiary)">—</span>'
      : (m.linkUp
          ? '<span style="color:' + MONITOR_STATE_COLORS.up + '">▲ ' + (m.linkSpeedBps ? _fmtBitsPerSec(m.linkSpeedBps) : "up") + '</span>'
          : '<span style="color:' + MONITOR_STATE_COLORS.down + '">▼ down</span>');
    var bytes = (m.txBytes != null || m.rxBytes != null)
      ? (m.txBytes != null ? _fmtBytes(m.txBytes) : "—") + ' / ' + (m.rxBytes != null ? _fmtBytes(m.rxBytes) : "—")
      : '<span style="color:var(--color-text-tertiary)">—</span>';
    var indent = indented
      ? '<span style="display:inline-block;width:1.25rem;color:var(--color-text-tertiary)">└</span>'
      : '';
    return '<tr>' +
        '<td data-col-id="member" data-col-required="true">' + indent + statusDot(m.state === "up") + escapeHtml(m.link) + '</td>' +
        '<td data-col-id="ip">' + (m.ip ? escapeHtml(m.ip) : '<span style="color:var(--color-text-tertiary)">—</span>') + '</td>' +
        '<td data-col-id="hcstatus">' + _sdwanStatusStripHTML(m.recent) + '</td>' +
        '<td data-col-id="checks">' + hcChips + '</td>' +
        '<td data-col-id="bytes">' + bytes + '</td>' +
        '<td data-col-id="link">' + link + '</td>' +
      '</tr>';
  }
  // Full-width zone grouping header. No data-col-id cells, so applyTableLayout
  // (which keys off data-col-id cells) leaves it untouched.
  function zoneHeader(label) {
    return '<tr class="sdwan-zone-header"><td colspan="6" style="padding:5px 8px;font-weight:600;' +
      'background:var(--color-bg-elevated);color:var(--color-text-secondary)">▸ ' + escapeHtml(label) + '</td></tr>';
  }
  var rows;
  if (!members.some(function (m) { return m.zone; })) {
    // No zones configured — flat table, unchanged.
    rows = members.map(function (m) { return memberRow(m, false); }).join("");
  } else {
    var groups = new Map(); // zone name | null → members[]
    members.forEach(function (m) {
      var z = m.zone || null;
      if (!groups.has(z)) groups.set(z, []);
      groups.get(z).push(m);
    });
    var parts = [];
    groups.forEach(function (list, z) {
      if (z === null) return; // null bucket emitted last
      parts.push(zoneHeader(z) + list.map(function (m) { return memberRow(m, true); }).join(""));
    });
    if (groups.has(null)) {
      parts.push(zoneHeader("No zone") + groups.get(null).map(function (m) { return memberRow(m, true); }).join(""));
    }
    rows = parts.join("");
  }
  return '<div class="table-wrapper"><table id="sdwan-members-table" class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th data-col-id="member" data-col-required="true">Member</th>' +
      '<th data-col-id="ip">IP</th>' +
      '<th data-col-id="hcstatus">Health Check Status</th>' +
      '<th data-col-id="checks">Health Checks</th>' +
      '<th data-col-id="bytes">Bytes (Sent/Received)</th>' +
      '<th data-col-id="link">Link</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function _assetSdwanTabHTML(a, rules, links, members) {
  rules = rules || [];
  links = links || [];
  members = members || [];
  var html = '<div style="padding:0.25rem 0">';

  // ── SD-WAN Members table (above the rules) ──
  if (members.length) {
    html +=
      '<div data-shot-section="sdwanMembers" data-shot-label="SD-WAN Members">' +
      '<section style="margin-bottom:1.25rem">' +
        '<h4 style="margin:0 0 0.5rem 0">SD-WAN Members</h4>' +
        '<p class="hint" style="margin:0 0 0.5rem 0;color:var(--color-text-tertiary)">WAN members (interfaces + overlays) with per-health-check status. The Health Check Status strip shows recent up/down per scrape; IP / link / bytes come from the latest interface poll.</p>' +
        _sdwanMembersTableHTML(members) +
      '</section>' +
      ((rules.length || links.length) ? '<hr style="margin:1.25rem 0;border:none;border-top:1px solid var(--color-border)">' : '') +
      '</div>';
  }

  // ── SD-WAN Rules table ── (canonical column-layout template: data-col-id on
  // every <th>, anchors marked data-col-required, applyTableLayout() wired in
  // _wireSdwanTab after the body lands in the DOM.)
  if (rules.length) {
    function _pillList(items, joinStr) {
      if (!items || !items.length) return '<span style="color:var(--color-text-tertiary)">—</span>';
      return items.map(function (m) { return escapeHtml(m); }).join(joinStr);
    }
    // member interface → SD-WAN zone, from the Members data this tab already
    // loaded. Lets a zone-preference rule group its candidate members by zone.
    var memberZoneByName = {};
    (members || []).forEach(function (mm) { if (mm && mm.link) memberZoneByName[mm.link] = mm.zone || null; });
    var ruleRows = rules.map(function (r) {
      var avail = Array.isArray(r.availableMembers) ? r.availableMembers : [];
      // One member pill (selected member highlighted). Color basis is the
      // rule's full candidate list so colors are stable across zone groups.
      function memberPill(m) {
        var sel = m === r.selectedMember;
        return '<span style="display:inline-block;margin:0 4px 2px 0;padding:1px 7px;border-radius:10px;font-size:0.76rem;' +
          (sel
            ? 'background:' + _sdwanMemberColor(m, avail) + ';color:#fff;font-weight:600'
            : 'background:var(--color-bg-elevated);border:1px solid var(--color-border);color:var(--color-text-secondary)') +
          '">' + escapeHtml(m) + (sel ? ' ✓' : '') + '</span>';
      }
      var pills;
      var zones = Array.isArray(r.priorityZones) ? r.priorityZones : [];
      if (zones.length) {
        // Zone-preference rule: one indented group per preferred zone listing
        // that zone's candidate members, selected one highlighted.
        var used = {};
        function zoneLabel(z) {
          return '<span style="font-size:0.72rem;color:var(--color-text-tertiary);margin-right:4px">' + escapeHtml(z) + ':</span>';
        }
        var groupsHtml = zones.map(function (z) {
          var zMembers = avail.filter(function (m) { return memberZoneByName[m] === z; });
          zMembers.forEach(function (m) { used[m] = true; });
          var inner = zMembers.length
            ? zMembers.map(memberPill).join("")
            : '<span style="color:var(--color-text-tertiary);font-size:0.74rem">no members</span>';
          return '<div style="margin:0 0 2px 0">' + zoneLabel(z) + inner + '</div>';
        }).join("");
        var leftovers = avail.filter(function (m) { return !used[m]; });
        if (leftovers.length) {
          groupsHtml += '<div style="margin:0 0 2px 0">' + zoneLabel("other") + leftovers.map(memberPill).join("") + '</div>';
        }
        pills = groupsHtml;
      } else {
        pills = avail.length
          ? avail.map(memberPill).join("")
          : '<span style="color:var(--color-text-tertiary)">—</span>';
      }
      var enabledCell = r.enabled == null
        ? '<span style="color:var(--color-text-tertiary)">—</span>'
        : (r.enabled
            ? '<span style="color:' + MONITOR_STATE_COLORS.up + '">● Enabled</span>'
            : '<span style="color:var(--color-text-tertiary)">○ Disabled</span>');
      return '<tr>' +
          '<td data-col-id="id">' + (r.ruleId != null ? escapeHtml(String(r.ruleId)) : '—') + '</td>' +
          '<td data-col-id="name" style="font-weight:600">' + escapeHtml(r.ruleName) + '</td>' +
          '<td data-col-id="dst">' + _pillList(r.dst, ", ") + '</td>' +
          '<td data-col-id="members">' + pills + '</td>' +
          '<td data-col-id="criteria">' + (r.criteria ? escapeHtml(r.criteria) : '—') + '</td>' +
          '<td data-col-id="perfsla">' + _pillList(r.healthChecks, ", ") + '</td>' +
          '<td data-col-id="status">' + enabledCell + '</td>' +
        '</tr>';
    }).join("");
    html +=
      '<div data-shot-section="sdwanRules" data-shot-label="SD-WAN Rules">' +
      '<section style="margin-bottom:1.25rem">' +
        '<h4 style="margin:0 0 0.5rem 0">SD-WAN Rules</h4>' +
        '<p class="hint" style="margin:0 0 0.5rem 0;color:var(--color-text-tertiary)">Service rules in FortiGate priority order, with the currently selected member highlighted in <strong>Members</strong>. Zone-preference rules list each preferred zone\'s members grouped by zone. The active member is inferred from health-check state when FortiOS does not report the selected route directly.</p>' +
        '<div class="table-wrapper"><table id="sdwan-rules-table" class="data-table" style="font-size:0.82rem"><thead><tr>' +
          '<th data-col-id="id" style="width:48px">ID</th>' +
          '<th data-col-id="name" data-col-required="true">Name</th>' +
          '<th data-col-id="dst">Destination</th>' +
          '<th data-col-id="members" data-col-required="true">Members</th>' +
          '<th data-col-id="criteria">Criteria</th>' +
          '<th data-col-id="perfsla">Performance SLA</th>' +
          '<th data-col-id="status">Status</th>' +
        '</tr></thead><tbody>' + ruleRows + '</tbody></table></div>' +
      '</section>' +
      '</div>';
  }

  // ── Performance SLA section ──
  if (links.length) {
    var rangeBtns = _chartRangeBtnsHTML("sdwan-range-btn", [
      { value: "1h",  label: "1h"  },
      { value: "24h", label: "24h" },
      { value: "7d",  label: "7d"  },
      { value: "30d", label: "30d" },
    ], "assetSdwan", "24h");
    // One option per health-check (members are overlaid on each chart).
    var hcOrder = [];
    links.forEach(function (l) { if (hcOrder.indexOf(l.healthCheck) < 0) hcOrder.push(l.healthCheck); });
    var options = hcOrder.map(function (hc) {
      var n = links.filter(function (l) { return l.healthCheck === hc; }).length;
      return '<option value="' + escapeHtml(hc) + '">' + escapeHtml(hc) + ' (' + n + ' member' + (n === 1 ? '' : 's') + ')</option>';
    }).join("");
    html += '<div data-shot-section="perfSla" data-shot-label="Performance SLA" data-shot-chart="assetSdwan">';
    if (rules.length) {
      html += '<hr style="margin:1.25rem 0;border:none;border-top:1px solid var(--color-border)">';
    }
    // Provenance badge (polling method · cadence · tier) + freshness stamp, same
    // as every other chart in the modal. SD-WAN rides the system-info pass, so
    // the "interfaces" stream resolves the cadence and lastSystemInfoAt is the
    // freshness. _wireSdwanTab upgrades the badge to authoritative provenance.
    var perfSlaBadge = _streamSourceBadgeHTML(a, "interfaces");
    var perfSlaUpdatedAt = a.lastSystemInfoAt
      ? ('<span style="font-size:0.72rem;color:var(--color-text-tertiary)" title="' + escapeHtml(new Date(a.lastSystemInfoAt).toLocaleString()) + '">updated ' + timeAgo(a.lastSystemInfoAt) + '</span>')
      : '';
    html +=
      '<section>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.5rem">' +
          '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
            '<h4 style="margin:0">Performance SLA</h4>' +
            '<select id="sdwan-perfsla-select" class="form-input" style="padding:2px 6px;font-size:0.82rem">' + options + '</select>' +
            perfSlaBadge + (perfSlaBadge && perfSlaUpdatedAt ? ' ' : '') + perfSlaUpdatedAt +
          '</div>' +
          '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
        '</div>' +
        '<div id="sdwan-perfsla-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
        '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Latency (ms)</h5>' +
        '<div id="sdwan-latency-chart" class="sdwan-chart-box"></div>' +
        '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Jitter (ms)</h5>' +
        '<div id="sdwan-jitter-chart" class="sdwan-chart-box"></div>' +
        '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Packet loss (%)</h5>' +
        '<div id="sdwan-loss-chart" class="sdwan-chart-box"></div>' +
      '</section>' +
      '</div>';
  }

  html += '</div>';
  return html;
}

// Holds the current SD-WAN tab selection state (link list + selected rule) so
// the shared range buttons can reload whichever sub-view is showing.
var _sdwanTabState = null;

function _wireSdwanTab(a, rules, links) {
  links = links || [];
  // Group health-check members so a single selection overlays every member of
  // a health-check on the charts.
  var linksByHc = {};
  var hcNames = [];
  links.forEach(function (l) {
    if (!linksByHc[l.healthCheck]) { linksByHc[l.healthCheck] = []; hcNames.push(l.healthCheck); }
    linksByHc[l.healthCheck].push(l);
  });
  _sdwanTabState = { assetId: a.id, links: links, linksByHc: linksByHc, hcNames: hcNames, hcName: hcNames[0] || null, rules: rules || [] };
  // Upgrade the Performance SLA provenance badge from the coarse sync guess to
  // the authoritative resolved polling method + tier (covers class overrides).
  _updateStreamSourceBadgesFromEffective(a.id, a);
  // Style chart boxes (same treatment as the IPsec panel).
  document.querySelectorAll(".sdwan-chart-box").forEach(function (el) {
    el.style.background = "var(--color-bg-elevated)";
    el.style.border = "1px solid var(--color-border)";
    el.style.borderRadius = "6px";
    el.style.padding = "0.5rem";
    el.style.minHeight = "140px";
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.color = "var(--color-text-secondary)";
    el.style.fontSize = "0.85rem";
  });

  var range = _getChartRangePref("assetSdwan", "24h");

  // Perf-SLA health-check selector + initial load (overlays all members).
  var sel = document.getElementById("sdwan-perfsla-select");
  if (sel && hcNames.length) {
    sel.addEventListener("change", function () {
      _sdwanTabState.hcName = sel.value;
      _loadPerfSlaForHealthCheck(a.id, sel.value, linksByHc[sel.value] || [], _getChartRangePref("assetSdwan", "24h"));
    });
    _loadPerfSlaForHealthCheck(a.id, hcNames[0], linksByHc[hcNames[0]] || [], range);
  }

  // Canonical column-layout template (resize + hover-gear chooser), persisted
  // by table-type so widths apply across every FortiGate's SD-WAN tab.
  if (typeof applyTableLayout === "function") {
    var membersTable = document.getElementById("sdwan-members-table");
    if (membersTable) applyTableLayout(membersTable, _assetTableTypeKey("asset-sdwan-members", a), {
      onScreenshot: function (t) { _screenshotTableEl(t, "SD-WAN Members"); },
    });
    var rulesTable = document.getElementById("sdwan-rules-table");
    if (rulesTable) applyTableLayout(rulesTable, _assetTableTypeKey("asset-sdwan-rules", a), {
      onScreenshot: function (t) { _screenshotTableEl(t, "SD-WAN Rules"); },
    });
  }

  // Shared range buttons — reload the Performance SLA charts (SD-WAN rules are
  // current-state, so they don't reload on range change).
  document.querySelectorAll(".sdwan-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var r = b.getAttribute("data-range");
      document.querySelectorAll(".sdwan-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _setChartRangePref("assetSdwan", r);
      if (_sdwanTabState.hcName) _loadPerfSlaForHealthCheck(a.id, _sdwanTabState.hcName, _sdwanTabState.linksByHc[_sdwanTabState.hcName] || [], r);
    });
  });
}

// Load every member of a health-check in parallel and overlay them on the
// three metric charts (one colored line per member). `members` is the array of
// link objects (from /perf-sla-links) for this health-check; they share the
// same SLA thresholds.
async function _loadPerfSlaForHealthCheck(assetId, hcName, members, range) {
  var latEl  = document.getElementById("sdwan-latency-chart");
  var jitEl  = document.getElementById("sdwan-jitter-chart");
  var lossEl = document.getElementById("sdwan-loss-chart");
  var stats  = document.getElementById("sdwan-perfsla-stats");
  if (!latEl || !members || !members.length) return;
  latEl.textContent = jitEl.textContent = lossEl.textContent = "Loading samples…";
  if (stats) stats.textContent = "Loading…";
  var opts = (typeof range === "string" || !range) ? { range: range || "24h" } : range;
  var memberNames = members.map(function (m) { return m.link; });
  try {
    var results = await Promise.all(members.map(function (m) {
      return api.assets.perfSlaHistory(assetId, m.healthCheck, m.link, opts)
        .then(function (data) { return { link: m.link, data: data, samples: data.samples || [] }; })
        .catch(function () { return { link: m.link, data: null, samples: [] }; });
    }));
    var series = results.map(function (r) {
      return { label: r.link, color: _sdwanMemberColor(r.link, memberNames), samples: r.samples, data: r.data };
    });
    var first = results.find(function (r) { return r.data; }) || results[0];
    var copts = { since: first && first.data ? first.data.since : undefined, until: first && first.data ? first.data.until : undefined, subject: hcName };
    var thr = members[0] || {};
    // Stash render state so the clickable legend can re-render all three charts
    // on toggle. Reset per-member visibility whenever the health-check changes.
    _sdwanTabState.perfSla = { series: series, copts: copts, thr: thr, data: first && first.data };
    _sdwanTabState.hiddenMembers = new Set();
    _renderPerfSlaStats(stats, series, first && first.data, hcName);
    _renderAllPerfSlaCharts();
  } catch (err) {
    latEl.textContent = jitEl.textContent = lossEl.textContent = "Error: " + (err.message || "failed to load");
    if (stats) stats.textContent = "";
  }
}

function _renderPerfSlaStats(container, series, data, subject) {
  if (!container) return;
  var total = series.reduce(function (n, s) { return n + s.samples.length; }, 0);
  if (!total) { _renderChartStats(container, 0, []); return; }
  function avg(key) {
    var vals = [];
    series.forEach(function (s) { s.samples.forEach(function (x) { if (typeof x[key] === "number") vals.push(x[key]); }); });
    if (!vals.length) return null;
    return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  }
  function fmt(v, unit) { return v == null ? null : (Math.round(v * 100) / 100) + " " + unit; }
  var parts = [
    { label: "Members", value: String(series.length) },
    { label: "Avg latency", value: fmt(avg("latencyMs"), "ms") },
    { label: "Avg jitter",  value: fmt(avg("jitterMs"), "ms") },
    { label: "Avg loss",    value: fmt(avg("packetLoss"), "%") },
  ];
  var tierPart = _tierStatsPart(data);
  if (tierPart) parts.unshift(tierPart);
  _renderChartStats(container, total, parts);
}

// Re-render all three Performance SLA charts from the stashed state (honors the
// current per-member hidden set). Called on initial load + on legend toggle.
function _renderAllPerfSlaCharts() {
  var st = _sdwanTabState;
  if (!st || !st.perfSla) return;
  var ps = st.perfSla;
  var latEl  = document.getElementById("sdwan-latency-chart");
  var jitEl  = document.getElementById("sdwan-jitter-chart");
  var lossEl = document.getElementById("sdwan-loss-chart");
  if (latEl)  _renderPerfSlaMultiChart(latEl,  ps.series, "latencyMs",  { label: "Latency", unit: "ms", threshold: ps.thr.latencyThresholdMs }, ps.copts);
  if (jitEl)  _renderPerfSlaMultiChart(jitEl,  ps.series, "jitterMs",   { label: "Jitter",  unit: "ms", threshold: ps.thr.jitterThresholdMs }, ps.copts);
  if (lossEl) _renderPerfSlaMultiChart(lossEl, ps.series, "packetLoss", { label: "Packet loss", unit: "%", threshold: ps.thr.packetLossThreshold }, ps.copts);
}

// Toggle one member's visibility across all three Performance SLA charts.
function _togglePerfSlaMember(label) {
  var st = _sdwanTabState;
  if (!st) return;
  if (!st.hiddenMembers) st.hiddenMembers = new Set();
  if (st.hiddenMembers.has(label)) st.hiddenMembers.delete(label);
  else st.hiddenMembers.add(label);
  _renderAllPerfSlaCharts();
}

// Multi-series gauge chart: one polyline per member (`series[].samples`), a
// clickable per-member color legend (click to hide/show on every chart), and
// the shared dashed SLA threshold line. The hidden set lives on
// `_sdwanTabState.hiddenMembers` so it persists across resize re-renders and is
// shared by all three charts.
function _renderPerfSlaMultiChart(container, series, metricKey, meta, opts) {
  opts = opts || {};
  meta = meta || {};
  // Build per-series value arrays; drop members with no numeric points.
  var drawn = series.map(function (s) {
    return {
      label: s.label, color: s.color,
      values: s.samples.map(function (x) { return { ts: x.timestamp, v: x[metricKey] }; })
                        .filter(function (e) { return typeof e.v === "number"; }),
    };
  }).filter(function (s) { return s.values.length; });
  if (!drawn.length) { container.textContent = "No samples in this range yet."; return; }
  // Per-member hidden set (shared across all three charts; lives on tab state).
  var hidden = (_sdwanTabState && _sdwanTabState.hiddenMembers) || new Set();
  var visible = drawn.filter(function (s) { return !hidden.has(s.label); });
  var W = container.clientWidth || 600, H = 160;
  var padL = 52, padR = 10, padT = 10, padB = 40; // extra bottom pad for legend
  var innerW = W - padL - padR, innerH = H - padT - padB;
  var allTs = [];
  drawn.forEach(function (s) { s.values.forEach(function (e) { allTs.push({ timestamp: e.ts }); }); });
  var bounds = _chartTimeBounds(allTs, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function fmtTick(ts) { var d = new Date(ts); return spanMs <= oneDayMs ? pad2(d.getHours()) + ":" + pad2(d.getMinutes()) : (d.getMonth() + 1) + "/" + d.getDate(); }
  var hasThreshold = typeof meta.threshold === "number" && meta.threshold > 0;
  // Scale the y-axis to the VISIBLE series so hiding a high member rescales the
  // rest (fall back to all members when everything is hidden).
  var maxV = 1;
  (visible.length ? visible : drawn).forEach(function (s) { s.values.forEach(function (e) { if (e.v > maxV) maxV = e.v; }); });
  if (hasThreshold) maxV = Math.max(maxV, meta.threshold * 1.05);
  function tidyCeil(n) { var exp = Math.pow(10, Math.floor(Math.log10(n))); var mant = n / exp; var step = mant <= 1 ? 1 : mant <= 2 ? 2 : mant <= 5 ? 5 : 10; return step * exp; }
  var ceil = tidyCeil(maxV);
  function xFor(ts) { return padL + ((new Date(ts).getTime() - t0) / (t1 - t0)) * innerW; }
  function yFor(v) { return padT + innerH - (v / ceil) * innerH; }
  var thresholdLine = "";
  if (hasThreshold) {
    var ty = yFor(meta.threshold);
    thresholdLine =
      '<line x1="' + padL + '" y1="' + ty + '" x2="' + (W - padR) + '" y2="' + ty + '" stroke="#e9a23b" stroke-width="1.25" stroke-dasharray="5,4"/>' +
      '<text x="' + (W - padR) + '" y="' + (ty - 3) + '" text-anchor="end" font-size="9" fill="#e9a23b">SLA ' + (Math.round(meta.threshold * 100) / 100) + ' ' + escapeHtml(meta.unit || "") + '</text>';
  }
  var seriesSvg = visible.map(function (s) {
    var pts = s.values.map(function (e) { return xFor(e.ts) + "," + yFor(e.v); }).join(" ");
    var dots = s.values.map(function (e) {
      return '<circle class="chart-hit" cx="' + xFor(e.ts) + '" cy="' + yFor(e.v) + '" r="5" fill="transparent" style="cursor:crosshair"' +
        ' data-ts="' + escapeHtml(String(e.ts)) + '" data-v="' + e.v + '" data-member="' + escapeHtml(s.label) + '"/>';
    }).join("");
    return '<polyline points="' + pts + '" fill="none" stroke="' + s.color + '" stroke-width="1.5"/>' + dots;
  }).join("");
  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = ceil * i / 4;
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + (Math.round(v * 100) / 100) + '</text>';
  }
  var xTicks = "";
  for (var j = 0; j <= 5; j++) {
    var tsTick = t0 + (t1 - t0) * (j / 5);
    var xPos = padL + (j / 5) * innerW;
    xTicks +=
      '<line x1="' + xPos + '" y1="' + (padT + innerH) + '" x2="' + xPos + '" y2="' + (padT + innerH + 3) + '" stroke="rgba(127,127,127,0.4)"/>' +
      '<text x="' + xPos + '" y="' + (padT + innerH + 14) + '" text-anchor="middle" font-size="10" fill="currentColor">' + fmtTick(tsTick) + '</text>';
  }
  // Legend row beneath the x-axis — one clickable swatch+label per member.
  // Click toggles that member's visibility on every chart; hidden members grey
  // out + strike through. Each item is a <g class="sdwan-legend-item"> with a
  // transparent hit rect so the whole chip is the click target.
  var legendY = padT + innerH + 30;
  var lx = padL;
  var legend = '<g font-size="10">' + drawn.map(function (s) {
    var isHidden = hidden.has(s.label);
    var w = 16 + s.label.length * 6.5;
    var item = '<g class="sdwan-legend-item" data-member="' + escapeHtml(s.label) + '" style="cursor:pointer" opacity="' + (isHidden ? "0.4" : "1") + '">' +
      '<rect x="' + lx + '" y="' + (legendY - 11) + '" width="' + w + '" height="14" fill="transparent"/>' +
      '<rect x="' + lx + '" y="' + (legendY - 7) + '" width="10" height="6" fill="' + s.color + '"/>' +
      '<text x="' + (lx + 14) + '" y="' + legendY + '" fill="currentColor"' + (isHidden ? ' text-decoration="line-through"' : '') + '>' + escapeHtml(s.label) + '</text>' +
      '</g>';
    lx += w + 8;
    return item;
  }).join("") + '</g>';
  var clipId = _chartClipId("sdwanGauge");
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        thresholdLine +
        seriesSvg +
      '</g>' +
      legend +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  _wireChartTooltip(container, function (target) {
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(target.getAttribute("data-member")) + '</div>' +
      '<div>' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>' + escapeHtml(meta.label || metricKey) + ': ' + escapeHtml(target.getAttribute("data-v")) + ' ' + escapeHtml(meta.unit || "") + '</div>';
  });
  _addChartScreenshotButton(container, "SD-WAN " + (meta.label || metricKey), { yAxis: (meta.label || "") + " (" + (meta.unit || "") + ")", subject: opts.subject });
  // Clickable legend → toggle the member across all three charts.
  container.querySelectorAll(".sdwan-legend-item").forEach(function (g) {
    g.addEventListener("click", function () { _togglePerfSlaMember(g.getAttribute("data-member")); });
  });
  _observeChartResize(container, function (c) { _renderPerfSlaMultiChart(c, series, metricKey, meta, opts); });
}

// ─── Storage mountpoint slide-over ─────────────────────────────────────────
//
// Sits on top of the asset details panel like the interface and IPsec slide-
// overs. Shows used / total bytes over time and used % over time. SNMP only
// — the table renderer already gates the slide-in to mountpoints that came
// back in the last system-info pass, so we don't need to re-check here.

function _ensureStoragePanelDOM() {
  if (document.getElementById("storage-panel-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "storage-panel-overlay";
  overlay.className = "slideover-overlay slideover-nested";
  overlay.style.zIndex = "1099";
  overlay.innerHTML =
    '<div class="slideover" id="storage-panel" style="z-index:1100">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="storage-panel-title">Storage</h3>' +
          '<button class="btn-icon" id="storage-panel-close" title="Close">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta" id="storage-panel-meta"></div>' +
      '</div>' +
      '<div class="slideover-body" id="storage-panel-body"><p class="empty-state" style="padding:1rem 1.25rem">Loading…</p></div>' +
      '<div class="slideover-footer" id="storage-panel-footer"></div>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeStoragePanel();
  });
  document.getElementById("storage-panel-close").addEventListener("click", closeStoragePanel);
  initSlideoverResize(document.getElementById("storage-panel"), "polaris.panel.width.storage");
}

function closeStoragePanel() {
  var ov = document.getElementById("storage-panel-overlay");
  if (ov) ov.classList.remove("open");
}

// Opens the consolidated storage slide-in panel containing one section per
// mountpoint discovered on this asset. `focusMountPath` (optional) is the
// mount that triggered the open — its section gets scrolled into view and
// briefly highlighted. `storage` is the asset's current storage[] array
// (one row per mount) as already loaded by the System tab; we use it for
// the mount list and the latest-snapshot Used/Total/% so each section can
// paint a header before its history fetch lands.
async function openStorageDetailPanel(asset, focusMountPath, storage) {
  if (!asset) return;
  var mounts = Array.isArray(storage) ? storage.filter(function (s) { return s && s.mountPath; }) : [];
  if (mounts.length === 0 && focusMountPath) {
    // Legacy callers that only have the mountPath (no storage array) — synthesize
    // a one-entry list so the panel still works.
    mounts = [{ mountPath: focusMountPath }];
  }
  if (mounts.length === 0) return;
  _ensureStoragePanelDOM();
  var titleEl  = document.getElementById("storage-panel-title");
  var metaEl   = document.getElementById("storage-panel-meta");
  var bodyEl   = document.getElementById("storage-panel-body");
  var footerEl = document.getElementById("storage-panel-footer");
  titleEl.textContent = "Storage — " + (asset.hostname || asset.ipAddress || asset.id);
  metaEl.textContent = mounts.length + " mount" + (mounts.length === 1 ? "" : "s");
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>';
  footerEl.innerHTML =
    '<button class="btn btn-sm btn-secondary" id="btn-storage-panel-close-btn">Close</button>';
  requestAnimationFrame(function () {
    document.getElementById("storage-panel-overlay").classList.add("open");
  });
  document.getElementById("btn-storage-panel-close-btn").addEventListener("click", closeStoragePanel);

  var rangeBtns = _chartRangeBtnsHTML("storage-range-btn", [
    { value: "1h",  label: "1h" },
    { value: "24h", label: "24h" },
    { value: "7d",  label: "7d" },
    { value: "30d", label: "30d" },
    { value: "custom", label: "Custom…", id: "btn-storage-custom" },
  ], "assetStorage", "24h");
  var storageCustomPanel =
    '<div id="storage-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
      '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="storage-custom-from" class="form-input" style="padding:2px 6px"></label>' +
      '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="storage-custom-to" class="form-input" style="padding:2px 6px"></label>' +
      '<button class="btn btn-sm btn-primary" id="btn-storage-custom-apply">Apply</button>' +
    '</div>';

  // Build per-mount section markup up front so the layout settles before the
  // (parallel) history fetches resolve. Each section carries data-mount so
  // re-renders and scroll-to-focus can target it by mount path.
  var sectionsHtml = mounts.map(function (m, i) {
    var safeMount = escapeHtml(m.mountPath);
    var latestPct = (m.totalBytes && m.usedBytes != null && m.totalBytes > 0)
      ? ((m.usedBytes / m.totalBytes) * 100).toFixed(1) + "%"
      : "—";
    var latestUsed  = (m.usedBytes  != null) ? _fmtBytes(m.usedBytes)  : "—";
    var latestTotal = (m.totalBytes != null) ? _fmtBytes(m.totalBytes) : "—";
    return (
      '<section class="storage-mount-section" data-mount="' + safeMount + '" data-mount-idx="' + i + '"' +
        ' style="border-top:1px solid var(--color-border);padding-top:1rem;margin-top:1rem;transition:background-color 1.2s ease">' +
        '<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.5rem">' +
          '<div>' +
            '<h5 class="mono" style="margin:0;font-size:0.95rem">' + safeMount + '</h5>' +
            '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:2px">' +
              'Latest: <strong>' + latestUsed + '</strong> / ' + latestTotal + ' (' + latestPct + ')' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:6px" data-storage-forecast-toggle></div>' +
        '</div>' +
        '<div data-storage-forecast-headline style="margin:0.25rem 0 0.5rem;font-size:0.85rem"></div>' +
        '<div data-storage-stats style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
        '<div data-storage-chart class="storage-chart-box"></div>' +
      '</section>'
    );
  }).join("");

  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;gap:0.75rem;flex-wrap:wrap">' +
        '<h4 style="margin:0">Usage history</h4>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
      storageCustomPanel +
      '<div style="display:flex;align-items:center;gap:0.75rem;margin:0.5rem 0 0.25rem;flex-wrap:wrap">' +
        '<div style="display:flex;gap:6px" id="storage-view-toggle"></div>' +
        '<span style="font-size:0.78rem;color:var(--color-text-secondary)">Applies to every mount below.</span>' +
      '</div>' +
      sectionsHtml +
    '</div>';
  document.querySelectorAll(".storage-chart-box").forEach(function (el) {
    el.style.background = "var(--color-bg-elevated)";
    el.style.border = "1px solid var(--color-border)";
    el.style.borderRadius = "6px";
    el.style.padding = "0.5rem";
    el.style.minHeight = "180px";
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.color = "var(--color-text-secondary)";
    el.style.fontSize = "0.85rem";
  });
  _renderStorageViewToggle();
  mounts.forEach(function (m) { _renderStorageForecastToggleFor(asset.id, m.mountPath); });

  await _loadAllStorageForAsset(asset.id, mounts.map(function (m) { return m.mountPath; }), _getChartRangePref("assetStorage", "24h"));
  if (focusMountPath) _scrollStorageSectionIntoView(focusMountPath);

  document.querySelectorAll(".storage-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      var panel = document.getElementById("storage-custom-panel");
      if (range === "custom") {
        if (!panel) return;
        var willOpen = panel.style.display === "none";
        panel.style.display = willOpen ? "flex" : "none";
        if (willOpen) {
          var toInput   = document.getElementById("storage-custom-to");
          var fromInput = document.getElementById("storage-custom-from");
          if (toInput && !toInput.value) toInput.value = _toLocalDatetimeInput(new Date());
          if (fromInput && !fromInput.value) fromInput.value = _toLocalDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000));
        }
        return;
      }
      if (panel) panel.style.display = "none";
      document.querySelectorAll(".storage-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _setChartRangePref("assetStorage", range);
      _loadAllStorageForAsset(asset.id, mounts.map(function (m) { return m.mountPath; }), range);
    });
  });
  var storageCustomApply = document.getElementById("btn-storage-custom-apply");
  if (storageCustomApply) {
    storageCustomApply.addEventListener("click", function () {
      var fromInput = document.getElementById("storage-custom-from");
      var toInput   = document.getElementById("storage-custom-to");
      if (!fromInput.value || !toInput.value) { showToast("Enter both From and To", "error"); return; }
      var fromIso = new Date(fromInput.value).toISOString();
      var toIso   = new Date(toInput.value).toISOString();
      if (new Date(fromIso) >= new Date(toIso)) { showToast("From must be before To", "error"); return; }
      document.querySelectorAll(".storage-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      var customBtn = document.getElementById("btn-storage-custom");
      if (customBtn) { customBtn.classList.remove("btn-secondary"); customBtn.classList.add("btn-primary"); }
      _loadAllStorageForAsset(asset.id, mounts.map(function (m) { return m.mountPath; }), { from: fromIso, to: toIso });
    });
  }
}

function _findStorageSection(mountPath) {
  if (!mountPath) return null;
  // Use attribute selector with CSS.escape so unusual mount paths like
  // "C:" / "/var/log" don't break the selector. CSS.escape is available
  // in every browser Polaris supports.
  try {
    return document.querySelector('.storage-mount-section[data-mount="' + CSS.escape(mountPath) + '"]');
  } catch (_) {
    var sections = document.querySelectorAll(".storage-mount-section");
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].getAttribute("data-mount") === mountPath) return sections[i];
    }
    return null;
  }
}

function _scrollStorageSectionIntoView(mountPath) {
  var section = _findStorageSection(mountPath);
  if (!section) return;
  // Defer a tick so the just-rendered charts have their final layout before
  // we measure scroll position.
  setTimeout(function () {
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    // Brief highlight to make the target obvious — fades via the
    // 1.2s background-color transition declared in the section style.
    section.style.backgroundColor = "var(--color-accent-soft, rgba(79,195,247,0.15))";
    setTimeout(function () { section.style.backgroundColor = "transparent"; }, 900);
  }, 30);
}

// Module-level cache of the most recent storage panel state so toggle clicks
// (view + forecast visibility) can re-render without re-fetching. Reset on
// every _loadAllStorageForAsset call.
//   { assetId, mounts: [{ mountPath, data, samples, forecast, error? }] }
var _storagePanelState = null;

function _renderStorageViewToggle() {
  var bar = document.getElementById("storage-view-toggle");
  if (!bar) return;
  var view = _getStorageViewPref();
  bar.innerHTML =
    '<button class="btn btn-sm ' + (view === "pct"   ? 'btn-primary' : 'btn-secondary') + ' storage-view-btn" data-view="pct">Used %</button>' +
    '<button class="btn btn-sm ' + (view === "bytes" ? 'btn-primary' : 'btn-secondary') + ' storage-view-btn" data-view="bytes">Used bytes</button>';
  bar.querySelectorAll(".storage-view-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var next = b.getAttribute("data-view");
      if (next === _getStorageViewPref()) return;
      _setStorageViewPref(next);
      _renderStorageViewToggle();
      _rerenderAllStorageSectionsFromState();
    });
  });
}

function _renderStorageForecastToggleFor(assetId, mountPath) {
  var section = _findStorageSection(mountPath);
  if (!section) return;
  var bar = section.querySelector("[data-storage-forecast-toggle]");
  if (!bar) return;
  var on = _getStorageForecastVisible(assetId, mountPath);
  bar.innerHTML =
    '<button class="btn btn-sm ' + (on ? 'btn-primary' : 'btn-secondary') + '" title="Per asset and mount; default on">' +
      (on ? '✓ Forecast' : 'Forecast') +
    '</button>';
  var btn = bar.querySelector("button");
  if (btn) {
    btn.addEventListener("click", function () {
      var next = !_getStorageForecastVisible(assetId, mountPath);
      _setStorageForecastVisible(assetId, mountPath, next);
      _renderStorageForecastToggleFor(assetId, mountPath);
      _rerenderStorageSectionFromState(mountPath);
    });
  }
}

function _rerenderAllStorageSectionsFromState() {
  var s = _storagePanelState;
  if (!s || !s.mounts) return;
  s.mounts.forEach(function (m) { _rerenderStorageSectionFromState(m.mountPath); });
}

function _rerenderStorageSectionFromState(mountPath) {
  var s = _storagePanelState;
  if (!s || !s.mounts) return;
  var mountState = null;
  for (var i = 0; i < s.mounts.length; i++) {
    if (s.mounts[i].mountPath === mountPath) { mountState = s.mounts[i]; break; }
  }
  if (!mountState) return;
  var section = _findStorageSection(mountPath);
  if (!section) return;
  var chartEl = section.querySelector("[data-storage-chart]");
  var statsEl = section.querySelector("[data-storage-stats]");
  var headEl  = section.querySelector("[data-storage-forecast-headline]");
  if (mountState.error) {
    if (chartEl) chartEl.textContent = "Error: " + mountState.error;
    if (statsEl) statsEl.textContent = "";
    if (headEl)  headEl.innerHTML = "";
    return;
  }
  var view = _getStorageViewPref();
  _renderStorageStats(statsEl, mountState.samples, mountState.data, view);
  _renderStorageForecastHeadline(headEl, mountState.forecast, view);
  _renderStorageChart(chartEl, mountState.samples, {
    since: mountState.data && mountState.data.since,
    until: mountState.data && mountState.data.until,
    subject: mountPath,
    view: view,
    forecast: mountState.forecast,
    forecastVisible: _getStorageForecastVisible(s.assetId, mountPath),
  });
}

async function _loadAllStorageForAsset(assetId, mountPaths, range) {
  if (!Array.isArray(mountPaths) || mountPaths.length === 0) return;
  // Set every section's chart container to "Loading…" up front so the user
  // sees activity across the pane, not just on the focused mount.
  mountPaths.forEach(function (mp) {
    var section = _findStorageSection(mp);
    if (!section) return;
    var chartEl = section.querySelector("[data-storage-chart]");
    var statsEl = section.querySelector("[data-storage-stats]");
    var headEl  = section.querySelector("[data-storage-forecast-headline]");
    if (chartEl) chartEl.textContent = "Loading samples…";
    if (statsEl) statsEl.textContent = "Loading…";
    if (headEl)  headEl.innerHTML = "";
  });

  var reqOpts = (typeof range === "string" || !range) ? { range: range || "24h" } : range;
  var rangeKey = typeof range === "string" ? range : "custom";

  // One {primary, 7d-forecast} pair per mount, deduped to a single fetch
  // when the operator's selected range happens to be 7d. All N pairs fire
  // in parallel under one Promise.all — per-mount failures are caught and
  // stored so one bad mount doesn't take down the rest of the pane.
  var perMount = await Promise.all(mountPaths.map(async function (mountPath) {
    try {
      var primaryPromise = api.assets.storageHistory(assetId, mountPath, reqOpts);
      var forecastPromise = rangeKey === "7d" ? primaryPromise : api.assets.storageHistory(assetId, mountPath, { range: "7d" });
      var pair = await Promise.all([primaryPromise, forecastPromise]);
      var data = pair[0];
      var samples = (data && data.samples) || [];
      var forecastSamples = (pair[1] && pair[1].samples) || [];
      var forecast = _computeStorageForecast(forecastSamples);
      return { mountPath: mountPath, data: data, samples: samples, forecast: forecast };
    } catch (err) {
      return { mountPath: mountPath, error: err && err.message ? err.message : "failed to load" };
    }
  }));

  _storagePanelState = { assetId: assetId, mounts: perMount };
  perMount.forEach(function (m) { _rerenderStorageSectionFromState(m.mountPath); });
}

function _renderStorageStats(container, samples, data, view) {
  if (!container) return;
  var latest = samples.length ? samples[samples.length - 1] : null;
  var parts;
  if (view === "bytes") {
    parts = [
      { label: "Latest used", value: latest && typeof latest.usedBytes  === "number" ? _fmtBytes(latest.usedBytes)  : "—" },
      { label: "Total",       value: latest && typeof latest.totalBytes === "number" ? _fmtBytes(latest.totalBytes) : "—" },
      { label: "Free",        value: (latest && typeof latest.totalBytes === "number" && typeof latest.usedBytes === "number")
                                     ? _fmtBytes(Math.max(0, latest.totalBytes - latest.usedBytes))
                                     : "—" },
    ];
  } else {
    var pcts = [];
    samples.forEach(function (s) {
      if (s.totalBytes && s.usedBytes != null && s.totalBytes > 0) {
        pcts.push((s.usedBytes / s.totalBytes) * 100);
      }
    });
    var minP = pcts.length ? Math.min.apply(null, pcts) : null;
    var maxP = pcts.length ? Math.max.apply(null, pcts) : null;
    var avgP = pcts.length ? pcts.reduce(function (a, b) { return a + b; }, 0) / pcts.length : null;
    var latestPct = (latest && latest.totalBytes && latest.usedBytes != null && latest.totalBytes > 0)
      ? ((latest.usedBytes / latest.totalBytes) * 100)
      : null;
    parts = [
      { label: "Latest", value: latestPct != null ? latestPct.toFixed(1) + "%" : "—" },
      { label: "Avg",    value: avgP      != null ? avgP.toFixed(1)      + "%" : "—" },
      { label: "Min",    value: minP      != null ? minP.toFixed(1)      + "%" : "—" },
      { label: "Max",    value: maxP      != null ? maxP.toFixed(1)      + "%" : "—" },
    ];
  }
  var tier = _tierStatsPart(data);
  if (tier) parts.unshift(tier);
  _renderChartStats(container, samples.length, parts);
}

// Linear least-squares over the last 7 days of usedBytes samples. Treats the
// latest sample's totalBytes as the projection target (FortiOS volume resizes
// are rare; assuming a fixed denominator avoids regressing two correlated
// series). Returns null when there are fewer than two samples or the latest
// sample has no totalBytes — caller renders "no data" in that case.
//
// `signal` semantics:
//   "growing"        — slope > 0 and daysToFull ≤ 365
//   "beyond-horizon" — slope > 0 but daysToFull > 365 (negligible growth)
//   "flat"           — |slope| × 7d projection is < 0.1% of totalBytes
//   "shrinking"      — slope < 0 with measurable shrink
function _computeStorageForecast(samples) {
  if (!Array.isArray(samples)) return null;
  var pts = [];
  for (var i = 0; i < samples.length; i++) {
    var s = samples[i];
    if (typeof s.usedBytes !== "number") continue;
    var ts = new Date(s.timestamp).getTime();
    if (!isFinite(ts)) continue;
    pts.push({ ts: ts, used: s.usedBytes, total: s.totalBytes });
  }
  if (pts.length < 2) return null;
  // Latest non-null totalBytes from the series — used as the projection
  // ceiling. Falls back to scanning the most recent samples that have it set.
  var totalBytes = null;
  for (var k = pts.length - 1; k >= 0; k--) {
    if (typeof pts[k].total === "number" && pts[k].total > 0) { totalBytes = pts[k].total; break; }
  }
  if (totalBytes == null) return null;
  // Least-squares: regress used = m * ts + b.
  var n = pts.length, sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (var j = 0; j < n; j++) {
    sumX  += pts[j].ts;
    sumY  += pts[j].used;
    sumXY += pts[j].ts * pts[j].used;
    sumXX += pts[j].ts * pts[j].ts;
  }
  var denom = (n * sumXX) - (sumX * sumX);
  if (denom === 0) return null;
  var slopePerMs = ((n * sumXY) - (sumX * sumY)) / denom;
  var intercept  = (sumY - slopePerMs * sumX) / n;
  var msPerDay = 86400000;
  var slopePerDay = slopePerMs * msPerDay;
  var latest = pts[pts.length - 1];
  // Significance threshold: 7-day projected change less than 0.1% of total.
  var sevenDayDelta = Math.abs(slopePerDay) * 7;
  var significanceFloor = totalBytes * 0.001;
  var signal;
  var daysToFull = null;
  if (sevenDayDelta < significanceFloor) {
    signal = "flat";
  } else if (slopePerDay < 0) {
    signal = "shrinking";
  } else {
    var remaining = totalBytes - latest.used;
    if (remaining <= 0) {
      daysToFull = 0;
      signal = "growing";
    } else {
      daysToFull = remaining / slopePerDay;
      signal = daysToFull > 365 ? "beyond-horizon" : "growing";
    }
  }
  return {
    slopePerMs: slopePerMs,
    slopePerDay: slopePerDay,
    intercept: intercept,
    latestTs: latest.ts,
    latestUsed: latest.used,
    totalBytes: totalBytes,
    daysToFull: daysToFull,
    signal: signal,
  };
}

function _renderStorageForecastHeadline(container, forecast, view) {
  if (!container) return;
  if (!forecast) { container.innerHTML = ""; return; }
  var color = "var(--color-text-secondary)";
  var headline;
  if (forecast.signal === "growing") {
    var days = forecast.daysToFull;
    if (days != null && days < 30) color = "var(--color-danger, #e63946)";
    else if (days != null && days < 90) color = "var(--color-warning, #f4a261)";
    else color = "var(--color-success, #2a9d8f)";
    headline = "Days until full: <strong>" + (days != null ? days.toFixed(days < 10 ? 1 : 0) : "—") + "</strong>";
    var trendBytes = Math.abs(forecast.slopePerDay);
    if (view === "bytes") {
      headline += ' <span style="color:var(--color-text-secondary)">· trend: +' + _fmtBytes(trendBytes) + "/day</span>";
    } else {
      var pctPerDay = (forecast.slopePerDay / forecast.totalBytes) * 100;
      headline += ' <span style="color:var(--color-text-secondary)">· trend: +' + pctPerDay.toFixed(pctPerDay < 1 ? 2 : 1) + "%/day</span>";
    }
  } else if (forecast.signal === "shrinking") {
    color = "var(--color-success, #2a9d8f)";
    headline = "Shrinking";
    var shrinkBytes = Math.abs(forecast.slopePerDay);
    if (view === "bytes") {
      headline += ' <span style="color:var(--color-text-secondary)">· −' + _fmtBytes(shrinkBytes) + "/day</span>";
    } else {
      var shrinkPct = Math.abs((forecast.slopePerDay / forecast.totalBytes) * 100);
      headline += ' <span style="color:var(--color-text-secondary)">· −' + shrinkPct.toFixed(shrinkPct < 1 ? 2 : 1) + "%/day</span>";
    }
  } else if (forecast.signal === "beyond-horizon") {
    color = "var(--color-success, #2a9d8f)";
    headline = "Days until full: <strong>&gt; 1 year</strong>";
  } else {
    headline = "No measurable growth";
  }
  container.innerHTML = '<span style="color:' + color + '">' + headline + "</span>";
}

// Unified storage chart. `view` ∈ "pct" | "bytes". When `opts.forecast` is
// present and `opts.forecastVisible` is true and the forecast is growing,
// the X-axis extends to the right by up to one history-span so the projected
// dashed line is visible without compressing history off the chart.
function _renderStorageChart(container, samples, opts) {
  if (!container) return;
  opts = opts || {};
  var view = opts.view === "bytes" ? "bytes" : "pct";
  var forecast = opts.forecast || null;
  var forecastVisible = opts.forecastVisible !== false && forecast != null;
  // Draw the projection for every non-null forecast — flat and shrinking
  // trajectories are useful information too. Only skip when we don't have
  // enough data to regress (forecast === null).
  var drawForecast = forecastVisible && forecast != null;

  if (view === "bytes") {
    var used  = samples.map(function (s) { return { ts: s.timestamp, v: s.usedBytes }; }).filter(function (e) { return typeof e.v === "number"; });
    var total = samples.map(function (s) { return { ts: s.timestamp, v: s.totalBytes }; }).filter(function (e) { return typeof e.v === "number"; });
    if (used.length === 0 && total.length === 0) {
      container.textContent = "No usage samples in this range yet.";
      return;
    }
  } else {
    var pctValues = samples.map(function (s) {
      var pct = (s.totalBytes && s.usedBytes != null && s.totalBytes > 0) ? (s.usedBytes / s.totalBytes) * 100 : null;
      return { ts: s.timestamp, v: pct };
    }).filter(function (e) { return typeof e.v === "number"; });
    if (pctValues.length === 0) {
      container.textContent = "No usage % samples in this range yet.";
      return;
    }
  }

  var W = container.clientWidth || 600, H = 180;
  var padL = view === "bytes" ? 64 : 44, padR = 10, padT = 10, padB = 32;
  var innerW = W - padL - padR, innerH = H - padT - padB;
  var bounds = _chartTimeBounds(samples, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var historySpan = Math.max(1, t1 - t0);
  var forecastEndTs = null;
  if (drawForecast) {
    // Always extend the X-axis by exactly one history-span so the projection
    // half of the chart sits next to a same-scale history half — a 1h range
    // shows 1h of history + 1h of future, a 7d range shows 7d + 7d, etc.
    // Flat and shrinking trajectories still get the extension so the dashed
    // line is visible; "growing" trajectories with daysToFull < historySpan
    // get clipped to the 100% line by the Y-axis cap below.
    forecastEndTs = forecast.latestTs + historySpan;
    if (forecastEndTs > t1) t1 = forecastEndTs;
  }
  var spanMs = t1 - t0, oneDayMs = 86400000;
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function fmtTick(ts) {
    var d = new Date(ts);
    if (spanMs <= oneDayMs) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  var ceil;
  if (view === "bytes") {
    var maxV = 0;
    samples.forEach(function (s) {
      if (typeof s.usedBytes  === "number" && s.usedBytes  > maxV) maxV = s.usedBytes;
      if (typeof s.totalBytes === "number" && s.totalBytes > maxV) maxV = s.totalBytes;
    });
    if (maxV <= 0) maxV = 1;
    function tidyCeil(n) {
      var exp = Math.pow(10, Math.floor(Math.log10(n)));
      var mant = n / exp;
      var step = mant <= 1 ? 1 : mant <= 2 ? 2 : mant <= 5 ? 5 : 10;
      return step * exp;
    }
    ceil = tidyCeil(maxV);
  } else {
    ceil = 100;
  }
  function xFor(ts) { return padL + ((new Date(ts).getTime() - t0) / (t1 - t0)) * innerW; }
  function yFor(v) { return padT + innerH - (v / ceil) * innerH; }

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = ceil * i / 4;
    var y = padT + innerH - (i / 4) * innerH;
    var label = view === "bytes" ? _fmtBytes(v) : v.toFixed(0) + "%";
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + label + '</text>';
  }
  var xTicks = "";
  for (var j = 0; j <= 5; j++) {
    var tsTick = t0 + (t1 - t0) * (j / 5);
    var xPos = padL + (j / 5) * innerW;
    xTicks +=
      '<line x1="' + xPos + '" y1="' + (padT + innerH) + '" x2="' + xPos + '" y2="' + (padT + innerH + 3) + '" stroke="rgba(127,127,127,0.4)"/>' +
      '<text x="' + xPos + '" y="' + (padT + innerH + 14) + '" text-anchor="middle" font-size="10" fill="currentColor">' + fmtTick(tsTick) + '</text>';
  }

  // Build main series, hit-targets, and forecast overlay per view.
  var seriesSvg = "", hitSvg = "", legendSvg = "", forecastSvg = "", nowMarkerSvg = "";
  if (view === "bytes") {
    var usedPts  = samples.filter(function (s) { return typeof s.usedBytes  === "number"; }).map(function (s) { return xFor(s.timestamp) + "," + yFor(s.usedBytes);  }).join(" ");
    var totalPts = samples.filter(function (s) { return typeof s.totalBytes === "number"; }).map(function (s) { return xFor(s.timestamp) + "," + yFor(s.totalBytes); }).join(" ");
    seriesSvg =
      (totalPts ? '<polyline points="' + totalPts + '" fill="none" stroke="#9b5de5" stroke-width="1.5" stroke-dasharray="4 3"/>' : '') +
      (usedPts  ? '<polyline points="' + usedPts  + '" fill="none" stroke="var(--color-accent)" stroke-width="1.5"/>' : '') +
      samples.filter(function (s) { return typeof s.totalBytes === "number"; }).map(function (s) { return '<circle cx="' + xFor(s.timestamp) + '" cy="' + yFor(s.totalBytes) + '" r="1.5" fill="#9b5de5"/>'; }).join("") +
      samples.filter(function (s) { return typeof s.usedBytes  === "number"; }).map(function (s) { return '<circle cx="' + xFor(s.timestamp) + '" cy="' + yFor(s.usedBytes)  + '" r="1.5" fill="var(--color-accent)"/>'; }).join("");
    legendSvg =
      '<g font-size="10" fill="currentColor">' +
        '<rect x="' + (padL + 10) + '" y="2" width="10" height="10" fill="var(--color-accent)"/>' +
        '<text x="' + (padL + 24) + '" y="11">Used</text>' +
        '<rect x="' + (padL + 80) + '" y="2" width="10" height="10" fill="#9b5de5"/>' +
        '<text x="' + (padL + 94) + '" y="11">Total</text>' +
        (drawForecast ? '<line x1="' + (padL + 150) + '" y1="7" x2="' + (padL + 168) + '" y2="7" stroke="var(--color-accent)" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.7"/><text x="' + (padL + 172) + '" y="11">Forecast</text>' : '') +
      '</g>';
    hitSvg = samples.map(function (s) {
      var y = padT + innerH;
      if (typeof s.usedBytes  === "number") y = Math.min(y, yFor(s.usedBytes));
      if (typeof s.totalBytes === "number") y = Math.min(y, yFor(s.totalBytes));
      return '<circle class="chart-hit" cx="' + xFor(s.timestamp) + '" cy="' + y + '" r="6" fill="transparent" style="cursor:crosshair"' +
        ' data-ts="' + escapeHtml(String(s.timestamp)) + '"' +
        ' data-used="'  + (typeof s.usedBytes  === "number" ? s.usedBytes  : "") + '"' +
        ' data-total="' + (typeof s.totalBytes === "number" ? s.totalBytes : "") + '"/>';
    }).join("");
  } else {
    var pctSeries = samples.map(function (s) {
      var pct = (s.totalBytes && s.usedBytes != null && s.totalBytes > 0) ? (s.usedBytes / s.totalBytes) * 100 : null;
      return { ts: s.timestamp, v: pct };
    }).filter(function (e) { return typeof e.v === "number"; });
    var pctPts = pctSeries.map(function (e) { return xFor(e.ts) + "," + yFor(e.v); }).join(" ");
    seriesSvg =
      '<polyline points="' + pctPts + '" fill="none" stroke="var(--color-accent)" stroke-width="1.5"/>' +
      pctSeries.map(function (e) { return '<circle cx="' + xFor(e.ts) + '" cy="' + yFor(e.v) + '" r="1.5" fill="var(--color-accent)"/>'; }).join("");
    if (drawForecast) {
      legendSvg =
        '<g font-size="10" fill="currentColor">' +
          '<line x1="' + (padL + 10) + '" y1="7" x2="' + (padL + 28) + '" y2="7" stroke="var(--color-accent)" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.7"/>' +
          '<text x="' + (padL + 32) + '" y="11">Forecast</text>' +
        '</g>';
    }
    hitSvg = pctSeries.map(function (e) {
      return '<circle class="chart-hit" cx="' + xFor(e.ts) + '" cy="' + yFor(e.v) + '" r="6" fill="transparent" style="cursor:crosshair"' +
        ' data-ts="' + escapeHtml(String(e.ts)) + '" data-v="' + e.v + '"/>';
    }).join("");
  }

  // Forecast overlay — dashed line in same color as the active series.
  // Drawn for every signal (growing / flat / shrinking / beyond-horizon)
  // so the operator always sees the projected trajectory next to history.
  if (drawForecast) {
    var fStart = forecast.latestTs;
    var fEnd   = forecastEndTs;
    var fStartV, fEndV;
    if (view === "bytes") {
      fStartV = forecast.latestUsed;
      fEndV   = forecast.intercept + forecast.slopePerMs * fEnd;
      if (fEndV > ceil) fEndV = ceil;
      if (fEndV < 0) fEndV = 0;
    } else {
      fStartV = (forecast.latestUsed / forecast.totalBytes) * 100;
      var projectedUsed = forecast.intercept + forecast.slopePerMs * fEnd;
      var projectedPct  = (projectedUsed / forecast.totalBytes) * 100;
      fEndV = Math.max(0, Math.min(100, projectedPct));
    }
    var x1 = xFor(fStart), y1 = yFor(fStartV);
    var x2 = xFor(fEnd),   y2 = yFor(fEndV);
    forecastSvg =
      '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"' +
        ' stroke="var(--color-accent)" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.7"/>';
    // Vertical "now" divider at the projection origin.
    nowMarkerSvg =
      '<line x1="' + x1 + '" y1="' + padT + '" x2="' + x1 + '" y2="' + (padT + innerH) + '"' +
        ' stroke="rgba(127,127,127,0.55)" stroke-width="1" stroke-dasharray="2,3"/>' +
      '<text x="' + (x1 + 3) + '" y="' + (padT + 9) + '" font-size="9" fill="currentColor" opacity="0.7">now</text>';
  }

  var clipId = _chartClipId("storage");
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        seriesSvg +
        forecastSvg +
        nowMarkerSvg +
        hitSvg +
      '</g>' +
      legendSvg +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  if (view === "bytes") {
    _wireChartTooltip(container, function (target) {
      var u = target.getAttribute("data-used");
      var t = target.getAttribute("data-total");
      return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
        '<div>Used: '  + (u !== "" ? _fmtBytes(Number(u)) : "—") + '</div>' +
        '<div>Total: ' + (t !== "" ? _fmtBytes(Number(t)) : "—") + '</div>';
    });
    _addChartScreenshotButton(container, "Storage usage (bytes)", { yAxis: "Bytes", subject: opts.subject });
  } else {
    _wireChartTooltip(container, function (target) {
      return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
        '<div>Used: ' + Number(target.getAttribute("data-v")).toFixed(2) + '%</div>';
    });
    _addChartScreenshotButton(container, "Storage usage %", { yAxis: "Used %", subject: opts.subject });
  }
  _observeChartResize(container, function (c) { _renderStorageChart(c, samples, opts); });
}

// Find the visible content of the asset details slide-in: the active tab
// panel when the slide-in is rendered with tabs, otherwise the body itself
// (modal-style edit views without tabs).
function _activeAssetPanel() {
  var panels = document.querySelectorAll('[id^="asset-view-tab-"]');
  for (var i = 0; i < panels.length; i++) {
    if (panels[i].classList.contains('active')) return panels[i];
  }
  return document.getElementById('asset-panel-body') ||
         document.querySelector('#modal-overlay .modal-body');
}

function _activeAssetTabLabel() {
  var btn = document.querySelector('#asset-view-tabs .page-tab.active');
  return btn ? (btn.innerText || btn.textContent || '').trim() : '';
}

// Walk the active tab panel and extract structured content blocks for the
// plaintext Copy button (the Screenshot button rasterizes the live DOM via
// html-to-image instead — see _runScreenshotCapture). Five block shapes:
//   { type: 'kv',      label, value }   from .detail-row pairs (General tab)
//   { type: 'table',   headers, rows }  from any <table> (System/Quarantine/etc.)
//   { type: 'heading', text }           from .section-label and <h1>-<h6>
//   { type: 'chart',   svg }            from any rendered chart <svg>
//                                       (skipped by the plaintext copy)
//   { type: 'text',    lines }          free-form panel text (Polaris Agent
//                                       block, chart stat lines, source badges)
//                                       with interactive/icon subtrees stripped
// Buttons, inputs, the gear/screenshot wraps, and hidden nodes are skipped.
function _extractTabBlocks(root) {
  if (!root) return [];
  // Interactive + icon scaffolding: never carries content worth capturing, and
  // (gear/screenshot wraps, resize handles) would otherwise leak into text.
  var SKIP_SEL = 'button,input,select,textarea,.sf-col-gear-wrap,.chart-screenshot-btn,.sf-resize-handle,script,style';
  var blocks = [];
  function isHidden(el) {
    if (!el) return true;
    var cs = el.ownerDocument && el.ownerDocument.defaultView
      ? el.ownerDocument.defaultView.getComputedStyle(el)
      : null;
    return cs && (cs.display === 'none' || cs.visibility === 'hidden');
  }
  // Collect visible, non-interactive text from a free-form subtree, one line
  // per block-level leaf so the Polaris Agent grid ("Version: …", "Platform: …")
  // and stat strips render as readable lines rather than one run-on string.
  function collectTextLines(el) {
    var lines = [];
    function isBlockish(c) {
      var cs = el.ownerDocument.defaultView.getComputedStyle(c);
      var d = cs ? cs.display : '';
      return d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item' ||
        /^(DIV|P|LI|TR|SECTION|UL|OL|H[1-6])$/.test(c.tagName);
    }
    function hasBlockChild(node) {
      for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        if (isHidden(c) || (c.matches && c.matches(SKIP_SEL))) continue;
        if (isBlockish(c)) return true;
      }
      return false;
    }
    function pushLeaf(node) {
      var clone = node.cloneNode(true);
      if (clone.querySelectorAll) {
        Array.prototype.forEach.call(clone.querySelectorAll(SKIP_SEL), function (n) {
          if (n.parentNode) n.parentNode.removeChild(n);
        });
      }
      var t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
    }
    function rec(node) {
      if (hasBlockChild(node)) {
        for (var i = 0; i < node.childNodes.length; i++) {
          var c = node.childNodes[i];
          if (c.nodeType === 3) {
            var t = c.nodeValue.replace(/\s+/g, ' ').trim();
            if (t) lines.push(t);
          } else if (c.nodeType === 1 && !isHidden(c) && !(c.matches && c.matches(SKIP_SEL))) {
            rec(c);
          }
        }
      } else {
        pushLeaf(node);
      }
    }
    rec(el);
    return lines;
  }
  function walk(node) {
    if (!node || node.nodeType !== 1) return;
    var el = node;
    if (isHidden(el)) return;
    // Rendered chart SVG → image block. Skip the camera button's own icon svg
    // and any small decorative/icon svg (charts are large; icons ~14-24px).
    if (el.tagName && el.tagName.toLowerCase() === 'svg') {
      if (!el.closest || !el.closest('.chart-screenshot-btn')) {
        var sr = el.getBoundingClientRect();
        if (sr.width >= 80 && sr.height >= 60) blocks.push({ type: 'chart', svg: el });
      }
      return;
    }
    if (el.matches && el.matches(SKIP_SEL)) return;
    if (el.classList && el.classList.contains('detail-row')) {
      var lbl = el.querySelector('.detail-label');
      var val = el.querySelector('.detail-value');
      if (lbl && val) {
        blocks.push({
          type: 'kv',
          label: (lbl.innerText || lbl.textContent || '').trim(),
          value: (val.innerText || val.textContent || '').trim(),
        });
      }
      return;
    }
    if (el.tagName === 'TABLE') {
      var headers = [];
      el.querySelectorAll('thead th').forEach(function (th) {
        headers.push((th.innerText || th.textContent || '').trim());
      });
      var rows = [];
      el.querySelectorAll('tbody tr').forEach(function (tr) {
        var row = [];
        tr.querySelectorAll('td').forEach(function (td) {
          row.push((td.innerText || td.textContent || '').trim().replace(/\s+/g, ' '));
        });
        if (row.length) rows.push(row);
      });
      if (rows.length) blocks.push({ type: 'table', headers: headers, rows: rows });
      return;
    }
    if (el.classList && el.classList.contains('section-label')) {
      var st = (el.innerText || el.textContent || '').trim();
      if (st) blocks.push({ type: 'heading', text: st });
      return;
    }
    if (/^H[1-6]$/.test(el.tagName)) {
      var ht = (el.innerText || el.textContent || '').trim();
      if (ht) blocks.push({ type: 'heading', text: ht });
      return;
    }
    // Free-form leaf (no structural descendants we handle separately) → text.
    if (!el.querySelector('.detail-row, table, .section-label, h1, h2, h3, h4, h5, h6, svg')) {
      var lines = collectTextLines(el);
      if (lines.length) blocks.push({ type: 'text', lines: lines });
      return;
    }
    for (var i = 0; i < el.childNodes.length; i++) walk(el.childNodes[i]);
  }
  walk(root);
  return blocks;
}

function _copyAssetDetails() {
  var blocks = _extractTabBlocks(_activeAssetPanel());
  if (blocks.length === 0) { showToast("Nothing to copy", "error"); return; }
  var lines = [];
  blocks.forEach(function (b) {
    if (b.type === 'heading') {
      if (lines.length) lines.push('');
      lines.push(b.text);
      lines.push(new Array(b.text.length + 1).join('-'));
    } else if (b.type === 'kv') {
      if (b.value.indexOf('\n') !== -1) {
        var indented = b.value.split('\n').map(function (l) { return '  ' + l; }).join('\n');
        lines.push(b.label + ':\n' + indented);
      } else {
        lines.push(b.label + ': ' + (b.value || '-'));
      }
    } else if (b.type === 'text') {
      (b.lines || []).forEach(function (line) { if (line) lines.push(line); });
    } else if (b.type === 'table') {
      if (b.headers && b.headers.length) lines.push(b.headers.join(' | '));
      b.rows.forEach(function (r) { lines.push(r.join(' | ')); });
    }
    // 'chart' blocks are images — nothing to put in a plaintext copy.
  });
  navigator.clipboard.writeText(lines.join('\n')).then(function () {
    showToast("Asset details copied to clipboard");
  }).catch(function () {
    showToast("Copy failed", "error");
  });
}

// Faithful screenshot of the active tab panel, rendered at a canonical
// CAPTURE_WIDTH so the output is identical regardless of the operator's
// display size or drag-resized slide-over. The live DOM subtree is
// rasterized as-rendered via the vendored html-to-image library: it deep-
// clones the panel, inlines computed styles (incl. pseudo-elements) and the
// page's webfonts, serializes the clone into an SVG <foreignObject>, and lets
// the browser itself paint it onto a canvas — so the PNG matches how the tab
// truly renders at that width (charts, badges, theme colors, fonts). A
// small title strip (hostname + tab label) is drawn above the capture and
// the whole composition gets uniform padding so the screenshot self-
// identifies and breathes after copy/paste. Scrollbar chrome is excluded via
// the .screenshot-hide-scrollbars class (see styles.css). Webfont embedding
// fetches the Google Fonts CSS + woff2 files (allowed by CSP connect-src);
// when they're unreachable the capture still completes, just with fallback
// system fonts. One known fidelity gap: inner scrollable regions render
// scrolled-to-top in the clone (scroll offsets don't survive cloneNode).
//
// `opts.filter` (optional) is forwarded to html-to-image — return false for a
// node to prune it and its whole subtree from the clone. The options modal
// uses it to drop deselected sections. Returns a Promise that resolves when
// the capture has finished (success or toast'd failure — it never rejects).
function _runScreenshotCapture(asset, opts) {
  opts = opts || {};
  var panel = _activeAssetPanel();
  if (!panel) { showToast("Nothing to screenshot", "error"); return Promise.resolve(); }
  if (typeof htmlToImage === "undefined") {
    showToast("Screenshot failed — capture library not loaded", "error");
    return Promise.resolve();
  }

  var cs = getComputedStyle(document.documentElement);
  var bgPrimary = cs.getPropertyValue("--color-bg-primary").trim() || "#ffffff";
  var clrText   = cs.getPropertyValue("--color-text-primary").trim() || "#111";
  var fontSans  = cs.getPropertyValue("--font-sans").trim() || "system-ui,-apple-system,sans-serif";

  var btn = document.getElementById("btn-asset-screenshot");
  if (btn) btn.disabled = true;
  function done() { if (btn) btn.disabled = false; }

  // Capture at a canonical width so the screenshot is independent of the
  // operator's display / drag-resized slide-over (initSlideoverResize stamps
  // an inline width). html-to-image freezes each element's COMPUTED pixel
  // styles into its clone, so the clone can't be reflowed after the fact —
  // the live panel itself must lay out at the target width before cloning.
  // Forcing the slide-over wide also makes every chart re-render at that
  // width via its ResizeObserver, hence the settle delay below. The
  // operator's width is restored as soon as the rasterization settles.
  var CAPTURE_WIDTH = 1100; // px — the slide-over's design max (styles.css clamp)
  var slideover = panel.closest(".slideover");
  var prevWidth = slideover ? slideover.style.width : "";
  if (slideover) slideover.style.width = CAPTURE_WIDTH + "px";

  // Hide scrollbar chrome (panel + every inner scrollable table wrap) for the
  // duration of the capture: `scrollbar-width: none` applied to the live
  // nodes is what the inlined computed styles carry into the clone. On
  // classic-scrollbar platforms (Windows) this also widens scroll containers
  // by the bar width — another reflow the settle delay absorbs.
  panel.classList.add("screenshot-hide-scrollbars");
  function release() {
    panel.classList.remove("screenshot-hide-scrollbars");
    if (slideover) slideover.style.width = prevWidth;
  }

  // Double-rAF puts us past the relayout + ResizeObserver delivery for the
  // width change; the timeout covers the chart re-renders those observers
  // kick off.
  function whenSettled(cb) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        setTimeout(cb, 300);
      });
    });
  }

  var scale = 2;
  return new Promise(function (resolve) {
    whenSettled(function () {
      var captureOpts = { pixelRatio: scale, backgroundColor: bgPrimary };
      if (typeof opts.filter === "function") captureOpts.filter = opts.filter;
      htmlToImage.toCanvas(panel, captureOpts)
        .then(function (capture) {
          release();
          var pad = 24;
          var titleH = 48;
          var w = capture.width / scale;
          var h = capture.height / scale;
          var canvas = document.createElement("canvas");
          canvas.width = (w + pad * 2) * scale;
          canvas.height = (titleH + h + pad) * scale;
          var ctx = canvas.getContext("2d");
          ctx.scale(scale, scale);
          ctx.fillStyle = bgPrimary;
          ctx.fillRect(0, 0, w + pad * 2, titleH + h + pad);
          ctx.fillStyle = clrText;
          ctx.font = "bold 17px " + fontSans;
          var tabLabel = _activeAssetTabLabel();
          var title = "Asset Details" + (asset && asset.hostname ? " — " + asset.hostname : "");
          if (tabLabel) title += " (" + tabLabel + ")";
          ctx.fillText(title, pad, 32);
          // 1:1 device-pixel blit (w×h CSS px under the 2x transform), so the
          // captured tab is never resampled.
          ctx.drawImage(capture, pad, titleH, w, h);
          canvas.toBlob(function (blob) {
            done();
            if (!blob) { showToast("Screenshot failed", "error"); resolve(); return; }
            if (!navigator.clipboard || typeof ClipboardItem === "undefined" || !navigator.clipboard.write) {
              showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
              resolve();
              return;
            }
            navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(function () {
              showToast("Screenshot copied to clipboard");
              resolve();
            }).catch(function () {
              showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
              resolve();
            });
          }, "image/png");
        })
        .catch(function () {
          release();
          done();
          showToast("Screenshot failed", "error");
          resolve();
        });
    });
  });
}

// Enumerate the active tab's screenshot-eligible sections from the live DOM.
// Every tab builder wraps each logical section in a
// `<div data-shot-section="<key>" data-shot-label="<Label>">` (chart-bearing
// sections add data-shot-chart, Interfaces adds data-shot-sub) — so the
// options modal needs no per-tab knowledge: sections absent on this asset
// simply don't render and never appear. Wrappers that are hidden or have no
// real content (an empty async mount like the dependency tree on a
// non-Fortinet asset, or the agent panel with no agent) are skipped.
function _collectShotSections(panel) {
  if (!panel) return [];
  var out = [];
  var els = panel.querySelectorAll("[data-shot-section]");
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.offsetParent === null) continue; // hidden
    var hasContent = (el.textContent || "").trim() !== "" || !!el.querySelector("svg,canvas,img,table");
    if (!hasContent) continue;
    var hasHiddenIfaceSub = false;
    if (el.getAttribute("data-shot-sub") === "hiddenIfaces") {
      var rows = el.querySelectorAll(".iface-inactive,.iface-child");
      for (var r = 0; r < rows.length; r++) {
        if (rows[r].style.display === "none") { hasHiddenIfaceSub = true; break; }
      }
    }
    out.push({
      key: el.getAttribute("data-shot-section"),
      label: el.getAttribute("data-shot-label") || el.getAttribute("data-shot-section"),
      el: el,
      chartKey: el.getAttribute("data-shot-chart") || null,
      hasHiddenIfaceSub: hasHiddenIfaceSub,
    });
  }
  return out;
}

// Current on-screen selection for a chart key — a range string ("1h"…"30d")
// or {from, to} for a custom window. Dispatches to each chart's existing
// getter so the options modal's range pickers default to what's displayed.
function _currentChartSelection(chartKey) {
  if (chartKey === "assetMonitor") return _currentMonitorSelection();
  if (chartKey === "assetSystem") return _currentSystemTabRange();
  if (chartKey === "assetSdwan") {
    var btn = document.querySelector(".sdwan-range-btn.btn-primary");
    return (btn && btn.getAttribute("data-range")) || _getChartRangePref("assetSdwan", "24h");
  }
  return "24h";
}

// Range-swap + capture + restore orchestration behind the options modal's
// Capture button. `choices` is:
//   { exclude: [section wrapper els], hiddenIfaces: bool,
//     charts: [{ chartKey, desired }] }   // desired = string range or {from,to}
// Charts re-render at the desired range (their loaders cancel their own
// auto-refresh timers on entry), hidden interface rows are revealed for the
// capture only, and EVERYTHING is restored in the finally — the operator's
// on-screen ranges, row visibility, and range-button state end unchanged
// (buttons + _setChartRangePref are never touched at all).
var _screenshotBusy = false; // re-entrancy guard across the whole swap→capture→restore span
async function _captureWithChoices(asset, choices) {
  if (_screenshotBusy) return;
  _screenshotBusy = true;
  var shotBtn = document.getElementById("btn-asset-screenshot");
  if (shotBtn) shotBtn.disabled = true;
  try {
    await _captureWithChoicesInner(asset, choices);
  } finally {
    _screenshotBusy = false;
    shotBtn = document.getElementById("btn-asset-screenshot");
    if (shotBtn) shotBtn.disabled = false;
  }
}

async function _captureWithChoicesInner(asset, choices) {
  choices = choices || {};
  var charts = choices.charts || [];
  var priors = {};
  var i;

  async function loadChart(chartKey, selection) {
    if (chartKey === "assetMonitor") {
      await _loadMonitorHistoryFor(asset.id, selection, { silent: true });
    } else if (chartKey === "assetSystem") {
      await _loadSystemTabFor(asset.id, selection, asset, { chartOnly: !!_assetSystemSiCache, silent: true });
    } else if (chartKey === "assetSdwan") {
      var st = _sdwanTabState;
      if (st && st.hcName) {
        await _loadPerfSlaForHealthCheck(asset.id, st.hcName, (st.linksByHc && st.linksByHc[st.hcName]) || [], selection);
      }
    }
  }

  // Swap each chart to the desired range. Sequential keeps the failure
  // story simple; these are sub-second history fetches.
  for (i = 0; i < charts.length; i++) {
    priors[charts[i].chartKey] = _currentChartSelection(charts[i].chartKey);
    await loadChart(charts[i].chartKey, charts[i].desired);
  }

  // Reveal hidden interface rows for the capture. Queried NOW (not at
  // modal-confirm) so an interfaces-table rebuild in between can't orphan
  // the row references.
  var revealed = [];
  var excl = new Set(choices.exclude || []);

  // A swapped chart's range buttons still highlight the operator's on-screen
  // selection (deliberately untouched), which would contradict the captured
  // window — drop the buttons (and any open custom-range panel) from the
  // image for swapped charts only.
  var CHART_UI = {
    assetMonitor: { btnSel: ".asset-monitor-range-btn", panelId: "asset-monitor-custom-panel" },
    assetSystem:  { btnSel: ".asset-system-range-btn",  panelId: "asset-system-custom-panel" },
    assetSdwan:   { btnSel: ".sdwan-range-btn",         panelId: null },
  };
  charts.forEach(function (c) {
    var ui = CHART_UI[c.chartKey];
    if (!ui) return;
    document.querySelectorAll(ui.btnSel).forEach(function (b) { excl.add(b); });
    if (ui.panelId) {
      var p = document.getElementById(ui.panelId);
      if (p) excl.add(p);
    }
  });
  if (choices.hiddenIfaces) {
    var ifaceWrap = document.querySelector('#asset-view-tab-system [data-shot-section="interfaces"]');
    if (ifaceWrap && !excl.has(ifaceWrap)) {
      var rows = ifaceWrap.querySelectorAll(".iface-inactive,.iface-child");
      for (i = 0; i < rows.length; i++) {
        if (rows[i].style.display === "none") {
          revealed.push(rows[i]);
          rows[i].style.display = "";
        }
      }
      // The "Show N inactive interfaces" button row would contradict the
      // now-visible rows — drop it from the capture.
      var toggleRow = document.getElementById("iface-inactive-toggle-row");
      if (toggleRow) excl.add(toggleRow);
    }
  }

  // html-to-image's filter only removes excluded nodes from the CLONE — the
  // live panel's computed height (frozen into the clone's inlined styles)
  // still includes them, so the capture keeps full height with blank gaps
  // where the sections were. Hide the exclusions in the live DOM instead so
  // the panel genuinely reflows before rasterization (_runScreenshotCapture's
  // settle delay absorbs the relayout); the filter stays on as a cheap
  // skip-clone for the same nodes. Prior inline display values are restored
  // in the finally.
  var hiddenForCapture = [];
  excl.forEach(function (el) {
    hiddenForCapture.push({ el: el, prev: el.style.display });
    el.style.display = "none";
  });

  try {
    await _runScreenshotCapture(asset, {
      filter: function (node) { return !(node && excl.has(node)); },
    });
  } finally {
    for (i = 0; i < hiddenForCapture.length; i++) {
      hiddenForCapture[i].el.style.display = hiddenForCapture[i].prev;
    }
    for (i = 0; i < revealed.length; i++) revealed[i].style.display = "none";
    for (i = 0; i < charts.length; i++) {
      try {
        await loadChart(charts[i].chartKey, priors[charts[i].chartKey]);
      } catch (_) { /* one chart failing to restore shouldn't strand the rest */ }
    }
  }
}

// Screenshot options modal — the footer Screenshot button lands here. Lists
// the active tab's sections (from the data-shot-section wrappers) with
// include/exclude checkboxes, an "Include hidden interfaces" sub-option on
// the Interfaces section, and a time-range picker (1h/24h/7d/30d/Custom)
// under each chart-bearing section defaulting to the chart's current
// on-screen selection. Checkbox + hidden-iface choices persist per user+tab
// (polaris-prefs-screenshot-<user>); ranges intentionally don't. Tabs with a
// single plain section (SNMP Walk, Stations) skip the modal entirely.
function _openScreenshotOptions(asset) {
  var panel = _activeAssetPanel();
  if (!panel) { showToast("Nothing to screenshot", "error"); return; }
  if (typeof htmlToImage === "undefined") {
    showToast("Screenshot failed — capture library not loaded", "error");
    return;
  }
  if (_screenshotBusy) return;
  var sections = _collectShotSections(panel);
  var hasOptions = sections.some(function (s) { return s.chartKey || s.hasHiddenIfaceSub; });
  if (sections.length <= 1 && !hasOptions) {
    // Route through the orchestrator (no swaps/exclusions) for its
    // re-entrancy guard.
    _captureWithChoices(asset, {});
    return;
  }

  var activeTabBtn = document.querySelector("#asset-view-tabs .page-tab.active");
  var tabKey = activeTabBtn ? (activeTabBtn.getAttribute("data-tab") || "tab") : "tab";
  var prefs = _getScreenshotPrefs()[tabKey] || {};
  var savedSections = prefs.sections || {};

  var RANGES = ["1h", "24h", "7d", "30d"];
  function rangeSelectHTML(s) {
    var cur = _currentChartSelection(s.chartKey);
    var isCustom = typeof cur !== "string";
    var opts = RANGES.map(function (r) {
      return '<option value="' + r + '"' + (!isCustom && cur === r ? " selected" : "") + '>' + r + '</option>';
    }).join("") + '<option value="custom"' + (isCustom ? " selected" : "") + '>Custom…</option>';
    var fromVal = isCustom ? _toLocalDatetimeInput(new Date(cur.from)) : "";
    var toVal   = isCustom ? _toLocalDatetimeInput(new Date(cur.to))   : "";
    return '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
      '<span style="font-size:0.8rem;color:var(--color-text-secondary)">Time range</span>' +
      '<select class="form-input shot-range" data-chart="' + s.chartKey + '" style="padding:2px 6px;font-size:0.82rem;width:auto">' + opts + '</select>' +
      '<span class="shot-custom-wrap" data-chart="' + s.chartKey + '" style="display:' + (isCustom ? "inline-flex" : "none") + ';align-items:center;gap:4px;font-size:0.8rem">' +
        'From <input type="datetime-local" class="form-input shot-from" data-chart="' + s.chartKey + '" value="' + fromVal + '" style="padding:2px 6px">' +
        'To <input type="datetime-local" class="form-input shot-to" data-chart="' + s.chartKey + '" value="' + toVal + '" style="padding:2px 6px">' +
      '</span>' +
    '</div>';
  }

  var rowsHtml = sections.map(function (s, idx) {
    var checked = savedSections[s.key] !== false;
    var subs = "";
    if (s.hasHiddenIfaceSub) {
      subs += '<label style="display:flex;align-items:center;gap:6px;font-size:0.85rem">' +
        '<input type="checkbox" id="shot-sub-hidden-ifaces"' + (prefs.includeHiddenIfaces === true ? " checked" : "") + '> Include hidden interfaces' +
      '</label>';
    }
    if (s.chartKey) subs += rangeSelectHTML(s);
    var subBlock = subs
      ? '<div class="shot-sub" data-idx="' + idx + '" style="margin:0.35rem 0 0 1.6rem;display:' + (checked ? "flex" : "none") + ';flex-direction:column;gap:0.35rem">' + subs + '</div>'
      : "";
    return '<div style="padding:0.45rem 0;border-bottom:1px solid var(--color-border)">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" class="shot-sec" data-key="' + escapeHtml(s.key) + '" data-idx="' + idx + '"' + (checked ? " checked" : "") + '>' +
        '<span style="font-weight:500">' + escapeHtml(s.label) + '</span>' +
      '</label>' +
      subBlock +
    '</div>';
  }).join("");

  var body =
    '<p style="margin:0 0 0.5rem;font-size:0.85rem;color:var(--color-text-secondary)">Choose which sections of this tab to include in the screenshot.</p>' +
    '<div id="shot-section-list">' + rowsHtml + '</div>';
  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-shot-capture">Capture</button>';
  openModal("Screenshot — " + _activeAssetTabLabel(), body, footer);

  var list = document.getElementById("shot-section-list");
  list.querySelectorAll(".shot-sec").forEach(function (cb) {
    cb.addEventListener("change", function () {
      var sub = list.querySelector('.shot-sub[data-idx="' + cb.getAttribute("data-idx") + '"]');
      if (sub) sub.style.display = cb.checked ? "flex" : "none";
    });
  });
  list.querySelectorAll(".shot-range").forEach(function (sel) {
    sel.addEventListener("change", function () {
      var wrap = list.querySelector('.shot-custom-wrap[data-chart="' + sel.getAttribute("data-chart") + '"]');
      if (wrap) wrap.style.display = sel.value === "custom" ? "inline-flex" : "none";
    });
  });

  document.getElementById("btn-shot-capture").addEventListener("click", async function () {
    var secState = {};
    var excludeEls = [];
    var anyChecked = false;
    list.querySelectorAll(".shot-sec").forEach(function (cb) {
      var idx = Number(cb.getAttribute("data-idx"));
      secState[sections[idx].key] = cb.checked;
      if (cb.checked) anyChecked = true;
      else excludeEls.push(sections[idx].el);
    });
    if (!anyChecked) { showToast("Select at least one section", "error"); return; }

    // Resolve each checked chart section's desired range; validate customs.
    var chartChoices = [];
    var invalid = false;
    sections.forEach(function (s) {
      if (!s.chartKey || secState[s.key] === false) return;
      var sel = list.querySelector('.shot-range[data-chart="' + s.chartKey + '"]');
      if (!sel) return;
      var desired;
      if (sel.value === "custom") {
        var fromEl = list.querySelector('.shot-from[data-chart="' + s.chartKey + '"]');
        var toEl   = list.querySelector('.shot-to[data-chart="' + s.chartKey + '"]');
        if (!fromEl.value || !toEl.value) { invalid = true; return; }
        var fromD = new Date(fromEl.value);
        var toD   = new Date(toEl.value);
        if (!(fromD < toD)) { invalid = true; return; }
        desired = { from: fromD.toISOString(), to: toD.toISOString() };
      } else {
        desired = sel.value;
      }
      // Skip charts already showing the desired window — no swap, no restore.
      var cur = _currentChartSelection(s.chartKey);
      var same = (typeof desired === "string")
        ? desired === cur
        : (typeof cur !== "string" && cur && cur.from === desired.from && cur.to === desired.to);
      if (!same) chartChoices.push({ chartKey: s.chartKey, desired: desired });
    });
    if (invalid) { showToast("Custom range needs valid From/To with From before To", "error"); return; }

    var hiddenIfaces = false;
    var hiddenCb = document.getElementById("shot-sub-hidden-ifaces");
    if (hiddenCb && hiddenCb.checked && secState.interfaces !== false) hiddenIfaces = true;

    _setScreenshotPrefs(tabKey, { sections: secState, includeHiddenIfaces: hiddenCb ? hiddenCb.checked : prefs.includeHiddenIfaces === true });
    closeModal();
    await _captureWithChoices(asset, { exclude: excludeEls, hiddenIfaces: hiddenIfaces, charts: chartChoices });
  });
}

// Per-table screenshot (the camera button injected to the left of a table's
// column-chooser gear by setupColumnLayout). Captures only that table — visible
// columns + headers — titled with the table label and the current asset name,
// then copies the PNG to the clipboard. Column widths auto-fit the content.
function _screenshotTableEl(tableEl, label, opts) {
  if (!tableEl) { showToast("Nothing to screenshot", "error"); return; }
  opts = opts || {};
  var hiddenNoun = opts.hiddenNoun || "row";
  var view = (tableEl.ownerDocument && tableEl.ownerDocument.defaultView) || window;
  function visible(el) {
    var cs = view.getComputedStyle(el);
    return !cs || (cs.display !== 'none' && cs.visibility !== 'hidden');
  }
  var ths = Array.prototype.slice.call(tableEl.querySelectorAll('thead th'));
  var visMask = ths.map(visible);
  var headers = [];
  ths.forEach(function (th, i) {
    if (visMask[i]) headers.push((th.innerText || th.textContent || '').trim());
  });
  var rows = [];
  // Count data rows the operator has hidden (inactive-interface toggle off, or a
  // collapsed parent). They're left out of the image but we note their count so
  // the screenshot can't be mistaken for the full set — reveal them, then re-shoot.
  var hiddenCount = 0;
  tableEl.querySelectorAll('tbody > tr').forEach(function (tr) {
    if (!visible(tr)) {
      // Skip control rows (toggle / section headers span all columns via colspan).
      if (tr.id && /toggle/i.test(tr.id)) return;
      var tds = tr.querySelectorAll(':scope > td');
      if (tds.length === 0) return;
      if (tds.length === 1 && tds[0].hasAttribute('colspan')) return;
      hiddenCount++;
      return;
    }
    var row = [];
    tr.querySelectorAll(':scope > td').forEach(function (td, i) {
      if (visMask[i] === false) return;   // skip hidden columns
      row.push((td.innerText || td.textContent || '').trim().replace(/\s+/g, ' '));
    });
    if (row.length) rows.push(row);
  });
  if (!rows.length) { showToast("Nothing to screenshot", "error"); return; }

  var hiddenNote = hiddenCount > 0
    ? "+ " + hiddenCount + " hidden " + hiddenNoun + (hiddenCount === 1 ? "" : "s") +
      " not shown — reveal them before screenshotting to include"
    : "";

  var a = _currentAssetForRefresh;
  var assetName = a ? (a.hostname || a.dnsName || a.ipAddress || a.id || "") : "";

  var cs = getComputedStyle(document.documentElement);
  var bgPrimary = cs.getPropertyValue("--color-bg-primary").trim() || "#ffffff";
  var bgSurface = cs.getPropertyValue("--color-surface").trim() || "#f5f5f5";
  var clrBorder = cs.getPropertyValue("--color-border").trim() || "#e0e0e0";
  var clrText   = cs.getPropertyValue("--color-text-primary").trim() || "#111";
  var clrMuted  = cs.getPropertyValue("--color-text-tertiary").trim() || "#888";

  var scale = 2;
  var pad = 20;
  var headerLines = (assetName ? 2 : 1);
  var titleH = headerLines === 2 ? 48 : 32;
  var tableHeaderH = 26;
  var tableRowH = 22;
  var cellPadX = 10;
  var fontFamily = "system-ui,-apple-system,sans-serif";

  var cols = Math.max(1, headers.length || (rows[0] ? rows[0].length : 1));
  var measureCtx = document.createElement("canvas").getContext("2d");
  var colW = [];
  for (var c = 0; c < cols; c++) {
    measureCtx.font = "600 10px " + fontFamily;
    var maxW = headers[c] ? measureCtx.measureText(headers[c].toUpperCase()).width : 0;
    measureCtx.font = "12px " + fontFamily;
    for (var r = 0; r < rows.length; r++) {
      var cell = rows[r][c] || '';
      var cw = measureCtx.measureText(cell).width;
      if (cw > maxW) maxW = cw;
    }
    colW[c] = Math.min(360, Math.max(64, Math.ceil(maxW) + cellPadX * 2));
  }
  var contentW = colW.reduce(function (acc, x) { return acc + x; }, 0);
  var noteH = hiddenNote ? 24 : 0;
  // The note can be wider than the (auto-fit) table — widen the canvas for it.
  var noteW = 0;
  if (hiddenNote) { measureCtx.font = "italic 12px " + fontFamily; noteW = measureCtx.measureText(hiddenNote).width; }
  var w = Math.max(contentW, Math.ceil(noteW)) + pad * 2;
  var hdrH = headers.length ? tableHeaderH : 0;
  var h = titleH + hdrH + rows.length * tableRowH + noteH + pad;

  var canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  var ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = bgPrimary;
  ctx.fillRect(0, 0, w, h);

  function fitText(text, maxTextW) {
    var t = String(text == null ? '' : text);
    while (ctx.measureText(t).width > maxTextW && t.length > 3) {
      t = t.slice(0, -4) + '…';
    }
    return t;
  }

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = clrText;
  ctx.font = "bold 15px " + fontFamily;
  ctx.fillText(label || "Table", pad, 22);
  if (assetName) {
    ctx.fillStyle = clrMuted;
    ctx.font = "12px " + fontFamily;
    ctx.fillText(assetName, pad, 40);
  }

  var ty = titleH;
  if (headers.length) {
    ctx.fillStyle = bgSurface;
    ctx.fillRect(pad, ty, contentW, tableHeaderH);
    ctx.fillStyle = clrMuted;
    ctx.font = "600 10px " + fontFamily;
    var hx = pad;
    for (var hi = 0; hi < cols; hi++) {
      ctx.fillText(fitText((headers[hi] || '').toUpperCase(), colW[hi] - cellPadX * 2), hx + cellPadX, ty + 17);
      hx += colW[hi];
    }
    ty += tableHeaderH;
  }
  ctx.font = "12px " + fontFamily;
  rows.forEach(function (row, ri) {
    if (ri % 2 === 1) {
      ctx.fillStyle = bgSurface;
      ctx.fillRect(pad, ty, contentW, tableRowH);
    }
    ctx.fillStyle = clrText;
    var cx = pad;
    for (var ci = 0; ci < cols; ci++) {
      ctx.fillText(fitText(row[ci] || '', colW[ci] - cellPadX * 2), cx + cellPadX, ty + 15);
      cx += colW[ci];
    }
    ty += tableRowH;
  });
  ctx.strokeStyle = clrBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(pad + 0.5, titleH + 0.5, contentW - 1, ty - titleH - 1);

  if (hiddenNote) {
    ctx.fillStyle = clrMuted;
    ctx.font = "italic 12px " + fontFamily;
    ctx.fillText(hiddenNote, pad, ty + 16);
  }

  canvas.toBlob(function (blob) {
    if (!blob) { showToast("Screenshot failed", "error"); return; }
    if (!navigator.clipboard || typeof ClipboardItem === "undefined" || !navigator.clipboard.write) {
      showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
      return;
    }
    navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(function () {
      showToast((label || "Table") + " copied to clipboard");
    }).catch(function () {
      showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
    });
  }, "image/png");
}

function _wireHoverTriggersIn(container) {
  if (!container) return;
  container.querySelectorAll('.mac-hover-trigger').forEach(function (el) {
    el.addEventListener('mouseenter', _handleMacEnter);
    el.addEventListener('mouseleave', _handleMacLeave);
  });
}

function ipViewRow(asset) {
  var ips = Array.isArray(asset.associatedIps) ? asset.associatedIps : [];
  if (!asset.ipAddress && ips.length === 0) {
    var noIpInner = asset.hostname
      ? '- <button class="btn btn-sm btn-secondary" onclick="singleForwardLookup(\'' + asset.id + '\')" title="Forward DNS lookup (A/AAAA record)">IP Lookup</button>'
      : '-';
    return '<div class="detail-row"><span class="detail-label">IP Address</span>' +
      '<span class="detail-value mono">' + noIpInner + '</span></div>';
  }
  var src = asset.ipSource
    ? '<span style="font-size:0.75rem;color:var(--color-text-tertiary);margin-left:8px">' + escapeHtml(asset.ipSource) + '</span>'
    : '';
  return '<div class="detail-row"><span class="detail-label">IP Address</span>' +
    '<span class="detail-value mono">' + ipCellHTML(asset) + src + '</span></div>';
}

// Operator-facing labels for Asset.lastSeenSource — the evidence that
// produced the current Last Seen value (stamped by the backend's
// bumpLastSeen). Unknown values render verbatim so new backend sources
// degrade gracefully.
var LAST_SEEN_SOURCE_LABELS = {
  "dhcp-lease":       "DHCP lease",
  "device-inventory": "FortiGate inventory",
  "discovery":        "discovery",
  "agent":            "agent heartbeat",
  "probe":            "monitor probe",
  "ping":             "ping",
  "conflict-accept":  "conflict resolution",
  "conflict-reject":  "conflict resolution",
};

// Build the General-tab "Last Seen" detail row. The date renders as plain
// text; the provenance label ("via DHCP lease" etc.) becomes a link into the
// lease slide-over when the asset's IP resolves to a containing subnet — the
// same gate (and target) the table's "View Lease" row action uses. With no
// resolvable network context the label stays plain text.
function lastSeenRowHTML(a) {
  var valueInner;
  if (!a.lastSeen) {
    valueInner = "-";
  } else {
    valueInner = escapeHtml(formatDate(a.lastSeen));
    if (a.lastSeenSource) {
      var srcLabel = LAST_SEEN_SOURCE_LABELS[a.lastSeenSource] || a.lastSeenSource;
      var ctx = a.ipContext;
      if (ctx && ctx.subnetId) {
        var title = "View this IP in " + (ctx.subnetCidr || "its network");
        valueInner += ' · via <a href="#" class="last-seen-source-link" ' +
          'onclick="viewAssetLease(\'' + a.id + '\');return false;" ' +
          'title="' + escapeHtml(title) + '">' + escapeHtml(srcLabel) + '</a>';
      } else {
        valueInner += " · via " + escapeHtml(srcLabel);
      }
    }
  }
  return '<div class="detail-row"><span class="detail-label">Last Seen</span>' +
    '<span class="detail-value">' + valueInner + '</span></div>';
}

function viewRow(label, value, mono, alignRight, copy) {
  var style = alignRight ? ' style="text-align:right"' : '';
  var inner = escapeHtml(value || "-");
  if (copy && value) {
    inner = '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(value) + '">' + inner + '</span>';
  }
  return '<div class="detail-row"><span class="detail-label">' + escapeHtml(label) + '</span>' +
    '<span class="detail-value' + (mono ? ' mono' : '') + '"' + style + '>' + inner + '</span></div>';
}

// Render HA cluster topology on the asset details General tab. Three rows
// (Mode / Role / Peer) appear only when the asset is a Fortinet firewall
// whose `fortinetTopology` carries HA fields. Standalone gates render
// nothing. The peer is shown as a clickable serial — clicking pivots the
// asset details modal to the peer Asset (matched by serialNumber) via the
// same window.openAssetById helper the topology graph and dependency tree
// use.
function haTopologyHTML(asset) {
  var topo = asset && asset.fortinetTopology;
  if (!topo || typeof topo !== "object") return "";
  var mode = topo.haMode;
  var role = topo.haRole;
  var peerSerial = topo.haPeerSerial;
  if (!mode || mode === "standalone" || !role) return "";
  var modeLabel = mode === "a-p" ? "Active / Passive (a-p)"
                : mode === "a-a" ? "Active / Active (a-a)"
                : mode;
  var roleLabel = role === "primary" ? "Primary (active)"
                : role === "secondary" ? "Secondary (standby)"
                : role;
  var roleColor = role === "primary" ? "var(--color-success,#10b981)" : "var(--color-warning,#fbbf24)";
  var roleBadge = '<span style="display:inline-block;padding:1px 8px;border-radius:4px;font-size:0.8rem;background:' +
    roleColor + ';color:#000;font-weight:600">' + escapeHtml(roleLabel) + '</span>';
  var peerHTML = '-';
  if (peerSerial) {
    var serialEsc = escapeHtml(peerSerial);
    peerHTML = '<a href="#" onclick="event.preventDefault(); window.openAssetBySerial && window.openAssetBySerial(\'' +
      serialEsc + '\'); return false" class="mono" title="Open peer asset">' + serialEsc + '</a>';
  }
  return '<div class="detail-row"><span class="detail-label">HA Mode</span><span class="detail-value">' +
    escapeHtml(modeLabel) + '</span></div>' +
    '<div class="detail-row"><span class="detail-label">HA Role</span><span class="detail-value">' + roleBadge + '</span></div>' +
    '<div class="detail-row"><span class="detail-label">HA Peer</span><span class="detail-value mono">' + peerHTML + '</span></div>';
}

function disabledInHTML(tags) {
  var t = Array.isArray(tags) ? tags : [];
  var sources = [];
  if (t.indexOf("entra-disabled") !== -1) sources.push("Entra ID");
  if (t.indexOf("ad-disabled") !== -1) sources.push("Active Directory");
  if (sources.length === 0) return '';
  var badges = sources.map(function (s) {
    return '<span style="display:inline-block;padding:1px 8px;border-radius:4px;font-size:0.8rem;background:var(--color-warning-bg,#7c4a00);color:var(--color-warning,#fbbf24);margin-right:4px">' + escapeHtml(s) + '</span>';
  }).join('');
  return '<div class="detail-row"><span class="detail-label">Disabled In</span><span class="detail-value">' + badges + '</span></div>';
}

function formatMacSource(source) {
  switch (source) {
    case "intune-ethernet": return "Intune — Ethernet";
    case "intune-wifi":     return "Intune — Wi-Fi";
    case "dhcp_reservation":return "DHCP reservation";
    case "dhcp_lease":      return "DHCP lease";
    case "device-inventory":return "Device inventory";
    case "fmg-discovery":   return "FortiManager discovery";
    default: return source || "";
  }
}

function macAddressesViewHTML(macAddresses) {
  if (!macAddresses || macAddresses.length === 0) return '';
  var rows = macAddresses.map(function (m) {
    var sourceLabel = formatMacSource(m.source);
    return '<div style="display:flex;gap:12px;align-items:center;padding:3px 0">' +
      '<code style="font-size:0.82rem">' + escapeHtml(m.mac) + '</code>' +
      '<span style="font-size:0.75rem;color:var(--color-text-tertiary)">' +
        (sourceLabel ? escapeHtml(sourceLabel) : '') +
        (m.lastSeen ? (sourceLabel ? ' &middot; ' : '') + formatDate(m.lastSeen) : '') +
      '</span>' +
    '</div>';
  }).join("");
  var label = macAddresses.length === 1 ? 'MAC History' : 'All MACs (' + macAddresses.length + ')';
  return '<div class="detail-row"><span class="detail-label">' + label + '</span>' +
    '<span class="detail-value">' + rows + '</span></div>';
}

function associatedUsersViewHTML(users) {
  if (!users || users.length === 0) return '';
  var rows = users.map(function (u) {
    var display = u.domain ? escapeHtml(u.domain) + '\\' + escapeHtml(u.user) : escapeHtml(u.user);
    return '<div style="display:flex;gap:12px;align-items:center;padding:3px 0">' +
      '<span style="font-size:0.85rem">' + display + '</span>' +
      '<span style="font-size:0.75rem;color:var(--color-text-tertiary)">' +
        (u.source ? escapeHtml(u.source) : '') +
        (u.lastSeen ? ' &middot; ' + formatDate(u.lastSeen) : '') +
      '</span>' +
    '</div>';
  }).join("");
  return '<div class="detail-row"><span class="detail-label">Associated Users (' + users.length + ')</span>' +
    '<span class="detail-value">' + rows + '</span></div>';
}

async function confirmDelete(id, name) {
  var ok = await showConfirm('Delete asset "' + name + '"? This cannot be undone.');
  if (!ok) return;
  try {
    await api.assets.delete(id);
    showToast("Asset deleted");
    loadAssets();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function dateInputVal(isoStr) {
  if (!isoStr) return "";
  return new Date(isoStr).toISOString().split("T")[0];
}

function val(id) { return document.getElementById(id).value.trim(); }

/* ─── DNS Lookup ─────────────────────────────────────────────────────────── */

async function singleDnsLookup(id, name) {
  try {
    var result = await api.assets.dnsLookup(id);
    if (result.ok) {
      showToast(result.message, "success");
      loadAssets();
      if (_currentAssetForRefresh && _currentAssetForRefresh.id === id) openViewModal(id);
    } else {
      showToast(result.message, "error");
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function singleForwardLookup(id, name) {
  try {
    var result = await api.assets.forwardLookup(id);
    if (result.ok) {
      showToast(result.message, "success");
      loadAssets();
      if (_currentAssetForRefresh && _currentAssetForRefresh.id === id) openViewModal(id);
    } else {
      showToast(result.message, "error");
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

/* ─── OUI Lookup ────────────────────────────────────────────────────────── */

async function bulkOuiLookup() {
  // The lookup itself is server-side and scans the whole fleet (ouiLookupAll),
  // so the confirm can't be scoped to the current page — ask generically and
  // let the server report how many were missing / resolved.
  var ok = await showConfirm("Run OUI manufacturer lookup for all assets missing a manufacturer?");
  if (!ok) return;

  try {
    var result = await api.assets.ouiLookupAll();
    if (!result.total) {
      showToast("All assets with MACs already have a manufacturer", "success");
    } else {
      showToast("OUI resolved " + result.resolved + " of " + result.total + " assets", "success");
    }
    if (result.resolved > 0) loadAssets();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function singleOuiLookup(id, mac) {
  try {
    var result = await api.assets.ouiLookup(id);
    if (result.ok) {
      showToast(result.message, "success");
      loadAssets();
      if (_currentAssetForRefresh && _currentAssetForRefresh.id === id) openViewModal(id);
    } else {
      showToast(result.message, "error");
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

/* ─── Export (PDF / CSV) ──────────────────────────────────────────────────── */

(function () {
  var menu = document.getElementById("export-menu");
  var btn  = document.getElementById("btn-export");
  if (!btn || !menu) return;

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    menu.classList.toggle("open");
  });

  document.addEventListener("click", function () { menu.classList.remove("open"); });
  menu.addEventListener("click", function (e) { e.stopPropagation(); });

  menu.querySelectorAll("button[data-export]").forEach(function (item) {
    item.addEventListener("click", async function () {
      menu.classList.remove("open");
      var mode = this.getAttribute("data-export");
      var fmt  = this.getAttribute("data-fmt");
      await handleAssetExport(mode, fmt);
    });
  });
})();

// Page through GET /assets in 10k-row chunks (the route's max limit) up to a
// hard ceiling, for the "filtered" / "all" export modes. Server-side paging
// means the browser no longer holds the whole table, so export re-fetches.
async function _fetchAssetsForExport(baseParams, signal) {
  var CHUNK = 10000;
  var CEILING = 100000;
  var params = Object.assign({}, baseParams);
  delete params.favoriteIds; // ordering is irrelevant for an export
  params.limit = CHUNK;
  var out = [];
  var total = Infinity;
  while (out.length < total && out.length < CEILING) {
    if (signal && signal.aborted) break;
    params.offset = out.length;
    var data = await request("GET", "/assets" + toQuery(params), undefined, signal);
    var rows = data.assets || [];
    total = (typeof data.total === "number") ? data.total : rows.length;
    if (!rows.length) break;
    out = out.concat(rows);
  }
  return { assets: out, total: total };
}

async function handleAssetExport(mode, fmt) {
  var assets, label, ok;

  if (mode === "page") {
    // _assetsData is already exactly the current page under server-side paging.
    assets = _assetsData;
    label = "page " + _assetsPage;
  } else if (mode === "filtered") {
    // Probe the total for the current filter set before committing to export.
    var probe = await api.assets.list(Object.assign(_buildAssetsQuery(), { limit: 1, offset: 0 }));
    var filteredTotal = probe.total || 0;
    if (filteredTotal === 0) { showToast("No assets to export", "error"); return; }
    label = filteredTotal + " filtered assets";
    if (filteredTotal > 100) {
      ok = await showConfirm("This will export " + filteredTotal + " assets. Continue?");
      if (!ok) return;
    }
  } else if (mode === "all") {
    ok = await showConfirm("Export the entire asset list? This may take a moment.");
    if (!ok) return;
  }

  await trackedPdfExport("Exporting assets " + fmt.toUpperCase(), async function (signal) {
    if (mode === "filtered") {
      var fr = await _fetchAssetsForExport(_buildAssetsQuery(), signal);
      assets = fr.assets;
      label = assets.length + " filtered assets";
    } else if (mode === "all") {
      var ar = await _fetchAssetsForExport({}, signal);
      assets = ar.assets;
      label = "all " + assets.length + " assets";
    }
    if (signal.aborted) return;
    if (!assets || assets.length === 0) { showToast("No assets to export", "error"); return; }
    if (fmt === "csv") generateAssetCsv(assets);
    else generateAssetPdf(assets, label);
  });
}

function generateAssetPdf(assets, label) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("PDF library not loaded. Check your internet connection and reload the page.");
  }
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });

  var now = new Date();
  var timestamp = now.toLocaleDateString() + " " + now.toLocaleTimeString();

  // Title
  doc.setFontSize(16);
  doc.setTextColor(40, 40, 40);
  doc.text((_branding ? _branding.appName : "Polaris") + " \u2014 Asset Report", 40, 36);
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text("Generated: " + timestamp + "  |  Scope: " + label + "  |  Count: " + assets.length, 40, 52);

  var head = [["Hostname", "IP Address", "MAC Address", "DNS Name", "Type", "Status", "Location", "Last Seen"]];
  var body = assets.map(function (a) {
    return [
      a.hostname || "-",
      a.ipAddress || "-",
      a.macAddress || "-",
      a.dnsName || "-",
      ASSET_TYPE_LABELS[a.assetType] || a.assetType || "-",
      a.status ? a.status.charAt(0).toUpperCase() + a.status.slice(1) : "-",
      a.location || a.learnedLocation || "-",
      a.lastSeen ? formatDate(a.lastSeen) : "-",
    ];
  });

  doc.autoTable({
    startY: 64,
    head: head,
    body: body,
    theme: "grid",
    styles: { fontSize: 8, cellPadding: 4, overflow: "linebreak" },
    headStyles: { fillColor: [30, 30, 54], textColor: [230, 230, 230], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 250] },
    margin: { left: 40, right: 40 },
    didDrawPage: function (data) {
      // Footer on each page
      var pageNum = doc.internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(
        "Page " + data.pageNumber + " of " + pageNum + "  |  " + (_branding ? _branding.appName : "Polaris") + " Asset Report",
        doc.internal.pageSize.getWidth() / 2,
        doc.internal.pageSize.getHeight() - 20,
        { align: "center" }
      );
    },
  });

  var filename = "polaris-assets-" + now.toISOString().slice(0, 10) + ".pdf";
  doc.save(filename);
  showToast("Exported " + assets.length + " assets to " + filename);
}

function generateAssetCsv(assets) {
  var headers = ["Hostname", "IP Address", "MAC Address", "DNS Name", "Type", "Status", "Location", "Last Seen", "Serial Number", "Manufacturer", "Model", "OS", "Asset Tag"];
  var rows = assets.map(function (a) {
    return [
      a.hostname || "", a.ipAddress || "", a.macAddress || "", a.dnsName || "",
      ASSET_TYPE_LABELS[a.assetType] || a.assetType || "", a.status || "",
      a.location || a.learnedLocation || "", (a.lastSeen ? formatDate(a.lastSeen) : ""), a.serialNumber || "",
      a.manufacturer || "", a.model || "", a.osVersion || a.os || "", a.assetTag || "",
    ];
  });
  var filename = "polaris-assets-" + new Date().toISOString().slice(0, 10) + ".csv";
  downloadCsv(headers, rows, filename);
  showToast("Exported " + assets.length + " assets to " + filename);
}

/* ─── CSV Import ──────────────────────────────────────────────────────────── */

function _parseCsv(text) {
  var lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  return lines.filter(function (l) { return l.trim(); }).map(function (line) {
    var fields = [];
    var cur = "";
    var inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === "," && !inQuote) { fields.push(cur.trim()); cur = ""; }
      else { cur += ch; }
    }
    fields.push(cur.trim());
    return fields;
  });
}

function _autoDetectCol(headers, patterns) {
  for (var i = 0; i < headers.length; i++) {
    var h = headers[i].toLowerCase().replace(/[\s_\-]+/g, "");
    for (var j = 0; j < patterns.length; j++) {
      if (h.includes(patterns[j])) return i;
    }
  }
  return -1;
}

async function openImportCsvModal(file) {
  var text = await file.text();
  var parsed = _parseCsv(text);
  if (parsed.length < 2) { showToast("CSV appears empty or has only a header row", "error"); return; }

  var headers = parsed[0];
  var dataRows = parsed.slice(1);

  var serialIdx = _autoDetectCol(headers, ["serial", "sn", "serialnum", "serialnumber"]);
  var dateIdx   = _autoDetectCol(headers, ["regdate", "registration", "purchasedate", "acquired", "date", "warranty"]);

  function colOptions(selected) {
    return headers.map(function (h, i) {
      return '<option value="' + i + '"' + (i === selected ? " selected" : "") + '>' + escapeHtml(h) + '</option>';
    }).join("");
  }

  var previewHtml = '<table class="data-table" style="font-size:0.82rem"><thead><tr>' +
    headers.map(function (h) { return '<th>' + escapeHtml(h) + '</th>'; }).join("") +
    '</tr></thead><tbody>' +
    dataRows.slice(0, 5).map(function (r) {
      return '<tr>' + r.map(function (c) { return '<td>' + escapeHtml(c) + '</td>'; }).join("") + '</tr>';
    }).join("") +
    '</tbody></table>';

  var body =
    '<p style="color:var(--color-text-secondary);margin-bottom:1rem">' +
      dataRows.length + ' data row(s) in <strong>' + escapeHtml(file.name) + '</strong>. ' +
      'Map the columns below, then click Preview to see which assets will be updated.' +
    '</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:1rem">' +
      '<div class="form-group"><label>Serial Number column</label>' +
        '<select id="import-col-serial">' + colOptions(serialIdx) + '</select></div>' +
      '<div class="form-group"><label>Registration Date column</label>' +
        '<select id="import-col-date">' + colOptions(dateIdx) + '</select></div>' +
    '</div>' +
    '<details style="margin-bottom:1rem"><summary style="cursor:pointer;color:var(--color-text-secondary);font-size:0.85rem">Preview first 5 rows</summary>' +
      '<div style="overflow-x:auto;margin-top:0.5rem">' + previewHtml + '</div>' +
    '</details>' +
    '<div id="import-preview-area"></div>';

  var footer =
    '<button class="btn btn-secondary" id="import-preview-btn">Preview Changes</button>' +
    '<button class="btn btn-primary" id="import-apply-btn" style="display:none">Apply Changes</button>' +
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>';

  openModal("Import CSV", body, footer, { wide: true });

  var pendingRows = null;

  document.getElementById("import-preview-btn").addEventListener("click", async function () {
    var sIdx = parseInt(document.getElementById("import-col-serial").value, 10);
    var dIdx = parseInt(document.getElementById("import-col-date").value, 10);

    var rows = dataRows.map(function (r) {
      return { serialNumber: r[sIdx] || "", date: r[dIdx] || "" };
    }).filter(function (r) { return r.serialNumber && r.date; });

    if (!rows.length) { showToast("No valid rows after column mapping", "error"); return; }

    var btn = document.getElementById("import-preview-btn");
    btn.disabled = true;
    btn.textContent = "Loading…";

    try {
      var result = await api.assets.import(rows, true);
      pendingRows = rows;

      var updateRows = result.preview.filter(function (r) { return r.willUpdate; });
      var skipRows   = result.preview.filter(function (r) { return !r.willUpdate; });

      var html = "";
      if (result.notFound > 0) {
        html += '<p style="color:var(--color-text-secondary);font-size:0.85rem;margin-bottom:0.5rem">' +
          result.notFound + ' serial number(s) not found in assets.</p>';
      }
      if (!updateRows.length) {
        html += '<p style="color:var(--color-success)">No updates needed — all matched assets already have an earlier or equal first-seen date.</p>';
        document.getElementById("import-apply-btn").style.display = "none";
      } else {
        html += '<p style="margin-bottom:0.5rem"><strong>' + updateRows.length + '</strong> asset(s) will have their first-seen date updated' +
          (skipRows.length ? '; <strong>' + skipRows.length + '</strong> already have an earlier date and will be skipped' : '') + '.</p>' +
          '<div style="overflow-x:auto"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
          '<th>Serial</th><th>Hostname</th><th>Current First Seen</th><th>New First Seen</th>' +
          '</tr></thead><tbody>' +
          updateRows.map(function (r) {
            return '<tr><td class="mono">' + escapeHtml(r.serialNumber) + '</td>' +
              '<td>' + escapeHtml(r.hostname || "-") + '</td>' +
              '<td>' + formatDate(r.currentFirstSeen) + '</td>' +
              '<td style="color:var(--color-success)">' + formatDate(r.importDate) + '</td></tr>';
          }).join("") +
          '</tbody></table></div>';
        document.getElementById("import-apply-btn").style.display = "";
      }
      document.getElementById("import-preview-area").innerHTML = html;
    } catch (e) {
      showToast("Preview failed: " + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Preview Changes";
    }
  });

  document.getElementById("import-apply-btn").addEventListener("click", async function () {
    if (!pendingRows) return;
    var btn = this;
    btn.disabled = true;
    btn.textContent = "Applying…";
    try {
      var result = await api.assets.import(pendingRows, false);
      closeModal();
      showToast("Updated first-seen date for " + result.updated + " asset(s)");
      loadAssets();
    } catch (e) {
      showToast("Import failed: " + e.message, "error");
      btn.disabled = false;
      btn.textContent = "Apply Changes";
    }
  });
}

/* ─── PDF Invoice Import ──────────────────────────────────────────────────── */

var _pdfJsLoaded = false;

var _PDFJS_VERSION = "3.11.174";
var _PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + _PDFJS_VERSION;

async function _loadPdfJs() {
  if (_pdfJsLoaded) return;
  return new Promise(function (resolve, reject) {
    var umd = document.createElement("script");
    umd.src = _PDFJS_CDN + "/pdf.min.js";
    umd.onload = function () {
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = _PDFJS_CDN + "/pdf.worker.min.js";
        _pdfJsLoaded = true;
        resolve();
      } else {
        reject(new Error("PDF.js did not load correctly"));
      }
    };
    umd.onerror = function () { reject(new Error("Failed to load PDF.js from CDN")); };
    document.head.appendChild(umd);
  });
}

async function _extractPdfPages(file) {
  await _loadPdfJs();
  var arrayBuffer = await file.arrayBuffer();
  var pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  var pages = [];
  for (var i = 1; i <= pdf.numPages; i++) {
    var page = await pdf.getPage(i);
    var content = await page.getTextContent();
    var text = content.items.map(function (item) { return item.str; }).join(" ");
    pages.push(text.replace(/\s{3,}/g, "\n").trim());
  }
  return pages;
}

var PDF_ASSET_FIELDS = [
  { key: "hostname",      label: "Hostname" },
  { key: "serialNumber",  label: "Serial Number" },
  { key: "manufacturer",  label: "Manufacturer" },
  { key: "model",         label: "Model" },
  { key: "ipAddress",     label: "IP Address" },
  { key: "macAddress",    label: "MAC Address" },
  { key: "assetTag",      label: "Asset Tag" },
  { key: "assignedTo",    label: "Assigned To" },
  { key: "location",      label: "Location" },
  { key: "notes",         label: "Notes" },
];

async function openImportPdfModal(file) {
  var loadingBody = '<div style="padding:2rem;text-align:center;color:var(--color-text-secondary)">Extracting PDF text…</div>';
  openModal("Import PDF Invoice", loadingBody, "", { xl: true });

  var pages;
  try {
    pages = await _extractPdfPages(file);
  } catch (err) {
    document.querySelector("#modal-overlay .modal-body").innerHTML =
      '<div style="padding:2rem;color:var(--color-danger)">Failed to read PDF: ' + escapeHtml(err.message) + '</div>';
    return;
  }

  if (!pages.length || pages.every(function (p) { return !p.trim(); })) {
    document.querySelector("#modal-overlay .modal-body").innerHTML =
      '<div style="padding:2rem;color:var(--color-text-secondary)">No readable text found in this PDF. It may be a scanned image — try OCR first.</div>';
    return;
  }

  var currentPage = 0;
  var assetList = [];

  function _getSelectedText() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return "";
    var text = sel.toString().trim();
    // Only allow selection from within our text area
    var textArea = document.getElementById("pdf-text-area");
    if (!textArea) return "";
    var range = sel.getRangeAt(0);
    if (!textArea.contains(range.commonAncestorContainer)) return "";
    return text;
  }

  function _renderForm() {
    return PDF_ASSET_FIELDS.map(function (f) {
      var isTextarea = f.key === "notes";
      var inputEl = isTextarea
        ? '<textarea id="pdf-field-' + f.key + '" rows="2" style="font-size:0.82rem;padding:4px 8px;resize:vertical"></textarea>'
        : '<input type="text" id="pdf-field-' + f.key + '" autocomplete="off">';
      return '<div class="form-row">' +
        '<div><label>' + escapeHtml(f.label) + '</label>' + inputEl + '</div>' +
        '<button class="btn btn-secondary btn-use" data-field="' + f.key + '" title="Paste selected text from PDF">&#8599; Use</button>' +
      '</div>';
    }).join("") +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:0.5rem">' +
      '<div><label style="font-size:0.78rem;color:var(--color-text-secondary)">Type</label>' +
        '<select id="pdf-field-assetType" style="font-size:0.82rem;padding:4px 8px;height:30px">' +
          '<option value="other">Other</option>' +
          '<option value="server">Server</option>' +
          '<option value="switch">Switch</option>' +
          '<option value="router">Router</option>' +
          '<option value="firewall">Firewall</option>' +
          '<option value="workstation">Workstation</option>' +
          '<option value="printer">Printer</option>' +
          '<option value="access_point">Access Point</option>' +
        '</select></div>' +
      '<div><label style="font-size:0.78rem;color:var(--color-text-secondary)">Status</label>' +
        '<select id="pdf-field-status" style="font-size:0.82rem;padding:4px 8px;height:30px">' +
          '<option value="active">Active</option>' +
          '<option value="storage">Storage</option>' +
          '<option value="maintenance">Maintenance</option>' +
          '<option value="decommissioned">Decommissioned</option>' +
          '<option value="disabled">Disabled</option>' +
        '</select></div>' +
    '</div>';
  }

  function _currentFields() {
    var obj = {};
    PDF_ASSET_FIELDS.forEach(function (f) {
      var el = document.getElementById("pdf-field-" + f.key);
      if (el && el.value.trim()) obj[f.key] = el.value.trim();
    });
    var typeEl   = document.getElementById("pdf-field-assetType");
    var statusEl = document.getElementById("pdf-field-status");
    if (typeEl)   obj.assetType = typeEl.value;
    if (statusEl) obj.status    = statusEl.value;
    return obj;
  }

  function _clearForm() {
    PDF_ASSET_FIELDS.forEach(function (f) {
      var el = document.getElementById("pdf-field-" + f.key);
      if (el) el.value = "";
    });
    var typeEl   = document.getElementById("pdf-field-assetType");
    var statusEl = document.getElementById("pdf-field-status");
    if (typeEl)   typeEl.value   = "other";
    if (statusEl) statusEl.value = "active";
  }

  function _renderAssetListTable() {
    var listEl = document.getElementById("pdf-asset-list");
    if (!listEl) return;
    if (!assetList.length) {
      listEl.innerHTML = '<p style="padding:0.5rem 1rem;font-size:0.8rem;color:var(--color-text-secondary)">No assets added yet.</p>';
      return;
    }
    listEl.innerHTML =
      '<table class="pdf-asset-list-table"><thead><tr>' +
        '<th>Serial</th><th>Hostname</th><th>Manufacturer</th><th>Model</th><th>Type</th><th></th>' +
      '</tr></thead><tbody>' +
      assetList.map(function (a, i) {
        return '<tr>' +
          '<td class="mono">' + escapeHtml(a.serialNumber || "-") + '</td>' +
          '<td>' + escapeHtml(a.hostname || "-") + '</td>' +
          '<td>' + escapeHtml(a.manufacturer || "-") + '</td>' +
          '<td>' + escapeHtml(a.model || "-") + '</td>' +
          '<td>' + escapeHtml(a.assetType || "-") + '</td>' +
          '<td><button class="btn btn-sm btn-danger" data-remove-idx="' + i + '" style="padding:1px 6px;font-size:0.72rem">✕</button></td>' +
        '</tr>';
      }).join("") +
      '</tbody></table>';
    listEl.querySelectorAll("[data-remove-idx]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var idx = parseInt(this.getAttribute("data-remove-idx"), 10);
        assetList.splice(idx, 1);
        _renderAssetListTable();
        _updateApplyBtn();
      });
    });
  }

  function _updateApplyBtn() {
    var applyBtn = document.getElementById("pdf-apply-btn");
    if (applyBtn) {
      applyBtn.disabled = assetList.length === 0;
      applyBtn.textContent = assetList.length
        ? "Preview & Apply (" + assetList.length + ")"
        : "Preview & Apply";
    }
  }

  function _renderPageText() {
    var textArea = document.getElementById("pdf-text-area");
    var pageInfo = document.getElementById("pdf-page-info");
    if (textArea) textArea.textContent = pages[currentPage] || "(empty page)";
    if (pageInfo) pageInfo.textContent = "Page " + (currentPage + 1) + " of " + pages.length;
    var prevBtn = document.getElementById("pdf-prev-page");
    var nextBtn = document.getElementById("pdf-next-page");
    if (prevBtn) prevBtn.disabled = currentPage === 0;
    if (nextBtn) nextBtn.disabled = currentPage === pages.length - 1;
  }

  var body =
    '<div class="pdf-import-pane">' +
      '<div class="pdf-import-left">' +
        '<div class="pdf-import-toolbar">' +
          '<strong style="color:var(--color-text-primary);font-size:0.82rem">' + escapeHtml(file.name) + '</strong>' +
          '<span id="pdf-page-info" style="margin-left:auto"></span>' +
          (pages.length > 1
            ? '<button class="btn btn-sm btn-secondary" id="pdf-prev-page">&#8592;</button>' +
              '<button class="btn btn-sm btn-secondary" id="pdf-next-page">&#8594;</button>'
            : '') +
        '</div>' +
        '<div class="pdf-import-text-area" id="pdf-text-area" title="Select text then click ↗ Use next to a field"></div>' +
      '</div>' +
      '<div class="pdf-import-right">' +
        '<div class="pdf-import-toolbar" style="justify-content:space-between">' +
          '<span style="font-size:0.8rem;color:var(--color-text-secondary)">Fill fields &rarr; Add Asset &rarr; repeat</span>' +
          '<button class="btn btn-sm btn-secondary" id="pdf-clear-btn">Clear</button>' +
        '</div>' +
        '<div class="pdf-import-form" id="pdf-form-area">' + _renderForm() + '</div>' +
        '<div style="padding:0.5rem 1rem;border-top:1px solid var(--color-border);flex-shrink:0">' +
          '<button class="btn btn-secondary" id="pdf-add-btn" style="width:100%">+ Add Asset to List</button>' +
        '</div>' +
        '<div class="pdf-asset-list" id="pdf-asset-list">' +
          '<p style="padding:0.5rem 1rem;font-size:0.8rem;color:var(--color-text-secondary)">No assets added yet.</p>' +
        '</div>' +
      '</div>' +
    '</div>';

  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="pdf-apply-btn" disabled>Preview & Apply</button>';

  openModal("Import PDF Invoice", body, footer, { xl: true });

  _renderPageText();

  document.getElementById("pdf-prev-page") && document.getElementById("pdf-prev-page").addEventListener("click", function () {
    if (currentPage > 0) { currentPage--; _renderPageText(); }
  });
  document.getElementById("pdf-next-page") && document.getElementById("pdf-next-page").addEventListener("click", function () {
    if (currentPage < pages.length - 1) { currentPage++; _renderPageText(); }
  });

  document.getElementById("pdf-clear-btn").addEventListener("click", _clearForm);

  document.getElementById("pdf-form-area").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-field]");
    if (!btn) return;
    var field = btn.getAttribute("data-field");
    var sel = _getSelectedText();
    if (!sel) { showToast("Select some text in the PDF viewer first", "error"); return; }
    var input = document.getElementById("pdf-field-" + field);
    if (input) { input.value = sel; input.focus(); }
  });

  document.getElementById("pdf-add-btn").addEventListener("click", function () {
    var fields = _currentFields();
    if (!fields.hostname && !fields.serialNumber && !fields.ipAddress && !fields.macAddress) {
      showToast("Enter at least one identifying field (hostname, serial, IP, or MAC)", "error");
      return;
    }
    assetList.push(fields);
    _renderAssetListTable();
    _updateApplyBtn();
    _clearForm();
    showToast("Asset added to list", "success");
  });

  document.getElementById("pdf-apply-btn").addEventListener("click", async function () {
    if (!assetList.length) return;
    var btn = this;
    btn.disabled = true;
    btn.textContent = "Previewing…";

    try {
      var result = await api.assets.importPdf(assetList, true);
      var creates = result.preview.filter(function (r) { return r.action === "create"; });
      var updates = result.preview.filter(function (r) { return r.action === "update"; });

      var previewHtml =
        '<p style="margin-bottom:0.75rem">' +
          (creates.length ? '<strong>' + creates.length + '</strong> will be <span style="color:var(--color-success)">created</span>' : '') +
          (creates.length && updates.length ? ' · ' : '') +
          (updates.length ? '<strong>' + updates.length + '</strong> will be <span style="color:var(--color-accent)">updated</span> (matched by serial number)' : '') +
        '</p>' +
        '<div style="overflow-x:auto"><table class="data-table" style="font-size:0.8rem"><thead><tr>' +
          '<th>Action</th><th>Serial</th><th>Hostname</th><th>Manufacturer</th><th>Model</th><th>Type</th>' +
        '</tr></thead><tbody>' +
        result.preview.map(function (r) {
          var actionBadge = r.action === "create"
            ? '<span style="color:var(--color-success)">Create</span>'
            : '<span style="color:var(--color-accent)">Update</span>';
          return '<tr>' +
            '<td>' + actionBadge + '</td>' +
            '<td class="mono">' + escapeHtml(r.serialNumber || "-") + '</td>' +
            '<td>' + escapeHtml(r.hostname || "-") + '</td>' +
            '<td>' + escapeHtml(r.fields.manufacturer || "-") + '</td>' +
            '<td>' + escapeHtml(r.fields.model || "-") + '</td>' +
            '<td>' + escapeHtml(r.fields.assetType || "-") + '</td>' +
          '</tr>';
        }).join("") +
        '</tbody></table></div>';

      var prevBody =
        '<div style="padding:1.25rem">' +
          '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1rem">Review the changes below, then confirm to apply.</p>' +
          previewHtml +
        '</div>';

      var prevFooter =
        '<button class="btn btn-secondary" id="pdf-preview-back">Back</button>' +
        '<button class="btn btn-primary" id="pdf-preview-confirm">Apply Changes</button>';

      openModal("PDF Import — Preview", prevBody, prevFooter, { wide: true });

      document.getElementById("pdf-preview-back").addEventListener("click", function () {
        openImportPdfModal._reopen && openImportPdfModal._reopen();
      });

      document.getElementById("pdf-preview-confirm").addEventListener("click", async function () {
        var confirmBtn = this;
        confirmBtn.disabled = true;
        confirmBtn.textContent = "Applying…";
        try {
          var applyResult = await api.assets.importPdf(assetList, false);
          closeModal();
          showToast("Created " + applyResult.created + ", updated " + applyResult.updated + " asset(s)", "success");
          loadAssets();
        } catch (e) {
          showToast("Apply failed: " + e.message, "error");
          confirmBtn.disabled = false;
          confirmBtn.textContent = "Apply Changes";
        }
      });

    } catch (e) {
      showToast("Preview failed: " + e.message, "error");
      btn.disabled = false;
      btn.textContent = "Preview & Apply (" + assetList.length + ")";
    }
  });
}

// ─── SNMP Walk tab (admin only) ────────────────────────────────────────────
//
// Operator-driven snmpwalk against the asset's IP. Admin-only on both the
// frontend (the tab is omitted) and the backend (POST /assets/:id/snmp-walk
// is gated on requireAdmin). Pick any stored SNMP credential — not just the
// asset's monitor credential — so an admin can spot-check a host that isn't
// yet monitored, or use a different community than the one the monitor uses.

var _snmpWalkLastOid = "1.3.6.1.2.1.1";
var _snmpWalkLastCredId = null;
var _snmpWalkLastMibId = "";        // "" = no MIB, "std:..." = standard, UUID = uploaded
var _snmpWalkLastObjectName = "";   // persists object name across tab open/close
var _snmpMibCache = null;           // null = not yet loaded; [] = loaded (may be empty)
var _snmpMibStructureCache = {};    // keyed by mibId; structure payload from GET /mibs/:id/structure

// "Standard MIBs" in the SNMP Walk dropdown are strictly RFC/IEEE specs
// Polaris seeds top-level OIDs for. Vendor MIBs (FORTINET-FORTIGATE-MIB,
// CISCO-PROCESS-MIB, etc.) belong in the Uploaded MIBs section — operators
// upload them via Server Settings → Identification → MIB Database, which
// also unlocks the MIB-aware walk (symbol resolution + value decoding).
var _SNMP_STANDARD_MIBS = [
  { id: "std:system",         label: "System (RFC 1213)",              oid: "1.3.6.1.2.1.1"          },
  { id: "std:interfaces",     label: "Interfaces — ifTable (RFC 2863)", oid: "1.3.6.1.2.1.2"          },
  { id: "std:if-ext",         label: "Interfaces — ifXTable, 64-bit counters (RFC 2863)", oid: "1.3.6.1.2.1.31"         },
  { id: "std:host-resources", label: "HOST-RESOURCES-MIB (RFC 2790)",  oid: "1.3.6.1.2.1.25"         },
  { id: "std:entity",         label: "ENTITY-MIB (RFC 4133)",          oid: "1.3.6.1.2.1.47"         },
  { id: "std:entity-sensor",  label: "ENTITY-SENSOR-MIB (RFC 3433)",   oid: "1.3.6.1.2.1.99"         },
  { id: "std:lldp",           label: "LLDP-MIB (IEEE 802.1AB)",        oid: "1.0.8802.1.1.2"         },
];

function _snmpCredentialOptions(selectedId) {
  var snmpCreds = (_credentialCache.list || []).filter(function (c) { return c.type === "snmp"; });
  if (!snmpCreds.length) return '<option value="">(no SNMP credentials defined)</option>';
  var defaultId = selectedId || _snmpWalkLastCredId || snmpCreds[0].id;
  var opts = "";
  snmpCreds.forEach(function (c) {
    opts += '<option value="' + escapeHtml(c.id) + '"' + (defaultId === c.id ? " selected" : "") + '>' + escapeHtml(c.name) + '</option>';
  });
  return opts;
}

function assetSnmpWalkViewHTML(a) {
  if (!a.ipAddress) {
    return '<div style="padding:1rem 0;color:var(--color-text-secondary)">' +
      'SNMP walks need an IP address — assign one to this asset before running a walk.' +
    '</div>';
  }
  // Pre-select the asset's stored monitor credential when it's an SNMP one
  // — the SNMP walk speaks the same protocol so it's the natural default.
  // Other credential types stay deselected; the operator picks one from
  // the dropdown.
  var monCred = a.monitorCredential;
  var seedCredId = (monCred && monCred.type === "snmp") ? monCred.id : null;
  // std and uploaded MIBs both use the object-name input + browse tree.
  // No MIB selected → numeric base-OID input + raw walk.
  var mibAware = !!_snmpWalkLastMibId;
  var oidVal = mibAware ? (_snmpWalkLastObjectName || "") : (_snmpWalkLastOid || "");
  var oidLabelText = mibAware ? "Object name" : "Base OID";
  var oidPlaceholder = mibAware ? "e.g. sysDescr, ifTable, lldpRemTable" : "1.3.6.1.2.1.1";
  return (
    '<div data-shot-section="snmpWalk" data-shot-label="SNMP Walk" style="display:flex;flex-direction:column;gap:0.75rem">' +
      '<div style="font-size:0.85rem;color:var(--color-text-secondary)">' +
        'Walks <code>' + escapeHtml(a.ipAddress) + '</code> using the selected SNMP credential. Admin-only — every walk is audited. Walks are capped at 5,000 rows.' +
      '</div>' +
      '<div>' +
        '<label class="form-label" for="snmp-walk-mib" style="font-size:0.8rem">MIB <span style="color:var(--color-text-secondary);font-weight:normal">(optional — select to decode values)</span></label>' +
        '<select class="form-control" id="snmp-walk-mib"><option value="">— No MIB (raw numeric walk) —</option></select>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:0.5rem;align-items:end">' +
        '<div>' +
          '<label class="form-label" for="snmp-walk-oid" style="font-size:0.8rem" id="snmp-walk-oid-label">' + oidLabelText + '</label>' +
          '<input class="form-control" id="snmp-walk-oid" type="text" value="' + escapeHtml(oidVal || "") + '" placeholder="' + escapeHtml(oidPlaceholder) + '">' +
        '</div>' +
        '<div>' +
          '<label class="form-label" for="snmp-walk-cred" style="font-size:0.8rem">Credential</label>' +
          '<select class="form-control" id="snmp-walk-cred">' + _snmpCredentialOptions(seedCredId) + '</select>' +
        '</div>' +
        '<div>' +
          '<label class="form-label" for="snmp-walk-max" style="font-size:0.8rem">Max rows</label>' +
          '<input class="form-control" id="snmp-walk-max" type="number" min="1" max="5000" value="500" style="width:100px">' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:0.5rem;align-items:center">' +
        '<button type="button" class="btn btn-primary btn-sm" id="btn-snmp-walk">Walk</button>' +
        '<button type="button" class="btn btn-danger btn-sm" id="btn-snmp-walk-abort" style="display:none">Abort</button>' +
        '<span id="snmp-walk-countdown" style="display:none;font-size:0.8rem;color:var(--color-text-secondary);font-variant-numeric:tabular-nums" title="Time remaining before the walk is aborted"></span>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="btn-snmp-walk-copy" disabled>Copy results</button>' +
        '<span id="snmp-walk-status" style="font-size:0.8rem;color:var(--color-text-secondary)"></span>' +
      '</div>' +
      '<div id="snmp-walk-mib-tree" style="display:none"></div>' +
      '<div id="snmp-walk-results"></div>' +
    '</div>'
  );
}

// Renders the symbol tree for an uploaded MIB into #snmp-walk-mib-tree.
// Click-to-select-only: tapping a symbol fills the object-name input and
// highlights the row, but does not auto-walk (walks can be slow).
function _renderSnmpMibTree(structure, onPick, selectedName) {
  var mount = document.getElementById("snmp-walk-mib-tree");
  if (!mount) return;
  if (!structure) {
    mount.style.display = "none";
    mount.innerHTML = "";
    return;
  }

  var tableColumns = new Set();
  var tableRows = new Set();
  var tableNames = new Set();
  (structure.tables || []).forEach(function (t) {
    tableNames.add(t.name);
    tableRows.add(t.rowSymbol);
    (t.columns || []).forEach(function (c) { tableColumns.add(c); });
  });

  function rowHtml(name, suffixHtml) {
    var isSel = name === selectedName;
    var selStyle = isSel
      ? "background:var(--color-primary-bg,rgba(99,179,237,0.18));color:var(--color-primary,#4fc3f7)"
      : "";
    return '<div class="snmp-mib-tree-row" data-name="' + escapeHtml(name) + '" ' +
      'style="padding:0.3rem 0.5rem;cursor:pointer;border-radius:4px;font-family:var(--font-mono,monospace);font-size:0.78rem;' + selStyle + '">' +
      escapeHtml(name) + (suffixHtml || "") +
    "</div>";
  }

  var tableRowsHtml = (structure.tables || []).map(function (t) {
    var colCount = t.columns ? t.columns.length : 0;
    var suffix = ' <span style="color:var(--color-text-tertiary);font-size:0.72rem;font-family:inherit">(' + colCount + ' col' + (colCount === 1 ? "" : "s") + ")</span>";
    return rowHtml(t.name, suffix);
  }).join("");

  var scalarRowsHtml = (structure.symbols || [])
    .filter(function (s) { return !tableColumns.has(s.name) && !tableRows.has(s.name) && !tableNames.has(s.name); })
    .map(function (s) {
      var typeBadge = s.baseType && s.baseType !== "OTHER" && s.baseType !== "OBJECT IDENTIFIER"
        ? ' <span style="color:var(--color-text-tertiary);font-size:0.72rem;font-family:inherit">' + escapeHtml(s.baseType) + "</span>"
        : "";
      var unresolved = s.fullOid === null
        ? ' <span style="color:var(--color-warning,#d97706);font-size:0.72rem;font-family:inherit">(unresolved)</span>'
        : "";
      return rowHtml(s.name, typeBadge + unresolved);
    }).join("");

  function section(title, inner) {
    if (!inner) return "";
    return '<div style="margin-bottom:0.5rem">' +
      '<div style="font-size:0.78rem;font-weight:600;color:var(--color-text-secondary);padding:0.25rem 0.5rem">' +
        escapeHtml(title) +
      "</div>" +
      inner +
    "</div>";
  }

  mount.style.display = "";
  mount.innerHTML =
    '<div style="border:1px solid var(--color-border);border-radius:6px;background:var(--color-surface-alt,rgba(127,127,127,0.04))">' +
      '<div style="padding:0.4rem 0.6rem;font-size:0.78rem;color:var(--color-text-secondary);border-bottom:1px solid var(--color-border)">' +
        "Browse " + escapeHtml(structure.moduleName || "MIB") + " — click a symbol to load it into the Object name field." +
      "</div>" +
      '<div style="max-height:32vh;overflow:auto;overscroll-behavior:contain;padding:0.5rem">' +
        section("Tables", tableRowsHtml) +
        section("Scalars / Other", scalarRowsHtml) +
      "</div>" +
    "</div>";

  mount.querySelectorAll(".snmp-mib-tree-row").forEach(function (el) {
    el.addEventListener("click", function () { onPick(el.getAttribute("data-name")); });
  });
}

function _renderSnmpWalkRows(result) {
  var container = document.getElementById("snmp-walk-results");
  if (!container) return;
  if (!result.rows.length) {
    container.innerHTML = '<p class="empty-state" style="padding:0.75rem 0">No varbinds returned.</p>';
    return;
  }
  var truncated = result.truncated
    ? '<div style="font-size:0.8rem;color:var(--color-warning,#d4a23a);margin-bottom:0.4rem">Truncated at ' + result.rows.length + ' rows — narrow the OID or raise Max rows to see more.</div>'
    : "";
  var rowsHtml = result.rows.map(function (r) {
    return '<tr>' +
      '<td style="font-family:var(--font-mono,monospace);font-size:0.78rem;white-space:nowrap">' + escapeHtml(r.oid) + '</td>' +
      '<td style="font-size:0.78rem;color:var(--color-text-secondary);white-space:nowrap">' + escapeHtml(r.type) + '</td>' +
      '<td style="font-family:var(--font-mono,monospace);font-size:0.78rem;word-break:break-all">' + escapeHtml(r.value) + '</td>' +
    '</tr>';
  }).join("");
  container.innerHTML = truncated +
    '<div class="table-wrapper" style="max-height:60vh;overflow:auto">' +
      '<table class="data-table" style="font-size:0.82rem;min-width:max-content">' +
        '<thead><tr><th style="white-space:nowrap">OID</th><th style="white-space:nowrap">Type</th><th style="white-space:nowrap">Value</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>' +
    '</div>';
}

function _renderMibWalkResult(result) {
  var container = document.getElementById("snmp-walk-results");
  if (!container) return;

  var header = "";
  if (result.rowCount > 0 && result.decodedCount < result.rowCount / 2) {
    header += '<div style="font-size:0.8rem;background:var(--color-warning-bg,rgba(212,162,58,0.12));color:var(--color-warning,#d4a23a);border-radius:4px;padding:0.4rem 0.6rem;margin-bottom:0.5rem">' +
      'Decoded ' + result.decodedCount + ' / ' + result.rowCount + ' values — this MIB may not match the asset’s manufacturer.' +
    '</div>';
  }
  if (result.truncated) {
    header += '<div style="font-size:0.8rem;color:var(--color-warning,#d4a23a);margin-bottom:0.4rem">Truncated at ' + result.rowCount + ' rows — raise Max rows or narrow the object to see more.</div>';
  }

  if (result.kind === "table" && result.table) {
    var t = result.table;
    if (!t.rows.length) {
      container.innerHTML = header + '<p class="empty-state" style="padding:0.75rem 0">No table rows returned.</p>';
      return;
    }
    var cols = t.columns;
    var thHtml = '<th style="white-space:nowrap">Index</th>' + cols.map(function (c) { return '<th style="white-space:nowrap">' + escapeHtml(c) + "</th>"; }).join("");
    var rowsHtml = t.rows.map(function (row) {
      var cells = '<td style="font-family:var(--font-mono,monospace);font-size:0.78rem;white-space:nowrap">' + escapeHtml(row.index) + "</td>";
      cells += cols.map(function (col) {
        var cell = row.cells[col];
        if (!cell) return '<td style="color:var(--color-text-secondary)">—</td>';
        var display = escapeHtml(cell.decoded);
        if (cell.raw !== cell.decoded) {
          display = '<span title="raw: ' + escapeHtml(cell.raw) + '" style="cursor:help;border-bottom:1px dotted var(--color-border)">' + display + "</span>";
        }
        return '<td style="font-size:0.78rem">' + display + "</td>";
      }).join("");
      return "<tr>" + cells + "</tr>";
    }).join("");
    container.innerHTML = header +
      '<div class="table-wrapper" style="max-height:60vh;overflow:auto">' +
        '<table class="data-table" style="font-size:0.82rem;min-width:max-content">' +
          "<thead><tr>" + thHtml + "</tr></thead>" +
          "<tbody>" + rowsHtml + "</tbody>" +
        "</table>" +
      "</div>";
    return;
  }

  // scalars
  var entries = result.entries || [];
  if (!entries.length) {
    container.innerHTML = header + '<p class="empty-state" style="padding:0.75rem 0">No varbinds returned.</p>';
    return;
  }
  var rowsHtml = entries.map(function (e) {
    var symHtml = e.symbol
      ? escapeHtml(e.symbol) + (e.suffix ? '<span style="color:var(--color-text-secondary)">.' + escapeHtml(e.suffix) + "</span>" : "")
      : '<span style="color:var(--color-text-secondary)">—</span>';
    var decoded = escapeHtml(e.decoded || e.raw);
    var rawHint = (e.decoded && e.decoded !== e.raw)
      ? ' <span style="font-size:0.75rem;color:var(--color-text-secondary)">(' + escapeHtml(e.raw) + ")</span>"
      : "";
    return "<tr>" +
      '<td style="font-family:var(--font-mono,monospace);font-size:0.78rem;white-space:nowrap">' + escapeHtml(e.oid) + "</td>" +
      '<td style="font-size:0.78rem">' + symHtml + "</td>" +
      '<td style="font-family:var(--font-mono,monospace);font-size:0.78rem;word-break:break-all">' + decoded + rawHint + "</td>" +
    "</tr>";
  }).join("");
  container.innerHTML = header +
    '<div class="table-wrapper" style="max-height:60vh;overflow:auto">' +
      '<table class="data-table" style="font-size:0.82rem;min-width:max-content">' +
        '<thead><tr><th style="white-space:nowrap">OID</th><th style="white-space:nowrap">Symbol</th><th style="white-space:nowrap">Value</th></tr></thead>' +
        "<tbody>" + rowsHtml + "</tbody>" +
      "</table>" +
    "</div>";
}

function _wireSnmpWalkTab(a) {
  var walkBtn = document.getElementById("btn-snmp-walk");
  if (!walkBtn) return; // tab not rendered (e.g. asset has no IP)
  var abortBtn    = document.getElementById("btn-snmp-walk-abort");
  var copyBtn     = document.getElementById("btn-snmp-walk-copy");
  var statusEl    = document.getElementById("snmp-walk-status");
  var mibSel      = document.getElementById("snmp-walk-mib");
  var oidLabel    = document.getElementById("snmp-walk-oid-label");
  var oidInput    = document.getElementById("snmp-walk-oid");
  var countdownEl = document.getElementById("snmp-walk-countdown");
  var lastResult    = null; // raw walk result
  var lastMibResult = null; // MIB-aware walk result
  var activeController = null;

  // Client-enforced walk deadline. There is no end-to-end timeout anywhere
  // else on this path (nginx allows 3600s; net-snmp's 10s timeout is per
  // getBulk request, not per walk), so a slow device could otherwise leave
  // the tab spinning indefinitely. The countdown renders next to the Walk
  // button and aborts the request when it reaches zero. The server-side walk
  // keeps running to completion either way — abort only abandons the response.
  var WALK_TIMEOUT_SEC = 60;
  var countdownTimer = null;
  var walkTimedOut = false;

  function _stopCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (countdownEl) { countdownEl.style.display = "none"; countdownEl.textContent = ""; }
  }

  function _startCountdown(controller) {
    walkTimedOut = false;
    var remaining = WALK_TIMEOUT_SEC;
    if (countdownEl) {
      countdownEl.style.display = "";
      countdownEl.textContent = remaining + "s";
    }
    countdownTimer = setInterval(function () {
      remaining -= 1;
      if (remaining <= 0) {
        _stopCountdown();
        walkTimedOut = true;
        controller.abort();
      } else if (countdownEl) {
        countdownEl.textContent = remaining + "s";
      }
    }, 1000);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function _isUploadedMib(mibId) { return mibId && !mibId.startsWith("std:"); }
  // "MIB-aware" — std AND uploaded MIBs both render the browse tree and
  // walk through the symbol-resolving endpoint. Raw OID mode (no MIB) is
  // the only branch that stays on numeric input + raw walk.
  function _isMibAware(mibId) { return !!mibId; }

  function _loadAndRenderMibTree(mibId) {
    if (!_isMibAware(mibId)) {
      _renderSnmpMibTree(null);
      return;
    }
    var pick = function (name) {
      oidInput.value = name;
      _snmpWalkLastObjectName = name;
      // preventScroll: focusing the input would otherwise scroll-into-view it,
      // jumping the modal's scroll container back to the top and yanking the
      // tree out from under the operator who just clicked a symbol.
      oidInput.focus({ preventScroll: true });
      _renderSnmpMibTree(_snmpMibStructureCache[mibId], pick, name);
    };
    var cached = _snmpMibStructureCache[mibId];
    if (cached) {
      _renderSnmpMibTree(cached, pick, _snmpWalkLastObjectName || null);
      return;
    }
    var mount = document.getElementById("snmp-walk-mib-tree");
    if (mount) {
      mount.style.display = "";
      mount.innerHTML = '<div style="padding:0.5rem;font-size:0.8rem;color:var(--color-text-secondary)">Loading MIB structure…</div>';
    }
    var fetcher = mibId.indexOf("std:") === 0
      ? api.serverSettings.getStdMibStructure(mibId)
      : api.serverSettings.getMibStructure(mibId);
    fetcher.then(function (st) {
      _snmpMibStructureCache[mibId] = st;
      if (mibSel.value === mibId) {
        _renderSnmpMibTree(st, pick, _snmpWalkLastObjectName || null);
      }
    }).catch(function (err) {
      if (mibSel.value !== mibId) return;
      var mt = document.getElementById("snmp-walk-mib-tree");
      if (mt) {
        mt.style.display = "";
        mt.innerHTML = '<div style="padding:0.5rem;font-size:0.8rem;color:var(--color-danger,#c0392b)">' +
          escapeHtml(err.message || "Failed to load MIB structure") +
        "</div>";
      }
    });
  }

  function _updateOidMode(mibId) {
    if (_isMibAware(mibId)) {
      // std and uploaded MIBs both use object-name mode; the browse tree
      // fills the input on click.
      oidLabel.textContent = "Object name";
      oidInput.placeholder = "e.g. sysDescr, ifTable, lldpRemTable";
      oidInput.value = _snmpWalkLastObjectName || "";
    } else {
      oidLabel.textContent = "Base OID";
      oidInput.placeholder = "1.3.6.1.2.1.1";
      oidInput.value = _snmpWalkLastOid;
    }
  }

  function _populateMibDropdown(uploadedMibs) {
    var html = '<option value="">— No MIB (raw numeric walk) —</option>';
    html += '<optgroup label="Standard MIBs">';
    _SNMP_STANDARD_MIBS.forEach(function (m) {
      html += '<option value="' + escapeHtml(m.id) + '"' + (_snmpWalkLastMibId === m.id ? " selected" : "") + '>' + escapeHtml(m.label) + "</option>";
    });
    html += "</optgroup>";
    if (uploadedMibs && uploadedMibs.length) {
      html += '<optgroup label="Uploaded MIBs">';
      uploadedMibs.forEach(function (m) {
        var label = m.manufacturer
          ? m.manufacturer + (m.model ? " / " + m.model : "") + " — " + m.moduleName
          : m.moduleName;
        html += '<option value="' + escapeHtml(m.id) + '"' + (_snmpWalkLastMibId === m.id ? " selected" : "") + '>' + escapeHtml(label) + "</option>";
      });
      html += "</optgroup>";
    }
    mibSel.innerHTML = html;
    _updateOidMode(mibSel.value);
    _loadAndRenderMibTree(mibSel.value);
  }

  // ── Load uploaded MIBs into dropdown ─────────────────────────────────────

  if (_snmpMibCache !== null) {
    _populateMibDropdown(_snmpMibCache);
  } else {
    _populateMibDropdown([]); // show standard MIBs immediately
    api.serverSettings.listMibs({}).then(function (mibs) {
      _snmpMibCache = Array.isArray(mibs) ? mibs : [];
      _populateMibDropdown(_snmpMibCache);
    }).catch(function () {
      _snmpMibCache = [];
    });
  }

  // ── MIB select change ─────────────────────────────────────────────────────

  mibSel.addEventListener("change", function () {
    _snmpWalkLastMibId = mibSel.value;
    _updateOidMode(mibSel.value);
    _loadAndRenderMibTree(mibSel.value);
    document.getElementById("snmp-walk-results").innerHTML = "";
    statusEl.textContent = "";
    if (copyBtn) copyBtn.disabled = true;
    lastResult = null;
    lastMibResult = null;
  });

  // ── Walk button ───────────────────────────────────────────────────────────

  walkBtn.addEventListener("click", async function () {
    var mibId   = mibSel.value;
    var oidOrObj = (oidInput.value || "").trim();
    var credId  = document.getElementById("snmp-walk-cred").value;
    var maxRows = parseInt(document.getElementById("snmp-walk-max").value, 10) || 500;
    var mibAware = _isMibAware(mibId);
    var isStd    = mibAware && mibId.indexOf("std:") === 0;

    if (!oidOrObj) { showToast(mibAware ? "Enter an object name" : "Enter a base OID", "error"); return; }
    if (!credId)   { showToast("Select an SNMP credential", "error"); return; }
    if (!mibAware && !/^\d+(\.\d+)*$/.test(oidOrObj)) {
      showToast("OID must be numeric (e.g. 1.3.6.1.2.1.1)", "error");
      return;
    }

    // Persist state
    _snmpWalkLastMibId   = mibId;
    _snmpWalkLastCredId  = credId;
    if (mibAware) { _snmpWalkLastObjectName = oidOrObj; } else { _snmpWalkLastOid = oidOrObj; }

    walkBtn.disabled = true;
    walkBtn.textContent = "Walking…";
    if (copyBtn) copyBtn.disabled = true;
    if (abortBtn) { abortBtn.style.display = ""; abortBtn.disabled = false; }
    statusEl.textContent = "Walking " + a.ipAddress + "…";
    document.getElementById("snmp-walk-results").innerHTML = "";
    lastResult = null;
    lastMibResult = null;

    activeController = new AbortController();
    var thisController = activeController;
    _startCountdown(thisController);

    try {
      if (mibAware) {
        var walkBody = { assetId: a.id, credentialId: credId, objectName: oidOrObj, maxRows: maxRows };
        var mibResult = isStd
          ? await api.serverSettings.walkStdMib(mibId, walkBody, thisController.signal)
          : await api.serverSettings.walkMib(mibId, walkBody, thisController.signal);
        lastMibResult = mibResult;
        statusEl.textContent = mibResult.rowCount + " row(s) in " + mibResult.durationMs + " ms" +
          (mibResult.truncated ? " (truncated)" : "") +
          " — decoded " + mibResult.decodedCount + "/" + mibResult.rowCount;
        _renderMibWalkResult(mibResult);
        if (copyBtn) copyBtn.disabled = !mibResult.rowCount;
      } else {
        var result = await api.assets.snmpWalk(a.id, { credentialId: credId, oid: oidOrObj, maxRows: maxRows }, thisController.signal);
        lastResult = result;
        statusEl.textContent = result.rows.length + " row(s) in " + result.durationMs + " ms" + (result.truncated ? " (truncated)" : "");
        _renderSnmpWalkRows(result);
        if (copyBtn) copyBtn.disabled = !result.rows.length;
      }
    } catch (err) {
      lastResult = null;
      lastMibResult = null;
      var aborted = err && (err.name === "AbortError" || thisController.signal.aborted);
      if (aborted) {
        var abortMsg = walkTimedOut
          ? "Walk timed out after " + WALK_TIMEOUT_SEC + "s."
          : "Walk aborted.";
        statusEl.textContent = abortMsg;
        document.getElementById("snmp-walk-results").innerHTML =
          '<p class="empty-state" style="padding:0.75rem 0">' + abortMsg + "</p>";
      } else {
        statusEl.textContent = "";
        var errMsg = err.message || "SNMP walk failed";
        // The per-host SNMP gate serializes walks against monitoring polls on
        // the same device; a gate timeout means the walk never started.
        if (/SNMP gate timeout/i.test(errMsg)) {
          errMsg = "Device was busy with another SNMP poll for the entire wait window — the walk never started. Try again in a moment.";
        }
        showToast(errMsg, "error");
        document.getElementById("snmp-walk-results").innerHTML =
          '<p class="empty-state" style="padding:0.75rem 0;color:var(--color-danger,#c0392b)">' +
            escapeHtml(errMsg) +
          "</p>";
      }
    } finally {
      _stopCountdown();
      if (activeController === thisController) activeController = null;
      walkBtn.disabled = false;
      walkBtn.textContent = "Walk";
      if (abortBtn) { abortBtn.style.display = "none"; abortBtn.disabled = false; }
    }
  });

  // ── Abort ─────────────────────────────────────────────────────────────────

  if (abortBtn) {
    abortBtn.addEventListener("click", function () {
      if (!activeController) return;
      abortBtn.disabled = true;
      statusEl.textContent = "Aborting…";
      activeController.abort();
    });
  }

  // ── Copy results ──────────────────────────────────────────────────────────

  if (copyBtn) {
    copyBtn.addEventListener("click", async function () {
      var text = "";
      if (lastMibResult) {
        if (lastMibResult.kind === "table" && lastMibResult.table) {
          var t = lastMibResult.table;
          var cols = t.columns;
          text = ["Index"].concat(cols).join("\t") + "\n" +
            t.rows.map(function (row) {
              return [row.index].concat(cols.map(function (c) {
                var cell = row.cells[c];
                return cell ? cell.decoded : "";
              })).join("\t");
            }).join("\n");
        } else if (lastMibResult.entries) {
          text = lastMibResult.entries.map(function (e) {
            var sym = e.symbol ? e.symbol + (e.suffix ? "." + e.suffix : "") : e.oid;
            return sym + " = " + (e.decoded || e.raw) + (e.decoded !== e.raw ? " (" + e.raw + ")" : "");
          }).join("\n");
        }
      } else if (lastResult) {
        text = lastResult.rows.map(function (r) { return r.oid + " = " + r.type + ": " + r.value; }).join("\n");
      }
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        var count = lastMibResult ? lastMibResult.rowCount : lastResult.rows.length;
        showToast("Copied " + count + " row(s)", "success");
      } catch (_) {
        showToast("Copy failed", "error");
      }
    });
  }
}

// ─── Sources tab (multi-source asset model — Phase 3a) ─────────────────────
//
// Renders the AssetSource rows for an asset, one card per source, in stable
// presentation order (entra → intune → ad → fortigate-firewall → fortiswitch →
// fortiap → manual). Each card shows the source's friendly label, the
// originating integration (when known), an inferred-row warning badge, and
// the raw observed blob as a key-value table — that's the "what did this
// source independently say" view that the Phase 1+2 foundation set up.

var _assetSourceLabels = {
  "entra":              "Microsoft Entra ID",
  "intune":             "Microsoft Intune",
  "ad":                 "Active Directory",
  "fortigate-firewall": "FortiGate (firewall)",
  "fortiswitch":        "FortiSwitch",
  "fortiap":            "FortiAP",
  "fortigate-endpoint": "FortiGate / FortiManager (endpoint)",
  "manual":             "Manual / other",
};

// Internal fields hidden from the per-source key/value table. `kind` and
// `syncedAt` are surfaced in the card header instead; raw recovery markers
// like `recovered` are shown via the inferred badge.
var _assetSourceHiddenObservedKeys = { kind: 1, syncedAt: 1, recovered: 1 };

function _humanizeSourceObservedKey(k) {
  // Camel-case → "Title Case With Spaces".
  if (!k) return "";
  var spaced = String(k).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function _formatSourceObservedValue(v) {
  if (v === null || v === undefined) return '<span style="color:var(--color-text-secondary)">—</span>';
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return escapeHtml(String(v));
  if (typeof v === "string") {
    // Pretty-print ISO timestamps; raw-show short strings; mono-format obvious
    // identifiers so they're easy to read at a glance.
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return escapeHtml(formatDate(v));
    return escapeHtml(v);
  }
  return '<code class="mono" style="font-size:0.78rem">' + escapeHtml(JSON.stringify(v)) + '</code>';
}

// Status pip rendered next to each row in the dependency tree. Mirrors the
// Status-pill priority used elsewhere: probe-down beats dep-down beats the
// rest of the five-state machine. We render a single character (▲ ● ▼) so
// the tree stays scannable; full label is in the title tooltip.
function _depTreeStatusPip(node) {
  // node may be either a parent (no dependencySuppressed field surfaced) or a
  // child (has it). For parents we don't have suppressed in the payload —
  // that's fine, the pip just reflects monitorStatus.
  if (!node || node.monitored === false) return '<span class="dep-tree-pip dep-tree-pip-unmon" title="Unmonitored">●</span>';
  // Admin-only "Dependency Test" overlay outranks every other state in the
  // tree pip — admins reading the tree need to see immediately which node
  // is the simulated-down one driving suppression downstream.
  var depTestUntil = node.dependencyTestUntil ? new Date(node.dependencyTestUntil) : null;
  if (depTestUntil && depTestUntil.getTime() > Date.now()) {
    return '<span class="dep-tree-pip dep-tree-pip-dep-test" title="Dependency Test active — simulated DOWN until ' + escapeHtml(depTestUntil.toLocaleString()) + '">●</span>';
  }
  if (node.dependencySuppressed) {
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

var _DEP_TREE_TYPE_LABEL = { firewall: "firewall", switch: "switch", access_point: "access point" };

// Click target: hostname becomes a button that pivots openViewModal to that
// asset. When the hostname is missing we fall through to the asset id.
function _depTreeNodeRow(node, opts) {
  opts = opts || {};
  var name = node.hostname || node.id;
  var safeName = escapeHtml(name);
  var typeLabel = _DEP_TREE_TYPE_LABEL[node.assetType] || node.assetType || "asset";
  var pip = _depTreeStatusPip(node);
  // Every node carries its computed dependencyLayer in the payload; surface it
  // so the operator can read each row's level, not just the current asset's.
  var levelBit = (node.dependencyLayer != null)
    ? ' <span class="dep-tree-level" title="Dependency level ' + node.dependencyLayer + '">L' + node.dependencyLayer + '</span>'
    : "";
  var hostHTML;
  if (opts.self) {
    // Current asset — bold + non-clickable, with the level annotation.
    var layerBit = (node.dependencyLayer != null) ? ' <span class="dep-tree-self-meta">— level ' + node.dependencyLayer + '</span>' : "";
    hostHTML = '<strong class="dep-tree-self">' + safeName + '</strong>' + layerBit;
  } else {
    hostHTML = '<button type="button" class="dep-tree-link" data-asset-id="' + escapeHtml(node.id) + '" title="Open ' + safeName + '">' + safeName + '</button>';
  }
  var sourceTag = (node.source === "override") ? ' <span class="dep-tree-source-tag" title="Operator override">override</span>' : "";
  var depthClass = opts.depth ? ' dep-tree-row-depth-' + opts.depth : '';
  return '<div class="dep-tree-row' + (opts.self ? ' dep-tree-row-self' : '') + depthClass + '">' +
    pip + ' ' + hostHTML +
    ' <span class="dep-tree-type">' + escapeHtml(typeLabel) + '</span>' +
    // Self node already prints "— level N" inline, so skip the tag there.
    (opts.self ? '' : levelBit) +
    sourceTag +
    '</div>';
}

// Render the General-tab dependency tree block. Hidden by default; populated
// asynchronously after openViewModal awaits api.assets.getDependencies(id).
// `payload` is the full /dependencies response. `selfId` distinguishes the
// current asset from any other id that might appear in the lists (defensive).
function renderDependencyTreeBlock(payload, selfId) {
  if (!payload) return "";
  var parents  = Array.isArray(payload.effectiveParents) ? payload.effectiveParents : [];
  var children = Array.isArray(payload.children)         ? payload.children         : [];
  var self     = payload.asset || {};
  if (parents.length === 0 && children.length === 0) {
    // Only show "standalone" messaging for Fortinet infra types; endpoint
    // assets (workstations, printers, etc.) shouldn't see the block at all
    // since they're never in the dependency tree.
    var infraTypes = ["firewall", "switch", "access_point"];
    if (infraTypes.indexOf(self.assetType) === -1) return "";
    return '<div class="dep-tree-block">' +
      '<div class="dep-tree-header">Dependency Tree</div>' +
      '<div class="dep-tree-empty">Standalone — not part of any discovered dependency chain.</div>' +
      '</div>';
  }

  var subtitle;
  if (parents.length === 0) subtitle = "Level 1 — root of the dependency tree";
  else if (parents.length === 1) {
    var p0 = parents[0].parent;
    subtitle = "Level " + (self.dependencyLayer != null ? self.dependencyLayer : "?") + " · directly under " + escapeHtml(p0.hostname || p0.id);
  } else {
    subtitle = "Level " + (self.dependencyLayer != null ? self.dependencyLayer : "?") + " · " + parents.length + " parents";
  }

  var parentsHTML = "";
  if (parents.length > 0) {
    parentsHTML = parents.map(function (p) { return _depTreeNodeRow({
      id: p.parent.id, hostname: p.parent.hostname, assetType: p.parent.assetType,
      dependencyLayer: p.parent.dependencyLayer, monitorStatus: p.parent.monitorStatus,
      monitored: p.parent.monitored, dependencySuppressed: false /* we don't have it on parent */, source: p.source,
      dependencyTestUntil: p.parent.dependencyTestUntil,
    }); }).join("");
    parentsHTML += '<div class="dep-tree-connector">│</div>';
  }
  var selfHTML = _depTreeNodeRow({
    id: self.id, hostname: self.hostname, assetType: self.assetType,
    dependencyLayer: self.dependencyLayer, monitorStatus: self.monitorStatus,
    monitored: self.monitored !== false, dependencySuppressed: !!self.dependencySuppressed,
    dependencyTestUntil: self.dependencyTestUntil,
  }, { self: true });

  var childrenHTML = "";
  if (children.length > 0) {
    childrenHTML += '<div class="dep-tree-connector">│</div>';
    childrenHTML += children.map(function (c) {
      var row = _depTreeNodeRow(c, { depth: 1 });
      var gcs = Array.isArray(c.grandchildren) ? c.grandchildren : [];
      if (gcs.length === 0) return row;
      var gcRows = gcs.map(function (gc) { return _depTreeNodeRow(gc, { depth: 2 }); }).join("");
      return row + gcRows;
    }).join("");
  }

  var overrideTag = payload.hasOverride
    ? '<span class="dep-tree-override-tag" title="Operator override is in effect">override active</span>'
    : "";
  // Admin-only "Dependency Test" — when active on the self node, render an
  // explanatory banner above the tree so it's obvious why every child is
  // showing up as Dep. Suppressed and so admins can see the auto-clear time.
  var depTestBanner = "";
  var selfDepTest = self.dependencyTestUntil ? new Date(self.dependencyTestUntil) : null;
  if (selfDepTest && selfDepTest.getTime() > Date.now()) {
    var startedBy = self.dependencyTestStartedBy ? " by " + escapeHtml(self.dependencyTestStartedBy) : "";
    depTestBanner = '<div class="dep-tree-test-banner">' +
      '<strong>Dependency Test active</strong>' + startedBy + ' — children are suppressed as if this device were down. Auto-clears ' + escapeHtml(selfDepTest.toLocaleString()) + '.' +
      '</div>';
  }

  return '<div class="dep-tree-block">' +
    '<div class="dep-tree-header">Dependency Tree ' + overrideTag + '</div>' +
    '<div class="dep-tree-subtitle">' + escapeHtml(subtitle) + '</div>' +
    depTestBanner +
    '<div class="dep-tree-body">' +
      parentsHTML +
      selfHTML +
      childrenHTML +
    '</div>' +
    '</div>';
}

// Wire clicks on .dep-tree-link buttons inside the body element. Each button
// carries data-asset-id; clicking pivots the open modal to that asset. Closes
// the current view in place (openViewModal swaps the body) so the user can
// keep walking up/down the tree.
function _wireDependencyTreeLinks(rootEl) {
  if (!rootEl) return;
  var btns = rootEl.querySelectorAll("[data-asset-id].dep-tree-link");
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener("click", function (e) {
      e.preventDefault();
      var id = e.currentTarget.getAttribute("data-asset-id");
      if (id) openViewModal(id);
    });
  }
}

// Shared markup for the per-firewall DHCP sighting table. Used by the Sources
// tab (general-visibility "found by N firewalls" history) and the Quarantine
// tab's fan-out section.
function _sightingsTableHTML(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return '<p class="empty-state" style="margin:0">No firewall sightings recorded.</p>';
  }
  return '<table class="data-table" style="font-size:0.82rem"><thead><tr><th>FortiGate</th><th>IP Address</th><th>VLAN</th><th>Source</th><th>Last Seen</th></tr></thead><tbody>' +
    rows.map(function (s) {
      var vlanCell = "—";
      if (s.subnetName || s.vlan != null) {
        var parts = [];
        if (s.subnetName) parts.push(escapeHtml(s.subnetName));
        if (s.vlan != null) parts.push("VLAN " + s.vlan);
        vlanCell = parts.join(" · ");
      }
      return '<tr>' +
        '<td>' + escapeHtml(s.fortigateDevice || "?") + '</td>' +
        '<td>' + escapeHtml(s.ipAddress || "—") + '</td>' +
        '<td>' + vlanCell + '</td>' +
        '<td><span class="badge badge-type">' + escapeHtml(s.source || "?") + '</span></td>' +
        '<td>' + (s.lastSeen ? formatDate(s.lastSeen) : "—") + '</td>' +
      '</tr>';
    }).join("") +
    '</tbody></table>';
}

// Shared markup for the IP-history table (IPs this asset has held over time).
function _ipHistoryTableHTML(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return '<p class="empty-state" style="margin:0">No IP history recorded for this asset.</p>';
  }
  return '<table class="data-table" style="font-size:0.82rem"><thead><tr><th>IP Address</th><th>Source</th><th>First Seen</th><th>Last Seen</th></tr></thead><tbody>' +
    rows.map(function (h) {
      return '<tr>' +
        '<td class="mono">' + escapeHtml(h.ip || "-") + '</td>' +
        '<td>' + escapeHtml(h.source || "-") + '</td>' +
        '<td>' + (h.firstSeen ? escapeHtml(formatDate(h.firstSeen)) : "-") + '</td>' +
        '<td>' + (h.lastSeen ? escapeHtml(formatDate(h.lastSeen)) : "-") + '</td>' +
      '</tr>';
    }).join("") +
    '</tbody></table>';
}

// ─── Events tab (asset-scoped audit history) ────────────────────────────────
// Self-contained reimplementation of the Events-page table + change-Detail
// popup, scoped to one asset (resourceType=asset, resourceId baked into every
// fetch). events.js is only loaded on events.html, so its renderTable /
// showEventDetail / TableSF wiring aren't available here — these mirror
// public/js/events.js. Follows TEMPLATES.md → "Sortable + filterable data
// table (server-side mode)" + offset pagination outside TableSF, and
// applyTableLayout for the column resize/chooser (dynamic-table variant).
var _assetEventsCurrentPage = [];   // current page of rows (Detail lookup by idx)
var _assetEventsAssetId = null;     // asset this tab is bound to
var _assetEventsSF = null;          // TableSF instance (server-side mode)
var _assetEventsLayout = null;      // applyTableLayout handle
var _assetEventsPageSize = 15;
var _assetEventsOffset = 0;
var _assetEventsTotal = 0;
var _assetEventsLoaded = false;     // lazy-load guard (first tab click)

// ─── Processes tab ─────────────────────────────────────────────────────────
// Current-state process inventory (one row per program, aggregated by name)
// with two pin checkboxes: Monitor (per-minute CPU/RAM + logs — Feature C) and
// Alert (flag for future alerting). Client-side TableSF for sort/filter since
// the row set is small + fetched in one call. Lazy-loaded on first tab click.
function _assetProcessesTabHTML(assetId) {
  return '<div class="section-block">' +
    '<div class="filter-bar" style="justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:0.5rem">' +
      '<p class="hint" style="margin:0;max-width:640px">Check <strong>Monitor</strong> to collect CPU/RAM history and logs for a program (sampled once a minute). Check <strong>Alert</strong> to flag it for future alerting/notifications.</p>' +
      '<button class="btn btn-secondary btn-sm" id="asset-view-proc-refresh">Refresh</button>' +
    '</div>' +
    '<div class="table-wrapper">' +
      '<table id="asset-view-proc-table">' +
        '<thead><tr>' +
          '<th style="width:64px"  data-col-id="monitor" data-col-required="true">Monitor</th>' +
          '<th style="width:54px"  data-col-id="alert"   data-col-required="true">Alert</th>' +
          '<th                      data-col-id="name"    data-col-required="true" data-sf-key="name"          data-sf-type="string">Name</th>' +
          '<th style="width:80px"  data-col-id="instances" data-sf-key="instanceCount" data-sf-type="number">Instances</th>' +
          '<th style="width:80px"  data-col-id="cpu"       data-sf-key="cpuPct"        data-sf-type="number">CPU %</th>' +
          '<th style="width:110px" data-col-id="ram"       data-sf-key="memRssBytes"   data-sf-type="number">RAM</th>' +
          '<th style="width:120px" data-col-id="user"      data-sf-key="username"      data-sf-type="string">User</th>' +
          '<th                      data-col-id="service"   data-sf-key="serviceUnit"   data-sf-type="string">Service/Unit</th>' +
        '</tr></thead>' +
        '<tbody id="asset-view-proc-tbody">' +
          '<tr><td colspan="8" class="empty-state">Loading…</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
  '</div>';
}

function _wireAssetProcessesTab(asset) {
  var assetId = asset && asset.id ? asset.id : asset; // tolerate id-or-object
  var btn = document.querySelector('#asset-view-tabs [data-tab="processes"]');
  if (!btn) return;
  var loaded = false;
  var layoutApplied = false;
  var sf = null;
  var rows = [];
  var configs = {};
  var monitored = new Set();
  var alerted = new Set();

  function fmtPct(v) { return v == null ? "—" : Number(v).toFixed(1); }

  function renderRows(data) {
    var tbody = document.getElementById("asset-view-proc-tbody");
    if (!tbody) return;
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No processes reported yet. Processes appear once an agent (or an SNMP/SSH/WinRM poll) reports this host\'s process list.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(function (p) {
      var nm = escapeHtml(p.name);
      var monChecked = monitored.has(p.name) ? " checked" : "";
      var altChecked = alerted.has(p.name) ? " checked" : "";
      var ram = (p.memRssBytes != null) ? _fmtBytes(Number(p.memRssBytes)) : "—";
      return '<tr>' +
        '<td style="text-align:center"><input type="checkbox" class="asset-proc-monitor-toggle" data-proc-name="' + nm + '"' + monChecked + '></td>' +
        '<td style="text-align:center"><input type="checkbox" class="asset-proc-alert-toggle" data-proc-name="' + nm + '"' + altChecked + '></td>' +
        '<td title="' + escapeHtml(p.exePath || "") + '"><a href="#" class="asset-proc-name-link" data-proc-name="' + nm + '">' + nm + '</a></td>' +
        '<td>' + (p.instanceCount != null ? p.instanceCount : "—") + '</td>' +
        '<td>' + fmtPct(p.cpuPct) + '</td>' +
        '<td>' + ram + '</td>' +
        '<td>' + escapeHtml(p.username || "—") + '</td>' +
        '<td>' + (p.serviceUnit ? escapeHtml(p.serviceUnit) : '<span style="color:var(--color-text-tertiary)">—</span>') + '</td>' +
      '</tr>';
    }).join("");
  }

  function apply() { renderRows(sf ? sf.apply(rows) : rows); }

  // Persist a pin-set change. `which` selects which array/field to write.
  async function togglePin(which, name, on) {
    var set = which === "monitor" ? monitored : alerted;
    var field = which === "monitor" ? "monitoredProcesses" : "alertWatchedProcesses";
    var next = new Set(set);
    if (on) next.add(name); else next.delete(name);
    try {
      var body = {};
      body[field] = Array.from(next);
      await api.assets.update(assetId, body);
      if (which === "monitor") monitored = next; else alerted = next;
      showToast(on
        ? (which === "monitor" ? ("Monitoring " + name + " (CPU/RAM + logs)") : ("Flagged " + name + " for alerting"))
        : (which === "monitor" ? ("Stopped monitoring " + name) : ("Unflagged " + name)),
        "success");
    } catch (err) {
      showToast(err && err.message ? err.message : "Failed to update", "error");
      apply(); // revert the checkbox to the persisted state
    }
  }

  async function load() {
    var tbody = document.getElementById("asset-view-proc-tbody");
    try {
      var resp = await api.assets.processes(assetId);
      rows = (resp && resp.processes) || [];
      configs = (resp && resp.configs) || {};
      monitored = new Set((resp && resp.monitoredProcesses) || []);
      alerted = new Set((resp && resp.alertWatchedProcesses) || []);
      // Resizable/choosable columns (rightmost right-edge pinned to the
      // border) — applied once, before TableSF, like the Events tab. Persists
      // across tbody re-renders since it operates on the thead/colgroup.
      if (!layoutApplied && typeof applyTableLayout === "function") {
        var procTable = document.getElementById("asset-view-proc-table");
        if (procTable) {
          applyTableLayout(procTable, "asset-processes", {
            onScreenshot: function (t) { _screenshotTableEl(t, "Processes"); },
          });
          layoutApplied = true;
        }
      }
      if (!sf && typeof TableSF !== "undefined") {
        sf = new TableSF("asset-view-proc-tbody", apply);
      }
      apply();
    } catch (err) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Error: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</td></tr>';
    }
  }

  // Delegated checkbox handler (survives re-render).
  var tbody = document.getElementById("asset-view-proc-tbody");
  if (tbody) {
    tbody.addEventListener("change", function (e) {
      var cb = e.target;
      var name = cb && cb.getAttribute ? cb.getAttribute("data-proc-name") : null;
      if (!name) return;
      if (cb.classList.contains("asset-proc-monitor-toggle")) togglePin("monitor", name, cb.checked);
      else if (cb.classList.contains("asset-proc-alert-toggle")) togglePin("alert", name, cb.checked);
    });
    // Name click → per-process detail slide-in (charts + logs + log config).
    tbody.addEventListener("click", function (e) {
      var link = e.target.closest ? e.target.closest(".asset-proc-name-link") : null;
      if (!link) return;
      e.preventDefault();
      var name = link.getAttribute("data-proc-name");
      if (!name) return;
      var procRow = rows.filter(function (r) { return r.name === name; })[0] || null;
      openProcessDetailPanel(asset, name, configs[name] || null, procRow);
    });
  }
  var refreshBtn = document.getElementById("asset-view-proc-refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", load);

  btn.addEventListener("click", function () {
    if (loaded) return;
    loaded = true;
    load();
  });
}

// ─── Per-process detail slide-in (nested slide-over) ─────────────────────────
// CPU/RAM charts (reusing _renderSensorChart) + an editable log-path config +
// a log viewer. Opened from the Processes-tab name link. Mirrors the interface
// detail panel's nested-slideover + range-button pattern.
function _ensureProcPanelDOM() {
  if (document.getElementById("proc-panel-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "proc-panel-overlay";
  overlay.className = "slideover-overlay slideover-nested";
  overlay.style.zIndex = "1099";
  overlay.innerHTML =
    '<div class="slideover" id="proc-panel" style="z-index:1100">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="proc-panel-title">Process</h3>' +
          '<button class="btn-icon" id="proc-panel-close" title="Close">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta" id="proc-panel-meta"></div>' +
      '</div>' +
      '<div class="slideover-body" id="proc-panel-body"><p class="empty-state" style="padding:1rem 1.25rem">Loading…</p></div>' +
      '<div class="slideover-footer" id="proc-panel-footer"></div>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener("click", function (e) { if (e.target === overlay) _closeProcPanel(); });
  document.getElementById("proc-panel-close").addEventListener("click", _closeProcPanel);
  if (typeof initSlideoverResize === "function") {
    initSlideoverResize(document.getElementById("proc-panel"), "polaris.panel.width.process");
  }
}

function _closeProcPanel() {
  var ov = document.getElementById("proc-panel-overlay");
  if (ov) ov.classList.remove("open");
}

async function openProcessDetailPanel(asset, name, cfg, procRow) {
  if (!asset || !name) return;
  _ensureProcPanelDOM();
  var titleEl = document.getElementById("proc-panel-title");
  var metaEl  = document.getElementById("proc-panel-meta");
  var bodyEl  = document.getElementById("proc-panel-body");
  var footerEl = document.getElementById("proc-panel-footer");
  titleEl.textContent = "Process — " + name;
  metaEl.textContent = asset.hostname || asset.ipAddress || asset.id;
  footerEl.innerHTML = '<span style="flex:1"></span><button class="btn btn-sm btn-secondary" id="btn-proc-panel-close-btn">Close</button>';
  requestAnimationFrame(function () {
    document.getElementById("proc-panel-overlay").classList.add("open");
  });
  document.getElementById("btn-proc-panel-close-btn").addEventListener("click", _closeProcPanel);

  var rangeBtns = _chartRangeBtnsHTML("proc-range-btn", [
    { value: "1h",  label: "1h" },
    { value: "24h", label: "24h" },
    { value: "7d",  label: "7d" },
    { value: "30d", label: "30d" },
  ], "assetProcess", "1h");

  var canEdit = canManageAssets();
  var c = cfg || {};
  var glob = c.logPathGlob || "";
  var src = c.logSource || "auto";
  function srcOpt(v, label) { return '<option value="' + v + '"' + (src === v ? " selected" : "") + '>' + label + '</option>'; }

  // Process control (Phase 4) — only when the process resolves to a service/
  // unit AND the operator holds the processControl permission. Buttons confirm
  // before acting; result polls the command status.
  var canControl = !!(procRow && procRow.controllable && procRow.serviceUnit && permAtLeast("processControl", "write"));
  var controlBlock = "";
  if (procRow && procRow.serviceUnit) {
    var ctlButtons = canControl
      ? '<button class="btn btn-sm btn-secondary proc-ctl-btn" data-action="restart">Restart</button>' +
        '<button class="btn btn-sm btn-secondary proc-ctl-btn" data-action="stop">Stop</button>' +
        '<button class="btn btn-sm btn-secondary proc-ctl-btn" data-action="start">Start</button>'
      : '<span class="hint" style="font-size:0.75rem">' + (permAtLeast("processControl", "write") ? "" : "Requires the Process Control permission.") + '</span>';
    controlBlock =
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:0.75rem;padding-bottom:0.6rem;border-bottom:1px solid var(--color-border)">' +
        '<div style="font-size:0.82rem;color:var(--color-text-secondary)">Service / unit: <code>' + escapeHtml(procRow.serviceUnit) + '</code> <span id="proc-ctl-status"></span></div>' +
        '<div style="display:flex;gap:6px">' + ctlButtons + '</div>' +
      '</div>';
  }

  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      controlBlock +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
        '<h4 style="margin:0">CPU &amp; Memory</h4>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">CPU (%)</h5>' +
      '<div id="proc-cpu-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<div id="proc-cpu-chart" class="proc-chart-box"></div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Memory (MB, RSS)</h5>' +
      '<div id="proc-mem-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<div id="proc-mem-chart" class="proc-chart-box"></div>' +
      '<div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:0.25rem;gap:8px;flex-wrap:wrap">' +
          '<h4 style="margin:0">Logs</h4>' +
          '<div style="display:flex;align-items:center;gap:10px">' +
            '<label style="font-size:0.78rem;display:flex;align-items:center;gap:4px"><input type="checkbox" id="proc-logs-flagged-only">Flagged only</label>' +
            (canEdit ? '<button class="btn btn-sm btn-secondary" id="btn-proc-flag-rules">Manage flag rules</button>' : '') +
            '<button class="btn btn-sm btn-secondary" id="btn-proc-logs-refresh">Refresh</button>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap;margin:0.4rem 0">' +
          '<label style="font-size:0.78rem;color:var(--color-text-secondary)">Source' +
            '<select id="proc-log-source" style="display:block;margin-top:2px"' + (canEdit ? "" : " disabled") + '>' +
              srcOpt("auto", "Auto") + srcOpt("journald-unit", "journald (Linux)") + srcOpt("file-glob", "File path/glob") +
            '</select>' +
          '</label>' +
          '<label style="flex:1;min-width:220px;font-size:0.78rem;color:var(--color-text-secondary)">Log path / wildcard' +
            '<input type="text" id="proc-log-glob" value="' + escapeHtml(glob) + '" placeholder="/var/log/' + escapeHtml(name) + '/*.log" style="display:block;width:100%;box-sizing:border-box;margin-top:2px"' + (canEdit ? "" : " disabled") + '>' +
          '</label>' +
          (canEdit ? '<button class="btn btn-sm btn-primary" id="btn-proc-log-config-save">Save</button>' : '') +
        '</div>' +
        (c.detectedUnit ? '<p class="hint" style="font-size:0.74rem">Auto-detected unit: <code>' + escapeHtml(c.detectedUnit) + '</code></p>' : '') +
        '<div id="proc-logs-view" style="max-height:300px;overflow:auto;background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;padding:0.5rem;font-family:var(--font-mono);font-size:0.78rem;white-space:pre-wrap;color:var(--color-text-secondary)">Loading…</div>' +
      '</div>' +
    '</div>';
  document.querySelectorAll(".proc-chart-box").forEach(function (el) {
    el.style.background = "var(--color-bg-elevated)";
    el.style.border = "1px solid var(--color-border)";
    el.style.borderRadius = "6px";
    el.style.padding = "0.5rem";
    el.style.minHeight = "160px";
  });

  await _loadProcessHistoryFor(asset.id, name, _getChartRangePref("assetProcess", "1h"));
  _loadProcessLogsFor(asset.id, name);

  document.querySelectorAll(".proc-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      document.querySelectorAll(".proc-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _setChartRangePref("assetProcess", range);
      _loadProcessHistoryFor(asset.id, name, range);
    });
  });
  var refreshLogs = document.getElementById("btn-proc-logs-refresh");
  if (refreshLogs) refreshLogs.addEventListener("click", function () { _loadProcessLogsFor(asset.id, name); });
  var flaggedOnly = document.getElementById("proc-logs-flagged-only");
  if (flaggedOnly) flaggedOnly.addEventListener("change", function () { _loadProcessLogsFor(asset.id, name); });
  var manageRules = document.getElementById("btn-proc-flag-rules");
  if (manageRules) manageRules.addEventListener("click", function () { openLogFlagRulesModal(asset, name, function () { _loadProcessLogsFor(asset.id, name); }); });
  if (canControl) {
    document.querySelectorAll(".proc-ctl-btn").forEach(function (b) {
      b.addEventListener("click", function () { _runProcessControl(asset.id, name, b.getAttribute("data-action")); });
    });
  }
  var saveCfg = document.getElementById("btn-proc-log-config-save");
  if (saveCfg) {
    saveCfg.addEventListener("click", async function () {
      var body = {
        logSource:   document.getElementById("proc-log-source").value,
        logPathGlob: document.getElementById("proc-log-glob").value || null,
      };
      saveCfg.disabled = true;
      try {
        await api.assets.setProcessConfig(asset.id, name, body);
        showToast("Log config saved for " + name, "success");
        _loadProcessLogsFor(asset.id, name);
      } catch (err) {
        showToast(err && err.message ? err.message : "Save failed", "error");
      } finally {
        saveCfg.disabled = false;
      }
    });
  }
}

async function _loadProcessHistoryFor(assetId, name, range) {
  var cpuEl = document.getElementById("proc-cpu-chart");
  var memEl = document.getElementById("proc-mem-chart");
  var cpuStats = document.getElementById("proc-cpu-stats");
  var memStats = document.getElementById("proc-mem-stats");
  if (!cpuEl || !memEl) return;
  try {
    var data = await api.assets.processHistory(assetId, name, range || "1h");
    var samples = data.samples || [];
    var cpu = samples.filter(function (s) { return typeof s.cpuPct === "number"; })
      .map(function (s) { return { timestamp: s.timestamp, value: s.cpuPct }; });
    var mem = samples.filter(function (s) { return s.memRssBytes != null; })
      .map(function (s) { return { timestamp: s.timestamp, value: Number(s.memRssBytes) / 1048576 }; });
    if (cpuStats) _renderChartStats(cpuStats, cpu.length, [{ label: "Max", value: cpu.length ? Math.max.apply(null, cpu.map(function (p) { return p.value; })).toFixed(1) + "%" : "—" }]);
    if (memStats) _renderChartStats(memStats, mem.length, [{ label: "Max", value: mem.length ? Math.max.apply(null, mem.map(function (p) { return p.value; })).toFixed(0) + " MB" : "—" }]);
    _renderSensorChart(cpuEl, cpu, { since: data.since, until: data.until, subject: name + " CPU", unit: "%" });
    _renderSensorChart(memEl, mem, { since: data.since, until: data.until, subject: name + " RAM", unit: "MB" });
  } catch (err) {
    cpuEl.textContent = "Error: " + (err.message || "failed to load");
    memEl.textContent = "";
  }
}

// Phase 4: issue a Stop/Start/Restart for a service-backed process, then poll
// the command to completion. Confirm first — this acts on the live host.
async function _runProcessControl(assetId, name, action) {
  var verb = action.charAt(0).toUpperCase() + action.slice(1);
  var ok = await showConfirm(verb + ' "' + name + '" on this host? This runs against the live service.');
  if (!ok) return;
  var statusEl = document.getElementById("proc-ctl-status");
  if (statusEl) statusEl.textContent = " — " + action + "ing…";
  try {
    var resp = await api.assets.controlProcess(assetId, name, action);
    var cmdId = resp && resp.command && resp.command.id;
    showToast(verb + " requested for " + name, "success");
    if (cmdId) _pollProcessCommand(assetId, cmdId, statusEl, 0);
  } catch (err) {
    showToast(err.message || "Control request failed", "error");
    if (statusEl) statusEl.textContent = "";
  }
}

function _pollProcessCommand(assetId, commandId, statusEl, tries) {
  api.assets.processCommand(assetId, commandId).then(function (r) {
    var st = r && r.command;
    if (!st) return;
    if (st.status === "succeeded") {
      if (statusEl) statusEl.textContent = " — done" + (st.resultState ? " (" + escapeHtml(st.resultState) + ")" : "");
      showToast(st.action + " of " + st.target + " succeeded", "success");
      return;
    }
    if (st.status === "failed") {
      if (statusEl) statusEl.textContent = " — failed";
      showToast(st.error || (st.action + " failed"), "error");
      return;
    }
    if (tries < 15) {
      setTimeout(function () { _pollProcessCommand(assetId, commandId, statusEl, tries + 1); }, 2000);
    } else if (statusEl) {
      statusEl.textContent = " — still pending (agent may be offline)";
    }
  }).catch(function () { /* transient — leave the last status */ });
}

async function _loadProcessLogsFor(assetId, name) {
  var el = document.getElementById("proc-logs-view");
  if (!el) return;
  var flaggedToggle = document.getElementById("proc-logs-flagged-only");
  var flaggedOnly = !!(flaggedToggle && flaggedToggle.checked);
  try {
    var data = await api.assets.processLogs(assetId, name, { limit: 300, flagged: flaggedOnly ? 1 : undefined });
    var logs = data.logs || [];
    if (!logs.length) {
      el.textContent = flaggedOnly
        ? "No flagged log lines in this window."
        : "No log lines collected yet. Set a log source/path above (or enable journald on Linux) and check that the program is pinned for Monitor.";
      return;
    }
    // Server returns newest-first; show oldest-first in the viewer.
    el.innerHTML = logs.slice().reverse().map(function (l) {
      var ts = l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : "";
      var lvl = l.level ? "[" + escapeHtml(l.level) + "] " : "";
      var flags = Array.isArray(l.flags) ? l.flags : [];
      var badges = flags.map(function (f) {
        var col = f.color || "var(--color-warning)";
        return '<span style="display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;font-size:0.7rem;background:' + col + ';color:#000">' + escapeHtml(f.label || f.name) + '</span>';
      }).join("");
      var hl = flags.length ? ';background:rgba(245,158,11,0.12);border-left:2px solid var(--color-warning);padding-left:4px' : "";
      return '<div style="' + hl + '"><span style="color:var(--color-text-tertiary)">' + escapeHtml(ts) + '</span> ' + lvl + escapeHtml(l.message || "") + badges + '</div>';
    }).join("");
  } catch (err) {
    el.textContent = "Error: " + (err.message || "failed to load logs");
  }
}

// Manage-flag-rules modal: list rules (scoped to global + this asset/program),
// add a rule prefilled for this process, toggle enable, delete. onChange is
// invoked after any write so the caller can re-fetch the flagged view.
function openLogFlagRulesModal(asset, processName, onChange) {
  var bodyHTML =
    '<div id="lfr-modal">' +
      '<p class="hint" style="margin-top:0">Rules flag matching log lines at read time. Scope to all logs, this asset, or this program.</p>' +
      '<div id="lfr-list" style="margin-bottom:1rem">Loading…</div>' +
      '<h4 style="margin:0.5rem 0">Add rule</h4>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
        '<label style="font-size:0.8rem">Name<input type="text" id="lfr-name" style="width:100%;box-sizing:border-box"></label>' +
        '<label style="font-size:0.8rem">Scope<select id="lfr-scope" style="width:100%">' +
          '<option value="process">This program (' + escapeHtml(processName) + ')</option>' +
          '<option value="asset">This asset</option>' +
          '<option value="global">All process logs</option>' +
        '</select></label>' +
        '<label style="font-size:0.8rem">Match type<select id="lfr-matchtype" style="width:100%"><option value="substring">Contains</option><option value="regex">Regex</option><option value="glob">Glob</option></select></label>' +
        '<label style="font-size:0.8rem">Min level<select id="lfr-minlevel" style="width:100%"><option value="">Any</option><option value="warning">Warning+</option><option value="error">Error+</option><option value="critical">Critical</option></select></label>' +
        '<label style="font-size:0.8rem;grid-column:1/3">Pattern<input type="text" id="lfr-pattern" style="width:100%;box-sizing:border-box" placeholder="e.g. error  |  out of memory  |  *timeout*"></label>' +
        '<label style="font-size:0.8rem">Label<input type="text" id="lfr-label" style="width:100%;box-sizing:border-box" placeholder="optional"></label>' +
        '<label style="font-size:0.8rem;display:flex;align-items:center;gap:6px;margin-top:1.2rem"><input type="checkbox" id="lfr-case">Case-sensitive</label>' +
      '</div>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:0.6rem"><button class="btn btn-sm btn-primary" id="lfr-add">Add rule</button></div>' +
    '</div>';
  openModal("Log flag rules — " + processName, bodyHTML, '<button class="btn btn-secondary" id="lfr-close">Close</button>');
  var closeBtn = document.getElementById("lfr-close");
  if (closeBtn) closeBtn.addEventListener("click", closeModal);

  async function refreshList() {
    var listEl = document.getElementById("lfr-list");
    if (!listEl) return;
    try {
      var resp = await api.logFlagRules.list();
      var rules = (resp && resp.rules) || [];
      // Show rules relevant to this view: global + this asset (+ its programs).
      rules = rules.filter(function (r) {
        return r.scope === "global" || r.assetId === asset.id;
      });
      if (!rules.length) { listEl.innerHTML = '<p class="empty-state" style="margin:0">No rules yet.</p>'; return; }
      listEl.innerHTML = '<table class="data-table" style="font-size:0.8rem;width:100%"><thead><tr><th>On</th><th>Name</th><th>Scope</th><th>Match</th><th>Pattern</th><th></th></tr></thead><tbody>' +
        rules.map(function (r) {
          var scopeLabel = r.scope === "process" ? ("program: " + escapeHtml(r.processName || "?")) : r.scope === "asset" ? "this asset" : "global";
          return '<tr>' +
            '<td><input type="checkbox" class="lfr-enable" data-id="' + r.id + '"' + (r.enabled ? " checked" : "") + '></td>' +
            '<td>' + escapeHtml(r.name) + '</td>' +
            '<td>' + scopeLabel + '</td>' +
            '<td>' + escapeHtml(r.matchType) + '</td>' +
            '<td class="mono">' + escapeHtml(r.pattern) + '</td>' +
            '<td><button class="btn btn-sm btn-danger lfr-del" data-id="' + r.id + '">Delete</button></td>' +
          '</tr>';
        }).join("") + '</tbody></table>';
      listEl.querySelectorAll(".lfr-enable").forEach(function (cb) {
        cb.addEventListener("change", async function () {
          try { await api.logFlagRules.update(cb.getAttribute("data-id"), { enabled: cb.checked }); if (onChange) onChange(); }
          catch (err) { showToast(err.message || "Update failed", "error"); cb.checked = !cb.checked; }
        });
      });
      listEl.querySelectorAll(".lfr-del").forEach(function (b) {
        b.addEventListener("click", async function () {
          try { await api.logFlagRules.remove(b.getAttribute("data-id")); refreshList(); if (onChange) onChange(); }
          catch (err) { showToast(err.message || "Delete failed", "error"); }
        });
      });
    } catch (err) {
      listEl.textContent = "Error: " + (err.message || "failed to load rules");
    }
  }

  var addBtn = document.getElementById("lfr-add");
  if (addBtn) {
    addBtn.addEventListener("click", async function () {
      var scope = document.getElementById("lfr-scope").value;
      var body = {
        name:        document.getElementById("lfr-name").value.trim(),
        scope:       scope,
        assetId:     scope === "global" ? null : asset.id,
        processName: scope === "process" ? processName : null,
        matchType:   document.getElementById("lfr-matchtype").value,
        pattern:     document.getElementById("lfr-pattern").value,
        caseSensitive: document.getElementById("lfr-case").checked,
        minLevel:    document.getElementById("lfr-minlevel").value || null,
        label:       document.getElementById("lfr-label").value.trim() || null,
      };
      if (!body.name || !body.pattern) { showToast("Name and pattern are required", "error"); return; }
      addBtn.disabled = true;
      try {
        await api.logFlagRules.create(body);
        showToast("Rule added", "success");
        document.getElementById("lfr-name").value = "";
        document.getElementById("lfr-pattern").value = "";
        document.getElementById("lfr-label").value = "";
        refreshList();
        if (onChange) onChange();
      } catch (err) {
        showToast(err.message || "Failed to add rule", "error");
      } finally {
        addBtn.disabled = false;
      }
    });
  }
  refreshList();
}

function _assetEventsTabHTML(assetId) {
  return '<div class="section-block">' +
    '<div class="filter-bar" style="justify-content:flex-end;margin-bottom:0.5rem">' +
      '<label>Show</label>' +
      '<select id="asset-view-events-pagesize" style="width:auto">' +
        '<option value="15" selected>15</option>' +
        '<option value="25">25</option>' +
        '<option value="50">50</option>' +
        '<option value="100">100</option>' +
      '</select>' +
      '<button class="btn btn-secondary btn-sm" id="asset-view-events-refresh">Refresh</button>' +
    '</div>' +
    '<div class="table-wrapper">' +
      '<table id="asset-view-events-table">' +
        '<thead><tr>' +
          '<th style="width:160px" data-col-id="timestamp" data-sf-key="timestamp" data-sf-type="date">Timestamp</th>' +
          '<th style="width:70px"  data-col-id="level"     data-sf-key="level"     data-sf-type="string" data-sf-options="info|warning|error">Level</th>' +
          '<th style="width:140px" data-col-id="action"    data-sf-key="action"    data-sf-type="string">Action</th>' +
          '<th style="width:100px" data-col-id="resource"  data-sf-key="resourceType" data-sf-type="string">Resource</th>' +
          '<th                      data-col-id="message"  data-sf-key="message"   data-sf-type="string">Message</th>' +
          '<th style="width:100px" data-col-id="user"      data-sf-key="actor"     data-sf-type="string">User</th>' +
          '<th style="width:60px"  data-col-id="actions" data-col-required="true"></th>' +
        '</tr></thead>' +
        '<tbody id="asset-view-events-tbody">' +
          '<tr><td colspan="7" class="empty-state">Loading…</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
    '<div id="asset-view-events-pagination" style="display:flex;align-items:center;gap:12px;justify-content:center;padding:1rem 0"></div>' +
  '</div>';
}

function _renderAssetEventRow(ev, idx) {
  var ts = new Date(ev.timestamp);
  var timeStr = ts.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " " + ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  var levelClass = "badge-level-" + (ev.level || "info");
  var levelLabel = (ev.level || "info").toUpperCase();

  var resourceLabel = ev.resourceType || "-";
  var resourceName = ev.resourceName ? ' <span style="color:var(--color-text-tertiary);font-size:0.8rem">(' + escapeHtml(ev.resourceName) + ')</span>' : "";

  var detailBtn = ev.details && ev.details.changes
    ? '<button class="btn btn-secondary btn-sm btn-event-detail" data-event-idx="' + idx + '" style="padding:2px 8px;font-size:0.75rem">Detail</button>'
    : '';

  return '<tr>' +
    '<td style="font-family:var(--font-mono);font-size:0.82rem;white-space:nowrap">' + escapeHtml(timeStr) + '</td>' +
    '<td><span class="badge ' + levelClass + '">' + levelLabel + '</span></td>' +
    '<td style="font-family:var(--font-mono);font-size:0.82rem">' + escapeHtml(ev.action || "") + '</td>' +
    '<td>' + escapeHtml(resourceLabel) + resourceName + '</td>' +
    '<td>' + escapeHtml(ev.message || "") + '</td>' +
    '<td>' + escapeHtml(ev.actor || "-") + '</td>' +
    '<td>' + detailBtn + '</td>' +
    '</tr>';
}

// Translate the live TableSF filter + sort state into GET /events params,
// with resourceType/resourceId pinned to this asset. Mirrors events.js
// _buildEventsQuery (server-side mode). The Resource column filter is left
// unwired — every row in this view is resourceType=asset by construction.
function _buildAssetEventsQuery() {
  var filters = _assetEventsSF ? _assetEventsSF._filters || {} : {};
  var params = {
    resourceType: "asset",
    resourceId: _assetEventsAssetId,
    limit: _assetEventsPageSize,
    offset: _assetEventsOffset,
  };
  if (Array.isArray(filters.level) && filters.level.length) params.level = filters.level.join(",");

  function pushText(field, raw) {
    if (raw == null) return;
    if (typeof raw === "string") {
      var v = raw.trim();
      if (v) params[field] = v;
    } else if (typeof raw === "object") {
      if (raw.op === "empty") {
        params[field + "Op"] = "empty";
      } else if (raw.op === "notempty") {
        params[field + "Op"] = "is_not_empty";
      } else if (raw.op === "not-contains") {
        var q = (raw.q || "").trim();
        if (q) { params[field] = q; params[field + "Op"] = "not_contains"; }
      }
    }
  }
  pushText("action", filters.action);
  pushText("actor", filters.actor);
  pushText("message", filters.message);

  if (filters.timestamp && filters.timestamp.type === "date") {
    if (filters.timestamp.from) params.since = filters.timestamp.from + "T00:00:00";
    if (filters.timestamp.to)   params.until = filters.timestamp.to   + "T23:59:59.999";
  }
  if (_assetEventsSF && _assetEventsSF._sortKey) {
    params.sortBy = _assetEventsSF._sortKey;
    params.sortDir = _assetEventsSF._sortDir === "asc" ? "asc" : "desc";
  }
  return params;
}

async function _loadAssetEventsTabFor() {
  var tbody = document.getElementById("asset-view-events-tbody");
  if (!tbody || !_assetEventsAssetId) return;
  try {
    var data = await api.events.list(_buildAssetEventsQuery());
    var events = (data && data.events) || [];
    _assetEventsTotal = (data && data.total) || 0;
    _assetEventsCurrentPage = events;
    tbody.innerHTML = events.length
      ? events.map(_renderAssetEventRow).join("")
      : '<tr><td colspan="7" class="empty-state">No events found</td></tr>';
    _renderAssetEventsPagination();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load events</td></tr>';
  }
}

function _renderAssetEventsPagination() {
  var container = document.getElementById("asset-view-events-pagination");
  if (!container) return;
  var total = _assetEventsTotal;
  var pageSize = _assetEventsPageSize;
  var totalPages = Math.max(1, Math.ceil(total / pageSize));
  var currentPage = Math.floor(_assetEventsOffset / pageSize) + 1;

  var pageButtons = "";
  var startPage = Math.max(1, currentPage - 2);
  var endPage = Math.min(totalPages, startPage + 4);
  if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);
  if (startPage > 1) {
    pageButtons += '<button class="btn btn-secondary btn-sm ae-page-btn" data-page="1">1</button>';
    if (startPage > 2) pageButtons += '<span style="color:var(--color-text-tertiary)">…</span>';
  }
  for (var p = startPage; p <= endPage; p++) {
    pageButtons += p === currentPage
      ? '<button class="btn btn-primary btn-sm ae-page-btn" data-page="' + p + '" disabled>' + p + '</button>'
      : '<button class="btn btn-secondary btn-sm ae-page-btn" data-page="' + p + '">' + p + '</button>';
  }
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) pageButtons += '<span style="color:var(--color-text-tertiary)">…</span>';
    pageButtons += '<button class="btn btn-secondary btn-sm ae-page-btn" data-page="' + totalPages + '">' + totalPages + '</button>';
  }

  container.innerHTML =
    '<button class="btn btn-secondary btn-sm ae-page-prev" ' + (currentPage <= 1 ? 'disabled' : '') + '>&laquo; Prev</button>' +
    pageButtons +
    '<button class="btn btn-secondary btn-sm ae-page-next" ' + (currentPage >= totalPages ? 'disabled' : '') + '>Next &raquo;</button>' +
    '<span style="font-size:0.82rem;color:var(--color-text-tertiary);margin-left:8px">' + total + ' events</span>';

  var prev = container.querySelector(".ae-page-prev");
  if (prev) prev.addEventListener("click", function () {
    if (_assetEventsOffset >= pageSize) { _assetEventsOffset -= pageSize; _loadAssetEventsTabFor(); }
  });
  var next = container.querySelector(".ae-page-next");
  if (next) next.addEventListener("click", function () {
    if (_assetEventsOffset + pageSize < total) { _assetEventsOffset += pageSize; _loadAssetEventsTabFor(); }
  });
  container.querySelectorAll(".ae-page-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var page = parseInt(btn.getAttribute("data-page"), 10);
      _assetEventsOffset = (page - 1) * pageSize;
      _loadAssetEventsTabFor();
    });
  });
}

function _saveAssetEventsPrefs() {
  if (typeof currentUsername === "undefined" || !currentUsername) return;
  try {
    // Layout persistence is handled by applyTableLayout under its own
    // polaris-table-layout-asset-events-<user> key; here we keep pageSize +
    // filter/sort state. Not per-asset — operators want one Events-tab view.
    localStorage.setItem("polaris-prefs-asset-events-" + currentUsername, JSON.stringify({
      pageSize: _assetEventsPageSize,
      filters: _assetEventsSF ? _assetEventsSF._filters : null,
      sort: _assetEventsSF ? { key: _assetEventsSF._sortKey, dir: _assetEventsSF._sortDir } : null,
    }));
  } catch (_) {}
}

function _restoreAssetEventsPrefs() {
  if (typeof currentUsername === "undefined" || !currentUsername) return;
  var raw;
  try { raw = localStorage.getItem("polaris-prefs-asset-events-" + currentUsername); } catch (_) { return; }
  if (!raw) return;
  try {
    var p = JSON.parse(raw);
    if (p.pageSize) {
      _assetEventsPageSize = p.pageSize;
      var ps = document.getElementById("asset-view-events-pagesize");
      if (ps) ps.value = String(p.pageSize);
    }
    if (_assetEventsSF) {
      if (p.filters && typeof p.filters === "object") _assetEventsSF._filters = p.filters;
      if (p.sort && typeof p.sort === "object") {
        if (p.sort.key) _assetEventsSF._sortKey = p.sort.key;
        if (p.sort.dir === "asc" || p.sort.dir === "desc") _assetEventsSF._sortDir = p.sort.dir;
      }
      _assetEventsSF.restoreFilterUI();
      _assetEventsSF._updateIcons();
    }
  } catch (_) {}
}

function _wireAssetEventsTab(assetId) {
  // Fresh per modal open — the table DOM was just rebuilt by openViewModal.
  _assetEventsAssetId = assetId;
  _assetEventsOffset = 0;
  _assetEventsTotal = 0;
  _assetEventsCurrentPage = [];
  _assetEventsLoaded = false;

  var table = document.getElementById("asset-view-events-table");
  if (!table) return;
  _assetEventsLayout = applyTableLayout(table, "asset-events", {
    onChange: _saveAssetEventsPrefs,
    onScreenshot: function (t) { _screenshotTableEl(t, "Events"); },
  });
  // Server-side mode: never call sf.apply(); onChange resets offset + refetches.
  _assetEventsSF = new TableSF("asset-view-events-tbody", function () {
    _assetEventsOffset = 0;
    _loadAssetEventsTabFor();
    _saveAssetEventsPrefs();
  });
  _restoreAssetEventsPrefs();

  var ps = document.getElementById("asset-view-events-pagesize");
  if (ps) ps.addEventListener("change", function () {
    _assetEventsPageSize = parseInt(this.value, 10) || 15;
    _assetEventsOffset = 0;
    _loadAssetEventsTabFor();
    _saveAssetEventsPrefs();
  });
  var refresh = document.getElementById("asset-view-events-refresh");
  if (refresh) refresh.addEventListener("click", function () { _loadAssetEventsTabFor(); });

  // Lazy first fetch on first Events-tab click (avoids an extra /events query
  // on every modal open). Subsequent loads come from TableSF/pagination.
  var btn = document.querySelector('#asset-view-tabs .page-tab[data-tab="events"]');
  if (btn) btn.addEventListener("click", function () {
    if (_assetEventsLoaded) return;
    _assetEventsLoaded = true;
    _loadAssetEventsTabFor();
  });

  var tbody = document.getElementById("asset-view-events-tbody");
  if (tbody) tbody.addEventListener("click", function (e) {
    var detailBtn = e.target.closest(".btn-event-detail");
    if (!detailBtn) return;
    var idx = parseInt(detailBtn.getAttribute("data-event-idx"), 10);
    if (_assetEventsCurrentPage[idx]) _showAssetEventDetail(_assetEventsCurrentPage[idx]);
  });
}

// ── Events-tab export (footer Export dropdown) ──────────────────────────────
// The footer's Screenshot button becomes an Export dropdown while the Events
// tab is active (_syncAssetFooterButtons). Mirrors the Events page export
// (events.js handleEventExport / generateEventCsv / generateEventPdf) but is
// scoped to this asset via _buildAssetEventsQuery — "all" honors the
// operator's active column filters + sort, pinned to resourceType=asset.
// The generators live here (with an _asset prefix) because events.js is not
// loaded on assets.html / map.html.

var _assetExportCloserWired = false; // document-level menu closer, once per page

// Hostname → filename-safe fragment for the export filenames.
function _assetExportSubject(asset) {
  var s = (asset && (asset.hostname || asset.id)) || "asset";
  return String(s).replace(/[^A-Za-z0-9._-]+/g, "-");
}

function _syncAssetFooterButtons() {
  var active = document.querySelector("#asset-view-tabs .page-tab.active");
  var isEvents = !!(active && active.getAttribute("data-tab") === "events");
  var shot = document.getElementById("btn-asset-screenshot");
  var wrap = document.getElementById("asset-export-wrap");
  if (shot) shot.style.display = isEvents ? "none" : "";
  if (wrap) wrap.style.display = isEvents ? "" : "none";
}

async function _handleAssetEventExport(mode, fmt, asset) {
  var events, label, ok;
  if (mode === "page") {
    events = _assetEventsCurrentPage;
    if (!events || events.length === 0) { showToast("No events to export", "error"); return; }
    label = "page " + (Math.floor(_assetEventsOffset / _assetEventsPageSize) + 1);
  } else if (mode === "all") {
    if (_assetEventsTotal > 100) {
      ok = await showConfirm("This will export " + _assetEventsTotal + " events. Continue?");
      if (!ok) return;
    }
  }

  await trackedPdfExport("Exporting asset events " + fmt.toUpperCase(), async function (signal) {
    if (mode === "all") {
      // GET /events caps limit at 200 (Zod schema rejects, not clamps,
      // anything larger) — page through in 200-row chunks up to a 10k
      // export ceiling.
      events = [];
      var offset = 0;
      var total = Infinity;
      while (offset < total && events.length < 10000) {
        var q = _buildAssetEventsQuery();
        q.limit = 200;
        q.offset = offset;
        var data = await request("GET", "/events" + toQuery(q), undefined, signal);
        if (signal.aborted) return;
        var chunk = (data && data.events) || [];
        events = events.concat(chunk);
        total = (data && data.total) || events.length;
        if (chunk.length === 0) break;
        offset += chunk.length;
      }
      label = "all " + events.length + " events";
    }
    if (signal.aborted) return;
    if (!events || events.length === 0) { showToast("No events to export", "error"); return; }
    if (fmt === "csv") _generateAssetEventCsv(events, asset);
    else _generateAssetEventPdf(events, label, asset);
  });
}

function _generateAssetEventCsv(events, asset) {
  var headers = ["Timestamp", "Level", "Action", "Resource Type", "Resource Name", "Message", "User"];
  var rows = events.map(function (ev) {
    var ts = new Date(ev.timestamp);
    var timeStr = ts.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
      " " + ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return [
      timeStr, (ev.level || "info").toUpperCase(), ev.action || "",
      ev.resourceType || "", ev.resourceName || "", ev.message || "", ev.actor || "",
    ];
  });
  var subject = _assetExportSubject(asset);
  var filename = "polaris-asset-events-" + subject + "-" + new Date().toISOString().slice(0, 10) + ".csv";
  downloadCsv(headers, rows, filename);
  showToast("Exported " + events.length + " events to " + filename);
}

function _generateAssetEventPdf(events, label, asset) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("PDF library not loaded. Check your internet connection and reload the page.");
  }
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });

  var now = new Date();
  var timestamp = now.toLocaleDateString() + " " + now.toLocaleTimeString();
  var subject = _assetExportSubject(asset);

  doc.setFontSize(16);
  doc.setTextColor(40, 40, 40);
  doc.text((_branding ? _branding.appName : "Polaris") + " — Event Log — " + subject, 40, 36);
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text("Generated: " + timestamp + "  |  Scope: " + label + "  |  Count: " + events.length, 40, 52);

  var head = [["Timestamp", "Level", "Action", "Resource", "Message", "User"]];
  var body = events.map(function (ev) {
    var ts = new Date(ev.timestamp);
    var timeStr = ts.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      " " + ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    var resource = ev.resourceType || "-";
    if (ev.resourceName) resource += " (" + ev.resourceName + ")";
    return [
      timeStr,
      (ev.level || "info").toUpperCase(),
      ev.action || "-",
      resource,
      ev.message || "-",
      ev.actor || "-",
    ];
  });

  doc.autoTable({
    startY: 64,
    head: head,
    body: body,
    theme: "grid",
    styles: { fontSize: 7.5, cellPadding: 4, overflow: "linebreak" },
    headStyles: { fillColor: [30, 30, 54], textColor: [230, 230, 230], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 250] },
    margin: { left: 40, right: 40 },
    columnStyles: {
      0: { cellWidth: 100 },
      1: { cellWidth: 42 },
      2: { cellWidth: 90 },
      3: { cellWidth: 80 },
      5: { cellWidth: 60 },
    },
    didDrawPage: function (data) {
      var pageNum = doc.internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(
        "Page " + data.pageNumber + " of " + pageNum + "  |  " + (_branding ? _branding.appName : "Polaris") + " Event Log",
        doc.internal.pageSize.getWidth() / 2,
        doc.internal.pageSize.getHeight() - 20,
        { align: "center" }
      );
    },
  });

  var filename = "polaris-asset-events-" + subject + "-" + now.toISOString().slice(0, 10) + ".pdf";
  doc.save(filename);
  showToast("Exported " + events.length + " events to " + filename);
}

function _formatEventFieldName(field) {
  return field.replace(/([A-Z])/g, " $1").replace(/^./, function (c) { return c.toUpperCase(); });
}

function _formatEventDetailValue(val) {
  if (Array.isArray(val)) return val.join(", ") || "none";
  if (val instanceof Object) return JSON.stringify(val);
  return String(val);
}

function _showAssetEventDetail(ev) {
  var changes = ev.details && ev.details.changes ? ev.details.changes : {};
  var keys = Object.keys(changes);
  if (!keys.length) return;

  var rows = keys.map(function (field) {
    var c = changes[field];
    var from = c.from === null || c.from === "" ? '<span style="color:var(--color-text-tertiary);font-style:italic">empty</span>' : escapeHtml(_formatEventDetailValue(c.from));
    var to = c.to === null || c.to === "" ? '<span style="color:var(--color-text-tertiary);font-style:italic">empty</span>' : escapeHtml(_formatEventDetailValue(c.to));
    return '<tr>' +
      '<td style="font-weight:500;white-space:nowrap">' + escapeHtml(_formatEventFieldName(field)) + '</td>' +
      '<td style="color:var(--color-danger)">' + from + '</td>' +
      '<td style="color:var(--color-success)">' + to + '</td>' +
      '</tr>';
  }).join("");

  var ts = new Date(ev.timestamp);
  var timeStr = ts.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " " + ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  var body =
    '<div style="margin-bottom:1rem;font-size:0.85rem;color:var(--color-text-secondary)">' +
      '<span style="font-family:var(--font-mono)">' + escapeHtml(ev.action) + '</span> by <strong>' + escapeHtml(ev.actor || "unknown") + '</strong> at ' + escapeHtml(timeStr) +
    '</div>' +
    '<table style="width:100%">' +
      '<thead><tr>' +
        '<th style="width:120px">Field</th>' +
        '<th>Before</th>' +
        '<th>After</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>';

  var title = "Change Detail" + (ev.resourceName ? " — " + ev.resourceName : "");
  openModal(title, body, '<button class="btn btn-secondary" onclick="closeModal()">Close</button>');
}

function _assetSourcesTabHTML(sources, assetId, sightings, ipHistory) {
  sources = Array.isArray(sources) ? sources : [];
  sightings = Array.isArray(sightings) ? sightings : [];
  ipHistory = Array.isArray(ipHistory) ? ipHistory : [];
  // Admin-only Merge action — absorb a duplicate asset into this one (the
  // inverse of the per-source Split below). Asset-level, so it's offered
  // regardless of source count (a manually-created single-source asset can
  // still be merged with a discovered duplicate).
  var mergeToolbar = isAdmin()
    ? '<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem">' +
        '<button class="btn btn-sm btn-secondary" onclick="openAssetMergeModal(\'' + assetId + '\')" ' +
        'title="Merge a duplicate asset into this one (combines discovery sources; the inverse of Split)">Merge asset...</button>' +
      '</div>'
    : '';
  if (sources.length === 0 && sightings.length === 0 && ipHistory.length === 0) {
    return mergeToolbar + '<div class="empty-state" style="padding:1rem">No source rows on file for this asset. Phase-1 backfill runs at startup; check the Events log if you expected entries here.</div>';
  }
  // History sections appended below the per-source cards: which firewalls have
  // seen this asset, and which IPs it has held over time. Folded in here so
  // they're visible to anyone who can view the asset (the Quarantine tab's
  // sighting copy is assets-admin-only and serves the push fan-out workflow).
  var historyHTML =
    '<div data-shot-section="sightings" data-shot-label="Firewall Sightings">' +
    '<div class="section-block" style="margin-bottom:1rem">' +
      '<div class="section-label" style="margin-bottom:0.25rem">Firewall Sightings</div>' +
      _sightingsTableHTML(sightings) +
    '</div>' +
    '</div>' +
    '<div data-shot-section="ipHistory" data-shot-label="IP History">' +
    '<div class="section-block" style="margin-bottom:1rem">' +
      '<div class="section-label" style="margin-bottom:0.25rem">IP History</div>' +
      _ipHistoryTableHTML(ipHistory) +
    '</div>' +
    '</div>';

  // Split is admin-only and only meaningful when there's more than one
  // source on the asset (the backend rejects splitting the only source).
  // Manual sources can never be split (backend also rejects those).
  var canSplit = isAdmin() && sources.length > 1;
  var sourceCards = sources.map(function (s) {
    var label = _assetSourceLabels[s.sourceKind] || s.sourceKind;
    var badges = [];
    if (s.inferred) {
      badges.push('<span class="badge badge-maintenance" title="Synthesized by phase-1 backfill from a legacy `ad-guid:` tag breadcrumb. The next real discovery from this source replaces the row with truth.">Inferred</span>');
    }
    if (s.integration) {
      badges.push('<span class="badge badge-active" title="' + escapeHtml(s.integration.type) + '">' + escapeHtml(s.integration.name) + '</span>');
    }
    var splitButton = "";
    if (canSplit && s.sourceKind !== "manual") {
      splitButton = '<button class="btn btn-sm btn-secondary" onclick="splitAssetSource(\'' + assetId + '\', \'' + s.id + '\', \'' + escapeHtml(label).replace(/'/g, "&#39;") + '\')" title="Detach this source onto a new asset (recovery action for bad merges)">Split</button>';
    }
    var headerRight = (badges.length || splitButton)
      ? '<div style="display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center">' + badges.join("") + splitButton + '</div>'
      : '';

    var meta = [];
    if (s.syncedAt) meta.push("Synced " + escapeHtml(formatDate(s.syncedAt)));
    if (s.firstSeen) meta.push("First seen " + escapeHtml(formatDate(s.firstSeen)));
    if (s.lastSeen)  meta.push("Last seen " + escapeHtml(formatDate(s.lastSeen)));
    if (s.externalId) meta.push("External ID <code class=\"mono\" style=\"font-size:0.78rem\">" + escapeHtml(s.externalId) + "</code>");

    var observed = (s.observed && typeof s.observed === "object") ? s.observed : {};
    var rows = Object.keys(observed)
      .filter(function (k) { return !_assetSourceHiddenObservedKeys[k]; })
      .map(function (k) {
        return '<tr>' +
          '<th style="text-align:left;padding:0.25rem 0.6rem 0.25rem 0;color:var(--color-text-secondary);font-weight:500;vertical-align:top;word-break:break-word">' + escapeHtml(_humanizeSourceObservedKey(k)) + '</th>' +
          '<td style="padding:0.25rem 0;vertical-align:top;word-break:break-word">' + _formatSourceObservedValue(observed[k]) + '</td>' +
        '</tr>';
      }).join("");
    // table-layout:fixed + an explicit colgroup makes the label column the
    // same width on every card, so values align vertically across sources
    // even when the longest label in each source differs.
    var observedTable = rows
      ? '<table style="width:100%;font-size:0.85rem;border-collapse:collapse;table-layout:fixed">' +
          '<colgroup><col style="width:220px"><col></colgroup>' +
          rows +
        '</table>'
      : '<em style="color:var(--color-text-secondary)">No observed fields recorded.</em>';

    return (
      '<div class="section-block" style="margin-bottom:1rem">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:0.6rem;margin-bottom:0.25rem">' +
          '<div class="section-label" style="margin:0">' + escapeHtml(label) + '</div>' +
          headerRight +
        '</div>' +
        (meta.length ? '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:0.5rem">' + meta.join(" · ") + '</div>' : '') +
        observedTable +
      '</div>'
    );
  }).join("");
  return '<div data-shot-section="sources" data-shot-label="Discovery Sources">' + mergeToolbar + sourceCards + '</div>' + historyHTML;
}

// ─── Quarantine tab ─────────────────────────────────────────────────────────

function _assetQuarantineTabHTML(a) {
  var isQ = a.status === "quarantined";
  var macs = [];
  if (Array.isArray(a.macAddresses)) {
    macs = a.macAddresses.map(function (m) { return typeof m === "object" ? (m.mac || "") : m; }).filter(Boolean);
  } else if (a.macAddress) {
    macs = [a.macAddress];
  }

  var statusSection = '';
  if (isQ) {
    var targets = Array.isArray(a.quarantineTargets) ? a.quarantineTargets : [];
    var targetsHtml = targets.length
      ? '<table class="data-table" style="font-size:0.82rem;margin-top:0.5rem"><thead><tr><th>FortiGate</th><th>Status</th><th>Pushed MACs</th><th>Pushed At</th></tr></thead><tbody>' +
          targets.map(function (t) {
            var statusCls = t.status === "synced" ? "badge-active" : t.status === "drift" ? "badge-maintenance" : "badge-disabled";
            return '<tr>' +
              '<td>' + escapeHtml(t.fortigateDevice || "?") + '</td>' +
              '<td><span class="badge ' + statusCls + '">' + escapeHtml(t.status || "?") + '</span></td>' +
              '<td class="mono" style="font-size:0.78rem">' + escapeHtml((t.pushedMacs || []).join(", ") || "—") + '</td>' +
              '<td>' + (t.pushedAt ? formatDate(t.pushedAt) : "—") + '</td>' +
            '</tr>';
          }).join("") +
        '</tbody></table>'
      : '<p class="empty-state" style="margin:0.5rem 0 0">No push targets recorded.</p>';

    statusSection =
      '<div data-shot-section="qStatus" data-shot-label="Quarantine Status">' +
      '<div class="section-block" style="margin-bottom:1rem">' +
        '<div class="section-label" style="margin-bottom:0.25rem">Quarantine Status</div>' +
        (a.quarantineReason ? '<p style="margin:0 0 0.5rem;color:var(--color-text-secondary)">Reason: ' + escapeHtml(a.quarantineReason) + '</p>' : '') +
        (a.quarantinedAt ? '<p style="margin:0 0 0.5rem;font-size:0.82rem;color:var(--color-text-secondary)">Quarantined ' + formatDate(a.quarantinedAt) + (a.quarantinedBy ? ' by ' + escapeHtml(a.quarantinedBy) : '') + '</p>' : '') +
        '<div class="section-label" style="margin:0.75rem 0 0.25rem">FortiGate Push Targets</div>' +
        targetsHtml +
      '</div>' +
      '</div>';
  }

  var macsHtml = macs.length
    ? '<div class="mono" style="font-size:0.82rem">' + escapeHtml(macs.join(", ")) + '</div>'
    : '<em style="color:var(--color-text-secondary)">No MACs on record — quarantine push requires at least one MAC.</em>';

  var sightingsSection =
    '<div data-shot-section="qSightings" data-shot-label="DHCP Sightings">' +
    '<div class="section-block" style="margin-bottom:1rem">' +
      '<div class="section-label" style="margin-bottom:0.25rem">DHCP Sightings</div>' +
      '<div id="asset-sightings-container"><em style="color:var(--color-text-secondary)">Loading…</em></div>' +
    '</div>' +
    '</div>';

  var isInfra = a.assetType === "firewall" || a.assetType === "switch" || a.assetType === "access_point";
  var actionBtn = isQ
    ? '<button class="btn btn-secondary" id="btn-qtn-release">Release Quarantine</button>'
    : (macs.length && !isInfra ? '<button class="btn btn-danger" id="btn-qtn-quarantine">Quarantine This Asset</button>' : '');
  var verifyBtn = isQ ? '<button class="btn btn-secondary" id="btn-qtn-verify">Verify Push</button>' : '';

  return '<div style="padding:0.5rem 0">' +
    statusSection +
    '<div data-shot-section="qMacs" data-shot-label="Associated MACs">' +
    '<div class="section-block" style="margin-bottom:1rem">' +
      '<div class="section-label" style="margin-bottom:0.25rem">Associated MACs</div>' +
      macsHtml +
    '</div>' +
    '</div>' +
    sightingsSection +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' + actionBtn + verifyBtn + '</div>' +
  '</div>';
}

function _wireQuarantineTab(a) {
  var tabPanel = document.getElementById("asset-view-tab-quarantine");
  if (!tabPanel) return;

  // Load sightings async when the tab is visible.
  function _loadSightings() {
    var container = document.getElementById("asset-sightings-container");
    if (!container) return;
    api.assets.getSightings(a.id).then(function (data) {
      var rows = Array.isArray(data) ? data : (data.sightings || []);
      container.innerHTML = _sightingsTableHTML(rows);
    }).catch(function () {
      var container2 = document.getElementById("asset-sightings-container");
      if (container2) container2.innerHTML = '<p class="empty-state" style="color:var(--color-danger,#c0392b)">Failed to load sightings.</p>';
    });
  }

  // Load sightings immediately if the quarantine tab is active, otherwise on click.
  var tabBtn = document.querySelector('#asset-view-tabs [data-tab="quarantine"]');
  if (tabBtn) {
    if (tabBtn.classList.contains("active")) {
      _loadSightings();
    } else {
      tabBtn.addEventListener("click", function handler() {
        tabBtn.removeEventListener("click", handler);
        _loadSightings();
      });
    }
  }

  var quarantineBtn = tabPanel.querySelector("#btn-qtn-quarantine");
  if (quarantineBtn) {
    quarantineBtn.addEventListener("click", async function () {
      var reason = window.prompt("Reason for quarantine (optional):");
      if (reason === null) return;
      quarantineBtn.disabled = true;
      try {
        var result = await api.assets.quarantine(a.id, reason || undefined);
        showToast(result.message || "Asset quarantined");
        closeAssetPanel();
        loadAssets();
      } catch (err) {
        showToast(err.message || "Quarantine failed", "error");
        quarantineBtn.disabled = false;
      }
    });
  }

  var releaseBtn = tabPanel.querySelector("#btn-qtn-release");
  if (releaseBtn) {
    releaseBtn.addEventListener("click", async function () {
      var ok = await showConfirm("Release quarantine on this asset?");
      if (!ok) return;
      releaseBtn.disabled = true;
      try {
        var result = await api.assets.unquarantine(a.id);
        showToast(result.message || "Quarantine released");
        closeAssetPanel();
        loadAssets();
      } catch (err) {
        showToast(err.message || "Release failed", "error");
        releaseBtn.disabled = false;
      }
    });
  }

  var verifyBtn = tabPanel.querySelector("#btn-qtn-verify");
  if (verifyBtn) {
    verifyBtn.addEventListener("click", async function () {
      verifyBtn.disabled = true;
      verifyBtn.textContent = "Verifying…";
      try {
        var result = await api.assets.verifyQuarantine(a.id);
        if (result.driftDetected) {
          showToast("Drift detected — one or more targets were out of sync. Updated.", "warning");
        } else {
          showToast("All quarantine targets verified OK", "success");
        }
        openViewModal(a.id);
      } catch (err) {
        showToast(err.message || "Verify failed", "error");
      } finally {
        verifyBtn.disabled = false;
        verifyBtn.textContent = "Verify Push";
      }
    });
  }
}

// ─── Monitoring (bulk + credential picker helpers) ─────────────────────────

var _credentialCache = { loaded: false, list: [] };

async function _ensureCredentials(force) {
  if (_credentialCache.loaded && !force) return _credentialCache.list;
  try {
    _credentialCache.list = await api.credentials.list();
    _credentialCache.loaded = true;
  } catch (_) {
    _credentialCache.list = [];
  }
  return _credentialCache.list;
}

function _credentialOptionsFor(type, selectedId) {
  var opts = '<option value="">— select credential —</option>';
  _credentialCache.list
    .filter(function (c) { return c.type === type; })
    .forEach(function (c) {
      opts += '<option value="' + escapeHtml(c.id) + '"' + (selectedId === c.id ? " selected" : "") + '>' + escapeHtml(c.name) + '</option>';
    });
  return opts;
}

// All credential types in one picker, with the type tagged on each label so
// the operator can pick the credential that matches their chosen polling
// method. Used by the asset edit modal's Monitoring tab — picking a SNMP
// credential alongside polling=winrm is silently ignored at probe time, but
// that's the operator's call to make.
function _credentialOptionsForAny(selectedId) {
  var opts = '<option value="">— none —</option>';
  _credentialCache.list.forEach(function (c) {
    var typeLabel = (c.type || "").toUpperCase();
    opts += '<option value="' + escapeHtml(c.id) + '"' +
      (selectedId === c.id ? " selected" : "") + '>' +
      escapeHtml(c.name) + ' · ' + escapeHtml(typeLabel) +
      '</option>';
  });
  return opts;
}

// ─── Monitoring Settings Modal ──────────────────────────────────────────────
// Opened from the "Monitoring Settings" button in the Assets page header.
// Two sections, both admin/assetsadmin only:
//
//   1. Manual Monitoring tier — settings for orphan / manually-created assets.
//      One form with the eight tier-3 fields. Save via
//      PUT /api/v1/monitor-settings/manual.
//
//   2. Class Overrides — list of (assetType + asset source) override rows.
//      Add / Edit / Delete. The integration tier (per-integration settings)
//      lives on the Integrations page and is edited from each integration's
//      Monitoring tab — it's intentionally NOT in this modal.
//
// All resolver caches invalidate server-side on every write.

var MON_TIER_DEFAULTS = {
  intervalSeconds:           60,
  failureThreshold:          3,
  probeTimeoutMs:            5000,
  cpuMemoryTimeoutMs:        10000,
  temperatureTimeoutMs:      10000,
  systemInfoTimeoutMs:       10000,
  cpuMemoryIntervalSeconds:  60,
  temperatureIntervalSeconds: 60,
  systemInfoIntervalSeconds: 600,
};

// Polling-method helpers (_POLLING_LABELS / _POLLING_COMPAT /
// _polarisPollingFourStreamHTML / _polarisReadPollingFourStream) are
// defined in integrations.js (loaded before this file on both
// integrations.html and assets.html), exposed globally on `window`.

var _monsetIntegrations  = [];   // for the source picker on add/edit
var _monsetOverrides     = [];   // class override rows currently rendered
var _monsetManualValues  = null; // last-fetched manual-tier settings (or null = not yet seeded)

async function openMonitoringSettingsModal() {
  // Loading shell first so the operator sees instant feedback. Replaced by
  // _monsetRender() below once the three parallel fetches resolve.
  openModal(
    "Monitoring Settings",
    '<div class="empty-state" style="padding:2rem 0">Loading…</div>',
    '<button class="btn btn-secondary" onclick="closeModal()">Close</button>',
    { wide: true }
  );
  try {
    var results = await Promise.all([
      api.monitorSettings.getManual().catch(function () { return null; }),
      api.monitorSettings.listClassOverrides({}).catch(function () { return []; }),
      api.integrations.list().catch(function () { return []; }),
      _ensureCredentials(),
    ]);
    _monsetManualValues = results[0] || Object.assign({}, MON_TIER_DEFAULTS);
    _monsetOverrides    = Array.isArray(results[1]) ? results[1] : [];
    var intgResp        = results[2];
    _monsetIntegrations = (intgResp && (intgResp.integrations || intgResp)) || [];
  } catch (err) {
    showToast(err.message || "Failed to load monitoring settings", "error");
    return;
  }
  _monsetRender();
}

function _monsetRender() {
  var manualBody    = _monsetManualSectionHTML(_monsetManualValues);
  var overridesBody = _monsetOverridesSectionHTML(_monsetOverrides);
  var body = manualBody +
    '<hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--color-border)">' +
    overridesBody;
  openModal(
    "Monitoring Settings",
    body,
    '<button class="btn btn-secondary" onclick="closeModal()">Close</button>',
    { wide: true }
  );

  // Wire the Manual Monitoring stream-subtab tab strip so clicking a stream
  // tab activates its panel. Same shared helper the integration Monitoring
  // tab uses. Safe to call before the listeners below — they don't depend
  // on tab state.
  if (typeof _intWireModalTabs === "function") {
    _intWireModalTabs("monset-manual-streams");
  }
  // Reactive per-stream credential rows: each stream's polling-method
  // dropdown reveals the matching snmp/ssh/winrm credential row. Helper
  // lives in integrations.js (loaded before assets.js on assets.html).
  if (typeof _wireStreamCredentialPickerVisibility === "function") {
    _wireStreamCredentialPickerVisibility(document);
  }
  document.getElementById("btn-monset-save-manual").addEventListener("click", _monsetSaveManual);
  document.getElementById("btn-monset-add-override").addEventListener("click", function () {
    _monsetOpenOverrideEditor(null);
  });
  // Per-row edit/delete buttons. Reattach each render since the table HTML
  // is rebuilt above.
  var tbody = document.getElementById("monset-overrides-tbody");
  if (tbody) {
    tbody.querySelectorAll("[data-edit-override]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id  = btn.getAttribute("data-edit-override");
        var row = _monsetOverrides.find(function (o) { return o.id === id; });
        if (row) _monsetOpenOverrideEditor(row);
      });
    });
    tbody.querySelectorAll("[data-delete-override]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id  = btn.getAttribute("data-delete-override");
        var row = _monsetOverrides.find(function (o) { return o.id === id; });
        var label = row
          ? ((ASSET_TYPE_LABELS[row.assetType] || row.assetType) + " @ " + (row.integration ? row.integration.name : "Manual"))
          : "this override";
        var ok = await showConfirm("Delete class override for " + label + "?");
        if (!ok) return;
        try {
          await api.monitorSettings.deleteClassOverride(id);
          _monsetOverrides = _monsetOverrides.filter(function (o) { return o.id !== id; });
          _monsetRender();
          showToast("Override deleted");
        } catch (err) {
          showToast(err.message || "Failed to delete override", "error");
        }
      });
    });
  }
}

function _monsetManualSectionHTML(v) {
  var values = v || MON_TIER_DEFAULTS;
  // Manual Monitoring is the bottom of the resolver hierarchy — there's
  // nothing to inherit from. Stamp sensible per-stream polling defaults
  // when the loaded tier doesn't already carry an explicit value:
  // Response Time → ICMP, every other stream → Disabled. Operators flip
  // streams on per-asset as needed. Explicit operator picks on a saved
  // Manual tier survive — we only fill nulls.
  var seeded = Object.assign({}, values);
  if (seeded.responseTimePolling == null) seeded.responseTimePolling = "icmp";
  if (seeded.cpuMemoryPolling    == null) seeded.cpuMemoryPolling    = "disabled";
  if (seeded.temperaturePolling  == null) seeded.temperaturePolling  = "disabled";
  if (seeded.interfacesPolling   == null) seeded.interfacesPolling   = "disabled";
  if (seeded.lldpPolling         == null) seeded.lldpPolling         = "disabled";
  if (seeded.storagePolling      == null) seeded.storagePolling      = "disabled";
  // Manual tier uses the same per-stream subtab layout the integration
  // Monitoring tab uses — Response Time / CPU+Memory / Temperature /
  // Interfaces / LLDP / Storage. No outer class strip (Manual has no per-
  // class breakdown). DOM id prefix `f-manual-mon-` namespaces every input
  // so it doesn't collide with the integration modal's `f-mon-` ids.
  // showInherit:false suppresses the misleading "Inherit" option in every
  // polling dropdown (Manual is the bottom of the resolver). showMib:false
  // drops the per-stream MIB picker here — Manual tier doesn't expose it
  // for this iteration; MIBs are picked at the asset tier instead.
  // _classStreamSubtabHTML, _streamsForClass, _intRenderTabbedBody, and
  // _intWireModalTabs are global function declarations in integrations.js
  // (loaded before this file on assets.html), so they're directly callable.
  var creds = (typeof _credentialCache !== "undefined" && _credentialCache && Array.isArray(_credentialCache.list))
    ? _credentialCache.list
    : [];
  var streams = (typeof _streamsForClass === "function") ? _streamsForClass("manual") : [];
  var streamTabs = streams.map(function (stream) {
    return {
      key:   stream.key,
      label: stream.label,
      html:  _classStreamSubtabHTML("f-manual-mon-", "manual", "manual", stream, seeded, creds, false, {
        showInherit: false,
        showMib:     false,
      }),
    };
  });
  return '<div class="monset-section">' +
    '<h3 style="margin-bottom:0.25rem">Manual Monitoring</h3>' +
    '<p class="hint" style="margin:0 0 1rem 0;color:var(--color-text-tertiary)">Settings applied to assets without an integration source — manually-created assets, or assets whose origin integration was deleted.</p>' +
    _intRenderTabbedBody("monset-manual-streams", streamTabs) +
    '<p class="hint" style="margin:0.5rem 0 0.5rem 0;color:var(--color-text-tertiary)">Manual tier accepts any method — operator picks per stream and supplies a credential at the asset level (or relies on ICMP).</p>' +
    '<p class="hint" style="margin:0 0 0.75rem 0;font-size:0.78rem">Sample retention is a global setting. Edit it in <a href="/server-settings.html?tab=retention">Server Settings → Retention</a>.</p>' +
    '<div style="margin-top:1rem;text-align:right">' +
      '<button class="btn btn-primary" id="btn-monset-save-manual">Save Manual Tier</button>' +
    '</div>' +
  '</div>';
}

// Renders one numeric input with label + range hint. `warnUnder500` adds a
// soft warning indicator when the current value is below 500ms — used for
// probeTimeoutMs per the spec.
function _monsetField(id, label, unit, value, min, max, warnUnder500) {
  var v = (value === null || value === undefined) ? "" : value;
  var warn = warnUnder500 && Number(v) > 0 && Number(v) < 500;
  var warnIcon = warn ? ' <span title="Probes will likely false-fail under healthy network conditions at this timeout" style="color:var(--color-warning);font-weight:700">⚠</span>' : "";
  return '<div class="form-group">' +
    '<label for="' + id + '">' + escapeHtml(label) + warnIcon + '</label>' +
    '<input type="number" id="' + id + '" min="' + min + '" max="' + max + '" value="' + escapeHtml(String(v)) + '">' +
    (unit ? '<div style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:2px">' + escapeHtml(unit) + '</div>' : '') +
  '</div>';
}

function _monsetReadField(id, fallback) {
  var el = document.getElementById(id);
  if (!el || el.value === "") return fallback;
  var n = parseInt(el.value, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function _monsetSaveManual() {
  var btn = document.getElementById("btn-monset-save-manual");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Saving…";
  // Stream-subtab layout uses id prefix `f-manual-mon-` for numeric inputs
  // (cadences + timeouts + failure threshold) and `f-manual-mon-tier-` for
  // polling-method + MIB selects, mirroring the integration Monitoring tab's
  // _classStreamSubtabHTML(isPrimary=false) shape.
  var body = {
    intervalSeconds:           _monsetReadField("f-manual-mon-intervalSeconds",           MON_TIER_DEFAULTS.intervalSeconds),
    failureThreshold:          _monsetReadField("f-manual-mon-failureThreshold",          MON_TIER_DEFAULTS.failureThreshold),
    probeTimeoutMs:            _monsetReadField("f-manual-mon-probeTimeoutMs",            MON_TIER_DEFAULTS.probeTimeoutMs),
    cpuMemoryTimeoutMs:        _monsetReadField("f-manual-mon-cpuMemoryTimeoutMs",        MON_TIER_DEFAULTS.cpuMemoryTimeoutMs),
    temperatureTimeoutMs:      _monsetReadField("f-manual-mon-temperatureTimeoutMs",      MON_TIER_DEFAULTS.temperatureTimeoutMs),
    systemInfoTimeoutMs:       _monsetReadField("f-manual-mon-systemInfoTimeoutMs",       MON_TIER_DEFAULTS.systemInfoTimeoutMs),
    cpuMemoryIntervalSeconds:  _monsetReadField("f-manual-mon-cpuMemoryIntervalSeconds",  MON_TIER_DEFAULTS.cpuMemoryIntervalSeconds),
    temperatureIntervalSeconds: _monsetReadField("f-manual-mon-temperatureIntervalSeconds", MON_TIER_DEFAULTS.temperatureIntervalSeconds),
    systemInfoIntervalSeconds: _monsetReadField("f-manual-mon-systemInfoIntervalSeconds", MON_TIER_DEFAULTS.systemInfoIntervalSeconds),
    // Phase 1 LLDP + Storage cadences. Persisted but inert today — see the
    // matching comment in integrations.js _readIntegrationCadenceForm.
    lldpIntervalSeconds:       _monsetReadField("f-manual-mon-lldpIntervalSeconds",       null),
    lldpTimeoutMs:             _monsetReadField("f-manual-mon-lldpTimeoutMs",             null),
    storageIntervalSeconds:    _monsetReadField("f-manual-mon-storageIntervalSeconds",    null),
    storageTimeoutMs:          _monsetReadField("f-manual-mon-storageTimeoutMs",          null),
  };
  Object.assign(body, _polarisReadPollingFourStream("f-manual-mon-tier-"));
  try {
    var saved = await api.monitorSettings.setManual(body);
    _monsetManualValues = saved || body;
    showToast("Manual monitoring settings saved");
  } catch (err) {
    showToast(err.message || "Failed to save manual settings", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Manual Tier";
  }
}

function _monsetOverridesSectionHTML(rows) {
  // Phase 2 (post-migration): Class Overrides surface is manual-scope-only.
  // Per-class settings for integration-discovered assets are configured on
  // each integration's Monitoring tab via the per-class streams blocks.
  // The Phase 2 migration job folded any historical integration-scoped
  // rows into the integration streams blocks and deleted them, so the
  // integrationId !== null filter here is defense-in-depth — the GET/POST
  // endpoints now reject integration-scoped writes outright (400).
  var manualRows = (rows || []).filter(function (o) { return !o.integrationId; });
  var rowHTML = manualRows.length === 0
    ? '<tr><td colspan="2" class="empty-state" style="text-align:center;padding:1rem">No manual-scope class overrides configured.</td></tr>'
    : manualRows.map(function (o) {
        var classLabel = ASSET_TYPE_LABELS[o.assetType] || o.assetType;
        return '<tr>' +
          '<td>' + escapeHtml(classLabel) + '</td>' +
          '<td class="actions" style="white-space:nowrap">' +
            '<button class="btn btn-sm btn-secondary" data-edit-override="' + escapeHtml(o.id) + '">Edit</button> ' +
            '<button class="btn btn-sm btn-danger"    data-delete-override="' + escapeHtml(o.id) + '">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join("");
  return '<div class="monset-section">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.25rem">' +
      '<h3 style="margin:0">Class Overrides</h3>' +
      '<button class="btn btn-primary" id="btn-monset-add-override">+ Add Override</button>' +
    '</div>' +
    '<div style="margin:0.25rem 0 0.5rem 0;padding:0.5rem 0.75rem;background:var(--color-bg-tertiary);border:1px solid var(--color-border);border-radius:var(--radius-sm);color:var(--color-text-secondary);font-size:0.85rem">' +
      '<strong>Manual scope only — assets without an integration source.</strong>' +
    '</div>' +
    '<p class="hint" style="margin:0 0 0.5rem 0;color:var(--color-text-tertiary)">Per-class settings for integration-discovered assets are configured on each integration\'s Monitoring tab. Use this section for manually-added assets organized by asset type.</p>' +
    '<table class="data-table" style="width:100%;border-collapse:collapse">' +
      '<thead><tr>' +
        '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border)">Class</th>' +
        '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border)">Actions</th>' +
      '</tr></thead>' +
      '<tbody id="monset-overrides-tbody">' + rowHTML + '</tbody>' +
    '</table>' +
  '</div>';
}

function _monsetOverrideSummary(o) {
  var parts  = [];
  var labels = {
    intervalSeconds:           "probe",
    failureThreshold:          "threshold",
    probeTimeoutMs:            "probe-timeout",
    cpuMemoryTimeoutMs:        "cpu-mem-timeout",
    temperatureTimeoutMs:      "temp-timeout",
    systemInfoTimeoutMs:       "sysinfo-timeout",
    cpuMemoryIntervalSeconds:  "cpu-mem",
    temperatureIntervalSeconds: "temp",
    systemInfoIntervalSeconds: "sysinfo",
    responseTimePolling:       "rt-poll",
    cpuMemoryPolling:          "cpu-mem-poll",
    temperaturePolling:        "temp-poll",
    interfacesPolling:         "if-poll",
    lldpPolling:               "lldp-poll",
    storagePolling:            "storage-poll",
  };
  Object.keys(labels).forEach(function (k) {
    if (o[k] !== null && o[k] !== undefined) parts.push(labels[k] + "=" + o[k]);
  });
  return parts.length === 0 ? "(empty — all fields inherited)" : parts.join(", ");
}

// Warning banner shown inside the class-override editor when the operator picks
// (class=switch|access_point) + (source=FMG/FortiGate integration whose
// per-class `enabled` flag — fortiswitchMonitor.enabled / fortiapMonitor.enabled
// — is false). In that state discovery never stamps `Asset.monitorCredentialId`
// on the managed switch/AP rows, so a class override with no per-stream
// credential set will fall through to the integration's top-level
// `monitorCredentialId` (the FortiGate's SNMP credential) — usually wrong for
// FortiLink-side switches/APs. Returns empty string when the warning doesn't apply.
function _monsetDirectPollWarningHTML(integrationId, assetType) {
  if (assetType !== "switch" && assetType !== "access_point") return "";
  if (!integrationId || integrationId === "null") return "";
  var intg = _monsetIntegrations.find(function (i) { return i.id === integrationId; });
  if (!intg) return "";
  if (intg.type !== "fortimanager" && intg.type !== "fortigate") return "";
  var cfg = intg.config || {};
  var blockKey = assetType === "switch" ? "fortiswitchMonitor" : "fortiapMonitor";
  var block = cfg[blockKey] || {};
  if (block.enabled === true) return "";
  var classLabel = assetType === "switch" ? "FortiSwitches" : "FortiAPs";
  return '<div id="monset-ov-direct-poll-warning-inner" style="margin:0.25rem 0 0.75rem 0;padding:0.5rem 0.75rem;background:rgba(245,158,11,0.08);border:1px solid var(--color-warning);border-radius:4px;color:var(--color-warning);font-size:0.82rem">' +
    '&#9888; <strong>Direct Polling is off</strong> for ' + escapeHtml(classLabel) + ' on this integration. ' +
    'Discovery won\'t stamp an SNMP credential on the asset row, so a class override without an explicit per-stream credential will fall through to the FortiGate\'s SNMP credential (usually wrong for FortiLink-side ' + escapeHtml(classLabel.toLowerCase()) + '). ' +
    'Either set the per-stream credentials below, or enable Direct Polling under the integration\'s ' + escapeHtml(classLabel) + ' subtab.' +
  '</div>';
}

function _monsetOpenOverrideEditor(existing) {
  var isEdit = !!existing;
  var classOpts = Object.keys(ASSET_TYPE_LABELS).map(function (key) {
    var sel = (existing && existing.assetType === key) ? " selected" : "";
    return '<option value="' + escapeHtml(key) + '"' + sel + '>' + escapeHtml(ASSET_TYPE_LABELS[key]) + '</option>';
  }).join("");
  var v = existing || Object.assign({}, MON_TIER_DEFAULTS);
  // Phase 1 Class Overrides is manual-scope only — the source picker is now
  // a static banner. Editing legacy integration-scoped rows would not work
  // here either; the filter in _monsetOverridesSectionHTML hides them from
  // the list, but defense-in-depth: if an operator somehow opens an
  // integration-scoped row via the edit pathway we still render the editor
  // (preserves manual editability of the cadence/timeout fields) — the
  // save handler still posts to the same row id.
  //
  // Stream-subtab layout — Response Time / CPU+Memory / Temperature /
  // Interfaces / LLDP / Storage — matches the canonical design in
  // TEMPLATES.md ("Polling methods section"). Reuses `_classStreamSubtabHTML`
  // with `isPrimary=false` + prefix `monset-ov-` so generated input ids
  // follow the same convention Manual Monitoring uses (polling/MIB selects
  // at `monset-ov-tier-<pollField>` / `monset-ov-tier-<streamKey>Mib`;
  // numeric inputs at `monset-ov-<field>`). showInherit:true — class
  // overrides legitimately defer to the integration / manual tier below.
  // showMib:true — per-stream MIB pickers are meaningful at this tier.
  var initialSourceKind = "manual";
  var creds = (_credentialCache && _credentialCache.list) ? _credentialCache.list : [];
  var streams = (typeof _streamsForClass === "function") ? _streamsForClass("manual") : [];
  var streamTabs = streams.map(function (stream) {
    return {
      key:   stream.key,
      label: stream.label,
      html:  _classStreamSubtabHTML("monset-ov-", initialSourceKind, "manual", stream, v, creds, false, {
        showInherit: true,
        showMib:     true,
      }),
    };
  });
  var body =
    '<div class="form-group"><label for="monset-ov-class">Class</label>' +
      '<select id="monset-ov-class"' + (isEdit ? " disabled" : "") + '>' + classOpts + '</select>' +
    '</div>' +
    '<div style="margin:0.25rem 0 0.75rem 0;padding:0.5rem 0.75rem;background:var(--color-bg-tertiary);border:1px solid var(--color-border);border-radius:var(--radius-sm);color:var(--color-text-secondary);font-size:0.85rem">' +
      '<strong>Manual scope only — assets without an integration source.</strong>' +
    '</div>' +
    (isEdit ? '<p class="hint" style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.25rem 0 0.75rem 0">Class is fixed for an existing override; delete and re-create to change it.</p>' : '') +
    '<div id="monset-ov-direct-poll-warning"></div>' +
    '<p class="hint" style="margin:0.5rem 0 0.75rem 0;color:var(--color-text-tertiary)">Leave a field blank to inherit from the source\'s tier.</p>' +
    _intRenderTabbedBody("monset-ov-streams", streamTabs) +
    '<p class="hint" style="margin:0.5rem 0 0 0;font-size:0.78rem">Sample retention is a global setting. Edit it in <a href="/server-settings.html?tab=retention">Server Settings → Retention</a>.</p>';
  var footer = '<button class="btn btn-secondary" id="btn-monset-ov-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-monset-ov-save">' + (isEdit ? "Save Changes" : "Create Override") + '</button>';
  openModal(isEdit ? "Edit Class Override" : "Add Class Override", body, footer);
  _populateUploadedMibsInDropdowns();
  if (typeof _intWireModalTabs === "function") _intWireModalTabs("monset-ov-streams");
  document.getElementById("btn-monset-ov-cancel").addEventListener("click", _monsetRender);
  document.getElementById("btn-monset-ov-save").addEventListener("click", function () {
    _monsetSaveOverride(existing);
  });

  // Wire per-stream polling dropdowns to show/hide the credential + MIB
  // sub-rows rendered by _classStreamSubtabHTML. Sub-row visibility rules:
  //   - credential row for a credtype shows when the picked method needs that
  //     credtype (snmp → snmp credrow, ssh → ssh credrow, winrm → winrm
  //     credrow; rest_api / icmp / disabled → no credrow)
  //   - MIB row shows when picked method is snmp
  var STREAMS_FULL = ["responseTime", "cpuMemory", "temperature", "interfaces", "lldp", "storage"];
  function _credtypeForMethod(method) {
    if (method === "snmp")  return "snmp";
    if (method === "ssh")   return "ssh";
    if (method === "winrm") return "winrm";
    return null;
  }
  function _ovPollFieldFor(streamKey) {
    return streamKey === "cpuMemory" ? "cpuMemoryPolling"
      : streamKey === "responseTime" ? "responseTimePolling"
      : streamKey + "Polling";
  }
  function _ovMibStreamKeyFor(streamKey) {
    // Mirror _ALL_STREAMS in integrations.js: cpuMemory uses telemetry MIB.
    if (streamKey === "cpuMemory") return "telemetry";
    return streamKey;
  }
  function _refreshOvStreamSubRows() {
    STREAMS_FULL.forEach(function (streamKey) {
      var pollId = "monset-ov-tier-" + _ovPollFieldFor(streamKey);
      var pollEl = document.getElementById(pollId);
      var method = pollEl ? pollEl.value : "";
      // Per-credtype rows are siblings: <pollId>-credrow-<credtype>
      ["snmp", "ssh", "winrm"].forEach(function (credType) {
        var row = document.getElementById(pollId + "-credrow-" + credType);
        if (!row) return;
        row.style.display = (_credtypeForMethod(method) === credType) ? "" : "none";
      });
      // MIB row id from _classStreamSubtabHTML: <prefix>tier-<mibStreamKey>-mib-wrap
      var mibStreamKey = _ovMibStreamKeyFor(streamKey);
      var mibWrap = document.getElementById("monset-ov-tier-" + mibStreamKey + "-mib-wrap");
      if (mibWrap) mibWrap.style.display = (method === "snmp") ? "" : "none";
    });
  }
  _refreshOvStreamSubRows();
  STREAMS_FULL.forEach(function (streamKey) {
    var pollEl = document.getElementById("monset-ov-tier-" + _ovPollFieldFor(streamKey));
    if (pollEl) pollEl.addEventListener("change", _refreshOvStreamSubRows);
  });

  // Pre-select per-stream credentials from the loaded override. _classStreamSubtabHTML
  // doesn't pre-select credentials because the integration modal's per-credtype
  // credential pickers are placeholders today; the class override row carries
  // real per-stream credential ids that we want reflected in the UI.
  var _OV_CRED_FIELDS = {
    responseTime: "responseTimeCredentialId",
    cpuMemory:    "cpuMemoryCredentialId",
    temperature:  "temperatureCredentialId",
    interfaces:   "interfacesCredentialId",
    lldp:         "lldpCredentialId",
  };
  Object.keys(_OV_CRED_FIELDS).forEach(function (streamKey) {
    var credId = v[_OV_CRED_FIELDS[streamKey]];
    if (!credId) return;
    var method = (v[_ovPollFieldFor(streamKey)] || "").toString();
    var credType = (method === "snmp") ? "snmp" : (method === "ssh") ? "ssh" : (method === "winrm") ? "winrm" : null;
    if (!credType) return;
    var sel = document.getElementById("monset-ov-tier-" + _ovPollFieldFor(streamKey) + "-cred-" + credType);
    if (sel) sel.value = credId;
  });

  // Class Overrides is manual-scope only now — there is no source picker to
  // wire, and the direct-poll warning (which only applies to FMG/FortiGate
  // integration-scoped switch/AP overrides) no longer fires from this surface.
  // The wrap div is left in place to avoid disturbing the surrounding DOM
  // layout; it stays empty in Phase 1 and is removed entirely when Phase 2
  // lands the backend narrowing.
}

async function _monsetSaveOverride(existing) {
  var btn = document.getElementById("btn-monset-ov-save");
  if (!btn) return;
  var prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Saving…";

  // Collect optional override fields. null = inherit from below.
  function readOptional(id) {
    var el = document.getElementById(id);
    if (!el || el.value === "") return null;
    var n = parseInt(el.value, 10);
    return Number.isFinite(n) ? n : null;
  }
  // Numeric inputs live at `monset-ov-<field>` (isPrimary=false in
  // _classStreamSubtabHTML uses `idPrefix + idSuffix` directly for the
  // numeric inputs — see numInput() inside that helper).
  var fields = {
    intervalSeconds:           readOptional("monset-ov-intervalSeconds"),
    failureThreshold:          readOptional("monset-ov-failureThreshold"),
    probeTimeoutMs:            readOptional("monset-ov-probeTimeoutMs"),
    cpuMemoryTimeoutMs:        readOptional("monset-ov-cpuMemoryTimeoutMs"),
    temperatureTimeoutMs:      readOptional("monset-ov-temperatureTimeoutMs"),
    systemInfoTimeoutMs:       readOptional("monset-ov-systemInfoTimeoutMs"),
    cpuMemoryIntervalSeconds:  readOptional("monset-ov-cpuMemoryIntervalSeconds"),
    temperatureIntervalSeconds: readOptional("monset-ov-temperatureIntervalSeconds"),
    systemInfoIntervalSeconds: readOptional("monset-ov-systemInfoIntervalSeconds"),
  };
  // Polling-method + MIB selects use the `monset-ov-tier-` prefix (matches
  // the Manual Monitoring section's `f-manual-mon-tier-` convention).
  Object.assign(fields, _polarisReadPollingFourStream("monset-ov-tier-"));
  Object.assign(fields, _polarisReadMibFourStream("monset-ov-tier-"));
  // Per-stream credentials: _classStreamSubtabHTML renders one select per
  // (stream × credtype) at `<pollId>-cred-<credtype>`. Pick the credential
  // matching the stream's chosen polling method; "Inherit / none" (empty)
  // also maps to null. The backend column is per-stream
  // (responseTimeCredentialId / cpuMemoryCredentialId / ...).
  var _OV_STREAM_TO_FIELDS = {
    responseTime: { pollField: "responseTimePolling", credField: "responseTimeCredentialId" },
    cpuMemory:    { pollField: "cpuMemoryPolling",    credField: "cpuMemoryCredentialId"    },
    temperature:  { pollField: "temperaturePolling",  credField: "temperatureCredentialId"  },
    interfaces:   { pollField: "interfacesPolling",   credField: "interfacesCredentialId"   },
    lldp:         { pollField: "lldpPolling",         credField: "lldpCredentialId"         },
    // Storage stream has no dedicated per-stream credential column on
    // MonitorClassOverride — the SNMP storage walk reuses whichever
    // credential the interfaces stream resolved.
  };
  Object.keys(_OV_STREAM_TO_FIELDS).forEach(function (streamKey) {
    var f = _OV_STREAM_TO_FIELDS[streamKey];
    var pollEl = document.getElementById("monset-ov-tier-" + f.pollField);
    var method = pollEl ? pollEl.value : "";
    var credType = (method === "snmp") ? "snmp"
      : (method === "ssh") ? "ssh"
      : (method === "winrm") ? "winrm"
      : null;
    if (!credType) {
      fields[f.credField] = null;
      return;
    }
    var credEl = document.getElementById("monset-ov-tier-" + f.pollField + "-cred-" + credType);
    fields[f.credField] = credEl ? (credEl.value || null) : null;
  });
  try {
    if (existing) {
      var updated = await api.monitorSettings.updateClassOverride(existing.id, fields);
      var idx = _monsetOverrides.findIndex(function (o) { return o.id === existing.id; });
      if (idx >= 0) _monsetOverrides[idx] = updated;
      showToast("Class override updated");
    } else {
      var assetType = document.getElementById("monset-ov-class").value;
      // Phase 1 narrowing: every new override is manual-scope.
      // Per-integration overrides are configured on each integration's
      // Monitoring tab.
      var created = await api.monitorSettings.createClassOverride(
        Object.assign({ assetType: assetType, integrationId: null }, fields)
      );
      _monsetOverrides.push(created);
      showToast("Class override created");
    }
    _monsetRender();
  } catch (err) {
    showToast(err.message || "Failed to save override", "error");
    btn.disabled    = false;
    btn.textContent = prevText;
  }
}

// One-click bulk monitoring toggle. The polling method comes from the
// resolver (per-asset overrides set via PUT, class overrides, integration
// tier, source default) — this endpoint just flips `monitored` on the
// selected rows. Per-asset polling adjustments are made through the asset
// edit modal's Monitoring tab.
async function bulkSetMonitoring(monitored) {
  var ids = Array.from(_assetsSelected);
  if (!ids.length) return;
  var btn = document.getElementById("assets-bulk-monitor-btn");
  if (btn) btn.disabled = true;
  var payload = monitored
    ? { ids: ids, monitored: true,  monitorCredentialId: null }
    : { ids: ids, monitored: false };
  try {
    var result = await api.assets.bulkMonitor(payload);
    var verb = monitored ? "Enabled" : "Disabled";
    var msg = verb + " monitoring on " + result.updated + " asset" + (result.updated !== 1 ? "s" : "");
    if (result.errors && result.errors.length) {
      showToast(msg + " — " + result.errors.length + " skipped", "error");
    } else {
      showToast(msg);
    }
    _assetsSelected.clear();
    loadAssets();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}
