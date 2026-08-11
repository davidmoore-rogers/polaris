/**
 * public/js/auth-flow.js — the login-flow fetch helpers shared by the desktop
 * login page (login.js) and the mobile SPA's auth screen (mobile/auth.js),
 * which previously carried drifting copies (2026-08 audit).
 *
 * Pure transport: each helper resolves a plain result object — success
 * navigation, error rendering, and button state stay with the page. Loaded
 * standalone on login.html (which deliberately does NOT load api.js) and on
 * mobile.html before the auth module.
 */

(function () {
  async function postJson(path, body) {
    try {
      var res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      var data = await res.json().catch(function () { return {}; });
      return { ok: res.ok, data: data };
    } catch (_) {
      return { ok: false, network: true, data: {} };
    }
  }

  window.PolarisAuthFlow = {
    /** POST /auth/login → { ok, mfaRequired?, pendingToken?, error?, network? } */
    login: async function (username, password) {
      var r = await postJson("/api/v1/auth/login", { username: username, password: password });
      if (r.network) return { ok: false, network: true, error: "Network error — try again" };
      if (!r.ok) return { ok: false, error: r.data.error || "Login failed" };
      return { ok: true, mfaRequired: !!r.data.mfaRequired, pendingToken: r.data.pendingToken };
    },

    /** POST /auth/login/totp → { ok, error?, network? } */
    confirmTotp: async function (pendingToken, code, isBackupCode) {
      var r = await postJson("/api/v1/auth/login/totp", {
        pendingToken: pendingToken, code: code, isBackupCode: isBackupCode,
      });
      if (r.network) return { ok: false, network: true, error: "Network error — try again" };
      if (!r.ok) return { ok: false, error: r.data.error || "Invalid code" };
      return { ok: true };
    },

    /** GET /server-settings/branding → branding object, or null (best-effort).
     *  Mirrors the payload into the same localStorage key applyBranding uses and
     *  hands the hardware-sensor display unit to the converter — the mobile SPA
     *  and the login screen have no applyBranding, so without this a phone that
     *  never opens the desktop UI would render Celsius whatever the install set. */
    fetchBranding: async function () {
      try {
        var res = await fetch("/api/v1/server-settings/branding");
        if (!res.ok) return null;
        var b = await res.json();
        try { localStorage.setItem("polaris-branding", JSON.stringify(b)); } catch (_) {}
        if (window.PolarisTempUnit) window.PolarisTempUnit.setFromBranding(b);
        return b;
      } catch (_) {
        return null;
      }
    },

    /** GET /auth/azure/config → config object ({ enabled: false } on any failure). */
    fetchAzureConfig: async function () {
      try {
        var res = await fetch("/api/v1/auth/azure/config");
        return res.ok ? await res.json() : { enabled: false };
      } catch (_) {
        return { enabled: false };
      }
    },
  };
})();
