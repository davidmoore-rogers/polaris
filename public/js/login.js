// public/js/login.js — Login page logic (extracted from login.html inline
// script so we can drop 'unsafe-inline' from the script CSP).

// Show any error from query string (e.g. SSO errors). MUST use textContent,
// never innerHTML — the error value originates from the server redirecting
// back here with ?error=<message>, which can be influenced by an attacker
// (e.g. a crafted SAML response). textContent is XSS-safe; innerHTML is not.
(function () {
  var params = new URLSearchParams(window.location.search);
  var err = params.get("error");
  if (err) {
    var errEl = document.getElementById("login-error");
    errEl.textContent = decodeURIComponent(err);
    errEl.style.display = "block";
  }
})();

// Apply branding. The mark is either the operator's own logo or the shipped
// Polaris wordmark art for the current theme — PolarisBrandLogo owns that
// choice (and the rule that the Application Name is text only shown beside a
// custom logo, since the Polaris art already spells it out).
(async function () {
  var h2 = document.querySelector(".login-card h2");
  var subEl = document.querySelector(".login-card .subtitle");
  var logo = document.querySelector(".login-logo");

  function paint(b) {
    var r = PolarisBrandLogo.applyTo(logo, b, "login");
    h2.textContent = (b && b.appName) || "Polaris";
    h2.style.display = r.showName ? "" : "none";
    subEl.textContent = (b && b.subtitle) || "";
    subEl.style.display = r.showSubtitle ? "" : "none";
  }

  var b = await PolarisAuthFlow.fetchBranding();
  paint(b);
  if (b) {
    document.title = ((b.appName || "").trim() || "Polaris") + " — Login";
    // Favicon follows the uploaded logo only; the brand art is a wordmark that
    // is unreadable at 16px, and /logo.png (the shipped mark) is already the
    // page's declared icon.
    if (b.customLogo && b.logoUrl) {
      var fav = document.querySelector('link[rel="icon"]');
      if (fav) fav.href = b.logoUrl;
    }
  }
  // Repaint on a theme flip — the OS switching light/dark under a user who has
  // never picked a theme swaps which wordmark art is legible.
  PolarisBrandLogo.onThemeChange(function () { paint(b); });

  h2.style.visibility = "";
  subEl.style.visibility = "";
  logo.style.visibility = "";
})();

// Keep the card above the on-screen keyboard on mobile. iOS Safari leaves the
// layout viewport at full height when the keyboard opens, so the flex-centered
// card doesn't move and the password field / Sign in button end up behind the
// keyboard. window.visualViewport reports the actually-visible rect on both iOS
// Safari and Chrome Android: while it's meaningfully shorter than the layout
// viewport we pin .login-wrapper to that rect and top-align it (see the
// .kb-open rules in login.html), then scroll the active form's bottom — the
// submit button — into view.
(function () {
  var vv = window.visualViewport;
  var wrapper = document.querySelector(".login-wrapper");
  if (!vv || !wrapper) return;

  // Below this delta it's browser chrome (collapsing URL bar), not a keyboard.
  var KEYBOARD_MIN_PX = 120;
  var pending = 0;
  var lastScrolled = null;

  function apply() {
    pending = 0;
    var layoutH = Math.max(window.innerHeight, document.documentElement.clientHeight || 0);
    var open = layoutH - vv.height > KEYBOARD_MIN_PX;

    if (open) {
      wrapper.style.setProperty("--vv-height", vv.height + "px");
      wrapper.style.setProperty("--vv-offset-top", vv.offsetTop + "px");
      wrapper.classList.add("kb-open");
      var active = document.activeElement;
      var target = active && active.form ? active.form : active;
      // Only when the focused form changes (keyboard just opened, or the MFA
      // step swapped forms) — re-running this on every resize/scroll event
      // would fight the user's own scrolling.
      if (target && target !== lastScrolled && target.scrollIntoView) {
        target.scrollIntoView({ block: "end", behavior: "smooth" });
        lastScrolled = target;
      }
    } else {
      wrapper.classList.remove("kb-open");
      wrapper.style.removeProperty("--vv-height");
      wrapper.style.removeProperty("--vv-offset-top");
      lastScrolled = null;
    }
  }

  function schedule() {
    if (!pending) pending = window.requestAnimationFrame(apply);
  }

  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  window.addEventListener("orientationchange", schedule);
  // The MFA step swaps the form in-place; re-measure so the code field and
  // Verify button land above a keyboard that's already up.
  document.addEventListener("focusin", schedule);
})();

// Check SSO config and show button if enabled
(async function () {
  try {
    var cfg = await PolarisAuthFlow.fetchAzureConfig();
    if (!cfg.enabled) return;

    var btn = document.getElementById("btn-sso");
    if (cfg.brand === "microsoft") {
      btn.innerHTML = '<svg viewBox="0 0 23 23" xmlns="http://www.w3.org/2000/svg" style="width:18px;height:18px"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg> Sign in with Microsoft';
    } else if (cfg.brand === "google") {
      btn.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:18px;height:18px"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/></svg> Sign in with Google';
    } else if (cfg.brand === "okta") {
      btn.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:18px;height:18px"><path fill="#007DC1" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5z"/></svg> Sign in with Okta';
    }

    btn.style.display = "";
    document.getElementById("sso-section").style.display = "block";
  } catch (_) {}
})();

