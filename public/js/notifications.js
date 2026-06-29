/**
 * public/js/notifications.js — Notifications page (View + Manage tabs).
 *
 * View tab: server-side TableSF list of triggered notifications with multiselect
 * acknowledge/clear (acknowledge gated notifications:write, clear gated
 * notifications:fullwrite) + an optional-note acknowledge modal. Manage tab
 * (gated notificationManagement): rule list + a schema-driven rule builder with
 * a live Test (preview). Mirrors the server-side table pattern in events.js.
 */

var _notifPageSize = 15;
var _notifSF = null;
var _notifLayout = null;
var _rulesSF = null;
var _rulesLayout = null;
var _ruleSchema = null;
var _ruleTagList = null;  // cached distinct asset tags for the scope picker

(function () {
  // Permissions resolve asynchronously via /auth/me (userReady). Computing
  // them at script-load time reads an empty matrix and wrongly hides the
  // Manage tab / action buttons — so they're (re)applied after userReady.
  var canAck = false;
  var canClear = false;
  var canManage = false;
  var canEditRules = false;

  function applyPermGatedUI() {
    canAck = permAtLeast("notifications", "write");
    canClear = permAtLeast("notifications", "fullwrite");
    canManage = permAtLeast("notificationManagement", "read");
    canEditRules = permAtLeast("notificationManagement", "fullwrite");

    var mb = document.getElementById("notif-tab-manage-btn");
    if (mb) mb.style.display = canManage ? "" : "none";
    var nr = document.getElementById("btn-new-rule");
    if (nr) {
      var activeTab = document.querySelector("#notif-tabs .page-tab.active");
      var onManage = activeTab && activeTab.getAttribute("data-tab") === "manage";
      nr.style.display = canEditRules && onManage ? "" : "none";
      if (canEditRules && !nr._wired) { nr._wired = true; nr.addEventListener("click", function () { openRuleBuilder(null); }); }
    }
    var ackBtn = document.getElementById("notif-bulk-ack");
    if (ackBtn) {
      ackBtn.style.display = canAck ? "" : "none";
      if (canAck && !ackBtn._wired) { ackBtn._wired = true; ackBtn.addEventListener("click", function () { openAckModal(Array.from(selected)); }); }
    }
    var clrBtn = document.getElementById("notif-bulk-clear");
    if (clrBtn && canClear) {
      clrBtn.style.display = "";
      if (!clrBtn._wired) { clrBtn._wired = true; clrBtn.addEventListener("click", doBulkClear); }
    }
  }

  // ─── Web push enable/disable (any viewer; gated only by browser support
  //     + server-side Web Push config) ─────────────────────────────────────
  function setupPushButton() {
    var btn = document.getElementById("btn-enable-push");
    if (!btn || !window.polarisPush) return;
    if (!polarisPush.isSupported()) { btn.style.display = "none"; return; }

    function paint(st) {
      if (!st.enabledOnServer) {
        // Server hasn't configured Web Push — keep the control hidden rather
        // than offer a button that can only error.
        btn.style.display = "none";
        return;
      }
      btn.style.display = "";
      btn.textContent = st.subscribed ? "Disable push" : "Enable push";
      btn.disabled = false;
    }

    polarisPush.status().then(paint).catch(function () { btn.style.display = "none"; });

    if (!btn._wired) {
      btn._wired = true;
      btn.addEventListener("click", async function () {
        btn.disabled = true;
        try {
          var st = await polarisPush.status();
          if (st.subscribed) { await polarisPush.disable(); showToast("Push notifications disabled", "info"); }
          else { await polarisPush.enable(); showToast("Push notifications enabled", "success"); }
        } catch (err) {
          showToast(err.message || "Push action failed", "error");
        }
        polarisPush.status().then(paint).catch(function () {});
      });
    }
  }

  // ─── Tabs ──────────────────────────────────────────────────────────────
  document.querySelectorAll("#notif-tabs .page-tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.getAttribute("data-tab");
      document.querySelectorAll("#notif-tabs .page-tab").forEach(function (b) { b.classList.remove("active"); });
      document.querySelectorAll('[id^="notif-tab-"]').forEach(function (p) { if (p.classList.contains("page-tab-panel")) p.classList.remove("active"); });
      btn.classList.add("active");
      var panel = document.getElementById("notif-tab-" + key);
      if (panel) panel.classList.add("active");
      // The "New rule" button only belongs on the Manage tab.
      var nrBtn = document.getElementById("btn-new-rule");
      if (nrBtn && canEditRules) nrBtn.style.display = key === "manage" ? "" : "none";
      if (key === "manage" && !_rulesSF) initRulesTab();
    });
  });

  document.getElementById("btn-refresh").addEventListener("click", function () {
    var active = document.querySelector("#notif-tabs .page-tab.active");
    if (active && active.getAttribute("data-tab") === "manage") loadRules();
    else loadNotifications();
  });

  // ═══════════════════════════════ View tab ═══════════════════════════════
  var pageSize = _notifPageSize;
  var offset = 0;
  var total = 0;
  var rows = [];
  var selected = new Set();

  function savePrefs() {
    if (!currentUsername) return;
    try {
      localStorage.setItem("polaris-prefs-notifications-" + currentUsername, JSON.stringify({
        pageSize: pageSize,
        layout: _notifLayout ? _notifLayout.getPrefs() : null,
        filters: _notifSF ? _notifSF._filters : null,
        sort: _notifSF ? { key: _notifSF._sortKey, dir: _notifSF._sortDir } : null,
      }));
    } catch (_) {}
  }
  function restorePrefs() {
    if (!currentUsername) return;
    var raw;
    try { raw = localStorage.getItem("polaris-prefs-notifications-" + currentUsername); } catch (_) { return; }
    if (!raw) return;
    try {
      var p = JSON.parse(raw);
      if (p.pageSize) { pageSize = p.pageSize; _notifPageSize = p.pageSize; var ps = document.getElementById("filter-pagesize"); if (ps) ps.value = String(p.pageSize); }
      if (_notifLayout && p.layout) _notifLayout.setPrefs(p.layout);
      if (_notifSF) {
        if (p.filters && typeof p.filters === "object") _notifSF._filters = p.filters;
        if (p.sort && typeof p.sort === "object") {
          if (p.sort.key) _notifSF._sortKey = p.sort.key;
          if (p.sort.dir === "asc" || p.sort.dir === "desc") _notifSF._sortDir = p.sort.dir;
        }
        _notifSF.restoreFilterUI();
        _notifSF._updateIcons();
      }
    } catch (_) {}
  }

  // NOTE: setupColumnLayout must run AFTER `new TableSF` below — TableSF
  // rewrites each th's innerHTML (sort/filter UI), which would wipe the resize
  // handles setupColumnLayout appends. Canonical order is TableSF first (see
  // assets.js). The call lives just after the TableSF construction.

  function buildQuery() {
    var f = _notifSF ? _notifSF._filters || {} : {};
    var params = { limit: pageSize, offset: offset };
    if (Array.isArray(f.severity) && f.severity.length) params.severity = f.severity.join(",");
    if (typeof f.message === "string" && f.message.trim()) params.search = f.message.trim();
    else if (f.message && typeof f.message === "object" && f.message.q) params.search = String(f.message.q).trim();
    if (typeof f.assetHostname === "string" && f.assetHostname.trim()) params.search = f.assetHostname.trim();
    if (Array.isArray(f.regions) && f.regions.length) params.region = f.regions.join(",");
    if (_notifSF && _notifSF._sortKey && _notifSF._sortKey !== "regions") {
      params.sortBy = _notifSF._sortKey;
      params.sortDir = _notifSF._sortDir === "asc" ? "asc" : "desc";
    }
    return params;
  }

  function loadNotifications() {
    api.notifications.list(buildQuery()).then(function (data) {
      rows = data.notifications || [];
      total = data.total || 0;
      renderTable();
      renderPagination();
    }).catch(function () {
      document.getElementById("notif-tbody").innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load notifications</td></tr>';
    });
  }
  window._reloadNotifications = loadNotifications;

  function renderTable() {
    var tbody = document.getElementById("notif-tbody");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No notifications</td></tr>';
      updateBulkBar();
      updateSelectAll();
      return;
    }
    tbody.innerHTML = rows.map(function (n) {
      var ts = new Date(n.triggeredAt);
      var timeStr = ts.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
        ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      var sev = (n.severity || "info");
      var checked = selected.has(n.id) ? " checked" : "";
      var regions = (n.regionTags || []).map(escapeHtml).join(", ");
      // Asset name links to the canonical asset-details slide-in when the
      // notification is tied to an asset; plain text otherwise.
      var assetCell = n.assetId
        ? '<a href="#" class="asset-name-link" data-asset-id="' + escapeHtml(n.assetId) + '">' + escapeHtml(n.assetHostname || n.assetId) + '</a>'
        : escapeHtml(n.assetHostname || "-");
      var ackCell = "";
      if (n.acknowledged) {
        var ackTs = n.acknowledgedAt ? new Date(n.acknowledgedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
        var label = escapeHtml(n.acknowledgedBy || "?") + (ackTs ? " · " + escapeHtml(ackTs) : "");
        if (n.acknowledgeNote && n.acknowledgeNote.trim()) {
          ackCell = '<a href="#" class="ack-view" data-id="' + n.id + '" title="Read note">' + label + ' &#128221;</a>';
        } else {
          ackCell = '<span style="color:var(--color-text-tertiary)">' + label + '</span>';
        }
      }
      return '<tr>' +
        '<td class="cb-col"><input type="checkbox" class="row-cb" data-id="' + n.id + '"' + checked + '></td>' +
        '<td style="font-family:var(--font-mono);font-size:0.82rem;white-space:nowrap">' + escapeHtml(timeStr) + '</td>' +
        '<td><span class="badge badge-level-' + sev + '">' + sev.toUpperCase() + '</span></td>' +
        '<td>' + assetCell + '</td>' +
        '<td>' + (regions || '<span style="color:var(--color-text-tertiary)">-</span>') + '</td>' +
        '<td>' + escapeHtml(n.message || "") + '</td>' +
        '<td>' + ackCell + '</td>' +
        '</tr>';
    }).join("");

    tbody.querySelectorAll(".row-cb").forEach(function (cb) {
      cb.addEventListener("change", function () {
        if (this.checked) selected.add(this.dataset.id); else selected.delete(this.dataset.id);
        updateBulkBar(); updateSelectAll();
      });
    });
    tbody.querySelectorAll(".ack-view").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var n = rows.find(function (r) { return r.id === a.dataset.id; });
        if (n) openAckReadModal(n);
      });
    });
    tbody.querySelectorAll(".asset-name-link").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        if (typeof openViewModal === "function") openViewModal(a.getAttribute("data-asset-id"));
      });
    });
    updateBulkBar(); updateSelectAll();
  }

  function updateSelectAll() {
    var all = document.querySelectorAll("#notif-tbody .row-cb");
    var checkedN = Array.prototype.filter.call(all, function (c) { return c.checked; }).length;
    var sa = document.getElementById("notif-select-all");
    if (sa) { sa.checked = all.length > 0 && checkedN === all.length; sa.indeterminate = checkedN > 0 && checkedN < all.length; }
  }
  // The action bar is always visible; its buttons are disabled until rows are
  // selected (perm-gated visibility is handled in applyPermGatedUI).
  function updateBulkBar() {
    var n = selected.size;
    var bar = document.getElementById("notif-bulk-bar");
    var countEl = bar && bar.querySelector(".bulk-bar-count");
    if (countEl) countEl.textContent = n === 0 ? "No notifications selected" : (n + " selected");
    // Accent border only once something is selected.
    if (bar) bar.classList.toggle("bulk-bar-idle", n === 0);
    ["notif-bulk-ack", "notif-bulk-clear", "notif-bulk-deselect"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.disabled = n === 0;
    });
  }

  document.getElementById("notif-select-all").addEventListener("change", function () {
    var on = this.checked;
    document.querySelectorAll("#notif-tbody .row-cb").forEach(function (cb) {
      cb.checked = on;
      if (on) selected.add(cb.dataset.id); else selected.delete(cb.dataset.id);
    });
    updateBulkBar();
  });
  function deselectAll() {
    selected.clear();
    document.querySelectorAll("#notif-tbody .row-cb").forEach(function (cb) { cb.checked = false; });
    updateBulkBar(); updateSelectAll();
  }
  document.getElementById("notif-bulk-deselect").addEventListener("click", deselectAll);

  // Escape clears the current selection — but only when nothing else owns
  // Escape (an open modal / asset slide-in closes first) and there's actually
  // a selection to clear, so Escape still falls through normally otherwise.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (selected.size === 0) return;
    if (document.querySelector(".modal-overlay.open") || document.querySelector(".slideover-overlay.open")) return;
    deselectAll();
  });

  // Acknowledge / Clear button visibility + wiring is applied in
  // applyPermGatedUI() (after userReady) since permissions load async.
  async function doBulkClear() {
    var ids = Array.from(selected);
    if (!ids.length) return;
    var ok = await showConfirm("Clear " + ids.length + " notification" + (ids.length === 1 ? "" : "s") + "? Cleared notifications are removed from the list.");
    if (!ok) return;
    try {
      await api.notifications.clear(ids);
      showToast("Cleared " + ids.length, "success");
      selected.clear();
      loadNotifications();
    } catch (err) { showToast(err.message || "Clear failed", "error"); }
  }

  function openAckModal(ids) {
    if (!ids.length) return;
    var body = '<div class="form-group"><label>Note (optional)</label>' +
      '<textarea id="ack-note" rows="3" style="width:100%" placeholder="Optional note about ' + ids.length + ' notification' + (ids.length === 1 ? "" : "s") + '..."></textarea></div>' +
      '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0">Acknowledging ' + ids.length + ' notification' + (ids.length === 1 ? "" : "s") + '. The note (if any) applies to all selected.</p>';
    var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="ack-confirm">Acknowledge</button>';
    openModal("Acknowledge notifications", body, footer);
    document.getElementById("ack-confirm").addEventListener("click", async function () {
      this.disabled = true;
      try {
        var note = (document.getElementById("ack-note").value || "").trim();
        await api.notifications.acknowledge(ids, note || undefined);
        closeModal();
        showToast("Acknowledged " + ids.length, "success");
        selected.clear();
        loadNotifications();
      } catch (err) { this.disabled = false; showToast(err.message || "Acknowledge failed", "error"); }
    });
  }

  function openAckReadModal(n) {
    var ackTs = n.acknowledgedAt ? new Date(n.acknowledgedAt).toLocaleString() : "";
    var body = '<div class="form-group"><label>Notification</label>' +
      '<p style="margin:0;padding:0.5rem;background:var(--color-bg-secondary);border-radius:4px">' + escapeHtml(n.message || "") + '</p></div>' +
      '<div class="form-group"><label>Acknowledged by</label><p style="margin:0">' + escapeHtml(n.acknowledgedBy || "?") + (ackTs ? " · " + escapeHtml(ackTs) : "") + '</p></div>' +
      '<div class="form-group"><label>Note</label><p style="margin:0;white-space:pre-wrap">' + escapeHtml(n.acknowledgeNote || "(none)") + '</p></div>';
    openModal("Acknowledgement", body, '<button class="btn btn-secondary" onclick="closeModal()">Close</button>');
  }

  function renderPagination() {
    var containers = [];
    var mainEl = document.getElementById("pagination");
    var topEl = document.getElementById("pagination-top");
    if (mainEl) containers.push(mainEl);
    if (topEl) containers.push(topEl);
    var totalPages = Math.max(1, Math.ceil(total / pageSize));
    var currentPage = Math.floor(offset / pageSize) + 1;
    var html =
      '<button class="btn btn-secondary btn-sm page-prev" ' + (currentPage <= 1 ? "disabled" : "") + '>&laquo; Prev</button>' +
      '<span style="font-size:0.82rem;color:var(--color-text-tertiary)">Page ' + currentPage + ' / ' + totalPages + '</span>' +
      '<button class="btn btn-secondary btn-sm page-next" ' + (currentPage >= totalPages ? "disabled" : "") + '>Next &raquo;</button>' +
      '<span style="font-size:0.82rem;color:var(--color-text-tertiary);margin-left:8px">' + total + ' notifications</span>';
    containers.forEach(function (c) {
      c.innerHTML = html;
      c.querySelector(".page-prev").addEventListener("click", function () { if (offset >= pageSize) { offset -= pageSize; loadNotifications(); } });
      c.querySelector(".page-next").addEventListener("click", function () { if (offset + pageSize < total) { offset += pageSize; loadNotifications(); } });
    });
  }

  _notifSF = new TableSF("notif-tbody", function () { offset = 0; loadNotifications(); savePrefs(); });
  // setupColumnLayout AFTER TableSF so its resize handles aren't wiped by
  // TableSF's per-th innerHTML rewrite (see note above).
  var notifTable = document.querySelector("#notif-tbody").closest("table");
  _notifLayout = setupColumnLayout(notifTable, { onChange: savePrefs });

  document.getElementById("filter-pagesize").addEventListener("change", function () {
    pageSize = parseInt(this.value, 10) || 15; _notifPageSize = pageSize; offset = 0; loadNotifications(); savePrefs();
  });

  var prefsReady = (typeof userReady !== "undefined" && userReady && userReady.then)
    ? userReady.then(restorePrefs) : (restorePrefs(), Promise.resolve());
  prefsReady.then(loadNotifications);

  // Apply permission-gated UI (Manage tab, New rule, Acknowledge/Clear) once
  // /auth/me has populated the permission matrix.
  if (typeof userReady !== "undefined" && userReady && userReady.then) {
    userReady.then(applyPermGatedUI);
  } else {
    applyPermGatedUI();
  }
  setupPushButton();

  // ═══════════════════════════════ Manage tab ═════════════════════════════
  function initRulesTab() {
    var rulesTable = document.querySelector("#rules-tbody").closest("table");
    // TableSF first, then setupColumnLayout (so resize handles survive — TableSF
    // rewrites th innerHTML).
    _rulesSF = new TableSF("rules-tbody", function () { renderRules(); });
    _rulesLayout = setupColumnLayout(rulesTable, { onChange: function () {} });
    loadRules();
  }

  var _rules = [];
  function loadRules() {
    if (!canManage) return;
    api.notificationRules.list().then(function (data) {
      _rules = data.rules || [];
      renderRules();
    }).catch(function () {
      document.getElementById("rules-tbody").innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load rules</td></tr>';
    });
  }
  window._reloadRules = loadRules;

  // Build a full rule-input body from a loaded rule record, applying overrides.
  // The PUT /notification-rules/:id route validates the complete ruleInputSchema,
  // so the inline enable/disable toggle must resend every field.
  function _ruleToInput(r, overrides) {
    return Object.assign({
      name: r.name,
      description: r.description != null ? r.description : null,
      enabled: r.enabled,
      severity: r.severity,
      trigger: r.trigger,
      scope: r.scope || {},
      clearBehavior: r.clearBehavior,
      clearAfterSec: r.clearAfterSec != null ? r.clearAfterSec : null,
      cooldownSec: r.cooldownSec != null ? r.cooldownSec : null,
      messageTemplate: r.messageTemplate != null ? r.messageTemplate : null,
      channels: r.channels || ["in_app"],
      targets: Array.isArray(r.targets) ? r.targets : [],
    }, overrides || {});
  }

  function scopeSummary(scope) {
    if (!scope || typeof scope !== "object") return "-";
    if (scope.allAssets) return "All assets";
    var parts = [];
    if (scope.assetTypes && scope.assetTypes.length) parts.push("types: " + scope.assetTypes.join("/"));
    if (scope.tags && scope.tags.length) parts.push("tags: " + scope.tags.join("/"));
    if (scope.assetIds && scope.assetIds.length) parts.push(scope.assetIds.length + " asset(s)");
    if (scope.integrationIds && scope.integrationIds.length) parts.push(scope.integrationIds.length + " integration(s)");
    return parts.length ? parts.join("; ") : "n/a";
  }

  function renderRules() {
    var tbody = document.getElementById("rules-tbody");
    var data = _rules.map(function (r) {
      return Object.assign({}, r, {
        triggerType: r.trigger && r.trigger.type ? r.trigger.type : "",
        scopeSummary: scopeSummary(r.scope),
      });
    });
    if (_rulesSF) data = _rulesSF.apply(data);
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No notification rules yet' + (canEditRules ? ' — click "+ New rule" to create one.' : "") + '</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(function (r) {
      var actions = "";
      if (canEditRules) {
        actions = '<button class="btn btn-sm btn-secondary rule-edit" data-id="' + r.id + '">Edit</button> ' +
          '<button class="btn btn-sm btn-secondary rule-del" data-id="' + r.id + '">Delete</button>';
      }
      // Enabled toggle — interactive switch for rule editors; static label otherwise.
      var enabledCell = canEditRules
        ? '<label class="toggle-switch" title="' + (r.enabled ? "Enabled — click to disable" : "Disabled — click to enable") + '">' +
            '<input type="checkbox" class="rule-enabled-toggle" data-id="' + r.id + '"' + (r.enabled ? " checked" : "") + '>' +
            '<span class="toggle-slider"></span>' +
          '</label>'
        : (r.enabled ? "Yes" : '<span style="color:var(--color-text-tertiary)">No</span>');
      return '<tr>' +
        '<td>' + escapeHtml(r.name) + '</td>' +
        '<td><span class="badge">' + escapeHtml(r.triggerType) + '</span></td>' +
        '<td><span class="badge badge-level-' + (r.severity || "info") + '">' + (r.severity || "info").toUpperCase() + '</span></td>' +
        '<td>' + enabledCell + '</td>' +
        '<td style="font-size:0.85rem">' + escapeHtml(r.scopeSummary) + '</td>' +
        '<td>' + escapeHtml(r.createdBy || "-") + '</td>' +
        '<td>' + actions + '</td>' +
        '</tr>';
    }).join("");
    tbody.querySelectorAll(".rule-enabled-toggle").forEach(function (cb) {
      cb.addEventListener("change", async function () {
        var r = _rules.find(function (x) { return x.id === cb.dataset.id; });
        if (!r) return;
        var desired = cb.checked;
        cb.disabled = true;
        try {
          await api.notificationRules.update(r.id, _ruleToInput(r, { enabled: desired }));
          r.enabled = desired;
          showToast("Rule " + (desired ? "enabled" : "disabled"), "success");
          loadRules();
        } catch (err) {
          cb.checked = !desired;
          cb.disabled = false;
          showToast(err.message || "Update failed", "error");
        }
      });
    });
    tbody.querySelectorAll(".rule-edit").forEach(function (b) {
      b.addEventListener("click", function () { var r = _rules.find(function (x) { return x.id === b.dataset.id; }); if (r) openRuleBuilder(r); });
    });
    tbody.querySelectorAll(".rule-del").forEach(function (b) {
      b.addEventListener("click", async function () {
        var r = _rules.find(function (x) { return x.id === b.dataset.id; });
        if (!r) return;
        var ok = await showConfirm('Delete rule "' + r.name + '"? Its firing state is dropped; existing notifications are kept.');
        if (!ok) return;
        try { await api.notificationRules.delete(r.id); showToast("Rule deleted", "success"); loadRules(); }
        catch (err) { showToast(err.message || "Delete failed", "error"); }
      });
    });
  }

  // expose for the builder (defined at module scope below)
  window._notifLoadRules = loadRules;
  window._notifGetSchema = function () { return _ruleSchema; };
})();

