/**
 * public/js/assets-tabs.js — per-user view tabs for the Assets table.
 *
 * A tab is one open VIEW: a name plus the table's filter + sort state. Tabs are
 * this operator's workspace — private, server-persisted per user
 * (GET/PUT /api/v1/me/table-tabs?scope=assets, the /me/dashboard sibling), so
 * they follow them across browsers but are never shared. The durable, shareable
 * artifact is a saved filter preset (assets-filters.js); a tab opened from one
 * keeps a REFERENCE for its label, and editing the tab never writes back — the
 * preset may belong to someone else.
 *
 * Contract with assets.js:
 *   init({hashSeeded})  — awaited before the first fetch so the page loads once
 *   syncFromTable()     — called from assetsApplyFilterState on every change
 * and with assets-filters.js:
 *   openInNewTab(preset) / noteFilterLoaded(preset) — the two load paths
 *
 * Re-entrancy: applying a tab's state calls assetsApplyFilterState, which calls
 * syncFromTable — guarded by _applying so a tab switch can't dirty the tab it
 * just left.
 *
 * Depends on globals from app.js (showToast/showConfirm/escapeHtml), api.js
 * (api), table-sf.js (TableSF.applyState/getPrefs) and assets.js (_assetsSF,
 * assetsApplyFilterState). Loaded by assets.html BEFORE assets.js so
 * window.PolarisAssetTabs exists when assets.js's DOMContentLoaded runs.
 */

/* global api, showToast, showConfirm, escapeHtml, _assetsSF, assetsApplyFilterState */

