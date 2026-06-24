/**
 * widgets/capacityHealth.js — overall capacity severity pill + top reasons.
 * Permission-gated on serverSettingsSystem:read since the underlying
 * endpoint (/server-settings/pg-tuning) is admin-only and leaks fleet-shape
 * data anyone without that permission shouldn't see.
 */

(function () {
  var SEVERITY_PILL = { ok: "widget-pill-ok", watch: "widget-pill-watch", amber: "widget-pill-amber", red: "widget-pill-red" };

  function renderInstance(el, payload) {
    var capacity = payload && payload.capacity;
    if (!capacity) { el.innerHTML = '<p class="empty-state">Capacity data unavailable</p>'; return; }
    var sev = capacity.severity || "ok";
    var pillCls = SEVERITY_PILL[sev] || "widget-pill-watch";
    var reasons = (capacity.reasons || []).slice(0, 5);
    var reasonsHtml = reasons.length
      ? '<ul style="list-style:none;padding:0;margin:8px 0 0;display:flex;flex-direction:column;gap:6px">' +
          reasons.map(function (r) {
            var rpill = SEVERITY_PILL[r.severity] || "widget-pill-watch";
            return '<li style="display:flex;gap:6px;align-items:flex-start">' +
              '<span class="widget-pill ' + rpill + '" style="flex-shrink:0">' + escapeHtml(r.severity) + '</span>' +
              '<span style="font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(r.message || r.code || "") + '</span>' +
            '</li>';
          }).join("") +
        '</ul>'
      : '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin:8px 0 0">No issues — everything within healthy thresholds.</p>';
    el.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<span class="widget-pill ' + pillCls + '">' + escapeHtml(sev.toUpperCase()) + '</span>' +
        '<a href="/server-settings.html#tab=maintenance" style="font-size:0.8rem;color:var(--color-text-secondary)">Open Maintenance →</a>' +
      '</div>' + reasonsHtml;
  }

  PolarisWidgets.register({
    type: "capacityHealth",
    category: "IP Space",
    label: "Capacity health",
    description: "Overall capacity severity pill + the top reasons driving it. Admin-only.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: {},
    requiredPermission: { key: "serverSettingsSystem", level: "read" },

    fetchData: function () {
      return api.serverSettings.getPgTuning().catch(function () { return null; });
    },

    renderInstance: function (el, _config, data) {
      renderInstance(el, data);
    },

    renderPreview: function (el) {
      renderInstance(el, {
        capacity: {
          severity: "amber",
          reasons: [
            { severity: "amber", message: "DB volume below 20% free" },
            { severity: "watch", message: "Prisma pool nearing capacity" },
          ],
        },
      });
    },
  });
})();
