/**
 * public/js/assets-maintenance.js
 *
 * Maintenance modal for the Assets page (toolbar → Maintenance, gated by the
 * maintenanceManagement RBAC key). Two tabs:
 *
 *   Create Schedule — name + dynamic asset filter (partial hostname, IP or
 *     subnet CIDR, model, manufacturer, OS, asset type — only MONITORED
 *     assets are eligible) with a debounced live device-list preview, plus a
 *     schedule editor (one-time window or daily/weekly/monthly/yearly
 *     recurrence with time-of-day range and optional active date bounds).
 *     The same form doubles as the editor when a schedule is opened from the
 *     list tab.
 *
 *   Schedules — every schedule with a human-readable date/time summary,
 *     enabled toggle, edit + delete.
 *
 * Also exposes the ad-hoc helper used by the status-pill / edit-modal flows
 * in assets.js: maintCreateAdhoc(assetId, hostname, endLocalIso) creates a
 * one-shot single-asset schedule starting now (the server reconciles inline,
 * so the asset is in maintenance before the call resolves).
 *
 * Builder markup mirrors the tag-criteria builder in server-settings.js
 * (which is NOT loaded on this page) with maint-prefixed ids/classes.
 * Times are SERVER-LOCAL wall-clock — the recurrence engine evaluates
 * schedules against the Polaris server's clock, stated in the UI hint.
 *
 * Depends on globals from app.js (openModal/closeModal/showToast/showConfirm/
 * escapeHtml/canManageMaintenance) and assets.js (_renderTabbedBody/
 * _wireModalTabs), both loaded before this file on assets.html.
 */

/* global api, openModal, closeModal, showToast, showConfirm, escapeHtml,
          _renderTabbedBody, _wireModalTabs, loadAssets */

// ─── Filter vocabulary ───────────────────────────────────────────────────────

