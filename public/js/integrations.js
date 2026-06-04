/**
 * public/js/integrations.js — Integrations management page
 */

// ─── Polling-method dropdown helpers ───────────────────────────────────────
// Mirrors src/utils/pollingCompatibility.ts. Frontend can't import TS, so we
// repeat the matrix here. Defined in integrations.js because that file loads
// before assets.js on both integrations.html and assets.html, so the helpers
// are available globally to every page that needs them. Keep in lockstep
// with the matrix comment in pollingCompatibility.ts.

var _POLLING_LABELS = {
  rest_api: "REST API",
  snmp:     "SNMP",
  winrm:    "WinRM",
  ssh:      "SSH",
  icmp:     "ICMP",
  disabled: "Disabled",
  agent:    "Polaris Agent",
};

// "agent" is intentionally NOT in any of these arrays — the Polaris Agent
// is installed via a dedicated button on the Monitoring tab, not picked
// from the polling dropdown. When an agent is installed Polaris stamps
// the four *Polling fields to "agent" server-side at enrollment time;
// the polling-methods section is hidden in the UI for those assets. The
// _POLLING_LABELS map still includes "agent" so the value renders
// correctly on any surface that displays raw values (audit logs, the
// asset-list status pill, etc.).
var _POLLING_COMPAT = {
  fortimanager:    ["rest_api", "snmp", "ssh", "icmp", "disabled"],
  fortigate:       ["rest_api", "snmp", "ssh", "icmp", "disabled"],
  activedirectory: ["icmp", "winrm", "ssh", "disabled"],
  entraid:         ["icmp", "winrm", "ssh", "disabled"],
  windowsserver:   ["icmp", "winrm", "ssh", "disabled"],
  manual:          ["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled"],
};

// Source-default polling for one stream. Mirrors defaultPollingForSource() in
// src/services/monitoringService.ts. Used to label the "Inherit" option.
function _polarisSourceDefaultPolling(source, stream) {
  if (source === "fortimanager" || source === "fortigate") {
    if (stream === "lldp") return "disabled";
    // FortiOS appliances don't expose meaningful mountable storage; default
    // off so operators opt in by picking SNMP at any tier when they need it.
    if (stream === "storage") return "disabled";
    // Response Time is the cheapest probe — ICMP is the universal default
    // for routable devices. CPU/mem/interfaces/temperature still default to
    // REST API because that's where the data actually is.
    if (stream === "responseTime") return "icmp";
    return "rest_api";
  }
  if (stream === "responseTime") return "icmp";
  return null; // telemetry/interfaces/lldp/storage not delivered on AD/Entra/Win/Manual by default
}

// Source-label table for the "Inherit" option. ICMP is universal for response-
// time but the rest of the streams need REST API / SNMP / WinRM / etc. — the
// label tells operators which source kind they're inheriting from. FMG depends
// on the Direct Polling toggle's current state because the same `fortimanager`
// source kind talks via two different transports; the relabel helper updates
// every Inherit option in place when the toggle flips.
function _polarisSourceLabel(source, opts) {
  opts = opts || {};
  if (source === "fortigate") return "FortiGate Direct";
  if (source === "fortimanager") {
    return opts.fmgDirectMode ? "FortiGate Direct" : "FortiManager Proxy";
  }
  if (source === "activedirectory") return "Active Directory";
  if (source === "entraid")         return "Entra ID";
  if (source === "windowsserver")   return "Windows Server";
  return "Manual";
}

// Builds a polling-method <select>. When `currentValue` is null/empty/missing
// the "Inherit" option is selected and labeled with the resolver's expected
// fallback ("Inherit (Source FortiGate Direct: REST API)", "Inherit (Source
// Manual: ICMP)", or "Inherit (Source <Label>: not delivered)" when the
// stream has no default for this source kind).
//
// ICMP is filtered out of every stream except responseTime — telemetry /
// interfaces / LLDP / storage all need a real protocol; an ICMP pick on those
// would silently fall through at resolution time. The backend
// validateStreamPollingMethod() applies the same filter on writes.
function _polarisPollingDropdownHTML(id, source, stream, currentValue, opts) {
  opts = opts || {};
  var allowed = _POLLING_COMPAT[source] || _POLLING_COMPAT.manual;
  if (stream !== "responseTime") {
    allowed = allowed.filter(function (m) { return m !== "icmp"; });
  }
  // showInherit defaults to true. Set false at the bottom of the resolver
  // hierarchy (Manual Monitoring) where there's nothing to inherit from —
  // the "Inherit" option there would be misleading.
  var showInherit = opts.showInherit !== false;
  var defaultMethod = _polarisSourceDefaultPolling(source, stream);
  var sourceLabel = _polarisSourceLabel(source, opts);
  var inheritLabel = defaultMethod
    ? "Inherit (Source " + sourceLabel + ": " + _POLLING_LABELS[defaultMethod] + ")"
    : "Inherit (Source " + sourceLabel + ": not delivered)";
  var v = currentValue || "";
  var opts2 = "";
  if (showInherit) {
    opts2 += '<option value=""' + (v === "" ? " selected" : "") + '>' + escapeHtml(inheritLabel) + '</option>';
  }
  for (var i = 0; i < allowed.length; i++) {
    var m = allowed[i];
    opts2 += '<option value="' + m + '"' + (v === m ? " selected" : "") + '>' + escapeHtml(_POLLING_LABELS[m]) + '</option>';
  }
  return '<select id="' + id + '" data-poll-source="' + escapeHtml(source) + '" data-poll-stream="' + escapeHtml(stream) + '">' + opts2 + '</select>';
}

function _polarisReadPollingDropdown(id) {
  var el = document.getElementById(id);
  if (!el) return undefined;
  return el.value || null;
}

// Standard MIBs selectable without uploading anything. Kept in lockstep with
// the _SNMP_STANDARD_MIBS array in assets.js (SNMP Walk tab).
var _SNMP_STANDARD_MIBS = [
  { id: "std:system",         label: "System (RFC 1213)",              oid: "1.3.6.1.2.1.1"         },
  { id: "std:interfaces",     label: "Interfaces — ifTable (RFC 2863)", oid: "1.3.6.1.2.1.2"         },
  { id: "std:if-ext",         label: "Interfaces — ifXTable, 64-bit counters (RFC 2863)", oid: "1.3.6.1.2.1.31"        },
  { id: "std:host-resources", label: "HOST-RESOURCES-MIB (RFC 2790)",  oid: "1.3.6.1.2.1.25"        },
  { id: "std:entity",         label: "ENTITY-MIB (RFC 4133)",          oid: "1.3.6.1.2.1.47"        },
  { id: "std:entity-sensor",  label: "ENTITY-SENSOR-MIB (RFC 3433)",   oid: "1.3.6.1.2.1.99"        },
  { id: "std:lldp",           label: "LLDP-MIB (IEEE 802.1AB)",        oid: "1.0.8802.1.1.2"        },
  { id: "std:fortinet-fg",    label: "Fortinet FORTIGATE-MIB",         oid: "1.3.6.1.4.1.12356.101" },
];

// Cache of uploaded MIBs for per-stream MIB pickers. null = not yet loaded.
var _uploadedMibsCache = null;

// Build <option> HTML for a MIB <select>. selectedId: null/"" = Automatic,
// "std:..." = standard built-in, UUID = uploaded MIB from the MIB database.
// Derive per-stream auto MIB names from the source kind (integration / class override tiers).
// CPU/memory + temperature both vary by vendor; the other three streams always use standard MIBs.
var _SOURCE_TELEMETRY_MIB = {
  fortimanager: "FORTINET-FORTIGATE-MIB",
  fortigate:    "FORTINET-FORTIGATE-MIB",
};
// Temperature: ENTITY-SENSOR-MIB is the standard fallback; Fortinet exposes its
// own sensor table under FORTINET-FORTIGATE-MIB (fgHwSensorTable) which the
// collector tries before falling back to ENTITY-SENSOR-MIB.
var _SOURCE_TEMPERATURE_MIB = {
  fortimanager: "FORTINET-FORTIGATE-MIB",
  fortigate:    "FORTINET-FORTIGATE-MIB",
};
function _autoMibNamesForSource(sourceKind) {
  return {
    responseTime: "SNMPv2-MIB",
    telemetry:    _SOURCE_TELEMETRY_MIB[sourceKind]   || "HOST-RESOURCES-MIB",
    temperature:  _SOURCE_TEMPERATURE_MIB[sourceKind] || "ENTITY-SENSOR-MIB",
    interfaces:   "IF-MIB",
    lldp:         "LLDP-MIB",
  };
}

// autoName is optional — when provided, replaces "let Polaris choose" with the resolved name.
function _mibOptionsHTML(selectedId, autoName) {
  var sel = selectedId || "";
  var autoLabel = "Automatic" + (autoName ? " (" + autoName + ")" : " (let Polaris choose)");
  var html = '<option value=""' + (sel === "" ? " selected" : "") + ">" + escapeHtml(autoLabel) + "</option>";
  html += '<optgroup label="Standard MIBs">';
  _SNMP_STANDARD_MIBS.forEach(function (m) {
    html += '<option value="' + escapeHtml(m.id) + '"' + (sel === m.id ? " selected" : "") + '>' + escapeHtml(m.label) + '</option>';
  });
  html += '</optgroup>';
  if (_uploadedMibsCache && _uploadedMibsCache.length > 0) {
    html += '<optgroup label="Uploaded MIBs">';
    _uploadedMibsCache.forEach(function (m) {
      var lbl = m.moduleName + (m.manufacturer ? " (" + m.manufacturer + (m.model ? "/" + m.model : "") + ")" : " (generic)");
      html += '<option value="' + escapeHtml(m.id) + '"' + (sel === m.id ? " selected" : "") + '>' + escapeHtml(lbl) + '</option>';
    });
    html += '</optgroup>';
  }
  return html;
}

// Populate every MIB <select> on the page (identified by data-mib-picker="1")
// with the current uploaded-MIB list. Lazy-loads from the API on first call.
function _populateUploadedMibsInDropdowns() {
  function repopulate() {
    var sels = document.querySelectorAll("[data-mib-picker='1']");
    for (var i = 0; i < sels.length; i++) {
      var el = sels[i];
      var current = el.getAttribute("data-current-id") || "";
      var autoName = el.getAttribute("data-auto-mib-name") || "";
      el.innerHTML = _mibOptionsHTML(current, autoName);
    }
  }
  if (_uploadedMibsCache !== null) {
    repopulate();
  } else {
    repopulate(); // render standard MIBs immediately; uploaded group appears once loaded
    api.serverSettings.listMibs({}).then(function (mibs) {
      _uploadedMibsCache = Array.isArray(mibs) ? mibs : [];
      repopulate();
    }).catch(function () {
      _uploadedMibsCache = [];
    });
  }
}

// Renders the four-stream polling block (response-time, telemetry, interfaces,
// lldp) for a given source kind. Used by the integration Monitoring tab, the
// class override editor, and the asset edit modal.
//
// opts.showMibRows  — emit a per-stream MIB sub-row (shown when SNMP selected)
// opts.showCredRows — emit a per-stream credential sub-row (class override tier)
// opts.credentials  — array of {id,name,type} for the credential sub-row
// opts.credValues   — object with {responseTimeCredentialId, ...} current values
// opts.mibValues    — object with {responseTimeMibId, ...} current values
function _polarisPollingFourStreamHTML(idPrefix, source, current, opts) {
  current = current || {};
  opts    = opts    || {};
  var showMibRows  = !!opts.showMibRows;
  var showCredRows = !!opts.showCredRows;
  var credentials  = opts.credentials || [];
  var credValues   = opts.credValues  || {};
  var mibValues    = opts.mibValues   || {};

  var streams = [
    { key: "responseTime",  label: "Response time",  pollField: "responseTimePolling",  credField: "responseTimeCredentialId",  mibField: "responseTimeMibId"  },
    { key: "telemetry",     label: "CPU/Memory",     pollField: "cpuMemoryPolling",     credField: "cpuMemoryCredentialId",     mibField: "cpuMemoryMibId"     },
    { key: "temperature",   label: "Temperature",    pollField: "temperaturePolling",   credField: "temperatureCredentialId",   mibField: "temperatureMibId"  },
    { key: "interfaces",    label: "Interfaces",     pollField: "interfacesPolling",    credField: "interfacesCredentialId",    mibField: "interfacesMibId"    },
    { key: "storage",       label: "Storage",        pollField: "storagePolling",       credField: "storageCredentialId",       mibField: null,                  noMib: true },
    { key: "lldp",          label: "LLDP neighbors", pollField: "lldpPolling",          credField: "lldpCredentialId",          mibField: "lldpMibId"          },
  ];

  var rows = "";
  streams.forEach(function (s) {
    var pollIsSnmp = (current[s.pollField] === "snmp");

    // Optional per-stream credential sub-row (class override tier). Storage
    // has no dedicated per-stream credential column — the SNMP storage walk
    // reuses whichever credential the interfaces stream resolved (the same
    // session pulls hrStorageTable alongside ifTable), so skip the row.
    var credSubRow = "";
    if (showCredRows && !s.noMib) {
      var currentCredId = credValues[s.credField] || "";
      var credOpts = '<option value="">— Inherit (use integration credential) —</option>';
      credentials.forEach(function (c) {
        if (c.type !== "snmp") return;
        credOpts += '<option value="' + escapeHtml(c.id) + '"' + (currentCredId === c.id ? " selected" : "") + '>' + escapeHtml(c.name) + '</option>';
      });
      credSubRow = '<div id="' + idPrefix + s.key + '-cred-wrap" style="display:' + (pollIsSnmp ? "flex" : "none") + ';grid-column:2;align-items:center;gap:0.5rem;margin-top:0.25rem">' +
        '<label style="margin:0;font-size:0.85rem;color:var(--color-text-secondary)">Credential</label>' +
        '<select id="' + idPrefix + s.key + 'Cred" style="flex:1">' + credOpts + '</select>' +
      '</div>';
    }

    // Optional per-stream MIB sub-row. Storage has no per-stream MIB column —
    // the SNMP storage walk hits HOST-RESOURCES-MIB hrStorageTable with a
    // vendor fallback through pickVendorProfileMerged; there's nothing the
    // operator can usefully pick from a MIB list, so skip the row entirely.
    var mibSubRow = "";
    if (showMibRows && !s.noMib && s.mibField) {
      var currentMibId = mibValues[s.mibField] || "";
      var autoMibName  = (opts.autoMibNames || _autoMibNamesForSource(source))[s.key] || "";
      mibSubRow = '<div id="' + idPrefix + s.key + '-mib-wrap" style="display:' + (pollIsSnmp ? "flex" : "none") + ';grid-column:2;align-items:center;gap:0.5rem;margin-top:0.25rem">' +
        '<label style="margin:0;font-size:0.85rem;color:var(--color-text-secondary)">MIB</label>' +
        '<select id="' + idPrefix + s.key + 'Mib" data-current-id="' + escapeHtml(currentMibId) + '" data-auto-mib-name="' + escapeHtml(autoMibName) + '" data-mib-picker="1" style="flex:1">' +
          _mibOptionsHTML(currentMibId, autoMibName) +
        '</select>' +
      '</div>';
    }

    var labelHtml = '<label style="margin:0">' + escapeHtml(s.label) +
      (s.note ? '<div style="font-size:0.72rem;font-weight:normal;color:var(--color-text-tertiary);margin-top:2px">' + escapeHtml(s.note) + '</div>' : '') +
      '</label>';
    rows += labelHtml +
      _polarisPollingDropdownHTML(idPrefix + s.pollField, source, s.key, current[s.pollField]) +
      credSubRow +
      mibSubRow;
  });

  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0.5rem 0 0.5rem 0">Polling Methods</p>' +
    '<div style="display:grid;grid-template-columns:200px 1fr;gap:0.5rem 1rem;align-items:center;margin-bottom:0.75rem">' +
      rows +
    '</div>';
}

function _polarisReadPollingFourStream(idPrefix) {
  return {
    responseTimePolling: _polarisReadPollingDropdown(idPrefix + "responseTimePolling"),
    cpuMemoryPolling:    _polarisReadPollingDropdown(idPrefix + "cpuMemoryPolling"),
    temperaturePolling:  _polarisReadPollingDropdown(idPrefix + "temperaturePolling"),
    interfacesPolling:   _polarisReadPollingDropdown(idPrefix + "interfacesPolling"),
    lldpPolling:         _polarisReadPollingDropdown(idPrefix + "lldpPolling"),
    storagePolling:      _polarisReadPollingDropdown(idPrefix + "storagePolling"),
  };
}

// Read per-stream MIB IDs from selects rendered by _polarisPollingFourStreamHTML.
// Returns {responseTimeMibId, cpuMemoryMibId, interfacesMibId, lldpMibId} with
// null for streams whose select is absent or set to "Automatic".
function _polarisReadMibFourStream(idPrefix) {
  function mibVal(stream) {
    var el = document.getElementById(idPrefix + stream + "Mib");
    return el ? (el.value || null) : undefined;
  }
  return {
    responseTimeMibId: mibVal("responseTime"),
    cpuMemoryMibId:    mibVal("telemetry"),
    temperatureMibId:  mibVal("temperature"),
    interfacesMibId:   mibVal("interfaces"),
    lldpMibId:         mibVal("lldp"),
  };
}

// Read per-stream credential IDs from selects rendered by _polarisPollingFourStreamHTML
// (class override tier only — opts.showCredRows must have been true).
function _polarisReadCredFourStream(idPrefix) {
  function credVal(stream) {
    var el = document.getElementById(idPrefix + stream + "Cred");
    return el ? (el.value || null) : undefined;
  }
  return {
    responseTimeCredentialId: credVal("responseTime"),
    cpuMemoryCredentialId:    credVal("telemetry"),
    temperatureCredentialId:  credVal("temperature"),
    interfacesCredentialId:   credVal("interfaces"),
    lldpCredentialId:         credVal("lldp"),
  };
}

document.addEventListener("DOMContentLoaded", function () {
  // Guard: this file is also loaded on assets.html for its monitoring form
  // helpers; only run the integrations-page init when the list element exists.
  if (!document.getElementById("integrations-list")) return;
  loadIntegrations();
  document.getElementById("btn-add-integration").addEventListener("click", showTypePicker);

  // Tab switching: Integrations (default) ↔ Polaris Agents. Agents tab lazy-
  // mounts the agent-build card on first activation; the + Add Integration
  // button in the page header is hidden while the Agents tab is active so
  // it doesn't suggest the button applies to agents (the agent install flow
  // lives on each asset's details modal).
  var _agentsTabLoaded = false;
  var addBtn = document.getElementById("btn-add-integration");
  document.querySelectorAll("#integration-tabs .page-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var target = tab.getAttribute("data-tab");
      document.querySelectorAll("#integration-tabs .page-tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".page-tab-panel").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      var panel = document.getElementById("tab-" + target);
      if (panel) panel.classList.add("active");
      if (addBtn) addBtn.style.display = (target === "integrations") ? "" : "none";
      if (target === "agents" && !_agentsTabLoaded) {
        _agentsTabLoaded = true;
        if (window.PolarisAgentBuild && window.PolarisAgentBuild.init) {
          window.PolarisAgentBuild.init();
        }
      }
    });
  });
});

// Kick off the direct-transport sanity check after a successful FMG test and
// surface its result as its own toast. Intentionally fire-and-forget so the
// FMG success toast isn't delayed by the FortiGate probe, which can be slow
// if the randomly chosen gate is unreachable.
function _runFortigateSampleProbe(runner) {
  runner()
    .then(function (r) {
      showToast(r.message, r.ok ? "success" : "error");
      loadIntegrations();
    })
    .catch(function (err) {
      if (err && err.name === "AbortError") return;
      showToast("Random FortiGate test failed: " + (err && err.message ? err.message : "unknown error"), "error");
    });
}

// After a fresh integration of a subnet-producing type is created, warn the
// operator if no IP blocks are defined yet. Discovery skips every DHCP scope
// without a matching parent block (`syncDhcpSubnets` logs them as "no matching
// parent block"), so without a block the integration is effectively a no-op.
// Asset-only integrations (Entra/AD) don't need blocks — they're skipped here.
async function _warnIfNoBlocksForIntegrationType(integrationType, integrationName) {
  var producesSubnets =
    integrationType === "fortimanager" ||
    integrationType === "fortigate" ||
    integrationType === "windowsserver";
  if (!producesSubnets) return;
  var blocks;
  try {
    var resp = await api.blocks.list();
    blocks = Array.isArray(resp) ? resp : (resp && resp.blocks) || [];
  } catch (e) {
    return; // Best-effort; don't block the create flow on a list-blocks failure
  }
  if (blocks.length > 0) return;
  var name = escapeHtml(integrationName || "this integration");
  var body =
    '<p style="font-size:0.95rem;color:var(--color-text-primary);margin-bottom:0.75rem">' +
    'No IP blocks are defined yet.</p>' +
    '<p style="font-size:0.88rem;color:var(--color-text-secondary);line-height:1.5;margin-bottom:0.75rem">' +
    'When ' + name + ' runs discovery, every DHCP scope it finds needs a parent IP block to land in. ' +
    'Without at least one block, all discovered subnets will be skipped and no endpoint reservations will be tracked.' +
    '</p>' +
    '<p style="font-size:0.88rem;color:var(--color-text-secondary);line-height:1.5">' +
    'Add the IP space your organization owns under <strong>IP Blocks</strong> before running discovery.' +
    '</p>';
  var footer =
    '<button class="btn btn-secondary" id="noblocks-dismiss">Got it</button>' +
    '<button class="btn btn-primary" id="noblocks-go">Add IP Block</button>';
  openModal("IP Blocks Required", body, footer);
  var dismiss = document.getElementById("noblocks-dismiss");
  var go = document.getElementById("noblocks-go");
  if (dismiss) dismiss.onclick = function () { closeModal(); };
  if (go) go.onclick = function () { closeModal(); window.location.href = "/blocks.html"; };
}

// Toggle FMG integration form between proxy and direct modes.
// `useDirect=true` means bypass FMG and query each FortiGate directly;
// the on-disk integration field stays `useProxy` (true=proxy) — only the
// UI semantics are inverted. Shows/hides the FortiGate credentials block
// and locks the parallelism input.
function _fmgToggleDirectMode(useDirect) {
  var directBlock = document.getElementById("f-direct-mode-block");
  var parallelInput = document.getElementById("f-discoveryParallelism");
  if (directBlock) directBlock.style.display = useDirect ? "" : "none";
  // Force parallelism back to 1 when collapsing so getFormConfig
  // doesn't ship a stale direct-mode value with proxy mode.
  if (parallelInput && !useDirect) parallelInput.value = 1;
}

function _discoverBtnHTML(id, name, discovery, disabled) {
  if (discovery) {
    var isSlow = discovery.slow || (discovery.slowDevices && discovery.slowDevices.length > 0);
    var style = isSlow
      ? 'background:rgba(255,214,0,0.12);border:1px solid rgba(255,214,0,0.35);color:var(--color-warning)'
      : 'background:rgba(79,195,247,0.1);border:1px solid rgba(79,195,247,0.25);color:var(--color-accent)';
    var label = isSlow ? 'Discovering — slow' : 'Discovering…';
    var title = isSlow ? ' title="This discovery is running longer than normal"' : '';
    // Aborting a running discovery/query is admin-only (integrations:fullwrite);
    // mirrors the server-side guard on DELETE /:id/discover so non-admins don't
    // see a button that would 403.
    var abortBtn = permAtLeast("integrations", "fullwrite")
      ? '<button class="query-abort-btn" style="margin-left:2px" onclick="abortIntegrationDiscovery(\'' + id + '\',\'' + escapeHtml(name) + '\')" title="Abort">&#x2715;</button>'
      : '';
    return '<span' + title + ' style="display:inline-flex;align-items:center;gap:6px;font-size:0.78rem;padding:0.3rem 0.6rem;border-radius:var(--radius-md);font-weight:500;' + style + '">' +
      '<span class="query-spinner"></span>' +
      '<span>' + label + '</span>' +
      abortBtn +
    '</span>';
  }
  return '<button class="btn btn-sm btn-primary" onclick="runDiscovery(\'' + id + '\')"' +
    (disabled ? ' disabled title="Run a successful test first"' : '') + '>Discover</button>';
}

function _updateDiscoverButtons(discoveries) {
  discoveries = discoveries || [];
  document.querySelectorAll("[id^='discover-wrap-']").forEach(function (wrap) {
    var id = wrap.id.slice("discover-wrap-".length);
    var name = (wrap.closest(".integration-card") || document).querySelector("strong");
    name = name ? name.textContent : "";
    var disabled = wrap.getAttribute("data-disabled") === "1";
    var discovery = discoveries.find(function (d) { return d.id === id; }) || null;
    wrap.innerHTML = _discoverBtnHTML(id, name, discovery, disabled);
  });
}

async function loadIntegrations() {
  var container = document.getElementById("integrations-list");
  window._onDiscoveriesChanged = _updateDiscoverButtons;
  try {
    var result = await api.integrations.list();
    var integrations = result.integrations || result;
    if (integrations.length === 0) {
      container.innerHTML = '<div class="empty-state-card"><p>No integrations configured.</p><p style="color:var(--color-text-tertiary);font-size:0.85rem;margin-top:0.5rem">Add a FortiManager, FortiGate, Windows Server, Microsoft Entra ID, or Active Directory connection to get started.</p></div>';
      return;
    }
    var activeDiscoveries = (window._getServerDiscoveries && window._getServerDiscoveries()) || [];
    container.innerHTML = integrations.map(function (intg) {
      var config = intg.config || {};
      var statusDot = intg.lastTestOk === true ? "dot-ok" : intg.lastTestOk === false ? "dot-fail" : "dot-unknown";
      var statusText = intg.lastTestOk === true ? "Connected" : intg.lastTestOk === false ? "Failed" : "Not tested";
      var lastTest = intg.lastTestAt ? formatDate(intg.lastTestAt) : "Never";
      var typeBadge =
        intg.type === "windowsserver" ? "Windows Server" :
        intg.type === "fortigate" ? "FortiGate" :
        intg.type === "entraid" ? "Entra ID" :
        intg.type === "activedirectory" ? "Active Directory" :
        "FortiManager";

      function filterRow(baseLabel, include, exclude) {
        include = include || []; exclude = exclude || [];
        var label = include.length > 0 ? baseLabel + ' Include' : baseLabel + ' Exclude';
        var list = include.length > 0 ? include : exclude;
        var value = list.length > 0 ? escapeHtml(list.join(", ")) : '<span style="color:var(--color-text-tertiary)">None</span>';
        return '<div class="detail-row"><span class="detail-label">' + label + '</span><span class="detail-value">' + value + '</span></div>';
      }
      var defaultPort =
        intg.type === "windowsserver" ? 5985 :
        intg.type === "activedirectory" ? (config.useLdaps === false ? 389 : 636) :
        443;

      var detailRows;
      if (intg.type === "activedirectory") {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || defaultPort) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Protocol</span><span class="detail-value">' + (config.useLdaps === false ? "LDAP" : "LDAPS") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Bind DN</span><span class="detail-value mono">' + escapeHtml(config.bindDn || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Base DN</span><span class="detail-value mono">' + escapeHtml(config.baseDn || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Search Scope</span><span class="detail-value">' + escapeHtml(config.searchScope || "sub") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Verify TLS</span><span class="detail-value">' + (config.verifyTls ? "Yes" : "No") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Include Disabled</span><span class="detail-value">' + (config.includeDisabled === false ? "No (skipped)" : "Yes (as disabled)") + '</span></div>' +
          filterRow("OUs", config.ouInclude, config.ouExclude);
      } else if (intg.type === "entraid") {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Tenant ID</span><span class="detail-value mono">' + escapeHtml(config.tenantId || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Client ID</span><span class="detail-value mono">' + escapeHtml(config.clientId || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Intune Sync</span><span class="detail-value">' + (config.enableIntune ? "Enabled" : "Disabled") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Include Disabled</span><span class="detail-value">' + (config.includeDisabled === false ? "No (skipped)" : "Yes (as disabled)") + '</span></div>' +
          filterRow("Devices", config.deviceInclude, config.deviceExclude);
      } else if (intg.type === "windowsserver") {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || defaultPort) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Username</span><span class="detail-value">' + escapeHtml(config.username || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Domain</span><span class="detail-value">' + escapeHtml(config.domain || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Use SSL</span><span class="detail-value">' + (config.useSsl ? "Yes" : "No") + '</span></div>' +
          filterRow("DHCP", config.dhcpInclude, config.dhcpExclude);
      } else if (intg.type === "fortigate") {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || defaultPort) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">API User</span><span class="detail-value">' + escapeHtml(config.apiUser || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">VDOM</span><span class="detail-value">' + escapeHtml(config.vdom || "root") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">SSL Verify</span><span class="detail-value">' + (config.verifySsl ? "Yes" : "No") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Mgmt Interface</span><span class="detail-value mono">' + escapeHtml(config.mgmtInterface || "-") + '</span></div>' +
          filterRow("DHCP", config.dhcpInclude, config.dhcpExclude) +
          filterRow("Interface", config.interfaceInclude, config.interfaceExclude) +
          filterRow("Inventory", config.inventoryIncludeInterfaces, config.inventoryExcludeInterfaces);
      } else {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || defaultPort) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">API User</span><span class="detail-value">' + escapeHtml(config.apiUser || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">ADOM</span><span class="detail-value">' + escapeHtml(config.adom || "root") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">SSL Verify</span><span class="detail-value">' + (config.verifySsl ? "Yes" : "No") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">FMG Proxy</span><span class="detail-value">' + (config.useProxy === false ? "Disabled (direct)" : "Enabled") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Mgmt Interface</span><span class="detail-value mono">' + escapeHtml(config.mgmtInterface || "-") + '</span></div>' +
          filterRow("FortiGates", config.deviceInclude, config.deviceExclude) +
          filterRow("DHCP", config.dhcpInclude, config.dhcpExclude) +
          filterRow("Inventory", config.inventoryIncludeInterfaces, config.inventoryExcludeInterfaces);
      }

      var nextDiscoveryText;
      if (!intg.enabled) {
        nextDiscoveryText = '<span style="color:var(--color-text-tertiary)">Integration disabled</span>';
      } else if (!intg.lastTestOk) {
        nextDiscoveryText = '<span style="color:var(--color-text-tertiary)">—</span>';
      } else if (intg.autoDiscover === false) {
        nextDiscoveryText = '<span style="color:var(--color-text-tertiary)">—</span>';
      } else {
        var intervalMs = (intg.pollInterval || 4) * 3600000;
        var nextRunMs = intg.lastDiscoveryAt ? new Date(intg.lastDiscoveryAt).getTime() + intervalMs : Date.now();
        nextDiscoveryText = escapeHtml(new Date(nextRunMs).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }));
      }

      // "Avg Discovery Time" row — surfaces the rolling baseline from
      // discoveryDurationService so operators can size pollInterval against
      // observed run length. Hidden until enough samples have been collected
      // (matches the slow-detection MIN_SAMPLES floor on the backend).
      var avgRow = "";
      var bl = intg.discoveryBaseline;
      if (bl && bl.sampleCount >= 3 && bl.avgMs > 0) {
        var avgMs = bl.avgMs;
        var s = Math.floor(avgMs / 1000);
        var avgText;
        if (s < 60) avgText = s + "s";
        else if (s < 3600) avgText = Math.floor(s / 60) + "m " + ((s % 60) < 10 ? "0" : "") + (s % 60) + "s";
        else avgText = Math.floor(s / 3600) + "h " + (Math.floor(s / 60) % 60) + "m";
        var intervalMsForAvg = (intg.pollInterval || 4) * 3600000;
        var autoOn = intg.enabled && intg.lastTestOk && intg.autoDiscover !== false;
        var nearOverlap = autoOn && avgMs > intervalMsForAvg * 0.75;
        var valueStyle = nearOverlap ? ' style="color:var(--color-warning)"' : "";
        var tooltip = nearOverlap
          ? ' title="Average run time is approaching the auto-discovery interval. Consecutive runs may begin overlapping — consider lengthening the interval."'
          : "";
        avgRow = '<div class="detail-row"' + tooltip + '><span class="detail-label">Avg Discovery Time</span><span class="detail-value"' + valueStyle + '>' + escapeHtml(avgText) + ' <span style="color:var(--color-text-tertiary);font-size:0.85em">(last ' + bl.sampleCount + ' run' + (bl.sampleCount === 1 ? '' : 's') + ')</span></span></div>';
      }

      var isFmgDirect = intg.type === "fortimanager" && config.useProxy === false;
      var fmgActivityRow = intg.type === "fortimanager"
        ? '<div class="detail-row" id="fmg-activity-row-' + intg.id + '"><span class="detail-label">Active FMG Calls</span><span class="detail-value" id="fmg-activity-val-' + intg.id + '" style="color:var(--color-text-tertiary)">&mdash;</span></div>'
        : '';
      return '<div class="integration-card"' + (isFmgDirect ? ' data-fmg-direct="1"' : '') + '>' +
        '<div class="integration-card-header">' +
          '<div class="integration-card-header-top">' +
            '<div class="integration-card-title">' +
              '<span class="integration-type-badge">' + typeBadge + '</span>' +
              '<strong>' + escapeHtml(intg.name) + '</strong>' +
              '<span class="integration-status ' + statusDot + '">' + statusText + '</span>' +
            '</div>' +
            '<div id="discover-wrap-' + intg.id + '" data-disabled="' + (intg.lastTestOk !== true ? '1' : '0') + '">' +
              _discoverBtnHTML(intg.id, intg.name, activeDiscoveries.find(function(d){ return d.id === intg.id; }) || null, intg.lastTestOk !== true) +
            '</div>' +
          '</div>' +
          '<div class="integration-card-actions">' +
            (intg.type === "fortimanager" ? '<button class="btn btn-sm btn-secondary" onclick="openApiQueryModal(\'' + intg.id + '\', \'' + escapeHtml(config.adom || 'root') + '\', ' + (config.useProxy !== false ? 'true' : 'false') + ')">Query API</button>' : '') +
            (intg.type === "fortigate" ? '<button class="btn btn-sm btn-secondary" onclick="openFgtApiQueryModal(\'' + intg.id + '\', \'' + escapeHtml(config.vdom || 'root') + '\')">Query API</button>' : '') +
            (intg.type === "entraid" ? '<button class="btn btn-sm btn-secondary" onclick="openEntraApiQueryModal(\'' + intg.id + '\')">Query API</button>' : '') +
            (intg.type === "activedirectory" ? '<button class="btn btn-sm btn-secondary" onclick="openAdApiQueryModal(\'' + intg.id + '\')">Query API</button>' : '') +
            '<button class="btn btn-sm btn-secondary" onclick="testConnection(\'' + intg.id + '\', this)">Test Connection</button>' +
            '<button class="btn btn-sm btn-secondary" onclick="openEditModal(\'' + intg.id + '\')">Edit</button>' +
            '<button class="btn btn-sm btn-danger" onclick="confirmDelete(\'' + intg.id + '\', \'' + escapeHtml(intg.name) + '\')">Delete</button>' +
          '</div>' +
        '</div>' +
        '<div class="integration-card-details">' +
          detailRows +
          '<div class="detail-row"><span class="detail-label">Auto-Discovery</span><span class="detail-value">' + (!intg.lastTestOk ? '<span style="color:var(--color-text-tertiary)">Disabled until a successful connection test</span>' : intg.autoDiscover === false ? '<span style="color:var(--color-text-tertiary)">Disabled</span>' : 'Every ' + (intg.pollInterval || 4) + ' hour' + ((intg.pollInterval || 4) === 1 ? '' : 's')) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Next Auto-Discovery</span><span class="detail-value">' + nextDiscoveryText + '</span></div>' +
          avgRow +
          '<div class="detail-row"><span class="detail-label">Status</span><span class="detail-value">' + (intg.enabled ? '<span class="badge badge-active">Enabled</span>' : '<span class="badge badge-deprecated">Disabled</span>') + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Last Tested</span><span class="detail-value">' + lastTest + '</span></div>' +
          fmgActivityRow +
        '</div>' +
      '</div>';
    }).join("");
    _pollFmgActivityAll(integrations);
  } catch (err) {
    container.innerHTML = '<p class="empty-state">Error: ' + escapeHtml(err.message) + '</p>';
  }
}

