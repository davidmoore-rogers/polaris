// appmap-discovery.js — the Application Map's "Discovery" entry point: a list of
// named MAP RULES, each of which pins process/service items onto the assets its
// scope selects (now, and on assets discovered later via the
// reconcileAppMapAutoMap job).
//
// This file owns the LIST; the builder lives in appmap-rules-wizard.js. Same split
// as automations.js / automations-wizard.js.
//
// Why rules instead of one fleet-wide picker: a single selection could only say
// "every asset that reports this program", which over-pins — mapping
// truckscale.service for the three truckscale hosts also hit every other host
// running it. Each rule carries its own asset scope, so the same unit can be
// mapped in one part of the fleet and left alone elsewhere.
//
// Asymmetry worth knowing while reading this: removing an item from a rule, or
// disabling/deleting the rule, stops FUTURE auto-pinning — it does not
// retroactively unpin, because Asset.mappedProcesses/mappedServices are
// operator-owned and someone may have pinned a name by hand. "Unmap everywhere" is
// the separate, confirmation-gated strip.
//
// openModal reuses ONE overlay, so the wizard REPLACES this list on the way in and
// reopens it on cancel/save (see openAppMapRuleWizard).

/* global openModal, closeModal, showToast, showConfirm, escapeHtml, permAtLeast, api,
   openAppMapRuleWizard */

