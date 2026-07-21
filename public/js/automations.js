/**
 * public/js/automations.js — Automations page (Alerts + Automations + Delivery tabs).
 *
 * Alerts tab: server-side TableSF list of triggered alerts with multiselect
 * acknowledge/clear (acknowledge gated alerts:write, clear gated
 * alerts:fullwrite) + an optional-note acknowledge modal. Automations tab
 * (data-tab="manage", gated automationManagement): automation list; create/edit
 * opens the 5-step wizard in automations-wizard.js. Delivery tab: the
 * NotificationChannel registry. Mirrors the server-side table pattern in events.js.
 */

var _notifPageSize = 15;
var _notifSF = null;
var _notifLayout = null;
var _rulesSF = null;
var _rulesLayout = null;
var _ruleSchema = null;
var _ruleTagList = null;  // cached distinct asset tags for the scope picker
var _ruleAssetTypes = null; // cached asset-type registry (finite set) for the scope picker
var _ruleChannels = null; // cached configured delivery channels (rule-builder picker)
var _ruleRecipientUsers = null; // cached users for the recipient picker

// A tag value that looks like a machine identifier — an Entra/Intune GUID
// (8-4-4-4-12 hex, possibly with a prefix like "prev-entra:<guid>") or a long
// bare hex object id. Filtered out of the rule-builder tag pickers (scope +
// recipient tags) so device IDs don't flood them. Human tags
// (region:Atlanta, firewall:fgt-1, prod) never match.
function _looksLikeDeviceId(tag) {
  if (!tag) return false;
  var t = String(tag);
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(t)) return true; // GUID anywhere in the value
  if (/^[0-9a-f]{24,}$/i.test(t)) return true; // long bare hex object id
  return false;
}

