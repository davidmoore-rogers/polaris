/**
 * public/js/ip-panel.js — Slide-over IP panel for networks page
 */

var _ipPanelSubnetId = null;
var _ipPanelPage = 1;
var _ipPanelPageSize = 256;
var _ipPanelData = null;
var _ipPanelDirty = false;
var _panelSelected = new Set();

// ─── Panel lifecycle ────────────────────────────────────────────────────────

function _ensurePanelDOM() {
  if (document.getElementById("ip-panel-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "ip-panel-overlay";
  overlay.className = "slideover-overlay";
  overlay.innerHTML =
    '<div class="slideover" id="ip-panel">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="ip-panel-title"></h3>' +
          '<button class="btn-icon" id="ip-panel-close" title="Close">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta" id="ip-panel-meta"></div>' +
      '</div>' +
      '<div class="slideover-body" id="ip-panel-body">' +
        '<p class="empty-state">Loading...</p>' +
      '</div>' +
      '<div class="slideover-footer" id="ip-panel-footer"></div>' +
    '</div>';
  document.body.appendChild(overlay);

  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeIpPanel();
  });
  document.getElementById("ip-panel-close").addEventListener("click", closeIpPanel);

  initSlideoverResize(document.getElementById("ip-panel"), "shelob.panel.width.ip");
}

function openIpPanel(subnetId) {
  _ensurePanelDOM();
  _ipPanelSubnetId = subnetId;
  _ipPanelPage = 1;
  _ipPanelDirty = false;
  _panelSelected.clear();
  document.getElementById("ip-panel-title").textContent = "Loading...";
  document.getElementById("ip-panel-meta").innerHTML = "";
  document.getElementById("ip-panel-body").innerHTML = '<p class="empty-state">Loading...</p>';
  document.getElementById("ip-panel-footer").innerHTML = "";
  requestAnimationFrame(function () {
    document.getElementById("ip-panel-overlay").classList.add("open");
  });
  _fetchIpPage();
}

function closeIpPanel() {
  var overlay = document.getElementById("ip-panel-overlay");
  if (overlay) overlay.classList.remove("open");
  var activeRow = document.querySelector("tr.row-panel-active");
  if (activeRow) activeRow.classList.remove("row-panel-active");
  if (_ipPanelDirty && typeof loadSubnets === "function") loadSubnets();
  _ipPanelSubnetId = null;
  _ipPanelData = null;
  _ipPanelDirty = false;
}

async function _fetchIpPage() {
  try {
    var data = await api.subnets.ips(_ipPanelSubnetId, { page: _ipPanelPage, pageSize: _ipPanelPageSize });
    _ipPanelData = data;
    _renderPanelHeader(data);
    _renderIpList(data);
    _renderPanelFooter(data);
  } catch (err) {
    document.getElementById("ip-panel-body").innerHTML =
      '<p class="empty-state">Error: ' + escapeHtml(err.message) + '</p>';
  }
}

// ─── Render helpers ─────────────────────────────────────────────────────────

