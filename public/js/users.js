/**
 * public/js/users.js — User management page
 */

document.addEventListener("DOMContentLoaded", function () {
  loadUsers();
  initAuthSettingsButton();
  document.getElementById("btn-add-user").addEventListener("click", openCreateModal);

  // Event delegation for table action buttons
  document.getElementById("users-tbody").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-action]");
    if (!btn) return;
    var action = btn.getAttribute("data-action");
    var id = btn.getAttribute("data-id");
    var username = btn.getAttribute("data-username");
    var role = btn.getAttribute("data-role");
    if (action === "role") openChangeRoleModal(id, username, role);
    else if (action === "password") openResetPasswordModal(id, username);
    else if (action === "delete") confirmDelete(id, username);
  });
});

async function loadUsers() {
  var tbody = document.getElementById("users-tbody");
  try {
    var users = await api.users.list();
    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No users found.</td></tr>';
      return;
    }
    tbody.innerHTML = users.map(function (u) {
      var roleBadge;
      if (u.role === "admin") roleBadge = '<span class="badge badge-admin">admin</span>';
      else if (u.role === "networkadmin") roleBadge = '<span class="badge badge-network-admin">network admin</span>';
      else if (u.role === "assetsadmin") roleBadge = '<span class="badge badge-assets-admin">assets admin</span>';
      else if (u.role === "user") roleBadge = '<span class="badge badge-available">user</span>';
      else roleBadge = '<span class="badge badge-readonly">read only</span>';
      var authBadge = u.authProvider === "azure"
        ? '<span class="badge badge-reserved" title="Azure SSO">Azure</span>'
        : '<span class="badge" style="background:var(--color-bg-secondary);color:var(--color-text-secondary)">Local</span>';
      var lastLogin = u.lastLogin
        ? '<span title="' + escapeHtml(new Date(u.lastLogin).toLocaleString()) + '">' + timeAgo(u.lastLogin) + '</span>'
        : '<span style="color:var(--color-text-tertiary)">Never</span>';
      var displayName = u.displayName ? ' <span style="color:var(--color-text-tertiary);font-size:0.85em">(' + escapeHtml(u.displayName) + ')</span>' : '';
      var passwordBtn = u.authProvider === "azure" ? '' :
        '<button class="btn btn-sm btn-secondary" data-action="password" data-id="' + escapeHtml(u.id) + '" data-username="' + escapeHtml(u.username) + '">Password</button>';
      return '<tr>' +
        '<td><strong>' + escapeHtml(u.username) + '</strong>' + displayName + '</td>' +
        '<td>' + authBadge + '</td>' +
        '<td>' + roleBadge + '</td>' +
        '<td>' + lastLogin + '</td>' +
        '<td>' + formatDate(u.createdAt) + '</td>' +
        '<td class="actions">' +
          '<button class="btn btn-sm btn-secondary" data-action="role" data-id="' + escapeHtml(u.id) + '" data-username="' + escapeHtml(u.username) + '" data-role="' + escapeHtml(u.role) + '">Role</button>' +
          passwordBtn +
          '<button class="btn btn-sm btn-danger" data-action="delete" data-id="' + escapeHtml(u.id) + '" data-username="' + escapeHtml(u.username) + '">Delete</button>' +
        '</td></tr>';
    }).join("");
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function openCreateModal() {
  var body = '<div class="form-group"><label>Username *</label><input type="text" id="f-username" placeholder="e.g. jsmith"></div>' +
    '<div class="form-group"><label>Password *</label><input type="password" id="f-password" placeholder="Enter password">' + passwordChecksHTML("f-pw-checks") + '<p class="hint">The user can change this after first login.</p></div>' +
    '<div class="form-group"><label>Role</label><select id="f-role"><option value="readonly" selected>Read Only</option><option value="user">User</option><option value="networkadmin">Network Admin</option><option value="assetsadmin">Assets Admin</option><option value="admin">Admin</option></select></div>';
  var footer = '<button class="btn btn-secondary" id="btn-cancel">Cancel</button><button class="btn btn-primary" id="btn-save">Create User</button>';
  openModal("Add User", body, footer);
  wirePasswordChecks("f-password", "f-pw-checks");
  document.getElementById("btn-cancel").addEventListener("click", closeModal);

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    if (!val("f-username")) {
      showToast("Username is required", "error");
      return;
    }
    if (!checkPasswordField(val("f-password"), "f-pw-checks")) {
      showToast("Password does not meet complexity requirements", "error");
      return;
    }
    btn.disabled = true;
    try {
      var input = {
        username: val("f-username"),
        password: val("f-password"),
        role: val("f-role"),
      };
      await api.users.create(input);
      closeModal();
      showToast("User created");
      loadUsers();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function openChangeRoleModal(id, username, currentRole) {
  var body = '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">Change role for <strong>' + escapeHtml(username) + '</strong></p>' +
    '<div class="form-group"><label>Role</label><select id="f-role">' +
      '<option value="readonly"' + (currentRole === "readonly" ? " selected" : "") + '>Read Only</option>' +
      '<option value="user"' + (currentRole === "user" ? " selected" : "") + '>User</option>' +
      '<option value="networkadmin"' + (currentRole === "networkadmin" ? " selected" : "") + '>Network Admin</option>' +
      '<option value="assetsadmin"' + (currentRole === "assetsadmin" ? " selected" : "") + '>Assets Admin</option>' +
      '<option value="admin"' + (currentRole === "admin" ? " selected" : "") + '>Admin</option>' +
    '</select></div>';
  var footer = '<button class="btn btn-secondary" id="btn-cancel">Cancel</button><button class="btn btn-primary" id="btn-save">Update Role</button>';
  openModal("Change Role", body, footer);
  document.getElementById("btn-cancel").addEventListener("click", closeModal);

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      await api.users.updateRole(id, { role: val("f-role") });
      closeModal();
      showToast("Role updated for " + username);
      loadUsers();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function openResetPasswordModal(id, username) {
  var body = '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">Set a new password for <strong>' + escapeHtml(username) + '</strong></p>' +
    '<div class="form-group"><label>New Password *</label><input type="password" id="f-password" placeholder="Enter password">' + passwordChecksHTML("f-pw-checks") + '</div>';
  var footer = '<button class="btn btn-secondary" id="btn-cancel">Cancel</button><button class="btn btn-primary" id="btn-save">Reset Password</button>';
  openModal("Reset Password", body, footer);
  wirePasswordChecks("f-password", "f-pw-checks");
  document.getElementById("btn-cancel").addEventListener("click", closeModal);

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    var pw = val("f-password");
    if (!checkPasswordField(pw, "f-pw-checks")) {
      showToast("Password does not meet complexity requirements", "error");
      return;
    }
    btn.disabled = true;
    try {
      await api.users.resetPassword(id, { password: pw });
      closeModal();
      showToast("Password reset for " + username);
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function confirmDelete(id, username) {
  var ok = await showConfirm('Delete user "' + username + '"? This cannot be undone.');
  if (!ok) return;
  try {
    await api.users.delete(id);
    showToast("User deleted");
    loadUsers();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function val(id) { return document.getElementById(id).value.trim(); }

// ─── Authentication Settings ───────────────────────────────────────────────

async function initAuthSettingsButton() {
  var btn = document.getElementById("btn-auth-settings");
  if (!btn) return;

  btn.style.display = "";
  btn.addEventListener("click", openAuthSettingsModal);
}

async function openAuthSettingsModal() {
  // Load current settings
  var settings;
  try {
    settings = await api.auth.azureSettings();
  } catch (_) {
    settings = { idpEntityId: "", idpLoginUrl: "", idpLogoutUrl: "", idpCertificate: "", skipLoginPage: false, autoLogoutMinutes: 0 };
  }

  var origin = window.location.origin;
  var spEntityId = origin;
  var spAcsUrl = origin + "/api/v1/auth/azure/callback";
  var spSlsUrl = origin + "/login.html";

  var body =
    '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1.25rem">Configure Azure AD SAML single sign-on and session behavior.</p>' +

    '<h4 style="font-size:0.88rem;font-weight:600;margin-bottom:0.75rem;color:var(--color-text-primary);border-bottom:1px solid var(--color-border);padding-bottom:0.4rem">Service Provider Info</h4>' +
    '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin-bottom:0.75rem">Copy these values into your Azure Enterprise Application SAML configuration.</p>' +
    '<div class="form-group">' +
      '<label>SP Entity ID</label>' +
      '<div style="display:flex;gap:0.5rem;align-items:center">' +
        '<input type="text" id="f-sp-entity-id" value="' + escapeHtml(spEntityId) + '" readonly style="background:var(--color-bg-secondary);cursor:default;flex:1">' +
        '<button type="button" class="btn btn-sm btn-secondary" id="btn-copy-entity-id" title="Copy">Copy</button>' +
      '</div>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>SP ACS (Login) URL</label>' +
      '<div style="display:flex;gap:0.5rem;align-items:center">' +
        '<input type="text" id="f-sp-acs-url" value="' + escapeHtml(spAcsUrl) + '" readonly style="background:var(--color-bg-secondary);cursor:default;flex:1">' +
        '<button type="button" class="btn btn-sm btn-secondary" id="btn-copy-acs-url" title="Copy">Copy</button>' +
      '</div>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>SP SLS (Logout) URL</label>' +
      '<div style="display:flex;gap:0.5rem;align-items:center">' +
        '<input type="text" id="f-sp-sls-url" value="' + escapeHtml(spSlsUrl) + '" readonly style="background:var(--color-bg-secondary);cursor:default;flex:1">' +
        '<button type="button" class="btn btn-sm btn-secondary" id="btn-copy-sls-url" title="Copy">Copy</button>' +
      '</div>' +
    '</div>' +

    '<h4 style="font-size:0.88rem;font-weight:600;margin:1.25rem 0 0.75rem;color:var(--color-text-primary);border-bottom:1px solid var(--color-border);padding-bottom:0.4rem">Identity Provider</h4>' +
    '<div class="form-group">' +
      '<label>IdP Entity ID</label>' +
      '<input type="text" id="f-idp-entity-id" value="' + escapeHtml(settings.idpEntityId || "") + '" placeholder="https://sts.windows.net/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>IdP Login URL</label>' +
      '<input type="text" id="f-idp-login-url" value="' + escapeHtml(settings.idpLoginUrl || "") + '" placeholder="https://login.microsoftonline.com/xxxxxxxx/saml2">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>IdP Logout URL</label>' +
      '<input type="text" id="f-idp-logout-url" value="' + escapeHtml(settings.idpLogoutUrl || "") + '" placeholder="https://login.microsoftonline.com/xxxxxxxx/saml2">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>IdP Certificate</label>' +
      '<textarea id="f-idp-certificate" rows="6" style="font-family:monospace;font-size:0.8rem;resize:vertical" placeholder="-----BEGIN CERTIFICATE-----\nMIIC8D...\n-----END CERTIFICATE-----">' + escapeHtml(settings.idpCertificate || "") + '</textarea>' +
      '<p class="hint">Paste the Base64-encoded signing certificate from the Azure SAML configuration, or import below.</p>' +
      '<input type="file" id="f-idp-cert-file" accept=".pem,.cer,.crt,.cert" style="margin-top:0.35rem;font-size:0.8rem">' +
    '</div>' +

    '<h4 style="font-size:0.88rem;font-weight:600;margin:1.25rem 0 0.75rem;color:var(--color-text-primary);border-bottom:1px solid var(--color-border);padding-bottom:0.4rem">Session</h4>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-skip-login"' + (settings.skipLoginPage ? ' checked' : '') + '>' +
        '<span>Skip login page (SAML SSO only)</span>' +
      '</label>' +
      '<p class="hint" style="margin:0.35rem 0 0 1.5rem">Redirect unauthenticated users straight to Azure SAML SSO. Requires IdP to be configured.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Auto-logout after inactivity</label>' +
      '<div style="display:flex;align-items:center;gap:0.5rem">' +
        '<input type="number" id="f-auto-logout" min="0" max="1440" value="' + (settings.autoLogoutMinutes || 0) + '" style="width:80px">' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">minutes</span>' +
      '</div>' +
      '<p class="hint">Set to 0 to disable. Maximum 1440 minutes (24 hours).</p>' +
    '</div>' +

    '<div id="sso-test-results" style="display:none;margin-top:1rem;padding:0.75rem;border-radius:6px;font-size:0.85rem"></div>';

  var footer =
    '<button class="btn btn-secondary" id="btn-cancel-auth">Cancel</button>' +
    '<button class="btn btn-secondary" id="btn-test-sso">Test</button>' +
    '<button class="btn btn-primary" id="btn-save-auth">Save</button>';

  openModal("Authentication Settings", body, footer);

  // Copy buttons
  document.getElementById("btn-copy-entity-id").addEventListener("click", function () { copyField("f-sp-entity-id", this); });
  document.getElementById("btn-copy-acs-url").addEventListener("click", function () { copyField("f-sp-acs-url", this); });
  document.getElementById("btn-copy-sls-url").addEventListener("click", function () { copyField("f-sp-sls-url", this); });
  document.getElementById("btn-cancel-auth").addEventListener("click", closeModal);

  // Certificate file import
  document.getElementById("f-idp-cert-file").addEventListener("change", function () {
    var file = this.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      document.getElementById("f-idp-certificate").value = e.target.result;
    };
    reader.readAsText(file);
  });

  document.getElementById("btn-test-sso").addEventListener("click", async function () {
    var btn = this;
    var resultsDiv = document.getElementById("sso-test-results");
    btn.disabled = true;
    btn.textContent = "Testing\u2026";
    resultsDiv.style.display = "block";
    resultsDiv.style.background = "var(--color-bg-secondary)";
    resultsDiv.style.border = "1px solid var(--color-border)";
    resultsDiv.innerHTML = '<span style="color:var(--color-text-secondary)">Running tests\u2026</span>';

    try {
      // Save current values first so the test uses the latest config
      await api.auth.updateAzureSettings({
        idpEntityId: val("f-idp-entity-id"),
        idpLoginUrl: val("f-idp-login-url"),
        idpLogoutUrl: val("f-idp-logout-url"),
        idpCertificate: document.getElementById("f-idp-certificate").value.trim(),
        skipLoginPage: document.getElementById("f-skip-login").checked,
        autoLogoutMinutes: parseInt(document.getElementById("f-auto-logout").value, 10) || 0,
      });

      var data = await api.auth.testAzureSettings();
      var r = data.results;
      var certIcon = r.certificate.ok ? "\u2705" : "\u274c";
      var urlIcon = r.idpLoginUrl.ok ? "\u2705" : "\u274c";

      var html = '<div style="display:flex;flex-direction:column;gap:0.5rem">' +
        '<div>' + certIcon + ' <strong>Certificate:</strong> ' + escapeHtml(r.certificate.message) + '</div>' +
        '<div>' + urlIcon + ' <strong>IdP Login URL:</strong> ' + escapeHtml(r.idpLoginUrl.message) + '</div>' +
        '</div>';

      resultsDiv.innerHTML = html;
      if (data.ok) {
        resultsDiv.style.background = "rgba(34,197,94,0.08)";
        resultsDiv.style.border = "1px solid rgba(34,197,94,0.3)";
      } else {
        resultsDiv.style.background = "rgba(239,68,68,0.08)";
        resultsDiv.style.border = "1px solid rgba(239,68,68,0.3)";
      }
    } catch (err) {
      resultsDiv.innerHTML = '<span style="color:var(--color-danger)">\u274c ' + escapeHtml(err.message) + '</span>';
      resultsDiv.style.background = "rgba(239,68,68,0.08)";
      resultsDiv.style.border = "1px solid rgba(239,68,68,0.3)";
    } finally {
      btn.disabled = false;
      btn.textContent = "Test";
    }
  });

  document.getElementById("btn-save-auth").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      await api.auth.updateAzureSettings({
        idpEntityId: val("f-idp-entity-id"),
        idpLoginUrl: val("f-idp-login-url"),
        idpLogoutUrl: val("f-idp-logout-url"),
        idpCertificate: document.getElementById("f-idp-certificate").value.trim(),
        skipLoginPage: document.getElementById("f-skip-login").checked,
        autoLogoutMinutes: parseInt(document.getElementById("f-auto-logout").value, 10) || 0,
      });
      closeModal();
      showToast("Authentication settings saved");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function copyField(id, btn) {
  var input = document.getElementById(id);
  navigator.clipboard.writeText(input.value).then(function () {
    var orig = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(function () { btn.textContent = orig; }, 1500);
  });
}

// ─── Password Complexity ──────────────────────────────────────────────────

var _pwRules = [
  { key: "length",  label: "At least 8 characters",  test: function (p) { return p.length >= 8; } },
  { key: "lower",   label: "Lowercase letter",        test: function (p) { return /[a-z]/.test(p); } },
  { key: "upper",   label: "Uppercase letter",        test: function (p) { return /[A-Z]/.test(p); } },
  { key: "number",  label: "Number",                  test: function (p) { return /[0-9]/.test(p); } },
  { key: "special", label: "Special character",        test: function (p) { return /[^a-zA-Z0-9]/.test(p); } },
];

function passwordChecksHTML(containerId) {
  var html = '<div id="' + containerId + '" style="margin-top:0.4rem;font-size:0.8rem;line-height:1.6;color:var(--color-text-tertiary)">';
  _pwRules.forEach(function (r) {
    html += '<div data-rule="' + r.key + '"><span class="pw-icon">&#9675;</span> ' + r.label + '</div>';
  });
  return html + '</div>';
}

function wirePasswordChecks(inputId, containerId) {
  document.getElementById(inputId).addEventListener("input", function () {
    checkPasswordField(this.value, containerId);
  });
}

function checkPasswordField(pw, containerId) {
  var allPassed = true;
  _pwRules.forEach(function (r) {
    var passed = r.test(pw);
    if (!passed) allPassed = false;
    var el = document.querySelector('#' + containerId + ' [data-rule="' + r.key + '"]');
    if (el) {
      el.querySelector(".pw-icon").innerHTML = passed ? "&#10003;" : "&#9675;";
      el.style.color = passed ? "var(--color-success, #4caf50)" : "var(--color-text-tertiary)";
    }
  });
  return allPassed;
}
