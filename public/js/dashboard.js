/**
 * public/js/dashboard.js — Dashboard orchestrator (column layout, v2).
 *
 * SolarWinds-style model:
 *   - The dashboard is an ordered list of COLUMNS; each column has a 12-grid
 *     width (3|4|6|12) and a vertical stack of widgets. Array order is the
 *     layout — there is no free-grid reflow.
 *   - EDIT MODE is explicit: the page is read-only until "Customize Page";
 *     edit mode reveals drag handles, remove ×, width/height controls, the
 *     "+ new column" drop target, and the gear config. "Done Editing" saves
 *     and exits.
 *   - Drag a widget (from the picker or an existing one) → a green "+"
 *     insertion placeholder marks the target slot; a trailing empty column is
 *     a "new column" drop target. The dragged widget lifts (shadow).
 *
 * Layout state mirrors the server: { version: 2, columns: [ { id, width,
 * widgets: [ { id, type, height, config } ] } ] }. Legacy v1 layouts are
 * migrated to v2 on load (migrateV1ToV2). Per-widget render lifecycle
 * (fetchData → renderInstance → ctx.onUnmount) is unchanged from v1.
 */

(function () {
  var ROW_HEIGHT_PX = 280;
  var GAP_PX = 16;
  var SAVE_DEBOUNCE_MS = 800;
  var WIDTH_STEPS = [3, 4, 6, 12];
  var HEIGHT_STEPS = [1, 2, 3];

  // Layout is v3: multiple named dashboards (tabs), each a column layout.
  //   { version:3, dashboards:[{ id, name, columns:[...] }], activeId }
  var state = {
    layout: { version: 3, dashboards: [], activeId: null },
    editing: false,
    saving: false,
    saveTimer: null,
    unmounts: {},  // widget instance id → cleanup fn
  };

  // The currently-shown dashboard. All column/widget logic operates on its
  // .columns; switching tabs just repoints activeId. Always returns an object
  // (falls back to the first, or a fresh empty one) so callers never null-check.
  function activeDash() {
    var d = state.layout.dashboards;
    if (!d || !d.length) {
      state.layout.dashboards = [{ id: PolarisWidgets.uuid(), name: "Dashboard 1", columns: [] }];
      state.layout.activeId = state.layout.dashboards[0].id;
      return state.layout.dashboards[0];
    }
    var found = d.find(function (x) { return x.id === state.layout.activeId; });
    if (!found) { found = d[0]; state.layout.activeId = found.id; }
    return found;
  }

  var canvasEl = null;
  var emptyEl = null;
  var tabsEl = null;
  var customizeBtn = null;
  var addWidgetsBtn = null;
  var doneBtn = null;
  var createBtn = null;
  var openPopover = null;

  // Drag stashes — dataTransfer.getData() is unreadable during dragover, so
  // the dragged type/id are stashed module-level at dragstart, cleared at
  // dragend. `_placeholder` is the single green "+" insertion marker.
  var _dragStashId = null;
  var _dragStashType = null;
  var _placeholder = null;
  // Tab-reorder drag stash (edit mode): the dashboard id being dragged.
  var _dragTabId = null;

  document.addEventListener("DOMContentLoaded", function () {
    canvasEl     = document.getElementById("dashboard-canvas");
    emptyEl      = document.getElementById("dashboard-empty-state");
    tabsEl       = document.getElementById("dashboard-tabs");
    customizeBtn = document.getElementById("dashboard-customize");
    addWidgetsBtn = document.getElementById("dashboard-add-widgets");
    doneBtn      = document.getElementById("dashboard-done");
    createBtn    = document.getElementById("dashboard-create");

    if (!canvasEl || !emptyEl || !customizeBtn) return;

    customizeBtn.addEventListener("click", enterEditMode);
    if (addWidgetsBtn) addWidgetsBtn.addEventListener("click", function () { WidgetLibrary.open(handleTapToAdd); });
    if (doneBtn) doneBtn.addEventListener("click", exitEditMode);
    if (createBtn) createBtn.addEventListener("click", createDashboard);

    canvasEl.addEventListener("dragover", onCanvasDragOver);
    canvasEl.addEventListener("dragleave", onCanvasDragLeave);
    canvasEl.addEventListener("drop", onCanvasDrop);

    // Library-card dragstarts happen in the picker overlay (outside the
    // canvas), so capture at the document level to stash the type.
    document.addEventListener("dragstart", function (e) {
      var card = e.target && e.target.closest ? e.target.closest(".widget-library-card[data-type]") : null;
      if (card) { _dragStashType = card.getAttribute("data-type"); _dragStashId = null; }
    });
    document.addEventListener("dragend", clearDragState);

    document.addEventListener("click", function (e) {
      if (!openPopover) return;
      if (openPopover.el.contains(e.target)) return;
      if (e.target.closest && e.target.closest(".dashboard-widget-action[data-action='gear']")) return;
      closePopover();
    });

    bootstrap();
  });

  // ─── Bootstrap + migration ──────────────────────────────────────────────

  async function bootstrap() {
    var loaded;
    try {
      loaded = await api.me.dashboard.get();
    } catch (_err) {
      loaded = null;
    }
    state.layout = normalizeLayout(loaded);

    // Drop-silently: across EVERY dashboard, widget types no longer registered
    // are filtered out and emptied columns dropped. Persist if anything changed.
    var before = JSON.stringify(state.layout.dashboards);
    state.layout.dashboards.forEach(function (dash) {
      dash.columns.forEach(function (col) {
        col.widgets = col.widgets.filter(function (w) { return PolarisWidgets.getByType(w.type) != null; });
      });
      dash.columns = dash.columns.filter(function (col) { return col.widgets.length > 0; });
    });
    if (JSON.stringify(state.layout.dashboards) !== before) queueSave();

    setHeaderMode();
    renderRoot();
  }

  // Normalize any stored layout to v3 (multi-dashboard). v3 passes through;
  // v2 (single column layout) and v1 (free-grid) are wrapped into one
  // "Dashboard 1" tab; anything else becomes a single empty dashboard.
  function normalizeLayout(data) {
    if (data && data.version === 3 && Array.isArray(data.dashboards) && data.dashboards.length) {
      if (!data.activeId || !data.dashboards.some(function (d) { return d.id === data.activeId; })) {
        data.activeId = data.dashboards[0].id;
      }
      return data;
    }
    var columns = [];
    if (data && data.version === 2 && Array.isArray(data.columns)) columns = data.columns;
    else if (data && data.version === 1 && Array.isArray(data.widgets)) columns = migrateV1ToV2(data).columns;
    var id = PolarisWidgets.uuid();
    return { version: 3, dashboards: [{ id: id, name: "Dashboard 1", columns: columns }], activeId: id };
  }

  // v1 {widgets:[{col,row,width,height}]} → v2 columns: bucket by col-start,
  // order by row within each, column width = closest snap of the widest
  // widget. Everything (id/type/config) preserved; empty fallback on error.
  function migrateV1ToV2(v1) {
    try {
      var byCol = {};
      v1.widgets.forEach(function (w) {
        var k = (w.col == null ? 0 : w.col);
        (byCol[k] = byCol[k] || []).push(w);
      });
      var starts = Object.keys(byCol).map(Number).sort(function (a, b) { return a - b; });
      var columns = starts.map(function (cs) {
        var ws = byCol[cs].slice().sort(function (a, b) { return (a.row || 0) - (b.row || 0); });
        var maxW = ws.reduce(function (m, w) { return Math.max(m, w.width || 6); }, 0);
        return {
          id: PolarisWidgets.uuid(),
          width: snapWidth(maxW),
          widgets: ws.map(function (w) {
            return { id: w.id || PolarisWidgets.uuid(), type: w.type, height: (w.height === 2 ? 2 : 1), config: w.config || {} };
          }),
        };
      });
      return { version: 2, columns: columns };
    } catch (_e) {
      return { version: 2, columns: [] };
    }
  }

  function snapWidth(n) {
    var best = WIDTH_STEPS[0], bestD = Infinity;
    WIDTH_STEPS.forEach(function (s) { var d = Math.abs(n - s); if (d < bestD) { bestD = d; best = s; } });
    return best;
  }

  function totalWidgets() {
    return activeDash().columns.reduce(function (n, c) { return n + c.widgets.length; }, 0);
  }

  // ─── Edit mode ────────────────────────────────────────────────────────────

  function enterEditMode() { state.editing = true; setHeaderMode(); renderRoot(); }
  function exitEditMode() {
    state.editing = false;
    setHeaderMode();
    WidgetLibrary.close();
    if (state.saveTimer) saveNow();
    renderRoot();
  }
  function setHeaderMode() {
    if (customizeBtn)   customizeBtn.hidden   = state.editing;
    if (addWidgetsBtn)  addWidgetsBtn.hidden  = !state.editing;
    if (doneBtn)        doneBtn.hidden        = !state.editing;
    canvasEl.classList.toggle("is-editing", state.editing);
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  function unmountAll() {
    Object.keys(state.unmounts).forEach(function (id) {
      try { state.unmounts[id](); } catch (_) {}
    });
    state.unmounts = {};
  }

  // Choose between the empty-state prompt and the canvas, then render. The tab
  // bar (when >1 dashboard) renders above either, independent of empty state.
  function renderRoot() {
    renderTabs();
    if (!state.editing && totalWidgets() === 0) { showEmpty(); return; }
    hideEmpty();
    renderCanvas();
  }

  // ─── Dashboards / tabs ────────────────────────────────────────────────────

  // Tab bar appears once there's more than one dashboard. Click a tab to
  // switch; in edit mode each tab can be renamed (double-click) and removed (×).
  function renderTabs() {
    if (!tabsEl) return;
    var dashes = state.layout.dashboards || [];
    if (dashes.length <= 1) { tabsEl.hidden = true; tabsEl.innerHTML = ""; return; }
    tabsEl.hidden = false;
    tabsEl.innerHTML = dashes.map(function (d) {
      var active = d.id === state.layout.activeId;
      // In edit mode the ACTIVE tab's name is an inline text input — click it
      // and type to rename. Other tabs show a plain name (click to switch).
      var nameHtml = (state.editing && active)
        ? '<input type="text" class="dashboard-tab-name-input" data-name="' + escapeHtml(d.id) + '" value="' + escapeHtml(d.name || "") + '" maxlength="60" size="' + Math.max((d.name || "").length, 8) + '" aria-label="Dashboard name">'
        : '<span class="dashboard-tab-name">' + escapeHtml(d.name || "Untitled") + '</span>';
      // In edit mode a dedicated grip is the drag handle for reordering —
      // the tab itself can't be draggable because the active tab is mostly
      // the rename input (dragging would fight text selection, and there'd
      // be no obvious place to grab).
      var grip = state.editing ? '<span class="dashboard-tab-grip" draggable="true" title="Drag to reorder">⠿</span>' : "";
      return '<div class="dashboard-tab' + (active ? " active" : "") + '" data-dash="' + escapeHtml(d.id) + '" role="button" tabindex="0">' +
        grip +
        nameHtml +
        (state.editing && dashes.length > 1 ? '<button type="button" class="dashboard-tab-remove" data-remove="' + escapeHtml(d.id) + '" title="Delete dashboard">&times;</button>' : '') +
      '</div>';
    }).join("");
    tabsEl.querySelectorAll(".dashboard-tab").forEach(function (tab) {
      var id = tab.getAttribute("data-dash");
      tab.addEventListener("click", function (e) {
        if (e.target.closest("[data-remove]")) { e.stopPropagation(); deleteDashboard(id); return; }
        if (e.target.closest(".dashboard-tab-name-input")) return; // editing the active name, don't switch
        if (e.target.closest(".dashboard-tab-grip")) return; // grip is for dragging, not switching
        switchDashboard(id);
      });
    });
    // Edit mode: wire drag-to-reorder. Drags start from the grip only; the
    // whole tab is the drop target, slotting before/after depending on which
    // half of it the drop lands in.
    if (state.editing) {
      tabsEl.querySelectorAll(".dashboard-tab").forEach(function (tab) {
        var id = tab.getAttribute("data-dash");
        var gripEl = tab.querySelector(".dashboard-tab-grip");
        gripEl.addEventListener("dragstart", function (e) {
          _dragTabId = id;
          if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", id); } catch (_e) {} }
          tab.style.opacity = "0.5";
        });
        gripEl.addEventListener("dragend", function () { _dragTabId = null; tab.style.opacity = ""; clearTabDropCues(); });
        tab.addEventListener("dragover", function (e) {
          if (!_dragTabId || _dragTabId === id) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          var rect = tab.getBoundingClientRect();
          tab._dropBefore = (e.clientX - rect.left) < rect.width / 2;
          clearTabDropCues();
          tab.style.boxShadow = tab._dropBefore ? "inset 3px 0 0 #4fc3f7" : "inset -3px 0 0 #4fc3f7";
        });
        tab.addEventListener("dragleave", function () { tab.style.boxShadow = ""; });
        tab.addEventListener("drop", function (e) {
          if (!_dragTabId || _dragTabId === id) { clearTabDropCues(); return; }
          e.preventDefault();
          reorderDashboards(_dragTabId, id, tab._dropBefore !== false);
        });
      });
    }
    // Inline rename on the active tab's input: Enter or blur commits, Esc cancels.
    var input = tabsEl.querySelector(".dashboard-tab-name-input");
    if (input) {
      input.addEventListener("click", function (e) { e.stopPropagation(); });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        else if (e.key === "Escape") { input.value = nameOf(input.getAttribute("data-name")); input.blur(); }
      });
      input.addEventListener("blur", function () { commitTabName(input.getAttribute("data-name"), input.value); });
    }
  }

  function nameOf(id) {
    var d = state.layout.dashboards.find(function (x) { return x.id === id; });
    return d ? (d.name || "") : "";
  }

  function commitTabName(id, value) {
    var d = state.layout.dashboards.find(function (x) { return x.id === id; });
    if (!d) return;
    var name = (value || "").trim().slice(0, 60);
    if (!name || name === d.name) { renderTabs(); return; } // blank/unchanged → restore
    d.name = name;
    queueSave();
    renderTabs();
  }

  function createDashboard() {
    var id = PolarisWidgets.uuid();
    var n = (state.layout.dashboards.length || 0) + 1;
    state.layout.dashboards.push({ id: id, name: "Dashboard " + n, columns: [] });
    state.layout.activeId = id;
    // New tab is empty and ready to edit, per the feature intent.
    state.editing = true;
    setHeaderMode();
    renderRoot();
    queueSave();
  }

  function clearTabDropCues() {
    if (!tabsEl) return;
    tabsEl.querySelectorAll(".dashboard-tab").forEach(function (t) { t.style.boxShadow = ""; });
  }

  // Move dashboard `fromId` to just before/after `toId` in the tab order, then
  // persist + re-render. Splice-out first so the target index is computed
  // against the array minus the moved item (indices stay correct).
  function reorderDashboards(fromId, toId, before) {
    var arr = state.layout.dashboards;
    var fromIdx = arr.findIndex(function (d) { return d.id === fromId; });
    if (fromIdx < 0) return;
    var moved = arr.splice(fromIdx, 1)[0];
    var toIdx = arr.findIndex(function (d) { return d.id === toId; });
    if (toIdx < 0) { arr.splice(fromIdx, 0, moved); return; } // target vanished — restore
    arr.splice(before ? toIdx : toIdx + 1, 0, moved);
    clearTabDropCues();
    queueSave();
    renderTabs();
  }

  function switchDashboard(id) {
    if (id === state.layout.activeId) return;
    state.layout.activeId = id;
    closePopover();
    renderRoot();
    queueSave();
  }

  function deleteDashboard(id) {
    if (state.layout.dashboards.length <= 1) return; // never remove the last
    if (!window.confirm("Delete this dashboard and its widgets?")) return;
    applyChange(function () {
      state.layout.dashboards = state.layout.dashboards.filter(function (x) { return x.id !== id; });
      if (state.layout.activeId === id) state.layout.activeId = state.layout.dashboards[0].id;
    });
  }

  function showEmpty() {
    emptyEl.hidden = false;
    canvasEl.hidden = true;
    canvasEl.innerHTML = "";
    unmountAll();
  }
  function hideEmpty() {
    emptyEl.hidden = true;
    canvasEl.hidden = false;
  }

  function renderCanvas() {
    unmountAll();
    canvasEl.innerHTML = "";
    _placeholder = null;
    activeDash().columns.forEach(function (col, ci) {
      canvasEl.appendChild(mountColumnShell(col, ci));
    });
    if (state.editing) canvasEl.appendChild(buildNewColumnTarget());
    // Mount widget bodies after all shells are in the DOM.
    activeDash().columns.forEach(function (col) { col.widgets.forEach(renderWidget); });
  }

  function mountColumnShell(col, ci) {
    var colEl = document.createElement("section");
    colEl.className = "dashboard-column";
    colEl.setAttribute("data-col-id", col.id);
    colEl.style.gridColumn = "span " + col.width;

    if (state.editing) {
      var header = document.createElement("div");
      header.className = "dashboard-column-header";
      header.innerHTML = widthCtlHTML(col.width) +
        '<button type="button" class="dashboard-column-remove" data-action="remove-column" title="Remove column">&times;</button>';
      header.querySelectorAll("[data-w]").forEach(function (btn) {
        btn.addEventListener("click", function () { setColumnWidth(col.id, parseInt(btn.getAttribute("data-w"), 10)); });
      });
      header.querySelector('[data-action="remove-column"]').addEventListener("click", function () { removeColumn(col.id); });
      colEl.appendChild(header);
    }

    var stack = document.createElement("div");
    stack.className = "dashboard-column-stack";
    col.widgets.forEach(function (w) { stack.appendChild(mountWidgetShell(w)); });
    colEl.appendChild(stack);
    return colEl;
  }

  var WIDTH_LABELS = { 3: "¼", 4: "⅓", 6: "½", 12: "Full" };
  function widthCtlHTML(active) {
    return '<div class="dashboard-column-width-ctl">' + WIDTH_STEPS.map(function (w) {
      return '<button type="button" data-w="' + w + '"' + (w === active ? ' class="active"' : '') +
        ' title="Width ' + w + '/12">' + WIDTH_LABELS[w] + '</button>';
    }).join("") + '</div>';
  }

  // Widget header title. When a widget's asset-type filter selects a strict
  // subset of the eight built-ins, the chosen types are appended in parens
  // (e.g. "Highest CPU (Server, Switch)"); all-on (or no filter) → bare label.
  function widgetTitleFor(module, w) {
    var base = module ? module.label : (w.type + " (unknown widget)");
    var cfg = (w && w.config) || {};
    var BUILTIN = (window.PolarisWidgets && PolarisWidgets.BUILTIN_ASSET_TYPES) || [];
    if (Array.isArray(cfg.assetTypes) && cfg.assetTypes.length > 0 && cfg.assetTypes.length < BUILTIN.length) {
      var labels = (window.PolarisWidgets && PolarisWidgets.ASSET_TYPE_LABELS) || {};
      var picked = BUILTIN
        .filter(function (t) { return cfg.assetTypes.indexOf(t) !== -1; })  // preserve built-in order
        .map(function (t) { return labels[t] || t; });
      if (picked.length) base += " (" + picked.join(", ") + ")";
    }
    return base;
  }

  function mountWidgetShell(w) {
    var module = PolarisWidgets.getByType(w.type);
    var label = widgetTitleFor(module, w);
    var article = document.createElement("article");
    article.className = "dashboard-widget";
    article.setAttribute("data-id", w.id);
    article.setAttribute("data-type", w.type);
    // Fixed pixel height so widget bodies (charts, Leaflet map) get a sized
    // container. height 1/2/3 rows → 280 / 576 / 872px (N rows + the gaps).
    var hRows = Math.min(3, Math.max(1, w.height || 1));
    article.style.height = (hRows * ROW_HEIGHT_PX + (hRows - 1) * GAP_PX) + "px";

    // In edit mode a dedicated grip is the drag handle — a clear, easy target
    // for dragging the widget to another column (the title alone was too easy
    // to miss). The whole widget can move across columns from here.
    var grip = state.editing ? '<span class="dashboard-widget-grip" draggable="true" title="Drag to move (to any column)">⠿</span>' : "";
    var editControls = state.editing
      ? '<button type="button" class="dashboard-widget-height-toggle" data-action="height" title="Height (click to cycle 1×/2×/3×)">' + (Math.min(3, Math.max(1, w.height || 1))) + '×</button>' +
        '<button type="button" class="dashboard-widget-action" data-action="gear" title="Configure">⚙</button>' +
        '<button type="button" class="dashboard-widget-remove" data-action="remove" title="Remove">&times;</button>'
      : "";
    article.innerHTML =
      '<div class="dashboard-widget-header">' +
        grip +
        '<div class="dashboard-widget-title">' + escapeHtml(label) + '</div>' +
        editControls +
      '</div>' +
      '<div class="dashboard-widget-body"></div>';

    if (state.editing) {
      var gripEl = article.querySelector(".dashboard-widget-grip");
      gripEl.addEventListener("dragstart", function (e) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-polaris-widget-move", w.id);
        e.dataTransfer.setData("text/plain", w.id);
        _dragStashId = w.id;
        _dragStashType = null;
        article.classList.add("lifted");
        canvasEl.classList.add("is-dragging");
      });
      gripEl.addEventListener("dragend", clearDragState);

      article.querySelector('[data-action="gear"]').addEventListener("click", function (ev) {
        ev.stopPropagation();
        openGearPopover(w, ev.currentTarget);
      });
      article.querySelector('[data-action="height"]').addEventListener("click", function () {
        // Cycle 1× → 2× → 3× → 1×.
        setWidgetHeight(w.id, (Math.min(3, Math.max(1, w.height || 1)) % 3) + 1);
      });
      article.querySelector('[data-action="remove"]').addEventListener("click", function () { removeWidget(w.id); });
    }
    return article;
  }

  function buildNewColumnTarget() {
    var el = document.createElement("div");
    el.className = "dashboard-newcol-target";
    el.setAttribute("data-newcol", "1");
    el.innerHTML = '<span>+ New block</span>';
    // Click-to-add a new empty column (keyboard/touch parity with drag).
    el.addEventListener("click", function () {
      if (!_dragStashId && !_dragStashType) WidgetLibrary.open(handleTapToAdd);
    });
    return el;
  }

  // renderWidget — per-widget mount lifecycle. UNCHANGED from v1: clears the
  // body, runs fetchData → renderInstance, registers cleanup via ctx.onUnmount.
  function renderWidget(w) {
    var article = canvasEl.querySelector('.dashboard-widget[data-id="' + cssEscape(w.id) + '"]');
    if (!article) return;
    var body = article.querySelector(".dashboard-widget-body");
    body.innerHTML = "";

    if (state.unmounts[w.id]) {
      try { state.unmounts[w.id](); } catch (_) {}
      delete state.unmounts[w.id];
    }
    var unmountFns = [];
    var ctx = {
      onUnmount: function (fn) { unmountFns.push(fn); },
    };

    var module = PolarisWidgets.getByType(w.type);
    if (!module) {
      body.innerHTML = '<p class="empty-state">Unknown widget: ' + escapeHtml(w.type) + '</p>';
      return;
    }
    // NOC-style auto-scroll: when a widget's content overflows, slowly creep
    // through it and loop (like noc.rogersgroupinc.com). Read-only only —
    // never while editing. Self-activates when/if content overflows.
    if (!state.editing) {
      unmountFns.push(startAutoScroll(body, article));
    }
    var dataPromise;
    try {
      dataPromise = module.fetchData ? module.fetchData(w.config || {}) : Promise.resolve(null);
    } catch (err) {
      dataPromise = Promise.reject(err);
    }
    Promise.resolve(dataPromise).then(function (data) {
      try {
        module.renderInstance(body, w.config || {}, data, ctx);
      } catch (err) {
        body.innerHTML = '<p class="empty-state" style="color:#ef5350">Render failed: ' + escapeHtml(err.message || String(err)) + '</p>';
      }
    }).catch(function (err) {
      body.innerHTML = '<p class="empty-state" style="color:#ef5350">' + escapeHtml(err.message || "Fetch failed") + '</p>';
    });
    state.unmounts[w.id] = function () { unmountFns.forEach(function (fn) { try { fn(); } catch (_) {} }); };
  }

  // ─── State mutations ──────────────────────────────────────────────────────

  function applyChange(mutator) {
    mutator();
    renderRoot();
    queueSave();
  }

  function queueSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }
  async function saveNow() {
    state.saveTimer = null;
    state.saving = true;
    try {
      await api.me.dashboard.put(state.layout);
    } catch (err) {
      if (typeof showToast === "function") showToast("Failed to save dashboard: " + (err.message || err), "error");
    } finally {
      state.saving = false;
    }
  }

  function findWidget(id) {
    for (var ci = 0; ci < activeDash().columns.length; ci++) {
      var idx = activeDash().columns[ci].widgets.findIndex(function (w) { return w.id === id; });
      if (idx !== -1) return { colIndex: ci, idx: idx, widget: activeDash().columns[ci].widgets[idx] };
    }
    return null;
  }

  function newColumn(widthHint, widgets) {
    return { id: PolarisWidgets.uuid(), width: snapWidth(widthHint || 6), widgets: widgets || [] };
  }

  function addWidgetAt(type, target) {
    var module = PolarisWidgets.getByType(type);
    if (!module) return;
    var inst = {
      id: PolarisWidgets.uuid(),
      type: module.type,
      height: module.defaultSize.height === 2 ? 2 : 1,
      config: Object.assign({}, module.defaultConfig || {}),
    };
    if (!target || target.newColumn || !activeDash().columns.length) {
      activeDash().columns.push(newColumn(module.defaultSize.width, [inst]));
    } else {
      activeDash().columns[target.columnIndex].widgets.splice(target.insertionIndex, 0, inst);
    }
    hideEmpty();
    renderRoot();
    queueSave();
  }

  function moveWidgetTo(id, target) {
    var src = findWidget(id);
    if (!src || !target) return;
    applyChange(function () {
      activeDash().columns[src.colIndex].widgets.splice(src.idx, 1);
      if (target.newColumn) {
        activeDash().columns.push(newColumn(6, [src.widget]));
      } else {
        var at = target.insertionIndex;
        // Same-column move past the removed slot shifts the index down by one.
        if (target.columnIndex === src.colIndex && src.idx < at) at--;
        activeDash().columns[target.columnIndex].widgets.splice(at, 0, src.widget);
      }
      activeDash().columns = activeDash().columns.filter(function (c) { return c.widgets.length > 0; });
    });
  }

  function removeWidget(id) {
    applyChange(function () {
      activeDash().columns.forEach(function (c) { c.widgets = c.widgets.filter(function (w) { return w.id !== id; }); });
      activeDash().columns = activeDash().columns.filter(function (c) { return c.widgets.length > 0; });
    });
  }

  function removeColumn(colId) {
    applyChange(function () {
      activeDash().columns = activeDash().columns.filter(function (c) { return c.id !== colId; });
    });
  }

  function setColumnWidth(colId, width) {
    var col = activeDash().columns.find(function (c) { return c.id === colId; });
    if (!col || col.width === width) return;
    applyChange(function () { col.width = width; });
  }

  function setWidgetHeight(id, height) {
    var src = findWidget(id);
    if (!src || src.widget.height === height) return;
    applyChange(function () { src.widget.height = height; });
  }

  function updateConfig(id, key, value) {
    var src = findWidget(id);
    if (!src) return;
    src.widget.config = Object.assign({}, src.widget.config || {}, { [key]: value });
    queueSave();
    renderWidget(src.widget);
    // Header title may depend on the asset-type filter — refresh it in place
    // (renderWidget only re-renders the body, not the shell header).
    var article = canvasEl.querySelector('.dashboard-widget[data-id="' + cssEscape(id) + '"]');
    var titleEl = article && article.querySelector(".dashboard-widget-title");
    if (titleEl) titleEl.textContent = widgetTitleFor(PolarisWidgets.getByType(src.widget.type), src.widget);
  }

  function handleTapToAdd(type) {
    // Click-to-add from the picker: append to the last column, or start one.
    if (activeDash().columns.length) {
      var last = activeDash().columns.length - 1;
      addWidgetAt(type, { columnIndex: last, insertionIndex: activeDash().columns[last].widgets.length });
    } else {
      addWidgetAt(type, { newColumn: true });
    }
  }

  // ─── Drag handlers (canvas) ─────────────────────────────────────────────

  function onCanvasDragOver(ev) {
    var types = ev.dataTransfer ? ev.dataTransfer.types : null;
    if (!types) return;
    var isAdd  = types.indexOf("application/x-polaris-widget") !== -1;
    var isMove = types.indexOf("application/x-polaris-widget-move") !== -1;
    if (!isAdd && !isMove) return;
    if (!state.editing) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = isAdd ? "copy" : "move";
    showPlaceholderAt(ev.clientX, ev.clientY);
  }

  function onCanvasDragLeave(ev) {
    if (ev.relatedTarget && canvasEl.contains(ev.relatedTarget)) return;
    clearPlaceholder();
  }

  function onCanvasDrop(ev) {
    if (!state.editing) return;
    var addType = ev.dataTransfer.getData("application/x-polaris-widget");
    var moveId  = ev.dataTransfer.getData("application/x-polaris-widget-move");
    if (!addType && !moveId) return;
    ev.preventDefault();
    var target = dropTargetFromCursor(ev.clientX, ev.clientY);
    clearDragState();
    if (!target) return;
    if (addType) { addWidgetAt(addType, target); WidgetLibrary.close(); }
    else if (moveId) { moveWidgetTo(moveId, target); }
  }

  // Resolve the cursor to { columnIndex, insertionIndex } or { newColumn:true }.
  function dropTargetFromCursor(clientX, clientY) {
    var newColEl = canvasEl.querySelector(".dashboard-newcol-target");
    if (newColEl && withinRect(newColEl, clientX, clientY)) return { newColumn: true };

    var colEls = Array.prototype.slice.call(canvasEl.querySelectorAll(".dashboard-column"));
    if (!colEls.length) return { newColumn: true };

    // Pick the column whose box contains the cursor in BOTH axes. Columns wrap
    // into multiple rows, and a Full-width column spans the entire row width —
    // so an x-only test would always match it and trap every drop in the first
    // (top) column. Require y to be inside the column too; if the cursor is in
    // a gap / below everything, fall back to the nearest column by centre.
    var colEl = null;
    for (var i = 0; i < colEls.length; i++) {
      var r = colEls[i].getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) { colEl = colEls[i]; break; }
    }
    if (!colEl) {
      var bestD = Infinity;
      for (var k = 0; k < colEls.length; k++) {
        var rr = colEls[k].getBoundingClientRect();
        var dx = clientX - (rr.left + rr.width / 2);
        var dy = clientY - (rr.top + rr.height / 2);
        var d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; colEl = colEls[k]; }
      }
    }
    var ci = colEls.indexOf(colEl);
    var cards = Array.prototype.slice.call(colEl.querySelectorAll(".dashboard-widget"));
    var idx = cards.length;
    for (var j = 0; j < cards.length; j++) {
      var cr = cards[j].getBoundingClientRect();
      if (clientY < cr.top + cr.height / 2) { idx = j; break; }
    }
    return { columnIndex: ci, insertionIndex: idx };
  }

  function withinRect(el, x, y) {
    var r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function ensurePlaceholder() {
    if (_placeholder) return _placeholder;
    _placeholder = document.createElement("div");
    _placeholder.className = "dashboard-drop-placeholder";
    return _placeholder;
  }

  function showPlaceholderAt(clientX, clientY) {
    var target = dropTargetFromCursor(clientX, clientY);
    canvasEl.querySelectorAll(".dashboard-column.drag-over, .dashboard-newcol-target.drag-over")
      .forEach(function (e) { e.classList.remove("drag-over"); });
    var ph = ensurePlaceholder();
    if (!target || target.newColumn) {
      var nc = canvasEl.querySelector(".dashboard-newcol-target");
      if (nc) nc.classList.add("drag-over");
      if (ph.parentNode) ph.parentNode.removeChild(ph);
      return;
    }
    var colEls = canvasEl.querySelectorAll(".dashboard-column");
    var colEl = colEls[target.columnIndex];
    if (!colEl) return;
    colEl.classList.add("drag-over");
    var stack = colEl.querySelector(".dashboard-column-stack");
    var cards = stack.querySelectorAll(".dashboard-widget");
    if (target.insertionIndex >= cards.length) stack.appendChild(ph);
    else stack.insertBefore(ph, cards[target.insertionIndex]);
  }

  function clearPlaceholder() {
    if (_placeholder && _placeholder.parentNode) _placeholder.parentNode.removeChild(_placeholder);
    canvasEl.querySelectorAll(".drag-over").forEach(function (e) { e.classList.remove("drag-over"); });
  }

  function clearDragState() {
    _dragStashId = null;
    _dragStashType = null;
    _dragTabId = null;
    clearTabDropCues();
    clearPlaceholder();
    canvasEl.classList.remove("is-dragging");
    canvasEl.querySelectorAll(".dashboard-widget.lifted").forEach(function (e) { e.classList.remove("lifted"); });
  }

  // ─── Gear popover ───────────────────────────────────────────────────────

  function openGearPopover(w, anchorEl) {
    closePopover();
    var module = PolarisWidgets.getByType(w.type);
    if (!module) return;
    var pop = document.createElement("div");
    pop.className = "widget-config-popover";
    pop.innerHTML = '<h4>' + escapeHtml(module.label) + '</h4><div class="widget-config-fields"></div>' +
      '<div class="widget-config-popover-footer">' +
        '<button type="button" class="btn btn-icon" data-action="remove">Remove widget</button>' +
        '<button type="button" class="btn btn-primary" data-action="close">Done</button>' +
      '</div>';
    document.body.appendChild(pop);

    var fieldsEl = pop.querySelector(".widget-config-fields");
    if (module.renderConfig) {
      try {
        module.renderConfig(fieldsEl, w.config || {}, function (key, value) { updateConfig(w.id, key, value); });
      } catch (err) {
        fieldsEl.innerHTML = '<p class="empty-state">Config failed to render.</p>';
      }
    } else {
      fieldsEl.innerHTML = '<p style="font-size:0.82rem;color:var(--color-text-secondary)">This widget has no configurable options.</p>';
    }
    pop.querySelector('[data-action="remove"]').addEventListener("click", function () { closePopover(); removeWidget(w.id); });
    pop.querySelector('[data-action="close"]').addEventListener("click", closePopover);

    var anchorRect = anchorEl.getBoundingClientRect();
    var width = 260;
    pop.style.width = width + "px";
    var top = anchorRect.top + window.scrollY;
    var leftSide = anchorRect.left + window.scrollX - width - 6;
    var rightSide = anchorRect.right + window.scrollX + 6;
    var left = leftSide >= 8 ? leftSide : rightSide;
    var viewportRight = window.scrollX + document.documentElement.clientWidth - 8;
    if (left + width > viewportRight) left = Math.max(8, viewportRight - width);
    pop.style.top = top + "px";
    pop.style.left = left + "px";

    openPopover = { el: pop, widgetId: w.id };
  }
  function closePopover() {
    if (!openPopover) return;
    try { document.body.removeChild(openPopover.el); } catch (_) {}
    openPopover = null;
  }

  // ─── NOC-style auto-scroll ───────────────────────────────────────────────
  // Mirrors the SolarWinds NOC wall display (noc.rogersgroupinc.com): pause
  // ~3s at the top, creep down 1px per tick, dwell ~3s at the bottom, reset to
  // the top (glide), repeat — but only while the content actually overflows.
  // NOC uses translateY on an inner wrapper; we drive scrollTop on the
  // overflow:auto widget body instead (no DOM wrapper needed). Pauses while
  // the operator hovers the widget so they can read / click without it moving.
  function startAutoScroll(scrollEl, hoverEl) {
    var STEP_MS = 80;                              // tick cadence (NOC metric-box speed)
    var TOP_PAUSE_TICKS = Math.ceil(3000 / STEP_MS); // ~3s dwell at the top
    var BOTTOM_DWELL = 40;                          // extra ticks held at the bottom (~3.2s)
    var offset = 0;
    var pause = TOP_PAUSE_TICKS;
    var hovered = false;

    function onEnter() { hovered = true; }
    function onLeave() { hovered = false; }
    hoverEl.addEventListener("mouseenter", onEnter);
    hoverEl.addEventListener("mouseleave", onLeave);

    var timer = setInterval(function () {
      var maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      if (maxScroll <= 4) {                         // content fits → nothing to scroll
        if (scrollEl.scrollTop !== 0) scrollEl.scrollTop = 0;
        offset = 0; pause = TOP_PAUSE_TICKS;
        return;
      }
      if (hovered) return;                          // operator is reading — hold
      if (pause > 0) { pause--; return; }
      offset += 1;
      if (offset > maxScroll + BOTTOM_DWELL) {       // past bottom + dwell → glide home, re-pause
        offset = 0;
        pause = TOP_PAUSE_TICKS;
        try { scrollEl.scrollTo({ top: 0, behavior: "smooth" }); }
        catch (_) { scrollEl.scrollTop = 0; }
        return;
      }
      scrollEl.scrollTop = Math.min(offset, maxScroll);
    }, STEP_MS);

    return function cleanup() {
      clearInterval(timer);
      hoverEl.removeEventListener("mouseenter", onEnter);
      hoverEl.removeEventListener("mouseleave", onLeave);
    };
  }

  // CSS.escape polyfill — old browsers + safe escape for our use case.
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return "\\" + c; });
  }
})();