function _renderPanelHeader(data) {
  var s = data.subnet;
  document.getElementById("ip-panel-title").innerHTML =
    escapeHtml(s.name) + ' <code style="font-size:0.85rem;margin-left:4px">' + escapeHtml(s.cidr) + '</code>';

  var meta = '';
  if (s.status) {
    var badge = statusBadge(s.hasConflict ? "conflict" : s.status);
    meta += s.conflictMessage ? '<span title="' + escapeHtml(s.conflictMessage) + '" style="cursor:help">' + badge + '</span>' : badge;
  }
  if (s.vlan) meta += '<span class="badge badge-vlan">VLAN ' + s.vlan + '</span>';
  if (s.integration) meta += '<span style="font-size:0.78rem;color:var(--color-text-secondary)">Integration: <strong>' + escapeHtml(s.integration.name) + '</strong></span>';
  if (s.fortigateDevice && (!s.integration || s.integration.type !== 'windowsserver')) meta += '<span style="font-size:0.78rem;color:var(--color-text-secondary)">Server: <strong>' + escapeHtml(s.fortigateDevice) + '</strong></span>';
  if (s.purpose) meta += '<span style="color:var(--color-text-tertiary)">' + escapeHtml(s.purpose) + '</span>';
  if (data.ipv6) meta += '<span style="color:var(--color-warning);font-size:0.75rem">IPv6 — showing reservations only</span>';

  var headerBtns = '<span style="margin-left:auto;display:flex;gap:6px">' +
    (canManageNetworks() && !data.ipv6 ? '<button class="btn btn-sm btn-danger" id="ip-panel-free-selected-btn" disabled>Free Selected</button>' : '') +
    '<div class="btn-dropdown-wrap">' +
      '<button class="btn btn-sm btn-secondary" id="ip-panel-export-btn">Export &#9662;</button>' +
      '<div class="btn-dropdown-menu" id="ip-panel-export-menu">' +
        '<button data-fmt="pdf">Export as PDF</button>' +
        '<button data-fmt="csv">Export as CSV</button>' +
      '</div>' +
    '</div>' +
    (canReserveIps() && !data.ipv6 ? '<button class="btn btn-sm btn-secondary" id="ip-panel-auto-alloc-btn">Auto-Allocate Next</button>' : '') +
    (canReserveIps() ? '<button class="btn btn-sm btn-primary" id="ip-panel-reserve-btn">+ Reserve IP</button>' : '') +
    '</span>';
  meta += headerBtns;

  document.getElementById("ip-panel-meta").innerHTML = meta;

  var allocBtn = document.getElementById("ip-panel-auto-alloc-btn");
  if (allocBtn) {
    allocBtn.addEventListener("click", function () {
      _openAutoAllocateModal(_ipPanelSubnetId);
    });
  }
  var btn = document.getElementById("ip-panel-reserve-btn");
  if (btn) {
    btn.addEventListener("click", function () {
      _openReserveModal(_ipPanelSubnetId, null);
    });
  }
  var freeBtn = document.getElementById("ip-panel-free-selected-btn");
  if (freeBtn) freeBtn.addEventListener("click", _bulkReleaseFromPanel);

  var exportBtn = document.getElementById("ip-panel-export-btn");
  var exportMenu = document.getElementById("ip-panel-export-menu");
  if (exportBtn && exportMenu) {
    exportBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      exportMenu.classList.toggle("open");
    });
    exportMenu.addEventListener("click", function (e) { e.stopPropagation(); });
    exportMenu.querySelectorAll("button[data-fmt]").forEach(function (item) {
      item.addEventListener("click", function () {
        exportMenu.classList.remove("open");
        _exportIpPanel(item.getAttribute("data-fmt"));
      });
    });
  }
}

