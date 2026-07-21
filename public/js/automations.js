/**
 * public/js/automations.js — Automations page (Alerts + Automations + Delivery tabs).
 *
 * View tab: server-side TableSF list of triggered notifications with multiselect
 * acknowledge/clear (acknowledge gated notifications:write, clear gated
 * notifications:fullwrite) + an optional-note acknowledge modal. Rules tab
 * (data-tab="manage", gated notificationManagement): rule list + a schema-driven
 * rule builder with a live Test (preview). Delivery tab: the NotificationChannel
 * registry. Mirrors the server-side table pattern in events.js.
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
      if (canEditRules && !nr._wired) { nr._wired = true; nr.addEventListener("click", function () { openRuleBuilder(null); }); }
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
      b.addEventListener("click", function () { var r = _rules.find(function (x) { return x.id === b.dataset.id; }); if (r) openRuleBuilder(r); });
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

// ─── Rule builder (module-scope so it can be opened from the page) ──────────

async function openRuleBuilder(existing) {
  if (!_ruleSchema) {
    try { _ruleSchema = await api.automations.schema(); }
    catch (err) { showToast("Failed to load the automation schema", "error"); return; }
  }
  if (_ruleTagList === null) {
    // Filter out machine-identifier tags (Entra/Intune GUIDs, long hex object
    // ids) so device IDs don't flood the scope + recipient-tag pickers. Human
    // tags (region:Atlanta, firewall:fgt-1, prod) never match.
    try { var _td = await api.assets.tags(); _ruleTagList = ((_td && _td.tags) || []).filter(function (t) { return !_looksLikeDeviceId(t); }); }
    catch (_e) { _ruleTagList = []; }
  }
  if (_ruleAssetTypes === null) {
    // Finite registry (built-ins + operator-added) — drives the scope picker's
    // selectable asset-type chips instead of a free-text field.
    try { var _at = await api.assetTypes.list(); _ruleAssetTypes = Array.isArray(_at) ? _at : ((_at && _at.assetTypes) || []); }
    catch (_e) { _ruleAssetTypes = []; }
  }
  // Always refresh channels (operator may have just added one in the Delivery tab).
  try { var _cd = await api.deliveryChannels.list(); _ruleChannels = (_cd && _cd.channels) || []; }
  catch (_e) { _ruleChannels = _ruleChannels || []; }
  if (_ruleRecipientUsers === null) {
    try { var _ru = await api.automations.recipientUsers(); _ruleRecipientUsers = (_ru && _ru.users) || []; }
    catch (_e) { _ruleRecipientUsers = []; }
  }
  var s = _ruleSchema;
  var r = existing || {};
  var trig = r.trigger || { type: "asset_metric" };
  var scope = r.scope || {};
  var comp = r.emailComposition || null;
  var esc = r.escalation || null;

  function opt(list, sel) {
    return list.map(function (v) { return '<option value="' + escapeHtml(v) + '"' + (v === sel ? " selected" : "") + '>' + escapeHtml(v) + '</option>'; }).join("");
  }
  function triggerTypeOptions() {
    return s.triggerTypes.map(function (t) {
      return '<option value="' + t.type + '"' + (t.type === trig.type ? " selected" : "") + '>' + escapeHtml(t.label) + '</option>';
    }).join("");
  }
  // Collapsed insert-variable palette (chips insert {token} into the last-
  // focused .tpl-field — message template, email subject/bodies, tier overrides).
  function tokenPaletteHtml() {
    var vars = s.templateVariables || [];
    if (!vars.length) return "";
    var chips = vars.map(function (v) {
      return '<button type="button" class="btn btn-sm btn-secondary tpl-token" data-token="' + escapeHtml(v.token) + '" title="' + escapeHtml(v.description) + '" style="margin:2px 4px 2px 0;font-family:var(--font-mono);font-size:0.72rem;padding:1px 6px">' + escapeHtml(v.token) + '</button>';
    }).join("");
    return '<details id="rule-token-palette" style="margin:2px 0 6px"><summary style="font-size:0.78rem;cursor:pointer;color:var(--color-text-tertiary)">Insert variable…</summary><div style="margin-top:4px">' + chips + '</div></details>';
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
    '<div class="form-group"><label>Message template (optional)</label>' + tokenPaletteHtml() + '<input type="text" id="rule-msg" class="tpl-field" value="' + escapeHtml(r.messageTemplate || "") + '" placeholder="{asset} {metric} = {value} (threshold {threshold})"></div>' +
    '<div class="form-group"><label><input type="checkbox" id="rule-enabled"' + (r.enabled === false ? "" : " checked") + '> Enabled</label></div>' +
    '<div class="form-group"><label>Notify (delivery targets)</label>' +
      '<div id="rule-targets"></div>' +
      '<button type="button" class="btn btn-sm btn-secondary" id="rule-add-target" style="margin-top:6px">+ Add target</button>' +
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:6px">In-app delivery is always on. Email targets need SMTP or Microsoft 365 configured in Server Settings → Notifications; web push needs Web Push configured and recipients who have enabled push on their device. Tag-routed email only reaches matched users who have an email address set.</p>' +
    '</div>' +
    // ── Email composition (rule-level; applies to all email targets) ─────────
    '<div class="form-group" style="border:1px solid var(--color-border);border-radius:6px;padding:0.75rem">' +
      '<label style="font-weight:600;margin:0"><input type="checkbox" id="rule-email-enable"' + (comp ? " checked" : "") + '> Customize outbound email (subject / Cc / Bcc / body)</label>' +
      '<div id="rule-email-fields" style="display:' + (comp ? "block" : "none") + ';margin-top:8px">' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 6px">Email targets only — other channel types ignore this. To recipients come from each email target above; with customization on, each email target sends ONE message carrying its full To list plus the Cc/Bcc below. Unset fields keep the default subject/body. Insert variables via the palette above the message template.</p>' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Subject</label><input type="text" id="rule-email-subject" class="tpl-field" value="' + escapeHtml((comp && comp.subjectTemplate) || "") + '" placeholder="[{severity.upper}] {asset} — {metric} = {value}"></div>' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Cc (comma-separated — start typing for known addresses)</label><input type="text" id="rule-email-cc-addr" list="notif-email-suggest" autocomplete="off" value="' + escapeHtml(((comp && comp.cc && comp.cc.addresses) || []).join(", ")) + '" placeholder="manager@example.com"></div>' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Bcc (comma-separated — start typing for known addresses)</label><input type="text" id="rule-email-bcc-addr" list="notif-email-suggest" autocomplete="off" value="' + escapeHtml(((comp && comp.bcc && comp.bcc.addresses) || []).join(", ")) + '" placeholder="audit@example.com"></div>' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Body (plain text)</label><textarea id="rule-email-body" class="tpl-field" rows="5" style="width:100%" placeholder="{message} — details: {asset.ip} {asset.location}. View: {link}">' + escapeHtml((comp && comp.bodyTextTemplate) || "") + '</textarea></div>' +
        '<label style="font-size:0.8rem;display:block"><input type="checkbox" id="rule-email-html-enable"' + (comp && comp.bodyHtmlTemplate ? " checked" : "") + '> Add HTML body (interpolated values are HTML-escaped; Microsoft 365 recipients get HTML only when both bodies are set)</label>' +
        '<textarea id="rule-email-html" class="tpl-field" rows="5" style="width:100%;display:' + (comp && comp.bodyHtmlTemplate ? "block" : "none") + ';margin-top:4px">' + escapeHtml((comp && comp.bodyHtmlTemplate) || "") + '</textarea>' +
      '</div>' +
    '</div>' +
    // ── Escalation tiers (follow-up emails while unhandled) ──────────────────
    '<div class="form-group" style="border:1px solid var(--color-border);border-radius:6px;padding:0.75rem">' +
      '<label style="font-weight:600;margin:0"><input type="checkbox" id="rule-esc-enable"' + (esc ? " checked" : "") + '> Escalation emails (follow up while unhandled)</label>' +
      '<div id="rule-esc-fields" style="display:' + (esc ? "block" : "none") + ';margin-top:8px">' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Stop escalating when</label><select id="rule-esc-stopon"><option value="acknowledge">Acknowledged (or cleared)</option><option value="clear">Cleared only — acknowledging does not stop it</option></select></div>' +
        '<div id="rule-esc-tiers"></div>' +
        '<button type="button" class="btn btn-sm btn-secondary" id="rule-esc-add" style="margin-top:6px">+ Add tier</button>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:6px">Each tier emails its recipients once its delay elapses (checked every minute), optionally repeating until the notification is handled or max repeats is reached. Tiers use email channels only. Subject/body overrides fall back to the customized email above, then to the default with an [ESCALATION n] subject prefix.</p>' +
      '</div>' +
    '</div>' +
    // Shared autocomplete source of known email addresses for the Cc/Bcc inputs.
    '<datalist id="notif-email-suggest">' + emailSuggestOptions() + '</datalist>' +
    '<div id="rule-preview" style="margin-top:0.5rem"></div>';

  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-secondary" id="rule-test">Test</button>' +
    '<button class="btn btn-primary" id="rule-save">' + (existing ? "Save changes" : "Create rule") + '</button>';

  openModal(existing ? "Edit automation" : "New automation", body, footer, { wide: true });

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
      html += '<div class="form-group"><label>Minimum event level (optional)</label><select id="tf-minlevel"><option value="">(any)</option>' + opt(s.eventLevels || ["info", "warning", "error"], cur.minLevel || "") + '</select></div>';
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
      // Asset types are a finite registry — render selectable toggle chips
      // (active = selected) backed by a hidden #sc-types comma input so
      // collectScope() reads them unchanged.
      var selTypes = {};
      (scope.assetTypes || []).forEach(function (t) { selTypes[t] = true; });
      var typeChips = (_ruleAssetTypes || []).map(function (at) {
        var on = !!selTypes[at.name];
        return '<button type="button" class="btn btn-sm ' + (on ? "btn-primary" : "btn-secondary") + ' sc-type-chip" data-type="' + escapeHtml(at.name) + '" aria-pressed="' + on + '" style="margin:2px 4px 2px 0">' + escapeHtml(at.label || at.name) + '</button>';
      }).join("");
      scopeBox.innerHTML =
        '<div class="form-group" style="border:1px solid var(--color-border);border-radius:6px;padding:0.75rem">' +
        '<label style="font-weight:600">Scope — which assets</label>' +
        '<label style="display:block;margin:4px 0"><input type="checkbox" id="sc-all"' + (scope.allAssets ? " checked" : "") + '> All assets</label>' +
        '<input type="hidden" id="sc-types" value="' + escapeHtml((scope.assetTypes || []).join(", ")) + '">' +
        (typeChips
          ? '<div style="margin:2px 0 8px"><span style="display:block;font-size:0.78rem;color:var(--color-text-tertiary);margin-bottom:2px">Asset types</span>' + typeChips + '</div>'
          : '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 8px">No asset types in the registry.</p>') +
        '<input type="text" id="sc-tags" placeholder="tags (comma-separated, e.g. region:Atlanta)" value="' + escapeHtml((scope.tags || []).join(", ")) + '" style="margin-bottom:4px;width:100%">' +
        (chips ? '<div style="margin-bottom:4px">' + chips + '</div>' : "") +
        '<input type="text" id="sc-ids" placeholder="specific asset IDs (comma-separated)" value="' + escapeHtml((scope.assetIds || []).join(", ")) + '" style="width:100%">' +
        '</div>';
      // Asset-type chips toggle their value in the hidden #sc-types input.
      scopeBox.querySelectorAll(".sc-type-chip").forEach(function (chip) {
        chip.addEventListener("click", function () {
          var input = document.getElementById("sc-types");
          var list = input.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
          var name = chip.getAttribute("data-type");
          var i = list.indexOf(name);
          var on;
          if (i >= 0) { list.splice(i, 1); on = false; } else { list.push(name); on = true; }
          input.value = list.join(", ");
          chip.setAttribute("aria-pressed", on);
          chip.classList.toggle("btn-primary", on);
          chip.classList.toggle("btn-secondary", !on);
        });
      });
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

  // ─── Notify (delivery targets) editor — pick configured channels ─────────
  var channels = _ruleChannels || [];
  var routedTypes = s.recipientRoutedTypes || ["smtp", "oauth_m365", "web_push"];
  var channelMeta = s.channelTypes || {};
  function chanById(id) { return channels.find(function (c) { return c.id === id; }); }
  function chanTypeLabel(type) { return (channelMeta[type] && channelMeta[type].label) || type; }
  function isRouted(type) { return routedTypes.indexOf(type) !== -1; }
  function isEmailType(type) { return type === "smtp" || type === "oauth_m365"; }

  // Region tags currently in this rule's Scope (drives the "users in the
  // region" recipient option). Read live from the scope tags field.
  function scopeRegionTagsNow() {
    var el = document.getElementById("sc-tags");
    var raw = el ? el.value : ((scope.tags || []).join(", "));
    return raw.split(",").map(function (x) { return x.trim(); }).filter(function (x) { return /^region:/i.test(x); });
  }
  // Distinct known email addresses (from configured users) → <option>s for the
  // Cc/Bcc autocomplete datalist. Suggestions only — the operator can still
  // type any address; nothing is pre-selected.
  function emailSuggestOptions() {
    var seen = {};
    return (_ruleRecipientUsers || [])
      .map(function (u) { return u.email; })
      .filter(function (e) { if (!e || seen[e]) return false; seen[e] = 1; return true; })
      .map(function (e) { return '<option value="' + escapeHtml(e) + '">'; })
      .join("");
  }
  function userMultiSelect(selectedIds, cls) {
    cls = cls || "tg-recipient-users";
    var sel = new Set(selectedIds || []);
    var users = _ruleRecipientUsers || [];
    if (!users.length) return '<select multiple class="' + cls + '" size="4" style="width:100%" disabled><option>No users found</option></select>';
    var opts = users.map(function (u) {
      var label = (u.displayName || u.username) + (u.email ? " <" + u.email + ">" : " (no email)");
      return '<option value="' + escapeHtml(u.id) + '"' + (sel.has(u.id) ? " selected" : "") + '>' + escapeHtml(label) + '</option>';
    }).join("");
    return '<select multiple class="' + cls + '" size="4" style="width:100%">' + opts + '</select>';
  }
  function channelOptions(selId) {
    if (channels.length === 0) return '<option value="">No channels configured</option>';
    return channels.map(function (c) {
      var lbl = c.name + " — " + chanTypeLabel(c.type) + (c.enabled ? "" : " (disabled)");
      return '<option value="' + escapeHtml(c.id) + '"' + (c.id === selId ? " selected" : "") + '>' + escapeHtml(lbl) + '</option>';
    }).join("");
  }
  function targetRowHtml(t) {
    t = t || {};
    return '<div class="tg-row" style="border:1px solid var(--color-border);border-radius:6px;padding:0.6rem;margin-bottom:6px">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
        '<label style="margin:0;font-size:0.8rem">Channel</label>' +
        '<select class="tg-channel" style="flex:1">' + channelOptions(t.channelId) + '</select>' +
        '<button type="button" class="btn btn-sm btn-danger tg-remove">Remove</button>' +
      '</div>' +
      '<div class="tg-fields"></div>' +
    '</div>';
  }
  function renderTargetFields(row, t) {
    t = t || {};
    var box = row.querySelector(".tg-fields");
    var ch = chanById(row.querySelector(".tg-channel").value);
    if (!ch) { box.innerHTML = '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0">Add a channel in the Delivery tab first.</p>'; return; }
    if (!isRouted(ch.type)) {
      box.innerHTML = '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0">Posts to this channel’s configured destination.</p>';
      return;
    }
    // Recipient sources: individual user accounts, (email) a custom address,
    // and users associated with the rule's scope region(s).
    var html = '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Send to user accounts</label>' + userMultiSelect(t.recipientUserIds) + '</div>';
    if (isEmailType(ch.type)) {
      html += '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">…or custom email addresses (comma-separated)</label><input type="text" class="tg-addresses" value="' + escapeHtml((t.addresses || []).join(", ")) + '" placeholder="oncall@example.com, noc@example.com"></div>';
    }
    var regions = scopeRegionTagsNow();
    var regionLabel = regions.length
      ? "…or users associated with the rule's region (" + regions.map(function (x) { return x.replace(/^region:/i, ""); }).join(", ") + ")"
      : "…or users associated with the rule's region (add a region: tag to the Scope above)";
    html += '<label style="display:block;font-size:0.8rem;margin:0"><input type="checkbox" class="tg-scope-region"' + (t.recipientScopeRegion ? " checked" : "") + (regions.length ? "" : " disabled") + '> ' + escapeHtml(regionLabel) + '</label>';
    box.innerHTML = html;
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
      var channelId = row.querySelector(".tg-channel").value;
      if (!channelId) return;
      var t = { channelId: channelId };
      var userSel = row.querySelector(".tg-recipient-users");
      if (userSel) {
        var uids = Array.from(userSel.selectedOptions).map(function (o) { return o.value; }).filter(function (v) { return v; });
        if (uids.length) t.recipientUserIds = uids;
      }
      var addrEl = row.querySelector(".tg-addresses");
      if (addrEl) {
        var addrs = (addrEl.value || "").split(",").map(function (a) { return a.trim(); }).filter(Boolean);
        if (addrs.length) t.addresses = addrs;
      }
      var regEl = row.querySelector(".tg-scope-region");
      if (regEl && regEl.checked) t.recipientScopeRegion = true;
      out.push(t);
    });
    return out;
  }
  (r.targets || []).forEach(addTargetRow);
  document.getElementById("rule-add-target").addEventListener("click", function () {
    if (channels.length === 0) { showToast("Add a delivery channel first (Delivery tab)", "info"); return; }
    addTargetRow({ channelId: channels[0].id });
  });

  // ─── Token palette wiring — insert {token} at caret of last-focused field ──
  var _tplFocus = null;
  function trackTplField(el) {
    if (el) el.addEventListener("focus", function () { _tplFocus = el; });
  }
  document.querySelectorAll(".tpl-field").forEach(trackTplField);
  document.querySelectorAll("#rule-token-palette .tpl-token").forEach(function (chip) {
    chip.addEventListener("click", function () {
      var el = _tplFocus || document.getElementById("rule-msg");
      if (!el) return;
      var tok = chip.getAttribute("data-token");
      if (typeof el.setRangeText === "function" && el.selectionStart != null) {
        el.setRangeText(tok, el.selectionStart, el.selectionEnd, "end");
      } else {
        el.value += tok;
      }
      el.focus();
    });
  });

  // ─── Email composition section ─────────────────────────────────────────────
  var emailEnable = document.getElementById("rule-email-enable");
  emailEnable.addEventListener("change", function () {
    document.getElementById("rule-email-fields").style.display = this.checked ? "block" : "none";
  });
  document.getElementById("rule-email-html-enable").addEventListener("change", function () {
    document.getElementById("rule-email-html").style.display = this.checked ? "block" : "none";
  });

  // Users/addresses pair → { recipientUserIds?, addresses? } or null when empty.
  function recipObj(userSelEl, addrEl) {
    var o = {};
    if (userSelEl && !userSelEl.disabled) {
      var ids = Array.from(userSelEl.selectedOptions).map(function (op) { return op.value; }).filter(Boolean);
      if (ids.length) o.recipientUserIds = ids;
    }
    if (addrEl) {
      var addrs = (addrEl.value || "").split(",").map(function (a) { return a.trim(); }).filter(Boolean);
      if (addrs.length) o.addresses = addrs;
    }
    return (o.recipientUserIds || o.addresses) ? o : null;
  }

  // Cc/Bcc are addresses-only (autocomplete of known emails, no autopopulated
  // user list). Parse the comma-separated input into { addresses } or null.
  function addrRecipObj(addrEl) {
    if (!addrEl) return null;
    var addrs = (addrEl.value || "").split(",").map(function (a) { return a.trim(); }).filter(Boolean);
    return addrs.length ? { addresses: addrs } : null;
  }

  function collectEmailComposition() {
    if (!emailEnable.checked) return null;
    var c = {};
    var subj = document.getElementById("rule-email-subject").value.trim(); if (subj) c.subjectTemplate = subj;
    var bodyTxt = document.getElementById("rule-email-body").value; if (bodyTxt.trim()) c.bodyTextTemplate = bodyTxt;
    if (document.getElementById("rule-email-html-enable").checked) {
      var h = document.getElementById("rule-email-html").value; if (h.trim()) c.bodyHtmlTemplate = h;
    }
    var cc = addrRecipObj(document.getElementById("rule-email-cc-addr")); if (cc) c.cc = cc;
    var bcc = addrRecipObj(document.getElementById("rule-email-bcc-addr")); if (bcc) c.bcc = bcc;
    return c; // {} is valid — explicit opt-in still switches email targets to one-message-per-target
  }

  // ─── Escalation section ────────────────────────────────────────────────────
  var escEnable = document.getElementById("rule-esc-enable");
  escEnable.addEventListener("change", function () {
    document.getElementById("rule-esc-fields").style.display = this.checked ? "block" : "none";
  });
  if (esc && esc.stopOn) document.getElementById("rule-esc-stopon").value = esc.stopOn;

  function emailChannels() { return channels.filter(function (c) { return isEmailType(c.type); }); }
  function escChannelOptions(selId) {
    var list = emailChannels();
    if (!list.length) return '<option value="">No email channels configured</option>';
    return list.map(function (c) {
      var lbl = c.name + " — " + chanTypeLabel(c.type) + (c.enabled ? "" : " (disabled)");
      return '<option value="' + escapeHtml(c.id) + '"' + (c.id === selId ? " selected" : "") + '>' + escapeHtml(lbl) + '</option>';
    }).join("");
  }
  function escTierHtml(t) {
    t = t || {};
    return '<div class="esc-tier" style="border:1px solid var(--color-border);border-radius:6px;padding:0.6rem;margin-bottom:6px">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">' +
        '<label style="margin:0;font-size:0.8rem">After</label>' +
        '<input type="number" class="esc-after" min="1" value="' + (t.afterMin != null ? t.afterMin : 15) + '" style="width:80px"> min,' +
        '<label style="margin:0;font-size:0.8rem">send via</label>' +
        '<select class="esc-channel" style="flex:1;min-width:160px">' + escChannelOptions(t.channelId) + '</select>' +
        '<button type="button" class="btn btn-sm btn-danger esc-remove">Remove</button>' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">To — user accounts</label>' + userMultiSelect(t.to && t.to.recipientUserIds, "esc-to-users") + '</div>' +
      '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">To — custom addresses (comma-separated)</label><input type="text" class="esc-to-addr" value="' + escapeHtml(((t.to && t.to.addresses) || []).join(", ")) + '" placeholder="supervisor@example.com"></div>' +
      '<details' + (t.cc || t.bcc || t.subjectTemplate || t.bodyTextTemplate || t.repeatEveryMin ? " open" : "") + '><summary style="font-size:0.78rem;cursor:pointer;color:var(--color-text-tertiary)">Cc / Bcc, subject/body overrides, repeat…</summary>' +
        '<div style="margin-top:6px">' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Cc (comma-separated — start typing for known addresses)</label><input type="text" class="esc-cc-addr" list="notif-email-suggest" autocomplete="off" value="' + escapeHtml(((t.cc && t.cc.addresses) || []).join(", ")) + '"></div>' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Bcc (comma-separated — start typing for known addresses)</label><input type="text" class="esc-bcc-addr" list="notif-email-suggest" autocomplete="off" value="' + escapeHtml(((t.bcc && t.bcc.addresses) || []).join(", ")) + '"></div>' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Subject override (optional)</label><input type="text" class="esc-subject tpl-field" value="' + escapeHtml(t.subjectTemplate || "") + '" placeholder="[ESCALATION {escalation.tier}] {asset} unhandled for {escalation.elapsed}"></div>' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Body override (plain text, optional)</label><textarea class="esc-body tpl-field" rows="3" style="width:100%">' + escapeHtml(t.bodyTextTemplate || "") + '</textarea></div>' +
        '<div class="form-group" style="margin-bottom:0"><label style="font-size:0.8rem">Repeat every</label> <input type="number" class="esc-repeat" min="5" value="' + (t.repeatEveryMin != null ? t.repeatEveryMin : "") + '" style="width:80px" placeholder="off"> min, <label style="font-size:0.8rem;display:inline">max</label> <input type="number" class="esc-max" min="1" max="20" value="' + (t.maxRepeats != null ? t.maxRepeats : "") + '" style="width:70px" placeholder="5"> repeats</div>' +
        '</div>' +
      '</details>' +
    '</div>';
  }
  function addEscTier(t) {
    var host = document.getElementById("rule-esc-tiers");
    var tmp = document.createElement("div");
    tmp.innerHTML = escTierHtml(t);
    var row = tmp.firstChild;
    host.appendChild(row);
    row.querySelector(".esc-remove").addEventListener("click", function () { row.remove(); });
    row.querySelectorAll(".tpl-field").forEach(trackTplField);
  }
  ((esc && esc.tiers) || []).forEach(addEscTier);
  document.getElementById("rule-esc-add").addEventListener("click", function () {
    if (emailChannels().length === 0) { showToast("Add an email delivery channel first (Delivery tab)", "info"); return; }
    if (document.querySelectorAll("#rule-esc-tiers .esc-tier").length >= 5) { showToast("Maximum 5 escalation tiers", "info"); return; }
    addEscTier({ channelId: emailChannels()[0].id });
  });

  function collectEscalation() {
    if (!escEnable.checked) return null;
    var tiers = [];
    document.querySelectorAll("#rule-esc-tiers .esc-tier").forEach(function (row) {
      var t = {
        afterMin: Number(row.querySelector(".esc-after").value),
        channelId: row.querySelector(".esc-channel").value,
        to: recipObj(row.querySelector(".esc-to-users"), row.querySelector(".esc-to-addr")) || {},
      };
      var cc = addrRecipObj(row.querySelector(".esc-cc-addr")); if (cc) t.cc = cc;
      var bcc = addrRecipObj(row.querySelector(".esc-bcc-addr")); if (bcc) t.bcc = bcc;
      var subj = row.querySelector(".esc-subject").value.trim(); if (subj) t.subjectTemplate = subj;
      var bodyTxt = row.querySelector(".esc-body").value; if (bodyTxt.trim()) t.bodyTextTemplate = bodyTxt;
      var rep = row.querySelector(".esc-repeat").value;
      if (rep !== "") {
        t.repeatEveryMin = Number(rep);
        var mx = row.querySelector(".esc-max").value;
        if (mx !== "") t.maxRepeats = Number(mx);
      }
      tiers.push(t);
    });
    return { stopOn: document.getElementById("rule-esc-stopon").value, tiers: tiers };
  }

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
      emailComposition: collectEmailComposition(),
      escalation: collectEscalation(),
    };
    return rule;
  }

  document.getElementById("rule-test").addEventListener("click", async function () {
    var box = document.getElementById("rule-preview");
    box.innerHTML = '<p style="color:var(--color-text-tertiary)">Testing…</p>';
    try {
      var res = await api.automations.preview(collectRule());
      if (!res.supported) { box.innerHTML = '<p style="color:var(--color-text-tertiary)">' + escapeHtml(res.note || "Not previewable.") + '</p>'; return; }
      var meeting = (res.matches || []).filter(function (m) { return m.meets; });
      var rowsHtml = (res.matches || []).slice(0, 20).map(function (m) {
        return '<tr><td>' + escapeHtml(m.hostname || m.assetId || "host") + '</td><td>' + escapeHtml(m.dimension || "") + '</td><td>' + escapeHtml(m.value == null ? "n/a" : String(m.value)) + '</td><td>' + (m.meets ? '<span style="color:var(--color-danger)">match</span>' : '<span style="color:var(--color-text-tertiary)">no</span>') + '</td></tr>';
      }).join("");
      box.innerHTML = '<p style="font-size:0.85rem"><strong>' + meeting.length + '</strong> of ' + res.totalEvaluated + ' currently match.</p>' +
        '<div class="table-wrapper" style="max-height:200px;overflow:auto"><table><thead><tr><th>Asset</th><th>Dimension</th><th>Value</th><th>Match</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
      if (res.emailPreview) {
        box.innerHTML += '<div style="border:1px solid var(--color-border);border-radius:6px;padding:0.6rem;margin-top:6px">' +
          '<p style="font-size:0.8rem;margin:0 0 4px"><strong>Composed email preview</strong> (rendered against the first match)</p>' +
          '<p style="font-size:0.85rem;margin:0 0 4px"><strong>Subject:</strong> ' + escapeHtml(res.emailPreview.subject) + '</p>' +
          '<pre style="white-space:pre-wrap;font-size:0.8rem;margin:0;max-height:160px;overflow:auto">' + escapeHtml(res.emailPreview.text) + '</pre>' +
          (res.emailPreview.html ? '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:4px 0 0">+ HTML body (' + res.emailPreview.html.length + ' chars)</p>' : '') +
          '</div>';
      }
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
      if (!t.channelId) return "Delivery " + n + ": pick a channel.";
      var ch = chanById(t.channelId);
      if (ch && isRouted(ch.type)) {
        var hasRecip = (t.recipientUserIds && t.recipientUserIds.length) || (t.addresses && t.addresses.length) ||
          t.recipientScopeRegion || (t.recipientTags && t.recipientTags.length);
        if (!hasRecip) return "Delivery " + n + " (" + ch.name + "): choose at least one recipient — user accounts, a custom email, or the rule's region.";
      }
    }
    if (rule.escalation) {
      var etiers = rule.escalation.tiers || [];
      if (!etiers.length) return "Escalation: add at least one tier, or untick escalation.";
      for (var j = 0; j < etiers.length; j++) {
        var et = etiers[j]; var tn = j + 1;
        if (!et.afterMin || isNaN(et.afterMin) || et.afterMin < 1) return "Escalation tier " + tn + ": enter the delay in minutes (1 or more).";
        if (!et.channelId) return "Escalation tier " + tn + ": pick an email channel.";
        if (!(et.to.recipientUserIds && et.to.recipientUserIds.length) && !(et.to.addresses && et.to.addresses.length)) {
          return "Escalation tier " + tn + ": choose at least one To recipient (user accounts or custom addresses).";
        }
        if (et.repeatEveryMin != null && (isNaN(et.repeatEveryMin) || et.repeatEveryMin < 5)) return "Escalation tier " + tn + ": repeat interval must be 5 minutes or more.";
      }
    }
    return null;
  }

  document.getElementById("rule-save").addEventListener("click", async function () {
    var rule = collectRule();
    var problem = validateRule(rule);
    if (problem) { showToast(problem, "error"); return; }
    // Non-blocking heads-up: composition without any email target does nothing.
    if (rule.emailComposition) {
      var hasEmailTarget = (rule.targets || []).some(function (t) {
        var ch = chanById(t.channelId);
        return ch && isEmailType(ch.type);
      });
      if (!hasEmailTarget) showToast("Email customization saved, but this rule has no email delivery target — add an SMTP / Microsoft 365 target for it to take effect.", "info");
    }
    this.disabled = true;
    try {
      if (existing) await api.automations.update(existing.id, rule);
      else await api.automations.create(rule);
      closeModal();
      showToast(existing ? "Automation saved" : "Automation created", "success");
      if (window._reloadRules) window._reloadRules();
    } catch (err) { this.disabled = false; showToast(err.message || "Save failed", "error"); }
  });
}

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
