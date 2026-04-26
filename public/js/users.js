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
    else if (action === "totp-self") openTotpSelfModal();
    else if (action === "totp-reset") confirmTotpReset(id, username);
  });
});

async function loadUsers() {
  var tbody = document.getElementById("users-tbody");
  try {
    var users = await api.users.list();
    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No users found.</td></tr>';
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
      var onlineDot = u.isOnline
        ? '<span class="ip-status-dot ip-dot-available" title="Currently logged in" style="vertical-align:middle"></span>'
        : '';
      var passwordBtn = u.authProvider === "azure" ? '' :
        '<button class="btn btn-sm btn-secondary" data-action="password" data-id="' + escapeHtml(u.id) + '" data-username="' + escapeHtml(u.username) + '">Password</button>';
      var totpCell;
      if (u.authProvider === "azure") {
        totpCell = '<span style="color:var(--color-text-tertiary);font-size:0.85em" title="Handled by your identity provider">IdP-managed</span>';
      } else if (u.totpEnabled) {
        totpCell = '<span class="badge" style="background:rgba(76,175,80,0.15);color:var(--color-success,#4caf50)">Enabled</span>';
      } else {
        totpCell = '<span style="color:var(--color-text-tertiary)">Not set</span>';
      }
      var isSelf = currentUsername === u.username;
      var totpBtn = "";
      if (u.authProvider !== "azure") {
        if (isSelf) {
          totpBtn = '<button class="btn btn-sm btn-secondary" data-action="totp-self" title="Manage your two-factor authentication">2FA</button>';
        } else if (u.totpEnabled) {
          totpBtn = '<button class="btn btn-sm btn-secondary" data-action="totp-reset" data-id="' + escapeHtml(u.id) + '" data-username="' + escapeHtml(u.username) + '" title="Reset 2FA (e.g. lost device)">Reset 2FA</button>';
        }
      }
      return '<tr>' +
        '<td style="text-align:center">' + onlineDot + '</td>' +
        '<td><strong>' + escapeHtml(u.username) + '</strong>' + displayName + '</td>' +
        '<td>' + authBadge + '</td>' +
        '<td>' + roleBadge + '</td>' +
        '<td>' + totpCell + '</td>' +
        '<td>' + lastLogin + '</td>' +
        '<td>' + formatDate(u.createdAt) + '</td>' +
        '<td class="actions">' +
          '<button class="btn btn-sm btn-secondary" data-action="role" data-id="' + escapeHtml(u.id) + '" data-username="' + escapeHtml(u.username) + '" data-role="' + escapeHtml(u.role) + '">Role</button>' +
          passwordBtn +
          totpBtn +
          '<button class="btn btn-sm btn-danger" data-action="delete" data-id="' + escapeHtml(u.id) + '" data-username="' + escapeHtml(u.username) + '">Delete</button>' +
        '</td></tr>';
    }).join("");
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function openCreateModal() {
  var body = '<div class="form-group"><label>Username *</label><input type="text" id="f-username" placeholder="e.g. jsmith"></div>' +
    '<div class="form-group"><label>Password *</label><input type="password" id="f-password" placeholder="Enter password">' + passwordChecksHTML("f-pw-checks") + '<p class="hint">The user can change this after first login.</p></div>' +
    '<div class="form-group"><label>Confirm Password *</label><input type="password" id="f-password-confirm" placeholder="Re-enter password">' + passwordMatchHTML("f-pw-match") + '</div>' +
    '<div class="form-group"><label>Role</label><select id="f-role"><option value="readonly" selected>Read Only</option><option value="user">User</option><option value="networkadmin">Network Admin</option><option value="assetsadmin">Assets Admin</option><option value="admin">Admin</option></select></div>';
  var footer = '<button class="btn btn-secondary" id="btn-cancel">Cancel</button><button class="btn btn-primary" id="btn-save">Create User</button>';
  openModal("Add User", body, footer);
  wirePasswordChecks("f-password", "f-pw-checks");
  wirePasswordMatch("f-password", "f-password-confirm", "f-pw-match");
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
    if (val("f-password") !== val("f-password-confirm")) {
      showToast("Passwords do not match", "error");
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

// ─── Self-service TOTP ─────────────────────────────────────────────────────

async function openTotpSelfModal() {
  var status;
  try { status = await api.totp.status(); }
  catch (err) { showToast(err.message, "error"); return; }
  if (status.enabled) openTotpDisableModal();
  else openTotpEnrollModal();
}

async function openTotpEnrollModal() {
  var enrollment;
  try { enrollment = await api.totp.enroll(); }
  catch (err) { showToast(err.message, "error"); return; }

  var body =
    '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'Scan the QR code with an authenticator app (Google Authenticator, 1Password, Bitwarden, Authy, Microsoft Authenticator, etc.), then enter the current 6-digit code to finish enrollment.' +
    '</p>' +
    '<div style="display:flex;justify-content:center;margin-bottom:1rem;background:#fff;padding:1rem;border-radius:8px">' +
      enrollment.qrSvg +
    '</div>' +
    '<details style="margin-bottom:1rem;font-size:0.85rem">' +
      '<summary style="cursor:pointer;color:var(--color-text-secondary)">Can\'t scan? Enter the secret manually</summary>' +
      '<p style="margin-top:0.5rem;padding:0.5rem;background:var(--color-bg-secondary);border-radius:4px;font-family:monospace;font-size:0.8rem;word-break:break-all">' +
        escapeHtml(enrollment.secret) +
      '</p>' +
    '</details>' +
    '<div class="form-group">' +
      '<label for="f-totp-code">Verification code</label>' +
      '<input type="text" id="f-totp-code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code" autofocus>' +
    '</div>';
  var footer =
    '<button class="btn btn-secondary" id="btn-totp-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-totp-confirm">Enable 2FA</button>';
  openModal("Enable Two-Factor Auth", body, footer);

  document.getElementById("btn-totp-cancel").addEventListener("click", closeModal);
  document.getElementById("btn-totp-confirm").addEventListener("click", async function () {
    var btn = this;
    var code = val("f-totp-code");
    if (!/^\d{6}$/.test(code)) { showToast("Enter the 6-digit code from your authenticator app", "error"); return; }
    btn.disabled = true;
    try {
      var result = await api.totp.confirm({ code: code });
      closeModal();
      showBackupCodesModal(result.backupCodes);
      loadUsers();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function showBackupCodesModal(codes) {
  var listHtml = codes.map(function (c) {
    return '<li style="font-family:monospace;font-size:0.95rem;padding:0.2rem 0">' + escapeHtml(c) + '</li>';
  }).join("");
  var body =
    '<p style="margin-bottom:0.75rem">Two-factor auth is now enabled. <strong>Save these backup codes somewhere safe</strong> — each works once and can be used in place of a code from your authenticator app if you lose your device.</p>' +
    '<div style="background:var(--color-bg-secondary);border:1px solid var(--color-border);border-radius:6px;padding:0.75rem 1rem;margin-bottom:0.75rem">' +
      '<ol style="margin:0;padding-left:1.5rem;columns:2;gap:1rem">' + listHtml + '</ol>' +
    '</div>' +
    '<p style="font-size:0.85rem;color:var(--color-text-tertiary)">These codes will not be shown again.</p>';
  var footer =
    '<button class="btn btn-secondary" id="btn-copy-backup">Copy to clipboard</button>' +
    '<button class="btn btn-primary" id="btn-backup-done">I\'ve saved them</button>';
  openModal("Backup Codes", body, footer);
  document.getElementById("btn-copy-backup").addEventListener("click", function () {
    navigator.clipboard.writeText(codes.join("\n")).then(function () {
      showToast("Backup codes copied");
    }).catch(function () {
      showToast("Copy failed — select the codes manually", "error");
    });
  });
  document.getElementById("btn-backup-done").addEventListener("click", closeModal);
}

function openTotpDisableModal() {
  var body =
    '<p style="margin-bottom:1rem">Enter a current code from your authenticator app (or a backup code) to turn off two-factor authentication for <strong>' + escapeHtml(currentUsername) + '</strong>.</p>' +
    '<div class="form-group">' +
      '<label for="f-totp-disable-code">Verification code</label>' +
      '<input type="text" id="f-totp-disable-code" inputmode="numeric" maxlength="9" placeholder="123456" autocomplete="one-time-code" autofocus>' +
    '</div>' +
    '<label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">' +
      '<input type="checkbox" id="f-totp-backup-check"> I\'m using a backup code' +
    '</label>';
  var footer =
    '<button class="btn btn-secondary" id="btn-totp-cancel">Cancel</button>' +
    '<button class="btn btn-danger" id="btn-totp-disable">Disable 2FA</button>';
  openModal("Disable Two-Factor Auth", body, footer);

  document.getElementById("btn-totp-cancel").addEventListener("click", closeModal);
  document.getElementById("btn-totp-disable").addEventListener("click", async function () {
    var btn = this;
    var code = val("f-totp-disable-code");
    var isBackup = document.getElementById("f-totp-backup-check").checked;
    if (!code) { showToast("Enter a code to continue", "error"); return; }
    btn.disabled = true;
    try {
      await api.totp.disable({ code: code, isBackupCode: isBackup });
      closeModal();
      showToast("Two-factor auth disabled");
      loadUsers();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function confirmTotpReset(id, username) {
  var ok = await showConfirm(
    'Reset two-factor auth for "' + username + '"?\n\n' +
    'Use this only when the user has lost access to their authenticator app and their backup codes. ' +
    'They will be able to log in with just their password on the next attempt, and should re-enroll immediately.',
  );
  if (!ok) return;
  try {
    await api.users.resetTotp(id);
    showToast("2FA reset for " + username);
    loadUsers();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── Authentication Settings ───────────────────────────────────────────────

async function initAuthSettingsButton() {
  var btn = document.getElementById("btn-auth-settings");
  if (!btn) return;

  btn.style.display = "";
  btn.addEventListener("click", openAuthSettingsModal);
}

var _authActiveTab = "saml";

async function openAuthSettingsModal() {
  var results = await Promise.all([
    api.auth.azureSettings().catch(function () { return { spEntityId: "", idpEntityId: "", idpLoginUrl: "", idpLogoutUrl: "", idpCertificate: "", wantResponseSigned: false, skipLoginPage: false, autoLogoutMinutes: 0 }; }),
    api.auth.oidcSettings().catch(function () { return { enabled: false, discoveryUrl: "", clientId: "", clientSecret: "", scopes: "openid profile email" }; }),
    api.auth.ldapSettings().catch(function () { return { enabled: false, url: "", bindDn: "", bindPassword: "", searchBase: "", searchFilter: "(sAMAccountName={{username}})", tlsVerify: true, displayNameAttr: "displayName", emailAttr: "mail" }; }),
  ]);
  var saml = results[0], oidc = results[1], ldap = results[2];

  var body =
    '<div class="settings-tabs">' +
      '<button class="settings-tab' + (_authActiveTab === "saml" ? ' active' : '') + '" data-tab="saml">SAML</button>' +
      '<button class="settings-tab' + (_authActiveTab === "oidc" ? ' active' : '') + '" data-tab="oidc">OIDC</button>' +
      '<button class="settings-tab' + (_authActiveTab === "ldap" ? ' active' : '') + '" data-tab="ldap">LDAP</button>' +
      '<button class="settings-tab' + (_authActiveTab === "session" ? ' active' : '') + '" data-tab="session">Session</button>' +
    '</div>' +
    '<div class="settings-tab-panel' + (_authActiveTab === "saml" ? ' active' : '') + '" id="tab-saml">' + buildSamlTab(saml) + '</div>' +
    '<div class="settings-tab-panel' + (_authActiveTab === "oidc" ? ' active' : '') + '" id="tab-oidc">' + buildOidcTab(oidc) + '</div>' +
    '<div class="settings-tab-panel' + (_authActiveTab === "ldap" ? ' active' : '') + '" id="tab-ldap">' + buildLdapTab(ldap) + '</div>' +
    '<div class="settings-tab-panel' + (_authActiveTab === "session" ? ' active' : '') + '" id="tab-session">' + buildSessionTab(saml) + '</div>';

  var footer =
    '<div style="margin-right:auto"><button class="btn btn-secondary" id="btn-test-auth">Test</button></div>' +
    '<button class="btn btn-secondary" id="btn-cancel-auth">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save-auth">Save</button>';

  openModal("Authentication", body, footer);

  // Tab switching
  document.querySelectorAll(".settings-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var target = tab.getAttribute("data-tab");
      _authActiveTab = target;
      document.querySelectorAll(".settings-tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".settings-tab-panel").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      document.getElementById("tab-" + target).classList.add("active");
      document.getElementById("btn-test-auth").style.display = target === "saml" ? "" : "none";
    });
  });
  document.getElementById("btn-test-auth").style.display = _authActiveTab === "saml" ? "" : "none";

  // SAML: live-update ACS / SLS URLs
  document.getElementById("f-sp-entity-id").addEventListener("input", function () {
    var base = this.value.trim().replace(/\/+$/, "");
    document.getElementById("f-sp-acs-url").value = base ? base + "/api/v1/auth/azure/callback" : "";
    document.getElementById("f-sp-sls-url").value = base ? base + "/login.html" : "";
  });

  // Copy buttons
  document.getElementById("btn-copy-acs-url").addEventListener("click", function () { copyField("f-sp-acs-url", this); });
  document.getElementById("btn-copy-sls-url").addEventListener("click", function () { copyField("f-sp-sls-url", this); });
  document.getElementById("btn-cancel-auth").addEventListener("click", closeModal);

  // Certificate file import
  document.getElementById("f-idp-cert-file").addEventListener("change", function () {
    var file = this.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) { document.getElementById("f-idp-certificate").value = e.target.result; };
    reader.readAsText(file);
  });

  // Test (SAML only)
  document.getElementById("btn-test-auth").addEventListener("click", async function () {
    var btn = this;
    var resultsDiv = document.getElementById("sso-test-results");
    btn.disabled = true;
    btn.textContent = "Testing\u2026";
    resultsDiv.style.display = "block";
    resultsDiv.style.background = "var(--color-bg-secondary)";
    resultsDiv.style.border = "1px solid var(--color-border)";
    resultsDiv.innerHTML = '<span style="color:var(--color-text-secondary)">Running tests\u2026</span>';
    try {
      await api.auth.updateAzureSettings(getSamlFormData());
      var data = await api.auth.testAzureSettings();
      var r = data.results;
      var html = '<div style="display:flex;flex-direction:column;gap:0.5rem">' +
        '<div>' + (r.certificate.ok ? "\u2705" : "\u274c") + ' <strong>Certificate:</strong> ' + escapeHtml(r.certificate.message) + '</div>' +
        '<div>' + (r.idpLoginUrl.ok ? "\u2705" : "\u274c") + ' <strong>IdP Login URL:</strong> ' + escapeHtml(r.idpLoginUrl.message) + '</div>' +
        '</div>';
      resultsDiv.innerHTML = html;
      resultsDiv.style.background = data.ok ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)";
      resultsDiv.style.border = data.ok ? "1px solid rgba(34,197,94,0.3)" : "1px solid rgba(239,68,68,0.3)";
    } catch (err) {
      resultsDiv.innerHTML = '<span style="color:var(--color-danger)">\u274c ' + escapeHtml(err.message) + '</span>';
      resultsDiv.style.background = "rgba(239,68,68,0.08)";
      resultsDiv.style.border = "1px solid rgba(239,68,68,0.3)";
    } finally {
      btn.disabled = false;
      btn.textContent = "Test";
    }
  });

  // Save — all tabs
  document.getElementById("btn-save-auth").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      await Promise.all([
        api.auth.updateAzureSettings(getSamlFormData()),
        api.auth.updateOidcSettings(getOidcFormData()),
        api.auth.updateLdapSettings(getLdapFormData()),
      ]);
      closeModal();
      showToast("Authentication settings saved");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function getSamlFormData() {
  return {
    enabled: document.getElementById("f-saml-enabled").checked,
    spEntityId: val("f-sp-entity-id"),
    idpEntityId: val("f-idp-entity-id"),
    idpLoginUrl: val("f-idp-login-url"),
    idpLogoutUrl: val("f-idp-logout-url"),
    idpCertificate: document.getElementById("f-idp-certificate").value.trim(),
    wantResponseSigned: document.getElementById("f-want-response-signed").checked,
    skipLoginPage: document.getElementById("f-skip-login").checked,
    autoLogoutMinutes: parseInt(document.getElementById("f-auto-logout").value, 10) || 0,
  };
}

function getOidcFormData() {
  return {
    enabled: document.getElementById("f-oidc-enabled").checked,
    discoveryUrl: val("f-oidc-discovery-url"),
    clientId: val("f-oidc-client-id"),
    clientSecret: val("f-oidc-client-secret"),
    scopes: val("f-oidc-scopes"),
  };
}

function getLdapFormData() {
  return {
    enabled: document.getElementById("f-ldap-enabled").checked,
    url: val("f-ldap-url"),
    bindDn: val("f-ldap-bind-dn"),
    bindPassword: val("f-ldap-bind-password"),
    searchBase: val("f-ldap-search-base"),
    searchFilter: val("f-ldap-search-filter"),
    tlsVerify: document.getElementById("f-ldap-tls-verify").checked,
    displayNameAttr: val("f-ldap-display-name-attr"),
    emailAttr: val("f-ldap-email-attr"),
  };
}

function buildSamlTab(s) {
  var origin = window.location.origin;
  var spEntityId = s.spEntityId || origin;
  var spAcsUrl = spEntityId.replace(/\/+$/, "") + "/api/v1/auth/azure/callback";
  var spSlsUrl = spEntityId.replace(/\/+$/, "") + "/login.html";

  return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1.25rem">Configure SAML 2.0 single sign-on with your identity provider.</p>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-saml-enabled"' + (s.enabled ? ' checked' : '') + '>' +
        '<span>Enable SAML authentication</span>' +
      '</label>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<h4 style="font-size:0.88rem;font-weight:600;margin-bottom:0.75rem;color:var(--color-text-primary);border-bottom:1px solid var(--color-border);padding-bottom:0.4rem">Service Provider</h4>' +
    '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin-bottom:0.75rem">Copy these values into your identity provider\'s SAML configuration.</p>' +
    '<div class="form-group">' +
      '<label>Application URL *</label>' +
      '<input type="text" id="f-sp-entity-id" value="' + escapeHtml(spEntityId) + '" placeholder="https://ipam.example.com">' +
      '<p class="hint">Your application\'s public URL. Used as the SP Entity ID and to build the callback URLs below.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>ACS (Login) URL</label>' +
      '<div style="display:flex;gap:0.5rem;align-items:center">' +
        '<input type="text" id="f-sp-acs-url" value="' + escapeHtml(spAcsUrl) + '" readonly style="background:var(--color-bg-secondary);cursor:default;flex:1">' +
        '<button type="button" class="btn btn-sm btn-secondary" id="btn-copy-acs-url" title="Copy">Copy</button>' +
      '</div>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>SLS (Logout) URL</label>' +
      '<div style="display:flex;gap:0.5rem;align-items:center">' +
        '<input type="text" id="f-sp-sls-url" value="' + escapeHtml(spSlsUrl) + '" readonly style="background:var(--color-bg-secondary);cursor:default;flex:1">' +
        '<button type="button" class="btn btn-sm btn-secondary" id="btn-copy-sls-url" title="Copy">Copy</button>' +
      '</div>' +
    '</div>' +
    '<h4 style="font-size:0.88rem;font-weight:600;margin:1.25rem 0 0.75rem;color:var(--color-text-primary);border-bottom:1px solid var(--color-border);padding-bottom:0.4rem">Identity Provider</h4>' +
    '<div class="form-group">' +
      '<label>IdP Entity ID</label>' +
      '<input type="text" id="f-idp-entity-id" value="' + escapeHtml(s.idpEntityId || "") + '" placeholder="e.g. https://sts.windows.net/... or https://accounts.google.com/...">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>IdP Login URL</label>' +
      '<input type="text" id="f-idp-login-url" value="' + escapeHtml(s.idpLoginUrl || "") + '" placeholder="e.g. https://login.microsoftonline.com/.../saml2">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>IdP Logout URL</label>' +
      '<input type="text" id="f-idp-logout-url" value="' + escapeHtml(s.idpLogoutUrl || "") + '" placeholder="Optional — defaults to login URL">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>IdP Certificate</label>' +
      '<textarea id="f-idp-certificate" rows="6" style="font-family:monospace;font-size:0.8rem;resize:vertical" placeholder="-----BEGIN CERTIFICATE-----\nMIIC8D...\n-----END CERTIFICATE-----">' + escapeHtml(s.idpCertificate || "") + '</textarea>' +
      '<p class="hint">Paste the Base64-encoded signing certificate from your IdP, or import a file.</p>' +
      '<input type="file" id="f-idp-cert-file" accept=".pem,.cer,.crt,.cert" style="margin-top:0.35rem;font-size:0.8rem">' +
    '</div>' +
    '<h4 style="font-size:0.88rem;font-weight:600;margin:1.25rem 0 0.75rem;color:var(--color-text-primary);border-bottom:1px solid var(--color-border);padding-bottom:0.4rem">Signature Verification</h4>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-want-response-signed"' + (s.wantResponseSigned ? ' checked' : '') + '>' +
        '<span>Require signed SAML response</span>' +
      '</label>' +
      '<p class="hint" style="margin:0.35rem 0 0 1.5rem">Enable if your IdP signs the entire SAML response (not just the assertion).</p>' +
    '</div>' +
    '<div id="sso-test-results" style="display:none;margin-top:1rem;padding:0.75rem;border-radius:6px;font-size:0.85rem"></div>';
}

function buildOidcTab(s) {
  return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1.25rem">Configure OpenID Connect for single sign-on with providers like Azure AD, Google Workspace, or Okta.</p>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-oidc-enabled"' + (s.enabled ? ' checked' : '') + '>' +
        '<span>Enable OIDC authentication</span>' +
      '</label>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<div class="form-group">' +
      '<label>Discovery URL</label>' +
      '<input type="text" id="f-oidc-discovery-url" value="' + escapeHtml(s.discoveryUrl || "") + '" placeholder="e.g. https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration">' +
      '<p class="hint">The OpenID Connect discovery endpoint. The client will auto-discover authorization, token, and userinfo endpoints.</p>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
      '<div class="form-group">' +
        '<label>Client ID</label>' +
        '<input type="text" id="f-oidc-client-id" value="' + escapeHtml(s.clientId || "") + '" placeholder="Application (client) ID">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Client Secret</label>' +
        '<input type="password" id="f-oidc-client-secret" value="' + escapeHtml(s.clientSecret || "") + '" placeholder="Client secret value">' +
      '</div>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Scopes</label>' +
      '<input type="text" id="f-oidc-scopes" value="' + escapeHtml(s.scopes || "openid profile email") + '">' +
      '<p class="hint">Space-separated list of scopes to request.</p>' +
    '</div>' +
    '<div style="margin-top:1rem;padding:0.75rem;background:var(--color-bg-secondary);border-radius:6px;font-size:0.82rem;color:var(--color-text-tertiary)">' +
      'OIDC authentication is not yet implemented. Save your configuration now and it will be available when support is added.' +
    '</div>';
}

function buildLdapTab(s) {
  return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1.25rem">Configure LDAP or Active Directory for username/password authentication against a directory server.</p>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-ldap-enabled"' + (s.enabled ? ' checked' : '') + '>' +
        '<span>Enable LDAP authentication</span>' +
      '</label>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Connection</p>' +
    '<div class="form-group">' +
      '<label>Server URL</label>' +
      '<input type="text" id="f-ldap-url" value="' + escapeHtml(s.url || "") + '" placeholder="e.g. ldaps://dc01.corp.local:636 or ldap://dc01.corp.local:389">' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-ldap-tls-verify"' + (s.tlsVerify !== false ? ' checked' : '') + '>' +
        '<span>Verify TLS certificate</span>' +
      '</label>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Bind Credentials</p>' +
    '<div class="form-group">' +
      '<label>Bind DN</label>' +
      '<input type="text" id="f-ldap-bind-dn" value="' + escapeHtml(s.bindDn || "") + '" placeholder="e.g. CN=svc-polaris,OU=Service Accounts,DC=corp,DC=local">' +
      '<p class="hint">Distinguished name of the service account used to search the directory.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Bind Password</label>' +
      '<input type="password" id="f-ldap-bind-password" value="' + escapeHtml(s.bindPassword || "") + '">' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">User Search</p>' +
    '<div class="form-group">' +
      '<label>Search Base</label>' +
      '<input type="text" id="f-ldap-search-base" value="' + escapeHtml(s.searchBase || "") + '" placeholder="e.g. DC=corp,DC=local">' +
      '<p class="hint">Base DN to search for user accounts.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Search Filter</label>' +
      '<input type="text" id="f-ldap-search-filter" value="' + escapeHtml(s.searchFilter || "(sAMAccountName={{username}})") + '">' +
      '<p class="hint">LDAP filter to find the user. Use <code>{{username}}</code> as a placeholder for the login username.</p>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Attribute Mapping</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
      '<div class="form-group">' +
        '<label>Display Name Attribute</label>' +
        '<input type="text" id="f-ldap-display-name-attr" value="' + escapeHtml(s.displayNameAttr || "displayName") + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Email Attribute</label>' +
        '<input type="text" id="f-ldap-email-attr" value="' + escapeHtml(s.emailAttr || "mail") + '">' +
      '</div>' +
    '</div>' +
    '<div style="margin-top:1rem;padding:0.75rem;background:var(--color-bg-secondary);border-radius:6px;font-size:0.82rem;color:var(--color-text-tertiary)">' +
      'LDAP authentication is not yet implemented. Save your configuration now and it will be available when support is added.' +
    '</div>';
}

function buildSessionTab(s) {
  return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1.25rem">Configure session behavior for all authentication methods.</p>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-skip-login"' + (s.skipLoginPage ? ' checked' : '') + '>' +
        '<span>Skip login page (SSO only)</span>' +
      '</label>' +
      '<p class="hint" style="margin:0.35rem 0 0 1.5rem">Redirect unauthenticated users straight to SSO. Requires an SSO provider to be configured.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Auto-logout after inactivity</label>' +
      '<div style="display:flex;align-items:center;gap:0.5rem">' +
        '<input type="number" id="f-auto-logout" min="0" max="1440" value="' + (s.autoLogoutMinutes || 0) + '" style="width:80px">' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">minutes</span>' +
      '</div>' +
      '<p class="hint">Set to 0 to disable. Maximum 1440 minutes (24 hours).</p>' +
    '</div>';
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

function passwordMatchHTML(containerId) {
  return '<div id="' + containerId + '" style="margin-top:0.4rem;font-size:0.8rem;line-height:1.6;color:var(--color-text-tertiary)">' +
    '<span class="pw-icon">&#9675;</span> Matches password' +
    '</div>';
}

function wirePasswordMatch(passwordId, confirmId, containerId) {
  function update() {
    checkPasswordMatch(document.getElementById(passwordId).value, document.getElementById(confirmId).value, containerId);
  }
  document.getElementById(passwordId).addEventListener("input", update);
  document.getElementById(confirmId).addEventListener("input", update);
}

function checkPasswordMatch(pw, confirm, containerId) {
  var el = document.getElementById(containerId);
  if (!el) return false;
  var matched = confirm.length > 0 && pw === confirm;
  el.querySelector(".pw-icon").innerHTML = matched ? "&#10003;" : "&#9675;";
  el.style.color = matched ? "var(--color-success, #4caf50)" : "var(--color-text-tertiary)";
  return matched;
}
