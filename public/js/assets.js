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
      a._acquired = a.acquiredAt || a.createdAt || null;
      return a;
    });
    if (statusVal === "hide-decommissioned") {
      _assetsData = _assetsData.filter(function (a) { return a.status !== "decommissioned" && a.status !== "disabled"; });
    }
    renderAssetsPage();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
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
    tbody.innerHTML = '<tr><td colspan="13" class="empty-state">No assets found. Add one to get started.</td></tr>';
    clearPageControls("pagination");
    _assetsUpdateSelectAll();
    return;
  }
  var sfData = _assetsSF ? _assetsSF.apply(_assetsData) : _assetsData;
  if (sfData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty-state">No results match the current filters.</td></tr>';
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
      '<td>' + (a._acquired ? formatDate(a._acquired) : "-") + '</td>' +
      '<td class="actions">' +
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
    (asset.monitorType === "fortimanager" || asset.monitorType === "fortigate"));
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
    var lockedLabel = (monitorType === "fortigate" ? "FortiGate: " : "FortiManager: ") + (integrationName || "(unknown)");
    typeSelect =
      '<select id="f-monitorType" disabled>' +
        '<option value="' + escapeHtml(monitorType) + '" selected>' + escapeHtml(lockedLabel) + '</option>' +
      '</select>' +
      '<p class="hint">Monitoring source is locked because this firewall was discovered by ' +
        escapeHtml(integrationName || "an integration") + '. Probes go through the integration’s direct-mode API token.</p>';
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
  var typeSel = document.getElementById("f-monitorType");
  var credWrap = document.getElementById("f-monitorCredential-wrap");
  var credSel = document.getElementById("f-monitorCredential");

  function refresh() {
    var t = typeSel ? typeSel.value : "";
    var needsCred = (t === "snmp" || t === "winrm" || t === "ssh");
    if (credWrap) credWrap.style.display = needsCred ? "block" : "none";
    if (needsCred && credSel) {
      var current = credSel.getAttribute("data-current-id") || "";
      credSel.innerHTML = _credentialOptionsFor(t, current);
    }
  }
  if (typeSel && !typeSel.disabled) typeSel.addEventListener("change", refresh);
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
    var a = await api.assets.get(id);
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
    var tabsHTML = _renderTabbedBody("asset-view", [
      { key: "general",    label: "General",    html: generalHTML },
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
    sourceLabel = (a.monitorType === "fortigate" ? "FortiGate: " : "FortiManager: ") + a.discoveredByIntegration.name;
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
      '<h4 style="margin:0">Response time</h4>' +
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
  var padL = 56, padR = 10, padT = 10, padB = 44;
  var innerW = W - padL - padR;
  var innerH = H - padT - padB;

  var t0 = new Date(samples[0].timestamp).getTime();
  var t1 = new Date(samples[samples.length - 1].timestamp).getTime();
  if (t1 === t0) t1 = t0 + 1;
  var spanMs = t1 - t0;
  var oneDayMs = 24 * 60 * 60 * 1000;
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function fmtTick(ts) {
    var d = new Date(ts);
    if (spanMs <= oneDayMs) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return (d.getMonth() + 1) + "/" + d.getDate();
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

  // Y-axis ticks
  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = (ceil * i / 4);
    var y = padT + innerH - (v / ceil) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + Math.round(v) + '</text>';
  }

  // X-axis tick labels
  var xTicks = "";
  var xTickCount = 5;
  for (var j = 0; j <= xTickCount; j++) {
    var tsTick = t0 + (t1 - t0) * (j / xTickCount);
    var xPos = padL + (j / xTickCount) * innerW;
    xTicks +=
      '<line x1="' + xPos + '" y1="' + (padT + innerH) + '" x2="' + xPos + '" y2="' + (padT + innerH + 3) + '" stroke="rgba(127,127,127,0.4)"/>' +
      '<text x="' + xPos + '" y="' + (padT + innerH + 14) + '" text-anchor="middle" font-size="10" fill="currentColor">' + fmtTick(tsTick) + '</text>';
  }

  // Axis titles
  var yTitleX = 14;
  var yTitleY = padT + innerH / 2;
  var yTitle = '<text x="' + yTitleX + '" y="' + yTitleY + '" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85" transform="rotate(-90 ' + yTitleX + ' ' + yTitleY + ')">Response time (ms)</text>';
  var xTitle = '<text x="' + (padL + innerW / 2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85">Time</text>';

  var svg =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      ticks +
      xTicks +
      yTitle +
      xTitle +
      failureLines +
      (pointsAttr ? '<polyline points="' + pointsAttr + '" fill="none" stroke="var(--color-accent)" stroke-width="1.5"/>' : '') +
      oks.map(function (s) {
        return '<circle cx="' + xFor(s.timestamp) + '" cy="' + yFor(s.responseTimeMs) + '" r="1.5" fill="var(--color-accent)"/>';
      }).join("") +
    '</svg>';
  container.innerHTML = svg;
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
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
  doc.text((_branding ? _branding.appName : "Shelob") + " \u2014 Asset Report", 40, 36);
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
        "Page " + data.pageNumber + " of " + pageNum + "  |  " + (_branding ? _branding.appName : "Shelob") + " Asset Report",
        doc.internal.pageSize.getWidth() / 2,
        doc.internal.pageSize.getHeight() - 20,
        { align: "center" }
      );
    },
  });

  var filename = "shelob-assets-" + now.toISOString().slice(0, 10) + ".pdf";
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
  var filename = "shelob-assets-" + new Date().toISOString().slice(0, 10) + ".csv";
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
// integration-locked; FMG/FortiGate-discovered firewalls keep their locked
// `monitorType` because the backend's bulk-monitor route ignores incoming
// `monitorType` for those rows.
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
