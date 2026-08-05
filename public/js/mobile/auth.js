// public/js/mobile/auth.js — Login and TOTP screens for the mobile app.
//
// Wires up the same two-phase auth flow as the desktop login.html:
//   POST /api/v1/auth/login
//     → { ok, user }                 → session set, navigate home
//     → { mfaRequired, pendingToken } → render TOTP step
//   POST /api/v1/auth/login/totp     → { ok, user } → home
//
// Renders directly into the .app container; doesn't touch the navbar or
// top app bar (those are app.js's responsibility once authenticated).

(function () {
  var pendingToken = null;
  var ssoConfig = null;

  // Microsoft 4-square logo, used when SSO is configured for Azure/Entra.
  var MS_LOGO_SVG = '<svg viewBox="0 0 23 23" xmlns="http://www.w3.org/2000/svg" style="width:18px;height:18px"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg>';

  async function loadSsoConfig() {
    if (ssoConfig !== null) return ssoConfig;
    ssoConfig = await PolarisAuthFlow.fetchAzureConfig();
    return ssoConfig;
  }

  function renderLogin(app) {
    app.dataset.tab = "";
    app.innerHTML = ''
      + '<div class="app-body">'
      + '  <div class="login-shell">'
      + '    <img class="brand-logo" id="brand-logo" src="/logo.png" alt="">'
      + '    <h2 id="brand-name">Polaris</h2>'
      + '    <div class="sub" id="brand-sub">IP management, navigated</div>'

      + '    <div id="login-error" class="hidden" style="width:100%;background:var(--md-error-container);color:var(--md-on-error-container);border-radius:var(--shape-xs);padding:10px 14px;font-size:13px;margin-bottom:12px;letter-spacing:.25px;"></div>'

      + '    <form id="login-form" style="width:100%;">'
      + '      <div class="full-field">'
      + '        <div class="tf-outlined"><span class="lbl">Username</span>'
      + '          <input class="field" type="text" id="username" autocomplete="username" required autofocus>'
      + '        </div>'
      + '      </div>'
      + '      <div class="full-field">'
      + '        <div class="tf-outlined"><span class="lbl">Password</span>'
      + '          <input class="field" type="password" id="password" autocomplete="current-password" required>'
      + '        </div>'
      + '      </div>'
      + '      <button type="submit" class="btn btn-filled btn-block" style="height:48px;">Sign in</button>'
      + '    </form>'

      + '    <div id="sso-section" class="hidden" style="width:100%;">'
      + '      <div class="divider">or</div>'
      + '      <button id="sso-btn" class="btn btn-tonal btn-block" style="height:48px;"></button>'
      + '    </div>'
      + '  </div>'
      + '</div>';

    // Pull branding (logo + app name) — best-effort.
    PolarisAuthFlow.fetchBranding().then(function (b) {
      if (!b) return;
      if (b.appName) {
        document.getElementById("brand-name").textContent = b.appName;
        document.title = b.appName;
      }
      if (b.subtitle) document.getElementById("brand-sub").textContent = b.subtitle;
      if (b.logoUrl) {
        var logo = document.getElementById("brand-logo");
        if (logo) logo.src = b.logoUrl;
        var fav = document.querySelector('link[rel="icon"]');
        if (fav) fav.href = b.logoUrl;
      }
    }).catch(function () {});

    // SSO button (Microsoft only for now — matches desktop scope).
    loadSsoConfig().then(function (cfg) {
      if (!cfg || !cfg.enabled) return;
      var sec = document.getElementById("sso-section");
      var btn = document.getElementById("sso-btn");
      var brand = cfg.brand || "microsoft";
      btn.innerHTML = MS_LOGO_SVG
        + '<span style="margin-left:8px;">Continue with '
        + (brand === "microsoft" ? "Microsoft"
          : brand === "google"   ? "Google"
          : brand === "okta"     ? "Okta" : "SSO")
        + '</span>';
      sec.classList.remove("hidden");
      btn.addEventListener("click", function () {
        window.location.href = "/api/v1/auth/azure/login";
      });
    });

    document.getElementById("login-form").addEventListener("submit", onLoginSubmit);
  }

  function renderTotp(app) {
    app.dataset.tab = "";
    app.innerHTML = ''
      + '<div class="app-body">'
      + '  <div class="login-shell">'
      + '    <div class="logo-mark"><svg viewBox="0 0 24 24"><use href="#i-shield"/></svg></div>'
      + '    <h2>Verification</h2>'
      + '    <div class="sub" id="totp-sub">Enter the 6-digit code from your authenticator app.</div>'

      + '    <div id="login-error" class="hidden" style="width:100%;background:var(--md-error-container);color:var(--md-on-error-container);border-radius:var(--shape-xs);padding:10px 14px;font-size:13px;margin-bottom:12px;letter-spacing:.25px;"></div>'

      + '    <form id="totp-form" style="width:100%;">'
      + '      <div class="full-field">'
      + '        <div class="tf-outlined"><span class="lbl" id="totp-label">Code</span>'
      + '          <input class="field mono" type="text" id="totp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" required autofocus>'
      + '        </div>'
      + '      </div>'
      + '      <button type="submit" class="btn btn-filled btn-block" style="height:48px;">Verify</button>'
      + '      <button type="button" id="totp-toggle" class="btn btn-text btn-block" style="height:40px; margin-top:8px;">Use a backup code</button>'
      + '      <button type="button" id="totp-cancel" class="btn btn-text btn-block" style="height:40px; color:var(--md-on-surface-variant);">Cancel</button>'
      + '    </form>'
      + '  </div>'
      + '</div>';

    var input = document.getElementById("totp-code");
    var label = document.getElementById("totp-label");
    var sub   = document.getElementById("totp-sub");
    var toggle = document.getElementById("totp-toggle");
    input.dataset.mode = "totp";

    toggle.addEventListener("click", function () {
      var backup = input.dataset.mode === "backup";
      if (backup) {
        input.dataset.mode = "totp";
        input.type = "text"; input.maxLength = 6; input.placeholder = "123456"; input.value = "";
        label.textContent = "Code";
        sub.textContent = "Enter the 6-digit code from your authenticator app.";
        toggle.textContent = "Use a backup code";
      } else {
        input.dataset.mode = "backup";
        input.type = "text"; input.maxLength = 9; input.placeholder = "XXXX-XXXX"; input.value = "";
        label.textContent = "Backup code";
        sub.textContent = "Enter one of the backup codes you saved when enabling 2FA.";
        toggle.textContent = "Use the authenticator app instead";
      }
      input.focus();
    });

    document.getElementById("totp-cancel").addEventListener("click", function () {
      pendingToken = null;
      renderLogin(app);
    });

    document.getElementById("totp-form").addEventListener("submit", onTotpSubmit);
  }

  function showError(msg) {
    var el = document.getElementById("login-error");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  function clearError() {
    var el = document.getElementById("login-error");
    if (el) el.classList.add("hidden");
  }

  async function onLoginSubmit(e) {
    e.preventDefault();
    clearError();
    var username = document.getElementById("username").value.trim();
    var password = document.getElementById("password").value;
    var btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    var r = await PolarisAuthFlow.login(username, password);
    if (!r.ok) { showError(r.error); btn.disabled = false; return; }
    if (r.mfaRequired) {
      pendingToken = r.pendingToken;
      renderTotp(document.getElementById("app"));
      return;
    }
    // Success — re-bootstrap with the new session.
    window.PolarisMobile.boot();
  }

  async function onTotpSubmit(e) {
    e.preventDefault();
    clearError();
    var input = document.getElementById("totp-code");
    var code = input.value.trim();
    if (!code) return;
    var isBackupCode = input.dataset.mode === "backup";
    var btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    var r = await PolarisAuthFlow.confirmTotp(pendingToken, code, isBackupCode);
    if (!r.ok) {
      showError(r.error);
      if (!r.network) input.select();
      btn.disabled = false;
      return;
    }
    pendingToken = null;
    window.PolarisMobile.boot();
  }

  window.PolarisAuth = {
    renderLogin: renderLogin,
  };
})();
