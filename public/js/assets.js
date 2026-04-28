/**
 * public/js/assets.js — Asset management page
 */

var _assetsPageSize = 15;
var _assetsPage = 1;
var _assetsData = [];
var _assetsSF = null;
var _assetsSelected = new Set();

function _saveAssetsPrefs() {
  if (!currentUsername) return;
  try {
    localStorage.setItem("shelob-prefs-assets-" + currentUsername, JSON.stringify({
      pageSize: _assetsPageSize,
      status: document.getElementById("filter-status").value,
      type: document.getElementById("filter-type").value,
      search: document.getElementById("filter-search").value,
      creator: document.getElementById("filter-creator").value,
      sortKey: _assetsSF ? _assetsSF._sortKey : null,
      sortDir: _assetsSF ? _assetsSF._sortDir : "asc",
      sfFilters: _assetsSF ? Object.assign({}, _assetsSF._filters) : {},
    }));
  } catch (_) {}
}

function _restoreAssetsPrefs() {
  if (!currentUsername) return;
  var raw;
  try { raw = localStorage.getItem("shelob-prefs-assets-" + currentUsername); } catch (_) { return; }
  if (!raw) return;
  try {
    var p = JSON.parse(raw);
    if (p.pageSize) {
      _assetsPageSize = p.pageSize;
      var psSel = document.getElementById("filter-pagesize");
      if (psSel) psSel.value = String(p.pageSize);
    }
    if (p.status)  { var sSel = document.getElementById("filter-status");  if (sSel) sSel.value = p.status; }
    if (p.type)    { var tSel = document.getElementById("filter-type");    if (tSel) tSel.value = p.type; }
    if (p.search)  { var sEl  = document.getElementById("filter-search");  if (sEl)  sEl.value  = p.search; }
    if (p.creator) { var cSel = document.getElementById("filter-creator"); if (cSel) cSel.value = p.creator; }
    if (_assetsSF) {
      if (p.sortKey) _assetsSF._sortKey = p.sortKey;
      if (p.sortDir) _assetsSF._sortDir = p.sortDir;
      if (p.sfFilters) {
        _assetsSF._filters = p.sfFilters;
        if (_assetsSF._thead) {
          _assetsSF._thead.querySelectorAll("th[data-sf-key]").forEach(function (th) {
            var inp = th.querySelector(".sf-filter");
            if (inp && p.sfFilters[th.getAttribute("data-sf-key")]) inp.value = p.sfFilters[th.getAttribute("data-sf-key")];
          });
        }
      }
      _assetsSF._updateIcons();
    }
  } catch (_) {}
}