// SSO button click
document.getElementById("btn-sso").addEventListener("click", function () {
  window.location.href = "/api/v1/auth/azure/login";
});

// Check OIDC config and show its button if enabled
(async function () {
  try {
    var res = await fetch("/api/v1/auth/oidc/config");
    if (!res.ok) return;
    var cfg = await res.json();
    if (!cfg.enabled) return;
    document.getElementById("btn-oidc").style.display = "";
    document.getElementById("sso-section").style.display = "block";
  } catch (_) {}
})();
document.getElementById("btn-oidc").addEventListener("click", function () {
  window.location.href = "/api/v1/auth/oidc/login";
});

// Check Entra App Proxy config. `available` means THIS request arrived
// through the App Proxy connector carrying identity headers — internal
// users get false and never see the button. Normal App Proxy entry is the
// server-side silent auto-login on protected pages; this button is the
// fallback for the post-logout / error-redirect landing here.
(async function () {
  try {
    var res = await fetch("/api/v1/auth/entra-proxy/config");
    if (!res.ok) return;
    var cfg = await res.json();
    if (!cfg.enabled || !cfg.available) return;
    document.getElementById("btn-entra-proxy").style.display = "";
    document.getElementById("sso-section").style.display = "block";
  } catch (_) {}
})();
document.getElementById("btn-entra-proxy").addEventListener("click", function () {
  window.location.href = "/api/v1/auth/entra-proxy/login";
});

// Show "View Setup Wizard" in demo mode
(async function () {
  try {
    var res = await fetch("/api/setup/status");
    if (!res.ok) return;
    var data = await res.json();
    // Demo server returns needsSetup: false — if we got a response, setup endpoint exists
    if (data.needsSetup === false) {
      document.getElementById("demo-setup-section").style.display = "block";
    }
  } catch (_) {}
})();
document.getElementById("btn-demo-setup").addEventListener("click", function () {
  window.location.href = "/setup.html";
});

// Two-phase login state — pendingToken is set after a correct password
// when the server requires a second factor. The rest of the flow is the
// same async/await shape as before.
var _mfaPendingToken = null;

function showError(msg) {
  var errEl = document.getElementById("login-error");
  errEl.textContent = msg;
  errEl.style.display = "block";
}

function clearError() {
  document.getElementById("login-error").style.display = "none";
}

function showMfaStep() {
  document.getElementById("local-login-section").style.display = "none";
  document.getElementById("sso-section").style.display = "none";
  document.getElementById("demo-setup-section").style.display = "none";
  document.getElementById("mfa-section").style.display = "block";
  setTimeout(function () { document.getElementById("mfa-code").focus(); }, 30);
}

document.getElementById("login-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  clearError();

  var username = document.getElementById("username").value.trim();
  var password = document.getElementById("password").value;

  var r = await PolarisAuthFlow.login(username, password);
  if (!r.ok) {
    showError(r.error);
    return;
  }
  if (r.mfaRequired) {
    _mfaPendingToken = r.pendingToken;
    showMfaStep();
    return;
  }
  window.location.href = "/";
});

// Toggle between TOTP code and backup code
document.getElementById("btn-use-backup").addEventListener("click", function (e) {
  e.preventDefault();
  var input = document.getElementById("mfa-code");
  var label = document.getElementById("mfa-code-label");
  var hint  = document.getElementById("mfa-hint");
  var link  = document.getElementById("btn-use-backup");
  var usingBackup = input.dataset.mode === "backup";
  if (usingBackup) {
    input.dataset.mode = "totp";
    input.type = "text";
    input.maxLength = 6;
    input.placeholder = "123456";
    input.value = "";
    label.textContent = "Verification code";
    hint.textContent  = "Enter the 6-digit code from your authenticator app.";
    link.textContent  = "Use a backup code";
  } else {
    input.dataset.mode = "backup";
    input.type = "text";
    input.maxLength = 9;
    input.placeholder = "XXXX-XXXX";
    input.value = "";
    label.textContent = "Backup code";
    hint.textContent  = "Enter one of the backup codes you saved when enabling 2FA.";
    link.textContent  = "Use the authenticator app instead";
  }
  input.focus();
});

document.getElementById("mfa-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  clearError();

  var input = document.getElementById("mfa-code");
  var code = input.value.trim();
  var isBackupCode = input.dataset.mode === "backup";
  if (!code) return;

  var r = await PolarisAuthFlow.confirmTotp(_mfaPendingToken, code, isBackupCode);
  if (!r.ok) {
    showError(r.error);
    if (!r.network) input.select();
    return;
  }
  window.location.href = "/";
});
