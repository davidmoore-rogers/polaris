// appmap-discovery.js — the Application Map's "Discovery" modal.
//
// Shows every process program and service unit the agents have reported across
// the fleet, aggregated with a per-name device count, and lets the operator tick
// the ones that belong on the map. Ticks are saved as a persistent SELECTION
// (Setting "appMapAutoMap") rather than applied once: the server pins them on
// every matching asset now, and the reconcileAppMapAutoMap job re-applies them to
// assets discovered later. That's the whole point — pinning used to be one
// Services-tab checkbox per host, which a newly-built host silently missed.
//
// Two asymmetries worth knowing while reading this:
//   - Un-ticking a row stops FUTURE auto-pinning; it does not retroactively
//     unpin, because those arrays are operator-owned and someone may have pinned
//     a name by hand. "Unmap everywhere" is the separate, explicit strip.
//   - Ticks are the `names` list. Patterns and the optional asset scope are also
//     part of the stored selection but are not (yet) surfaced here; the modal
//     round-trips whatever the server sent so it can't silently drop them.
//
// Loaded after appmap.js; both are IIFEs. Exposes openAppMapDiscovery() on window.

(function () {
  "use strict";

  var data = null;         // { processes, services, selection }
  var picked = {           // name -> true, per kind. The editable state.
    process: {},
    service: {},
  };
  var previewTimer = null;
  var searchQuery = "";
  var kindFilter = "all";  // all | process | service
  var onlySelected = false;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function canWrite() {
    return typeof permAtLeast === "function" &&
      permAtLeast("applicationMap", "write") && permAtLeast("assets", "write");
  }

  // ─── Row model ─────────────────────────────────────────────────────

  function allRows() {
    var out = [];
    (data.processes || []).forEach(function (r) {
      out.push({ kind: "process", name: r.name, deviceCount: r.deviceCount, mappedCount: r.mappedCount, sub: "" });
    });
    (data.services || []).forEach(function (r) {
      out.push({
        kind: "service", name: r.name, deviceCount: r.deviceCount, mappedCount: r.mappedCount,
        sub: [r.displayName, r.platform].filter(Boolean).join(" · "),
      });
    });
    return out;
  }

  function visibleRows() {
    var q = searchQuery.trim().toLowerCase();
    return allRows().filter(function (r) {
      if (kindFilter !== "all" && r.kind !== kindFilter) return false;
      if (onlySelected && !picked[r.kind][r.name]) return false;
      if (!q) return true;
      return r.name.toLowerCase().indexOf(q) >= 0 || (r.sub || "").toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) {
      // Most-deployed first — that's the useful end of a long tail of
      // one-host-only programs.
      if (b.deviceCount !== a.deviceCount) return b.deviceCount - a.deviceCount;
      return a.name.localeCompare(b.name);
    });
  }

  function pickedCount() {
    return Object.keys(picked.process).length + Object.keys(picked.service).length;
  }

  // ─── Render ────────────────────────────────────────────────────────

  function bodyHTML() {
    return '' +
      '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
        'Everything the Polaris Agents have reported across the fleet. Tick what belongs on the ' +
        'Application Map — Polaris pins it on every matching device now, <strong>and on devices ' +
        'discovered later</strong>. Un-ticking stops future auto-pinning; it doesn\'t unpin what\'s ' +
        'already there (use <em>Unmap everywhere</em> for that).' +
      '</p>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:0.6rem">' +
        '<input type="search" id="apd-search" class="input" placeholder="Search programs / units…" ' +
               'style="flex:1 1 220px;min-width:160px" autocomplete="off" spellcheck="false">' +
        '<select id="apd-kind" class="input" style="width:auto">' +
          '<option value="all">All types</option>' +
          '<option value="service">Services only</option>' +
          '<option value="process">Processes only</option>' +
        '</select>' +
        '<label class="appmap-check"><input type="checkbox" id="apd-only-selected"> Selected only</label>' +
      '</div>' +
      '<div id="apd-table-wrap" style="max-height:46vh;overflow-y:auto;border:1px solid var(--color-border);border-radius:var(--radius-md)">' +
        '<table class="data-table" id="apd-table" style="margin:0">' +
          '<thead><tr>' +
            '<th style="width:2.5rem"></th>' +
            '<th>Name</th>' +
            '<th style="width:6rem">Type</th>' +
            '<th style="width:6rem">Devices</th>' +
            '<th style="width:7rem">Mapped</th>' +
            '<th style="width:9rem"></th>' +
          '</tr></thead>' +
          '<tbody id="apd-tbody"></tbody>' +
        '</table>' +
      '</div>' +
      '<div id="apd-preview" class="hint" style="margin-top:0.6rem;font-size:0.8rem">' +
        'Tick something to preview what would be pinned.' +
      '</div>';
  }

  function renderRows() {
    var tbody = document.getElementById("apd-tbody");
    if (!tbody) return;
    var rows = visibleRows();
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">' +
        (allRows().length
          ? "Nothing matches this search."
          : "No processes or services reported yet. They appear once a Polaris Agent reports a host’s inventory.") +
        '</td></tr>';
      return;
    }
    var disabled = canWrite() ? "" : " disabled";
    tbody.innerHTML = rows.map(function (r) {
      var checked = picked[r.kind][r.name] ? " checked" : "";
      var nm = esc(r.name);
      return '<tr>' +
        '<td><input type="checkbox" class="apd-pick" data-kind="' + r.kind + '" data-name="' + nm + '"' + checked + disabled + '></td>' +
        '<td>' + nm + (r.sub ? '<div style="font-size:0.72rem;color:var(--color-text-tertiary)">' + esc(r.sub) + '</div>' : "") + '</td>' +
        '<td>' + (r.kind === "service" ? "Service" : "Process") + '</td>' +
        '<td>' + r.deviceCount + '</td>' +
        '<td>' + (r.mappedCount ? r.mappedCount + " host(s)" : "—") + '</td>' +
        '<td>' + (r.mappedCount
          ? '<button type="button" class="btn btn-secondary btn-sm apd-unmap" data-kind="' + r.kind +
            '" data-name="' + nm + '"' + disabled + '>Unmap everywhere</button>'
          : "") + '</td>' +
      '</tr>';
    }).join("");
  }

  // ─── Preview (debounced, mirrors the maintenance builder) ──────────

  function selectionFromPicked() {
    // Round-trip patterns + scope untouched: the modal doesn't surface them, so
    // saving must not be how an operator loses them.
    var stored = (data && data.selection) || {};
    var sp = stored.processes || {};
    var ss = stored.services || {};
    return {
      version: 1,
      processes: { names: Object.keys(picked.process), patterns: sp.patterns || [], regex: !!sp.regex },
      services:  { names: Object.keys(picked.service), patterns: ss.patterns || [], regex: !!ss.regex },
      scope: stored.scope || null,
    };
  }

  function refreshPreview() {
    var el = document.getElementById("apd-preview");
    if (!el) return;
    var sel = selectionFromPicked();
    var nothing = !sel.processes.names.length && !sel.services.names.length &&
      !sel.processes.patterns.length && !sel.services.patterns.length;
    if (nothing) {
      el.textContent = "Tick something to preview what would be pinned.";
      return;
    }
    el.textContent = "Checking…";
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(async function () {
      try {
        var res = await api.applicationMap.previewDiscovery(sel);
        if (!res.deviceCount) {
          el.innerHTML = "<em>Nothing new to pin — every matching device already has these.</em>";
          return;
        }
        var names = (res.sampleDevices || []).map(function (d) { return d.hostname || d.assetId; });
        el.innerHTML =
          "Would add <strong>" + res.processPins + "</strong> process pin(s) and <strong>" +
          res.servicePins + "</strong> service pin(s) across <strong>" + res.deviceCount +
          "</strong> device(s)" +
          (names.length ? ": " + esc(names.join(", ")) + (res.deviceCount > names.length ? ", …" : "") : "") + ".";
      } catch (err) {
        el.textContent = "Preview failed: " + (err && err.message ? err.message : String(err));
      }
    }, 450);
  }

  // ─── Wiring ────────────────────────────────────────────────────────

  function wire() {
    var search = document.getElementById("apd-search");
    var reRender = (typeof debounce === "function") ? debounce(renderRows, 200) : renderRows;
    if (search) {
      search.addEventListener("input", function () { searchQuery = search.value; reRender(); });
    }
    var kind = document.getElementById("apd-kind");
    if (kind) kind.addEventListener("change", function () { kindFilter = kind.value; renderRows(); });
    var only = document.getElementById("apd-only-selected");
    if (only) only.addEventListener("change", function () { onlySelected = only.checked; renderRows(); });

    var tbody = document.getElementById("apd-tbody");
    if (tbody) {
      tbody.addEventListener("change", function (ev) {
        var box = ev.target.closest ? ev.target.closest(".apd-pick") : null;
        if (!box) return;
        var k = box.getAttribute("data-kind");
        var n = box.getAttribute("data-name");
        if (box.checked) picked[k][n] = true; else delete picked[k][n];
        refreshPreview();
        syncFooter();
      });
      tbody.addEventListener("click", async function (ev) {
        var btn = ev.target.closest ? ev.target.closest(".apd-unmap") : null;
        if (!btn) return;
        var k = btn.getAttribute("data-kind");
        var n = btn.getAttribute("data-name");
        var ok = await showConfirm(
          'Remove "' + n + '" from every device\'s Application Map pins and delete its collected ' +
          'connection rows? This also takes it out of the saved selection so it won\'t be re-pinned.',
        );
        if (!ok) return;
        btn.disabled = true;
        try {
          var res = await api.applicationMap.unmapEverywhere(k, n);
          showToast("Un-mapped " + n + " from " + res.devices + " device(s)", "success");
          delete picked[k][n];
          await reload();
        } catch (err) {
          showToast("Un-map failed: " + (err && err.message ? err.message : String(err)), "error");
          btn.disabled = false;
        }
      });
    }
  }

  function syncFooter() {
    var save = document.getElementById("apd-save");
    if (!save) return;
    var n = pickedCount();
    save.textContent = n ? "Save selection (" + n + ")" : "Save selection";
  }

  async function reload() {
    data = await api.applicationMap.discovery();
    var sel = data.selection || {};
    picked = { process: {}, service: {} };
    ((sel.processes && sel.processes.names) || []).forEach(function (n) { picked.process[n] = true; });
    ((sel.services  && sel.services.names)  || []).forEach(function (n) { picked.service[n] = true; });
    renderRows();
    refreshPreview();
    syncFooter();
  }

  async function save() {
    var btn = document.getElementById("apd-save");
    if (btn) btn.disabled = true;
    try {
      var res = await api.applicationMap.saveDiscovery(selectionFromPicked());
      var a = res.applied || {};
      showToast(
        a.devices
          ? "Saved — pinned " + ((a.processPins || 0) + (a.servicePins || 0)) + " item(s) on " + a.devices + " device(s)"
          : "Saved — nothing new to pin right now",
        "success",
      );
      closeModal();
      // The map itself changes as a result, so reflect it without a manual refresh.
      if (typeof window.appMapReload === "function") window.appMapReload();
    } catch (err) {
      showToast("Save failed: " + (err && err.message ? err.message : String(err)), "error");
      if (btn) btn.disabled = false;
    }
  }

  window.openAppMapDiscovery = async function openAppMapDiscovery() {
    var footer =
      '<button type="button" class="btn btn-secondary" id="apd-cancel">Close</button>' +
      (canWrite() ? '<button type="button" class="btn btn-primary" id="apd-save">Save selection</button>' : "");
    openModal("Discover processes &amp; services", bodyHTML(), footer, { large: true });
    var cancel = document.getElementById("apd-cancel");
    if (cancel) cancel.addEventListener("click", closeModal);
    var saveBtn = document.getElementById("apd-save");
    if (saveBtn) saveBtn.addEventListener("click", save);
    wire();
    var tbody = document.getElementById("apd-tbody");
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Loading…</td></tr>';
    try {
      await reload();
    } catch (err) {
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load: ' +
          esc(err && err.message ? err.message : String(err)) + '</td></tr>';
      }
    }
  };
})();
