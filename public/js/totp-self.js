/**
 * public/js/totp-self.js — self-service TOTP (two-factor) enrollment UI.
 *
 * Extracted from users.js so the flow can be reached from the page-header
 * account menu on EVERY page. The same permission mismatch push enrollment
 * had applies here: /users.html is page-gated `users` (admin-only in the
 * built-in matrix), so a local user without it could never configure their
 * own second factor even though every route this module calls
 * (`/auth/totp/*`) is gated on nothing beyond being logged in.
 *
 * `local` accounts only — the server refuses enrollment for every other
 * authProvider ("managed by your identity provider"), so callers gate on the
 * status payload's own `authProvider` rather than guessing from the session.
 *
 * Depends on globals from api.js (api, escapeHtml, copyTextToClipboard) and
 * app.js (openModal, closeModal, showToast, val, currentUsername). Load order
 * doesn't matter: nothing here runs until a menu item is selected.
 */

(function () {
  "use strict";

  function toast(msg, kind) { if (typeof showToast === "function") showToast(msg, kind); }

  /** GET the caller's own enrollment state. */
  function status() {
    return api.totp.status();
  }

  /**
   * Route to the right modal for the current state. `opts.onChange` fires
   * after a successful enroll/disable so a caller that renders that state
   * (the Users table, the account menu's cached row) can refresh it.
   */
  async function open(opts) {
    var st;
    try { st = await status(); }
    catch (err) { toast(err.message, "error"); return; }
    if (st && st.authProvider && st.authProvider !== "local") {
      toast("Two-factor auth is managed by your identity provider for SSO accounts.", "error");
      return;
    }
    if (st && st.enabled) openDisable(opts);
    else openEnroll(opts);
  }

  async function openEnroll(opts) {
    var onChange = (opts && opts.onChange) || function () {};
    var enrollment;
    try { enrollment = await api.totp.enroll(); }
    catch (err) { toast(err.message, "error"); return; }

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
      if (!/^\d{6}$/.test(code)) { toast("Enter the 6-digit code from your authenticator app", "error"); return; }
      btn.disabled = true;
      try {
        var result = await api.totp.confirm({ code: code });
        closeModal();
        showBackupCodes(result.backupCodes);
        onChange();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  }

  function showBackupCodes(codes) {
    var listHtml = (codes || []).map(function (c) {
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
      copyTextToClipboard((codes || []).join("\n")).then(function (ok) {
        toast(ok ? "Backup codes copied" : "Copy failed — select the codes manually", ok ? "success" : "error");
      });
    });
    document.getElementById("btn-backup-done").addEventListener("click", closeModal);
  }

  function openDisable(opts) {
    var onChange = (opts && opts.onChange) || function () {};
    var who = (opts && opts.username) || (typeof currentUsername === "string" && currentUsername) || "your account";
    var body =
      '<p style="margin-bottom:1rem">Enter a current code from your authenticator app (or a backup code) to turn off two-factor authentication for <strong>' + escapeHtml(who) + '</strong>.</p>' +
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
      if (!code) { toast("Enter a code to continue", "error"); return; }
      btn.disabled = true;
      try {
        await api.totp.disable({ code: code, isBackupCode: isBackup });
        closeModal();
        toast("Two-factor auth disabled");
        onChange();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  }

  window.PolarisTotpSelf = {
    status: status,
    open: open,
    openEnroll: openEnroll,
    openDisable: openDisable,
    showBackupCodes: showBackupCodes,
  };
})();
