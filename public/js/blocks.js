/**
 * public/js/blocks.js — IP Blocks list + CRUD
 */

var _blocksPageSize = 15;
var _blocksPage = 1;
var _blocksData = [];
var _blocksSF = null;
var _blocksLayout = null;

function _saveBlocksPrefs() {
  if (!currentUsername) return;
  try {
    localStorage.setItem("polaris-prefs-blocks-" + currentUsername, JSON.stringify({
      pageSize: _blocksPageSize,
      version: document.getElementById("filter-version").value,
      tag: document.getElementById("filter-tag").value,
      sortKey: _blocksSF ? _blocksSF._sortKey : null,
      sortDir: _blocksSF ? _blocksSF._sortDir : "asc",
      sfFilters: _blocksSF ? Object.assign({}, _blocksSF._filters) : {},
      layout: _blocksLayout ? _blocksLayout.getPrefs() : null,
    }));
  } catch (_) {}
}

function _restoreBlocksPrefs() {
  if (!currentUsername) return;
  var raw;
  try { raw = localStorage.getItem("polaris-prefs-blocks-" + currentUsername); } catch (_) { return; }
  if (!raw) return;
  try {
    var p = JSON.parse(raw);
    if (p.pageSize) {
      _blocksPageSize = p.pageSize;
      var psSel = document.getElementById("filter-pagesize");
      if (psSel) psSel.value = String(p.pageSize);
    }
    if (p.version) { var vSel = document.getElementById("filter-version"); if (vSel) vSel.value = p.version; }
    if (p.tag)     { var tEl  = document.getElementById("filter-tag");     if (tEl)  tEl.value  = p.tag; }
    if (_blocksSF) {
      if (p.sortKey) _blocksSF._sortKey = p.sortKey;
      if (p.sortDir) _blocksSF._sortDir = p.sortDir;
      if (p.sfFilters) {
        _blocksSF._filters = p.sfFilters;
        _blocksSF.restoreFilterUI();
      }
      _blocksSF._updateIcons();
    }
    if (_blocksLayout && p.layout) _blocksLayout.setPrefs(p.layout);
  } catch (_) {}
}

document.addEventListener("DOMContentLoaded", async function () {
  _blocksSF = new TableSF("blocks-tbody", function () { _blocksPage = 1; renderBlocksPage(); _saveBlocksPrefs(); });
  var blocksTable = document.querySelector("#blocks-tbody").closest("table");
  _blocksLayout = setupColumnLayout(blocksTable, {
    chooserButton: document.getElementById("btn-blocks-columns"),
    onChange: _saveBlocksPrefs,
  });
  await userReady;
  _restoreBlocksPrefs();
  loadBlocks();
  wireFavoriteClicks("blocks-tbody", function () { renderBlocksPage(); });

  document.getElementById("blocks-tbody").addEventListener("click", function (e) {
    var link = e.target.closest(".block-name-link");
    if (!link) return;
    e.preventDefault();
    var prev = document.querySelector("tr.row-panel-active");
    if (prev) prev.classList.remove("row-panel-active");
    var row = link.closest("tr");
    if (row) row.classList.add("row-panel-active");
    openBlockPanel(link.getAttribute("data-block-id"));
  });

  var addBtn = document.getElementById("btn-add-block");
  if (addBtn) addBtn.addEventListener("click", openCreateModal);
  document.getElementById("filter-version").addEventListener("change", function () { _blocksPage = 1; loadBlocks(); _saveBlocksPrefs(); });
  document.getElementById("filter-tag").addEventListener("input", debounce(function () { _blocksPage = 1; loadBlocks(); _saveBlocksPrefs(); }, 300));
  document.getElementById("filter-pagesize").addEventListener("change", function () {
    _blocksPageSize = parseInt(this.value, 10) || 15;
    _blocksPage = 1;
    renderBlocksPage();
    _saveBlocksPrefs();
  });
});

