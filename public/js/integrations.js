/**
 * public/js/integrations.js — Integrations management page
 */

document.addEventListener("DOMContentLoaded", function () {
  loadIntegrations();
  document.getElementById("btn-add-integration").addEventListener("click", showTypePicker);
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
    return '<span' + title + ' style="display:inline-flex;align-items:center;gap:6px;font-size:0.78rem;padding:0.3rem 0.6rem;border-radius:var(--radius-md);font-weight:500;' + style + '">' +
      '<span class="query-spinner"></span>' +
      '<span>' + label + '</span>' +
      '<button class="query-abort-btn" style="margin-left:2px" onclick="abortIntegrationDiscovery(\'' + id + '\',\'' + escapeHtml(name) + '\')" title="Abort">&#x2715;</button>' +
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
          '<div class="detail-row"><span class="detail-label">Bind Password</span><span class="detail-value mono">' + escapeHtml(config.bindPassword || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Base DN</span><span class="detail-value mono">' + escapeHtml(config.baseDn || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Search Scope</span><span class="detail-value">' + escapeHtml(config.searchScope || "sub") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Verify TLS</span><span class="detail-value">' + (config.verifyTls ? "Yes" : "No") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Include Disabled</span><span class="detail-value">' + (config.includeDisabled === false ? "No (skipped)" : "Yes (as disabled)") + '</span></div>' +
          filterRow("OUs", config.ouInclude, config.ouExclude);
      } else if (intg.type === "entraid") {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Tenant ID</span><span class="detail-value mono">' + escapeHtml(config.tenantId || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Client ID</span><span class="detail-value mono">' + escapeHtml(config.clientId || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Client Secret</span><span class="detail-value mono">' + escapeHtml(config.clientSecret || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Intune Sync</span><span class="detail-value">' + (config.enableIntune ? "Enabled" : "Disabled") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Include Disabled</span><span class="detail-value">' + (config.includeDisabled === false ? "No (skipped)" : "Yes (as disabled)") + '</span></div>' +
          filterRow("Devices", config.deviceInclude, config.deviceExclude);
      } else if (intg.type === "windowsserver") {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || defaultPort) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Username</span><span class="detail-value">' + escapeHtml(config.username || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Password</span><span class="detail-value mono">' + escapeHtml(config.password || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Domain</span><span class="detail-value">' + escapeHtml(config.domain || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Use SSL</span><span class="detail-value">' + (config.useSsl ? "Yes" : "No") + '</span></div>' +
          filterRow("DHCP", config.dhcpInclude, config.dhcpExclude);
      } else if (intg.type === "fortigate") {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || defaultPort) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">API User</span><span class="detail-value">' + escapeHtml(config.apiUser || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">API Token</span><span class="detail-value mono">' + escapeHtml(config.apiToken || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">VDOM</span><span class="detail-value">' + escapeHtml(config.vdom || "root") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">SSL Verify</span><span class="detail-value">' + (config.verifySsl ? "Yes" : "No") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Mgmt Interface</span><span class="detail-value mono">' + escapeHtml(config.mgmtInterface || "-") + '</span></div>' +
          filterRow("DHCP", config.dhcpInclude, config.dhcpExclude) +
          filterRow("Inventory", config.inventoryIncludeInterfaces, config.inventoryExcludeInterfaces);
      } else {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || defaultPort) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">API User</span><span class="detail-value">' + escapeHtml(config.apiUser || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">API Token</span><span class="detail-value mono">' + escapeHtml(config.apiToken || "-") + '</span></div>' +
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
        if (nextRunMs <= Date.now()) {
          nextDiscoveryText = '<span style="color:var(--color-text-tertiary)">Pending next check (within 15 min)</span>';
        } else {
          nextDiscoveryText = escapeHtml(new Date(nextRunMs).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }));
        }
      }

      var isFmgDirect = intg.type === "fortimanager" && config.useProxy === false;
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
          '<div class="detail-row"><span class="detail-label">Status</span><span class="detail-value">' + (intg.enabled ? '<span class="badge badge-active">Enabled</span>' : '<span class="badge badge-deprecated">Disabled</span>') + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Last Tested</span><span class="detail-value">' + lastTest + '</span></div>' +
        '</div>' +
      '</div>';
    }).join("");
  } catch (err) {
    container.innerHTML = '<p class="empty-state">Error: ' + escapeHtml(err.message) + '</p>';
  }
}

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

// Reservation Push tab body. Renders the master toggle plus mode-aware
// guidance: when useProxy is on the reservation lands on the FortiGate via
// FMG's REST proxy in real time; when it's off the reservation goes direct
// to the FortiGate's REST API using fortigateApiUser/fortigateApiToken on
// the Settings tab. Either way, every Polaris reservation create on a
// subnet discovered by this integration must succeed and verify on the
// device — failures abort the create.
//
// `pushReservations` is the current toggle value; `useProxy` is the current
// transport setting on the General tab (we read it at render time only).
function reservationPushFormHTML(pushReservations, useProxy) {
  var checked = pushReservations === true ? "checked" : "";
  var modeLabel = (useProxy === false)
    ? "Direct to each FortiGate"
    : "Proxy through FortiManager to each FortiGate";
  var modeBody = (useProxy === false)
    ? "Reservations are written to each FortiGate's REST API using the per-device API token configured on the Settings tab. FortiManager is bypassed entirely. Each reservation lands on the running config in real time."
    : "Reservations are written through FortiManager's <code>/sys/proxy/json</code> endpoint, which forwards the call to the target FortiGate using FortiManager's stored device credentials. Each reservation lands on the running config in real time; FortiManager will see the change on its next config sync.";
  return '<div class="form-section">' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
      '<input type="checkbox" id="f-pushReservations" ' + checked + ' style="width:auto">' +
      '<label for="f-pushReservations" style="margin:0;font-weight:500">Push manual IP reservations from Polaris back to FortiGate</label>' +
    '</div>' +
    '<p class="hint" style="margin-bottom:1rem">When checked, every manual reservation created on a subnet discovered by this integration is written to the FortiGate at create time. The Polaris reservation only commits if the device write succeeds and the entry verifies on read-back; any failure aborts the create.</p>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Push transport (current setting)</p>' +
    '<p style="margin:0 0 0.4rem 0;font-weight:500">' + escapeHtml(modeLabel) + '</p>' +
    '<p class="hint" style="margin-bottom:1rem">' + modeBody + '</p>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Required FortiManager admin profile changes</p>' +
    '<ul style="margin:0 0 0.5rem 1.2rem;padding:0;font-size:0.85rem">' +
      '<li><strong>Device Manager</strong> &rarr; Read-Write</li>' +
      '<li style="margin-left:1.2rem"><strong>Manage Device Configurations</strong> &rarr; Read-Write &nbsp;<span style="color:var(--color-text-tertiary)">&larr; the actual gate</span></li>' +
      '<li>All other Device Manager sub-items &mdash; leave at Read-Only or None</li>' +
      '<li><strong>Policy &amp; Objects</strong> &mdash; leave at Read-Only or None</li>' +
      '<li style="margin-left:1.2rem"><strong>Install Policy Package or Device Configuration</strong> &rarr; None &nbsp;<span style="color:var(--color-text-tertiary)">&larr; Polaris never triggers installs</span></li>' +
    '</ul>' +
    '<div class="form-group" style="background:var(--color-warning-bg, rgba(255,193,7,0.08));border:1px solid var(--color-warning, #ffc107);border-radius:4px;padding:0.6rem 0.8rem;margin-top:0.6rem">' +
      '<p style="margin:0 0 0.4rem 0;font-weight:500;color:var(--color-warning, #ffc107)">&#9888; Blast radius</p>' +
      '<p class="hint" style="margin:0">FortiManager admin profiles do not have a per-object permission for DHCP reservations. <strong>Manage Device Configurations</strong> grants write access to every CMDB tree on every FortiGate in this ADOM. A compromised Polaris API token could in principle modify other device-level config &mdash; interfaces, routing, other DHCP scopes &mdash; not just the reservations Polaris pushes. Treat the API token as a privileged credential and rotate on the same cadence as your other admin secrets.</p>' +
    '</div>' +
    '<div class="form-group" style="background:var(--color-info-bg, rgba(33,150,243,0.06));border:1px solid var(--color-info, #2196f3);border-radius:4px;padding:0.6rem 0.8rem;margin-top:0.6rem">' +
      '<p style="margin:0 0 0.4rem 0;font-weight:500;color:var(--color-info, #2196f3)">&#128161; Tighter scope alternative</p>' +
      '<p class="hint" style="margin:0">For tighter scope, switch to direct mode (uncheck <em>Query each FortiGate directly (bypass FortiManager proxy)</em> on the Settings tab) and configure a per-FortiGate REST API admin with <strong>Network &rarr; Custom &rarr; Configuration</strong> set to Read/Write. This scopes write access to one FortiGate\'s network-configuration bucket instead of every CMDB tree on every device in the ADOM.</p>' +
    '</div>' +
  '</div>';
}

