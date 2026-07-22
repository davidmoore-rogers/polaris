/**
 * public/js/automations.js — Automations page (Alerts + Automations + Delivery tabs).
 *
 * Automations tab (default, gated automationManagement): automation list;
 * create/edit opens the 5-step wizard in automations-wizard.js. Delivery tab:
 * the NotificationChannel registry. Scripts tab: the AutomationScript
 * registry. The triggered-alert LIST no longer lives here — alerts surface on
 * the dashboard's Active Alerts widget + the asset-details Alerts tab (a
 * dedicated alerts widget rework is planned).
 */

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
  var canManage = false;
  var canEditRules = false;
  var canReadScripts = false;
  var canEditScripts = false;

  function applyPermGatedUI() {
    canManage = permAtLeast("automationManagement", "read");
    canEditRules = permAtLeast("automationManagement", "fullwrite");
    canReadScripts = permAtLeast("automationScripts", "read");
    canEditScripts = permAtLeast("automationScripts", "fullwrite");

    var mb = document.getElementById("auto-tab-manage-btn");
    if (mb) mb.style.display = canManage ? "" : "none";
    var db = document.getElementById("auto-tab-delivery-btn");
    if (db) db.style.display = canManage ? "" : "none";
    var sb = document.getElementById("auto-tab-scripts-btn");
    if (sb) sb.style.display = canReadScripts ? "" : "none";
    var activeKey = (document.querySelector("#auto-tabs .page-tab.active") || {}).getAttribute
      ? document.querySelector("#auto-tabs .page-tab.active").getAttribute("data-tab") : "manage";
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
    var asBtn = document.getElementById("btn-add-script");
    if (asBtn) {
      asBtn.style.display = canEditScripts && activeKey === "scripts" ? "" : "none";
      if (canEditScripts && !asBtn._wired) { asBtn._wired = true; asBtn.addEventListener("click", function () { openScriptModal(null); }); }
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
      var asBtn2 = document.getElementById("btn-add-script");
      if (asBtn2 && canEditScripts) asBtn2.style.display = key === "scripts" ? "" : "none";
      if (key === "manage" && !_rulesSF) initRulesTab();
      if (key === "delivery") loadChannelsTab();
      if (key === "scripts") loadScriptsTab();
    });
  });

  document.getElementById("btn-refresh").addEventListener("click", function () {
    var active = document.querySelector("#auto-tabs .page-tab.active");
    var key = active ? active.getAttribute("data-tab") : "manage";
    if (key === "delivery") loadChannelsTab();
    else if (key === "scripts") loadScriptsTab();
    else loadRules();
  });

  // Apply permission-gated UI (tab visibility, header buttons) once /auth/me
  // has populated the permission matrix, then boot the default (Automations) tab.
  function bootPage() {
    applyPermGatedUI();
    if (canManage && !_rulesSF) initRulesTab();
  }
  if (typeof userReady !== "undefined" && userReady && userReady.then) {
    userReady.then(bootPage);
  } else {
    bootPage();
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
    if (scope.manufacturers && scope.manufacturers.length) parts.push("mfr: " + scope.manufacturers.join("/"));
    if (scope.models && scope.models.length) parts.push("model: " + scope.models.join("/"));
    if (scope.subnetCidrs && scope.subnetCidrs.length) parts.push("subnets: " + scope.subnetCidrs.join("/"));
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

// ═══════════════════════════════ Scripts tab ═══════════════════════════════
// AutomationScript registry — the scripts `script` actions reference. Gated
// automationScripts (read = view; fullwrite = CUD + test-run). RCE-equivalent
// surface: every card + modal carries the human-review reminder, and the
// server audits creation/body changes with sha256 checksums.

var _awScriptList = null;

async function loadScriptsTab() {
  var container = document.getElementById("scripts-list");
  if (!container) return;
  if (!_ruleSchema) { try { _ruleSchema = await api.automations.schema(); } catch (_e) {} }
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    var resp = await api.automationScripts.list();
    _awScriptList = (resp && resp.scripts) || [];
    _awScripts = _awScriptList; // keep the wizard's picker cache in sync
    renderScriptsList(_awScriptList);
  } catch (err) {
    container.innerHTML = '<p class="empty-state">Error: ' + escapeHtml(err.message || "load failed") + '</p>';
  }
}

