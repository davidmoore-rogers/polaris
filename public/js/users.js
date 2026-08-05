/**
 * public/js/users.js — User management page
 */

// Module-scoped state ─────────────────────────────────────────────────────
var _usersRaw = [];           // last list from GET /users
var _usersSF = null;           // TableSF instance
var _usersPage = 1;            // unused today (no pagination) but matches the
                               //  callback shape the canonical implementations use
var _usersLayout = null;       // setupColumnLayout instance for the Users table
var _rolesLayout = null;       // setupColumnLayout instance for the Roles table
var _groupMappingsLayout = null; // setupColumnLayout instance for the Group Mappings table
var _rolesRaw = [];            // last list from GET /roles
var _rolesById = {};           // { id: role }
var _matrixSpec = null;        // { accessLevels, functions } from GET /roles/functions
var _regionList = [];          // cached map-region names for the region picker
var _regionByName = {};        // name → color hex; populated alongside _regionList
var _groupMappingsRaw = [];    // last list from GET /group-mappings
var _groupMappingsById = {};   // { id: mapping }

// Per-user TableSF prefs persistence — matches the canonical
// polaris-prefs-<scope>-<username> convention used by assets.js / blocks.js /
// subnets.js. Sort + filter state survives reload and is scoped per logged-in
// username so multiple operators sharing a workstation don't trample each
// other's settings. Save fires from the TableSF onChange callback; restore
// runs once after `userReady` resolves so currentUsername is populated.
function _saveUsersPrefs() {
  PolarisPrefs.save("users", currentUsername, Object.assign(
    {
      layout: _usersLayout ? _usersLayout.getPrefs() : null,
      rolesLayout: _rolesLayout ? _rolesLayout.getPrefs() : null,
      groupMappingsLayout: _groupMappingsLayout ? _groupMappingsLayout.getPrefs() : null,
    },
    _usersSF ? _usersSF.getPrefs() : {},
  ));
}

function _restoreUsersPrefs() {
  var p = PolarisPrefs.load("users", currentUsername);
  if (!p) return;
  if (_usersSF) _usersSF.setPrefs(p);
  if (_usersLayout && p.layout) _usersLayout.setPrefs(p.layout);
  if (_rolesLayout && p.rolesLayout) _rolesLayout.setPrefs(p.rolesLayout);
  if (_groupMappingsLayout && p.groupMappingsLayout) _groupMappingsLayout.setPrefs(p.groupMappingsLayout);
}

document.addEventListener("DOMContentLoaded", async function () {
  _usersSF = new TableSF("users-tbody", function () {
    _usersPage = 1;
    renderUsersBody();
    _saveUsersPrefs();
  });
  var usersTable = document.querySelector("#users-tbody").closest("table");
  if (usersTable && typeof setupColumnLayout === "function") {
    _usersLayout = setupColumnLayout(usersTable, { onChange: _saveUsersPrefs });
  }
  var rolesTableEl = document.querySelector("#roles-tbody");
  rolesTableEl = rolesTableEl ? rolesTableEl.closest("table") : null;
  if (rolesTableEl && typeof setupColumnLayout === "function") {
    _rolesLayout = setupColumnLayout(rolesTableEl, { onChange: _saveUsersPrefs });
  }
  var gmTableEl = document.querySelector("#group-mappings-tbody");
  gmTableEl = gmTableEl ? gmTableEl.closest("table") : null;
  if (gmTableEl && typeof setupColumnLayout === "function") {
    _groupMappingsLayout = setupColumnLayout(gmTableEl, { onChange: _saveUsersPrefs });
  }
  await userReady;
  _restoreUsersPrefs();
  loadUsers();
  loadRoles();          // also drives the role dropdowns in the user modals
  loadGroupMappings();  // IdP group → role + tags
  loadRegionList();     // best-effort; used by the region pickers
  initAuthSettingsButton();
  document.getElementById("btn-add-user").addEventListener("click", openCreateModal);
  var btnAddRole = document.getElementById("btn-add-role");
  if (btnAddRole) btnAddRole.addEventListener("click", function () { openRoleSlideover(null); });
  var btnAddGm = document.getElementById("btn-add-group-mapping");
  if (btnAddGm) btnAddGm.addEventListener("click", function () { openGroupMappingSlideover(null); });
  var gmTbody = document.getElementById("group-mappings-tbody");
  if (gmTbody) {
    gmTbody.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-gm-action]");
      if (!btn) return;
      var action = btn.getAttribute("data-gm-action");
      var id = btn.getAttribute("data-gm-id");
      if (action === "edit") openGroupMappingSlideover(id);
      else if (action === "delete") confirmDeleteGroupMapping(id);
    });
  }

  // Event delegation for users-table action buttons
  document.getElementById("users-tbody").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-action]");
    if (!btn) return;
    var action = btn.getAttribute("data-action");
    var id = btn.getAttribute("data-id");
    var username = btn.getAttribute("data-username");
    var roleId = btn.getAttribute("data-role-id");
    if (action === "role") openChangeRoleModal(id, username, roleId);
    else if (action === "regions") openUserRegionsModal(id, username);
    else if (action === "password") openResetPasswordModal(id, username);
    else if (action === "delete") confirmDelete(id, username);
    else if (action === "totp-self") openTotpSelfModal();
    else if (action === "totp-reset") confirmTotpReset(id, username);
  });

  // Event delegation for roles-table action buttons
  var rolesTbody = document.getElementById("roles-tbody");
  if (rolesTbody) {
    rolesTbody.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-role-action]");
      if (!btn) return;
      var action = btn.getAttribute("data-role-action");
      var id = btn.getAttribute("data-role-id");
      if (action === "edit") openRoleSlideover(id);
      else if (action === "delete") confirmDeleteRole(id);
    });
  }
});