(function () {
  // Permissions resolve asynchronously via /auth/me (userReady). Computing
  // them at script-load time reads an empty matrix and wrongly hides the
  // Manage tab / action buttons — so they're (re)applied after userReady.
  var canAck = false;
  var canClear = false;
  var canManage = false;
  var canEditRules = false;

  function applyPermGatedUI() {
    canAck = permAtLeast("alerts", "write");
    canClear = permAtLeast("alerts", "fullwrite");
    canManage = permAtLeast("automationManagement", "read");
    canEditRules = permAtLeast("automationManagement", "fullwrite");

    var mb = document.getElementById("auto-tab-manage-btn");
    if (mb) mb.style.display = canManage ? "" : "none";
    var db = document.getElementById("auto-tab-delivery-btn");
    if (db) db.style.display = canManage ? "" : "none";
    var activeKey = (document.querySelector("#auto-tabs .page-tab.active") || {}).getAttribute
      ? document.querySelector("#auto-tabs .page-tab.active").getAttribute("data-tab") : "view";
    var nr = document.getElementById("btn-new-rule");
    if (nr) {
      nr.style.display = canEditRules && activeKey === "manage" ? "" : "none";
      if (canEditRules && !nr._wired) { nr._wired = true; nr.addEventListener("click", function () { openAutomationWizard(null); }); }
    }
    var ac = document.getElementById("btn-add-channel");
    if (ac) {
      ac.style.display = canEditRules && activeKey === "delivery" ? "" : "none";
      if (canEditRules && !ac._wired) { ac._wired = true; ac.addEventListener("click", function () { openChannelModal(null); }); }
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
  document.querySelectorAll("#auto-tabs .page-tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.getAttribute("data-tab");
      document.querySelectorAll("#auto-tabs .page-tab").forEach(function (b) { b.classList.remove("active"); });
      document.querySelectorAll('[id^="auto-tab-"]').forEach(function (p) { if (p.classList.contains("page-tab-panel")) p.classList.remove("active"); });
      btn.classList.add("active");
      var panel = document.getElementById("auto-tab-" + key);
      if (panel) panel.classList.add("active");
      // Header buttons are tab-specific: New rule on Manage, Add channel on Delivery.
      var nrBtn = document.getElementById("btn-new-rule");
      if (nrBtn && canEditRules) nrBtn.style.display = key === "manage" ? "" : "none";
      var acBtn = document.getElementById("btn-add-channel");
      if (acBtn && canEditRules) acBtn.style.display = key === "delivery" ? "" : "none";
      if (key === "manage" && !_rulesSF) initRulesTab();
      if (key === "delivery") loadChannelsTab();
    });
  });

  document.getElementById("btn-refresh").addEventListener("click", function () {
    var active = document.querySelector("#auto-tabs .page-tab.active");
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
      localStorage.setItem("polaris-prefs-alerts-" + currentUsername, JSON.stringify({
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
    // One-time read-migrate from the pre-rename key (Automations cutover) —
    // the old key is left in place, harmless.
    try {
      raw = localStorage.getItem("polaris-prefs-alerts-" + currentUsername)
        || localStorage.getItem("polaris-prefs-notifications-" + currentUsername);
    } catch (_) { return; }
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
    api.alerts.list(buildQuery()).then(function (data) {
      rows = data.notifications || [];
      total = data.total || 0;
      renderTable();
      renderPagination();
    }).catch(function () {
      document.getElementById("notif-tbody").innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load alerts</td></tr>';
    });
  }
  window._reloadNotifications = loadNotifications;

  function renderTable() {
    var tbody = document.getElementById("notif-tbody");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No alerts</td></tr>';
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
      // Escalation marker — from the escalateNotifications sweep's per-tier state.
      var escLine = "";
      if (n.escalationState && n.escalationState.tiers) {
        var escKeys = Object.keys(n.escalationState.tiers);
        if (escKeys.length) {
          var escSent = 0;
          escKeys.forEach(function (k) { escSent += (n.escalationState.tiers[k].count || 0); });
          var escTier = Math.max.apply(null, escKeys.map(Number)) + 1;
          escLine = '<div style="font-size:0.75rem;color:var(--color-danger);margin-top:2px" title="Escalation emails sent while unhandled">Escalated — tier ' + escTier + ', ' + escSent + ' email' + (escSent === 1 ? "" : "s") + ' sent</div>';
        }
      }
      return '<tr>' +
        '<td class="cb-col"><input type="checkbox" class="row-cb" data-id="' + n.id + '"' + checked + '></td>' +
        '<td style="font-family:var(--font-mono);font-size:0.82rem;white-space:nowrap">' + escapeHtml(timeStr) + '</td>' +
        '<td><span class="badge badge-level-' + sev + '">' + sev.toUpperCase() + '</span></td>' +
        '<td>' + assetCell + '</td>' +
        '<td>' + (regions || '<span style="color:var(--color-text-tertiary)">-</span>') + '</td>' +
        '<td>' + escapeHtml(n.message || "") + escLine + '</td>' +
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
    var ok = await showConfirm("Clear " + ids.length + " alert" + (ids.length === 1 ? "" : "s") + "? Cleared alerts are removed from the list.");
    if (!ok) return;
    try {
      await api.alerts.clear(ids);
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
        await api.alerts.acknowledge(ids, note || undefined);
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
    api.automations.list().then(function (data) {
      _rules = data.rules || [];
      renderRules();
    }).catch(function () {
      document.getElementById("rules-tbody").innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load automations</td></tr>';
    });
  }
  window._reloadRules = loadRules;

  // Build a full rule-input body from a loaded rule record, applying overrides.
  // The PUT /notification-rules/:id route validates the complete ruleInputSchema,
  // so the inline enable/disable toggle must resend every field.
  function _ruleToInput(r, overrides) {
    // Rule-shape v2: resend reset + actions (the server's list endpoint always
    // returns them) so this full-record PUT can't strip the v2 fields. The
    // legacy clearBehavior/targets columns are the server-maintained mirror —
    // never sent from here (v2 wins server-side when both appear anyway).
    return Object.assign({
      name: r.name,
      description: r.description != null ? r.description : null,
      enabled: r.enabled,
      severity: r.severity,
      trigger: r.trigger,
      scope: r.scope || {},
      reset: r.reset || null,
      actions: Array.isArray(r.actions) ? r.actions : [],
      cooldownSec: r.cooldownSec != null ? r.cooldownSec : null,
      messageTemplate: r.messageTemplate != null ? r.messageTemplate : null,
      channels: r.channels || ["in_app"],
      emailComposition: r.emailComposition || null,
      escalation: r.escalation || null,
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
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No automations yet' + (canEditRules ? ' — click "+ New automation" to create one.' : "") + '</td></tr>';
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
          await api.automations.update(r.id, _ruleToInput(r, { enabled: desired }));
          r.enabled = desired;
          showToast("Automation " + (desired ? "enabled" : "disabled"), "success");
          loadRules();
        } catch (err) {
          cb.checked = !desired;
          cb.disabled = false;
          showToast(err.message || "Update failed", "error");
        }
      });
    });
    tbody.querySelectorAll(".rule-edit").forEach(function (b) {
      b.addEventListener("click", function () { var r = _rules.find(function (x) { return x.id === b.dataset.id; }); if (r) openAutomationWizard(r); });
    });
    tbody.querySelectorAll(".rule-del").forEach(function (b) {
      b.addEventListener("click", async function () {
        var r = _rules.find(function (x) { return x.id === b.dataset.id; });
        if (!r) return;
        var ok = await showConfirm('Delete automation "' + r.name + '"? Its firing state is dropped; existing alerts are kept.');
        if (!ok) return;
        try { await api.automations.delete(r.id); showToast("Automation deleted", "success"); loadRules(); }
        catch (err) { showToast(err.message || "Delete failed", "error"); }
      });
    });
  }

  // expose for the builder (defined at module scope below)
  window._notifLoadRules = loadRules;
  window._notifGetSchema = function () { return _ruleSchema; };
})();

// ═══════════════════════════ Delivery (channels) tab ════════════════════════
// Operator-managed list of outbound delivery channels, set up like the
// Integrations page. Backed by /notification-channels; secrets masked on read.

async function loadChannelsTab() {
  var container = document.getElementById("channels-list");
  if (!container) return;
  if (!_ruleSchema) { try { _ruleSchema = await api.automations.schema(); } catch (_e) { /* labels degrade to raw type */ } }
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    var resp = await api.deliveryChannels.list();
    _ruleChannels = (resp && resp.channels) || [];
    renderChannelsList(_ruleChannels);
  } catch (err) {
    container.innerHTML = '<p class="empty-state">Error: ' + escapeHtml(err.message || "load failed") + '</p>';
  }
}