async function loadBlocks() {
  var tbody = document.getElementById("blocks-tbody");
  try {
    var filters = {
      ipVersion: document.getElementById("filter-version").value || undefined,
      tag: document.getElementById("filter-tag").value || undefined,
    };
    _blocksData = await api.blocks.list(filters);
    renderBlocksPage();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function renderBlocksPage() {
  var tbody = document.getElementById("blocks-tbody");
  if (_blocksData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No IP blocks found. Create one to get started.</td></tr>';
    clearPageControls("pagination");
    return;
  }
  var sfData = _blocksSF ? _blocksSF.apply(_blocksData) : _blocksData;
  if (sfData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No results match the current filters.</td></tr>';
    clearPageControls("pagination");
    return;
  }
  sfData = sortFavoritesFirst(sfData, "blocks");
  var start = (_blocksPage - 1) * _blocksPageSize;
  var page = sfData.slice(start, start + _blocksPageSize);
  tbody.innerHTML = page.map(function (b) {
    var tags = (b.tags || []).map(function (t) { return escapeHtml(t); }).join(", ");
    return '<tr>' +
      starCellHTML("blocks", b.id) +
      '<td><a href="#" class="block-name-link" data-block-id="' + b.id + '"><strong>' + escapeHtml(b.name) + '</strong></a></td>' +
      '<td class="mono">' + escapeHtml(b.cidr) + '</td>' +
      '<td>' + statusBadge(b.ipVersion) + '</td>' +
      '<td>' + escapeHtml(b.description || "-") + '</td>' +
      '<td>' + (tags || '<span style="color:var(--color-text-tertiary)">-</span>') + '</td>' +
      '<td>' + (b._count ? b._count.subnets : 0) + '</td>' +
      '<td>' + formatDate(b.createdAt) + '</td>' +
      '<td class="actions">' +
        (canManageNetworks() ? '<button class="btn btn-sm btn-secondary" onclick="openEditModal(\'' + b.id + '\')">Edit</button>' +
        '<button class="btn btn-sm btn-danger" onclick="confirmDelete(\'' + b.id + '\', \'' + escapeHtml(b.cidr) + '\')">Del</button>' : '') +
      '</td></tr>';
  }).join("");
  renderPageControls("pagination", sfData.length, _blocksPageSize, _blocksPage, function (p) {
    _blocksPage = p;
    renderBlocksPage();
  });
}

async function openCreateModal() {
  await _ensureTagCache();
  var body = formHTML({ name: "", cidr: "", description: "" }) + tagFieldHTML([]);
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Create Block</button>';
  openModal("Add IP Block", body, footer);
  wireTagPicker();
  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var input = {
        name: val("f-name"),
        cidr: val("f-cidr"),
        description: val("f-description") || undefined,
        tags: getTagFieldValue(),
      };
      await api.blocks.create(input);
      closeModal();
      showToast("Block created");
      loadBlocks();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function openEditModal(id) {
  try {
    var block = await api.blocks.get(id);
    await _ensureTagCache();
    var readOnly = !canManageNetworks();
    var lock = readOnly ? ' disabled class="field-locked"' : '';
    var banner = readOnly
      ? '<p class="hint" style="margin-bottom:12px">View-only — you don\'t have permission to edit blocks.</p>'
      : '';
    var body = banner +
      '<div class="form-group"><label>Name</label><input type="text" id="f-name" value="' + escapeHtml(block.name) + '"' + lock + '></div>' +
      '<div class="form-group"><label>CIDR</label><input type="text" value="' + escapeHtml(block.cidr) + '" disabled></div>' +
      '<div class="form-group"><label>Description</label><textarea id="f-description"' + lock + '>' + escapeHtml(block.description || "") + '</textarea></div>' +
      tagFieldHTML(block.tags || [], { readOnly: readOnly });
    var footer = readOnly
      ? '<button class="btn btn-secondary" onclick="closeModal()">Close</button>'
      : '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal(readOnly ? "View Block" : "Edit Block", body, footer);
    if (!readOnly) {
      wireTagPicker();
      document.getElementById("btn-save").addEventListener("click", async function () {
        var btn = this;
        btn.disabled = true;
        try {
          var input = {
            name: val("f-name") || undefined,
            description: val("f-description") || undefined,
            tags: getTagFieldValue(),
          };
          await api.blocks.update(id, input);
          closeModal();
          showToast("Block updated");
          loadBlocks();
        } catch (err) {
          showToast(err.message, "error");
        } finally {
          btn.disabled = false;
        }
      });
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function confirmDelete(id, cidr) {
  var ok = await showConfirm('Delete block "' + cidr + '"? This cannot be undone.');
  if (!ok) return;
  try {
    await api.blocks.delete(id);
    showToast("Block deleted");
    loadBlocks();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function formHTML(defaults) {
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(defaults.name) + '" placeholder="e.g. Corporate Datacenter"></div>' +
    '<div class="form-group"><label>CIDR *</label><input type="text" id="f-cidr" value="' + escapeHtml(defaults.cidr) + '" placeholder="e.g. 10.0.0.0/8"></div>' +
    '<div class="form-group"><label>Description</label><textarea id="f-description" placeholder="Optional description">' + escapeHtml(defaults.description) + '</textarea></div>';
}

function val(id) { return document.getElementById(id).value.trim(); }

function debounce(fn, ms) {
  var timer;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