// Read the toggle's current value out of the Reservation Push tab. Returns
// undefined when the tab didn't render (non-FMG integration types) so the
// caller can leave the existing config alone.
function _readPushReservationsToggle() {
  var el = document.getElementById("f-pushReservations");
  if (!el) return undefined;
  return !!el.checked;
}

// Per-integration monitoring transport block rendered at the top of the
// FortiGates subtab on the Monitoring tab. Renders an SNMP credential picker
// plus four checkboxes that decide which streams (response-time, telemetry,
// interfaces, LLDP) ride SNMP vs the default FortiOS REST API. IPsec is always
// REST regardless — SNMP has no equivalent.
//
// `sources` is the integration's current transport config:
//   { responseTime: "rest"|"snmp", telemetry: ..., interfaces: ..., lldp: ... }
// All default to "rest".
function integrationMonitorOverrideHTML(credentials, selectedId, sources) {
  sources = sources || {};
  var rt = sources.responseTime === "snmp";
  var tl = sources.telemetry    === "snmp";
  var iv = sources.interfaces   === "snmp";
  var ll = sources.lldp         === "snmp";
  var snmp = (credentials || []).filter(function (c) { return c.type === "snmp"; });
  var options = '<option value="">— none —</option>' +
    snmp.map(function (c) {
      var sel = (selectedId && c.id === selectedId) ? " selected" : "";
      return '<option value="' + escapeHtml(c.id) + '"' + sel + '>' + escapeHtml(c.name) + '</option>';
    }).join("");
  var emptyHint = snmp.length === 0
    ? '<p class="hint" style="color:var(--color-warning)">No SNMP credentials defined yet — add one under Server Settings &gt; Credentials before enabling any SNMP toggle.</p>'
    : '<p class="hint">Used by every stream below toggled to SNMP. A per-asset credential on the Asset Monitoring tab takes precedence when set.</p>';
  function row(id, label, checked, hint) {
    return '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.4rem">' +
        '<input type="checkbox" id="' + id + '" ' + (checked ? "checked" : "") + ' style="width:auto">' +
        '<label for="' + id + '" style="margin:0;font-weight:500">' + escapeHtml(label) + '</label>' +
      '</div>' +
      '<p class="hint" style="margin:-0.2rem 0 0.7rem 1.6rem">' + hint + '</p>';
  }
  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Monitoring transport</p>' +
    '<div class="form-group">' +
      '<label>SNMP credential</label>' +
      '<select id="f-mon-credential">' + options + '</select>' +
      emptyHint +
    '</div>' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0.6rem 0 0.5rem">Use SNMP for</p>' +
    row("f-mon-src-responseTime", "Response time",
        rt,
        'SNMP <code>sysUpTime</code> instead of FortiOS REST <code>/system/status</code>. Typically much faster.') +
    row("f-mon-src-telemetry",    "Telemetry (CPU, memory, temperature)",
        tl,
        'Vendor SNMP profile + ENTITY-SENSOR/<code>fgHwSensorTable</code> instead of FortiOS REST <code>/resource/usage</code> + <code>/sensor-info</code>. Use this on branch FortiGates (40F/60F/61F/91G/101F class) whose REST sensor endpoint 404s on FortiOS 7.4.x.') +
    row("f-mon-src-interfaces",   "Interfaces (and storage)",
        iv,
        'IF-MIB + HOST-RESOURCES instead of FortiOS REST <code>/system/interface</code>. IPsec tunnels stay on REST regardless — SNMP has no equivalent.') +
    row("f-mon-src-lldp",         "LLDP neighbor discovery",
        ll,
        'LLDP-MIB walk (<code>lldpRemTable</code>) instead of FortiOS REST <code>/system/interface/lldp-neighbors</code>. Useful when the REST endpoint 404s on a given firmware but LLDP-MIB still reports neighbors. Decoupled from "Interfaces" so the operator can pick the working source per-stream.') +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">';
}

// Build a per-class timer block. The id prefix lets the FortiGate /
// FortiSwitch / FortiAP subtabs each use their own DOM ids while sharing
// the same field set. `defaults` is the FortiGate (top-level) class so
// the FortiSwitch / FortiAP subtabs render the same defaults the operator
// would see if they hadn't customized anything yet.
function _classTimerFieldsHTML(idPrefix, s, defaults) {
  s = s || {};
  defaults = defaults || {};
  function num(name, label, value, defaultValue, min, max, hint) {
    return '<div class="form-group"><label>' + escapeHtml(label) + '</label>' +
      '<input type="number" id="' + idPrefix + name + '" value="' + (value != null ? value : defaultValue) + '" min="' + min + '" max="' + max + '" style="width:120px">' +
      (hint ? '<p class="hint">' + hint + '</p>' : '') +
    '</div>';
  }
  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Response-time polling</p>' +
    num("intervalSeconds",          "Polling interval (seconds)",            s.intervalSeconds,          defaults.intervalSeconds          || 60,  5,  86400, "How often each monitored asset in this class is probed for an up/down ping. Default 60 s.") +
    num("failureThreshold",         "Failure threshold (consecutive misses)", s.failureThreshold,        defaults.failureThreshold         || 3,   1,  100,   "Number of consecutive failed probes before an asset is marked Down.") +
    num("sampleRetentionDays",      "Sample retention (days)",                s.sampleRetentionDays,     defaults.sampleRetentionDays      || 30,  0,  3650,  "How long this class's response-time samples are kept. 0 = forever.") +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Telemetry (CPU + memory)</p>' +
    num("telemetryIntervalSeconds", "Telemetry interval (seconds)",           s.telemetryIntervalSeconds, defaults.telemetryIntervalSeconds || 60, 15,  86400, "How often each asset's CPU and memory snapshot is taken. Default 60 s.") +
    num("telemetryRetentionDays",   "Telemetry retention (days)",             s.telemetryRetentionDays,   defaults.telemetryRetentionDays   || 30,  0,  3650,  "How long telemetry samples are kept. 0 = forever.") +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Interface &amp; storage discovery</p>' +
    num("systemInfoIntervalSeconds","Discovery interval (seconds)",            s.systemInfoIntervalSeconds, defaults.systemInfoIntervalSeconds || 600, 60, 86400, "How often interfaces and storage are scraped. Default 600 s (10 min).") +
    num("systemInfoRetentionDays",  "Sample retention (days)",                 s.systemInfoRetentionDays,  defaults.systemInfoRetentionDays   || 30,  0,  3650,  "How long interface and storage samples are kept. 0 = forever.");
}

