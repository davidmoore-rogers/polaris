/**
 * public/js/automations-wizard.js — the 5-step automation builder.
 *
 * openAutomationWizard(existing) replaces the old single-form rule builder:
 *   Step 1  Name & description (+ severity + enabled)
 *   Step 2  Asset filtering (scope) — live matched-device preview
 *   Step 3  Trigger conditions — live plain-English sentence + current-value test
 *   Step 4  Reset conditions — auto (hysteresis + clear-sustain) / timed / manual
 *           + re-notify cooldown, live sentence
 *   Step 5  Automations (actions: notify / api_call / script) + escalation
 *           tiers of actions + review summary
 *
 * Mechanics: shared stepper CSS from styles.css (see TEMPLATES.md → "Wizard
 * (stepper modal)"); free navigation to visited steps (all steps unlocked in
 * edit mode); one module-scope draft (`_aw`, rule-shape v2) collected on every
 * navigation, hard-validated only on Next/Save. Loaded AFTER automations.js —
 * reuses its module-scope caches (_ruleSchema, _ruleTagList, _ruleAssetTypes,
 * _ruleChannels, _ruleRecipientUsers) and _looksLikeDeviceId.
 */

/* global _ruleSchema, _ruleTagList, _ruleAssetTypes, _ruleChannels,
          _ruleRecipientUsers, _looksLikeDeviceId */

var _awScripts = null;      // AutomationScript registry (null = not loadable — no automationScripts read)
var _awDraftStash = null;   // in-memory draft stash (never persisted — may contain addresses)