function renderScriptsList(scripts) {
  var container = document.getElementById("scripts-list");
  if (!container) return;
  var canEdit = permAtLeast("automationScripts", "fullwrite");
  if (!scripts.length) {
    container.innerHTML = '<p class="empty-state">No scripts yet' + (canEdit ? ' — click "+ Add script" to create one.' : "") + '</p>';
    return;
  }
  container.innerHTML = scripts.map(function (sc) {
    var runTargetLabel = sc.runTarget === "either" ? "server or agent" : sc.runTarget;
    var actions = canEdit
      ? '<button class="btn btn-sm btn-secondary script-test" data-id="' + sc.id + '">Test run</button> ' +
        '<button class="btn btn-sm btn-secondary script-edit" data-id="' + sc.id + '">Edit</button> ' +
        '<button class="btn btn-sm btn-danger script-del" data-id="' + sc.id + '">Delete</button>'
      : "";
    return '<div class="card" style="margin-bottom:0.75rem;padding:0.9rem">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<strong>' + escapeHtml(sc.name) + '</strong>' +
        '<span class="badge">' + escapeHtml(sc.interpreter) + '</span>' +
        '<span class="badge">runs on ' + escapeHtml(runTargetLabel) + '</span>' +
        (sc.enabled ? "" : '<span class="badge" style="opacity:0.7">disabled</span>') +
        '<span style="margin-left:auto">' + actions + '</span>' +
      '</div>' +
      (sc.description ? '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin:6px 0 0">' + escapeHtml(sc.description) + '</p>' : "") +
      '<p style="font-size:0.75rem;color:var(--color-text-tertiary);margin:6px 0 0;font-family:var(--font-mono)">timeout ' + sc.timeoutSec + 's · sha256 ' + escapeHtml((sc.sha256 || "").slice(0, 12)) + '…</p>' +
      '<div class="script-test-out" data-id="' + sc.id + '"></div>' +
    '</div>';
  }).join("");

  container.querySelectorAll(".script-edit").forEach(function (b) {
    b.addEventListener("click", function () {
      var sc = _awScriptList.find(function (x) { return x.id === b.dataset.id; });
      if (sc) openScriptModal(sc);
    });
  });
  container.querySelectorAll(".script-del").forEach(function (b) {
    b.addEventListener("click", async function () {
      var sc = _awScriptList.find(function (x) { return x.id === b.dataset.id; });
      if (!sc) return;
      if (!(await showConfirm('Delete script "' + sc.name + '"? Automations referencing it must drop their script actions first (the server refuses otherwise).'))) return;
      try { await api.automationScripts.delete(sc.id); showToast("Script deleted", "success"); loadScriptsTab(); }
      catch (err) { showToast(err.message || "Delete failed", "error"); }
    });
  });
  container.querySelectorAll(".script-test").forEach(function (b) {
    b.addEventListener("click", function () {
      var sc = _awScriptList.find(function (x) { return x.id === b.dataset.id; });
      if (sc) runScriptTest(sc, b);
    });
  });
}

// Server-side test run: enqueue (202 + runId), then poll the run until it
// completes (the 5s runner job executes it) and render exit code + output.
async function runScriptTest(sc, btn) {
  var out = document.querySelector('.script-test-out[data-id="' + sc.id + '"]');
  if (sc.runTarget === "agent") { showToast("Agent-only scripts can't be test-run from here — trigger them through an automation on a real asset.", "info"); return; }
  if (!(await showConfirm('Run "' + sc.name + '" on the Polaris server NOW (as the service account)?'))) return;
  btn.disabled = true;
  if (out) out.innerHTML = '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:6px 0 0">Queued…</p>';
  try {
    var res = await api.automationScripts.testRun(sc.id, {});
    var runId = res.runId;
    var tries = 0;
    var poll = async function () {
      tries++;
      var rr;
      try { rr = await api.automationScripts.run(runId); }
      catch (_e) { rr = null; }
      var run = rr && rr.run;
      if (run && (run.status === "succeeded" || run.status === "failed" || run.status === "timeout")) {
        var color = run.status === "succeeded" ? "var(--color-success)" : "var(--color-danger)";
        if (out) out.innerHTML =
          '<div style="border:1px solid var(--color-border);border-radius:6px;padding:0.5rem;margin-top:6px">' +
            '<p style="font-size:0.8rem;margin:0"><strong style="color:' + color + '">' + escapeHtml(run.status) + '</strong> (exit ' + (run.exitCode != null ? run.exitCode : "n/a") + ')</p>' +
            (run.stdout ? '<pre style="white-space:pre-wrap;font-size:0.75rem;max-height:160px;overflow:auto;margin:4px 0 0">' + escapeHtml(run.stdout) + '</pre>' : "") +
            (run.stderr ? '<pre style="white-space:pre-wrap;font-size:0.75rem;max-height:120px;overflow:auto;margin:4px 0 0;color:var(--color-danger)">' + escapeHtml(run.stderr) + '</pre>' : "") +
          '</div>';
        btn.disabled = false;
        return;
      }
      if (tries > 60) { if (out) out.innerHTML = '<p style="font-size:0.8rem;color:var(--color-danger);margin:6px 0 0">Timed out waiting for the run to complete.</p>'; btn.disabled = false; return; }
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 2000);
  } catch (err) {
    if (out) out.innerHTML = "";
    btn.disabled = false;
    showToast(err.message || "Test run failed", "error");
  }
}

