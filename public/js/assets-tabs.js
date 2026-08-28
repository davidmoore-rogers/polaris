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
 * A tab may also pin one preset as its BASE filter (Filters ▾ → ★): the view
 * the tab returns to. That's what makes narrowing INSIDE a saved filter
 * survivable — the operator filters further on top of the base and gets back
 * with one click, and while a base is set the page-controls row says "Reset
 * Filter" instead of "Clear Filters" (the label is assets.js's, read from
 * activeDefault()). `defaultState` is a SNAPSHOT and is what Reset applies, so
 * a preset that is deleted — or was someone else's private one — can never take
 * a tab's base away; refreshDefaultsFromPresets() re-syncs the snapshot from the
 * live preset every time the Filters menu lists them, which is how an edit to
 * the preset reaches the tabs based on it.
 *
 * Contract with assets.js:
 *   init({hashSeeded})  — awaited before the first fetch so the page loads once
 *   syncFromTable()     — called from assetsApplyFilterState on every change
 *   activeDefault() / resetToDefault() — the Clear/Reset button's label + action
 * and with assets-filters.js:
 *   openInNewTab(preset) / noteFilterLoaded(preset) — the two load paths
 *   setDefaultFilter(preset) / clearDefaultFilter() / refreshDefaultsFromPresets()
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

  // [{ id, name, state, savedFilterId, savedFilterName,
  //    defaultFilterId, defaultFilterName, defaultState }]
  var _tabs = [];
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

  function emptyState() {
    return { sfFilters: {}, sortKey: null, sortDir: null };
  }

  /** The live table state, in the shape the server stores. */
  function liveState() {
    if (!_assetsSF || typeof _assetsSF.getPrefs !== "function") return emptyState();
    var p = _assetsSF.getPrefs();
    return { sfFilters: p.sfFilters || {}, sortKey: p.sortKey || null, sortDir: p.sortDir || null };
  }

  /**
   * A detached copy of a filter state. A base snapshot must never alias the
   * live table state or the Filters menu's preset cache: TableSF.applyState
   * hands the filter objects it is given straight to the filter widgets, so a
   * shared reference would let the operator's next keystroke quietly edit the
   * thing they reset TO.
   */
  function cloneState(state) {
    if (!state || typeof state !== "object") return emptyState();
    return {
      sfFilters: JSON.parse(JSON.stringify(state.sfFilters || {})),
      sortKey: state.sortKey || null,
      sortDir: state.sortDir || null,
    };
  }

  function sameState(a, b) {
    return JSON.stringify(cloneState(a)) === JSON.stringify(cloneState(b));
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
            defaultFilterId: t.defaultFilterId || null,
            defaultFilterName: t.defaultFilterName || null,
            defaultState: t.defaultState || null,
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

  /**
   * Repaint the page-controls row, whose Clear/Reset button is labeled from the
   * active tab's base. assets.js only re-renders it after a fetch, so a base
   * change that leaves the query alone (setting one on the view already on
   * screen, clearing one) has to ask for the repaint itself.
   */
  function notifyBaseChanged() {
    if (typeof window._renderAssetsPageControls === "function") window._renderAssetsPageControls();
  }

  /** Drive the table to a state and let assets.js fetch + mirror it back. */
  function applyStateToTable(state) {
    if (!_assetsSF || typeof _assetsSF.applyState !== "function") return false;
    _assetsSF.applyState(cloneState(state));
    assetsApplyFilterState();
    return true;
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  function tabTitle(tab) {
    var n = filterCount(tab.state);
    var bits = [n ? (n + (n === 1 ? " filter" : " filters")) : "No filters"];
    if (tab.defaultState) {
      bits.push('resets to base filter "' + (tab.defaultFilterName || "base") + '"');
    } else if (tab.savedFilterName) {
      bits.push('from saved filter "' + tab.savedFilterName + '"');
    }
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
      // The base marker does not replace the dot: "has filters" and "has a base
      // to get back to" are two different facts, and the operator acts on both.
      var base = t.defaultState
        ? '<span class="table-tab-base" title="Base filter: ' +
          escapeHtml(t.defaultFilterName || "saved filter") + '">&#9733;</span>'
        : "";
      return '<div class="table-tab' + (active ? " active" : "") + '" data-tab-id="' + escapeHtml(t.id) + '"' +
        ' role="tab" aria-selected="' + (active ? "true" : "false") + '" tabindex="0"' +
        ' title="' + escapeHtml(tabTitle(t)) + '">' +
          base + dot +
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
      state: opts.state ? cloneState(opts.state) : emptyState(),
      savedFilterId: opts.savedFilterId || null,
      savedFilterName: opts.savedFilterName || null,
      defaultFilterId: opts.defaultFilterId || null,
      defaultFilterName: opts.defaultFilterName || null,
      defaultState: opts.defaultState ? cloneState(opts.defaultState) : null,
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
    // filter can be reopened from the Filters menu in one click, and a tab
    // sitting exactly on its own base has nothing on top of it to lose.
    var onBase = tab.defaultState && sameState(tab.state, tab.defaultState);
    if (filterCount(tab.state) && !tab.savedFilterId && !onBase) {
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
            // Rows written before base filters existed carry none — an absent
            // default is simply a tab with nothing to reset to.
            defaultFilterId: t.defaultFilterId || null,
            defaultFilterName: t.defaultFilterName || null,
            defaultState: (t.defaultState && typeof t.defaultState === "object") ? t.defaultState : null,
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
          defaultFilterId: null,
          defaultFilterName: null,
          defaultState: null,
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

    /**
     * Pin a saved preset as the ACTIVE tab's base filter, and apply it.
     *
     * Marking a base IS a reset to it: the base is where the tab starts from,
     * and on a tab already carrying hand-built filters a click that visibly
     * changed nothing would leave the operator unsure it took. What's lost is
     * scratch column filters, which the base is now the way back to.
     */
    setDefaultFilter: function (preset) {
      if (!_ready || !preset) return false;
      var tab = activeTab();
      if (!tab) return false;
      tab.defaultFilterId = preset.id || null;
      tab.defaultFilterName = preset.name ? String(preset.name).slice(0, MAX_NAME) : null;
      tab.defaultState = cloneState(preset.state);
      // The tab came from this preset in every sense now — keep the load-path
      // provenance in step so the close confirmation and tooltip agree.
      tab.savedFilterId = tab.defaultFilterId;
      tab.savedFilterName = tab.defaultFilterName;
      render();
      scheduleSave();
      // applyStateToTable mirrors the base back into tab.state via
      // syncFromTable; the repaint below then relabels the button.
      applyStateToTable(tab.defaultState);
      notifyBaseChanged();
      return true;
    },

    /**
     * Unpin the active tab's base. Deliberately leaves the live filters where
     * they are — the operator asked to stop having a way back, not to lose the
     * view they are looking at.
     */
    clearDefaultFilter: function () {
      if (!_ready) return false;
      var tab = activeTab();
      if (!tab || !tab.defaultState) return false;
      tab.defaultFilterId = null;
      tab.defaultFilterName = null;
      tab.defaultState = null;
      render();
      scheduleSave();
      notifyBaseChanged();
      return true;
    },

    /** The active tab's base filter, or null — read by assets.js + the menu. */
    activeDefault: function () {
      var tab = activeTab();
      if (!tab || !tab.defaultState) return null;
      return {
        id: tab.defaultFilterId,
        name: tab.defaultFilterName,
        state: cloneState(tab.defaultState),
      };
    },

    /** Re-apply the active tab's base filter. False when it has none. */
    resetToDefault: function () {
      var tab = activeTab();
      if (!tab || !tab.defaultState) return false;
      return applyStateToTable(tab.defaultState);
    },

    /**
     * Re-sync every tab's base snapshot from a fresh saved-filter list (the
     * Filters menu calls this on each fetch). An edit to the preset reaches the
     * tabs based on it this way; a preset that has gone — deleted, or someone
     * else's private one — leaves the snapshot alone, so the tab keeps a base
     * it can still reset to.
     */
    refreshDefaultsFromPresets: function (list) {
      if (!_ready || !Array.isArray(list)) return;
      var changed = false;
      _tabs.forEach(function (t) {
        if (!t.defaultState || !t.defaultFilterId) return;
        var preset = null;
        list.forEach(function (f) { if (f && f.id === t.defaultFilterId) preset = f; });
        if (!preset) return;
        var name = preset.name ? String(preset.name).slice(0, MAX_NAME) : null;
        if (name && name !== t.defaultFilterName) { t.defaultFilterName = name; changed = true; }
        if (!sameState(preset.state, t.defaultState)) { t.defaultState = cloneState(preset.state); changed = true; }
      });
      if (!changed) return;
      render();
      scheduleSave();
      notifyBaseChanged();
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
