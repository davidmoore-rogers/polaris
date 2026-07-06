/**
 * public/js/dash-mode.js — Dash wallboard page flags.
 *
 * MUST be the first script on dash.html (before api.js): the CSP forbids
 * inline <script> blocks, so these page-mode flags live in this tiny external
 * file instead of an inline snippet.
 *
 *   - POLARIS_DASH_LOCAL: dashboard.js persists layout to localStorage
 *     instead of /me/dashboard, and widget click-throughs that would bounce
 *     an anonymous viewer to the login page become no-ops.
 *   - __polarisApiBase: api.js routes every request to the Dash listener's
 *     own IP-gated API at /dash/api/v1 instead of the authenticated API.
 *   - __polarisOn401: never redirect to /login.html — a wallboard must not
 *     navigate away if a response ever comes back 401.
 */

window.POLARIS_DASH_LOCAL = true;
window.__polarisApiBase = "/dash/api/v1";
window.__polarisOn401 = function () { return null; };