// Poll the /fmg-activity endpoint for every FortiManager integration on the
// page and update its "Active FMG Calls" row. Reads the DB-backed snapshot
// the discovery role (or single-process "all" role) writes every 2 s — so a
// stuck CMDB call shows up here as a non-zero native-inflight count that
// never decrements, and a stuck proxy call shows as a long-running label.
function _pollFmgActivityAll(integrations) {
  var fmgIds = (integrations || []).filter(function (i) { return i.type === "fortimanager"; }).map(function (i) { return i.id; });
  fmgIds.forEach(_pollFmgActivityOne);
}
async function _pollFmgActivityOne(id) {
  var el = document.getElementById("fmg-activity-val-" + id);
  if (!el) return;
  try {
    var r = await api.integrations.fmgActivity(id);
    el.innerHTML = _renderFmgActivity(r);
  } catch (_) {
    // Leave the previous value in place on transient errors.
  }
}
function _renderFmgActivity(r) {
  var tertiary = 'color:var(--color-text-tertiary)';
  var warning = 'color:var(--color-warning)';
  if (!r || r.updatedAt === null) {
    return '<span style="' + tertiary + '" title="No heartbeat from the FMG worker process yet. Snapshot is written by the discovery role; if you\'re in split-role prod, make sure polaris-discovery is running.">no heartbeat</span>';
  }
  if (!r.fresh) {
    var ageSec = r.ageMs != null ? Math.round(r.ageMs / 1000) : null;
    return '<span style="' + warning + '" title="The FMG worker process stopped publishing its activity heartbeat. Check polaris-discovery service health.">stale' + (ageSec != null ? ' (' + ageSec + 's old)' : '') + '</span>';
  }
  var parts = [];
  if (r.proxyInFlightLabel) {
    parts.push('<span title="Proxy lane in-flight (one at a time; FMG\'s rule)">&#9889; ' + escapeHtml(String(r.proxyInFlightLabel)) + '</span>');
  }
  if (r.proxyQueueDepth > 0) {
    parts.push('<span title="Proxy-lane requests waiting behind the in-flight call">queued ' + r.proxyQueueDepth + '</span>');
  }
  if (r.nativeInFlightCount > 0) {
    parts.push('<span title="Native-lane (CMDB/dvmdb) calls running in parallel">native ' + r.nativeInFlightCount + '</span>');
  }
  if (parts.length === 0) {
    return '<span style="' + tertiary + '">idle</span>';
  }
  return parts.join(' &middot; ');
}

// Periodic refresher: re-poll every 2 s while the integrations tab is visible.
// loadIntegrations() does the initial population (and re-runs whenever the
// list changes); this interval keeps the rows live in between.
setInterval(function () {
  var rows = document.querySelectorAll('[id^="fmg-activity-val-"]');
  rows.forEach(function (el) {
    var id = el.id.substring("fmg-activity-val-".length);
    _pollFmgActivityOne(id);
  });
}, 2000);

// ─── Tab helpers (FMG / FortiGate modal — General + Monitoring) ────────────
//
// Mirror of the assets.js tab pattern. Keeps `f-...` form IDs intact across
// tabs so the existing getFormConfig / getFgtFormConfig don't need to change.

function _intRenderTabbedBody(prefix, tabs) {
  var tabBar = '<div class="page-tabs" id="' + prefix + '-tabs" style="margin-bottom:1rem">' +
    tabs.map(function (t, i) {
      return '<button type="button" class="page-tab' + (i === 0 ? " active" : "") + '" data-tab="' + t.key + '">' + escapeHtml(t.label) + '</button>';
    }).join("") +
    '</div>';
  var panels = tabs.map(function (t, i) {
    return '<div class="page-tab-panel' + (i === 0 ? " active" : "") + '" id="' + prefix + '-tab-' + t.key + '">' + t.html + '</div>';
  }).join("");
  return tabBar + panels;
}

function _intWireModalTabs(prefix) {
  document.querySelectorAll("#" + prefix + "-tabs .page-tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.getAttribute("data-tab");
      document.querySelectorAll("#" + prefix + "-tabs .page-tab").forEach(function (b) { b.classList.remove("active"); });
      document.querySelectorAll('[id^="' + prefix + '-tab-"]').forEach(function (p) { p.classList.remove("active"); });
      btn.classList.add("active");
      var panel = document.getElementById(prefix + "-tab-" + key);
      if (panel) panel.classList.add("active");
    });
  });
}

// DHCP Push tab body. Renders the master toggle plus mode-aware guidance:
// when useProxy is on the call lands on the FortiGate via FMG's REST proxy
// in real time; when it's off it goes direct to the FortiGate's REST API
// using fortigateApiUser/fortigateApiToken on the Settings tab. The toggle
// gates both halves of the Polaris → FortiGate DHCP write path:
//   1. Manual reservation creates → POST /cmdb/system.dhcp/server/<id>/
//      reserved-address. Verified on read-back; failures abort the create.
//   2. Freeing a discovered dhcp_lease row → POST /monitor/system/dhcp/
//      release-lease {ip}. Best-effort; device failure does not block the
//      Polaris release.
//
// `pushReservations` is the current toggle value; `useProxy` is the current
// transport setting on the General tab (we read it at render time only).
function reservationPushFormHTML(pushReservations, useProxy) {
  var checked = pushReservations === true ? "checked" : "";
  var modeLabel = (useProxy === false)
    ? "Direct to each FortiGate"
    : "Proxy through FortiManager to each FortiGate";
  var modeBody = (useProxy === false)
    ? "DHCP writes go to each FortiGate's REST API using the per-device API token configured on the Settings tab. FortiManager is bypassed entirely. Each call lands on the running config in real time."
    : "DHCP writes go through FortiManager's <code>/sys/proxy/json</code> endpoint, which forwards the call to the target FortiGate using FortiManager's stored device credentials. Each call lands on the running config in real time; FortiManager will see the change on its next config sync.";
  return '<section style="margin-bottom:1.5rem">' +
      '<h4 style="margin:0 0 0.25rem 0">DHCP Push</h4>' +
      '<p class="hint" style="margin:0 0 0.75rem 0;color:var(--color-text-tertiary)">When enabled, two DHCP writes flow from Polaris back to the originating FortiGate on subnets discovered by this integration.</p>' +
      '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<input type="checkbox" id="f-pushReservations" ' + checked + ' style="width:auto">' +
        '<label for="f-pushReservations" style="margin:0">Write Polaris DHCP changes back to FortiGate</label>' +
      '</div>' +
      '<ul class="hint" style="margin:0.25rem 0 0 1.2rem;padding:0">' +
        '<li><strong>Reservation create.</strong> Every manual IP reservation is written to the FortiGate at create time as a <code>reserved-address</code> entry. The Polaris reservation only commits if the device write succeeds and the entry verifies on read-back; any failure aborts the create.</li>' +
        '<li><strong>DHCP lease revoke.</strong> Freeing a discovered <code>dhcp_lease</code> row tells the FortiGate to forget the current lease via <code>release-lease</code>. Best-effort &mdash; a device-side failure is logged as a warning but does not block the Polaris release. The same client can still DHCP-acquire the IP back on its next request; this is "expire now," not a block.</li>' +
      '</ul>' +
    '</section>' +
    '<hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--color-border)">' +
    '<section style="margin-bottom:1.5rem">' +
      '<h4 style="margin:0 0 0.25rem 0">Push Transport</h4>' +
      '<p class="hint" style="margin:0 0 0.25rem 0;color:var(--color-text-tertiary)">Current setting: <strong style="color:var(--color-text-primary)">' + escapeHtml(modeLabel) + '</strong></p>' +
      '<p class="hint" style="margin:0;color:var(--color-text-tertiary)">' + modeBody + '</p>' +
    '</section>' +
    '<hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--color-border)">' +
    '<section>' +
      '<h4 style="margin:0 0 0.25rem 0">Required FortiManager Admin Profile</h4>' +
      '<p class="hint" style="margin:0 0 0.75rem 0;color:var(--color-text-tertiary)">The following permission changes are needed on the FortiManager admin profile Polaris uses:</p>' +
      '<ul style="margin:0 0 0.75rem 1.2rem;padding:0;font-size:0.85rem">' +
        '<li><strong>Device Manager</strong> &rarr; Read-Write</li>' +
        '<li style="margin-left:1.2rem"><strong>Manage Device Configurations</strong> &rarr; Read-Write &nbsp;<span style="color:var(--color-text-tertiary)">&larr; the actual gate</span></li>' +
        '<li>All other Device Manager sub-items &mdash; leave at Read-Only or None</li>' +
        '<li><strong>Policy &amp; Objects</strong> &mdash; leave at Read-Only or None</li>' +
        '<li style="margin-left:1.2rem"><strong>Install Policy Package or Device Configuration</strong> &rarr; None &nbsp;<span style="color:var(--color-text-tertiary)">&larr; Polaris never triggers installs</span></li>' +
      '</ul>' +
      '<div style="background:var(--color-warning-bg, rgba(255,193,7,0.08));border:1px solid var(--color-warning, #ffc107);border-radius:4px;padding:0.6rem 0.8rem;margin-bottom:0.5rem">' +
        '<p style="margin:0 0 0.4rem 0;font-weight:500;color:var(--color-warning, #ffc107)">&#9888; Blast radius</p>' +
        '<p class="hint" style="margin:0">FortiManager admin profiles do not have a per-object permission for DHCP reservations. <strong>Manage Device Configurations</strong> grants write access to every CMDB tree on every FortiGate in this ADOM. A compromised Polaris API token could in principle modify other device-level config &mdash; interfaces, routing, other DHCP scopes &mdash; not just the reservations Polaris pushes. Treat the API token as a privileged credential and rotate on the same cadence as your other admin secrets.</p>' +
      '</div>' +
      '<div style="background:var(--color-info-bg, rgba(33,150,243,0.06));border:1px solid var(--color-info, #2196f3);border-radius:4px;padding:0.6rem 0.8rem">' +
        '<p style="margin:0 0 0.4rem 0;font-weight:500;color:var(--color-info, #2196f3)">&#128161; Tighter scope alternative</p>' +
        '<p class="hint" style="margin:0">For tighter scope, switch to direct mode (uncheck <em>Query each FortiGate directly (bypass FortiManager proxy)</em> on the Settings tab) and configure a per-FortiGate REST API admin with <strong>Network &rarr; Custom &rarr; Configuration</strong> set to Read/Write. This scopes write access to one FortiGate\'s network-configuration bucket instead of every CMDB tree on every device in the ADOM.</p>' +
      '</div>' +
    '</section>';
}

// Read the toggle's current value out of the Reservation Push tab. Returns
// undefined when the tab didn't render (non-FMG integration types) so the
// caller can leave the existing config alone.
function _readPushReservationsToggle() {
  var el = document.getElementById("f-pushReservations");
  if (!el) return undefined;
  return !!el.checked;
}

// SD-WAN tab body. Single master toggle (config.pullSdwan). When enabled, each
// system-info pass for FortiGates owned by this integration also pulls SD-WAN
// Performance SLA health-check metrics + service-rule member selection, which
// surface on the asset's SD-WAN tab. FortiOS-only; read-only on the device.
function sdwanFormHTML(pullSdwan) {
  var checked = pullSdwan === true ? "checked" : "";
  return '<section style="margin-bottom:1.5rem">' +
      '<h4 style="margin:0 0 0.25rem 0">SD-WAN Monitoring</h4>' +
      '<p class="hint" style="margin:0 0 0.75rem 0;color:var(--color-text-tertiary)">When enabled, Polaris pulls SD-WAN data from each FortiGate on its system-info polling cadence and shows it on the asset\'s <strong>SD-WAN</strong> tab. Read-only &mdash; nothing is written back to the device.</p>' +
      '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<input type="checkbox" id="f-pullSdwan" ' + checked + ' style="width:auto">' +
        '<label for="f-pullSdwan" style="margin:0">Pull SD-WAN Performance SLA + rule selection</label>' +
      '</div>' +
      '<ul class="hint" style="margin:0.25rem 0 0 1.2rem;padding:0">' +
        '<li><strong>Performance SLA health-checks.</strong> Per WAN-member latency, jitter and packet-loss from <code>/api/v2/monitor/virtual-wan/health-check</code>, charted over time.</li>' +
        '<li><strong>SD-WAN rules.</strong> Each service rule\'s configured members (priority order) and which member is currently selected, from <code>/api/v2/cmdb/system/sdwan</code>, with a selection-history timeline. The active member is inferred from health-check state when FortiOS doesn\'t expose it directly.</li>' +
      '</ul>' +
    '</section>' +
    '<hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--color-border)">' +
    '<section>' +
      '<h4 style="margin:0 0 0.25rem 0">Required Read Access</h4>' +
      '<p class="hint" style="margin:0;color:var(--color-text-tertiary)">The API token needs read access to <strong>System &rarr; SD-WAN</strong> (CMDB) and the SD-WAN monitor endpoints. No write access is required &mdash; this stream never modifies device configuration. FortiGates without SD-WAN configured simply report no data and the tab stays hidden.</p>' +
    '</section>';
}

// Read the SD-WAN toggle out of its tab. Returns undefined when the tab didn't
// render (non-FortiGate/FMG types) so the caller leaves the config alone.
function _readPullSdwanToggle() {
  var el = document.getElementById("f-pullSdwan");
  if (!el) return undefined;
  return !!el.checked;
}

// Quarantine Push tab body. Renders the master toggle plus transport-mode
// guidance. When enabled, quarantining an asset pushes MAC-based
// address-group entries to every FortiGate sighted by this integration.
// `pushQuarantine` is the current toggle value; `useProxy` drives the
// transport mode label.
function quarantinePushFormHTML(pushQuarantine, useProxy) {
  var checked = pushQuarantine === true ? "checked" : "";
  var modeLabel = (useProxy === false)
    ? "Direct to each FortiGate"
    : "Proxy through FortiManager to each FortiGate";
  var modeBody = (useProxy === false)
    ? "Quarantine entries are written to each FortiGate's REST API using the per-device API token configured on the Settings tab."
    : "Quarantine entries are written through FortiManager's <code>/sys/proxy/json</code> endpoint, which forwards the call to the target FortiGate using FortiManager's stored device credentials.";
  return '<section style="margin-bottom:1.5rem">' +
      '<h4 style="margin:0 0 0.25rem 0">Quarantine Push</h4>' +
      '<p class="hint" style="margin:0 0 0.75rem 0;color:var(--color-text-tertiary)">When enabled, quarantining an asset adds its MAC addresses to the FortiGate quarantine address-group on every device that has recently sighted the asset. Releasing quarantine removes the entries from the device.</p>' +
      '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
        '<input type="checkbox" id="f-pushQuarantine" ' + checked + ' style="width:auto">' +
        '<label for="f-pushQuarantine" style="margin:0">Push asset quarantine entries from Polaris back to FortiGate</label>' +
      '</div>' +
    '</section>' +
    '<hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--color-border)">' +
    '<section style="margin-bottom:1.5rem">' +
      '<h4 style="margin:0 0 0.25rem 0">Push Transport</h4>' +
      '<p class="hint" style="margin:0 0 0.25rem 0;color:var(--color-text-tertiary)">Current setting: <strong style="color:var(--color-text-primary)">' + escapeHtml(modeLabel) + '</strong></p>' +
      '<p class="hint" style="margin:0;color:var(--color-text-tertiary)">' + modeBody + '</p>' +
    '</section>' +
    '<hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--color-border)">' +
    '<section>' +
      '<h4 style="margin:0 0 0.25rem 0">Required FortiManager Admin Profile</h4>' +
      '<p class="hint" style="margin:0 0 0.75rem 0;color:var(--color-text-tertiary)">The following permission changes are needed on the FortiManager admin profile Polaris uses:</p>' +
      '<ul style="margin:0 0 0.75rem 1.2rem;padding:0;font-size:0.85rem">' +
        '<li><strong>Device Manager</strong> &rarr; Read-Write</li>' +
        '<li style="margin-left:1.2rem"><strong>Manage Device Configurations</strong> &rarr; Read-Write</li>' +
        '<li>All other Device Manager sub-items &mdash; leave at Read-Only or None</li>' +
      '</ul>' +
      '<div style="background:var(--color-warning-bg, rgba(255,193,7,0.08));border:1px solid var(--color-warning, #ffc107);border-radius:4px;padding:0.6rem 0.8rem">' +
        '<p style="margin:0 0 0.4rem 0;font-weight:500;color:var(--color-warning, #ffc107)">&#9888; Blast radius</p>' +
        '<p class="hint" style="margin:0">FortiManager admin profiles do not have a per-object permission for quarantine. <strong>Manage Device Configurations</strong> grants write access to every CMDB tree on every FortiGate in this ADOM. Treat the API token as a privileged credential and rotate on the same cadence as your other admin secrets.</p>' +
      '</div>' +
    '</section>';
}

// Read the quarantine push toggle. Returns undefined when the tab didn't render.
function _readPushQuarantineToggle() {
  var el = document.getElementById("f-pushQuarantine");
  if (!el) return undefined;
  return !!el.checked;
}

// Per-integration monitoring transport block rendered at the top of the
// FortiGates subtab on the Monitoring tab. Renders an SNMP credential picker
// plus four checkboxes that decide which streams (response-time, telemetry,
// interfaces, LLDP) ride SNMP vs the default FortiOS REST API. IPsec is always
// REST regardless — SNMP has no equivalent.
// SNMP / SSH credential pickers for the FortiGates subtab on FMG/FortiGate
// integration modals. Per-stream polling-method selection (REST API / SNMP /
// SSH / ICMP) lives in the Cadence & Retention section above; these pickers
// supply the credentials the SNMP- or SSH-keyed streams will use. A per-asset
// monitorCredential on the Asset's Monitoring tab takes priority.
//
// Both rows are rendered with `display:none` and revealed reactively by
// _syncCredentialPickerVisibility() based on which polling methods are
// currently selected on the four tier dropdowns.
function integrationMonitorOverrideHTML(credentials, selectedSnmpId, selectedSshId) {
  function row(type, label, selectId, selectedId) {
    var creds = (credentials || []).filter(function (c) { return c.type === type; });
    var options = '<option value="">— none —</option>' +
      creds.map(function (c) {
        var sel = (selectedId && c.id === selectedId) ? " selected" : "";
        return '<option value="' + escapeHtml(c.id) + '"' + sel + '>' + escapeHtml(c.name) + '</option>';
      }).join("");
    var emptyHint = creds.length === 0
      ? '<p class="hint" style="color:var(--color-warning)">No ' + escapeHtml(label) + ' credentials defined yet — add one under Server Settings &gt; Credentials.</p>'
      : '<p class="hint">Used by every stream above whose polling method is ' + escapeHtml(label) + '. A per-asset credential on the Asset Monitoring tab takes precedence when set.</p>';
    return '<div class="form-group" id="' + selectId + '-row" style="display:none">' +
        '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">' + escapeHtml(label) + ' credential</p>' +
        '<select id="' + selectId + '">' + options + '</select>' +
        emptyHint +
      '</div>';
  }
  return row("snmp", "SNMP", "f-mon-credential",     selectedSnmpId) +
         row("ssh",  "SSH",  "f-mon-credential-ssh", selectedSshId)  +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">';
}

// Build a per-class timer block. The id prefix lets the FortiGate /
// FortiSwitch / FortiAP subtabs each use their own DOM ids while sharing
// the same field set. `defaults` is the FortiGate (top-level) class so
// the FortiSwitch / FortiAP subtabs render the same defaults the operator
// would see if they hadn't customized anything yet.
// ─── Phase 1 monitoring redesign — class subtabs + per-stream subtabs ──────
//
// The new Monitoring tab is organised as:
//   Class subtabs (FortiGate / FortiSwitch / FortiAP for FMG+FortiGate,
//                  Workstations / Servers for AD+Entra+WinSrv)
//     └── Stream subtabs (Response Time / CPU+Memory / Temperature /
//                         Interfaces / LLDP / Storage — Storage absent on
//                         FortiAP)
//          └── Polling method + credential + interval + timeout
//                                + failure threshold (Response Time only)
//
// In Phase 1 every class subtab reads + writes the SAME shared
// `Integration.config.monitorSettings` JSON. The PRIMARY class subtab
// (FortiGate for FMG/FortiGate, Workstations for AD/Entra/WinSrv) uses the
// legacy `f-mon-tier-...` / `f-mon-...` DOM ids so the existing
// `_readIntegrationCadenceForm()` save path keeps working unchanged. Other
// class subtabs use namespaced ids (`f-mon-classecho-<klass>-...`) so the
// inputs render with real values but don't collide on save. The banner inside
// the secondary subtabs warns operators that those values currently mirror
// the primary subtab.
//
// Phase 2 lands the per-class data model + migration + Assets-page narrowing
// after the layout has been reviewed in the demo.

// Per-integration-type class subtab metadata. `primary` names the class whose
// subtab uses the canonical `f-mon-tier-` / `f-mon-` DOM ids — i.e. the one
// whose stream values are actually saved in Phase 1.
var _CLASS_SUBTAB_SPECS = {
  fortimanager: {
    primary: "fortigate",
    classes: [
      { key: "fortigate",   label: "FortiGate"    },
      { key: "fortiswitch", label: "FortiSwitch"  },
      { key: "fortiap",     label: "FortiAP"      },
    ],
  },
  fortigate: {
    primary: "fortigate",
    classes: [
      { key: "fortigate",   label: "FortiGate"    },
      { key: "fortiswitch", label: "FortiSwitch"  },
      { key: "fortiap",     label: "FortiAP"      },
    ],
  },
  activedirectory: {
    primary: "workstations",
    classes: [
      { key: "workstations", label: "Workstations" },
      { key: "servers",      label: "Servers"      },
    ],
  },
  entraid: {
    primary: "workstations",
    classes: [
      { key: "workstations", label: "Workstations" },
      { key: "servers",      label: "Servers"      },
    ],
  },
  windowsserver: {
    primary: "workstations",
    classes: [
      { key: "workstations", label: "Workstations" },
      { key: "servers",      label: "Servers"      },
    ],
  },
};

// Streams rendered inside each class subtab. Each entry names:
//   pollField   — legacy poll-method field on monitorSettings (driver of the
//                 polling dropdown id `f-mon-tier-<pollField>`)
//   mibStreamKey — key in _polarisReadMibFourStream's output (responseTime,
//                  telemetry, temperature, interfaces, lldp); MIB select id
//                  is `f-mon-tier-<mibStreamKey>Mib`
//   intervalField / timeoutField — field name on monitorSettings; legacy id
//                  is `f-mon-<intervalField>`, `f-mon-<timeoutField>`. NULL
//                  on lldp + storage — they share systemInfo cadence with
//                  interfaces and the cadence inputs render only on
//                  interfaces. The save reader (_readIntegrationCadenceForm)
//                  already reads systemInfoIntervalSeconds + Timeout once.
// FortiAP omits Storage — APs don't expose mountable storage.
// Phase 1 LLDP + Storage carry their own intervalField / timeoutField. The
// backend resolver doesn't consume these yet (LLDP + Storage continue to
// ride systemInfo cadence at runtime); Phase 2 wires the actual cadence
// dispatch and queue carve-out. Persisted today so the operator's choice
// survives the cutover.
var _ALL_STREAMS = [
  { key: "responseTime", label: "Response Time", pollField: "responseTimePolling", mibStreamKey: "responseTime", intervalField: "intervalSeconds",            timeoutField: "probeTimeoutMs",       hasFailure: true },
  { key: "cpuMemory",    label: "CPU/Memory",    pollField: "cpuMemoryPolling",    mibStreamKey: "telemetry",    intervalField: "cpuMemoryIntervalSeconds",   timeoutField: "cpuMemoryTimeoutMs"   },
  { key: "temperature",  label: "Temperature",   pollField: "temperaturePolling",  mibStreamKey: "temperature",  intervalField: "temperatureIntervalSeconds", timeoutField: "temperatureTimeoutMs" },
  { key: "interfaces",   label: "Interfaces",    pollField: "interfacesPolling",   mibStreamKey: "interfaces",   intervalField: "systemInfoIntervalSeconds",  timeoutField: "systemInfoTimeoutMs", sharesCadenceWith: null },
  { key: "lldp",         label: "LLDP",          pollField: "lldpPolling",         mibStreamKey: "lldp",         intervalField: "lldpIntervalSeconds",        timeoutField: "lldpTimeoutMs"        },
  { key: "storage",      label: "Storage",       pollField: "storagePolling",      mibStreamKey: null,           intervalField: "storageIntervalSeconds",     timeoutField: "storageTimeoutMs",    noMib: true },
];

// Phase 2 — pick the saved per-class `streams` block matching this class
// subtab, from the `opts` object passed into `_classSubtabBodyHTML`. The
// per-class blocks live on the integration's config at
// `<klass>Monitor.streams` (post-migration); when absent, this returns
// undefined and the overlay falls through to the flat baseline so a
// freshly-edited or unmigrated install still renders sensible values.
function _classStreamsBlockFor(klass, opts) {
  function streamsOf(block) { return block && typeof block === "object" ? block.streams : null; }
  if (klass === "fortigate")    return streamsOf(opts.fortigateMonitor);
  if (klass === "fortiswitch")  return streamsOf(opts.fortiswitchMonitor);
  if (klass === "fortiap")      return streamsOf(opts.fortiapMonitor);
  // _CLASS_SUBTAB_SPECS uses plural class keys for AD/Entra/WinSrv (matches
  // the human-facing tab labels). The backend Integration.config blocks
  // stay singular (workstationMonitor / serverMonitor) so the resolver
  // dispatches on Asset.assetType which is also singular.
  if (klass === "workstations" || klass === "workstation") return streamsOf(opts.workstationMonitor);
  if (klass === "servers"      || klass === "server")      return streamsOf(opts.serverMonitor);
  return null;
}

// Phase 2 — overlay a per-class streams block onto the flat baseline so a
// class subtab can show its own saved values. Maps stream cell keys to the
// legacy field names `_classStreamSubtabHTML` consumes from `settings`.
// Returns a shallow-merged copy; never mutates the inputs.
function _classSettingsOverlay(flatSettings, classStreams) {
  var out = Object.assign({}, flatSettings || {});
  if (!classStreams || typeof classStreams !== "object") return out;
  function pickStream(streamKey, fields) {
    var cell = classStreams[streamKey];
    if (!cell || typeof cell !== "object") return;
    if (Object.prototype.hasOwnProperty.call(cell, "polling")          && cell.polling          != null) out[fields.poll]     = cell.polling;
    if (Object.prototype.hasOwnProperty.call(cell, "intervalSeconds")  && cell.intervalSeconds  != null) out[fields.interval] = cell.intervalSeconds;
    if (Object.prototype.hasOwnProperty.call(cell, "timeoutMs")        && cell.timeoutMs        != null) out[fields.timeout]  = cell.timeoutMs;
    if (fields.mib && Object.prototype.hasOwnProperty.call(cell, "mibId")            && cell.mibId  != null) out[fields.mib]      = cell.mibId;
    if (fields.cred && Object.prototype.hasOwnProperty.call(cell, "credentialId")    && cell.credentialId != null) out[fields.cred] = cell.credentialId;
    if (fields.failure && Object.prototype.hasOwnProperty.call(cell, "failureThreshold") && cell.failureThreshold != null) out[fields.failure] = cell.failureThreshold;
  }
  pickStream("responseTime", { poll: "responseTimePolling", interval: "intervalSeconds",            timeout: "probeTimeoutMs",       mib: "responseTimeMibId", cred: "responseTimeCredentialId", failure: "failureThreshold" });
  pickStream("cpuMemory",    { poll: "cpuMemoryPolling",    interval: "cpuMemoryIntervalSeconds",   timeout: "cpuMemoryTimeoutMs",   mib: "cpuMemoryMibId",    cred: "cpuMemoryCredentialId" });
  pickStream("temperature",  { poll: "temperaturePolling",  interval: "temperatureIntervalSeconds", timeout: "temperatureTimeoutMs", mib: "temperatureMibId",  cred: "temperatureCredentialId" });
  pickStream("interfaces",   { poll: "interfacesPolling",   interval: "systemInfoIntervalSeconds",  timeout: "systemInfoTimeoutMs",  mib: "interfacesMibId",   cred: "interfacesCredentialId" });
  pickStream("lldp",         { poll: "lldpPolling",         interval: "lldpIntervalSeconds",        timeout: "lldpTimeoutMs",        mib: "lldpMibId",         cred: "lldpCredentialId" });
  // Storage shares the interfaces credential at the backend overlay layer,
  // so the pre-select uses interfacesCredentialId — matching the resolver.
  pickStream("storage",      { poll: "storagePolling",      interval: "storageIntervalSeconds",     timeout: "storageTimeoutMs",     cred: "interfacesCredentialId" });
  return out;
}

function _streamsForClass(klass) {
  if (klass === "fortiap") return _ALL_STREAMS.filter(function (s) { return s.key !== "storage"; });
  return _ALL_STREAMS;
}

// Renders the polling-method + credential + interval + timeout block for ONE
// (class, stream) pair. `idPrefix` namespaces the DOM ids. For the PRIMARY
// class subtab the prefix is empty-ish: polling dropdowns use the legacy
// `f-mon-tier-<pollField>` ids and numeric inputs use `f-mon-<numField>`
// ids so `_readIntegrationCadenceForm()` finds them unchanged. For
// SECONDARY class subtabs (echo of the primary in Phase 1) the prefix
// becomes `f-mon-classecho-<klass>-` and the same suffixes follow — those
// ids exist so the inputs render with the same starting values but never
// get read on save.
function _classStreamSubtabHTML(idPrefix, sourceKind, klass, stream, settings, credentials, isPrimary, opts) {
  settings = settings || {};
  credentials = credentials || [];
  opts = opts || {};
  // opts.showInherit (default true) — pass false at the bottom of the
  // resolver hierarchy (Manual Monitoring) so the polling-method dropdown
  // omits "Inherit". opts.showMib (default true) — pass false on surfaces
  // where the per-stream MIB picker isn't meaningful (also Manual Monitoring
  // in this iteration). opts.showStreamCredentials (default true) — pass
  // false on FortiSwitch + FortiAP class subtabs where the class-level
  // SNMP/SSH credential picker (rendered inside _classDirectPollHTML) is
  // the authoritative source; managed switches and APs use one credential
  // across every stream so the per-stream rows would just duplicate it.
  var showInherit = opts.showInherit !== false;
  var showMib     = opts.showMib     !== false;
  var showStreamCredentials = opts.showStreamCredentials !== false;
  var pollCurrent = settings[stream.pollField] || "";

  // Stream-key → settings field that holds this stream's saved credential
  // id, used both for pre-selecting the dropdown on render and by the read
  // path on save. Storage shares the interfaces credential (mirrors the
  // backend overlay's `storage: { credentialField: "interfacesCredentialId" }`).
  var streamCredField =
    stream.key === "responseTime" ? "responseTimeCredentialId" :
    stream.key === "cpuMemory"    ? "cpuMemoryCredentialId"    :
    stream.key === "temperature"  ? "temperatureCredentialId"  :
    stream.key === "interfaces"   ? "interfacesCredentialId"   :
    stream.key === "lldp"         ? "lldpCredentialId"         :
    stream.key === "storage"      ? "interfacesCredentialId"   :
    null;
  var savedStreamCredId = streamCredField ? (settings[streamCredField] || "") : "";

  // ID composition. The primary subtab uses the legacy naming so the existing
  // _polarisReadPollingFourStream / _polarisReadMibFourStream /
  // _readIntegrationCadenceForm readers find the values without changes.
  var pollId    = isPrimary ? ("f-mon-tier-" + stream.pollField)         : (idPrefix + "tier-" + stream.pollField);
  var mibId     = (stream.mibStreamKey && !stream.noMib)
    ? (isPrimary ? ("f-mon-tier-" + stream.mibStreamKey + "Mib")          : (idPrefix + "tier-" + stream.mibStreamKey + "Mib"))
    : null;
  var mibWrapId = (stream.mibStreamKey && !stream.noMib)
    ? (isPrimary ? ("f-mon-tier-" + stream.mibStreamKey + "-mib-wrap")    : (idPrefix + "tier-" + stream.mibStreamKey + "-mib-wrap"))
    : null;

  // Polling dropdown. Polling stream key fed into _polarisPollingDropdownHTML
  // mirrors the legacy mapping (cpuMemory → telemetry) so the source-default
  // label matches the resolver.
  var pollStreamKeyForDefaults = stream.key === "cpuMemory" ? "telemetry" : stream.key;
  var pollDropdown = _polarisPollingDropdownHTML(pollId, sourceKind, pollStreamKeyForDefaults, pollCurrent, {
    fmgDirectMode: opts.fmgDirectMode === true,
    showInherit:   showInherit,
  });

  // Credential picker. Visibility is reactive — we render the row always and
  // toggle display based on whether the chosen polling method needs creds.
  // Each stream cell carries a `credentialId` field on the backend at
  // config.<klass>Monitor.streams.<stream>.credentialId; we pre-select the
  // matching dropdown when the saved id matches the credential type that
  // pairs with the chosen polling method. When showStreamCredentials is
  // false (FortiSwitch + FortiAP class subtabs), the rows are omitted
  // entirely — the class-level credential picker is the authoritative
  // source there.
  var credRows = "";
  if (showStreamCredentials) {
    ["snmp", "ssh", "winrm"].forEach(function (credType) {
      var label = credType === "winrm" ? "WinRM" : credType.toUpperCase();
      var rows = credentials.filter(function (c) { return c.type === credType; });
      // Pre-select the saved credential only when it actually exists in this
      // credtype's list — guards against the saved value belonging to a
      // different credtype than the currently-chosen polling method (e.g.
      // operator flipped polling from SNMP to SSH; the stored SNMP id stays
      // in settings but the SSH dropdown stays at "Inherit").
      var selectedValue = "";
      if (savedStreamCredId && rows.some(function (c) { return c.id === savedStreamCredId; })) {
        selectedValue = savedStreamCredId;
      }
      var options = '<option value=""' + (selectedValue === "" ? " selected" : "") + '>— Inherit / none —</option>' +
        rows.map(function (c) {
          var sel = c.id === selectedValue ? " selected" : "";
          return '<option value="' + escapeHtml(c.id) + '"' + sel + '>' + escapeHtml(c.name) + '</option>';
        }).join("");
      credRows += '<div class="form-group" id="' + pollId + '-credrow-' + credType + '" style="display:none;margin-bottom:0.5rem">' +
          '<label style="margin:0 0 0.25rem 0;font-size:0.85rem">' + escapeHtml(label) + ' credential</label>' +
          '<select id="' + pollId + '-cred-' + credType + '">' + options + '</select>' +
          (rows.length === 0
            ? '<p class="hint" style="color:var(--color-warning);margin-top:0.25rem">No ' + escapeHtml(label) + ' credentials defined yet — add one under Server Settings &gt; Credentials.</p>'
            : '<p class="hint" style="margin-top:0.25rem">Used when this stream\'s polling method resolves to ' + escapeHtml(label) + '. A per-asset credential takes priority.</p>'
          ) +
        '</div>';
    });
  }

  // Per-stream cadence + timeout. Streams that share systemInfo cadence with
  // Interfaces (LLDP, Storage) skip the inputs and render a shares-cadence
  // hint instead — the underlying systemInfoIntervalSeconds / Timeout fields
  // are edited from the Interfaces subtab.
  function numInput(idSuffix, label, value, defaultValue, min, max, hint, warn500) {
    var fullId = isPrimary ? ("f-mon-" + idSuffix) : (idPrefix + idSuffix);
    var v = (value != null) ? value : defaultValue;
    var warnMarkup = warn500
      ? '<span id="' + fullId + '-warn" style="display:none;font-size:0.75rem;color:var(--color-warning);margin-left:0.5rem">⚠ Below 500 ms — probes will likely false-fail under healthy network conditions.</span>'
      : '';
    return '<div class="form-group"><label>' + escapeHtml(label) + warnMarkup + '</label>' +
      '<input type="number" id="' + fullId + '" value="' + escapeHtml(String(v == null ? "" : v)) + '" min="' + min + '" max="' + max + '" style="width:140px">' +
      (hint ? '<p class="hint">' + hint + '</p>' : '') +
    '</div>';
  }

  var cadenceHtml = "";
  if (stream.sharesCadenceWith) {
    cadenceHtml = '<p class="hint" style="margin:0.25rem 0 0.75rem 0;padding:0.5rem 0.65rem;background:var(--color-bg-tertiary);border-radius:var(--radius-sm);color:var(--color-text-secondary)">' +
      "Cadence + timeout for this stream are shared with the <strong>" + escapeHtml(stream.sharesCadenceWith) + "</strong> subtab. " +
      "An independent " + escapeHtml(stream.key) + " queue + interval ships in the next release." +
    '</p>';
  } else {
    var intervalDefault, intervalMin, intervalMax, timeoutDefault;
    if (stream.key === "responseTime") {
      intervalDefault = 60; intervalMin = 5; intervalMax = 86400; timeoutDefault = 5000;
    } else if (stream.key === "cpuMemory" || stream.key === "temperature") {
      intervalDefault = 60; intervalMin = 15; intervalMax = 86400; timeoutDefault = 10000;
    } else {
      intervalDefault = 600; intervalMin = 60; intervalMax = 86400; timeoutDefault = 10000;
    }
    var intervalHint = "How often this stream collects from each monitored " + escapeHtml(klass) + ".";
    var timeoutHint = "Per-request timeout.";
    cadenceHtml = numInput(stream.intervalField, "Interval (seconds)", settings[stream.intervalField], intervalDefault, intervalMin, intervalMax, intervalHint, false) +
      numInput(stream.timeoutField, "Timeout (ms)", settings[stream.timeoutField], timeoutDefault, 100, 120000, timeoutHint, stream.key === "responseTime");
  }

  // Failure threshold lives only on the Response Time subtab.
  var failureHtml = "";
  if (stream.hasFailure) {
    failureHtml = numInput("failureThreshold", "Failure threshold (consecutive misses)", settings.failureThreshold, 3, 1, 100, "Consecutive failed probes before the asset is marked Down — and successes needed to recover back to Up.", false);
  }

  // Optional per-stream MIB picker (only shown when SNMP is the chosen
  // polling method). The select id matches what _polarisReadMibFourStream
  // already reads (`f-mon-tier-<streamKey>Mib`).
  var mibHtml = "";
  if (mibId && mibWrapId && showMib) {
    var autoName = (_autoMibNamesForSource(sourceKind) || {})[pollStreamKeyForDefaults] || "";
    var mibCurrent = settings[stream.mibStreamKey + "MibId"] || "";
    mibHtml = '<div class="form-group" id="' + mibWrapId + '" style="display:none">' +
        '<label>MIB</label>' +
        '<select id="' + mibId + '" data-current-id="' + escapeHtml(mibCurrent) + '" data-auto-mib-name="' + escapeHtml(autoName) + '" data-mib-picker="1">' +
          _mibOptionsHTML(mibCurrent, autoName) +
        '</select>' +
        "<p class=\"hint\">Defaults to Automatic — Polaris picks the right MIB from the asset's Manufacturer Profile (Server Settings → Credentials → Manufacturer Profiles). Pin a specific module here only when a particular device needs to override its profile.</p>" +
      '</div>';
  }

  return '<div class="form-group"><label>Polling method</label>' + pollDropdown +
      '<p class="hint">Select the protocol Polaris uses for this stream. "Inherit" falls through to the source default.</p>' +
    '</div>' +
    credRows +
    cadenceHtml +
    failureHtml +
    mibHtml;
}

