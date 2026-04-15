/**
 * public/js/users.js — User management page
 */

document.addEventListener("DOMContentLoaded", function () {
  loadUsers();
  document.getElementById("btn-add-user").addEventListener("click", openCreateModal);
});

async function loadUsers() {
  var tbody = document.getElementById("users-tbody");
  try {
    var users = await api.users.list();
    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-state">No users found.</td></tr>';
      return;
    }
    tbody.innerHTML = users.map(function (u) {
      return '<tr>' +
        '<td><strong>' + escapeHtml(u.username) + '</strong></td>' +
        '<td>' + formatDate(u.createdAt) + '</td>' +
        '<td class="actions">' +
          '<button class="btn btn-sm btn-secondary" onclick="openResetPasswordModal(\'' + u.id + '\', \'' + escapeHtml(u.username) + '\')">Reset Password</button>' +
          '<button class="btn btn-sm btn-danger" onclick="confirmDelete(\'' + u.id + '\', \'' + escapeHtml(u.username) + '\')">Delete</button>' +
        '</td></tr>';
    }).join("");
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function openCreateModal() {
  var body = '<div class="form-group"><label>Username *</label><input type="text" id="f-username" placeholder="e.g. jsmith"></div>' +
    '<div class="form-group"><label>Password *</label><input type="password" id="f-password" placeholder="Minimum 4 characters"><p class="hint">The user can change this after first login.</p></div>';
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Create User</button>';
  openModal("Add User", body, footer);

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var input = {
        username: val("f-username"),
        password: val("f-password"),
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

function openResetPasswordModal(id, username) {
  var body = '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">Set a new password for <strong>' + escapeHtml(username) + '</strong></p>' +
    '<div class="form-group"><label>New Password *</label><input type="password" id="f-password" placeholder="Minimum 4 characters"></div>';
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Reset Password</button>';
  openModal("Reset Password", body, footer);

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      await api.users.resetPassword(id, { password: val("f-password") });
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