function _renderIpList(data) {
  var body = document.getElementById("ip-panel-body");

  if (data.ips.length === 0) {
    body.innerHTML = '<p class="empty-state">No IPs to display</p>';
    return;
  }

  var hasReleasable = data.ips.some(function (ip) {
    return !ip.type && ip.reservation && ip.reservation.status === "active" && canManageNetworks();
  });

  var html = '<table class="ip-table"><thead><tr>' +
    '<th class="cb-col">' + (hasReleasable ? '<input type="checkbox" id="panel-select-all" title="Select all active">' : '') + '</th>' +
    '<th style="width:36px"></th>' +
    '<th>IP Address</th>' +
    '<th>Hostname</th>' +
    '<th>MAC Address</th>' +
    '<th>Owner</th>' +
    '<th>Lease Expiry</th>' +
    '<th>Status</th>' +
    '<th style="width:140px">Actions</th>' +
    '</tr></thead><tbody>';

  data.ips.forEach(function (ip) {
    var isSpecial = ip.type === "network" || ip.type === "broadcast";
    var r = ip.reservation;
    var rowClass = isSpecial ? ' class="ip-row-special"' : '';

    var dotClass, statusLabel, statusTooltip = "";
    if (isSpecial) {
      dotClass = "ip-dot-reserved";
      statusLabel = ip.type === "network" ? "Network" : "Broadcast";
    } else if (r && r.conflictMessage) {
      dotClass = "ip-dot-conflict";
      statusLabel = "Conflict";
      statusTooltip = r.conflictMessage;
    } else if (r && r.status === "active" && r.owner === "dhcp-reservation") {
      dotClass = "ip-dot-dhcp-reservation";
      statusLabel = "DHCP Reservation";
    } else if (r && r.status === "active" && r.owner === "dhcp-lease") {
      dotClass = "ip-dot-dhcp-lease";
      statusLabel = "DHCP Lease";
    } else if (r && r.status === "active") {
      dotClass = "ip-dot-active";
      statusLabel = "Active";
    } else if (r && r.status === "expired") {
      dotClass = "ip-dot-expired";
      statusLabel = "Expired";
    } else if (r && r.status === "released") {
      dotClass = "ip-dot-released";
      statusLabel = "Released";
    } else {
      dotClass = "ip-dot-available";
      statusLabel = "Available";
    }

    var hostnameText = r ? escapeHtml(r.hostname || "-") : '<span style="color:var(--color-text-tertiary)">-</span>';
    var vipBadge = "";
    if (r && r.vipInfo) {
      var vi = r.vipInfo;
      var vipTip = "VIP: " + escapeHtml(vi.name || "") + " (" + escapeHtml(vi.role || "") + ") on " + escapeHtml(vi.device || "") + " — ext: " + escapeHtml(vi.extip || "");
      vipBadge = ' <span class="vip-badge" title="' + vipTip + '">VIP</span>';
    }
    var hostname = hostnameText + vipBadge;
    var macMatch = r && r.notes ? r.notes.match(/MAC:\s*([\w:]+)/) : null;
    var macDisplay = macMatch
      ? '<span class="mono" style="font-size:0.75rem">' + escapeHtml(macMatch[1]) + '</span>'
      : '<span style="color:var(--color-text-tertiary)">-</span>';
    var ownerDisplay = !r
      ? '<span style="color:var(--color-text-tertiary)">-</span>'
      : escapeHtml(r.owner || "-");
    var owner = ownerDisplay;

    var actions = "";
    var isOwner = r && r.createdBy === currentUsername;
    var canEditThis = canManageNetworks() || isOwner;
    var assetBtn = ip.assetId
      ? '<button class="btn btn-sm btn-secondary ip-asset-btn" data-aid="' + escapeHtml(ip.assetId) + '" title="View asset record">Asset</button>'
      : '';
    if (isSpecial) {
      actions = "";
    } else if (r && r.status === "active") {
      actions =
        assetBtn +
        (canEditThis ? '<button class="btn btn-sm btn-secondary ip-edit-btn" data-rid="' + r.id + '" title="Edit">Edit</button>' : '') +
        (canEditThis ? '<button class="btn btn-sm btn-danger ip-release-btn" data-rid="' + r.id + '" title="Release">Free</button>' : '');
    } else if (r && r.status === "expired") {
      actions = assetBtn + (canEditThis ? '<button class="btn btn-sm btn-secondary ip-edit-btn" data-rid="' + r.id + '" title="Edit">Edit</button>' : '');
    } else if (!r && canReserveIps()) {
      actions = assetBtn + '<button class="btn btn-sm btn-primary ip-reserve-btn" data-ip="' + escapeHtml(ip.address) + '">Reserve</button>';
    } else {
      actions = assetBtn;
    }

    var statusHtml = statusTooltip
      ? '<span class="conflict-label" title="' + escapeHtml(statusTooltip) + '">' + statusLabel + ' <span class="conflict-icon">&#9888;</span></span>'
      : statusLabel;

    var leaseExpiry = r && r.expiresAt
      ? '<span style="font-size:0.75rem">' + escapeHtml(formatDate(r.expiresAt)) + '</span>'
      : '<span style="color:var(--color-text-tertiary)">-</span>';

    var canRelease = !isSpecial && r && r.status === "active" && canManageNetworks();
    var cbChecked = canRelease && _panelSelected.has(r.id) ? ' checked' : '';
    var cbCell = canRelease
      ? '<td class="cb-col"><input type="checkbox" class="panel-row-cb"' + cbChecked + ' data-rid="' + r.id + '"></td>'
      : '<td class="cb-col"></td>';

    html += '<tr' + rowClass + '>' +
      cbCell +
      '<td style="text-align:center"><span class="ip-status-dot ' + dotClass + '"></span></td>' +
      '<td class="mono" style="font-size:0.8rem">' + escapeHtml(ip.address) + '</td>' +
      '<td>' + hostname + '</td>' +
      '<td>' + macDisplay + '</td>' +
      '<td>' + owner + '</td>' +
      '<td>' + leaseExpiry + '</td>' +
      '<td style="font-size:0.78rem">' + statusHtml + '</td>' +
      '<td class="actions">' + actions + '</td>' +
      '</tr>';
  });

  html += '</tbody></table>';

  // Pagination
  var totalPages = Math.max(1, Math.ceil(data.totalIps / data.pageSize));
  if (totalPages > 1) {
    html += '<div class="slideover-pagination">' +
      '<button class="btn btn-sm btn-secondary" id="ip-pg-prev"' + (_ipPanelPage <= 1 ? ' disabled' : '') + '>&laquo;</button>' +
      '<span style="font-size:0.8rem;color:var(--color-text-secondary)">Page ' + _ipPanelPage + ' of ' + totalPages + '</span>' +
      '<button class="btn btn-sm btn-secondary" id="ip-pg-next"' + (_ipPanelPage >= totalPages ? ' disabled' : '') + '>&raquo;</button>' +
      '</div>';
  }

  body.innerHTML = html;

  // Wire up bulk selection
  var panelSelectAll = document.getElementById("panel-select-all");
  if (panelSelectAll) {
    panelSelectAll.addEventListener("change", function () {
      var cbs = body.querySelectorAll(".panel-row-cb");
      var chk = this.checked;
      cbs.forEach(function (cb) {
        cb.checked = chk;
        if (chk) _panelSelected.add(cb.getAttribute("data-rid"));
        else _panelSelected.delete(cb.getAttribute("data-rid"));
      });
      _panelUpdateBulkBar();
    });
  }
  body.addEventListener("change", function (e) {
    var cb = e.target;
    if (!cb.classList.contains("panel-row-cb")) return;
    var rid = cb.getAttribute("data-rid");
    if (cb.checked) _panelSelected.add(rid);
    else _panelSelected.delete(rid);
    _panelUpdateSelectAll();
    _panelUpdateBulkBar();
  });
  _panelUpdateBulkBar();
  _panelUpdateSelectAll();

  // Wire up pagination
  var prevBtn = document.getElementById("ip-pg-prev");
  var nextBtn = document.getElementById("ip-pg-next");
  if (prevBtn) prevBtn.addEventListener("click", function () { _ipPanelPage--; _panelSelected.clear(); _fetchIpPage(); });
  if (nextBtn) nextBtn.addEventListener("click", function () { _ipPanelPage++; _panelSelected.clear(); _fetchIpPage(); });

  // Wire up action buttons
  body.querySelectorAll(".ip-edit-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      _openEditReservationModal(btn.getAttribute("data-rid"));
    });
  });
  body.querySelectorAll(".ip-release-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      _confirmReleaseFromPanel(btn.getAttribute("data-rid"));
    });
  });
  body.querySelectorAll(".ip-reserve-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      _openReserveModal(_ipPanelSubnetId, btn.getAttribute("data-ip"));
    });
  });
  body.querySelectorAll(".ip-asset-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      _openAssetViewModal(btn.getAttribute("data-aid"));
    });
  });
}

