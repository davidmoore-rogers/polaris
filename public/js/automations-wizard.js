/**
 * public/js/automations-wizard.js — the 6-step automation builder.
 *
 * openAutomationWizard(existing) replaces the old single-form rule builder:
 *   Step 1  Name & description (+ severity + enabled)
 *   Step 2  Asset filtering — "All assets" checkbox (default) or a nested
 *           AND/OR condition builder with drag-and-drop; live device preview
 *   Step 3  Trigger conditions — device/host triggers use the same AND/OR
 *           tree builder (1 condition saves as the legacy single trigger,
 *           2+ as a per-asset composite); event/change keep flat fields;
 *           live plain-English sentence + current-value test with per-leaf
 *           breakdown
 *   Step 4  Reset conditions — default-checked "trigger no longer true"
 *           (auto, with hysteresis/sustain extras); unchecked reveals
 *           timed / manual (+ a custom AND/OR reset-condition tree for
 *           composite triggers → reset mode "condition")
 *   Step 5  Automations (actions: notify / api_call / script) + escalation
 *           tiers of actions
 *   Step 6  Summary — review grid + the list of devices the automation
 *           affects (live scope preview)
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

// ─── Sentence builder (pure; factory over the /schema payload) ───
// Everything the live wizard sentence + summary rendering needs, closed over
// only the schema `s` — no draft/DOM state — so it is unit-testable
// (tests/unit/automationSentences.test.ts evaluates this file in a Node vm
// and pulls the factory off window.PolarisAutomationSentences, same idiom as
// the appmap filter core). Extracted verbatim from openAutomationWizard 2026-08.
function makeAutomationSentences(s) {
  function findType(t) { return s.triggerTypes.find(function (x) { return x.type === t; }); }
  /** Device-scoped? Composite depends on kind (host composites ignore scope). */
  function isTriggerScoped(tr) {
    if (!tr || !tr.type) return true;
    if (tr.type === "composite") return tr.kind !== "host";
    var def = findType(tr.type);
    return !!(def && def.scoped);
  }
  function metricLabel(m) { var x = s.metricMeta && s.metricMeta[m]; return x ? x.label : m; }
  function metricUnit(m) { var x = s.metricMeta && s.metricMeta[m]; return (x && x.unit) || ""; }
  // hwSensorValue's unit depends on the sensor class in the dimension filter
  // (metricMeta carries the "(sensor unit)" placeholder) — resolve it from the
  // schema's sensorClassUnits map (temperature → °C, fan → RPM, voltage → V,
  // disk → °C). "" when the class is empty/unknown or the class has no unit.
  function leafUnit(metric, df) {
    var u = metricUnit(metric);
    if (u !== "(sensor unit)") return u;
    var cls = df && df.sensorClass ? String(df.sensorClass).trim().toLowerCase() : "";
    return (cls && s.sensorClassUnits && s.sensorClassUnits[cls]) || "";
  }
  function fieldLabel(f) { var x = s.fieldMeta && s.fieldMeta[f]; return x ? x.label : f; }
  function changeLabel(c) { return (s.changeTypeMeta && s.changeTypeMeta[c]) || c; }

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
  function tgLeafPhrase(leaf) {
    if (!leaf || !leaf.type) return "…";
    if (leaf.type === "asset_state") {
      return fieldLabel(leaf.field) + " " + (CMP_PHRASE[leaf.operator] || leaf.operator) + " " + String(leaf.value == null || leaf.value === "" ? "…" : leaf.value);
    }
    var unit = leafUnit(leaf.metric, leaf.dimensionFilter); unit = unit ? " " + unit : "";
    var agg = leaf.aggregation && leaf.aggregation !== "latest" && leaf.windowSec
      ? " (" + (AGG_PHRASE[leaf.aggregation] || leaf.aggregation) + " " + humanDuration(leaf.windowSec) + ")" : "";
    var thr = leaf.threshold == null || isNaN(leaf.threshold) ? "…" : leaf.threshold;
    var out = (leaf.type === "host_metric" ? "the Polaris host's " : "") + metricLabel(leaf.metric) + agg + " " + (CMP_PHRASE[leaf.operator] || leaf.operator) + " " + thr + unit;
    var df = leaf.dimensionFilter || {};
    Object.keys(df).forEach(function (k) {
      if (df[k]) out += " " + (DIM_PHRASE[k] || k + " = {value}").replace("{value}", df[k]);
    });
    return out;
  }
  function tgTreePhrase(node) {
    var parts = (node.children || []).map(function (c) {
      if (c && c.type === undefined && Array.isArray(c.children)) return "(" + tgTreePhrase(c) + ")";
      return tgLeafPhrase(c);
    });
    return parts.join(node.op === "or" ? " OR " : " AND ");
  }
  function triggerSentence(tr) {
    if (!tr || !tr.type) return "…";
    var out;
    if (tr.type === "composite") {
      out = "When <strong>" + escapeHtml(tgTreePhrase({ op: tr.op, children: tr.children || [] }) || "…") + "</strong>";
      if (tr.forDurationSec > 0) out += ", sustained for <strong>" + humanDuration(tr.forDurationSec) + "</strong>";
      return out + ".";
    }
    if (tr.type === "asset_metric" || tr.type === "host_metric") {
      var subject = tr.type === "host_metric" ? "the Polaris host's " + metricLabel(tr.metric) : metricLabel(tr.metric);
      var agg = tr.aggregation && tr.aggregation !== "latest" && tr.windowSec
        ? " (" + (AGG_PHRASE[tr.aggregation] || tr.aggregation) + " " + humanDuration(tr.windowSec) + ")" : "";
      var thr = tr.threshold == null || isNaN(tr.threshold) ? "…" : tr.threshold;
      var unit = leafUnit(tr.metric, tr.dimensionFilter); unit = unit ? " " + unit : "";
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
    } else if (reset.mode === "condition") {
      out = "Resets when <strong>" + escapeHtml(reset.condition ? tgTreePhrase(reset.condition) : "…") + "</strong>";
      if (reset.sustainSec > 0) out += " and stays that way for <strong>" + humanDuration(reset.sustainSec) + "</strong>";
      out += ".";
    } else {
      var numeric = tr && (tr.type === "asset_metric" || tr.type === "host_metric");
      if (numeric && reset.clearThreshold != null && !isNaN(reset.clearThreshold)) {
        var invOp = INV_CMP[tr.operator] || "<";
        var unit = leafUnit(tr.metric, tr.dimensionFilter); unit = unit ? " " + unit : "";
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

  return {
    findType: findType, isTriggerScoped: isTriggerScoped,
    metricLabel: metricLabel, metricUnit: metricUnit, leafUnit: leafUnit,
    fieldLabel: fieldLabel, changeLabel: changeLabel, humanDuration: humanDuration,
    tgLeafPhrase: tgLeafPhrase, tgTreePhrase: tgTreePhrase,
    triggerSentence: triggerSentence, resetSentence: resetSentence,
    CMP_PHRASE: CMP_PHRASE, INV_CMP: INV_CMP, AGG_PHRASE: AGG_PHRASE, DIM_PHRASE: DIM_PHRASE,
  };
}
if (typeof window !== "undefined") window.PolarisAutomationSentences = { make: makeAutomationSentences };

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
  var visited = editing ? 6 : 1;
  var STEPS = ["Name", "Devices", "Trigger", "Reset", "Actions", "Summary"];
  var scopePreviewTimer = null;
  var trigPreviewTimer = null;
  // Step-5 escalation: shows/hides the "stop escalating when" config as
  // escalation rows come and go (set by renderStep5, called by addTierRow).
  var _escSyncFn = null;

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
  // Schema-label + sentence helpers — the pure factory above owns them; the
  // wizard aliases what its step renderers reference.
  var _sent = makeAutomationSentences(s);
  var findType = _sent.findType, isTriggerScoped = _sent.isTriggerScoped,
      metricLabel = _sent.metricLabel, metricUnit = _sent.metricUnit, leafUnit = _sent.leafUnit,
      fieldLabel = _sent.fieldLabel, changeLabel = _sent.changeLabel,
      humanDuration = _sent.humanDuration, tgTreePhrase = _sent.tgTreePhrase,
      triggerSentence = _sent.triggerSentence, resetSentence = _sent.resetSentence,
      CMP_PHRASE = _sent.CMP_PHRASE, INV_CMP = _sent.INV_CMP;
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


  // Builder vocabularies — must initialize BEFORE the body assembly below
  // (step2Html/step3Html render from them during the openModal call).
  var tgMeta = s.compositeMeta || {
    groupOps: ["and", "or"],
    groupOpLabels: { and: "All conditions must be met (AND)", or: "At least one condition must be met (OR)" },
    maxDepth: 3, maxLeaves: 10,
    anyDimensionNote: "With multiple conditions, an automation alerts once per device; a per-sensor/per-interface condition counts as met when any of them crosses.",
  };
  var TRIGGER_CATEGORIES = [
    { value: "device", label: "Device conditions" },
    { value: "host", label: "Polaris host conditions" },
    { value: "event", label: (findType("event") || {}).label || "Audit event match" },
    { value: "change", label: (findType("change") || {}).label || "Change detection" },
  ];
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
      // Asset ID intentionally omitted — a raw id targets one device with no
      // precedence meaning; use hostname. Saved rules using it still evaluate.
    ],
    maxDepth: 5,
  };

  // ── Modal shell: stepper + panels + footer ─────────────────────────────
  function stepperHtml() {
    var parts = [];
    for (var i = 1; i <= STEPS.length; i++) {
      parts.push('<div class="stepper-step" data-step="' + i + '"><span class="stepper-num">' + i + '</span><span>' + STEPS[i - 1] + '</span></div>');
      if (i < STEPS.length) parts.push('<div class="stepper-line" data-line="' + i + '"></div>');
    }
    return '<div class="stepper" id="aw-stepper">' + parts.join("") + '</div>';
  }

  var body =
    stepperHtml() +
    '<div class="step-panel visible" id="aw-step-1">' + step1Html() + '</div>' +
    '<div class="step-panel" id="aw-step-2">' + step2Html() + '</div>' +
    '<div class="step-panel" id="aw-step-3">' + step3Html() + '</div>' +
    '<div class="step-panel" id="aw-step-4"></div>' + // rendered on entry (depends on trigger type)
    '<div class="step-panel" id="aw-step-5"></div>' + // rendered on entry (actions/escalation)
    '<div class="step-panel" id="aw-step-6"></div>' + // rendered on entry (summary + affected devices)
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
      '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 1rem">Name it and describe what it watches for. (Severity is set with the trigger on the next steps.)</p>' +
      '<div class="form-group"><label>Name</label><input type="text" id="aw-name" value="' + escapeHtml(draft.name || "") + '" placeholder="e.g. Switch temperature high"></div>' +
      '<div class="form-group"><label>Description (optional)</label><input type="text" id="aw-desc" value="' + escapeHtml(draft.description || "") + '"></div>';
  }
  function collectStep1() {
    draft.name = document.getElementById("aw-name").value.trim();
    draft.description = document.getElementById("aw-desc").value.trim() || null;
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
      '<span class="aw-grip" draggable="true" title="Drag to move">&#x2842;</span>' +
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
        (depth > 0 ? '<span class="aw-grip" draggable="true" title="Drag to move group">&#x2842;</span>' : "") +
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
    var allAssets = !scope.condition && (scope.allAssets === true || Object.keys(scope).length === 0);
    var root = scope.condition
      ? JSON.parse(JSON.stringify(scope.condition))
      : (allAssets ? { op: "and", children: [] } : legacyScopeToCondition(scope));
    return '<h3 style="margin:0 0 0.25rem">Which devices?</h3>' +
      '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 0.75rem">Polaris-host and audit-event triggers aren’t tied to assets and ignore this filter.</p>' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label style="font-weight:600"><input type="checkbox" id="aw-all-assets"' + (allAssets ? " checked" : "") + '> All assets</label>' +
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0 24px">Uncheck to filter which devices this automation applies to.</p></div>' +
      '<div id="aw-cond-wrap" style="display:' + (allAssets ? "none" : "block") + '">' +
        '<p style="font-size:0.82rem;color:var(--color-text-tertiary);margin:0 0 0.5rem">Build the filter from conditions and nested groups — drag the <span class="aw-grip" style="cursor:default">&#x2842;</span> handle to move a condition into another group or reorder groups.</p>' +
        '<div id="aw-cond-root">' + scGroupHtml(root, 0) + '</div>' +
        '<div id="aw-scope-preview" style="margin-top:0.75rem"></div>' +
      '</div>';
  }
  function wireStep2() {
    var panel = document.getElementById("aw-step-2");
    var allCb = panel.querySelector("#aw-all-assets");
    if (allCb) {
      allCb.addEventListener("change", function () {
        var wrap = panel.querySelector("#aw-cond-wrap");
        wrap.style.display = allCb.checked ? "none" : "block";
        if (!allCb.checked) {
          // Revealed with an empty root: seed a starter row so the operator
          // lands on something editable.
          var kids = panel.querySelector("#aw-cond-root > .scg-group > .scg-children");
          if (kids && kids.children.length === 0) kids.insertAdjacentHTML("beforeend", scRuleRowHtml(null));
          scheduleScopePreview();
        }
      });
    }
    wireCondDnD(panel, "#aw-cond-root", scheduleScopePreview);
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
        if (depth >= (scMeta.maxDepth || 5)) { showToast("Groups nest at most " + (scMeta.maxDepth || 5) + " levels", "info"); return; }
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
  // ── Condition-tree drag & drop (shared by the devices / trigger / reset
  // builders). Grip handles (.aw-grip) start the drag (dashboard tab-grip
  // pattern: the dragged element is stashed module-side because dataTransfer
  // is unreadable during dragover); rows/groups accept before/after drops by
  // cursor midpoint, empty group bodies accept drop-into. DOM order IS the
  // tree — collect just walks it, so a move needs no model bookkeeping.
  var _awDragEl = null;
  var _awDropCue = null;
  function awClearDropCue() {
    if (_awDropCue) { _awDropCue.classList.remove("aw-drop-before", "aw-drop-after", "aw-drop-into"); _awDropCue = null; }
  }
  function awGroupDepthOf(el, rootEl) {
    var d = 0;
    var p = el.parentElement;
    while (p && p !== rootEl) {
      if (p.classList && p.classList.contains("scg-group")) d++;
      p = p.parentElement;
    }
    return d;
  }
  function awSubtreeHeight(el) {
    // How many group levels the dragged element itself adds (row = 0).
    if (!el.classList.contains("scg-group")) return 0;
    var max = 1;
    el.querySelectorAll(".scg-group").forEach(function (g) {
      var d = 1;
      var p = g.parentElement;
      while (p && p !== el) {
        if (p.classList.contains("scg-group")) d++;
        p = p.parentElement;
      }
      if (d + 1 > max) max = d + 1;
    });
    return max;
  }
  function awFixDepths(rootEl) {
    var boundary = rootEl.parentElement || rootEl;
    rootEl.querySelectorAll(".scg-group").forEach(function (g) {
      var depth = awGroupDepthOf(g, boundary);
      g.setAttribute("data-depth", String(depth));
      g.style.borderLeftColor = depth === 0 ? "var(--color-accent)" : "var(--color-success)";
    });
  }
  function wireCondDnD(panel, rootSelector, onChange, maxDepthOverride) {
    panel.addEventListener("dragstart", function (e) {
      var grip = e.target && e.target.classList && e.target.classList.contains("aw-grip") ? e.target : null;
      if (!grip) return;
      var el = grip.closest(".scr-row, .scg-group");
      var root = panel.querySelector(rootSelector);
      if (!el || !root || !root.contains(el)) return;
      _awDragEl = el;
      try { e.dataTransfer.setData("text/plain", ""); e.dataTransfer.effectAllowed = "move"; } catch (_e) {}
    });
    panel.addEventListener("dragover", function (e) {
      if (!_awDragEl) return;
      var root = panel.querySelector(rootSelector);
      if (!root) return;
      var over = e.target.closest && e.target.closest(".scr-row, .scg-children, .scg-group");
      if (!over || !root.contains(over) || _awDragEl.contains(over)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "move"; } catch (_e) {}
      awClearDropCue();
      if (over.classList.contains("scg-children")) {
        // Hovering a group's (possibly empty) body → drop into it.
        over.classList.add("aw-drop-into");
        _awDropCue = over;
      } else {
        var rect = over.getBoundingClientRect();
        var before = e.clientY - rect.top < rect.height / 2;
        over.classList.add(before ? "aw-drop-before" : "aw-drop-after");
        _awDropCue = over;
      }
    });
    panel.addEventListener("drop", function (e) {
      if (!_awDragEl) return;
      var root = panel.querySelector(rootSelector);
      var cue = _awDropCue;
      awClearDropCue();
      if (!root || !cue || !root.contains(cue) || _awDragEl.contains(cue)) { _awDragEl = null; return; }
      e.preventDefault();
      var maxDepth = maxDepthOverride || scMeta.maxDepth || 5;
      var destChildren = null;
      var beforeEl = null;
      if (cue.classList.contains("scg-children")) {
        destChildren = cue;
      } else if (cue.classList.contains("scr-row")) {
        destChildren = cue.parentElement;
        beforeEl = e.clientY - cue.getBoundingClientRect().top < cue.getBoundingClientRect().height / 2 ? cue : cue.nextElementSibling;
      } else { // scg-group
        destChildren = cue.parentElement;
        if (!destChildren.classList.contains("scg-children")) { _awDragEl = null; return; } // root group — can't sibling it
        beforeEl = e.clientY - cue.getBoundingClientRect().top < cue.getBoundingClientRect().height / 2 ? cue : cue.nextElementSibling;
      }
      // Depth cap (matches the render rule: child groups live at depth ≤
      // maxDepth-1): destination group depth + the dragged subtree's height.
      var destGroup = destChildren.closest(".scg-group");
      var h = awSubtreeHeight(_awDragEl); // rows = 0, plain group = 1, nested deeper
      if (h > 0 && awGroupDepthOf(destGroup, panel) + h > maxDepth - 1) {
        showToast("That move would nest groups more than " + maxDepth + " levels deep", "info");
        _awDragEl = null;
        return;
      }
      if (beforeEl) destChildren.insertBefore(_awDragEl, beforeEl);
      else destChildren.appendChild(_awDragEl);
      _awDragEl = null;
      awFixDepths(root);
      if (onChange) onChange();
    });
    panel.addEventListener("dragend", function () {
      _awDragEl = null;
      awClearDropCue();
    });
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
    var cb = document.getElementById("aw-all-assets");
    if (cb && cb.checked) { draft.scope = { allAssets: true }; return; }
    var root = document.querySelector("#aw-cond-root > .scg-group");
    if (!root) return;
    var tree = scCollectGroup(root);
    // With "All assets" unchecked an empty tree is NOT all-assets — validation
    // asks for a condition or a re-check so nothing matches silently.
    draft.scope = { condition: tree };
  }
  function validateStep2() {
    if (!isTriggerScoped(draft.trigger)) return null; // non-scoped triggers ignore the filter
    var sc = draft.scope || {};
    if (sc.allAssets || !sc.condition) return null;
    if (!sc.condition.children.length) {
      return 'Add at least one condition, or check "All assets".';
    }
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

  // ── Step 3: Trigger conditions (AND/OR condition tree) ─────────────────
  // Device / Polaris-host triggers use the same nested group builder as the
  // Devices step: leaf rows are metric/state conditions, groups combine with
  // AND/OR (only — negation would fire on missing data), drag-and-drop moves
  // conditions between groups. One condition saves as the legacy single
  // trigger (per-sensor/-mount alerting + hysteresis); two or more save as a
  // composite that alerts once per device. Audit-event and change triggers
  // keep their flat fields.
  function triggerCategoryOf(tr) {
    if (!tr || !tr.type) return "device";
    if (tr.type === "composite") return tr.kind === "host" ? "host" : "device";
    if (tr.type === "host_metric") return "host";
    if (tr.type === "event" || tr.type === "change") return tr.type;
    return "device";
  }
  function tgDefaultLeaf(kind) {
    return kind === "host"
      ? { type: "host_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: null }
      : { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: null };
  }
  function triggerToTree(tr, kind) {
    if (tr && tr.type === "composite" && (tr.kind || "asset") === kind) {
      return { op: tr.op || "and", children: JSON.parse(JSON.stringify(tr.children || [])) };
    }
    var leafKinds = kind === "host" ? ["host_metric"] : ["asset_metric", "asset_state"];
    if (tr && leafKinds.indexOf(tr.type) !== -1) {
      var leaf = JSON.parse(JSON.stringify(tr));
      delete leaf.forDurationSec;
      return { op: "and", children: [leaf] };
    }
    return { op: "and", children: [tgDefaultLeaf(kind)] };
  }
  /** Mirror of the server's collapseCompositeTrigger: 1 leaf ⇒ legacy single
   *  trigger (so Step 4 offers hysteresis and the stored shape matches). */
  function tgCollapse(tr) {
    var op = tr.op, children = tr.children;
    while (children.length === 1 && children[0] && children[0].type === undefined && Array.isArray(children[0].children)) {
      op = children[0].op; children = children[0].children;
    }
    if (children.length === 1 && children[0] && children[0].type !== undefined) {
      var leaf = JSON.parse(JSON.stringify(children[0]));
      leaf.forDurationSec = tr.forDurationSec || 0;
      return leaf;
    }
    return { type: "composite", kind: tr.kind, op: op, children: children, forDurationSec: tr.forDurationSec || 0 };
  }
  function tgLeaves(node) {
    var out = [];
    (node.children || []).forEach(function (c) {
      if (c && c.type !== undefined) out.push(c);
      else if (c) out = out.concat(tgLeaves(c));
    });
    return out;
  }
  function tgGroupOpOptions(sel) {
    return (tgMeta.groupOps || ["and", "or"]).map(function (o) {
      return '<option value="' + o + '"' + (o === sel ? " selected" : "") + '>' + escapeHtml((tgMeta.groupOpLabels || {})[o] || o) + '</option>';
    }).join("");
  }
  function tgWhatOptions(kind, selWhat) {
    if (kind === "host") {
      var hm = (findType("host_metric") || {}).metrics || [];
      return hm.map(function (m) {
        var v = "m:" + m;
        return '<option value="' + v + '"' + (v === selWhat ? " selected" : "") + '>' + escapeHtml(metricLabel(m)) + '</option>';
      }).join("");
    }
    var metrics = (findType("asset_metric") || {}).metrics || [];
    var fields = (findType("asset_state") || {}).fields || [];
    return '<optgroup label="Metrics">' + metrics.map(function (m) {
      var v = "m:" + m;
      return '<option value="' + v + '"' + (v === selWhat ? " selected" : "") + '>' + escapeHtml(metricLabel(m)) + '</option>';
    }).join("") + '</optgroup><optgroup label="Device state">' + fields.map(function (f) {
      var v = "f:" + f;
      return '<option value="' + v + '"' + (v === selWhat ? " selected" : "") + '>' + escapeHtml(fieldLabel(f)) + '</option>';
    }).join("") + '</optgroup>';
  }
  function tgStateValueControl(field, val) {
    var meta = s.fieldMeta && s.fieldMeta[field];
    var v = val != null ? String(val) : "";
    if (meta && (meta.kind === "enum" || meta.kind === "bool") && meta.values) {
      return '<select class="tgl-value" style="width:130px">' + opt(meta.values, v) + '</select>';
    }
    if (meta && meta.kind === "number") return '<input type="number" class="tgl-value" value="' + escapeHtml(v) + '" style="width:110px" placeholder="e.g. 3">';
    return '<input type="text" class="tgl-value" value="' + escapeHtml(v) + '" style="width:130px" placeholder="e.g. up / down">';
  }
  function tgLeafRowHtml(leaf, kind) {
    leaf = leaf || tgDefaultLeaf(kind);
    var isState = leaf.type === "asset_state";
    var what = isState ? "f:" + leaf.field : "m:" + leaf.metric;
    // Unit chip sits beside the threshold value it qualifies (read-only —
    // never part of the input). hwSensorValue resolves it from the typed
    // sensor class; "sensor unit" is the unresolved placeholder.
    var unit = "";
    if (!isState) {
      unit = leafUnit(leaf.metric, leaf.dimensionFilter || {});
      if (!unit && metricUnit(leaf.metric) === "(sensor unit)") unit = "sensor unit";
    }
    var line1 =
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<span class="aw-grip" draggable="true" title="Drag to move">&#x2842;</span>' +
        '<select class="tgl-what" style="flex:1;min-width:0">' + tgWhatOptions(kind, what) + '</select>' +
        '<select class="tgl-op" style="width:64px">' + opt(s.comparators, leaf.operator || (isState ? "==" : ">=")) + '</select>' +
        (isState
          ? tgStateValueControl(leaf.field, leaf.value)
          : '<input type="number" step="any" class="tgl-threshold" value="' + (leaf.threshold != null && !isNaN(leaf.threshold) ? leaf.threshold : "") + '" placeholder="value" style="width:110px">' +
            (unit ? '<span class="tgl-unit" style="font-size:0.8rem;color:var(--color-text-tertiary);white-space:nowrap">' + escapeHtml(unit) + '</span>' : "")) +
        '<button type="button" class="btn btn-sm btn-danger scr-remove" title="Remove condition">&times;</button>' +
      '</div>';
    var line2 = "";
    if (!isState) {
      var dims = kind === "host" ? [] : ((s.metricDimensions && s.metricDimensions[leaf.metric]) || []);
      var df = leaf.dimensionFilter || {};
      var dimInputs = dims.map(function (d) {
        return '<input type="text" class="tgl-dim" data-dim="' + d + '" placeholder="' + escapeHtml(DIM_PLACEHOLDER[d] || d) + '" value="' + escapeHtml(df[d] || "") + '" style="flex:1;min-width:120px">';
      }).join("");
      line2 =
        '<div class="tgl-line2" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0 0 22px;font-size:0.8rem;color:var(--color-text-tertiary)">' +
          '<select class="tgl-agg" style="width:auto;font-size:0.8rem">' + opt(s.aggregations, leaf.aggregation || "latest") + '</select>' +
          '<span>over</span><input type="number" class="tgl-window" value="' + (leaf.windowSec || 0) + '" style="width:70px"><span>sec (0 = latest)</span>' +
          dimInputs +
        '</div>';
    }
    return '<div class="scr-row" style="margin:4px 0;padding:4px;border:1px solid var(--color-border);border-radius:6px">' + line1 + line2 + '</div>';
  }
  function tgGroupHtml(group, depth, kind) {
    group = group || { op: "and", children: [] };
    var inner = (group.children || []).map(function (c) {
      return c && c.type === undefined && Array.isArray(c.children)
        ? tgGroupHtml(c, depth + 1, kind)
        : tgLeafRowHtml(c, kind);
    }).join("");
    return '<div class="scg-group" data-depth="' + depth + '" style="border:1px solid var(--color-border);border-left:3px solid ' + (depth === 0 ? "var(--color-accent)" : "var(--color-success)") + ';border-radius:6px;padding:0.55rem;margin:4px 0">' +
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:2px">' +
        (depth > 0 ? '<span class="aw-grip" draggable="true" title="Drag to move group">&#x2842;</span>' : "") +
        '<select class="scg-op" style="flex:1;font-size:0.85rem">' + tgGroupOpOptions(group.op || "and") + '</select>' +
        (depth > 0 ? '<button type="button" class="btn btn-sm btn-danger scg-remove" title="Remove group">&times;</button>' : "") +
      '</div>' +
      '<div class="scg-children">' + inner + '</div>' +
      '<div style="margin-top:4px">' +
        '<button type="button" class="btn btn-sm btn-secondary scg-add-rule">+ Condition</button> ' +
        (depth + 1 < (tgMeta.maxDepth || 3) ? '<button type="button" class="btn btn-sm btn-secondary scg-add-group">+ Group</button>' : "") +
      '</div>' +
    '</div>';
  }
  function tgCollectLeaf(rowEl, kind) {
    var what = rowEl.querySelector(".tgl-what").value;
    var op = rowEl.querySelector(".tgl-op").value;
    if (what.indexOf("f:") === 0) {
      var vEl = rowEl.querySelector(".tgl-value");
      return { type: "asset_state", field: what.slice(2), operator: op, value: vEl ? vEl.value : "" };
    }
    var leaf = {
      type: kind === "host" ? "host_metric" : "asset_metric",
      metric: what.slice(2),
      aggregation: (rowEl.querySelector(".tgl-agg") || { value: "latest" }).value || "latest",
      windowSec: Number((rowEl.querySelector(".tgl-window") || { value: 0 }).value) || 0,
      operator: op,
      threshold: Number(rowEl.querySelector(".tgl-threshold").value),
    };
    if (kind !== "host") {
      var df = {};
      rowEl.querySelectorAll(".tgl-dim").forEach(function (el) { var v = el.value.trim(); if (v) df[el.getAttribute("data-dim")] = v; });
      if (Object.keys(df).length) leaf.dimensionFilter = df;
    }
    return leaf;
  }
  function tgCollectGroup(groupEl, kind) {
    var op = groupEl.querySelector(":scope > div > .scg-op").value;
    var children = [];
    groupEl.querySelectorAll(":scope > .scg-children > *").forEach(function (el) {
      if (el.classList.contains("scr-row")) children.push(tgCollectLeaf(el, kind));
      else if (el.classList.contains("scg-group")) children.push(tgCollectGroup(el, kind));
    });
    return { op: op, children: children };
  }
  /** Delegated wiring for a trigger-style condition tree (Step 3 + the Step-4
   *  reset builder). Added ONCE per panel (guard flag) — renders may replace
   *  the inner HTML freely. kindFn is read at event time (device↔host swaps). */
  function wireTgTree(panel, rootSelector, kindFn, onChange) {
    if (panel._tgWired) return;
    panel._tgWired = true;
    panel.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest("button");
      if (!btn) return;
      var root = panel.querySelector(rootSelector);
      if (!root || !root.contains(btn)) return;
      if (btn.classList.contains("scr-remove")) {
        btn.closest(".scr-row").remove();
        onChange();
      } else if (btn.classList.contains("scg-remove")) {
        btn.closest(".scg-group").remove();
        onChange();
      } else if (btn.classList.contains("scg-add-rule")) {
        btn.closest(".scg-group").querySelector(":scope > .scg-children")
          .insertAdjacentHTML("beforeend", tgLeafRowHtml(null, kindFn()));
        onChange();
      } else if (btn.classList.contains("scg-add-group")) {
        var g = btn.closest(".scg-group");
        var depth = Number(g.getAttribute("data-depth")) + 1;
        if (depth >= (tgMeta.maxDepth || 3)) { showToast("Groups nest at most " + (tgMeta.maxDepth || 3) + " levels", "info"); return; }
        g.querySelector(":scope > .scg-children")
          .insertAdjacentHTML("beforeend", tgGroupHtml({ op: "or", children: [tgDefaultLeaf(kindFn())] }, depth, kindFn()));
        onChange();
      }
    });
    // Live unit hint: typing a sensor class into the hwSensorValue dimension
    // filter swaps the row's unit chip (°C / RPM / V …) as the class resolves.
    panel.addEventListener("input", function (e) {
      var t = e.target;
      if (!t || !t.classList || !t.classList.contains("tgl-dim") || t.getAttribute("data-dim") !== "sensorClass") return;
      var root = panel.querySelector(rootSelector);
      if (!root || !root.contains(t)) return;
      var row = t.closest(".scr-row");
      var span = row && row.querySelector(".tgl-unit");
      if (!span) return;
      var metric = String(row.querySelector(".tgl-what").value || "").slice(2);
      span.textContent = leafUnit(metric, { sensorClass: t.value }) || "sensor unit";
    });
    panel.addEventListener("change", function (e) {
      var t = e.target;
      if (!t || !t.classList) return;
      var root = panel.querySelector(rootSelector);
      if (!root || !root.contains(t)) return;
      if (t.classList.contains("tgl-what")) {
        // What changed: re-render the row with the new leaf's default fields.
        var row = t.closest(".scr-row");
        var what = t.value;
        var leaf = what.indexOf("f:") === 0
          ? { type: "asset_state", field: what.slice(2), operator: "==", value: "" }
          : { type: kindFn() === "host" ? "host_metric" : "asset_metric", metric: what.slice(2), aggregation: "latest", windowSec: 0, operator: ">=", threshold: null };
        row.outerHTML = tgLeafRowHtml(leaf, kindFn());
      }
      onChange();
    });
    wireCondDnD(panel, rootSelector, onChange, tgMeta.maxDepth || 3);
  }

  function step3Html() {
    var cat = triggerCategoryOf(draft.trigger);
    var typeOpts = TRIGGER_CATEGORIES.map(function (t) {
      return '<option value="' + t.value + '"' + (t.value === cat ? " selected" : "") + '>' + escapeHtml(t.label) + '</option>';
    }).join("");
    var multi = !!(draft.severityBands && draft.severityBands.length);
    return '<h3 id="aw-step3-heading" style="margin:0 0 0.25rem">When should it fire?</h3>' +
      '<div class="aw-sentence" id="aw-trigger-sentence">…</div>' +
      '<div class="form-group"><label><input type="checkbox" id="aw-multi-sev"' + (multi ? " checked" : "") + '> Use multiple severity levels (escalate severity as the value climbs)</label></div>' +
      '<div class="form-group" id="aw-single-sev-wrap"><label>Alert severity</label><select id="aw-trigger-severity" class="sev-select sev-' + escapeHtml(draft.severity || "warning") + '">' + sevOpt(draft.severity || "warning") + '</select></div>' +
      '<div class="form-group"><label>Trigger type</label><select id="aw-trigger-type">' + typeOpts + '</select></div>' +
      '<div id="aw-trigger-fields"></div>' +
      '<div id="aw-bands-host" style="display:none"></div>' +
      '<details' + (draft.messageTemplate ? " open" : "") + ' style="margin:0.5rem 0"><summary style="font-size:0.82rem;cursor:pointer;color:var(--color-text-tertiary)">Alert message template (optional)</summary>' +
        '<div style="margin-top:6px">' + tokenPaletteHtml("aw-token-palette") +
        '<input type="text" id="aw-msg" class="tpl-field" value="' + escapeHtml(draft.messageTemplate || "") + '" placeholder="{asset} {metric} = {value} (threshold {threshold})" style="width:100%"></div>' +
      '</details>' +
      '<div style="margin:0.5rem 0"><button type="button" class="btn btn-sm btn-secondary" id="aw-trigger-test">Test against current data</button></div>' +
      '<div id="aw-trigger-preview"></div>';
  }
  function renderTriggerFields() {
    var panel = document.getElementById("aw-step-3");
    var cat = panel.querySelector("#aw-trigger-type").value;
    var box = panel.querySelector("#aw-trigger-fields");
    var tr = draft.trigger || {};
    var html = "";
    if (cat === "device" || cat === "host") {
      var kind = cat === "host" ? "host" : "asset";
      var tree = triggerToTree(tr, kind);
      html += '<p style="font-size:0.82rem;color:var(--color-text-tertiary);margin:0 0 0.5rem">Add conditions and combine them with AND/OR groups — drag the <span class="aw-grip" style="cursor:default">&#x2842;</span> handle to move them. ' + escapeHtml(tgMeta.anyDimensionNote || "") + '</p>' +
        '<div id="aw-trig-root">' + tgGroupHtml(tree, 0, kind) + '</div>' +
        '<div class="form-group" style="margin-top:0.5rem"><label>Sustained for (minutes)</label><input type="number" id="tf-duration-min" min="0" value="' + Math.round(((tr.forDurationSec || 0)) / 60) + '" placeholder="0 = fire immediately"></div>';
      if (cat === "host") {
        html += '<p style="font-size:0.78rem;color:var(--color-text-tertiary)">Polaris-host conditions aren’t tied to assets — the device filter from the previous step is ignored.</p>';
      }
    } else if (cat === "event") {
      var ev = tr.type === "event" ? tr : {};
      html += '<div class="form-group"><label>Action pattern (glob)</label><input type="text" id="tf-action" value="' + escapeHtml(ev.actionPattern || "") + '" placeholder="e.g. monitor.status_changed or integration.test.*"></div>';
      html += '<div class="form-group"><label>Resource type (optional)</label><input type="text" id="tf-restype" value="' + escapeHtml(ev.resourceType || "") + '" placeholder="e.g. asset / integration"></div>';
      html += '<div class="form-group"><label>Minimum event level (optional)</label><select id="tf-minlevel"><option value="">(any)</option>' + opt(s.eventLevels || ["info", "warning", "error"], ev.minLevel || "") + '</select></div>';
      html += '<p style="font-size:0.78rem;color:var(--color-text-tertiary)">Audit-event triggers aren’t tied to assets — the device filter from the previous step is ignored.</p>';
    } else if (cat === "change") {
      var ch = tr.type === "change" ? tr : {};
      var def = findType("change");
      html += '<div class="form-group"><label>Change type</label><select id="tf-changetype">' + optLabeled((def && def.changeTypes) || [], ch.changeType, changeLabel) + '</select></div>';
    }
    box.innerHTML = html;
    refreshTriggerSentence();
  }
  function wireStep3() {
    var panel = document.getElementById("aw-step-3");
    var sevSel = panel.querySelector("#aw-trigger-severity");
    if (sevSel) {
      sevSel.addEventListener("change", function () {
        draft.severity = sevSel.value;
        sevSel.className = "sev-select sev-" + sevSel.value;
        var note = panel.querySelector("#aw-band-base-note");
        if (note) note.innerHTML = bandBaseNoteHtml();
        applySevAccent(panel);
      });
    }
    var multiCb = panel.querySelector("#aw-multi-sev");
    if (multiCb) multiCb.addEventListener("change", function () { syncSeverityMode(panel); });
    panel.querySelector("#aw-trigger-type").addEventListener("change", function () {
      renderTriggerFields(); // category swap renders fresh from the draft
    });
    wireTgTree(panel, "#aw-trig-root", function () {
      return panel.querySelector("#aw-trigger-type").value === "host" ? "host" : "asset";
    }, refreshTriggerSentence);
    // Delegated: any input/select change re-renders the sentence (the tree's
    // own change handler also calls it — a second render is harmless) and
    // re-syncs the severity mode (single dropdown vs multi tiers + accent).
    panel.addEventListener("input", function () { refreshTriggerSentence(); syncSeverityMode(panel); });
    panel.addEventListener("change", function () { refreshTriggerSentence(); syncSeverityMode(panel); });
    panel.querySelector("#aw-trigger-test").addEventListener("click", runTriggerPreview);
    renderTriggerFields();
    syncSeverityMode(panel);
    wireTokenPalette(panel);
  }
  function collectStep3() {
    var panel = document.getElementById("aw-step-3");
    var typeSel = panel.querySelector("#aw-trigger-type");
    if (!typeSel) return;
    var cat = typeSel.value;
    if (cat === "device" || cat === "host") {
      var kind = cat === "host" ? "host" : "asset";
      var root = panel.querySelector("#aw-trig-root > .scg-group");
      if (root) {
        var tree = tgCollectGroup(root, kind);
        var dEl = panel.querySelector("#tf-duration-min");
        var mins = dEl && dEl.value !== "" ? Number(dEl.value) : 0;
        draft.trigger = tgCollapse({
          type: "composite", kind: kind, op: tree.op, children: tree.children,
          forDurationSec: (isNaN(mins) ? 0 : mins) * 60,
        });
      }
    } else if (cat === "event") {
      var ev = { type: "event", actionPattern: panel.querySelector("#tf-action").value.trim() };
      var rt = panel.querySelector("#tf-restype").value.trim(); if (rt) ev.resourceType = rt;
      var ml = panel.querySelector("#tf-minlevel").value; if (ml) ev.minLevel = ml;
      draft.trigger = ev;
    } else if (cat === "change") {
      draft.trigger = { type: "change", changeType: panel.querySelector("#tf-changetype").value };
    }
    draft.messageTemplate = (panel.querySelector("#aw-msg") ? panel.querySelector("#aw-msg").value.trim() : "") || null;
    // Base severity: in multi mode it's the select injected into the condition
    // group header (.scg-sev); in single mode the standalone Alert dropdown.
    var baseSel = multiSevOn(panel) ? panel.querySelector("#aw-trig-root .scg-sev") : panel.querySelector("#aw-trigger-severity");
    if (baseSel) draft.severity = baseSel.value;
    collectBands(panel); // severity tiers live with the trigger (step 3)
  }
  function tgValidateLeaf(leaf, label) {
    if (leaf.type === "asset_state") {
      if (leaf.value == null || String(leaf.value).trim() === "") return label + ": choose or enter a value.";
      return null;
    }
    if (leaf.threshold == null || isNaN(leaf.threshold)) return label + ": enter a numeric threshold.";
    return null;
  }
  function validateStep3() {
    var tr = draft.trigger || {};
    if (tr.type === "composite" || tr.type === "asset_metric" || tr.type === "asset_state" || tr.type === "host_metric") {
      var leaves = tr.type === "composite" ? tgLeaves(tr) : [tr];
      if (!leaves.length) return "Add at least one condition.";
      if (leaves.length > (tgMeta.maxLeaves || 10)) return "At most " + (tgMeta.maxLeaves || 10) + " conditions per trigger.";
      for (var i = 0; i < leaves.length; i++) {
        var p = tgValidateLeaf(leaves[i], "Condition " + (i + 1));
        if (p) return p;
      }
      // Empty sub-groups collapse to nothing meaningful — flag them.
      if (tr.type === "composite") {
        var emptyGroup = false;
        (function walk(node) {
          if (!node || node.type !== undefined || !Array.isArray(node.children)) return;
          if (!node.children.length) { emptyGroup = true; return; }
          node.children.forEach(walk);
        })({ op: tr.op, children: tr.children });
        if (emptyGroup) return "A condition group is empty — add a condition or remove the group.";
      }
      return validateBands();
    }
    if (tr.type === "event" && !String(tr.actionPattern || "").trim()) {
      return "Enter an action pattern for the event trigger.";
    }
    return null;
  }
  // Severity bands live with the trigger (step 3): threshold + severity present,
  // actions valid (tier ordering is enforced server-side against base+operator).
  function validateBands() {
    if (!bandsApplicable(draft.trigger) || !draft.severityBands) return null;
    for (var b = 0; b < draft.severityBands.length; b++) {
      var band = draft.severityBands[b]; var bn = "Severity band " + (b + 1);
      if (band.threshold == null || isNaN(band.threshold)) return bn + ": enter a numeric threshold.";
      if (!band.severity) return bn + ": pick a severity.";
      for (var ba = 0; ba < (band.actions || []).length; ba++) {
        var pb = validateAction(band.actions[ba], bn + ", action " + (ba + 1));
        if (pb) return pb;
      }
      var betiers = (band.escalation && band.escalation.tiers) || [];
      for (var be = 0; be < betiers.length; be++) {
        if (!betiers[be].actions.length) return bn + ", escalation " + (be + 1) + ": add at least one action (or remove it).";
      }
    }
    if (draft.bandNotify && draft.bandNotify.onResolved && draft.bandNotify.resolvedMode === "dedicated") {
      var ra = draft.bandNotify.resolvedActions || [];
      for (var r = 0; r < ra.length; r++) {
        var pr = validateAction(ra[r], "Resolved action " + (r + 1));
        if (pr) return pr;
      }
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
      var composite = (res.matches || []).some(function (m) { return Array.isArray(m.leaves); });
      var rowsHtml = (res.matches || []).slice(0, 20).map(function (m) {
        var statusCell = m.meets ? '<span style="color:var(--color-danger)">would fire</span>' : m.inDeadBand ? '<span style="color:var(--color-warning,#d97706)">dead band</span>' : '<span style="color:var(--color-text-tertiary)">no</span>';
        if (composite) {
          // Per-condition breakdown: ✓ met (with witness dim), ✗ measured
          // false, — no data.
          var leafLines = (m.leaves || []).map(function (l) {
            var mark = l.met ? '<span style="color:var(--color-danger)">&#10003;</span>' : l.noData ? '<span style="color:var(--color-text-tertiary)">&mdash;</span>' : '<span style="color:var(--color-text-tertiary)">&#10007;</span>';
            var val = l.noData ? "no data" : (l.dimension ? l.dimension + " = " : "") + (l.value == null ? "n/a" : String(l.value));
            return mark + ' ' + escapeHtml(l.label) + ' <span style="color:var(--color-text-tertiary)">(' + escapeHtml(val) + ')</span>';
          }).join("<br>");
          return '<tr><td>' + escapeHtml(m.hostname || m.assetId || "host") + '</td><td style="font-size:0.78rem">' + leafLines + '</td><td>' + statusCell + '</td></tr>';
        }
        return '<tr><td>' + escapeHtml(m.hostname || m.assetId || "host") + '</td><td>' + escapeHtml(m.dimension || "") + '</td><td>' + escapeHtml(m.value == null ? "n/a" : String(m.value)) + '</td><td>' + statusCell + '</td></tr>';
      }).join("");
      var headHtml = composite
        ? '<tr><th>Asset</th><th>Conditions</th><th>Status</th></tr>'
        : '<tr><th>Asset</th><th>Dimension</th><th>Value</th><th>Status</th></tr>';
      box.innerHTML = '<p style="font-size:0.85rem"><strong>' + meeting.length + '</strong> of ' + res.totalEvaluated + ' currently match.</p>' +
        '<div class="table-wrapper" style="max-height:200px;overflow:auto"><table><thead>' + headHtml + '</thead><tbody>' + rowsHtml + '</tbody></table></div>';
    } catch (err) { box.innerHTML = '<p style="color:var(--color-danger)">' + escapeHtml(err.message || "Preview failed") + '</p>'; }
  }

  // ── Step 4: Reset conditions ───────────────────────────────────────────
  // Default: a checked "Reset when the trigger is no longer true" checkbox
  // (= auto mode, with hysteresis/sustain extras). Unchecking reveals the
  // other modes — composite triggers additionally get "custom conditions"
  // (the same AND/OR builder, stored as reset mode "condition").
  // Event/change triggers keep the plain timed/manual radios.
  function defaultResetFor(triggerType) {
    var d = (s.resetDefaults && s.resetDefaults[triggerType]) || { mode: "auto" };
    return JSON.parse(JSON.stringify(d));
  }
  function resetRadioHtml(m, reset, extra) {
    var meta = (s.resetModeMeta || {})[m] || { label: m };
    return '<div style="margin-bottom:0.6rem">' +
      '<label style="display:block;font-weight:600;font-size:0.9rem"><input type="radio" name="aw-reset-mode" value="' + m + '"' + (reset.mode === m ? " checked" : "") + '> ' + escapeHtml(meta.label || m) + '</label>' +
      (meta.help ? '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0 24px">' + escapeHtml(meta.help) + '</p>' : "") +
      '<div class="aw-reset-extra" data-mode="' + m + '" style="display:' + (reset.mode === m ? "block" : "none") + '">' + (extra || "") + '</div>' +
    '</div>';
  }
  function timedExtraHtml(reset) {
    return '<div style="margin:6px 0 0 24px;font-size:0.85rem">Clear after <input type="number" id="aw-after-min" min="1" value="' + Math.round((reset.afterSec || 3600) / 60) + '" style="width:90px"> min</div>';
  }
  function renderStep4() {
    var panel = document.getElementById("aw-step-4");
    var tr = draft.trigger || {};
    var modes = (s.resetModesByTriggerType && s.resetModesByTriggerType[tr.type]) || ["auto", "timed", "manual"];
    if (!draft.reset || modes.indexOf(draft.reset.mode) === -1) draft.reset = defaultResetFor(tr.type);
    var reset = draft.reset;
    var isEC = tr.type === "event" || tr.type === "change";
    var isComposite = tr.type === "composite";
    var numeric = tr.type === "asset_metric" || tr.type === "host_metric";
    var cooldownHtml = '<div class="form-group" style="margin-top:0.75rem"><label>Re-notify cooldown (minutes, optional)</label><input type="number" id="aw-cooldown-min" min="0" value="' + (draft.cooldownSec != null ? Math.round(draft.cooldownSec / 60) : "") + '" placeholder="blank = suppress repeats while active"></div>';

    if (isEC) {
      // Event/change: no continuous condition — plain timed/manual radios.
      var radios = modes.map(function (m) {
        return resetRadioHtml(m, reset, m === "timed" ? timedExtraHtml(reset) : "");
      }).join("");
      panel.innerHTML = '<h3 style="margin:0 0 0.25rem">How should its alerts reset?</h3>' +
        '<div class="aw-sentence" id="aw-reset-sentence">…</div>' + radios + cooldownHtml;
    } else {
      var autoOn = reset.mode === "auto";
      var customModes = (isComposite ? ["condition"] : []).concat(["timed", "manual"]);
      var selCustom = customModes.indexOf(reset.mode) !== -1 ? reset.mode : customModes[customModes.length - 1];
      var customReset = { mode: autoOn ? selCustom : reset.mode, afterSec: reset.afterSec, condition: reset.condition, sustainSec: reset.sustainSec };

      var unit = numeric ? leafUnit(tr.metric, tr.dimensionFilter) : "";
      var invOp = INV_CMP[tr.operator] || "<";
      var sustainHtml = '<div style="margin:6px 0 0;font-size:0.85rem">Must stay cleared for <input type="number" id="aw-sustain-min" min="0" value="' + Math.round((reset.sustainSec || 0) / 60) + '" style="width:80px"> min (0 = reset immediately)</div>';
      var autoExtras = "";
      if (numeric) {
        autoExtras =
          '<label style="display:block;font-size:0.82rem"><input type="checkbox" id="aw-hyst-enable"' + (reset.clearThreshold != null ? " checked" : "") + '> Use a different clear threshold (hysteresis)</label>' +
          '<div id="aw-hyst-fields" style="display:' + (reset.clearThreshold != null ? "block" : "none") + ';margin:4px 0 0 24px;font-size:0.85rem">value must be <strong>' + escapeHtml(CMP_PHRASE[invOp] || invOp) + '</strong> ' +
            '<input type="number" step="any" id="aw-clear-threshold" value="' + (reset.clearThreshold != null ? reset.clearThreshold : "") + '" style="width:110px"> ' + escapeHtml(unit) +
          '</div>' + sustainHtml;
      } else {
        autoExtras = sustainHtml;
      }

      var condExtra = "";
      if (isComposite) {
        var kind = tr.kind === "host" ? "host" : "asset";
        var condTree = customReset.condition
          ? JSON.parse(JSON.stringify(customReset.condition))
          : { op: "and", children: [tgDefaultLeaf(kind)] };
        condExtra =
          '<div style="margin:6px 0 0 24px">' +
            '<div id="aw-reset-root">' + tgGroupHtml(condTree, 0, kind) + '</div>' +
            '<div style="font-size:0.85rem;margin-top:4px">Must stay true for <input type="number" id="aw-crs-sustain-min" min="0" value="' + Math.round((reset.mode === "condition" ? (reset.sustainSec || 0) : 0) / 60) + '" style="width:80px"> min (0 = reset immediately)</div>' +
            '<p style="font-size:0.78rem;color:var(--color-warning,#d97706);margin:6px 0 0">If the trigger and reset conditions can both be true at once, the automation can clear and re-fire in a loop — set a re-notify cooldown below.</p>' +
          '</div>';
      }

      var customRadios = customModes.map(function (m) {
        var extra = m === "condition" ? condExtra : m === "timed" ? timedExtraHtml(customReset) : "";
        return resetRadioHtml(m, customReset, extra);
      }).join("");

      panel.innerHTML = '<h3 style="margin:0 0 0.25rem">How should its alerts reset?</h3>' +
        '<div class="aw-sentence" id="aw-reset-sentence">…</div>' +
        '<div class="form-group" style="margin-bottom:0.5rem"><label style="font-weight:600"><input type="checkbox" id="aw-reset-auto"' + (autoOn ? " checked" : "") + '> Reset when the trigger is no longer true</label>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0 24px">The alert clears automatically once the condition recovers. Uncheck for timed/manual resets' + (isComposite ? " or a custom reset condition" : "") + '.</p></div>' +
        '<div id="aw-auto-extras" style="display:' + (autoOn ? "block" : "none") + ';margin:0 0 0.6rem 24px">' + autoExtras + '</div>' +
        '<div id="aw-reset-custom" style="display:' + (autoOn ? "none" : "block") + '">' + customRadios + '</div>' +
        cooldownHtml;

      var autoCb = panel.querySelector("#aw-reset-auto");
      autoCb.addEventListener("change", function () {
        panel.querySelector("#aw-auto-extras").style.display = autoCb.checked ? "block" : "none";
        panel.querySelector("#aw-reset-custom").style.display = autoCb.checked ? "none" : "block";
        refreshResetSentence();
      });
      var hystEnable = panel.querySelector("#aw-hyst-enable");
      if (hystEnable) {
        hystEnable.addEventListener("change", function () {
          panel.querySelector("#aw-hyst-fields").style.display = hystEnable.checked ? "block" : "none";
          refreshResetSentence();
        });
      }
      // The reset-condition builder shares the trigger tree machinery
      // (delegated once per panel; kind follows the trigger).
      wireTgTree(panel, "#aw-reset-root", function () {
        return (draft.trigger && draft.trigger.kind) === "host" ? "host" : "asset";
      }, refreshResetSentence);
    }

    panel.querySelectorAll('input[name="aw-reset-mode"]').forEach(function (radio) {
      radio.addEventListener("change", function () {
        panel.querySelectorAll(".aw-reset-extra").forEach(function (x) { x.style.display = x.getAttribute("data-mode") === radio.value ? "block" : "none"; });
        refreshResetSentence();
      });
    });
    if (!panel._rsWired) {
      panel._rsWired = true;
      panel.addEventListener("input", function () { refreshResetSentence(); });
    }
    refreshResetSentence();
  }
  function collectStep4() {
    var panel = document.getElementById("aw-step-4");
    var tr = draft.trigger || {};
    var autoCb = panel.querySelector("#aw-reset-auto");
    var reset;
    if (autoCb && autoCb.checked) {
      reset = { mode: "auto" };
      var hyst = panel.querySelector("#aw-hyst-enable");
      var ct = panel.querySelector("#aw-clear-threshold");
      if (hyst && hyst.checked && ct && ct.value !== "" && !isNaN(Number(ct.value))) reset.clearThreshold = Number(ct.value);
      var sm = panel.querySelector("#aw-sustain-min");
      var sus = sm && sm.value !== "" ? Number(sm.value) : 0;
      if (!isNaN(sus) && sus > 0) reset.sustainSec = sus * 60;
    } else {
      var sel = panel.querySelector('input[name="aw-reset-mode"]:checked');
      if (!sel) return;
      var mode = sel.value;
      reset = { mode: mode };
      if (mode === "timed") {
        var am = panel.querySelector("#aw-after-min");
        var mins = am && am.value !== "" ? Number(am.value) : 60;
        reset.afterSec = (isNaN(mins) || mins < 1 ? 60 : mins) * 60;
      } else if (mode === "condition") {
        var kind = tr.kind === "host" ? "host" : "asset";
        var root = panel.querySelector("#aw-reset-root > .scg-group");
        if (root) reset.condition = tgCollectGroup(root, kind);
        var cs = panel.querySelector("#aw-crs-sustain-min");
        var csus = cs && cs.value !== "" ? Number(cs.value) : 0;
        if (!isNaN(csus) && csus > 0) reset.sustainSec = csus * 60;
      }
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
    if (r.mode === "condition") {
      if (tr.type !== "composite") return "A custom reset condition needs a multi-condition trigger — add a second trigger condition, or use the automatic reset.";
      if (!r.condition || !(r.condition.children || []).length) return "Custom reset: add at least one condition.";
      var leaves = tgLeaves(r.condition);
      if (!leaves.length) return "Custom reset: add at least one condition.";
      for (var i = 0; i < leaves.length; i++) {
        var p = tgValidateLeaf(leaves[i], "Reset condition " + (i + 1));
        if (p) return p;
      }
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
        '<label style="font-weight:600;margin:0 0 4px;display:block">Escalation</label>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 6px">If an alert stays unhandled, run more actions after a delay — e.g. notify a wider group 15 minutes in. Each escalation runs once its delay elapses (checked every minute), optionally repeating until the alert is handled.</p>' +
        '<div id="aw-esc-config" style="display:none;margin-bottom:6px"><label style="font-size:0.8rem">Stop escalating when</label><select id="aw-esc-stopon"><option value="acknowledge"' + (esc && esc.stopOn === "acknowledge" ? " selected" : "") + '>Acknowledged (or cleared)</option><option value="clear"' + (esc && esc.stopOn === "clear" ? " selected" : "") + '>Cleared only — acknowledging does not stop it</option></select></div>' +
        '<div id="aw-esc-tiers"></div>' +
        '<button type="button" class="btn btn-sm btn-secondary" id="aw-esc-add" style="margin-top:6px">+ Add escalation</button>' +
      '</div>';

    var host = panel.querySelector("#aw-actions");
    (draft.actions || []).forEach(function (a) { addActionRow(host, a); });
    panel.querySelector("#aw-add-action").addEventListener("click", function () { addActionRow(host, null); });

    var tiersHost = panel.querySelector("#aw-esc-tiers");
    // "Stop escalating when" is meaningful only once at least one escalation
    // exists; addTierRow's remove handler calls this too (via _escSyncFn).
    _escSyncFn = function () {
      var any = tiersHost.querySelectorAll(".aw-tier").length > 0;
      panel.querySelector("#aw-esc-config").style.display = any ? "block" : "none";
    };
    ((esc && esc.tiers) || []).forEach(function (t) { addTierRow(tiersHost, t); });
    _escSyncFn();
    panel.querySelector("#aw-esc-add").addEventListener("click", function () {
      var max = (s.escalationMeta && s.escalationMeta.maxTiers) || 5;
      if (tiersHost.querySelectorAll(".aw-tier").length >= max) { showToast("Maximum " + max + " escalation tiers", "info"); return; }
      var row = addTierRow(tiersHost, null);
      // Seed a notify action so the channel + recipient fields are right
      // there — an escalation without an action can't do anything anyway.
      addActionRow(row.querySelector(".tier-actions"), null);
      _escSyncFn();
    });
    wireTokenPalette(panel);
  }

  // ── Severity bands (numeric single-metric triggers) — live on step 3 (with
  //    the trigger, since bands are threshold-defined). Built lazily into
  //    #aw-bands-host and shown only while the trigger is a single numeric
  //    metric; syncBandsVisibility toggles as the trigger tree changes. ────────
  function bandBaseNoteHtml() {
    var tr = draft.trigger || {};
    var opPhrase = ((s.comparatorPhrases || {})[tr.operator]) || tr.operator || ">=";
    return 'This condition alerts at severity <strong>' + escapeHtml(draft.severity) + '</strong> when the value ' + escapeHtml(opPhrase) + ' <strong>' + escapeHtml(String(tr.threshold != null ? tr.threshold : "?")) + '</strong> (its actions live on the Actions step). Add another severity to escalate as the value climbs further.';
  }
  function bandsSectionHtml() {
    // Base severity + the first "+ Severity" live INSIDE the condition group
    // header (injectBaseSeverity); this section holds the added tier groups +
    // the notify policy. #aw-band-base-note is kept (hidden) for legacy callers.
    return '<div id="aw-bands-section">' +
      '<p id="aw-band-base-note" style="display:none"></p>' +
      '<div id="aw-bands"></div>' +
      '<button type="button" class="btn btn-sm btn-secondary" id="aw-band-add" style="margin-top:4px;display:none">+ Severity</button>' +
      '<div id="aw-band-notify" style="display:none;margin-top:10px;border-top:1px solid var(--color-border);padding-top:8px">' +
        '<label style="font-weight:600;font-size:0.82rem;display:block;margin:0 0 4px">Notify on</label>' +
        '<label style="font-size:0.82rem;display:block"><input type="checkbox" id="aw-bn-increase" checked> Severity increase (re-notify with the new band’s actions)</label>' +
        '<label style="font-size:0.82rem;display:block"><input type="checkbox" id="aw-bn-decrease"> Severity decrease (run the lower band’s actions)</label>' +
        '<label style="font-size:0.82rem;display:block"><input type="checkbox" id="aw-bn-resolved" checked> Resolved (below the base tier)</label>' +
        '<div id="aw-bn-resolved-wrap" style="margin:6px 0 0 1.2rem">' +
          '<label style="font-size:0.8rem">Resolved actions</label> ' +
          '<select id="aw-bn-resolved-mode" style="width:auto"><option value="reuse">Reuse the alert’s actions</option><option value="dedicated">Run dedicated actions</option></select>' +
          '<div id="aw-bn-resolved-actions" style="margin-top:6px;display:none"></div>' +
          '<button type="button" class="btn btn-sm btn-secondary" id="aw-bn-resolved-add" style="margin-top:4px;display:none">+ Add resolved action</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  function bandSeverityOptions(sel) {
    return (s.severities || []).map(function (sv) {
      return '<option value="' + sv + '"' + (sv === sel ? " selected" : "") + '>' + escapeHtml(sv) + '</option>';
    }).join("");
  }
  function wireBandsSection(panel) {
    var section = panel.querySelector("#aw-bands-section");
    if (!section) return; // not a numeric single-metric trigger
    var bandsHost = panel.querySelector("#aw-bands");
    (draft.severityBands || []).forEach(function (b) { addBandRow(bandsHost, b); });
    var notifyBox = panel.querySelector("#aw-band-notify");
    var syncNotify = function () { notifyBox.style.display = bandsHost.querySelectorAll(".aw-band").length ? "block" : "none"; };
    panel.querySelector("#aw-band-add").addEventListener("click", function () { addBandRow(bandsHost, null); syncNotify(); });
    // Notify policy state.
    var bn = draft.bandNotify || {};
    panel.querySelector("#aw-bn-increase").checked = bn.onIncrease !== false;
    panel.querySelector("#aw-bn-decrease").checked = bn.onDecrease === true;
    panel.querySelector("#aw-bn-resolved").checked = bn.onResolved !== false;
    var modeSel = panel.querySelector("#aw-bn-resolved-mode");
    modeSel.value = bn.resolvedMode === "dedicated" ? "dedicated" : "reuse";
    var resActionsHost = panel.querySelector("#aw-bn-resolved-actions");
    var resAddBtn = panel.querySelector("#aw-bn-resolved-add");
    var syncResolved = function () {
      var on = panel.querySelector("#aw-bn-resolved").checked;
      var dedicated = on && modeSel.value === "dedicated";
      panel.querySelector("#aw-bn-resolved-wrap").style.display = on ? "block" : "none";
      resActionsHost.style.display = dedicated ? "block" : "none";
      resAddBtn.style.display = dedicated ? "inline-block" : "none";
    };
    (bn.resolvedActions || []).forEach(function (a) { addActionRow(resActionsHost, a); });
    panel.querySelector("#aw-bn-resolved").addEventListener("change", syncResolved);
    modeSel.addEventListener("change", syncResolved);
    resAddBtn.addEventListener("click", function () { addActionRow(resActionsHost, null); });
    syncNotify();
    syncResolved();
  }
  // Severity colors (mirror styles.css .sev-select palette) for the accent.
  var SEV_COLORS = { notice: "var(--color-sev-notice)", informational: "var(--color-accent)", warning: "var(--color-warning)", serious: "var(--color-sev-serious)", critical: "var(--color-danger)" };
  function sevColor(sev) { return SEV_COLORS[sev] || "var(--color-accent)"; }
  function sevRankOf(sev) { return (s.severities || []).indexOf(sev); }
  // Paint the step heading + the conditions group border to the base severity.
  function applySevAccent(panel) {
    var color = sevColor(draft.severity || "warning");
    var h = panel.querySelector("#aw-step3-heading");
    if (h) h.style.color = color;
    var root = panel.querySelector("#aw-trig-root > .scg-group");
    if (root) root.style.borderLeftColor = color;
  }
  function multiSevOn(panel) {
    var cb = panel.querySelector("#aw-multi-sev");
    return !!(cb && cb.checked && bandsApplicable(draft.trigger));
  }
  // Single mode → standalone Alert severity dropdown; multi mode → the severity
  // levels panel (base severity + tiers) with the trigger's sampling shared.
  // Built lazily; re-syncs as the trigger tree / checkbox change without wiping
  // in-progress tiers. Also repaints the severity accent.
  function syncSeverityMode(panel) {
    var cb = panel.querySelector("#aw-multi-sev");
    var applicable = bandsApplicable(draft.trigger);
    if (cb) cb.disabled = !applicable;
    var multi = multiSevOn(panel);
    var singleWrap = panel.querySelector("#aw-single-sev-wrap");
    if (singleWrap) singleWrap.style.display = multi ? "none" : "";
    var hostWrap = panel.querySelector("#aw-bands-host");
    if (hostWrap) {
      if (multi) {
        if (!hostWrap._built) { hostWrap.innerHTML = bandsSectionHtml(); hostWrap._built = true; wireBandsSection(panel); }
        hostWrap.style.display = "";
      } else {
        hostWrap.style.display = "none";
      }
    }
    // Base severity + the first "+ Severity" live in the condition group header.
    injectBaseSeverity(panel, multi);
    applySevAccent(panel);
  }
  function sevSelectHtml(cls, sev) {
    return '<select class="' + cls + ' sev-select sev-' + escapeHtml(sev) + '" style="width:auto">' + bandSeverityOptions(sev) + '</select>';
  }
  // In multi mode, inject a Base severity select into the condition group header
  // (before the AND/OR select) + a "+ Severity" button in the group's button row,
  // and accent the group border. Removed again in single mode. Idempotent.
  function injectBaseSeverity(panel, multi) {
    var root = panel.querySelector("#aw-trig-root > .scg-group");
    if (!root) return;
    var header = root.querySelector(":scope > div"); // header row (holds .scg-op)
    var btnRow = root.querySelector(":scope > div:last-child"); // +Condition/+Group row
    var existingSev = header && header.querySelector(".scg-sev-wrap");
    var existingAdd = btnRow && btnRow.querySelector(".scg-add-sev");
    if (!multi) {
      if (existingSev) existingSev.remove();
      if (existingAdd) existingAdd.remove();
      root.style.borderLeftColor = "";
      return;
    }
    if (header && !existingSev) {
      var wrap = document.createElement("span");
      wrap.className = "scg-sev-wrap";
      wrap.style.cssText = "display:flex;align-items:center;gap:6px;margin-right:6px";
      wrap.innerHTML = '<label style="margin:0;font-size:0.8rem;font-weight:600">severity</label>' + sevSelectHtml("scg-sev", draft.severity || "warning");
      header.insertBefore(wrap, header.firstChild);
      var sel = wrap.querySelector(".scg-sev");
      sel.addEventListener("change", function () {
        draft.severity = sel.value;
        sel.className = "scg-sev sev-select sev-" + sel.value;
        applySevAccent(panel);
        syncBandAddButtons(panel);
      });
    }
    if (btnRow && !existingAdd) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-sm btn-secondary scg-add-sev";
      b.style.marginLeft = "4px";
      b.textContent = "+ Severity";
      b.addEventListener("click", function () { addBandRow(panel.querySelector("#aw-bands"), null); syncBandNotify(panel); });
      btnRow.appendChild(b);
    }
    root.style.borderLeftColor = sevColor(draft.severity || "warning");
    syncBandAddButtons(panel);
  }
  function syncBandNotify(panel) {
    var box = panel.querySelector("#aw-band-notify");
    var host = panel.querySelector("#aw-bands");
    if (box && host) box.style.display = host.querySelectorAll(".aw-band").length ? "block" : "none";
  }
  // Default severity for a NEW tier: one rank above the most-severe existing
  // tier (or the base) — enforces the "only increase severity" rule.
  function nextTierSeverity(bandsHost) {
    var maxRank = sevRankOf(draft.severity || "warning");
    bandsHost.querySelectorAll(".band-severity").forEach(function (sel) { maxRank = Math.max(maxRank, sevRankOf(sel.value)); });
    var sevs = s.severities || [];
    return sevs[Math.min(maxRank + 1, sevs.length - 1)] || sevs[sevs.length - 1];
  }
  function addBandRow(host, band) {
    if (host.querySelectorAll(".aw-band").length >= 4 && !band) { showToast("At most 4 additional severities", "info"); return null; }
    band = band || { threshold: "", severity: nextTierSeverity(host), actions: [] };
    var sev0 = band.severity || nextTierSeverity(host);
    var tr = draft.trigger || {};
    var kind = tr.type === "host_metric" ? "host" : "asset";
    // Each tier is a full condition GROUP on the SAME metric + sampling as the
    // base condition — only severity / operator / value vary (shared sampling).
    var tierLeaf = {
      type: kind === "host" ? "host_metric" : "asset_metric",
      metric: tr.metric, aggregation: tr.aggregation || "latest", windowSec: tr.windowSec || 0,
      operator: band.operator || tr.operator || ">=",
      threshold: band.threshold != null && band.threshold !== "" ? band.threshold : null,
      dimensionFilter: tr.dimensionFilter,
    };
    var panel = document.getElementById("aw-step-3");
    var row = document.createElement("div");
    row.className = "aw-band scg-group";
    row.style.cssText = "border:1px solid var(--color-border);border-left:3px solid " + sevColor(sev0) + ";border-radius:6px;padding:0.55rem;margin:4px 0";
    // A tier is just: severity + the (locked-metric) condition + "+ Severity".
    // It carries NO per-tier actions/escalation — the alert re-notifies with the
    // base (Actions-step) actions + base escalation at the tier's severity.
    row.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;flex-wrap:wrap">' +
        '<label style="margin:0;font-size:0.8rem;font-weight:600">severity</label>' +
        sevSelectHtml("band-severity", sev0) +
        '<button type="button" class="btn btn-sm btn-danger band-remove" title="Remove severity" style="margin-left:auto">&times;</button>' +
      '</div>' +
      '<select class="scg-op" disabled style="width:100%;font-size:0.85rem;margin-bottom:2px"><option>All conditions must be met (AND)</option></select>' +
      '<div class="band-cond scg-children">' + tgLeafRowHtml(tierLeaf, kind) + '</div>' +
      '<div style="margin-top:4px"><button type="button" class="btn btn-sm btn-secondary band-add-sev">+ Severity</button></div>';
    host.appendChild(row);
    // Lock the shared-sampling fields on the tier's condition row — metric,
    // aggregation, window, dimensions — so only operator + value are editable.
    var cond = row.querySelector(".band-cond");
    cond.querySelectorAll(".tgl-what, .tgl-agg, .tgl-window, .tgl-dim").forEach(function (el) { el.disabled = true; el.style.opacity = "0.55"; });
    var grip = cond.querySelector(".aw-grip"); if (grip) grip.style.display = "none";
    var rmCond = cond.querySelector(".scr-remove"); if (rmCond) rmCond.style.display = "none";
    row.querySelector(".band-add-sev").addEventListener("click", function () { addBandRow(host, null); syncBandNotify(panel); });
    // Per-tier accent + "only increase severity" guard: a tier can't be set at
    // or below the tier before it (or the base).
    var sevSel = row.querySelector(".band-severity");
    sevSel.addEventListener("change", function () {
      var prev = row.previousElementSibling && row.previousElementSibling.classList.contains("aw-band")
        ? sevRankOf(row.previousElementSibling.querySelector(".band-severity").value)
        : sevRankOf(draft.severity || "warning");
      if (sevRankOf(sevSel.value) <= prev) {
        var sevs = s.severities || [];
        sevSel.value = sevs[Math.min(prev + 1, sevs.length - 1)];
        showToast("Each added severity must be higher than the one before it", "info");
      }
      sevSel.className = "band-severity sev-select sev-" + sevSel.value;
      row.style.borderLeftColor = sevColor(sevSel.value);
      syncBandAddButtons(panel);
    });
    row.querySelector(".band-remove").addEventListener("click", function () {
      row.remove();
      syncBandNotify(panel);
      syncBandAddButtons(panel);
    });
    syncBandAddButtons(panel);
    return row;
  }
  // Show a "+ Severity" button only while a HIGHER severity is still available
  // (and fewer than 4 tiers) — so the chain can reach critical but not beyond.
  function syncBandAddButtons(panel) {
    var host = panel.querySelector("#aw-bands");
    var sevs = s.severities || [];
    var maxRank = sevRankOf(draft.severity || "warning");
    var count = 0;
    if (host) host.querySelectorAll(".band-severity").forEach(function (sel) { maxRank = Math.max(maxRank, sevRankOf(sel.value)); count++; });
    var canAdd = count < 4 && maxRank < sevs.length - 1;
    panel.querySelectorAll(".scg-add-sev, .band-add-sev").forEach(function (b) { b.style.display = canAdd ? "" : "none"; });
  }

  // ── Step 6: Summary + affected devices ─────────────────────────────────
  function renderStep6() {
    var panel = document.getElementById("aw-step-6");
    panel.innerHTML = '<h3 style="margin:0 0 0.25rem">Review &amp; save</h3>' +
      '<div class="form-group" style="border:1px solid var(--color-border);border-radius:6px;padding:0.75rem">' +
        '<label style="font-weight:600;margin:0 0 6px;display:block">Summary</label>' +
        '<div id="aw-summary"></div>' +
      '</div>' +
      '<div class="form-group" style="border:1px solid var(--color-border);border-radius:6px;padding:0.75rem">' +
        '<label style="font-weight:600;margin:0 0 6px;display:block">Devices this automation affects</label>' +
        '<div id="aw-affected"><p style="color:var(--color-text-tertiary);font-size:0.85rem">Checking…</p></div>' +
      '</div>';
    renderSummary();
    renderAffectedDevices();
  }
  async function renderAffectedDevices() {
    var box = document.getElementById("aw-affected");
    if (!box) return;
    if (!isTriggerScoped(draft.trigger)) {
      box.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:0.85rem">This trigger isn’t tied to devices (Polaris host / audit events).</p>';
      return;
    }
    try {
      // Send the trigger + rule id so the preview can compute the precedence
      // carve-out (which devices this automation shares with more/less-specific
      // automations that watch the same thing) and exclude this rule itself.
      var body = { scope: draft.scope, trigger: draft.trigger, reset: draft.reset || undefined };
      if (editing && editing.id) body.id = editing.id;
      var res = await api.automations.preview(body);
      var matches = res.matches || [];
      var names = matches.slice(0, 100).map(function (m) {
        var carved = m.excludedBy
          ? ' <span style="color:var(--color-warning, #b7791f);font-size:0.75rem">— covered by “' + escapeHtml(m.excludedBy.ruleName) + '”</span>'
          : "";
        return '<tr><td>' + escapeHtml(m.hostname || m.assetId || "") + carved + '</td></tr>';
      }).join("");
      var spec = res.specificity
        ? '<p style="font-size:0.8rem;margin:0 0 6px">Specificity: <strong>' + escapeHtml(res.specificity.label) + '</strong>' +
          ' <span style="color:var(--color-text-tertiary)">— a more-specific automation watching the same thing takes precedence for the devices it covers.</span></p>'
        : "";
      box.innerHTML = spec +
        '<p style="font-size:0.85rem;margin:0 0 4px"><strong>' + res.totalEvaluated + '</strong> device(s) match the filter right now.</p>' +
        carveOutWarningHtml(res.carveOut) +
        (names ? '<div class="table-wrapper" style="max-height:220px;overflow:auto"><table><tbody>' + names + '</tbody></table></div>' +
          (res.totalEvaluated > 100 ? '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:4px 0 0">…and ' + (res.totalEvaluated - 100) + ' more.</p>' : "") : "");
    } catch (err) {
      box.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:0.85rem">' + escapeHtml(err.message || "Preview unavailable") + '</p>';
    }
  }
  // Bidirectional precedence warning: what this draft takes from less-specific
  // automations (carvesFrom) + what more-specific ones already cover (carvedOut).
  function carveOutWarningHtml(carveOut) {
    if (!carveOut) return "";
    var parts = [];
    if (carveOut.carvesFrom && carveOut.carvesFrom.length) {
      var lines = carveOut.carvesFrom.map(function (c) {
        var sample = (c.sampleHostnames || []).slice(0, 3).join(", ");
        return '<li>“' + escapeHtml(c.ruleName) + '” — <strong>' + c.count + '</strong> device(s)' +
          (sample ? ' <span style="color:var(--color-text-tertiary)">(' + escapeHtml(sample) + (c.count > 3 ? ", …" : "") + ')</span>' : "") + '</li>';
      }).join("");
      parts.push('<p style="margin:0 0 2px;font-size:0.82rem">Creating this will stop these less-specific automations from alerting on the devices it covers:</p><ul style="margin:0 0 6px 1.1rem;font-size:0.82rem">' + lines + '</ul>');
    }
    if (carveOut.carvedOut && carveOut.carvedOut.count) {
      var by = (carveOut.carvedOut.byRule || []).map(function (b) { return '“' + escapeHtml(b.ruleName) + '” (' + b.count + ')'; }).join(", ");
      parts.push('<p style="margin:0 0 6px;font-size:0.82rem"><strong>' + carveOut.carvedOut.count + '</strong> matched device(s) are already covered by a more-specific automation, so this one won’t alert on them: ' + by + '.</p>');
    }
    if (!parts.length) return "";
    return '<div style="border:1px solid var(--color-warning, #d9a441);background:var(--color-warning-bg, rgba(217,164,65,0.08));border-radius:6px;padding:0.5rem 0.6rem;margin:0 0 8px">' + parts.join("") + '</div>';
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
        '<label style="margin:0;font-size:0.8rem;font-weight:600">Escalate after</label>' +
        '<input type="number" class="tier-after" min="1" value="' + (tier.afterMin != null ? tier.afterMin : 15) + '" style="width:80px" title="Minutes after the alert fires (while it stays unhandled)">' +
        '<label style="margin:0;font-size:0.8rem">minutes unhandled, repeat every</label>' +
        '<input type="number" class="tier-repeat" min="5" value="' + (tier.repeatEveryMin != null ? tier.repeatEveryMin : "") + '" style="width:80px" placeholder="off"> min,' +
        '<label style="margin:0;font-size:0.8rem">max</label>' +
        '<input type="number" class="tier-max" min="1" max="20" value="' + (tier.maxRepeats != null ? tier.maxRepeats : "") + '" style="width:70px" placeholder="5">' +
        '<button type="button" class="btn btn-sm btn-danger tier-remove" style="margin-left:auto">Remove escalation</button>' +
      '</div>' +
      '<div class="tier-actions"></div>' +
      '<button type="button" class="btn btn-sm btn-secondary tier-add-action">+ Add action</button>';
    host.appendChild(row);
    row.querySelector(".tier-remove").addEventListener("click", function () {
      row.remove();
      if (_escSyncFn) _escSyncFn();
    });
    var actionsHost = row.querySelector(".tier-actions");
    (tier.actions || []).forEach(function (a) { addActionRow(actionsHost, a); });
    row.querySelector(".tier-add-action").addEventListener("click", function () { addActionRow(actionsHost, null); });
    return row;
  }

  // Collect escalation-tier rows from a host (shared by the base escalation and
  // each severity band's escalation).
  function collectTierRows(host) {
    var tiers = [];
    host.querySelectorAll(":scope > .aw-tier").forEach(function (row) {
      var t = { afterMin: Number(row.querySelector(".tier-after").value) || 0, actions: collectActionsFrom(row.querySelector(".tier-actions")) };
      var rep = row.querySelector(".tier-repeat").value;
      if (rep !== "") {
        t.repeatEveryMin = Number(rep);
        var mx = row.querySelector(".tier-max").value;
        if (mx !== "") t.maxRepeats = Number(mx);
      }
      tiers.push(t);
    });
    return tiers;
  }
  function collectStep5() {
    var panel = document.getElementById("aw-step-5");
    var host = panel.querySelector("#aw-actions");
    if (!host) return;
    draft.actions = collectActionsFrom(host);
    // Escalation exists iff at least one escalation row does — no toggle.
    var tiers = collectTierRows(panel.querySelector("#aw-esc-tiers"));
    draft.escalation = tiers.length
      ? { stopOn: panel.querySelector("#aw-esc-stopon").value, tiers: tiers }
      : null;
  }
  // Severity tiers + notify policy — collected only in multi-severity mode
  // (a single numeric metric). Single mode clears them.
  function collectBands(panel) {
    if (!multiSevOn(panel)) { draft.severityBands = null; draft.bandNotify = null; return; }
    var bandsHost = panel.querySelector("#aw-bands");
    if (!bandsHost) return; // section not rendered
    var baseOp = (draft.trigger && draft.trigger.operator) || ">=";
    var kind = (draft.trigger && draft.trigger.type === "host_metric") ? "host" : "asset";
    var bands = [];
    bandsHost.querySelectorAll(":scope > .aw-band").forEach(function (row) {
      // The tier's operator + threshold come from its (locked-metric) condition
      // row; metric + aggregation + window are shared with the base condition.
      var condRow = row.querySelector(".band-cond .scr-row");
      var leaf = condRow ? tgCollectLeaf(condRow, kind) : {};
      // Tiers carry no per-tier actions/escalation — the alert re-notifies with
      // the base (Actions-step) actions + base escalation at the tier's severity.
      var band = {
        threshold: leaf.threshold != null && !isNaN(leaf.threshold) ? leaf.threshold : null,
        severity: row.querySelector(".band-severity").value,
        actions: [],
      };
      // Persist a per-tier operator only when it differs from the base.
      if (leaf.operator && leaf.operator !== baseOp) band.operator = leaf.operator;
      bands.push(band);
    });
    draft.severityBands = bands.length ? bands : null;
    if (!bands.length) { draft.bandNotify = null; return; }
    var np = {
      onIncrease: panel.querySelector("#aw-bn-increase").checked,
      onDecrease: panel.querySelector("#aw-bn-decrease").checked,
      onResolved: panel.querySelector("#aw-bn-resolved").checked,
      resolvedMode: panel.querySelector("#aw-bn-resolved-mode").value,
    };
    if (np.onResolved && np.resolvedMode === "dedicated") {
      np.resolvedActions = collectActionsFrom(panel.querySelector("#aw-bn-resolved-actions"));
    }
    draft.bandNotify = np;
  }
  function bandsApplicable(tr) { return !!tr && (tr.type === "asset_metric" || tr.type === "host_metric"); }
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
      for (var j = 0; j < tiers.length; j++) {
        var t = tiers[j]; var tn = j + 1;
        if (!t.afterMin || isNaN(t.afterMin) || t.afterMin < 1) return "Escalation " + tn + ": enter the delay in minutes (1 or more).";
        if (!t.actions.length) return "Escalation " + tn + ": add at least one action (or remove it).";
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
    var bandsRow = "";
    if (bandsApplicable(draft.trigger) && draft.severityBands && draft.severityBands.length) {
      var op = (draft.trigger && draft.trigger.operator) || ">=";
      var bandLine = draft.severityBands.map(function (b) { return escapeHtml(b.severity + " " + op + " " + b.threshold); }).join(", ");
      var np = draft.bandNotify || {};
      var notifyBits = [np.onIncrease !== false ? "increase" : null, np.onDecrease ? "decrease" : null, np.onResolved !== false ? "resolved" : null].filter(Boolean).join(" + ");
      bandsRow = '<dt>Severity bands</dt><dd>' + bandLine + ' <span style="color:var(--color-text-tertiary)">— notify on ' + escapeHtml(notifyBits || "none") + '</span></dd>';
    }
    box.innerHTML = '<dl class="review-grid">' +
      '<dt>Name</dt><dd>' + escapeHtml(draft.name || "…") + ' <span class="badge badge-level-' + (draft.severity || "warning") + '">' + escapeHtml((draft.severity || "warning").toUpperCase()) + '</span>' + (draft.enabled === false ? ' <span class="badge">disabled</span>' : "") + '</dd>' +
      '<dt>Devices</dt><dd>' + escapeHtml(scopeSummaryText(draft.scope)) + '</dd>' +
      '<dt>Trigger</dt><dd>' + triggerSentence(draft.trigger) + '</dd>' +
      '<dt>Reset</dt><dd>' + resetSentence(draft.reset, draft.trigger, draft.cooldownSec) + '</dd>' +
      '<dt>Actions</dt><dd>' + (actionLines.length ? actionLines.join("<br>") : '<span style="color:var(--color-text-tertiary)">in-app alert only</span>') + '</dd>' +
      bandsRow +
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
  var COLLECT = { 1: collectStep1, 2: collectStep2, 3: collectStep3, 4: collectStep4, 5: collectStep5, 6: function () {} };
  var VALIDATE = { 1: validateStep1, 2: validateStep2, 3: validateStep3, 4: validateStep4, 5: validateStep5, 6: function () { return null; } };

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
    document.getElementById("aw-next").style.display = step < STEPS.length ? "" : "none";
    document.getElementById("aw-save").style.display = (step === STEPS.length || editing) ? "" : "none";
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
    // Steps 4–6 re-render on entry (they depend on earlier steps' state).
    if (n === 4) renderStep4();
    if (n === 5) renderStep5();
    if (n === 6) renderStep6();
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
    for (var i = 1; i <= STEPS.length; i++) {
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
      scope: isTriggerScoped(draft.trigger) ? draft.scope : {},
      reset: draft.reset,
      actions: draft.actions,
      cooldownSec: draft.cooldownSec,
      messageTemplate: draft.messageTemplate,
      channels: ["in_app"],
      emailComposition: null, // per-action composition in v2; rule-level field retired by the wizard
      escalation: draft.escalation,
      severityBands: bandsApplicable(draft.trigger) ? (draft.severityBands || null) : null,
      bandNotify: bandsApplicable(draft.trigger) && draft.severityBands && draft.severityBands.length ? (draft.bandNotify || null) : null,
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
  // (Severity moved off step 1 onto the trigger step — wired in wireStep3.)
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
    severityBands: Array.isArray(r.severityBands) && r.severityBands.length ? JSON.parse(JSON.stringify(r.severityBands)) : null,
    bandNotify: r.bandNotify ? JSON.parse(JSON.stringify(r.bandNotify)) : null,
  };
}
