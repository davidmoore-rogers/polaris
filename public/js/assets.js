/**
 * public/js/assets.js — Asset management page
 */

var _assetsPageSize = 15;
var _assetsPage = 1;
var _assetsData = [];
var _assetsSF = null;
var _assetsLayout = null;
var _assetsSelected = new Set();

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

document.addEventListener("DOMContentLoaded", async function () {
  _assetsSF = new TableSF("assets-tbody", function () { _assetsPage = 1; renderAssetsPage(); _saveAssetsPrefs(); });
  var assetsTable = document.querySelector("#assets-tbody").closest("table");
  _assetsLayout = setupColumnLayout(assetsTable, {
    chooserButton: document.getElementById("btn-assets-columns"),
    onChange: _saveAssetsPrefs,
  });
  // MAC tooltips are promoted to <body>, so delegate on document so the
  // delete button works regardless of where the tooltip lives.
  document.addEventListener("click", _handleMacDeleteClick);
  document.getElementById("assets-bulk-delete-btn").addEventListener("click", bulkDeleteAssets);
  document.getElementById("assets-bulk-edit-btn").addEventListener("click", openBulkEditModal);
  var bmOn  = document.getElementById("assets-bulk-monitor-on-btn");
  var bmOff = document.getElementById("assets-bulk-monitor-off-btn");
  if (bmOn)  bmOn.addEventListener("click",  function () { bulkSetMonitoring(true); });
  if (bmOff) bmOff.addEventListener("click", function () { bulkSetMonitoring(false); });
  var bQuarantine   = document.getElementById("assets-bulk-quarantine-btn");
  var bUnquarantine = document.getElementById("assets-bulk-unquarantine-btn");
  if (bQuarantine)   bQuarantine.addEventListener("click", bulkQuarantineAssets);
  if (bUnquarantine) bUnquarantine.addEventListener("click", bulkUnquarantineAssets);
  var bDeselect = document.getElementById("assets-bulk-deselect-btn");
  if (bDeselect) bDeselect.addEventListener("click", function () {
    _assetsSelected.clear();
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
  loadAssets();
  document.getElementById("assets-select-all").addEventListener("change", function () {
    var cbs = document.querySelectorAll("#assets-tbody input.row-cb");
    var chk = this.checked;
    cbs.forEach(function (cb) {
      cb.checked = chk;
      if (chk) _assetsSelected.add(cb.getAttribute("data-id"));
      else _assetsSelected.delete(cb.getAttribute("data-id"));
    });
    _assetsUpdateBulkBar();
  });
  document.getElementById("assets-tbody").addEventListener("change", function (e) {
    var cb = e.target;
    if (!cb.classList.contains("row-cb")) return;
    var id = cb.getAttribute("data-id");
    if (cb.checked) _assetsSelected.add(id);
    else _assetsSelected.delete(id);
    _assetsUpdateSelectAll();
    _assetsUpdateBulkBar();
  });
  document.getElementById("assets-tbody").addEventListener("click", function (e) {
    var link = e.target.closest(".asset-name-link");
    if (!link) return;
    e.preventDefault();
    openViewModal(link.getAttribute("data-asset-id"));
  });
  wireFavoriteClicks("assets-tbody", function () { renderAssetsPage(); });

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
    renderAssetsPage();
    _saveAssetsPrefs();
  });
  document.getElementById("filter-pagesize").addEventListener("change", function () {
    _assetsPageSize = parseInt(this.value, 10) || 15;
    _assetsPage = 1;
    renderAssetsPage();
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

async function loadAssets() {
  _assetsSelected.clear();
  _assetsUpdateBulkBar();
  var tbody = document.getElementById("assets-tbody");
  try {
    var PAGE = 10000;
    var first = await api.assets.list({ limit: PAGE, offset: 0 });
    var all = first.assets || first;
    var total = first.total || all.length;
    if (total > PAGE) {
      var pages = [];
      for (var off = PAGE; off < total; off += PAGE) {
        pages.push(api.assets.list({ limit: PAGE, offset: off }));
      }
      var rest = await Promise.all(pages);
      rest.forEach(function (r) { all = all.concat(r.assets || r); });
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
      } else {
        // Both "pending" (recovering / freshly enabled) and "unknown" (never
        // probed) display as Pending — they're indistinguishable to operators.
        a._monitor = ["Monitored", "Pending"];
      }
      return a;
    }
    _assetsData = all.map(_mapAsset);
    renderAssetsPage();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
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
// `monitored` flag through PUT /assets/:id; the route stamps
// `monitoredOperatorSet=true` so the choice survives discovery cycles. UI
// is optimistic — flip the cached row + re-render before the network round
// trip; rollback on failure with a toast.
async function _handleMonitorPillClick(e) {
  var pill = e.target.closest('[data-monitor-toggle]');
  if (!pill) return;
  e.preventDefault();
  e.stopPropagation();
  if (typeof canManageAssets === "function" && !canManageAssets()) return;
  var assetId = pill.getAttribute('data-monitor-toggle');
  var currentlyMonitored = pill.getAttribute('data-monitored') === "true";
  var nextMonitored = !currentlyMonitored;
  // Find the cached row.
  var idx = (_assetsData || []).findIndex(function (a) { return a.id === assetId; });
  if (idx === -1) return;
  var prevSnapshot = Object.assign({}, _assetsData[idx]);
  // Optimistic update.
  _assetsData[idx].monitored = nextMonitored;
  if (!nextMonitored) {
    _assetsData[idx].monitorStatus = null;
    _assetsData[idx].lastResponseTimeMs = null;
  } else if (!_assetsData[idx].monitorStatus) {
    _assetsData[idx].monitorStatus = "unknown";
  }
  renderAssetsPage();
  try {
    await api.assets.update(assetId, { monitored: nextMonitored });
    showToast(nextMonitored ? "Monitoring enabled" : "Monitoring disabled");
  } catch (err) {
    // Rollback. Single field-level revert keeps the rest of the row's
    // state (lastResponseTimeMs etc.) untouched in case other fields drifted.
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
  if (_assetsData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No assets found. Add one to get started.</td></tr>';
    clearPageControls("pagination");
    _assetsUpdateSelectAll();
    return;
  }
  var sfData = _assetsSF ? _assetsSF.apply(_assetsData) : _assetsData;
  if (sfData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No results match the current filters.</td></tr>';
    clearPageControls("pagination");
    _assetsUpdateSelectAll();
    return;
  }
  sfData = sortFavoritesFirst(sfData, "assets");
  var start = (_assetsPage - 1) * _assetsPageSize;
  var page = sfData.slice(start, start + _assetsPageSize);
  tbody.innerHTML = page.map(function (a) {
    var checked = _assetsSelected.has(a.id) ? ' checked' : '';
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
  renderPageControls("pagination", sfData.length, _assetsPageSize, _assetsPage, function (p) {
    _assetsPage = p;
    renderAssetsPage();
  });
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

  // Show quarantine/release buttons only for assets-admins. Determine which
  // buttons are relevant based on the statuses of the selected assets.
  // Infrastructure types (firewall/switch/access_point) are excluded from the
  // Quarantine button — they can't be quarantined — but stay eligible for
  // Release in case one was quarantined before this guard was added.
  if (canManageAssets() && _assetsData && _assetsData.length) {
    var selected = _assetsData.filter(function (a) { return _assetsSelected.has(a.id); });
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

async function openBulkEditModal() {
  var ids = Array.from(_assetsSelected);
  if (!ids.length) return;
  await _ensureTagCache();

  var typeOptions = '<option value="">— no change —</option>' +
    '<option value="server">Server</option>' +
    '<option value="switch">Switch</option>' +
    '<option value="router">Router</option>' +
    '<option value="firewall">Firewall</option>' +
    '<option value="workstation">Workstation</option>' +
    '<option value="printer">Printer</option>' +
    '<option value="access_point">Access Point</option>' +
    '<option value="other">Other</option>';

  var body =
    '<p style="color:var(--color-text-secondary);margin-bottom:1.25rem">Editing <strong>' + ids.length + '</strong> asset' + (ids.length !== 1 ? 's' : '') + '. Leave a field at its default to skip it.</p>' +
    '<div class="form-group"><label>Asset Type</label>' +
      '<select id="bulk-f-type">' + typeOptions + '</select>' +
    '</div>' +
    '<div class="form-group"><label>Tags</label>' +
      '<div style="display:flex;gap:16px;margin-bottom:0.5rem">' +
        '<label style="display:flex;gap:6px;align-items:center;cursor:pointer;font-weight:normal"><input type="radio" name="bulk-tag-mode" value="none" checked> No change</label>' +
        '<label style="display:flex;gap:6px;align-items:center;cursor:pointer;font-weight:normal"><input type="radio" name="bulk-tag-mode" value="add"> Add tags</label>' +
        '<label style="display:flex;gap:6px;align-items:center;cursor:pointer;font-weight:normal"><input type="radio" name="bulk-tag-mode" value="replace"> Replace tags</label>' +
      '</div>' +
      '<div id="bulk-tag-picker-wrap" style="display:none">' + tagFieldHTML([]) + '</div>' +
    '</div>';

  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="bulk-edit-save-btn">Apply to ' + ids.length + ' Asset' + (ids.length !== 1 ? 's' : '') + '</button>';

  openModal("Edit Selected Assets", body, footer);
  wireTagPicker();

  document.querySelectorAll('input[name="bulk-tag-mode"]').forEach(function (radio) {
    radio.addEventListener("change", function () {
      var wrap = document.getElementById("bulk-tag-picker-wrap");
      if (wrap) wrap.style.display = this.value !== "none" ? "" : "none";
    });
  });

  document.getElementById("bulk-edit-save-btn").addEventListener("click", async function () {
    var btn = this;
    var typeVal = document.getElementById("bulk-f-type").value;
    var tagModeEl = document.querySelector('input[name="bulk-tag-mode"]:checked');
    var tagMode = tagModeEl ? tagModeEl.value : "none";
    var selectedTags = tagMode !== "none" ? getTagFieldValue() : null;

    if (!typeVal && tagMode === "none") {
      showToast("No changes selected", "error");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Applying…";

    var successCount = 0;
    var errorCount = 0;

    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var payload = {};
      if (typeVal) payload.assetType = typeVal;
      if (tagMode !== "none") {
        if (tagMode === "add") {
          var existing = _assetsData.find(function (a) { return a.id === id; });
          var existingTags = existing && existing.tags ? existing.tags : [];
          payload.tags = Array.from(new Set(existingTags.concat(selectedTags)));
        } else {
          payload.tags = selectedTags;
        }
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
      showToast("Updated " + successCount + " asset" + (successCount !== 1 ? "s" : ""));
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
  return '<span class="badge badge-asset-type badge-clickable"' +
    ' data-asset-type-toggle="' + escapeHtml(asset.id) + '"' +
    ' data-asset-type="' + escapeHtml(type || "other") + '"' +
    ' role="button" tabindex="0"' +
    ' title="Click to change type">' +
    escapeHtml(label) + ' ▾</span>';
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
//   monitored=false                       → grey   "Unmonitored"
//   monitored=true, status="up"           → green  "Up"
//   monitored=true, status="warning"      → amber  "Warning"   (was up, currently failing but below threshold)
//   monitored=true, status="pending"      → blue   "Pending"   (recovering from down / freshly enabled, below threshold)
//   monitored=true, status="down"         → red    "Down"
//   monitored=true, status="unknown"/null → blue   "Pending"   (never probed — same display as "pending")
//
// For admin/assetsadmin callers the pill is clickable: a single click
// toggles monitored (sets monitoredOperatorSet=true server-side so the
// choice sticks across discovery cycles). The pill carries
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
  var title = bits.length ? ' title="' + escapeHtml(bits.join("\n")) + '"' : "";
  var clickCls = canToggle ? " badge-clickable" : "";
  if (s === "up")      return '<span class="badge badge-monitored'        + clickCls + '"' + title + toggleAttrs + '>Up</span>';
  if (s === "warning") return '<span class="badge badge-monitor-warning'  + clickCls + '"' + title + toggleAttrs + '>Warning</span>';
  if (s === "down")    return '<span class="badge badge-monitor-down'     + clickCls + '"' + title + toggleAttrs + '>Down</span>';
  // pending + unknown both render as "Pending".
  return '<span class="badge badge-monitor-pending' + clickCls + '"' + title + toggleAttrs + '>Pending</span>';
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
    '<div class="form-group"><label>Type</label><select id="f-assetType">' +
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
    var credSel = document.getElementById("f-monitorCredential");
    if (credSel) data.monitorCredentialId = credSel.value || null;
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
    // Per-stream polling-method overrides. Each select returns null
    // (= inherit) or one of "rest_api"/"snmp"/"winrm"/"ssh"/"icmp".
    var polling = _polarisReadPollingFourStream("f-");
    if (document.getElementById("f-responseTimePolling")) {
      data.responseTimePolling = polling.responseTimePolling;
      data.telemetryPolling    = polling.telemetryPolling;
      data.interfacesPolling   = polling.interfacesPolling;
      data.lldpPolling         = polling.lldpPolling;
    }
  }
  return data;
}

// ─── Tabbed asset modal scaffolding ────────────────────────────────────────

function assetMonitoringFormHTML(asset) {
  var credId = asset && asset.monitorCredentialId ? asset.monitorCredentialId : "";
  var interval = asset && asset.monitorIntervalSec != null ? asset.monitorIntervalSec : "";
  var probeTimeout = asset && asset.probeTimeoutMs != null ? asset.probeTimeoutMs : "";
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
    telemetryPolling:    asset && asset.telemetryPolling,
    interfacesPolling:   asset && asset.interfacesPolling,
    lldpPolling:         asset && asset.lldpPolling,
  };
  var transportBlockHtml =
    '<div id="f-transport-wrap" style="margin-top:0.5rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
      _polarisPollingFourStreamHTML("f-", assetSourceKind, pollingCurrent) +
      '<p class="hint" style="margin-top:0.25rem">Per-asset overrides win over class / integration / source-default tiers. Methods that need a credential (SNMP / WinRM / SSH / REST API) use this asset\'s credential when set; FMG/FortiGate-discovered firewalls fall back to the integration\'s API token (REST API) or shared SNMP credential.</p>' +
    '</div>';

  return (
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" id="f-monitored"' + monitored + '>' +
        '<span>Enable monitoring for this asset</span>' +
      '</label>' +
      '<p class="hint">A successful probe means the credential authenticated. Probes write a sample row each cycle; failed probes count as packet loss.</p>' +
    '</div>' +
    '<div class="form-group" id="f-monitorCredential-wrap">' +
      '<label>Credential</label>' +
      '<select id="f-monitorCredential" data-current-id="' + escapeHtml(credId) + '">' +
        '<option value="">— none —</option>' +
      '</select>' +
      '<p class="hint">Used by polling methods that need authentication (SNMP / WinRM / SSH / REST API). FMG/FortiGate-discovered firewalls fall back to the integration\'s API token when no asset credential is set. Add credentials in <a href="/server-settings.html?tab=credentials">Server Settings → Credentials</a>.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Poll Interval Override (seconds) <span class="tier-badge" id="f-monitorInterval-tier" style="margin-left:0.5rem;font-size:0.78rem;font-weight:normal;color:var(--color-text-tertiary)"></span></label>' +
      '<input type="number" id="f-monitorInterval" min="5" max="86400" value="' + escapeHtml(String(interval)) + '" placeholder="leave blank to inherit" style="max-width:240px">' +
      '<p class="hint">Inherits from the resolved tier when blank. Minimum 5 seconds. Edit defaults from the <a href="/assets.html#monitoring-settings">Monitoring Settings</a> button at the top of the Assets page or from the integration\'s Monitoring tab.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Probe Timeout Override (ms) <span class="tier-badge" id="f-probeTimeoutMs-tier" style="margin-left:0.5rem;font-size:0.78rem;font-weight:normal;color:var(--color-text-tertiary)"></span></label>' +
      '<input type="number" id="f-probeTimeoutMs" min="100" max="60000" value="' + escapeHtml(String(probeTimeout)) + '" placeholder="leave blank to inherit" style="max-width:240px">' +
      '<p class="hint" id="f-probeTimeoutMs-warn" style="display:none;color:var(--color-warning)">⚠ Below 500 ms — probes will likely false-fail under healthy network conditions.</p>' +
      '<p class="hint">Range 100..60000 ms; default is 5000 ms. Inherits from the resolved tier when blank.</p>' +
    '</div>' +
    transportBlockHtml +
    '<div class="form-group" id="f-asset-overrides-wrap"' + assetIdAttr + ' style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--color-border);display:none">' +
      '<button type="button" class="btn btn-secondary" id="btn-asset-overrides-list">Show other asset overrides under this scope</button>' +
      '<p class="hint" id="f-asset-overrides-hint">Lists every asset under the same (class, asset source) scope that has its own per-asset overrides.</p>' +
    '</div>'
  );
}

async function _wireMonitorEditTab(asset) {
  await _ensureCredentials();
  var monChk = document.getElementById("f-monitored");
  var credWrap = document.getElementById("f-monitorCredential-wrap");
  var credSel = document.getElementById("f-monitorCredential");
  var intervalEl = document.getElementById("f-monitorInterval");
  var probeTimeoutEl = document.getElementById("f-probeTimeoutMs");
  var probeTimeoutWarn = document.getElementById("f-probeTimeoutMs-warn");

  var transportWrap = document.getElementById("f-transport-wrap");
  function refresh() {
    var enabled = !!(monChk && monChk.checked);
    if (intervalEl) intervalEl.disabled = !enabled;
    if (probeTimeoutEl) probeTimeoutEl.disabled = !enabled;
    if (credWrap) credWrap.style.display = enabled ? "block" : "none";
    if (credSel) {
      credSel.disabled = !enabled;
      // Populate with every credential type — operator picks the one that
      // matches the polling method they've chosen below. The picker stays
      // visible whenever monitoring is enabled because a single asset
      // could have polling=snmp + a stored SNMP credential, or
      // polling=winrm + a WinRM credential, etc.
      if (enabled) {
        var current = credSel.getAttribute("data-current-id") || "";
        credSel.innerHTML = _credentialOptionsForAny(current);
      }
    }
    if (transportWrap) {
      transportWrap.style.display = enabled ? "block" : "none";
    }
  }
  if (monChk) monChk.addEventListener("change", refresh);
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
  setBadge("f-monitorInterval-tier", "intervalSeconds", " s");
  setBadge("f-probeTimeoutMs-tier",  "probeTimeoutMs",  " ms");
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
        if (a.monitorIntervalSec    != null) bits.push("interval=" + a.monitorIntervalSec + "s");
        if (a.telemetryIntervalSec  != null) bits.push("telemetry=" + a.telemetryIntervalSec + "s");
        if (a.systemInfoIntervalSec != null) bits.push("sysinfo=" + a.systemInfoIntervalSec + "s");
        if (a.probeTimeoutMs        != null) bits.push("timeout=" + a.probeTimeoutMs + "ms");
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
    var results = await Promise.all([api.assets.get(id), _ensureTagCache()]);
    var asset = results[0];
    asset._editing = true;
    var body = _renderTabbedBody("asset-edit", [
      { key: "general",    label: "General",    html: assetFormHTML(asset) },
      { key: "monitoring", label: "Monitoring", html: assetMonitoringFormHTML(asset) },
    ]);
    var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="btn-save">Save Changes</button>';
    var title = "Edit Asset" + (asset.hostname ? " — " + asset.hostname : "");
    openModal(title, body, footer);
    _wireModalTabs("asset-edit");
    wireTagPicker();
    _wireMonitorEditTab(asset);
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
var _ifaceRefreshTimer        = null;
var _monitorSettingsCache     = null;  // global monitor settings, fetched once per session
var _currentAssetForRefresh   = null;  // asset object cached so refresh schedulers can read its per-asset intervals

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

// Auto-refresh ticks must not yank the user back to the top of the panel.
// Showing "Loading…" placeholders collapses the slideover body's scrollHeight,
// which clamps scrollTop. Silent callers skip the placeholders and capture +
// restore scrollTop around the swap (see the silent branches in
// _loadSystemTabFor / _loadMonitorHistoryFor / _loadInterfaceHistoryFor).

function _currentIfaceRange() {
  var btn = document.querySelector(".iface-range-btn.btn-primary");
  return (btn && btn.getAttribute("data-range")) || "1h";
}

function _ensureAssetPanelDOM() {
  if (document.getElementById("asset-panel-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "asset-panel-overlay";
  overlay.className = "slideover-overlay";
  overlay.innerHTML =
    '<div class="slideover" id="asset-panel">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="asset-panel-title">Asset Details</h3>' +
          '<button class="btn-icon" id="asset-panel-close" title="Close">&times;</button>' +
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

  initSlideoverResize(document.getElementById("asset-panel"), "polaris.panel.width.asset");
}

function closeAssetPanel() {
  var overlay = document.getElementById("asset-panel-overlay");
  if (overlay) overlay.classList.remove("open");
  _clearAssetRefreshTimers();
  _currentAssetForRefresh = null;
}

async function openViewModal(id) {
  _ensureAssetPanelDOM();
  var titleEl  = document.getElementById("asset-panel-title");
  var metaEl   = document.getElementById("asset-panel-meta");
  var bodyEl   = document.getElementById("asset-panel-body");
  var footerEl = document.getElementById("asset-panel-footer");
  titleEl.textContent = "Asset Details";
  metaEl.innerHTML = "";
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading...</p>';
  footerEl.innerHTML = "";
  requestAnimationFrame(function () {
    document.getElementById("asset-panel-overlay").classList.add("open");
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
    var generalHTML = '<div class="asset-view-grid">' +
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
      viewRow("Location", a.location) +
      viewRow("Learned Location", a.learnedLocation) +
      ((a.latitude != null && a.longitude != null)
        ? viewRow("Coordinates", a.latitude.toFixed(4) + ", " + a.longitude.toFixed(4), true)
        : "") +
      viewRow("Department", a.department) +
      viewRow("Assigned To", a.assignedTo) +
      viewRow("OS / Firmware", a.osVersion || a.os) +
      viewRow("Last Seen Switch", a.lastSeenSwitch) +
      viewRow("Last Seen AP", a.lastSeenAp) +
      associatedUsersViewHTML(a.associatedUsers) +
      viewRow("Last Seen", a.lastSeen ? formatDate(a.lastSeen) : null) +
      viewRow("Acquired", (a.acquiredAt || a.createdAt) ? formatDate(a.acquiredAt || a.createdAt) : null) +
      viewRow("Warranty Expires", a.warrantyExpiry ? formatDate(a.warrantyExpiry) : null) +
      viewRow("Purchase Order", a.purchaseOrder) +
      viewRow("Tags", (a.tags || []).join(", ") || null, false, true) +
      viewRow("Notes", a.notes, false, true) +
      viewRow("Created", formatDate(a.createdAt)) +
      viewRow("Updated", formatDate(a.updatedAt)) +
    '</div>';

    var monitoringHTML = assetMonitoringViewHTML(a);
    var systemHTML     = a.monitored
      ? monitoringHTML +
        '<hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--color-border)">' +
        assetSystemViewHTML(a)
      : monitoringHTML;
    var tabs = [
      { key: "general", label: "General", html: generalHTML },
      { key: "system",  label: "System",  html: systemHTML },
    ];
    // Sources tab — surfaces the multi-source asset model (Phase 3a). Loaded
    // ahead of render so the table is ready on first paint; failures fall
    // through to an empty-state message so the rest of the modal still works.
    var sources = [];
    try {
      sources = await api.assets.getSources(a.id);
    } catch (err) {
      console.warn("Failed to load asset sources", err);
    }
    tabs.push({ key: "sources", label: "Sources", html: _assetSourcesTabHTML(sources, a.id) });
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

    var histLabel = escapeHtml(a.hostname || a.ipAddress || a.id);
    var historyBtn = '<button class="btn btn-sm btn-secondary" onclick="openIpHistoryModal(\'' + a.id + '\',\'' + histLabel + '\')">History</button>';
    var copyBtns =
      '<button type="button" class="btn btn-sm btn-secondary" id="btn-asset-copy">Copy</button>' +
      '<button type="button" class="btn btn-sm btn-secondary" id="btn-asset-screenshot">Screenshot</button>';
    var leftBtns = historyBtn + copyBtns;
    var rightBtns = '<button class="btn btn-sm btn-secondary" id="btn-asset-panel-close-btn">Close</button>' +
      (canManageAssets() ? '<button class="btn btn-sm btn-primary" id="btn-asset-panel-edit-btn">Edit</button>' : '');
    footerEl.innerHTML = leftBtns + '<span style="flex:1"></span>' + rightBtns;

    _wireModalTabs("asset-view");
    if (isAdmin()) _wireSnmpWalkTab(a);
    if (canManageAssets()) _wireQuarantineTab(a);
    _wireHoverTriggersIn(bodyEl);
    bodyEl.addEventListener("click", _handleCopyClick);
    document.getElementById("btn-asset-copy").addEventListener("click", _copyAssetDetails);
    document.getElementById("btn-asset-screenshot").addEventListener("click", function () {
      _screenshotAssetDetails(a);
    });
    document.getElementById("btn-asset-panel-close-btn").addEventListener("click", closeAssetPanel);
    var editBtn = document.getElementById("btn-asset-panel-edit-btn");
    if (editBtn) {
      editBtn.addEventListener("click", function () {
        closeAssetPanel();
        openEditModal(a.id);
      });
    }
    if (a.monitored) _loadMonitorHistoryFor(a.id, "24h");
    if (a.monitored) _loadSystemTabFor(a.id, "24h", a);
    if (a.monitored) _renderIntermittencyBar(a.id);
    document.querySelectorAll(".asset-system-range-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var range = b.getAttribute("data-range");
        document.querySelectorAll(".asset-system-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
        b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
        _loadSystemTabFor(a.id, range, a);
      });
    });
    var probeBtn = document.getElementById("btn-asset-probe-now");
    if (probeBtn) {
      probeBtn.addEventListener("click", async function () {
        probeBtn.disabled = true;
        probeBtn.textContent = "Refreshing…";
        try {
          var r = await api.assets.probeNow(a.id);
          // Build a per-stream summary so the toast names exactly which streams
          // refreshed and which failed (and why). The probe-now endpoint returns:
          //   { success, responseTimeMs, error?, telemetry: {supported,collected,error?}, systemInfo: {…} }
          var parts = [];
          var failures = [];
          if (r.success) parts.push("probe " + r.responseTimeMs + " ms");
          else failures.push("probe: " + (r.error || "unknown"));

          var tel = r.telemetry || {};
          if (tel.collected) parts.push("telemetry");
          else if (tel.supported && tel.error) failures.push("telemetry: " + tel.error);

          var si = r.systemInfo || {};
          if (si.collected) parts.push("interfaces");
          else if (si.supported && si.error) failures.push("interfaces: " + si.error);

          var anyFail = failures.length > 0;
          var label = anyFail ? "Refresh partial" : "Refreshed";
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
        } catch (err) {
          showToast(err.message || "Refresh failed", "error");
        } finally {
          probeBtn.disabled = false;
          probeBtn.textContent = "Refresh";
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
  // delivered when the resolved interfacesPolling is REST API or SNMP.
  // ICMP / SSH / WinRM don't carry the data shapes yet.
  var ifPolling = a.interfacesPolling;
  if (!ifPolling) {
    var integ = a.discoveredByIntegration;
    var sk = (integ && integ.type) || "manual";
    if (sk !== "fortimanager" && sk !== "fortigate") ifPolling = null;
    else ifPolling = "rest_api";
  }
  if (ifPolling !== "rest_api" && ifPolling !== "snmp") {
    return '<div style="padding:1rem 0;color:var(--color-text-secondary)">' +
      'System metrics (CPU / memory / interfaces / storage) require REST API or SNMP polling on the Interfaces stream. Switch the polling method on the Monitoring tab to enable.' +
    '</div>';
  }
  var rangeBtns =
    '<button class="btn btn-sm btn-primary asset-system-range-btn" data-range="1h">1h</button>' +
    '<button class="btn btn-sm btn-secondary asset-system-range-btn" data-range="24h">24h</button>' +
    '<button class="btn btn-sm btn-secondary asset-system-range-btn" data-range="7d">7d</button>' +
    '<button class="btn btn-sm btn-secondary asset-system-range-btn" data-range="30d">30d</button>';
  // CPU/Memory + Temperatures share the Telemetry stream — the same toggle
  // controls both, so they get the same source badge. Interfaces is its
  // own stream. Storage and LLDP ride the same stream as Interfaces.
  var telemetryBadge   = _streamSourceBadgeHTML(a, "telemetry");
  var interfacesBadge  = _streamSourceBadgeHTML(a, "interfaces");
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
    sectionHeader("CPU &amp; Memory", telemetryBadge, true) +
    '<div id="asset-system-summary" style="display:flex;gap:1.25rem;flex-wrap:wrap;font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">' +
      '<span>Loading…</span>' +
    '</div>' +
    '<div id="asset-system-chart" style="background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;padding:0.5rem;min-height:200px;display:flex;align-items:center;justify-content:center;color:var(--color-text-secondary);font-size:0.85rem">' +
      'Loading samples…' +
    '</div>' +
    sectionHeader("Temperatures", telemetryBadge, false) +
    '<div id="asset-system-temps"><span class="empty-state">Loading…</span></div>' +
    sectionHeader("Interfaces", interfacesBadge, false) +
    '<div id="asset-system-interfaces"><span class="empty-state">Loading…</span></div>' +
    sectionHeader("Storage", interfacesBadge, false) +
    '<div id="asset-system-storage"><span class="empty-state">Loading…</span></div>' +
    sectionHeader("LLDP Neighbors", _streamSourceBadgeHTML(a, "lldp"), false) +
    '<div id="asset-system-lldp"><span class="empty-state">Loading…</span></div>'
  );
}

function _currentSystemTabRange() {
  var chart = document.getElementById("asset-system-chart");
  return (chart && chart.dataset.range) || "24h";
}

async function _loadSystemTabFor(assetId, range, asset, opts) {
  // Cancel any pending auto-refresh — a manual range change, probe-now, or
  // re-render shouldn't race a scheduled tick.
  if (_assetSystemRefreshTimer) { clearTimeout(_assetSystemRefreshTimer); _assetSystemRefreshTimer = null; }
  var silent = !!(opts && opts.silent);
  var chart   = document.getElementById("asset-system-chart");
  var summary = document.getElementById("asset-system-summary");
  var ifaces  = document.getElementById("asset-system-interfaces");
  var storage = document.getElementById("asset-system-storage");
  var temps   = document.getElementById("asset-system-temps");
  var lldp    = document.getElementById("asset-system-lldp");
  if (!chart) return;
  chart.dataset.range = range || "24h";
  if (!silent) {
    chart.textContent = "Loading samples…";
    if (summary) summary.innerHTML = "<span>Loading…</span>";
    if (ifaces)  ifaces.innerHTML  = '<span class="empty-state">Loading…</span>';
    if (storage) storage.innerHTML = '<span class="empty-state">Loading…</span>';
    if (temps)   temps.innerHTML   = '<span class="empty-state">Loading…</span>';
    if (lldp)    lldp.innerHTML    = '<span class="empty-state">Loading…</span>';
  }

  var panelBody = silent ? document.getElementById("asset-panel-body") : null;
  var savedScroll = panelBody ? panelBody.scrollTop : 0;

  try {
    var results = await Promise.all([
      api.assets.telemetryHistory(assetId, range || "24h"),
      api.assets.systemInfo(assetId),
    ]);
    var tel    = results[0];
    var si     = results[1];

    _renderSystemChart(chart, tel);
    _renderSystemSummary(summary, tel, si);
    _renderInterfacesTable(ifaces, si, asset);
    _renderStorageTable(storage, si, asset);
    _renderTemperatures(temps, si, asset);
    _renderLldpNeighborsCard(lldp, si);
  } catch (err) {
    if (!silent) {
      chart.textContent = "Error: " + (err.message || "failed to load");
      if (summary) summary.innerHTML = "";
      if (ifaces)  ifaces.innerHTML  = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
      if (storage) storage.innerHTML = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
      if (temps)   temps.innerHTML   = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
      if (lldp)    lldp.innerHTML    = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
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
  // Schedule next auto-refresh on the telemetry cadence (the fastest of the
  // three System-tab streams). Keep going on error so a transient blip doesn't
  // disable the chain.
  var settings = _monitorSettingsCache || {};
  var refAsset = asset || _currentAssetForRefresh;
  var ms = _refreshIntervalMs(refAsset && refAsset.telemetryIntervalSec, settings.telemetryIntervalSeconds, 60);
  _scheduleAssetSystemRefresh(assetId, refAsset, ms);
}

function _renderSystemSummary(container, tel, si) {
  if (!container) return;
  var parts = [];
  var latest = (si && si.telemetry) || null;
  if (latest) {
    if (typeof latest.cpuPct === "number") parts.push('<span><strong>CPU:</strong> ' + latest.cpuPct.toFixed(1) + '%</span>');
    if (typeof latest.memPct === "number") parts.push('<span><strong>Memory:</strong> ' + latest.memPct.toFixed(1) + '%</span>');
    if (typeof latest.memUsedBytes === "number" && typeof latest.memTotalBytes === "number" && latest.memTotalBytes > 0) {
      parts.push('<span>(' + _fmtBytes(latest.memUsedBytes) + ' / ' + _fmtBytes(latest.memTotalBytes) + ')</span>');
    }
    if (latest.timestamp) parts.push('<span style="opacity:0.7">as of ' + escapeHtml(formatDate(latest.timestamp)) + '</span>');
  }
  if (tel && tel.stats) {
    var s = tel.stats;
    var cpu = s.avgCpuPct != null ? ('avg ' + s.avgCpuPct.toFixed(1) + '%, max ' + s.maxCpuPct.toFixed(1) + '%') : '—';
    var mem = s.avgMemPct != null ? ('avg ' + s.avgMemPct.toFixed(1) + '%, max ' + s.maxMemPct.toFixed(1) + '%') : '—';
    parts.push('<span style="opacity:0.7">window: CPU ' + cpu + ' · Mem ' + mem + ' (' + s.total + ' samples)</span>');
  }
  container.innerHTML = parts.join("") || '<span>No telemetry samples yet.</span>';
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
  var monitored        = new Set(((si && si.monitoredInterfaces)   || (asset && asset.monitoredInterfaces)   || []));
  var monitoredTunnels = new Set(((si && si.monitoredIpsecTunnels) || (asset && asset.monitoredIpsecTunnels) || []));
  var canEdit = canManageAssets();
  var COLS = 10;
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
    var childAttr = opts.isChild ? ' class="iface-child" data-parent="' + escapeHtml(opts.parentName) + '"' : "";
    var neighborCell = '<td>' + _lldpNeighborInlineCell(lldpByIf[iface.ifName] || []) + '</td>';

    return "<tr" + childAttr + ">" +
      '<td style="text-align:center;width:1%">' + checkbox + "</td>" +
      nameCell +
      "<td>" + statusCell(iface) + "</td>" +
      "<td>" + speed + "</td>" +
      '<td class="mono">' + escapeHtml(iface.ipAddress  || "—") + "</td>" +
      '<td class="mono">' + escapeHtml(iface.macAddress || "—") + "</td>" +
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
    return "<tr" + rowAttr + ">" +
      '<td style="text-align:center;width:1%">' + checkbox + "</td>" +
      nameCell +
      "<td>" + statusPill + "</td>" +
      "<td>—</td>" +
      '<td class="mono">' + escapeHtml(tn.remoteGateway || "—") + "</td>" +
      '<td class="mono">—</td>' +
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

  // Groups
  var aggGroup  = topLevel.filter(function (r) { return r.ifType === "aggregate"; });
  var physGroup = topLevel.filter(function (r) { return r.ifType === "physical" || r.ifType == null; });
  var otherGroup = topLevel.filter(function (r) {
    return r.ifType && r.ifType !== "physical" && r.ifType !== "aggregate";
  });

  // ── render ─────────────────────────────────────────────────────────────────
  var html = "";

  if (aggGroup.length > 0) {
    html += sectionRow("Aggregate Interfaces", aggGroup.length);
    aggGroup.forEach(function (agg) { html += renderCluster(agg); });
  }

  if (physGroup.length > 0) {
    html += sectionRow("Physical Interfaces", physGroup.length);
    physGroup.forEach(function (phys) { html += renderCluster(phys); });
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

  container.innerHTML =
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th title="Pin this interface for fast-cadence polling" style="width:32px"></th>' +
      '<th>Interface</th><th>Status</th><th>Speed</th><th>IP</th><th>MAC</th><th>In</th><th>Out</th><th>Errors (in/out)</th>' +
      '<th title="LLDP neighbor seen on this interface">Neighbor</th>' +
    '</tr></thead><tbody>' + html + "</tbody></table></div>";

  // Expand / collapse aggregate and physical-with-children rows
  container.querySelectorAll(".iface-expand-toggle").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var parentName = btn.getAttribute("data-parent");
      var expanded = btn.textContent.trim() === "▼";
      btn.textContent = expanded ? "▶" : "▼";
      btn.title = expanded ? "Expand children" : "Collapse children";
      container.querySelectorAll(".iface-child").forEach(function (row) {
        if (row.getAttribute("data-parent") === parentName) row.style.display = expanded ? "none" : "";
      });
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

  // Interface name click — opens per-interface history panel
  container.querySelectorAll(".asset-iface-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      openInterfaceDetailPanel(asset, link.getAttribute("data-ifname"));
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
function _lldpNeighborInlineCell(neighbors) {
  if (!neighbors || neighbors.length === 0) return "—";
  var first = neighbors[0];
  var label = (first.systemName && String(first.systemName).trim())
    || first.chassisId
    || first.managementIp
    || "neighbor";
  var port = first.portId || first.portDescription || "";
  var labelHtml = first.matchedAsset && first.matchedAsset.id
    ? '<a href="#" class="asset-lldp-link" data-asset-id="' + escapeHtml(first.matchedAsset.id) +
      '" style="color:var(--color-accent);text-decoration:none">' + escapeHtml(label) + '</a>'
    : escapeHtml(label);
  var portStr = port ? ' <span style="opacity:0.7" class="mono">/ ' + escapeHtml(port) + '</span>' : "";
  var more = neighbors.length > 1
    ? ' <span style="font-size:0.7rem;padding:1px 5px;border-radius:3px;background:#6b728018;color:#9ca3af;border:1px solid #6b728030">+' + (neighbors.length - 1) + '</span>'
    : "";
  return labelHtml + portStr + more;
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
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th title="Pin this mountpoint for fast-cadence polling" style="width:32px"></th>' +
      '<th>Mount</th><th>Used</th><th>Total</th><th>Used %</th>' +
    '</tr></thead><tbody>' + body + '</tbody></table></div>';

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
      openStorageDetailPanel(asset, link.getAttribute("data-mount"));
    });
  });
}

// Latest-snapshot temperature table. Each sensor name is a clickable link
// that opens the per-sensor history slide-over (see openSensorDetailPanel).
// We dropped the shared multi-sensor chart this section used to render — too
// many sensors on one chart was unreadable; one sensor per modal is clearer.
function _renderTemperatures(container, si, asset) {
  if (!container) return;
  var latest = (si && si.temperatures) || [];
  if (latest.length === 0) {
    container.innerHTML = '<p class="empty-state">No temperature sensors reported by this device.</p>';
    return;
  }
  var rows = latest.map(function (t) {
    var c = (typeof t.celsius === "number") ? t.celsius.toFixed(1) + ' °C' : '—';
    var f = (typeof t.celsius === "number") ? (t.celsius * 9 / 5 + 32).toFixed(1) + ' °F' : '—';
    var name = '<a href="#" class="asset-temp-link" data-name="' + escapeHtml(t.sensorName) + '" style="color:var(--color-accent);text-decoration:none">' + escapeHtml(t.sensorName) + '</a>';
    return '<tr>' +
      '<td>' + name + '</td>' +
      '<td class="mono">' + c + '</td>' +
      '<td class="mono" style="color:var(--color-text-secondary)">' + f + '</td>' +
    '</tr>';
  }).join("");
  container.innerHTML =
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th>Sensor</th><th>Celsius</th><th>Fahrenheit</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';

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
function _renderLldpNeighborsCard(container, si) {
  if (!container) return;
  var neighbors = (si && si.lldpNeighbors) || [];
  if (neighbors.length === 0) {
    container.innerHTML = '<p class="empty-state">' +
      'No LLDP neighbors collected. Either the device isn’t advertising LLDP, ' +
      'the monitoring transport doesn’t support it, or the FortiOS REST endpoint ' +
      'returned 404 — try flipping the integration’s LLDP transport to SNMP.' +
      '</p>';
    return;
  }
  // Stable presentation: sort by local port, then chassis id.
  neighbors.sort(function (a, b) {
    var la = String(a.localIfName || ""), lb = String(b.localIfName || "");
    if (la !== lb) return la.localeCompare(lb);
    return String(a.chassisId || "").localeCompare(String(b.chassisId || ""));
  });
  var rows = neighbors.map(function (n) {
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
    return '<tr>' +
      '<td class="mono">' + escapeHtml(n.localIfName || "—") + '</td>' +
      '<td>' + primaryHtml +
        (idBits.length ? '<div class="mono" style="font-size:0.72rem;color:var(--color-text-tertiary);margin-top:2px">' + escapeHtml(idBits.join(" · ")) + '</div>' : '') +
      '</td>' +
      '<td style="font-size:0.78rem;color:var(--color-text-secondary)">' + escapeHtml(caps) + '</td>' +
    '</tr>';
  }).join("");
  container.innerHTML =
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th>Local Port</th><th>Neighbor</th><th>Capabilities</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';

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
}

async function openSensorDetailPanel(asset, sensorName) {
  if (!asset || !sensorName) return;
  _ensureSensorPanelDOM();
  var titleEl  = document.getElementById("sensor-panel-title");
  var metaEl   = document.getElementById("sensor-panel-meta");
  var bodyEl   = document.getElementById("sensor-panel-body");
  var footerEl = document.getElementById("sensor-panel-footer");
  titleEl.textContent = "Temperature — " + sensorName;
  metaEl.textContent = asset.hostname || asset.ipAddress || asset.id;
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>';
  footerEl.innerHTML =
    '<button class="btn btn-sm btn-secondary" id="btn-sensor-panel-close-btn">Close</button>';
  requestAnimationFrame(function () {
    document.getElementById("sensor-panel-overlay").classList.add("open");
  });
  document.getElementById("btn-sensor-panel-close-btn").addEventListener("click", closeSensorPanel);

  var rangeBtns =
    '<button class="btn btn-sm btn-primary sensor-range-btn" data-range="24h">24h</button>' +
    '<button class="btn btn-sm btn-secondary sensor-range-btn" data-range="7d">7d</button>' +
    '<button class="btn btn-sm btn-secondary sensor-range-btn" data-range="30d">30d</button>';

  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
        '<h4 style="margin:0">' + escapeHtml(sensorName) + '</h4>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
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

  await _loadSensorHistoryFor(asset.id, sensorName, "24h");
  document.querySelectorAll(".sensor-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      document.querySelectorAll(".sensor-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _loadSensorHistoryFor(asset.id, sensorName, range);
    });
  });
}

async function _loadSensorHistoryFor(assetId, sensorName, range) {
  var chartEl = document.getElementById("sensor-chart");
  var stats   = document.getElementById("sensor-stats");
  if (!chartEl) return;
  chartEl.textContent = "Loading samples…";
  if (stats) stats.textContent = "Loading…";
  try {
    var data = await api.assets.temperatureHistory(assetId, { sensorName: sensorName, range: range || "24h" });
    var samples = (data.samples || []).filter(function (s) { return typeof s.celsius === "number"; });
    if (stats) {
      if (samples.length === 0) {
        stats.textContent = "No samples in this range yet.";
      } else {
        var st = data.stats || {};
        var avg = (typeof st.avgCelsius === "number") ? st.avgCelsius.toFixed(1) : "—";
        var mn  = (typeof st.minCelsius === "number") ? st.minCelsius.toFixed(1) : "—";
        var mx  = (typeof st.maxCelsius === "number") ? st.maxCelsius.toFixed(1) : "—";
        stats.textContent = samples.length + " samples · avg " + avg + " °C · min " + mn + " °C · max " + mx + " °C";
      }
    }
    _renderSensorChart(chartEl, samples, {
      since:   data.since,
      until:   data.until,
      subject: sensorName,
    });
  } catch (err) {
    chartEl.textContent = "Error: " + (err.message || "failed to load");
    if (stats) stats.textContent = "";
  }
}

function _renderSensorChart(container, samples, opts) {
  opts = opts || {};
  if (samples.length === 0) {
    container.textContent = "No temperature samples in this range yet.";
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

  var allC = samples.map(function (s) { return s.celsius; });
  var minC = Math.min.apply(null, allC);
  var maxC = Math.max.apply(null, allC);
  if (minC === maxC) { minC -= 1; maxC += 1; }
  // 5° padding so a rock-steady sensor still gets a visible band
  minC = Math.floor((minC - 2) / 5) * 5;
  maxC = Math.ceil((maxC + 2) / 5) * 5;

  function xFor(ts) { return padL + ((new Date(ts).getTime() - t0) / (t1 - t0)) * innerW; }
  function yFor(c)  { return padT + innerH - ((c - minC) / (maxC - minC)) * innerH; }

  var pts = samples.map(function (s) { return xFor(s.timestamp) + "," + yFor(s.celsius); }).join(" ");
  var hits = samples.map(function (s) {
    return '<circle class="chart-hit" cx="' + xFor(s.timestamp) + '" cy="' + yFor(s.celsius) + '" r="6" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(s.timestamp)) + '"' +
      ' data-c="' + s.celsius + '"/>';
  }).join("");

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = minC + (maxC - minC) * (i / 4);
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + v.toFixed(0) + '°C</text>';
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
      ' transform="rotate(-90 ' + yLabelX + ' ' + yLabelY + ')">Temperature (°C)</text>';

  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      labels + ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      '<polyline points="' + pts + '" fill="none" stroke="var(--color-accent)" stroke-width="1.5"/>' +
      samples.map(function (s) { return '<circle cx="' + xFor(s.timestamp) + '" cy="' + yFor(s.celsius) + '" r="1.5" fill="var(--color-accent)"/>'; }).join("") +
      hits +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";

  _wireChartTooltip(container, function (target) {
    var c = Number(target.getAttribute("data-c"));
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>' + c.toFixed(1) + ' °C / ' + (c * 9 / 5 + 32).toFixed(1) + ' °F</div>';
  });
  _addChartScreenshotButton(container, "Temperature", { yAxis: "Temperature (°C)", subject: opts.subject });
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
  var statsEl = document.getElementById("iface-stats");
  var statsText = statsEl ? (statsEl.textContent || "").trim() : "";
  if (statsText === "Loading…") statsText = "";

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
function _renderSystemChart(container, data) {
  var samples = (data && data.samples) || [];
  if (samples.length === 0) {
    container.textContent = "No telemetry samples in this range yet.";
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

  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      (cpuPts ? '<polyline points="' + cpuPts + '" fill="none" stroke="' + cpuColor + '" stroke-width="1.5"/>' : '') +
      (memPts ? '<polyline points="' + memPts + '" fill="none" stroke="' + memColor + '" stroke-width="1.5"/>' : '') +
      cpuValues.map(function (e) { return '<circle cx="' + xFor(e.s.timestamp) + '" cy="' + yFor(e.v) + '" r="1.5" fill="' + cpuColor + '"/>'; }).join("") +
      memValues.map(function (e) { return '<circle cx="' + xFor(e.s.timestamp) + '" cy="' + yFor(e.v) + '" r="1.5" fill="' + memColor + '"/>'; }).join("") +
      legend + hits +
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
  _observeChartResize(container, function (c) { _renderSystemChart(c, data); });
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
function _assetMonitorStreamSource(asset, stream) {
  if (!asset) return { polling: null, source: "—" };
  var integration = asset.discoveredByIntegration;

  // Asset source: which integration discovered this asset, or "Manual".
  var typeLabels = {
    fortimanager:    "FortiManager",
    fortigate:       "FortiGate",
    activedirectory: "Active Directory",
    entraid:         "Entra ID",
    windowsserver:   "Windows Server",
  };
  var sourceName = integration
    ? ((typeLabels[integration.type] || integration.type) + " · " + integration.name)
    : "Manual";

  // Per-asset polling override wins; otherwise show the source default for
  // this stream. This is a coarse view (skips class-override / tier-3 layers
  // — that fidelity comes from /effective-monitor-settings) and is good
  // enough for the at-a-glance chart badge.
  var sourceKind = (integration && integration.type) || "manual";
  if (!_POLLING_COMPAT[sourceKind]) sourceKind = "manual";
  var assetField = stream + "Polling";
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

// Renders the badge content "polling · source" used next to each chart
// header. Returns "" when the stream isn't delivered for the asset's
// source kind (caller skips the badge entirely).
function _streamSourceBadgeHTML(asset, stream) {
  var info = _assetMonitorStreamSource(asset, stream);
  if (!info.polling) return "";
  var label = info.polling + " via " + info.source;
  var titleLabel = "Polling method · Asset source for this stream";
  return '<span title="' + escapeHtml(titleLabel) + '" style="font-size:0.75rem;padding:2px 6px;border-radius:10px;background:var(--color-bg-elevated);border:1px solid var(--color-border);color:var(--color-text-secondary);white-space:nowrap">' +
    escapeHtml(label) +
  '</span>';
}

function assetMonitoringViewHTML(a) {
  if (!a) return '<p class="empty-state">No data.</p>';
  var pill = assetMonitorBadge(a);
  if (!a.monitored) {
    return '<div style="padding:1rem 0">' +
      pill + ' &nbsp; ' +
      '<span style="color:var(--color-text-secondary)">Monitoring is disabled for this asset. Enable it from the Edit modal’s Monitoring tab.</span>' +
    '</div>';
  }
  // Source label: integration name when integration-discovered, else
  // credential name + polling method, else bare polling method.
  var sourceLabel = "—";
  var integ = a.discoveredByIntegration;
  if (integ) {
    var integTypeLabels = {
      fortimanager:    "FortiManager",
      fortigate:       "FortiGate",
      activedirectory: "Active Directory",
      entraid:         "Entra ID",
      windowsserver:   "Windows Server",
    };
    sourceLabel = (integTypeLabels[integ.type] || integ.type) + ": " + integ.name;
  } else {
    var rtPolling = a.responseTimePolling || "icmp";
    if (a.monitorCredential) sourceLabel = rtPolling.toUpperCase() + " · " + a.monitorCredential.name;
    else sourceLabel = rtPolling.toUpperCase();
  }
  var lastRtt = (typeof a.lastResponseTimeMs === "number") ? (a.lastResponseTimeMs + " ms") : "—";
  var lastPoll = a.lastMonitorAt ? formatDate(a.lastMonitorAt) : "—";
  var consec = a.consecutiveFailures || 0;
  var probeBtn = isUserOrAbove()
    ? '<button class="btn btn-sm btn-primary" id="btn-asset-probe-now" style="margin-right:6px" title="Run a response-time probe and pull fresh telemetry + interface data">Refresh</button>'
    : '';
  var rangeBtns =
    '<button class="btn btn-sm btn-primary asset-monitor-range-btn" data-range="24h">24h</button>' +
    '<button class="btn btn-sm btn-secondary asset-monitor-range-btn" data-range="7d">7d</button>' +
    '<button class="btn btn-sm btn-secondary asset-monitor-range-btn" data-range="30d">30d</button>' +
    '<button class="btn btn-sm btn-secondary asset-monitor-range-btn" data-range="custom" id="btn-asset-monitor-custom">Custom…</button>';
  var customPanel =
    '<div id="asset-monitor-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
      '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="asset-monitor-from" class="form-input" style="padding:2px 6px"></label>' +
      '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="asset-monitor-to" class="form-input" style="padding:2px 6px"></label>' +
      '<button class="btn btn-sm btn-primary" id="btn-asset-monitor-custom-apply">Apply</button>' +
    '</div>';
  return (
    '<div class="asset-view-grid">' +
      // Status uses a raw-HTML row because viewRow() escapes its value and
      // would render the badge markup as text.
      '<div class="detail-row"><span class="detail-label">Status</span>' +
        '<span class="detail-value">' + probeBtn + pill + '</span></div>' +
      // Last hour intermittency bar — one cell per probe sample, colored
      // by the resolved monitor state at that point. Loaded asynchronously
      // by _renderIntermittencyBar(). Hidden on unmonitored assets.
      (a.monitored
        ? '<div class="detail-row"><span class="detail-label">Last hour</span>' +
            '<span class="detail-value" id="asset-intermittency-bar" data-asset-id="' + escapeHtml(a.id) + '">' +
              '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Loading…</span>' +
            '</span></div>'
        : '') +
      viewRow("Source", sourceLabel) +
      viewRow("Last Response Time", lastRtt) +
      viewRow("Last Poll", lastPoll) +
      viewRow("Consecutive Failures", String(consec)) +
    '</div>' +
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
  // Fetch in parallel: 1h sample stream + the resolved threshold for the
  // state-machine replay. Both are best-effort; if either fails we fall
  // back to a sensible default so the bar still renders something useful.
  var samples = [];
  var threshold = 3;
  try {
    var results = await Promise.all([
      api.assets.monitorHistory(assetId, "1h").catch(function () { return null; }),
      api.assets.effectiveMonitorSettings(assetId).catch(function () { return null; }),
    ]);
    samples = (results[0] && Array.isArray(results[0].samples)) ? results[0].samples : [];
    if (results[1] && results[1].resolved && Number.isFinite(results[1].resolved.failureThreshold)) {
      threshold = results[1].resolved.failureThreshold;
    }
  } catch (_) { /* fall through with defaults */ }

  if (samples.length === 0) {
    slot.innerHTML = '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">No samples in the last hour</span>';
    return;
  }
  // Replay the state machine forward across samples to label each one with
  // its resolved status. failureThreshold doubles as the recovery threshold.
  // Starting state is "unknown" — for the first ~threshold cells the bar
  // may show pending/warning before settling, which is honest given we
  // have no memory of pre-window state.
  var cf = 0;
  var cs = 0;
  var prev = "unknown";
  var states = samples.map(function (s) {
    if (s.success) {
      cf = 0; cs += 1;
      if (prev === "up") {
        // stay up
      } else if (prev === "warning" || prev === "pending") {
        if (cs >= threshold) prev = "up";
      } else {
        // unknown / down
        prev = (cs >= threshold) ? "up" : "pending";
      }
    } else {
      cs = 0; cf += 1;
      if (cf >= threshold) prev = "down";
      else if (prev === "up" || prev === "unknown") prev = "warning";
      // pending / warning / down stay
    }
    return { timestamp: s.timestamp, status: prev };
  });

  // Color map mirrors badge-monitor-* hues so the bar reads as the same
  // visual vocabulary as the pill above it.
  var colors = {
    up:      "rgba(0,200,83,0.65)",
    warning: "rgba(255,193,7,0.75)",
    pending: "rgba(79,195,247,0.65)",
    down:    "rgba(211,47,47,0.75)",
    unknown: "rgba(117,117,117,0.45)",
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
      '<span>1h ago</span>' +
      '<span>' + samples.length + ' sample' + (samples.length === 1 ? '' : 's') + '</span>' +
      '<span>now</span>' +
    '</div>';
}

/**
 * Fetches asset.updated events for one asset within the chart window and
 * returns transition markers — one per event whose change-set touched the
 * polling-method fields (responseTimePolling / telemetryPolling /
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
    telemetryPolling:          "Telemetry polling",
    interfacesPolling:         "Interfaces polling",
    lldpPolling:               "LLDP polling",
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
      var loss = s.packetLossRate != null ? (s.packetLossRate * 100).toFixed(1) + "%" : "—";
      var avg  = s.avgMs != null ? s.avgMs + " ms" : "—";
      var min  = s.minMs != null ? s.minMs + " ms" : "—";
      var max  = s.maxMs != null ? s.maxMs + " ms" : "—";
      stats.innerHTML =
        '<span><strong>' + s.total + '</strong> samples</span>' +
        '<span><strong>Avg:</strong> ' + avg + '</span>' +
        '<span><strong>Min:</strong> ' + min + '</span>' +
        '<span><strong>Max:</strong> ' + max + '</span>' +
        '<span><strong>Packet loss:</strong> ' + loss + '</span>';
      stats.dataset.summary = s.total + " samples · avg " + avg + " · min " + min + " · max " + max + " · packet loss " + loss;
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
  // Transparent hit targets (r=7) on top of every sample so hover is forgiving
  // for both the 1.5px dots and the 1px failure lines.
  var hitTargets = samples.map(function (s) {
    var x = xFor(s.timestamp);
    var y = (s.success && typeof s.responseTimeMs === "number") ? yFor(s.responseTimeMs) : (padT + innerH / 2);
    return '<circle class="monitor-hit" cx="' + x + '" cy="' + y + '" r="7" fill="transparent" style="cursor:crosshair"' + hitAttrs(s) + '/>';
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

  var svg =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      ticks +
      xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      transitionLayer +
      yTitle +
      xTitle +
      failureLines +
      (pointsAttr ? '<polyline points="' + pointsAttr + '" fill="none" stroke="var(--color-accent)" stroke-width="1.5"/>' : '') +
      oks.map(function (s) {
        return '<circle cx="' + xFor(s.timestamp) + '" cy="' + yFor(s.responseTimeMs) + '" r="1.5" fill="var(--color-accent)"/>';
      }).join("") +
      hitTargets +
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
    var rttLine = ok && rtt !== "" ? (rtt + " ms") : '<span style="color:var(--color-danger,#d32f2f)">no response</span>';
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

async function openInterfaceDetailPanel(asset, ifName) {
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

  var rangeBtns =
    '<button class="btn btn-sm btn-primary iface-range-btn" data-range="1h">1h</button>' +
    '<button class="btn btn-sm btn-secondary iface-range-btn" data-range="24h">24h</button>' +
    '<button class="btn btn-sm btn-secondary iface-range-btn" data-range="7d">7d</button>' +
    '<button class="btn btn-sm btn-secondary iface-range-btn" data-range="30d">30d</button>';

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
      '<div id="iface-lldp-block" style="margin-bottom:0.75rem"></div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
        '<h4 style="margin:0">Throughput &amp; errors</h4>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
      '<div id="iface-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Throughput (bps)</h5>' +
      '<div id="iface-tput-chart" class="iface-chart-box"></div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Errors per interval (in / out)</h5>' +
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

  await _loadInterfaceHistoryFor(asset.id, ifName, "1h");
  document.querySelectorAll(".iface-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      document.querySelectorAll(".iface-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _loadInterfaceHistoryFor(asset.id, ifName, range);
    });
  });
}

async function _loadInterfaceHistoryFor(assetId, ifName, range, callOpts) {
  // Cancel any pending auto-refresh — manual range change shouldn't race a tick.
  if (_ifaceRefreshTimer) { clearTimeout(_ifaceRefreshTimer); _ifaceRefreshTimer = null; }
  var silent = !!(callOpts && callOpts.silent);
  var tputEl = document.getElementById("iface-tput-chart");
  var errEl = document.getElementById("iface-err-chart");
  var stats = document.getElementById("iface-stats");
  if (!tputEl) return;
  if (!silent) {
    tputEl.textContent = errEl.textContent = "Loading samples…";
    if (stats) stats.textContent = "Loading…";
  }
  var panelBody = silent ? document.getElementById("iface-panel-body") : null;
  var savedScroll = panelBody ? panelBody.scrollTop : 0;
  try {
    var data = await api.assets.interfaceHistory(assetId, ifName, range || "1h");
    var derived = _derivePerIntervalSeries(data.samples || []);
    if (stats) stats.textContent = _ifaceStatsLabel(data.samples || [], derived);
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
  } catch (err) {
    if (!silent) {
      tputEl.textContent = errEl.textContent = "Error: " + (err.message || "failed to load");
      if (stats) stats.textContent = "";
    }
    // Silent ticks leave stale content in place on transient errors.
  }
  if (panelBody) {
    panelBody.scrollTop = savedScroll;
    requestAnimationFrame(function () {
      if (panelBody.scrollTop !== savedScroll) panelBody.scrollTop = savedScroll;
    });
  }
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

// Convert cumulative octet/error counters to per-interval bps and per-interval
// error counts. Negative deltas (counter wraps or device reboots) are dropped.
function _derivePerIntervalSeries(samples) {
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

function _ifaceStatsLabel(rawSamples, derived) {
  if (rawSamples.length === 0) return "No samples in this range yet.";
  var inMax = 0, outMax = 0, inSum = 0, outSum = 0, inN = 0, outN = 0, errIn = 0, errOut = 0;
  derived.forEach(function (d) {
    if (typeof d.inBps  === "number") { inSum  += d.inBps;  inN++;  if (d.inBps  > inMax)  inMax  = d.inBps; }
    if (typeof d.outBps === "number") { outSum += d.outBps; outN++; if (d.outBps > outMax) outMax = d.outBps; }
    if (typeof d.inErr  === "number") errIn  += d.inErr;
    if (typeof d.outErr === "number") errOut += d.outErr;
  });
  return rawSamples.length + " samples · in avg " + _fmtBitsPerSec(inN ? inSum / inN : 0) +
    " · in peak " + _fmtBitsPerSec(inMax) +
    " · out avg " + _fmtBitsPerSec(outN ? outSum / outN : 0) +
    " · out peak " + _fmtBitsPerSec(outMax) +
    " · errors " + errIn + " in / " + errOut + " out";
}

// Render the LLDP neighbor card inside the interface slide-over. Empty when
// the interface has no neighbors. When the neighbor's chassis/management info
// resolves to an existing Polaris asset, the system-name link opens that
// asset's view modal so the operator can pivot from one device to the next.
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
    var rowHtml = rows.map(function (r) {
      return '<div style="display:flex;gap:0.5rem;font-size:0.8rem"><div style="width:140px;color:var(--color-text-secondary);flex-shrink:0">' + r[0] + '</div><div style="flex:1;min-width:0;word-break:break-word">' + r[1] + '</div></div>';
    }).join("");
    var matchHint = n.matchedAsset
      ? ''
      : ' <span style="font-size:0.7rem;padding:1px 5px;border-radius:3px;background:#6b728018;color:#9ca3af;border:1px solid #6b728030;margin-left:6px" title="No Polaris asset matched this neighbor by management IP, chassis MAC, or hostname">unmatched</span>';
    html +=
      '<div style="background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;padding:0.5rem 0.6rem">' +
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
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      (inPts  ? '<polyline points="' + inPts  + '" fill="none" stroke="' + inColor  + '" stroke-width="1.5"/>' : '') +
      (outPts ? '<polyline points="' + outPts + '" fill="none" stroke="' + outColor + '" stroke-width="1.5"/>' : '') +
      inSeries .map(function (d) { return '<circle cx="' + xFor(d.timestamp) + '" cy="' + yFor(d.inBps)  + '" r="1.5" fill="' + inColor  + '"/>'; }).join("") +
      outSeries.map(function (d) { return '<circle cx="' + xFor(d.timestamp) + '" cy="' + yFor(d.outBps) + '" r="1.5" fill="' + outColor + '"/>'; }).join("") +
      legend + hits +
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
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      (inPts  ? '<polyline points="' + inPts  + '" fill="none" stroke="#d32f2f" stroke-width="1.5"/>' : '') +
      (outPts ? '<polyline points="' + outPts + '" fill="none" stroke="#9b5de5" stroke-width="1.5"/>' : '') +
      inSeries .map(function (d) { return '<circle cx="' + xFor(d.timestamp) + '" cy="' + yFor(d.inErr)  + '" r="1.5" fill="#d32f2f"/>'; }).join("") +
      outSeries.map(function (d) { return '<circle cx="' + xFor(d.timestamp) + '" cy="' + yFor(d.outErr) + '" r="1.5" fill="#9b5de5"/>'; }).join("") +
      legend + hits +
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

  var rangeBtns =
    '<button class="btn btn-sm btn-primary ipsec-range-btn" data-range="24h">24h</button>' +
    '<button class="btn btn-sm btn-secondary ipsec-range-btn" data-range="7d">7d</button>' +
    '<button class="btn btn-sm btn-secondary ipsec-range-btn" data-range="30d">30d</button>';

  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
        '<h4 style="margin:0">Tunnel state &amp; throughput</h4>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
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

  await _loadIpsecHistoryFor(asset.id, tunnelName, "24h");
  document.querySelectorAll(".ipsec-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      document.querySelectorAll(".ipsec-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _loadIpsecHistoryFor(asset.id, tunnelName, range);
    });
  });
}

async function _loadIpsecHistoryFor(assetId, tunnelName, range) {
  var statusEl = document.getElementById("ipsec-status-chart");
  var inEl     = document.getElementById("ipsec-in-chart");
  var outEl    = document.getElementById("ipsec-out-chart");
  var stats    = document.getElementById("ipsec-stats");
  if (!statusEl) return;
  statusEl.textContent = inEl.textContent = outEl.textContent = "Loading samples…";
  if (stats) stats.textContent = "Loading…";
  try {
    var data = await api.assets.ipsecHistory(assetId, tunnelName, range || "24h");
    var samples = data.samples || [];
    var derived = _deriveIpsecThroughput(samples);
    if (stats) stats.textContent = _ipsecStatsLabel(samples, derived);
    var ipsecOpts = { since: data.since, until: data.until, subject: tunnelName };
    _renderIpsecStatusChart(statusEl, samples, ipsecOpts);
    _renderIpsecBpsChart(inEl,  derived, "in",  ipsecOpts);
    _renderIpsecBpsChart(outEl, derived, "out", ipsecOpts);
  } catch (err) {
    statusEl.textContent = inEl.textContent = outEl.textContent = "Error: " + (err.message || "failed to load");
    if (stats) stats.textContent = "";
  }
}

// FortiOS resets phase-1 byte counters when the SA renegotiates, so a
// negative delta is treated as a counter reset (skipped) rather than negative
// throughput. Same convention as _derivePerIntervalSeries for interfaces.
function _deriveIpsecThroughput(samples) {
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

function _ipsecStatsLabel(samples, derived) {
  if (samples.length === 0) return "No samples in this range yet.";
  var up = 0, down = 0, partial = 0, dynamic = 0;
  samples.forEach(function (s) {
    if (s.status === "up") up++;
    else if (s.status === "down") down++;
    else if (s.status === "dynamic") dynamic++;
    else partial++;
  });
  var inMax = 0, outMax = 0, inSum = 0, outSum = 0, inN = 0, outN = 0;
  derived.forEach(function (d) {
    if (typeof d.inBps  === "number") { inSum  += d.inBps;  inN++;  if (d.inBps  > inMax)  inMax  = d.inBps; }
    if (typeof d.outBps === "number") { outSum += d.outBps; outN++; if (d.outBps > outMax) outMax = d.outBps; }
  });
  // Dial-up server template — phase-2 children appear as separate `parent`-
  // bearing tunnels that we filter out, so the rollup is meaningless. Skip
  // up/partial/down counts and label the throughput line only.
  if (dynamic > 0 && up === 0 && down === 0 && partial === 0) {
    return samples.length + " samples · dial-up server (dynamic) · " +
      "in avg " + _fmtBitsPerSec(inN ? inSum / inN : 0) +
      " · in peak " + _fmtBitsPerSec(inMax) +
      " · out avg " + _fmtBitsPerSec(outN ? outSum / outN : 0) +
      " · out peak " + _fmtBitsPerSec(outMax);
  }
  var counts = up + " up / " + partial + " partial / " + down + " down";
  if (dynamic > 0) counts += " / " + dynamic + " dynamic";
  return samples.length + " samples · " + counts + " · " +
    "in avg " + _fmtBitsPerSec(inN ? inSum / inN : 0) +
    " · in peak " + _fmtBitsPerSec(inMax) +
    " · out avg " + _fmtBitsPerSec(outN ? outSum / outN : 0) +
    " · out peak " + _fmtBitsPerSec(outMax);
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
    if (s === "up") return "#2a9d8f";
    if (s === "down") return "#d32f2f";
    if (s === "dynamic") return "#7b8794"; // dial-up server template — neutral gray
    return "#f4a261";
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
      '<rect x="' + padL + '" y="2" width="10" height="6" fill="#2a9d8f"/><text x="' + (padL + 14) + '" y="8">up</text>' +
      '<rect x="' + (padL + 50) + '" y="2" width="10" height="6" fill="#f4a261"/><text x="' + (padL + 64) + '" y="8">partial</text>' +
      '<rect x="' + (padL + 110) + '" y="2" width="10" height="6" fill="#d32f2f"/><text x="' + (padL + 124) + '" y="8">down</text>' +
      (hasDynamic ? '<rect x="' + (padL + 160) + '" y="2" width="10" height="6" fill="#7b8794"/><text x="' + (padL + 174) + '" y="8">dynamic</text>' : '') +
    '</g>';
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      bars + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
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
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.5"/>' +
      values.map(function (e) { return '<circle cx="' + xFor(e.ts) + '" cy="' + yFor(e.v) + '" r="1.5" fill="' + color + '"/>'; }).join("") +
      hits +
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

async function openStorageDetailPanel(asset, mountPath) {
  if (!asset || !mountPath) return;
  _ensureStoragePanelDOM();
  var titleEl  = document.getElementById("storage-panel-title");
  var metaEl   = document.getElementById("storage-panel-meta");
  var bodyEl   = document.getElementById("storage-panel-body");
  var footerEl = document.getElementById("storage-panel-footer");
  titleEl.textContent = "Storage — " + mountPath;
  metaEl.textContent = asset.hostname || asset.ipAddress || asset.id;
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>';
  footerEl.innerHTML =
    '<button class="btn btn-sm btn-secondary" id="btn-storage-panel-close-btn">Close</button>';
  requestAnimationFrame(function () {
    document.getElementById("storage-panel-overlay").classList.add("open");
  });
  document.getElementById("btn-storage-panel-close-btn").addEventListener("click", closeStoragePanel);

  var rangeBtns =
    '<button class="btn btn-sm btn-primary storage-range-btn" data-range="1h">1h</button>' +
    '<button class="btn btn-sm btn-secondary storage-range-btn" data-range="24h">24h</button>' +
    '<button class="btn btn-sm btn-secondary storage-range-btn" data-range="7d">7d</button>' +
    '<button class="btn btn-sm btn-secondary storage-range-btn" data-range="30d">30d</button>';

  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
        '<h4 style="margin:0">Usage history</h4>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
      '<div id="storage-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Used vs total (bytes)</h5>' +
      '<div id="storage-bytes-chart" class="storage-chart-box"></div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Used %</h5>' +
      '<div id="storage-pct-chart" class="storage-chart-box"></div>' +
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

  await _loadStorageHistoryFor(asset.id, mountPath, "1h");
  document.querySelectorAll(".storage-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      document.querySelectorAll(".storage-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _loadStorageHistoryFor(asset.id, mountPath, range);
    });
  });
}

async function _loadStorageHistoryFor(assetId, mountPath, range) {
  var bytesEl = document.getElementById("storage-bytes-chart");
  var pctEl   = document.getElementById("storage-pct-chart");
  var stats   = document.getElementById("storage-stats");
  if (!bytesEl) return;
  bytesEl.textContent = pctEl.textContent = "Loading samples…";
  if (stats) stats.textContent = "Loading…";
  try {
    var data = await api.assets.storageHistory(assetId, mountPath, range || "1h");
    var samples = (data && data.samples) || [];
    if (stats) stats.textContent = _storageStatsLabel(samples);
    var opts = { since: data.since, until: data.until, subject: mountPath };
    _renderStorageBytesChart(bytesEl, samples, opts);
    _renderStoragePctChart(pctEl, samples, opts);
  } catch (err) {
    bytesEl.textContent = pctEl.textContent = "Error: " + (err.message || "failed to load");
    if (stats) stats.textContent = "";
  }
}

function _storageStatsLabel(samples) {
  if (!samples.length) return "No samples in this range yet.";
  var pcts = [];
  var latest = samples[samples.length - 1];
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
  return samples.length + " samples · latest " +
    (latestPct != null ? latestPct.toFixed(1) + "%" : "—") +
    (latest && latest.usedBytes != null && latest.totalBytes != null
      ? " (" + _fmtBytes(latest.usedBytes) + " / " + _fmtBytes(latest.totalBytes) + ")"
      : "") +
    " · avg " + (avgP != null ? avgP.toFixed(1) + "%" : "—") +
    " · min " + (minP != null ? minP.toFixed(1) + "%" : "—") +
    " · max " + (maxP != null ? maxP.toFixed(1) + "%" : "—");
}

function _renderStorageBytesChart(container, samples, opts) {
  opts = opts || {};
  var used  = samples.map(function (s) { return { ts: s.timestamp, v: s.usedBytes }; }).filter(function (e) { return typeof e.v === "number"; });
  var total = samples.map(function (s) { return { ts: s.timestamp, v: s.totalBytes }; }).filter(function (e) { return typeof e.v === "number"; });
  if (used.length === 0 && total.length === 0) {
    container.textContent = "No usage samples in this range yet.";
    return;
  }
  var W = container.clientWidth || 600, H = 180;
  var padL = 64, padR = 10, padT = 10, padB = 32;
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
  var maxV = 0;
  used.concat(total).forEach(function (e) { if (e.v > maxV) maxV = e.v; });
  if (maxV <= 0) maxV = 1;
  function tidyCeil(n) {
    var exp = Math.pow(10, Math.floor(Math.log10(n)));
    var mant = n / exp;
    var step = mant <= 1 ? 1 : mant <= 2 ? 2 : mant <= 5 ? 5 : 10;
    return step * exp;
  }
  var ceil = tidyCeil(maxV);
  function xFor(ts) { return padL + ((new Date(ts).getTime() - t0) / (t1 - t0)) * innerW; }
  function yFor(v) { return padT + innerH - (v / ceil) * innerH; }
  var usedPts  = used.map(function (e)  { return xFor(e.ts) + "," + yFor(e.v); }).join(" ");
  var totalPts = total.map(function (e) { return xFor(e.ts) + "," + yFor(e.v); }).join(" ");
  var hits = samples.map(function (s) {
    var y = padT + innerH;
    if (typeof s.usedBytes  === "number") y = Math.min(y, yFor(s.usedBytes));
    if (typeof s.totalBytes === "number") y = Math.min(y, yFor(s.totalBytes));
    return '<circle class="chart-hit" cx="' + xFor(s.timestamp) + '" cy="' + y + '" r="6" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(s.timestamp)) + '"' +
      ' data-used="'  + (typeof s.usedBytes  === "number" ? s.usedBytes  : "") + '"' +
      ' data-total="' + (typeof s.totalBytes === "number" ? s.totalBytes : "") + '"/>';
  }).join("");
  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = ceil * i / 4;
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + _fmtBytes(v) + '</text>';
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
      '<rect x="' + (padL + 10) + '" y="2" width="10" height="10" fill="var(--color-accent)"/>' +
      '<text x="' + (padL + 24) + '" y="11">Used</text>' +
      '<rect x="' + (padL + 80) + '" y="2" width="10" height="10" fill="#9b5de5"/>' +
      '<text x="' + (padL + 94) + '" y="11">Total</text>' +
    '</g>';
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      (totalPts ? '<polyline points="' + totalPts + '" fill="none" stroke="#9b5de5" stroke-width="1.5" stroke-dasharray="4 3"/>' : '') +
      (usedPts  ? '<polyline points="' + usedPts  + '" fill="none" stroke="var(--color-accent)" stroke-width="1.5"/>' : '') +
      total.map(function (e) { return '<circle cx="' + xFor(e.ts) + '" cy="' + yFor(e.v) + '" r="1.5" fill="#9b5de5"/>'; }).join("") +
      used .map(function (e) { return '<circle cx="' + xFor(e.ts) + '" cy="' + yFor(e.v) + '" r="1.5" fill="var(--color-accent)"/>'; }).join("") +
      legend + hits +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  _wireChartTooltip(container, function (target) {
    var u = target.getAttribute("data-used");
    var t = target.getAttribute("data-total");
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>Used: '  + (u !== "" ? _fmtBytes(Number(u)) : "—") + '</div>' +
      '<div>Total: ' + (t !== "" ? _fmtBytes(Number(t)) : "—") + '</div>';
  });
  _addChartScreenshotButton(container, "Storage usage (bytes)", { yAxis: "Bytes", subject: opts.subject });
  _observeChartResize(container, function (c) { _renderStorageBytesChart(c, samples, opts); });
}

function _renderStoragePctChart(container, samples, opts) {
  opts = opts || {};
  var values = samples.map(function (s) {
    var pct = (s.totalBytes && s.usedBytes != null && s.totalBytes > 0) ? (s.usedBytes / s.totalBytes) * 100 : null;
    return { ts: s.timestamp, v: pct };
  }).filter(function (e) { return typeof e.v === "number"; });
  if (values.length === 0) {
    container.textContent = "No usage % samples in this range yet.";
    return;
  }
  var W = container.clientWidth || 600, H = 180;
  var padL = 44, padR = 10, padT = 10, padB = 32;
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
  // Y axis fixed at 0–100% so charts comparing two mountpoints feel consistent.
  var ceil = 100;
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
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      '<polyline points="' + pts + '" fill="none" stroke="var(--color-accent)" stroke-width="1.5"/>' +
      values.map(function (e) { return '<circle cx="' + xFor(e.ts) + '" cy="' + yFor(e.v) + '" r="1.5" fill="var(--color-accent)"/>'; }).join("") +
      hits +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  _wireChartTooltip(container, function (target) {
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>Used: ' + Number(target.getAttribute("data-v")).toFixed(2) + '%</div>';
  });
  _addChartScreenshotButton(container, "Storage usage %", { yAxis: "Used %", subject: opts.subject });
  _observeChartResize(container, function (c) { _renderStoragePctChart(c, samples, opts); });
}

async function openIpHistoryModal(assetId, label) {
  var title = "IP History — " + (label || assetId);
  var closeFooter = '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';
  openModal(title, '<p style="color:var(--color-text-secondary);padding:1rem 0">Loading…</p>', closeFooter, { wide: true });
  try {
    var history = await api.assets.getIpHistory(assetId);
    var body;
    if (!Array.isArray(history) || history.length === 0) {
      body = '<p style="color:var(--color-text-secondary);padding:1rem 0">No IP history recorded for this asset.</p>';
    } else {
      var rows = history.map(function (h) {
        return '<tr>' +
          '<td class="mono">' + escapeHtml(h.ip || "-") + '</td>' +
          '<td>' + escapeHtml(h.source || "-") + '</td>' +
          '<td>' + (h.firstSeen ? escapeHtml(formatDate(h.firstSeen)) : "-") + '</td>' +
          '<td>' + (h.lastSeen ? escapeHtml(formatDate(h.lastSeen)) : "-") + '</td>' +
          '</tr>';
      }).join("");
      body =
        '<div class="table-wrapper"><table class="data-table"><thead><tr>' +
          '<th>IP Address</th><th>Source</th><th>First Seen</th><th>Last Seen</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    }
    openModal(title, body, closeFooter, { wide: true });
  } catch (err) {
    closeModal();
    showToast(err.message || "Failed to load IP history", "error");
  }
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

// Walk the active tab panel and extract structured content blocks. Three
// block shapes power both copy and screenshot:
//   { type: 'kv',      label, value }   from .detail-row pairs (General tab)
//   { type: 'table',   headers, rows }  from any <table> (System/Quarantine/etc.)
//   { type: 'heading', text }           from .section-label and <h1>-<h6>
// Anything else (charts, buttons, hidden nodes) is skipped.
function _extractTabBlocks(root) {
  if (!root) return [];
  var blocks = [];
  function isHidden(el) {
    if (!el) return true;
    var cs = el.ownerDocument && el.ownerDocument.defaultView
      ? el.ownerDocument.defaultView.getComputedStyle(el)
      : null;
    return cs && (cs.display === 'none' || cs.visibility === 'hidden');
  }
  function walk(node) {
    if (!node || node.nodeType !== 1) return;
    var el = node;
    if (isHidden(el)) return;
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
    } else if (b.type === 'table') {
      if (b.headers && b.headers.length) lines.push(b.headers.join(' | '));
      b.rows.forEach(function (r) { lines.push(r.join(' | ')); });
    }
  });
  navigator.clipboard.writeText(lines.join('\n')).then(function () {
    showToast("Asset details copied to clipboard");
  }).catch(function () {
    showToast("Copy failed", "error");
  });
}

function _screenshotAssetDetails(asset) {
  var blocks = _extractTabBlocks(_activeAssetPanel());
  if (blocks.length === 0) { showToast("Nothing to screenshot", "error"); return; }

  var cs = getComputedStyle(document.documentElement);
  var bgPrimary = cs.getPropertyValue("--color-bg-primary").trim() || "#ffffff";
  var bgSurface = cs.getPropertyValue("--color-surface").trim() || "#f5f5f5";
  var clrBorder = cs.getPropertyValue("--color-border").trim() || "#e0e0e0";
  var clrText   = cs.getPropertyValue("--color-text-primary").trim() || "#111";
  var clrMuted  = cs.getPropertyValue("--color-text-tertiary").trim() || "#888";

  var scale = 2;
  var pad = 24;
  var titleH = 48;
  var labelColW = 180;
  var valueColW = 480;
  var contentW = labelColW + valueColW;
  var lineH = 18;
  var rowPadV = 10;
  var headingH = 32;
  var tableHeaderH = 26;
  var tableRowH = 22;
  var tableGap = 12;
  var w = contentW + pad * 2;

  // Pre-measure each block so the canvas is sized exactly.
  // Use a throwaway context so font metrics line up with the final draw.
  var measureCanvas = document.createElement("canvas");
  var measureCtx = measureCanvas.getContext("2d");

  var laidOut = blocks.map(function (b) {
    if (b.type === 'heading') {
      return { block: b, h: headingH };
    }
    if (b.type === 'kv') {
      var lines = b.value.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
      if (lines.length === 0) lines = ['-'];
      return { block: b, lines: lines, h: Math.max(30, lines.length * lineH + rowPadV) };
    }
    if (b.type === 'table') {
      var cols = Math.max(1, (b.headers && b.headers.length) || (b.rows[0] ? b.rows[0].length : 1));
      var bodyH = b.rows.length * tableRowH;
      var hdrH = b.headers && b.headers.length ? tableHeaderH : 0;
      return { block: b, cols: cols, h: hdrH + bodyH + tableGap };
    }
    return { block: b, h: 0 };
  });

  var totalH = laidOut.reduce(function (acc, l) { return acc + l.h; }, 0);
  var h = titleH + totalH + pad;

  var canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  var ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  ctx.fillStyle = bgPrimary;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = clrText;
  ctx.font = "bold 17px system-ui,-apple-system,sans-serif";
  var tabLabel = _activeAssetTabLabel();
  var title = "Asset Details" + (asset && asset.hostname ? " — " + asset.hostname : "");
  if (tabLabel) title += " (" + tabLabel + ")";
  ctx.fillText(title, pad, 32);

  function fitText(text, maxW) {
    var t = String(text == null ? '' : text);
    while (ctx.measureText(t).width > maxW && t.length > 3) {
      t = t.slice(0, -4) + '…';
    }
    return t;
  }

  var y = titleH;
  var kvRowIndex = 0;
  laidOut.forEach(function (l) {
    var b = l.block;
    if (b.type === 'heading') {
      ctx.fillStyle = clrText;
      ctx.font = "600 13px system-ui,-apple-system,sans-serif";
      ctx.fillText(b.text, pad, y + 22);
      y += l.h;
      kvRowIndex = 0;
      return;
    }
    if (b.type === 'kv') {
      if (kvRowIndex % 2 === 1) {
        ctx.fillStyle = bgSurface;
        ctx.fillRect(pad, y, contentW, l.h);
      }
      ctx.fillStyle = clrMuted;
      ctx.font = "600 10px system-ui,-apple-system,sans-serif";
      ctx.fillText(b.label.toUpperCase(), pad + 10, y + 20);
      ctx.fillStyle = clrText;
      ctx.font = "13px system-ui,-apple-system,sans-serif";
      var maxW = valueColW - 20;
      l.lines.forEach(function (line, li) {
        ctx.fillText(fitText(line, maxW), pad + labelColW + 10, y + 20 + li * lineH);
      });
      ctx.fillStyle = clrBorder;
      ctx.fillRect(pad, y + l.h - 1, contentW, 1);
      y += l.h;
      kvRowIndex += 1;
      return;
    }
    if (b.type === 'table') {
      var colW = Math.floor(contentW / l.cols);
      var ty = y;
      if (b.headers && b.headers.length) {
        ctx.fillStyle = bgSurface;
        ctx.fillRect(pad, ty, contentW, tableHeaderH);
        ctx.fillStyle = clrMuted;
        ctx.font = "600 10px system-ui,-apple-system,sans-serif";
        for (var ci = 0; ci < l.cols; ci++) {
          var label = (b.headers[ci] || '').toUpperCase();
          ctx.fillText(fitText(label, colW - 16), pad + ci * colW + 8, ty + 17);
        }
        ty += tableHeaderH;
      }
      ctx.fillStyle = clrText;
      ctx.font = "12px system-ui,-apple-system,sans-serif";
      b.rows.forEach(function (row, ri) {
        if (ri % 2 === 1) {
          ctx.fillStyle = bgSurface;
          ctx.fillRect(pad, ty, contentW, tableRowH);
        }
        ctx.fillStyle = clrText;
        for (var c = 0; c < l.cols; c++) {
          var cell = row[c] || '';
          ctx.fillText(fitText(cell, colW - 16), pad + c * colW + 8, ty + 15);
        }
        ty += tableRowH;
      });
      ctx.strokeStyle = clrBorder;
      ctx.lineWidth = 1;
      ctx.strokeRect(pad + 0.5, y + 0.5, contentW - 1, ty - y - 1);
      y += l.h;
      kvRowIndex = 0;
      return;
    }
  });

  canvas.toBlob(function (blob) {
    if (!blob) { showToast("Screenshot failed", "error"); return; }
    if (!navigator.clipboard || typeof ClipboardItem === "undefined" || !navigator.clipboard.write) {
      showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
      return;
    }
    navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(function () {
      showToast("Screenshot copied to clipboard");
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

function viewRow(label, value, mono, alignRight, copy) {
  var style = alignRight ? ' style="text-align:right"' : '';
  var inner = escapeHtml(value || "-");
  if (copy && value) {
    inner = '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(value) + '">' + inner + '</span>';
  }
  return '<div class="detail-row"><span class="detail-label">' + escapeHtml(label) + '</span>' +
    '<span class="detail-value' + (mono ? ' mono' : '') + '"' + style + '>' + inner + '</span></div>';
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

function debounce(fn, ms) {
  var timer;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

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
  var missing = _assetsData.filter(function (a) { return a.macAddress && !a.manufacturer; });
  if (missing.length === 0) {
    showToast("All assets with MACs already have a manufacturer", "success");
    return;
  }
  var ok = await showConfirm("Run OUI manufacturer lookup for " + missing.length + " assets missing a manufacturer?");
  if (!ok) return;

  try {
    var result = await api.assets.ouiLookupAll();
    showToast("OUI resolved " + result.resolved + " of " + result.total + " assets", "success");
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

async function handleAssetExport(mode, fmt) {
  var assets, label, ok;

  if (mode === "page") {
    assets = _assetsData.slice((_assetsPage - 1) * _assetsPageSize, _assetsPage * _assetsPageSize);
    label = "page " + _assetsPage;
  } else if (mode === "filtered") {
    assets = _assetsData;
    label = assets.length + " filtered assets";
    if (assets.length > 100) {
      ok = await showConfirm("This will export " + assets.length + " assets. Continue?");
      if (!ok) return;
    }
  } else if (mode === "all") {
    ok = await showConfirm("Export the entire asset list? This may take a moment.");
    if (!ok) return;
  }

  await trackedPdfExport("Exporting assets " + fmt.toUpperCase(), async function (signal) {
    if (mode === "all") {
      var allResult = await request("GET", "/assets?limit=200", undefined, signal);
      assets = allResult.assets || allResult;
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
  return (
    '<div style="display:flex;flex-direction:column;gap:0.75rem">' +
      '<div style="font-size:0.85rem;color:var(--color-text-secondary)">' +
        'Walks <code>' + escapeHtml(a.ipAddress) + '</code> using the selected SNMP credential. Admin-only — every walk is audited. Walks are capped at 5,000 rows.' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:0.5rem;align-items:end">' +
        '<div>' +
          '<label class="form-label" for="snmp-walk-oid" style="font-size:0.8rem">Base OID</label>' +
          '<input class="form-control" id="snmp-walk-oid" type="text" value="' + escapeHtml(_snmpWalkLastOid) + '" placeholder="1.3.6.1.2.1.1">' +
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
        '<button type="button" class="btn btn-secondary btn-sm" id="btn-snmp-walk-copy" disabled>Copy results</button>' +
        '<span id="snmp-walk-status" style="font-size:0.8rem;color:var(--color-text-secondary)"></span>' +
      '</div>' +
      '<div id="snmp-walk-results"></div>' +
    '</div>'
  );
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
      '<table class="data-table" style="font-size:0.82rem">' +
        '<thead><tr><th>OID</th><th>Type</th><th>Value</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>' +
    '</div>';
}

function _wireSnmpWalkTab(a) {
  var walkBtn = document.getElementById("btn-snmp-walk");
  if (!walkBtn) return; // tab not rendered (e.g. asset has no IP)
  var abortBtn = document.getElementById("btn-snmp-walk-abort");
  var copyBtn = document.getElementById("btn-snmp-walk-copy");
  var statusEl = document.getElementById("snmp-walk-status");
  var lastResult = null;
  var activeController = null;

  walkBtn.addEventListener("click", async function () {
    var oid = (document.getElementById("snmp-walk-oid").value || "").trim();
    var credId = document.getElementById("snmp-walk-cred").value;
    var maxRows = parseInt(document.getElementById("snmp-walk-max").value, 10) || 500;
    if (!oid) { showToast("Enter a base OID", "error"); return; }
    if (!credId) { showToast("Select an SNMP credential", "error"); return; }
    if (!/^\d+(\.\d+)*$/.test(oid)) { showToast("OID must be numeric (e.g. 1.3.6.1.2.1.1)", "error"); return; }

    _snmpWalkLastOid = oid;
    _snmpWalkLastCredId = credId;
    walkBtn.disabled = true;
    walkBtn.textContent = "Walking…";
    if (copyBtn) copyBtn.disabled = true;
    if (abortBtn) { abortBtn.style.display = ""; abortBtn.disabled = false; }
    statusEl.textContent = "Walking " + a.ipAddress + " " + oid + "…";
    document.getElementById("snmp-walk-results").innerHTML = "";

    activeController = new AbortController();
    var thisController = activeController;

    try {
      var result = await api.assets.snmpWalk(a.id, { credentialId: credId, oid: oid, maxRows: maxRows }, thisController.signal);
      lastResult = result;
      statusEl.textContent = result.rows.length + " row(s) in " + result.durationMs + " ms" + (result.truncated ? " (truncated)" : "");
      _renderSnmpWalkRows(result);
      if (copyBtn) copyBtn.disabled = !result.rows.length;
    } catch (err) {
      lastResult = null;
      var aborted = err && (err.name === "AbortError" || thisController.signal.aborted);
      if (aborted) {
        statusEl.textContent = "Walk aborted.";
        document.getElementById("snmp-walk-results").innerHTML =
          '<p class="empty-state" style="padding:0.75rem 0">Walk aborted.</p>';
      } else {
        statusEl.textContent = "";
        showToast(err.message || "SNMP walk failed", "error");
        document.getElementById("snmp-walk-results").innerHTML =
          '<p class="empty-state" style="padding:0.75rem 0;color:var(--color-danger,#c0392b)">' +
            escapeHtml(err.message || "SNMP walk failed") +
          '</p>';
      }
    } finally {
      if (activeController === thisController) activeController = null;
      walkBtn.disabled = false;
      walkBtn.textContent = "Walk";
      if (abortBtn) { abortBtn.style.display = "none"; abortBtn.disabled = false; }
    }
  });

  if (abortBtn) {
    abortBtn.addEventListener("click", function () {
      if (!activeController) return;
      abortBtn.disabled = true;
      statusEl.textContent = "Aborting…";
      activeController.abort();
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener("click", async function () {
      if (!lastResult || !lastResult.rows.length) return;
      var text = lastResult.rows.map(function (r) {
        return r.oid + " = " + r.type + ": " + r.value;
      }).join("\n");
      try {
        await navigator.clipboard.writeText(text);
        showToast("Copied " + lastResult.rows.length + " row(s)", "success");
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

function _assetSourcesTabHTML(sources, assetId) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return '<div class="empty-state" style="padding:1rem">No source rows on file for this asset. Phase-1 backfill runs at startup; check the Events log if you expected entries here.</div>';
  }
  // Split is admin-only and only meaningful when there's more than one
  // source on the asset (the backend rejects splitting the only source).
  // Manual sources can never be split (backend also rejects those).
  var canSplit = isAdmin() && sources.length > 1;
  return sources.map(function (s) {
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
      '<div class="section-block" style="margin-bottom:1rem">' +
        '<div class="section-label" style="margin-bottom:0.25rem">Quarantine Status</div>' +
        (a.quarantineReason ? '<p style="margin:0 0 0.5rem;color:var(--color-text-secondary)">Reason: ' + escapeHtml(a.quarantineReason) + '</p>' : '') +
        (a.quarantinedAt ? '<p style="margin:0 0 0.5rem;font-size:0.82rem;color:var(--color-text-secondary)">Quarantined ' + formatDate(a.quarantinedAt) + (a.quarantinedBy ? ' by ' + escapeHtml(a.quarantinedBy) : '') + '</p>' : '') +
        '<div class="section-label" style="margin:0.75rem 0 0.25rem">FortiGate Push Targets</div>' +
        targetsHtml +
      '</div>';
  }

  var macsHtml = macs.length
    ? '<div class="mono" style="font-size:0.82rem">' + escapeHtml(macs.join(", ")) + '</div>'
    : '<em style="color:var(--color-text-secondary)">No MACs on record — quarantine push requires at least one MAC.</em>';

  var sightingsSection =
    '<div class="section-block" style="margin-bottom:1rem">' +
      '<div class="section-label" style="margin-bottom:0.25rem">DHCP Sightings</div>' +
      '<div id="asset-sightings-container"><em style="color:var(--color-text-secondary)">Loading…</em></div>' +
    '</div>';

  var isInfra = a.assetType === "firewall" || a.assetType === "switch" || a.assetType === "access_point";
  var actionBtn = isQ
    ? '<button class="btn btn-secondary" id="btn-qtn-release">Release Quarantine</button>'
    : (macs.length && !isInfra ? '<button class="btn btn-danger" id="btn-qtn-quarantine">Quarantine This Asset</button>' : '');
  var verifyBtn = isQ ? '<button class="btn btn-secondary" id="btn-qtn-verify">Verify Push</button>' : '';

  return '<div style="padding:0.5rem 0">' +
    statusSection +
    '<div class="section-block" style="margin-bottom:1rem">' +
      '<div class="section-label" style="margin-bottom:0.25rem">Associated MACs</div>' +
      macsHtml +
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
      if (!rows.length) {
        container.innerHTML = '<p class="empty-state" style="margin:0">No DHCP sightings recorded yet.</p>';
        return;
      }
      container.innerHTML =
        '<table class="data-table" style="font-size:0.82rem"><thead><tr><th>FortiGate</th><th>IP Address</th><th>VLAN</th><th>Source</th><th>Last Seen</th></tr></thead><tbody>' +
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
  telemetryIntervalSeconds:  60,
  systemInfoIntervalSeconds: 600,
  sampleRetentionDays:       30,
  telemetryRetentionDays:    30,
  systemInfoRetentionDays:   30,
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
  return '<div class="monset-section">' +
    '<h3 style="margin-bottom:0.25rem">Manual Monitoring</h3>' +
    '<p class="hint" style="margin:0 0 1rem 0;color:var(--color-text-tertiary)">Settings applied to assets without an integration source — manually-created assets, or assets whose origin integration was deleted.</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem 1rem">' +
      _monsetField("monset-manual-intervalSeconds",           "Probe interval",         "seconds",                       values.intervalSeconds,           1,   86400, false) +
      _monsetField("monset-manual-failureThreshold",          "Failure threshold",      "consecutive failures",          values.failureThreshold,          1,   100,   false) +
      _monsetField("monset-manual-probeTimeoutMs",            "Probe timeout",          "ms (warning under 500)",        values.probeTimeoutMs,            100, 60000, true)  +
      _monsetField("monset-manual-telemetryIntervalSeconds",  "Telemetry interval",     "seconds (CPU + memory + temp)", values.telemetryIntervalSeconds,  15,  86400, false) +
      _monsetField("monset-manual-systemInfoIntervalSeconds", "System info interval",   "seconds (interfaces + storage)",values.systemInfoIntervalSeconds, 60,  86400, false) +
      _monsetField("monset-manual-sampleRetentionDays",       "Probe sample retention", "days (0 = forever)",            values.sampleRetentionDays,       0,   3650,  false) +
      _monsetField("monset-manual-telemetryRetentionDays",    "Telemetry retention",    "days (0 = forever)",            values.telemetryRetentionDays,    0,   3650,  false) +
      _monsetField("monset-manual-systemInfoRetentionDays",   "System info retention",  "days (0 = forever)",            values.systemInfoRetentionDays,   0,   3650,  false) +
    '</div>' +
    '<hr style="margin:1rem 0;border:none;border-top:1px solid var(--color-border)">' +
    _polarisPollingFourStreamHTML("monset-manual-", "manual", values) +
    '<p class="hint" style="margin:0 0 0.75rem 0;color:var(--color-text-tertiary)">Manual tier accepts any method — operator picks per stream and supplies a credential at the asset level (or relies on ICMP).</p>' +
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
  var body = {
    intervalSeconds:           _monsetReadField("monset-manual-intervalSeconds",           MON_TIER_DEFAULTS.intervalSeconds),
    failureThreshold:          _monsetReadField("monset-manual-failureThreshold",          MON_TIER_DEFAULTS.failureThreshold),
    probeTimeoutMs:            _monsetReadField("monset-manual-probeTimeoutMs",            MON_TIER_DEFAULTS.probeTimeoutMs),
    telemetryIntervalSeconds:  _monsetReadField("monset-manual-telemetryIntervalSeconds",  MON_TIER_DEFAULTS.telemetryIntervalSeconds),
    systemInfoIntervalSeconds: _monsetReadField("monset-manual-systemInfoIntervalSeconds", MON_TIER_DEFAULTS.systemInfoIntervalSeconds),
    sampleRetentionDays:       _monsetReadField("monset-manual-sampleRetentionDays",       MON_TIER_DEFAULTS.sampleRetentionDays),
    telemetryRetentionDays:    _monsetReadField("monset-manual-telemetryRetentionDays",    MON_TIER_DEFAULTS.telemetryRetentionDays),
    systemInfoRetentionDays:   _monsetReadField("monset-manual-systemInfoRetentionDays",   MON_TIER_DEFAULTS.systemInfoRetentionDays),
  };
  Object.assign(body, _polarisReadPollingFourStream("monset-manual-"));
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
  var rowHTML = rows.length === 0
    ? '<tr><td colspan="4" class="empty-state" style="text-align:center;padding:1rem">No class overrides configured.</td></tr>'
    : rows.map(function (o) {
        var sourceLabel = o.integration
          ? escapeHtml(o.integration.name) + ' <span class="hint" style="opacity:0.65">(' + escapeHtml(o.integration.type) + ')</span>'
          : '<em>Manual</em>';
        var classLabel = ASSET_TYPE_LABELS[o.assetType] || o.assetType;
        return '<tr>' +
          '<td>' + escapeHtml(classLabel) + '</td>' +
          '<td>' + sourceLabel + '</td>' +
          '<td><span class="hint" style="font-size:0.78rem;color:var(--color-text-tertiary)">' + escapeHtml(_monsetOverrideSummary(o)) + '</span></td>' +
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
    '<p class="hint" style="margin:0 0 0.5rem 0;color:var(--color-text-tertiary)">Per-(class + asset source) overrides. Take priority over the integration tier and the manual tier; per-asset overrides take priority over these.</p>' +
    '<table class="data-table" style="width:100%;border-collapse:collapse">' +
      '<thead><tr>' +
        '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border)">Class</th>' +
        '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border)">Asset Source</th>' +
        '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border)">Overrides</th>' +
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
    probeTimeoutMs:            "timeout",
    telemetryIntervalSeconds:  "telemetry",
    systemInfoIntervalSeconds: "sysinfo",
    sampleRetentionDays:       "probe-retain",
    telemetryRetentionDays:    "telem-retain",
    systemInfoRetentionDays:   "sysinfo-retain",
    responseTimePolling:       "rt-poll",
    telemetryPolling:          "tel-poll",
    interfacesPolling:         "if-poll",
    lldpPolling:               "lldp-poll",
  };
  Object.keys(labels).forEach(function (k) {
    if (o[k] !== null && o[k] !== undefined) parts.push(labels[k] + "=" + o[k]);
  });
  return parts.length === 0 ? "(empty — all fields inherited)" : parts.join(", ");
}

function _monsetOpenOverrideEditor(existing) {
  var isEdit = !!existing;
  var classOpts = Object.keys(ASSET_TYPE_LABELS).map(function (key) {
    var sel = (existing && existing.assetType === key) ? " selected" : "";
    return '<option value="' + escapeHtml(key) + '"' + sel + '>' + escapeHtml(ASSET_TYPE_LABELS[key]) + '</option>';
  }).join("");
  // Default to "Manual" on add; preserve the row's source on edit. Each
  // option carries data-type so the polling-block re-renderer below can
  // figure out the asset-source kind without re-querying the integrations
  // list.
  var sourceOpts = '<option value="null" data-type=""' + ((existing && existing.integrationId === null) || !existing ? " selected" : "") + '>Manual</option>' +
    _monsetIntegrations.map(function (intg) {
      var sel = (existing && existing.integrationId === intg.id) ? " selected" : "";
      return '<option value="' + escapeHtml(intg.id) + '" data-type="' + escapeHtml(intg.type) + '"' + sel + '>' + escapeHtml(intg.name) + ' (' + escapeHtml(intg.type) + ')</option>';
    }).join("");
  var v = existing || {};
  // Initial source kind: if editing, use the row's integration type;
  // otherwise default to manual (matches the default-selected source option).
  var initialSourceKind = (existing && existing.integration && existing.integration.type) || "manual";
  var body =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem 1rem">' +
      '<div class="form-group"><label for="monset-ov-class">Class</label>' +
        '<select id="monset-ov-class"' + (isEdit ? " disabled" : "") + '>' + classOpts + '</select>' +
      '</div>' +
      '<div class="form-group"><label for="monset-ov-source">Asset Source</label>' +
        '<select id="monset-ov-source"' + (isEdit ? " disabled" : "") + '>' + sourceOpts + '</select>' +
      '</div>' +
    '</div>' +
    (isEdit ? '<p class="hint" style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.25rem 0 0.75rem 0">Class and source are fixed for an existing override; delete and re-create to change them.</p>' : '') +
    '<p class="hint" style="margin:0.5rem 0 0.75rem 0;color:var(--color-text-tertiary)">Leave a field blank to inherit from the source\'s tier.</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem 1rem">' +
      _monsetField("monset-ov-intervalSeconds",           "Probe interval",         "seconds",                       v.intervalSeconds,           1,   86400, false) +
      _monsetField("monset-ov-failureThreshold",          "Failure threshold",      "consecutive failures",          v.failureThreshold,          1,   100,   false) +
      _monsetField("monset-ov-probeTimeoutMs",            "Probe timeout",          "ms (warning under 500)",        v.probeTimeoutMs,            100, 60000, true)  +
      _monsetField("monset-ov-telemetryIntervalSeconds",  "Telemetry interval",     "seconds (CPU + memory + temp)", v.telemetryIntervalSeconds,  15,  86400, false) +
      _monsetField("monset-ov-systemInfoIntervalSeconds", "System info interval",   "seconds (interfaces + storage)",v.systemInfoIntervalSeconds, 60,  86400, false) +
      _monsetField("monset-ov-sampleRetentionDays",       "Probe sample retention", "days (0 = forever)",            v.sampleRetentionDays,       0,   3650,  false) +
      _monsetField("monset-ov-telemetryRetentionDays",    "Telemetry retention",    "days (0 = forever)",            v.telemetryRetentionDays,    0,   3650,  false) +
      _monsetField("monset-ov-systemInfoRetentionDays",   "System info retention",  "days (0 = forever)",            v.systemInfoRetentionDays,   0,   3650,  false) +
    '</div>' +
    '<hr style="margin:1rem 0;border:none;border-top:1px solid var(--color-border)">' +
    '<div id="monset-ov-polling-block">' + _polarisPollingFourStreamHTML("monset-ov-", initialSourceKind, v) + '</div>';
  var footer = '<button class="btn btn-secondary" id="btn-monset-ov-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-monset-ov-save">' + (isEdit ? "Save Changes" : "Create Override") + '</button>';
  openModal(isEdit ? "Edit Class Override" : "Add Class Override", body, footer);
  document.getElementById("btn-monset-ov-cancel").addEventListener("click", _monsetRender);
  document.getElementById("btn-monset-ov-save").addEventListener("click", function () {
    _monsetSaveOverride(existing);
  });
  // Re-render the polling block when the source changes — methods compatible
  // with the new source replace the old options. Disabled in edit mode (the
  // source picker itself is disabled).
  if (!isEdit) {
    var srcSel = document.getElementById("monset-ov-source");
    if (srcSel) {
      srcSel.addEventListener("change", function () {
        var opt = srcSel.options[srcSel.selectedIndex];
        var kind = (opt && opt.getAttribute("data-type")) || "manual";
        // Preserve currently-typed values that survive the new compat
        // matrix; everything else falls back to "Inherit".
        var currentValues = _polarisReadPollingFourStream("monset-ov-");
        var allowed = _POLLING_COMPAT[kind] || _POLLING_COMPAT.manual;
        ["responseTimePolling", "telemetryPolling", "interfacesPolling", "lldpPolling"].forEach(function (k) {
          if (currentValues[k] && allowed.indexOf(currentValues[k]) === -1) currentValues[k] = null;
        });
        var block = document.getElementById("monset-ov-polling-block");
        if (block) block.innerHTML = _polarisPollingFourStreamHTML("monset-ov-", kind, currentValues);
      });
    }
  }
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
  var fields = {
    intervalSeconds:           readOptional("monset-ov-intervalSeconds"),
    failureThreshold:          readOptional("monset-ov-failureThreshold"),
    probeTimeoutMs:            readOptional("monset-ov-probeTimeoutMs"),
    telemetryIntervalSeconds:  readOptional("monset-ov-telemetryIntervalSeconds"),
    systemInfoIntervalSeconds: readOptional("monset-ov-systemInfoIntervalSeconds"),
    sampleRetentionDays:       readOptional("monset-ov-sampleRetentionDays"),
    telemetryRetentionDays:    readOptional("monset-ov-telemetryRetentionDays"),
    systemInfoRetentionDays:   readOptional("monset-ov-systemInfoRetentionDays"),
  };
  Object.assign(fields, _polarisReadPollingFourStream("monset-ov-"));
  try {
    if (existing) {
      var updated = await api.monitorSettings.updateClassOverride(existing.id, fields);
      var idx = _monsetOverrides.findIndex(function (o) { return o.id === existing.id; });
      if (idx >= 0) _monsetOverrides[idx] = updated;
      showToast("Class override updated");
    } else {
      var assetType    = document.getElementById("monset-ov-class").value;
      var sourceVal    = document.getElementById("monset-ov-source").value;
      var integrationId = sourceVal === "null" ? null : sourceVal;
      var created = await api.monitorSettings.createClassOverride(
        Object.assign({ assetType: assetType, integrationId: integrationId }, fields)
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
  var btn = document.getElementById(monitored ? "assets-bulk-monitor-on-btn" : "assets-bulk-monitor-off-btn");
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
