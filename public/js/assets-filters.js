/**
 * public/js/assets-filters.js — saved filter presets for the Assets table.
 *
 * The page-header "Filters ▾" menu: save the table's current column filters +
 * sort as a named preset, load one back, and delete it. Presets live on the
 * SERVER (GET/POST/PUT/DELETE /api/v1/saved-filters?scope=assets), not in
 * localStorage, precisely because they're shareable:
 *
 *   Private — visible only to the operator who saved it.
 *   Public  — offered to every user who can read the Assets page. Publishing
 *             is a write to shared state, so it needs assets:write; keeping a
 *             private preset only needs the assets:read the page already has.
 *
 * A preset stores the QUERY only ({ sfFilters, sortKey, sortDir } — TableSF's
 * getPrefs shape). Column widths / visibility stay per-browser in localStorage
 * (applyTableLayout) — they describe the operator's screen, not what they're
 * looking for.
 *
 * Depends on globals from app.js (openModal/closeModal/showConfirm/permAtLeast),
 * api.js (api/showToast/escapeHtml), table-sf.js (TableSF.prototype.applyState)
 * and assets.js (_assetsSF, assetsApplyFilterState) — all loaded before this
 * file on assets.html.
 */

/* global api, openModal, closeModal, showToast, showConfirm, escapeHtml,
          permAtLeast, _assetsSF, assetsApplyFilterState */

var SFL_SCOPE = "assets";

var _sflCache = [];          // last server list, for the save-modal name collision check
var _sflLoaded = false;      // false until the first successful list fetch

// ─── Data ───────────────────────────────────────────────────────────────────

async function _sflFetch() {
  var data = await api.savedFilters.list(SFL_SCOPE);
  _sflCache = (data && data.filters) || [];
  _sflLoaded = true;
  return _sflCache;
}

/** The live table state, in the shape the server stores. */
function _sflCurrentState() {
  if (!_assetsSF || typeof _assetsSF.getPrefs !== "function") {
    return { sfFilters: {}, sortKey: null, sortDir: null };
  }
  var p = _assetsSF.getPrefs();
  return { sfFilters: p.sfFilters || {}, sortKey: p.sortKey || null, sortDir: p.sortDir || null };
}

function _sflFilterCount(state) {
  return Object.keys((state && state.sfFilters) || {}).length;
}

// ─── Human-readable summaries ───────────────────────────────────────────────

/**
 * Column key → the header label the operator sees ("hostname" → "Hostname").
 * Walks the headers rather than building an attribute selector: a preset's
 * keys come back from the server, and a quote in one would break the selector
 * (or need CSS.escape, which not every runtime exposes). Falls back to the raw
 * key so a column removed since the preset was saved still reads sensibly.
 */
function _sflColumnLabel(key) {
  var ths = document.querySelectorAll("#assets-table-wrapper th[data-sf-key]");
  for (var i = 0; i < ths.length; i++) {
    if (ths[i].getAttribute("data-sf-key") !== key) continue;
    var label = ths[i].querySelector(".sf-label");
    return label ? label.textContent.trim() : key;
  }
  return key;
}

/** One column's filter as a phrase ("Hostname contains nsh"). */
function _sflDescribeFilter(key, raw) {
  var label = _sflColumnLabel(key);
  if (Array.isArray(raw)) return label + ": " + raw.join(", ");
  if (typeof raw === "string") {
    return raw.charAt(0) === "!"
      ? label + " excludes " + raw.slice(1)
      : label + " contains " + raw;
  }
  if (raw && typeof raw === "object") {
    if (raw.type === "date") {
      if (raw.from && raw.to) return label + " " + raw.from + " – " + raw.to;
      if (raw.from) return label + " since " + raw.from;
      if (raw.to) return label + " until " + raw.to;
      return label + " (any date)";
    }
    if (raw.op === "empty")        return label + " is empty";
    if (raw.op === "notempty")     return label + " is not empty";
    if (raw.op === "not-contains") return label + " excludes " + (raw.q || "");
    if (raw.op === "contains")     return label + " contains " + (raw.q || "");
  }
  return label;
}

/** Full state as one sentence, for the menu tooltip + the save modal preview. */
function _sflDescribeState(state) {
  var filters = (state && state.sfFilters) || {};
  var parts = Object.keys(filters).map(function (k) { return _sflDescribeFilter(k, filters[k]); });
  if (state && state.sortKey) {
    parts.push("sorted by " + _sflColumnLabel(state.sortKey) + (state.sortDir === "desc" ? " ↓" : " ↑"));
  }
  return parts.length ? parts.join(" · ") : "No filters — shows every asset";
}

// ─── Menu ───────────────────────────────────────────────────────────────────

function _sflCanDelete(f) {
  return f.isOwner || permAtLeast("assets", "fullwrite");
}