// Renders the inside of one class subtab (e.g. FortiSwitch) — the optional
// "direct polling" / "discovery defaults" header content first, then the
// stream subtabs. The primary class subtab uses the legacy DOM ids so the
// existing save reader keeps working; secondary subtabs use namespaced ids
// for parallel render-only inputs and surface a banner explaining that
// their values currently mirror the primary subtab.
function _classSubtabBodyHTML(opts) {
  var integrationType = opts.integrationType;
  var klass           = opts.klass;
  var isPrimary       = opts.isPrimary;
  var primaryLabel    = opts.primaryLabel;
  var settings        = opts.settings || {};
  var credentials     = opts.credentials || [];
  var headerHtml      = opts.headerHtml || "";

  // Phase 2: overlay the per-class streams block onto the flat settings
  // baseline so this class subtab shows its own saved per-stream values
  // instead of mirroring the FortiGate / Workstation primary subtab. The
  // per-class block lives at opts.<klass>MonitorConfig.streams.<stream>.
  // Each stream's cells become the same keys the legacy `settings`
  // object carried: `<pollField>` / `<intervalField>` / `<timeoutField>` /
  // `<mibStreamKey>MibId` / `failureThreshold`. Empty fields fall back to
  // the flat baseline so legacy integrations that haven't been migrated
  // yet still render their familiar starting values.
  var perClassSettings = _classSettingsOverlay(settings, opts.classStreams);

  // Phase 1: every non-primary class subtab is an echo of the primary today
  // (the save reader only consumes the primary subtab's namespaced ids). The
  // banner that used to call this out has been removed at the user's request —
  // operators know it's echo-only and don't need the inline reminder.
  var banner = "";

  // Secondary class subtabs get a fully-namespaced id prefix so their inputs
  // don't collide with the primary subtab's legacy ids.
  var echoPrefix = "f-mon-classecho-" + klass + "-";

  // Nested tab strip key per class so two class subtabs in the same modal
  // don't share active stream-tab state.
  var streamTabsPrefix = isPrimary
    ? "intg-mon-streams-primary"
    : "intg-mon-streams-" + klass;

  // fmgDirectMode is the live state of the f-useDirect toggle for fortimanager
  // integrations (true when checked / useProxy=false); for fortigate integrations
  // it's implicitly always direct. Drives the "Inherit (Source FortiGate Direct
  // / FortiManager Proxy: …)" label rendered by _polarisPollingDropdownHTML.
  var initialFmgDirectMode = integrationType === "fortimanager"
    ? ((opts.fmgDefaults || {}).useProxy === false)
    : (integrationType === "fortigate");
  var streams = _streamsForClass(klass);
  var streamTabs = streams.map(function (stream) {
    return {
      key: stream.key,
      label: stream.label,
      html: _classStreamSubtabHTML(echoPrefix, integrationType, klass, stream, perClassSettings, credentials, isPrimary, {
        fmgDirectMode: initialFmgDirectMode,
        showStreamCredentials: opts.showStreamCredentials !== false,
      }),
    };
  });

  // Stream subtabs are gated by the class's Direct Polling toggle on
  // integrations that have one (FMG-FortiGate, FortiSwitch, FortiAP).
  // `_wireMonitoringTabSubtabs` wires the toggles' change events to show/hide
  // this wrapper at runtime. Classes without a toggle (standalone FortiGate's
  // FortiGate subtab, AD / Entra / WinSrv) render the wrapper always-visible.
  var streamsWrapId = "intg-mon-streams-wrap-" + (isPrimary ? "primary-" : "") + klass;
  var directToggleId = _directPollingToggleIdFor(integrationType, klass);
  var initialDirectOn = _directPollingInitialStateFor(integrationType, klass, opts);
  var wrapperHidden = (directToggleId && !initialDirectOn) ? "display:none" : "";

  return banner +
    headerHtml +
    '<div id="' + streamsWrapId + '" data-direct-toggle="' + escapeHtml(directToggleId || "") + '" style="' + wrapperHidden + '">' +
      _intRenderTabbedBody(streamTabsPrefix, streamTabs) +
    '</div>';
}

// Returns the DOM id of the Direct Polling checkbox that gates this class's
// stream subtabs, or null when the class has no such toggle (standalone
// FortiGate's FortiGate subtab, AD / Entra / WindowsServer). The class subtab
// renderer reads this to decide whether to wrap stream subtabs in a hidden
// container; `_wireMonitoringTabSubtabs` reads it to wire the toggle's
// `change` event so flipping it reveals/hides the wrapper.
function _directPollingToggleIdFor(integrationType, klass) {
  if (klass === "fortigate"   && integrationType === "fortimanager") return "f-useDirect";
  if (klass === "fortiswitch" && (integrationType === "fortimanager" || integrationType === "fortigate")) return "f-mon-fortiswitch-enabled";
  if (klass === "fortiap"     && (integrationType === "fortimanager" || integrationType === "fortigate")) return "f-mon-fortiap-enabled";
  return null;
}

// Returns the initial on/off state for the Direct Polling toggle that gates
// this class's stream subtabs. Mirrors the same values the toggle's own
// `checked` attribute is rendered with so the stream wrapper opens in the
// matching state without a JS round-trip.
function _directPollingInitialStateFor(integrationType, klass, opts) {
  if (klass === "fortigate" && integrationType === "fortimanager") {
    return (opts.fmgDefaults || {}).useProxy === false;
  }
  if (klass === "fortiswitch" && (integrationType === "fortimanager" || integrationType === "fortigate")) {
    return (opts.fortiswitchMonitor || {}).enabled === true;
  }
  if (klass === "fortiap" && (integrationType === "fortimanager" || integrationType === "fortigate")) {
    return (opts.fortiapMonitor || {}).enabled === true;
  }
  return true;
}

// "Enable / Disable Auto-Monitoring" button + hint. Replaces the prior
// checkbox to add visual weight to the destructive transition (red
// "Disable" framing). The id `<prefix>addAsMonitored` continues to be
// the source of truth read by the save path; we now stash its boolean
// state on a hidden input of the same id (so the existing _getCheckbox
// reader keeps working) and the visible Button toggles the hidden input
// while updating its own label/color reactively.
//
// The Save Changes path runs a preflight against the proposed addAsMonitored
// values and shows a confirm modal when wouldDisable > 0 on any class —
// see `_promptAutoMonitorAssetsConfirm` below.
function _classAddAsMonitoredHTML(idPrefix, kindLabel, currentAddAsMonitored) {
  var enabled = currentAddAsMonitored === true;
  var btnClass = enabled ? "btn-danger" : "btn-primary";
  var btnLabel = enabled ? "Disable Auto-Monitoring" : "Enable Auto-Monitoring";
  return '<div style="background:rgba(79,195,247,0.06);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<div class="form-group" style="display:flex;align-items:center;gap:12px;margin-bottom:0.4rem">' +
        // Hidden input preserves the existing save-path read pattern (_getCheckbox).
        '<input type="checkbox" id="' + idPrefix + 'addAsMonitored" ' + (enabled ? "checked" : "") + ' style="display:none">' +
        '<button type="button" class="btn ' + btnClass + '" data-auto-monitor-toggle="' + idPrefix + 'addAsMonitored" style="min-width:200px">' + btnLabel + '</button>' +
        '<div style="font-weight:500">Auto-Monitor ' + escapeHtml(kindLabel) + 's</div>' +
      '</div>' +
      '<p class="hint" style="margin:0">When enabled, every discovered ' + escapeHtml(kindLabel) + ' is monitored. Disabling sweeps existing ' + escapeHtml(kindLabel) + 's off monitoring on the next discovery cycle unless an operator has set a per-asset override. You\'ll be asked to confirm at Save Changes.</p>' +
    '</div>';
}

// Picker block for the FortiSwitch / FortiAP subtab — "enable direct polling"
// checkbox + per-credential-type dropdowns (SNMP / SSH). The addAsMonitored
// checkbox used to live here too but was hoisted into
// `_classAddAsMonitoredHTML` so the FortiSwitch / FortiAP subtabs can render
// addAsMonitored at the top of the body. id prefix collides if you
// instantiate twice on the same page; we use distinct prefixes per class.
// The SNMP and SSH rows render hidden and are revealed reactively by
// _syncCredentialPickerVisibility() once the integration-tier polling
// dropdowns pick the matching method.
function _classDirectPollHTML(idPrefix, kindLabel, credentials, currentEnabled, currentSnmpCredId, currentSshCredId) {
  function credRow(type, label, selectId, selectedId) {
    var rows = (credentials || []).filter(function (c) { return c.type === type; });
    var options = '<option value="">— select credential —</option>' +
      rows.map(function (c) {
        var sel = (selectedId && c.id === selectedId) ? " selected" : "";
        return '<option value="' + escapeHtml(c.id) + '"' + sel + '>' + escapeHtml(c.name) + '</option>';
      }).join("");
    var emptyHint = rows.length === 0
      ? '<p class="hint" style="color:var(--color-warning)">No ' + escapeHtml(label) + ' credentials defined yet — add one under Server Settings &gt; Credentials, or leave direct polling off and Polaris will fall back to ICMP when "Add as Monitored" is checked above.</p>'
      : '<p class="hint">Discovery stamps each newly-found ' + escapeHtml(kindLabel) + ' with this credential when ' + escapeHtml(label) + ' is the resolved polling method. Operator overrides on existing assets are preserved.</p>';
    return '<div class="form-group" id="' + selectId + '-row" style="margin-bottom:0.6rem;display:none">' +
        '<label>' + escapeHtml(label) + ' credential</label>' +
        '<select id="' + selectId + '">' + options + '</select>' +
        emptyHint +
      '</div>';
  }
  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Direct polling</p>' +
    '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5;margin:0 0 0.6rem 0">Managed ' + escapeHtml(kindLabel) + 's in FortiLink mode usually keep their own management plane locked down. Polaris can\'t reach them through the controller FortiGate, so direct polling only works when the matching protocol has been explicitly enabled on the ' + escapeHtml(kindLabel) + ' itself.</p>' +
      '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.6rem">' +
        '<input type="checkbox" id="' + idPrefix + 'enabled" ' + (currentEnabled ? "checked" : "") + ' style="width:auto">' +
        '<label for="' + idPrefix + 'enabled" style="margin:0;font-weight:500">Enable direct polling of managed ' + escapeHtml(kindLabel) + 's</label>' +
      '</div>' +
      credRow("snmp", "SNMP", idPrefix + "credentialId",    currentSnmpCredId) +
      credRow("ssh",  "SSH",  idPrefix + "sshCredentialId", currentSshCredId)  +
    '</div>';
}

// ─── Auto-Monitor Interfaces card ──────────────────────────────────────────
// Three selection modes; defaults differ per class (FortiGates → names,
// FortiSwitches → wildcard, FortiAPs → type). On the Create modal we don't
// have an integrationId yet, so the live preview + aggregate list are
// suppressed (operator still picks a mode and sets values; the first preview
// happens after Save + first discovery).

// Rough threshold above which Save warns about pin volume. Per-asset isn't
// the issue — the worst case is "type=physical, onlyUp=false" on a fleet of
// 48-port FortiSwitches, which can pin thousands of interfaces all polled
// every ~60s. Tune after observing real DBs.
var AUTO_MONITOR_INTERFACE_WARN_THRESHOLD = 500;

// Frontend mirror of services/autoMonitorInterfacesService.ts:coerceLegacySelection.
// Used when rendering a saved config that hasn't been swept by the one-shot
// migration job yet — keeps the card in sync with whatever shape is in the DB.
function _amonCoerceLegacy(sel) {
  if (!sel || typeof sel !== "object") return null;
  if ("byNames" in sel || "byPatterns" in sel || "byTypes" in sel || "byLldp" in sel) return sel;
  if (sel.mode === "names"    && Array.isArray(sel.names))    return { byNames:    { names: sel.names.slice() } };
  if (sel.mode === "wildcard" && Array.isArray(sel.patterns)) return { byPatterns: { patterns: sel.patterns.slice(), regex: false, onlyUp: sel.onlyUp === true } };
  if (sel.mode === "type"     && Array.isArray(sel.types))    return { byTypes:    { types: sel.types.slice(), onlyUp: sel.onlyUp !== false } };
  return null;
}

// Canonical-stringify an autoMonitorInterfaces selection for change detection.
// Sorts string arrays so reordering inside a list doesn't read as a change,
// normalizes booleans, and collapses null / {} / coerced-legacy shapes to the
// same string ("null"). Used by the save handler to skip the per-class apply
// pass when nothing about that block's selection actually changed — saving
// for an unrelated reason (API token rotation, name change, monitoring tier
// edit) shouldn't re-fire an apply that can be expensive on big fleets.
function _amonCanonicalize(sel) {
  var coerced = _amonCoerceLegacy(sel);
  if (!coerced) return "null";
  var out = {};
  if (coerced.byNames && Array.isArray(coerced.byNames.names)) {
    out.byNames = { names: coerced.byNames.names.slice().sort() };
  }
  if (coerced.byPatterns && Array.isArray(coerced.byPatterns.patterns)) {
    out.byPatterns = {
      patterns: coerced.byPatterns.patterns.slice().sort(),
      regex:    coerced.byPatterns.regex === true,
      onlyUp:   coerced.byPatterns.onlyUp === true,
    };
  }
  if (coerced.byTypes && Array.isArray(coerced.byTypes.types)) {
    out.byTypes = {
      types:  coerced.byTypes.types.slice().sort(),
      onlyUp: coerced.byTypes.onlyUp === true,
      includeDownTunnels: coerced.byTypes.includeDownTunnels === true,
    };
  }
  if (coerced.byLldp && Array.isArray(coerced.byLldp.neighborTypes)) {
    out.byLldp = { neighborTypes: coerced.byLldp.neighborTypes.slice().sort() };
  }
  if (Object.keys(out).length === 0) return "null";
  return JSON.stringify(out);
}

// Renders one "By interface type" row. For the tunnel row it appends an
// inline "Include down tunnels" control (id `<prefix>types-includeDown`,
// wrapped in `<prefix>types-includeDown-wrap` for show/hide) to the right of
// the type label — visible only when tunnel is checked, since a down IPsec
// tunnel is something operators commonly want to monitor even with "Only
// currently up" on. Shared by the initial saved render and the post-aggregate
// re-render so the two never diverge.
function _amonTypeRowHTML(idPrefix, name, checked, inclDownChecked, inclDownVisible) {
  var label = '<label style="display:flex;align-items:center;gap:6px;font-size:0.88rem;margin-bottom:0.25rem">' +
                '<input type="checkbox" data-type-checkbox="1" id="' + idPrefix + 'type-' + name + '" value="' + name + '"' + (checked ? " checked" : "") + ' style="width:auto"> ' + name +
              '</label>';
  if (name !== "tunnel") return label;
  var incl = '<span id="' + idPrefix + 'types-includeDown-wrap" style="display:' + (inclDownVisible ? "inline-flex" : "none") + ';align-items:center;margin-bottom:0.25rem">' +
               '<label style="display:flex;align-items:center;gap:6px;font-size:0.84rem;margin:0;cursor:pointer">' +
                 '<input type="checkbox" id="' + idPrefix + 'types-includeDown"' + (inclDownChecked ? " checked" : "") + ' style="width:auto"> Include down tunnels' +
                 ' <span class="hint" style="margin:0;font-size:0.78rem">(otherwise excluded by &quot;Only currently up&quot;)</span>' +
               '</label>' +
             '</span>';
  return '<div style="display:flex;align-items:center;gap:14px">' + label + incl + '</div>';
}

function _autoMonitorInterfacesHTML(idPrefix, kindLabel, currentSelection, _defaultMode, hasIntegrationId) {
  var sel = _amonCoerceLegacy(currentSelection) || {};
  var byNames    = sel.byNames    || null;
  var byPatterns = sel.byPatterns || null;
  var byTypes    = sel.byTypes    || null;
  var byLldp     = sel.byLldp     || null;

  // Stash the saved selection so the wire function can seed lastSentSelection
  // with it. The diff in the live preview compares each in-flight selection
  // against the PREVIOUS one sent — initial baseline = saved, so the first
  // render shows no diff and subsequent toggles show per-click adds/removes.
  // Stored under a per-card key so multiple cards in the same modal (the
  // FortiGate / FortiSwitch / FortiAP subtabs) don't clobber each other.
  window["__autoMon_savedSelection_" + idPrefix] = (Object.keys(sel).length > 0) ? sel : null;

  // Each "block" gets a master checkbox that controls visibility + inclusion.
  // Independent — operators can mix-and-match modes; the union is what gets
  // pinned. No "Disabled" toggle anymore: all four off = nothing pinned.
  function masterBox(value, label, hint, checked) {
    return '<label style="display:flex;align-items:center;gap:6px;margin-bottom:0.35rem;font-weight:500;cursor:pointer">' +
             '<input type="checkbox" data-amon-master="1" name="' + idPrefix + 'enable" value="' + value + '"' + (checked ? " checked" : "") + ' style="width:auto"> ' + escapeHtml(label) +
             (hint ? ' <span style="color:var(--color-text-tertiary);font-weight:400;font-size:0.82rem">— ' + escapeHtml(hint) + '</span>' : '') +
           '</label>';
  }

  // ─── By name panel ────────────────────────────────────────────────────────
  var namesPanel = '<div id="' + idPrefix + 'panel-names" style="display:' + (byNames ? '' : 'none') + ';margin:0.35rem 0 0.6rem 1.5rem">' +
    (hasIntegrationId
      ? '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
          '<button type="button" class="btn btn-secondary" id="' + idPrefix + 'reload" style="font-size:0.78rem;padding:4px 10px">Refresh from latest discovery</button>' +
          '<span class="hint" id="' + idPrefix + 'names-counter" style="margin:0">Selected: 0</span>' +
        '</div>' +
        '<div id="' + idPrefix + 'names-list" style="max-height:280px;overflow:auto;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:0.5rem;background:var(--color-bg-tertiary)">' +
          '<p class="hint" style="margin:0">Loading…</p>' +
        '</div>' +
        '<p class="hint" style="margin:0.35rem 0 0 0;font-size:0.78rem">Aggregated from interfaces already seen on this integration\'s ' + escapeHtml(kindLabel) + 's. Examples: <code>wan1</code>, <code>port1</code>, <code>FortiLink</code>.</p>'
      : '<p class="hint" style="margin:0;color:var(--color-warning)">Save the integration and run discovery first — interface names are aggregated from already-discovered devices.</p>'
    ) +
  '</div>';

  // ─── By pattern panel ─────────────────────────────────────────────────────
  var patternText = byPatterns ? byPatterns.patterns.join("\n") : "";
  var patternIsRegex = !!(byPatterns && byPatterns.regex === true);
  var patternOnlyUp  = !!(byPatterns && byPatterns.onlyUp === true);
  var patternsExample = patternIsRegex ? '^wan\\d+$&#10;^port(1|2)$' : 'wan*&#10;port4?';
  var patternsPanel = '<div id="' + idPrefix + 'panel-patterns" style="display:' + (byPatterns ? '' : 'none') + ';margin:0.35rem 0 0.6rem 1.5rem">' +
    '<div style="display:flex;align-items:center;gap:1.25rem;margin-bottom:0.4rem;font-size:0.86rem">' +
      '<label style="display:flex;align-items:center;gap:6px;margin:0;cursor:pointer">' +
        '<input type="radio" name="' + idPrefix + 'patterns-mode" value="wildcard"' + (patternIsRegex ? "" : " checked") + ' style="width:auto"> Wildcard' +
        ' <span class="hint" style="margin:0;font-size:0.78rem">(<code>*</code> any, <code>?</code> one)</span>' +
      '</label>' +
      '<label style="display:flex;align-items:center;gap:6px;margin:0;cursor:pointer">' +
        '<input type="radio" name="' + idPrefix + 'patterns-mode" value="regex"' + (patternIsRegex ? " checked" : "") + ' style="width:auto"> Regex' +
        ' <span class="hint" style="margin:0;font-size:0.78rem">(anchor with <code>^</code> / <code>$</code> if needed)</span>' +
      '</label>' +
    '</div>' +
    '<div class="form-group" style="margin-bottom:0.4rem">' +
      '<textarea id="' + idPrefix + 'patterns" rows="4" style="font-family:monospace;font-size:0.85rem;width:100%" placeholder="' + patternsExample + '">' + escapeHtml(patternText) + '</textarea>' +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:0.86rem;margin:0">' +
        '<input type="checkbox" id="' + idPrefix + 'patterns-onlyUp"' + (patternOnlyUp ? " checked" : "") + ' style="width:auto"> Only currently up' +
        ' <span class="hint" style="margin:0;font-size:0.78rem">(skips disabled / disconnected ports)</span>' +
      '</label>' +
      '<button type="button" class="btn btn-secondary" id="' + idPrefix + 'patterns-test" style="font-size:0.78rem;padding:4px 12px"' +
        (hasIntegrationId ? '' : ' disabled title="Save the integration first"') + '>Test against fleet</button>' +
    '</div>' +
    '<div id="' + idPrefix + 'patterns-test-result" class="hint" style="margin:0.5rem 0 0 0;font-size:0.82rem;display:none;padding:0.45rem 0.6rem;background:var(--color-bg-tertiary);border-radius:var(--radius-sm);border:1px solid var(--color-border)"></div>' +
  '</div>';

  // ─── By interface type panel ──────────────────────────────────────────────
  // The list of types rendered here is sourced from the integration's
  // interface-aggregate endpoint at lazy-load time (shared with the By-name
  // load) so operators only see ifType values that actually exist on this
  // integration's discovered devices. Saved-selection types not present in
  // the latest discovery are preserved so a stored value isn't silently
  // dropped. The initial render shows only the saved-selection types (or a
  // loading placeholder when there's nothing saved yet) — the data load
  // replaces this with the observed set.
  var typeOnlyUp = byTypes ? byTypes.onlyUp !== false : true;
  var savedTypes = byTypes ? byTypes.types.slice() : [];
  var savedInclDown = !!(byTypes && byTypes.includeDownTunnels === true);
  // Stash for the loader so it can preserve saved-but-not-yet-rendered types
  // even before the user has opened this panel.
  window["__autoMon_typeSeed_" + idPrefix] = savedTypes;
  window["__autoMon_inclDownSeed_" + idPrefix] = savedInclDown;
  function _initialTypeBox(name) {
    // Initial render checks every saved type, so the tunnel row (if saved) is
    // checked → its include-down control is visible.
    return _amonTypeRowHTML(idPrefix, name, true, savedInclDown, true);
  }
  var initialTypesHtml = savedTypes.length > 0
    ? savedTypes.map(_initialTypeBox).join("")
    : (hasIntegrationId
        ? '<p class="hint" style="margin:0">Loading interface types…</p>'
        : '<p class="hint" style="margin:0;color:var(--color-warning)">Save the integration and run discovery first — interface types are aggregated from already-discovered devices.</p>');
  var typesPanel = '<div id="' + idPrefix + 'panel-types" style="display:' + (byTypes ? '' : 'none') + ';margin:0.35rem 0 0.6rem 1.5rem">' +
    '<div id="' + idPrefix + 'types-options">' + initialTypesHtml + '</div>' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:0.86rem;margin-top:0.5rem">' +
      '<input type="checkbox" id="' + idPrefix + 'types-onlyUp"' + (typeOnlyUp ? " checked" : "") + ' style="width:auto"> Only currently up' +
      ' <span class="hint" style="margin:0;font-size:0.78rem">(skips disabled / disconnected ports)</span>' +
    '</label>' +
    '<p class="hint" style="margin:0.35rem 0 0 0;font-size:0.78rem">Only interface types observed on this integration\'s ' + escapeHtml(kindLabel) + 's are listed.</p>' +
  '</div>';

  // ─── By LLDP neighbor panel ───────────────────────────────────────────────
  var lldpSet = byLldp ? new Set(byLldp.neighborTypes) : new Set();
  function lldpBox(value, label) {
    var on = lldpSet.has(value) ? " checked" : "";
    return '<label style="display:flex;align-items:center;gap:6px;font-size:0.88rem;margin-bottom:0.25rem">' +
             '<input type="checkbox" data-lldp-checkbox="1" id="' + idPrefix + 'lldp-' + value + '" value="' + value + '"' + on + ' style="width:auto"> ' + escapeHtml(label) +
           '</label>';
  }
  var lldpPanel = '<div id="' + idPrefix + 'panel-lldp" style="display:' + (byLldp ? '' : 'none') + ';margin:0.35rem 0 0.6rem 1.5rem">' +
    '<p class="hint" style="margin:0 0 0.4rem 0;font-size:0.82rem">Pin where Polaris knows a <strong>monitored</strong> neighbor of the chosen type is connected — via direct LLDP advertisement <strong>OR</strong> via FortiOS topology inference (managed FortiAPs reported through their parent FortiGate, FortiSwitch FortiLink uplinks, etc.). Updates as fleet topology changes — new uplinks get pinned automatically next discovery.</p>' +
    lldpBox("firewall",     "Firewall") +
    lldpBox("switch",       "Switch") +
    lldpBox("access_point", "Access Point") +
    lldpBox("server",       "Server") +
    lldpBox("workstation",  "Workstation") +
    lldpBox("other",        "Other") +
  '</div>';

  // ─── Live preview (unioned across enabled blocks) ─────────────────────────
  var previewPanel = '<div id="' + idPrefix + 'preview" class="form-group" style="margin-top:0.8rem;padding:0.5rem 0.7rem;background:var(--color-bg-tertiary);border-radius:var(--radius-sm);border:1px solid var(--color-border);font-size:0.84rem;color:var(--color-text-secondary);min-height:1.4em">' +
    (hasIntegrationId ? '<em>Enable a block to preview matches.</em>' : '<em>Preview becomes available after the integration is saved and discovery has run at least once.</em>') +
  '</div>';

  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Auto-monitor interfaces</p>' +
    '<div style="background:rgba(79,195,247,0.06);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5;margin:0 0 0.2rem 0">Pin interfaces on every ' + escapeHtml(kindLabel) + ' discovered by this integration. Selected interfaces are added to each device\'s "Poll 1m" list and scraped on the response-time cadence (~60s). Operator-pinned interfaces on individual assets are preserved.</p>' +
      '<p class="hint" style="margin:0 0 0.6rem 0;font-size:0.78rem">Strictly additive — removing a selection here does <strong>not</strong> unpin interfaces already pinned on existing assets.</p>' +
      masterBox("names",    "By name",            "explicit ifNames from this integration's devices", !!byNames) +
      namesPanel +
      masterBox("patterns", "By pattern",         "wildcard or regex match",                          !!byPatterns) +
      patternsPanel +
      masterBox("types",    "By interface type",  "types seen on this integration's devices",         !!byTypes) +
      typesPanel +
      masterBox("lldp",     "By LLDP (includes inferred interfaces)",   "pin where a monitored neighbor is connected (LLDP or FortiOS topology inference)",  !!byLldp) +
      lldpPanel +
      previewPanel +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">';
}

// Reads the auto-monitor card into a server-shaped AutoMonitorSelection or
// null. Returns undefined when the card didn't render (subtab never opened).
// Multi-block: each master checkbox gates its own block; the result is the
// union. An enabled block with no inner values populated (e.g. patterns
// master ticked but textarea empty) is dropped — server-side schema would
// reject it anyway.
function _readAutoMonitorInterfaces(idPrefix) {
  var masters = document.getElementsByName(idPrefix + "enable");
  if (!masters || masters.length === 0) return undefined;

  var enabled = { names: false, patterns: false, types: false, lldp: false };
  for (var m = 0; m < masters.length; m++) {
    if (masters[m].checked) enabled[masters[m].value] = true;
  }

  var out = {};

  if (enabled.names) {
    var checks = document.querySelectorAll('input[data-name-checkbox="1"][data-prefix="' + idPrefix + '"]:checked');
    var names = [];
    for (var j = 0; j < checks.length; j++) names.push(checks[j].value);
    if (names.length > 0) out.byNames = { names: names };
  }

  if (enabled.patterns) {
    var ta = document.getElementById(idPrefix + "patterns");
    var raw = ta ? String(ta.value || "") : "";
    var patterns = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (patterns.length > 0) {
      var modeRadios = document.getElementsByName(idPrefix + "patterns-mode");
      var isRegex = false;
      for (var r = 0; r < modeRadios.length; r++) { if (modeRadios[r].checked && modeRadios[r].value === "regex") { isRegex = true; break; } }
      var ouEl = document.getElementById(idPrefix + "patterns-onlyUp");
      out.byPatterns = {
        patterns: patterns,
        regex:    isRegex,
        onlyUp:   ouEl ? ouEl.checked === true : false,
      };
    }
  }

  if (enabled.types) {
    var typeChecks = document.querySelectorAll('input[data-type-checkbox="1"][id^="' + idPrefix + 'type-"]:checked');
    var types = [];
    for (var k = 0; k < typeChecks.length; k++) {
      var v = typeChecks[k].value;
      if (v === "physical" || v === "aggregate" || v === "vlan" || v === "loopback" || v === "tunnel") types.push(v);
    }
    if (types.length > 0) {
      var ou2El = document.getElementById(idPrefix + "types-onlyUp");
      out.byTypes = { types: types, onlyUp: ou2El ? ou2El.checked === true : true };
      // Tunnel-only: pin fully-down IPsec tunnels too. Only meaningful when
      // "tunnel" is selected; omit the flag otherwise so it stays default-off.
      if (types.indexOf("tunnel") !== -1) {
        var inclEl = document.getElementById(idPrefix + "types-includeDown");
        if (inclEl && inclEl.checked === true) out.byTypes.includeDownTunnels = true;
      }
    }
  }

  if (enabled.lldp) {
    var lldpChecks = document.querySelectorAll('input[data-lldp-checkbox="1"][id^="' + idPrefix + 'lldp-"]:checked');
    var neighborTypes = [];
    var ALLOWED = { firewall:1, "switch":1, access_point:1, server:1, workstation:1, router:1, printer:1, other:1 };
    for (var l = 0; l < lldpChecks.length; l++) {
      var t = lldpChecks[l].value;
      if (ALLOWED[t]) neighborTypes.push(t);
    }
    if (neighborTypes.length > 0) out.byLldp = { neighborTypes: neighborTypes };
  }

  // If nothing usable was captured, persist null (= feature off for this class).
  if (!out.byNames && !out.byPatterns && !out.byTypes && !out.byLldp) return null;
  return out;
}