document.addEventListener("DOMContentLoaded", async function () {
  _assetsSF = new TableSF("assets-tbody", function () { _assetsPage = 1; renderAssetsPage(); _saveAssetsPrefs(); });
  // MAC tooltips are promoted to <body>, so delegate on document so the
  // delete button works regardless of where the tooltip lives.
  document.addEventListener("click", _handleMacDeleteClick);
  document.getElementById("assets-bulk-delete-btn").addEventListener("click", bulkDeleteAssets);
  document.getElementById("assets-bulk-edit-btn").addEventListener("click", openBulkEditModal);
  var bmOn  = document.getElementById("assets-bulk-monitor-on-btn");
  var bmOff = document.getElementById("assets-bulk-monitor-off-btn");
  if (bmOn)  bmOn.addEventListener("click",  function () { bulkSetMonitoring(true); });
  if (bmOff) bmOff.addEventListener("click", function () { bulkSetMonitoring(false); });
  var settingsBtn = document.getElementById("btn-asset-settings");
  if (settingsBtn) settingsBtn.addEventListener("click", openAssetSettingsModal);
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
  var ouiBtn = document.getElementById("btn-oui-lookup");
  if (ouiBtn) ouiBtn.addEventListener("click", bulkOuiLookup);
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
  document.getElementById("filter-status").addEventListener("change", function () { _assetsPage = 1; loadAssets(); _saveAssetsPrefs(); });
  document.getElementById("filter-type").addEventListener("change", function () { _assetsPage = 1; loadAssets(); _saveAssetsPrefs(); });
  document.getElementById("filter-search").addEventListener("input", debounce(function () { _assetsPage = 1; loadAssets(); _saveAssetsPrefs(); }, 300));
  document.getElementById("filter-creator").addEventListener("change", function () { _assetsPage = 1; loadAssets(); _saveAssetsPrefs(); });
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
    var statusVal = document.getElementById("filter-status").value;
    var apiStatus = (statusVal === "hide-decommissioned" || !statusVal) ? undefined : statusVal;
    var filters = {
      status: apiStatus,
      assetType: document.getElementById("filter-type").value || undefined,
      search: document.getElementById("filter-search").value || undefined,
      createdBy: document.getElementById("filter-creator").value || undefined,
      limit: 10000,
    };
    var result = await api.assets.list(filters);
    _assetsData = (result.assets || result).map(function (a) {
      a._server = a.location || a.learnedLocation || "";
      return a;
    });
    if (statusVal === "hide-decommissioned") {
      _assetsData = _assetsData.filter(function (a) { return a.status !== "decommissioned" && a.status !== "disabled"; });
    }
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
      '<td>' + assetTypeBadge(a.assetType) + '</td>' +
      '<td>' + assetStatusBadge(a) + '</td>' +
      '<td>' + assetMonitorBadge(a) + '</td>' +
      '<td>' + escapeHtml(a.location || a.learnedLocation || "-") + '</td>' +
      '<td>' + (a.lastSeen ? formatDate(a.lastSeen) : "-") + '</td>' +
      '<td class="actions">' +
        _reserveActionHTML(a) +
        (canManageAssets() ? '<button class="btn btn-sm btn-secondary" onclick="openEditModal(\'' + a.id + '\')">Edit</button>' +
        (a.ipAddress && !a.dnsName ? '<button class="btn btn-sm btn-secondary" onclick="singleDnsLookup(\'' + a.id + '\', \'' + escapeHtml(a.hostname || a.ipAddress) + '\')" title="Reverse DNS lookup (IP → hostname)">DNS</button>' : '') +
        (!a.ipAddress && (a.dnsName || a.hostname) ? '<button class="btn btn-sm btn-secondary" onclick="singleForwardLookup(\'' + a.id + '\', \'' + escapeHtml(a.dnsName || a.hostname) + '\')" title="Forward DNS lookup (hostname → IP)">PTR</button>' : '') +
        (a.macAddress && !a.manufacturer ? '<button class="btn btn-sm btn-secondary" onclick="singleOuiLookup(\'' + a.id + '\', \'' + escapeHtml(a.macAddress) + '\')" title="OUI manufacturer lookup">OUI</button>' : '') +
        '<button class="btn btn-sm btn-danger" onclick="confirmDelete(\'' + a.id + '\', \'' + escapeHtml(a.hostname || a.assetTag || a.ipAddress || "this asset") + '\')">Del</button>' : '') +
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
}

// Reserve / Unreserve cell. Returns "" when there's nothing to render so the
// caller can splat it inside the Actions cell unconditionally. The visibility
// rules:
//   - readonly users see no button
//   - asset must have an IP and a non-deprecated containing subnet
//   - if there's already an active reservation, render Unreserve; networkadmin+
//     can release any reservation, everyone else only their own (the backend
//     re-checks this — the disabled state is just a UX hint)
//   - dhcp_lease reservations are treated as "no real reservation" — leases
//     roll over, so the user should be able to promote one into a manual
//     reservation. The reserve endpoint releases the lease in-place.
function _reserveActionHTML(a) {
  if (!canReserveIps()) return '';
  if (!a.ipAddress) return '';
  var ctx = a.ipContext;
  if (!ctx || !ctx.subnetId) return '';
  if (ctx.reservation && ctx.reservation.sourceType !== 'dhcp_lease') {
    var canUnreserve = canManageNetworks() || ctx.reservation.createdBy === currentUsername;
    var title = canUnreserve
      ? 'Release this reservation'
      : 'Reserved by ' + (ctx.reservation.createdBy || 'system') + ' — only they (or a network admin) can release it';
    return '<button class="btn btn-sm btn-secondary" onclick="unreserveAssetIp(\'' + a.id + '\')" title="' + escapeHtml(title) + '"' + (canUnreserve ? '' : ' disabled') + '>Unreserve</button>';
  }
  var reserveTitle = ctx.reservation && ctx.reservation.sourceType === 'dhcp_lease'
    ? 'Promote DHCP lease to a manual reservation in ' + (ctx.subnetCidr || '')
    : 'Reserve this IP in ' + (ctx.subnetCidr || '');
  return '<button class="btn btn-sm btn-secondary" onclick="reserveAssetIp(\'' + a.id + '\')" title="' + escapeHtml(reserveTitle) + '">Reserve</button>';
}

async function reserveAssetIp(id) {
  try {
    await api.assets.reserve(id);
    showToast('Reservation created');
    loadAssets();
  } catch (err) {
    showToast(err.message || 'Reservation failed', 'error');
  }
}

async function unreserveAssetIp(id) {
  var ok = await showConfirm('Release this reservation?');
  if (!ok) return;
  try {
    await api.assets.unreserve(id);
    showToast('Reservation released');
    loadAssets();
  } catch (err) {
    showToast(err.message || 'Release failed', 'error');
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

function assetTypeBadge(type) {
  var label = ASSET_TYPE_LABELS[type] || type;
  return '<span class="badge badge-asset-type">' + escapeHtml(label) + '</span>';
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

// Three-state monitoring pill matching the user-facing taxonomy:
//   monitored=false                     → grey  "Unmonitored"
//   monitored=true, no probe yet        → blue  "Pending"
//   monitored=true, status="up"         → green "Monitored"
//   monitored=true, status="down"       → red   "Down"
function assetMonitorBadge(asset) {
  if (!asset || asset.monitored === false || asset.monitored == null) {
    return '<span class="badge badge-unmonitored">Unmonitored</span>';
  }
  var s = asset.monitorStatus || "unknown";
  var bits = [];
  if (asset.monitorType) bits.push("Type: " + asset.monitorType);
  if (typeof asset.lastResponseTimeMs === "number") bits.push("Last RTT: " + asset.lastResponseTimeMs + " ms");
  if (asset.lastMonitorAt) bits.push("Last poll: " + new Date(asset.lastMonitorAt).toLocaleString());
  var title = bits.length ? ' title="' + escapeHtml(bits.join("\n")) + '"' : "";
  if (s === "up")   return '<span class="badge badge-monitored"' + title + '>Monitored</span>';
  if (s === "down") return '<span class="badge badge-monitor-down"' + title + '>Down</span>';
  return '<span class="badge badge-monitor-pending"' + title + '>Pending</span>';
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
    var typeSel = document.getElementById("f-monitorType");
    // Locked dropdowns are disabled; their value is still readable via .value.
    if (typeSel) data.monitorType = typeSel.value || null;
    var credSel = document.getElementById("f-monitorCredential");
    if (credSel) data.monitorCredentialId = credSel.value || null;
    var ivEl = document.getElementById("f-monitorInterval");
    if (ivEl) {
      var iv = parseInt(ivEl.value, 10);
      data.monitorIntervalSec = Number.isFinite(iv) && iv >= 5 ? iv : null;
    }
  }
  return data;
}

// ─── Tabbed asset modal scaffolding ────────────────────────────────────────

function _isMonitorIntegrationLocked(asset) {
  return !!(asset && asset.discoveredByIntegrationId &&
    (asset.monitorType === "fortimanager" ||
     asset.monitorType === "fortigate" ||
     asset.monitorType === "activedirectory"));
}

function assetMonitoringFormHTML(asset) {
  var locked = _isMonitorIntegrationLocked(asset);
  var integrationName = (asset && asset.discoveredByIntegration && asset.discoveredByIntegration.name) || "";
  var monitorType = asset && asset.monitorType ? asset.monitorType : "";
  var credId = asset && asset.monitorCredentialId ? asset.monitorCredentialId : "";
  var interval = asset && asset.monitorIntervalSec != null ? asset.monitorIntervalSec : "";
  var monitored = asset && asset.monitored ? " checked" : "";

  var typeSelect;
  if (locked) {
    var sourcePrefix =
      monitorType === "fortigate"        ? "FortiGate: " :
      monitorType === "activedirectory"  ? "Active Directory: " :
                                            "FortiManager: ";
    var lockedLabel = sourcePrefix + (integrationName || "(unknown)");
    var lockedHint = monitorType === "activedirectory"
      ? 'Monitoring source is locked because this host was discovered by ' +
        escapeHtml(integrationName || "an integration") + '. Probes reuse the integration’s bind credentials — WinRM for Windows hosts, SSH for realm-joined Linux hosts. Bind DN must be in UPN form, e.g. <code>user@domain.com</code>.'
      : 'Monitoring source is locked because this firewall was discovered by ' +
        escapeHtml(integrationName || "an integration") + '. Probes go through the integration’s direct-mode API token.';
    typeSelect =
      '<select id="f-monitorType" disabled>' +
        '<option value="' + escapeHtml(monitorType) + '" selected>' + escapeHtml(lockedLabel) + '</option>' +
      '</select>' +
      '<p class="hint">' + lockedHint + '</p>';
  } else {
    typeSelect =
      '<select id="f-monitorType">' +
        '<option value=""'      + (monitorType === ""      ? " selected" : "") + '>— none —</option>' +
        '<option value="icmp"'  + (monitorType === "icmp"  ? " selected" : "") + '>ICMP (no credentials)</option>' +
        '<option value="snmp"'  + (monitorType === "snmp"  ? " selected" : "") + '>SNMP</option>' +
        '<option value="winrm"' + (monitorType === "winrm" ? " selected" : "") + '>WinRM</option>' +
        '<option value="ssh"'   + (monitorType === "ssh"   ? " selected" : "") + '>SSH</option>' +
      '</select>';
  }

  return (
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" id="f-monitored"' + monitored + '>' +
        '<span>Enable monitoring for this asset</span>' +
      '</label>' +
      '<p class="hint">A successful probe means the credential authenticated. Probes write a sample row each cycle; failed probes count as packet loss.</p>' +
    '</div>' +
    '<div class="form-group"><label>Monitor Type</label>' + typeSelect + '</div>' +
    '<div class="form-group" id="f-monitorCredential-wrap"' + (locked ? ' style="display:none"' : '') + '>' +
      '<label>Credential</label>' +
      '<select id="f-monitorCredential" data-current-id="' + escapeHtml(credId) + '">' +
        '<option value="">— none —</option>' +
      '</select>' +
      '<p class="hint">Add credentials in <a href="/server-settings.html?tab=credentials">Server Settings → Credentials</a>.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Poll Interval Override (seconds)</label>' +
      '<input type="number" id="f-monitorInterval" min="5" max="86400" value="' + escapeHtml(String(interval)) + '" placeholder="leave blank for global default" style="max-width:240px">' +
      '<p class="hint">Default is set in <a href="/events.html?tab=settings">Events → Settings</a>. Minimum 5 seconds.</p>' +
    '</div>'
  );
}

async function _wireMonitorEditTab(asset) {
  await _ensureCredentials();
  var locked = _isMonitorIntegrationLocked(asset);
  var monChk = document.getElementById("f-monitored");
  var typeSel = document.getElementById("f-monitorType");
  var credWrap = document.getElementById("f-monitorCredential-wrap");
  var credSel = document.getElementById("f-monitorCredential");
  var intervalEl = document.getElementById("f-monitorInterval");

  function refresh() {
    var enabled = !!(monChk && monChk.checked);
    var t = typeSel ? typeSel.value : "";
    var needsCred = (t === "snmp" || t === "winrm" || t === "ssh");
    if (typeSel) typeSel.disabled = locked || !enabled;
    if (intervalEl) intervalEl.disabled = !enabled;
    if (credWrap) credWrap.style.display = (enabled && needsCred && !locked) ? "block" : "none";
    if (credSel) credSel.disabled = !enabled;
    if (enabled && needsCred && credSel) {
      var current = credSel.getAttribute("data-current-id") || "";
      credSel.innerHTML = _credentialOptionsFor(t, current);
    }
  }
  if (typeSel && !locked) typeSel.addEventListener("change", refresh);
  if (monChk) monChk.addEventListener("change", refresh);
  refresh();
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
    _loadMonitorHistoryFor(assetId, _currentMonitorSelection());
  }, ms);
}

function _scheduleAssetSystemRefresh(assetId, asset, ms) {
  if (_assetSystemRefreshTimer) clearTimeout(_assetSystemRefreshTimer);
  _assetSystemRefreshTimer = setTimeout(function tick() {
    if (!_isOverlayOpen("asset-panel-overlay") || !_isCurrentAsset(assetId)) { _assetSystemRefreshTimer = null; return; }
    if (document.hidden) { _assetSystemRefreshTimer = setTimeout(tick, 30000); return; }
    _loadSystemTabFor(assetId, _currentSystemTabRange(), asset);
  }, ms);
}

function _scheduleIfaceRefresh(assetId, ifName, ms) {
  if (_ifaceRefreshTimer) clearTimeout(_ifaceRefreshTimer);
  _ifaceRefreshTimer = setTimeout(function tick() {
    // The iface slide-over is anchored to the current asset; if either is gone we drop the chain.
    if (!_isOverlayOpen("iface-panel-overlay") || !_isCurrentAsset(assetId)) { _ifaceRefreshTimer = null; return; }
    if (document.hidden) { _ifaceRefreshTimer = setTimeout(tick, 30000); return; }
    _loadInterfaceHistoryFor(assetId, ifName, _currentIfaceRange());
  }, ms);
}

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

  initSlideoverResize(document.getElementById("asset-panel"), "shelob.panel.width.asset");
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
    // Fetch the asset and (once per session) the global monitor settings in parallel.
    // _monitorSettingsCache feeds the auto-refresh schedulers — without it we'd
    // fall back to a hardcoded 60s default even when the admin has tuned the
    // global cadence higher.
    var fetches = [api.assets.get(id)];
    if (!_monitorSettingsCache) {
      fetches.push(api.assets.getMonitorSettings().catch(function () { return null; }));
    }
    var fetched = await Promise.all(fetches);
    var a = fetched[0];
    if (fetched[1]) _monitorSettingsCache = fetched[1];
    _currentAssetForRefresh = a;
    var generalHTML = '<div class="asset-view-grid">' +
      viewRow("Hostname", a.hostname) +
      viewRow("DNS Name", a.dnsName) +
      ipViewRow(a) +
      viewRow("MAC Address", a.macAddress, true) +
      macAddressesViewHTML(a.macAddresses) +
      viewRow("Asset Tag", a.assetTag) +
      viewRow("Serial Number", a.serialNumber) +
      viewRow("Manufacturer", a.manufacturer) +
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

    var systemHTML     = assetSystemViewHTML(a);
    var monitoringHTML = assetMonitoringViewHTML(a);
    var tabsHTML = _renderTabbedBody("asset-view", [
      { key: "general",    label: "General",    html: generalHTML },
      { key: "system",     label: "System",     html: systemHTML },
      { key: "monitoring", label: "Monitoring", html: monitoringHTML },
    ]);
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
    _wireHoverTriggersIn(bodyEl);
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
    var sysProbeBtn = document.getElementById("btn-asset-system-probe");
    if (sysProbeBtn) {
      sysProbeBtn.addEventListener("click", async function () {
        sysProbeBtn.disabled = true;
        try {
          await api.assets.probeNow(a.id);
          await _loadSystemTabFor(a.id, _currentSystemTabRange(), a);
          showToast("System info refreshed");
        } catch (err) {
          showToast(err.message || "Probe failed", "error");
        } finally {
          sysProbeBtn.disabled = false;
        }
      });
    }
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
        try {
          var r = await api.assets.probeNow(a.id);
          showToast(r.success ? ("Probe ok — " + r.responseTimeMs + " ms") : ("Probe failed: " + (r.error || "unknown")), r.success ? "success" : "error");
          _loadMonitorHistoryFor(a.id, _currentMonitorSelection());
        } catch (err) {
          showToast(err.message, "error");
        } finally {
          probeBtn.disabled = false;
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

// ─── System tab ────────────────────────────────────────────────────────────
//
// Renders three sections: CPU/memory time-series charts, an interfaces table,
// and a storage table. Telemetry is collected every ~60s, system info every
// ~10min, so the charts are sparse compared to the response-time chart on
// the Monitoring tab. ICMP/SSH-monitored assets render an empty-state message
// because those probes can't deliver this data.

function assetSystemViewHTML(a) {
  if (!a) return '<p class="empty-state">No data.</p>';
  if (!a.monitored) {
    return '<div style="padding:1rem 0;color:var(--color-text-secondary)">' +
      'Enable monitoring on this asset (Monitoring tab → Edit) to start collecting CPU/memory and interface data.' +
    '</div>';
  }
  var t = a.monitorType;
  if (t === "icmp" || t === "ssh") {
    return '<div style="padding:1rem 0;color:var(--color-text-secondary)">' +
      'System metrics are not available for ' + escapeHtml(t.toUpperCase()) + '-monitored assets — switch to SNMP, FortiOS, or WinRM to see CPU, memory, interfaces, and storage.' +
    '</div>';
  }
  if (t === "winrm" || t === "activedirectory") {
    return '<div style="padding:1rem 0;color:var(--color-text-secondary)">' +
      'WinRM telemetry collection is not yet implemented. Use SNMP if you need CPU, memory, and interface metrics for this host today.' +
    '</div>';
  }
  var rangeBtns =
    '<button class="btn btn-sm btn-primary asset-system-range-btn" data-range="1h">1h</button>' +
    '<button class="btn btn-sm btn-secondary asset-system-range-btn" data-range="24h">24h</button>' +
    '<button class="btn btn-sm btn-secondary asset-system-range-btn" data-range="7d">7d</button>' +
    '<button class="btn btn-sm btn-secondary asset-system-range-btn" data-range="30d">30d</button>';
  var probeBtn = canManageAssets()
    ? '<button class="btn btn-sm btn-secondary" id="btn-asset-system-probe">Probe now</button>'
    : '';
  return (
    '<div style="display:flex;align-items:center;justify-content:space-between;margin:0.25rem 0 0.5rem">' +
      '<h4 style="margin:0">CPU &amp; Memory</h4>' +
      '<div style="display:flex;gap:6px">' + rangeBtns + ' ' + probeBtn + '</div>' +
    '</div>' +
    '<div id="asset-system-summary" style="display:flex;gap:1.25rem;flex-wrap:wrap;font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">' +
      '<span>Loading…</span>' +
    '</div>' +
    '<div id="asset-system-chart" style="background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;padding:0.5rem;min-height:200px;display:flex;align-items:center;justify-content:center;color:var(--color-text-secondary);font-size:0.85rem">' +
      'Loading samples…' +
    '</div>' +
    '<h4 style="margin:1.25rem 0 0.5rem">Temperatures</h4>' +
    '<div id="asset-system-temps"><span class="empty-state">Loading…</span></div>' +
    '<h4 style="margin:1.25rem 0 0.5rem">Interfaces</h4>' +
    '<div id="asset-system-interfaces"><span class="empty-state">Loading…</span></div>' +
    '<h4 style="margin:1.25rem 0 0.5rem">Storage</h4>' +
    '<div id="asset-system-storage"><span class="empty-state">Loading…</span></div>' +
    '<h4 style="margin:1.25rem 0 0.5rem">IPsec Tunnels</h4>' +
    '<div id="asset-system-ipsec"><span class="empty-state">Loading…</span></div>'
  );
}

function _currentSystemTabRange() {
  var chart = document.getElementById("asset-system-chart");
  return (chart && chart.dataset.range) || "24h";
}

async function _loadSystemTabFor(assetId, range, asset) {
  // Cancel any pending auto-refresh — a manual range change, probe-now, or
  // re-render shouldn't race a scheduled tick.
  if (_assetSystemRefreshTimer) { clearTimeout(_assetSystemRefreshTimer); _assetSystemRefreshTimer = null; }
  var chart   = document.getElementById("asset-system-chart");
  var summary = document.getElementById("asset-system-summary");
  var ifaces  = document.getElementById("asset-system-interfaces");
  var storage = document.getElementById("asset-system-storage");
  var temps   = document.getElementById("asset-system-temps");
  var ipsec   = document.getElementById("asset-system-ipsec");
  if (!chart) return;
  chart.dataset.range = range || "24h";
  chart.textContent = "Loading samples…";
  if (summary) summary.innerHTML = "<span>Loading…</span>";
  if (ifaces)  ifaces.innerHTML  = '<span class="empty-state">Loading…</span>';
  if (storage) storage.innerHTML = '<span class="empty-state">Loading…</span>';
  if (temps)   temps.innerHTML   = '<span class="empty-state">Loading…</span>';
  if (ipsec)   ipsec.innerHTML   = '<span class="empty-state">Loading…</span>';

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
    _renderIpsecTunnels(ipsec, si, asset);
  } catch (err) {
    chart.textContent = "Error: " + (err.message || "failed to load");
    if (summary) summary.innerHTML = "";
    if (ifaces)  ifaces.innerHTML  = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
    if (storage) storage.innerHTML = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
    if (temps)   temps.innerHTML   = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
    if (ipsec)   ipsec.innerHTML   = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
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
  if (rows.length === 0) {
    container.innerHTML = '<p class="empty-state">No interface data yet — system info is collected every ~10 minutes after monitoring is enabled.</p>';
    return;
  }
  rows = rows.slice().sort(function (a, b) {
    return String(a.ifName || "").localeCompare(String(b.ifName || ""), undefined, { numeric: true, sensitivity: "base" });
  });
  var monitored = new Set(((si && si.monitoredInterfaces) || (asset && asset.monitoredInterfaces) || []));
  var canEdit = canManageAssets();
  var body = rows.map(function (i) {
    var oper = i.operStatus  ? '<span class="status-pill status-pill-' + (i.operStatus  === "up" ? "active" : "decommissioned") + '">' + escapeHtml(i.operStatus) + '</span>' : '—';
    var admin= i.adminStatus ? escapeHtml(i.adminStatus) : '—';
    var speed = i.speedBps != null ? _fmtSpeed(i.speedBps) : '—';
    var checked = monitored.has(i.ifName) ? ' checked' : '';
    var disabled = canEdit ? '' : ' disabled';
    var checkbox =
      '<input type="checkbox" class="asset-iface-toggle" data-ifname="' + escapeHtml(i.ifName) + '"' + checked + disabled +
      ' title="Poll this interface every minute (response-time cadence)">';
    var nameCell = '<a href="#" class="asset-iface-link" data-ifname="' + escapeHtml(i.ifName) + '" style="color:var(--color-accent);text-decoration:none">' + escapeHtml(i.ifName) + '</a>';
    var errs = ((i.inErrors != null && i.inErrors > 0) || (i.outErrors != null && i.outErrors > 0))
      ? ((i.inErrors || 0) + ' / ' + (i.outErrors || 0))
      : '0 / 0';
    return '<tr>' +
      '<td style="text-align:center;width:1%">' + checkbox + '</td>' +
      '<td class="mono">' + nameCell + '</td>' +
      '<td>' + admin + '</td>' +
      '<td>' + oper + '</td>' +
      '<td>' + speed + '</td>' +
      '<td class="mono">' + escapeHtml(i.ipAddress || "—") + '</td>' +
      '<td class="mono">' + escapeHtml(i.macAddress || "—") + '</td>' +
      '<td>' + (i.inOctets  != null ? _fmtBytes(i.inOctets)  : '—') + '</td>' +
      '<td>' + (i.outOctets != null ? _fmtBytes(i.outOctets) : '—') + '</td>' +
      '<td title="In errors / Out errors (cumulative)">' + errs + '</td>' +
    '</tr>';
  }).join("");
  container.innerHTML =
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th title="Pin this interface for fast-cadence polling">Poll 1m</th>' +
      '<th>Interface</th><th>Admin</th><th>Oper</th><th>Speed</th><th>IP</th><th>MAC</th><th>In</th><th>Out</th><th>Errors (in/out)</th>' +
    '</tr></thead><tbody>' + body + '</tbody></table></div>';

  // Toggle handler — POSTs the new monitoredInterfaces array.
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
  // Click handler — open nested interface detail panel.
  container.querySelectorAll(".asset-iface-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      var name = link.getAttribute("data-ifname");
      openInterfaceDetailPanel(asset, name);
    });
  });
}