async function openAutomationWizard(existing) {
  // ── Load the catalogs the steps render from ────────────────────────────
  if (!_ruleSchema) {
    try { _ruleSchema = await api.automations.schema(); }
    catch (err) { showToast("Failed to load the automation schema", "error"); return; }
  }
  if (_ruleTagList === null) {
    try { var _td = await api.assets.tags(); _ruleTagList = ((_td && _td.tags) || []).filter(function (t) { return !_looksLikeDeviceId(t); }); }
    catch (_e) { _ruleTagList = []; }
  }
  if (_ruleAssetTypes === null) {
    // GET /asset-types returns { types: [...] } (the old builder read the
    // wrong key and always showed "No asset types in the registry").
    try { var _at = await api.assetTypes.list(); _ruleAssetTypes = Array.isArray(_at) ? _at : ((_at && (_at.types || _at.assetTypes)) || []); }
    catch (_e) { _ruleAssetTypes = []; }
  }
  // Scope-picker option lists (distinct manufacturers/models + IPAM subnets) —
  // refreshed every open, they're one cheap query each.
  var _awScopeOptions = { manufacturers: [], models: [], subnets: [] };
  try { _awScopeOptions = await api.automations.scopeOptions(); } catch (_e) {}
  try { var _cd = await api.deliveryChannels.list(); _ruleChannels = (_cd && _cd.channels) || []; }
  catch (_e) { _ruleChannels = _ruleChannels || []; }
  if (_ruleRecipientUsers === null) {
    try { var _ru = await api.automations.recipientUsers(); _ruleRecipientUsers = (_ru && _ru.users) || []; }
    catch (_e) { _ruleRecipientUsers = []; }
  }
  // Script registry — readable only with the automationScripts key; a 403
  // hides the script action type rather than erroring the wizard.
  if (_awScripts === null && permAtLeast("automationScripts", "read")) {
    try { var _sd = await api.automationScripts.list(); _awScripts = (_sd && _sd.scripts) || []; }
    catch (_e) { _awScripts = null; }
  } else if (permAtLeast("automationScripts", "read")) {
    try { var _sd2 = await api.automationScripts.list(); _awScripts = (_sd2 && _sd2.scripts) || []; } catch (_e) {}
  }

  var s = _ruleSchema;
  var editing = existing || null;

  // ── Draft (rule-shape v2) ──────────────────────────────────────────────
  var draft;
  if (editing) {
    draft = _awDraftFromRule(editing);
  } else if (_awDraftStash && await showConfirm("Restore your unsaved automation draft?")) {
    draft = _awDraftStash;
  } else {
    draft = {
      name: "", description: null, enabled: true, severity: "warning",
      scope: { allAssets: true },
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: null, forDurationSec: 0 },
      reset: null, // defaulted per trigger type on Step-4 entry
      cooldownSec: null, messageTemplate: null,
      actions: [], escalation: null,
    };
  }
  _awDraftStash = null;

  var step = 1;
  var visited = editing ? 5 : 1;
  var STEPS = ["Name", "Devices", "Trigger", "Reset", "Actions"];
  var scopePreviewTimer = null;
  var trigPreviewTimer = null;

  // ── Small shared helpers (schema-driven options / labels) ──────────────
  function opt(list, sel) {
    return (list || []).map(function (v) { return '<option value="' + escapeHtml(v) + '"' + (v === sel ? " selected" : "") + '>' + escapeHtml(v) + '</option>'; }).join("");
  }
  // Severity options carry the shared badge palette (styles.css .sev-select).
  function sevOpt(sel) {
    return (s.severities || []).map(function (v) {
      return '<option value="' + escapeHtml(v) + '" class="sev-' + escapeHtml(v) + '"' + (v === sel ? " selected" : "") + '>' + escapeHtml(v) + '</option>';
    }).join("");
  }
  function optLabeled(list, sel, labelFor) {
    return (list || []).map(function (v) {
      return '<option value="' + escapeHtml(v) + '"' + (v === sel ? " selected" : "") + '>' + escapeHtml(labelFor ? labelFor(v) : v) + '</option>';
    }).join("");
  }
  function findType(t) { return s.triggerTypes.find(function (x) { return x.type === t; }); }
  function metricLabel(m) { var x = s.metricMeta && s.metricMeta[m]; return x ? x.label : m; }
  function metricUnit(m) { var x = s.metricMeta && s.metricMeta[m]; return (x && x.unit) || ""; }
  function fieldLabel(f) { var x = s.fieldMeta && s.fieldMeta[f]; return x ? x.label : f; }
  function changeLabel(c) { return (s.changeTypeMeta && s.changeTypeMeta[c]) || c; }
  var DIM_PLACEHOLDER = { ifNamePattern: "interface name contains", sensorClass: "sensor class (temperature / fan / voltage / power / disk)", mountPathPattern: "mount path contains", healthCheck: "SD-WAN health-check name", link: "WAN member / link name", tunnelName: "IPsec tunnel name", widgetId: "custom widget id" };

  var channels = _ruleChannels || [];
  var routedTypes = s.recipientRoutedTypes || ["smtp", "oauth_m365", "web_push"];
  function chanById(id) { return channels.find(function (c) { return c.id === id; }); }
  function chanTypeLabel(type) { return (s.channelTypes && s.channelTypes[type] && s.channelTypes[type].label) || type; }
  function isRouted(type) { return routedTypes.indexOf(type) !== -1; }
  function isEmailType(type) { return type === "smtp" || type === "oauth_m365"; }
  function channelOptions(selId) {
    if (channels.length === 0) return '<option value="">No channels configured</option>';
    return channels.map(function (c) {
      var lbl = c.name + " — " + chanTypeLabel(c.type) + (c.enabled ? "" : " (disabled)");
      return '<option value="' + escapeHtml(c.id) + '"' + (c.id === selId ? " selected" : "") + '>' + escapeHtml(lbl) + '</option>';
    }).join("");
  }
  function userMultiSelect(selectedIds, cls) {
    var sel = new Set(selectedIds || []);
    var users = _ruleRecipientUsers || [];
    if (!users.length) return '<select multiple class="' + cls + '" size="4" style="width:100%" disabled><option>No users found</option></select>';
    var opts = users.map(function (u) {
      var label = (u.displayName || u.username) + (u.email ? " <" + u.email + ">" : " (no email)");
      return '<option value="' + escapeHtml(u.id) + '"' + (sel.has(u.id) ? " selected" : "") + '>' + escapeHtml(label) + '</option>';
    }).join("");
    return '<select multiple class="' + cls + '" size="4" style="width:100%">' + opts + '</select>';
  }
  function emailSuggestOptions() {
    var seen = {};
    return (_ruleRecipientUsers || [])
      .map(function (u) { return u.email; })
      .filter(function (e) { if (!e || seen[e]) return false; seen[e] = 1; return true; })
      .map(function (e) { return '<option value="' + escapeHtml(e) + '">'; })
      .join("");
  }
  function tokenPaletteHtml(id) {
    var vars = s.templateVariables || [];
    if (!vars.length) return "";
    var chips = vars.map(function (v) {
      return '<button type="button" class="btn btn-sm btn-secondary tpl-token" data-token="' + escapeHtml(v.token) + '" title="' + escapeHtml(v.description) + '" style="margin:2px 4px 2px 0;font-family:var(--font-mono);font-size:0.72rem;padding:1px 6px">' + escapeHtml(v.token) + '</button>';
    }).join("");
    return '<details id="' + id + '" style="margin:2px 0 6px"><summary style="font-size:0.78rem;cursor:pointer;color:var(--color-text-tertiary)">Insert variable…</summary><div style="margin-top:4px">' + chips + '</div></details>';
  }
  function csvOf(val) { return String(val || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean); }
  function scriptById(id) { return (_awScripts || []).find(function (x) { return x.id === id; }); }

  // Which action types the picker offers: catalog-driven, script additionally
  // needs the registry to be readable + the fullwrite key to attach.
  function availableActionTypes() {
    return (s.actionTypes || [{ type: "notify", label: "Send a notification" }]).filter(function (t) {
      if (t.type === "script") return Array.isArray(_awScripts) && permAtLeast("automationScripts", "fullwrite");
      return true;
    });
  }

  // ── Sentence builder ───────────────────────────────────────────────────
  var CMP_PHRASE = Object.assign({ ">": "is above", ">=": "is at or above", "<": "is below", "<=": "is at or below", "==": "equals", "!=": "is not" }, s.comparatorPhrases || {});
  var INV_CMP = Object.assign({ ">": "<=", ">=": "<", "<": ">=", "<=": ">", "==": "!=", "!=": "==" }, s.inverseComparators || {});
  var AGG_PHRASE = Object.assign({ latest: "", avg: "avg over", min: "min over", max: "max over" }, s.aggregationPhrases || {});
  var DIM_PHRASE = Object.assign({
    sensorClass: "for sensors of class {value}", ifNamePattern: "on interfaces matching {value}",
    mountPathPattern: "on mounts matching {value}", healthCheck: "for health check {value}",
    link: "on member {value}", tunnelName: "on tunnel {value}", widgetId: "for widget {value}",
    processNamePattern: "for processes matching {value}",
  }, s.dimensionPhrases || {});

  function humanDuration(sec) {
    if (!sec || sec <= 0) return "";
    if (sec % 3600 === 0) { var h = sec / 3600; return h + (h === 1 ? " hour" : " hours"); }
    if (sec % 60 === 0) { var m = sec / 60; return m + (m === 1 ? " minute" : " minutes"); }
    return sec + " seconds";
  }
  function triggerSentence(tr) {
    if (!tr || !tr.type) return "…";
    var out;
    if (tr.type === "asset_metric" || tr.type === "host_metric") {
      var subject = tr.type === "host_metric" ? "the Polaris host's " + metricLabel(tr.metric) : metricLabel(tr.metric);
      var agg = tr.aggregation && tr.aggregation !== "latest" && tr.windowSec
        ? " (" + (AGG_PHRASE[tr.aggregation] || tr.aggregation) + " " + humanDuration(tr.windowSec) + ")" : "";
      var thr = tr.threshold == null || isNaN(tr.threshold) ? "…" : tr.threshold;
      var unit = metricUnit(tr.metric); unit = unit && unit !== "(sensor unit)" ? " " + unit : "";
      out = "When <strong>" + escapeHtml(subject) + agg + " " + (CMP_PHRASE[tr.operator] || tr.operator) + " " + escapeHtml(String(thr)) + escapeHtml(unit) + "</strong>";
      var df = tr.dimensionFilter || {};
      Object.keys(df).forEach(function (k) {
        if (df[k]) out += " " + escapeHtml((DIM_PHRASE[k] || k + " = {value}").replace("{value}", df[k]));
      });
    } else if (tr.type === "asset_state") {
      out = "When <strong>" + escapeHtml(fieldLabel(tr.field)) + " " + (CMP_PHRASE[tr.operator] || tr.operator) + " " + escapeHtml(String(tr.value == null ? "…" : tr.value)) + "</strong>";
    } else if (tr.type === "event") {
      out = "When an audit event matching <strong>" + escapeHtml(tr.actionPattern || "…") + "</strong>" +
        (tr.resourceType ? " on <strong>" + escapeHtml(tr.resourceType) + "</strong> resources" : "") +
        (tr.minLevel ? " at level <strong>" + escapeHtml(tr.minLevel) + "</strong> or above" : "") + " occurs";
    } else if (tr.type === "change") {
      out = "When <strong>" + escapeHtml(changeLabel(tr.changeType)) + "</strong> is detected";
    } else {
      out = "…";
    }
    if ((tr.type === "asset_metric" || tr.type === "host_metric" || tr.type === "asset_state") && tr.forDurationSec > 0) {
      out += ", sustained for <strong>" + humanDuration(tr.forDurationSec) + "</strong>";
    }
    return out + ".";
  }
  function resetSentence(reset, tr, cooldownSec) {
    var out;
    reset = reset || { mode: "manual" };
    if (reset.mode === "manual") {
      out = "Stays active until <strong>someone clears it manually</strong>.";
    } else if (reset.mode === "timed") {
      out = "Resets automatically after <strong>" + (reset.afterSec ? humanDuration(reset.afterSec) : "…") + "</strong>.";
    } else {
      var numeric = tr && (tr.type === "asset_metric" || tr.type === "host_metric");
      if (numeric && reset.clearThreshold != null && !isNaN(reset.clearThreshold)) {
        var invOp = INV_CMP[tr.operator] || "<";
        var unit = metricUnit(tr.metric); unit = unit && unit !== "(sensor unit)" ? " " + unit : "";
        out = "Resets when the value <strong>" + (CMP_PHRASE[invOp] || invOp) + " " + escapeHtml(String(reset.clearThreshold)) + escapeHtml(unit) + "</strong>";
      } else {
        out = "Resets when <strong>the condition is no longer met</strong>";
      }
      if (reset.sustainSec > 0) out += " and stays there for <strong>" + humanDuration(reset.sustainSec) + "</strong>";
      out += ".";
    }
    if (cooldownSec > 0) out += " Won’t re-fire within <strong>" + humanDuration(cooldownSec) + "</strong> of the last alert.";
    return out;
  }

  // Condition-builder vocabulary — must initialize BEFORE the body assembly
  // below (step2Html renders from it during the openModal call).
  var scMeta = s.scopeCondition || {
    groupOps: ["and", "or", "none", "notAll"],
    groupOpLabels: {
      and: "All child conditions must be satisfied (AND)",
      or: "At least one child condition must be satisfied (OR)",
      none: "All child conditions must NOT be satisfied",
      notAll: "At least one child condition must NOT be satisfied",
    },
    operatorLabels: { equals: "is equal to", notEquals: "is not equal to", contains: "contains", notContains: "does not contain", startsWith: "starts with", endsWith: "ends with", has: "is applied", notHas: "is not applied", inCidr: "is in subnet", notInCidr: "is not in subnet" },
    fields: [
      { field: "assetType", label: "Device type", ops: ["equals", "notEquals"], optionsFrom: "assetTypes" },
      { field: "manufacturer", label: "Manufacturer", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: "manufacturers" },
      { field: "model", label: "Model", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: "models" },
      { field: "hostname", label: "Hostname", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: null },
      { field: "os", label: "Operating system", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: null },
      { field: "tag", label: "Tag", ops: ["has", "notHas"], optionsFrom: "tags" },
      { field: "subnet", label: "Subnet / IP", ops: ["inCidr", "notInCidr"], optionsFrom: "subnets" },
      { field: "status", label: "Lifecycle status", ops: ["equals", "notEquals"], optionsFrom: null, values: ["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"] },
      { field: "assetId", label: "Asset ID", ops: ["equals", "notEquals"], optionsFrom: null },
    ],
    maxDepth: 5,
  };

  // ── Modal shell: stepper + panels + footer ─────────────────────────────
  function stepperHtml() {
    var parts = [];
    for (var i = 1; i <= 5; i++) {
      parts.push('<div class="stepper-step" data-step="' + i + '"><span class="stepper-num">' + i + '</span><span>' + STEPS[i - 1] + '</span></div>');
      if (i < 5) parts.push('<div class="stepper-line" data-line="' + i + '"></div>');
    }
    return '<div class="stepper" id="aw-stepper">' + parts.join("") + '</div>';
  }

  var body =
    stepperHtml() +
    '<div class="step-panel visible" id="aw-step-1">' + step1Html() + '</div>' +
    '<div class="step-panel" id="aw-step-2">' + step2Html() + '</div>' +
    '<div class="step-panel" id="aw-step-3">' + step3Html() + '</div>' +
    '<div class="step-panel" id="aw-step-4"></div>' + // rendered on entry (depends on trigger type)
    '<div class="step-panel" id="aw-step-5"></div>' + // rendered on entry (summary reflects steps 1–4)
    '<datalist id="notif-email-suggest">' + emailSuggestOptions() + '</datalist>';

  var footer =
    '<button class="btn btn-secondary" id="aw-cancel">Cancel</button>' +
    '<button class="btn btn-secondary" id="aw-back" style="display:none">&larr; Back</button>' +
    '<button class="btn btn-primary" id="aw-next">Next &rarr;</button>' +
    '<button class="btn btn-primary" id="aw-save" style="display:none">' + (editing ? "Save changes" : "Create automation") + '</button>';

  openModal(editing ? "Edit automation" : "New automation", body, footer, { wide: true });

  // ── Step 1: Name & description ─────────────────────────────────────────
  function step1Html() {
    return '<h3 style="margin:0 0 0.25rem">What is this automation?</h3>' +
      '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 1rem">Name it, describe what it watches for, and pick the severity its alerts carry.</p>' +
      '<div class="form-group"><label>Name</label><input type="text" id="aw-name" value="' + escapeHtml(draft.name || "") + '" placeholder="e.g. Switch temperature high"></div>' +
      '<div class="form-group"><label>Description (optional)</label><input type="text" id="aw-desc" value="' + escapeHtml(draft.description || "") + '"></div>' +
      '<div class="form-group"><label>Severity</label><select id="aw-severity" class="sev-select sev-' + escapeHtml(draft.severity || "warning") + '">' + sevOpt(draft.severity || "warning") + '</select></div>' +
      '<div class="form-group"><label><input type="checkbox" id="aw-enabled"' + (draft.enabled === false ? "" : " checked") + '> Enabled</label></div>';
  }
  function collectStep1() {
    draft.name = document.getElementById("aw-name").value.trim();
    draft.description = document.getElementById("aw-desc").value.trim() || null;
    draft.severity = document.getElementById("aw-severity").value;
    draft.enabled = document.getElementById("aw-enabled").checked;
  }
  function validateStep1() {
    if (!draft.name) return "Name is required.";
    return null;
  }

  // ── Step 2: Asset filtering (nested condition builder) ──────────────────
  // SolarWinds-style tree: a root group with a combinator (AND / OR / NONE /
  // NOT-ALL), child rules of [field][operator][value], and nested sub-groups.
  // An empty root = all assets. Collect walks the DOM into scope.condition;
  // the backend evaluates the same tree via evaluateScopeCondition.
  function scFieldMeta(field) {
    return (scMeta.fields || []).find(function (f) { return f.field === field; }) || scMeta.fields[0];
  }
  function scValueOptions(field) {
    var fm = scFieldMeta(field);
    if (fm.values) return fm.values.map(function (v) { return { value: v, label: v }; });
    switch (fm.optionsFrom) {
      case "assetTypes": return (_ruleAssetTypes || []).map(function (t) { return { value: t.name, label: t.label || t.name }; });
      case "manufacturers": return (_awScopeOptions.manufacturers || []).map(function (m) { return { value: m, label: m }; });
      case "models": return (_awScopeOptions.models || []).map(function (m) { return { value: m, label: m }; });
      case "tags": return (_ruleTagList || []).map(function (t) { return { value: t, label: t }; });
      case "subnets": return (_awScopeOptions.subnets || []).map(function (sn) { return { value: sn.cidr, label: sn.name + " — " + sn.cidr }; });
      default: return [];
    }
  }
  function scOpOptions(field, sel) {
    var fm = scFieldMeta(field);
    return (fm.ops || []).map(function (o) {
      return '<option value="' + o + '"' + (o === sel ? " selected" : "") + '>' + escapeHtml((scMeta.operatorLabels || {})[o] || o) + '</option>';
    }).join("");
  }
  function scGroupOpOptions(sel) {
    return (scMeta.groupOps || []).map(function (o) {
      return '<option value="' + o + '"' + (o === sel ? " selected" : "") + '>' + escapeHtml((scMeta.groupOpLabels || {})[o] || o) + '</option>';
    }).join("");
  }
  function scRuleRowHtml(rule) {
    rule = rule || { field: "assetType", operator: null, value: "" };
    var fm = scFieldMeta(rule.field);
    var fieldOpts = (scMeta.fields || []).map(function (f) {
      return '<option value="' + f.field + '"' + (f.field === fm.field ? " selected" : "") + '>' + escapeHtml(f.label) + '</option>';
    }).join("");
    return '<div class="scr-row" style="display:flex;gap:6px;align-items:center;margin:4px 0">' +
      '<select class="scr-field" style="width:31%">' + fieldOpts + '</select>' +
      '<select class="scr-op" style="width:26%">' + scOpOptions(fm.field, rule.operator || (fm.ops && fm.ops[0])) + '</select>' +
      '<span class="aw-combo">' +
        '<input type="text" class="scr-value" autocomplete="off" value="' + escapeHtml(rule.value || "") + '" placeholder="value">' +
        '<div class="aw-suggest"></div>' +
      '</span>' +
      '<button type="button" class="btn btn-sm btn-danger scr-remove" title="Remove condition">&times;</button>' +
    '</div>';
  }
  function scGroupHtml(group, depth) {
    group = group || { op: "and", children: [] };
    var inner = (group.children || []).map(function (c) {
      return c && c.op !== undefined && Array.isArray(c.children)
        ? scGroupHtml(c, depth + 1)
        : scRuleRowHtml(c);
    }).join("");
    return '<div class="scg-group" data-depth="' + depth + '" style="border:1px solid var(--color-border);border-left:3px solid ' + (depth === 0 ? "var(--color-accent)" : "var(--color-success)") + ';border-radius:6px;padding:0.55rem;margin:4px 0">' +
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:2px">' +
        '<select class="scg-op" style="flex:1;font-size:0.85rem">' + scGroupOpOptions(group.op || "and") + '</select>' +
        (depth > 0 ? '<button type="button" class="btn btn-sm btn-danger scg-remove" title="Remove group">&times;</button>' : "") +
      '</div>' +
      '<div class="scg-children">' + inner + '</div>' +
      '<div style="margin-top:4px">' +
        '<button type="button" class="btn btn-sm btn-secondary scg-add-rule">+ Condition</button> ' +
        (depth + 1 < (scMeta.maxDepth || 5) ? '<button type="button" class="btn btn-sm btn-secondary scg-add-group">+ Group</button>' : "") +
      '</div>' +
    '</div>';
  }
  /** Legacy flat scope → a condition tree for editing (each used dimension
   *  becomes a rule, or an OR sub-group when the list has several entries). */
  function legacyScopeToCondition(sc) {
    var children = [];
    var addDim = function (list, field, operator) {
      if (!list || !list.length) return;
      var rules = list.map(function (v) { return { field: field, operator: operator, value: v }; });
      if (rules.length === 1) children.push(rules[0]);
      else children.push({ op: "or", children: rules });
    };
    addDim(sc.assetTypes, "assetType", "equals");
    addDim(sc.manufacturers, "manufacturer", "contains");
    addDim(sc.models, "model", "contains");
    addDim(sc.tags, "tag", "has");
    addDim(sc.subnetCidrs, "subnet", "inCidr");
    addDim(sc.assetIds, "assetId", "equals");
    return { op: "and", children: children };
  }
  function step2Html() {
    var scope = draft.scope || {};
    var root = scope.condition
      ? JSON.parse(JSON.stringify(scope.condition))
      : (scope.allAssets ? { op: "and", children: [] } : legacyScopeToCondition(scope));
    return '<h3 style="margin:0 0 0.25rem">Which devices?</h3>' +
      '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 0.75rem">Build the filter from conditions and nested groups — with <strong>no conditions, every asset matches</strong>. Polaris-host and audit-event triggers aren’t tied to assets and ignore this filter.</p>' +
      '<div id="aw-cond-root">' + scGroupHtml(root, 0) + '</div>' +
      '<div id="aw-scope-preview" style="margin-top:0.75rem"></div>';
  }
  function wireStep2() {
    var panel = document.getElementById("aw-step-2");
    panel.addEventListener("change", function (e) {
      var t = e.target;
      if (!t || !t.classList) return;
      if (t.classList.contains("scr-field")) {
        // Field changed: swap the operator list; the value combobox reads the
        // row's field at open time, so it just needs a reset.
        var row = t.closest(".scr-row");
        row.querySelector(".scr-op").innerHTML = scOpOptions(t.value, null);
        var input = row.querySelector(".scr-value");
        input.value = "";
        scCloseSuggest(row.querySelector(".aw-suggest"));
      }
      if (t.classList.contains("scr-field") || t.classList.contains("scr-op") || t.classList.contains("scg-op") || t.classList.contains("scr-value")) {
        scheduleScopePreview();
      }
    });
    panel.addEventListener("input", function (e) {
      if (e.target && e.target.classList && e.target.classList.contains("scr-value")) {
        scOpenSuggest(e.target); // refilter the suggestions as they type
        scheduleScopePreview();
      }
    });
    panel.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest("button");
      if (!btn || !panel.contains(btn)) return;
      if (btn.classList.contains("scr-remove")) {
        btn.closest(".scr-row").remove();
        scheduleScopePreview();
      } else if (btn.classList.contains("scg-remove")) {
        btn.closest(".scg-group").remove();
        scheduleScopePreview();
      } else if (btn.classList.contains("scg-add-rule")) {
        var g1 = btn.closest(".scg-group");
        g1.querySelector(":scope > .scg-children").insertAdjacentHTML("beforeend", scRuleRowHtml(null));
        scheduleScopePreview();
      } else if (btn.classList.contains("scg-add-group")) {
        var g2 = btn.closest(".scg-group");
        var depth = Number(g2.getAttribute("data-depth")) + 1;
        g2.querySelector(":scope > .scg-children").insertAdjacentHTML(
          "beforeend",
          scGroupHtml({ op: "or", children: [{ field: "assetType", operator: "equals", value: "" }] }, depth),
        );
        scheduleScopePreview();
      }
    });

    // Value combobox: focus/click opens existing values for the row's field;
    // typing filters (contains); ArrowUp/Down + Enter select; Esc closes.
    panel.addEventListener("focusin", function (e) {
      if (e.target && e.target.classList && e.target.classList.contains("scr-value")) scOpenSuggest(e.target);
    });
    panel.addEventListener("click", function (e) {
      if (e.target && e.target.classList && e.target.classList.contains("scr-value")) scOpenSuggest(e.target);
    });
    panel.addEventListener("focusout", function (e) {
      var input = e.target;
      if (!input || !input.classList || !input.classList.contains("scr-value")) return;
      // Delay so a mousedown on a suggestion (which fires before blur
      // completes) still lands.
      setTimeout(function () {
        var suggest = input.parentElement && input.parentElement.querySelector(".aw-suggest");
        if (suggest && !suggest.contains(document.activeElement)) scCloseSuggest(suggest);
      }, 150);
    });
    panel.addEventListener("mousedown", function (e) {
      var item = e.target.closest && e.target.closest(".aw-suggest-item");
      if (!item) return;
      e.preventDefault(); // keep focus on the input
      var combo = item.closest(".aw-combo");
      var input = combo.querySelector(".scr-value");
      input.value = item.getAttribute("data-val");
      scCloseSuggest(combo.querySelector(".aw-suggest"));
      scheduleScopePreview();
    });
    panel.addEventListener("keydown", function (e) {
      var input = e.target;
      if (!input || !input.classList || !input.classList.contains("scr-value")) return;
      var suggest = input.parentElement.querySelector(".aw-suggest");
      var open = suggest && suggest.classList.contains("open");
      if (e.key === "Escape") {
        if (open) { scCloseSuggest(suggest); e.stopPropagation(); } // keep the modal open
        return;
      }
      if (!open) return;
      var items = Array.from(suggest.querySelectorAll(".aw-suggest-item"));
      if (!items.length) return;
      var idx = items.findIndex(function (i) { return i.classList.contains("active"); });
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        var next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
        items.forEach(function (i) { i.classList.remove("active"); });
        items[next].classList.add("active");
        if (items[next].scrollIntoView) items[next].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && idx >= 0) {
        e.preventDefault();
        input.value = items[idx].getAttribute("data-val");
        scCloseSuggest(suggest);
        scheduleScopePreview();
      }
    });
  }
  function scCloseSuggest(suggest) {
    if (suggest) { suggest.classList.remove("open"); suggest.innerHTML = ""; }
  }
  function scOpenSuggest(input) {
    var row = input.closest(".scr-row");
    var suggest = input.parentElement.querySelector(".aw-suggest");
    if (!row || !suggest) return;
    var field = row.querySelector(".scr-field").value;
    var opts = scValueOptions(field);
    if (!opts.length) { scCloseSuggest(suggest); return; }
    var q = input.value.trim().toLowerCase();
    var filtered = opts.filter(function (o) {
      return !q || o.value.toLowerCase().indexOf(q) !== -1 || o.label.toLowerCase().indexOf(q) !== -1;
    }).slice(0, 50);
    suggest.innerHTML = filtered.length
      ? filtered.map(function (o) {
          return '<div class="aw-suggest-item" data-val="' + escapeHtml(o.value) + '" title="' + escapeHtml(o.label) + '">' + escapeHtml(o.label) + '</div>';
        }).join("")
      : '<div class="aw-suggest-empty">No matching values (free text is fine).</div>';
    suggest.classList.add("open");
  }
  function scCollectGroup(groupEl) {
    var op = groupEl.querySelector(":scope > div > .scg-op").value;
    var children = [];
    groupEl.querySelectorAll(":scope > .scg-children > *").forEach(function (el) {
      if (el.classList.contains("scr-row")) {
        children.push({
          field: el.querySelector(".scr-field").value,
          operator: el.querySelector(".scr-op").value,
          value: el.querySelector(".scr-value").value.trim(),
        });
      } else if (el.classList.contains("scg-group")) {
        children.push(scCollectGroup(el));
      }
    });
    return { op: op, children: children };
  }
  function collectStep2() {
    var root = document.querySelector("#aw-cond-root > .scg-group");
    if (!root) return;
    var tree = scCollectGroup(root);
    // Prune empty-valued rules and empty sub-groups (unfinished rows should
    // not silently exclude everything); validation flags them on Next.
    draft.scope = tree.children.length === 0 ? { allAssets: true } : { condition: tree };
  }
  function validateStep2() {
    var def = findType((draft.trigger || {}).type);
    if (def && !def.scoped) return null; // non-scoped triggers ignore the filter
    var sc = draft.scope || {};
    if (sc.allAssets || !sc.condition) return null;
    var CIDR_ISH = /^([0-9]{1,3}\.){3}[0-9]{1,3}(\/[0-9]{1,2})?$|^[0-9a-f:]+(\/[0-9]{1,3})?$/i;
    var problem = null;
    var walk = function (g) {
      if (problem) return;
      if (!g.children.length) { problem = "A condition group is empty — add a condition or remove the group."; return; }
      g.children.forEach(function (c) {
        if (problem) return;
        if (c.op !== undefined && Array.isArray(c.children)) { walk(c); return; }
        if (!c.value) { problem = "Every condition needs a value (or remove the empty row)."; return; }
        if (c.field === "subnet" && !CIDR_ISH.test(c.value)) {
          problem = 'Subnet "' + c.value + '" does not look like a CIDR or IP (e.g. 10.20.0.0/16).';
        }
      });
    };
    walk(sc.condition);
    return problem;
  }
  function scheduleScopePreview() {
    if (scopePreviewTimer) clearTimeout(scopePreviewTimer);
    scopePreviewTimer = setTimeout(runScopePreview, 400);
  }
  async function runScopePreview() {
    var box = document.getElementById("aw-scope-preview");
    if (!box) return;
    collectStep2();
    box.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:0.85rem">Checking…</p>';
    try {
      var res = await api.automations.preview({ scope: draft.scope });
      var rows = (res.matches || []).slice(0, 15).map(function (m) {
        return '<tr><td>' + escapeHtml(m.hostname || m.assetId || "") + '</td></tr>';
      }).join("");
      box.innerHTML = '<p style="font-size:0.85rem;margin:0 0 4px"><strong>' + res.totalEvaluated + '</strong> device(s) match this filter.</p>' +
        (rows ? '<div class="table-wrapper" style="max-height:180px;overflow:auto"><table><tbody>' + rows + '</tbody></table></div>' +
          (res.totalEvaluated > 15 ? '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:4px 0 0">…and ' + (res.totalEvaluated - 15) + ' more.</p>' : "") : "");
    } catch (err) {
      box.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:0.85rem">' + escapeHtml(err.message || "Preview unavailable") + '</p>';
    }
  }

  // ── Step 3: Trigger conditions ─────────────────────────────────────────
  function step3Html() {
    var tr = draft.trigger || { type: "asset_metric" };
    var typeOpts = s.triggerTypes.map(function (t) {
      return '<option value="' + t.type + '"' + (t.type === tr.type ? " selected" : "") + '>' + escapeHtml(t.label) + '</option>';
    }).join("");
    return '<h3 style="margin:0 0 0.25rem">When should it fire?</h3>' +
      '<div class="aw-sentence" id="aw-trigger-sentence">…</div>' +
      '<div class="form-group"><label>Trigger type</label><select id="aw-trigger-type">' + typeOpts + '</select></div>' +
      '<div id="aw-trigger-fields"></div>' +
      '<details' + (draft.messageTemplate ? " open" : "") + ' style="margin:0.5rem 0"><summary style="font-size:0.82rem;cursor:pointer;color:var(--color-text-tertiary)">Alert message template (optional)</summary>' +
        '<div style="margin-top:6px">' + tokenPaletteHtml("aw-token-palette") +
        '<input type="text" id="aw-msg" class="tpl-field" value="' + escapeHtml(draft.messageTemplate || "") + '" placeholder="{asset} {metric} = {value} (threshold {threshold})" style="width:100%"></div>' +
      '</details>' +
      '<div style="margin:0.5rem 0"><button type="button" class="btn btn-sm btn-secondary" id="aw-trigger-test">Test against current data</button></div>' +
      '<div id="aw-trigger-preview"></div>';
  }
  function renderTriggerFields() {
    var panel = document.getElementById("aw-step-3");
    var t = panel.querySelector("#aw-trigger-type").value;
    var def = findType(t);
    var box = panel.querySelector("#aw-trigger-fields");
    var cur = (draft.trigger && draft.trigger.type === t) ? draft.trigger : {};
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
    if (def && !def.scoped) {
      html += '<p style="font-size:0.78rem;color:var(--color-text-tertiary)">This trigger isn’t tied to assets — the device filter from the previous step is ignored.</p>';
    }
    box.innerHTML = html;

    if (t === "asset_metric" || t === "host_metric") {
      var renderMetricExtras = function () {
        var m = panel.querySelector("#tf-metric").value;
        var unitEl = panel.querySelector("#tf-unit"); if (unitEl) { var u = metricUnit(m); unitEl.textContent = u === "(sensor unit)" ? "(sensor unit)" : u; }
        var dimsBox = panel.querySelector("#tf-dims");
        if (dimsBox) {
          var dims = (s.metricDimensions && s.metricDimensions[m]) || [];
          var df = cur.dimensionFilter || {};
          var rows = dims.map(function (d) {
            return '<input type="text" data-dim="' + d + '" placeholder="' + escapeHtml(DIM_PLACEHOLDER[d] || d) + '" value="' + escapeHtml(df[d] || "") + '" style="margin-bottom:4px;display:block;width:100%">';
          }).join("");
          dimsBox.innerHTML = rows ? '<div class="form-group"><label>Dimension filter (optional)</label>' + rows + '</div>' : "";
        }
        refreshTriggerSentence();
      };
      panel.querySelector("#tf-metric").addEventListener("change", renderMetricExtras);
      renderMetricExtras();
    }
    if (t === "asset_state") {
      var renderStateValue = function () {
        var f = panel.querySelector("#tf-field").value;
        var meta = s.fieldMeta && s.fieldMeta[f];
        var wrap = panel.querySelector("#tf-value-wrap"); if (!wrap) return;
        var v = cur.value != null ? String(cur.value) : "";
        if (meta && (meta.kind === "enum" || meta.kind === "bool") && meta.values) {
          wrap.innerHTML = '<select id="tf-value">' + opt(meta.values, v) + '</select>';
        } else if (meta && meta.kind === "number") {
          wrap.innerHTML = '<input type="number" id="tf-value" value="' + escapeHtml(v) + '" placeholder="e.g. 3">';
        } else {
          wrap.innerHTML = '<input type="text" id="tf-value" value="' + escapeHtml(v) + '" placeholder="device value (e.g. up / down)">';
        }
        refreshTriggerSentence();
      };
      panel.querySelector("#tf-field").addEventListener("change", renderStateValue);
      renderStateValue();
    }
    refreshTriggerSentence();
  }
  function wireStep3() {
    var panel = document.getElementById("aw-step-3");
    panel.querySelector("#aw-trigger-type").addEventListener("change", function () {
      collectStep3(); // keep whatever fits before the fields re-render
      renderTriggerFields();
    });
    // Delegated: any input change re-renders the sentence.
    panel.addEventListener("input", function () { refreshTriggerSentence(); });
    panel.addEventListener("change", function () { refreshTriggerSentence(); });
    panel.querySelector("#aw-trigger-test").addEventListener("click", runTriggerPreview);
    renderTriggerFields();
    wireTokenPalette(panel);
  }
  function collectStep3() {
    var panel = document.getElementById("aw-step-3");
    var typeSel = panel.querySelector("#aw-trigger-type");
    if (!typeSel) return;
    var t = typeSel.value;
    var numOf = function (id) { var el = panel.querySelector("#" + id); if (!el || el.value === "") return undefined; var n = Number(el.value); return isNaN(n) ? undefined : n; };
    var durationSec = (numOf("tf-duration-min") || 0) * 60;
    if (t === "asset_metric" || t === "host_metric") {
      var trg = { type: t, metric: panel.querySelector("#tf-metric").value, aggregation: panel.querySelector("#tf-agg").value, windowSec: numOf("tf-window") || 0, operator: panel.querySelector("#tf-op").value, threshold: Number(panel.querySelector("#tf-threshold").value), forDurationSec: durationSec };
      if (t === "asset_metric") {
        var df = {};
        panel.querySelectorAll("#tf-dims [data-dim]").forEach(function (el) { var v = el.value.trim(); if (v) df[el.getAttribute("data-dim")] = v; });
        if (Object.keys(df).length) trg.dimensionFilter = df;
      }
      draft.trigger = trg;
    } else if (t === "asset_state") {
      draft.trigger = { type: t, field: panel.querySelector("#tf-field").value, operator: panel.querySelector("#tf-op").value, value: panel.querySelector("#tf-value") ? panel.querySelector("#tf-value").value : "", forDurationSec: durationSec };
    } else if (t === "event") {
      var ev = { type: t, actionPattern: panel.querySelector("#tf-action").value.trim() };
      var rt = panel.querySelector("#tf-restype").value.trim(); if (rt) ev.resourceType = rt;
      var ml = panel.querySelector("#tf-minlevel").value; if (ml) ev.minLevel = ml;
      draft.trigger = ev;
    } else if (t === "change") {
      draft.trigger = { type: t, changeType: panel.querySelector("#tf-changetype").value };
    }
    draft.messageTemplate = (panel.querySelector("#aw-msg") ? panel.querySelector("#aw-msg").value.trim() : "") || null;
  }
  function validateStep3() {
    var tr = draft.trigger || {};
    if ((tr.type === "asset_metric" || tr.type === "host_metric") && (tr.threshold == null || isNaN(tr.threshold))) {
      return "Enter a numeric threshold for the condition.";
    }
    if (tr.type === "asset_state" && (tr.value == null || String(tr.value).trim() === "")) {
      return "Choose or enter a value for the condition.";
    }
    if (tr.type === "event" && !String(tr.actionPattern || "").trim()) {
      return "Enter an action pattern for the event trigger.";
    }
    return null;
  }
  function refreshTriggerSentence() {
    var el = document.getElementById("aw-trigger-sentence");
    if (!el) return;
    collectStep3();
    el.innerHTML = triggerSentence(draft.trigger);
  }
  async function runTriggerPreview() {
    var box = document.getElementById("aw-trigger-preview");
    if (!box) return;
    collectStep2(); collectStep3();
    box.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:0.85rem">Testing…</p>';
    try {
      var res = await api.automations.preview({ trigger: draft.trigger, scope: draft.scope, reset: draft.reset || undefined });
      if (!res.supported) { box.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:0.85rem">' + escapeHtml(res.note || "Not previewable.") + '</p>'; return; }
      var meeting = (res.matches || []).filter(function (m) { return m.meets; });
      var rowsHtml = (res.matches || []).slice(0, 20).map(function (m) {
        return '<tr><td>' + escapeHtml(m.hostname || m.assetId || "host") + '</td><td>' + escapeHtml(m.dimension || "") + '</td><td>' + escapeHtml(m.value == null ? "n/a" : String(m.value)) + '</td><td>' + (m.meets ? '<span style="color:var(--color-danger)">would fire</span>' : m.inDeadBand ? '<span style="color:var(--color-warning,#d97706)">dead band</span>' : '<span style="color:var(--color-text-tertiary)">no</span>') + '</td></tr>';
      }).join("");
      box.innerHTML = '<p style="font-size:0.85rem"><strong>' + meeting.length + '</strong> of ' + res.totalEvaluated + ' currently match.</p>' +
        '<div class="table-wrapper" style="max-height:200px;overflow:auto"><table><thead><tr><th>Asset</th><th>Dimension</th><th>Value</th><th>Status</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
    } catch (err) { box.innerHTML = '<p style="color:var(--color-danger)">' + escapeHtml(err.message || "Preview failed") + '</p>'; }
  }

  // ── Step 4: Reset conditions ───────────────────────────────────────────
  function defaultResetFor(triggerType) {
    var d = (s.resetDefaults && s.resetDefaults[triggerType]) || { mode: "auto" };
    return JSON.parse(JSON.stringify(d));
  }
  function renderStep4() {
    var panel = document.getElementById("aw-step-4");
    var tr = draft.trigger || {};
    var modes = (s.resetModesByTriggerType && s.resetModesByTriggerType[tr.type]) || ["auto", "timed", "manual"];
    if (!draft.reset || modes.indexOf(draft.reset.mode) === -1) draft.reset = defaultResetFor(tr.type);
    var reset = draft.reset;
    var numeric = tr.type === "asset_metric" || tr.type === "host_metric";
    var modeMeta = s.resetModeMeta || {};
    var unit = numeric ? metricUnit(tr.metric) : "";
    if (unit === "(sensor unit)") unit = "";
    var invOp = INV_CMP[tr.operator] || "<";

    var radios = modes.map(function (m) {
      var meta = modeMeta[m] || { label: m };
      var extra = "";
      if (m === "auto" && numeric) {
        extra =
          '<div style="margin:6px 0 0 24px">' +
            '<label style="display:block;font-size:0.82rem"><input type="checkbox" id="aw-hyst-enable"' + (reset.clearThreshold != null ? " checked" : "") + '> Use a different clear threshold (hysteresis)</label>' +
            '<div id="aw-hyst-fields" style="display:' + (reset.clearThreshold != null ? "block" : "none") + ';margin:4px 0 0 24px;font-size:0.85rem">value must be <strong>' + escapeHtml(CMP_PHRASE[invOp] || invOp) + '</strong> ' +
              '<input type="number" step="any" id="aw-clear-threshold" value="' + (reset.clearThreshold != null ? reset.clearThreshold : "") + '" style="width:110px"> ' + escapeHtml(unit) +
            '</div>' +
            '<div style="margin:6px 0 0 24px;font-size:0.85rem">Must stay cleared for <input type="number" id="aw-sustain-min" min="0" value="' + Math.round((reset.sustainSec || 0) / 60) + '" style="width:80px"> min (0 = reset immediately)</div>' +
          '</div>';
      } else if (m === "auto") {
        extra = '<div style="margin:6px 0 0 24px;font-size:0.85rem">Must stay cleared for <input type="number" id="aw-sustain-min" min="0" value="' + Math.round((reset.sustainSec || 0) / 60) + '" style="width:80px"> min (0 = reset immediately)</div>';
      } else if (m === "timed") {
        extra = '<div style="margin:6px 0 0 24px;font-size:0.85rem">Clear after <input type="number" id="aw-after-min" min="1" value="' + Math.round((reset.afterSec || 3600) / 60) + '" style="width:90px"> min</div>';
      }
      return '<div style="margin-bottom:0.6rem">' +
        '<label style="display:block;font-weight:600;font-size:0.9rem"><input type="radio" name="aw-reset-mode" value="' + m + '"' + (reset.mode === m ? " checked" : "") + '> ' + escapeHtml(meta.label || m) + '</label>' +
        (meta.help ? '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0 24px">' + escapeHtml(meta.help) + '</p>' : "") +
        '<div class="aw-reset-extra" data-mode="' + m + '" style="display:' + (reset.mode === m ? "block" : "none") + '">' + extra + '</div>' +
      '</div>';
    }).join("");

    panel.innerHTML = '<h3 style="margin:0 0 0.25rem">How should its alerts reset?</h3>' +
      '<div class="aw-sentence" id="aw-reset-sentence">…</div>' +
      radios +
      '<div class="form-group" style="margin-top:0.75rem"><label>Re-notify cooldown (minutes, optional)</label><input type="number" id="aw-cooldown-min" min="0" value="' + (draft.cooldownSec != null ? Math.round(draft.cooldownSec / 60) : "") + '" placeholder="blank = suppress repeats while active"></div>';

    panel.querySelectorAll('input[name="aw-reset-mode"]').forEach(function (radio) {
      radio.addEventListener("change", function () {
        panel.querySelectorAll(".aw-reset-extra").forEach(function (x) { x.style.display = x.getAttribute("data-mode") === radio.value ? "block" : "none"; });
        refreshResetSentence();
      });
    });
    var hystEnable = panel.querySelector("#aw-hyst-enable");
    if (hystEnable) {
      hystEnable.addEventListener("change", function () {
        panel.querySelector("#aw-hyst-fields").style.display = hystEnable.checked ? "block" : "none";
        refreshResetSentence();
      });
    }
    panel.addEventListener("input", function () { refreshResetSentence(); });
    refreshResetSentence();
  }
  function collectStep4() {
    var panel = document.getElementById("aw-step-4");
    var sel = panel.querySelector('input[name="aw-reset-mode"]:checked');
    if (!sel) return;
    var mode = sel.value;
    var reset = { mode: mode };
    if (mode === "auto") {
      var hyst = panel.querySelector("#aw-hyst-enable");
      var ct = panel.querySelector("#aw-clear-threshold");
      if (hyst && hyst.checked && ct && ct.value !== "" && !isNaN(Number(ct.value))) reset.clearThreshold = Number(ct.value);
      var sm = panel.querySelector("#aw-sustain-min");
      var sus = sm && sm.value !== "" ? Number(sm.value) : 0;
      if (!isNaN(sus) && sus > 0) reset.sustainSec = sus * 60;
    } else if (mode === "timed") {
      var am = panel.querySelector("#aw-after-min");
      var mins = am && am.value !== "" ? Number(am.value) : 60;
      reset.afterSec = (isNaN(mins) || mins < 1 ? 60 : mins) * 60;
    }
    draft.reset = reset;
    var cd = panel.querySelector("#aw-cooldown-min");
    draft.cooldownSec = cd && cd.value !== "" && !isNaN(Number(cd.value)) ? Number(cd.value) * 60 : null;
  }
  function validateStep4() {
    var r = draft.reset || {};
    var tr = draft.trigger || {};
    if (r.mode === "timed" && (!r.afterSec || r.afterSec < 60)) return "Timed reset: enter the clear delay (1 minute or more).";
    if (r.mode === "auto" && r.clearThreshold != null) {
      if (isNaN(r.clearThreshold)) return "Hysteresis: enter a numeric clear threshold.";
      var t = tr.threshold;
      if (tr.operator === "==" || tr.operator === "!=") return "Hysteresis can't be combined with the " + tr.operator + " operator.";
      if ((tr.operator === ">" || tr.operator === ">=") && r.clearThreshold > t) return "Clear threshold must be at or below the fire threshold (" + t + ").";
      if ((tr.operator === "<" || tr.operator === "<=") && r.clearThreshold < t) return "Clear threshold must be at or above the fire threshold (" + t + ").";
    }
    return null;
  }
  function refreshResetSentence() {
    var el = document.getElementById("aw-reset-sentence");
    if (!el) return;
    collectStep4();
    el.innerHTML = resetSentence(draft.reset, draft.trigger, draft.cooldownSec);
  }

  // ── Step 5: Actions + escalation + summary ─────────────────────────────
  function actionSummary(a) {
    if (a.type === "notify") {
      var ch = chanById(a.channelId);
      return "Notify via " + (ch ? ch.name : "…");
    }
    if (a.type === "api_call") return (a.method || "POST") + " " + (a.url || "…");
    if (a.type === "script") {
      var sc = scriptById(a.scriptId);
      return "Run " + (sc ? sc.name : "…") + " on " + (a.runOn || "server");
    }
    return a.type;
  }
  function renderStep5() {
    var panel = document.getElementById("aw-step-5");
    var esc = draft.escalation;
    panel.innerHTML = '<h3 style="margin:0 0 0.25rem">What should happen?</h3>' +
      '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 0.75rem">In-app alerts (the Alerts tab) are always created — actions run in addition. Notifications route through Delivery-tab channels; API calls POST to your systems; scripts run on the Polaris server or the triggering asset’s agent.</p>' +
      '<div class="form-group"><label style="font-weight:600">Actions when this fires</label>' +
        '<div id="aw-actions"></div>' +
        '<button type="button" class="btn btn-sm btn-secondary" id="aw-add-action" style="margin-top:6px">+ Add action</button>' +
      '</div>' +
      '<div class="form-group" style="border:1px solid var(--color-border);border-radius:6px;padding:0.75rem">' +
        '<label style="font-weight:600;margin:0"><input type="checkbox" id="aw-esc-enable"' + (esc ? " checked" : "") + '> Escalate while unhandled</label>' +
        '<div id="aw-esc-fields" style="display:' + (esc ? "block" : "none") + ';margin-top:8px">' +
          '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Stop escalating when</label><select id="aw-esc-stopon"><option value="acknowledge"' + (esc && esc.stopOn === "acknowledge" ? " selected" : "") + '>Acknowledged (or cleared)</option><option value="clear"' + (esc && esc.stopOn === "clear" ? " selected" : "") + '>Cleared only — acknowledging does not stop it</option></select></div>' +
          '<div id="aw-esc-tiers"></div>' +
          '<button type="button" class="btn btn-sm btn-secondary" id="aw-esc-add" style="margin-top:6px">+ Add tier</button>' +
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:6px">Each tier runs its actions once its delay elapses (checked every minute), optionally repeating until the alert is handled or max repeats is reached.</p>' +
        '</div>' +
      '</div>' +
      '<div class="form-group" style="border:1px solid var(--color-border);border-radius:6px;padding:0.75rem">' +
        '<label style="font-weight:600;margin:0 0 6px;display:block">Summary</label>' +
        '<div id="aw-summary"></div>' +
      '</div>';

    var host = panel.querySelector("#aw-actions");
    (draft.actions || []).forEach(function (a) { addActionRow(host, a); });
    panel.querySelector("#aw-add-action").addEventListener("click", function () { addActionRow(host, null); });

    var escEnable = panel.querySelector("#aw-esc-enable");
    escEnable.addEventListener("change", function () {
      panel.querySelector("#aw-esc-fields").style.display = escEnable.checked ? "block" : "none";
    });
    var tiersHost = panel.querySelector("#aw-esc-tiers");
    ((esc && esc.tiers) || []).forEach(function (t) { addTierRow(tiersHost, t); });
    panel.querySelector("#aw-esc-add").addEventListener("click", function () {
      var max = (s.escalationMeta && s.escalationMeta.maxTiers) || 5;
      if (tiersHost.querySelectorAll(".aw-tier").length >= max) { showToast("Maximum " + max + " escalation tiers", "info"); return; }
      addTierRow(tiersHost, null);
    });
    renderSummary();
    wireTokenPalette(panel);
  }

  // One action row — used for top-level actions AND escalation-tier actions.
  function addActionRow(host, action) {
    action = action || { type: "notify", channelId: channels.length ? channels[0].id : "" };
    var types = availableActionTypes();
    var row = document.createElement("div");
    row.className = "aw-action";
    row.style.cssText = "border:1px solid var(--color-border);border-radius:6px;padding:0.6rem;margin-bottom:6px";
    var typeOpts = types.map(function (t) {
      return '<option value="' + t.type + '"' + (t.type === action.type ? " selected" : "") + '>' + escapeHtml(t.label) + '</option>';
    }).join("");
    row.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
        '<select class="aw-action-type" style="width:auto">' + typeOpts + '</select>' +
        '<span class="aw-action-summary" style="flex:1;font-size:0.8rem;color:var(--color-text-tertiary)"></span>' +
        '<button type="button" class="btn btn-sm btn-danger aw-action-remove">Remove</button>' +
      '</div>' +
      '<div class="aw-action-fields"></div>';
    host.appendChild(row);
    row.querySelector(".aw-action-remove").addEventListener("click", function () { row.remove(); });
    row.querySelector(".aw-action-type").addEventListener("change", function () {
      renderActionFields(row, { type: row.querySelector(".aw-action-type").value });
    });
    renderActionFields(row, action);
  }
  function renderActionFields(row, action) {
    var box = row.querySelector(".aw-action-fields");
    var t = action.type;
    row.querySelector(".aw-action-summary").textContent = actionSummary(action);
    if (t === "notify") {
      var comp = action.emailComposition || null;
      var html =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<label style="margin:0;font-size:0.8rem">Channel</label>' +
          '<select class="na-channel" style="flex:1">' + channelOptions(action.channelId) + '</select>' +
        '</div>' +
        '<div class="na-fields"></div>' +
        '<details class="na-comp"' + (comp ? " open" : "") + '><summary style="font-size:0.78rem;cursor:pointer;color:var(--color-text-tertiary)">Customize the email (subject / Cc / Bcc / body)…</summary>' +
          '<div style="margin-top:6px">' +
            '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Subject</label><input type="text" class="na-subject tpl-field" value="' + escapeHtml((comp && comp.subjectTemplate) || "") + '" placeholder="[{severity.upper}] {asset} — {metric} = {value}"></div>' +
            '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Cc (comma-separated)</label><input type="text" class="na-cc" list="notif-email-suggest" autocomplete="off" value="' + escapeHtml(((comp && comp.cc && comp.cc.addresses) || []).join(", ")) + '"></div>' +
            '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Bcc (comma-separated)</label><input type="text" class="na-bcc" list="notif-email-suggest" autocomplete="off" value="' + escapeHtml(((comp && comp.bcc && comp.bcc.addresses) || []).join(", ")) + '"></div>' +
            '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Body (plain text)</label><textarea class="na-body tpl-field" rows="4" style="width:100%">' + escapeHtml((comp && comp.bodyTextTemplate) || "") + '</textarea></div>' +
            '<label style="font-size:0.8rem;display:block"><input type="checkbox" class="na-html-enable"' + (comp && comp.bodyHtmlTemplate ? " checked" : "") + '> Add HTML body (values are HTML-escaped)</label>' +
            '<textarea class="na-html tpl-field" rows="4" style="width:100%;display:' + (comp && comp.bodyHtmlTemplate ? "block" : "none") + ';margin-top:4px">' + escapeHtml((comp && comp.bodyHtmlTemplate) || "") + '</textarea>' +
          '</div>' +
        '</details>';
      box.innerHTML = html;
      var renderRecipients = function () {
        var ch = chanById(row.querySelector(".na-channel").value);
        var fbox = box.querySelector(".na-fields");
        var compEl = box.querySelector(".na-comp");
        if (!ch) { fbox.innerHTML = '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 6px">Add a channel in the Delivery tab first.</p>'; if (compEl) compEl.style.display = "none"; return; }
        if (compEl) compEl.style.display = isEmailType(ch.type) ? "" : "none";
        if (!isRouted(ch.type)) { fbox.innerHTML = '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 6px">Posts to this channel’s configured destination.</p>'; return; }
        var h = '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Send to user accounts</label>' + userMultiSelect(action.recipientUserIds, "na-users") + '</div>';
        if (isEmailType(ch.type)) {
          h += '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">…or custom email addresses (comma-separated)</label><input type="text" class="na-addresses" value="' + escapeHtml((action.addresses || []).join(", ")) + '" placeholder="oncall@example.com"></div>';
        }
        var regions = (draft.scope && draft.scope.tags || []).filter(function (x) { return /^region:/i.test(x); });
        // Condition-tree scopes carry tags inside rules — collect positive
        // region: tag rules too (mirrors the server's scopeRegionTagsOf).
        (function walk(node) {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node.children)) { node.children.forEach(walk); return; }
          if (node.field === "tag" && node.operator === "has" && /^region:/i.test(node.value || "")) regions.push(node.value);
        })(draft.scope && draft.scope.condition);
        var regionLabel = regions.length
          ? "…or users associated with the automation's region (" + regions.map(function (x) { return x.replace(/^region:/i, ""); }).join(", ") + ")"
          : "…or users associated with the automation's region (add a region: tag on the Devices step)";
        h += '<label style="display:block;font-size:0.8rem;margin:0"><input type="checkbox" class="na-scope-region"' + (action.recipientScopeRegion ? " checked" : "") + (regions.length ? "" : " disabled") + '> ' + escapeHtml(regionLabel) + '</label>';
        fbox.innerHTML = h;
      };
      box.querySelector(".na-html-enable").addEventListener("change", function () {
        box.querySelector(".na-html").style.display = this.checked ? "block" : "none";
      });
      row.querySelector(".na-channel").addEventListener("change", function () {
        row.querySelector(".aw-action-summary").textContent = actionSummary({ type: "notify", channelId: row.querySelector(".na-channel").value });
        renderRecipients();
      });
      renderRecipients();
    } else if (t === "api_call") {
      var meta = s.apiCallMeta || { allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"] };
      var headers = action.headers || {};
      var headerRows = Object.keys(headers).map(function (k) { return apiHeaderRowHtml(k, headers[k]); }).join("");
      box.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<select class="ac-method" style="width:auto">' + opt(meta.allowedMethods, action.method || "POST") + '</select>' +
          '<input type="text" class="ac-url" value="' + escapeHtml(action.url || "") + '" placeholder="https://api.example.com/hook" style="flex:1">' +
        '</div>' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Headers</label><div class="ac-headers">' + headerRows + '</div>' +
          '<button type="button" class="btn btn-sm btn-secondary ac-add-header" style="margin-top:4px">+ Header</button>' +
          '<p class="ac-header-warn" style="display:none;font-size:0.78rem;color:var(--color-warning,#d97706);margin:4px 0 0">Headers are stored unmasked on the automation — never paste API keys, tokens, or credentials.</p>' +
        '</div>' +
        '<div class="form-group ac-body-wrap" style="margin-bottom:6px"><label style="font-size:0.8rem">Body template (JSON — tokens like {asset} render at fire time)</label><textarea class="ac-body tpl-field" rows="4" style="width:100%;font-family:var(--font-mono)" placeholder=\'{"asset":"{asset}","value":{value},"severity":"{severity}"}\'>' + escapeHtml(action.bodyTemplate || "") + '</textarea></div>' +
        '<div class="form-group" style="margin-bottom:0"><label style="font-size:0.8rem">Timeout</label> <input type="number" class="ac-timeout" min="1" max="' + (meta.maxTimeoutSec || 60) + '" value="' + (action.timeoutSec || 15) + '" style="width:80px"> sec</div>';
      var syncApiBits = function () {
        var m = box.querySelector(".ac-method").value;
        box.querySelector(".ac-body-wrap").style.display = m === "GET" ? "none" : "";
        row.querySelector(".aw-action-summary").textContent = actionSummary({ type: "api_call", method: m, url: box.querySelector(".ac-url").value });
        var warn = box.querySelector(".ac-header-warn");
        var suspicious = Array.from(box.querySelectorAll(".ac-hname")).some(function (el) { return /authorization|api-?key|token|secret/i.test(el.value); });
        warn.style.display = suspicious ? "" : "none";
      };
      box.querySelector(".ac-add-header").addEventListener("click", function () {
        var div = document.createElement("div");
        div.innerHTML = apiHeaderRowHtml("", "");
        box.querySelector(".ac-headers").appendChild(div.firstChild);
        wireHeaderRows(box, syncApiBits);
      });
      box.addEventListener("input", syncApiBits);
      wireHeaderRows(box, syncApiBits);
      syncApiBits();
    } else if (t === "script") {
      var scripts = _awScripts || [];
      if (!scripts.length) {
        box.innerHTML = '<p style="font-size:0.82rem;color:var(--color-text-tertiary);margin:0">No scripts in the registry yet — add one on the Scripts tab first.</p>';
        return;
      }
      var scOpts = scripts.map(function (x) {
        return '<option value="' + escapeHtml(x.id) + '"' + (x.id === action.scriptId ? " selected" : "") + '>' + escapeHtml(x.name + " (" + x.interpreter + ", " + x.runTarget + ")") + '</option>';
      }).join("");
      box.innerHTML =
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Script</label><select class="sa-script" style="width:100%">' + scOpts + '</select></div>' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Run on</label> ' +
          '<label style="font-size:0.85rem;margin-right:10px"><input type="radio" class="sa-runon" name="sa-runon-' + Math.random().toString(36).slice(2, 8) + '" value="server"> the Polaris server</label>' +
          '<label style="font-size:0.85rem"><input type="radio" class="sa-runon-agent" value="agent"> the triggering asset’s agent</label>' +
        '</div>' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Arguments (one string; tokens render at fire time)</label><input type="text" class="sa-args tpl-field" value="' + escapeHtml(action.argsTemplate || "") + '" placeholder="{asset} {value}"></div>' +
        '<div class="form-group" style="margin-bottom:0"><label style="font-size:0.8rem">Timeout override</label> <input type="number" class="sa-timeout" min="1" max="600" value="' + (action.timeoutSec || "") + '" style="width:80px" placeholder="script default"> sec</div>' +
        '<p style="font-size:0.78rem;color:var(--color-warning,#d97706);margin:6px 0 0">Scripts run with full privileges (Polaris service account / agent root). A human must review a script before enabling it in production.</p>';
      var runonServer = box.querySelector('.sa-runon');
      var runonAgent = box.querySelector('.sa-runon-agent');
      // Radios must share a name per row; wire them as a pair manually.
      var group = "sa-runon-" + Math.random().toString(36).slice(2, 8);
      runonServer.name = group; runonAgent.name = group;
      var syncScriptBits = function () {
        var sc = scriptById(box.querySelector(".sa-script").value) || {};
        var canServer = sc.runTarget === "server" || sc.runTarget === "either";
        var canAgent = sc.runTarget === "agent" || sc.runTarget === "either";
        runonServer.disabled = !canServer;
        runonAgent.disabled = !canAgent;
        var want = action.runOn || (canServer ? "server" : "agent");
        if (want === "server" && !canServer) want = "agent";
        if (want === "agent" && !canAgent) want = "server";
        (want === "agent" ? runonAgent : runonServer).checked = true;
        row.querySelector(".aw-action-summary").textContent = actionSummary({ type: "script", scriptId: sc.id, runOn: want });
      };
      box.querySelector(".sa-script").addEventListener("change", syncScriptBits);
      syncScriptBits();
    }
  }
  function apiHeaderRowHtml(k, v) {
    return '<div class="ac-hrow" style="display:flex;gap:6px;margin-bottom:4px">' +
      '<input type="text" class="ac-hname" value="' + escapeHtml(k) + '" placeholder="Header-Name" style="width:38%">' +
      '<input type="text" class="ac-hval" value="' + escapeHtml(v) + '" placeholder="value" style="flex:1">' +
      '<button type="button" class="btn btn-sm btn-danger ac-hremove">&times;</button>' +
    '</div>';
  }
  function wireHeaderRows(box, onChange) {
    box.querySelectorAll(".ac-hremove").forEach(function (b) {
      if (b._wired) return; b._wired = true;
      b.addEventListener("click", function () { b.closest(".ac-hrow").remove(); onChange(); });
    });
  }
  function collectAction(row) {
    var t = row.querySelector(".aw-action-type").value;
    var box = row.querySelector(".aw-action-fields");
    if (t === "notify") {
      var chSel = box.querySelector(".na-channel");
      if (!chSel || !chSel.value) return null;
      var a = { type: "notify", channelId: chSel.value };
      var userSel = box.querySelector(".na-users");
      if (userSel && !userSel.disabled) {
        var uids = Array.from(userSel.selectedOptions).map(function (o) { return o.value; }).filter(Boolean);
        if (uids.length) a.recipientUserIds = uids;
      }
      var addrEl = box.querySelector(".na-addresses");
      if (addrEl) { var addrs = csvOf(addrEl.value); if (addrs.length) a.addresses = addrs; }
      var regEl = box.querySelector(".na-scope-region");
      if (regEl && regEl.checked) a.recipientScopeRegion = true;
      // Per-action email composition (email channels only; hidden otherwise).
      var ch = chanById(a.channelId);
      if (ch && isEmailType(ch.type)) {
        var c = {};
        var subj = (box.querySelector(".na-subject") || {}).value || ""; if (subj.trim()) c.subjectTemplate = subj.trim();
        var bodyTxt = (box.querySelector(".na-body") || {}).value || ""; if (bodyTxt.trim()) c.bodyTextTemplate = bodyTxt;
        var htmlOn = box.querySelector(".na-html-enable");
        if (htmlOn && htmlOn.checked) { var h = (box.querySelector(".na-html") || {}).value || ""; if (h.trim()) c.bodyHtmlTemplate = h; }
        var cc = csvOf((box.querySelector(".na-cc") || {}).value); if (cc.length) c.cc = { addresses: cc };
        var bcc = csvOf((box.querySelector(".na-bcc") || {}).value); if (bcc.length) c.bcc = { addresses: bcc };
        if (Object.keys(c).length) a.emailComposition = c;
      }
      return a;
    }
    if (t === "api_call") {
      var a2 = {
        type: "api_call",
        method: box.querySelector(".ac-method").value,
        url: box.querySelector(".ac-url").value.trim(),
        timeoutSec: Number(box.querySelector(".ac-timeout").value) || 15,
      };
      var hdrs = {};
      box.querySelectorAll(".ac-hrow").forEach(function (hr) {
        var k = hr.querySelector(".ac-hname").value.trim();
        var v = hr.querySelector(".ac-hval").value;
        if (k) hdrs[k] = v;
      });
      if (Object.keys(hdrs).length) a2.headers = hdrs;
      if (a2.method !== "GET") { var bt = box.querySelector(".ac-body").value; if (bt.trim()) a2.bodyTemplate = bt; }
      return a2;
    }
    if (t === "script") {
      var scSel = box.querySelector(".sa-script");
      if (!scSel) return null;
      var runOnEl = box.querySelector('input.sa-runon:checked, input.sa-runon-agent:checked');
      var a3 = { type: "script", scriptId: scSel.value, runOn: runOnEl ? runOnEl.value : "server" };
      var args = box.querySelector(".sa-args").value; if (args.trim()) a3.argsTemplate = args;
      var to = box.querySelector(".sa-timeout").value;
      if (to !== "" && !isNaN(Number(to))) a3.timeoutSec = Number(to);
      return a3;
    }
    return null;
  }
  function collectActionsFrom(host) {
    var out = [];
    host.querySelectorAll(":scope > .aw-action").forEach(function (row) {
      var a = collectAction(row);
      if (a) out.push(a);
    });
    return out;
  }

  // Escalation tier row — afterMin/repeat controls + a nested action list.
  function addTierRow(host, tier) {
    tier = tier || { afterMin: 15, actions: [] };
    var row = document.createElement("div");
    row.className = "aw-tier";
    row.style.cssText = "border:1px solid var(--color-border);border-radius:6px;padding:0.6rem;margin-bottom:6px";
    row.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">' +
        '<label style="margin:0;font-size:0.8rem">After</label>' +
        '<input type="number" class="tier-after" min="1" value="' + (tier.afterMin != null ? tier.afterMin : 15) + '" style="width:80px"> min,' +
        '<label style="margin:0;font-size:0.8rem">repeat every</label>' +
        '<input type="number" class="tier-repeat" min="5" value="' + (tier.repeatEveryMin != null ? tier.repeatEveryMin : "") + '" style="width:80px" placeholder="off"> min,' +
        '<label style="margin:0;font-size:0.8rem">max</label>' +
        '<input type="number" class="tier-max" min="1" max="20" value="' + (tier.maxRepeats != null ? tier.maxRepeats : "") + '" style="width:70px" placeholder="5">' +
        '<button type="button" class="btn btn-sm btn-danger tier-remove" style="margin-left:auto">Remove tier</button>' +
      '</div>' +
      '<div class="tier-actions"></div>' +
      '<button type="button" class="btn btn-sm btn-secondary tier-add-action">+ Add action</button>';
    host.appendChild(row);
    row.querySelector(".tier-remove").addEventListener("click", function () { row.remove(); });
    var actionsHost = row.querySelector(".tier-actions");
    (tier.actions || []).forEach(function (a) { addActionRow(actionsHost, a); });
    row.querySelector(".tier-add-action").addEventListener("click", function () { addActionRow(actionsHost, null); });
  }

  function collectStep5() {
    var panel = document.getElementById("aw-step-5");
    var host = panel.querySelector("#aw-actions");
    if (!host) return;
    draft.actions = collectActionsFrom(host);
    if (panel.querySelector("#aw-esc-enable").checked) {
      var tiers = [];
      panel.querySelectorAll("#aw-esc-tiers .aw-tier").forEach(function (row) {
        var t = { afterMin: Number(row.querySelector(".tier-after").value) || 0, actions: collectActionsFrom(row.querySelector(".tier-actions")) };
        var rep = row.querySelector(".tier-repeat").value;
        if (rep !== "") {
          t.repeatEveryMin = Number(rep);
          var mx = row.querySelector(".tier-max").value;
          if (mx !== "") t.maxRepeats = Number(mx);
        }
        tiers.push(t);
      });
      draft.escalation = { stopOn: panel.querySelector("#aw-esc-stopon").value, tiers: tiers };
    } else {
      draft.escalation = null;
    }
  }
  function validateAction(a, label) {
    if (a.type === "notify") {
      if (!a.channelId) return label + ": pick a channel.";
      var ch = chanById(a.channelId);
      if (ch && isRouted(ch.type)) {
        var hasRecip = (a.recipientUserIds && a.recipientUserIds.length) || (a.addresses && a.addresses.length) || a.recipientScopeRegion;
        if (!hasRecip) return label + " (" + ch.name + "): choose at least one recipient.";
      }
    } else if (a.type === "api_call") {
      if (!a.url) return label + ": enter the URL.";
      if (!/^https?:\/\//i.test(a.url)) return label + ": the URL must start with http:// or https://.";
    } else if (a.type === "script") {
      if (!a.scriptId) return label + ": pick a script.";
    }
    return null;
  }
  function validateStep5() {
    var acts = draft.actions || [];
    for (var i = 0; i < acts.length; i++) {
      var p = validateAction(acts[i], "Action " + (i + 1));
      if (p) return p;
    }
    if (draft.escalation) {
      var tiers = draft.escalation.tiers || [];
      if (!tiers.length) return "Escalation: add at least one tier, or untick escalation.";
      for (var j = 0; j < tiers.length; j++) {
        var t = tiers[j]; var tn = j + 1;
        if (!t.afterMin || isNaN(t.afterMin) || t.afterMin < 1) return "Escalation tier " + tn + ": enter the delay in minutes (1 or more).";
        if (!t.actions.length) return "Escalation tier " + tn + ": add at least one action.";
        for (var k = 0; k < t.actions.length; k++) {
          var p2 = validateAction(t.actions[k], "Escalation tier " + tn + ", action " + (k + 1));
          if (p2) return p2;
        }
        if (t.repeatEveryMin != null && (isNaN(t.repeatEveryMin) || t.repeatEveryMin < 5)) return "Escalation tier " + tn + ": repeat interval must be 5 minutes or more.";
      }
    }
    return null;
  }
  function condText(g) {
    var parts = (g.children || []).map(function (c) {
      if (c.op !== undefined && Array.isArray(c.children)) return "(" + condText(c) + ")";
      var fm = scFieldMeta(c.field);
      var opLbl = (scMeta.operatorLabels || {})[c.operator] || c.operator;
      return fm.label + " " + opLbl + " " + c.value;
    });
    if (g.op === "or") return parts.join(" OR ");
    if (g.op === "none") return "NOT(" + parts.join(" OR ") + ")";
    if (g.op === "notAll") return "NOT(" + parts.join(" AND ") + ")";
    return parts.join(" AND ");
  }
  function scopeSummaryText(sc) {
    sc = sc || {};
    if (sc.allAssets) return "All assets";
    if (sc.condition) return condText(sc.condition) || "(none)";
    var parts = [];
    if (sc.assetTypes && sc.assetTypes.length) parts.push("types: " + sc.assetTypes.join("/"));
    if (sc.tags && sc.tags.length) parts.push("tags: " + sc.tags.join("/"));
    if (sc.manufacturers && sc.manufacturers.length) parts.push("mfr: " + sc.manufacturers.join("/"));
    if (sc.models && sc.models.length) parts.push("model: " + sc.models.join("/"));
    if (sc.subnetCidrs && sc.subnetCidrs.length) parts.push("subnets: " + sc.subnetCidrs.join("/"));
    if (sc.assetIds && sc.assetIds.length) parts.push(sc.assetIds.length + " asset(s)");
    return parts.length ? parts.join("; ") : "(none)";
  }
  function renderSummary() {
    var box = document.getElementById("aw-summary");
    if (!box) return;
    var actionLines = (draft.actions || []).map(function (a) { return escapeHtml(actionSummary(a)); });
    var escLine = draft.escalation && draft.escalation.tiers && draft.escalation.tiers.length
      ? draft.escalation.tiers.length + " tier(s), stops on " + (draft.escalation.stopOn === "clear" ? "clear" : "acknowledge")
      : "off";
    box.innerHTML = '<dl class="review-grid">' +
      '<dt>Name</dt><dd>' + escapeHtml(draft.name || "…") + ' <span class="badge badge-level-' + (draft.severity || "warning") + '">' + escapeHtml((draft.severity || "warning").toUpperCase()) + '</span>' + (draft.enabled === false ? ' <span class="badge">disabled</span>' : "") + '</dd>' +
      '<dt>Devices</dt><dd>' + escapeHtml(scopeSummaryText(draft.scope)) + '</dd>' +
      '<dt>Trigger</dt><dd>' + triggerSentence(draft.trigger) + '</dd>' +
      '<dt>Reset</dt><dd>' + resetSentence(draft.reset, draft.trigger, draft.cooldownSec) + '</dd>' +
      '<dt>Actions</dt><dd>' + (actionLines.length ? actionLines.join("<br>") : '<span style="color:var(--color-text-tertiary)">in-app alert only</span>') + '</dd>' +
      '<dt>Escalation</dt><dd>' + escapeHtml(escLine) + '</dd>' +
    '</dl>';
  }

  // ── Token palette wiring (per panel) ───────────────────────────────────
  var _tplFocus = null;
  function wireTokenPalette(panel) {
    panel.querySelectorAll(".tpl-field").forEach(function (el) {
      if (el._tplWired) return; el._tplWired = true;
      el.addEventListener("focus", function () { _tplFocus = el; });
    });
    panel.querySelectorAll(".tpl-token").forEach(function (chip) {
      if (chip._tplWired) return; chip._tplWired = true;
      chip.addEventListener("click", function () {
        var el = _tplFocus;
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
  }

  // ── Navigation ─────────────────────────────────────────────────────────
  var COLLECT = { 1: collectStep1, 2: collectStep2, 3: collectStep3, 4: collectStep4, 5: collectStep5 };
  var VALIDATE = { 1: validateStep1, 2: validateStep2, 3: validateStep3, 4: validateStep4, 5: validateStep5 };

  function updateStepper() {
    document.querySelectorAll("#aw-stepper .stepper-step").forEach(function (el) {
      var n = Number(el.getAttribute("data-step"));
      el.classList.toggle("active", n === step);
      el.classList.toggle("done", n < step);
      el.classList.toggle("clickable", n <= visited && n !== step);
    });
    document.querySelectorAll("#aw-stepper .stepper-line").forEach(function (el) {
      el.classList.toggle("done", Number(el.getAttribute("data-line")) < step);
    });
  }
  function syncFooter() {
    document.getElementById("aw-back").style.display = step > 1 ? "" : "none";
    document.getElementById("aw-next").style.display = step < 5 ? "" : "none";
    document.getElementById("aw-save").style.display = (step === 5 || editing) ? "" : "none";
  }
  function goToStep(n, opts) {
    opts = opts || {};
    if (!opts.skipCollect) COLLECT[step]();
    if (opts.validate) {
      var problem = VALIDATE[step]();
      if (problem) { showToast(problem, "error"); return false; }
    }
    // Cancel in-flight preview timers when leaving their steps.
    if (step === 2 && scopePreviewTimer) { clearTimeout(scopePreviewTimer); scopePreviewTimer = null; }
    if (step === 3 && trigPreviewTimer) { clearTimeout(trigPreviewTimer); trigPreviewTimer = null; }
    document.getElementById("aw-step-" + step).classList.remove("visible");
    step = n;
    visited = Math.max(visited, n);
    // Steps 4 + 5 re-render on entry (they depend on earlier steps' state).
    if (n === 4) renderStep4();
    if (n === 5) renderStep5();
    document.getElementById("aw-step-" + n).classList.add("visible");
    updateStepper();
    syncFooter();
    var mb = document.querySelector(".modal-body");
    if (mb) mb.scrollTop = 0;
    if (n === 2) scheduleScopePreview();
    return true;
  }

  document.getElementById("aw-next").addEventListener("click", function () { goToStep(step + 1, { validate: true }); });
  document.getElementById("aw-back").addEventListener("click", function () { goToStep(step - 1); });
  document.querySelectorAll("#aw-stepper .stepper-step").forEach(function (el) {
    el.addEventListener("click", function () {
      var n = Number(el.getAttribute("data-step"));
      if (n <= visited && n !== step) goToStep(n);
    });
  });
  document.getElementById("aw-cancel").addEventListener("click", function () {
    COLLECT[step]();
    if (!editing && (draft.name || (draft.actions || []).length)) _awDraftStash = draft; // in-memory only
    closeModal();
  });

  document.getElementById("aw-save").addEventListener("click", async function () {
    COLLECT[step]();
    // Validate every step; jump to the first failing one.
    for (var i = 1; i <= 5; i++) {
      var problem = VALIDATE[i]();
      if (problem) {
        if (i !== step) goToStep(i, { skipCollect: true });
        showToast(problem, "error");
        return;
      }
    }
    var payload = {
      name: draft.name,
      description: draft.description,
      enabled: draft.enabled,
      severity: draft.severity,
      trigger: draft.trigger,
      scope: findType(draft.trigger.type) && findType(draft.trigger.type).scoped ? draft.scope : {},
      reset: draft.reset,
      actions: draft.actions,
      cooldownSec: draft.cooldownSec,
      messageTemplate: draft.messageTemplate,
      channels: ["in_app"],
      emailComposition: null, // per-action composition in v2; rule-level field retired by the wizard
      escalation: draft.escalation,
    };
    this.disabled = true;
    try {
      if (editing) await api.automations.update(editing.id, payload);
      else await api.automations.create(payload);
      _awDraftStash = null;
      closeModal();
      showToast(editing ? "Automation saved" : "Automation created", "success");
      if (window._reloadRules) window._reloadRules();
    } catch (err) { this.disabled = false; showToast(err.message || "Save failed", "error"); }
  });

  // ── First render ───────────────────────────────────────────────────────
  var sevSel = document.getElementById("aw-severity");
  if (sevSel) {
    sevSel.addEventListener("change", function () {
      sevSel.className = "sev-select sev-" + sevSel.value;
    });
  }
  wireStep2();
  wireStep3();
  updateStepper();
  syncFooter();
}

/** Rule record (API row, rule-shape v2 via the server's withV2 read) → wizard
 *  draft. Escalation may still be stored in the legacy email-tier shape —
 *  convert it to v2 tiers-of-actions exactly like the server's
 *  normalizeEscalationToV2 (tier overrides → the notify action's
 *  emailComposition). */
function _awDraftFromRule(r) {
  var esc = r.escalation || null;
  if (esc && Array.isArray(esc.tiers) && esc.tiers.length && esc.tiers[0].actions === undefined) {
    esc = {
      stopOn: esc.stopOn || "acknowledge",
      tiers: esc.tiers.map(function (t) {
        var hasComp = t.subjectTemplate != null || t.bodyTextTemplate != null || t.bodyHtmlTemplate != null || t.cc != null || t.bcc != null;
        var action = { type: "notify", channelId: t.channelId };
        if (t.to && t.to.recipientUserIds && t.to.recipientUserIds.length) action.recipientUserIds = t.to.recipientUserIds;
        if (t.to && t.to.addresses && t.to.addresses.length) action.addresses = t.to.addresses;
        if (hasComp) {
          action.emailComposition = {};
          if (t.subjectTemplate != null) action.emailComposition.subjectTemplate = t.subjectTemplate;
          if (t.bodyTextTemplate != null) action.emailComposition.bodyTextTemplate = t.bodyTextTemplate;
          if (t.bodyHtmlTemplate != null) action.emailComposition.bodyHtmlTemplate = t.bodyHtmlTemplate;
          if (t.cc != null) action.emailComposition.cc = t.cc;
          if (t.bcc != null) action.emailComposition.bcc = t.bcc;
        }
        var tier = { afterMin: t.afterMin, actions: [action] };
        if (t.repeatEveryMin != null) tier.repeatEveryMin = t.repeatEveryMin;
        if (t.maxRepeats != null) tier.maxRepeats = t.maxRepeats;
        return tier;
      }),
    };
  }
  return {
    name: r.name || "",
    description: r.description != null ? r.description : null,
    enabled: r.enabled !== false,
    severity: r.severity || "warning",
    trigger: JSON.parse(JSON.stringify(r.trigger || { type: "asset_metric" })),
    scope: JSON.parse(JSON.stringify(r.scope || {})),
    reset: r.reset ? JSON.parse(JSON.stringify(r.reset)) : null,
    cooldownSec: r.cooldownSec != null ? r.cooldownSec : null,
    messageTemplate: r.messageTemplate != null ? r.messageTemplate : null,
    actions: JSON.parse(JSON.stringify(Array.isArray(r.actions) ? r.actions : [])),
    escalation: esc ? JSON.parse(JSON.stringify(esc)) : null,
  };
}