// Wires change-listeners on a freshly-rendered auto-monitor card. Toggles
// panel visibility + fetches the aggregate list lazily on first "By name"
// expand + debounces a preview call into the preview block. Safe to call
// after the card's HTML has been inserted into the DOM.
function _wireAutoMonitorCard(idPrefix, klass, integrationId) {
  var masters = document.getElementsByName(idPrefix + "enable");
  if (!masters || masters.length === 0) return;
  var panels = {
    names:    document.getElementById(idPrefix + "panel-names"),
    patterns: document.getElementById(idPrefix + "panel-patterns"),
    types:    document.getElementById(idPrefix + "panel-types"),
    lldp:     document.getElementById(idPrefix + "panel-lldp"),
  };
  var preview = document.getElementById(idPrefix + "preview");
  var aggregateLoaded = false;
  var aggregateRows = null;
  // Per-card tracking of the most recently sent selection. The next preview
  // request passes this as `baselineSelection`, so the backend's diff block
  // shows the delta from the operator's previous click — not from the saved
  // state. Initial baseline = saved selection at modal open (stashed by
  // _autoMonitorInterfacesHTML), so the first preview-on-open shows no diff.
  var lastSentSelection = window["__autoMon_savedSelection_" + idPrefix] || null;
  // Canonical IfType order — matches IF_TYPES in src/services/autoMonitorInterfacesService.ts.
  // Backend Zod schema rejects values outside this set, so the UI mirrors it.
  var CANONICAL_IF_TYPES = ["physical", "aggregate", "vlan", "loopback", "tunnel"];
  // Tracks the "Include down tunnels" checkbox across type-list re-renders
  // (renderTypesList rebuilds innerHTML, destroying the DOM element). Seeded
  // from the saved selection; updated by the include-down change handler.
  var inclDownState = window["__autoMon_inclDownSeed_" + idPrefix] === true;

  function syncMasterVisibility() {
    var anyEnabled = false;
    for (var m = 0; m < masters.length; m++) {
      var checked = masters[m].checked;
      var key = masters[m].value;
      if (panels[key]) panels[key].style.display = checked ? "" : "none";
      if (checked) anyEnabled = true;
      if ((key === "names" || key === "types") && checked && !aggregateLoaded && integrationId) loadAggregate();
    }
    return anyEnabled;
  }

  // (Re)binds the tunnel row's "Include down tunnels" control: tunnel checkbox
  // toggles its visibility; the include-down checkbox updates inclDownState +
  // re-previews. Called after every type-list render (initial + dynamic) since
  // the elements are recreated each time.
  function wireInclDown() {
    var tunnelBox = document.getElementById(idPrefix + "type-tunnel");
    var wrap = document.getElementById(idPrefix + "types-includeDown-wrap");
    var inclBox = document.getElementById(idPrefix + "types-includeDown");
    if (tunnelBox && wrap) {
      tunnelBox.addEventListener("change", function () {
        wrap.style.display = tunnelBox.checked ? "inline-flex" : "none";
      });
    }
    if (inclBox) {
      inclBox.addEventListener("change", function () {
        inclDownState = inclBox.checked === true;
        schedulePreview();
      });
    }
  }

  // Renders the dynamic "By interface type" checklist from cached aggregate
  // rows. Only canonical ifTypes that actually appear in the integration's
  // discovered samples are listed, plus any saved-selection types not seen
  // in the latest data (preserved so a stored value isn't silently dropped).
  // Already-checked boxes in the DOM are preserved across re-renders.
  function renderTypesList() {
    var optsEl = document.getElementById(idPrefix + "types-options");
    if (!optsEl || aggregateRows === null) return;
    var existingChecked = new Set();
    var existing = optsEl.querySelectorAll('input[data-type-checkbox="1"]:checked');
    for (var i = 0; i < existing.length; i++) existingChecked.add(existing[i].value);
    var seed = window["__autoMon_typeSeed_" + idPrefix];
    if (seed && seed.length) seed.forEach(function (t) { existingChecked.add(t); });
    var seenTypes = new Set();
    for (var r = 0; r < aggregateRows.length; r++) {
      var t = aggregateRows[r].ifType;
      if (t && CANONICAL_IF_TYPES.indexOf(t) !== -1) seenTypes.add(t);
    }
    // Union the observed types with any saved-selection types we need to
    // preserve. Render in canonical order.
    var renderSet = new Set(seenTypes);
    existingChecked.forEach(function (t) {
      if (CANONICAL_IF_TYPES.indexOf(t) !== -1) renderSet.add(t);
    });
    var rendered = CANONICAL_IF_TYPES.filter(function (t) { return renderSet.has(t); });
    if (rendered.length === 0) {
      optsEl.innerHTML = '<p class="hint" style="margin:0;color:var(--color-warning)">No interface types found yet. Once monitoring runs at least one System Info pass on each discovered device, types will appear here.</p>';
      return;
    }
    optsEl.innerHTML = rendered.map(function (name) {
      var on = existingChecked.has(name);
      // Tunnel row's include-down control: checked from the tracked closure
      // state (survives re-renders), visible only when tunnel itself is checked.
      return _amonTypeRowHTML(idPrefix, name, on, inclDownState, on);
    }).join("");
    var boxes = optsEl.querySelectorAll('input[data-type-checkbox="1"]');
    for (var b = 0; b < boxes.length; b++) {
      boxes[b].addEventListener("change", schedulePreview);
    }
    wireInclDown();
  }

  function loadAggregate(force) {
    if (!integrationId) return;
    if (!force && aggregateLoaded) return;
    var listEl = document.getElementById(idPrefix + "names-list");
    var typesEl = document.getElementById(idPrefix + "types-options");
    if (listEl) listEl.innerHTML = '<p class="hint" style="margin:0">Loading…</p>';
    if (typesEl && (force || !aggregateRows)) typesEl.innerHTML = '<p class="hint" style="margin:0">Loading interface types…</p>';
    api.integrations.interfaceAggregate(integrationId, klass).then(function (resp) {
      aggregateLoaded = true;
      var rows = (resp && resp.rows) || [];
      aggregateRows = rows;
      renderNamesList(rows);
      renderTypesList();
    }).catch(function (err) {
      if (listEl) listEl.innerHTML = '<p class="hint" style="margin:0;color:var(--color-error)">Failed to load: ' + escapeHtml(err.message || "unknown error") + '</p>';
      if (typesEl) typesEl.innerHTML = '<p class="hint" style="margin:0;color:var(--color-error)">Failed to load: ' + escapeHtml(err.message || "unknown error") + '</p>';
    });
  }

  function renderNamesList(rows) {
    var listEl = document.getElementById(idPrefix + "names-list");
    if (!listEl) return;
    // Preserve any names the operator already checked from a prior selection.
    var existingChecked = new Set();
    var existing = document.querySelectorAll('input[data-name-checkbox="1"][data-prefix="' + idPrefix + '"]:checked');
    for (var i = 0; i < existing.length; i++) existingChecked.add(existing[i].value);
    // ALSO seed with the original currentSelection.names so "By name" remembers
    // the saved selection even when it doesn't match anything in the latest aggregate.
    if (window["__autoMon_seed_" + idPrefix]) {
      window["__autoMon_seed_" + idPrefix].forEach(function (n) { existingChecked.add(n); });
    }
    if (rows.length === 0) {
      listEl.innerHTML = '<p class="hint" style="margin:0;color:var(--color-warning)">No interface samples yet. Once monitoring runs at least one System Info pass on each discovered device, names will appear here.</p>';
    } else {
      listEl.innerHTML = rows.map(function (r) {
        var checked = existingChecked.has(r.ifName) ? " checked" : "";
        var typeTag = r.ifType ? '<span class="hint" style="margin:0 0 0 6px;font-size:0.78rem">[' + escapeHtml(r.ifType) + ']</span>' : "";
        return '<label style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:0.86rem">' +
                 '<input type="checkbox" data-name-checkbox="1" data-prefix="' + idPrefix + '" value="' + escapeHtml(r.ifName) + '"' + checked + ' style="width:auto">' +
                 '<span style="font-family:monospace">' + escapeHtml(r.ifName) + '</span>' +
                 typeTag +
                 '<span class="hint" style="margin:0 0 0 auto;font-size:0.78rem">' + r.deviceCount + ' device' + (r.deviceCount === 1 ? "" : "s") + '</span>' +
               '</label>';
      }).join("");
    }
    // Hand-roll the change listener — fires the preview + selected counter.
    var boxes = listEl.querySelectorAll('input[data-name-checkbox="1"]');
    for (var b = 0; b < boxes.length; b++) {
      boxes[b].addEventListener("change", function () { updateNamesCounter(); schedulePreview(); });
    }
    updateNamesCounter();
    schedulePreview();
  }

  function updateNamesCounter() {
    var counter = document.getElementById(idPrefix + "names-counter");
    if (!counter) return;
    var total = document.querySelectorAll('input[data-name-checkbox="1"][data-prefix="' + idPrefix + '"]').length;
    var picked = document.querySelectorAll('input[data-name-checkbox="1"][data-prefix="' + idPrefix + '"]:checked').length;
    counter.textContent = "Selected: " + picked + " / " + total;
  }

  // Debounced preview fetch.
  var previewTimer = null;
  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 250);
  }

  function runPreview() {
    if (!preview) return;
    if (!integrationId) {
      preview.innerHTML = '<em>Preview becomes available after the integration is saved and discovery has run at least once.</em>';
      return;
    }
    var selection = _readAutoMonitorInterfaces(idPrefix);
    if (!selection) {
      preview.innerHTML = '<em>Enable a block and add at least one value to preview matches.</em>';
      preview.style.borderColor = "";
      // Keep lastSentSelection in sync so the next toggle's diff is "from
      // empty" instead of "from a stale earlier selection."
      lastSentSelection = null;
      return;
    }
    // Pass the previously-sent selection as the baseline. Backend computes
    // both pin sets in one DB fetch and returns a `diff` block with the
    // per-(asset, ifName) add/remove counts. On the very first preview-after-
    // open, baseline = saved selection at modal open (so diff is 0); on every
    // subsequent toggle, baseline = the prior in-flight selection (so diff
    // shows what that toggle just changed).
    var requestBaseline = lastSentSelection;
    api.integrations.interfaceAggregatePreview(integrationId, { class: klass, selection: selection, baselineSelection: requestBaseline }).then(function (r) {
      // Update the baseline for the NEXT request right after a successful
      // round-trip — preserves per-click semantics even if the user clicks
      // a second time while the first preview is still in flight (debounce
      // collapses bursts; whichever response lands last wins, and the next
      // baseline tracks that one).
      lastSentSelection = selection;
      var warn = r.interfaceCount > AUTO_MONITOR_INTERFACE_WARN_THRESHOLD;
      var sample = (r.sampleDevices || []).slice(0, 5).map(function (d) {
        return escapeHtml(d.hostname || "(unnamed)") + ' <span class="hint" style="margin:0;font-size:0.78rem">(' + d.pinNames.length + ')</span>';
      }).join(" · ");
      // Diff badge. Hidden when there's no change since the last request.
      // Renders side-by-side green (+N added) and amber (−N removed) so an
      // operator can see at a glance whether a click broadened or narrowed
      // the pinned set. Sample additions/removals show a few illustrative
      // (hostname / ifName) pairs without overwhelming the box.
      var diff = r.diff || null;
      var diffHtml = "";
      if (diff && (diff.addedCount > 0 || diff.removedCount > 0)) {
        var parts = [];
        if (diff.addedCount > 0) {
          parts.push('<span style="color:var(--color-success);font-weight:600">+' + diff.addedCount + ' added</span>');
        }
        if (diff.removedCount > 0) {
          parts.push('<span style="color:var(--color-warning);font-weight:600">−' + diff.removedCount + ' removed</span>');
        }
        var sampleParts = [];
        var addedSample = (diff.addedSample || []).slice(0, 3).map(function (e) {
          return '<span style="color:var(--color-success)">+' + escapeHtml(e.hostname || "(unnamed)") + ' / ' + escapeHtml(e.ifName) + '</span>';
        });
        var removedSample = (diff.removedSample || []).slice(0, 3).map(function (e) {
          return '<span style="color:var(--color-warning)">−' + escapeHtml(e.hostname || "(unnamed)") + ' / ' + escapeHtml(e.ifName) + '</span>';
        });
        sampleParts = addedSample.concat(removedSample);
        diffHtml =
          '<div style="margin-top:0.3rem;font-size:0.82rem">Change since last edit: ' + parts.join(" · ") +
          (sampleParts.length > 0 ? ' <span class="hint" style="margin:0 0 0 6px;font-size:0.78rem">(' + sampleParts.join(" · ") + ')</span>' : '') +
          '</div>';
      }
      preview.innerHTML =
        '<div><strong>' + r.interfaceCount + '</strong> interface' + (r.interfaceCount === 1 ? "" : "s") +
        ' on <strong>' + r.deviceCount + '</strong> device' + (r.deviceCount === 1 ? "" : "s") +
        ' (max ' + r.perDeviceMax + '/device)' +
        (warn ? ' <span style="color:var(--color-warning);margin-left:6px">⚠ above warn threshold (' + AUTO_MONITOR_INTERFACE_WARN_THRESHOLD + ')</span>' : '') +
        '</div>' +
        diffHtml +
        (sample ? '<div style="margin-top:0.3rem;font-size:0.82rem">First matches: ' + sample + '</div>' : '');
      preview.style.borderColor = warn ? "var(--color-warning)" : "";
      // Cache the latest interface count on the card for the Save handler to read.
      preview.dataset.interfaceCount = String(r.interfaceCount);
    }).catch(function (err) {
      preview.innerHTML = '<span style="color:var(--color-error)">Preview failed: ' + escapeHtml(err.message || "unknown error") + '</span>';
    });
  }

  // Wire master checkboxes — each one toggles its panel and re-runs preview.
  for (var i = 0; i < masters.length; i++) {
    masters[i].addEventListener("change", function () { syncMasterVisibility(); schedulePreview(); });
  }

  // Patterns block — textarea, regex/wildcard radio, onlyUp.
  var patternsEls = [
    document.getElementById(idPrefix + "patterns"),
    document.getElementById(idPrefix + "patterns-onlyUp"),
  ];
  patternsEls.forEach(function (el) {
    if (!el) return;
    el.addEventListener("input", schedulePreview);
    el.addEventListener("change", schedulePreview);
  });
  var patternsModeRadios = document.getElementsByName(idPrefix + "patterns-mode");
  for (var pm = 0; pm < patternsModeRadios.length; pm++) {
    patternsModeRadios[pm].addEventListener("change", schedulePreview);
  }

  // Test button — preview the patterns block in isolation so the operator can
  // verify their regex without the noise of the other blocks. Hits the same
  // /interface-aggregate/preview endpoint with just byPatterns populated.
  var testBtn = document.getElementById(idPrefix + "patterns-test");
  var testOut = document.getElementById(idPrefix + "patterns-test-result");
  if (testBtn && testOut) {
    testBtn.addEventListener("click", function () {
      if (!integrationId) return;
      var ta = document.getElementById(idPrefix + "patterns");
      var raw = ta ? String(ta.value || "") : "";
      var patterns = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (patterns.length === 0) {
        testOut.style.display = "";
        testOut.innerHTML = '<span style="color:var(--color-warning)">Enter at least one pattern to test.</span>';
        return;
      }
      var modeRs = document.getElementsByName(idPrefix + "patterns-mode");
      var isRegex = false;
      for (var pr = 0; pr < modeRs.length; pr++) { if (modeRs[pr].checked && modeRs[pr].value === "regex") { isRegex = true; break; } }
      var ouEl = document.getElementById(idPrefix + "patterns-onlyUp");
      var selection = { byPatterns: { patterns: patterns, regex: isRegex, onlyUp: ouEl ? ouEl.checked === true : false } };
      testBtn.disabled = true;
      var prevLabel = testBtn.textContent;
      testBtn.textContent = "Testing…";
      testOut.style.display = "";
      testOut.innerHTML = '<em>Running…</em>';
      api.integrations.interfaceAggregatePreview(integrationId, { class: klass, selection: selection }).then(function (r) {
        var sample = (r.sampleDevices || []).slice(0, 5).map(function (d) {
          var names = (d.pinNames || []).slice(0, 6).join(", ");
          if ((d.pinNames || []).length > 6) names += ", …";
          return escapeHtml(d.hostname || "(unnamed)") + ' <span class="hint" style="margin:0">[' + escapeHtml(names) + ']</span>';
        }).join("<br>");
        testOut.innerHTML =
          '<div><strong>' + r.interfaceCount + '</strong> match' + (r.interfaceCount === 1 ? "" : "es") +
          ' on <strong>' + r.deviceCount + '</strong> device' + (r.deviceCount === 1 ? "" : "s") +
          (r.deviceCount > 0 ? ' (max ' + r.perDeviceMax + '/device)' : '') + '</div>' +
          (sample ? '<div style="margin-top:0.3rem">' + sample + '</div>' : '');
      }).catch(function (err) {
        testOut.innerHTML = '<span style="color:var(--color-error)">' + escapeHtml(err.message || "Test failed") + '</span>';
      }).finally(function () {
        testBtn.disabled = false;
        testBtn.textContent = prevLabel;
      });
    });
  }

  // Types block.
  var typeBoxes = document.querySelectorAll('input[data-type-checkbox="1"][id^="' + idPrefix + 'type-"]');
  for (var t = 0; t < typeBoxes.length; t++) typeBoxes[t].addEventListener("change", schedulePreview);
  var typesOnlyUp = document.getElementById(idPrefix + "types-onlyUp");
  if (typesOnlyUp) typesOnlyUp.addEventListener("change", schedulePreview);
  // Wire the include-down control on the initial (saved) render; renderTypesList
  // re-wires it after a dynamic re-render.
  wireInclDown();

  // LLDP block.
  var lldpBoxes = document.querySelectorAll('input[data-lldp-checkbox="1"][id^="' + idPrefix + 'lldp-"]');
  for (var lb = 0; lb < lldpBoxes.length; lb++) lldpBoxes[lb].addEventListener("change", schedulePreview);

  // Reload (By name).
  var reload = document.getElementById(idPrefix + "reload");
  if (reload) reload.addEventListener("click", function () { aggregateLoaded = false; loadAggregate(true); });

  // Initial visibility sync.
  syncMasterVisibility();
  // Run initial preview if anything is enabled.
  schedulePreview();
}

// FortiGate subtab variant — "Add as Monitored" only, wrapped in a styled
// box matching the Auto-Monitor Interfaces card. The SNMP-sysLocation
// pull/push toggles moved out to the top-level Geographic Location tab on
// the integration's Edit modal (see geographicLocationFormHTML). FortiGates
// always get the integration source link stamped at discovery, which drives
// the polling-method resolver to REST API by default, so no per-class
// credential picker is needed here.
function _fortigateAddMonitoredHTML(idPrefix, currentAddAsMonitored) {
  var enabled = currentAddAsMonitored === true;
  var btnClass = enabled ? "btn-danger" : "btn-primary";
  var btnLabel = enabled ? "Disable Auto-Monitoring" : "Enable Auto-Monitoring";
  return '<div style="background:rgba(79,195,247,0.06);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<div class="form-group" style="display:flex;align-items:center;gap:12px;margin-bottom:0.4rem">' +
        '<input type="checkbox" id="' + idPrefix + 'addAsMonitored" ' + (enabled ? "checked" : "") + ' style="display:none">' +
        '<button type="button" class="btn ' + btnClass + '" data-auto-monitor-toggle="' + idPrefix + 'addAsMonitored" style="min-width:200px">' + btnLabel + '</button>' +
        '<div style="font-weight:500">Auto-Monitor FortiGates</div>' +
      '</div>' +
      '<p class="hint" style="margin:0">When enabled, every discovered FortiGate is monitored (the integration\'s API token already provides the probe path). Disabling sweeps existing FortiGates off monitoring on the next discovery cycle unless an operator has set a per-asset override. You\'ll be asked to confirm at Save Changes.</p>' +
    '</div>';
}

// Reactively enable/disable the pushGeocodedCoords checkbox. Push is available
// when EITHER "Pull SNMP sysLocation" is on OR an address metavar is named
// (FMG-only) — both are geocode sources Polaris can write coords back from.
// Attached to window so the inline onchange/oninput handlers in
// geographicLocationFormHTML can reach it after the modal renders.
if (typeof window !== "undefined") {
  window._geoRecomputePush = function (prefix) {
    var pull = document.getElementById(prefix + "pullSnmpLocation");
    var addr = document.getElementById(prefix + "addressMetavar");
    var push = document.getElementById(prefix + "pushGeocodedCoords");
    if (!push) return;
    var enabled = (pull && pull.checked === true) || (addr && addr.value.trim() !== "");
    push.disabled = !enabled;
    if (!enabled) push.checked = false;
    var lbl = push.nextElementSibling;
    if (lbl) lbl.style.opacity = enabled ? "1" : "0.5";
  };
}

// Body of the top-level "Geographic Location" tab on FMG and standalone
// FortiGate integration Edit/Create modals. Carries the pull-from-SNMP and
// push-geocoded-coords toggles plus (FMG only) the per-device metavar-name
// fields. The DOM ids stay `f-mon-fortigate-pullSnmpLocation` /
// `...pushGeocodedCoords` / `...latitudeMetavar` / `...longitudeMetavar` /
// `...addressMetavar` so `_readFortigateMonitorBlock()` finds them at save
// time. pushGeocodedCoords reactively enables when pull is on OR an address
// metavar is named (see window._geoRecomputePush).
function geographicLocationFormHTML(currentPullSnmpLocation, currentPushGeocodedCoords, latMeta, lngMeta, addrMeta, integrationType) {
  var idPrefix = "f-mon-fortigate-";
  var pull = currentPullSnmpLocation === true;
  var push = currentPushGeocodedCoords === true;
  var isFmg = integrationType === "fortimanager";
  var addrSet = isFmg && typeof addrMeta === "string" && addrMeta.trim() !== "";
  var pushEnabled = pull || addrSet;
  // FMG-only metavar-name fields. Standalone FortiGate has no metavars, so the
  // block is omitted entirely there (push writes CMDB only).
  var metavarBlock = "";
  if (isFmg) {
    metavarBlock =
      '<div style="margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--color-border)">' +
        '<div style="font-weight:600;margin-bottom:0.25rem">FortiManager metavariable names</div>' +
        '<p class="hint" style="margin-top:0;margin-bottom:0.75rem">Names of the per-device FMG metavariables Polaris reads coordinates from and writes them back to. Leave Latitude / Longitude at the defaults unless your fleet uses a different naming scheme.</p>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">' +
          '<div class="form-group" style="margin:0">' +
            '<label for="' + idPrefix + 'latitudeMetavar" style="font-weight:500">Latitude metavar</label>' +
            '<input type="text" id="' + idPrefix + 'latitudeMetavar" value="' + escapeHtml(latMeta || "Latitude") + '" placeholder="Latitude">' +
          '</div>' +
          '<div class="form-group" style="margin:0">' +
            '<label for="' + idPrefix + 'longitudeMetavar" style="font-weight:500">Longitude metavar</label>' +
            '<input type="text" id="' + idPrefix + 'longitudeMetavar" value="' + escapeHtml(lngMeta || "Longitude") + '" placeholder="Longitude">' +
          '</div>' +
        '</div>' +
        '<div class="form-group" style="margin:0.75rem 0 0 0">' +
          '<label for="' + idPrefix + 'addressMetavar" style="font-weight:500">Address metavar (optional)</label>' +
          '<input type="text" id="' + idPrefix + 'addressMetavar" value="' + escapeHtml(addrMeta || "") + '" placeholder="Leave blank to use SNMP sysLocation" oninput="window._geoRecomputePush(\'' + idPrefix + '\')">' +
          '<p class="hint" style="margin-bottom:0">When set, Polaris reads this metavar\'s address string from each FortiGate and geocodes it <strong>instead of</strong> the SNMP sysLocation (SNMP is used only as a fallback when this metavar is empty). Use this if you don\'t want to pull sysLocation. Leave blank to rely on SNMP.</p>' +
        '</div>' +
      '</div>';
  }
  return '<p style="font-size:0.9rem;color:var(--color-text-secondary);line-height:1.5;margin:0 0 1rem 0">' +
      'Polaris resolves each FortiGate\'s location to map coordinates and (optionally) writes the result ' +
      'back to the device so it shows up correctly on the Polaris Device Map. The location string comes from ' +
      'the SNMP <code>sysLocation</code> (read via REST API — no separate SNMP credential needed)' +
      (isFmg ? ' or, in preference, a FortiManager address metavariable' : '') +
      ', geocoded via OpenStreetMap Nominatim. ' +
      'When the location is blank or doesn\'t geocode, Polaris falls back to ' +
      (isFmg ? 'FortiManager coordinate metavars / CMDB coords.' : 'the FortiGate\'s CMDB coords.') +
    '</p>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.4rem">' +
      '<input type="checkbox" id="' + idPrefix + 'pullSnmpLocation" ' + (pull ? "checked" : "") +
      ' onchange="window._geoRecomputePush(\'' + idPrefix + '\')"' +
      ' style="width:auto">' +
      '<label for="' + idPrefix + 'pullSnmpLocation" style="margin:0;font-weight:500">Pull SNMP sysLocation from each FortiGate</label>' +
    '</div>' +
    '<p class="hint" style="margin-bottom:1rem">Each discovery cycle, Polaris fetches <code>sysLocation</code> for every FortiGate via the FortiOS REST API and geocodes it through Nominatim. The resolved coordinates become the asset\'s position on the Device Map.</p>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.4rem">' +
      '<input type="checkbox" id="' + idPrefix + 'pushGeocodedCoords" ' + (push ? "checked" : "") + (pushEnabled ? "" : " disabled") + ' style="width:auto">' +
      '<label for="' + idPrefix + 'pushGeocodedCoords" style="margin:0;font-weight:500' + (pushEnabled ? "" : ";opacity:0.5") + '">Write geocoded coordinates back to the FortiGate</label>' +
    '</div>' +
    '<p class="hint" style="margin-bottom:0">When the geocoded coords differ from the FortiGate\'s current GUI values, update them on the device — ' +
      (isFmg
        ? 'writes to both the FortiManager coordinate metavars and the FortiGate\'s CMDB <code>gui-device-latitude</code> / <code>gui-device-longitude</code>. In FortiManager mode the change lands in FMG\'s CMDB but won\'t reach the live FortiGate until an operator runs Install Device Configuration in FMG.'
        : 'writes the FortiGate\'s CMDB <code>gui-device-latitude</code> / <code>gui-device-longitude</code>.') +
    '</p>' +
    metavarBlock;
}

// Renders the integration's Monitoring tab as a set of CLASS subtabs. Each
// class subtab carries:
//   1. Class-level header content (FortiGate: useDirect-toggle + discovery
//      defaults; FortiSwitch / FortiAP: direct-polling toggle + discovery
//      defaults; AD / Entra / WinSrv: no class header — they always discover)
//   2. Stream subtabs (Response Time / CPU+Memory / Temperature / Interfaces
//      / LLDP / Storage). FortiAP omits Storage.
//
// Class subtab set per integration type (see `_CLASS_SUBTAB_SPECS`):
//   fortimanager + fortigate → FortiGate / FortiSwitch / FortiAP
//   activedirectory + entraid + windowsserver → Workstations / Servers
//
// Phase 1 behaviour: every class subtab reads + writes the SAME flat
// `Integration.config.monitorSettings` JSON. The PRIMARY class subtab uses
// the legacy `f-mon-tier-...` / `f-mon-...` ids so `_readIntegrationCadenceForm`
// finds the values; secondary subtabs render a parallel, namespaced echo
// that doesn't get read on save. A banner inside each secondary subtab
// makes that explicit.
//
// opts: { integrationId, integrationType, integrationName, snmpCredentials,
//         monitorCredentialId, sshCredentialId, fortigateMonitor,
//         fortiswitchMonitor, fortiapMonitor, fmgDefaults?, pollInterval }
//   fmgDefaults is the FMG/FortiGate connection-form `defaults` blob — only
//   consulted for the relocated useDirect / discoveryParallelism /
//   fortigateApiUser / fortigateApiToken / fortigateVerifySsl fields when
//   `integrationType` is fortimanager.
function monitorSettingsFormHTML(s, opts) {
  s = s || {};
  opts = opts || {};
  var integrationType = opts.integrationType || "";
  var spec = _CLASS_SUBTAB_SPECS[integrationType];
  if (!spec) {
    // Fallback: no per-class layout known for this type — render a single
    // primary class subtab carrying every stream, no header content. Keeps
    // the modal functional for future integration types that haven't been
    // added to the spec yet.
    spec = { primary: "generic", classes: [{ key: "generic", label: "Monitoring" }] };
  }

  var isFmgFgt = integrationType === "fortimanager" || integrationType === "fortigate";
  var hasId    = !!opts.integrationId;
  var credentials = opts.snmpCredentials || [];

  // Per-class header content (auto-monitor, direct-polling toggles, etc.).
  // Built lazily per class inside the loop below.
  var fwFgCfg = opts.fortigateMonitor   || { addAsMonitored: false, autoMonitorInterfaces: null, pullSnmpLocation: false, pushGeocodedCoords: false, latitudeMetavar: "Latitude", longitudeMetavar: "Longitude", addressMetavar: "" };
  var fwSwCfg = opts.fortiswitchMonitor || { enabled: false, snmpCredentialId: null, sshCredentialId: null, addAsMonitored: false, autoMonitorInterfaces: null };
  var fwApCfg = opts.fortiapMonitor     || { enabled: false, snmpCredentialId: null, sshCredentialId: null, addAsMonitored: false, autoMonitorInterfaces: null };
  // AD/Entra/WindowsServer per-class blocks. The backend Zod schema names
  // them singularly (workstationMonitor / serverMonitor); the in-UI class
  // keys are plural (workstations / servers).
  var workstationCfg = opts.workstationMonitor || { addAsMonitored: false, autoMonitorInterfaces: null };
  var serverCfg      = opts.serverMonitor     || { addAsMonitored: false, autoMonitorInterfaces: null };

  // Stash auto-monitor name seeds for the lazy-loaded checklists.
  if (typeof window !== "undefined" && isFmgFgt) {
    function _amonSeedNames(sel) {
      if (!sel) return [];
      if (sel.byNames && Array.isArray(sel.byNames.names)) return sel.byNames.names.slice();
      if (sel.mode === "names" && Array.isArray(sel.names)) return sel.names.slice();
      return [];
    }
    window["__autoMon_seed_f-mon-fortigate-amon-"]   = _amonSeedNames(fwFgCfg.autoMonitorInterfaces);
    window["__autoMon_seed_f-mon-fortiswitch-amon-"] = _amonSeedNames(fwSwCfg.autoMonitorInterfaces);
    window["__autoMon_seed_f-mon-fortiap-amon-"]     = _amonSeedNames(fwApCfg.autoMonitorInterfaces);
  }

  // Class subtab header content (Discovery defaults at top, then optional
  // Direct Polling toggle whose ON state reveals the per-class direct-polling
  // credentials AND the per-stream subtabs below). Returns "" for AD / Entra /
  // WindowsServer + the generic fallback — those have no per-class discovery-
  // time knobs to surface.
  //
  // For FortiGate on FMG integrations, the SNMP/SSH credential pickers from
  // `integrationMonitorOverrideHTML` are rendered hidden (display:none) at the
  // bottom of the section so the save-path reader (`_polarisReadCredentials`
  // / form serializer) still finds the `f-mon-credential` /
  // `f-mon-credential-ssh` select elements. Per-stream credential pickers
  // inside each stream subtab are the operator-facing surface. We pre-mirror
  // the SNMP value from the Response Time stream's snmp credential picker on
  // form change so a save still serializes the operator's intent.
  // Per-class header content. Each FMG/FortiGate class subtab gets an
  // "Auto-monitoring" section header followed by two side-by-side concept
  // cards (addAsMonitored, then Auto-Monitor Interfaces), then any class-
  // specific tail (Direct Polling toggle for FortiSwitch / FortiAP; FMG's
  // Direct Polling block for the FortiGate subtab on FMG integrations).
  // The "Discovery defaults" heading + description that used to lead the
  // section have been dropped — the "Auto-monitoring" header replaces them
  // positionally, and the help text inside each card is the only descriptor
  // operators need.
  function autoMonitoringHeader() {
    return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0 0 0.75rem 0">Auto-monitoring</p>';
  }
  function headerForClass(klass) {
    if (klass === "fortigate" && isFmgFgt) {
      // Auto-Monitor Interfaces is gated on addAsMonitored — auto-monitor
      // pins interfaces on newly-discovered assets to be polled on the fast
      // cadence, which only makes sense when those assets are being added
      // as monitored. _wireMonitoringTabSubtabs wires a change listener on
      // the addAsMonitored checkbox to toggle this wrapper's display.
      var fgAutoMonWrapHidden = (fwFgCfg.addAsMonitored === true) ? "" : "display:none";
      var autoMonitoringSection =
        '<section style="margin-bottom:1.25rem">' +
          autoMonitoringHeader() +
          _fortigateAddMonitoredHTML(
            "f-mon-fortigate-",
            fwFgCfg.addAsMonitored === true,
          ) +
          '<div id="f-mon-fortigate-automon-wrap" style="' + fgAutoMonWrapHidden + '">' +
            _autoMonitorInterfacesHTML("f-mon-fortigate-amon-", "FortiGate", fwFgCfg.autoMonitorInterfaces || null, "names", hasId) +
          '</div>' +
        '</section>';

      // Save-path continuity: keep the legacy SNMP/SSH credential pickers in
      // the DOM but invisible. `_syncCredentialPickerVisibility` normally
      // shows/hides these based on per-stream polling-method selections; we
      // need them to stay hidden no matter what under FortiGate now, so we
      // wrap them in a display:none container that nothing flips back on.
      var hiddenLegacyCreds =
        '<div id="f-mon-fortigate-legacy-creds" style="display:none" aria-hidden="true">' +
          integrationMonitorOverrideHTML(credentials, opts.monitorCredentialId, opts.sshCredentialId || null) +
        '</div>';

      // FMG-only: Direct Polling toggle + revealable inner block (REST
      // credentials). Standalone FortiGate is always direct so this block
      // is omitted entirely there.
      var directBlock = (integrationType === "fortimanager")
        ? _fmgDirectModeBlockHTML(opts.fmgDefaults || {})
        : "";

      return autoMonitoringSection + directBlock + hiddenLegacyCreds;
    }
    if (klass === "fortiswitch" && isFmgFgt) {
      // Order: Auto-monitoring header → addAsMonitored card → Auto-Monitor
      // Interfaces card (gated on addAsMonitored) → Direct Polling toggle +
      // per-class credentials. Stream subtabs (rendered by
      // _classSubtabBodyHTML) sit below the Direct Polling toggle and are
      // gated by it.
      var swAutoMonWrapHidden = (fwSwCfg.addAsMonitored === true) ? "" : "display:none";
      return '<section style="margin-bottom:1.25rem">' +
          autoMonitoringHeader() +
          _classAddAsMonitoredHTML("f-mon-fortiswitch-", "FortiSwitch", fwSwCfg.addAsMonitored === true) +
          '<div id="f-mon-fortiswitch-automon-wrap" style="' + swAutoMonWrapHidden + '">' +
            _autoMonitorInterfacesHTML("f-mon-fortiswitch-amon-", "FortiSwitch", fwSwCfg.autoMonitorInterfaces || null, "wildcard", hasId) +
          '</div>' +
          _classDirectPollHTML("f-mon-fortiswitch-", "FortiSwitch", credentials, fwSwCfg.enabled === true, fwSwCfg.snmpCredentialId || null, fwSwCfg.sshCredentialId || null) +
        '</section>';
    }
    if (klass === "fortiap" && isFmgFgt) {
      var apAutoMonWrapHidden = (fwApCfg.addAsMonitored === true) ? "" : "display:none";
      return '<section style="margin-bottom:1.25rem">' +
          autoMonitoringHeader() +
          _classAddAsMonitoredHTML("f-mon-fortiap-", "FortiAP", fwApCfg.addAsMonitored === true) +
          '<div id="f-mon-fortiap-automon-wrap" style="' + apAutoMonWrapHidden + '">' +
            _autoMonitorInterfacesHTML("f-mon-fortiap-amon-", "FortiAP", fwApCfg.autoMonitorInterfaces || null, "type", hasId) +
          '</div>' +
          _classDirectPollHTML("f-mon-fortiap-", "FortiAP", credentials, fwApCfg.enabled === true, fwApCfg.snmpCredentialId || null, fwApCfg.sshCredentialId || null) +
        '</section>';
    }
    // AD / Entra / Windows Server Workstations + Servers subtabs. Currently
    // these integrations always discover (no `enabled` toggle) and the
    // addAsMonitored flag is persisted but NOT yet consulted by the AD /
    // Entra / WinSrv discovery code — a backend follow-up will wire it.
    // Auto-Monitor Interfaces is the FortiGate-discovery feature; surface
    // it on workstations/servers would mislead since AD/Entra-discovered
    // endpoints don't have an authoritative interface roster to apply
    // against, so we omit that card entirely here.
    if (klass === "workstations" || klass === "workstation") {
      return '<section style="margin-bottom:1.25rem">' +
          autoMonitoringHeader() +
          _classAddAsMonitoredHTML("f-mon-workstation-", "workstation", workstationCfg.addAsMonitored === true) +
          '<p class="hint" style="margin:-0.25rem 0 0 0;color:var(--color-text-tertiary)">' +
            "Flag is persisted today but not yet honored by discovery — a backend follow-up will wire it. " +
            "In the meantime, flip <code>monitored</code> per-asset from the assets table." +
          '</p>' +
        '</section>';
    }
    if (klass === "servers" || klass === "server") {
      return '<section style="margin-bottom:1.25rem">' +
          autoMonitoringHeader() +
          _classAddAsMonitoredHTML("f-mon-server-", "server", serverCfg.addAsMonitored === true) +
          '<p class="hint" style="margin:-0.25rem 0 0 0;color:var(--color-text-tertiary)">' +
            "Flag is persisted today but not yet honored by discovery — a backend follow-up will wire it. " +
            "In the meantime, flip <code>monitored</code> per-asset from the assets table." +
          '</p>' +
        '</section>';
    }
    return "";
  }

  // Build the class-level tab list.
  var primaryLabel = (spec.classes.find(function (c) { return c.key === spec.primary; }) || spec.classes[0]).label;
  var classTabs = spec.classes.map(function (c) {
    return {
      key: c.key,
      label: c.label,
      html: _classSubtabBodyHTML({
        integrationType: integrationType,
        klass:           c.key,
        isPrimary:       c.key === spec.primary,
        primaryLabel:    primaryLabel,
        settings:        s,
        // Phase 2 — pick the per-class streams block matching this class.
        // FMG / FortiGate route to fortigateMonitor / fortiswitchMonitor /
        // fortiapMonitor; AD / Entra / WinSrv route to workstationMonitor /
        // serverMonitor. Missing block → undefined → overlay no-ops →
        // legacy flat baseline shows through (unmigrated install).
        classStreams: _classStreamsBlockFor(c.key, opts),
        credentials:     credentials,
        headerHtml:      headerForClass(c.key),
        fmgDefaults:     opts.fmgDefaults || {},
        fortigateMonitor:   opts.fortigateMonitor   || {},
        fortiswitchMonitor: opts.fortiswitchMonitor || {},
        fortiapMonitor:     opts.fortiapMonitor     || {},
        workstationMonitor: opts.workstationMonitor || {},
        serverMonitor:      opts.serverMonitor     || {},
        // Hide per-stream credential rows on FortiSwitch + FortiAP class
        // subtabs — the class-level SNMP/SSH credential picker inside the
        // Direct Polling block is authoritative for those classes (managed
        // switches and APs use one credential across every stream).
        showStreamCredentials: !(c.key === "fortiswitch" || c.key === "fortiap"),
      }),
    };
  });

  return '<section>' +
      '<p class="hint" style="margin:0 0 0.85rem 0;color:var(--color-text-tertiary)">' +
        "Per-class polling, cadences, and credentials for assets discovered by this integration. " +
        "A class override (Assets page → Monitoring Settings) or a per-asset override on the asset itself takes priority." +
      '</p>' +
      _intRenderTabbedBody("intg-mon-class", classTabs) +
    '</section>';
}

// Direct-polling toggle + REST API credentials for FMG-managed FortiGates.
// Rendered inside the FortiGate class subtab of the Monitoring tab. Mirrors
// the FortiSwitch/FortiAP "Direct Polling" pattern visually (compact toggle
// + revealable inner block) — the legacy DOM ids (`f-useDirect`,
// `f-direct-mode-block`, `f-discoveryParallelism`, `f-fortigateApiUser`,
// `f-fortigateApiToken`, `f-fortigateVerifySsl`) all stay so
// `getFormConfig()` and `_fmgToggleDirectMode()` keep reading them unchanged.
// UI semantic: checked = direct (useProxy=false); unchecked = proxy.
function _fmgDirectModeBlockHTML(d) {
  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Direct polling</p>' +
    '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<input type="checkbox" id="f-useDirect" ' + (d.useProxy === false ? "checked" : "") + ' style="width:auto" onchange="_fmgToggleDirectMode(this.checked)">' +
        '<label for="f-useDirect" style="margin:0;font-weight:500">Direct Polling</label>' +
      '</div>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5;margin:0 0 0.6rem 0">Bypass FortiManager proxy to directly poll discovered FortiGates. Some information is still gathered through FortiManager.</p>' +
      '<div id="f-direct-mode-block" style="' + (d.useProxy === false ? "" : "display:none;") + 'border-top:1px solid rgba(79,195,247,0.2);padding-top:0.75rem;margin-top:0.25rem">' +
        '<div class="form-group"><label>Parallel FortiGate Queries</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-discoveryParallelism" value="' + (d.useProxy === false ? (d.discoveryParallelism || 5) : 1) + '" min="1" max="20" style="width:80px"><span id="f-parallelism-note" style="color:var(--color-text-tertiary);font-size:0.85rem">gates at once</span></div><p class="hint">Up to 20 FortiGates concurrently. Recommended when monitoring more than 20 FortiGates — proxy mode polls them one at a time.</p></div>' +
        '<div class="form-group"><label>FortiGate API User</label><input type="text" id="f-fortigateApiUser" value="' + escapeHtml(d.fortigateApiUser || "") + '" placeholder="e.g. polaris-ro"><p class="hint">REST API admin username configured on each managed FortiGate</p></div>' +
        '<div class="form-group"><label>FortiGate API Token</label><input type="password" id="f-fortigateApiToken" value="' + (d.fortigateApiTokenPlaceholder ? "" : escapeHtml(d.fortigateApiToken || "")) + '" placeholder="' + (d.fortigateApiTokenPlaceholder || "Bearer token") + '"><p class="hint">Bearer token for the above admin. Must be the same across all managed FortiGates.</p></div>' +
        '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0">' +
          '<input type="checkbox" id="f-fortigateVerifySsl" ' + (d.fortigateVerifySsl ? "checked" : "") + ' style="width:auto">' +
          '<label for="f-fortigateVerifySsl" style="margin:0">Verify SSL certificate on FortiGates</label>' +
        '</div>' +
        '<p class="hint" style="color:var(--color-warning,#d98c00)">Leave enabled. Disabling lets a network attacker intercept the direct FortiGate REST connections and capture the API token. Disable only for FortiGates with self-signed certificates you cannot replace.</p>' +
      '</div>' +
    '</div>';
}

