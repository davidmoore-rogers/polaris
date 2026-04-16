/**
 * public/js/assets.js — Asset management page
 */

var _assetsPageSize = 15;
var _assetsPage = 1;
var _assetsData = [];

document.addEventListener("DOMContentLoaded", function () {
  loadAssets();

  var addBtn = document.getElementById("btn-add-asset");
  if (addBtn) addBtn.addEventListener("click", openCreateModal);
  document.getElementById("filter-status").addEventListener("change", function () { _assetsPage = 1; loadAssets(); });
  document.getElementById("filter-type").addEventListener("change", function () { _assetsPage = 1; loadAssets(); });
  document.getElementById("filter-search").addEventListener("input", debounce(function () { _assetsPage = 1; loadAssets(); }, 300));
  document.getElementById("filter-pagesize").addEventListener("change", function () {
    _assetsPageSize = parseInt(this.value, 10) || 15;
    _assetsPage = 1;
    renderAssetsPage();
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
  var tbody = document.getElementById("assets-tbody");
  try {
    var filters = {
      status: document.getElementById("filter-status").value || undefined,
      assetType: document.getElementById("filter-type").value || undefined,
      search: document.getElementById("filter-search").value || undefined,
    };
    _assetsData = await api.assets.list(filters);
    renderAssetsPage();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function renderAssetsPage() {
  var tbody = document.getElementById("assets-tbody");
  if (_assetsData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No assets found. Add one to get started.</td></tr>';
    document.getElementById("pagination").innerHTML = "";
    return;
  }
  var start = (_assetsPage - 1) * _assetsPageSize;
  var page = _assetsData.slice(start, start + _assetsPageSize);
  tbody.innerHTML = page.map(function (a) {
    return '<tr>' +
      '<td><strong>' + escapeHtml(a.hostname || "-") + '</strong>' +
        (a.assetTag ? '<br><span class="asset-tag-label">' + escapeHtml(a.assetTag) + '</span>' : '') +
      '</td>' +
      '<td class="mono">' + escapeHtml(a.ipAddress || "-") + '</td>' +
      '<td class="mono" style="font-size:0.8rem">' + escapeHtml(a.macAddress || "-") + '</td>' +
      '<td>' + escapeHtml(a.serialNumber || "-") + '</td>' +
      '<td>' + escapeHtml(a.dnsName || "-") + '</td>' +
      '<td>' + assetTypeBadge(a.assetType) + '</td>' +
      '<td>' + assetStatusBadge(a.status) + '</td>' +
      '<td>' + escapeHtml(a.location || "-") + '</td>' +
      '<td>' + escapeHtml(a.assignedTo || "-") + '</td>' +
      '<td>' + (a.acquiredAt ? formatDate(a.acquiredAt) : "-") + '</td>' +
      '<td class="actions">' +
        '<button class="btn btn-sm btn-secondary" onclick="openViewModal(\'' + a.id + '\')">View</button>' +
        (isAdmin() ? '<button class="btn btn-sm btn-secondary" onclick="openEditModal(\'' + a.id + '\')">Edit</button>' +
        '<button class="btn btn-sm btn-danger" onclick="confirmDelete(\'' + a.id + '\', \'' + escapeHtml(a.hostname || a.assetTag || a.ipAddress || "this asset") + '\')">Del</button>' : '') +
      '</td></tr>';
  }).join("");
  renderPageControls("pagination", _assetsData.length, _assetsPageSize, _assetsPage, function (p) {
    _assetsPage = p;
    renderAssetsPage();
  });
}

function assetTypeBadge(type) {
  var label = ASSET_TYPE_LABELS[type] || type;
  return '<span class="badge badge-asset-type">' + escapeHtml(label) + '</span>';
}

function assetStatusBadge(status) {
  var cls = "badge-" + status;
  var label = status.charAt(0).toUpperCase() + status.slice(1);
  return '<span class="badge ' + cls + '">' + escapeHtml(label) + '</span>';
}

function assetFormHTML(defaults) {
  var d = defaults || {};
  return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Hostname</label><input type="text" id="f-hostname" value="' + escapeHtml(d.hostname || "") + '" placeholder="e.g. server-01"></div>' +
    '<div class="form-group"><label>DNS Name</label><input type="text" id="f-dnsName" value="' + escapeHtml(d.dnsName || "") + '" placeholder="e.g. server-01.corp.local"></div>' +
    '<div class="form-group"><label>IP Address</label><input type="text" id="f-ipAddress" value="' + escapeHtml(d.ipAddress || "") + '" placeholder="e.g. 10.0.1.50"></div>' +
    '<div class="form-group"><label>MAC Address</label><input type="text" id="f-macAddress" value="' + escapeHtml(d.macAddress || "") + '" placeholder="e.g. AA:BB:CC:DD:EE:FF"></div>' +
  '</div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Asset Details</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Asset Tag</label><input type="text" id="f-assetTag" value="' + escapeHtml(d.assetTag || "") + '" placeholder="e.g. RGI-00421"></div>' +
    '<div class="form-group"><label>Serial Number</label><input type="text" id="f-serialNumber" value="' + escapeHtml(d.serialNumber || "") + '" placeholder="e.g. SN12345678"></div>' +
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
      '<option value="active"' + (d.status === "active" || !d.status ? " selected" : "") + '>Active</option>' +
      '<option value="maintenance"' + (d.status === "maintenance" ? " selected" : "") + '>Maintenance</option>' +
      '<option value="decommissioned"' + (d.status === "decommissioned" ? " selected" : "") + '>Decommissioned</option>' +
      '<option value="storage"' + (d.status === "storage" ? " selected" : "") + '>Storage</option>' +
    '</select></div>' +
  '</div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Location & Ownership</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Location</label><input type="text" id="f-location" value="' + escapeHtml(d.location || "") + '" placeholder="e.g. DC1 Rack A3"></div>' +
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
  '<div class="form-group"><label>Tags</label><input type="text" id="f-tags" value="' + escapeHtml(tagsToString(d.tags)) + '" placeholder="Comma-separated tags"><p class="hint">e.g. prod, rack-a3, critical</p></div>';
}

function getAssetFormData() {
  var acq = document.getElementById("f-acquiredAt").value;
  var war = document.getElementById("f-warrantyExpiry").value;
  return {
    hostname:      val("f-hostname") || undefined,
    dnsName:       val("f-dnsName") || undefined,
    ipAddress:     val("f-ipAddress") || undefined,
    macAddress:    val("f-macAddress") || undefined,
    assetTag:      val("f-assetTag") || undefined,
    serialNumber:  val("f-serialNumber") || undefined,
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
    tags:          tagsToArray(val("f-tags")),
  };
}

function openCreateModal() {
  var body = assetFormHTML({});
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">Create Asset</button>';
  openModal("Add Asset", body, footer);
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
    var asset = await api.assets.get(id);
    var body = assetFormHTML(asset);
    var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal("Edit Asset", body, footer);
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

async function openViewModal(id) {
  try {
    var a = await api.assets.get(id);
    var body = '<div class="asset-view-grid">' +
      viewRow("Hostname", a.hostname) +
      viewRow("DNS Name", a.dnsName) +
      viewRow("IP Address", a.ipAddress, true) +
      viewRow("MAC Address", a.macAddress, true) +
      viewRow("Asset Tag", a.assetTag) +
      viewRow("Serial Number", a.serialNumber) +
      viewRow("Manufacturer", a.manufacturer) +
      viewRow("Model", a.model) +
      viewRow("Type", ASSET_TYPE_LABELS[a.assetType] || a.assetType) +
      viewRow("Status", a.status ? a.status.charAt(0).toUpperCase() + a.status.slice(1) : "-") +
      viewRow("Location", a.location) +
      viewRow("Department", a.department) +
      viewRow("Assigned To", a.assignedTo) +
      viewRow("Operating System", a.os) +
      viewRow("Acquired", a.acquiredAt ? formatDate(a.acquiredAt) : null) +
      viewRow("Warranty Expires", a.warrantyExpiry ? formatDate(a.warrantyExpiry) : null) +
      viewRow("Purchase Order", a.purchaseOrder) +
      viewRow("Tags", (a.tags || []).join(", ") || null) +
      viewRow("Notes", a.notes) +
      viewRow("Created", formatDate(a.createdAt)) +
      viewRow("Updated", formatDate(a.updatedAt)) +
    '</div>';
    var footer = isAdmin()
      ? '<button class="btn btn-secondary" onclick="closeModal()">Close</button><button class="btn btn-primary" onclick="closeModal();openEditModal(\'' + a.id + '\')">Edit</button>'
      : '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';
    openModal("Asset Details", body, footer);
  } catch (err) {
    showToast(err.message, "error");
  }
}

function viewRow(label, value, mono) {
  return '<div class="detail-row"><span class="detail-label">' + escapeHtml(label) + '</span>' +
    '<span class="detail-value' + (mono ? ' mono' : '') + '">' + escapeHtml(value || "-") + '</span></div>';
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