// Picker block for the FortiSwitch / FortiAP subtab — "enable direct polling"
// checkbox + SNMP credential dropdown + "Add as Monitored" checkbox. id
// prefix collides if you instantiate twice on the same page; we use distinct
// prefixes per class.
function _classDirectPollHTML(idPrefix, kindLabel, snmpCredentials, currentEnabled, currentCredId, currentAddAsMonitored) {
  var snmp = (snmpCredentials || []).filter(function (c) { return c.type === "snmp"; });
  var options = '<option value="">— select credential —</option>' +
    snmp.map(function (c) {
      var sel = (currentCredId && c.id === currentCredId) ? " selected" : "";
      return '<option value="' + escapeHtml(c.id) + '"' + sel + '>' + escapeHtml(c.name) + '</option>';
    }).join("");
  var emptyHint = snmp.length === 0
    ? '<p class="hint" style="color:var(--color-warning)">No SNMP credentials defined yet — add one under Server Settings &gt; Credentials, or leave direct polling off and Polaris will fall back to ICMP when "Add as Monitored" is checked below.</p>'
    : '<p class="hint">Discovery stamps each newly-found ' + escapeHtml(kindLabel) + ' with this credential. Operator overrides on existing assets are preserved.</p>';
  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Direct polling</p>' +
    '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5;margin:0 0 0.6rem 0">Managed ' + escapeHtml(kindLabel) + 's in FortiLink mode usually keep their own management plane locked down. Polaris can\'t reach them through the controller FortiGate, so direct polling only works when SNMP has been explicitly enabled on the ' + escapeHtml(kindLabel) + ' itself.</p>' +
      '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.6rem">' +
        '<input type="checkbox" id="' + idPrefix + 'enabled" ' + (currentEnabled ? "checked" : "") + ' style="width:auto">' +
        '<label for="' + idPrefix + 'enabled" style="margin:0;font-weight:500">Enable direct polling of managed ' + escapeHtml(kindLabel) + 's</label>' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:0">' +
        '<label>SNMP credential</label>' +
        '<select id="' + idPrefix + 'credentialId">' + options + '</select>' +
        emptyHint +
      '</div>' +
    '</div>' +
    // "Add as Monitored" checkbox — independent of direct polling. When on,
    // each newly-discovered switch/AP is created with monitored=true and
    // either monitorType="snmp" (when direct polling is configured) or
    // monitorType="icmp" (fallback when no SNMP credential is wired up yet).
    // Existing assets are not touched — operator stays in charge of those.
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Auto-monitoring</p>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.4rem">' +
      '<input type="checkbox" id="' + idPrefix + 'addAsMonitored" ' + (currentAddAsMonitored ? "checked" : "") + ' style="width:auto">' +
      '<label for="' + idPrefix + 'addAsMonitored" style="margin:0;font-weight:500">Add discovered ' + escapeHtml(kindLabel) + 's to Assets as Monitored</label>' +
    '</div>' +
    '<p class="hint" style="margin-bottom:1rem">When checked, newly-discovered ' + escapeHtml(kindLabel) + 's land in Assets with monitoring enabled. Without an SNMP credential above, monitorType falls back to <code>icmp</code>. Existing assets are unchanged — flip them individually from the asset modal.</p>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">';
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

function _autoMonitorInterfacesHTML(idPrefix, kindLabel, currentSelection, defaultMode, hasIntegrationId) {
  var sel = currentSelection || null;
  var mode = sel ? sel.mode : "off";
  // Card always renders all four mode panels; visibility is toggled on change.
  function modeRadio(value, label, hint) {
    var checked = (mode === value) ? " checked" : "";
    return '<label style="display:block;margin-bottom:0.35rem;font-weight:500">' +
             '<input type="radio" name="' + idPrefix + 'mode" value="' + value + '"' + checked + ' style="width:auto;margin-right:6px"> ' + escapeHtml(label) +
             (hint ? ' <span style="color:var(--color-text-tertiary);font-weight:400;font-size:0.82rem">— ' + escapeHtml(hint) + '</span>' : '') +
           '</label>';
  }
  // Names panel — populated by /interface-aggregate when first shown.
  var namesPanel = '<div id="' + idPrefix + 'panel-names" style="display:none;margin-top:0.6rem">' +
    (hasIntegrationId
      ? '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
          '<button type="button" class="btn btn-secondary" id="' + idPrefix + 'reload" style="font-size:0.78rem;padding:4px 10px">Refresh from latest discovery</button>' +
          '<span class="hint" id="' + idPrefix + 'names-counter" style="margin:0">Selected: 0</span>' +
        '</div>' +
        '<div id="' + idPrefix + 'names-list" style="max-height:280px;overflow:auto;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:0.5rem;background:var(--color-bg-tertiary)">' +
          '<p class="hint" style="margin:0">Loading…</p>' +
        '</div>'
      : '<p class="hint" style="margin:0;color:var(--color-warning)">Save the integration and run discovery first — interface names are aggregated from already-discovered devices.</p>'
    ) +
  '</div>';
  // Wildcard panel — textarea + onlyUp checkbox.
  var wildcardPatterns = (sel && sel.mode === "wildcard") ? sel.patterns.join("\n") : "";
  var wildcardOnlyUp = (sel && sel.mode === "wildcard") ? sel.onlyUp === true : false;
  var wildcardPanel = '<div id="' + idPrefix + 'panel-wildcard" style="display:none;margin-top:0.6rem">' +
    '<div class="form-group" style="margin-bottom:0.6rem">' +
      '<label>Patterns (one per line — <code>*</code> matches any chars, <code>?</code> matches one)</label>' +
      '<textarea id="' + idPrefix + 'patterns" rows="4" style="font-family:monospace;font-size:0.85rem;width:100%" placeholder="wan*&#10;port4?">' + escapeHtml(wildcardPatterns) + '</textarea>' +
    '</div>' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:0.88rem">' +
      '<input type="checkbox" id="' + idPrefix + 'wildcard-onlyUp"' + (wildcardOnlyUp ? " checked" : "") + ' style="width:auto"> Only currently up' +
      ' <span class="hint" style="margin:0">(skips administratively-disabled and disconnected ports)</span>' +
    '</label>' +
  '</div>';
  // Type panel — five fixed checkboxes + onlyUp.
  var typeSet = (sel && sel.mode === "type") ? new Set(sel.types) : new Set();
  var typeOnlyUp = (sel && sel.mode === "type") ? sel.onlyUp !== false : true; // default true
  function typeBox(name) {
    var on = typeSet.has(name) ? " checked" : "";
    return '<label style="display:flex;align-items:center;gap:6px;font-size:0.88rem;margin-bottom:0.25rem">' +
             '<input type="checkbox" data-type-checkbox="1" id="' + idPrefix + 'type-' + name + '" value="' + name + '"' + on + ' style="width:auto"> ' + name +
           '</label>';
  }
  var typePanel = '<div id="' + idPrefix + 'panel-type" style="display:none;margin-top:0.6rem">' +
    typeBox("physical") + typeBox("aggregate") + typeBox("vlan") + typeBox("loopback") + typeBox("tunnel") +
    '<label style="display:flex;align-items:center;gap:6px;font-size:0.88rem;margin-top:0.5rem">' +
      '<input type="checkbox" id="' + idPrefix + 'type-onlyUp"' + (typeOnlyUp ? " checked" : "") + ' style="width:auto"> Only currently up' +
      ' <span class="hint" style="margin:0">(skips administratively-disabled and disconnected ports)</span>' +
    '</label>' +
  '</div>';
  // Preview block — filled by the wiring code on every change.
  var previewPanel = '<div id="' + idPrefix + 'preview" class="form-group" style="margin-top:0.8rem;padding:0.5rem 0.7rem;background:var(--color-bg-tertiary);border-radius:var(--radius-sm);border:1px solid var(--color-border);font-size:0.84rem;color:var(--color-text-secondary);min-height:1.4em">' +
    (hasIntegrationId ? '<em>Pick a mode to preview matches.</em>' : '<em>Preview becomes available after the integration is saved and discovery has run at least once.</em>') +
  '</div>';
  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Auto-monitor interfaces</p>' +
    '<div style="background:rgba(79,195,247,0.06);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5;margin:0 0 0.7rem 0">Pin interfaces on every ' + escapeHtml(kindLabel) + ' discovered by this integration. Selected interfaces are added to each device\'s "Poll 1m" list and scraped on the response-time cadence (~60s). Operator-pinned interfaces on individual assets are preserved.</p>' +
      '<div class="form-group" style="margin-bottom:0.6rem">' +
        modeRadio("off",      "Disabled",                       "no auto-pinning") +
        modeRadio("names",    "By name",                        "aggregated from devices") +
        modeRadio("wildcard", "By pattern",                     "wildcard match (* and ?)") +
        modeRadio("type",     "By interface type",              "physical / aggregate / vlan / ...") +
      '</div>' +
      namesPanel + wildcardPanel + typePanel + previewPanel +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">';
}

// Reads the auto-monitor card into a server-shaped AutoMonitorSelection or null.
// Returns undefined when the card didn't render (subtab never opened).
function _readAutoMonitorInterfaces(idPrefix) {
  var radios = document.getElementsByName(idPrefix + "mode");
  if (!radios || radios.length === 0) return undefined;
  var mode = "off";
  for (var i = 0; i < radios.length; i++) { if (radios[i].checked) { mode = radios[i].value; break; } }
  if (mode === "off") return null;
  if (mode === "names") {
    var checks = document.querySelectorAll('input[data-name-checkbox="1"][data-prefix="' + idPrefix + '"]:checked');
    var names = [];
    for (var j = 0; j < checks.length; j++) names.push(checks[j].value);
    if (names.length === 0) return null;
    return { mode: "names", names: names };
  }
  if (mode === "wildcard") {
    var ta = document.getElementById(idPrefix + "patterns");
    var raw = ta ? String(ta.value || "") : "";
    var patterns = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (patterns.length === 0) return null;
    var ouEl = document.getElementById(idPrefix + "wildcard-onlyUp");
    return { mode: "wildcard", patterns: patterns, onlyUp: ouEl ? ouEl.checked === true : false };
  }
  if (mode === "type") {
    var typeChecks = document.querySelectorAll('input[data-type-checkbox="1"][id^="' + idPrefix + 'type-"]:checked');
    var types = [];
    for (var k = 0; k < typeChecks.length; k++) {
      var v = typeChecks[k].value;
      if (v === "physical" || v === "aggregate" || v === "vlan" || v === "loopback" || v === "tunnel") types.push(v);
    }
    if (types.length === 0) return null;
    var ou2El = document.getElementById(idPrefix + "type-onlyUp");
    return { mode: "type", types: types, onlyUp: ou2El ? ou2El.checked === true : true };
  }
  return null;
}

// Wires change-listeners on a freshly-rendered auto-monitor card. Toggles
// panel visibility + fetches the aggregate list lazily on first "names" view
// + debounces a preview call into the preview block. Safe to call after the
// card's HTML has been inserted into the DOM.
function _wireAutoMonitorCard(idPrefix, klass, integrationId) {
  var radios = document.getElementsByName(idPrefix + "mode");
  if (!radios || radios.length === 0) return;
  var panels = {
    names:    document.getElementById(idPrefix + "panel-names"),
    wildcard: document.getElementById(idPrefix + "panel-wildcard"),
    type:     document.getElementById(idPrefix + "panel-type"),
  };
  var preview = document.getElementById(idPrefix + "preview");
  var namesLoaded = false;

  function showPanel(mode) {
    panels.names.style.display    = (mode === "names")    ? "" : "none";
    panels.wildcard.style.display = (mode === "wildcard") ? "" : "none";
    panels.type.style.display     = (mode === "type")     ? "" : "none";
    if (mode === "names" && !namesLoaded && integrationId) loadNamesList();
    schedulePreview();
  }

  function loadNamesList(force) {
    if (!integrationId) return;
    var listEl = document.getElementById(idPrefix + "names-list");
    if (!listEl) return;
    if (!force && namesLoaded) return;
    listEl.innerHTML = '<p class="hint" style="margin:0">Loading…</p>';
    api.integrations.interfaceAggregate(integrationId, klass).then(function (resp) {
      namesLoaded = true;
      var rows = (resp && resp.rows) || [];
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
    }).catch(function (err) {
      listEl.innerHTML = '<p class="hint" style="margin:0;color:var(--color-error)">Failed to load: ' + escapeHtml(err.message || "unknown error") + '</p>';
    });
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
      preview.innerHTML = '<em>Pick a mode and at least one value to preview matches.</em>';
      preview.style.borderColor = "";
      return;
    }
    api.integrations.interfaceAggregatePreview(integrationId, { class: klass, selection: selection }).then(function (r) {
      var warn = r.interfaceCount > AUTO_MONITOR_INTERFACE_WARN_THRESHOLD;
      var sample = (r.sampleDevices || []).slice(0, 5).map(function (d) {
        return escapeHtml(d.hostname || "(unnamed)") + ' <span class="hint" style="margin:0;font-size:0.78rem">(' + d.pinNames.length + ')</span>';
      }).join(" · ");
      preview.innerHTML =
        '<div><strong>' + r.interfaceCount + '</strong> interface' + (r.interfaceCount === 1 ? "" : "s") +
        ' on <strong>' + r.deviceCount + '</strong> device' + (r.deviceCount === 1 ? "" : "s") +
        ' (max ' + r.perDeviceMax + '/device)' +
        (warn ? ' <span style="color:var(--color-warning);margin-left:6px">⚠ above warn threshold (' + AUTO_MONITOR_INTERFACE_WARN_THRESHOLD + ')</span>' : '') +
        '</div>' +
        (sample ? '<div style="margin-top:0.3rem;font-size:0.82rem">First matches: ' + sample + '</div>' : '');
      preview.style.borderColor = warn ? "var(--color-warning)" : "";
      // Cache the latest interface count on the card for the Save handler to read.
      preview.dataset.interfaceCount = String(r.interfaceCount);
    }).catch(function (err) {
      preview.innerHTML = '<span style="color:var(--color-error)">Preview failed: ' + escapeHtml(err.message || "unknown error") + '</span>';
    });
  }

  // Wire mode radios.
  for (var i = 0; i < radios.length; i++) {
    radios[i].addEventListener("change", function (e) { showPanel(e.target.value); });
  }
  // Wire wildcard + type changes (debounced preview).
  var wildcardEls = [
    document.getElementById(idPrefix + "patterns"),
    document.getElementById(idPrefix + "wildcard-onlyUp"),
    document.getElementById(idPrefix + "type-onlyUp"),
  ];
  wildcardEls.forEach(function (el) { if (el) el.addEventListener("input", schedulePreview); if (el) el.addEventListener("change", schedulePreview); });
  var typeBoxes = document.querySelectorAll('input[data-type-checkbox="1"][id^="' + idPrefix + 'type-"]');
  for (var t = 0; t < typeBoxes.length; t++) typeBoxes[t].addEventListener("change", schedulePreview);
  // Reload button.
  var reload = document.getElementById(idPrefix + "reload");
  if (reload) reload.addEventListener("click", function () { namesLoaded = false; loadNamesList(true); });

  // Initial state — show whichever panel matches the current mode.
  var initialMode = "off";
  for (var r2 = 0; r2 < radios.length; r2++) { if (radios[r2].checked) { initialMode = radios[r2].value; break; } }
  showPanel(initialMode);
}

