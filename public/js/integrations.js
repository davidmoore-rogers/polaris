/**
 * public/js/integrations.js — Integrations management page
 */

document.addEventListener("DOMContentLoaded", function () {
  loadIntegrations();
  document.getElementById("btn-add-integration").addEventListener("click", openCreateModal);
});

async function loadIntegrations() {
  var container = document.getElementById("integrations-list");
  try {
    var integrations = await api.integrations.list();
    if (integrations.length === 0) {
      container.innerHTML = '<div class="empty-state-card"><p>No integrations configured.</p><p style="color:var(--color-text-tertiary);font-size:0.85rem;margin-top:0.5rem">Add a FortiManager connection to get started.</p></div>';
      return;
    }
    container.innerHTML = integrations.map(function (intg) {
      var config = intg.config || {};
      var statusDot = intg.lastTestOk === true ? "dot-ok" : intg.lastTestOk === false ? "dot-fail" : "dot-unknown";
      var statusText = intg.lastTestOk === true ? "Connected" : intg.lastTestOk === false ? "Failed" : "Not tested";
      var lastTest = intg.lastTestAt ? formatDate(intg.lastTestAt) : "Never";

      return '<div class="integration-card">' +
        '<div class="integration-card-header">' +
          '<div class="integration-card-title">' +
            '<span class="integration-type-badge">FortiManager</span>' +
            '<strong>' + escapeHtml(intg.name) + '</strong>' +
            '<span class="integration-status ' + statusDot + '">' + statusText + '</span>' +
          '</div>' +
          '<div class="integration-card-actions">' +
            '<button class="btn btn-sm btn-secondary" onclick="testConnection(\'' + intg.id + '\', this)">Test Connection</button>' +
            '<button class="btn btn-sm btn-secondary" onclick="openEditModal(\'' + intg.id + '\')">Edit</button>' +
            '<button class="btn btn-sm btn-danger" onclick="confirmDelete(\'' + intg.id + '\', \'' + escapeHtml(intg.name) + '\')">Delete</button>' +
          '</div>' +
        '</div>' +
        '<div class="integration-card-details">' +
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || 443) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">API User</span><span class="detail-value">' + escapeHtml(config.apiUser || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">API Token</span><span class="detail-value mono">' + escapeHtml(config.apiToken || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">ADOM</span><span class="detail-value">' + escapeHtml(config.adom || "root") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">SSL Verify</span><span class="detail-value">' + (config.verifySsl ? "Yes" : "No") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Mgmt Interface</span><span class="detail-value mono">' + escapeHtml(config.mgmtInterface || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">DHCP Include</span><span class="detail-value">' + ((config.dhcpInclude || []).length ? escapeHtml(config.dhcpInclude.join(", ")) : '<span style="color:var(--color-text-tertiary)">All</span>') + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">DHCP Exclude</span><span class="detail-value">' + ((config.dhcpExclude || []).length ? escapeHtml(config.dhcpExclude.join(", ")) : '<span style="color:var(--color-text-tertiary)">None</span>') + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Status</span><span class="detail-value">' + (intg.enabled ? '<span class="badge badge-active">Enabled</span>' : '<span class="badge badge-deprecated">Disabled</span>') + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Last Tested</span><span class="detail-value">' + lastTest + '</span></div>' +
        '</div>' +
      '</div>';
    }).join("");
  } catch (err) {
    container.innerHTML = '<p class="empty-state">Error: ' + escapeHtml(err.message) + '</p>';
  }
}

