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
  var HEIGHT_STEPS = [1, 2];

  var state = {
    layout: { version: 2, columns: [] },
    editing: false,
    saving: false,
    saveTimer: null,
    summary: null, // cached /dashboard/summary payload (shared by built-in widgets)
    unmounts: {},  // widget instance id → cleanup fn
  };

  var canvasEl = null;
  var emptyEl = null;
  var customizeBtn = null;
  var addWidgetsBtn = null;
  var doneBtn = null;
  var openPopover = null;

  // Drag stashes — dataTransfer.getData() is unreadable during dragover, so
  // the dragged type/id are stashed module-level at dragstart, cleared at
  // dragend. `_placeholder` is the single green "+" insertion marker.
  var _dragStashId = null;
  var _dragStashType = null;
  var _placeholder = null;

  document.addEventListener("DOMContentLoaded", function () {
    canvasEl     = document.getElementById("dashboard-canvas");
    emptyEl      = document.getElementById("dashboard-empty-state");
    customizeBtn = document.getElementById("dashboard-customize");
    addWidgetsBtn = document.getElementById("dashboard-add-widgets");
    doneBtn      = document.getElementById("dashboard-done");

    if (!canvasEl || !emptyEl || !customizeBtn) return;

    customizeBtn.addEventListener("click", enterEditMode);
    if (addWidgetsBtn) addWidgetsBtn.addEventListener("click", function () { WidgetLibrary.open(handleTapToAdd); });
    if (doneBtn) doneBtn.addEventListener("click", exitEditMode);

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

    // Drop-silently: widget types no longer registered are filtered out of
    // every column; empty columns are dropped. Persist if anything changed.
    var before = JSON.stringify(state.layout.columns);
    state.layout.columns.forEach(function (col) {
      col.widgets = col.widgets.filter(function (w) { return PolarisWidgets.getByType(w.type) != null; });
    });
    state.layout.columns = state.layout.columns.filter(function (col) { return col.widgets.length > 0; });
    if (JSON.stringify(state.layout.columns) !== before) queueSave();

    setHeaderMode();
    renderRoot();
  }

  // Accept a v2 layout as-is, migrate a v1 layout, or fall back to empty.
  function normalizeLayout(data) {
    if (data && data.version === 2 && Array.isArray(data.columns)) return data;
    if (data && data.version === 1 && Array.isArray(data.widgets)) return migrateV1ToV2(data);
    return { version: 2, columns: [] };
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
    return state.layout.columns.reduce(function (n, c) { return n + c.widgets.length; }, 0);
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

  // Choose between the empty-state prompt and the canvas, then render.
  function renderRoot() {
    if (!state.editing && totalWidgets() === 0) { showEmpty(); return; }
    hideEmpty();
    renderCanvas();
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
    state.layout.columns.forEach(function (col, ci) {
      canvasEl.appendChild(mountColumnShell(col, ci));
    });
    if (state.editing) canvasEl.appendChild(buildNewColumnTarget());
    // Mount widget bodies after all shells are in the DOM.
    state.layout.columns.forEach(function (col) { col.widgets.forEach(renderWidget); });
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

  function mountWidgetShell(w) {
    var module = PolarisWidgets.getByType(w.type);
    var label = module ? module.label : (w.type + " (unknown widget)");
    var article = document.createElement("article");
    article.className = "dashboard-widget";
    article.setAttribute("data-id", w.id);
    article.setAttribute("data-type", w.type);
    // Fixed pixel height so widget bodies (charts, Leaflet map) get a sized
    // container; height 1 → 280px, height 2 → 576px (2 rows + the gap).
    article.style.height = (w.height === 2 ? (2 * ROW_HEIGHT_PX + GAP_PX) : ROW_HEIGHT_PX) + "px";

    // In edit mode a dedicated grip is the drag handle — a clear, easy target
    // for dragging the widget to another column (the title alone was too easy
    // to miss). The whole widget can move across columns from here.
    var grip = state.editing ? '<span class="dashboard-widget-grip" draggable="true" title="Drag to move (to any column)">⠿</span>' : "";
    var editControls = state.editing
      ? '<button type="button" class="dashboard-widget-height-toggle" data-action="height" title="Toggle height">' + (w.height === 2 ? "▾" : "▴") + '</button>' +
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
        setWidgetHeight(w.id, w.height === 2 ? 1 : 2);
      });
      article.querySelector('[data-action="remove"]').addEventListener("click", function () { removeWidget(w.id); });
    }
    return article;
  }

  function buildNewColumnTarget() {
    var el = document.createElement("div");
    el.className = "dashboard-newcol-target";
    el.setAttribute("data-newcol", "1");
    el.innerHTML = '<span>+ New column</span>';
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
      summary: state.summary,
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
      dataPromise = module.fetchData ? module.fetchData(w.config || {}, state.summary) : Promise.resolve(null);
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

  async function refetchSummaryIfNeeded() {
    var needsSummary = state.layout.columns.some(function (col) {
      return col.widgets.some(function (w) {
        return ["recentReservations", "assetTypes", "blockUtilization"].indexOf(w.type) !== -1;
      });
    });
    if (!needsSummary) { state.summary = null; return; }
    try {
      state.summary = await api.dashboard.summary();
    } catch (_err) {
      state.summary = null;
    }
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
    for (var ci = 0; ci < state.layout.columns.length; ci++) {
      var idx = state.layout.columns[ci].widgets.findIndex(function (w) { return w.id === id; });
      if (idx !== -1) return { colIndex: ci, idx: idx, widget: state.layout.columns[ci].widgets[idx] };
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
    if (!target || target.newColumn || !state.layout.columns.length) {
      state.layout.columns.push(newColumn(module.defaultSize.width, [inst]));
    } else {
      state.layout.columns[target.columnIndex].widgets.splice(target.insertionIndex, 0, inst);
    }
    hideEmpty();
    refetchSummaryIfNeeded().then(function () { renderRoot(); });
    queueSave();
  }

  function moveWidgetTo(id, target) {
    var src = findWidget(id);
    if (!src || !target) return;
    applyChange(function () {
      state.layout.columns[src.colIndex].widgets.splice(src.idx, 1);
      if (target.newColumn) {
        state.layout.columns.push(newColumn(6, [src.widget]));
      } else {
        var at = target.insertionIndex;
        // Same-column move past the removed slot shifts the index down by one.
        if (target.columnIndex === src.colIndex && src.idx < at) at--;
        state.layout.columns[target.columnIndex].widgets.splice(at, 0, src.widget);
      }
      state.layout.columns = state.layout.columns.filter(function (c) { return c.widgets.length > 0; });
    });
  }

  function removeWidget(id) {
    applyChange(function () {
      state.layout.columns.forEach(function (c) { c.widgets = c.widgets.filter(function (w) { return w.id !== id; }); });
      state.layout.columns = state.layout.columns.filter(function (c) { return c.widgets.length > 0; });
    });
  }

  function removeColumn(colId) {
    applyChange(function () {
      state.layout.columns = state.layout.columns.filter(function (c) { return c.id !== colId; });
    });
  }

  function setColumnWidth(colId, width) {
    var col = state.layout.columns.find(function (c) { return c.id === colId; });
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
  }

  function handleTapToAdd(type) {
    // Click-to-add from the picker: append to the last column, or start one.
    if (state.layout.columns.length) {
      var last = state.layout.columns.length - 1;
      addWidgetAt(type, { columnIndex: last, insertionIndex: state.layout.columns[last].widgets.length });
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
