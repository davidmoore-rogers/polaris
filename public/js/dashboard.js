/**
 * public/js/dashboard.js — Dashboard orchestrator.
 *
 * Owns the layout state (widget list + per-widget positions/sizes/config),
 * mounts each widget module into the 12-col canvas, and handles:
 *   - drag from the +Widget slide-in onto the canvas
 *   - drag within the canvas to reorder (insertion-shift via reflow)
 *   - resize via the bottom-right grip (snaps to width 3/4/6/12 × height 1/2)
 *   - per-widget gear popover with widget-module-supplied config inputs
 *   - debounced PUT /me/dashboard on every state change
 *
 * Layout state shape mirrors the server: { version: 1, widgets: [...] }.
 * Widget order in the array is the canonical placement order; col/row are
 * derived by reflow() on every state change. This keeps the model simple
 * — drag/resize/remove all just rewrite the ordered list and reflow.
 */

(function () {
  var GRID_COLS = 12;
  var ROW_HEIGHT_PX = 280;
  var GAP_PX = 16;
  var SAVE_DEBOUNCE_MS = 800;

  var state = {
    layout: { version: 1, widgets: [] },
    saving: false,
    saveTimer: null,
    summary: null, // cached /dashboard/summary payload (shared by all four built-in widgets)
    unmounts: {},  // widget instance id → cleanup fn
    gridOverlay: null, // overlay DOM during drag/resize
    dropPreview: null, // child of gridOverlay; sized to dragged widget at target slot
  };

  var canvasEl = null;
  var emptyEl = null;
  var addBtnEl = null;
  var openPopover = null;

  document.addEventListener("DOMContentLoaded", function () {
    canvasEl = document.getElementById("dashboard-canvas");
    emptyEl  = document.getElementById("dashboard-empty-state");
    addBtnEl = document.getElementById("dashboard-add-widget");

    if (!canvasEl || !emptyEl || !addBtnEl) return;

    addBtnEl.addEventListener("click", function () {
      WidgetLibrary.open(handleTapToAdd);
    });

    // Wire drag-from-slide-in onto the canvas.
    canvasEl.addEventListener("dragover", onCanvasDragOver);
    canvasEl.addEventListener("dragleave", onCanvasDragLeave);
    canvasEl.addEventListener("drop", onCanvasDrop);

    // Library-card dragstarts happen outside the canvas (in the +Widget
    // slide-in), so we capture them at the document level to stash the type
    // for the drop-preview's default-size lookup. dataTransfer.getData() is
    // unreadable during dragover for security reasons.
    document.addEventListener("dragstart", function (e) {
      var card = e.target && e.target.closest ? e.target.closest(".widget-library-card[data-type]") : null;
      if (card) _dragStashType = card.getAttribute("data-type");
    });
    document.addEventListener("dragend", function (e) {
      if (e.target && e.target.closest && e.target.closest(".widget-library-card")) {
        _dragStashType = null;
        canvasEl.classList.remove("drop-target");
        hideGridOverlay();
      }
    });

    // Close popover on outside-click.
    document.addEventListener("click", function (e) {
      if (!openPopover) return;
      if (openPopover.el.contains(e.target)) return;
      if (e.target.closest && e.target.closest(".dashboard-widget-action[data-action='gear']")) return;
      closePopover();
    });

    bootstrap();
  });

  // ─── Bootstrap ──────────────────────────────────────────────────────────

  async function bootstrap() {
    try {
      var data = await api.me.dashboard.get();
      state.layout = data && data.widgets ? data : { version: 1, widgets: [] };
    } catch (_err) {
      state.layout = { version: 1, widgets: [] };
    }
    if (state.layout.widgets.length === 0) {
      showEmpty();
    } else {
      hideEmpty();
      await refetchSummaryIfNeeded();
      reflow(state.layout.widgets);
      renderCanvas();
    }
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

  // ─── Layout maths ───────────────────────────────────────────────────────

  // Row-major packer. For each widget in order, find the leftmost-topmost
  // free slot that fits its width × height and place it there. Mutates
  // each widget's col/row in place.
  function reflow(widgets) {
    var occupied = {}; // "row,col" → true
    function rowKey(r) { return r; }
    function isFree(r, c, w, h) {
      for (var rr = r; rr < r + h; rr++) {
        for (var cc = c; cc < c + w; cc++) {
          if (cc >= GRID_COLS) return false;
          if (occupied[rr + "," + cc]) return false;
        }
      }
      return true;
    }
    function mark(r, c, w, h) {
      for (var rr = r; rr < r + h; rr++) {
        for (var cc = c; cc < c + w; cc++) {
          occupied[rr + "," + cc] = true;
        }
      }
    }
    widgets.forEach(function (w) {
      // Clamp width to grid.
      if (w.width > GRID_COLS) w.width = GRID_COLS;
      var placed = false;
      for (var r = 0; !placed; r++) {
        for (var c = 0; c <= GRID_COLS - w.width; c++) {
          if (isFree(r, c, w.width, w.height)) {
            w.col = c;
            w.row = r;
            mark(r, c, w.width, w.height);
            placed = true;
            break;
          }
        }
      }
    });
  }

  // Insertion-index from cursor pixel position. Returns the index in the
  // ordered widget array where a new widget should be inserted to land at
  // the cursor's grid cell. Walks widgets in order and finds the first one
  // whose row-major position is *strictly after* the cursor's cell.
  function insertIndexFromCursor(clientX, clientY) {
    var rect = canvasEl.getBoundingClientRect();
    var x = Math.max(0, clientX - rect.left);
    var y = Math.max(0, clientY - rect.top);
    var colWidth = (rect.width - GAP_PX * (GRID_COLS - 1)) / GRID_COLS;
    var col = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(x / (colWidth + GAP_PX))));
    var row = Math.max(0, Math.floor(y / (ROW_HEIGHT_PX + GAP_PX)));
    var widgets = state.layout.widgets;
    for (var i = 0; i < widgets.length; i++) {
      var w = widgets[i];
      // "Strictly after" in row-major terms.
      if (w.row > row || (w.row === row && w.col > col)) return i;
    }
    return widgets.length;
  }

  // ─── State mutations ────────────────────────────────────────────────────

  function applyChange(mutator) {
    mutator();
    reflow(state.layout.widgets);
    renderCanvas();
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

  function addWidget(type, atIndex) {
    var module = PolarisWidgets.getByType(type);
    if (!module) return;
    var instance = {
      id:    PolarisWidgets.uuid(),
      type:  module.type,
      col:   0,
      row:   0,
      width: module.defaultSize.width,
      height: module.defaultSize.height,
      config: Object.assign({}, module.defaultConfig || {}),
    };
    var idx = (atIndex == null || atIndex < 0) ? state.layout.widgets.length : atIndex;
    state.layout.widgets.splice(idx, 0, instance);
    reflow(state.layout.widgets);
    hideEmpty();
    // Refetch the shared summary BEFORE rendering so any built-in widgets
    // (existing or newly added) get fresh data; non-summary widgets fetch
    // their own data inside renderWidget anyway.
    refetchSummaryIfNeeded().then(renderCanvas);
    queueSave();
  }

  function removeWidget(id) {
    applyChange(function () {
      state.layout.widgets = state.layout.widgets.filter(function (w) { return w.id !== id; });
    });
    if (state.layout.widgets.length === 0) showEmpty();
  }

  function moveWidget(id, toIndex) {
    applyChange(function () {
      var widgets = state.layout.widgets;
      var fromIdx = widgets.findIndex(function (w) { return w.id === id; });
      if (fromIdx === -1) return;
      var moved = widgets.splice(fromIdx, 1)[0];
      // After removal, adjust toIndex when the source was before the target.
      var insertAt = toIndex;
      if (fromIdx < toIndex) insertAt = Math.max(0, toIndex - 1);
      widgets.splice(insertAt, 0, moved);
    });
  }

  function resizeWidget(id, width, height) {
    var w = state.layout.widgets.find(function (x) { return x.id === id; });
    if (!w) return;
    if (w.width === width && w.height === height) return;
    applyChange(function () {
      w.width = width;
      w.height = height;
    });
  }

  function updateConfig(id, key, value) {
    var w = state.layout.widgets.find(function (x) { return x.id === id; });
    if (!w) return;
    w.config = Object.assign({}, w.config || {}, { [key]: value });
    queueSave();
    // Re-render that one widget with the new config.
    renderWidget(w);
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  function unmountAll() {
    Object.keys(state.unmounts).forEach(function (id) {
      try { state.unmounts[id](); } catch (_) {}
    });
    state.unmounts = {};
  }

  function renderCanvas() {
    unmountAll();
    canvasEl.innerHTML = "";
    state.layout.widgets.forEach(function (w) {
      var el = mountWidgetShell(w);
      canvasEl.appendChild(el);
      renderWidget(w);
    });
  }

  function mountWidgetShell(w) {
    var module = PolarisWidgets.getByType(w.type);
    // Even unknown widgets get a placeholder so the operator can remove them.
    var label = module ? module.label : (w.type + " (unknown widget)");
    var article = document.createElement("article");
    article.className = "dashboard-widget";
    article.setAttribute("data-id", w.id);
    article.setAttribute("data-type", w.type);
    article.style.gridColumn = (w.col + 1) + " / span " + w.width;
    article.style.gridRow    = (w.row + 1) + " / span " + w.height;

    article.innerHTML =
      '<div class="dashboard-widget-header">' +
        '<div class="dashboard-widget-title" draggable="true">' + escapeHtml(label) + '</div>' +
        '<button type="button" class="dashboard-widget-action" data-action="gear" title="Configure">⚙</button>' +
      '</div>' +
      '<div class="dashboard-widget-body"></div>' +
      '<div class="dashboard-widget-resize" data-action="resize" title="Resize"></div>';

    // Drag this widget to reorder.
    var titleEl = article.querySelector(".dashboard-widget-title");
    titleEl.addEventListener("dragstart", function (e) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/x-polaris-widget-move", w.id);
      e.dataTransfer.setData("text/plain", w.id);
      article.classList.add("dragging");
      _dragStashId = w.id;
      _dragStashType = null;
      canvasEl.classList.add("is-dragging");
      showGridOverlay();
    });
    titleEl.addEventListener("dragend", function () {
      article.classList.remove("dragging");
      _dragStashId = null;
      _dragStashType = null;
      canvasEl.classList.remove("is-dragging");
      canvasEl.classList.remove("drop-target");
      hideGridOverlay();
    });

    article.querySelector('[data-action="gear"]').addEventListener("click", function (ev) {
      ev.stopPropagation();
      openGearPopover(w, ev.currentTarget);
    });

    // Resize handle.
    var resizeEl = article.querySelector('[data-action="resize"]');
    resizeEl.addEventListener("pointerdown", function (ev) { startResize(ev, w, article); });

    return article;
  }

  function renderWidget(w) {
    var article = canvasEl.querySelector('.dashboard-widget[data-id="' + cssEscape(w.id) + '"]');
    if (!article) return;
    var body = article.querySelector(".dashboard-widget-body");
    body.innerHTML = "";

    // Cleanup previous timers etc.
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
    // Only the four built-in widgets read the shared /dashboard/summary
    // payload; others have their own fetchData. If any built-in widget is
    // present we fetch once and share.
    var needsSummary = state.layout.widgets.some(function (w) {
      return ["monitorAlerts", "recentReservations", "assetTypes", "blockUtilization"].indexOf(w.type) !== -1;
    });
    if (!needsSummary) { state.summary = null; return; }
    try {
      state.summary = await api.dashboard.summary();
    } catch (_err) {
      state.summary = null;
    }
  }

  // ─── Drag handlers (canvas) ─────────────────────────────────────────────

  function onCanvasDragOver(ev) {
    var types = ev.dataTransfer ? ev.dataTransfer.types : null;
    if (!types) return;
    var isAdd  = types.indexOf("application/x-polaris-widget") !== -1;
    var isMove = types.indexOf("application/x-polaris-widget-move") !== -1;
    if (!isAdd && !isMove) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = isAdd ? "copy" : "move";
    canvasEl.classList.add("drop-target");
    // dragstart for library cards happens outside this orchestrator's reach,
    // so library-drags don't yet have an overlay — lazily mount one here.
    if (!state.gridOverlay) showGridOverlay();
    var movingId = isMove ? readWidgetIdFromDataTransfer(ev.dataTransfer) : null;
    var moving   = movingId ? state.layout.widgets.find(function (x) { return x.id === movingId; }) : null;
    var size;
    if (moving) {
      size = { width: moving.width, height: moving.height };
    } else if (isAdd) {
      // Library drag — best-guess preview using the type's defaultSize.
      var type = readWidgetIdFromDataTransfer(ev.dataTransfer, "application/x-polaris-widget");
      var mod  = type ? PolarisWidgets.getByType(type) : null;
      size = (mod && mod.defaultSize) || { width: 6, height: 1 };
    } else {
      size = { width: 6, height: 1 };
    }
    updateDropPreviewAt(ev.clientX, ev.clientY, size);
  }

  function onCanvasDragLeave(ev) {
    if (ev.relatedTarget && canvasEl.contains(ev.relatedTarget)) return;
    canvasEl.classList.remove("drop-target");
    // The drop will fire next (and clean up) on a successful drag; the
    // dragend handler on the widget article clears for cancelled drags.
  }

  function onCanvasDrop(ev) {
    canvasEl.classList.remove("drop-target");
    hideGridOverlay();
    var addType  = ev.dataTransfer.getData("application/x-polaris-widget");
    var moveId   = ev.dataTransfer.getData("application/x-polaris-widget-move");
    if (!addType && !moveId) return;
    ev.preventDefault();
    var idx = insertIndexFromCursor(ev.clientX, ev.clientY);
    if (addType) {
      addWidget(addType, idx);
      WidgetLibrary.close();
    } else if (moveId) {
      moveWidget(moveId, idx);
    }
  }

  // dataTransfer.getData() is only readable during the `drop` event — during
  // dragover it's empty for security reasons. We do have `types`, which lists
  // the registered formats, so the moving-widget id has to come from elsewhere.
  // We stash the id on a module-level variable during dragstart and clear on
  // dragend. Library-drag types: same pattern.
  var _dragStashId = null;
  var _dragStashType = null;
  function readWidgetIdFromDataTransfer(_dt, format) {
    if (format === "application/x-polaris-widget") return _dragStashType;
    return _dragStashId;
  }

  // ─── Grid overlay + drop-preview ────────────────────────────────────────

  function showGridOverlay() {
    if (state.gridOverlay) return;
    var rect = canvasEl.getBoundingClientRect();
    var colWidth = (rect.width - GAP_PX * (GRID_COLS - 1)) / GRID_COLS;
    var rowStride = ROW_HEIGHT_PX + GAP_PX;

    var overlay = document.createElement("div");
    overlay.className = "dashboard-grid-overlay";

    // Column cells — one per column, full height. The cell's own border
    // outlines the column's left + right edges.
    for (var c = 0; c < GRID_COLS; c++) {
      var col = document.createElement("div");
      col.className = "dashboard-grid-col";
      col.style.left = (c * (colWidth + GAP_PX)) + "px";
      col.style.width = colWidth + "px";
      overlay.appendChild(col);
    }

    // Horizontal row separators. Draw enough to cover the current canvas
    // height plus one extra row for new-bottom-row drop targets.
    var height = Math.max(rect.height, rowStride * 2);
    var rowCount = Math.ceil(height / rowStride) + 1;
    for (var r = 1; r <= rowCount; r++) {
      var row = document.createElement("div");
      row.className = "dashboard-grid-row";
      // Land the line on the row-boundary gap-center: each row occupies
      // (r-1)*rowStride .. r*rowStride - GAP_PX, then GAP_PX of gap.
      row.style.top = (r * rowStride - GAP_PX - 1) + "px";
      overlay.appendChild(row);
    }

    var preview = document.createElement("div");
    preview.className = "dashboard-drop-preview";
    preview.style.display = "none";
    overlay.appendChild(preview);

    canvasEl.appendChild(overlay);
    state.gridOverlay = overlay;
    state.dropPreview = preview;
  }

  function hideGridOverlay() {
    if (!state.gridOverlay) return;
    try { canvasEl.removeChild(state.gridOverlay); } catch (_) {}
    state.gridOverlay = null;
    state.dropPreview = null;
  }

  function updateDropPreviewAt(clientX, clientY, size) {
    if (!state.dropPreview) return;
    var rect = canvasEl.getBoundingClientRect();
    var x = Math.max(0, clientX - rect.left);
    var y = Math.max(0, clientY - rect.top);
    var colWidth = (rect.width - GAP_PX * (GRID_COLS - 1)) / GRID_COLS;
    var rowStride = ROW_HEIGHT_PX + GAP_PX;
    var w = (size && size.width) || 6;
    var h = (size && size.height) || 1;
    // Snap the cursor to its column; clamp so the preview never overshoots
    // the right edge of the grid.
    var col = Math.max(0, Math.min(GRID_COLS - w, Math.floor(x / (colWidth + GAP_PX))));
    var row = Math.max(0, Math.floor(y / rowStride));
    state.dropPreview.style.display = "block";
    state.dropPreview.style.left   = (col * (colWidth + GAP_PX)) + "px";
    state.dropPreview.style.top    = (row * rowStride) + "px";
    state.dropPreview.style.width  = (w * colWidth + (w - 1) * GAP_PX) + "px";
    state.dropPreview.style.height = (h * ROW_HEIGHT_PX + (h - 1) * GAP_PX) + "px";
  }

  function handleTapToAdd(type) {
    // Tap-to-add fallback (used on small viewports / touch): append at end.
    addWidget(type, state.layout.widgets.length);
  }

  // ─── Resize ─────────────────────────────────────────────────────────────

  function startResize(ev, w, article) {
    ev.preventDefault();
    var rect = article.getBoundingClientRect();
    var canvasRect = canvasEl.getBoundingClientRect();
    var colWidth = (canvasRect.width - GAP_PX * (GRID_COLS - 1)) / GRID_COLS;
    var startW = w.width;
    var startH = w.height;
    var widthSteps = [3, 4, 6, 12];
    var heightSteps = [1, 2];
    canvasEl.classList.add("is-resizing");
    showGridOverlay();

    function pickClosest(target, steps) {
      var best = steps[0], bestDist = Infinity;
      steps.forEach(function (s) {
        var d = Math.abs(target - s);
        if (d < bestDist) { bestDist = d; best = s; }
      });
      return best;
    }

    function onMove(mv) {
      var newPxW = mv.clientX - rect.left;
      var newPxH = mv.clientY - rect.top;
      var newColW = (newPxW + GAP_PX) / (colWidth + GAP_PX);
      var newRowH = (newPxH + GAP_PX) / (ROW_HEIGHT_PX + GAP_PX);
      var targetW = pickClosest(newColW, widthSteps);
      var targetH = pickClosest(newRowH, heightSteps);
      var module = PolarisWidgets.getByType(w.type);
      var minW = (module && module.minSize && module.minSize.width) || 3;
      var minH = (module && module.minSize && module.minSize.height) || 1;
      if (targetW < minW) targetW = minW;
      if (targetH < minH) targetH = minH;
      // Live-preview without committing reflow.
      article.style.gridColumn = (w.col + 1) + " / span " + targetW;
      article.style.gridRow    = (w.row + 1) + " / span " + targetH;
      article.setAttribute("data-preview-w", targetW);
      article.setAttribute("data-preview-h", targetH);
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      canvasEl.classList.remove("is-resizing");
      hideGridOverlay();
      var finalW = parseInt(article.getAttribute("data-preview-w") || startW, 10);
      var finalH = parseInt(article.getAttribute("data-preview-h") || startH, 10);
      article.removeAttribute("data-preview-w");
      article.removeAttribute("data-preview-h");
      resizeWidget(w.id, finalW, finalH);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
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
        module.renderConfig(fieldsEl, w.config || {}, function (key, value) {
          updateConfig(w.id, key, value);
        });
      } catch (err) {
        fieldsEl.innerHTML = '<p class="empty-state">Config failed to render.</p>';
      }
    } else {
      fieldsEl.innerHTML = '<p style="font-size:0.82rem;color:var(--color-text-secondary)">This widget has no configurable options.</p>';
    }
    pop.querySelector('[data-action="remove"]').addEventListener("click", function () {
      closePopover();
      removeWidget(w.id);
    });
    pop.querySelector('[data-action="close"]').addEventListener("click", closePopover);

    // Position next to the gear icon — prefer to the left of the gear so the
    // popover hangs into the widget area; fall back to the right when the
    // widget hugs the left edge of the viewport.
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

  // CSS.escape polyfill — old browsers + safe escape for our use case.
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return "\\" + c; });
  }
})();