async function loadUsers() {
  var tbody = document.getElementById("users-tbody");
  try {
    _usersRaw = await api.users.list();
    if (_usersRaw.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No users found.</td></tr>';
      return;
    }
    // Decorate each row with a stable `totpEnabledSort` string so TableSF
    // can sort the 2FA column lexically (Enabled / Not set / IdP-managed).
    _usersRaw.forEach(function (u) {
      u.totpEnabledSort = isIdpManaged(u)
        ? "IdP-managed"
        : (u.totpEnabled ? "Enabled" : "Not set");
    });
    renderUsersBody();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

// A user whose identity + credentials are owned by an external IdP (SSO/LDAP);
// Polaris shows no local password or TOTP controls for them. Every non-local
// authProvider qualifies (azure / oidc / ldap / entra-proxy).
function isIdpManaged(u) {
  return !!u.authProvider && u.authProvider !== "local";
}

function idpProviderLabel(provider) {
  switch (provider) {
    case "azure": return "Azure";
    case "oidc": return "OIDC";
    case "ldap": return "LDAP";
    case "entra-proxy": return "App Proxy";
    default: return "SSO";
  }
}

function renderUsersBody() {
  var tbody = document.getElementById("users-tbody");
  var rows = _usersSF ? _usersSF.apply(_usersRaw) : _usersRaw;
  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No users match the current filters.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function (u) {
    var roleName = u.role ? u.role.name : "";
    var roleKey = roleName.toLowerCase();
    var roleColor = u.role ? u.role.color : null;
    // Friendly label for the built-ins; raw name for everything else.
    var roleLabelText =
      roleKey === "admin" ? "admin" :
      roleKey === "networkadmin" ? "network admin" :
      roleKey === "assetsadmin" ? "assets admin" :
      roleKey === "user" ? "user" :
      roleKey === "readonly" ? "read only" :
      (roleName || "—");
    var roleBadge;
    var roleColorStyle = roleBadgeStyleFromColor(roleColor);
    if (roleColorStyle) {
      // Stored color wins — survives renames + colors custom roles.
      roleBadge = '<span class="badge" style="' + roleColorStyle + '">' + escapeHtml(roleLabelText) + '</span>';
    } else if (roleKey === "admin") roleBadge = '<span class="badge badge-admin">admin</span>';
    else if (roleKey === "networkadmin") roleBadge = '<span class="badge badge-network-admin">network admin</span>';
    else if (roleKey === "assetsadmin") roleBadge = '<span class="badge badge-assets-admin">assets admin</span>';
    else if (roleKey === "user") roleBadge = '<span class="badge badge-user">user</span>';
    else if (roleKey === "readonly") roleBadge = '<span class="badge badge-readonly">read only</span>';
    else roleBadge = '<span class="badge" style="background:var(--color-bg-secondary);color:var(--color-text-primary);border:1px solid var(--color-border)">' + escapeHtml(roleName || "—") + '</span>';
    var authBadge = isIdpManaged(u)
      ? '<span class="badge badge-reserved" title="' + escapeHtml(idpProviderLabel(u.authProvider)) + ' SSO">' + escapeHtml(idpProviderLabel(u.authProvider)) + '</span>'
      : '<span class="badge" style="background:var(--color-bg-secondary);color:var(--color-text-secondary)">Local</span>';
    var lastLogin = u.lastLogin
      ? '<span title="' + escapeHtml(new Date(u.lastLogin).toLocaleString()) + '">' + timeAgo(u.lastLogin) + '</span>'
      : '<span style="color:var(--color-text-tertiary)">Never</span>';
    var displayName = u.displayName ? ' <span style="color:var(--color-text-tertiary);font-size:0.85em">(' + escapeHtml(u.displayName) + ')</span>' : '';
    var onlineDot = u.isOnline
      ? '<span class="ip-status-dot ip-dot-available" title="Currently logged in" style="vertical-align:middle"></span>'
      : '';
    // Regions render on their own line under the username as one pill per
    // region, each colored by the region's stored map-color so admins can
    // scan scope at a glance.
    var regionsLabel = "";
    if (Array.isArray(u.regionTags) && u.regionTags.length > 0) {
      regionsLabel = '<div style="margin-top:0.25rem;display:flex;flex-wrap:wrap;gap:0.25rem" title="Per-user region scope">' + regionPillsHtml(u.regionTags) + '</div>';
    }
    var passwordBtn = isIdpManaged(u) ? '' :
      '<button class="btn btn-sm btn-secondary" data-action="password" data-id="' + escapeHtml(u.id) + '" data-username="' + escapeHtml(u.username) + '">Password</button>';
    var totpCell;
    if (isIdpManaged(u)) {
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
    var roleId = u.role ? u.role.id : "";
    return '<tr>' +
      '<td style="text-align:center">' + onlineDot + '</td>' +
      '<td><strong>' + escapeHtml(u.username) + '</strong>' + displayName + regionsLabel + '</td>' +
      '<td>' + authBadge + '</td>' +
      '<td>' + roleBadge + '</td>' +
      '<td>' + totpCell + '</td>' +
      '<td>' + lastLogin + '</td>' +
      '<td>' + formatDate(u.createdAt) + '</td>' +
      '<td class="actions">' +
        '<button class="btn btn-sm btn-secondary" data-action="role" data-id="' + escapeHtml(u.id) + '" data-username="' + escapeHtml(u.username) + '" data-role-id="' + escapeHtml(roleId) + '">Role</button>' +
        '<button class="btn btn-sm btn-secondary" data-action="regions" data-id="' + escapeHtml(u.id) + '" data-username="' + escapeHtml(u.username) + '" title="Per-user region scope">Regions</button>' +
        passwordBtn +
        totpBtn +
        '<button class="btn btn-sm btn-danger" data-action="delete" data-id="' + escapeHtml(u.id) + '" data-username="' + escapeHtml(u.username) + '">Delete</button>' +
      '</td></tr>';
  }).join("");
}

// Build a <select> of roles. `selectedId` pre-selects a row; `defaultName`
// (e.g. "readonly") falls back to a name-match when no id is given.
function roleSelectHtml(selectId, selectedId, defaultName) {
  if (_rolesRaw.length === 0) {
    return '<select id="' + selectId + '"><option value="" selected>Loading…</option></select>';
  }
  var fallbackId = selectedId;
  if (!fallbackId && defaultName) {
    var d = _rolesRaw.filter(function (r) { return r.name === defaultName; })[0];
    if (d) fallbackId = d.id;
  }
  var opts = _rolesRaw.map(function (r) {
    var label = r.name + (r.isBuiltIn ? "" : " (custom)");
    var selected = r.id === fallbackId ? " selected" : "";
    return '<option value="' + escapeHtml(r.id) + '"' + selected + '>' + escapeHtml(label) + '</option>';
  }).join("");
  return '<select id="' + selectId + '">' + opts + '</select>';
}

function openCreateModal() {
  var body = '<div class="form-group"><label>Username *</label><input type="text" id="f-username" placeholder="e.g. jsmith"></div>' +
    '<div class="form-group"><label>Password *</label><input type="password" id="f-password" placeholder="Enter password">' + passwordChecksHTML("f-pw-checks") + '<p class="hint">The user can change this after first login.</p></div>' +
    '<div class="form-group"><label>Confirm Password *</label><input type="password" id="f-password-confirm" placeholder="Re-enter password">' + passwordMatchHTML("f-pw-match") + '</div>' +
    '<div class="form-group"><label>Role</label>' + roleSelectHtml("f-role", null, "readonly") + '</div>';
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
    var roleId = val("f-role");
    if (!roleId) { showToast("Pick a role", "error"); return; }
    btn.disabled = true;
    try {
      await api.users.create({
        username: val("f-username"),
        password: val("f-password"),
        roleId: roleId,
      });
      closeModal();
      showToast("User created");
      loadUsers();
      loadRoles();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function openChangeRoleModal(id, username, currentRoleId) {
  var body = '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">Change role for <strong>' + escapeHtml(username) + '</strong></p>' +
    '<div class="form-group"><label>Role</label>' + roleSelectHtml("f-role", currentRoleId, null) + '</div>';
  var footer = '<button class="btn btn-secondary" id="btn-cancel">Cancel</button><button class="btn btn-primary" id="btn-save">Update Role</button>';
  openModal("Change Role", body, footer);
  document.getElementById("btn-cancel").addEventListener("click", closeModal);

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    var roleId = val("f-role");
    if (!roleId) { showToast("Pick a role", "error"); return; }
    btn.disabled = true;
    try {
      await api.users.updateRole(id, { roleId: roleId });
      closeModal();
      showToast("Role updated for " + username);
      loadUsers();
      loadRoles();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function openUserRegionsModal(id, username) {
  var user = _usersRaw.filter(function (u) { return u.id === id; })[0];
  var current = (user && Array.isArray(user.regionTags)) ? user.regionTags.slice() : [];
  var currentOther = (user && Array.isArray(user.otherTags)) ? user.otherTags.slice() : [];
  var help =
    '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'Per-user tag scope for <strong>' + escapeHtml(username) + '</strong>. ' +
      'Empty = unrestricted. Effective scope is the union of the role\'s tags, ' +
      'these per-user tags, and any tags granted by the user\'s IdP groups.' +
    '</p>';
  var body = help +
    '<div class="form-group"><label>Region Scope</label>' + regionPickerHtml("f-user-regions", current) + '</div>' +
    '<div class="form-group"><label>Other Tags</label>' + otherTagsPickerHtml("f-user-other", currentOther) + '</div>';
  var footer = '<button class="btn btn-secondary" id="btn-cancel">Cancel</button><button class="btn btn-primary" id="btn-save">Save</button>';
  openModal("User Tag Scope", body, footer);
  document.getElementById("btn-cancel").addEventListener("click", closeModal);
  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var regionTags = collectRegionPicker("f-user-regions");
      var otherTags = collectOtherTags("f-user-other");
      await api.users.updateRegions(id, { regionTags: regionTags, otherTags: otherTags });
      closeModal();
      showToast("Tag scope updated for " + username);
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
    '<div class="form-group"><label>New Password *</label><input type="password" id="f-password" placeholder="Enter password">' + passwordChecksHTML("f-pw-checks") + '</div>' +
    '<div class="form-group"><label>Confirm Password *</label><input type="password" id="f-password-confirm" placeholder="Re-enter password">' + passwordMatchHTML("f-pw-match") + '</div>';
  var footer = '<button class="btn btn-secondary" id="btn-cancel">Cancel</button><button class="btn btn-primary" id="btn-save">Reset Password</button>';
  openModal("Reset Password", body, footer);
  wirePasswordChecks("f-password", "f-pw-checks");
  wirePasswordMatch("f-password", "f-password-confirm", "f-pw-match");
  document.getElementById("btn-cancel").addEventListener("click", closeModal);

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    var pw = val("f-password");
    if (!checkPasswordField(pw, "f-pw-checks")) {
      showToast("Password does not meet complexity requirements", "error");
      return;
    }
    if (pw !== val("f-password-confirm")) {
      showToast("Passwords do not match", "error");
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

// val() is the app.js canonical (2026-08 audit — five identical top-level copies shadowed each other on co-loaded pages).

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
    api.auth.entraProxySettings().catch(function () { return { enabled: false, trustedSourceIps: [], objectIdHeader: "x-entra-object-id", usernameHeader: "x-entra-upn", emailHeader: "x-entra-email", displayNameHeader: "x-entra-display-name", groupsHeader: "x-entra-groups" }; }),
  ]);
  var saml = results[0], oidc = results[1], ldap = results[2], entraProxy = results[3];

  var body =
    '<div class="settings-tabs">' +
      '<button class="settings-tab' + (_authActiveTab === "saml" ? ' active' : '') + '" data-tab="saml">SAML</button>' +
      '<button class="settings-tab' + (_authActiveTab === "oidc" ? ' active' : '') + '" data-tab="oidc">OIDC</button>' +
      '<button class="settings-tab' + (_authActiveTab === "ldap" ? ' active' : '') + '" data-tab="ldap">LDAP</button>' +
      '<button class="settings-tab' + (_authActiveTab === "entra-proxy" ? ' active' : '') + '" data-tab="entra-proxy">App Proxy</button>' +
      '<button class="settings-tab' + (_authActiveTab === "session" ? ' active' : '') + '" data-tab="session">Session</button>' +
    '</div>' +
    '<div class="settings-tab-panel' + (_authActiveTab === "saml" ? ' active' : '') + '" id="tab-saml">' + buildSamlTab(saml) + '</div>' +
    '<div class="settings-tab-panel' + (_authActiveTab === "oidc" ? ' active' : '') + '" id="tab-oidc">' + buildOidcTab(oidc) + '</div>' +
    '<div class="settings-tab-panel' + (_authActiveTab === "ldap" ? ' active' : '') + '" id="tab-ldap">' + buildLdapTab(ldap) + '</div>' +
    '<div class="settings-tab-panel' + (_authActiveTab === "entra-proxy" ? ' active' : '') + '" id="tab-entra-proxy">' + buildEntraProxyTab(entraProxy) + '</div>' +
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
      document.getElementById("btn-test-auth").style.display = (target === "session") ? "none" : "";
    });
  });
  document.getElementById("btn-test-auth").style.display = (_authActiveTab === "session") ? "none" : "";

  // SAML: live-update ACS / SLS URLs
  document.getElementById("f-sp-entity-id").addEventListener("input", function () {
    var base = this.value.trim().replace(/\/+$/, "");
    document.getElementById("f-sp-acs-url").value = base ? base + "/api/v1/auth/azure/callback" : "";
    document.getElementById("f-sp-sls-url").value = base ? base + "/login.html" : "";
  });

  // Copy buttons
  document.getElementById("btn-copy-acs-url").addEventListener("click", function () { copyField("f-sp-acs-url", this); });
  document.getElementById("btn-copy-sls-url").addEventListener("click", function () { copyField("f-sp-sls-url", this); });
  var oidcCopy = document.getElementById("btn-copy-oidc-redirect");
  if (oidcCopy) oidcCopy.addEventListener("click", function () { copyField("f-oidc-redirect-uri", this); });
  document.getElementById("btn-cancel-auth").addEventListener("click", closeModal);

  // Certificate file import
  document.getElementById("f-idp-cert-file").addEventListener("change", function () {
    var file = this.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) { document.getElementById("f-idp-certificate").value = e.target.result; };
    reader.readAsText(file);
  });

  // Test \u2014 per active tab (SAML / OIDC / LDAP). Saves that tab's settings
  // first, then runs the provider-specific connectivity test.
  document.getElementById("btn-test-auth").addEventListener("click", async function () {
    var tab = _authActiveTab;
    var btn = this;
    var resultsDiv = document.getElementById(tab === "saml" ? "sso-test-results" : tab + "-test-results");
    if (!resultsDiv) return;
    function setBox(ok) {
      resultsDiv.style.display = "block";
      resultsDiv.style.background = ok ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)";
      resultsDiv.style.border = ok ? "1px solid rgba(34,197,94,0.3)" : "1px solid rgba(239,68,68,0.3)";
    }
    btn.disabled = true;
    btn.textContent = "Testing\u2026";
    resultsDiv.style.display = "block";
    resultsDiv.style.background = "var(--color-bg-secondary)";
    resultsDiv.style.border = "1px solid var(--color-border)";
    resultsDiv.innerHTML = '<span style="color:var(--color-text-secondary)">Running test\u2026</span>';
    try {
      if (tab === "saml") {
        await api.auth.updateAzureSettings(getSamlFormData());
        var data = await api.auth.testAzureSettings();
        var r = data.results;
        resultsDiv.innerHTML = '<div style="display:flex;flex-direction:column;gap:0.5rem">' +
          '<div>' + (r.certificate.ok ? "\u2705" : "\u274c") + ' <strong>Certificate:</strong> ' + escapeHtml(r.certificate.message) + '</div>' +
          '<div>' + (r.idpLoginUrl.ok ? "\u2705" : "\u274c") + ' <strong>IdP Login URL:</strong> ' + escapeHtml(r.idpLoginUrl.message) + '</div>' +
        '</div>';
        setBox(data.ok);
      } else if (tab === "oidc") {
        await api.auth.updateOidcSettings(getOidcFormData());
        var od = await api.auth.testOidc();
        var detailHtml = "";
        if (od.details) {
          detailHtml = '<div style="margin-top:0.4rem;font-size:0.8rem;color:var(--color-text-secondary)">' +
            'authorization: ' + escapeHtml(od.details.authorization_endpoint || "") + '<br>' +
            'token: ' + escapeHtml(od.details.token_endpoint || "") + '<br>' +
            'userinfo: ' + escapeHtml(od.details.userinfo_endpoint || "(none)") + '</div>';
        }
        resultsDiv.innerHTML = (od.ok ? "\u2705 " : "\u274c ") + escapeHtml(od.message) + detailHtml;
        setBox(od.ok);
      } else if (tab === "ldap") {
        await api.auth.updateLdapSettings(getLdapFormData());
        var ld = await api.auth.testLdap();
        resultsDiv.innerHTML = (ld.ok ? "\u2705 " : "\u274c ") + escapeHtml(ld.message);
        setBox(ld.ok);
      } else if (tab === "entra-proxy") {
        await api.auth.updateEntraProxySettings(getEntraProxyFormData());
        var ep = await api.auth.testEntraProxy();
        var epDetail = "";
        if (ep.details) {
          epDetail = '<div style="margin-top:0.4rem;font-size:0.8rem;color:var(--color-text-secondary)">' +
            'request IP: <code>' + escapeHtml(ep.details.requestIp || "(unknown)") + '</code> \u2014 ' +
            (ep.details.trusted ? 'trusted' : 'not trusted') + '<br>' +
            'identity headers on this request: ' + escapeHtml((ep.details.headersPresent || []).join(", ") || "(none)") + '</div>';
        }
        resultsDiv.innerHTML = (ep.ok ? "\u2705 " : "\u274c ") + escapeHtml(ep.message) + epDetail;
        setBox(ep.ok);
      }
    } catch (err) {
      resultsDiv.innerHTML = '<span style="color:var(--color-danger)">\u274c ' + escapeHtml(err.message) + '</span>';
      setBox(false);
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
        api.auth.updateEntraProxySettings(getEntraProxyFormData()),
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
    groupsClaim: val("f-oidc-groups-claim"),
    usernameClaim: val("f-oidc-username-claim"),
    emailClaim: val("f-oidc-email-claim"),
    displayNameClaim: val("f-oidc-displayname-claim"),
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
    userIdAttribute: val("f-ldap-userid-attr"),
    groupAttribute: val("f-ldap-group-attr"),
    groupBaseDn: val("f-ldap-group-base"),
    groupFilter: val("f-ldap-group-filter"),
  };
}

function getEntraProxyFormData() {
  var ips = val("f-entra-proxy-trusted-ips")
    .split(/[\s,]+/)
    .map(function (x) { return x.trim(); })
    .filter(Boolean);
  return {
    enabled: document.getElementById("f-entra-proxy-enabled").checked,
    trustedSourceIps: ips,
    objectIdHeader: val("f-entra-proxy-objectid-header"),
    usernameHeader: val("f-entra-proxy-username-header"),
    emailHeader: val("f-entra-proxy-email-header"),
    displayNameHeader: val("f-entra-proxy-displayname-header"),
    groupsHeader: val("f-entra-proxy-groups-header"),
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
      '<p class="hint">Space-separated list of scopes to request. Include the scope that returns groups (e.g. <code>groups</code> or a provider-specific scope).</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Redirect URI</label>' +
      '<div style="display:flex;gap:0.5rem;align-items:center">' +
        '<input type="text" id="f-oidc-redirect-uri" value="' + escapeHtml(s.redirectUri || "") + '" readonly style="background:var(--color-bg-secondary);cursor:default;flex:1">' +
        '<button type="button" class="btn btn-sm btn-secondary" id="btn-copy-oidc-redirect" title="Copy">Copy</button>' +
      '</div>' +
      '<p class="hint">Register this exact redirect URI in your IdP app. Derived from <code>POLARIS_PUBLIC_URL</code>.</p>' +
    '</div>' +
    '<h4 style="font-size:0.88rem;font-weight:600;margin:1.25rem 0 0.75rem;color:var(--color-text-primary);border-bottom:1px solid var(--color-border);padding-bottom:0.4rem">Claim Mapping</h4>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
      '<div class="form-group">' +
        '<label>Groups Claim</label>' +
        '<input type="text" id="f-oidc-groups-claim" value="' + escapeHtml(s.groupsClaim || "groups") + '">' +
        '<p class="hint">Claim holding the user\'s groups. <strong>Azure AD emits group object IDs (GUIDs), not names</strong> — map those IDs in Group Mappings, or configure Azure to emit names.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Username Claim</label>' +
        '<input type="text" id="f-oidc-username-claim" value="' + escapeHtml(s.usernameClaim || "preferred_username") + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Email Claim</label>' +
        '<input type="text" id="f-oidc-email-claim" value="' + escapeHtml(s.emailClaim || "email") + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Display Name Claim</label>' +
        '<input type="text" id="f-oidc-displayname-claim" value="' + escapeHtml(s.displayNameClaim || "name") + '">' +
      '</div>' +
    '</div>' +
    '<div id="oidc-test-results" style="display:none;margin-top:1rem;padding:0.75rem;border-radius:6px;font-size:0.85rem"></div>';
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
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Group Membership</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
      '<div class="form-group">' +
        '<label>User ID Attribute</label>' +
        '<input type="text" id="f-ldap-userid-attr" value="' + escapeHtml(s.userIdAttribute || "objectGUID") + '">' +
        '<p class="hint">Stable per-user id. <code>objectGUID</code> (AD) or <code>entryUUID</code> (OpenLDAP).</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Group Attribute</label>' +
        '<input type="text" id="f-ldap-group-attr" value="' + escapeHtml(s.groupAttribute || "memberOf") + '">' +
        '<p class="hint">Multi-valued group DNs on the user entry. <code>memberOf</code> on AD.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Group Search Base <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
        '<input type="text" id="f-ldap-group-base" value="' + escapeHtml(s.groupBaseDn || "") + '" placeholder="e.g. OU=Groups,DC=corp,DC=local">' +
        '<p class="hint">Reverse member search to catch groups not in <code>memberOf</code>. Leave blank to skip.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Group Filter <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
        '<input type="text" id="f-ldap-group-filter" value="' + escapeHtml(s.groupFilter || "(member={{userDn}})") + '">' +
        '<p class="hint">Used with the group search base. <code>{{userDn}}</code> is the user\'s DN.</p>' +
      '</div>' +
    '</div>' +
    '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin-top:0.5rem">Map LDAP group DNs to roles + tags in <strong>Group Mappings</strong>. Group identifiers match on the full DN (lowercased).</p>' +
    '<div id="ldap-test-results" style="display:none;margin-top:1rem;padding:0.75rem;border-radius:6px;font-size:0.85rem"></div>';
}

function buildEntraProxyTab(s) {
  var ips = (s.trustedSourceIps || []).join("\n");
  return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1rem">Sign users in from identity headers injected by <strong>Microsoft Entra Application Proxy</strong> header-based SSO. Users pre-authenticated by Entra are logged in automatically (no second sign-in).</p>' +
    '<div style="background:rgba(234,179,8,0.10);border:1px solid rgba(234,179,8,0.35);border-radius:6px;padding:0.6rem 0.75rem;margin-bottom:1.1rem;font-size:0.8rem;color:var(--color-text-secondary)">' +
      '⚠️ <strong>These headers are unsigned.</strong> The only thing preventing spoofing is source-IP trust — Polaris honors the identity headers <em>only</em> from the addresses below and strips them from every other request. Make sure the backend is reachable <em>only</em> through the App Proxy connector (and your nginx). Entra also silently omits the groups header when a user is in more than ~150 groups unless the app is configured with “groups assigned to the application.”' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-entra-proxy-enabled"' + (s.enabled ? ' checked' : '') + '>' +
        '<span>Enable App Proxy header authentication</span>' +
      '</label>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<div class="form-group">' +
      '<label>Trusted source IPs / CIDRs</label>' +
      '<textarea id="f-entra-proxy-trusted-ips" rows="3" style="font-family:monospace;font-size:0.8rem;resize:vertical" placeholder="10.20.30.40&#10;10.20.30.0/24">' + escapeHtml(ips) + '</textarea>' +
      '<p class="hint">One IP or CIDR per line — the App Proxy connector host(s) <strong>as Polaris sees them</strong> (behind nginx, the address nginx forwards). Empty = header login is disabled. Use the <strong>Test</strong> button below to see this request\'s source address.</p>' +
    '</div>' +
    '<h4 style="font-size:0.88rem;font-weight:600;margin:1.25rem 0 0.75rem;color:var(--color-text-primary);border-bottom:1px solid var(--color-border);padding-bottom:0.4rem">Header Mapping</h4>' +
    '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin-bottom:0.75rem">The header names you configure in the App Proxy SSO blade. Lowercase, letters/digits/hyphens only.</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
      '<div class="form-group">' +
        '<label>Object ID header *</label>' +
        '<input type="text" id="f-entra-proxy-objectid-header" value="' + escapeHtml(s.objectIdHeader || "x-entra-object-id") + '">' +
        '<p class="hint">Carries the Entra user object ID (GUID) — the account key.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Username / UPN header *</label>' +
        '<input type="text" id="f-entra-proxy-username-header" value="' + escapeHtml(s.usernameHeader || "x-entra-upn") + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Email header</label>' +
        '<input type="text" id="f-entra-proxy-email-header" value="' + escapeHtml(s.emailHeader || "") + '" placeholder="(optional)">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Display name header</label>' +
        '<input type="text" id="f-entra-proxy-displayname-header" value="' + escapeHtml(s.displayNameHeader || "") + '" placeholder="(optional)">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Groups header</label>' +
        '<input type="text" id="f-entra-proxy-groups-header" value="' + escapeHtml(s.groupsHeader || "") + '" placeholder="(optional)">' +
        '<p class="hint">Comma/semicolon-separated Entra group object IDs (GUIDs). Map them to roles + tags in <strong>Group Mappings</strong> (provider “App Proxy”).</p>' +
      '</div>' +
    '</div>' +
    '<div id="entra-proxy-test-results" style="display:none;margin-top:1rem;padding:0.75rem;border-radius:6px;font-size:0.85rem"></div>';
}

function buildSessionTab(s) {
  // Turning "Skip login page" ON is only permitted while the admin is signed in
  // through SSO (SAML or OIDC) — end-to-end proof that SSO works before the
  // local login page is hidden, so an SSO misconfiguration can't lock everyone
  // out. The server enforces this on save; we mirror it here. Turning it OFF is
  // always allowed, so the checkbox is only locked when it's currently off.
  var ssoSession = (typeof currentUserAuthProvider !== "undefined") &&
    (currentUserAuthProvider === "azure" || currentUserAuthProvider === "oidc");
  var lockOn = !ssoSession && !s.skipLoginPage;
  var hint = lockOn
    ? "You are signed in with a local account. To enable this, sign in through SSO (SAML or OIDC) first — this prevents locking everyone out if SSO is misconfigured."
    : "Redirect unauthenticated users straight to SSO. Requires a SAML or OIDC provider to be configured.";
  return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1.25rem">Configure session behavior for all authentication methods.</p>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:' + (lockOn ? 'not-allowed' : 'pointer') + '">' +
        '<input type="checkbox" id="f-skip-login"' + (s.skipLoginPage ? ' checked' : '') + (lockOn ? ' disabled' : '') + '>' +
        '<span>Skip login page (SSO only)</span>' +
      '</label>' +
      '<p class="hint" style="margin:0.35rem 0 0 1.5rem">' + hint + '</p>' +
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

// ─── Roles section ─────────────────────────────────────────────────────────

async function loadRoles() {
  var section = document.getElementById("roles-section");
  if (!section) return;
  // Roles management is admin-only. The backend will 403 non-admin callers;
  // hiding the section client-side avoids a misleading empty card.
  if (typeof isAdmin === "function" && !isAdmin()) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";
  var tbody = document.getElementById("roles-tbody");
  try {
    _rolesRaw = await api.roles.list();
    _rolesById = {};
    _rolesRaw.forEach(function (r) { _rolesById[r.id] = r; });
    if (!_matrixSpec) {
      try { _matrixSpec = await api.roles.functions(); } catch (_) { _matrixSpec = null; }
    }
    renderRolesBody();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function renderRolesBody() {
  var tbody = document.getElementById("roles-tbody");
  // Hide the two protected built-ins (admin + readonly) from the editable
  // list — they're always-locked-and-pre-populated by definition. Custom
  // roles + the three editable built-ins (networkadmin / assetsadmin /
  // user) show up here.
  var visible = _rolesRaw.filter(function (r) { return !r.isProtected; });
  if (visible.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No editable roles. Click "+ Add Role" to create one.</td></tr>';
    return;
  }
  visible.sort(function (a, b) {
    // Built-ins first, then custom; alphabetical within each tier.
    if (a.isBuiltIn !== b.isBuiltIn) return a.isBuiltIn ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  tbody.innerHTML = visible.map(function (r) {
    var swatch = r.color
      ? '<span title="Badge color" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + escapeHtml(r.color) + ';margin-right:7px;vertical-align:middle;border:1px solid var(--color-border)"></span>'
      : '';
    var nameCell = swatch + '<button class="btn btn-link" data-role-action="edit" data-role-id="' + escapeHtml(r.id) + '" style="padding:0;font-weight:600;color:var(--color-accent);background:none;border:none;cursor:pointer;vertical-align:middle">' + escapeHtml(r.name) + '</button>';
    var descCell = '<span style="color:var(--color-text-secondary);font-size:0.88em">' + escapeHtml(r.description || "—") + '</span>';
    var usersCell = '<span class="badge" style="background:var(--color-bg-secondary);color:var(--color-text-primary)">' + r.userCount + '</span>';
    var builtInCell = r.isBuiltIn
      ? '<span class="badge" style="background:var(--color-bg-secondary);color:var(--color-text-secondary)">Built-in</span>'
      : '<span style="color:var(--color-text-tertiary)">—</span>';
    var delBtn = r.isBuiltIn || r.userCount > 0
      ? '<button class="btn btn-sm btn-secondary" disabled title="' + (r.isBuiltIn ? "Built-in roles cannot be deleted" : "Reassign users first") + '">Delete</button>'
      : '<button class="btn btn-sm btn-danger" data-role-action="delete" data-role-id="' + escapeHtml(r.id) + '">Delete</button>';
    return '<tr>' +
      '<td>' + nameCell + '</td>' +
      '<td>' + descCell + '</td>' +
      '<td>' + usersCell + '</td>' +
      '<td>' + builtInCell + '</td>' +
      '<td class="actions">' +
        '<button class="btn btn-sm btn-secondary" data-role-action="edit" data-role-id="' + escapeHtml(r.id) + '">Edit</button>' +
        delBtn +
      '</td></tr>';
  }).join("");
}

async function confirmDeleteRole(id) {
  var role = _rolesById[id];
  if (!role) return;
  var ok = await showConfirm('Delete role "' + role.name + '"? This cannot be undone.');
  if (!ok) return;
  try {
    await api.roles.delete(id);
    showToast("Role deleted");
    loadRoles();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── Group Mappings section ─────────────────────────────────────────────────

var _GM_PROVIDERS = [
  { value: "oidc", label: "OIDC" },
  { value: "ldap", label: "LDAP" },
  { value: "saml", label: "SAML" },
  { value: "entra-proxy", label: "App Proxy" },
];

async function loadGroupMappings() {
  var section = document.getElementById("group-mappings-section");
  if (!section) return;
  // Admin-only (gated server-side on users=fullwrite); hide for everyone else.
  if (typeof isAdmin === "function" && !isAdmin()) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";
  var tbody = document.getElementById("group-mappings-tbody");
  try {
    _groupMappingsRaw = await api.groupMappings.list();
    _groupMappingsById = {};
    _groupMappingsRaw.forEach(function (m) { _groupMappingsById[m.id] = m; });
    renderGroupMappingsBody();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function gmTagsCell(m) {
  var parts = [];
  (m.regionTags || []).forEach(function (t) {
    parts.push('<span class="badge" style="background:rgba(74,158,255,0.12);color:var(--color-primary,#4a9eff);border:1px solid rgba(74,158,255,0.35);margin:0.1rem 0.2rem 0.1rem 0">' + escapeHtml(t) + '</span>');
  });
  (m.otherTags || []).forEach(function (t) {
    parts.push('<span class="badge" style="background:rgba(158,158,158,0.14);color:var(--color-text-secondary);border:1px solid rgba(158,158,158,0.4);margin:0.1rem 0.2rem 0.1rem 0">' + escapeHtml(t) + '</span>');
  });
  return parts.length ? parts.join("") : '<span style="color:var(--color-text-tertiary)">—</span>';
}

function renderGroupMappingsBody() {
  var tbody = document.getElementById("group-mappings-tbody");
  if (!_groupMappingsRaw.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No group mappings. Click "+ Add Mapping" to map an IdP group to a role + tags.</td></tr>';
    return;
  }
  tbody.innerHTML = _groupMappingsRaw.map(function (m) {
    var role = m.roleName ? escapeHtml(m.roleName) : '<span style="color:var(--color-text-tertiary)">(tags only)</span>';
    var enabled = m.enabled
      ? '<span class="badge" style="background:rgba(34,197,94,0.14);color:#22c55e;border:1px solid rgba(34,197,94,0.4)">Enabled</span>'
      : '<span class="badge" style="background:rgba(158,158,158,0.14);color:var(--color-text-tertiary);border:1px solid rgba(158,158,158,0.4)">Disabled</span>';
    return '<tr>' +
      '<td style="text-transform:uppercase;font-size:0.75rem;font-weight:600">' + escapeHtml(m.provider) + '</td>' +
      '<td style="word-break:break-all">' + escapeHtml(m.groupLabel || m.groupKey) + (m.description ? '<div class="hint" style="margin:0.15rem 0 0">' + escapeHtml(m.description) + '</div>' : '') + '</td>' +
      '<td>' + role + '</td>' +
      '<td>' + gmTagsCell(m) + '</td>' +
      '<td>' + enabled + '</td>' +
      '<td>' +
        '<button class="btn btn-sm btn-secondary" data-gm-action="edit" data-gm-id="' + m.id + '">Edit</button> ' +
        '<button class="btn btn-sm btn-danger" data-gm-action="delete" data-gm-id="' + m.id + '">Delete</button>' +
      '</td>' +
    '</tr>';
  }).join("");
}

async function confirmDeleteGroupMapping(id) {
  var m = _groupMappingsById[id];
  if (!m) return;
  var ok = await showConfirm('Delete the ' + m.provider + ' group mapping for "' + (m.groupLabel || m.groupKey) + '"?');
  if (!ok) return;
  try {
    await api.groupMappings.delete(id);
    showToast("Group mapping deleted");
    loadGroupMappings();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function openGroupMappingSlideover(id) {
  // Ensure the role list is loaded for the dropdown.
  if (!_rolesRaw || !_rolesRaw.length) {
    try { _rolesRaw = await api.roles.list(); _rolesRaw.forEach(function (r) { _rolesById[r.id] = r; }); } catch (_) {}
  }
  var m = id ? _groupMappingsById[id] : null;
  var isCreate = !m;
  var provider = m ? m.provider : "oidc";

  var providerOpts = _GM_PROVIDERS.map(function (p) {
    return '<option value="' + p.value + '"' + (provider === p.value ? " selected" : "") + '>' + p.label + '</option>';
  }).join("");
  var roleOpts = '<option value="">(tags only — no role)</option>' +
    _rolesRaw.map(function (r) {
      return '<option value="' + r.id + '"' + (m && m.roleId === r.id ? " selected" : "") + '>' + escapeHtml(r.name) + '</option>';
    }).join("");

  var groupHint = 'For LDAP, enter the full group DN (matched case-insensitively). For OIDC/SAML, enter the group claim value exactly. <strong>Azure AD emits group object IDs (GUIDs)</strong> — use the object ID unless your IdP emits names. For <strong>App Proxy</strong>, enter the Entra group object ID (GUID; matched case-insensitively) exactly as it appears in the App Proxy group header.';

  var body =
    '<div class="form-group">' +
      '<label>Provider</label>' +
      '<select id="f-gm-provider"' + (isCreate ? "" : " disabled") + '>' + providerOpts + '</select>' +
      (isCreate ? '' : '<p class="hint">Provider can\'t be changed after creation.</p>') +
    '</div>' +
    '<div class="form-group">' +
      '<label>Group Identifier *</label>' +
      '<input type="text" id="f-gm-group" value="' + escapeHtml(m ? (m.groupLabel || m.groupKey) : "") + '" placeholder="CN=NetAdmins,OU=Groups,DC=corp,DC=local or a group name/object-id">' +
      '<p class="hint">' + groupHint + '</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Role</label>' +
      '<select id="f-gm-role">' + roleOpts + '</select>' +
      '<p class="hint">Highest-privilege role wins when a user is in multiple mapped groups.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Region Scope</label>' +
      regionPickerHtml("f-gm-regions", m ? (m.regionTags || []) : []) +
    '</div>' +
    '<div class="form-group">' +
      '<label>Other Tags</label>' +
      otherTagsPickerHtml("f-gm-other", m ? (m.otherTags || []) : []) +
    '</div>' +
    '<div class="form-group">' +
      '<label>Description</label>' +
      '<input type="text" id="f-gm-description" value="' + escapeHtml(m && m.description ? m.description : "") + '" maxlength="200" placeholder="Optional note">' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-gm-enabled"' + (!m || m.enabled ? " checked" : "") + '><span>Enabled</span>' +
      '</label>' +
    '</div>';
  var footer = '<button class="btn btn-secondary" id="btn-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">' + (isCreate ? "Create Mapping" : "Save Changes") + '</button>';
  openModal(isCreate ? "Add Group Mapping" : "Edit Group Mapping", body, footer);
  document.getElementById("btn-cancel").addEventListener("click", closeModal);
  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    var groupKey = (document.getElementById("f-gm-group").value || "").trim();
    if (!groupKey) { showToast("Group identifier is required", "error"); return; }
    var payload = {
      groupKey: groupKey,
      roleId: document.getElementById("f-gm-role").value || null,
      regionTags: collectRegionPicker("f-gm-regions"),
      otherTags: collectOtherTags("f-gm-other"),
      description: (document.getElementById("f-gm-description").value || "").trim() || null,
      enabled: document.getElementById("f-gm-enabled").checked,
    };
    btn.disabled = true;
    try {
      if (isCreate) {
        payload.provider = document.getElementById("f-gm-provider").value;
        await api.groupMappings.create(payload);
        showToast("Group mapping created");
      } else {
        await api.groupMappings.update(m.id, payload);
        showToast("Group mapping saved");
      }
      closeModal();
      loadGroupMappings();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// ─── Permissions slide-over ────────────────────────────────────────────────

var _PERM_LEVELS = ["none", "read", "write", "fullwrite"];
var _PERM_LABELS = { none: "No Access", read: "Read-Only", write: "Read-Write", fullwrite: "Full Read-Write" };

async function openRoleSlideover(roleId) {
  if (!_matrixSpec) {
    try { _matrixSpec = await api.roles.functions(); }
    catch (err) { showToast("Could not load permission catalogue: " + err.message, "error"); return; }
  }
  var role = roleId ? _rolesById[roleId] : null;
  var isCreate = !role;
  var isProtected = !!(role && role.isProtected);
  var permissions = role ? Object.assign({}, role.permissions) : {};
  // Pre-fill new roles with all-none.
  _matrixSpec.functions.forEach(function (f) {
    if (!(f.key in permissions)) permissions[f.key] = "none";
  });

  var mount = document.getElementById("role-slideover-mount");
  if (!mount) return;
  mount.innerHTML = buildRoleSlideoverHtml(role, isCreate, isProtected, permissions);

  var overlay = document.getElementById("role-slideover-overlay");
  var panel = document.getElementById("role-slideover-panel");
  if (typeof initSlideoverResize === "function") {
    initSlideoverResize(panel, "polaris.panel.width.role-permissions");
  }
  requestAnimationFrame(function () { overlay.classList.add("open"); });

  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeRoleSlideover();
  });
  document.getElementById("role-slideover-close").addEventListener("click", closeRoleSlideover);
  document.getElementById("role-slideover-cancel").addEventListener("click", closeRoleSlideover);

  // "Set all to …" bulk action
  document.getElementById("role-bulk-set").addEventListener("change", function () {
    var lvl = this.value;
    if (!lvl) return;
    _matrixSpec.functions.forEach(function (f) {
      var radio = document.querySelector('input[type="radio"][name="perm-' + f.key + '"][value="' + lvl + '"]');
      if (radio && !radio.disabled) radio.checked = true;
    });
    this.value = "";
  });

  // Color picker: live-preview the badge as the color or name changes, and
  // re-roll on "Randomize". Inert for protected roles (input disabled).
  var colorInput = document.getElementById("f-role-color");
  var colorPreview = document.getElementById("role-color-preview");
  var nameInput = document.getElementById("f-role-name");
  function syncColorPreview() {
    if (!colorPreview) return;
    var style = roleBadgeStyleFromColor(colorInput ? colorInput.value : null);
    if (style) colorPreview.setAttribute("style", style);
    var nm = nameInput ? nameInput.value.trim() : "";
    colorPreview.textContent = nm || "preview";
  }
  if (colorInput) colorInput.addEventListener("input", syncColorPreview);
  if (nameInput) nameInput.addEventListener("input", syncColorPreview);
  var randomBtn = document.getElementById("f-role-color-random");
  if (randomBtn) randomBtn.addEventListener("click", function () {
    if (colorInput) colorInput.value = randomRoleColor();
    syncColorPreview();
  });

  if (isProtected) {
    // Don't expose Save for protected roles — read-only view.
    var saveBtn = document.getElementById("role-slideover-save");
    if (saveBtn) saveBtn.style.display = "none";
    return;
  }

  document.getElementById("role-slideover-save").addEventListener("click", async function () {
    var btn = this;
    var name = (document.getElementById("f-role-name").value || "").trim();
    var description = (document.getElementById("f-role-description").value || "").trim();
    if (!/^[A-Za-z0-9_-]{2,32}$/.test(name)) {
      showToast("Role name must be 2-32 chars: letters / digits / dash / underscore", "error");
      return;
    }
    var perms = {};
    _matrixSpec.functions.forEach(function (f) {
      var checked = document.querySelector('input[type="radio"][name="perm-' + f.key + '"]:checked');
      perms[f.key] = checked ? checked.value : "none";
    });
    var regionTags = collectRegionPicker("f-role-regions");
    var otherTags = collectOtherTags("f-role-other");
    var colorEl = document.getElementById("f-role-color");
    var color = colorEl ? colorEl.value : null;
    btn.disabled = true;
    try {
      if (isCreate) {
        await api.roles.create({ name: name, description: description, permissions: perms, regionTags: regionTags, otherTags: otherTags, color: color });
        showToast('Role "' + name + '" created');
      } else {
        await api.roles.update(role.id, { name: name, description: description, permissions: perms, regionTags: regionTags, otherTags: otherTags, color: color });
        showToast('Role "' + name + '" saved');
      }
      closeRoleSlideover();
      loadRoles();
      loadUsers();  // user-list role badges may rename if a built-in name changed
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function closeRoleSlideover() {
  var overlay = document.getElementById("role-slideover-overlay");
  if (!overlay) return;
  overlay.classList.remove("open");
  setTimeout(function () {
    var mount = document.getElementById("role-slideover-mount");
    if (mount) mount.innerHTML = "";
  }, 250);
}

function buildRoleSlideoverHtml(role, isCreate, isProtected, permissions) {
  var titleText = isCreate ? "New Role" : ("Role: " + (role ? role.name : ""));
  var builtInBadge = role && role.isBuiltIn ? ' <span class="badge" style="background:var(--color-bg-secondary);color:var(--color-text-secondary);font-size:0.7em">Built-in</span>' : "";
  var protectedBadge = isProtected ? ' <span class="badge" style="background:rgba(239,68,68,0.15);color:var(--color-danger);font-size:0.7em">Locked</span>' : "";
  var userCountMeta = role ? (role.userCount + " user(s) hold this role") : "Not yet assigned";

  var matrixRows = _matrixSpec.functions.map(function (f) {
    var current = permissions[f.key] || "none";
    var cells = _PERM_LEVELS.map(function (lvl) {
      var disabled = isProtected ? " disabled" : "";
      var checked = current === lvl ? " checked" : "";
      return '<td style="text-align:center">' +
        '<label style="cursor:' + (isProtected ? "default" : "pointer") + ';display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%;padding:0.5rem 0">' +
          '<input type="radio" name="perm-' + escapeHtml(f.key) + '" value="' + lvl + '"' + checked + disabled + '>' +
        '</label>' +
      '</td>';
    }).join("");
    var ownershipNote = f.hasOwnershipDimension
      ? ' <span title="Read-Write = create/edit/delete your own rows only; Full Read-Write = create/edit/delete any row" style="color:var(--color-text-tertiary);font-size:0.85em">(Read-Write = own · Full Read-Write = any)</span>'
      : '';
    return '<tr>' +
      '<td>' +
        '<div style="font-weight:600">' + escapeHtml(f.label) + ownershipNote + '</div>' +
        '<div style="font-size:0.78em;color:var(--color-text-tertiary)">' + escapeHtml(f.description) + '</div>' +
      '</td>' +
      cells +
    '</tr>';
  }).join("");

  var headerCells = _PERM_LEVELS.map(function (lvl) {
    return '<th style="text-align:center;font-size:0.8em">' + escapeHtml(_PERM_LABELS[lvl]) + '</th>';
  }).join("");

  var bulkSet = isProtected
    ? ''
    : '<div style="margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem">' +
        '<label style="font-size:0.85em;color:var(--color-text-secondary)">Set every row to:</label>' +
        '<select id="role-bulk-set" style="width:auto">' +
          '<option value="">—</option>' +
          _PERM_LEVELS.map(function (lvl) { return '<option value="' + lvl + '">' + escapeHtml(_PERM_LABELS[lvl]) + '</option>'; }).join("") +
        '</select>' +
      '</div>';

  var nameRow = '<div class="form-group">' +
    '<label>Name *</label>' +
    '<input type="text" id="f-role-name" maxlength="32" value="' + escapeHtml(role ? role.name : "") + '"' + (isProtected ? " disabled" : "") + '>' +
    '<p class="hint">2-32 characters; letters, digits, dash, underscore.</p>' +
  '</div>';
  var descRow = '<div class="form-group">' +
    '<label>Description</label>' +
    '<input type="text" id="f-role-description" maxlength="200" value="' + escapeHtml(role ? (role.description || "") : "") + '"' + (isProtected ? " disabled" : "") + '>' +
  '</div>';
  // New roles default to a random color; existing roles prefill their stored
  // color (or a random one if somehow unset). The native color input always
  // yields a valid #rrggbb, so it round-trips the backend regex cleanly.
  var initialColor = (role && role.color) || randomRoleColor();
  var previewLabel = (role && role.name) || "preview";
  var colorRow = '<div class="form-group">' +
    '<label>Badge Color</label>' +
    '<div style="display:flex;align-items:center;gap:0.6rem">' +
      '<input type="color" id="f-role-color" value="' + escapeHtml(initialColor) + '"' + (isProtected ? " disabled" : "") +
        ' style="width:48px;height:34px;padding:2px;border:1px solid var(--color-border);border-radius:6px;background:none;cursor:' + (isProtected ? "default" : "pointer") + '">' +
      (isProtected ? "" : '<button type="button" class="btn btn-sm btn-secondary" id="f-role-color-random">Randomize</button>') +
      '<span class="badge" id="role-color-preview" style="' + roleBadgeStyleFromColor(initialColor) + '">' + escapeHtml(previewLabel) + '</span>' +
    '</div>' +
    '<p class="hint">Pill color shown in the sidebar, the users list, and this list.</p>' +
  '</div>';
  var regionsRow = '<div class="form-group">' +
    '<label>Region Scope</label>' +
    '<p class="hint" style="margin-top:0">Empty = unrestricted. Combined with each user\'s own region tags at session time.</p>' +
    regionPickerHtml("f-role-regions", role ? (role.regionTags || []) : []) +
  '</div>' +
  '<div class="form-group">' +
    '<label>Other Tags</label>' +
    '<p class="hint" style="margin-top:0">Free-form tag scope, a second dimension alongside region tags. Empty = unrestricted.</p>' +
    otherTagsPickerHtml("f-role-other", role ? (role.otherTags || []) : []) +
  '</div>';

  var footerHtml = isProtected
    ? '<button class="btn btn-secondary" id="role-slideover-cancel">Close</button>'
    : '<button class="btn btn-secondary" id="role-slideover-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="role-slideover-save">' + (isCreate ? "Create Role" : "Save Changes") + '</button>';

  return '' +
    '<div class="slideover-overlay" id="role-slideover-overlay">' +
      '<div class="slideover" id="role-slideover-panel">' +
        '<div class="slideover-resize-handle"></div>' +
        '<div class="slideover-header">' +
          '<div class="slideover-header-top">' +
            '<h3>' + escapeHtml(titleText) + builtInBadge + protectedBadge + '</h3>' +
            '<button class="btn-icon" id="role-slideover-close">&times;</button>' +
          '</div>' +
          '<div class="slideover-meta">' + escapeHtml(userCountMeta) + '</div>' +
        '</div>' +
        '<div class="slideover-body">' +
          '<div class="role-panel-content">' +
            nameRow +
            descRow +
            colorRow +
            regionsRow +
            '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
            '<h4 style="margin:0 0 0.5rem;font-size:0.95rem">Permissions</h4>' +
            bulkSet +
            '<div style="overflow:auto">' +
              '<table style="width:100%;border-collapse:collapse">' +
                '<thead><tr><th style="text-align:left">Function</th>' + headerCells + '</tr></thead>' +
                '<tbody>' + matrixRows + '</tbody>' +
              '</table>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="slideover-footer">' + footerHtml + '</div>' +
      '</div>' +
    '</div>';
}

// ─── Region tag picker (shared by user-regions modal + role slide-over) ──

async function loadRegionList() {
  try {
    if (api.mapRegions && typeof api.mapRegions.list === "function") {
      var regions = await api.mapRegions.list();
      _regionByName = {};
      (regions || []).forEach(function (r) {
        if (r && r.name) _regionByName[r.name] = r.color || "";
      });
      _regionList = Object.keys(_regionByName).sort();
      // Re-render any open user table so existing rows pick up the colors.
      if (typeof renderUsersBody === "function" && document.getElementById("users-tbody")) {
        try { renderUsersBody(); } catch (_) {}
      }
    }
  } catch (_) {
    // Region listing requires mapRegions=read; non-admin viewers fall
    // through to a free-text picker with no autocomplete.
    _regionList = [];
    _regionByName = {};
  }
}

// Return the stored hex color for a region name, or a neutral fallback so a
// region tag that was hand-typed (and not in the map-regions catalogue) still
// renders as a recognizable pill.
function regionColorFor(name) {
  var c = _regionByName[name];
  if (c && /^#[0-9a-fA-F]{6}$/.test(c)) return c;
  return "#9e9e9e";
}

// Convert a #rrggbb hex to "r, g, b" so we can drop it into rgba(...) for the
// translucent pill background while keeping the solid border + text in full color.
function hexToRgbTriplet(hex) {
  var m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex || "");
  if (!m) return "158, 158, 158";
  return parseInt(m[1], 16) + ", " + parseInt(m[2], 16) + ", " + parseInt(m[3], 16);
}

// One badge per region, colored by the region's stored color.
function regionPillsHtml(names) {
  if (!Array.isArray(names) || names.length === 0) return "";
  return names.map(function (n) {
    var hex = regionColorFor(n);
    var rgb = hexToRgbTriplet(hex);
    return '<span class="badge" style="background:rgba(' + rgb + ',0.18);color:' + hex + ';border:1px solid rgba(' + rgb + ',0.45)">' +
      escapeHtml(n) +
    '</span>';
  }).join("");
}

// Render every map-region as a clickable pill colored by the region's stored
// color. Selected pills are filled; deselected pills are an outline of the
// same color. Click toggles. Region tags previously assigned by hand that no
// longer exist in the catalogue are shown at the top in gray with a remove ×
// so admins can clean them up without losing the assignment data.
function regionPickerHtml(idPrefix, selected) {
  var sel = Array.isArray(selected) ? selected.slice() : [];
  var selSet = {};
  sel.forEach(function (n) { selSet[n.toLowerCase()] = true; });

  var orphans = sel.filter(function (n) { return !_regionByName.hasOwnProperty(n); });
  var orphanHtml = orphans.length
    ? '<div style="margin-bottom:0.5rem">' +
        '<div style="font-size:0.78rem;color:var(--color-text-tertiary);margin-bottom:0.25rem">Unknown region tags (no longer in the map). Click × to remove.</div>' +
        orphans.map(function (n) {
          return '<span class="badge region-chip" data-region="' + escapeHtml(n) + '" data-selected="1" style="display:inline-flex;align-items:center;gap:0.35rem;background:rgba(158,158,158,0.18);color:#9e9e9e;border:1px solid rgba(158,158,158,0.45);padding:0.2rem 0.5rem;margin:0.15rem 0.25rem 0.15rem 0">' +
            escapeHtml(n) +
            ' <button type="button" class="region-chip-remove" aria-label="Remove" style="background:none;border:none;cursor:pointer;color:inherit;padding:0;font-size:1.1em;line-height:1">&times;</button>' +
          '</span>';
        }).join("") +
      '</div>'
    : '';

  var available = _regionList.length === 0
    ? '<div style="font-size:0.85rem;color:var(--color-text-tertiary);padding:0.5rem;border:1px dashed var(--color-border);border-radius:6px">No map regions defined yet. Create regions on the Device Map first.</div>'
    : '<div class="region-pill-grid" style="display:flex;flex-wrap:wrap;gap:0.4rem">' +
        _regionList.map(function (n) {
          var hex = regionColorFor(n);
          var rgb = hexToRgbTriplet(hex);
          var isSel = selSet[n.toLowerCase()];
          var style = isSel
            ? "background:rgba(" + rgb + ",0.22);color:" + hex + ";border:1px solid rgba(" + rgb + ",0.55)"
            : "background:transparent;color:" + hex + ";border:1px solid rgba(" + rgb + ",0.45);opacity:0.75";
          return '<button type="button" class="badge region-chip" data-region="' + escapeHtml(n) + '" data-selected="' + (isSel ? "1" : "0") + '" data-color="' + escapeHtml(hex) + '" data-rgb="' + escapeHtml(rgb) + '" style="cursor:pointer;padding:0.3rem 0.7rem;font-size:0.78rem;font-weight:600;text-transform:capitalize;' + style + '">' +
            escapeHtml(n) +
          '</button>';
        }).join("") +
      '</div>';

  return '<div id="' + idPrefix + '" class="region-picker">' +
    orphanHtml +
    available +
  '</div>';
}

// Event delegation for any region picker on the page (handles dynamic create).
document.addEventListener("click", function (e) {
  var removeBtn = e.target.closest(".region-chip-remove");
  if (removeBtn) {
    var orphan = removeBtn.closest(".region-chip");
    if (orphan) orphan.remove();
    e.preventDefault();
    return;
  }
  var pill = e.target.closest(".region-picker .region-chip");
  if (!pill || pill.getAttribute("data-selected") === null) return;
  // Orphan rows have no data-color and only respond to the × button above.
  if (!pill.hasAttribute("data-color")) return;
  var isSel = pill.getAttribute("data-selected") === "1";
  var hex = pill.getAttribute("data-color");
  var rgb = pill.getAttribute("data-rgb");
  if (isSel) {
    pill.setAttribute("data-selected", "0");
    pill.style.cssText = "cursor:pointer;padding:0.3rem 0.7rem;font-size:0.78rem;font-weight:600;text-transform:capitalize;background:transparent;color:" + hex + ";border:1px solid rgba(" + rgb + ",0.45);opacity:0.75";
  } else {
    pill.setAttribute("data-selected", "1");
    pill.style.cssText = "cursor:pointer;padding:0.3rem 0.7rem;font-size:0.78rem;font-weight:600;text-transform:capitalize;background:rgba(" + rgb + ",0.22);color:" + hex + ";border:1px solid rgba(" + rgb + ",0.55)";
  }
});

function collectRegionPicker(idPrefix) {
  var picker = document.getElementById(idPrefix);
  if (!picker) return [];
  var out = [];
  picker.querySelectorAll(".region-chip[data-selected='1']").forEach(function (c) {
    out.push(c.getAttribute("data-region"));
  });
  return out;
}

// ─── Free-form "other" tag picker (chip input; no registry) ──────────────
// Parallel dimension to region tags. Operator types a tag; Enter or comma
// commits a chip; × removes it. Used in the role slide-over, the per-user
// tag modal, and the Group Mappings slide-over.

function otherTagChipHtml(t) {
  return '<span class="badge other-tag-chip" data-tag="' + escapeHtml(t) + '" style="display:inline-flex;align-items:center;gap:0.35rem;background:rgba(74,158,255,0.16);color:var(--color-primary,#4a9eff);border:1px solid rgba(74,158,255,0.4);padding:0.2rem 0.5rem;margin:0.1rem 0">' +
    escapeHtml(t) +
    ' <button type="button" class="other-tag-remove" aria-label="Remove" style="background:none;border:none;cursor:pointer;color:inherit;padding:0;font-size:1.1em;line-height:1">&times;</button>' +
  '</span>';
}

function otherTagsPickerHtml(idPrefix, selected) {
  var sel = Array.isArray(selected) ? selected.slice() : [];
  var chips = sel.map(otherTagChipHtml).join("");
  return '<div id="' + escapeHtml(idPrefix) + '" class="other-tags-picker">' +
    '<div class="other-tags-chips" style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:0.4rem">' + chips + '</div>' +
    '<input type="text" class="other-tags-input" placeholder="Type a tag, press Enter" autocomplete="off" style="width:100%">' +
  '</div>';
}

function addOtherTagChips(input) {
  var picker = input.closest(".other-tags-picker");
  if (!picker) return;
  var chipWrap = picker.querySelector(".other-tags-chips");
  var existing = {};
  picker.querySelectorAll(".other-tag-chip").forEach(function (c) {
    existing[(c.getAttribute("data-tag") || "").toLowerCase()] = true;
  });
  input.value.split(",").forEach(function (raw) {
    var t = raw.trim();
    if (!t || t.length > 64) return;
    if (existing[t.toLowerCase()]) return;
    existing[t.toLowerCase()] = true;
    chipWrap.insertAdjacentHTML("beforeend", otherTagChipHtml(t));
  });
  input.value = "";
}

function collectOtherTags(idPrefix) {
  var picker = document.getElementById(idPrefix);
  if (!picker) return [];
  var out = [];
  var seen = {};
  picker.querySelectorAll(".other-tag-chip").forEach(function (c) {
    var t = (c.getAttribute("data-tag") || "").trim();
    if (t && !seen[t.toLowerCase()]) { seen[t.toLowerCase()] = true; out.push(t); }
  });
  var input = picker.querySelector(".other-tags-input");
  if (input && input.value.trim()) {
    input.value.split(",").forEach(function (raw) {
      var t = raw.trim();
      if (t && !seen[t.toLowerCase()]) { seen[t.toLowerCase()] = true; out.push(t); }
    });
  }
  return out;
}

document.addEventListener("keydown", function (e) {
  var input = e.target.closest && e.target.closest(".other-tags-picker .other-tags-input");
  if (!input) return;
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addOtherTagChips(input);
  } else if (e.key === "Backspace" && !input.value) {
    var chips = input.parentElement.parentElement.querySelectorAll(".other-tag-chip");
    if (chips.length) chips[chips.length - 1].remove();
  }
});
document.addEventListener("blur", function (e) {
  var input = e.target.closest && e.target.closest(".other-tags-picker .other-tags-input");
  if (input && input.value.trim()) addOtherTagChips(input);
}, true);
document.addEventListener("click", function (e) {
  var rm = e.target.closest && e.target.closest(".other-tag-remove");
  if (rm) {
    var chip = rm.closest(".other-tag-chip");
    if (chip) chip.remove();
    e.preventDefault();
  }
});