var MAINT_CRITERIA_FIELDS = [
  { value: "hostname",     label: "Hostname",         kind: "string" },
  { value: "subnet",       label: "IP / Subnet",      kind: "subnet" },
  { value: "model",        label: "Model",            kind: "string" },
  { value: "manufacturer", label: "Manufacturer",     kind: "string" },
  { value: "os",           label: "Operating system", kind: "string" },
  { value: "osVersion",    label: "OS version",       kind: "string" },
  { value: "assetType",    label: "Asset type",       kind: "assetType" },
];
var MAINT_STRING_OPS = [
  { value: "contains", label: "contains" },
  { value: "exact",    label: "is" },
  { value: "pattern",  label: "matches (wildcard *)" },
];
var MAINT_WEEKDAYS = [
  { value: 0, label: "Sun" }, { value: 1, label: "Mon" }, { value: 2, label: "Tue" },
  { value: 3, label: "Wed" }, { value: 4, label: "Thu" }, { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

var _maintSchedules = [];       // list-tab cache
var _maintEditingId = null;     // schedule id being edited (null = create mode)
var _maintEditingAssetIds = []; // explicit assetIds carried by the edited schedule
var _maintPreviewTimer = null;
var _maintAssetTypesCache = null;

// ─── Local-time formatting ──────────────────────────────────────────────────

function _maintPad(n) { return (n < 10 ? "0" : "") + n; }

/** Date → "YYYY-MM-DDTHH:MM" in local time (datetime-local value format). */
function _maintLocalIso(d) {
  return d.getFullYear() + "-" + _maintPad(d.getMonth() + 1) + "-" + _maintPad(d.getDate()) +
    "T" + _maintPad(d.getHours()) + ":" + _maintPad(d.getMinutes());
}

var _MAINT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function _maintFmtLocal(iso) {
  // "2026-07-12T22:00(:ss)" → "Jul 12 2026 22:00"
  var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  return _MAINT_MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + " " + m[1] + " " + m[4];
}

function _maintFmtDate(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  return _MAINT_MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + " " + m[1];
}

/** Human-readable one-liner for a schedule's recurrence shape. */
function maintScheduleSummary(schedule) {
  if (!schedule || !schedule.kind) return "—";
  if (schedule.kind === "oneshot") {
    return "One-time " + _maintFmtLocal(schedule.startAt) + " → " + _maintFmtLocal(schedule.endAt);
  }
  var time = schedule.startTime && schedule.endTime
    ? " " + schedule.startTime + "–" + schedule.endTime
    : " (all day)";
  var base;
  switch (schedule.freq) {
    case "daily":  base = "Daily" + time; break;
    case "weekly": {
      var days = (schedule.daysOfWeek || []).slice().sort().map(function (d) {
        var w = MAINT_WEEKDAYS.find(function (x) { return x.value === d; });
        return w ? w.label : d;
      }).join(", ");
      base = "Weekly " + days + time;
      break;
    }
    case "monthly": base = "Monthly on day " + schedule.dayOfMonth + time; break;
    case "yearly":  base = "Yearly " + _MAINT_MONTHS[(schedule.month || 1) - 1] + " " + schedule.day + time; break;
    default: base = schedule.freq + time;
  }
  if (schedule.activeFrom || schedule.activeUntil) {
    base += " · " + (schedule.activeFrom ? _maintFmtDate(schedule.activeFrom) : "…") +
      " – " + (schedule.activeUntil ? _maintFmtDate(schedule.activeUntil) : "…");
  }
  return base;
}

// ─── Modal shell ────────────────────────────────────────────────────────────

async function openMaintenanceModal() {
  _maintEditingId = null;
  _maintEditingAssetIds = [];
  var body = _renderTabbedBody("maint", [
    { key: "create", label: "Create Schedule", html: _maintEditorHTML() },
    { key: "list",   label: "Schedules",       html: '<div id="maint-list-body" class="empty-state">Loading…</div>' },
  ]);
  openModal(
    "Maintenance",
    body,
    '<button class="btn btn-secondary" onclick="closeModal()">Close</button>',
    { large: true }
  );
  _wireModalTabs("maint");
  _maintWireEditor();
  _maintReloadList();
}

// ─── Tab 1 — schedule editor ────────────────────────────────────────────────

function _maintFieldKind(field) {
  var f = MAINT_CRITERIA_FIELDS.find(function (x) { return x.value === field; });
  return f ? f.kind : "string";
}

function _maintRuleCellsHTML(field, op, valueStr) {
  var kind = _maintFieldKind(field);
  var opHtml;
  if (kind === "string") {
    // width:auto beats the global `select { width: 100% }` — with basis
    // `auto` that 100% width becomes the flex basis and the op select
    // stretches across the row, crushing the value input.
    opHtml = '<select class="maint-rule-op" style="flex:0 0 auto;width:auto">' +
      MAINT_STRING_OPS.map(function (o) {
        return '<option value="' + o.value + '"' + (o.value === op ? " selected" : "") + '>' + escapeHtml(o.label) + '</option>';
      }).join("") + '</select>';
  } else if (kind === "subnet") {
    opHtml = '<span style="flex:0 0 auto;align-self:center;color:var(--color-text-secondary);font-size:0.82rem">in</span>';
  } else {
    opHtml = '<span style="flex:0 0 auto;align-self:center;color:var(--color-text-secondary);font-size:0.82rem">is</span>';
  }
  var placeholder, listAttr = "";
  if (kind === "subnet") placeholder = "10.1.0.0/16, 10.2.3.4/32";
  else if (kind === "assetType") { placeholder = "firewall, switch"; listAttr = ' list="maint-assettype-list"'; }
  else placeholder = "value, another value";
  return opHtml +
    '<input type="text" class="maint-rule-input" style="flex:1"' + listAttr +
    ' placeholder="' + escapeHtml(placeholder) + '" value="' + escapeHtml(valueStr || "") + '">';
}

function _maintRuleRowHTML(rule) {
  var field = rule ? rule.field : "hostname";
  var op = rule ? (rule.op || "contains") : "contains";
  var valueStr = "";
  if (rule) {
    valueStr = rule.field === "subnet" ? (rule.cidrs || []).join(", ") : (rule.values || []).join(", ");
  }
  var fieldOpts = MAINT_CRITERIA_FIELDS.map(function (f) {
    return '<option value="' + f.value + '"' + (f.value === field ? " selected" : "") + '>' + escapeHtml(f.label) + '</option>';
  }).join("");
  return '<div class="maint-rule" style="display:flex;gap:6px;margin-bottom:6px;align-items:flex-start">' +
    '<select class="maint-rule-field" style="flex:0 0 9.5rem">' + fieldOpts + '</select>' +
    '<div class="maint-rule-cells" style="display:flex;gap:6px;flex:1">' + _maintRuleCellsHTML(field, op, valueStr) + '</div>' +
    '<button type="button" class="maint-rule-remove btn-icon" title="Remove rule" aria-label="Remove rule" ' +
      'style="flex:0 0 auto;border:1px solid var(--color-border);border-radius:4px;background:transparent;color:var(--color-text-secondary);cursor:pointer;width:30px;height:30px">×</button>' +
  '</div>';
}

function _maintEditorHTML() {
  // Default all checked = "every day" (collected as freq=daily).
  var weekdayBoxes = MAINT_WEEKDAYS.map(function (w) {
    return '<label style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;cursor:pointer">' +
      '<input type="checkbox" class="maint-dow" value="' + w.value + '" checked style="width:auto">' + w.label + '</label>';
  }).join("");
  return (
    '<div id="maint-edit-banner" class="hint" style="display:none;margin-bottom:8px;font-weight:600"></div>' +
    '<div class="form-group">' +
      '<label>Schedule name</label>' +
      '<input type="text" id="maint-name" maxlength="200" placeholder="e.g. Shop switch stack patching">' +
    '</div>' +

    '<div class="form-group" style="border-top:1px solid var(--color-border);padding-top:12px">' +
      '<label>Asset filter</label>' +
      '<p class="hint">Assets matching ALL rules enter maintenance while the schedule is active. Only <strong>monitored</strong> assets are eligible. A single IP is a /32 CIDR (e.g. <code>10.2.3.4/32</code>).</p>' +
      '<div id="maint-rules">' + _maintRuleRowHTML(null) + '</div>' +
      '<button type="button" id="maint-add-rule" class="btn btn-secondary btn-sm" style="margin-top:4px">+ Add rule</button>' +
      '<div id="maint-explicit" class="hint" style="display:none;margin-top:6px"></div>' +
      '<datalist id="maint-assettype-list"></datalist>' +
    '</div>' +

    '<div class="form-group">' +
      '<label>Included devices (preview)</label>' +
      '<div id="maint-preview" class="hint" style="font-style:italic">Add a filter rule to preview matching devices.</div>' +
    '</div>' +

    '<div class="form-group" style="border-top:1px solid var(--color-border);padding-top:12px">' +
      '<label>When</label>' +
      '<p class="hint">Times are the Polaris server’s local wall-clock. An end time at or before the start time spans midnight into the next day.</p>' +
      '<label style="display:inline-flex;align-items:center;gap:6px;margin-right:16px;cursor:pointer">' +
        '<input type="radio" name="maint-kind" id="maint-kind-oneshot" value="oneshot" checked style="width:auto"> One-time window' +
      '</label>' +
      '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">' +
        '<input type="radio" name="maint-kind" id="maint-kind-recurring" value="recurring" style="width:auto"> Recurring' +
      '</label>' +

      '<div id="maint-oneshot-block" style="margin-top:10px;display:flex;gap:12px;flex-wrap:wrap">' +
        '<div><label>Start</label><input type="datetime-local" id="maint-start"></div>' +
        '<div><label>End</label><input type="datetime-local" id="maint-end"></div>' +
      '</div>' +

      '<div id="maint-recurring-block" style="margin-top:10px;display:none">' +
        '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">' +
          '<div><label>Repeats</label>' +
            '<select id="maint-freq" style="width:auto">' +
              '<option value="days">Specific days of the week</option>' +
              '<option value="monthly">Monthly</option><option value="yearly">Yearly</option>' +
            '</select></div>' +
          '<div id="maint-monthly-block" style="display:none"><label>Day of month</label>' +
            '<input type="number" id="maint-daymonth" min="1" max="31" value="1" style="max-width:90px">' +
            '<span class="hint" style="display:block">31 = last-day clamp in short months</span></div>' +
          '<div id="maint-yearly-block" style="display:none"><label>Month / day</label>' +
            '<select id="maint-month" style="max-width:110px">' +
              _MAINT_MONTHS.map(function (m, i) { return '<option value="' + (i + 1) + '">' + m + '</option>'; }).join("") +
            '</select> ' +
            '<input type="number" id="maint-day" min="1" max="31" value="1" style="max-width:80px">' +
          '</div>' +
        '</div>' +
        '<div id="maint-weekly-block" style="margin-top:8px">' +
          '<label>Days</label>' +
          '<div>' + weekdayBoxes + '</div>' +
          '<span class="hint">All days checked = every day.</span>' +
        '</div>' +
        '<div style="margin-top:10px">' +
          '<label>Time range</label>' +
          '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin-right:14px">' +
            '<input type="checkbox" id="maint-allday" style="width:auto"> All day' +
          '</label>' +
          '<span id="maint-time-range">' +
            '<input type="time" id="maint-time-start" value="20:00"> &ndash; <input type="time" id="maint-time-end" value="02:00">' +
          '</span>' +
          '<span class="hint" style="display:block">An end at or before the start runs into the next day — 20:00 &ndash; 02:00 ends at 2 AM the following morning (the day checkboxes match the START day).</span>' +
        '</div>' +
        '<div style="margin-top:10px">' +
          '<label>Date range (optional)</label>' +
          '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
            '<input type="date" id="maint-active-from" style="width:auto"> &ndash; ' +
            '<input type="date" id="maint-active-until" style="width:auto">' +
          '</div>' +
          '<span class="hint">First / last day the schedule applies (inclusive). Leave empty for no bounds.</span>' +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="form-group" style="border-top:1px solid var(--color-border);padding-top:12px">' +
      '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin:0">' +
        '<input type="checkbox" id="maint-suppress-children" checked style="width:auto"> Mark dependent devices as down' +
      '</label>' +
      '<p class="hint" style="margin:4px 0 0">Devices behind an in-maintenance asset go into dependency suppression (their notifications pause) for the window — as if the asset went offline. Uncheck when dependents stay reachable (redundant path, clustered parent) and should keep monitoring and alerting normally.</p>' +
    '</div>' +

    '<div class="form-group" style="display:flex;align-items:center;gap:16px;border-top:1px solid var(--color-border);padding-top:12px">' +
      '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin:0">' +
        '<input type="checkbox" id="maint-enabled" checked style="width:auto"> Enabled' +
      '</label>' +
      '<button type="button" class="btn btn-primary" id="maint-save">Create Schedule</button>' +
      '<button type="button" class="btn btn-secondary" id="maint-cancel-edit" style="display:none">Cancel Edit</button>' +
    '</div>'
  );
}

function _maintCollectCriteria() {
  var rules = [];
  document.querySelectorAll("#maint-rules .maint-rule").forEach(function (row) {
    var field = row.querySelector(".maint-rule-field").value;
    var input = row.querySelector(".maint-rule-input");
    var parts = (input && input.value ? input.value : "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) return;
    if (field === "subnet") {
      // Bare IPs are promoted to /32 (v4) or /128 (v6) so "10.2.3.4" works.
      var cidrs = parts.map(function (p) {
        if (p.indexOf("/") !== -1) return p;
        return p.indexOf(":") !== -1 ? p + "/128" : p + "/32";
      });
      rules.push({ field: "subnet", op: "inCidr", cidrs: cidrs });
    } else {
      var kind = _maintFieldKind(field);
      var op = "exact";
      if (kind === "string") {
        var opSel = row.querySelector(".maint-rule-op");
        if (opSel) op = opSel.value;
      }
      rules.push({ field: field, op: op, values: parts });
    }
  });
  return rules.length ? { version: 1, match: "all", rules: rules } : null;
}

function _maintCollectSchedule() {
  var oneshot = document.getElementById("maint-kind-oneshot").checked;
  if (oneshot) {
    var startAt = document.getElementById("maint-start").value;
    var endAt = document.getElementById("maint-end").value;
    if (!startAt || !endAt) throw new Error("Start and end are required for a one-time window");
    return { version: 1, kind: "oneshot", startAt: startAt, endAt: endAt };
  }
  var freq = document.getElementById("maint-freq").value;
  var out = { version: 1, kind: "recurring", freq: freq };
  if (freq === "days") {
    // UI mode "specific days" maps onto the stored shape: all 7 checked =
    // freq "daily", a subset = freq "weekly" + daysOfWeek.
    var days = Array.prototype.map.call(
      document.querySelectorAll(".maint-dow:checked"),
      function (cb) { return Number(cb.value); }
    );
    if (!days.length) throw new Error("Pick at least one day of the week");
    if (days.length === 7) {
      out.freq = "daily";
    } else {
      out.freq = "weekly";
      out.daysOfWeek = days;
    }
  }
  if (freq === "monthly") out.dayOfMonth = parseInt(document.getElementById("maint-daymonth").value, 10) || 1;
  if (freq === "yearly") {
    out.month = parseInt(document.getElementById("maint-month").value, 10) || 1;
    out.day = parseInt(document.getElementById("maint-day").value, 10) || 1;
  }
  if (!document.getElementById("maint-allday").checked) {
    var ts = document.getElementById("maint-time-start").value;
    var te = document.getElementById("maint-time-end").value;
    if (!ts || !te) throw new Error("Start and end times are required (or check All day)");
    out.startTime = ts;
    out.endTime = te;
  }
  var af = document.getElementById("maint-active-from").value;
  var au = document.getElementById("maint-active-until").value;
  if (af) out.activeFrom = af;
  if (au) out.activeUntil = au;
  return out;
}

function _maintRefreshPreview() {
  var el = document.getElementById("maint-preview");
  if (!el) return;
  var criteria = _maintCollectCriteria();
  if (!criteria && !_maintEditingAssetIds.length) {
    el.innerHTML = "Add a filter rule to preview matching devices.";
    return;
  }
  el.textContent = "Checking…";
  if (_maintPreviewTimer) clearTimeout(_maintPreviewTimer);
  _maintPreviewTimer = setTimeout(async function () {
    try {
      var res = await api.maintenanceSchedules.preview({ criteria: criteria, assetIds: _maintEditingAssetIds });
      if (!res.total) {
        el.innerHTML = '<em>No monitored assets match.</em>';
        return;
      }
      var rows = res.assets.map(function (a) {
        return "<tr><td>" + escapeHtml(a.hostname || "—") + "</td><td>" + escapeHtml(a.ipAddress || "—") +
          "</td><td>" + escapeHtml([a.manufacturer, a.model].filter(Boolean).join(" ") || "—") + "</td></tr>";
      }).join("");
      var more = res.total > res.assets.length
        ? '<div class="hint" style="font-style:italic">…and ' + (res.total - res.assets.length) + " more</div>"
        : "";
      el.innerHTML =
        "<div><strong>" + res.total + "</strong> monitored asset" + (res.total === 1 ? "" : "s") + " included</div>" +
        '<div style="max-height:180px;overflow-y:auto;margin-top:4px;border:1px solid var(--color-border);border-radius:4px">' +
          '<table class="data-table" style="margin:0"><thead><tr><th>Hostname</th><th>IP</th><th>Model</th></tr></thead>' +
          "<tbody>" + rows + "</tbody></table></div>" + more;
    } catch (err) {
      el.textContent = "Preview unavailable: " + (err && err.message ? err.message : "error");
    }
  }, 400);
}

function _maintSyncScheduleBlocks() {
  var oneshot = document.getElementById("maint-kind-oneshot").checked;
  document.getElementById("maint-oneshot-block").style.display = oneshot ? "flex" : "none";
  document.getElementById("maint-recurring-block").style.display = oneshot ? "none" : "";
  var freq = document.getElementById("maint-freq").value;
  document.getElementById("maint-weekly-block").style.display  = (!oneshot && freq === "days")    ? "" : "none";
  document.getElementById("maint-monthly-block").style.display = (!oneshot && freq === "monthly") ? "" : "none";
  document.getElementById("maint-yearly-block").style.display  = (!oneshot && freq === "yearly")  ? "" : "none";
  document.getElementById("maint-time-range").style.display =
    document.getElementById("maint-allday").checked ? "none" : "";
}

function _maintSyncExplicitLine() {
  var el = document.getElementById("maint-explicit");
  if (!el) return;
  if (!_maintEditingAssetIds.length) { el.style.display = "none"; return; }
  el.style.display = "";
  el.innerHTML = "Also explicitly includes <strong>" + _maintEditingAssetIds.length + "</strong> asset" +
    (_maintEditingAssetIds.length === 1 ? "" : "s") +
    ' (ad-hoc selection) <button type="button" class="btn btn-secondary btn-sm" id="maint-clear-explicit">Remove</button>';
  var btn = document.getElementById("maint-clear-explicit");
  if (btn) btn.addEventListener("click", function () {
    _maintEditingAssetIds = [];
    _maintSyncExplicitLine();
    _maintRefreshPreview();
  });
}

async function _maintWireEditor() {
  // Asset-type datalist (best-effort).
  var dl = document.getElementById("maint-assettype-list");
  if (dl) {
    if (!_maintAssetTypesCache) {
      try { _maintAssetTypesCache = await api.assetTypes.list(); } catch (e) { _maintAssetTypesCache = []; }
    }
    dl.innerHTML = (_maintAssetTypesCache || []).map(function (t) {
      return '<option value="' + escapeHtml(t.name) + '">' + escapeHtml(t.label || t.name) + "</option>";
    }).join("");
  }

  // Sensible one-shot defaults: now → now + 2h.
  var now = new Date();
  document.getElementById("maint-start").value = _maintLocalIso(now);
  document.getElementById("maint-end").value = _maintLocalIso(new Date(now.getTime() + 2 * 60 * 60 * 1000));

  document.getElementById("maint-add-rule").addEventListener("click", function () {
    document.getElementById("maint-rules").insertAdjacentHTML("beforeend", _maintRuleRowHTML(null));
  });
  var rulesEl = document.getElementById("maint-rules");
  rulesEl.addEventListener("change", function (e) {
    var fieldSel = e.target.closest ? e.target.closest(".maint-rule-field") : null;
    if (fieldSel) {
      var row = fieldSel.closest(".maint-rule");
      row.querySelector(".maint-rule-cells").innerHTML = _maintRuleCellsHTML(fieldSel.value, "contains", "");
    }
    _maintRefreshPreview();
  });
  rulesEl.addEventListener("input", function () { _maintRefreshPreview(); });
  rulesEl.addEventListener("click", function (e) {
    var rm = e.target.closest ? e.target.closest(".maint-rule-remove") : null;
    if (rm) {
      var row = rm.closest(".maint-rule");
      if (row) row.remove();
      _maintRefreshPreview();
    }
  });

  ["maint-kind-oneshot", "maint-kind-recurring", "maint-freq", "maint-allday"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", _maintSyncScheduleBlocks);
  });
  _maintSyncScheduleBlocks();

  document.getElementById("maint-save").addEventListener("click", _maintSave);
  document.getElementById("maint-cancel-edit").addEventListener("click", function () {
    _maintResetEditor();
  });
}

function _maintResetEditor() {
  _maintEditingId = null;
  _maintEditingAssetIds = [];
  document.getElementById("maint-name").value = "";
  document.getElementById("maint-rules").innerHTML = _maintRuleRowHTML(null);
  document.getElementById("maint-enabled").checked = true;
  document.getElementById("maint-suppress-children").checked = true;
  document.getElementById("maint-kind-oneshot").checked = true;
  document.getElementById("maint-freq").value = "days";
  document.querySelectorAll(".maint-dow").forEach(function (cb) { cb.checked = true; });
  var now = new Date();
  document.getElementById("maint-start").value = _maintLocalIso(now);
  document.getElementById("maint-end").value = _maintLocalIso(new Date(now.getTime() + 2 * 60 * 60 * 1000));
  document.getElementById("maint-edit-banner").style.display = "none";
  document.getElementById("maint-save").textContent = "Create Schedule";
  document.getElementById("maint-cancel-edit").style.display = "none";
  _maintSyncScheduleBlocks();
  _maintSyncExplicitLine();
  _maintRefreshPreview();
}

/** Load a schedule row into the editor and switch to the Create tab. */
function _maintLoadIntoEditor(row) {
  _maintEditingId = row.id;
  _maintEditingAssetIds = Array.isArray(row.assetIds) ? row.assetIds.slice() : [];
  document.getElementById("maint-name").value = row.name || "";
  document.getElementById("maint-enabled").checked = row.enabled !== false;
  document.getElementById("maint-suppress-children").checked = row.suppressChildren !== false;

  var criteria = row.criteria;
  var rulesEl = document.getElementById("maint-rules");
  rulesEl.innerHTML = criteria && criteria.rules && criteria.rules.length
    ? criteria.rules.map(function (r) { return _maintRuleRowHTML(r); }).join("")
    : _maintRuleRowHTML(null);

  var s = row.schedule || {};
  var oneshot = s.kind === "oneshot";
  document.getElementById("maint-kind-oneshot").checked = oneshot;
  document.getElementById("maint-kind-recurring").checked = !oneshot;
  if (oneshot) {
    document.getElementById("maint-start").value = String(s.startAt || "").slice(0, 16);
    document.getElementById("maint-end").value = String(s.endAt || "").slice(0, 16);
  } else {
    // Stored daily/weekly both load as the "specific days" UI mode: daily =
    // all boxes checked, weekly = its daysOfWeek subset.
    var storedFreq = s.freq || "daily";
    var daysMode = storedFreq === "daily" || storedFreq === "weekly";
    document.getElementById("maint-freq").value = daysMode ? "days" : storedFreq;
    document.querySelectorAll(".maint-dow").forEach(function (cb) {
      cb.checked = storedFreq === "weekly"
        ? Array.isArray(s.daysOfWeek) && s.daysOfWeek.indexOf(Number(cb.value)) !== -1
        : true;
    });
    if (s.dayOfMonth) document.getElementById("maint-daymonth").value = s.dayOfMonth;
    if (s.month) document.getElementById("maint-month").value = s.month;
    if (s.day) document.getElementById("maint-day").value = s.day;
    var allDay = !s.startTime;
    document.getElementById("maint-allday").checked = allDay;
    if (!allDay) {
      document.getElementById("maint-time-start").value = s.startTime;
      document.getElementById("maint-time-end").value = s.endTime;
    }
    document.getElementById("maint-active-from").value = s.activeFrom || "";
    document.getElementById("maint-active-until").value = s.activeUntil || "";
  }

  var banner = document.getElementById("maint-edit-banner");
  banner.textContent = "Editing schedule: " + (row.name || row.id);
  banner.style.display = "";
  document.getElementById("maint-save").textContent = "Save Changes";
  document.getElementById("maint-cancel-edit").style.display = "";
  _maintSyncScheduleBlocks();
  _maintSyncExplicitLine();
  _maintRefreshPreview();

  var createTab = document.querySelector('#maint-tabs .page-tab[data-tab="create"]');
  if (createTab) createTab.click();
}

async function _maintSave() {
  var btn = document.getElementById("maint-save");
  btn.disabled = true;
  try {
    var name = document.getElementById("maint-name").value.trim();
    if (!name) throw new Error("Schedule name is required");
    var criteria = _maintCollectCriteria();
    if (!criteria && !_maintEditingAssetIds.length) throw new Error("Add at least one filter rule");
    var body = {
      name: name,
      enabled: document.getElementById("maint-enabled").checked,
      criteria: criteria,
      assetIds: _maintEditingAssetIds,
      schedule: _maintCollectSchedule(),
      suppressChildren: document.getElementById("maint-suppress-children").checked,
    };
    if (_maintEditingId) {
      await api.maintenanceSchedules.update(_maintEditingId, body);
      showToast("Maintenance schedule updated");
    } else {
      await api.maintenanceSchedules.create(body);
      showToast("Maintenance schedule created");
    }
    _maintResetEditor();
    await _maintReloadList();
    // Statuses may have flipped immediately (inline reconcile) — refresh the table.
    if (typeof loadAssets === "function") loadAssets();
    var listTab = document.querySelector('#maint-tabs .page-tab[data-tab="list"]');
    if (listTab) listTab.click();
  } catch (err) {
    showToast(err && err.message ? err.message : "Failed to save schedule", "error");
  } finally {
    btn.disabled = false;
  }
}

// ─── Tab 2 — schedules list ─────────────────────────────────────────────────

function _maintTargetsSummary(row) {
  var parts = [];
  var ruleCount = row.criteria && row.criteria.rules ? row.criteria.rules.length : 0;
  if (ruleCount) parts.push(ruleCount + " filter rule" + (ruleCount === 1 ? "" : "s"));
  var explicit = Array.isArray(row.assetIds) ? row.assetIds.length : 0;
  if (explicit) parts.push(explicit + " explicit asset" + (explicit === 1 ? "" : "s"));
  return parts.join(" + ") || "—";
}

async function _maintReloadList() {
  var el = document.getElementById("maint-list-body");
  if (!el) return;
  try {
    var res = await api.maintenanceSchedules.list();
    _maintSchedules = res.schedules || [];
  } catch (err) {
    el.innerHTML = '<div class="empty-state">' + escapeHtml(err.message || "Failed to load schedules") + "</div>";
    return;
  }
  if (!_maintSchedules.length) {
    el.innerHTML = '<div class="empty-state">No maintenance schedules yet. Create one on the Create Schedule tab.</div>';
    return;
  }
  var rows = _maintSchedules.map(function (s) {
    return "<tr>" +
      "<td><a href=\"#\" class=\"maint-edit-link\" data-id=\"" + s.id + "\">" + escapeHtml(s.name) + "</a></td>" +
      "<td>" + escapeHtml(maintScheduleSummary(s.schedule)) + "</td>" +
      '<td style="white-space:nowrap">' + escapeHtml(_maintTargetsSummary(s)) + "</td>" +
      '<td style="white-space:nowrap">' + (s.suppressChildren !== false ? "Marked down" : "Unaffected") + "</td>" +
      '<td style="white-space:nowrap"><label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">' +
        '<input type="checkbox" class="maint-enable-toggle" data-id="' + s.id + '"' + (s.enabled ? " checked" : "") + ' style="width:auto">' +
        (s.enabled ? "Enabled" : "Disabled") + "</label></td>" +
      '<td style="white-space:nowrap">' +
        '<button type="button" class="btn btn-secondary btn-sm maint-edit-btn" data-id="' + s.id + '">Edit</button> ' +
        '<button type="button" class="btn btn-danger btn-sm maint-delete-btn" data-id="' + s.id + '">Delete</button>' +
      "</td></tr>";
  }).join("");
  el.innerHTML =
    '<table class="data-table"><thead><tr style="white-space:nowrap">' +
    '<th>Name</th><th>Schedule</th><th>Targets</th><th title="Whether devices behind an in-maintenance asset are dependency-suppressed for the window">Dependents</th><th>State</th><th></th>' +
    "</tr></thead><tbody>" + rows + "</tbody></table>" +
    '<p class="hint" style="margin-top:8px">Disabling or deleting a schedule ends its active maintenance windows immediately and restores asset statuses.</p>';

  el.querySelectorAll(".maint-edit-btn, .maint-edit-link").forEach(function (b) {
    b.addEventListener("click", function (e) {
      e.preventDefault();
      var row = _maintSchedules.find(function (s) { return s.id === b.getAttribute("data-id"); });
      if (row) _maintLoadIntoEditor(row);
    });
  });
  el.querySelectorAll(".maint-enable-toggle").forEach(function (cb) {
    cb.addEventListener("change", async function () {
      var row = _maintSchedules.find(function (s) { return s.id === cb.getAttribute("data-id"); });
      if (!row) return;
      try {
        await api.maintenanceSchedules.update(row.id, {
          name: row.name,
          enabled: cb.checked,
          criteria: row.criteria || null,
          assetIds: row.assetIds || [],
          schedule: row.schedule,
          // Pass through — normalizeInput defaults a missing value to true,
          // which would silently flip an opted-out schedule.
          suppressChildren: row.suppressChildren !== false,
        });
        showToast(cb.checked ? "Schedule enabled" : "Schedule disabled");
        await _maintReloadList();
        if (typeof loadAssets === "function") loadAssets();
      } catch (err) {
        showToast(err.message || "Failed to update schedule", "error");
        cb.checked = !cb.checked;
      }
    });
  });
  el.querySelectorAll(".maint-delete-btn").forEach(function (b) {
    b.addEventListener("click", async function () {
      var row = _maintSchedules.find(function (s) { return s.id === b.getAttribute("data-id"); });
      if (!row) return;
      var ok = await showConfirm('Delete maintenance schedule "' + row.name + '"? Active windows end immediately and asset statuses are restored.');
      if (!ok) return;
      try {
        await api.maintenanceSchedules.delete(row.id);
        showToast("Schedule deleted");
        await _maintReloadList();
        if (typeof loadAssets === "function") loadAssets();
      } catch (err) {
        showToast(err.message || "Failed to delete schedule", "error");
      }
    });
  });
}

// ─── Ad-hoc entry (status pill / edit modal) ────────────────────────────────

/**
 * Create a one-shot single-asset maintenance schedule starting now. The
 * server reconciles inline, so the asset is already in maintenance when the
 * promise resolves. endLocalIso is a datetime-local value ("YYYY-MM-DDTHH:MM").
 * opts.suppressChildren (default true) — whether dependents behind the asset
 * are dependency-suppressed for the window.
 */
async function maintCreateAdhoc(assetId, hostname, endLocalIso, opts) {
  return api.maintenanceSchedules.create({
    name: "Ad-hoc — " + (hostname || assetId),
    assetIds: [assetId],
    schedule: {
      version: 1,
      kind: "oneshot",
      startAt: _maintLocalIso(new Date()),
      endAt: endLocalIso,
    },
    suppressChildren: !(opts && opts.suppressChildren === false),
  });
}

window.openMaintenanceModal = openMaintenanceModal;
window.maintCreateAdhoc = maintCreateAdhoc;
window.maintScheduleSummary = maintScheduleSummary;
window.maintLocalIso = _maintLocalIso;
