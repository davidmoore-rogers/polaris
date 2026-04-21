/**
 * public/js/subnets.js — Networks list + CRUD + next-available
 */

var cachedBlocks = [];
var _subnetsPageSize = 15;
var _subnetsPage = 1;
var _subnetsData = [];
var _allSubnetsData = [];
var _subnetsSF = null;
var _subnetsSelected = new Set();

function _saveSubnetsPrefs() {
  if (!currentUsername) return;
  try {
    localStorage.setItem("shelob-prefs-subnets-" + currentUsername, JSON.stringify({
      pageSize: _subnetsPageSize,
      block: document.getElementById("filter-block").value,
      status: document.getElementById("filter-status").value,
      server: document.getElementById("filter-server").value,
      integration: document.getElementById("filter-integration").value,
      tag: document.getElementById("filter-tag").value,
      sortKey: _subnetsSF ? _subnetsSF._sortKey : null,
      sortDir: _subnetsSF ? _subnetsSF._sortDir : "asc",
      sfFilters: _subnetsSF ? Object.assign({}, _subnetsSF._filters) : {},
    }));
  } catch (_) {}
}

function _restoreSubnetsPrefs() {
  if (!currentUsername) return;
  var raw;
  try { raw = localStorage.getItem("shelob-prefs-subnets-" + currentUsername); } catch (_) { return; }
  if (!raw) return;
  try {
    var p = JSON.parse(raw);
    if (p.pageSize) {
      _subnetsPageSize = p.pageSize;
      var psSel = document.getElementById("filter-pagesize");
      if (psSel) psSel.value = String(p.pageSize);
    }
    if (p.block)       { var bSel = document.getElementById("filter-block");       if (bSel) bSel.value = p.block; }
    if (p.status)      { var sSel = document.getElementById("filter-status");      if (sSel) sSel.value = p.status; }
    if (p.server)      { var svEl = document.getElementById("filter-server");      if (svEl) svEl.value = p.server; }
    if (p.integration) { var iSel = document.getElementById("filter-integration"); if (iSel) iSel.value = p.integration; }
    if (p.tag)         { var tEl  = document.getElementById("filter-tag");         if (tEl)  tEl.value  = p.tag; }
    if (_subnetsSF) {
      if (p.sortKey) _subnetsSF._sortKey = p.sortKey;
      if (p.sortDir) _subnetsSF._sortDir = p.sortDir;
      if (p.sfFilters) {
        _subnetsSF._filters = p.sfFilters;
        if (_subnetsSF._thead) {
          _subnetsSF._thead.querySelectorAll("th[data-sf-key]").forEach(function (th) {
            var inp = th.querySelector(".sf-filter");
            if (inp && p.sfFilters[th.getAttribute("data-sf-key")]) inp.value = p.sfFilters[th.getAttribute("data-sf-key")];
          });
        }
      }
      _subnetsSF._updateIcons();
    }
  } catch (_) {}
}