function _chanTypeMeta() { return (_ruleSchema && _ruleSchema.channelTypes) || {}; }
function channelTypeLabel(type) { var m = _chanTypeMeta()[type]; return (m && m.label) || type; }

// Short badge token per channel type for the card header.
var _CHANNEL_BADGE = { smtp: "SMTP", oauth_m365: "M365", pushbullet: "Pushbullet", slack: "Slack", teams: "Teams", web_push: "Web Push" };

// Detail rows for a channel card — schema-driven from the type's field defs.
// Non-secret values (host, tenant id, client id, from, send-as user, …) render
// directly; secret fields show configured/not-set rather than the value.
function channelDetailRows(c) {
  var defs = (_chanTypeMeta()[c.type] && _chanTypeMeta()[c.type].fields) || [];
  var cfg = (c.config && typeof c.config === "object") ? c.config : {};
  var rows = '<div class="detail-row"><span class="detail-label">Type</span><span class="detail-value">' + escapeHtml(channelTypeLabel(c.type)) + '</span></div>';
  defs.forEach(function (f) {
    var val;
    if (f.secret) {
      val = cfg[f.key + "Set"] ? '<span class="badge badge-active">configured</span>' : '<span style="color:var(--color-text-tertiary)">not set</span>';
    } else {
      var raw = cfg[f.key];
      if (raw === undefined || raw === null || String(raw) === "") return; // skip empty optional fields
      val = escapeHtml(String(raw));
    }
    rows += '<div class="detail-row"><span class="detail-label">' + escapeHtml(f.label) + '</span><span class="detail-value">' + val + '</span></div>';
  });
  if (c.type === "web_push") {
    rows += '<div class="detail-row"><span class="detail-label">VAPID keypair</span><span class="detail-value">' +
      (cfg.privateKeySet ? '<span class="badge badge-active">generated</span>' : '<span style="color:var(--color-danger)">not generated</span>') + '</span></div>';
  }
  return rows;
}