function _sflRowHtml(f) {
  var badge = f.visibility === "public"
    ? '<span class="sfl-badge" title="Shared with everyone">Public</span>' : "";
  var owner = f.isOwner ? "" : '<span class="sfl-owner">' + escapeHtml(f.ownerName) + "</span>";
  // Open-in-new-tab only exists where the tab strip does (assets.html).
  var newTab = window.PolarisAssetTabs
    ? '<button type="button" class="sfl-newtab" data-sfl-newtab="' + escapeHtml(f.id) +
      '" title="Open in a new tab" aria-label="Open ' + escapeHtml(f.name) + ' in a new tab">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" aria-hidden="true">' +
      '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg></button>'
    : "";
  var del = _sflCanDelete(f)
    ? '<button type="button" class="sfl-del" data-sfl-del="' + escapeHtml(f.id) +
      '" title="Delete this saved filter" aria-label="Delete ' + escapeHtml(f.name) + '">&times;</button>'
    : "";
  return '<div class="sfl-row">' +
    '<button type="button" class="sfl-load" data-sfl-load="' + escapeHtml(f.id) + '" title="' +
      escapeHtml(_sflDescribeState(f.state)) + '">' +
      '<span class="sfl-name">' + escapeHtml(f.name) + "</span>" + badge + owner +
    "</button>" + newTab + del +
  "</div>";
}

function _sflRenderMenu(list, error) {
  var menu = document.getElementById("saved-filters-menu");
  if (!menu) return;
  var html =
    '<button type="button" data-sfl-act="save">Save current filters&hellip;</button>' +
    '<button type="button" data-sfl-act="clear">Clear active filters</button>' +
    '<div class="dropdown-divider"></div>';

  if (error) {
    html += '<div class="sfl-empty">Could not load saved filters</div>';
  } else if (!_sflLoaded) {
    html += '<div class="sfl-empty">Loading&hellip;</div>';
  } else {
    var mine = list.filter(function (f) { return f.isOwner; });
    var shared = list.filter(function (f) { return !f.isOwner; });
    if (!mine.length && !shared.length) {
      html += '<div class="sfl-empty">No saved filters yet</div>';
    }
    if (mine.length) {
      html += '<div class="dropdown-heading">My filters</div>' + mine.map(_sflRowHtml).join("");
    }
    if (shared.length) {
      html += '<div class="dropdown-heading">Shared filters</div>' + shared.map(_sflRowHtml).join("");
    }
  }
  menu.innerHTML = html;
}