// Walk every polling-method <select> rendered by _polarisPollingDropdownHTML
// (identified by data-poll-source / data-poll-stream attributes) inside the
// given container and rewrite the first option's text — the "Inherit (…)"
// label — so it reflects the current Direct Polling state. Called from the
// FMG `f-useDirect` toggle's change handler so flipping the toggle live
// updates every per-stream dropdown's label without re-rendering and losing
// the operator's current selections.
function _relabelInheritOptions(container, fmgDirectMode) {
  if (!container) container = document;
  var selects = container.querySelectorAll("select[data-poll-source][data-poll-stream]");
  for (var i = 0; i < selects.length; i++) {
    var sel = selects[i];
    var source = sel.getAttribute("data-poll-source");
    var stream = sel.getAttribute("data-poll-stream");
    if (!sel.options || sel.options.length === 0) continue;
    var firstOpt = sel.options[0];
    if (firstOpt.value !== "") continue; // safety: only touch the Inherit row
    var defaultMethod = _polarisSourceDefaultPolling(source, stream);
    var sourceLabel = _polarisSourceLabel(source, { fmgDirectMode: fmgDirectMode === true });
    firstOpt.textContent = defaultMethod
      ? "Inherit (Source " + sourceLabel + ": " + _POLLING_LABELS[defaultMethod] + ")"
      : "Inherit (Source " + sourceLabel + ": not delivered)";
  }
}

// Per-stream credential-row reactivity. Each polling-method <select> rendered
// by _polarisPollingDropdownHTML carries data-poll-source + data-poll-stream
// attributes and its DOM id; _classStreamSubtabHTML emits three sibling
// credential rows below each dropdown at `<pollId>-credrow-snmp` /
// `-credrow-ssh` / `-credrow-winrm`, all default display:none. This helper
// walks every such dropdown inside `rootEl` (defaults to document), wires a
// `change` listener that reveals only the row matching the chosen polling
// method (snmp/ssh/winrm), hides the others (and hides all three on
// rest_api / icmp / disabled), and applies the same logic to each
// dropdown's current value so the initial render lands in the right state
// before any user interaction. Idempotent against re-call — the wired flag
// on each element prevents stacking duplicate listeners.
function _wireStreamCredentialPickerVisibility(rootEl) {
  var root = rootEl || document;
  var selects = root.querySelectorAll("select[data-poll-source][data-poll-stream]");
  function applyOne(sel) {
    var pollId = sel.id;
    if (!pollId) return;
    var value = sel.value || "";
    ["snmp", "ssh", "winrm"].forEach(function (credType) {
      var row = document.getElementById(pollId + "-credrow-" + credType);
      if (!row) return;
      row.style.display = (value === credType) ? "" : "none";
    });
  }
  for (var i = 0; i < selects.length; i++) {
    var sel = selects[i];
    applyOne(sel);
    if (!sel.dataset.polarisCredRowsWired) {
      sel.dataset.polarisCredRowsWired = "1";
      sel.addEventListener("change", (function (s) {
        return function () { applyOne(s); };
      })(sel));
    }
  }
}

// Wires every nested tab strip rendered inside the Monitoring tab: one
// class-level strip (intg-mon-class) plus one stream-level strip per class
// subtab (intg-mon-streams-primary + intg-mon-streams-<klass> for each
// secondary class). Idempotent — safe to call whenever the modal mounts.
// Bind the Enable/Disable Auto-Monitoring button to its paired hidden
// checkbox. The button toggles the checkbox, dispatches a `change` event
// (so the existing automon-wrap visibility listener and any other change
// hooks fire unchanged), and re-themes itself (blue → red on enable,
// red → blue on disable). Idempotent: re-binding is harmless.
function _wireAutoMonitoringButtons(rootEl) {
  var root = rootEl || document;
  var buttons = root.querySelectorAll('button[data-auto-monitor-toggle]');
  for (var i = 0; i < buttons.length; i++) {
    var btn = buttons[i];
    if (btn.dataset.wired === "1") continue;
    btn.dataset.wired = "1";
    (function (b) {
      b.addEventListener("click", function () {
        var targetId = b.getAttribute("data-auto-monitor-toggle");
        var hidden = document.getElementById(targetId);
        if (!hidden) return;
        var nextOn = !hidden.checked;
        hidden.checked = nextOn;
        if (nextOn) {
          b.classList.remove("btn-primary");
          b.classList.add("btn-danger");
          b.textContent = "Disable Auto-Monitoring";
        } else {
          b.classList.remove("btn-danger");
          b.classList.add("btn-primary");
          b.textContent = "Enable Auto-Monitoring";
        }
        // Dispatch so the existing change listener (automon-wrap display,
        // any future side effects) fires as before. Inputs of type=checkbox
        // dispatch 'change' on user interaction; we have to do it manually
        // when we mutate `checked` from JS.
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
      });
    })(btn);
  }
}

function _wireMonitoringTabSubtabs(integrationType) {
  var spec = _CLASS_SUBTAB_SPECS[integrationType];
  if (!spec) return;
  _intWireModalTabs("intg-mon-class");
  // Wire the Enable/Disable Auto-Monitoring buttons for every class subtab.
  _wireAutoMonitoringButtons(document);
  spec.classes.forEach(function (c) {
    var prefix = (c.key === spec.primary)
      ? "intg-mon-streams-primary"
      : "intg-mon-streams-" + c.key;
    _intWireModalTabs(prefix);

    // Wire the Direct Polling toggle (if any) for this class so flipping it
    // reveals or hides the per-stream subtab wrapper without losing the
    // values inside. Classes without a toggle (standalone FortiGate's
    // FortiGate subtab, AD / Entra / WinSrv) render the wrapper always-on
    // and don't enter this branch.
    var toggleId = _directPollingToggleIdFor(integrationType, c.key);
    if (toggleId) {
      var streamsWrapId = "intg-mon-streams-wrap-" + (c.key === spec.primary ? "primary-" : "") + c.key;
      var toggleEl = document.getElementById(toggleId);
      var wrapEl   = document.getElementById(streamsWrapId);
      if (toggleEl && wrapEl) {
        // Closure captures the per-class toggle + wrap; outer scope captures
        // integrationType so the FMG-only "FortiGate Direct" vs "FortiManager
        // Proxy" relabel only fires for fortimanager integrations.
        (function (tEl, wEl, cls) {
          tEl.addEventListener("change", function () {
            wEl.style.display = tEl.checked ? "" : "none";
            // FMG's f-useDirect toggle changes the source label across every
            // stream-subtab dropdown in the whole modal (every class subtab
            // reads "FortiGate Direct" vs "FortiManager Proxy" from the same
            // toggle). Relabel everything inside the Monitoring tab; the
            // class-specific FortiSwitch / FortiAP toggles don't change any
            // labels so they skip this branch.
            if (cls === "fortigate" && integrationType === "fortimanager") {
              var monTab = document.getElementById("intg-mon-class-tabs") || document;
              // The class subtabs may have moved out of the tab-strip wrapper
              // depending on the modal HTML; fall back to walking from the
              // form root so every dropdown gets relabeled.
              var root = monTab.closest ? (monTab.closest("form, .modal, body") || document) : document;
              _relabelInheritOptions(root, tEl.checked);
            }
          });
        })(toggleEl, wrapEl, c.key);
      }
    }

    // FMG/FortiGate only: gate the Auto-Monitor Interfaces section on the
    // class's addAsMonitored checkbox. Auto-monitor pins fast-cadence
    // interfaces on newly-discovered assets, so it only makes sense when
    // those assets are actually being added as monitored. Each class
    // (fortigate / fortiswitch / fortiap) has its own checkbox + its own
    // wrapper id; classes without one (AD / Entra / WinSrv) skip this.
    var addAsMonitoredId = null;
    if (integrationType === "fortimanager" || integrationType === "fortigate") {
      if (c.key === "fortigate"   || c.key === "fortiswitch" || c.key === "fortiap") {
        addAsMonitoredId = "f-mon-" + c.key + "-addAsMonitored";
      }
    }
    if (addAsMonitoredId) {
      var automonWrapId = "f-mon-" + c.key + "-automon-wrap";
      var addEl = document.getElementById(addAsMonitoredId);
      var automonWrapEl = document.getElementById(automonWrapId);
      if (addEl && automonWrapEl) {
        addEl.addEventListener("change", function () {
          automonWrapEl.style.display = addEl.checked ? "" : "none";
        });
      }
    }
  });
  // Reactive per-stream credential rows (snmp/ssh/winrm) reveal based on the
  // polling-method dropdown's chosen value. Scoped to the Monitoring tab so
  // we don't touch dropdowns on other tabs. The Direct Polling toggle (above)
  // hides the entire stream subtab strip but doesn't unmount it — credrow
  // wiring stays valid when the wrapper flips back on.
  var monRoot = document.getElementById("intg-mon-class-tabs");
  if (monRoot && monRoot.closest) {
    monRoot = monRoot.closest("form, .modal-body, .modal, body") || document;
  }
  _wireStreamCredentialPickerVisibility(monRoot || document);
}

// Wires the per-asset-timeout warning indicator so the Cadence section
// surfaces "⚠ Below 500 ms" feedback while the operator types. Mirrors the
// same warning the assets-page Monitoring Settings modal renders.
function _wireProbeTimeoutWarning() {
  var input = document.getElementById("f-mon-probeTimeoutMs");
  var warn  = document.getElementById("f-mon-probeTimeoutMs-warn");
  if (!input || !warn) return;
  function check() {
    var v = parseInt(input.value, 10);
    warn.style.display = (Number.isFinite(v) && v > 0 && v < 500) ? "inline" : "none";
  }
  input.addEventListener("input", check);
  check();
}

// Reactive show/hide of the Discovery Defaults credential rows on the
// FortiGates / FortiSwitches / FortiAPs subtabs. The SNMP rows appear iff
// any of the four integration-tier polling dropdowns is set to SNMP; the
// SSH rows appear iff any is set to SSH. Run on initial render and on every
// dropdown change so the UI reflects the live selection without a save.
function _syncCredentialPickerVisibility() {
  var streamDefs = [
    { pollId: "f-mon-tier-responseTimePolling", mibWrapId: "f-mon-tier-responseTime-mib-wrap" },
    { pollId: "f-mon-tier-cpuMemoryPolling",    mibWrapId: "f-mon-tier-telemetry-mib-wrap"    },
    { pollId: "f-mon-tier-temperaturePolling",  mibWrapId: "f-mon-tier-temperature-mib-wrap"  },
    { pollId: "f-mon-tier-interfacesPolling",   mibWrapId: "f-mon-tier-interfaces-mib-wrap"   },
    { pollId: "f-mon-tier-lldpPolling",         mibWrapId: "f-mon-tier-lldp-mib-wrap"         },
    // Storage has no per-stream MIB picker (HOST-RESOURCES-MIB + vendor
    // fallback; nothing for the operator to choose), so mibWrapId is null.
    { pollId: "f-mon-tier-storagePolling",      mibWrapId: null                                },
  ];
  var anySnmp = false, anySsh = false;
  for (var i = 0; i < streamDefs.length; i++) {
    var el = document.getElementById(streamDefs[i].pollId);
    if (!el) continue;
    if (el.value === "snmp") anySnmp = true;
    if (el.value === "ssh")  anySsh  = true;
    // Show/hide the per-stream MIB sub-row for this stream. mibWrapId is null
    // for streams that don't carry a MIB picker (storage). Reveal as "" so the
    // form-group resumes its default block layout — using "flex" puts the
    // label, select, and hint paragraph on a single horizontal line which is
    // wrong for the per-class stream subtab's stacked layout.
    if (streamDefs[i].mibWrapId) {
      var mibWrap = document.getElementById(streamDefs[i].mibWrapId);
      if (mibWrap) mibWrap.style.display = (el.value === "snmp") ? "" : "none";
    }
  }
  var snmpRowIds = ["f-mon-credential-row", "f-mon-fortiswitch-credentialId-row", "f-mon-fortiap-credentialId-row"];
  var sshRowIds  = ["f-mon-credential-ssh-row", "f-mon-fortiswitch-sshCredentialId-row", "f-mon-fortiap-sshCredentialId-row"];
  function toggle(idList, show) {
    for (var j = 0; j < idList.length; j++) {
      var row = document.getElementById(idList[j]);
      if (row) row.style.display = show ? "" : "none";
    }
  }
  toggle(snmpRowIds, anySnmp);
  toggle(sshRowIds,  anySsh);
}

// Wires `change` listeners on the four integration-tier polling dropdowns so
// _syncCredentialPickerVisibility() runs whenever the operator picks a new
// method. Also runs once on initial mount so a freshly-opened modal lands in
// the correct state.
function _wireCredentialPickerVisibility() {
  var ids = ["f-mon-tier-responseTimePolling", "f-mon-tier-cpuMemoryPolling", "f-mon-tier-temperaturePolling", "f-mon-tier-interfacesPolling", "f-mon-tier-lldpPolling", "f-mon-tier-storagePolling"];
  var any = false;
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (!el) continue;
    el.addEventListener("change", _syncCredentialPickerVisibility);
    any = true;
  }
  if (any) _syncCredentialPickerVisibility();
}

// Call after monitorSettingsFormHTML() has been inserted into the DOM. Wires
// each subtab's auto-monitor card. Safe to call when integrationId is null
// (Create modal) — the cards still render but the live preview + aggregate
// list are suppressed inside the wiring helper.
function wireAutoMonitorCards(integrationId) {
  _wireAutoMonitorCard("f-mon-fortigate-amon-",   "fortigate",   integrationId || null);
  _wireAutoMonitorCard("f-mon-fortiswitch-amon-", "fortiswitch", integrationId || null);
  _wireAutoMonitorCard("f-mon-fortiap-amon-",     "fortiap",     integrationId || null);
}

// Reads the eight integration-tier cadence + retention fields from the
// Monitoring tab. Returns the flat MonitorTierSettings shape that the
// `/api/v1/monitor-settings/integration/:id` endpoint accepts. Out-of-range
// or empty values are dropped (server-side Zod re-validates anyway).
function _readIntegrationCadenceForm() {
  function n(name) {
    var el = document.getElementById("f-mon-" + name);
    if (!el) return undefined;
    var v = parseInt(el.value, 10);
    return Number.isFinite(v) ? v : undefined;
  }
  // systemInfoIntervalSeconds accepts a blank input meaning "follow the
  // integration's discovery pollInterval". Blank → null (not undefined) so
  // the server-side Zod (nullable on the integration tier) accepts it and
  // the resolver applies the pollInterval derivation.
  function nNullable(name) {
    var el = document.getElementById("f-mon-" + name);
    if (!el) return undefined;
    var raw = (el.value == null ? "" : String(el.value)).trim();
    if (raw === "") return null;
    var v = parseInt(raw, 10);
    return Number.isFinite(v) ? v : null;
  }
  var out = {
    intervalSeconds:           n("intervalSeconds"),
    failureThreshold:          n("failureThreshold"),
    probeTimeoutMs:            n("probeTimeoutMs"),
    cpuMemoryTimeoutMs:        n("cpuMemoryTimeoutMs"),
    temperatureTimeoutMs:      n("temperatureTimeoutMs"),
    systemInfoTimeoutMs:       n("systemInfoTimeoutMs"),
    cpuMemoryIntervalSeconds:  n("cpuMemoryIntervalSeconds"),
    temperatureIntervalSeconds: n("temperatureIntervalSeconds"),
    systemInfoIntervalSeconds: nNullable("systemInfoIntervalSeconds"),
    // Phase 1 carves LLDP + Storage out of systemInfo cadence: the inputs are
    // rendered + persisted, but the backend resolver still has them riding
    // systemInfoIntervalSeconds at runtime. Phase 2 lands the actual queue
    // split. Storing today keeps operator intent across the cutover.
    lldpIntervalSeconds:       n("lldpIntervalSeconds"),
    lldpTimeoutMs:             n("lldpTimeoutMs"),
    storageIntervalSeconds:    n("storageIntervalSeconds"),
    storageTimeoutMs:          n("storageTimeoutMs"),
  };
  // Slice 2 split telemetry into cpuMemory + temperature streams server-side
  // (TierSettingsSchema requires both). The Temperature inputs are now in
  // the form, but when the operator leaves them blank we mirror the cpuMemory
  // values so the save still satisfies the required-both shape.
  if (out.temperatureIntervalSeconds === undefined) {
    out.temperatureIntervalSeconds = out.cpuMemoryIntervalSeconds;
  }
  if (out.temperatureTimeoutMs === undefined) {
    out.temperatureTimeoutMs = out.cpuMemoryTimeoutMs;
  }
  Object.assign(out, _polarisReadPollingFourStream("f-mon-tier-"));
  Object.assign(out, _polarisReadMibFourStream("f-mon-tier-"));
  return out;
}

// Kept under the old name for the two existing call sites in the Add/Edit
// flows — both pass the result straight into setIntegration(). Identical
// shape, just renamed for clarity.
function getMonitorSettingsFromForm() {
  return _readIntegrationCadenceForm();
}

// Phase 2 — read the per-stream values from one class subtab into the
// `streams` shape the backend persists at config.<klass>Monitor.streams.
// `isPrimary` true reads from the primary subtab's legacy IDs
// (`f-mon-tier-<pollField>` / `f-mon-<intervalField>`); false reads from
// the secondary subtab's namespaced IDs
// (`f-mon-classecho-<klass>-tier-<pollField>` / `f-mon-classecho-<klass>-<intervalField>`).
// `includeStorage` matches `_streamsForClass` — FortiAP omits storage.
function _readClassStreamSubtabs(klass, isPrimary, includeStorage) {
  function id(suffix) {
    return isPrimary ? ("f-mon-" + suffix) : ("f-mon-classecho-" + klass + "-" + suffix);
  }
  function tierId(suffix) {
    return isPrimary ? ("f-mon-tier-" + suffix) : ("f-mon-classecho-" + klass + "-tier-" + suffix);
  }
  function pollVal(field) {
    var el = document.getElementById(tierId(field));
    if (!el) return undefined;
    var v = el.value || "";
    return v.length > 0 ? v : null;
  }
  function mibVal(streamKey) {
    var el = document.getElementById(tierId(streamKey + "Mib"));
    if (!el) return undefined;
    var v = el.value || "";
    return v.length > 0 ? v : null;
  }
  function numVal(field) {
    var el = document.getElementById(id(field));
    if (!el) return undefined;
    var raw = (el.value == null ? "" : String(el.value)).trim();
    if (raw === "") return null;
    var n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  // Reads the per-stream credential dropdown that matches the chosen polling
  // method. _classStreamSubtabHTML emits three sibling dropdowns per stream
  // (snmp/ssh/winrm), and only the one matching `polling` is visible to the
  // operator — the other two stay at "Inherit / none". When the class subtab
  // omitted per-stream credentials entirely (FortiSwitch + FortiAP via
  // showStreamCredentials: false), the lookup misses every credtype dropdown
  // and we return undefined so the streams cell stays free of a credentialId
  // key, letting the resolver fall back to the asset's monitorCredentialId
  // which discovery already stamps from the class-level credential picker.
  function credVal(pollField) {
    var pollEl = document.getElementById(tierId(pollField));
    if (!pollEl) return undefined;
    var method = pollEl.value || "";
    var credType = method === "snmp" ? "snmp"
      : method === "ssh"   ? "ssh"
      : method === "winrm" ? "winrm"
      : null;
    if (!credType) return null;
    var credEl = document.getElementById(tierId(pollField) + "-cred-" + credType);
    if (!credEl) return undefined; // row not rendered (showStreamCredentials=false)
    return credEl.value || null;
  }
  // Cell builder for one stream. Empty per-stream cells are still serialized
  // as `{polling:null, intervalSeconds:null, ...}` so the operator's explicit
  // "inherit at all 4 layers" choice persists across reload.
  function cell(opts) {
    var out = {};
    if (opts.polling          !== undefined) out.polling          = opts.polling;
    if (opts.credentialId     !== undefined) out.credentialId     = opts.credentialId;
    if (opts.intervalSeconds  !== undefined) out.intervalSeconds  = opts.intervalSeconds;
    if (opts.timeoutMs        !== undefined) out.timeoutMs        = opts.timeoutMs;
    if (opts.mibId            !== undefined) out.mibId            = opts.mibId;
    if (opts.failureThreshold !== undefined) out.failureThreshold = opts.failureThreshold;
    return out;
  }
  var streams = {
    responseTime: cell({
      polling:          pollVal("responseTimePolling"),
      credentialId:     credVal("responseTimePolling"),
      intervalSeconds:  numVal("intervalSeconds"),
      timeoutMs:        numVal("probeTimeoutMs"),
      mibId:            mibVal("responseTime"),
      failureThreshold: numVal("failureThreshold"),
    }),
    cpuMemory: cell({
      polling:         pollVal("cpuMemoryPolling"),
      credentialId:    credVal("cpuMemoryPolling"),
      intervalSeconds: numVal("cpuMemoryIntervalSeconds"),
      timeoutMs:       numVal("cpuMemoryTimeoutMs"),
      mibId:           mibVal("cpuMemory"),
    }),
    temperature: cell({
      polling:         pollVal("temperaturePolling"),
      credentialId:    credVal("temperaturePolling"),
      intervalSeconds: numVal("temperatureIntervalSeconds"),
      timeoutMs:       numVal("temperatureTimeoutMs"),
      mibId:           mibVal("temperature"),
    }),
    interfaces: cell({
      polling:         pollVal("interfacesPolling"),
      credentialId:    credVal("interfacesPolling"),
      intervalSeconds: numVal("systemInfoIntervalSeconds"),
      timeoutMs:       numVal("systemInfoTimeoutMs"),
      mibId:           mibVal("interfaces"),
    }),
    lldp: cell({
      polling:         pollVal("lldpPolling"),
      credentialId:    credVal("lldpPolling"),
      intervalSeconds: numVal("lldpIntervalSeconds"),
      timeoutMs:       numVal("lldpTimeoutMs"),
      mibId:           mibVal("lldp"),
    }),
  };
  if (includeStorage !== false) {
    streams.storage = cell({
      polling:         pollVal("storagePolling"),
      credentialId:    credVal("storagePolling"),
      intervalSeconds: numVal("storageIntervalSeconds"),
      timeoutMs:       numVal("storageTimeoutMs"),
    });
  }
  return streams;
}

// Reads the "enable direct polling" + SNMP/SSH credential pickers + the
// auto-Monitor flag + the auto-monitor-interfaces selection for one class
// (FortiSwitch or FortiAP). Returns null when the subtab didn't render.
// Both credential ids are persisted regardless of which row is currently
// visible — flipping the integration tier between SNMP and SSH should
// restore the prior selection rather than zero it out.
function _readClassMonitorBlock(prefix, opts) {
  var enabledEl    = document.getElementById(prefix + "enabled");
  var credEl       = document.getElementById(prefix + "credentialId");
  var sshCredEl    = document.getElementById(prefix + "sshCredentialId");
  var addMonEl     = document.getElementById(prefix + "addAsMonitored");
  if (!enabledEl || !credEl) return null;
  var ami = _readAutoMonitorInterfaces(prefix + "amon-");
  var out = {
    enabled: enabledEl.checked === true,
    snmpCredentialId: credEl.value || null,
    sshCredentialId:  sshCredEl ? (sshCredEl.value || null) : null,
    addAsMonitored: addMonEl ? addMonEl.checked === true : false,
    autoMonitorInterfaces: ami === undefined ? null : ami,
  };
  // Phase 2 per-class streams. `opts.klass` and `opts.isPrimary` drive the
  // ID lookup for the stream subtabs inside this class subtab. FortiAP omits
  // storage. When the caller doesn't pass these (legacy invocation), we skip
  // the streams field so backward-compat behavior is preserved.
  if (opts && opts.klass) {
    out.streams = _readClassStreamSubtabs(opts.klass, opts.isPrimary === true, opts.includeStorage !== false);
  }
  return out;
}

// FortiGate variant — only the auto-Monitor flag (no direct-polling toggle
// since FortiGates always have the integration source link stamped at
// discovery, which the resolver picks REST API for) plus the
// auto-monitor-interfaces selection.
function _readFortigateMonitorBlock(prefix, opts) {
  var addMonEl   = document.getElementById(prefix + "addAsMonitored");
  var pullEl     = document.getElementById(prefix + "pullSnmpLocation");
  var pushEl     = document.getElementById(prefix + "pushGeocodedCoords");
  var latEl      = document.getElementById(prefix + "latitudeMetavar");
  var lngEl      = document.getElementById(prefix + "longitudeMetavar");
  var addrEl     = document.getElementById(prefix + "addressMetavar");
  if (!addMonEl) return null;
  var ami = _readAutoMonitorInterfaces(prefix + "amon-");
  var addrVal = addrEl ? addrEl.value.trim() : "";
  // Push is allowed when there's a geocode source: SNMP pull OR a named address
  // metavar. Force pushGeocodedCoords false otherwise (checkbox is disabled in
  // that state). Metavar-name inputs are FMG-only — absent on standalone
  // FortiGate, where they fall back to the defaults (ignored by that path).
  var pushAllowed = (pullEl && pullEl.checked === true) || addrVal !== "";
  var out = {
    addAsMonitored: addMonEl.checked === true,
    autoMonitorInterfaces: ami === undefined ? null : ami,
    pullSnmpLocation: pullEl ? pullEl.checked === true : false,
    pushGeocodedCoords: (pushAllowed && pushEl) ? pushEl.checked === true : false,
    latitudeMetavar: (latEl && latEl.value.trim()) || "Latitude",
    longitudeMetavar: (lngEl && lngEl.value.trim()) || "Longitude",
    addressMetavar: addrVal,
  };
  // Phase 2: FortiGate subtab is the primary class subtab for FMG / standalone
  // FortiGate integrations. Read its per-stream values into config.fortigateMonitor.streams.
  if (opts && opts.klass) {
    out.streams = _readClassStreamSubtabs(opts.klass, opts.isPrimary === true, true);
  }
  return out;
}

// AD / Entra / Windows Server Workstations + Servers reader. No enabled
// toggle (those integrations always discover); no per-class snmp/ssh
// credentials (per-stream credentials inside `streams` carry that). The
// addAsMonitored flag is persisted but not yet consulted by AD/Entra/WinSrv
// discovery code — a backend follow-up will wire it. Auto-Monitor
// Interfaces is omitted by design (workstation/server endpoints don't have
// an authoritative interface roster to apply against).
function _readWorkstationServerMonitorBlock(prefix, opts) {
  var addMonEl = document.getElementById(prefix + "addAsMonitored");
  if (!addMonEl) return null;
  var out = {
    addAsMonitored: addMonEl.checked === true,
    autoMonitorInterfaces: null,
  };
  if (opts && opts.klass) {
    out.streams = _readClassStreamSubtabs(opts.klass, opts.isPrimary === true, true);
  }
  return out;
}

// Shared "Verbose debug logging" checkbox appended to the General tab of
// every integration type. When ticked, the next discovery cycle + every
// monitor worker job published for assets owned by this integration emits
// step-by-step structured logs to journalctl. Auto-disables after 30 minutes.
function verboseLoggingFormHTML(defaults) {
  var d = defaults || {};
  var checked = d.verboseLogging === true ? "checked" : "";

  // When currently enabled with a known start time, show a countdown so the
  // operator knows when it will auto-disable.
  var expiryHint = "";
  if (d.verboseLogging === true && d.verboseLoggingEnabledAt) {
    var enabledAt = new Date(d.verboseLoggingEnabledAt);
    var expiresAt = new Date(enabledAt.getTime() + 30 * 60 * 1000);
    var remainingMs = expiresAt - Date.now();
    if (remainingMs > 0) {
      var remainingMin = Math.ceil(remainingMs / 60000);
      expiryHint = " <span style=\"color:var(--color-warning,#ffb74d);font-size:0.78rem;font-weight:normal\">— auto-disables in " + remainingMin + " min</span>";
    } else {
      expiryHint = " <span style=\"color:var(--color-text-tertiary);font-size:0.78rem;font-weight:normal\">— auto-disabling shortly</span>";
    }
  }

  return "<hr style=\"border:none;border-top:1px solid var(--color-border);margin:1.25rem 0\">" +
    "<p style=\"font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.5rem\">Debug</p>" +
    "<div style=\"display:flex;align-items:flex-start;gap:0.55rem\">" +
      "<input type=\"checkbox\" id=\"f-verboseLogging\" " + checked + " style=\"margin-top:3px\">" +
      "<label for=\"f-verboseLogging\" style=\"margin:0\">" +
        "<strong>Verbose debug logging</strong>" + expiryHint + "<br>" +
        "<span style=\"font-size:0.8rem;color:var(--color-text-secondary)\">" +
        "Emits step-by-step discovery, sync, and worker pickup/finish logs to " +
        "journalctl for this integration. High log volume — flip on for diagnosis, " +
        "flip off when done. Auto-disables after 30 minutes. " +
        "Effective on the next discovery cycle / monitor tick; no restart needed." +
        "</span>" +
      "</label>" +
    "</div>";
}

// Read the verbose-logging checkbox from any integration form. Returns
// `false` when the checkbox isn't on the page (defensive — keeps the
// config valid for older modals that may not include it yet).
function readVerboseLoggingFromForm() {
  var el = document.getElementById("f-verboseLogging");
  return el ? el.checked === true : false;
}

function fortiManagerGeneralHTML(defaults) {
  var d = defaults || {};
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Production FortiManager"></div>' +
    '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:1rem;font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5">This integration is for <strong style="color:var(--color-text-primary)">on-premise FortiManager</strong> only (not FortiManager Cloud). Requires version <strong style="color:var(--color-text-primary)">7.4.7+</strong> or <strong style="color:var(--color-text-primary)">7.6.2+</strong>. Older versions do not support bearer token authentication.</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Connection Settings</p>' +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
      '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + escapeHtml(d.host || "") + '" placeholder="e.g. fmg.example.com"></div>' +
      '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + (d.port || 443) + '" min="1" max="65535" style="width:90px"></div>' +
    '</div>' +
    '<div class="form-group"><label>API User</label><input type="text" id="f-apiUser" value="' + escapeHtml(d.apiUser || "") + '" placeholder="e.g. api-admin"></div>' +
    '<div class="form-group"><label>API Token</label><input type="password" id="f-apiToken" value="' + (d.apiTokenPlaceholder ? "" : escapeHtml(d.apiToken || "")) + '" placeholder="' + (d.apiTokenPlaceholder || "Bearer token") + '"><p class="hint">Generate from FortiManager under System Settings &gt; Admin &gt; API Users</p></div>' +
    '<div class="form-group"><label>ADOM</label><input type="text" id="f-adom" value="' + escapeHtml(d.adom || "root") + '" placeholder="root"><p class="hint">Administrative Domain (leave as "root" for default)</p></div>' +
    '<div class="form-group"><label>Management Interface</label><input type="text" id="f-mgmtInterface" value="' + escapeHtml(d.mgmtInterface || "") + '" placeholder="e.g. port1, mgmt, loopback0"><p class="hint">Interface name used for FortiGate management traffic</p></div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-verifySsl" ' + (d.verifySsl ? "checked" : "") + ' style="width:auto">' +
      '<label for="f-verifySsl" style="margin:0">Verify SSL certificate</label>' +
    '</div>' +
    '<p class="hint" style="color:var(--color-warning,#d98c00)">Leave enabled. Disabling certificate verification lets a network attacker on the path intercept this connection and capture the API credentials. Disable only for a device with a self-signed certificate you cannot replace.</p>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + (d.enabled !== false ? "checked" : "") + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-autoDiscover" ' + (d.autoDiscover !== false ? "checked" : "") + ' style="width:auto">' +
      '<label for="f-autoDiscover" style="margin:0">Enable auto-discovery</label>' +
    '</div>' +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 12) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div><p class="hint">How often to automatically query for DHCP updates (1–24 hours)</p></div>' +
    verboseLoggingFormHTML(d);
}

