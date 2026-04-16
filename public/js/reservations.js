/**
 * public/js/reservations.js — Reservations list + CRUD
 */

var cachedSubnets = [];
var _resPageSize = 15;
var _resPage = 1;
var _resData = [];

document.addEventListener("DOMContentLoaded", async function () {
  await loadSubnetOptions();
  loadReservations();

  document.getElementById("btn-add-reservation").addEventListener("click", openCreateModal);
  document.getElementById("filter-status").addEventListener("change", function () { _resPage = 1; loadReservations(); });
  document.getElementById("filter-owner").addEventListener("input", debounce(function () { _resPage = 1; loadReservations(); }, 300));
  document.getElementById("filter-project").addEventListener("input", debounce(function () { _resPage = 1; loadReservations(); }, 300));
  document.getElementById("filter-pagesize").addEventListener("change", function () {
    _resPageSize = parseInt(this.value, 10) || 15;
    _resPage = 1;
    renderReservationsPage();
  });
});

async function loadSubnetOptions() {
  try {
    cachedSubnets = await api.subnets.list();
  } catch (err) {
    showToast("Failed to load networks: " + err.message, "error");
  }
}

function subnetSelectHTML(id) {
  var opts = '<option value="">Select a network...</option>';
  cachedSubnets.forEach(function (s) {
    opts += '<option value="' + s.id + '">' + escapeHtml(s.name) + ' (' + escapeHtml(s.cidr) + ')</option>';
  });
  return '<select id="' + id + '">' + opts + '</select>';
}