function openScriptModal(existing) {
  var s = _ruleSchema || {};
  var meta = s.scriptMeta || { languages: ["bash", "sh", "powershell", "cmd", "python3"], runOnOptions: ["server", "agent"], maxTimeoutSec: 600 };
  var sc = existing || {};
  function optList(list, sel) {
    return (list || []).map(function (v) { return '<option value="' + escapeHtml(v) + '"' + (v === sel ? " selected" : "") + '>' + escapeHtml(v) + '</option>'; }).join("");
  }
  var body =
    '<div class="form-group"><label>Name</label><input type="text" id="script-name" value="' + escapeHtml(sc.name || "") + '" placeholder="e.g. restart-print-spooler"></div>' +
    '<div class="form-group"><label>Description (optional)</label><input type="text" id="script-desc" value="' + escapeHtml(sc.description || "") + '"></div>' +
    '<div class="form-group"><label>Interpreter</label><select id="script-interp">' + optList(meta.languages, sc.interpreter || "bash") + '</select></div>' +
    '<div class="form-group"><label>Runs on</label><select id="script-target">' +
      '<option value="server"' + ((sc.runTarget || "server") === "server" ? " selected" : "") + '>the Polaris server</option>' +
      '<option value="agent"' + (sc.runTarget === "agent" ? " selected" : "") + '>the triggering asset’s agent</option>' +
      '<option value="either"' + (sc.runTarget === "either" ? " selected" : "") + '>either</option>' +
    '</select></div>' +
    '<div class="form-group"><label>Script body</label><textarea id="script-body" rows="12" style="width:100%;font-family:var(--font-mono);font-size:0.82rem" spellcheck="false">' + escapeHtml(sc.body || "") + '</textarea>' +
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:4px 0 0">Arguments arrive as one positional parameter ($1 / %1); alert context rides POLARIS_ALERT_ID / POLARIS_RULE / POLARIS_ASSET environment variables.</p></div>' +
    '<div class="form-group"><label>Default timeout (seconds, 1–' + (meta.maxTimeoutSec || 600) + ')</label><input type="number" id="script-timeout" min="1" max="' + (meta.maxTimeoutSec || 600) + '" value="' + (sc.timeoutSec || 60) + '"></div>' +
    '<div class="form-group"><label><input type="checkbox" id="script-enabled"' + (sc.enabled === false ? "" : " checked") + '> Enabled</label></div>' +
    '<p style="font-size:0.8rem;color:var(--color-warning,#d97706);margin:0">' + escapeHtml(meta.help || "Scripts execute with full privileges — a human must review every script before enabling it in production.") + '</p>';
  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="script-save">' + (existing ? "Save changes" : "Create script") + '</button>';
  openModal(existing ? "Edit script" : "New script", body, footer, { wide: true });

  document.getElementById("script-save").addEventListener("click", async function () {
    var payload = {
      name: document.getElementById("script-name").value.trim(),
      description: document.getElementById("script-desc").value.trim() || null,
      interpreter: document.getElementById("script-interp").value,
      runTarget: document.getElementById("script-target").value,
      body: document.getElementById("script-body").value,
      timeoutSec: Number(document.getElementById("script-timeout").value) || 60,
      enabled: document.getElementById("script-enabled").checked,
    };
    if (!payload.name) { showToast("Name is required.", "error"); return; }
    if (!payload.body.trim()) { showToast("Script body is required.", "error"); return; }
    this.disabled = true;
    try {
      if (existing) await api.automationScripts.update(existing.id, payload);
      else await api.automationScripts.create(payload);
      closeModal();
      showToast(existing ? "Script saved" : "Script created", "success");
      loadScriptsTab();
    } catch (err) { this.disabled = false; showToast(err.message || "Save failed", "error"); }
  });
}