function fortiManagerFiltersHTML(defaults) {
  var d = defaults || {};
  var ifaceInclude = d.interfaceInclude || [];
  var ifaceExclude = d.interfaceExclude || [];
  var ifaceMode = ifaceInclude.length > 0 ? "include" : "exclude";
  var ifaceList = ifaceMode === "include" ? ifaceInclude : ifaceExclude;
  var dhcpIncludeList = d.dhcpInclude || [];
  var dhcpExcludeList = d.dhcpExclude || [];
  var dhcpMode = dhcpIncludeList.length > 0 ? "include" : "exclude";
  var dhcpIfaces = dhcpMode === "include" ? dhcpIncludeList : dhcpExcludeList;
  var invMode = (d.inventoryIncludeInterfaces && d.inventoryIncludeInterfaces.length > 0) ? "include" : "exclude";
  var invIfaces = invMode === "include" ? (d.inventoryIncludeInterfaces || []) : (d.inventoryExcludeInterfaces || []);
  var devMode = (d.deviceInclude && d.deviceInclude.length > 0) ? "include" : "exclude";
  var devNames = devMode === "include" ? (d.deviceInclude || []) : (d.deviceExclude || []);
  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">FortiGate Device Filter</p>' +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-deviceMode" style="width:auto">' +
          '<option value="include"' + (devMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (devMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these managed FortiGates from all discovery queries</span>' +
      '</div>' +
      '<textarea id="f-deviceNames" rows="2" placeholder="One per line — e.g. FG-HQ-01&#10;FG-DC-*&#10;*-lab">' + escapeHtml(devNames.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to query all managed FortiGates. Matched against device name or hostname. Wildcards supported: <code>FG-*</code>, <code>*-lab</code>, <code>*dc*</code></p>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">DHCP Filter</p>' +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-dhcpMode" style="width:auto">' +
          '<option value="include"' + (dhcpMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (dhcpMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these interfaces from DHCP server scope discovery</span>' +
      '</div>' +
      '<textarea id="f-dhcpInterfaces" rows="2" placeholder="One per line — e.g. port1&#10;internal*&#10;*wan">' + escapeHtml(dhcpIfaces.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to include all interfaces. Applies to DHCP server scope discovery only. Wildcards supported: <code>port*</code>, <code>*wan</code>, <code>*mgmt*</code></p>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Interface Filter</p>' +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-ifaceMode" style="width:auto">' +
          '<option value="include"' + (ifaceMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (ifaceMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these interfaces from interface IP discovery</span>' +
      '</div>' +
      '<textarea id="f-ifaceInterfaces" rows="2" placeholder="One per line — e.g. port1&#10;internal*&#10;*wan">' + escapeHtml(ifaceList.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to include all interfaces. Applies to interface IP reservations only. Wildcards supported: <code>port*</code>, <code>*wan</code>, <code>*mgmt*</code></p>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Device Inventory</p>' +
    '<div class="form-group"><label>Interface Filter</label>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-inventoryMode" style="width:auto">' +
          '<option value="exclude"' + (invMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
          '<option value="include"' + (invMode === "include" ? " selected" : "") + '>Include</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">devices seen on these interfaces from asset discovery</span>' +
      '</div>' +
      '<textarea id="f-inventoryInterfaces" rows="2" placeholder="One per line — e.g. lan&#10;wifi*&#10;*guest">' + escapeHtml(invIfaces.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to include all interfaces. Wildcards supported: <code>port*</code>, <code>*lan</code>, <code>*mgmt*</code></p>' +
    '</div>';
}

// Flat-form fallback for any caller that wants the full FMG form in a single
// string. The Add and Edit modals split it into General + Filters tabs and
// call the two helpers above directly.
function fortiManagerFormHTML(defaults) {
  return fortiManagerGeneralHTML(defaults) + fortiManagerFiltersHTML(defaults);
}

function getFormConfig() {
  var port = document.getElementById("f-port").value;
  var dhcpMode = document.getElementById("f-dhcpMode").value;
  var dhcpIfaces = linesToArray("f-dhcpInterfaces");
  var ifaceMode = document.getElementById("f-ifaceMode").value;
  var ifaceIfaces = linesToArray("f-ifaceInterfaces");
  var invMode = document.getElementById("f-inventoryMode").value;
  var invIfaces = linesToArray("f-inventoryInterfaces");
  var devMode = document.getElementById("f-deviceMode").value;
  var devNames = linesToArray("f-deviceNames");
  // UI checkbox is inverted vs. the on-disk field: checked = direct, unchecked = proxy.
  var useDirect = document.getElementById("f-useDirect").checked;
  var useProxy = !useDirect;
  return {
    host: val("f-host"),
    port: port ? parseInt(port, 10) : 443,
    apiUser: val("f-apiUser"),
    apiToken: val("f-apiToken"),
    adom: val("f-adom") || "root",
    verifySsl: document.getElementById("f-verifySsl").checked,
    mgmtInterface: val("f-mgmtInterface") || "",
    dhcpInclude: dhcpMode === "include" ? dhcpIfaces : [],
    dhcpExclude: dhcpMode === "exclude" ? dhcpIfaces : [],
    interfaceInclude: ifaceMode === "include" ? ifaceIfaces : [],
    interfaceExclude: ifaceMode === "exclude" ? ifaceIfaces : [],
    inventoryExcludeInterfaces: invMode === "exclude" ? invIfaces : [],
    inventoryIncludeInterfaces: invMode === "include" ? invIfaces : [],
    deviceInclude: devMode === "include" ? devNames : [],
    deviceExclude: devMode === "exclude" ? devNames : [],
    discoveryParallelism: (function () { var v = parseInt(val("f-discoveryParallelism"), 10); return Number.isFinite(v) && v >= 1 && v <= 20 ? v : (useProxy ? 1 : 5); })(),
    useProxy: useProxy,
    fortigateApiUser: val("f-fortigateApiUser"),
    fortigateApiToken: val("f-fortigateApiToken"),
    fortigateVerifySsl: (function () { var el = document.getElementById("f-fortigateVerifySsl"); return el ? el.checked : false; })(),
    verboseLogging: readVerboseLoggingFromForm(),
  };
}

// Standalone FortiGate "General" tab — connection settings + name + auto-
// discovery scheduling. Mirrors `fortiManagerGeneralHTML`'s split: filters
// move to a separate tab so the modal layout matches FMG.
function fortiGateGeneralHTML(defaults) {
  var d = defaults || {};
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Branch Office FortiGate"></div>' +
    '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:1rem;font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5">This integration connects <strong style="color:var(--color-text-primary)">directly to a standalone FortiGate</strong> (not managed by FortiManager). Requires an API administrator token created under <strong style="color:var(--color-text-primary)">System &gt; Administrators &gt; REST API Admin</strong>.</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Connection Settings</p>' +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
      '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + escapeHtml(d.host || "") + '" placeholder="e.g. fortigate.example.com"></div>' +
      '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + (d.port || 443) + '" min="1" max="65535" style="width:90px"></div>' +
    '</div>' +
    '<div class="form-group"><label>API User</label><input type="text" id="f-apiUser" value="' + escapeHtml(d.apiUser || "") + '" placeholder="e.g. api-admin"></div>' +
    '<div class="form-group"><label>API Token</label><input type="password" id="f-apiToken" value="' + (d.apiTokenPlaceholder ? "" : escapeHtml(d.apiToken || "")) + '" placeholder="' + (d.apiTokenPlaceholder || "Bearer token") + '"><p class="hint">Generate under System &gt; Administrators &gt; Create New &gt; REST API Admin</p></div>' +
    '<div class="form-group"><label>VDOM</label><input type="text" id="f-vdom" value="' + escapeHtml(d.vdom || "root") + '" placeholder="root"><p class="hint">Virtual Domain (leave as "root" for default)</p></div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-verifySsl" ' + (d.verifySsl ? "checked" : "") + ' style="width:auto">' +
      '<label for="f-verifySsl" style="margin:0">Verify SSL certificate</label>' +
    '</div>' +
    '<p class="hint" style="color:var(--color-warning,#d98c00)">Leave enabled. Disabling certificate verification lets a network attacker on the path intercept this connection and capture the API credentials. Disable only for a device with a self-signed certificate you cannot replace.</p>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + (d.enabled !== false ? "checked" : "") + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-autoDiscover" ' + (d.autoDiscover !== false ? "checked" : "") + ' style="width:auto">' +
      '<label for="f-autoDiscover" style="margin:0">Enable auto-discovery</label>' +
    '</div>' +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 12) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div><p class="hint">How often to automatically query for DHCP updates (1–24 hours)</p></div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">FortiGate Settings</p>' +
    '<div class="form-group"><label>Management Interface</label><input type="text" id="f-mgmtInterface" value="' + escapeHtml(d.mgmtInterface || "") + '" placeholder="e.g. port1, mgmt, loopback0"><p class="hint">Interface name used for FortiGate management traffic</p></div>' +
    verboseLoggingFormHTML(d);
}

// Standalone FortiGate "Filters" tab — DHCP server scope, interface IP
// reservation, and device inventory filters. Mirrors `fortiManagerFiltersHTML`
// minus the FortiGate device-name filter (single-device integration).
function fortiGateFiltersHTML(defaults) {
  var d = defaults || {};
  var dhcpMode = (d.dhcpInclude && d.dhcpInclude.length > 0) ? "include" : "exclude";
  var dhcpIfaces = dhcpMode === "include" ? (d.dhcpInclude || []) : (d.dhcpExclude || []);
  var ifaceMode = (d.interfaceInclude && d.interfaceInclude.length > 0) ? "include" : "exclude";
  var ifaceList = ifaceMode === "include" ? (d.interfaceInclude || []) : (d.interfaceExclude || []);
  var invMode = (d.inventoryIncludeInterfaces && d.inventoryIncludeInterfaces.length > 0) ? "include" : "exclude";
  var invIfaces = invMode === "include" ? (d.inventoryIncludeInterfaces || []) : (d.inventoryExcludeInterfaces || []);
  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">DHCP Filter</p>' +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-dhcpMode" style="width:auto">' +
          '<option value="include"' + (dhcpMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (dhcpMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these interfaces from DHCP server scope discovery</span>' +
      '</div>' +
      '<textarea id="f-dhcpInterfaces" rows="2" placeholder="One per line — e.g. port1&#10;internal*&#10;*wan">' + escapeHtml(dhcpIfaces.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to include all interfaces. Applies to DHCP server scope discovery only. Wildcards supported: <code>port*</code>, <code>*wan</code>, <code>*mgmt*</code></p>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Interface Filter</p>' +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-ifaceMode" style="width:auto">' +
          '<option value="include"' + (ifaceMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (ifaceMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these interfaces from interface IP discovery</span>' +
      '</div>' +
      '<textarea id="f-ifaceInterfaces" rows="2" placeholder="One per line — e.g. port1&#10;internal*&#10;*wan">' + escapeHtml(ifaceList.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to include all interfaces. Applies to interface IP reservations only. Wildcards supported: <code>port*</code>, <code>*wan</code>, <code>*mgmt*</code></p>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Device Inventory</p>' +
    '<div class="form-group"><label>Interface Filter</label>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-inventoryMode" style="width:auto">' +
          '<option value="exclude"' + (invMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
          '<option value="include"' + (invMode === "include" ? " selected" : "") + '>Include</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">devices seen on these interfaces from asset discovery</span>' +
      '</div>' +
      '<textarea id="f-inventoryInterfaces" rows="2" placeholder="One per line — e.g. lan&#10;wifi*&#10;*guest">' + escapeHtml(invIfaces.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to include all interfaces. Wildcards supported: <code>port*</code>, <code>*lan</code>, <code>*mgmt*</code></p>' +
    '</div>';
}

// Flat-form fallback for any caller that wants the full FortiGate form in a
// single string. Add and Edit modals split it into General + Filters tabs and
// call the two helpers above directly (matches the FMG rendering pattern).
function fortiGateFormHTML(defaults) {
  return fortiGateGeneralHTML(defaults) + fortiGateFiltersHTML(defaults);
}

function getFgtFormConfig() {
  var port = document.getElementById("f-port").value;
  var dhcpMode = document.getElementById("f-dhcpMode").value;
  var dhcpIfaces = linesToArray("f-dhcpInterfaces");
  var ifaceMode = document.getElementById("f-ifaceMode").value;
  var ifaceIfaces = linesToArray("f-ifaceInterfaces");
  var invMode = document.getElementById("f-inventoryMode").value;
  var invIfaces = linesToArray("f-inventoryInterfaces");
  return {
    host: val("f-host"),
    port: port ? parseInt(port, 10) : 443,
    apiUser: val("f-apiUser"),
    apiToken: val("f-apiToken"),
    vdom: val("f-vdom") || "root",
    verifySsl: document.getElementById("f-verifySsl").checked,
    mgmtInterface: val("f-mgmtInterface") || "",
    dhcpInclude: dhcpMode === "include" ? dhcpIfaces : [],
    dhcpExclude: dhcpMode === "exclude" ? dhcpIfaces : [],
    interfaceInclude: ifaceMode === "include" ? ifaceIfaces : [],
    interfaceExclude: ifaceMode === "exclude" ? ifaceIfaces : [],
    inventoryExcludeInterfaces: invMode === "exclude" ? invIfaces : [],
    inventoryIncludeInterfaces: invMode === "include" ? invIfaces : [],
    verboseLogging: readVerboseLoggingFromForm(),
  };
}

function windowsServerFormHTML(defaults) {
  var d = defaults || {};
  var sslChecked = d.useSsl ? "checked" : "";
  var enabledChecked = d.enabled !== false ? "checked" : "";
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. DC1 DHCP Server"></div>' +
    '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:1rem;font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5">Connects to <strong style="color:var(--color-text-primary)">Windows Server DHCP</strong> via WinRM (PowerShell remoting). Requires WinRM enabled on the target server (port <strong style="color:var(--color-text-primary)">5985</strong> HTTP or <strong style="color:var(--color-text-primary)">5986</strong> HTTPS).</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Connection Settings</p>' +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
      '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + escapeHtml(d.host || "") + '" placeholder="e.g. dhcp-server.example.com"></div>' +
      '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + (d.port || 5985) + '" min="1" max="65535" style="width:90px"></div>' +
    '</div>' +
    '<div class="form-group"><label>Username *</label><input type="text" id="f-username" value="' + escapeHtml(d.username || "") + '" placeholder="e.g. Administrator"></div>' +
    '<div class="form-group"><label>Password *</label><input type="password" id="f-password" value="' + (d.passwordPlaceholder ? "" : escapeHtml(d.password || "")) + '" placeholder="' + (d.passwordPlaceholder || "Password") + '"></div>' +
    '<div class="form-group"><label>Domain</label><input type="text" id="f-domain" value="' + escapeHtml(d.domain || "") + '" placeholder="e.g. CORP (optional)"><p class="hint">Active Directory domain for authentication (leave empty for local accounts)</p></div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-useSsl" ' + sslChecked + ' style="width:auto">' +
      '<label for="f-useSsl" style="margin:0">Use SSL (HTTPS / port 5986)</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + enabledChecked + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 4) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div><p class="hint">How often to automatically query for DHCP updates (1–24 hours)</p></div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">DHCP Scope Filtering</p>' +
    '<div class="form-group"><label>Include Scopes</label><textarea id="f-dhcpInclude" rows="2" placeholder="One per line — scope name or ID&#10;e.g. 10.0.1.0">' + escapeHtml((d.dhcpInclude || []).join("\n")) + '</textarea><p class="hint">Only sync these DHCP scopes (leave empty to sync all)</p></div>' +
    '<div class="form-group"><label>Exclude Scopes</label><textarea id="f-dhcpExclude" rows="2" placeholder="One per line — scope name or ID&#10;e.g. lab-scope">' + escapeHtml((d.dhcpExclude || []).join("\n")) + '</textarea><p class="hint">Skip these DHCP scopes when syncing</p></div>' +
    verboseLoggingFormHTML(d);
}

function getWinFormConfig() {
  var port = document.getElementById("f-port").value;
  return {
    host: val("f-host"),
    port: port ? parseInt(port, 10) : 5985,
    username: val("f-username"),
    password: val("f-password"),
    useSsl: document.getElementById("f-useSsl").checked,
    domain: val("f-domain"),
    dhcpInclude: linesToArray("f-dhcpInclude"),
    dhcpExclude: linesToArray("f-dhcpExclude"),
    verboseLogging: readVerboseLoggingFromForm(),
  };
}

function entraIdFormHTML(defaults) {
  var d = defaults || {};
  var devMode = (d.deviceInclude && d.deviceInclude.length > 0) ? "include" : "exclude";
  var devNames = devMode === "include" ? (d.deviceInclude || []) : (d.deviceExclude || []);
  var intuneChecked = d.enableIntune ? "checked" : "";
  var includeDisabled = d.includeDisabled !== false;
  var enabledChecked = d.enabled !== false ? "checked" : "";
  var autoChecked = d.autoDiscover !== false ? "checked" : "";
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Corporate Entra ID"></div>' +
    '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:1rem;font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5">Connects to <strong style="color:var(--color-text-primary)">Microsoft Entra ID</strong> (Azure AD) via an app registration with client-credentials flow. Requires <strong style="color:var(--color-text-primary)">Device.Read.All</strong> (application); add <strong style="color:var(--color-text-primary)">DeviceManagementManagedDevices.Read.All</strong> if Intune sync is enabled. Grant admin consent in the Azure portal.</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Connection Settings</p>' +
    '<div class="form-group"><label>Tenant ID *</label><input type="text" id="f-tenantId" value="' + escapeHtml(d.tenantId || "") + '" placeholder="e.g. 00000000-0000-0000-0000-000000000000"><p class="hint">Directory (tenant) ID from Azure portal &gt; Entra ID &gt; Overview</p></div>' +
    '<div class="form-group"><label>Client ID *</label><input type="text" id="f-clientId" value="' + escapeHtml(d.clientId || "") + '" placeholder="e.g. 00000000-0000-0000-0000-000000000000"><p class="hint">Application (client) ID from App Registrations &gt; Overview</p></div>' +
    '<div class="form-group"><label>Client Secret *</label><input type="password" id="f-clientSecret" value="' + (d.clientSecretPlaceholder ? "" : escapeHtml(d.clientSecret || "")) + '" placeholder="' + (d.clientSecretPlaceholder || "Secret value") + '"><p class="hint">Generate under App Registrations &gt; Certificates &amp; secrets &gt; New client secret (save the Value, not the ID)</p></div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enableIntune" ' + intuneChecked + ' style="width:auto">' +
      '<label for="f-enableIntune" style="margin:0">Enable Intune device sync</label>' +
    '</div>' +
    '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-top:0.5rem;margin-bottom:1rem;font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5">When on, overlays richer data (serial, MAC, model, primary user, compliance) from <code>/deviceManagement/managedDevices</code> onto Entra devices. Requires an Intune license and the extra Graph permission above.</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-includeDisabled" ' + (includeDisabled ? "checked" : "") + ' style="width:auto">' +
      '<label for="f-includeDisabled" style="margin:0">Include disabled devices (as <em>disabled</em>)</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + enabledChecked + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-autoDiscover" ' + autoChecked + ' style="width:auto">' +
      '<label for="f-autoDiscover" style="margin:0">Enable auto-discovery</label>' +
    '</div>' +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 12) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div><p class="hint">How often to automatically query Graph for device updates (1–24 hours)</p></div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Device Filter</p>' +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-deviceMode" style="width:auto">' +
          '<option value="include"' + (devMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (devMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these devices by display name</span>' +
      '</div>' +
      '<textarea id="f-deviceNames" rows="2" placeholder="One per line — e.g. LAPTOP-*&#10;SRV-HQ-*&#10;*-lab">' + escapeHtml(devNames.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to sync every device. Wildcards supported: <code>LAPTOP-*</code>, <code>*-lab</code>, <code>*pc*</code></p>' +
    '</div>' +
    verboseLoggingFormHTML(d);
}

function getEntraFormConfig() {
  var devMode = document.getElementById("f-deviceMode").value;
  var devNames = linesToArray("f-deviceNames");
  return {
    tenantId: val("f-tenantId"),
    clientId: val("f-clientId"),
    clientSecret: val("f-clientSecret"),
    enableIntune: document.getElementById("f-enableIntune").checked,
    includeDisabled: document.getElementById("f-includeDisabled").checked,
    deviceInclude: devMode === "include" ? devNames : [],
    deviceExclude: devMode === "exclude" ? devNames : [],
    verboseLogging: readVerboseLoggingFromForm(),
  };
}

function activeDirectoryFormHTML(defaults) {
  var d = defaults || {};
  var useLdaps = d.useLdaps !== false;
  var verifyTls = !!d.verifyTls;
  var enabledChecked = d.enabled !== false ? "checked" : "";
  var autoChecked = d.autoDiscover !== false ? "checked" : "";
  var scope = d.searchScope || "sub";
  var includeDisabled = d.includeDisabled !== false;
  var devMode = (d.ouInclude && d.ouInclude.length > 0) ? "include" : "exclude";
  var devNames = devMode === "include" ? (d.ouInclude || []) : (d.ouExclude || []);
  var defaultPort = useLdaps ? 636 : 389;
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Corp AD — DC01"></div>' +
    '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:1rem;font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5">Connects to an <strong style="color:var(--color-text-primary)">on-premise Active Directory</strong> domain controller via LDAP simple bind. Produces assets only. Hybrid-joined devices are cross-linked to the Entra ID integration via on-prem SID, so the same device never appears twice.</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Connection Settings</p>' +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
      '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + escapeHtml(d.host || "") + '" placeholder="e.g. dc01.corp.local"></div>' +
      '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + (d.port || defaultPort) + '" min="1" max="65535" style="width:90px"></div>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-useLdaps" ' + (useLdaps ? "checked" : "") + ' style="width:auto">' +
      '<label for="f-useLdaps" style="margin:0">Use LDAPS (TLS)</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-verifyTls" ' + (verifyTls ? "checked" : "") + ' style="width:auto">' +
      '<label for="f-verifyTls" style="margin:0">Verify TLS certificate</label>' +
    '</div>' +
    '<p class="hint" style="color:var(--color-warning,#d98c00)">Leave enabled. Disabling certificate verification lets a network attacker intercept the LDAPS connection and capture the bind credentials. Disable only for a domain controller with a self-signed certificate you cannot replace.</p>' +
    '<div class="form-group"><label>Bind DN *</label><input type="text" id="f-bindDn" value="' + escapeHtml(d.bindDn || "") + '" placeholder="e.g. CN=polaris-svc,OU=Service Accounts,DC=corp,DC=local"><p class="hint">Distinguished name of the bind account. A read-only domain user is sufficient.</p></div>' +
    '<div class="form-group"><label>Bind Password *</label><input type="password" id="f-bindPassword" value="' + (d.bindPasswordPlaceholder ? "" : escapeHtml(d.bindPassword || "")) + '" placeholder="' + (d.bindPasswordPlaceholder || "Password") + '"></div>' +
    '<div class="form-group"><label>Base DN *</label><input type="text" id="f-baseDn" value="' + escapeHtml(d.baseDn || "") + '" placeholder="e.g. DC=corp,DC=local"><p class="hint">Subtree to search for computer objects. Narrow this (e.g. <code>OU=Workstations,DC=corp,DC=local</code>) if you only want part of the directory.</p></div>' +
    '<div class="form-group"><label>Search Scope</label>' +
      '<select id="f-searchScope" style="width:auto">' +
        '<option value="sub"' + (scope === "sub" ? " selected" : "") + '>Subtree (recursive)</option>' +
        '<option value="one"' + (scope === "one" ? " selected" : "") + '>One level (immediate children only)</option>' +
      '</select>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-includeDisabled" ' + (includeDisabled ? "checked" : "") + ' style="width:auto">' +
      '<label for="f-includeDisabled" style="margin:0">Include disabled computer accounts (as <em>disabled</em>)</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + enabledChecked + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-autoDiscover" ' + autoChecked + ' style="width:auto">' +
      '<label for="f-autoDiscover" style="margin:0">Enable auto-discovery</label>' +
    '</div>' +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 12) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div><p class="hint">How often to re-query AD for device updates (1–24 hours)</p></div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">OU Filter</p>' +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-deviceMode" style="width:auto">' +
          '<option value="include"' + (devMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (devMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these OUs (matched against distinguished name)</span>' +
      '</div>' +
      '<textarea id="f-deviceNames" rows="3" placeholder="One per line — e.g.&#10;*OU=Workstations*&#10;*OU=Servers,OU=HQ*">' + escapeHtml(devNames.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to sync all computers under the base DN. Each line is matched against the computer\'s full distinguished name. Wildcards: <code>*OU=Workstations*</code>, <code>*OU=Servers,OU=HQ*</code></p>' +
    '</div>' +
    verboseLoggingFormHTML(d);
}

function getAdFormConfig() {
  var port = document.getElementById("f-port").value;
  var devMode = document.getElementById("f-deviceMode").value;
  var devNames = linesToArray("f-deviceNames");
  return {
    host: val("f-host"),
    port: port ? parseInt(port, 10) : 636,
    useLdaps: document.getElementById("f-useLdaps").checked,
    verifyTls: document.getElementById("f-verifyTls").checked,
    bindDn: val("f-bindDn"),
    bindPassword: val("f-bindPassword"),
    baseDn: val("f-baseDn"),
    searchScope: document.getElementById("f-searchScope").value === "one" ? "one" : "sub",
    includeDisabled: document.getElementById("f-includeDisabled").checked,
    ouInclude: devMode === "include" ? devNames : [],
    ouExclude: devMode === "exclude" ? devNames : [],
    verboseLogging: readVerboseLoggingFromForm(),
  };
}

function linesToArray(id) {
  return document.getElementById(id).value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
}

function showTypePicker() {
  var body =
    '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">Select the type of integration to add:</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
      '<button class="btn btn-secondary" id="pick-fmg" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px">' +
        '<strong>FortiManager</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Multi-FortiGate via JSON-RPC</span>' +
      '</button>' +
      '<button class="btn btn-secondary" id="pick-fgt" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px">' +
        '<strong>FortiGate</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Standalone FortiGate via REST</span>' +
      '</button>' +
      '<button class="btn btn-secondary" id="pick-win" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px">' +
        '<strong>Windows Server</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">DHCP scopes via WinRM</span>' +
      '</button>' +
      '<button class="btn btn-secondary" id="pick-entra" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px">' +
        '<strong>Microsoft Entra ID</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Devices via Microsoft Graph</span>' +
      '</button>' +
      '<button class="btn btn-secondary" id="pick-ad" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px">' +
        '<strong>Active Directory</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">On-prem computer objects via LDAP</span>' +
      '</button>' +
    '</div>';
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>';
  openModal("Add Integration", body, footer);
  document.getElementById("pick-fmg").addEventListener("click", function () { closeModal(); openCreateModal("fortimanager"); });
  document.getElementById("pick-fgt").addEventListener("click", function () { closeModal(); openCreateModal("fortigate"); });
  document.getElementById("pick-win").addEventListener("click", function () { closeModal(); openCreateModal("windowsserver"); });
  document.getElementById("pick-entra").addEventListener("click", function () { closeModal(); openCreateModal("entraid"); });
  document.getElementById("pick-ad").addEventListener("click", function () { closeModal(); openCreateModal("activedirectory"); });
}

function _formHTMLForType(type, defaults) {
  if (type === "windowsserver") return windowsServerFormHTML(defaults);
  if (type === "fortigate") return fortiGateFormHTML(defaults);
  if (type === "entraid") return entraIdFormHTML(defaults);
  if (type === "activedirectory") return activeDirectoryFormHTML(defaults);
  return fortiManagerFormHTML(defaults);
}

function _formConfigForType(type) {
  if (type === "windowsserver") return getWinFormConfig();
  if (type === "fortigate") return getFgtFormConfig();
  if (type === "entraid") return getEntraFormConfig();
  if (type === "activedirectory") return getAdFormConfig();
  return getFormConfig();
}

// Reads the SNMP override picker (FMG/FortiGate Monitoring tab). Returns the
// chosen credential id, an empty string to explicitly clear it, or undefined
// when the picker isn't on screen — caller decides whether to merge.
function _readMonitorCredentialId() {
  var el = document.getElementById("f-mon-credential");
  if (!el) return undefined;
  return el.value || "";
}

// Reads the SSH override picker. Same semantics as _readMonitorCredentialId
// but for the parallel SSH credential row in integrationMonitorOverrideHTML.
function _readSshCredentialId() {
  var el = document.getElementById("f-mon-credential-ssh");
  if (!el) return undefined;
  return el.value || "";
}

function _titleForType(type, action) {
  var product =
    type === "windowsserver" ? "Windows Server" :
    type === "fortigate" ? "FortiGate" :
    type === "entraid" ? "Entra ID" :
    type === "activedirectory" ? "Active Directory" :
    "FortiManager";
  return action + " " + product + " Integration";
}

async function openCreateModal(type) {
  type = type || "fortimanager";
  var isWin = type === "windowsserver";
  var isEntra = type === "entraid";
  var isAd = type === "activedirectory";
  var isFmg = type === "fortimanager";
  var isFgt = type === "fortigate";
  var isAd  = type === "activedirectory";
  var isEntra = type === "entraid";
  var isWin = type === "windowsserver";
  var title = _titleForType(type, "Add");
  // FMG / FortiGate / AD / Entra / WindowsServer integrations all expose a
  // Monitoring tab. FMG and FortiGate also get the Discovery Defaults
  // section (per-class addAsMonitored / autoMonitorInterfaces / per-stream
  // transport overrides). All five seed their initial Monitoring tab from
  // the manual tier — closest equivalent to "fleet defaults" until the
  // operator saves the new integration's own tier.
  var body;
  if (isFmg || isFgt) {
    var monSettings = {};
    var creds = [];
    // No integration ID yet on the Add flow — seed the form from the manual
    // tier (closest equivalent to "fleet defaults"). After create, the new
    // integration's tier gets written via setIntegration() below.
    try {
      var manual = await api.monitorSettings.getManual();
      monSettings = manual || {};
    } catch (e) { /* fall back to defaults */ }
    try { var credResp = await api.credentials.list(); creds = Array.isArray(credResp) ? credResp : []; } catch (e) { /* picker just shows defaults */ }
    // Seed TLS-verify ON for NEW integrations so the checkbox renders checked,
    // matching the verify-by-default backend schema (2026-06-03 review, M1).
    // Edit flow passes the stored config, so existing rows are unaffected.
    var generalHtml = isFmg
      ? fortiManagerGeneralHTML({ verifySsl: true, fortigateVerifySsl: true })
      : fortiGateGeneralHTML({ verifySsl: true });
    var filtersHtml = isFmg ? fortiManagerFiltersHTML({}) : fortiGateFiltersHTML({});
    var addTabs = [
      { key: "general", label: "General", html: generalHtml },
      { key: "filters", label: "Filters", html: filtersHtml },
    ];
    addTabs.push({ key: "monitoring", label: "Monitoring", html: monitorSettingsFormHTML(monSettings, { snmpCredentials: creds, monitorCredentialId: null, integrationId: null, integrationType: type, integrationName: "", fmgDefaults: {} }) });
    // FMG and standalone FortiGate share the Reservation Push and Quarantine
    // Push tabs. Both default to off. The "useProxy=true" flag in the form
    // helpers labels the active mode for FMG; standalone FortiGate ignores it
    // and always uses direct REST with the integration's own credentials —
    // pass true so the FMG copy doesn't render an irrelevant "direct" warning.
    addTabs.push({ key: "push", label: "DHCP Push", html: reservationPushFormHTML(false, true) });
    addTabs.push({ key: "quarantine-push", label: "Quarantine Push", html: quarantinePushFormHTML(false, true) });
    // SD-WAN tab (FMG + standalone FortiGate). Default off.
    addTabs.push({ key: "sdwan", label: "SD-WAN", html: sdwanFormHTML(false) });
    // Geographic Location tab (FMG + standalone FortiGate). Carries the
    // pull-from-SNMP and push-geocoded-coords toggles previously surfaced
    // inside Monitoring → FortiGate. DOM ids preserved so the existing save
    // path (`_readFortigateMonitorBlock`) keeps finding them.
    addTabs.push({ key: "geographicLocation", label: "Geographic Location", html: geographicLocationFormHTML(false, false, "Latitude", "Longitude", "", type) });
    body = _intRenderTabbedBody("intg-edit", addTabs);
  } else if (isAd || isEntra || isWin) {
    var addMonSettings = {};
    try {
      var addManual = await api.monitorSettings.getManual();
      addMonSettings = addManual || {};
    } catch (e) { /* fall back to defaults */ }
    var addNonFortinetTabs = [
      { key: "general",    label: "General",    html: _formHTMLForType(type, isAd ? { verifyTls: true } : {}) },
      { key: "monitoring", label: "Monitoring", html: monitorSettingsFormHTML(addMonSettings, {
        integrationId:   null,
        integrationType: type,
        integrationName: "",
      }) },
    ];
    body = _intRenderTabbedBody("intg-edit", addNonFortinetTabs);
  } else {
    body = _formHTMLForType(type, {});
  }
  var footer = '<button class="btn btn-secondary" id="btn-test-new">Test Connection</button>' +
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">Create</button>';
  openModal(title, body, footer, { wide: true });
  if (isFmg || isFgt) {
    _intWireModalTabs("intg-edit");
    _wireMonitoringTabSubtabs(type);
    wireAutoMonitorCards(null);
    _wireProbeTimeoutWarning();
    _wireCredentialPickerVisibility();
    _populateUploadedMibsInDropdowns();
  } else if (isAd || isEntra || isWin) {
    _intWireModalTabs("intg-edit");
    _wireMonitoringTabSubtabs(type);
    _wireProbeTimeoutWarning();
  }

  // Tracks whether the pre-save Test Connection succeeded against the
  // current form data. Used after Create to inherit the result onto the new
  // integration so the Discover button isn't gated on a redundant re-test.
  var _modalTestOk = false;

  document.getElementById("btn-test-new").addEventListener("click", async function () {
    var btn = this;
    if (isEntra) {
      if (!val("f-tenantId") || !val("f-clientId") || !val("f-clientSecret")) { showToast("Fill in tenant ID, client ID, and client secret first", "error"); return; }
    } else if (isAd) {
      if (!val("f-host") || !val("f-bindDn") || !val("f-bindPassword") || !val("f-baseDn")) { showToast("Fill in host, bind DN, bind password, and base DN first", "error"); return; }
    } else if (isWin) {
      if (!val("f-host") || !val("f-username")) { showToast("Fill in host and username first", "error"); return; }
    } else {
      if (!val("f-host") || !val("f-apiToken")) { showToast("Fill in host and API token first", "error"); return; }
    }
    btn.disabled = true;
    btn.textContent = "Testing...";
    try {
      var result = await api.integrations.testNew({
        type: type,
        name: val("f-name") || "Test",
        config: _formConfigForType(type),
      });
      _modalTestOk = !!result.ok;
      showToast(result.message, result.ok ? "success" : "error");
    } catch (err) {
      _modalTestOk = false;
      if (err.name === "AbortError") { showToast("Test aborted", "error"); }
      else { showToast(err.message, "error"); }
    } finally {
      btn.disabled = false;
      btn.textContent = "Test Connection";
    }
  });

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    btn.textContent = "Creating...";
    try {
      var autoDiscoverEl = document.getElementById("f-autoDiscover");
      var createConfig = _formConfigForType(type);
      if (isFmg || isFgt) {
        var credId = _readMonitorCredentialId();
        if (credId) createConfig.monitorCredentialId = credId;
        var sshCredId = _readSshCredentialId();
        if (sshCredId) createConfig.sshCredentialId = sshCredId;
        // Per-stream polling methods are part of the integration tier
        // settings now (Cadence & Retention section); they're written to
        // Integration.config.monitorSettings.polling by the
        // /monitor-settings/integration/:id PUT after the integration is
        // created — no inline fields needed on create.
        var fgBlockNew = _readFortigateMonitorBlock("f-mon-fortigate-",   { klass: "fortigate",   isPrimary: true });
        var swBlockNew = _readClassMonitorBlock("f-mon-fortiswitch-",     { klass: "fortiswitch", isPrimary: false });
        var apBlockNew = _readClassMonitorBlock("f-mon-fortiap-",         { klass: "fortiap",     isPrimary: false, includeStorage: false });
        if (fgBlockNew) createConfig.fortigateMonitor   = fgBlockNew;
        if (swBlockNew) createConfig.fortiswitchMonitor = swBlockNew;
        if (apBlockNew) createConfig.fortiapMonitor     = apBlockNew;
      }
      if (isAd || isEntra || isWin) {
        // AD / Entra / Windows Server per-class blocks. Workstations is the
        // primary class subtab (legacy `f-mon-*` IDs); Servers is secondary
        // (namespaced `f-mon-classecho-servers-*`). _CLASS_SUBTAB_SPECS
        // uses plural class keys; backend Zod schema names them singularly.
        var wsBlockNew = _readWorkstationServerMonitorBlock("f-mon-workstation-", { klass: "workstations", isPrimary: true });
        var srvBlockNew = _readWorkstationServerMonitorBlock("f-mon-server-",     { klass: "servers",      isPrimary: false });
        if (wsBlockNew)  createConfig.workstationMonitor = wsBlockNew;
        if (srvBlockNew) createConfig.serverMonitor      = srvBlockNew;
      }
      if (isFmg || isFgt) {
        var pushToggleNew = _readPushReservationsToggle();
        if (pushToggleNew !== undefined) createConfig.pushReservations = pushToggleNew;
        var quarantinePushToggleNew = _readPushQuarantineToggle();
        if (quarantinePushToggleNew !== undefined) createConfig.pushQuarantine = quarantinePushToggleNew;
        var sdwanToggleNew = _readPullSdwanToggle();
        if (sdwanToggleNew !== undefined) createConfig.pullSdwan = sdwanToggleNew;
      }
      var input = {
        type: type,
        name: val("f-name"),
        config: createConfig,
        enabled: document.getElementById("f-enabled").checked,
        autoDiscover: autoDiscoverEl ? autoDiscoverEl.checked : true,
        pollInterval: parseInt(document.getElementById("f-pollInterval").value, 10) || 4,
      };
      var result = await api.integrations.create(input);
      // Save the new integration's tier-3 monitor settings if the Monitoring
      // tab was rendered. Failures here aren't fatal — the integration is
      // already created; operator can edit and resave.
      if ((isFmg || isFgt || isAd || isEntra || isWin) && result && result.id) {
        try { await api.monitorSettings.setIntegration(result.id, getMonitorSettingsFromForm()); }
        catch (e) { showToast("Integration created, but monitor settings couldn\'t be saved: " + (e.message || "unknown error"), "error"); }
      }
      closeModal();
      showToast("Integration created");
      loadIntegrations();
      // If the user successfully tested the connection in the modal, inherit
      // that result onto the new integration so the Discover button is
      // immediately enabled instead of gated on a redundant re-test.
      if (_modalTestOk && result && result.id) {
        api.integrations.test(result.id, input.name)
          .then(function () { loadIntegrations(); })
          .catch(function () { /* user can retry from the card */ });
      }
      if (result && result.conflicts && result.conflicts.length) {
        showConflictModal(result.id, result.conflicts);
      } else {
        // Conflict modal owns the screen when it renders, so skip the
        // no-blocks warning in that case — operators see it on the next
        // create or after the conflict modal closes.
        await _warnIfNoBlocksForIntegrationType(type, input.name);
      }
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Create";
    }
  });
}

async function openEditModal(id) {
  try {
    var intg = await api.integrations.get(id);
    var config = intg.config || {};
    var isWin = intg.type === "windowsserver";
    var isFgt = intg.type === "fortigate";
    var isEntra = intg.type === "entraid";
    var isAd = intg.type === "activedirectory";
    var body, formGetter;

    if (isAd) {
      var defaults = {
        name: intg.name,
        host: config.host,
        port: config.port,
        useLdaps: config.useLdaps !== false,
        verifyTls: config.verifyTls,
        bindDn: config.bindDn,
        bindPassword: "",
        bindPasswordPlaceholder: "Leave blank to keep current password",
        baseDn: config.baseDn,
        searchScope: config.searchScope || "sub",
        includeDisabled: config.includeDisabled !== false,
        enabled: intg.enabled,
        autoDiscover: intg.autoDiscover !== false,
        pollInterval: intg.pollInterval,
        ouInclude: config.ouInclude || [],
        ouExclude: config.ouExclude || [],
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
      };
      body = activeDirectoryFormHTML(defaults);
      formGetter = function () {
        var fc = getAdFormConfig();
        if (!fc.bindPassword) delete fc.bindPassword;
        return fc;
      };
    } else if (isEntra) {
      var defaults = {
        name: intg.name,
        tenantId: config.tenantId,
        clientId: config.clientId,
        clientSecret: "",
        clientSecretPlaceholder: "Leave blank to keep current secret",
        enableIntune: config.enableIntune,
        enabled: intg.enabled,
        autoDiscover: intg.autoDiscover !== false,
        pollInterval: intg.pollInterval,
        deviceInclude: config.deviceInclude || [],
        deviceExclude: config.deviceExclude || [],
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
      };
      body = entraIdFormHTML(defaults);
      formGetter = function () {
        var fc = getEntraFormConfig();
        if (!fc.clientSecret) delete fc.clientSecret;
        return fc;
      };
    } else if (isWin) {
      var defaults = {
        name: intg.name,
        host: config.host,
        port: config.port,
        username: config.username,
        password: "",
        passwordPlaceholder: "Leave blank to keep current password",
        useSsl: config.useSsl,
        domain: config.domain,
        enabled: intg.enabled,
        pollInterval: intg.pollInterval,
        dhcpInclude: config.dhcpInclude || [],
        dhcpExclude: config.dhcpExclude || [],
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
      };
      body = windowsServerFormHTML(defaults);
      formGetter = function () {
        var fc = getWinFormConfig();
        if (!fc.password) delete fc.password;
        return fc;
      };
    } else if (isFgt) {
      var defaults = {
        name: intg.name,
        host: config.host,
        port: config.port,
        apiUser: config.apiUser,
        apiToken: "",
        apiTokenPlaceholder: "Leave blank to keep current token",
        vdom: config.vdom,
        verifySsl: config.verifySsl,
        enabled: intg.enabled,
        autoDiscover: intg.autoDiscover !== false,
        pollInterval: intg.pollInterval,
        mgmtInterface: config.mgmtInterface,
        dhcpInclude: config.dhcpInclude || [],
        dhcpExclude: config.dhcpExclude || [],
        interfaceInclude: config.interfaceInclude || [],
        interfaceExclude: config.interfaceExclude || [],
        inventoryIncludeInterfaces: config.inventoryIncludeInterfaces || [],
        inventoryExcludeInterfaces: config.inventoryExcludeInterfaces || [],
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
      };
      body = fortiGateFormHTML(defaults);
      formGetter = function () {
        var fc = getFgtFormConfig();
        if (!fc.apiToken) delete fc.apiToken;
        return fc;
      };
    } else {
      var defaults = {
        name: intg.name,
        host: config.host,
        port: config.port,
        apiUser: config.apiUser,
        apiToken: "",
        apiTokenPlaceholder: "Leave blank to keep current token",
        adom: config.adom,
        verifySsl: config.verifySsl,
        enabled: intg.enabled,
        autoDiscover: intg.autoDiscover !== false,
        pollInterval: intg.pollInterval,
        mgmtInterface: config.mgmtInterface,
        interfaceInclude: config.interfaceInclude || [],
        interfaceExclude: config.interfaceExclude || [],
        dhcpInclude: config.dhcpInclude || [],
        dhcpExclude: config.dhcpExclude || [],
        inventoryIncludeInterfaces: config.inventoryIncludeInterfaces || [],
        inventoryExcludeInterfaces: config.inventoryExcludeInterfaces || [],
        deviceInclude: config.deviceInclude || [],
        deviceExclude: config.deviceExclude || [],
        discoveryParallelism: config.discoveryParallelism,
        useProxy: config.useProxy !== false,
        fortigateApiUser: config.fortigateApiUser,
        fortigateApiToken: "",
        fortigateApiTokenPlaceholder: "Leave blank to keep current token",
        fortigateVerifySsl: config.fortigateVerifySsl === true,
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
      };
      body = fortiManagerFormHTML(defaults);
      formGetter = function () {
        var fc = getFormConfig();
        if (!fc.apiToken) delete fc.apiToken;
        if (!fc.fortigateApiToken) delete fc.fortigateApiToken;
        return fc;
      };
    }

    // FMG + FortiGate get the full Monitoring tab (Cadence + Discovery
    // Defaults + Class Overrides). AD / Entra / WindowsServer get the same
    // Monitoring tab minus the Discovery Defaults section (those concerns
    // don't apply to non-Fortinet integrations). All tier-3 settings are
    // now per-integration — this tab edits THIS integration's settings
    // only. Manual tier + cross-source class overrides live on the Assets
    // page Monitoring Settings modal.
    var isFmgOrFgt = (intg.type === "fortimanager" || intg.type === "fortigate");
    var monCapable = isFmgOrFgt || isAd || isEntra || isWin;
    if (!isFmgOrFgt && monCapable) {
      // AD / Entra / WindowsServer: wrap the existing flat form as the
      // General tab and add a Monitoring tab alongside it.
      var monSettings = {};
      try {
        var resp = await api.monitorSettings.getIntegration(intg.id);
        if (resp && resp.settings) monSettings = resp.settings;
      } catch (e) { /* fall back to defaults */ }
      var generalTabBody = body;
      var nonFortinetTabs = [
        { key: "general",    label: "General",    html: generalTabBody },
        { key: "monitoring", label: "Monitoring", html: monitorSettingsFormHTML(monSettings, {
          integrationId:   id,
          integrationType: intg.type,
          integrationName: intg.name,
          pollInterval:    intg.pollInterval,
          // Phase 2 — forward AD/Entra/WinSrv per-class blocks so per-class
          // subtabs can render their own saved stream values. Blocks are
          // freshly seeded by the migration job; pre-migration installs see
          // an empty object → overlay no-ops → flat baseline shows through.
          workstationMonitor: config.workstationMonitor || null,
          serverMonitor:      config.serverMonitor      || null,
        }) },
      ];
      body = _intRenderTabbedBody("intg-edit", nonFortinetTabs);
    }
    if (isFmgOrFgt) {
      var monSettings = {};
      var creds = [];
      try {
        var resp = await api.monitorSettings.getIntegration(intg.id);
        var tier = resp && resp.settings;
        // Tier may be null on a fresh integration whose tier-3 hasn't been
        // saved yet — the form falls back to its hardcoded defaults.
        if (tier) monSettings = tier;
      } catch (e) { /* fall back to defaults */ }
      try { var credResp = await api.credentials.list(); creds = Array.isArray(credResp) ? credResp : []; } catch (e) { /* picker just shows defaults */ }
      var generalHtml = (intg.type === "fortimanager") ? fortiManagerGeneralHTML(defaults) : fortiGateGeneralHTML(defaults);
      var filtersHtml = (intg.type === "fortimanager") ? fortiManagerFiltersHTML(defaults) : fortiGateFiltersHTML(defaults);
      var editTabs = [
        { key: "general",    label: "General",    html: generalHtml },
        { key: "filters",    label: "Filters",    html: filtersHtml },
      ];
      editTabs.push(
        { key: "monitoring", label: "Monitoring", html: monitorSettingsFormHTML(monSettings, {
          snmpCredentials: creds,
          monitorCredentialId: config.monitorCredentialId || null,
          sshCredentialId:    config.sshCredentialId    || null,
          fortigateMonitor:   config.fortigateMonitor   || null,
          fortiswitchMonitor: config.fortiswitchMonitor || null,
          fortiapMonitor:     config.fortiapMonitor     || null,
          integrationId:      id,
          integrationType:    intg.type,
          integrationName:    intg.name,
          pollInterval:       intg.pollInterval,
          // The relocated useDirect toggle + direct-mode credentials block
          // lives inside the FortiGate class subtab in the Monitoring tab.
          // Pass the FMG `defaults` blob so it renders with the current
          // values. Standalone FortiGate doesn't carry these fields and
          // the block is skipped on that path.
          fmgDefaults:        defaults,
        }) },
      );
      // Reservation Push + Quarantine Push tabs render for both FMG and
      // standalone FortiGate. The `useProxy` flag is meaningful only for FMG;
      // standalone always goes direct REST so we pass true so the proxy/
      // direct copy in the form helpers doesn't render an irrelevant warning.
      {
        var pushUseProxy = intg.type === "fortimanager" ? (config.useProxy !== false) : true;
        editTabs.push({
          key: "push",
          label: "DHCP Push",
          html: reservationPushFormHTML(config.pushReservations === true, pushUseProxy),
        });
        editTabs.push({
          key: "quarantine-push",
          label: "Quarantine Push",
          html: quarantinePushFormHTML(config.pushQuarantine === true, pushUseProxy),
        });
        editTabs.push({
          key: "sdwan",
          label: "SD-WAN",
          html: sdwanFormHTML(config.pullSdwan === true),
        });
        // Geographic Location tab (FMG + standalone FortiGate). Carries the
        // pull-from-SNMP and push-geocoded-coords toggles previously surfaced
        // inside Monitoring → FortiGate. DOM ids preserved so the existing
        // save path (`_readFortigateMonitorBlock`) keeps finding them.
        var fwFgCfgEdit = config.fortigateMonitor || {};
        editTabs.push({
          key: "geographicLocation",
          label: "Geographic Location",
          html: geographicLocationFormHTML(
            fwFgCfgEdit.pullSnmpLocation === true,
            fwFgCfgEdit.pushGeocodedCoords === true,
            fwFgCfgEdit.latitudeMetavar || "Latitude",
            fwFgCfgEdit.longitudeMetavar || "Longitude",
            fwFgCfgEdit.addressMetavar || "",
            intg.type,
          ),
        });
      }
      body = _intRenderTabbedBody("intg-edit", editTabs);
    }

    var footer = '<button class="btn btn-secondary" id="btn-test-existing">Test Connection</button>' +
      '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal("Edit Integration", body, footer, { wide: true });
    if (isFmgOrFgt) {
      _intWireModalTabs("intg-edit");
      _wireMonitoringTabSubtabs(intg.type);
      wireAutoMonitorCards(id);
      _wireProbeTimeoutWarning();
      _wireCredentialPickerVisibility();
      _populateUploadedMibsInDropdowns();
    } else if (isAd || isEntra || isWin) {
      _intWireModalTabs("intg-edit");
      _wireMonitoringTabSubtabs(intg.type);
      _wireProbeTimeoutWarning();
    }

    document.getElementById("btn-test-existing").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = "Testing...";
      try {
        var formConfig = _formConfigForType(intg.type);
        // Strip blank secrets so the server fills them in from the stored config.
        if (isWin) { if (!formConfig.password) delete formConfig.password; }
        else if (isEntra) { if (!formConfig.clientSecret) delete formConfig.clientSecret; }
        else if (isAd) { if (!formConfig.bindPassword) delete formConfig.bindPassword; }
        else {
          if (!formConfig.apiToken) delete formConfig.apiToken;
          if (!formConfig.fortigateApiToken) delete formConfig.fortigateApiToken;
        }
        var result = await api.integrations.testNew({
          id: id,
          type: intg.type,
          name: val("f-name") || intg.name,
          config: formConfig,
        });
        showToast(result.message, result.ok ? "success" : "error");
        if (result.ok) loadIntegrations();
        // Direct-transport sanity check: run asynchronously so the FMG
        // toast appears immediately rather than waiting on the FortiGate
        // probe (which can take 10s if the random gate is unreachable).
        if (result.ok && intg.type === "fortimanager" && formConfig && formConfig.useProxy === false) {
          var probeBody = {
            id: id,
            type: intg.type,
            name: val("f-name") || intg.name,
            config: formConfig,
          };
          _runFortigateSampleProbe(function () { return api.integrations.testFortigateSampleNew(probeBody); });
        }
      } catch (err) {
        if (err.name === "AbortError") { showToast("Test aborted", "error"); }
        else { showToast(err.message, "error"); }
      } finally {
        btn.disabled = false;
        btn.textContent = "Test Connection";
      }
    });

    // Builds the request body, PUTs it, and returns the editConfig so the
    // caller can drive the auto-monitor apply pass for any class with a
    // non-null selection.
    async function performSave() {
      var autoDiscoverEl = document.getElementById("f-autoDiscover");
      var editConfig = formGetter();
      if (isFmgOrFgt) {
        // Always send the picker value so an explicit clear round-trips.
        // Empty string is normalized to null on the server.
        editConfig.monitorCredentialId = _readMonitorCredentialId() || null;
        editConfig.sshCredentialId     = _readSshCredentialId()     || null;
        // Per-stream polling methods are persisted via the
        // /monitor-settings/integration/:id PUT below — they live in
        // Integration.config.monitorSettings.polling now.
        // Per-class FortiGate / FortiSwitch / FortiAP blocks. The reader
        // returns null when its subtab didn't render — in that case leave
        // the existing config alone rather than wiping it.
        // Phase 2: each class subtab carries its own per-stream config. The
        // FortiGate subtab is the primary (uses legacy IDs); FortiSwitch and
        // FortiAP are secondary subtabs whose IDs are namespaced under
        // `f-mon-classecho-<klass>-`. FortiAP omits storage.
        var fgBlock = _readFortigateMonitorBlock("f-mon-fortigate-",   { klass: "fortigate",   isPrimary: true });
        var swBlock = _readClassMonitorBlock("f-mon-fortiswitch-",     { klass: "fortiswitch", isPrimary: false });
        var apBlock = _readClassMonitorBlock("f-mon-fortiap-",         { klass: "fortiap",     isPrimary: false, includeStorage: false });
        if (fgBlock) editConfig.fortigateMonitor   = fgBlock;
        if (swBlock) editConfig.fortiswitchMonitor = swBlock;
        if (apBlock) editConfig.fortiapMonitor     = apBlock;
        // FMG and standalone FortiGate share the DHCP Push + Quarantine Push
        // tabs. Readers return undefined when the tabs didn't render (e.g.
        // future integration type that doesn't expose them); leave unchanged.
        var pushToggle = _readPushReservationsToggle();
        if (pushToggle !== undefined) editConfig.pushReservations = pushToggle;
        var quarantinePushToggle = _readPushQuarantineToggle();
        if (quarantinePushToggle !== undefined) editConfig.pushQuarantine = quarantinePushToggle;
        var sdwanToggle = _readPullSdwanToggle();
        if (sdwanToggle !== undefined) editConfig.pullSdwan = sdwanToggle;
      }
      if (isAd || isEntra || isWin) {
        // AD / Entra / Windows Server per-class blocks. Workstations is the
        // primary class subtab (legacy `f-mon-*` IDs); Servers is secondary
        // (namespaced `f-mon-classecho-servers-*`). Class keys are plural in
        // _CLASS_SUBTAB_SPECS to match the human-facing tab labels; backend
        // schema names them singularly. Readers return null when the subtab
        // didn't render — leave existing config alone.
        var wsBlock  = _readWorkstationServerMonitorBlock("f-mon-workstation-", { klass: "workstations", isPrimary: true });
        var srvBlock = _readWorkstationServerMonitorBlock("f-mon-server-",      { klass: "servers",      isPrimary: false });
        if (wsBlock)  editConfig.workstationMonitor = wsBlock;
        if (srvBlock) editConfig.serverMonitor      = srvBlock;
      }
      var input = {
        name: val("f-name"),
        config: editConfig,
        enabled: document.getElementById("f-enabled").checked,
        autoDiscover: autoDiscoverEl ? autoDiscoverEl.checked : true,
        pollInterval: parseInt(document.getElementById("f-pollInterval").value, 10) || 4,
      };
      var result = await api.integrations.update(id, input);
      // Persist the integration-tier monitor settings for any integration
      // type that renders a Monitoring tab. Failures here aren't fatal —
      // the integration update itself already landed.
      if (isFmgOrFgt || isAd || isEntra || isWin) {
        try { await api.monitorSettings.setIntegration(id, getMonitorSettingsFromForm()); }
        catch (e) { showToast("Integration updated, but monitor settings couldn\'t be saved: " + (e.message || "unknown error"), "error"); }
      }
      return { result: result, editConfig: editConfig };
    }

    document.getElementById("btn-save").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = "Saving...";
      try {
        // Auto-Monitor confirm gate (FortiGate/Switch/AP only) — preflight
        // the operator's proposed addAsMonitored toggle states and ask for
        // confirmation when disabling would sweep monitoring off existing
        // assets. Read from the hidden checkboxes (the visible buttons
        // toggle these via _wireAutoMonitoringButtons). Aborts the save
        // without re-enabling the button if the operator declines, so the
        // finally block at the end resets state cleanly.
        if (isFmgOrFgt) {
          var proposed = {};
          var fgEl = document.getElementById("f-mon-fortigate-addAsMonitored");
          var swEl = document.getElementById("f-mon-fortiswitch-addAsMonitored");
          var apEl = document.getElementById("f-mon-fortiap-addAsMonitored");
          if (fgEl) proposed.firewall     = fgEl.checked === true;
          if (swEl) proposed["switch"]    = swEl.checked === true;
          if (apEl) proposed.access_point = apEl.checked === true;
          try {
            var pre = await api.integrations.autoMonitorAssetsPreflight(id, proposed);
            var disablingClasses = [];
            ["firewall", "switch", "access_point"].forEach(function (k) {
              var c = pre && pre.classes && pre.classes[k];
              if (c && c.wouldDisable > 0) {
                disablingClasses.push({ k: k, wouldDisable: c.wouldDisable, overridden: c.overridden });
              }
            });
            if (disablingClasses.length > 0) {
              var humanClass = { firewall: "FortiGate", "switch": "FortiSwitch", access_point: "FortiAP" };
              var lines = disablingClasses.map(function (d) {
                var protectedNote = d.overridden > 0 ? " (" + d.overridden + " protected by per-asset override)" : "";
                return "  • " + humanClass[d.k] + ": " + d.wouldDisable + " asset(s) will stop being monitored" + protectedNote;
              });
              var ok = await showConfirm(
                "Disabling Auto-Monitoring will sweep monitoring OFF for previously-discovered assets:\n\n" +
                lines.join("\n") + "\n\n" +
                "Per-asset overrides are preserved. Continue?"
              );
              if (!ok) {
                btn.disabled = false;
                btn.textContent = "Save Changes";
                return;
              }
            }
          } catch (preflightErr) {
            // Preflight failure shouldn't block the save — log it and proceed.
            // The backend save itself will still apply correctly.
            if (window.console) console.warn("Auto-Monitor preflight failed:", preflightErr);
          }
        }

        var saved = await performSave();
        var classes = isFmgOrFgt ? [
          ["fortigate",   saved.editConfig.fortigateMonitor],
          ["fortiswitch", saved.editConfig.fortiswitchMonitor],
          ["fortiap",     saved.editConfig.fortiapMonitor],
        ] : [];

        // Fire apply only for per-class blocks whose autoMonitorInterfaces
        // selection actually changed during this modal session. Saving for
        // an unrelated reason (API token rotation, name change, monitoring
        // tier edit) used to re-fire apply for every block that had ANY
        // selection — expensive on big fleets and surprising to operators.
        // Baseline = saved selection stashed at modal-open by
        // _autoMonitorInterfacesHTML; post-save = whatever editConfig holds
        // (what we just PUT). Equality goes through _amonCanonicalize so
        // array reordering / null-vs-empty-object don't read as a change.
        var classToBaselinePrefix = {
          fortigate:   "f-mon-fortigate-amon-",
          fortiswitch: "f-mon-fortiswitch-amon-",
          fortiap:     "f-mon-fortiap-amon-",
        };
        var activeApplies = classes.filter(function (entry) {
          if (!(entry[1] && entry[1].autoMonitorInterfaces)) return false;
          var prefix = classToBaselinePrefix[entry[0]];
          var baseline = prefix ? window["__autoMon_savedSelection_" + prefix] : null;
          return _amonCanonicalize(baseline) !== _amonCanonicalize(entry[1].autoMonitorInterfaces);
        });

        if (activeApplies.length > 0) {
          // Capacity guard: warn before applying selections that would pin
          // a large number of interfaces. We sniff the cached count from
          // each preview block; missing/stale values just skip the warning.
          // Scoped to the blocks that ARE changing — a class whose selection
          // didn't change this session shouldn't contribute to the estimate.
          var changedPrefixes = activeApplies
            .map(function (e) { return classToBaselinePrefix[e[0]]; })
            .filter(Boolean);
          var totalEstimate = 0;
          changedPrefixes.forEach(function (p) {
            var el = document.getElementById(p + "preview");
            var n = el && el.dataset && parseInt(el.dataset.interfaceCount || "0", 10);
            if (Number.isFinite(n)) totalEstimate += n;
          });
          if (totalEstimate > AUTO_MONITOR_INTERFACE_WARN_THRESHOLD) {
            var ok = await showConfirm(
              "Auto-Monitor will pin approximately " + totalEstimate + " interfaces across the discovered devices.\n\n" +
              "Each pin gets scraped on the response-time cadence (default 60s). Large pin counts add load to the database and to the monitored devices.\n\n" +
              "Continue applying now?"
            );
            if (!ok) {
              closeModal();
              showToast("Integration updated; auto-monitor not applied");
              loadIntegrations();
              return;
            }
          }
          btn.textContent = "Applying...";
          // Run the per-class applies in parallel. Each call is independent
          // (different assetType slice of the integration's assets), the
          // backend's chunked Promise.allSettled handles its own per-class
          // concurrency, and waiting for them serially used to leave the
          // modal stuck on "Applying..." for minutes on big fleets — one
          // class with a few hundred switches could take 30-60s on its own
          // under the old sequential-update path.
          var applyResults = await Promise.all(activeApplies.map(function (entry) {
            return api.integrations.interfaceAggregateApply(id, entry[0]).then(
              function (r) { return { ok: true,  klass: entry[0], r: r }; },
              function (err) { return { ok: false, klass: entry[0], err: err }; },
            );
          }));
          var totalDevices = 0;
          var totalIfaces = 0;
          var failures = [];
          for (var c = 0; c < applyResults.length; c++) {
            var result = applyResults[c];
            if (result.ok) {
              totalDevices += result.r.devices || 0;
              totalIfaces  += result.r.interfacesAdded || 0;
            } else {
              failures.push(result.klass + ": " + (result.err.message || "failed"));
            }
          }
          closeModal();
          if (failures.length === 0) {
            showToast("Integration updated · pinned " + totalIfaces + " interface(s) on " + totalDevices + " device(s)", "success");
          } else {
            showToast("Saved, but apply had errors — " + failures.join("; "), "error");
          }
        } else {
          closeModal();
          showToast("Integration updated");
        }
        loadIntegrations();
        if (saved.result && saved.result.conflicts && saved.result.conflicts.length) {
          showConflictModal(saved.result.id || id, saved.result.conflicts);
        }
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Save Changes";
      }
    });
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function testConnection(id, btn) {
  btn.disabled = true;
  btn.textContent = "Testing...";
  var card = btn.closest(".integration-card");
  var name = card.querySelector("strong").textContent;
  var isFmgDirect = card.getAttribute("data-fmg-direct") === "1";
  try {
    var result = await api.integrations.test(id, name);
    showToast(result.message, result.ok ? "success" : "error");
    loadIntegrations();
    if (result.ok && isFmgDirect) {
      _runFortigateSampleProbe(function () { return api.integrations.testFortigateSample(id); });
    }
  } catch (err) {
    if (err.name === "AbortError") { showToast("Test aborted", "error"); }
    else { showToast(err.message, "error"); }
  } finally {
    btn.disabled = false;
    btn.textContent = "Test Connection";
  }
}

async function runDiscovery(id) {
  var wrap = document.getElementById("discover-wrap-" + id);
  var name = wrap ? ((wrap.closest(".integration-card") || document).querySelector("strong") || {}).textContent || "" : "";
  // Flip button immediately; the server poll will keep it in sync
  if (wrap) wrap.innerHTML = _discoverBtnHTML(id, name, { id: id, name: name, currentDevice: null }, false);
  try {
    await api.integrations.discover(id, name);
    // Immediately refresh the server discoveries list so the sidebar popup
    // transitions seamlessly from the tracked POST to the running discovery
    // entry without the up-to-4-second gap from the normal polling interval.
    if (window._pollDiscoveries) window._pollDiscoveries();
    showToast("Discovery started — running in the background. Results will appear shortly.", "success");
    [15000, 45000, 120000].forEach(function (delay) {
      setTimeout(function () {
        if (document.getElementById("integrations-list")) loadIntegrations();
      }, delay);
    });
  } catch (err) {
    // Restore button on error (poll will also correct it on next tick)
    var disabled = wrap ? wrap.getAttribute("data-disabled") === "1" : false;
    if (wrap) wrap.innerHTML = _discoverBtnHTML(id, name, false, disabled);
    if (err.name === "AbortError") { showToast("Discovery aborted", "error"); }
    else { showToast(err.message, "error"); }
  }
}

async function abortIntegrationDiscovery(id, name) {
  var ok = await showConfirm('Abort discovery of "' + name + '"?');
  if (!ok) return;
  try { await api.integrations.abortDiscover(id); } catch (_) {}
}

async function confirmDelete(id, name) {
  var ok = await showConfirm('Delete integration "' + name + '"? This cannot be undone.');
  if (!ok) return;
  try {
    await api.integrations.delete(id);
    showToast("Integration deleted");
    loadIntegrations();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function showConflictModal(integrationId, conflicts) {
  var admin = canManageNetworks();
  var resConflicts = conflicts.filter(function (c) { return c.type === "reservation"; });
  if (!resConflicts.length) return;

  var body = admin
    ? '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">An existing reservation was found for this IP. Select which fields to overwrite.</p>'
    : '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">An existing reservation was found for this IP. Contact an administrator to resolve the conflict.</p>';

  var fieldLabels = {
    ipAddress: "IP Address", hostname: "Hostname", owner: "Owner",
    projectRef: "Project Ref", notes: "Notes", status: "Status",
    subnetCidr: "Network",
  };
  var editableFields = ["hostname", "owner", "projectRef", "notes", "status"];

  resConflicts.forEach(function (c) {
    var fields = ["ipAddress", "hostname", "owner", "projectRef", "notes", "status"];

    body += '<div style="margin-bottom:1rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.5rem">Reservation Conflict</p>' +
      '<div class="conflict-table"><table><thead><tr>';
    if (admin) body += '<th style="width:36px"></th>';
    body += '<th>Field</th><th>Existing</th><th>New</th></tr></thead><tbody>';

    fields.forEach(function (f) {
      var existVal = c.existing[f] != null ? String(c.existing[f]) : "-";
      var newVal = c.proposed[f] != null ? String(c.proposed[f]) : "-";
      var changed = existVal !== newVal;
      var canCheck = admin && changed && editableFields.indexOf(f) !== -1;
      body += '<tr' + (changed ? ' class="conflict-changed"' : '') + '>';
      if (admin) {
        body += '<td style="text-align:center">';
        if (canCheck) {
          body += '<input type="checkbox" class="conflict-cb" data-field="' + f + '" checked>';
        }
        body += '</td>';
      }
      body += '<td class="conflict-field">' + escapeHtml(fieldLabels[f] || f) + '</td>' +
        '<td>' + escapeHtml(existVal) + '</td>' +
        '<td>' + (changed ? '<strong>' + escapeHtml(newVal) + '</strong>' : escapeHtml(newVal)) + '</td>' +
        '</tr>';
    });

    body += '</tbody></table></div></div>';
  });

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Keep Existing</button>';
  if (admin) {
    footer += '<button class="btn btn-danger" id="btn-overwrite">Overwrite Selected</button>';
  }

  openModal("Reservation Conflict Detected", body, footer);

  if (admin) {
    document.getElementById("btn-overwrite").addEventListener("click", async function () {
      var btn = this;
      var checked = document.querySelectorAll(".conflict-cb:checked");
      var selectedFields = [];
      checked.forEach(function (cb) { selectedFields.push(cb.getAttribute("data-field")); });
      if (!selectedFields.length) {
        showToast("Select at least one field to overwrite", "error");
        return;
      }
      btn.disabled = true;
      btn.textContent = "Overwriting...";
      try {
        await api.integrations.register(integrationId, { fields: selectedFields });
        closeModal();
        showToast("Selected fields overwritten");
        loadIntegrations();
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Overwrite Selected";
      }
    });
  }
}

function val(id) { return document.getElementById(id).value.trim(); }

// Preset queries use "<adom>" as a placeholder — substituted with the integration's
// configured ADOM when loaded into the form. Only "<device-name>" needs user input.
// Each preset carries a `mode` ("fmg" = JSON-RPC against FortiManager, including
// /sys/proxy/json passthroughs; "fortigate" = direct REST against a managed
// FortiGate). The Saved Queries dropdown filters by the currently-selected radio.
var _FMG_PROXY_PRESET_QUERIES = [
  {
    name: "System status",
    mode: "fmg",
    method: "get",
    params: '[\n  { "url": "/sys/status" }\n]',
  },
  {
    name: "List ADOMs",
    mode: "fmg",
    method: "get",
    params: '[\n  {\n    "url": "/dvmdb/adom",\n    "data": { "fields": ["name", "state", "os_ver"] }\n  }\n]',
  },
  {
    name: "List devices in ADOM",
    mode: "fmg",
    method: "get",
    params: '[\n  {\n    "url": "/dvmdb/adom/<adom>/device",\n    "data": { "fields": ["name", "sn", "ip", "os_ver", "platform_str", "ha_mode", "conn_status", "last_checked"] }\n  }\n]',
  },
  {
    name: "DHCP servers on device",
    mode: "fmg",
    method: "exec",
    params: '[\n  {\n    "url": "/sys/proxy/json",\n    "data": {\n      "target": ["/adom/<adom>/device/<device-name>"],\n      "action": "get",\n      "resource": "/api/v2/cmdb/system.dhcp/server"\n    }\n  }\n]',
  },
  {
    name: "DHCP leases on device",
    mode: "fmg",
    method: "exec",
    params: '[\n  {\n    "url": "/sys/proxy/json",\n    "data": {\n      "target": ["/adom/<adom>/device/<device-name>"],\n      "action": "get",\n      "resource": "/api/v2/monitor/system/dhcp?format=ip|mac|hostname|interface|reserved|expire_time|access_point|ssid|vci"\n    }\n  }\n]',
  },
  {
    name: "Interface IPs on device",
    mode: "fmg",
    method: "exec",
    params: '[\n  {\n    "url": "/sys/proxy/json",\n    "data": {\n      "target": ["/adom/<adom>/device/<device-name>"],\n      "action": "get",\n      "resource": "/api/v2/cmdb/system/interface",\n      "params": [{ "fields": ["name", "ip", "vdom", "type", "status"] }]\n    }\n  }\n]',
  },
  {
    name: "Managed FortiSwitches on device",
    mode: "fmg",
    method: "exec",
    params: '[\n  {\n    "url": "/sys/proxy/json",\n    "data": {\n      "target": ["/adom/<adom>/device/<device-name>"],\n      "action": "get",\n      "resource": "/api/v2/monitor/switch-controller/managed-switch/status?format=connecting_from|fgt_peer_intf_name|join_time|os_version|serial|switch-id|state|status"\n    }\n  }\n]',
  },
  {
    name: "Managed FortiAPs on device",
    mode: "fmg",
    method: "exec",
    params: '[\n  {\n    "url": "/sys/proxy/json",\n    "data": {\n      "target": ["/adom/<adom>/device/<device-name>"],\n      "action": "get",\n      "resource": "/api/v2/monitor/wifi/managed_ap?format=name|wtp_id|serial|model|wtp_profile|ip_addr|ip_address|local_ipv4_address|base_mac|mac|status|state|version|firmware_version"\n    }\n  }\n]',
  },
  {
    name: "Firewall VIPs on device",
    mode: "fmg",
    method: "exec",
    params: '[\n  {\n    "url": "/sys/proxy/json",\n    "data": {\n      "target": ["/adom/<adom>/device/<device-name>"],\n      "action": "get",\n      "resource": "/api/v2/cmdb/firewall/vip"\n    }\n  }\n]',
  },
  {
    name: "Endpoint devices on device",
    mode: "fmg",
    method: "exec",
    params: '[\n  {\n    "url": "/sys/proxy/json",\n    "data": {\n      "target": ["/adom/<adom>/device/<device-name>"],\n      "action": "get",\n      "resource": "/api/v2/monitor/user/device/query?format=mac|ip|hostname|host|os|type|os_version|hardware_vendor|interface|switch_fortilink|fortiswitch|switch_port|ap_name|fortiap|user|detected_user|is_online|last_seen"\n    }\n  }\n]',
  },
];

// Direct-mode (REST-to-FortiGate) presets. Available when the integration has
// `useProxy=false` AND the operator picks the "Directly to FortiGate (REST)"
// radio. The FortiManager-native queries (sys/status, dvmdb/adom, etc.) have
// no direct-mode equivalent — they query FMG itself, not a managed gate — so
// they only appear in the FMG-proxy preset list above. `deviceName` is left
// blank so the operator types in the target FortiGate per query.
var _FMG_DIRECT_PRESET_QUERIES = [
  {
    name: "System status",
    mode: "fortigate",
    method: "GET",
    path: "/api/v2/monitor/system/status",
    deviceName: "",
    query: "vdom=root",
  },
  {
    name: "DHCP servers on device",
    mode: "fortigate",
    method: "GET",
    path: "/api/v2/cmdb/system.dhcp/server",
    deviceName: "",
    query: "vdom=root",
  },
  {
    name: "DHCP leases on device",
    mode: "fortigate",
    method: "GET",
    path: "/api/v2/monitor/system/dhcp",
    deviceName: "",
    query: "vdom=root\nformat=ip|mac|hostname|interface|reserved|expire_time|access_point|ssid|vci",
  },
  {
    name: "Interface IPs on device",
    mode: "fortigate",
    method: "GET",
    path: "/api/v2/cmdb/system/interface",
    deviceName: "",
    query: "vdom=root\nformat=name|ip|vdom|type|status",
  },
  {
    name: "Managed FortiSwitches on device",
    mode: "fortigate",
    method: "GET",
    path: "/api/v2/monitor/switch-controller/managed-switch/status",
    deviceName: "",
    query: "vdom=root\nformat=connecting_from|fgt_peer_intf_name|join_time|os_version|serial|switch-id|state|status",
  },
  {
    name: "Managed FortiAPs on device",
    mode: "fortigate",
    method: "GET",
    path: "/api/v2/monitor/wifi/managed_ap",
    deviceName: "",
    query: "vdom=root\nformat=name|wtp_id|serial|model|wtp_profile|ip_addr|ip_address|local_ipv4_address|base_mac|mac|status|state|version|firmware_version",
  },
  {
    name: "Firewall VIPs on device",
    mode: "fortigate",
    method: "GET",
    path: "/api/v2/cmdb/firewall/vip",
    deviceName: "",
    query: "vdom=root",
  },
  {
    name: "Endpoint devices on device",
    mode: "fortigate",
    method: "GET",
    path: "/api/v2/monitor/user/device/query",
    deviceName: "",
    query: "vdom=root\nformat=mac|ip|hostname|host|os|type|os_version|hardware_vendor|interface|switch_fortilink|fortiswitch|switch_port|ap_name|fortiap|user|detected_user|is_online|last_seen",
  },
];

// Back-compat alias — kept so anything that still imports this name keeps working.
var _FMG_PRESET_QUERIES = _FMG_PROXY_PRESET_QUERIES.concat(_FMG_DIRECT_PRESET_QUERIES);

// Bumped to 4 to reseed savedQueries with the new direct-mode presets and the
// mode-tagged proxy presets. Operator-saved queries are reseeded with the new
// preset set; previously-saved custom names are lost on upgrade — same contract
// as prior version bumps (operators rebuild their named queries).
var _FMG_QUERIES_VERSION = 4;

function _substituteFmgAdom(paramsStr, adom) {
  return String(paramsStr).replace(/<adom>/g, adom || "root");
}

function _fmgLoadQueries() {
  try {
    var stored = JSON.parse(localStorage.getItem("polaris-fmg-queries") || "null");
    if (!stored || stored.v !== _FMG_QUERIES_VERSION) {
      var seed = _FMG_PROXY_PRESET_QUERIES.concat(_FMG_DIRECT_PRESET_QUERIES);
      var initial = { v: _FMG_QUERIES_VERSION, queries: seed.slice() };
      localStorage.setItem("polaris-fmg-queries", JSON.stringify(initial));
      return seed.slice();
    }
    return stored.queries;
  } catch (_) { return []; }
}

function _fmgPersistQueries(queries) {
  localStorage.setItem("polaris-fmg-queries", JSON.stringify({ v: _FMG_QUERIES_VERSION, queries: queries }));
}

// Filters `queries` to the entries matching `mode` ("fmg" | "fortigate"). Entries
// saved before the mode field existed are treated as "fmg" (the legacy default).
// `selectValue` is the *original* queries-array index of the entry to preselect;
// the option's value stays the original index so load/delete can look the entry
// up by `savedQueries[idx]` without remapping.
function _fmgRenderSavedSelect(queries, mode, selectValue) {
  var sel = document.getElementById("fmg-saved-select");
  if (!sel) return;
  var filteredIdx = [];
  queries.forEach(function (q, i) {
    var qMode = q && q.mode === "fortigate" ? "fortigate" : "fmg";
    if (qMode === mode) filteredIdx.push(i);
  });
  sel.innerHTML = '<option value="">— load a saved query —</option>' +
    filteredIdx.map(function (i) {
      var q = queries[i];
      return '<option value="' + i + '"' + (String(i) === String(selectValue) ? " selected" : "") + '>' + escapeHtml(q.name) + '</option>';
    }).join("");
}

function openApiQueryModal(id, adom, useProxy) {
  adom = adom || "root";
  if (useProxy === undefined) useProxy = true;
  var defaultParams = JSON.stringify([{
    url: "/sys/proxy/json",
    data: {
      target: ["adom/" + adom + "/device/<device-name>"],
      action: "get",
      resource: "/api/v2/monitor/system/dhcp"
    }
  }], null, 2);

  var body =
    '<div style="margin-bottom:0.75rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Query Mode</p>' +
      '<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
        '<label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:normal">' +
          '<input type="radio" name="fmg-mode" value="fmg" id="fmg-mode-fmg" checked style="width:auto"> FortiManager (JSON-RPC / proxy)' +
        '</label>' +
        '<label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:normal">' +
          '<input type="radio" name="fmg-mode" value="fortigate" id="fmg-mode-fgt" style="width:auto"> Directly to FortiGate (REST)' +
        '</label>' +
      '</div>' +
      '<p class="hint" id="fmg-mode-hint" style="margin-top:0.4rem">FMG-side proxy is enabled — Direct-to-FortiGate is disabled. Switch off proxy to query a managed FortiGate directly.</p>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:0 0 0.75rem">' +
    '<div style="margin-bottom:0.75rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Saved Queries</p>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<select id="fmg-saved-select" style="flex:1"></select>' +
        '<button class="btn btn-sm btn-secondary" id="fmg-load-btn">Load</button>' +
        '<button class="btn btn-sm btn-danger" id="fmg-delete-btn">Delete</button>' +
      '</div>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:0 0 0.75rem">' +
    // ─── FMG (JSON-RPC) form ─────────────────────────────────────────────
    '<div id="fmg-form-fmg">' +
      '<div class="form-group">' +
        '<label>Method</label>' +
        '<select id="fmg-method" style="width:auto">' +
          '<option value="exec">exec</option>' +
          '<option value="get">get</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Params <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(JSON array)</span></label>' +
        '<textarea id="fmg-params" rows="9" style="font-family:monospace;font-size:0.82rem">' + escapeHtml(defaultParams) + '</textarea>' +
      '</div>' +
    '</div>' +
    // ─── Direct-to-FortiGate (REST) form ─────────────────────────────────
    '<div id="fmg-form-fgt" style="display:none">' +
      '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:end">' +
        '<div class="form-group" style="margin:0">' +
          '<label>Method</label>' +
          '<select id="fmg-fgt-method" style="width:auto">' +
            '<option value="GET">GET</option>' +
            '<option value="POST">POST</option>' +
          '</select>' +
        '</div>' +
        '<div class="form-group" style="margin:0">' +
          '<label>Path</label>' +
          '<input type="text" id="fmg-fgt-path" value="/api/v2/monitor/system/status" placeholder="/api/v2/monitor/system/status" style="font-family:monospace;font-size:0.85rem">' +
        '</div>' +
      '</div>' +
      '<div class="form-group" style="margin-top:0.75rem">' +
        '<label>Target FortiGate</label>' +
        '<input type="text" id="fmg-fgt-device" placeholder="FMG device name — e.g. FG-HQ-01">' +
        '<p class="hint">Name as it appears in FortiManager. Polaris resolves the management IP via FMG, then sends the REST call directly using the integration\'s FortiGate API token.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Query Parameters <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(one per line — <code>key=value</code>)</span></label>' +
        '<textarea id="fmg-fgt-query" rows="4" style="font-family:monospace;font-size:0.82rem" placeholder="vdom=root&#10;format=mac|ip|hostname">vdom=root</textarea>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem"><button class="btn btn-primary" id="fmg-send">Send</button></div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:0.25rem">' +
      '<input type="text" id="fmg-save-name" placeholder="Name this query to save it…" style="flex:1;font-size:0.85rem">' +
      '<button class="btn btn-sm btn-secondary" id="fmg-save-btn">Save</button>' +
    '</div>' +
    '<div id="fmg-response-wrap" style="display:none;margin-top:1rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
        '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0">Response</p>' +
        '<button class="btn btn-sm btn-secondary" id="fmg-copy-btn" style="padding:2px 10px;font-size:0.75rem">Copy</button>' +
      '</div>' +
      '<pre id="fmg-response" style="background:var(--color-surface-raised);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.75rem;font-size:0.78rem;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;margin:0"></pre>' +
    '</div>';

  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';

  openModal("FortiManager API Query", body, footer, { wide: true });

  var savedQueries = _fmgLoadQueries();
  _fmgRenderSavedSelect(savedQueries, "fmg");

  // Mode toggle: when FMG proxy mode is enabled, the "Directly to FortiGate"
  // option is disabled. Lock state is driven by the integration's `useProxy`
  // flag (passed in from the caller; default true). The user can still browse
  // the radio if proxy is off.
  var fgtRadio = document.getElementById("fmg-mode-fgt");
  var fmgRadio = document.getElementById("fmg-mode-fmg");
  var modeHint = document.getElementById("fmg-mode-hint");
  if (useProxy) {
    fgtRadio.disabled = true;
    fgtRadio.parentElement.style.opacity = "0.5";
    fgtRadio.parentElement.title = "Disabled while FortiManager proxy mode is enabled on this integration";
  } else {
    if (modeHint) modeHint.textContent = "FMG-side proxy is disabled — choose either transport.";
  }
  function _fmgApplyMode(mode) {
    document.getElementById("fmg-form-fmg").style.display = mode === "fmg" ? "" : "none";
    document.getElementById("fmg-form-fgt").style.display = mode === "fortigate" ? "" : "none";
    // Repopulate the Saved Queries dropdown with the presets/saves that match
    // the newly selected transport. The dropdown's option value is the original
    // index into savedQueries, so load/delete still resolve by that index.
    // Preserve the current selection across the re-render so loading a query
    // and then clicking Send doesn't reset the dropdown to "— load a saved
    // query —". When the mode actually changes the prior selection's option
    // will be filtered out and the dropdown collapses to its placeholder.
    var sel = document.getElementById("fmg-saved-select");
    var prior = sel ? sel.value : "";
    _fmgRenderSavedSelect(savedQueries, mode, prior);
  }
  fmgRadio.addEventListener("change", function () { if (this.checked) _fmgApplyMode("fmg"); });
  fgtRadio.addEventListener("change", function () { if (this.checked) _fmgApplyMode("fortigate"); });

  document.getElementById("fmg-load-btn").addEventListener("click", function () {
    var idx = parseInt(document.getElementById("fmg-saved-select").value, 10);
    if (isNaN(idx) || !savedQueries[idx]) return;
    var q = savedQueries[idx];
    if (q.mode === "fortigate") {
      if (!fgtRadio.disabled) {
        fgtRadio.checked = true; _fmgApplyMode("fortigate");
        document.getElementById("fmg-fgt-method").value = q.method || "GET";
        document.getElementById("fmg-fgt-path").value = q.path || "";
        document.getElementById("fmg-fgt-device").value = q.deviceName || "";
        document.getElementById("fmg-fgt-query").value = q.query || "";
      } else {
        showToast("This saved query targets a FortiGate directly — disable FMG proxy on the integration to load it", "error");
        return;
      }
    } else {
      fmgRadio.checked = true; _fmgApplyMode("fmg");
      document.getElementById("fmg-method").value = q.method;
      document.getElementById("fmg-params").value = _substituteFmgAdom(q.params, adom);
    }
    document.getElementById("fmg-save-name").value = q.name;
  });

  document.getElementById("fmg-delete-btn").addEventListener("click", async function () {
    var idx = parseInt(document.getElementById("fmg-saved-select").value, 10);
    if (isNaN(idx) || !savedQueries[idx]) return;
    var ok = await showConfirm("Delete saved query \"" + savedQueries[idx].name + "\"?");
    if (!ok) return;
    savedQueries.splice(idx, 1);
    _fmgPersistQueries(savedQueries);
    _fmgRenderSavedSelect(savedQueries, _fmgCurrentMode());
  });

  function _fmgCurrentMode() {
    return fgtRadio.checked ? "fortigate" : "fmg";
  }

  document.getElementById("fmg-save-btn").addEventListener("click", function () {
    var name = document.getElementById("fmg-save-name").value.trim();
    if (!name) { showToast("Enter a name for this query", "error"); return; }
    var mode = _fmgCurrentMode();
    var entry;
    if (mode === "fortigate") {
      entry = {
        name: name,
        mode: "fortigate",
        method: document.getElementById("fmg-fgt-method").value,
        path: document.getElementById("fmg-fgt-path").value.trim(),
        deviceName: document.getElementById("fmg-fgt-device").value.trim(),
        query: document.getElementById("fmg-fgt-query").value,
      };
    } else {
      entry = {
        name: name,
        mode: "fmg",
        method: document.getElementById("fmg-method").value,
        params: document.getElementById("fmg-params").value.trim(),
      };
    }
    var existIdx = -1;
    savedQueries.forEach(function (q, i) { if (q.name === name) existIdx = i; });
    if (existIdx >= 0) {
      savedQueries[existIdx] = entry;
    } else {
      savedQueries.push(entry);
      existIdx = savedQueries.length - 1;
    }
    _fmgPersistQueries(savedQueries);
    _fmgRenderSavedSelect(savedQueries, mode, existIdx);
    showToast("Query saved");
  });

  document.getElementById("fmg-send").addEventListener("click", async function () {
    var btn = this;
    var mode = _fmgCurrentMode();
    var payload;
    if (mode === "fortigate") {
      var deviceName = document.getElementById("fmg-fgt-device").value.trim();
      var path = document.getElementById("fmg-fgt-path").value.trim();
      if (!deviceName) { showToast("Enter the FMG device name of the FortiGate", "error"); return; }
      if (!path) { showToast("Enter a path (e.g. /api/v2/monitor/system/status)", "error"); return; }
      var query = {};
      document.getElementById("fmg-fgt-query").value.split("\n").forEach(function (line) {
        var trimmed = line.trim();
        if (!trimmed) return;
        var eq = trimmed.indexOf("=");
        if (eq < 0) { query[trimmed] = ""; return; }
        var key = trimmed.slice(0, eq).trim();
        var value = trimmed.slice(eq + 1).trim();
        if (key) query[key] = value;
      });
      payload = {
        mode: "fortigate",
        deviceName: deviceName,
        method: document.getElementById("fmg-fgt-method").value,
        path: path,
        query: query,
      };
    } else {
      var method = document.getElementById("fmg-method").value;
      var paramsRaw = document.getElementById("fmg-params").value.trim();
      var params;
      try {
        params = JSON.parse(paramsRaw);
        if (!Array.isArray(params)) throw new Error("Params must be a JSON array");
      } catch (e) {
        showToast("Invalid JSON: " + e.message, "error");
        return;
      }
      payload = { mode: "fmg", method: method, params: params };
    }
    btn.disabled = true;
    btn.textContent = "Sending…";
    var responseWrap = document.getElementById("fmg-response-wrap");
    var responsePre = document.getElementById("fmg-response");
    try {
      var result = await api.integrations.query(id, payload);
      responseWrap.style.display = "";
      responsePre.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      responseWrap.style.display = "";
      responsePre.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  });

  document.getElementById("fmg-copy-btn").addEventListener("click", function () {
    var text = document.getElementById("fmg-response").textContent;
    var btn = this;
    navigator.clipboard.writeText(text).then(function () {
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = "Copy"; }, 1500);
    }).catch(function () { showToast("Copy failed", "error"); });
  });
}

// ─── FortiGate API Query modal ──────────────────────────────────────────────

var _FGT_PRESET_QUERIES = [
  {
    name: "System status",
    method: "GET",
    path: "/api/v2/monitor/system/status",
    query: "vdom=root",
  },
  {
    name: "DHCP servers",
    method: "GET",
    path: "/api/v2/cmdb/system.dhcp/server",
    query: "vdom=root",
  },
  {
    name: "DHCP leases",
    method: "GET",
    path: "/api/v2/monitor/system/dhcp",
    query: "vdom=root",
  },
  {
    name: "Interface IPs",
    method: "GET",
    path: "/api/v2/cmdb/system/interface",
    query: "vdom=root\nformat=name|ip|type|status|vdom",
  },
  {
    name: "Firewall VIPs",
    method: "GET",
    path: "/api/v2/cmdb/firewall/vip",
    query: "vdom=root",
  },
  {
    name: "Managed FortiSwitches",
    method: "GET",
    path: "/api/v2/monitor/switch-controller/managed-switch/status",
    query: "vdom=root\nformat=switch-id|serial|connecting_from|state|status|os_version",
  },
  {
    name: "Managed FortiAPs",
    method: "GET",
    path: "/api/v2/monitor/wifi/managed_ap",
    query: "vdom=root",
  },
  {
    name: "ARP table",
    method: "GET",
    path: "/api/v2/monitor/system/arp",
    query: "vdom=root",
  },
  {
    name: "Routing table (IPv4)",
    method: "GET",
    path: "/api/v2/monitor/router/ipv4",
    query: "vdom=root",
  },
];

var _FGT_QUERIES_VERSION = 1;

function _fgtLoadQueries() {
  try {
    var stored = JSON.parse(localStorage.getItem("polaris-fgt-queries") || "null");
    if (!stored || stored.v !== _FGT_QUERIES_VERSION) {
      var initial = { v: _FGT_QUERIES_VERSION, queries: _FGT_PRESET_QUERIES.slice() };
      localStorage.setItem("polaris-fgt-queries", JSON.stringify(initial));
      return _FGT_PRESET_QUERIES.slice();
    }
    return stored.queries;
  } catch (_) { return []; }
}

function _fgtPersistQueries(queries) {
  localStorage.setItem("polaris-fgt-queries", JSON.stringify({ v: _FGT_QUERIES_VERSION, queries: queries }));
}

function _fgtRenderSavedSelect(queries, selectValue) {
  var sel = document.getElementById("fgt-saved-select");
  if (!sel) return;
  sel.innerHTML = '<option value="">— load a saved query —</option>' +
    queries.map(function (q, i) {
      return '<option value="' + i + '"' + (String(i) === String(selectValue) ? " selected" : "") + '>' + escapeHtml(q.name) + '</option>';
    }).join("");
}

function openFgtApiQueryModal(id, vdom) {
  vdom = vdom || "root";

  var body =
    '<div style="margin-bottom:0.75rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Saved Queries</p>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<select id="fgt-saved-select" style="flex:1"></select>' +
        '<button class="btn btn-sm btn-secondary" id="fgt-load-btn">Load</button>' +
        '<button class="btn btn-sm btn-danger" id="fgt-delete-btn">Delete</button>' +
      '</div>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:0 0 0.75rem">' +
    '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:end">' +
      '<div class="form-group" style="margin:0">' +
        '<label>Method</label>' +
        '<select id="fgt-method" style="width:auto">' +
          '<option value="GET">GET</option>' +
          '<option value="POST">POST</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group" style="margin:0">' +
        '<label>Path</label>' +
        '<input type="text" id="fgt-path" value="/api/v2/monitor/system/status" placeholder="/api/v2/monitor/system/status" style="font-family:monospace;font-size:0.85rem">' +
      '</div>' +
    '</div>' +
    '<div class="form-group" style="margin-top:0.75rem">' +
      '<label>Query Parameters <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(one per line — <code>key=value</code>)</span></label>' +
      '<textarea id="fgt-query" rows="4" style="font-family:monospace;font-size:0.82rem" placeholder="vdom=' + escapeHtml(vdom) + '&#10;format=mac|ip|hostname">vdom=' + escapeHtml(vdom) + '</textarea>' +
      '<p class="hint">VDOM is set here; add other parameters like <code>format=…</code> or <code>filter=…</code> as needed.</p>' +
    '</div>' +
    '<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem"><button class="btn btn-primary" id="fgt-send">Send</button></div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:0.25rem">' +
      '<input type="text" id="fgt-save-name" placeholder="Name this query to save it…" style="flex:1;font-size:0.85rem">' +
      '<button class="btn btn-sm btn-secondary" id="fgt-save-btn">Save</button>' +
    '</div>' +
    '<div id="fgt-response-wrap" style="display:none;margin-top:1rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
        '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0">Response</p>' +
        '<button class="btn btn-sm btn-secondary" id="fgt-copy-btn" style="padding:2px 10px;font-size:0.75rem">Copy</button>' +
      '</div>' +
      '<pre id="fgt-response" style="background:var(--color-surface-raised);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.75rem;font-size:0.78rem;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;margin:0"></pre>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';

  openModal("FortiGate API Query", body, footer, { wide: true });

  var savedQueries = _fgtLoadQueries();
  _fgtRenderSavedSelect(savedQueries);

  document.getElementById("fgt-load-btn").addEventListener("click", function () {
    var idx = parseInt(document.getElementById("fgt-saved-select").value, 10);
    if (isNaN(idx) || !savedQueries[idx]) return;
    var q = savedQueries[idx];
    document.getElementById("fgt-method").value = q.method || "GET";
    document.getElementById("fgt-path").value = q.path || "";
    document.getElementById("fgt-query").value = q.query || "";
    document.getElementById("fgt-save-name").value = q.name;
  });

  document.getElementById("fgt-delete-btn").addEventListener("click", async function () {
    var idx = parseInt(document.getElementById("fgt-saved-select").value, 10);
    if (isNaN(idx) || !savedQueries[idx]) return;
    var ok = await showConfirm("Delete saved query \"" + savedQueries[idx].name + "\"?");
    if (!ok) return;
    savedQueries.splice(idx, 1);
    _fgtPersistQueries(savedQueries);
    _fgtRenderSavedSelect(savedQueries);
  });

  document.getElementById("fgt-save-btn").addEventListener("click", function () {
    var name = document.getElementById("fgt-save-name").value.trim();
    if (!name) { showToast("Enter a name for this query", "error"); return; }
    var method = document.getElementById("fgt-method").value;
    var path = document.getElementById("fgt-path").value.trim();
    var query = document.getElementById("fgt-query").value;
    var existIdx = -1;
    savedQueries.forEach(function (q, i) { if (q.name === name) existIdx = i; });
    var entry = { name: name, method: method, path: path, query: query };
    if (existIdx >= 0) {
      savedQueries[existIdx] = entry;
    } else {
      savedQueries.push(entry);
      existIdx = savedQueries.length - 1;
    }
    _fgtPersistQueries(savedQueries);
    _fgtRenderSavedSelect(savedQueries, existIdx);
    showToast("Query saved");
  });

  document.getElementById("fgt-send").addEventListener("click", async function () {
    var btn = this;
    var method = document.getElementById("fgt-method").value;
    var path = document.getElementById("fgt-path").value.trim();
    if (!path) { showToast("Enter a path (e.g. /api/v2/monitor/system/status)", "error"); return; }
    var queryRaw = document.getElementById("fgt-query").value;
    var query = {};
    queryRaw.split("\n").forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      var eq = trimmed.indexOf("=");
      if (eq < 0) { query[trimmed] = ""; return; }
      var key = trimmed.slice(0, eq).trim();
      var value = trimmed.slice(eq + 1).trim();
      if (key) query[key] = value;
    });
    btn.disabled = true;
    btn.textContent = "Sending…";
    var responseWrap = document.getElementById("fgt-response-wrap");
    var responsePre = document.getElementById("fgt-response");
    try {
      var result = await api.integrations.query(id, { method: method, path: path, query: query });
      responseWrap.style.display = "";
      responsePre.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      responseWrap.style.display = "";
      responsePre.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  });

  document.getElementById("fgt-copy-btn").addEventListener("click", function () {
    var text = document.getElementById("fgt-response").textContent;
    var btn = this;
    navigator.clipboard.writeText(text).then(function () {
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = "Copy"; }, 1500);
    }).catch(function () { showToast("Copy failed", "error"); });
  });
}

// ─── Entra ID API Query modal ───────────────────────────────────────────────

var _ENTRA_PRESET_QUERIES = [
  {
    name: "All registered devices",
    path: "/v1.0/devices",
    query: "$top=25\n$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType,approximateLastSignInDateTime",
  },
  {
    name: "All managed devices (Intune)",
    path: "/v1.0/deviceManagement/managedDevices",
    query: "$top=25\n$select=id,azureADDeviceId,deviceName,operatingSystem,osVersion,complianceState,lastSyncDateTime,userPrincipalName,chassisType",
  },
  {
    name: "Windows devices only",
    path: "/v1.0/devices",
    query: "$top=25\n$filter=operatingSystem eq 'Windows'\n$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType,approximateLastSignInDateTime",
  },
  {
    name: "Device by display name prefix (edit startswith value)",
    path: "/v1.0/devices",
    query: "$filter=startswith(displayName,'LAPTOP')\n$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType",
  },
  {
    name: "Non-compliant devices (Intune)",
    path: "/v1.0/deviceManagement/managedDevices",
    query: "$filter=complianceState eq 'noncompliant'\n$select=id,deviceName,operatingSystem,complianceState,lastSyncDateTime,userPrincipalName\n$top=25",
  },
  {
    name: "Hybrid-joined devices",
    path: "/v1.0/devices",
    query: "$filter=trustType eq 'ServerAd'\n$top=25\n$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,onPremisesSecurityIdentifier,approximateLastSignInDateTime",
  },
  {
    name: "Users (summary)",
    path: "/v1.0/users",
    query: "$top=25\n$select=id,displayName,userPrincipalName,accountEnabled,jobTitle,department",
  },
  {
    name: "Groups",
    path: "/v1.0/groups",
    query: "$top=25\n$select=id,displayName,groupTypes,membershipRule,mail",
  },
];

var _ENTRA_QUERIES_VERSION = 1;

function _entraLoadQueries() {
  try {
    var stored = JSON.parse(localStorage.getItem("polaris-entra-queries") || "null");
    if (!stored || stored.v !== _ENTRA_QUERIES_VERSION) {
      var initial = { v: _ENTRA_QUERIES_VERSION, queries: _ENTRA_PRESET_QUERIES.slice() };
      localStorage.setItem("polaris-entra-queries", JSON.stringify(initial));
      return _ENTRA_PRESET_QUERIES.slice();
    }
    return stored.queries;
  } catch (_) { return []; }
}

function _entraPersistQueries(queries) {
  localStorage.setItem("polaris-entra-queries", JSON.stringify({ v: _ENTRA_QUERIES_VERSION, queries: queries }));
}

function _entraRenderSavedSelect(queries, selectValue) {
  var sel = document.getElementById("entra-saved-select");
  if (!sel) return;
  sel.innerHTML = '<option value="">— load a saved query —</option>' +
    queries.map(function (q, i) {
      return '<option value="' + i + '"' + (String(i) === String(selectValue) ? " selected" : "") + '>' + escapeHtml(q.name) + '</option>';
    }).join("");
}

function openEntraApiQueryModal(id) {
  var body =
    '<div style="margin-bottom:0.75rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Saved Queries</p>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<select id="entra-saved-select" style="flex:1"></select>' +
        '<button class="btn btn-sm btn-secondary" id="entra-load-btn">Load</button>' +
        '<button class="btn btn-sm btn-danger" id="entra-delete-btn">Delete</button>' +
      '</div>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:0 0 0.75rem">' +
    '<div class="form-group">' +
      '<label>Path <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(GET only — must begin with <code>/v1.0/</code> or <code>/beta/</code>)</span></label>' +
      '<input type="text" id="entra-path" value="/v1.0/devices" placeholder="/v1.0/deviceManagement/managedDevices" style="font-family:monospace;font-size:0.85rem">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Query Parameters <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(one per line — <code>key=value</code>)</span></label>' +
      '<textarea id="entra-query" rows="5" style="font-family:monospace;font-size:0.82rem" placeholder="$top=10&#10;$select=id,deviceId,displayName&#10;$filter=startswith(displayName,&apos;LAPTOP&apos;)"></textarea>' +
      '<p class="hint">Common: <code>$select=…</code> to limit fields, <code>$filter=…</code> to narrow results, <code>$top=…</code> to cap rows. Host is fixed to <code>graph.microsoft.com</code>.</p>' +
    '</div>' +
    '<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem"><button class="btn btn-primary" id="entra-send">Send</button></div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:0.25rem">' +
      '<input type="text" id="entra-save-name" placeholder="Name this query to save it…" style="flex:1;font-size:0.85rem">' +
      '<button class="btn btn-sm btn-secondary" id="entra-save-btn">Save</button>' +
    '</div>' +
    '<div id="entra-response-wrap" style="display:none;margin-top:1rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
        '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0">Response</p>' +
        '<button class="btn btn-sm btn-secondary" id="entra-copy-btn" style="padding:2px 10px;font-size:0.75rem">Copy</button>' +
      '</div>' +
      '<pre id="entra-response" style="background:var(--color-surface-raised);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.75rem;font-size:0.78rem;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;margin:0"></pre>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';

  openModal("Entra ID / Graph API Query", body, footer, { wide: true });

  var savedQueries = _entraLoadQueries();
  _entraRenderSavedSelect(savedQueries);

  document.getElementById("entra-load-btn").addEventListener("click", function () {
    var idx = parseInt(document.getElementById("entra-saved-select").value, 10);
    if (isNaN(idx) || !savedQueries[idx]) return;
    var q = savedQueries[idx];
    document.getElementById("entra-path").value = q.path || "";
    document.getElementById("entra-query").value = q.query || "";
    document.getElementById("entra-save-name").value = q.name;
  });

  document.getElementById("entra-delete-btn").addEventListener("click", async function () {
    var idx = parseInt(document.getElementById("entra-saved-select").value, 10);
    if (isNaN(idx) || !savedQueries[idx]) return;
    var ok = await showConfirm("Delete saved query \"" + savedQueries[idx].name + "\"?");
    if (!ok) return;
    savedQueries.splice(idx, 1);
    _entraPersistQueries(savedQueries);
    _entraRenderSavedSelect(savedQueries);
  });

  document.getElementById("entra-save-btn").addEventListener("click", function () {
    var name = document.getElementById("entra-save-name").value.trim();
    if (!name) { showToast("Enter a name for this query", "error"); return; }
    var path = document.getElementById("entra-path").value.trim();
    var query = document.getElementById("entra-query").value;
    var existIdx = -1;
    savedQueries.forEach(function (q, i) { if (q.name === name) existIdx = i; });
    var entry = { name: name, path: path, query: query };
    if (existIdx >= 0) {
      savedQueries[existIdx] = entry;
    } else {
      savedQueries.push(entry);
      existIdx = savedQueries.length - 1;
    }
    _entraPersistQueries(savedQueries);
    _entraRenderSavedSelect(savedQueries, existIdx);
    showToast("Query saved");
  });

  document.getElementById("entra-send").addEventListener("click", async function () {
    var btn = this;
    var path = document.getElementById("entra-path").value.trim();
    if (!path) { showToast("Enter a path (e.g. /v1.0/devices)", "error"); return; }
    var queryRaw = document.getElementById("entra-query").value;
    var query = {};
    queryRaw.split("\n").forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      var eq = trimmed.indexOf("=");
      if (eq < 0) { query[trimmed] = ""; return; }
      var key = trimmed.slice(0, eq).trim();
      var value = trimmed.slice(eq + 1).trim();
      if (key) query[key] = value;
    });
    btn.disabled = true;
    btn.textContent = "Sending…";
    var responseWrap = document.getElementById("entra-response-wrap");
    var responsePre = document.getElementById("entra-response");
    try {
      var result = await api.integrations.query(id, { path: path, query: query });
      responseWrap.style.display = "";
      responsePre.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      responseWrap.style.display = "";
      responsePre.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  });

  document.getElementById("entra-copy-btn").addEventListener("click", function () {
    var text = document.getElementById("entra-response").textContent;
    var btn = this;
    navigator.clipboard.writeText(text).then(function () {
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = "Copy"; }, 1500);
    }).catch(function () { showToast("Copy failed", "error"); });
  });
}

// ─── Active Directory LDAP Query modal ──────────────────────────────────────

var _AD_PRESET_QUERIES = [
  {
    name: "All computers (summary)",
    filter: "(&(objectCategory=computer)(objectClass=computer))",
    attributes: "cn, dNSHostName, operatingSystem, operatingSystemVersion, userAccountControl, lastLogonTimestamp",
    sizeLimit: "50",
  },
  {
    name: "Servers (by OS)",
    filter: "(&(objectCategory=computer)(objectClass=computer)(operatingSystem=*Server*))",
    attributes: "cn, dNSHostName, operatingSystem, operatingSystemVersion, lastLogonTimestamp, whenCreated",
    sizeLimit: "50",
  },
  {
    name: "Workstations (non-server OS)",
    filter: "(&(objectCategory=computer)(objectClass=computer)(!(operatingSystem=*Server*)))",
    attributes: "cn, dNSHostName, operatingSystem, operatingSystemVersion, lastLogonTimestamp",
    sizeLimit: "50",
  },
  {
    name: "Disabled computer accounts",
    filter: "(&(objectCategory=computer)(objectClass=computer)(userAccountControl:1.2.840.113556.1.4.803:=2))",
    attributes: "cn, dNSHostName, operatingSystem, userAccountControl, whenCreated, distinguishedName",
    sizeLimit: "50",
  },
  {
    name: "Never logged on computers",
    filter: "(&(objectCategory=computer)(objectClass=computer)(!(lastLogonTimestamp=*)))",
    attributes: "cn, dNSHostName, operatingSystem, whenCreated, distinguishedName",
    sizeLimit: "50",
  },
  {
    name: "Computer by hostname (edit CN=)",
    filter: "(&(objectCategory=computer)(cn=HOSTNAME*))",
    attributes: "cn, dNSHostName, distinguishedName, operatingSystem, operatingSystemVersion, objectGUID, objectSid, userAccountControl, lastLogonTimestamp, whenCreated, description",
    sizeLimit: "10",
  },
  {
    name: "All OUs (directory structure)",
    filter: "(objectClass=organizationalUnit)",
    attributes: "ou, distinguishedName, description",
    sizeLimit: "200",
  },
  {
    name: "User accounts (summary)",
    filter: "(&(objectCategory=person)(objectClass=user))",
    attributes: "sAMAccountName, displayName, mail, userAccountControl, lastLogon, distinguishedName",
    sizeLimit: "50",
  },
];

var _AD_QUERIES_VERSION = 1;

function _adLoadQueries() {
  try {
    var stored = JSON.parse(localStorage.getItem("polaris-ad-queries") || "null");
    if (!stored || stored.v !== _AD_QUERIES_VERSION) {
      var initial = { v: _AD_QUERIES_VERSION, queries: _AD_PRESET_QUERIES.slice() };
      localStorage.setItem("polaris-ad-queries", JSON.stringify(initial));
      return _AD_PRESET_QUERIES.slice();
    }
    return stored.queries;
  } catch (_) { return []; }
}

function _adPersistQueries(queries) {
  localStorage.setItem("polaris-ad-queries", JSON.stringify({ v: _AD_QUERIES_VERSION, queries: queries }));
}

function _adRenderSavedSelect(queries, selectValue) {
  var sel = document.getElementById("ad-saved-select");
  if (!sel) return;
  sel.innerHTML = '<option value="">— load a saved query —</option>' +
    queries.map(function (q, i) {
      return '<option value="' + i + '"' + (String(i) === String(selectValue) ? " selected" : "") + '>' + escapeHtml(q.name) + '</option>';
    }).join("");
}

function openAdApiQueryModal(id) {
  var body =
    '<div style="margin-bottom:0.75rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Saved Queries</p>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<select id="ad-saved-select" style="flex:1"></select>' +
        '<button class="btn btn-sm btn-secondary" id="ad-load-btn">Load</button>' +
        '<button class="btn btn-sm btn-danger" id="ad-delete-btn">Delete</button>' +
      '</div>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:0 0 0.75rem">' +
    '<div class="form-group">' +
      '<label>Filter <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(LDAP search filter)</span></label>' +
      '<input type="text" id="ad-filter" value="(&(objectCategory=computer)(objectClass=computer))" style="font-family:monospace;font-size:0.85rem">' +
      '<p class="hint">Examples: <code>(&(objectCategory=computer)(operatingSystem=*Server*))</code> &nbsp;·&nbsp; <code>(&(objectCategory=person)(objectClass=user))</code></p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Attributes <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(comma-separated; leave empty for all)</span></label>' +
      '<input type="text" id="ad-attributes" value="cn, dNSHostName, operatingSystem, operatingSystemVersion, userAccountControl, lastLogonTimestamp" style="font-family:monospace;font-size:0.85rem">' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end">' +
      '<div class="form-group" style="margin-bottom:0">' +
        '<label>Base DN override <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(optional)</span></label>' +
        '<input type="text" id="ad-basedn" placeholder="Defaults to integration base DN" style="font-family:monospace;font-size:0.85rem">' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:0">' +
        '<label>Scope</label>' +
        '<select id="ad-scope" style="width:auto">' +
          '<option value="sub" selected>Subtree (recursive)</option>' +
          '<option value="one">One level</option>' +
          '<option value="base">Base only</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:0">' +
        '<label>Limit</label>' +
        '<input type="number" id="ad-sizelimit" value="50" min="1" max="500" style="width:70px">' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;justify-content:flex-end;margin:0.75rem 0"><button class="btn btn-primary" id="ad-send">Send</button></div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:0.25rem">' +
      '<input type="text" id="ad-save-name" placeholder="Name this query to save it…" style="flex:1;font-size:0.85rem">' +
      '<button class="btn btn-sm btn-secondary" id="ad-save-btn">Save</button>' +
    '</div>' +
    '<div id="ad-response-wrap" style="display:none;margin-top:1rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
        '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0">Response</p>' +
        '<button class="btn btn-sm btn-secondary" id="ad-copy-btn" style="padding:2px 10px;font-size:0.75rem">Copy</button>' +
      '</div>' +
      '<pre id="ad-response" style="background:var(--color-surface-raised);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.75rem;font-size:0.78rem;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;margin:0"></pre>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';

  openModal("Active Directory LDAP Query", body, footer, { wide: true });

  var savedQueries = _adLoadQueries();
  _adRenderSavedSelect(savedQueries);

  document.getElementById("ad-load-btn").addEventListener("click", function () {
    var idx = parseInt(document.getElementById("ad-saved-select").value, 10);
    if (isNaN(idx) || !savedQueries[idx]) return;
    var q = savedQueries[idx];
    document.getElementById("ad-filter").value = q.filter || "";
    document.getElementById("ad-attributes").value = q.attributes || "";
    if (q.sizeLimit) document.getElementById("ad-sizelimit").value = q.sizeLimit;
    document.getElementById("ad-save-name").value = q.name;
  });

  document.getElementById("ad-delete-btn").addEventListener("click", async function () {
    var idx = parseInt(document.getElementById("ad-saved-select").value, 10);
    if (isNaN(idx) || !savedQueries[idx]) return;
    var ok = await showConfirm("Delete saved query \"" + savedQueries[idx].name + "\"?");
    if (!ok) return;
    savedQueries.splice(idx, 1);
    _adPersistQueries(savedQueries);
    _adRenderSavedSelect(savedQueries);
  });

  document.getElementById("ad-save-btn").addEventListener("click", function () {
    var name = document.getElementById("ad-save-name").value.trim();
    if (!name) { showToast("Enter a name for this query", "error"); return; }
    var filter = document.getElementById("ad-filter").value.trim();
    var attributes = document.getElementById("ad-attributes").value;
    var sizeLimit = document.getElementById("ad-sizelimit").value;
    var existIdx = -1;
    savedQueries.forEach(function (q, i) { if (q.name === name) existIdx = i; });
    var entry = { name: name, filter: filter, attributes: attributes, sizeLimit: sizeLimit };
    if (existIdx >= 0) {
      savedQueries[existIdx] = entry;
    } else {
      savedQueries.push(entry);
      existIdx = savedQueries.length - 1;
    }
    _adPersistQueries(savedQueries);
    _adRenderSavedSelect(savedQueries, existIdx);
    showToast("Query saved");
  });

  document.getElementById("ad-send").addEventListener("click", async function () {
    var btn = this;
    var filter = document.getElementById("ad-filter").value.trim();
    if (!filter) { showToast("Enter a filter (e.g. (&(objectCategory=computer)(objectClass=computer)))", "error"); return; }
    var attrsRaw = document.getElementById("ad-attributes").value;
    var attrs = attrsRaw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var baseDn = document.getElementById("ad-basedn").value.trim() || undefined;
    var scope = document.getElementById("ad-scope").value;
    var sizeLimit = parseInt(document.getElementById("ad-sizelimit").value, 10) || 50;

    btn.disabled = true;
    btn.textContent = "Sending…";
    var responseWrap = document.getElementById("ad-response-wrap");
    var responsePre = document.getElementById("ad-response");
    try {
      var body = { filter: filter, scope: scope, sizeLimit: sizeLimit };
      if (attrs.length > 0) body.attributes = attrs;
      if (baseDn) body.baseDn = baseDn;
      var result = await api.integrations.query(id, body);
      responseWrap.style.display = "";
      responsePre.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      responseWrap.style.display = "";
      responsePre.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  });

  document.getElementById("ad-copy-btn").addEventListener("click", function () {
    var text = document.getElementById("ad-response").textContent;
    var btn = this;
    navigator.clipboard.writeText(text).then(function () {
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = "Copy"; }, 1500);
    }).catch(function () { showToast("Copy failed", "error"); });
  });
}