document.addEventListener("DOMContentLoaded", async function () {
  _subnetsSF = new TableSF("subnets-tbody", function () { _subnetsPage = 1; renderSubnetsPage(); _saveSubnetsPrefs(); });
  await userReady;
  _restoreSubnetsPrefs();
  await loadBlockOptions();
  loadSubnets();

  var addBtn = document.getElementById("btn-add-subnet");
  if (addBtn) addBtn.addEventListener("click", openCreateModal);
  var allocBtn = document.getElementById("btn-auto-alloc");
  if (allocBtn) allocBtn.addEventListener("click", openAllocateModal);
  document.getElementById("subnets-tbody").addEventListener("click", function (e) {
    var link = e.target.closest(".subnet-name-link");
    if (!link) return;
    e.preventDefault();
    var prev = document.querySelector("tr.row-panel-active");
    if (prev) prev.classList.remove("row-panel-active");
    var row = link.closest("tr");
    if (row) row.classList.add("row-panel-active");
    openIpPanel(link.getAttribute("data-subnet-id"));
  });
  document.getElementById("subnets-select-all").addEventListener("change", function () {
    var cbs = document.querySelectorAll("#subnets-tbody input.row-cb");
    var chk = this.checked;
    cbs.forEach(function (cb) {
      cb.checked = chk;
      if (chk) _subnetsSelected.add(cb.getAttribute("data-id"));
      else _subnetsSelected.delete(cb.getAttribute("data-id"));
    });
    _subnetsUpdateBulkBar();
  });
  document.getElementById("subnets-tbody").addEventListener("change", function (e) {
    var cb = e.target;
    if (!cb.classList.contains("row-cb")) return;
    var id = cb.getAttribute("data-id");
    if (cb.checked) _subnetsSelected.add(id);
    else _subnetsSelected.delete(id);
    _subnetsUpdateSelectAll();
    _subnetsUpdateBulkBar();
  });
  document.getElementById("filter-block").addEventListener("change", function () { _subnetsPage = 1; loadSubnets(); _saveSubnetsPrefs(); });
  document.getElementById("filter-status").addEventListener("change", function () { _subnetsPage = 1; loadSubnets(); _saveSubnetsPrefs(); });
  document.getElementById("filter-server").addEventListener("input", debounce(function () { _subnetsPage = 1; _applyLocalFilters(); renderSubnetsPage(); _saveSubnetsPrefs(); }, 300));
  document.getElementById("filter-integration").addEventListener("change", function () { _subnetsPage = 1; _applyLocalFilters(); renderSubnetsPage(); _saveSubnetsPrefs(); });
  document.getElementById("filter-tag").addEventListener("input", debounce(function () { _subnetsPage = 1; loadSubnets(); _saveSubnetsPrefs(); }, 300));
  document.getElementById("filter-pagesize").addEventListener("change", function () {
    _subnetsPageSize = parseInt(this.value, 10) || 15;
    _subnetsPage = 1;
    renderSubnetsPage();
    _saveSubnetsPrefs();
  });
});

async function loadBlockOptions() {
  try {
    cachedBlocks = await api.blocks.list();
    var sel = document.getElementById("filter-block");
    cachedBlocks.forEach(function (b) {
      var opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.name + " (" + b.cidr + ")";
      sel.appendChild(opt);
    });
  } catch (err) {
    showToast("Failed to load blocks: " + err.message, "error");
  }
}

function blockSelectHTML(id, required) {
  var opts = '<option value="">' + (required ? "Select a block..." : "All blocks") + '</option>';
  cachedBlocks.forEach(function (b) {
    opts += '<option value="' + b.id + '">' + escapeHtml(b.name) + ' (' + escapeHtml(b.cidr) + ')</option>';
  });
  return '<select id="' + id + '">' + opts + '</select>';
}