async function loadReservations() {
  var tbody = document.getElementById("reservations-tbody");
  try {
    var filters = {
      status: document.getElementById("filter-status").value || undefined,
      owner: document.getElementById("filter-owner").value || undefined,
      projectRef: document.getElementById("filter-project").value || undefined,
    };
    _resData = await api.reservations.list(filters);
    renderReservationsPage();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function renderReservationsPage() {
  var tbody = document.getElementById("reservations-tbody");
  if (_resData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No reservations found. Create one to get started.</td></tr>';
    document.getElementById("pagination").innerHTML = "";
    return;
  }
  var start = (_resPage - 1) * _resPageSize;
  var page = _resData.slice(start, start + _resPageSize);
  tbody.innerHTML = page.map(function (r) {
    var subnetLabel = r.subnet ? escapeHtml(r.subnet.name) + ' <code>' + escapeHtml(r.subnet.cidr) + '</code>' : escapeHtml(r.subnetId);
    var ipLabel = r.ipAddress ? '<code>' + escapeHtml(r.ipAddress) + '</code>' : '<span style="color:var(--color-text-tertiary)">Full network</span>';
    var expires = r.expiresAt ? formatDate(r.expiresAt) : '<span style="color:var(--color-text-tertiary)">Never</span>';
    var actions = '<button class="btn btn-sm btn-secondary" onclick="openEditModal(\'' + r.id + '\')">Edit</button>';
    if (r.status === "active") {
      actions += '<button class="btn btn-sm btn-danger" onclick="confirmRelease(\'' + r.id + '\')">Release</button>';
    }
    return '<tr>' +
      '<td>' + subnetLabel + '</td>' +
      '<td>' + ipLabel + '</td>' +
      '<td>' + escapeHtml(r.hostname || "-") + '</td>' +
      '<td>' + escapeHtml(r.owner) + '</td>' +
      '<td>' + escapeHtml(r.projectRef) + '</td>' +
      '<td>' + statusBadge(r.status) + '</td>' +
      '<td>' + expires + '</td>' +
      '<td>' + formatDate(r.createdAt) + '</td>' +
      '<td class="actions">' + actions + '</td></tr>';
  }).join("");
  renderPageControls("pagination", _resData.length, _resPageSize, _resPage, function (p) {
    _resPage = p;
    renderReservationsPage();
  });
}

function openCreateModal() {
  var body = '<div class="form-group"><label>Network *</label>' + subnetSelectHTML("f-subnetId") + '</div>' +
    '<div class="form-group"><label>IP Address</label><input type="text" id="f-ipAddress" placeholder="Leave blank for full-network reservation"><p class="hint">e.g. 10.0.1.10</p></div>' +
    '<div class="form-group"><label>Hostname</label><input type="text" id="f-hostname" placeholder="e.g. web-server-01"></div>' +
    '<div class="form-group"><label>Owner *</label><input type="text" id="f-owner" placeholder="e.g. platform-team"></div>' +
    '<div class="form-group"><label>Project Ref *</label><input type="text" id="f-projectRef" placeholder="e.g. INFRA-001"></div>' +
    '<div class="form-group"><label>Expires At</label><input type="datetime-local" id="f-expiresAt"><p class="hint">Optional TTL</p></div>' +
    '<div class="form-group"><label>Notes</label><textarea id="f-notes" placeholder="Optional notes"></textarea></div>';
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Create Reservation</button>';
  openModal("Add Reservation", body, footer);

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var expiresVal = document.getElementById("f-expiresAt").value;
      var input = {
        subnetId: val("f-subnetId"),
        ipAddress: val("f-ipAddress") || undefined,
        hostname: val("f-hostname") || undefined,
        owner: val("f-owner"),
        projectRef: val("f-projectRef"),
        expiresAt: expiresVal ? new Date(expiresVal).toISOString() : undefined,
        notes: val("f-notes") || undefined,
      };
      await api.reservations.create(input);
      closeModal();
      showToast("Reservation created");
      loadReservations();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function openEditModal(id) {
  try {
    var r = await api.reservations.get(id);
    var subnetLabel = r.subnet ? escapeHtml(r.subnet.name) + " (" + escapeHtml(r.subnet.cidr) + ")" : r.subnetId;
    var expiresVal = r.expiresAt ? toDatetimeLocal(r.expiresAt) : "";
    var body = '<div class="form-group"><label>Network</label><input type="text" value="' + subnetLabel + '" disabled></div>' +
      '<div class="form-group"><label>IP Address</label><input type="text" value="' + escapeHtml(r.ipAddress || "Full network") + '" disabled></div>' +
      '<div class="form-group"><label>Status</label>' + statusBadge(r.status) + '</div>' +
      '<div class="form-group"><label>Hostname</label><input type="text" id="f-hostname" value="' + escapeHtml(r.hostname || "") + '"></div>' +
      '<div class="form-group"><label>Owner</label><input type="text" id="f-owner" value="' + escapeHtml(r.owner) + '"></div>' +
      '<div class="form-group"><label>Project Ref</label><input type="text" id="f-projectRef" value="' + escapeHtml(r.projectRef) + '"></div>' +
      '<div class="form-group"><label>Expires At</label><input type="datetime-local" id="f-expiresAt" value="' + expiresVal + '"></div>' +
      '<div class="form-group"><label>Notes</label><textarea id="f-notes">' + escapeHtml(r.notes || "") + '</textarea></div>';
    var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal("Edit Reservation", body, footer);

    document.getElementById("btn-save").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      try {
        var expiresVal = document.getElementById("f-expiresAt").value;
        var input = {
          hostname: val("f-hostname") || undefined,
          owner: val("f-owner") || undefined,
          projectRef: val("f-projectRef") || undefined,
          expiresAt: expiresVal ? new Date(expiresVal).toISOString() : undefined,
          notes: val("f-notes") || undefined,
        };
        await api.reservations.update(id, input);
        closeModal();
        showToast("Reservation updated");
        loadReservations();
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

async function confirmRelease(id) {
  var ok = await showConfirm("Release this reservation? This will free the IP/network.");
  if (!ok) return;
  try {
    await api.reservations.release(id);
    showToast("Reservation released");
    loadReservations();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function toDatetimeLocal(isoStr) {
  var d = new Date(isoStr);
  var pad = function (n) { return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function val(id) { return document.getElementById(id).value.trim(); }

function debounce(fn, ms) {
  var timer;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