(function () {
  "use strict";

  var rules = [];

  function canWrite() {
    return typeof permAtLeast === "function" &&
      permAtLeast("applicationMap", "write") && permAtLeast("assets", "write");
  }

  function scopeSummary(r) {
    if (!r.scope || !(r.scope.rules || []).length) return "All monitored assets";
    var n = r.scope.rules.length;
    var first = r.scope.rules[0];
    var label = first.field === "subnet"
      ? "IP in " + (first.cidrs || []).join(", ")
      : first.field + " " + first.op + " " + (first.values || []).join(", ");
    return n === 1 ? label : label + " +" + (n - 1) + " more";
  }

  function itemSummary(r) {
    var svc = (r.services && r.services.names) || [];
    var proc = (r.processes && r.processes.names) || [];
    var pat = ((r.services && r.services.patterns) || []).length +
              ((r.processes && r.processes.patterns) || []).length;
    var parts = [];
    if (svc.length) parts.push(svc.length + " service" + (svc.length === 1 ? "" : "s"));
    if (proc.length) parts.push(proc.length + " process" + (proc.length === 1 ? "" : "es"));
    if (pat) parts.push(pat + " pattern" + (pat === 1 ? "" : "s"));
    return parts.length ? parts.join(" · ") : "—";
  }

  function bodyHTML() {
    return '' +
      '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.85rem">' +
        'Map rules pin processes and services onto the devices you choose — on the devices that ' +
        'match today, <strong>and on devices discovered later</strong>. Removing an item or ' +
        "disabling a rule stops future auto-pinning; it doesn't unpin what's already there " +
        '(use <em>Unmap everywhere</em> for that).' +
      '</p>' +
      '<div style="display:flex;justify-content:flex-end;margin-bottom:0.6rem">' +
        (canWrite() ? '<button type="button" class="btn btn-primary btn-sm" id="apd-add">+ Add rule</button>' : "") +
      '</div>' +
      '<div class="table-wrapper table-wrapper-modal-sticky" style="max-height:46vh">' +
        '<table class="data-table" style="margin:0">' +
          '<thead><tr>' +
            '<th style="width:4rem">On</th>' +
            '<th>Rule</th>' +
            '<th>Devices</th>' +
            '<th>Items</th>' +
            '<th style="width:8rem"></th>' +
          '</tr></thead>' +
          '<tbody id="apd-tbody"><tr><td colspan="5" class="empty-state">Loading…</td></tr></tbody>' +
        '</table>' +
      '</div>';
  }

  function renderRows() {
    var tbody = document.getElementById("apd-tbody");
    if (!tbody) return;
    if (!rules.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">' +
        (canWrite()
          ? "No map rules yet. Add one to choose which devices get which processes and services mapped."
          : "No map rules configured.") +
        "</td></tr>";
      return;
    }
    var dis = canWrite() ? "" : " disabled";
    tbody.innerHTML = rules.map(function (r) {
      return "<tr>" +
        '<td><label class="toggle-switch" title="' +
          (r.enabled ? "Enabled — stops pinning new items when turned off" : "Disabled") + '">' +
          '<input type="checkbox" class="apd-toggle" data-id="' + escapeHtml(r.id) + '"' +
            (r.enabled ? " checked" : "") + dis + ">" +
          '<span class="toggle-slider"></span></label></td>' +
        '<td><a href="#" class="apd-edit-link" data-id="' + escapeHtml(r.id) + '">' + escapeHtml(r.name) + "</a></td>" +
        "<td>" + escapeHtml(scopeSummary(r)) + "</td>" +
        "<td>" + escapeHtml(itemSummary(r)) + "</td>" +
        '<td style="white-space:nowrap">' +
          '<button type="button" class="btn btn-secondary btn-sm apd-edit" data-id="' + escapeHtml(r.id) + '"' + dis + ">Edit</button> " +
          '<button type="button" class="btn btn-secondary btn-sm apd-delete" data-id="' + escapeHtml(r.id) + '"' + dis + ">Delete</button>" +
        "</td>" +
      "</tr>";
    }).join("");
  }

  // Every write PUTs the whole rule set — the endpoint validates and applies the
  // complete config (cross-rule name/id uniqueness can't be checked per-rule), and
  // applying is what makes pins land immediately instead of waiting for the tick.
  async function persist(nextRules, successMsg) {
    var res = await api.applicationMap.saveDiscovery(nextRules);
    rules = res.rules || [];
    var a = res.applied || {};
    showToast(
      a.devices
        ? successMsg + " — pinned " + ((a.processPins || 0) + (a.servicePins || 0)) + " item(s) on " + a.devices + " device(s)"
        : successMsg,
      "success",
    );
    // The map itself changed, so reflect it without making the operator refresh.
    if (typeof window.appMapReload === "function") window.appMapReload();
    return res;
  }

  // Called by the wizard on save. Upsert by id so Edit replaces in place.
  window.appMapRulesSaveOne = async function appMapRulesSaveOne(rule) {
    var next = rules.slice();
    var idx = rule.id ? next.findIndex(function (r) { return r.id === rule.id; }) : -1;
    if (idx >= 0) next[idx] = rule; else next.push(rule);
    await persist(next, idx >= 0 ? "Rule updated" : "Rule created");
  };

  function wire() {
    var add = document.getElementById("apd-add");
    if (add) {
      add.addEventListener("click", function () {
        if (typeof openAppMapRuleWizard === "function") openAppMapRuleWizard(null);
      });
    }
    var tbody = document.getElementById("apd-tbody");
    if (!tbody) return;

    tbody.addEventListener("click", async function (ev) {
      var editEl = ev.target.closest ? ev.target.closest(".apd-edit, .apd-edit-link") : null;
      if (editEl) {
        ev.preventDefault();
        var id = editEl.getAttribute("data-id");
        var hit = rules.filter(function (r) { return r.id === id; })[0];
        if (hit && typeof openAppMapRuleWizard === "function") openAppMapRuleWizard(hit);
        return;
      }
      var del = ev.target.closest ? ev.target.closest(".apd-delete") : null;
      if (del) {
        var did = del.getAttribute("data-id");
        var row = rules.filter(function (r) { return r.id === did; })[0];
        if (!row) return;
        var ok = await showConfirm(
          'Delete the map rule "' + row.name + '"? Devices it already pinned keep their pins — ' +
          "deleting only stops future auto-pinning.",
        );
        if (!ok) return;
        del.disabled = true;
        try {
          await persist(rules.filter(function (r) { return r.id !== did; }), "Rule deleted");
          renderRows();
        } catch (err) {
          showToast("Delete failed: " + (err && err.message ? err.message : String(err)), "error");
          del.disabled = false;
        }
      }
    });

    tbody.addEventListener("change", async function (ev) {
      var cb = ev.target.closest ? ev.target.closest(".apd-toggle") : null;
      if (!cb) return;
      var id = cb.getAttribute("data-id");
      var next = rules.map(function (r) {
        return r.id === id ? Object.assign({}, r, { enabled: cb.checked }) : r;
      });
      try {
        await persist(next, cb.checked ? "Rule enabled" : "Rule disabled");
        renderRows();
      } catch (err) {
        showToast("Update failed: " + (err && err.message ? err.message : String(err)), "error");
        cb.checked = !cb.checked; // revert the optimistic flip
      }
    });
  }

  async function reload() {
    var cfg = await api.applicationMap.discovery();
    rules = (cfg && cfg.rules) || [];
    renderRows();
  }

  // Named separately from the button handler so the wizard can return here.
  window.openAppMapRulesList = async function openAppMapRulesList() {
    openModal(
      // Titled to tie back to the toolbar button the operator clicked.
      "Discovery — map rules",
      bodyHTML(),
      '<button type="button" class="btn btn-secondary" id="apd-close">Close</button>',
      { large: true },
    );
    var close = document.getElementById("apd-close");
    if (close) close.addEventListener("click", closeModal);
    wire();
    try {
      await reload();
    } catch (err) {
      var tbody = document.getElementById("apd-tbody");
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load: ' +
          escapeHtml(err && err.message ? err.message : String(err)) + "</td></tr>";
      }
    }
  };

  // Kept as the toolbar button's entry point so appmap.js doesn't need to change.
  window.openAppMapDiscovery = window.openAppMapRulesList;
})();