function renderChannelsList(channels) {
  var container = document.getElementById("channels-list");
  if (!container) return;
  var canEdit = permAtLeast("automationManagement", "fullwrite");
  if (!channels.length) {
    container.innerHTML = '<div class="empty-state-card"><p>No delivery channels configured.</p>' +
      (canEdit ? '<p style="color:var(--color-text-tertiary);font-size:0.85rem;margin-top:0.5rem">Click “+ Add channel” to add an SMTP / Microsoft 365 email, Pushbullet, Slack, Microsoft Teams, or Web Push destination.</p>' : '') + '</div>';
    return;
  }
  container.innerHTML = channels.map(function (c) {
    var actions = canEdit
      ? '<button class="btn btn-sm btn-secondary ch-test" data-id="' + c.id + '">Test</button> ' +
        '<button class="btn btn-sm btn-secondary ch-edit" data-id="' + c.id + '">Edit</button> ' +
        '<button class="btn btn-sm btn-danger ch-del" data-id="' + c.id + '">Delete</button>'
      : '';
    var statusPill = c.enabled
      ? '<span class="integration-status dot-ok">Enabled</span>'
      : '<span class="integration-status dot-unknown">Disabled</span>';
    return '<div class="integration-card">' +
      '<div class="integration-card-header">' +
        '<div class="integration-card-header-top">' +
          '<div class="integration-card-title">' +
            '<span class="integration-type-badge">' + escapeHtml(_CHANNEL_BADGE[c.type] || c.type) + '</span>' +
            '<strong>' + escapeHtml(c.name) + '</strong>' +
            statusPill +
          '</div>' +
          (actions ? '<div class="integration-card-actions">' + actions + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="integration-card-details">' + channelDetailRows(c) + '</div>' +
    '</div>';
  }).join("");
  if (!canEdit) return;
  container.querySelectorAll(".ch-edit").forEach(function (b) { b.addEventListener("click", function () { openChannelModal(channels.find(function (x) { return x.id === b.dataset.id; })); }); });
  container.querySelectorAll(".ch-del").forEach(function (b) { b.addEventListener("click", function () { deleteChannel(channels.find(function (x) { return x.id === b.dataset.id; })); }); });
  container.querySelectorAll(".ch-test").forEach(function (b) { b.addEventListener("click", function () { testChannel(channels.find(function (x) { return x.id === b.dataset.id; }), b); }); });
}

async function deleteChannel(c) {
  if (!c) return;
  if (!(await showConfirm('Delete delivery channel "' + c.name + '"? Automations referencing it will stop delivering through it.'))) return;
  try { await api.deliveryChannels.delete(c.id); showToast("Channel deleted", "success"); loadChannelsTab(); }
  catch (err) { showToast(err.message || "Delete failed", "error"); }
}

async function testChannel(c, btn) {
  if (!c) return;
  var body = {};
  if (c.type === "smtp" || c.type === "oauth_m365") {
    var to = window.prompt("Send a test email to:", "");
    if (!to) return;
    body.to = to.trim();
  } else if (c.type === "web_push") {
    showToast("Test web push by enabling it on a device (Enable push button)", "info");
    return;
  }
  if (btn) btn.disabled = true;
  try { var r = await api.deliveryChannels.test(c.id, body); showToast(r.message || "Test sent", "success"); }
  catch (err) { showToast(err.message || "Test failed", "error"); }
  if (btn) btn.disabled = false;
}

// Add/edit a channel. `existing` = the masked channel row (edit) or null (add).
function openChannelModal(existing) {
  var meta = _chanTypeMeta();
  var types = Object.keys(meta);
  if (types.length === 0) { showToast("Channel schema not loaded", "error"); return; }
  var isEdit = !!existing;
  var cur = existing || {};
  var curConfig = (cur.config && typeof cur.config === "object") ? cur.config : {};
  var initialType = isEdit ? cur.type : types[0];

  function fieldInput(f) {
    var id = "ch-field-" + f.key;
    var val = (curConfig[f.key] != null && f.kind !== "password") ? String(curConfig[f.key]) : "";
    var setFlag = curConfig[f.key + "Set"];
    if (f.kind === "select") {
      var opts = (f.options || []).map(function (o) { return '<option value="' + o + '"' + (o === val ? " selected" : "") + '>' + o + '</option>'; }).join("");
      return '<div class="form-group"><label>' + escapeHtml(f.label) + '</label><select id="' + id + '">' + opts + '</select></div>';
    }
    var inputType = f.kind === "password" ? "password" : (f.kind === "number" ? "number" : "text");
    var ph = f.placeholder || "";
    if (f.kind === "password" && isEdit && setFlag) ph = "(unchanged)";
    return '<div class="form-group"><label>' + escapeHtml(f.label) + '</label>' +
      '<input type="' + inputType + '" id="' + id + '" value="' + escapeHtml(f.kind === "password" ? "" : val) + '" placeholder="' + escapeHtml(ph) + '"' + (f.kind === "password" ? ' autocomplete="new-password"' : '') + '></div>';
  }

  function webPushExtra() {
    var pub = curConfig.publicKey ? String(curConfig.publicKey) : "";
    var keySet = !!curConfig.privateKeySet;
    return '<div class="form-group"><label>Public key</label><input type="text" id="ch-webpush-public" value="' + escapeHtml(pub) + '" readonly placeholder="(generated on save)"></div>' +
      '<p style="font-size:0.82rem;color:var(--color-text-tertiary)">Private key: ' + (keySet ? '<span style="color:var(--color-success)">set</span>' : '<span style="color:var(--color-danger)">not set</span>') +
      (isEdit ? ' — <button type="button" class="btn btn-sm btn-secondary" id="ch-gen-vapid">Regenerate keypair</button>' : ' — generated automatically when you save') + '</p>';
  }

  function fieldsFor(type) {
    var defs = (meta[type] && meta[type].fields) || [];
    var help = meta[type] && meta[type].help;
    var html = help ? '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0 0 0.6rem">' + escapeHtml(help) + '</p>' : "";
    html += defs.map(fieldInput).join("");
    if (type === "web_push") html += webPushExtra();
    return html;
  }

  var typeControl = isEdit
    ? '<div class="form-group"><label>Type</label><input type="text" value="' + escapeHtml(channelTypeLabel(cur.type)) + '" readonly></div>'
    : '<div class="form-group"><label>Type</label><select id="ch-type">' + types.map(function (t) { return '<option value="' + t + '">' + escapeHtml(meta[t].label || t) + '</option>'; }).join("") + '</select></div>';

  var body =
    '<div class="form-group"><label>Name</label><input type="text" id="ch-name" value="' + escapeHtml(cur.name || "") + '" placeholder="e.g. NOC Slack"></div>' +
    typeControl +
    '<div class="form-group"><label><input type="checkbox" id="ch-enabled"' + (cur.enabled === false ? "" : " checked") + '> Enabled</label></div>' +
    '<div id="ch-fields">' + fieldsFor(initialType) + '</div>';

  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="ch-save">' + (isEdit ? "Save changes" : "Create channel") + '</button>';

  openModal(isEdit ? "Edit delivery channel" : "Add delivery channel", body, footer, { wide: true });

  var typeSel = document.getElementById("ch-type");
  function currentType() { return isEdit ? cur.type : (typeSel ? typeSel.value : initialType); }
  if (typeSel) typeSel.addEventListener("change", function () { document.getElementById("ch-fields").innerHTML = fieldsFor(typeSel.value); wireVapidBtn(); wireSmtpPortAutofill(); });

  // SMTP: selecting a security level auto-fills the conventional port
  // (none→25, starttls→587, ssl→465). The operator can still edit the port
  // afterward — we only set it on an explicit security change.
  function wireSmtpPortAutofill() {
    var sec = document.getElementById("ch-field-security");
    var port = document.getElementById("ch-field-port");
    if (!sec || !port || sec._portWired) return;
    sec._portWired = true;
    var PORTS = { none: 25, starttls: 587, ssl: 465 };
    sec.addEventListener("change", function () {
      var d = PORTS[sec.value];
      if (d) port.value = d;
    });
  }

  function wireVapidBtn() {
    var gb = document.getElementById("ch-gen-vapid");
    if (gb && !gb._wired) {
      gb._wired = true;
      gb.addEventListener("click", async function () {
        gb.disabled = true;
        try {
          var r = await api.deliveryChannels.generateVapid(cur.id);
          var pubEl = document.getElementById("ch-webpush-public");
          if (pubEl) pubEl.value = r.publicKey || "";
          showToast("New VAPID keypair generated", "success");
        } catch (err) { showToast(err.message || "Generate failed", "error"); }
        gb.disabled = false;
      });
    }
  }
  wireVapidBtn();
  wireSmtpPortAutofill();

  function collectConfig(type) {
    var defs = (meta[type] && meta[type].fields) || [];
    var config = {};
    defs.forEach(function (f) {
      var el = document.getElementById("ch-field-" + f.key);
      if (!el) return;
      var v = el.value;
      if (f.kind === "password" && v === "") return; // blank secret → server preserves
      if (f.kind === "number") { config[f.key] = parseInt(v, 10) || 0; return; }
      config[f.key] = v.trim();
    });
    return config;
  }

  document.getElementById("ch-save").addEventListener("click", async function () {
    var name = document.getElementById("ch-name").value.trim();
    if (!name) { showToast("Name is required", "error"); return; }
    var type = currentType();
    var payload = { name: name, type: type, enabled: document.getElementById("ch-enabled").checked, config: collectConfig(type) };
    this.disabled = true;
    try {
      if (isEdit) {
        await api.deliveryChannels.update(cur.id, payload);
      } else {
        var created = await api.deliveryChannels.create(payload);
        // A brand-new Web Push channel needs a keypair to send — mint one now.
        if (type === "web_push" && created && created.id) {
          try { await api.deliveryChannels.generateVapid(created.id); } catch (_e) { /* operator can regenerate later */ }
        }
      }
      closeModal();
      showToast(isEdit ? "Channel saved" : "Channel created", "success");
      loadChannelsTab();
    } catch (err) { this.disabled = false; showToast(err.message || "Save failed", "error"); }
  });
}
