/**
 * public/js/dash-boot.js — slim app.js replacement for the Dash wallboard.
 *
 * dash.html loads this INSTEAD of app.js. The full app.js drags in the
 * sidebar nav (links to session-gated pages), logout, global search, and
 * several polling loops against endpoints the Dash listener doesn't mount.
 * This file provides exactly the globals the dashboard stack consumes
 * (dashboard.js, widgets/*, favorites.js, widget-library.js), each mirroring
 * its app.js original — keep behavior in lockstep when editing either side:
 *
 *   theme init                → app.js top-of-file IIFE
 *   currentUsername/role/perm → app.js fetchCurrentUser()
 *   userReady promise         → app.js
 *   permLevel/permAtLeast     → app.js
 *   isAdmin                   → app.js (always false here — no welcome modal)
 *   showToast                 → app.js (simplified: no copy button)
 *   timeAgo                   → app.js
 */

// ─── Theme (same key as the main app, so the wallboard follows the browser's
//     last-chosen Polaris theme) ─────────────────────────────────────────────
(function () {
  var saved = localStorage.getItem("polaris-theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
})();

// ─── Identity globals (populated from the Dash listener's synthetic
//     /auth/me, which answers as the built-in readonly role) ────────────────
var currentUserRole = null;
var currentRolePermissions = {};
var currentEffectiveRegions = [];
var currentUsername = null;
var _userReadyResolve = null;
var userReady = new Promise(function (resolve) { _userReadyResolve = resolve; });

async function fetchCurrentUser() {
  try {
    var base = window.__polarisApiBase || "/api/v1";
    var data = await fetch(base + "/auth/me").then(function (r) { return r.json(); });
    if (data.authenticated) {
      currentUserRole = (data.role && data.role.name) || null;
      currentRolePermissions = (data.role && data.role.permissions) || {};
      currentUsername = data.username;
      currentEffectiveRegions = (data.regionTags && data.regionTags.effective) || [];
    }
  } catch (_) {}
  if (_userReadyResolve) { _userReadyResolve(); _userReadyResolve = null; }
  return currentUserRole;
}

var _PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };
function permLevel(key) { return currentRolePermissions[key] || "none"; }
function permAtLeast(key, level) {
  return (_PERM_RANK[permLevel(key)] || 0) >= (_PERM_RANK[level] || 0);
}
function isAdmin() { return false; }

// ─── Toasts (simplified copy of app.js showToast) ───────────────────────────
function getToastContainer() {
  var c = document.querySelector(".toast-container");
  if (!c) {
    c = document.createElement("div");
    c.className = "toast-container";
    document.body.appendChild(c);
  }
  return c;
}

function showToast(message, type) {
  type = type || "success";
  var el = document.createElement("div");
  el.className = "toast toast-" + type;
  var text = document.createElement("span");
  text.textContent = message;
  el.appendChild(text);
  getToastContainer().appendChild(el);
  setTimeout(function () { el.remove(); }, 6000);
}

// ─── Helpers (copies of app.js originals) ───────────────────────────────────
function timeAgo(dateStr) {
  var diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 0) return "just now";
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

// ─── Branding (title, header text, and favicon follow the operator's
//     branding — favicon swap mirrors applyBranding in app.js) ───────────────
async function applyDashBranding() {
  try {
    var b = await api.serverSettings.getBranding();
    var name = (b && b.appName) || "Polaris";
    document.title = name + " — Dash";
    var h = document.getElementById("dash-title");
    if (h) h.textContent = name + " Dashboard";
    var favicon = document.querySelector('link[rel="icon"]');
    if (favicon && b && b.logoUrl) favicon.href = b.logoUrl;
  } catch (_) {}
}

fetchCurrentUser();
document.addEventListener("DOMContentLoaded", applyDashBranding);