function _panelUpdateSelectAll() {
  var body = document.getElementById("ip-panel-body");
  if (!body) return;
  var allCbs = body.querySelectorAll(".panel-row-cb");
  var checked = Array.from(allCbs).filter(function (cb) { return cb.checked; }).length;
  var sa = document.getElementById("panel-select-all");
  if (!sa) return;
  sa.checked = allCbs.length > 0 && checked === allCbs.length;
  sa.indeterminate = checked > 0 && checked < allCbs.length;
}

function _panelUpdateBulkBar() {
  var btn = document.getElementById("ip-panel-free-selected-btn");
  if (!btn) return;
  var count = _panelSelected.size;
  btn.disabled = count === 0;
  btn.textContent = count > 0 ? "Free Selected (" + count + ")" : "Free Selected";
}

async function _bulkReleaseFromPanel() {
  var ids = Array.from(_panelSelected);
  if (!ids.length) return;
  var ok = await showConfirm("Free " + ids.length + " reservation" + (ids.length !== 1 ? "s" : "") + "? This will release those IPs.");
  if (!ok) return;
  var btn = document.getElementById("ip-panel-free-selected-btn");
  if (btn) btn.disabled = true;
  var failed = 0;
  for (var i = 0; i < ids.length; i++) {
    try { await api.reservations.release(ids[i]); }
    catch (e) { failed++; }
  }
  _panelSelected.clear();
  if (btn) btn.disabled = false;
  _ipPanelDirty = true;
  if (failed > 0) showToast(failed + " release(s) failed", "error");
  else showToast("Freed " + ids.length + " reservation" + (ids.length !== 1 ? "s" : ""));
  _fetchIpPage();
}

function _renderPanelFooter(data) {
  var footer = document.getElementById("ip-panel-footer");
  if (data.ipv6) {
    footer.innerHTML = '<span>' + data.ips.length + ' reservation' + (data.ips.length !== 1 ? 's' : '') + '</span>';
    return;
  }
  var reserved = 0;
  // Count from current page data + total for the summary
  data.ips.forEach(function (ip) {
    if (ip.reservation && ip.reservation.status === "active") reserved++;
  });
  // For multi-page, we show page-level counts
  var totalHosts = Math.max(0, data.totalIps - 2); // exclude network + broadcast
  var pct = totalHosts > 0 ? Math.round((reserved / totalHosts) * 100) : 0;
  var totalPages = Math.ceil(data.totalIps / data.pageSize);
  var pageNote = totalPages > 1 ? ' (this page)' : '';

  footer.innerHTML =
    '<span>' + reserved + ' of ' + totalHosts + ' IPs reserved' + pageNote + '</span>' +
    '<div class="util-bar-track"><div class="util-bar-fill" style="width:' + pct + '%;background:var(--color-accent)"></div></div>' +
    '<span>' + pct + '%</span>';
}

// ─── Reservation modals (reuse existing modal system) ───────────────────────