// ─── Rule builder (module-scope so it can be opened from the page) ──────────

async function openRuleBuilder(existing) {
  if (!_ruleSchema) {
    try { _ruleSchema = await api.notificationRules.schema(); }
    catch (err) { showToast("Failed to load rule schema", "error"); return; }
  }
  if (_ruleTagList === null) {
    try { var _td = await api.assets.tags(); _ruleTagList = (_td && _td.tags) || []; }
    catch (_e) { _ruleTagList = []; }
  }
  var s = _ruleSchema;
  var r = existing || {};
  var trig = r.trigger || { type: "asset_metric" };
  var scope = r.scope || {};

  function opt(list, sel) {
    return list.map(function (v) { return '<option value="' + escapeHtml(v) + '"' + (v === sel ? " selected" : "") + '>' + escapeHtml(v) + '</option>'; }).join("");
  }
  function triggerTypeOptions() {
    return s.triggerTypes.map(function (t) {
      return '<option value="' + t.type + '"' + (t.type === trig.type ? " selected" : "") + '>' + escapeHtml(t.label) + '</option>';
    }).join("");
  }

  var body =
    '<div class="form-group"><label>Name</label><input type="text" id="rule-name" value="' + escapeHtml(r.name || "") + '"></div>' +
    '<div class="form-group"><label>Description</label><input type="text" id="rule-desc" value="' + escapeHtml(r.description || "") + '"></div>' +
    '<div class="form-group"><label>Severity</label><select id="rule-severity">' + opt(s.severities, r.severity || "warning") + '</select></div>' +
    '<div class="form-group"><label>Trigger type</label><select id="rule-trigger-type">' + triggerTypeOptions() + '</select></div>' +
    '<div id="rule-trigger-fields" style="border:1px solid var(--color-border);border-radius:6px;padding:0.75rem;margin-bottom:0.75rem"></div>' +
    '<div id="rule-scope-fields"></div>' +
    '<div class="form-group"><label>Clear behavior</label><select id="rule-clear">' + opt(s.clearBehaviors, r.clearBehavior || "manual") + '</select></div>' +
    '<div class="form-group" id="rule-clearafter-wrap" style="display:none"><label>Auto-clear after (seconds)</label><input type="number" id="rule-clearafter" value="' + (r.clearAfterSec || 3600) + '"></div>' +
    '<div class="form-group"><label>Re-notify cooldown (seconds, optional)</label><input type="number" id="rule-cooldown" value="' + (r.cooldownSec != null ? r.cooldownSec : "") + '" placeholder="0 = suppress while firing"></div>' +
    '<div class="form-group"><label>Message template (optional)</label><input type="text" id="rule-msg" value="' + escapeHtml(r.messageTemplate || "") + '" placeholder="{asset} {metric} = {value} (threshold {threshold})"></div>' +
    '<div class="form-group"><label><input type="checkbox" id="rule-enabled"' + (r.enabled === false ? "" : " checked") + '> Enabled</label></div>' +
    '<div class="form-group"><label>Notify (delivery targets)</label>' +
      '<div id="rule-targets"></div>' +
      '<button type="button" class="btn btn-sm btn-secondary" id="rule-add-target" style="margin-top:6px">+ Add target</button>' +
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:6px">In-app delivery is always on. Email targets need SMTP or Microsoft 365 configured in Server Settings → Notifications; web push needs Web Push configured and recipients who have enabled push on their device. Tag-routed email only reaches matched users who have an email address set.</p>' +
    '</div>' +
    '<div id="rule-preview" style="margin-top:0.5rem"></div>';

  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-secondary" id="rule-test">Test</button>' +
    '<button class="btn btn-primary" id="rule-save">' + (existing ? "Save changes" : "Create rule") + '</button>';

  openModal(existing ? "Edit notification rule" : "New notification rule", body, footer, { wide: true });

  var typeSel = document.getElementById("rule-trigger-type");
  var clearSel = document.getElementById("rule-clear");
  function renderClearAfter() { document.getElementById("rule-clearafter-wrap").style.display = clearSel.value === "timed" ? "" : "none"; }
  clearSel.addEventListener("change", renderClearAfter);
  renderClearAfter();

  function findType(t) { return s.triggerTypes.find(function (x) { return x.type === t; }); }
  // Label helpers driven by the schema's display metadata.
  function optLabeled(list, sel, labelFor) {
    return (list || []).map(function (v) {
      return '<option value="' + escapeHtml(v) + '"' + (v === sel ? " selected" : "") + '>' + escapeHtml(labelFor ? labelFor(v) : v) + '</option>';
    }).join("");
  }
  var metricLabel = function (m) { var x = s.metricMeta && s.metricMeta[m]; return x ? x.label : m; };
  var metricUnit = function (m) { var x = s.metricMeta && s.metricMeta[m]; return (x && x.unit) || ""; };
  var fieldLabel = function (f) { var x = s.fieldMeta && s.fieldMeta[f]; return x ? x.label : f; };
  var changeLabel = function (c) { return (s.changeTypeMeta && s.changeTypeMeta[c]) || c; };
  var DIM_PLACEHOLDER = { ifNamePattern: "interface name contains", sensorClass: "sensor class (temperature / fan / voltage / power / disk)", mountPathPattern: "mount path contains", healthCheck: "SD-WAN health-check name", link: "WAN member / link name", tunnelName: "IPsec tunnel name", widgetId: "custom widget id" };

  function renderTriggerFields() {
    var t = typeSel.value;
    var def = findType(t);
    var box = document.getElementById("rule-trigger-fields");
    var scopeBox = document.getElementById("rule-scope-fields");
    var cur = (existing && trig.type === t) ? trig : {};
    var html = "";
    if (t === "asset_metric" || t === "host_metric") {
      html += '<div class="form-group"><label>Metric</label><select id="tf-metric">' + optLabeled(def.metrics || [], cur.metric, metricLabel) + '</select></div>';
      html += '<div class="form-group"><label>Aggregation</label><select id="tf-agg">' + opt(s.aggregations, cur.aggregation || "latest") + '</select> over <input type="number" id="tf-window" value="' + (cur.windowSec || 0) + '" style="width:90px"> sec (0 = latest)</div>';
      html += '<div class="form-group"><label>Condition</label><select id="tf-op">' + opt(s.comparators, cur.operator || ">") + '</select> <input type="number" step="any" id="tf-threshold" value="' + (cur.threshold != null ? cur.threshold : "") + '" placeholder="threshold"> <span id="tf-unit" style="color:var(--color-text-tertiary);font-size:0.85rem"></span></div>';
      html += '<div class="form-group"><label>Sustained for (minutes)</label><input type="number" id="tf-duration-min" min="0" value="' + Math.round((cur.forDurationSec || 0) / 60) + '" placeholder="0 = fire immediately"></div>';
      if (t === "asset_metric") html += '<div id="tf-dims"></div>';
    } else if (t === "asset_state") {
      html += '<div class="form-group"><label>Field</label><select id="tf-field">' + optLabeled(def.fields || [], cur.field, fieldLabel) + '</select></div>';
      html += '<div class="form-group"><label>Condition</label><select id="tf-op">' + opt(s.comparators, cur.operator || "==") + '</select> <span id="tf-value-wrap"></span></div>';
      html += '<div class="form-group"><label>Sustained for (minutes)</label><input type="number" id="tf-duration-min" min="0" value="' + Math.round((cur.forDurationSec || 0) / 60) + '"></div>';
    } else if (t === "event") {
      html += '<div class="form-group"><label>Action pattern (glob)</label><input type="text" id="tf-action" value="' + escapeHtml(cur.actionPattern || "") + '" placeholder="e.g. monitor.status_changed or integration.test.*"></div>';
      html += '<div class="form-group"><label>Resource type (optional)</label><input type="text" id="tf-restype" value="' + escapeHtml(cur.resourceType || "") + '" placeholder="e.g. asset / integration"></div>';
      html += '<div class="form-group"><label>Minimum level (optional)</label><select id="tf-minlevel"><option value="">(any)</option>' + opt(s.severities, cur.minLevel || "") + '</select></div>';
    } else if (t === "change") {
      html += '<div class="form-group"><label>Change type</label><select id="tf-changetype">' + optLabeled(def.changeTypes || [], cur.changeType, changeLabel) + '</select></div>';
    }
    box.innerHTML = html;

    // Metric trigger: keep the unit hint + contextual dimension filters in sync.
    if (t === "asset_metric" || t === "host_metric") {
      var renderMetricExtras = function () {
        var m = document.getElementById("tf-metric").value;
        var unitEl = document.getElementById("tf-unit"); if (unitEl) unitEl.textContent = metricUnit(m) || "";
        var dimsBox = document.getElementById("tf-dims");
        if (dimsBox) {
          var dims = (s.metricDimensions && s.metricDimensions[m]) || [];
          var df = cur.dimensionFilter || {};
          var rows = dims.map(function (d) {
            return '<input type="text" data-dim="' + d + '" placeholder="' + escapeHtml(DIM_PLACEHOLDER[d] || d) + '" value="' + escapeHtml(df[d] || "") + '" style="margin-bottom:4px;display:block;width:100%">';
          }).join("");
          dimsBox.innerHTML = rows ? '<div class="form-group"><label>Dimension filter (optional)</label>' + rows + '</div>' : "";
        }
      };
      document.getElementById("tf-metric").addEventListener("change", renderMetricExtras);
      renderMetricExtras();
    }

    // Asset-state: value control depends on the field type.
    if (t === "asset_state") {
      var renderStateValue = function () {
        var f = document.getElementById("tf-field").value;
        var meta = s.fieldMeta && s.fieldMeta[f];
        var wrap = document.getElementById("tf-value-wrap"); if (!wrap) return;
        var v = cur.value != null ? String(cur.value) : "";
        if (meta && (meta.kind === "enum" || meta.kind === "bool") && meta.values) {
          wrap.innerHTML = '<select id="tf-value">' + opt(meta.values, v) + '</select>';
        } else if (meta && meta.kind === "number") {
          wrap.innerHTML = '<input type="number" id="tf-value" value="' + escapeHtml(v) + '" placeholder="e.g. 3">';
        } else {
          wrap.innerHTML = '<input type="text" id="tf-value" value="' + escapeHtml(v) + '" placeholder="device value (e.g. up / down)">';
        }
      };
      document.getElementById("tf-field").addEventListener("change", renderStateValue);
      renderStateValue();
    }

    // Scope fields only for asset-scoped trigger types.
    if (def && def.scoped) {
      var chips = (_ruleTagList || []).map(function (tg) {
        return '<button type="button" class="btn btn-sm btn-secondary sc-tag-chip" data-tag="' + escapeHtml(tg) + '" style="margin:2px 4px 2px 0">' + escapeHtml(tg) + '</button>';
      }).join("");
      scopeBox.innerHTML =
        '<div class="form-group" style="border:1px solid var(--color-border);border-radius:6px;padding:0.75rem">' +
        '<label style="font-weight:600">Scope — which assets</label>' +
        '<label style="display:block;margin:4px 0"><input type="checkbox" id="sc-all"' + (scope.allAssets ? " checked" : "") + '> All assets</label>' +
        '<input type="text" id="sc-types" placeholder="asset types (comma-separated)" value="' + escapeHtml((scope.assetTypes || []).join(", ")) + '" style="margin-bottom:4px;width:100%">' +
        '<input type="text" id="sc-tags" placeholder="tags (comma-separated, e.g. region:Atlanta)" value="' + escapeHtml((scope.tags || []).join(", ")) + '" style="margin-bottom:4px;width:100%">' +
        (chips ? '<div style="margin-bottom:4px">' + chips + '</div>' : "") +
        '<input type="text" id="sc-ids" placeholder="specific asset IDs (comma-separated)" value="' + escapeHtml((scope.assetIds || []).join(", ")) + '" style="width:100%">' +
        '</div>';
      // Tag chips append/remove from the comma-separated tags input.
      scopeBox.querySelectorAll(".sc-tag-chip").forEach(function (chip) {
        chip.addEventListener("click", function () {
          var input = document.getElementById("sc-tags");
          var list = input.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
          var tg = chip.getAttribute("data-tag");
          var i = list.indexOf(tg);
          if (i >= 0) list.splice(i, 1); else list.push(tg);
          input.value = list.join(", ");
        });
      });
    } else {
      scopeBox.innerHTML = "";
    }
  }
  typeSel.addEventListener("change", renderTriggerFields);
  renderTriggerFields();

  function csv(id) {
    var el = document.getElementById(id);
    if (!el) return [];
    return el.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function numOrUndef(id) { var el = document.getElementById(id); if (!el || el.value === "") return undefined; var n = Number(el.value); return isNaN(n) ? undefined : n; }
  // Sustained-for is entered in minutes; the engine field is forDurationSec.
  function durationSec() { return (numOrUndef("tf-duration-min") || 0) * 60; }
  function collectDims() {
    var df = {};
    document.querySelectorAll("#tf-dims [data-dim]").forEach(function (el) {
      var v = el.value.trim();
      if (v) df[el.getAttribute("data-dim")] = v;
    });
    return df;
  }

  function collectTrigger() {
    var t = typeSel.value;
    if (t === "asset_metric") {
      var df = collectDims();
      var trg = { type: t, metric: document.getElementById("tf-metric").value, aggregation: document.getElementById("tf-agg").value, windowSec: numOrUndef("tf-window") || 0, operator: document.getElementById("tf-op").value, threshold: Number(document.getElementById("tf-threshold").value), forDurationSec: durationSec() };
      if (Object.keys(df).length) trg.dimensionFilter = df;
      return trg;
    }
    if (t === "host_metric") {
      return { type: t, metric: document.getElementById("tf-metric").value, aggregation: document.getElementById("tf-agg").value, windowSec: numOrUndef("tf-window") || 0, operator: document.getElementById("tf-op").value, threshold: Number(document.getElementById("tf-threshold").value), forDurationSec: durationSec() };
    }
    if (t === "asset_state") {
      return { type: t, field: document.getElementById("tf-field").value, operator: document.getElementById("tf-op").value, value: document.getElementById("tf-value").value, forDurationSec: durationSec() };
    }
    if (t === "event") {
      var ev = { type: t, actionPattern: document.getElementById("tf-action").value.trim() };
      var rt = document.getElementById("tf-restype").value.trim(); if (rt) ev.resourceType = rt;
      var ml = document.getElementById("tf-minlevel").value; if (ml) ev.minLevel = ml;
      return ev;
    }
    if (t === "change") {
      return { type: t, changeType: document.getElementById("tf-changetype").value };
    }
    return { type: t };
  }

  function collectScope() {
    var def = findType(typeSel.value);
    if (!def || !def.scoped) return {};
    var all = document.getElementById("sc-all");
    if (all && all.checked) return { allAssets: true };
    var sc = {};
    var types = csv("sc-types"); if (types.length) sc.assetTypes = types;
    var tags = csv("sc-tags"); if (tags.length) sc.tags = tags;
    var ids = csv("sc-ids"); if (ids.length) sc.assetIds = ids;
    return sc;
  }

  // ─── Notify (delivery targets) editor ──────────────────────────────────
  var WEBHOOK_KINDS = (s.webhookKinds || ["generic", "slack", "teams"]);
  function tagMultiSelect(selected) {
    var sel = new Set(selected || []);
    var opts = (_ruleTagList || []).map(function (tg) {
      return '<option value="' + escapeHtml(tg) + '"' + (sel.has(tg) ? " selected" : "") + '>' + escapeHtml(tg) + '</option>';
    }).join("");
    return '<select multiple class="tg-recipient-tags" size="4" style="width:100%">' + opts + '</select>';
  }
  function targetRowHtml(t) {
    t = t || { channel: "email" };
    var ch = t.channel || "email";
    var channelSel = '<select class="tg-channel">' +
      ['email', 'webhook', 'web_push'].map(function (c) {
        var lbl = c === "web_push" ? "Web push" : c.charAt(0).toUpperCase() + c.slice(1);
        return '<option value="' + c + '"' + (c === ch ? " selected" : "") + '>' + lbl + '</option>';
      }).join("") + '</select>';
    return '<div class="tg-row" style="border:1px solid var(--color-border);border-radius:6px;padding:0.6rem;margin-bottom:6px">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
        '<label style="margin:0;font-size:0.8rem">Channel</label>' + channelSel +
        '<button type="button" class="btn btn-sm btn-danger tg-remove" style="margin-left:auto">Remove</button>' +
      '</div>' +
      '<div class="tg-fields"></div>' +
    '</div>';
  }
  function renderTargetFields(row, t) {
    t = t || {};
    var ch = row.querySelector(".tg-channel").value;
    var box = row.querySelector(".tg-fields");
    if (ch === "email") {
      box.innerHTML =
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Recipient tags (route to matching users)</label>' + tagMultiSelect(t.recipientTags) + '</div>' +
        '<div class="form-group" style="margin:0"><label style="font-size:0.8rem">Explicit addresses (comma-separated)</label><input type="text" class="tg-addresses" value="' + escapeHtml((t.addresses || []).join(", ")) + '" placeholder="oncall@example.com, noc@example.com"></div>';
    } else if (ch === "webhook") {
      box.innerHTML =
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Webhook URL</label><input type="text" class="tg-webhook-url" value="' + escapeHtml(t.webhookUrl || "") + '" placeholder="https://hooks.slack.com/…"></div>' +
        '<div class="form-group" style="margin:0"><label style="font-size:0.8rem">Format</label><select class="tg-webhook-kind">' +
          WEBHOOK_KINDS.map(function (k) { return '<option value="' + k + '"' + (k === (t.webhookKind || "generic") ? " selected" : "") + '>' + escapeHtml(k) + '</option>'; }).join("") +
        '</select></div>';
    } else {
      box.innerHTML =
        '<div class="form-group" style="margin:0"><label style="font-size:0.8rem">Recipient tags (route to subscribed users)</label>' + tagMultiSelect(t.recipientTags) + '</div>';
    }
  }
  function wireTargetRow(row, t) {
    renderTargetFields(row, t);
    row.querySelector(".tg-channel").addEventListener("change", function () { renderTargetFields(row, {}); });
    row.querySelector(".tg-remove").addEventListener("click", function () { row.remove(); });
  }
  function addTargetRow(t) {
    var host = document.getElementById("rule-targets");
    var tmp = document.createElement("div");
    tmp.innerHTML = targetRowHtml(t);
    var row = tmp.firstChild;
    host.appendChild(row);
    wireTargetRow(row, t);
  }
  function collectTargets() {
    var out = [];
    document.querySelectorAll("#rule-targets .tg-row").forEach(function (row) {
      var ch = row.querySelector(".tg-channel").value;
      var t = { channel: ch };
      var tagSel = row.querySelector(".tg-recipient-tags");
      if (tagSel) {
        var tags = Array.from(tagSel.selectedOptions).map(function (o) { return o.value; });
        if (tags.length) t.recipientTags = tags;
      }
      if (ch === "email") {
        var addrs = (row.querySelector(".tg-addresses").value || "").split(",").map(function (a) { return a.trim(); }).filter(Boolean);
        if (addrs.length) t.addresses = addrs;
      } else if (ch === "webhook") {
        var url = (row.querySelector(".tg-webhook-url").value || "").trim();
        if (url) t.webhookUrl = url;
        t.webhookKind = row.querySelector(".tg-webhook-kind").value;
      }
      out.push(t);
    });
    return out;
  }
  (r.targets || []).forEach(addTargetRow);
  document.getElementById("rule-add-target").addEventListener("click", function () { addTargetRow({ channel: "email" }); });

  function collectRule() {
    var rule = {
      name: document.getElementById("rule-name").value.trim(),
      description: document.getElementById("rule-desc").value.trim() || null,
      enabled: document.getElementById("rule-enabled").checked,
      severity: document.getElementById("rule-severity").value,
      trigger: collectTrigger(),
      scope: collectScope(),
      clearBehavior: clearSel.value,
      clearAfterSec: clearSel.value === "timed" ? (numOrUndef("rule-clearafter") || 3600) : null,
      cooldownSec: numOrUndef("rule-cooldown") != null ? numOrUndef("rule-cooldown") : null,
      messageTemplate: document.getElementById("rule-msg").value.trim() || null,
      channels: ["in_app"],
      targets: collectTargets(),
    };
    return rule;
  }

  document.getElementById("rule-test").addEventListener("click", async function () {
    var box = document.getElementById("rule-preview");
    box.innerHTML = '<p style="color:var(--color-text-tertiary)">Testing…</p>';
    try {
      var res = await api.notificationRules.preview(collectRule());
      if (!res.supported) { box.innerHTML = '<p style="color:var(--color-text-tertiary)">' + escapeHtml(res.note || "Not previewable.") + '</p>'; return; }
      var meeting = (res.matches || []).filter(function (m) { return m.meets; });
      var rowsHtml = (res.matches || []).slice(0, 20).map(function (m) {
        return '<tr><td>' + escapeHtml(m.hostname || m.assetId || "host") + '</td><td>' + escapeHtml(m.dimension || "") + '</td><td>' + escapeHtml(m.value == null ? "n/a" : String(m.value)) + '</td><td>' + (m.meets ? '<span style="color:var(--color-danger)">match</span>' : '<span style="color:var(--color-text-tertiary)">no</span>') + '</td></tr>';
      }).join("");
      box.innerHTML = '<p style="font-size:0.85rem"><strong>' + meeting.length + '</strong> of ' + res.totalEvaluated + ' currently match.</p>' +
        '<div class="table-wrapper" style="max-height:200px;overflow:auto"><table><thead><tr><th>Asset</th><th>Dimension</th><th>Value</th><th>Match</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
    } catch (err) { box.innerHTML = '<p style="color:var(--color-danger)">' + escapeHtml(err.message || "Preview failed") + '</p>'; }
  });

  function validateRule(rule) {
    if (!rule.name) return "Name is required.";
    var tr = rule.trigger || {};
    if ((tr.type === "asset_metric" || tr.type === "host_metric") && (tr.threshold == null || isNaN(tr.threshold))) {
      return "Enter a numeric threshold for the condition.";
    }
    if (tr.type === "asset_state" && (tr.value == null || String(tr.value).trim() === "")) {
      return "Choose or enter a value for the condition.";
    }
    if (tr.type === "event" && !String(tr.actionPattern || "").trim()) {
      return "Enter an action pattern for the event trigger.";
    }
    var sc = rule.scope || {};
    var def = findType(tr.type);
    if (def && def.scoped && !sc.allAssets && !(sc.assetTypes && sc.assetTypes.length) && !(sc.tags && sc.tags.length) && !(sc.assetIds && sc.assetIds.length)) {
      return "Pick a scope: All assets, or at least one asset type / tag / asset ID.";
    }
    var targets = rule.targets || [];
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i]; var n = i + 1;
      if (t.channel === "webhook" && !t.webhookUrl) return "Target " + n + ": a webhook URL is required.";
      if (t.channel === "email" && !(t.addresses && t.addresses.length) && !(t.recipientTags && t.recipientTags.length)) {
        return "Target " + n + ": an email target needs recipient tags and/or explicit addresses.";
      }
      if (t.channel === "web_push" && !(t.recipientTags && t.recipientTags.length)) {
        return "Target " + n + ": a web-push target needs recipient tags.";
      }
    }
    return null;
  }

  document.getElementById("rule-save").addEventListener("click", async function () {
    var rule = collectRule();
    var problem = validateRule(rule);
    if (problem) { showToast(problem, "error"); return; }
    this.disabled = true;
    try {
      if (existing) await api.notificationRules.update(existing.id, rule);
      else await api.notificationRules.create(rule);
      closeModal();
      showToast(existing ? "Rule saved" : "Rule created", "success");
      if (window._reloadRules) window._reloadRules();
    } catch (err) { this.disabled = false; showToast(err.message || "Save failed", "error"); }
  });
}