// IPsec tunnel snapshot — FortiOS-only. The backend leaves the array empty
// for SNMP/WinRM/AD assets and for FortiGates with no tunnels configured;
// either way render an explanatory empty-state instead of an empty table.
function _renderIpsecTunnels(container, si, asset) {
  if (!container) return;
  var rows = (si && si.ipsecTunnels) || [];
  var t = (si && si.monitorType) || (asset && asset.monitorType) || "";
  if (rows.length === 0) {
    if (t === "fortigate" || t === "fortimanager") {
      container.innerHTML = '<p class="empty-state">No IPsec tunnels reported by this FortiGate (or none configured yet).</p>';
    } else {
      container.innerHTML = '<p class="empty-state">IPsec tunnel data is only collected for FortiOS-monitored devices.</p>';
    }
    return;
  }
  var monitored = new Set(((si && si.monitoredIpsecTunnels) || (asset && asset.monitoredIpsecTunnels) || []));
  var canEdit = canManageAssets();
  var body = rows.map(function (t) {
    var pillClass = t.status === "up" ? "active" : t.status === "down" ? "decommissioned" : "maintenance";
    var pill = '<span class="status-pill status-pill-' + pillClass + '">' + escapeHtml(t.status) + '</span>';
    var name = '<a href="#" class="asset-ipsec-link" data-name="' + escapeHtml(t.tunnelName) + '" style="color:var(--color-accent);text-decoration:none">' + escapeHtml(t.tunnelName) + '</a>';
    var p2 = t.proxyIdCount != null ? String(t.proxyIdCount) : '—';
    var checked = monitored.has(t.tunnelName) ? ' checked' : '';
    var disabled = canEdit ? '' : ' disabled';
    var checkbox =
      '<input type="checkbox" class="asset-ipsec-toggle" data-name="' + escapeHtml(t.tunnelName) + '"' + checked + disabled +
      ' title="Poll this tunnel every minute (response-time cadence)">';
    return '<tr>' +
      '<td style="text-align:center;width:1%">' + checkbox + '</td>' +
      '<td class="mono">' + name + '</td>' +
      '<td>' + pill + '</td>' +
      '<td class="mono">' + escapeHtml(t.remoteGateway || '—') + '</td>' +
      '<td>' + (t.incomingBytes != null ? _fmtBytes(t.incomingBytes) : '—') + '</td>' +
      '<td>' + (t.outgoingBytes != null ? _fmtBytes(t.outgoingBytes) : '—') + '</td>' +
      '<td title="Phase-2 selector count">' + p2 + '</td>' +
    '</tr>';
  }).join("");
  container.innerHTML =
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th title="Pin this tunnel for fast-cadence polling">Poll 1m</th>' +
      '<th>Tunnel</th><th>Status</th><th>Remote gateway</th><th>In (cumulative)</th><th>Out (cumulative)</th><th>P2</th>' +
    '</tr></thead><tbody>' + body + '</tbody></table></div>';

  if (canEdit && asset) {
    container.querySelectorAll(".asset-ipsec-toggle").forEach(function (cb) {
      cb.addEventListener("change", async function () {
        var name = cb.getAttribute("data-name");
        var current = new Set(monitored);
        if (cb.checked) current.add(name); else current.delete(name);
        cb.disabled = true;
        try {
          await api.assets.update(asset.id, { monitoredIpsecTunnels: Array.from(current) });
          monitored = current;
          if (si) si.monitoredIpsecTunnels = Array.from(current);
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
  container.querySelectorAll(".asset-ipsec-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      openIpsecTunnelDetailPanel(asset, link.getAttribute("data-name"));
    });
  });
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
      '<th title="Pin this mountpoint for fast-cadence polling">Poll 1m</th>' +
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
  initSlideoverResize(document.getElementById("sensor-panel"), "shelob.panel.width.sensor");
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
    var titleParts = [];
    if (meta.title)   titleParts.push(meta.title);
    if (meta.subject) titleParts.push(meta.subject);
    var headerLine1 = titleParts.join(" — ");
    var headerLine2 = meta.asset || "";
    var headerH = 0;
    if (headerLine1 && headerLine2) headerH = 40;
    else if (headerLine1 || headerLine2) headerH = 24;

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
      if (headerLine1) {
        ctx.fillStyle = resolvedText;
        ctx.font = "600 13px " + fontFamily;
        ctx.fillText(headerLine1, headerX, 8);
      }
      if (headerLine2) {
        ctx.fillStyle = textSec;
        ctx.font = "11px " + fontFamily;
        ctx.fillText(headerLine2, headerX, headerLine1 ? 24 : 8);
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
    var meta = {
      title: label,
      asset: assetName,
      subject: axisOpts.subject || "",
      xAxis: axisOpts.xAxis || "Time",
      yAxis: axisOpts.yAxis || label,
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

// Two stacked charts (CPU + Memory) over the telemetry time window. CPU stays
// pinned to 0–100% so spikes are meaningful; Memory autoscales to its observed
// range so a host that idles around 60% still shows variation instead of a
// flat line. Each chart has its own hit targets / hover tooltip.
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

  container.innerHTML =
    '<div class="asset-system-subchart" style="position:relative;margin-bottom:0.5rem"></div>' +
    '<div class="asset-system-subchart" style="position:relative"></div>';
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  container.style.position = "relative";
  container.style.flexDirection = "column";

  var subs = container.querySelectorAll(".asset-system-subchart");
  var since = data && data.since;
  var until = data && data.until;
  _renderTelemetrySubChart(subs[0], samples, {
    label: "CPU",
    color: "var(--color-accent)",
    yFmt: function (v) { return v.toFixed(0) + "%"; },
    pickValue: function (s) { return typeof s.cpuPct === "number" ? s.cpuPct : null; },
    yMin: 0,
    yMax: 100,
    since: since,
    until: until,
    tooltip: function (s, v) {
      return '<div>CPU: ' + (v != null ? v.toFixed(1) + "%" : "—") + '</div>';
    },
  });
  _renderTelemetrySubChart(subs[1], samples, {
    label: "Memory",
    color: "#f4a261",
    yFmt: function (v) { return v.toFixed(0) + "%"; },
    pickValue: memPctFromSample,
    autoscale: true,
    since: since,
    until: until,
    tooltip: function (s, v) {
      var line = '<div>Memory: ' + (v != null ? v.toFixed(1) + "%" : "—");
      if (typeof s.memUsedBytes === "number" && typeof s.memTotalBytes === "number") {
        line += " (" + _fmtBytes(s.memUsedBytes) + " / " + _fmtBytes(s.memTotalBytes) + ")";
      }
      return line + "</div>";
    },
  });
}

// Renders a single-line telemetry chart with a Y-axis scale. CPU passes a fixed
// {yMin, yMax}; Memory passes {autoscale: true} which fits the axis to the
// observed range with a small pad so flat-ish series still show variation.
function _renderTelemetrySubChart(container, samples, opts) {
  var W = container.clientWidth || 600;
  var H = 160;
  var padL = 50, padR = 10, padT = 14, padB = 28;
  var innerW = W - padL - padR;
  var innerH = H - padT - padB;

  var bounds = _chartTimeBounds(samples, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0;
  var oneDayMs = 24 * 60 * 60 * 1000;
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function fmtTick(ts) {
    var d = new Date(ts);
    if (spanMs <= oneDayMs) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  var withVal = samples.map(function (s) { return { s: s, v: opts.pickValue(s) }; })
                       .filter(function (e) { return typeof e.v === "number"; });

  var yMin, yMax;
  if (opts.autoscale) {
    if (withVal.length === 0) { yMin = 0; yMax = 100; }
    else {
      var vMin = Infinity, vMax = -Infinity;
      withVal.forEach(function (e) {
        if (e.v < vMin) vMin = e.v;
        if (e.v > vMax) vMax = e.v;
      });
      yMin = Math.max(0,   Math.floor(vMin - 2));
      yMax = Math.min(100, Math.ceil (vMax + 2));
      if (yMax - yMin < 4) { yMin = Math.max(0, yMin - 2); yMax = Math.min(100, yMax + 2); }
      if (yMax === yMin) yMax = yMin + 1;
    }
  } else {
    yMin = opts.yMin != null ? opts.yMin : 0;
    yMax = opts.yMax != null ? opts.yMax : 100;
  }

  function xFor(ts) { return padL + ((new Date(ts).getTime() - t0) / (t1 - t0)) * innerW; }
  function yFor(v)  { return padT + innerH - ((v - yMin) / (yMax - yMin)) * innerH; }

  var pts = withVal.map(function (e) { return xFor(e.s.timestamp) + "," + yFor(e.v); }).join(" ");
  var hits = withVal.map(function (e) {
    return '<circle class="chart-hit" cx="' + xFor(e.s.timestamp) + '" cy="' + yFor(e.v) + '" r="7" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(e.s.timestamp)) + '"' +
      ' data-v="' + e.v + '"' +
      ' data-mb="' + (typeof e.s.memUsedBytes === "number" ? e.s.memUsedBytes : "") + '"' +
      ' data-mt="' + (typeof e.s.memTotalBytes === "number" ? e.s.memTotalBytes : "") + '"/>';
  }).join("");

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = yMin + (yMax - yMin) * (i / 4);
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + opts.yFmt(v) + '</text>';
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
      '<rect x="' + (padL + 4) + '" y="2" width="10" height="10" fill="' + opts.color + '"/>' +
      '<text x="' + (padL + 18) + '" y="11">' + escapeHtml(opts.label) + '</text>' +
    '</g>';

  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      (pts ? '<polyline points="' + pts + '" fill="none" stroke="' + opts.color + '" stroke-width="1.5"/>' : '') +
      legend + hits +
    '</svg>' + CHART_TOOLTIP_HTML;

  _wireChartTooltip(container, function (target) {
    var ts = target.getAttribute("data-ts");
    var raw = target.getAttribute("data-v");
    var v = raw !== "" ? Number(raw) : null;
    var mb = target.getAttribute("data-mb");
    var mt = target.getAttribute("data-mt");
    var sample = {
      memUsedBytes: mb !== "" ? Number(mb) : undefined,
      memTotalBytes: mt !== "" ? Number(mt) : undefined,
    };
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(ts)) + '</div>' +
      opts.tooltip(sample, v);
  });
  _addChartScreenshotButton(container, opts.label, { yAxis: opts.label + " (%)" });
  _observeChartResize(container, function (c) { _renderTelemetrySubChart(c, samples, opts); });
}

// Human-readable label for the probe method behind the response-time chart.
// Mirrors the routing in monitoringService.probeAsset / getAdMonitorProtocol so
// the chart self-describes (FortiOS REST vs SNMP vs ICMP vs WinRM vs SSH).
// AD-locked assets are split into AD-WinRM (Windows hosts) and AD-SSH (realm-
// joined Linux) since the probe path differs.
function _probeMethodLabel(a) {
  if (!a) return "—";
  var t = a.monitorType;
  if (t === "fortimanager" || t === "fortigate") return "FortiOS REST API";
  if (t === "snmp") return "SNMP GET";
  if (t === "winrm") return "WinRM";
  if (t === "ssh") return "SSH";
  if (t === "icmp") return "ICMP ping";
  if (t === "activedirectory") {
    var os = (a.os || "").toLowerCase();
    if (os.indexOf("linux") >= 0) return "AD-locked SSH";
    if (os.indexOf("windows") >= 0) return "AD-locked WinRM";
    return "Active Directory";
  }
  return t || "—";
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
  var sourceLabel = a.monitorType || "—";
  if (_isMonitorIntegrationLocked(a) && a.discoveredByIntegration) {
    var lockedPrefix =
      a.monitorType === "fortigate"       ? "FortiGate: " :
      a.monitorType === "activedirectory" ? "Active Directory: " :
                                            "FortiManager: ";
    sourceLabel = lockedPrefix + a.discoveredByIntegration.name;
  } else if (a.monitorType === "snmp" || a.monitorType === "winrm" || a.monitorType === "ssh") {
    if (a.monitorCredential) sourceLabel = a.monitorType.toUpperCase() + " · " + a.monitorCredential.name;
  } else if (a.monitorType === "icmp") {
    sourceLabel = "ICMP";
  }
  var lastRtt = (typeof a.lastResponseTimeMs === "number") ? (a.lastResponseTimeMs + " ms") : "—";
  var lastPoll = a.lastMonitorAt ? formatDate(a.lastMonitorAt) : "—";
  var consec = a.consecutiveFailures || 0;
  var probeBtn = canManageAssets()
    ? '<button class="btn btn-sm btn-secondary" id="btn-asset-probe-now">Probe now</button>'
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
        '<span class="detail-value">' + pill + '</span></div>' +
      viewRow("Source", sourceLabel) +
      viewRow("Last Response Time", lastRtt) +
      viewRow("Last Poll", lastPoll) +
      viewRow("Consecutive Failures", String(consec)) +
    '</div>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin:1.5rem 0 0.5rem">' +
      '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
        '<h4 style="margin:0">Response time</h4>' +
        '<span title="Probe method used to measure response time" style="font-size:0.75rem;padding:2px 6px;border-radius:10px;background:var(--color-bg-elevated);border:1px solid var(--color-border);color:var(--color-text-secondary)">' +
          escapeHtml(_probeMethodLabel(a)) +
        '</span>' +
      '</div>' +
      '<div style="display:flex;gap:6px">' + rangeBtns + ' ' + probeBtn + '</div>' +
    '</div>' +
    customPanel +
    '<div id="asset-monitor-chart" style="background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:6px;padding:0.5rem;min-height:200px;display:flex;align-items:center;justify-content:center;color:var(--color-text-secondary);font-size:0.85rem">' +
      'Loading samples…' +
    '</div>' +
    '<div id="asset-monitor-stats" style="margin-top:0.5rem;font-size:0.85rem;color:var(--color-text-secondary)"></div>'
  );
}

async function _loadMonitorHistoryFor(assetId, selection) {
  // Cancel any pending auto-refresh — a manual range change or probe-now click
  // shouldn't race against an in-flight scheduled tick.
  if (_assetMonitorRefreshTimer) { clearTimeout(_assetMonitorRefreshTimer); _assetMonitorRefreshTimer = null; }
  var chart = document.getElementById("asset-monitor-chart");
  var stats = document.getElementById("asset-monitor-stats");
  if (!chart) return;
  chart.textContent = "Loading samples…";
  if (stats) stats.textContent = "";
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
  try {
    var data = await api.assets.monitorHistory(assetId, opts);
    _renderMonitorChart(chart, data);
    if (stats && data.stats) {
      var s = data.stats;
      var loss = s.packetLossRate != null ? (s.packetLossRate * 100).toFixed(1) + "%" : "—";
      var avg  = s.avgMs != null ? s.avgMs + " ms" : "—";
      var min  = s.minMs != null ? s.minMs + " ms" : "—";
      var max  = s.maxMs != null ? s.maxMs + " ms" : "—";
      stats.textContent = s.total + " samples · avg " + avg + " · min " + min + " · max " + max + " · packet loss " + loss;
    }
  } catch (err) {
    chart.textContent = "Error: " + (err.message || "failed to load history");
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

function _renderMonitorChart(container, data) {
  var samples = (data && data.samples) || [];
  if (samples.length === 0) {
    container.textContent = "No samples in this range yet.";
    return;
  }
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

  var svg =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      ticks +
      xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
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
  svgEl.addEventListener("mousemove", function (evt) {
    var t = evt.target;
    if (t && t.classList && t.classList.contains("monitor-hit")) {
      showTip(t, evt);
    } else {
      tip.style.display = "none";
    }
  });
  svgEl.addEventListener("mouseleave", function () { tip.style.display = "none"; });
  _addChartScreenshotButton(container, "Response time", { yAxis: "Response time (ms)" });
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
  initSlideoverResize(document.getElementById("iface-panel"), "shelob.panel.width.iface");
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
  titleEl.textContent = "Interface — " + ifName;
  metaEl.textContent = asset.hostname || asset.ipAddress || asset.id;
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>';
  footerEl.innerHTML =
    '<button class="btn btn-sm btn-secondary" id="btn-iface-panel-close-btn">Close</button>';
  requestAnimationFrame(function () {
    document.getElementById("iface-panel-overlay").classList.add("open");
  });
  document.getElementById("btn-iface-panel-close-btn").addEventListener("click", closeIfacePanel);

  var rangeBtns =
    '<button class="btn btn-sm btn-primary iface-range-btn" data-range="1h">1h</button>' +
    '<button class="btn btn-sm btn-secondary iface-range-btn" data-range="24h">24h</button>' +
    '<button class="btn btn-sm btn-secondary iface-range-btn" data-range="7d">7d</button>' +
    '<button class="btn btn-sm btn-secondary iface-range-btn" data-range="30d">30d</button>';

  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
        '<h4 style="margin:0">Throughput &amp; errors</h4>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
      '<div id="iface-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Input (bps)</h5>' +
      '<div id="iface-in-chart" class="iface-chart-box"></div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Output (bps)</h5>' +
      '<div id="iface-out-chart" class="iface-chart-box"></div>' +
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

async function _loadInterfaceHistoryFor(assetId, ifName, range) {
  // Cancel any pending auto-refresh — manual range change shouldn't race a tick.
  if (_ifaceRefreshTimer) { clearTimeout(_ifaceRefreshTimer); _ifaceRefreshTimer = null; }
  var inEl = document.getElementById("iface-in-chart");
  var outEl = document.getElementById("iface-out-chart");
  var errEl = document.getElementById("iface-err-chart");
  var stats = document.getElementById("iface-stats");
  if (!inEl) return;
  inEl.textContent = outEl.textContent = errEl.textContent = "Loading samples…";
  if (stats) stats.textContent = "Loading…";
  try {
    var data = await api.assets.interfaceHistory(assetId, ifName, range || "1h");
    var derived = _derivePerIntervalSeries(data.samples || []);
    if (stats) stats.textContent = _ifaceStatsLabel(data.samples || [], derived);
    var ifaceOpts = { since: data.since, until: data.until, subject: ifName };
    _renderIfaceCounterChart(inEl,  derived, "in",  ifaceOpts);
    _renderIfaceCounterChart(outEl, derived, "out", ifaceOpts);
    _renderIfaceErrorChart(errEl, derived, ifaceOpts);
  } catch (err) {
    inEl.textContent = outEl.textContent = errEl.textContent = "Error: " + (err.message || "failed to load");
    if (stats) stats.textContent = "";
  }
  // Schedule next auto-refresh on the response-time cadence — pinned interfaces
  // ride that cadence on the backend (collectInterfacesFiltered).
  var settings = _monitorSettingsCache || {};
  var asset = _currentAssetForRefresh;
  var ms = _refreshIntervalMs(asset && asset.monitorIntervalSec, settings.intervalSeconds, 60);
  _scheduleIfaceRefresh(assetId, ifName, ms);
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

function _renderIfaceCounterChart(container, derived, side, opts) {
  opts = opts || {};
  var values = derived.map(function (d) { return { ts: d.timestamp, v: side === "in" ? d.inBps : d.outBps }; })
                     .filter(function (e) { return typeof e.v === "number"; });
  if (values.length === 0) {
    container.textContent = "No throughput samples yet — fast-cadence polling is required for sub-minute resolution.";
    return;
  }
  var W = container.clientWidth || 600, H = 180;
  var padL = 56, padR = 10, padT = 10, padB = 32;
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
  // Tidy ceiling at the next 0.25 / 0.5 / 1 / 5 / 10 / 25 / 100 / 250 ... Mbps step
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
      hits +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  _wireChartTooltip(container, function (target) {
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>' + (side === "in" ? "Input" : "Output") + ': ' + _fmtBitsPerSec(Number(target.getAttribute("data-v"))) + '</div>';
  });
  _addChartScreenshotButton(container, side === "in" ? "Input throughput" : "Output throughput", { yAxis: "Throughput (bps)", subject: opts.subject });
  _observeChartResize(container, function (c) { _renderIfaceCounterChart(c, derived, side, opts); });
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
  initSlideoverResize(document.getElementById("ipsec-panel"), "shelob.panel.width.ipsec");
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
  var up = 0, down = 0, partial = 0;
  samples.forEach(function (s) {
    if (s.status === "up") up++;
    else if (s.status === "down") down++;
    else partial++;
  });
  var inMax = 0, outMax = 0, inSum = 0, outSum = 0, inN = 0, outN = 0;
  derived.forEach(function (d) {
    if (typeof d.inBps  === "number") { inSum  += d.inBps;  inN++;  if (d.inBps  > inMax)  inMax  = d.inBps; }
    if (typeof d.outBps === "number") { outSum += d.outBps; outN++; if (d.outBps > outMax) outMax = d.outBps; }
  });
  return samples.length + " samples · " + up + " up / " + partial + " partial / " + down + " down · " +
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
  var legend =
    '<g font-size="10" fill="currentColor">' +
      '<rect x="' + padL + '" y="2" width="10" height="6" fill="#2a9d8f"/><text x="' + (padL + 14) + '" y="8">up</text>' +
      '<rect x="' + (padL + 50) + '" y="2" width="10" height="6" fill="#f4a261"/><text x="' + (padL + 64) + '" y="8">partial</text>' +
      '<rect x="' + (padL + 110) + '" y="2" width="10" height="6" fill="#d32f2f"/><text x="' + (padL + 124) + '" y="8">down</text>' +
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
  initSlideoverResize(document.getElementById("storage-panel"), "shelob.panel.width.storage");
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

function _assetDetailPairs() {
  var body = document.getElementById('asset-panel-body') ||
             document.querySelector('#modal-overlay .modal-body');
  if (!body) return [];
  var pairs = [];
  body.querySelectorAll('.detail-row').forEach(function (row) {
    var label = row.querySelector('.detail-label');
    var value = row.querySelector('.detail-value');
    if (!label || !value) return;
    var labelText = (label.innerText || label.textContent || '').trim();
    var valueText = (value.innerText || value.textContent || '').trim();
    pairs.push({ label: labelText, value: valueText });
  });
  return pairs;
}

function _copyAssetDetails() {
  var pairs = _assetDetailPairs();
  if (pairs.length === 0) { showToast("Nothing to copy", "error"); return; }
  var text = pairs.map(function (p) {
    if (p.value.indexOf('\n') !== -1) {
      var indented = p.value.split('\n').map(function (l) { return '  ' + l; }).join('\n');
      return p.label + ':\n' + indented;
    }
    return p.label + ': ' + (p.value || '-');
  }).join('\n');
  navigator.clipboard.writeText(text).then(function () {
    showToast("Asset details copied to clipboard");
  }).catch(function () {
    showToast("Copy failed", "error");
  });
}

function _screenshotAssetDetails(asset) {
  var pairs = _assetDetailPairs();
  if (pairs.length === 0) { showToast("Nothing to screenshot", "error"); return; }

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
  var tableW = labelColW + valueColW;
  var lineH = 18;
  var rowPadV = 10;
  var w = tableW + pad * 2;

  var rows = pairs.map(function (p) {
    var lines = p.value.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
    if (lines.length === 0) lines = ['-'];
    return { label: p.label, lines: lines, h: Math.max(30, lines.length * lineH + rowPadV) };
  });

  var totalRowsH = rows.reduce(function (acc, r) { return acc + r.h; }, 0);
  var h = titleH + totalRowsH + pad;

  var canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  var ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  ctx.fillStyle = bgPrimary;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = clrText;
  ctx.font = "bold 17px system-ui,-apple-system,sans-serif";
  var title = "Asset Details" + (asset && asset.hostname ? " — " + asset.hostname : "");
  ctx.fillText(title, pad, 32);

  var y = titleH;
  rows.forEach(function (r, i) {
    if (i % 2 === 1) {
      ctx.fillStyle = bgSurface;
      ctx.fillRect(pad, y, tableW, r.h);
    }

    ctx.fillStyle = clrMuted;
    ctx.font = "600 10px system-ui,-apple-system,sans-serif";
    ctx.fillText(r.label.toUpperCase(), pad + 10, y + 20);

    ctx.fillStyle = clrText;
    ctx.font = "13px system-ui,-apple-system,sans-serif";
    var maxW = valueColW - 20;
    r.lines.forEach(function (line, li) {
      var txt = line;
      while (ctx.measureText(txt).width > maxW && txt.length > 3) {
        txt = txt.slice(0, -4) + '…';
      }
      ctx.fillText(txt, pad + labelColW + 10, y + 20 + li * lineH);
    });

    ctx.fillStyle = clrBorder;
    ctx.fillRect(pad, y + r.h - 1, tableW, 1);
    y += r.h;
  });

  ctx.strokeStyle = clrBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(pad + 0.5, titleH + 0.5, tableW - 1, totalRowsH - 1);

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
    return '<div class="detail-row"><span class="detail-label">IP Address</span>' +
      '<span class="detail-value mono">-</span></div>';
  }
  var src = asset.ipSource
    ? '<span style="font-size:0.75rem;color:var(--color-text-tertiary);margin-left:8px">' + escapeHtml(asset.ipSource) + '</span>'
    : '';
  return '<div class="detail-row"><span class="detail-label">IP Address</span>' +
    '<span class="detail-value mono">' + ipCellHTML(asset) + src + '</span></div>';
}

function viewRow(label, value, mono, alignRight) {
  var style = alignRight ? ' style="text-align:right"' : '';
  return '<div class="detail-row"><span class="detail-label">' + escapeHtml(label) + '</span>' +
    '<span class="detail-value' + (mono ? ' mono' : '') + '"' + style + '>' + escapeHtml(value || "-") + '</span></div>';
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

function macAddressesViewHTML(macAddresses) {
  if (!macAddresses || macAddresses.length <= 1) return '';
  var rows = macAddresses.map(function (m) {
    return '<div style="display:flex;gap:12px;align-items:center;padding:3px 0">' +
      '<code style="font-size:0.82rem">' + escapeHtml(m.mac) + '</code>' +
      '<span style="font-size:0.75rem;color:var(--color-text-tertiary)">' +
        escapeHtml(m.source || "") +
        (m.lastSeen ? ' &middot; ' + formatDate(m.lastSeen) : '') +
      '</span>' +
    '</div>';
  }).join("");
  return '<div class="detail-row"><span class="detail-label">All MACs (' + macAddresses.length + ')</span>' +
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

function _hasActiveFilters() {
  var status = document.getElementById("filter-status").value;
  var type   = document.getElementById("filter-type").value;
  var search = document.getElementById("filter-search").value.trim();
  return !!(type || search || (status && status !== "hide-decommissioned"));
}

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

// One-click bulk monitoring toggle. Defaults to ICMP for assets that aren't
// integration-locked; integration-owned assets (FMG/FortiGate firewalls,
// AD-discovered Windows hosts) keep their locked `monitorType` because the
// backend's bulk-monitor route ignores incoming `monitorType` for those rows.
async function bulkSetMonitoring(monitored) {
  var ids = Array.from(_assetsSelected);
  if (!ids.length) return;
  var btn = document.getElementById(monitored ? "assets-bulk-monitor-on-btn" : "assets-bulk-monitor-off-btn");
  if (btn) btn.disabled = true;
  var payload = monitored
    ? { ids: ids, monitored: true,  monitorType: "icmp", monitorCredentialId: null }
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