function _openAutoAllocateModal(subnetId) {
  var s = _ipPanelData ? _ipPanelData.subnet : null;
  var subnetLabel = s ? escapeHtml(s.name) + ' (' + escapeHtml(s.cidr) + ')' : subnetId;

  var body =
    '<div class="form-group"><label>Network</label><input type="text" value="' + subnetLabel + '" disabled></div>' +
    '<p class="hint" style="margin-bottom:12px">The next available host IP will be reserved automatically.</p>' +
    '<div class="form-group"><label>Hostname *</label><input type="text" id="f-hostname" placeholder="e.g. web-server-01"></div>' +
    '<div class="form-group"><label>Owner</label><input type="text" id="f-owner" placeholder="e.g. platform-team"></div>' +
    '<div class="form-group"><label>Project Ref</label><input type="text" id="f-projectRef" placeholder="e.g. INFRA-001"></div>' +
    '<div class="form-group"><label>Expires At</label><input type="datetime-local" id="f-expiresAt"><p class="hint">Optional TTL</p></div>' +
    '<div class="form-group"><label>Notes</label><textarea id="f-notes" placeholder="Optional notes"></textarea></div>';
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">Auto-Allocate</button>';
  openModal("Auto-Allocate Next IP", body, footer);

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var expiresVal = document.getElementById("f-expiresAt").value;
      var input = {
        subnetId: subnetId,
        hostname: document.getElementById("f-hostname").value.trim(),
        owner: document.getElementById("f-owner").value.trim() || undefined,
        projectRef: document.getElementById("f-projectRef").value.trim() || undefined,
        expiresAt: expiresVal ? new Date(expiresVal).toISOString() : undefined,
        notes: document.getElementById("f-notes").value.trim() || undefined,
      };
      var reservation = await api.reservations.nextAvailable(input);
      closeModal();
      showToast("Reserved " + reservation.ipAddress);
      _ipPanelDirty = true;
      _fetchIpPage();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function _openReserveModal(subnetId, ipAddress) {
  var s = _ipPanelData ? _ipPanelData.subnet : null;
  var subnetLabel = s ? escapeHtml(s.name) + ' (' + escapeHtml(s.cidr) + ')' : subnetId;

  var body =
    '<div class="form-group"><label>Network</label><input type="text" value="' + subnetLabel + '" disabled></div>' +
    '<div class="form-group"><label>IP Address' + (ipAddress ? '' : ' *') + '</label>' +
      (ipAddress
        ? '<input type="text" value="' + escapeHtml(ipAddress) + '" disabled>'
        : '<input type="text" id="f-ipAddress" placeholder="e.g. ' + (s ? escapeHtml(s.cidr.replace(/\/.*/, '').replace(/\.0$/, '.10')) : '10.0.1.10') + '">') +
    '</div>' +
    '<div class="form-group"><label>Hostname *</label><input type="text" id="f-hostname" placeholder="e.g. web-server-01"></div>' +
    '<div class="form-group"><label>Owner</label><input type="text" id="f-owner" placeholder="e.g. platform-team"></div>' +
    '<div class="form-group"><label>Project Ref</label><input type="text" id="f-projectRef" placeholder="e.g. INFRA-001"></div>' +
    '<div class="form-group"><label>Expires At</label><input type="datetime-local" id="f-expiresAt"><p class="hint">Optional TTL</p></div>' +
    '<div class="form-group"><label>Notes</label><textarea id="f-notes" placeholder="Optional notes"></textarea></div>';
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">Create Reservation</button>';
  openModal("Reserve IP", body, footer);

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var ipEl = document.getElementById("f-ipAddress");
      var expiresVal = document.getElementById("f-expiresAt").value;
      var input = {
        subnetId: subnetId,
        ipAddress: ipAddress || (ipEl ? ipEl.value.trim() : undefined) || undefined,
        hostname: document.getElementById("f-hostname").value.trim(),
        owner: document.getElementById("f-owner").value.trim() || undefined,
        projectRef: document.getElementById("f-projectRef").value.trim() || undefined,
        expiresAt: expiresVal ? new Date(expiresVal).toISOString() : undefined,
        notes: document.getElementById("f-notes").value.trim() || undefined,
      };
      await api.reservations.create(input);
      closeModal();
      showToast("Reservation created");
      _ipPanelDirty = true;
      _fetchIpPage();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function _openEditReservationModal(reservationId) {
  api.reservations.get(reservationId).then(function (r) {
    var subnetLabel = r.subnet ? escapeHtml(r.subnet.name) + " (" + escapeHtml(r.subnet.cidr) + ")" : r.subnetId;
    var expiresVal = r.expiresAt ? _toDatetimeLocal(r.expiresAt) : "";
    var body =
      '<div class="form-group"><label>Network</label><input type="text" value="' + subnetLabel + '" disabled></div>' +
      '<div class="form-group"><label>IP Address</label><input type="text" value="' + escapeHtml(r.ipAddress || "Full network") + '" disabled></div>' +
      '<div class="form-group"><label>Status</label>' + statusBadge(r.status) + '</div>' +
      '<div class="form-group"><label>Hostname</label><input type="text" id="f-hostname" value="' + escapeHtml(r.hostname || "") + '"></div>' +
      '<div class="form-group"><label>Owner</label><input type="text" id="f-owner" value="' + escapeHtml(r.owner) + '"></div>' +
      '<div class="form-group"><label>Project Ref</label><input type="text" id="f-projectRef" value="' + escapeHtml(r.projectRef) + '"></div>' +
      '<div class="form-group"><label>Expires At</label><input type="datetime-local" id="f-expiresAt" value="' + expiresVal + '"></div>' +
      '<div class="form-group"><label>Notes</label><textarea id="f-notes">' + escapeHtml(r.notes || "") + '</textarea></div>';
    var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal("Edit Reservation", body, footer);

    document.getElementById("btn-save").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      try {
        var expiresVal = document.getElementById("f-expiresAt").value;
        var input = {
          hostname: document.getElementById("f-hostname").value.trim() || undefined,
          owner: document.getElementById("f-owner").value.trim() || undefined,
          projectRef: document.getElementById("f-projectRef").value.trim() || undefined,
          expiresAt: expiresVal ? new Date(expiresVal).toISOString() : undefined,
          notes: document.getElementById("f-notes").value.trim() || undefined,
        };
        await api.reservations.update(reservationId, input);
        closeModal();
        showToast("Reservation updated");
        _ipPanelDirty = true;
        _fetchIpPage();
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  }).catch(function (err) {
    showToast(err.message, "error");
  });
}

async function _confirmReleaseFromPanel(reservationId) {
  var ok = await showConfirm("Release this reservation? This will free the IP.");
  if (!ok) return;
  try {
    await api.reservations.release(reservationId);
    showToast("Reservation released");
    _ipPanelDirty = true;
    _fetchIpPage();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function _toDatetimeLocal(isoStr) {
  var d = new Date(isoStr);
  var pad = function (n) { return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/* ─── Export (PDF / CSV) ──────────────────────────────────────────────────── */

async function _exportIpPanel(fmt) {
  if (!_ipPanelData) {
    showToast("No data to export", "error");
    return;
  }

  var data = _ipPanelData;
  var s = data.subnet;
  var totalPages = Math.max(1, Math.ceil(data.totalIps / data.pageSize));

  // If multi-page, confirm first
  var allIps = data.ips;
  if (totalPages > 1) {
    var ok = await showConfirm(
      "This network has " + data.totalIps + " IPs across " + totalPages + " pages. Export all?"
    );
    if (!ok) return;
  }

  await trackedPdfExport("Exporting " + s.name + " " + fmt.toUpperCase(), async function (signal) {
    if (totalPages > 1) {
      var qs = toQuery({ page: 1, pageSize: data.totalIps });
      var full = await request("GET", "/subnets/" + _ipPanelSubnetId + "/ips" + qs, undefined, signal);
      allIps = full.ips;
    }
    if (signal.aborted) return;
    if (fmt === "csv") _generateIpPanelCsv(s, allIps);
    else _generateIpPanelPdf(s, allIps);
  });
}

function _generateIpPanelPdf(s, allIps) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("PDF library not loaded. Check your internet connection and reload the page.");
  }
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });

  var now = new Date();
  var timestamp = now.toLocaleDateString() + " " + now.toLocaleTimeString();

  // Header
  doc.setFontSize(16);
  doc.setTextColor(40, 40, 40);
  doc.text((_branding ? _branding.appName : "Shelob") + " \u2014 Network Detail", 40, 36);
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text("Generated: " + timestamp, 40, 52);

  // Subnet info
  var yPos = 70;
  doc.setFontSize(12);
  doc.setTextColor(40, 40, 40);
  doc.text(s.name + "  (" + s.cidr + ")", 40, yPos);
  yPos += 16;
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  var details = [];
  if (s.status) details.push("Status: " + s.status.charAt(0).toUpperCase() + s.status.slice(1));
  if (s.vlan) details.push("VLAN: " + s.vlan);
  if (s.purpose) details.push("Purpose: " + s.purpose);
  details.push("Total IPs: " + allIps.length);
  doc.text(details.join("  |  "), 40, yPos);
  yPos += 18;

  // Table
  var head = [["IP Address", "Hostname", "MAC Address", "Owner", "Lease Expiry", "Status"]];
  var body = allIps.map(function (ip) {
    var isSpecial = ip.type === "network" || ip.type === "broadcast";
    var r = ip.reservation;
    var statusLabel;
    if (isSpecial) {
      statusLabel = ip.type === "network" ? "Network" : "Broadcast";
    } else if (r && r.conflictMessage) {
      statusLabel = "Conflict: " + r.conflictMessage;
    } else if (r && r.status === "active" && r.owner === "dhcp-reservation") {
      statusLabel = "DHCP Reservation";
    } else if (r && r.status === "active" && r.owner === "dhcp-lease") {
      statusLabel = "DHCP Lease";
    } else if (r && r.status === "active") {
      statusLabel = "Active";
    } else if (r && r.status === "expired") {
      statusLabel = "Expired";
    } else if (r && r.status === "released") {
      statusLabel = "Released";
    } else {
      statusLabel = "Available";
    }

    var macMatch = r && r.notes ? r.notes.match(/MAC:\s*([\w:]+)/) : null;
    var mac = macMatch ? macMatch[1] : "-";
    var owner = r ? (r.owner || "-") : "-";
    var expiry = r && r.expiresAt ? formatDate(r.expiresAt) : "-";

    return [
      ip.address,
      r ? (r.hostname || "-") : "-",
      mac,
      owner,
      expiry,
      statusLabel,
    ];
  });

  doc.autoTable({
    startY: yPos,
    head: head,
    body: body,
    theme: "grid",
    styles: { fontSize: 7.5, cellPadding: 3, overflow: "linebreak" },
    headStyles: { fillColor: [30, 30, 54], textColor: [230, 230, 230], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 250] },
    margin: { left: 40, right: 40 },
    columnStyles: {
      0: { cellWidth: 100, font: "courier" },
    },
    didDrawPage: function (pgData) {
      var pageNum = doc.internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(
        "Page " + pgData.pageNumber + " of " + pageNum + "  |  " + s.name + " (" + s.cidr + ")",
        doc.internal.pageSize.getWidth() / 2,
        doc.internal.pageSize.getHeight() - 20,
        { align: "center" }
      );
    },
  });

  var filename = "shelob-network-" + s.cidr.replace(/[\/]/g, "_") + "-" + now.toISOString().slice(0, 10) + ".pdf";
  doc.save(filename);
  showToast("Exported " + allIps.length + " IPs to " + filename);
}

/* ─── Asset view modal (self-contained; no dep on assets.js) ─────────────────*/

var _ASSET_TYPE_LABELS = {
  server: "Server", switch: "Switch", router: "Router", firewall: "Firewall",
  workstation: "Workstation", printer: "Printer", access_point: "AP", other: "Other",
};

function _assetViewRow(label, value, mono) {
  return '<div class="detail-row"><span class="detail-label">' + escapeHtml(label) + '</span>' +
    '<span class="detail-value' + (mono ? ' mono' : '') + '">' + escapeHtml(value || "-") + '</span></div>';
}

function _assetMacAddressesHTML(macs) {
  if (!macs || macs.length <= 1) return '';
  var rows = macs.map(function (m) {
    return '<div style="display:flex;gap:12px;align-items:center;padding:3px 0">' +
      '<code style="font-size:0.82rem">' + escapeHtml(m.mac) + '</code>' +
      '<span style="font-size:0.75rem;color:var(--color-text-tertiary)">' +
        escapeHtml(m.source || "") + (m.lastSeen ? ' &middot; ' + formatDate(m.lastSeen) : '') +
      '</span></div>';
  }).join("");
  return '<div class="detail-row"><span class="detail-label">All MACs (' + macs.length + ')</span>' +
    '<span class="detail-value">' + rows + '</span></div>';
}

function _assetAssocIpsHTML(ips) {
  if (!ips || ips.length === 0) return '';
  var rows = ips.map(function (entry) {
    return '<div style="display:flex;gap:12px;align-items:center;padding:3px 0">' +
      '<code style="font-size:0.82rem">' + escapeHtml(entry.ip) + '</code>' +
      '<span style="font-size:0.75rem;color:var(--color-text-tertiary)">' +
        (entry.interfaceName ? escapeHtml(entry.interfaceName) : '') +
        (entry.source ? ' &middot; ' + escapeHtml(entry.source) : '') +
        (entry.lastSeen ? ' &middot; ' + formatDate(entry.lastSeen) : '') +
      '</span></div>';
  }).join("");
  return '<div class="detail-row"><span class="detail-label">Associated IPs (' + ips.length + ')</span>' +
    '<span class="detail-value">' + rows + '</span></div>';
}

function _assetAssocUsersHTML(users) {
  if (!users || users.length === 0) return '';
  var rows = users.map(function (u) {
    var display = u.domain ? escapeHtml(u.domain) + '\\' + escapeHtml(u.user) : escapeHtml(u.user);
    return '<div style="display:flex;gap:12px;align-items:center;padding:3px 0">' +
      '<span style="font-size:0.85rem">' + display + '</span>' +
      '<span style="font-size:0.75rem;color:var(--color-text-tertiary)">' +
        (u.source ? escapeHtml(u.source) : '') +
        (u.lastSeen ? ' &middot; ' + formatDate(u.lastSeen) : '') +
      '</span></div>';
  }).join("");
  return '<div class="detail-row"><span class="detail-label">Associated Users (' + users.length + ')</span>' +
    '<span class="detail-value">' + rows + '</span></div>';
}

async function _openAssetViewModal(assetId) {
  try {
    var a = await api.assets.get(assetId);
    var body = '<div class="asset-view-grid">' +
      _assetViewRow("Hostname", a.hostname) +
      _assetViewRow("DNS Name", a.dnsName) +
      _assetViewRow("IP Address", a.ipAddress, true) +
      _assetAssocIpsHTML(a.associatedIps) +
      _assetViewRow("MAC Address", a.macAddress, true) +
      _assetMacAddressesHTML(a.macAddresses) +
      _assetViewRow("Asset Tag", a.assetTag) +
      _assetViewRow("Serial Number", a.serialNumber) +
      _assetViewRow("Manufacturer", a.manufacturer) +
      _assetViewRow("Model", a.model) +
      _assetViewRow("Type", _ASSET_TYPE_LABELS[a.assetType] || a.assetType) +
      _assetViewRow("Status", a.status ? a.status.charAt(0).toUpperCase() + a.status.slice(1) : "-") +
      _assetViewRow("Location", a.location) +
      _assetViewRow("Learned Location", a.learnedLocation) +
      _assetViewRow("Department", a.department) +
      _assetViewRow("Assigned To", a.assignedTo) +
      _assetViewRow("OS / Firmware", a.osVersion || a.os) +
      _assetViewRow("Last Seen Switch", a.lastSeenSwitch) +
      _assetViewRow("Last Seen AP", a.lastSeenAp) +
      _assetAssocUsersHTML(a.associatedUsers) +
      _assetViewRow("First Seen", a.createdAt ? formatDate(a.createdAt) : null) +
      _assetViewRow("Last Seen", a.lastSeen ? formatDate(a.lastSeen) : null) +
      _assetViewRow("Acquired", a.acquiredAt ? formatDate(a.acquiredAt) : null) +
      _assetViewRow("Warranty Expires", a.warrantyExpiry ? formatDate(a.warrantyExpiry) : null) +
      _assetViewRow("Purchase Order", a.purchaseOrder) +
      _assetViewRow("Tags", (a.tags || []).join(", ") || null) +
      _assetViewRow("Notes", a.notes) +
      _assetViewRow("Created", formatDate(a.createdAt)) +
      _assetViewRow("Updated", formatDate(a.updatedAt)) +
    '</div>';
    var footer = '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';
    openModal("Asset Details", body, footer, { wide: true });
  } catch (err) {
    showToast(err.message, "error");
  }
}

function _generateIpPanelCsv(s, allIps) {
  var headers = ["IP Address", "Hostname", "MAC Address", "Owner", "Lease Expiry", "Status"];
  var rows = allIps.map(function (ip) {
    var isSpecial = ip.type === "network" || ip.type === "broadcast";
    var r = ip.reservation;
    var statusLabel;
    if (isSpecial) {
      statusLabel = ip.type === "network" ? "Network" : "Broadcast";
    } else if (r && r.conflictMessage) {
      statusLabel = "Conflict: " + r.conflictMessage;
    } else if (r && r.status === "active" && r.owner === "dhcp-reservation") {
      statusLabel = "DHCP Reservation";
    } else if (r && r.status === "active" && r.owner === "dhcp-lease") {
      statusLabel = "DHCP Lease";
    } else if (r && r.status === "active") {
      statusLabel = "Active";
    } else if (r && r.status === "expired") {
      statusLabel = "Expired";
    } else if (r && r.status === "released") {
      statusLabel = "Released";
    } else {
      statusLabel = "Available";
    }
    var macMatch = r && r.notes ? r.notes.match(/MAC:\s*([\w:]+)/) : null;
    var mac = macMatch ? macMatch[1] : "";
    var owner = r ? (r.owner || "") : "";
    var expiry = r && r.expiresAt ? formatDate(r.expiresAt) : "";
    return [ip.address, r ? (r.hostname || "") : "", mac, owner, expiry, statusLabel];
  });
  var filename = "shelob-network-" + s.cidr.replace(/[\/]/g, "_") + "-" + new Date().toISOString().slice(0, 10) + ".csv";
  downloadCsv(headers, rows, filename);
  showToast("Exported " + allIps.length + " IPs to " + filename);
}
