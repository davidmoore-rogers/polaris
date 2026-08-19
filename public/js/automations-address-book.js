/* global api, escapeHtml, showToast, showConfirm, _trapFocus, _focusFirstIn, permAtLeast, _ensureLockButton, isPanelLocked, flashModalCloseBtn */
/**
 * public/js/automations-address-book.js
 *
 * The address book: named email addresses alerts can route to, each optionally
 * owning a set of devices. Two surfaces, one renderer:
 *
 *   1. Automations → Address Book tab — full management (renderTab).
 *   2. A picker opened from the recipient fields in the automation wizard
 *      (openPicker), which resolves the chosen entries back to the caller.
 *
 * LAYERING. openModal reuses ONE shared #modal-overlay and overwrites its body,
 * so calling it from inside the open wizard would destroy the wizard's form DOM
 * (see the comment above showConfirm in app.js). Both surfaces here therefore
 * build their own standalone overlay — the showConfirm / _showMergeReviewModal
 * pattern — at a z-index above the base modal:
 *
 *   1300  picker   (same rung as showConfirm; a confirm opened FROM the picker
 *                   is appended later and so paints above it)
 *   1320  editor   (stacks over the picker, and over nothing on the tab)
 *
 * Unlike _showMergeReviewModal, both restore focus and trap Tab — the two
 * things that instance drops. They also carry the app-wide modal lock (the
 * padlock next to the X, shared with every openModal dialog).
 */
