/**
 * public/js/subnets.js — Networks list + CRUD + next-available
 */

var cachedBlocks = [];
var _subnetsPageSize = 15;
var _subnetsPage = 1;
var _subnetsData = [];

document.addEventListener("DOMContentLoaded", async function () {
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
    openIpPanel(link.getAttribute("data-subnet-id"));
  });
  document.getElementById("filter-block").addEventListener("change", function () { _subnetsPage = 1; loadSubnets(); });
  document.getElementById("filter-status").addEventListener("change", function () { _subnetsPage = 1; loadSubnets(); });
  document.getElementById("filter-tag").addEventListener("input", debounce(function () { _subnetsPage = 1; loadSubnets(); }, 300));
  document.getElementById("filter-pagesize").addEventListener("change", function () {
    _subnetsPageSize = parseInt(this.value, 10) || 15;
    _subnetsPage = 1;
    renderSubnetsPage();
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
  var tbody = document.getElementById("subnets-tbody");
  try {
    var statusVal = document.getElementById("filter-status").value;
    var apiStatus = (statusVal === "hide-deprecated" || !statusVal) ? undefined : statusVal;
    var filters = {
      blockId: document.getElementById("filter-block").value || undefined,
      status: apiStatus,
      tag: document.getElementById("filter-tag").value || undefined,
    };
    _subnetsData = await api.subnets.list(filters);
    if (statusVal === "hide-deprecated") {
      _subnetsData = _subnetsData.filter(function (s) { return s.status !== "deprecated"; });
    }
    renderSubnetsPage();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function renderSubnetsPage() {
  var tbody = document.getElementById("subnets-tbody");
  if (_subnetsData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No networks found. Create one to get started.</td></tr>';
    document.getElementById("pagination").innerHTML = "";
    return;
  }
  var start = (_subnetsPage - 1) * _subnetsPageSize;
  var page = _subnetsData.slice(start, start + _subnetsPageSize);
  tbody.innerHTML = page.map(function (s) {
    var tags = (s.tags || []).map(function (t) { return escapeHtml(t); }).join(", ");
    var blockName = s.block ? escapeHtml(s.block.name) : "-";
    var fgtDevice = s.fortigateDevice ? escapeHtml(s.fortigateDevice) : "-";
    var source = s.integration
      ? escapeHtml(s.integration.name)
      : '<span style="color:var(--color-text-tertiary)">Manual</span>';
    return '<tr>' +
      '<td><a href="#" class="subnet-name-link" data-subnet-id="' + s.id + '"><strong>' + escapeHtml(s.name) + '</strong></a></td>' +
      '<td class="mono">' + escapeHtml(s.cidr) + '</td>' +
      '<td>' + blockName + '</td>' +
      '<td>' + escapeHtml(s.purpose || "-") + '</td>' +
      '<td>' + (s.vlan ? '<span class="badge badge-vlan">VLAN ' + s.vlan + '</span>' : '-') + '</td>' +
      '<td>' + statusBadge(s.status) + '</td>' +
      '<td>' + (tags || '<span style="color:var(--color-text-tertiary)">-</span>') + '</td>' +
      '<td>' + fgtDevice + '</td>' +
      '<td>' + source + '</td>' +
      '<td>' + (s._count ? s._count.reservations : 0) + '</td>' +
      '<td class="actions">' +
        (canManageNetworks() ? '<button class="btn btn-sm btn-secondary" onclick="openEditModal(\'' + s.id + '\')">Edit</button>' +
        '<button class="btn btn-sm btn-danger" onclick="confirmDelete(\'' + s.id + '\', \'' + escapeHtml(s.cidr) + '\')">Del</button>' : '') +
      '</td></tr>';
  }).join("");
  renderPageControls("pagination", _subnetsData.length, _subnetsPageSize, _subnetsPage, function (p) {
    _subnetsPage = p;
    renderSubnetsPage();
  });
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
    var body = '<div class="form-group"><label>CIDR</label><input type="text" value="' + escapeHtml(subnet.cidr) + '" disabled></div>' +
      '<div class="form-group"><label>Name</label><input type="text" id="f-name" value="' + escapeHtml(subnet.name) + '"></div>' +
      '<div class="form-group"><label>Purpose</label><textarea id="f-purpose">' + escapeHtml(subnet.purpose || "") + '</textarea></div>' +
      '<div class="form-group"><label>Status</label><select id="f-status"><option value="available"' + (subnet.status === "available" ? " selected" : "") + '>Available</option><option value="reserved"' + (subnet.status === "reserved" ? " selected" : "") + '>Reserved</option><option value="deprecated"' + (subnet.status === "deprecated" ? " selected" : "") + '>Deprecated</option></select></div>' +
      '<div class="form-group"><label>VLAN</label><input type="number" id="f-vlan" min="1" max="4094" value="' + (subnet.vlan || "") + '" placeholder="Empty to clear"></div>' +
      tagFieldHTML(subnet.tags || []);
    var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal("Edit Network", body, footer);
    wireTagPicker();

    document.getElementById("btn-save").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      try {
        var vlanVal = document.getElementById("f-vlan").value;
        var input = {
          name: val("f-name") || undefined,
          purpose: val("f-purpose") || undefined,
          status: val("f-status"),
          vlan: vlanVal ? parseInt(vlanVal, 10) : null,
          tags: getTagFieldValue(),
        };
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

async function confirmDelete(id, cidr) {
  var ok = await showConfirm('Delete network "' + cidr + '"? This cannot be undone.');
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
      networks = await request("GET", "/subnets", undefined, signal);
      label = "all " + networks.length + " networks";
    }
    if (signal.aborted) return;
    if (!networks || networks.length === 0) { showToast("No networks to export", "error"); return; }
    if (fmt === "csv") generateNetworkCsv(networks);
    else generateNetworkPdf(networks, label);
  });
}

function generateNetworkPdf(networks, label) {
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
      s.status ? s.status.charAt(0).toUpperCase() + s.status.slice(1) : "-",
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
      s.purpose || "", s.vlan ? String(s.vlan) : "", s.status || "",
      (s.tags || []).join("; "), s.fortigateDevice || "",
      s.integration ? s.integration.name : "Manual",
      s._count ? String(s._count.reservations) : "0",
    ];
  });
  var filename = "shelob-networks-" + new Date().toISOString().slice(0, 10) + ".csv";
  downloadCsv(headers, rows, filename);
  showToast("Exported " + networks.length + " networks to " + filename);
}