async function loadSubnets() {
  _subnetsSelected.clear();
  _subnetsUpdateBulkBar();
  var tbody = document.getElementById("subnets-tbody");
  try {
    var statusVal = document.getElementById("filter-status").value;
    var apiStatus = (statusVal === "hide-deprecated" || !statusVal) ? undefined : statusVal;
    var filters = {
      blockId: document.getElementById("filter-block").value || undefined,
      status: apiStatus,
      tag: document.getElementById("filter-tag").value || undefined,
      limit: 10000,
    };
    var result = await api.subnets.list(filters);
    _allSubnetsData = result.subnets || result;
    if (statusVal === "hide-deprecated") {
      _allSubnetsData = _allSubnetsData.filter(function (s) { return s.status !== "deprecated"; });
    }
    _rebuildServerIntegrationFilters();
    _applyLocalFilters();
    renderSubnetsPage();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function _rebuildServerIntegrationFilters() {
  var integrations = new Map(); // id → name
  _allSubnetsData.forEach(function (s) {
    if (s.integration) integrations.set(s.integration.id, s.integration.name);
  });

  var intSel = document.getElementById("filter-integration");
  var prevInt = intSel.value;
  intSel.innerHTML = '<option value="">All integrations</option><option value="__manual__">Manual</option>';
  integrations.forEach(function (name, id) {
    var opt = document.createElement("option");
    opt.value = id;
    opt.textContent = name;
    intSel.appendChild(opt);
  });
  intSel.value = prevInt;
}

function _applyLocalFilters() {
  var serverVal = document.getElementById("filter-server").value;
  var intVal = document.getElementById("filter-integration").value;
  _subnetsData = _allSubnetsData.filter(function (s) {
    if (serverVal && !(s.fortigateDevice || "").toLowerCase().includes(serverVal.toLowerCase())) return false;
    if (intVal === "__manual__" && s.integration) return false;
    if (intVal && intVal !== "__manual__" && (!s.integration || s.integration.id !== intVal)) return false;
    return true;
  });
}

function renderSubnetsPage() {
  var tbody = document.getElementById("subnets-tbody");
  if (_subnetsData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty-state">No networks found. Create one to get started.</td></tr>';
    document.getElementById("pagination").innerHTML = "";
    _subnetsUpdateSelectAll();
    return;
  }
  var sfData = _subnetsSF ? _subnetsSF.apply(_subnetsData) : _subnetsData;
  if (sfData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty-state">No results match the current filters.</td></tr>';
    document.getElementById("pagination").innerHTML = "";
    _subnetsUpdateSelectAll();
    return;
  }
  var start = (_subnetsPage - 1) * _subnetsPageSize;
  var page = sfData.slice(start, start + _subnetsPageSize);
  tbody.innerHTML = page.map(function (s) {
    var tags = (s.tags || []).map(function (t) { return escapeHtml(t); }).join(", ");
    var blockName = s.block ? escapeHtml(s.block.name) : "-";
    var fgtDevice = s.fortigateDevice ? escapeHtml(s.fortigateDevice) : "-";
    var source = s.integration
      ? escapeHtml(s.integration.name)
      : '<span style="color:var(--color-text-tertiary)">Manual</span>';
    var checked = _subnetsSelected.has(s.id) ? ' checked' : '';
    return '<tr>' +
      '<td class="cb-col"><input type="checkbox" class="row-cb"' + checked + ' data-id="' + s.id + '"></td>' +
      '<td><a href="#" class="subnet-name-link" data-subnet-id="' + s.id + '"><strong>' + escapeHtml(s.name) + '</strong></a></td>' +
      '<td class="mono">' + escapeHtml(s.cidr) + '</td>' +
      '<td>' + blockName + '</td>' +
      '<td>' + escapeHtml(s.purpose || "-") + '</td>' +
      '<td>' + (s.vlan ? '<span class="badge badge-vlan">VLAN ' + s.vlan + '</span>' : '-') + '</td>' +
      '<td>' + (s.hasConflict ? (s.conflictMessage ? '<span title="' + escapeHtml(s.conflictMessage) + '">' + statusBadge("conflict") + '</span>' : statusBadge("conflict")) : statusBadge(s.status)) + '</td>' +
      '<td>' + (tags || '<span style="color:var(--color-text-tertiary)">-</span>') + '</td>' +
      '<td>' + fgtDevice + '</td>' +
      '<td>' + source + '</td>' +
      '<td>' + (s._count ? s._count.reservations : 0) + '</td>' +
      '<td class="actions">' +
        (canManageNetworks() ? '<button class="btn btn-sm btn-secondary" onclick="openEditModal(\'' + s.id + '\')">Edit</button>' +
        '<button class="btn btn-sm btn-danger" onclick="confirmDelete(\'' + s.id + '\', \'' + escapeHtml(s.cidr) + '\', ' + (s._count ? s._count.reservations : 0) + ')">Del</button>' : '') +
      '</td></tr>';
  }).join("");
  _subnetsUpdateSelectAll();
  renderPageControls("pagination", sfData.length, _subnetsPageSize, _subnetsPage, function (p) {
    _subnetsPage = p;
    renderSubnetsPage();
  });
}

function _subnetsUpdateSelectAll() {
  var allCbs = document.querySelectorAll("#subnets-tbody input.row-cb");
  var checked = Array.from(allCbs).filter(function (cb) { return cb.checked; }).length;
  var sa = document.getElementById("subnets-select-all");
  if (!sa) return;
  sa.checked = allCbs.length > 0 && checked === allCbs.length;
  sa.indeterminate = checked > 0 && checked < allCbs.length;
}

function _subnetsUpdateBulkBar() {
  var bar = document.getElementById("subnets-bulk-bar");
  if (!bar) return;
  var count = _subnetsSelected.size;
  bar.style.display = count > 0 ? "flex" : "none";
  var el = bar.querySelector(".bulk-bar-count");
  if (el) el.textContent = count + " selected";
}

async function bulkDeleteSubnets() {
  var ids = Array.from(_subnetsSelected);
  if (!ids.length) return;
  var ok = await showConfirm("Delete " + ids.length + " network" + (ids.length !== 1 ? "s" : "") + "? This cannot be undone.");
  if (!ok) return;
  var btn = document.getElementById("subnets-bulk-delete-btn");
  if (btn) btn.disabled = true;
  var failed = 0;
  for (var i = 0; i < ids.length; i++) {
    try { await api.subnets.delete(ids[i]); }
    catch (e) { failed++; }
  }
  _subnetsSelected.clear();
  if (btn) btn.disabled = false;
  if (failed > 0) showToast(failed + " deletion(s) failed", "error");
  else showToast("Deleted " + ids.length + " network" + (ids.length !== 1 ? "s" : ""));
  loadSubnets();
}

async function openCreateModal() {
  await _ensureTagCache();
  var body = '<div class="form-group"><label>Block *</label>' + blockSelectHTML("f-blockId", true) + '</div>' +
    '<div class="form-group"><label>CIDR *</label><input type="text" id="f-cidr" placeholder="e.g. 10.0.3.0/24"></div>' +
    '<div class="form-group"><label>Name *</label><input type="text" id="f-name" placeholder="e.g. API Servers"></div>' +
    '<div class="form-group"><label>Purpose</label><textarea id="f-purpose" placeholder="What is this network for?"></textarea></div>' +
    '<div class="form-group"><label>VLAN</label><input type="number" id="f-vlan" min="1" max="4094" placeholder="1-4094"></div>' +
    tagFieldHTML([]);
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Create Network</button>';
  openModal("Add Network", body, footer);
  wireTagPicker();

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var vlan = document.getElementById("f-vlan").value;
      var input = {
        blockId: val("f-blockId"),
        cidr: val("f-cidr"),
        name: val("f-name"),
        purpose: val("f-purpose") || undefined,
        vlan: vlan ? parseInt(vlan, 10) : undefined,
        tags: getTagFieldValue(),
      };
      await api.subnets.create(input);
      closeModal();
      showToast("Network created");
      loadSubnets();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function openAllocateModal() {
  await _ensureTagCache();
  var body = '<div class="form-group"><label>Block *</label>' + blockSelectHTML("f-blockId", true) + '</div>' +
    '<div class="form-group"><label>Prefix Length *</label><input type="number" id="f-prefix" min="8" max="32" placeholder="e.g. 24"><p class="hint">/8 to /32</p></div>' +
    '<div class="form-group"><label>Name *</label><input type="text" id="f-name" placeholder="e.g. New Subnet"></div>' +
    '<div class="form-group"><label>Purpose</label><textarea id="f-purpose" placeholder="What is this network for?"></textarea></div>' +
    '<div class="form-group"><label>VLAN</label><input type="number" id="f-vlan" min="1" max="4094" placeholder="1-4094"></div>' +
    tagFieldHTML([]);
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Allocate</button>';
  openModal("Auto-Allocate Next Network", body, footer);
  wireTagPicker();

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var vlan = document.getElementById("f-vlan").value;
      var input = {
        blockId: val("f-blockId"),
        prefixLength: parseInt(val("f-prefix"), 10),
        name: val("f-name"),
        purpose: val("f-purpose") || undefined,
        vlan: vlan ? parseInt(vlan, 10) : undefined,
        tags: getTagFieldValue(),
      };
      var subnet = await api.subnets.nextAvailable(input);
      closeModal();
      showToast("Allocated " + subnet.cidr);
      loadSubnets();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function openEditModal(id) {
  try {
    var results = await Promise.all([api.subnets.get(id), _ensureTagCache()]);
    var subnet = results[0];
    var isIntegration = !!subnet.discoveredBy;
    var isDeprecatedIntegration = isIntegration && subnet.status === "deprecated" && canManageNetworks();
    var dis = isIntegration && !isDeprecatedIntegration ? ' disabled class="field-locked"' : '';
    var statusDis = isIntegration && !isDeprecatedIntegration ? ' disabled class="field-locked"' : '';
    var hasPendingMerge = !isIntegration && subnet.conflictMessage && subnet.pendingIntegration && canManageNetworks();
    var hintMsg = isDeprecatedIntegration
      ? '<p class="hint" style="margin-bottom:12px">This network was deprecated by an integration. Changing the status will convert it to a manual network.</p>'
      : (isIntegration ? '<p class="hint" style="margin-bottom:12px">This network is managed by an integration. Only purpose and tags can be edited.</p>' : '');
    if (hasPendingMerge) {
      var pi = subnet.pendingIntegration;
      var mergeDesc = pi.integrationType === "windowsserver"
        ? escapeHtml(pi.integrationName)
        : escapeHtml(pi.integrationName) + ' on ' + escapeHtml(pi.fortigateDevice);
      hintMsg = '<div class="merge-banner">' +
        '<span>This network was also discovered by <strong>' + mergeDesc + '</strong>. Merge to let the integration manage it.</span>' +
        '<button class="btn btn-sm btn-primary" id="btn-merge">Merge</button>' +
        '</div>';
    }
    var body = hintMsg +
      '<div class="form-group"><label>CIDR</label><input type="text" value="' + escapeHtml(subnet.cidr) + '" disabled class="field-locked"></div>' +
      '<div class="form-group"><label>Name</label><input type="text" id="f-name" value="' + escapeHtml(subnet.name) + '"' + dis + '></div>' +
      '<div class="form-group"><label>Purpose</label><textarea id="f-purpose">' + escapeHtml(subnet.purpose || "") + '</textarea></div>' +
      '<div class="form-group"><label>Status</label><select id="f-status"' + statusDis + '><option value="available"' + (subnet.status === "available" ? " selected" : "") + '>Available</option><option value="reserved"' + (subnet.status === "reserved" ? " selected" : "") + '>Reserved</option><option value="deprecated"' + (subnet.status === "deprecated" ? " selected" : "") + '>Deprecated</option></select></div>' +
      '<div class="form-group"><label>VLAN</label><input type="number" id="f-vlan" min="1" max="4094" value="' + (subnet.vlan || "") + '" placeholder="Empty to clear"' + dis + '></div>' +
      tagFieldHTML(subnet.tags || []);
    var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal("Edit Network", body, footer);
    wireTagPicker();

    if (hasPendingMerge) {
      document.getElementById("btn-merge").addEventListener("click", async function () {
        var mergeBtn = this;
        var pi = subnet.pendingIntegration;
        var mergeLabel = pi.integrationType === "windowsserver"
          ? pi.integrationName
          : pi.integrationName + ' on ' + pi.fortigateDevice;
        var ok = await showConfirm('Merge this network with "' + mergeLabel + '"? It will become managed by the integration.');
        if (!ok) return;
        mergeBtn.disabled = true;
        try {
          await api.subnets.update(id, { mergeIntegration: true });
          closeModal();
          showToast("Network merged with integration");
          loadSubnets();
        } catch (err) {
          showToast(err.message, "error");
        } finally {
          mergeBtn.disabled = false;
        }
      });
    }

    document.getElementById("btn-save").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      try {
        var input = {
          purpose: val("f-purpose") || undefined,
          tags: getTagFieldValue(),
        };
        if (!isIntegration) {
          var vlanVal = document.getElementById("f-vlan").value;
          input.name = val("f-name") || undefined;
          input.status = val("f-status");
          input.vlan = vlanVal ? parseInt(vlanVal, 10) : null;
        } else if (isDeprecatedIntegration) {
          var newStatus = val("f-status");
          input.status = newStatus;
          if (newStatus !== "deprecated") {
            input.convertToManual = true;
          }
        }
        await api.subnets.update(id, input);
        closeModal();
        showToast("Network updated");
        loadSubnets();
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

async function confirmDelete(id, cidr, reservationCount) {
  var msg = 'Delete network "' + cidr + '"?';
  if (reservationCount > 0) {
    msg += ' This will also delete ' + reservationCount + ' reservation' + (reservationCount !== 1 ? 's' : '') + '.';
  }
  msg += ' This cannot be undone.';
  var ok = await showConfirm(msg);
  if (!ok) return;
  try {
    await api.subnets.delete(id);
    showToast("Network deleted");
    loadSubnets();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function val(id) { return document.getElementById(id).value.trim(); }

function debounce(fn, ms) {
  var timer;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/* ─── PDF Export ──────────────────────────────────────────────────────────── */

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
      await handleNetworkExport(this.getAttribute("data-export"), this.getAttribute("data-fmt"));
    });
  });
})();

async function handleNetworkExport(mode, fmt) {
  var networks, label, ok;

  if (mode === "page") {
    networks = _subnetsData.slice((_subnetsPage - 1) * _subnetsPageSize, _subnetsPage * _subnetsPageSize);
    label = "page " + _subnetsPage;
  } else if (mode === "filtered") {
    networks = _subnetsData;
    label = networks.length + " filtered networks";
    if (networks.length > 100) {
      ok = await showConfirm("This will export " + networks.length + " networks. Continue?");
      if (!ok) return;
    }
  } else if (mode === "all") {
    ok = await showConfirm("Export the entire network list? This may take a moment.");
    if (!ok) return;
  }

  await trackedPdfExport("Exporting networks " + fmt.toUpperCase(), async function (signal) {
    if (mode === "all") {
      var allResult = await request("GET", "/subnets?limit=200", undefined, signal);
      networks = allResult.subnets || allResult;
      label = "all " + networks.length + " networks";
    }
    if (signal.aborted) return;
    if (!networks || networks.length === 0) { showToast("No networks to export", "error"); return; }
    if (fmt === "csv") generateNetworkCsv(networks);
    else generateNetworkPdf(networks, label);
  });
}

function generateNetworkPdf(networks, label) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("PDF library not loaded. Check your internet connection and reload the page.");
  }
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });

  var now = new Date();
  var timestamp = now.toLocaleDateString() + " " + now.toLocaleTimeString();

  doc.setFontSize(16);
  doc.setTextColor(40, 40, 40);
  doc.text((_branding ? _branding.appName : "Shelob") + " \u2014 Network Report", 40, 36);
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text("Generated: " + timestamp + "  |  Scope: " + label + "  |  Count: " + networks.length, 40, 52);

  var head = [["Name", "Network", "Block", "Purpose", "VLAN", "Status", "Server", "Integration", "Reservations"]];
  var body = networks.map(function (s) {
    return [
      s.name || "-",
      s.cidr || "-",
      s.block ? s.block.name : "-",
      s.purpose || "-",
      s.vlan ? "VLAN " + s.vlan : "-",
      s.hasConflict ? ("Conflict" + (s.conflictMessage ? ": " + s.conflictMessage : "")) : (s.status ? s.status.charAt(0).toUpperCase() + s.status.slice(1) : "-"),
      s.fortigateDevice || "-",
      s.integration ? s.integration.name : "Manual",
      s._count ? String(s._count.reservations) : "0",
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
      var pageNum = doc.internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(
        "Page " + data.pageNumber + " of " + pageNum + "  |  " + (_branding ? _branding.appName : "Shelob") + " Network Report",
        doc.internal.pageSize.getWidth() / 2,
        doc.internal.pageSize.getHeight() - 20,
        { align: "center" }
      );
    },
  });

  var filename = "shelob-networks-" + now.toISOString().slice(0, 10) + ".pdf";
  doc.save(filename);
  showToast("Exported " + networks.length + " networks to " + filename);
}

function generateNetworkCsv(networks) {
  var headers = ["Name", "Network", "Block", "Purpose", "VLAN", "Status", "Tags", "Server", "Integration", "Reservations"];
  var rows = networks.map(function (s) {
    return [
      s.name || "", s.cidr || "", s.block ? s.block.name : "",
      s.purpose || "", s.vlan ? String(s.vlan) : "", s.hasConflict ? ("Conflict" + (s.conflictMessage ? ": " + s.conflictMessage : "")) : (s.status || ""),
      (s.tags || []).join("; "), s.fortigateDevice || "",
      s.integration ? s.integration.name : "Manual",
      s._count ? String(s._count.reservations) : "0",
    ];
  });
  var filename = "shelob-networks-" + new Date().toISOString().slice(0, 10) + ".csv";
  downloadCsv(headers, rows, filename);
  showToast("Exported " + networks.length + " networks to " + filename);
}