(function () {
  var Z_PICKER = 1300;
  var Z_EDITOR = 1320;

  // ── Device-filter vocabulary ──────────────────────────────────────────────
  // A contact's "devices this contact is responsible for" is the SAME nested
  // AND/OR condition tree the automation wizard's Devices step builds — same
  // module (public/js/condition-builder.js), same stored shape, same server-side
  // evaluator. The flat comma-separated criteria rows this replaced asked the
  // one question in a second language.
  //
  // The vocabulary comes from GET /contacts/filter-schema rather than being
  // written out here: it's the wizard's field set plus the four this surface has
  // always carried (OS version / Department / Location / Behind FortiGate) and a
  // wildcard operator, and a client-side copy is how the builder would come to
  // offer a field the server refuses. `_filterSchema` caches it per page load.
  var _filterSchema = null;

  function loadFilterSchema() {
    if (_filterSchema) return Promise.resolve(_filterSchema);
    return api.contacts.filterSchema().then(function (r) {
      _filterSchema = {
        meta: (r && r.scopeCondition) || { fields: [], groupOps: ["and", "or"], maxDepth: 5 },
        options: (r && r.options) || {},
      };
      return _filterSchema;
    });
  }

  function canWrite() { return permAtLeast("contacts", "write"); }
  function canWriteAny() { return permAtLeast("contacts", "fullwrite"); }
  /** Ownership mirror of the server gate: own rows at write, anyone's at fullwrite. */
  function canEditRow(c) {
    if (canWriteAny()) return true;
    if (!canWrite()) return false;
    return !!c.createdBy && c.createdBy === (window.currentUsername || null);
  }

  // ─── Standalone overlay (the stacked-modal pattern) ────────────────────────

  /**
   * Build a dismissible overlay above any open modal. Returns { overlay, close }.
   * `onClose` fires for backdrop click / Escape / close button.
   */
  function buildOverlay(z, title, bodyHtml, footerHtml, onClose, wide) {
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = String(z);
    overlay.innerHTML =
      '<div class="modal' + (wide ? " modal-large" : " modal-wide") + '" role="dialog" aria-modal="true" tabindex="-1">' +
        '<div class="modal-header"><h3>' + escapeHtml(title) + '</h3>' +
          '<button class="btn-icon modal-close" type="button" aria-label="Close dialog">&times;</button></div>' +
        '<div class="modal-body">' + bodyHtml + '</div>' +
        '<div class="modal-footer">' + footerHtml + '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var dialog = overlay.querySelector(".modal");
    var prevFocus = document.activeElement;
    var closed = false;
    var teardownTrap = _trapFocus(dialog, function () { close(); });

    function close() {
      if (closed) return;
      closed = true;
      teardownTrap();
      overlay.classList.remove("open");
      // Remove on transition end, with a timer fallback for reduced-motion.
      overlay.addEventListener("transitionend", function () {
        if (overlay.parentNode) overlay.remove();
      }, { once: true });
      setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 400);
      if (prevFocus && typeof prevFocus.focus === "function") { try { prevFocus.focus(); } catch (_) {} }
      if (onClose) onClose();
    }

    // Panel lock: one global switch governs EVERY modal, so these stacked
    // overlays take the same toggle app.js injects into the shared #modal-overlay
    // (its MutationObserver only looks at that one element, hence the direct
    // call) and honor it the same way — an off-click while locked flashes the X
    // + bloom instead of dismissing. Guarded so the module still works on a page
    // that somehow loads without app.js.
    var closeBtn = overlay.querySelector(".modal-close");
    if (typeof _ensureLockButton === "function") {
      _ensureLockButton(overlay.querySelector(".modal-header"), "modal");
    }
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", function (ev) {
      if (ev.target !== overlay) return;
      if (typeof isPanelLocked === "function" && isPanelLocked("modal")) {
        if (typeof flashModalCloseBtn === "function") flashModalCloseBtn(closeBtn);
        return;
      }
      close();
    });
    requestAnimationFrame(function () { overlay.classList.add("open"); _focusFirstIn(dialog); });

    return { overlay: overlay, dialog: dialog, close: close };
  }

  // ─── Editor (add / edit one contact) ──────────────────────────────────────

  /**
   * Value suggestions per field, from the schema payload — the wizard's
   * scValueOptions with the same `optionsFrom` contract, so a field the server
   * adds to the catalog gets its picker here with no client change.
   */
  function valueOptionsFor(schema) {
    var fields = schema.meta.fields || [];
    var opts = schema.options || {};
    return function (field) {
      var fm = null;
      for (var i = 0; i < fields.length; i++) if (fields[i].field === field) fm = fields[i];
      if (!fm) return [];
      if (fm.values) return fm.values.map(function (v) { return { value: v, label: v }; });
      var plain = function (list) {
        return (list || []).map(function (v) { return { value: v, label: v }; });
      };
      switch (fm.optionsFrom) {
        case "assetTypes":
          return (opts.assetTypes || []).map(function (t) { return { value: t.name, label: t.label || t.name }; });
        case "manufacturers": return plain(opts.manufacturers);
        case "models": return plain(opts.models);
        case "tags": return plain(opts.tags);
        case "subnets":
          return (opts.subnets || []).map(function (sn) { return { value: sn.cidr, label: sn.name + " — " + sn.cidr }; });
        default: return [];
      }
    };
  }

  /**
   * Which of the three ownership states a stored contact is in. A contact —
   * unlike an automation — may legitimately own NOTHING (an address-only entry,
   * which is most of them), so the wizard's two-state All-assets checkbox
   * becomes three radios here. "All devices" is a real choice for a NOC mailbox,
   * and the server only ever produces it from an explicit flag.
   */
  function ownershipModeOf(c) {
    if (!c) return "none";
    if (c.assetAllDevices) return "all";
    var cond = c.assetConditionEffective || c.assetCondition;
    if (cond && (cond.children || []).length === 0) return "all"; // the all-devices marker
    if (cond) return "filter";
    // A legacy blob the builder can't render still counts as a filter, so the
    // radio doesn't read as "owns nothing" while the contact keeps matching.
    if ((c.assetFilterUnconvertible || []).length) return "filter";
    return "none";
  }

  function editorBodyHtml(c, builder) {
    var mode = ownershipModeOf(c);
    var stuck = (c && c.assetFilterUnconvertible) || [];
    var cond = (c && (c.assetConditionEffective || c.assetCondition)) || null;
    var root = cond && (cond.children || []).length ? cond : { op: "and", children: [] };
    var radio = function (value, label, hint) {
      return '<label class="appmap-check" style="display:block;margin:4px 0">' +
        '<input type="radio" name="ab-own" value="' + value + '"' + (mode === value ? " checked" : "") + '> ' +
        escapeHtml(label) + '</label>' +
        (hint ? '<p class="hint" style="margin:0 0 6px 24px">' + hint + '</p>' : "");
    };
    return '' +
      '<div class="form-group">' +
        '<label for="ab-email">Email address</label>' +
        '<input type="email" class="input" id="ab-email" autocomplete="off" spellcheck="false" ' +
               'placeholder="noc-oncall@example.com" value="' + escapeHtml((c && c.email) || "") + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label for="ab-name">Name</label>' +
        '<input type="text" class="input" id="ab-name" maxlength="200" ' +
               'placeholder="NOC On-Call rotation" value="' + escapeHtml((c && c.name) || "") + '">' +
        '<p class="hint">What the recipient picker shows instead of the raw address.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label for="ab-desc">Description</label>' +
        '<textarea class="input" id="ab-desc" rows="2" maxlength="1000" ' +
                  'placeholder="Rotates weekly; paged for anything at the Nashville plant">' + escapeHtml((c && c.description) || "") + '</textarea>' +
      '</div>' +
      '<div class="section-block">' +
        '<div class="section-label">Devices this contact is responsible for</div>' +
        '<p class="hint" style="margin-top:0">An automation whose Notify action routes to ' +
          '“the contacts responsible for the triggering device” reaches this address for any device below. ' +
          'Pinned devices are added on top of whatever the filter matches.</p>' +
        radio("none", "No filter", "Only the devices pinned below, if any — otherwise this contact is reachable just by being named in an automation.") +
        radio("filter", "Devices matching a filter") +
        radio("all", "All devices", "Every device in the inventory, including ones discovered later.") +
        '<div id="ab-filter-wrap"' + (mode === "filter" ? "" : ' style="display:none"') + '>' +
          (stuck.length
            ? '<p class="hint" style="color:var(--color-warning);margin:0 0 8px">This contact’s filter uses ' +
                escapeHtml(stuck.join(", ")) + ', which this builder can’t show. It still applies — ' +
                'saving without adding conditions below leaves it exactly as it is.</p>'
            : "") +
          '<p class="hint" style="margin:0 0 8px">Drag the <span class="aw-grip" style="cursor:default">&#x2842;</span> handle to move a condition into another group or reorder groups.</p>' +
          '<div id="ab-cond-root">' + builder.groupHtml(root, 0) + '</div>' +
        '</div>' +
        '<div class="form-group" style="margin-top:12px">' +
          '<label>Pinned devices</label>' +
          '<div id="ab-pins"></div>' +
          '<div style="display:flex;gap:6px;align-items:center;margin-top:6px">' +
            '<input type="text" class="input" id="ab-pin-search" style="flex:1" autocomplete="off" ' +
                   'placeholder="Search a device by hostname or IP to pin…">' +
          '</div>' +
          '<div id="ab-pin-results" class="hint"></div>' +
        '</div>' +
        '<div class="form-group" style="margin-top:12px">' +
          '<label>Devices covered right now</label>' +
          '<div id="ab-preview" class="hint">—</div>' +
        '</div>' +
      '</div>';
    // No datalists: the builder's value control is the shared click-to-suggest
    // combobox, fed by /contacts/filter-schema. (A <datalist> was tried in the
    // wizard and confirmed nothing — see TEMPLATES.md.)
  }

  /**
   * Add/edit modal. `contact` null = create. Resolves to the saved contact, or
   * null if the operator dismissed it.
   */
  async function openEditor(contact) {
    // The vocabulary has to be in hand BEFORE the body is assembled: the builder
    // renders its field/operator selects from it, and the wizard's own comment
    // says the same about creating its instance above the modal call.
    var schema;
    try {
      schema = await loadFilterSchema();
    } catch (err) {
      showToast((err && err.message) || "Couldn’t load the device-filter options", "error");
      return null;
    }
    return new Promise(function (resolve) {
      var pins = ((contact && contact.assetIds) || []).slice();
      var pinLabels = {};
      var settled = null;
      // A legacy filter this builder can't render is carried through the save
      // untouched (see the warning in the body) rather than being replaced by
      // whatever the empty tree collects to.
      var stuckCriteria = ((contact && (contact.assetFilterUnconvertible || []).length) && contact.assetCriteria) || null;

      var CB = window.PolarisConditionBuilder;
      var condBuilder = CB.create({
        meta: schema.meta,
        valueOptions: valueOptionsFor(schema),
        onChange: function () { refreshPreview(); },
      });

      var ui = buildOverlay(
        Z_EDITOR,
        contact ? "Edit contact" : "Add contact",
        editorBodyHtml(contact, condBuilder),
        '<button class="btn btn-secondary" type="button" data-ab="cancel">Cancel</button>' +
        '<button class="btn btn-primary" type="button" data-ab="save">' + (contact ? "Save" : "Add contact") + '</button>',
        function () { resolve(settled); },
        true,
      );
      var root = ui.dialog;

      function q(sel) { return root.querySelector(sel); }

      // ── Device filter (the shared condition tree) ──
      // Read the radios by PROPERTY rather than with a `:checked` selector:
      // happy-dom resolves `:checked` from the attribute, so a selector here
      // would make the DOM tests assert the engine's behaviour instead of ours
      // (the same trap as <option selected> — see TEMPLATES.md).
      function ownershipMode() {
        var radios = root.querySelectorAll('input[name="ab-own"]');
        for (var i = 0; i < radios.length; i++) if (radios[i].checked) return radios[i].value;
        return "none";
      }

      /** The device-ownership half of the request body, in all three modes. */
      function filterBody() {
        var mode = ownershipMode();
        if (mode === "all") return { assetAllDevices: true, assetIds: pins };
        if (mode === "none") return { assetIds: pins };
        var rootGroup = root.querySelector("#ab-cond-root > .scg-group");
        var tree = rootGroup ? condBuilder.collect(rootGroup) : null;
        if (tree && (tree.children || []).length) return { assetCondition: tree, assetIds: pins };
        // Filter mode with nothing built: preserve a legacy blob we couldn't
        // render, else there is simply no filter.
        return stuckCriteria ? { assetCriteria: stuckCriteria, assetIds: pins } : { assetIds: pins };
      }

      root.addEventListener("change", function (ev) {
        if (!ev.target.closest || !ev.target.closest('input[name="ab-own"]')) return;
        var filtering = ownershipMode() === "filter";
        q("#ab-filter-wrap").style.display = filtering ? "" : "none";
        // Revealed empty: seed a starter row so the operator lands on something
        // editable (the wizard's All-assets untick does the same).
        if (filtering) condBuilder.seedIfEmpty(q("#ab-cond-root"));
        refreshPreview();
      });

      // Rows, groups, the value combobox and the grip drag all live in the
      // shared module; the preview debounce rides its onChange.
      condBuilder.wire(root, "#ab-cond-root");

      // ── Pinned devices ──
      function renderPins() {
        var box = q("#ab-pins");
        if (!pins.length) { box.innerHTML = '<p class="hint" style="margin:0">No pinned devices.</p>'; return; }
        box.innerHTML = '<div class="tag-chip-list">' + pins.map(function (id) {
          return '<span class="tag-chip">' + escapeHtml(pinLabels[id] || id) +
            '<button type="button" class="tag-chip-delete" data-ab-unpin="' + escapeHtml(id) + '" ' +
            'aria-label="Remove pinned device">&times;</button></span>';
        }).join("") + '</div>';
      }
      root.addEventListener("click", function (ev) {
        var b = ev.target.closest && ev.target.closest("[data-ab-unpin]");
        if (!b) return;
        var id = b.getAttribute("data-ab-unpin");
        pins = pins.filter(function (x) { return x !== id; });
        renderPins();
        refreshPreview();
      });

      var pinTimer = null;
      q("#ab-pin-search").addEventListener("input", function () {
        var term = this.value.trim();
        clearTimeout(pinTimer);
        var out = q("#ab-pin-results");
        if (term.length < 2) { out.innerHTML = ""; return; }
        pinTimer = setTimeout(function () {
          api.assets.list({ search: term, limit: 8 }).then(function (r) {
            var rows = (r && r.assets) || [];
            if (!rows.length) { out.innerHTML = "No matching devices."; return; }
            out.innerHTML = rows.map(function (a) {
              return '<div><button type="button" class="btn btn-secondary btn-sm" style="margin:2px 0" ' +
                'data-ab-pin="' + escapeHtml(a.id) + '" data-ab-pin-label="' + escapeHtml(a.hostname || a.ipAddress || a.id) + '">+ ' +
                escapeHtml(a.hostname || "(no hostname)") + (a.ipAddress ? " — " + escapeHtml(a.ipAddress) : "") +
                '</button></div>';
            }).join("");
          }).catch(function () { out.innerHTML = "Device lookup failed."; });
        }, 250);
      });
      root.addEventListener("click", function (ev) {
        var b = ev.target.closest && ev.target.closest("[data-ab-pin]");
        if (!b) return;
        var id = b.getAttribute("data-ab-pin");
        if (pins.indexOf(id) === -1) pins.push(id);
        pinLabels[id] = b.getAttribute("data-ab-pin-label");
        renderPins();
        refreshPreview();
        q("#ab-pin-search").value = "";
        q("#ab-pin-results").innerHTML = "";
      });

      // ── Live preview ──
      var previewTimer = null;
      function refreshPreview() {
        clearTimeout(previewTimer);
        var el = q("#ab-preview");
        if (!el) return;
        var body = filterBody();
        if (!body.assetCondition && !body.assetCriteria && !body.assetAllDevices && !pins.length) {
          el.textContent = "No devices — this contact is address-only.";
          return;
        }
        el.textContent = "Checking…";
        previewTimer = setTimeout(function () {
          api.contacts.preview(body).then(function (r) {
            var n = r.matchCount || 0;
            if (!n) { el.textContent = "No devices match."; return; }
            var names = (r.sample || []).slice(0, 8).map(function (a) { return a.hostname || a.ipAddress || a.id; });
            el.innerHTML = '<strong>' + n + '</strong> device' + (n === 1 ? "" : "s") + " — " +
              escapeHtml(names.join(", ")) + (n > names.length ? ", …" : "");
          }).catch(function (err) { el.textContent = (err && err.message) || "Preview failed."; });
        }, 400);
      }

      renderPins();
      refreshPreview();

      // ── Save ──
      root.querySelector('[data-ab="cancel"]').addEventListener("click", function () { ui.close(); });
      root.querySelector('[data-ab="save"]').addEventListener("click", async function () {
        var btn = this;
        var filter = filterBody();
        var body = {
          email: q("#ab-email").value.trim(),
          name: q("#ab-name").value.trim() || null,
          description: q("#ab-desc").value.trim() || null,
        };
        Object.keys(filter).forEach(function (k) { body[k] = filter[k]; });
        if (!body.email) { showToast("Enter an email address", "error"); return; }
        // Same words wherever the builder is used — validate() moved into the
        // shared module for exactly this.
        if (body.assetCondition) {
          var problem = condBuilder.validate(body.assetCondition);
          if (problem) { showToast(problem, "error"); return; }
        }
        btn.disabled = true;
        try {
          var res = contact
            ? await api.contacts.update(contact.id, body)
            : await api.contacts.create(body);
          settled = res.contact;
          showToast(contact ? "Contact updated" : "Contact added", "success");
          ui.close();
        } catch (err) {
          showToast((err && err.message) || "Save failed", "error");
          btn.disabled = false;
        }
      });
    });
  }

  // ─── Row rendering (shared by the tab and the picker) ─────────────────────

  /** Count the leaf conditions in a tree (groups don't count as conditions). */
  function conditionCount(cond) {
    if (!cond) return 0;
    var n = 0;
    (cond.children || []).forEach(function (child) {
      n += child.op ? conditionCount(child) : 1;
    });
    return n;
  }

  function targetSummary(c) {
    var bits = [];
    var cond = c.assetConditionEffective || c.assetCondition;
    if (cond && (cond.children || []).length === 0) bits.push("all devices");
    else if (cond) {
      var n = conditionCount(cond);
      bits.push(n + " condition" + (n === 1 ? "" : "s"));
    } else if ((c.assetFilterUnconvertible || []).length) {
      // Still matching, just not renderable here — say so rather than "—".
      bits.push("a legacy filter");
    }
    if ((c.assetIds || []).length) {
      bits.push(c.assetIds.length + " pinned device" + (c.assetIds.length === 1 ? "" : "s"));
    }
    return bits.length ? bits.join(" + ") : "—";
  }

  // ─── Tab surface ──────────────────────────────────────────────────────────

  async function renderTab() {
    var host = document.getElementById("contacts-list");
    if (!host) return;
    host.innerHTML = '<p class="empty-state">Loading…</p>';
    var contacts;
    try {
      contacts = (await api.contacts.list()).contacts || [];
    } catch (err) {
      host.innerHTML = '<p class="empty-state">' + escapeHtml((err && err.message) || "Failed to load the address book") + "</p>";
      return;
    }
    if (!contacts.length) {
      host.innerHTML = '<p class="empty-state">No contacts yet. Add one to route alerts to an address that has no Polaris account — ' +
        'a distribution list, an on-call rotation, a vendor NOC.</p>';
      return;
    }
    host.innerHTML =
      '<div class="table-wrapper"><table><thead><tr>' +
        '<th style="width:220px">Name</th>' +
        '<th style="width:260px">Email</th>' +
        '<th>Description</th>' +
        '<th style="width:200px">Devices</th>' +
        '<th style="width:120px">Added by</th>' +
        '<th style="width:120px"></th>' +
      '</tr></thead><tbody>' +
      contacts.map(function (c) {
        var editable = canEditRow(c);
        return '<tr>' +
          "<td>" + escapeHtml(c.name || "—") + "</td>" +
          '<td class="mono">' + escapeHtml(c.email) + "</td>" +
          "<td>" + escapeHtml(c.description || "") + "</td>" +
          "<td>" + escapeHtml(targetSummary(c)) + "</td>" +
          "<td>" + escapeHtml(c.createdBy || "—") + "</td>" +
          '<td>' + (editable
            ? '<button class="btn btn-secondary btn-sm" data-ab-edit="' + escapeHtml(c.id) + '">Edit</button> ' +
              '<button class="btn btn-danger btn-sm" data-ab-del="' + escapeHtml(c.id) + '">Delete</button>'
            : "") + "</td>" +
        "</tr>";
      }).join("") +
      "</tbody></table></div>";

    if (host._wired) return;
    host._wired = true;
    host.addEventListener("click", async function (ev) {
      var ed = ev.target.closest && ev.target.closest("[data-ab-edit]");
      if (ed) {
        var row = (await api.contacts.list()).contacts.find(function (x) { return x.id === ed.getAttribute("data-ab-edit"); });
        if (row) { await openEditor(row); renderTab(); }
        return;
      }
      var del = ev.target.closest && ev.target.closest("[data-ab-del]");
      if (del) {
        if (!(await showConfirm("Delete this contact? Automations routing to it will stop reaching that address."))) return;
        try {
          await api.contacts.delete(del.getAttribute("data-ab-del"));
          showToast("Contact deleted", "success");
        } catch (err) { showToast((err && err.message) || "Delete failed", "error"); }
        renderTab();
      }
    });
  }

  // ─── Picker surface (opened from the wizard's recipient fields) ───────────

  function pickerBodyHtml() {
    return '' +
      '<div class="form-group" style="margin-bottom:8px">' +
        '<input type="text" class="input" id="ab-pick-search" autocomplete="off" spellcheck="false" ' +
               'placeholder="Search people, contacts and lists…">' +
      '</div>' +
      '<div id="ab-pick-results"><p class="empty-state">Loading…</p></div>';
  }

  function sourceBadge(src) {
    var label = src === "user" ? "Polaris user" : src === "contact" ? "Contact" : src === "entra" ? "Entra" : "Directory";
    return '<span class="badge" style="font-size:0.7rem">' + escapeHtml(label) + "</span>";
  }

  /**
   * Address-book picker. `field` is the recipient field it was opened from
   * ("to" | "cc" | "bcc") and comes back on the result so the caller knows
   * where to drop the entries. Resolves { field, entries } or null.
   */
  function openPicker(opts) {
    var field = (opts && opts.field) || "to";
    return new Promise(function (resolve) {
      var chosen = {};       // email → entry
      var settled = null;
      var entries = [];

      var ui = buildOverlay(
        Z_PICKER,
        "Address book",
        pickerBodyHtml(),
        '<button class="btn btn-secondary" type="button" data-ab="new">+ New contact</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-secondary" type="button" data-ab="add-to">Add to To</button>' +
        '<button class="btn btn-secondary" type="button" data-ab="add-cc">Add to Cc</button>' +
        '<button class="btn btn-secondary" type="button" data-ab="add-bcc">Add to Bcc</button>',
        function () { resolve(settled); },
        true,
      );
      var root = ui.dialog;
      function q(sel) { return root.querySelector(sel); }

      // Highlight the field the picker was opened from so "Add to Cc" from a Cc
      // field is the obvious default without removing the other two.
      var defBtn = root.querySelector('[data-ab="add-' + field + '"]');
      if (defBtn) { defBtn.classList.remove("btn-secondary"); defBtn.classList.add("btn-primary"); }

      function render() {
        var box = q("#ab-pick-results");
        if (!entries.length) {
          box.innerHTML = '<p class="empty-state">No matches.</p>';
          return;
        }
        box.innerHTML = '<div class="table-wrapper"><table><thead><tr>' +
          '<th style="width:36px"></th><th style="width:200px">Name</th><th style="width:250px">Email</th>' +
          '<th>Description</th><th style="width:110px">Source</th><th style="width:110px"></th>' +
          '</tr></thead><tbody>' +
          entries.map(function (e) {
            var on = !!chosen[e.email.toLowerCase()];
            return '<tr>' +
              '<td><input type="checkbox" data-ab-pick="' + escapeHtml(e.email) + '"' + (on ? " checked" : "") + "></td>" +
              "<td>" + escapeHtml(e.name || "—") + "</td>" +
              '<td class="mono">' + escapeHtml(e.email) + "</td>" +
              "<td>" + escapeHtml(e.description || "") + "</td>" +
              "<td>" + sourceBadge(e.source) + "</td>" +
              "<td>" + (e.source === "contact" && e.owned !== false && canWrite()
                ? '<button class="btn btn-secondary btn-sm" data-ab-pedit="' + escapeHtml(e.id) + '">Edit</button>'
                : "") + "</td>" +
            "</tr>";
          }).join("") +
          "</tbody></table></div>";
      }

      async function load(term) {
        try {
          // `true` = also search the organization's directory (live, not stored).
          entries = (await api.contacts.search(term || "", true)).entries || [];
        } catch (err) {
          q("#ab-pick-results").innerHTML = '<p class="empty-state">' +
            escapeHtml((err && err.message) || "Search failed") + "</p>";
          return;
        }
        render();
      }

      var timer = null;
      q("#ab-pick-search").addEventListener("input", function () {
        var term = this.value.trim();
        clearTimeout(timer);
        timer = setTimeout(function () { load(term); }, 250);
      });

      root.addEventListener("change", function (ev) {
        var cb = ev.target.closest && ev.target.closest("[data-ab-pick]");
        if (!cb) return;
        var email = cb.getAttribute("data-ab-pick");
        var entry = entries.find(function (e) { return e.email === email; });
        if (cb.checked && entry) chosen[email.toLowerCase()] = entry;
        else delete chosen[email.toLowerCase()];
      });

      root.addEventListener("click", async function (ev) {
        var ed = ev.target.closest && ev.target.closest("[data-ab-pedit]");
        if (ed) {
          var id = ed.getAttribute("data-ab-pedit");
          var row = ((await api.contacts.list()).contacts || []).find(function (x) { return x.id === id; });
          if (row) { await openEditor(row); load(q("#ab-pick-search").value.trim()); }
        }
      });

      root.querySelector('[data-ab="new"]').addEventListener("click", async function () {
        var created = await openEditor(null);
        if (created) {
          // Auto-select what the operator just added — they opened the editor
          // from a recipient field, so they mean to use it.
          chosen[created.email.toLowerCase()] = {
            source: "contact", id: created.id, email: created.email,
            name: created.name, description: created.description, kind: "person",
          };
        }
        load(q("#ab-pick-search").value.trim());
      });

      ["to", "cc", "bcc"].forEach(function (f) {
        root.querySelector('[data-ab="add-' + f + '"]').addEventListener("click", function () {
          var picked = Object.keys(chosen).map(function (k) { return chosen[k]; });
          if (!picked.length) { showToast("Select at least one address", "error"); return; }
          settled = { field: f, entries: picked };
          ui.close();
        });
      });

      load("");
    });
  }

  window.PolarisAddressBook = {
    renderTab: renderTab,
    openEditor: function (c) { return openEditor(c).then(function (r) { renderTab(); return r; }); },
    openPicker: openPicker,
  };
})();