// FortiGate subtab variant — only "Add as Monitored" since FortiGates always
// get a monitorType stamped at discovery (the integration's native type).
function _fortigateAddMonitoredHTML(idPrefix, currentAddAsMonitored) {
  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Auto-monitoring</p>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.4rem">' +
      '<input type="checkbox" id="' + idPrefix + 'addAsMonitored" ' + (currentAddAsMonitored ? "checked" : "") + ' style="width:auto">' +
      '<label for="' + idPrefix + 'addAsMonitored" style="margin:0;font-weight:500">Add discovered FortiGates to Assets as Monitored</label>' +
    '</div>' +
    '<p class="hint" style="margin-bottom:1rem">When checked, newly-discovered FortiGates land in Assets with monitoring enabled (the integration\'s API token already provides the probe path). Existing FortiGates are unchanged — flip them individually from the asset modal.</p>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">';
}

// Renders the Monitoring tab as 3 sub-tabs: FortiGates, FortiSwitches,
// FortiAPs. The FortiGates subtab keeps the existing FortiGate-specific
// content (per-integration SNMP probe override + global FortiGate timers).
// FortiSwitches / FortiAPs add a "direct polling" block (enable + SNMP
// credential picker) that drives discovery-time auto-stamping, plus their
// own per-class timer fields (default = the FortiGate values).
//
// The classDefaults below are pulled from the top-level monitor settings
// because the FortiSwitch / FortiAP groups inherit from them on a fresh
// install (server-side resolver picks the top-level when a class field is
// unset). Showing the inherited number as the placeholder lets the operator
// see what's currently in effect even if they haven't customized this class.
function monitorSettingsFormHTML(s, opts) {
  s = s || {};
  opts = opts || {};
  var classDefaults = {
    intervalSeconds: s.intervalSeconds, failureThreshold: s.failureThreshold,
    sampleRetentionDays: s.sampleRetentionDays,
    telemetryIntervalSeconds: s.telemetryIntervalSeconds, telemetryRetentionDays: s.telemetryRetentionDays,
    systemInfoIntervalSeconds: s.systemInfoIntervalSeconds, systemInfoRetentionDays: s.systemInfoRetentionDays,
  };
  var fsClass = s.fortiswitch || {};
  var faClass = s.fortiap     || {};
  var fwSwCfg = opts.fortiswitchMonitor || { enabled: false, snmpCredentialId: null, addAsMonitored: false, autoMonitorInterfaces: null };
  var fwApCfg = opts.fortiapMonitor     || { enabled: false, snmpCredentialId: null, addAsMonitored: false, autoMonitorInterfaces: null };
  var fwFgCfg = opts.fortigateMonitor   || { addAsMonitored: false, autoMonitorInterfaces: null };
  var hasId = !!opts.integrationId;
  // Stash the originally-saved name selection so the lazy-loaded checklist can
  // re-tick checkboxes that match the saved selection — even if an interface
  // name has gone missing from the latest discovery.
  if (typeof window !== "undefined") {
    window["__autoMon_seed_f-mon-fortigate-amon-"]   = (fwFgCfg.autoMonitorInterfaces && fwFgCfg.autoMonitorInterfaces.mode === "names") ? fwFgCfg.autoMonitorInterfaces.names.slice() : [];
    window["__autoMon_seed_f-mon-fortiswitch-amon-"] = (fwSwCfg.autoMonitorInterfaces && fwSwCfg.autoMonitorInterfaces.mode === "names") ? fwSwCfg.autoMonitorInterfaces.names.slice() : [];
    window["__autoMon_seed_f-mon-fortiap-amon-"]     = (fwApCfg.autoMonitorInterfaces && fwApCfg.autoMonitorInterfaces.mode === "names") ? fwApCfg.autoMonitorInterfaces.names.slice() : [];
  }

  var fortigatePanel =
    _fortigateAddMonitoredHTML("f-mon-fortigate-", fwFgCfg.addAsMonitored === true) +
    integrationMonitorOverrideHTML(opts.snmpCredentials, opts.monitorCredentialId, opts.transportSources || {}) +
    _autoMonitorInterfacesHTML("f-mon-fortigate-amon-", "FortiGate", fwFgCfg.autoMonitorInterfaces || null, "names", hasId) +
    '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:1rem;font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5">' +
      'These timers apply <strong style="color:var(--color-text-primary)">globally</strong> to every monitored asset that isn\'t a Fortinet switch or AP — Cisco SNMP, Windows WinRM, Linux SSH, ICMP, etc. Switches and APs use the values on their own subtabs.' +
    '</div>' +
    _classTimerFieldsHTML("f-mon-", s, {});

  var switchPanel =
    _classDirectPollHTML("f-mon-fortiswitch-", "FortiSwitch", opts.snmpCredentials, fwSwCfg.enabled === true, fwSwCfg.snmpCredentialId || null, fwSwCfg.addAsMonitored === true) +
    _autoMonitorInterfacesHTML("f-mon-fortiswitch-amon-", "FortiSwitch", fwSwCfg.autoMonitorInterfaces || null, "wildcard", hasId) +
    '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:1rem;font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5">' +
      'These timers apply <strong style="color:var(--color-text-primary)">globally</strong> to every monitored Fortinet FortiSwitch — across all integrations, not just this one. Empty fields fall back to the values on the FortiGates subtab.' +
    '</div>' +
    _classTimerFieldsHTML("f-mon-fortiswitch-", fsClass, classDefaults);

  var apPanel =
    _classDirectPollHTML("f-mon-fortiap-", "FortiAP", opts.snmpCredentials, fwApCfg.enabled === true, fwApCfg.snmpCredentialId || null, fwApCfg.addAsMonitored === true) +
    _autoMonitorInterfacesHTML("f-mon-fortiap-amon-", "FortiAP", fwApCfg.autoMonitorInterfaces || null, "type", hasId) +
    '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:1rem;font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5">' +
      'These timers apply <strong style="color:var(--color-text-primary)">globally</strong> to every monitored Fortinet FortiAP — across all integrations, not just this one. Empty fields fall back to the values on the FortiGates subtab.' +
    '</div>' +
    _classTimerFieldsHTML("f-mon-fortiap-", faClass, classDefaults);

  // Inner sub-tab bar inside the outer "Monitoring" tab. Same _intRenderTabbedBody
  // pattern, just with a unique prefix so the two tab bars don't collide.
  return _intRenderTabbedBody("intg-mon", [
    { key: "fortigates",    label: "FortiGates",    html: fortigatePanel },
    { key: "fortiswitches", label: "FortiSwitches", html: switchPanel },
    { key: "fortiaps",      label: "FortiAPs",      html: apPanel },
  ]);
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

// Reads one class's timer block (FortiGate / FortiSwitch / FortiAP) and
// returns the seven-field shape the server expects for that class.
function _readClassTimers(prefix) {
  function n(name) {
    var el = document.getElementById(prefix + name);
    if (!el) return undefined;
    var v = parseInt(el.value, 10);
    return Number.isFinite(v) ? v : undefined;
  }
  return {
    intervalSeconds:           n("intervalSeconds"),
    failureThreshold:          n("failureThreshold"),
    sampleRetentionDays:       n("sampleRetentionDays"),
    telemetryIntervalSeconds:  n("telemetryIntervalSeconds"),
    telemetryRetentionDays:    n("telemetryRetentionDays"),
    systemInfoIntervalSeconds: n("systemInfoIntervalSeconds"),
    systemInfoRetentionDays:   n("systemInfoRetentionDays"),
  };
}

function getMonitorSettingsFromForm() {
  // Top-level (FortiGate subtab) + nested per-class (Switch/AP subtabs).
  // Only include the per-class blocks when the corresponding subtab actually
  // rendered — tab might be hidden when the modal hasn't been opened yet.
  var top = _readClassTimers("f-mon-");
  var out = top;
  if (document.getElementById("f-mon-fortiswitch-intervalSeconds")) {
    out.fortiswitch = _readClassTimers("f-mon-fortiswitch-");
  }
  if (document.getElementById("f-mon-fortiap-intervalSeconds")) {
    out.fortiap = _readClassTimers("f-mon-fortiap-");
  }
  return out;
}

// Reads the "enable direct polling" + SNMP credential picker + the auto-Monitor
// flag + the auto-monitor-interfaces selection for one class (FortiSwitch or
// FortiAP). Returns null when the subtab didn't render.
function _readClassMonitorBlock(prefix) {
  var enabledEl    = document.getElementById(prefix + "enabled");
  var credEl       = document.getElementById(prefix + "credentialId");
  var addMonEl     = document.getElementById(prefix + "addAsMonitored");
  if (!enabledEl || !credEl) return null;
  var ami = _readAutoMonitorInterfaces(prefix + "amon-");
  return {
    enabled: enabledEl.checked === true,
    snmpCredentialId: credEl.value || null,
    addAsMonitored: addMonEl ? addMonEl.checked === true : false,
    autoMonitorInterfaces: ami === undefined ? null : ami,
  };
}

// FortiGate variant — only the auto-Monitor flag (no direct-polling toggle
// since FortiGates always have a monitorType stamped at discovery) plus the
// auto-monitor-interfaces selection.
function _readFortigateMonitorBlock(prefix) {
  var addMonEl = document.getElementById(prefix + "addAsMonitored");
  if (!addMonEl) return null;
  var ami = _readAutoMonitorInterfaces(prefix + "amon-");
  return {
    addAsMonitored: addMonEl.checked === true,
    autoMonitorInterfaces: ami === undefined ? null : ami,
  };
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
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);border-radius:var(--radius-md);padding:0.75rem 0.9rem;margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.4rem">' +
        // Backend field is still `useProxy`; UI shows the inverse — checked = direct, unchecked = proxy.
        '<input type="checkbox" id="f-useDirect" ' + (d.useProxy === false ? "checked" : "") + ' style="width:auto" onchange="_fmgToggleDirectMode(this.checked)">' +
        '<label for="f-useDirect" style="margin:0;font-weight:500">Query each FortiGate directly (bypass FortiManager proxy)</label>' +
      '</div>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5;margin:0 0 0.75rem 0">When checked, Polaris skips FortiManager\'s <code>/sys/proxy/json</code> and talks straight to each managed FortiGate\'s management IP using the REST API credentials below — supports up to 20 parallel queries. When unchecked (default), all per-device DHCP/interface/switch/AP/VIP queries are proxied through FortiManager, which serializes them to one at a time.</p>' +
      '<p style="font-size:0.82rem;color:var(--color-warning);line-height:1.5;margin:0 0 0.75rem 0;background:rgba(255,214,0,0.08);border:1px solid rgba(255,214,0,0.25);border-radius:4px;padding:0.5rem 0.65rem"><strong>Tip:</strong> If your environment has more than 20 managed FortiGates, switching to direct queries is strongly recommended — proxy mode polls them one at a time, so a full discovery run scales linearly with device count.</p>' +
      '<div id="f-direct-mode-block" style="' + (d.useProxy === false ? "" : "display:none;") + 'border-top:1px solid rgba(79,195,247,0.2);padding-top:0.75rem;margin-top:0.5rem">' +
        '<div class="form-group"><label>Parallel FortiGate Queries</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-discoveryParallelism" value="' + (d.useProxy === false ? (d.discoveryParallelism || 5) : 1) + '" min="1" max="20" style="width:80px"><span id="f-parallelism-note" style="color:var(--color-text-tertiary);font-size:0.85rem">gates at once</span></div><p class="hint">Up to 20 FortiGates concurrently.</p></div>' +
        '<div class="form-group"><label>FortiGate API User</label><input type="text" id="f-fortigateApiUser" value="' + escapeHtml(d.fortigateApiUser || "") + '" placeholder="e.g. polaris-ro"><p class="hint">REST API admin username configured on each managed FortiGate</p></div>' +
        '<div class="form-group"><label>FortiGate API Token</label><input type="password" id="f-fortigateApiToken" value="' + (d.fortigateApiTokenPlaceholder ? "" : escapeHtml(d.fortigateApiToken || "")) + '" placeholder="' + (d.fortigateApiTokenPlaceholder || "Bearer token") + '"><p class="hint">Bearer token for the above admin. Must be the same across all managed FortiGates.</p></div>' +
        '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0">' +
          '<input type="checkbox" id="f-fortigateVerifySsl" ' + (d.fortigateVerifySsl ? "checked" : "") + ' style="width:auto">' +
          '<label for="f-fortigateVerifySsl" style="margin:0">Verify SSL certificate on FortiGates</label>' +
        '</div>' +
      '</div>' +
    '</div>';
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
  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">FortiGate Device Scope</p>' +
    '<div class="form-group"><label>Device Filter</label>' +
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
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">DHCP Scope</p>' +
    '<div class="form-group"><label>DHCP Filter</label>' +
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
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Interface Scope</p>' +
    '<div class="form-group"><label>Interface Filter</label>' +
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
  };
}