function fortiManagerFormHTML(defaults) {
  var d = defaults || {};
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Production FortiManager"></div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Connection Settings</p>' +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
      '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + escapeHtml(d.host || "") + '" placeholder="e.g. fmg.example.com"></div>' +
      '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + (d.port || 443) + '" min="1" max="65535" style="width:90px"></div>' +
    '</div>' +
    '<div class="form-group"><label>API User</label><input type="text" id="f-apiUser" value="' + escapeHtml(d.apiUser || "") + '" placeholder="e.g. api-admin"></div>' +
    '<div class="form-group"><label>API Token</label><input type="password" id="f-apiToken" value="' + (d.apiTokenPlaceholder ? "" : escapeHtml(d.apiToken || "")) + '" placeholder="' + (d.apiTokenPlaceholder || "Bearer token") + '"><p class="hint">Generate from FortiManager under System Settings &gt; Admin &gt; API Users</p></div>' +
    '<div class="form-group"><label>ADOM</label><input type="text" id="f-adom" value="' + escapeHtml(d.adom || "root") + '" placeholder="root"><p class="hint">Administrative Domain (leave as "root" for default)</p></div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-verifySsl" ' + (d.verifySsl ? "checked" : "") + ' style="width:auto">' +
      '<label for="f-verifySsl" style="margin:0">Verify SSL certificate</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + (d.enabled !== false ? "checked" : "") + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">FortiGate Settings</p>' +
    '<div class="form-group"><label>Management Interface</label><input type="text" id="f-mgmtInterface" value="' + escapeHtml(d.mgmtInterface || "") + '" placeholder="e.g. port1, mgmt, loopback0"><p class="hint">Interface name used for FortiGate management traffic</p></div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">DHCP Server Scope</p>' +
    '<div class="form-group"><label>Include DHCP Servers</label><textarea id="f-dhcpInclude" rows="2" placeholder="One per line — e.g. dhcp-server-01&#10;192.168.1.10">' + escapeHtml((d.dhcpInclude || []).join("\n")) + '</textarea><p class="hint">Only query these DHCP servers (leave empty to query all)</p></div>' +
    '<div class="form-group"><label>Exclude DHCP Servers</label><textarea id="f-dhcpExclude" rows="2" placeholder="One per line — e.g. lab-dhcp&#10;test-server">' + escapeHtml((d.dhcpExclude || []).join("\n")) + '</textarea><p class="hint">Skip these DHCP servers when querying</p></div>';
}

function getFormConfig() {
  var port = document.getElementById("f-port").value;
  return {
    host: val("f-host"),
    port: port ? parseInt(port, 10) : 443,
    apiUser: val("f-apiUser"),
    apiToken: val("f-apiToken"),
    adom: val("f-adom") || "root",
    verifySsl: document.getElementById("f-verifySsl").checked,
    mgmtInterface: val("f-mgmtInterface") || "",
    dhcpInclude: linesToArray("f-dhcpInclude"),
    dhcpExclude: linesToArray("f-dhcpExclude"),
  };
}

function linesToArray(id) {
  return document.getElementById(id).value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
}

function openCreateModal() {
  var body = fortiManagerFormHTML({});
  var footer = '<button class="btn btn-secondary" id="btn-test-new">Test Connection</button>' +
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">Create</button>';
  openModal("Add FortiManager Integration", body, footer);

  document.getElementById("btn-test-new").addEventListener("click", async function () {
    var btn = this;
    if (!val("f-host") || !val("f-apiToken")) {
      showToast("Fill in host and API token first", "error");
      return;
    }
    btn.disabled = true;
    btn.textContent = "Testing...";
    try {
      var result = await api.integrations.testNew({
        type: "fortimanager",
        name: val("f-name") || "Test",
        config: getFormConfig(),
      });
      showToast(result.message, result.ok ? "success" : "error");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Test Connection";
    }
  });

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var input = {
        type: "fortimanager",
        name: val("f-name"),
        config: getFormConfig(),
        enabled: document.getElementById("f-enabled").checked,
      };
      await api.integrations.create(input);
      closeModal();
      showToast("Integration created");
      loadIntegrations();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function openEditModal(id) {
  try {
    var intg = await api.integrations.get(id);
    var config = intg.config || {};
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
      mgmtInterface: config.mgmtInterface,
      dhcpInclude: config.dhcpInclude || [],
      dhcpExclude: config.dhcpExclude || [],
    };
    var body = fortiManagerFormHTML(defaults);
    var footer = '<button class="btn btn-secondary" id="btn-test-existing">Test Connection</button>' +
      '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal("Edit Integration", body, footer);

    document.getElementById("btn-test-existing").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = "Testing...";
      try {
        var result = await api.integrations.test(id);
        showToast(result.message, result.ok ? "success" : "error");
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Test Connection";
      }
    });

    document.getElementById("btn-save").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      try {
        var formConfig = getFormConfig();
        if (!formConfig.apiToken) delete formConfig.apiToken;
        var input = {
          name: val("f-name"),
          config: formConfig,
          enabled: document.getElementById("f-enabled").checked,
        };
        await api.integrations.update(id, input);
        closeModal();
        showToast("Integration updated");
        loadIntegrations();
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function testConnection(id, btn) {
  btn.disabled = true;
  btn.textContent = "Testing...";
  try {
    var result = await api.integrations.test(id);
    showToast(result.message, result.ok ? "success" : "error");
    loadIntegrations();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Test Connection";
  }
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

function val(id) { return document.getElementById(id).value.trim(); }