(function () {
  var SCOPE = "assets";
  var MAX_TABS = 20;
  var MAX_NAME = 40;
  var SAVE_DEBOUNCE_MS = 800;

  var _tabs = [];            // [{ id, name, state, savedFilterId, savedFilterName }]
  var _activeId = "";
  var _applying = false;     // suppresses syncFromTable while we drive the table
  var _persisted = false;    // false until the server has a row for this user
  var _saveTimer = null;
  var _ready = false;

  function uid() {
    // Not security-sensitive — just needs to be unique within one user's strip.
    return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function activeTab() {
    for (var i = 0; i < _tabs.length; i++) if (_tabs[i].id === _activeId) return _tabs[i];
    return _tabs[0] || null;
  }

  /** The live table state, in the shape the server stores. */
  function liveState() {
    if (!_assetsSF || typeof _assetsSF.getPrefs !== "function") {
      return { sfFilters: {}, sortKey: null, sortDir: null };
    }
    var p = _assetsSF.getPrefs();
    return { sfFilters: p.sfFilters || {}, sortKey: p.sortKey || null, sortDir: p.sortDir || null };
  }

  function filterCount(state) {
    return Object.keys((state && state.sfFilters) || {}).length;
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  function scheduleSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }

  async function saveNow() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    try {
      await api.tableTabs.save(SCOPE, {
        tabs: _tabs.map(function (t) {
          return {
            id: t.id,
            name: t.name,
            state: t.state,
            savedFilterId: t.savedFilterId || null,
            savedFilterName: t.savedFilterName || null,
          };
        }),
        activeId: _activeId,
      });
      _persisted = true;
    } catch (err) {
      // Non-fatal: the strip keeps working for this session. Surfacing it once
      // is better than silently losing the layout on the next login.
      showToast("Could not save your tabs — " + (err.message || "server error"), "error");
    }
  }

  // ─── Applying a tab to the table ──────────────────────────────────────────

  function applyActiveToTable() {
    var tab = activeTab();
    if (!tab || !_assetsSF || typeof _assetsSF.applyState !== "function") return;
    _applying = true;
    try {
      _assetsSF.applyState(tab.state);
      assetsApplyFilterState();
    } finally {
      _applying = false;
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  function tabTitle(tab) {
    var n = filterCount(tab.state);
    var bits = [n ? (n + (n === 1 ? " filter" : " filters")) : "No filters"];
    if (tab.savedFilterName) bits.push('from saved filter "' + tab.savedFilterName + '"');
    bits.push("double-click to rename");
    return bits.join(" · ");
  }

  function render() {
    var list = document.getElementById("assets-tabs-list");
    if (!list) return;
    var closable = _tabs.length > 1;
    list.innerHTML = _tabs.map(function (t) {
      var active = t.id === _activeId;
      var dot = filterCount(t.state) ? '<span class="table-tab-dot" aria-hidden="true"></span>' : "";
      return '<div class="table-tab' + (active ? " active" : "") + '" data-tab-id="' + escapeHtml(t.id) + '"' +
        ' role="tab" aria-selected="' + (active ? "true" : "false") + '" tabindex="0"' +
        ' title="' + escapeHtml(tabTitle(t)) + '">' +
          dot +
          '<span class="table-tab-name">' + escapeHtml(t.name) + "</span>" +
          (closable
            ? '<button type="button" class="table-tab-close" data-tab-close="' + escapeHtml(t.id) +
              '" title="Close tab" aria-label="Close ' + escapeHtml(t.name) + '">&times;</button>'
            : "") +
        "</div>";
    }).join("");
  }

  // ─── Mutations ────────────────────────────────────────────────────────────

  function selectTab(id) {
    if (id === _activeId) return;
    var found = _tabs.some(function (t) { return t.id === id; });
    if (!found) return;
    _activeId = id;
    render();
    applyActiveToTable();
    scheduleSave();
  }

  function addTab(opts) {
    opts = opts || {};
    if (_tabs.length >= MAX_TABS) {
      showToast("You can have at most " + MAX_TABS + " tabs — close one first", "error");
      return null;
    }
    var tab = {
      id: uid(),
      name: (opts.name || defaultTabName()).slice(0, MAX_NAME),
      state: opts.state || { sfFilters: {}, sortKey: null, sortDir: null },
      savedFilterId: opts.savedFilterId || null,
      savedFilterName: opts.savedFilterName || null,
    };
    _tabs.push(tab);
    _activeId = tab.id;
    render();
    applyActiveToTable();
    scheduleSave();
    return tab;
  }

  function defaultTabName() {
    for (var n = _tabs.length + 1; ; n++) {
      var name = "Tab " + n;
      var taken = _tabs.some(function (t) { return t.name === name; });
      if (!taken) return name;
    }
  }

  async function closeTab(id) {
    if (_tabs.length <= 1) return;                       // never close the last one
    var idx = -1;
    for (var i = 0; i < _tabs.length; i++) if (_tabs[i].id === id) idx = i;
    if (idx < 0) return;
    var tab = _tabs[idx];
    // Only ask when there's hand-built work to lose: a tab backed by a saved
    // filter can be reopened from the Filters menu in one click.
    if (filterCount(tab.state) && !tab.savedFilterId) {
      var ok = await showConfirm('Close "' + tab.name + '"? Its filters are not saved.');
      if (!ok) return;
    }
    _tabs.splice(idx, 1);
    if (_activeId === id) {
      _activeId = _tabs[Math.min(idx, _tabs.length - 1)].id;
      render();
      applyActiveToTable();
    } else {
      render();
    }
    scheduleSave();
  }

  /** Swap a tab's label for an input; Enter/blur commits, Escape reverts. */
  function beginRename(tabEl) {
    var id = tabEl.getAttribute("data-tab-id");
    var tab = null;
    _tabs.forEach(function (t) { if (t.id === id) tab = t; });
    if (!tab || tabEl.querySelector("input")) return;
    var nameEl = tabEl.querySelector(".table-tab-name");
    if (!nameEl) return;
    var input = document.createElement("input");
    input.type = "text";
    input.className = "table-tab-input";
    input.maxLength = MAX_NAME;
    input.value = tab.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    var done = false;
    function commit(save) {
      if (done) return;
      done = true;
      var next = (input.value || "").trim().replace(/\s+/g, " ").slice(0, MAX_NAME);
      if (save && next) {
        tab.name = next;
        // A renamed tab is the operator's own label now — drop the preset
        // reference from the LABEL story but keep the id so "not saved"
        // confirmations still know it came from somewhere.
        scheduleSave();
      }
      render();
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
    input.addEventListener("blur", function () { commit(true); });
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  window.PolarisAssetTabs = {
    /**
     * Load the caller's tabs and apply the active one. Awaited by assets.js
     * before its first fetch. `hashSeeded` = a deep link already narrowed the
     * table, so keep that narrowing and fold it into the active tab instead of
     * replacing it.
     */
    init: async function (opts) {
      var strip = document.getElementById("assets-tabs");
      if (!strip) return;                                 // not the Assets page
      opts = opts || {};
      var layout = null;
      try {
        layout = await api.tableTabs.get(SCOPE);
      } catch (_) {
        layout = null;                                    // offline/denied — local-only strip
      }
      if (layout && Array.isArray(layout.tabs) && layout.tabs.length) {
        _tabs = layout.tabs.map(function (t) {
          return {
            id: String(t.id),
            name: String(t.name || "Tab"),
            state: (t.state && typeof t.state === "object") ? t.state : { sfFilters: {}, sortKey: null, sortDir: null },
            savedFilterId: t.savedFilterId || null,
            savedFilterName: t.savedFilterName || null,
          };
        });
        _activeId = layout.activeId || _tabs[0].id;
        _persisted = true;
      } else {
        // First visit: seed one tab from whatever the table is already showing
        // (the restored localStorage prefs), so nothing the operator had is lost.
        _tabs = [{
          id: uid(),
          name: "All assets",
          state: liveState(),
          savedFilterId: null,
          savedFilterName: null,
        }];
        _activeId = _tabs[0].id;
        _persisted = false;                               // don't write until they use it
      }
      _ready = true;
      render();
      wire(strip);

      if (opts.hashSeeded) {
        // The deep link wins for this load; record it so the tab reflects what
        // is on screen (pre-tabs behavior overwrote the saved prefs the same way).
        var t = activeTab();
        if (t) { t.state = liveState(); if (_persisted) scheduleSave(); }
        render();
      } else {
        _applying = true;
        try {
          if (_assetsSF && typeof _assetsSF.applyState === "function") _assetsSF.applyState(activeTab().state);
        } finally {
          _applying = false;
        }
        // No assetsApplyFilterState here — assets.js fetches right after init,
        // and a second fetch would double-load the first page.
      }
    },

    /** Mirror the live table state into the active tab (assets.js hook). */
    syncFromTable: function () {
      if (!_ready || _applying) return;
      var tab = activeTab();
      if (!tab) return;
      var next = liveState();
      if (JSON.stringify(next) === JSON.stringify(tab.state)) return;
      tab.state = next;
      render();                                           // filter dot + tooltip
      scheduleSave();
    },

    /** Open a saved preset in a NEW tab (Filters ▾ → ⧉). */
    openInNewTab: function (preset) {
      if (!_ready || !preset) return false;
      return !!addTab({
        name: preset.name,
        state: preset.state,
        savedFilterId: preset.id,
        savedFilterName: preset.name,
      });
    },

    /** A preset was loaded into the CURRENT tab — record where it came from. */
    noteFilterLoaded: function (preset) {
      if (!_ready || !preset) return;
      var tab = activeTab();
      if (!tab) return;
      tab.savedFilterId = preset.id;
      tab.savedFilterName = preset.name;
      // Adopt the preset's name only while the tab is still unnamed scratch —
      // never clobber a name the operator typed.
      if (/^Tab \d+$/.test(tab.name) || tab.name === "All assets") {
        tab.name = String(preset.name).slice(0, MAX_NAME);
      }
      render();
      scheduleSave();
    },

    /** The active tab's name — seeds the save-preset modal. */
    activeTabName: function () {
      var t = activeTab();
      return t ? t.name : "";
    },

    /** Test seam: the current strip state without a round-trip. */
    _debugState: function () {
      return { tabs: _tabs.slice(), activeId: _activeId, persisted: _persisted };
    },
  };

  // ─── Wiring ───────────────────────────────────────────────────────────────

  function wire(strip) {
    if (strip.getAttribute("data-wired") === "1") return;
    strip.setAttribute("data-wired", "1");

    var add = document.getElementById("assets-tab-add");
    if (add) add.addEventListener("click", function () { addTab(); });

    var list = document.getElementById("assets-tabs-list");
    if (!list) return;

    list.addEventListener("click", function (e) {
      var close = e.target.closest("[data-tab-close]");
      if (close) {
        e.stopPropagation();
        closeTab(close.getAttribute("data-tab-close"));
        return;
      }
      var tabEl = e.target.closest(".table-tab");
      if (tabEl && !tabEl.querySelector("input")) selectTab(tabEl.getAttribute("data-tab-id"));
    });

    list.addEventListener("dblclick", function (e) {
      var tabEl = e.target.closest(".table-tab");
      if (tabEl) beginRename(tabEl);
    });

    // Keyboard parity for the click/dblclick pair: Enter/Space activates,
    // F2 renames — the strip's tabs are focusable (tabindex=0).
    list.addEventListener("keydown", function (e) {
      var tabEl = e.target.closest(".table-tab");
      if (!tabEl || tabEl.querySelector("input")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectTab(tabEl.getAttribute("data-tab-id"));
      } else if (e.key === "F2") {
        e.preventDefault();
        beginRename(tabEl);
      }
    });

    // A debounced layout save can still be in flight when the operator leaves.
    window.addEventListener("beforeunload", function () {
      if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; saveNow(); }
    });
  }
})();
