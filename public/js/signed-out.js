// public/js/signed-out.js — the logout landing (/signed-out.html).
//
// Two jobs, and neither is signing anyone in: paint the operator's branding
// the way the login page does, and say WHY the session ended when the landing
// knows (`?reason=` from a CLOSED set — the value is never rendered, it only
// selects a sentence, so a crafted query string can put nothing on the page).
// The Sign in button is a plain link to the bare /login.html and needs no
// script: src/app.ts decides whether that URL means SSO ("Skip login page"
// on) or the form (off).

(function () {
  // Closed set. An unknown or absent reason falls back to the neutral line.
  var REASONS = {
    inactivity: "You were signed out after a period of inactivity.",
  };
  var DEFAULT_MSG = "You have signed out of {app}.";

  var params = new URLSearchParams(window.location.search);
  var reason = params.get("reason");
  var msgEl = document.getElementById("signed-out-msg");

  function paintMessage(appName) {
    var text = Object.prototype.hasOwnProperty.call(REASONS, reason)
      ? REASONS[reason]
      : DEFAULT_MSG.replace("{app}", appName || "Polaris");
    msgEl.textContent = text; // textContent, never innerHTML
  }

  paintMessage(null);

  // Branding — the same mark the login page paints (business rule 27:
  // PolarisBrandLogo owns which art a theme gets, and the Application Name is
  // text only beside a custom logo).
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
    paintMessage(b && b.appName);
    if (b) {
      document.title = ((b.appName || "").trim() || "Polaris") + " — Signed out";
      if (b.customLogo && b.logoUrl) PolarisBrandLogo.setFavicon(b.logoUrl);
    }
    PolarisBrandLogo.onThemeChange(function () { paint(b); });

    h2.style.visibility = "";
    subEl.style.visibility = "";
    logo.style.visibility = "";
  })();
})();