function fortiGateFormHTML(defaults) {
  var d = defaults || {};
  var dhcpMode = (d.dhcpInclude && d.dhcpInclude.length > 0) ? "include" : "exclude";
  var dhcpIfaces = dhcpMode === "include" ? (d.dhcpInclude || []) : (d.dhcpExclude || []);
  var invMode = (d.inventoryIncludeInterfaces && d.inventoryIncludeInterfaces.length > 0) ? "include" : "exclude";
  var invIfaces = invMode === "include" ? (d.inventoryIncludeInterfaces || []) : (d.inventoryExcludeInterfaces || []);
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
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">DHCP Server Scope</p>' +
    '<div class="form-group"><label>Interface Filter</label>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-dhcpMode" style="width:auto">' +
          '<option value="include"' + (dhcpMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (dhcpMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these interfaces when querying DHCP servers</span>' +
      '</div>' +
      '<textarea id="f-dhcpInterfaces" rows="2" placeholder="One per line — e.g. port1&#10;internal*&#10;*wan">' + escapeHtml(dhcpIfaces.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to query all interfaces. Wildcards supported: <code>port*</code>, <code>*wan</code>, <code>*mgmt*</code></p>' +
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

function getFgtFormConfig() {
  var port = document.getElementById("f-port").value;
  var dhcpMode = document.getElementById("f-dhcpMode").value;
  var dhcpIfaces = linesToArray("f-dhcpInterfaces");
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
    inventoryExcludeInterfaces: invMode === "exclude" ? invIfaces : [],
    inventoryIncludeInterfaces: invMode === "include" ? invIfaces : [],
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
    '<div class="form-group"><label>Exclude Scopes</label><textarea id="f-dhcpExclude" rows="2" placeholder="One per line — scope name or ID&#10;e.g. lab-scope">' + escapeHtml((d.dhcpExclude || []).join("\n")) + '</textarea><p class="hint">Skip these DHCP scopes when syncing</p></div>';
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
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Device Scope</p>' +
    '<div class="form-group"><label>Device Filter</label>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-deviceMode" style="width:auto">' +
          '<option value="include"' + (devMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (devMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these devices by display name</span>' +
      '</div>' +
      '<textarea id="f-deviceNames" rows="2" placeholder="One per line — e.g. LAPTOP-*&#10;SRV-HQ-*&#10;*-lab">' + escapeHtml(devNames.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to sync every device. Wildcards supported: <code>LAPTOP-*</code>, <code>*-lab</code>, <code>*pc*</code></p>' +
    '</div>';
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
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Computer Scope</p>' +
    '<div class="form-group"><label>OU Filter</label>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-deviceMode" style="width:auto">' +
          '<option value="include"' + (devMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (devMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these OUs (matched against distinguished name)</span>' +
      '</div>' +
      '<textarea id="f-deviceNames" rows="3" placeholder="One per line — e.g.&#10;*OU=Workstations*&#10;*OU=Servers,OU=HQ*">' + escapeHtml(devNames.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to sync all computers under the base DN. Each line is matched against the computer\'s full distinguished name. Wildcards: <code>*OU=Workstations*</code>, <code>*OU=Servers,OU=HQ*</code></p>' +
    '</div>';
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

// Reads the per-stream transport checkboxes from the FortiGates subtab.
// Returns { responseTime, telemetry, interfaces, lldp } as "rest" | "snmp",
// or null when the subtab isn't on screen — caller leaves the existing config.
function _readMonitorTransportSources() {
  var rt = document.getElementById("f-mon-src-responseTime");
  var tl = document.getElementById("f-mon-src-telemetry");
  var iv = document.getElementById("f-mon-src-interfaces");
  var ll = document.getElementById("f-mon-src-lldp");
  if (!rt && !tl && !iv && !ll) return null;
  return {
    monitorResponseTimeSource: rt && rt.checked ? "snmp" : "rest",
    monitorTelemetrySource:    tl && tl.checked ? "snmp" : "rest",
    monitorInterfacesSource:   iv && iv.checked ? "snmp" : "rest",
    monitorLldpSource:         ll && ll.checked ? "snmp" : "rest",
  };
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
  var title = _titleForType(type, "Add");
  // FMG + FortiGate get a Monitoring tab alongside General; the rest still
  // render a single flat form (their telemetry isn't wired up yet).
  var body;
  if (isFmg || isFgt) {
    var monSettings = {};
    var creds = [];
    try { monSettings = await api.assets.getMonitorSettings(); } catch (e) { /* fall back to defaults */ }
    try { var credResp = await api.credentials.list(); creds = Array.isArray(credResp) ? credResp : []; } catch (e) { /* picker just shows defaults */ }
    var generalHtml = isFmg ? fortiManagerGeneralHTML({}) : _formHTMLForType(type, {});
    var addTabs = [
      { key: "general", label: "General", html: generalHtml },
    ];
    if (isFmg) {
      addTabs.push({ key: "filters", label: "Filters", html: fortiManagerFiltersHTML({}) });
    }
    addTabs.push({ key: "monitoring", label: "Monitoring", html: monitorSettingsFormHTML(monSettings, { snmpCredentials: creds, monitorCredentialId: null, integrationId: null }) });
    // FMG only: tab for the Reservation Push toggle. Defaults to off.
    // useProxy on a fresh integration defaults to true (the FMG proxy path).
    if (isFmg) {
      addTabs.push({ key: "push", label: "Reservation Push", html: reservationPushFormHTML(false, true) });
    }
    body = _intRenderTabbedBody("intg-edit", addTabs);
  } else {
    body = _formHTMLForType(type, {});
  }
  var footer = '<button class="btn btn-secondary" id="btn-test-new">Test Connection</button>' +
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">Create</button>';
  openModal(title, body, footer);
  if (isFmg || isFgt) {
    _intWireModalTabs("intg-edit");
    // Inner sub-tabs inside the Monitoring tab (FortiGates / FortiSwitches / FortiAPs).
    _intWireModalTabs("intg-mon");
    wireAutoMonitorCards(null);
  }

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
      showToast(result.message, result.ok ? "success" : "error");
    } catch (err) {
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
        var transports = _readMonitorTransportSources();
        if (transports) {
          createConfig.monitorResponseTimeSource = transports.monitorResponseTimeSource;
          createConfig.monitorTelemetrySource    = transports.monitorTelemetrySource;
          createConfig.monitorInterfacesSource   = transports.monitorInterfacesSource;
          createConfig.monitorLldpSource         = transports.monitorLldpSource;
        }
        var fgBlockNew = _readFortigateMonitorBlock("f-mon-fortigate-");
        var swBlockNew = _readClassMonitorBlock("f-mon-fortiswitch-");
        var apBlockNew = _readClassMonitorBlock("f-mon-fortiap-");
        if (fgBlockNew) createConfig.fortigateMonitor   = fgBlockNew;
        if (swBlockNew) createConfig.fortiswitchMonitor = swBlockNew;
        if (apBlockNew) createConfig.fortiapMonitor     = apBlockNew;
      }
      if (isFmg) {
        var pushToggleNew = _readPushReservationsToggle();
        if (pushToggleNew !== undefined) createConfig.pushReservations = pushToggleNew;
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
      // Save the global monitor settings if the Monitoring tab was rendered.
      // Failures here aren't fatal — the integration is already created.
      if (isFmg || isFgt) {
        try { await api.assets.updateMonitorSettings(getMonitorSettingsFromForm()); }
        catch (e) { showToast("Integration created, but monitor settings couldn\'t be saved: " + (e.message || "unknown error"), "error"); }
      }
      closeModal();
      showToast("Integration created");
      loadIntegrations();
      if (result && result.conflicts && result.conflicts.length) {
        showConflictModal(result.id, result.conflicts);
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
        inventoryIncludeInterfaces: config.inventoryIncludeInterfaces || [],
        inventoryExcludeInterfaces: config.inventoryExcludeInterfaces || [],
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
      };
      body = fortiManagerFormHTML(defaults);
      formGetter = function () {
        var fc = getFormConfig();
        if (!fc.apiToken) delete fc.apiToken;
        if (!fc.fortigateApiToken) delete fc.fortigateApiToken;
        return fc;
      };
    }

    // FMG + FortiGate get a Monitoring tab. The settings are global, so they
    // apply across all integrations — the tab here is just a convenient
    // editor surface (saved alongside the integration on Save Changes).
    var isFmgOrFgt = (intg.type === "fortimanager" || intg.type === "fortigate");
    if (isFmgOrFgt) {
      var monSettings = {};
      var creds = [];
      try { monSettings = await api.assets.getMonitorSettings(); } catch (e) { /* fall back to defaults */ }
      try { var credResp = await api.credentials.list(); creds = Array.isArray(credResp) ? credResp : []; } catch (e) { /* picker just shows defaults */ }
      var generalHtml = (intg.type === "fortimanager") ? fortiManagerGeneralHTML(defaults) : body;
      var editTabs = [
        { key: "general",    label: "General",    html: generalHtml },
      ];
      if (intg.type === "fortimanager") {
        editTabs.push({ key: "filters", label: "Filters", html: fortiManagerFiltersHTML(defaults) });
      }
      editTabs.push(
        { key: "monitoring", label: "Monitoring", html: monitorSettingsFormHTML(monSettings, {
          snmpCredentials: creds,
          monitorCredentialId: config.monitorCredentialId || null,
          transportSources: {
            responseTime: config.monitorResponseTimeSource || "rest",
            telemetry:    config.monitorTelemetrySource    || "rest",
            interfaces:   config.monitorInterfacesSource   || "rest",
            lldp:         config.monitorLldpSource         || "rest",
          },
          fortigateMonitor:   config.fortigateMonitor   || null,
          fortiswitchMonitor: config.fortiswitchMonitor || null,
          fortiapMonitor:     config.fortiapMonitor     || null,
          integrationId:      id,
        }) },
      );
      // FMG only: third tab for the Reservation Push toggle. The body uses
      // the integration's current useProxy setting to label the active mode.
      if (intg.type === "fortimanager") {
        editTabs.push({
          key: "push",
          label: "Reservation Push",
          html: reservationPushFormHTML(config.pushReservations === true, config.useProxy !== false),
        });
      }
      body = _intRenderTabbedBody("intg-edit", editTabs);
    }

    var footer = '<button class="btn btn-secondary" id="btn-test-existing">Test Connection</button>' +
      '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal("Edit Integration", body, footer);
    if (isFmgOrFgt) {
      _intWireModalTabs("intg-edit");
      _intWireModalTabs("intg-mon");
      wireAutoMonitorCards(id);
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
        // Per-stream transport toggles. Reader returns null when the subtab
        // didn't render — leave the existing config alone in that case.
        var transports = _readMonitorTransportSources();
        if (transports) {
          editConfig.monitorResponseTimeSource = transports.monitorResponseTimeSource;
          editConfig.monitorTelemetrySource    = transports.monitorTelemetrySource;
          editConfig.monitorInterfacesSource   = transports.monitorInterfacesSource;
        }
        // Per-class FortiGate / FortiSwitch / FortiAP blocks. The reader
        // returns null when its subtab didn't render — in that case leave
        // the existing config alone rather than wiping it.
        var fgBlock = _readFortigateMonitorBlock("f-mon-fortigate-");
        var swBlock = _readClassMonitorBlock("f-mon-fortiswitch-");
        var apBlock = _readClassMonitorBlock("f-mon-fortiap-");
        if (fgBlock) editConfig.fortigateMonitor   = fgBlock;
        if (swBlock) editConfig.fortiswitchMonitor = swBlock;
        if (apBlock) editConfig.fortiapMonitor     = apBlock;
        // FMG-only push toggle. Reader returns undefined when the tab
        // didn't render (FortiGate-type integration); leave unchanged.
        if (intg.type === "fortimanager") {
          var pushToggle = _readPushReservationsToggle();
          if (pushToggle !== undefined) editConfig.pushReservations = pushToggle;
        }
      }
      var input = {
        name: val("f-name"),
        config: editConfig,
        enabled: document.getElementById("f-enabled").checked,
        autoDiscover: autoDiscoverEl ? autoDiscoverEl.checked : true,
        pollInterval: parseInt(document.getElementById("f-pollInterval").value, 10) || 4,
      };
      var result = await api.integrations.update(id, input);
      if (isFmgOrFgt) {
        try { await api.assets.updateMonitorSettings(getMonitorSettingsFromForm()); }
        catch (e) { showToast("Integration updated, but monitor settings couldn\'t be saved: " + (e.message || "unknown error"), "error"); }
      }
      return { result: result, editConfig: editConfig };
    }

    document.getElementById("btn-save").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = "Saving...";
      try {
        var saved = await performSave();
        var classes = isFmgOrFgt ? [
          ["fortigate",   saved.editConfig.fortigateMonitor],
          ["fortiswitch", saved.editConfig.fortiswitchMonitor],
          ["fortiap",     saved.editConfig.fortiapMonitor],
        ] : [];
        var hasSelection = classes.some(function (c) { return c[1] && c[1].autoMonitorInterfaces; });

        if (hasSelection) {
          // Capacity guard: warn before applying selections that would pin
          // a large number of interfaces. We sniff the cached count from
          // each preview block; missing/stale values just skip the warning.
          var totalEstimate = 0;
          ["f-mon-fortigate-amon-", "f-mon-fortiswitch-amon-", "f-mon-fortiap-amon-"].forEach(function (p) {
            var el = document.getElementById(p + "preview");
            var n = el && el.dataset && parseInt(el.dataset.interfaceCount || "0", 10);
            if (Number.isFinite(n)) totalEstimate += n;
          });
          if (totalEstimate > AUTO_MONITOR_INTERFACE_WARN_THRESHOLD) {
            var ok = window.confirm(
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
          var totalDevices = 0;
          var totalIfaces = 0;
          var failures = [];
          for (var c = 0; c < classes.length; c++) {
            var klass = classes[c][0];
            var block = classes[c][1];
            if (!block || !block.autoMonitorInterfaces) continue;
            try {
              var r = await api.integrations.interfaceAggregateApply(id, klass);
              totalDevices += r.devices || 0;
              totalIfaces  += r.interfacesAdded || 0;
            } catch (err) {
              failures.push(klass + ": " + (err.message || "failed"));
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
var _FMG_PRESET_QUERIES = [
  {
    name: "System status",
    method: "get",
    params: '[\n  { "url": "/sys/status" }\n]',
  },
  {
    name: "List ADOMs",
    method: "get",
    params: '[\n  {\n    "url": "/dvmdb/adom",\n    "data": { "fields": ["name", "state", "os_ver"] }\n  }\n]',
  },
  {
    name: "List devices in ADOM",
    method: "get",
    params: '[\n  {\n    "url": "/dvmdb/adom/<adom>/device",\n    "data": { "fields": ["name", "sn", "ip", "os_ver", "platform_str", "ha_mode", "conn_status", "last_checked"] }\n  }\n]',
  },
  {
    name: "DHCP servers on device",
    method: "exec",
    params: '[\n  {\n    "url": "/sys/proxy/json",\n    "data": {\n      "target": ["/adom/<adom>/device/<device-name>"],\n      "action": "get",\n      "resource": "/api/v2/cmdb/system.dhcp/server"\n    }\n  }\n]',
  },
  {
    name: "DHCP leases on device",
    method: "exec",
    params: '[\n  {\n    "url": "/sys/proxy/json",\n    "data": {\n      "target": ["/adom/<adom>/device/<device-name>"],\n      "action": "get",\n      "resource": "/api/v2/monitor/system/dhcp?format=ip|mac|hostname|interface|reserved|expire_time|access_point|ssid|vci"\n    }\n  }\n]',
  },
  {
    name: "Interface IPs on device",
    method: "exec",
    params: '[\n  {\n    "url": "/sys/proxy/json",\n    "data": {\n      "target": ["/adom/<adom>/device/<device-name>"],\n      "action": "get",\n      "resource": "/api/v2/cmdb/system/interface",\n      "params": [{ "fields": ["name", "ip", "vdom", "type", "status"] }]\n    }\n  }\n]',
  },
  {
    name: "Managed FortiSwitches on device",
    method: "exec",
    params: '[\n  {\n    "url": "/sys/proxy/json",\n    "data": {\n      "target": ["/adom/<adom>/device/<device-name>"],\n      "action": "get",\n      "resource": "/api/v2/monitor/switch-controller/managed-switch/status?format=connecting_from|fgt_peer_intf_name|join_time|os_version|serial|switch-id|state|status"\n    }\n  }\n]',
  },
  {
    name: "Managed FortiAPs on device",
    method: "exec",
    params: '[\n  {\n    "url": "/sys/proxy/json",\n    "data": {\n      "target": ["/adom/<adom>/device/<device-name>"],\n      "action": "get",\n      "resource": "/api/v2/monitor/wifi/managed_ap?format=name|wtp_id|serial|model|wtp_profile|ip_addr|ip_address|local_ipv4_address|base_mac|mac|status|state|version|firmware_version"\n    }\n  }\n]',
  },
  {
    name: "Firewall VIPs on device",
    method: "exec",
    params: '[\n  {\n    "url": "/sys/proxy/json",\n    "data": {\n      "target": ["/adom/<adom>/device/<device-name>"],\n      "action": "get",\n      "resource": "/api/v2/cmdb/firewall/vip"\n    }\n  }\n]',
  },
  {
    name: "Endpoint devices on device",
    method: "exec",
    params: '[\n  {\n    "url": "/sys/proxy/json",\n    "data": {\n      "target": ["/adom/<adom>/device/<device-name>"],\n      "action": "get",\n      "resource": "/api/v2/monitor/user/device/query?format=mac|ip|hostname|host|os|type|os_version|hardware_vendor|interface|switch_fortilink|fortiswitch|switch_port|ap_name|fortiap|user|detected_user|is_online|last_seen"\n    }\n  }\n]',
  },
];

var _FMG_QUERIES_VERSION = 3;

function _substituteFmgAdom(paramsStr, adom) {
  return String(paramsStr).replace(/<adom>/g, adom || "root");
}

function _fmgLoadQueries() {
  try {
    var stored = JSON.parse(localStorage.getItem("polaris-fmg-queries") || "null");
    if (!stored || stored.v !== _FMG_QUERIES_VERSION) {
      var initial = { v: _FMG_QUERIES_VERSION, queries: _FMG_PRESET_QUERIES.slice() };
      localStorage.setItem("polaris-fmg-queries", JSON.stringify(initial));
      return _FMG_PRESET_QUERIES.slice();
    }
    return stored.queries;
  } catch (_) { return []; }
}

function _fmgPersistQueries(queries) {
  localStorage.setItem("polaris-fmg-queries", JSON.stringify({ v: _FMG_QUERIES_VERSION, queries: queries }));
}

function _fmgRenderSavedSelect(queries, selectValue) {
  var sel = document.getElementById("fmg-saved-select");
  if (!sel) return;
  sel.innerHTML = '<option value="">— load a saved query —</option>' +
    queries.map(function (q, i) {
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
  _fmgRenderSavedSelect(savedQueries);

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
    _fmgRenderSavedSelect(savedQueries);
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
    _fmgRenderSavedSelect(savedQueries, existIdx);
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