async function _sflRefreshMenu() {
  try {
    _sflRenderMenu(await _sflFetch(), false);
  } catch (err) {
    _sflRenderMenu([], true);
  }
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Load a preset into the CURRENT view tab. */
function _sflApply(filter) {
  if (!_assetsSF || typeof _assetsSF.applyState !== "function") return;
  _assetsSF.applyState(filter.state || {});
  assetsApplyFilterState();
  // The tab records where its filters came from (label + close confirmation).
  // Order matters: assetsApplyFilterState already mirrored the new state into
  // the tab, so this only stamps the provenance on top.
  if (window.PolarisAssetTabs) window.PolarisAssetTabs.noteFilterLoaded(filter);
  showToast('Applied filter "' + filter.name + '"');
}

/** Load a preset into a NEW view tab, leaving the current one untouched. */
function _sflApplyInNewTab(filter) {
  if (!window.PolarisAssetTabs) { _sflApply(filter); return; }
  if (window.PolarisAssetTabs.openInNewTab(filter)) {
    showToast('Opened "' + filter.name + '" in a new tab');
  }
}

async function _sflDelete(id) {
  var f = _sflCache.find(function (x) { return x.id === id; });
  if (!f) return;
  var extra = f.isOwner
    ? (f.visibility === "public" ? "\n\nIt is shared — everyone loses it." : "")
    : "\n\nIt belongs to " + f.ownerName + " and is shared with everyone.";
  var ok = await showConfirm('Delete the saved filter "' + f.name + '"?' + extra);
  if (!ok) return;
  try {
    await api.savedFilters.delete(id);
    showToast('Deleted "' + f.name + '"');
    await _sflRefreshMenu();
  } catch (err) {
    showToast(err.message || "Delete failed", "error");
  }
}

function _sflOpenSaveModal() {
  var state = _sflCurrentState();
  var canPublish = permAtLeast("assets", "write");
  var count = _sflFilterCount(state);

  // Seed the name from the tab the operator is looking at — the usual intent
  // is "keep this view", and they already named the tab. Never seeded from the
  // untouched default names.
  var seedName = "";
  if (window.PolarisAssetTabs) {
    var tabName = window.PolarisAssetTabs.activeTabName();
    if (tabName && !/^Tab \d+$/.test(tabName) && tabName !== "All assets") seedName = tabName;
  }

  var body =
    '<div class="form-group">' +
      '<label for="sfl-name">Name</label>' +
      '<input type="text" id="sfl-name" maxlength="60" autocomplete="off" list="sfl-name-list" value="' +
        escapeHtml(seedName) + '" placeholder="e.g. Down firewalls">' +
      '<datalist id="sfl-name-list">' +
        _sflCache.filter(function (f) { return f.isOwner; })
          .map(function (f) { return '<option value="' + escapeHtml(f.name) + '"></option>'; }).join("") +
      "</datalist>" +
      '<div class="hint">Saving over one of your existing names replaces it.</div>' +
    "</div>" +
    '<div class="form-group">' +
      "<label>Visibility</label>" +
      '<label class="sfl-vis"><input type="radio" name="sfl-vis" value="private" checked>' +
        "<span><strong>Private</strong> — only you can see and use it</span></label>" +
      '<label class="sfl-vis' + (canPublish ? "" : " sfl-vis-disabled") + '">' +
        '<input type="radio" name="sfl-vis" value="public"' + (canPublish ? "" : " disabled") + ">" +
        "<span><strong>Public</strong> — everyone who can view assets can use it" +
        (canPublish ? "" : '<br><span class="hint">Requires asset write access</span>') +
        "</span></label>" +
    "</div>" +
    '<div class="form-group">' +
      "<label>What gets saved</label>" +
      '<div class="sfl-preview">' + escapeHtml(_sflDescribeState(state)) + "</div>" +
      '<div class="hint">' +
        (count ? count + (count === 1 ? " column filter" : " column filters") : "No column filters") +
        " · column widths and hidden columns are not part of a preset." +
      "</div>" +
    "</div>";

  var footer =
    '<button class="btn btn-secondary" id="sfl-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="sfl-save">Save</button>';

  openModal("Save current filters", body, footer);
  document.getElementById("sfl-cancel").addEventListener("click", closeModal);

  var nameInput = document.getElementById("sfl-name");
  var saveBtn = document.getElementById("sfl-save");

  async function submit() {
    var name = (nameInput.value || "").trim();
    if (!name) { showToast("Name is required", "error"); nameInput.focus(); return; }
    var visEl = document.querySelector('input[name="sfl-vis"]:checked');
    var visibility = visEl ? visEl.value : "private";

    var clash = _sflCache.find(function (f) {
      return f.isOwner && f.name.toLowerCase() === name.toLowerCase();
    });
    if (clash) {
      var ok = await showConfirm('You already have a filter named "' + clash.name + '" — replace it?');
      if (!ok) return;
    }

    saveBtn.disabled = true;
    try {
      // The server treats a same-(scope, owner, name) POST as an update, so
      // one call covers both create and overwrite.
      await api.savedFilters.create({ scope: SFL_SCOPE, name: name, visibility: visibility, state: state });
      closeModal();
      showToast('Saved filter "' + name + '"');
      await _sflRefreshMenu();
    } catch (err) {
      showToast(err.message || "Save failed", "error");
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener("click", submit);
  nameInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  });
}

// ─── Wiring ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function () {
  var btn = document.getElementById("btn-saved-filters");
  var menu = document.getElementById("saved-filters-menu");
  if (!btn || !menu) return;   // assets.js is also loaded on map.html

  // Render the placeholder once so the first open isn't an empty box.
  _sflRenderMenu([], false);

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    var willOpen = !menu.classList.contains("open");
    // Sibling header menus (Import / Export) stopPropagation on their own
    // button, so their document-level close listener never fires for a click
    // on ours — close them explicitly instead of stacking two open menus.
    document.querySelectorAll(".btn-dropdown-menu.open").forEach(function (m) { m.classList.remove("open"); });
    if (willOpen) {
      menu.classList.add("open");
      // Re-fetch on every open: another operator may have published a preset
      // since the last look, and the list is small.
      _sflRefreshMenu();
    }
  });
  document.addEventListener("click", function () { menu.classList.remove("open"); });
  menu.addEventListener("click", function (e) { e.stopPropagation(); });

  menu.addEventListener("click", function (e) {
    var act = e.target.closest("[data-sfl-act]");
    if (act) {
      menu.classList.remove("open");
      if (act.getAttribute("data-sfl-act") === "save") {
        _sflOpenSaveModal();
      } else if (_assetsSF) {
        _assetsSF.clearFilters();
        assetsApplyFilterState();
      }
      return;
    }
    var newTab = e.target.closest("[data-sfl-newtab]");
    if (newTab) {
      menu.classList.remove("open");
      var nf = _sflCache.find(function (x) { return x.id === newTab.getAttribute("data-sfl-newtab"); });
      if (nf) _sflApplyInNewTab(nf);
      return;
    }
    var load = e.target.closest("[data-sfl-load]");
    if (load) {
      menu.classList.remove("open");
      var f = _sflCache.find(function (x) { return x.id === load.getAttribute("data-sfl-load"); });
      if (f) _sflApply(f);
      return;
    }
    var del = e.target.closest("[data-sfl-del]");
    if (del) _sflDelete(del.getAttribute("data-sfl-del"));
  });
});
