/* global api, escapeHtml, showToast, showConfirm, permAtLeast, buildOverlay */
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

  // buildOverlay now lives in app.js (loaded on every page) so surfaces outside
  // this file — the automations code editor, which the wizard opens on pages that
  // never load the address book — can stack a dialog over an open modal too.

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
   * Is this contact responsible for EVERY device? Drives the All-devices
   * checkbox, which is the automations Devices step's control exactly — same
   * default-checked two-state shape, so "which devices?" is asked the same way in
   * both places.
   *
   * A NEW contact starts checked (`c` null). Unchecking reveals the builder, and
   * an empty builder means "no filter" — only the pinned devices below, which is
   * the address-only state most contacts are in. That last part is where contacts
   * differ from automations, where an empty tree with All-assets unchecked is a
   * validation error: an automation must select something to be worth saving,
   * while a contact is perfectly useful as a bare address.
   */
  function allDevicesOf(c) {
    if (!c) return true;
    if (c.assetAllDevices) return true;
    var cond = c.assetConditionEffective || c.assetCondition;
    // The all-devices marker is an empty AND group (true for every asset by
    // boolean identity); anything else is a real filter.
    return !!cond && (cond.children || []).length === 0;
  }

  function editorBodyHtml(c, builder) {
    var allDevices = allDevicesOf(c);
    var stuck = (c && c.assetFilterUnconvertible) || [];
    var cond = (c && (c.assetConditionEffective || c.assetCondition)) || null;
    var root = cond && (cond.children || []).length ? cond : { op: "and", children: [] };
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
                  'placeholder="Rotates weekly; paged for anything at the Ashfield plant">' + escapeHtml((c && c.description) || "") + '</textarea>' +
      '</div>' +
      '<div class="section-block">' +
        '<div class="section-label">Devices this contact is responsible for</div>' +
        '<p class="hint" style="margin-top:0">An automation whose Notify action routes to ' +
          '“the contacts responsible for the triggering device” reaches this address for any device below. ' +
          'Pinned devices are added on top of whatever the filter matches.</p>' +
        '<div class="form-group" style="margin-bottom:0.5rem">' +
          '<label style="font-weight:600"><input type="checkbox" id="ab-all-devices"' + (allDevices ? " checked" : "") + '> All devices</label>' +
          '<p class="hint" style="margin:2px 0 0 24px">Every device in the inventory, including ones discovered later. ' +
            'Uncheck to filter which devices this contact is responsible for — leave the filter empty and only the pinned devices below count.</p>' +
        '</div>' +
        '<div id="ab-filter-wrap"' + (allDevices ? ' style="display:none"' : "") + '>' +
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
      // Read the checkbox by PROPERTY rather than with a `:checked` selector:
      // happy-dom resolves `:checked` from the attribute, so a selector here
      // would make the DOM tests assert the engine's behaviour instead of ours
      // (the same trap as <option selected> — see TEMPLATES.md).
      function allDevicesChecked() {
        var cb = q("#ab-all-devices");
        return !!(cb && cb.checked);
      }

      /** The device-ownership half of the request body. */
      function filterBody() {
        if (allDevicesChecked()) return { assetAllDevices: true, assetIds: pins };
        var rootGroup = root.querySelector("#ab-cond-root > .scg-group");
        var tree = rootGroup ? condBuilder.collect(rootGroup) : null;
        if (tree && (tree.children || []).length) return { assetCondition: tree, assetIds: pins };
        // Unchecked with nothing built: preserve a legacy blob we couldn't
        // render, else there is simply no filter — only the pins.
        return stuckCriteria ? { assetCriteria: stuckCriteria, assetIds: pins } : { assetIds: pins };
      }

      var allCb = q("#ab-all-devices");
      if (allCb) {
        allCb.addEventListener("change", function () {
          q("#ab-filter-wrap").style.display = allCb.checked ? "none" : "";
          // Revealed empty: seed a starter row so the operator lands on something
          // editable (the wizard's All-assets untick does the same).
          if (!allCb.checked) condBuilder.seedIfEmpty(q("#ab-cond-root"));
          refreshPreview();
        });
      }

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
            var un = r.unmonitoredCount || 0;
            // The unmonitored remainder is stated, not hidden: the filter does
            // cover those devices, and an event or change automation fires on
            // them — they're just not what the operator is choosing between.
            var extra = un
              ? ' <span class="hint">(+' + un + " unmonitored device" + (un === 1 ? "" : "s") + " also covered)</span>"
              : "";
            if (!n) {
              el.innerHTML = un
                ? "No monitored devices match." + extra
                : "No devices match.";
              return;
            }
            var names = (r.sample || []).slice(0, 8).map(function (a) { return a.hostname || a.ipAddress || a.id; });
            el.innerHTML = '<strong>' + n + '</strong> monitored device' + (n === 1 ? "" : "s") + " — " +
              escapeHtml(names.join(", ")) + (n > names.length ? ", …" : "") + extra;
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

  // ─── Shared table renderer (both surfaces) ─────────────────────────────────

  /**
   * ONE table for the tab and the picker. The surfaces differ only in their
   * COLUMNS — the picker adds a checkbox and drops the management columns — so
   * they share the cell builders instead of each writing its own <td> for
   * name/email/description/source and drifting on one of them.
   *
   * `cols` is an ordered list of { label?, width?, cls?, cell(entry) } specs;
   * `cell` returns the cell's INNER html. `hint` is pre-rendered html appended
   * under the table, because each surface decides emptiness differently (the
   * picker's panes always carry their dynamic rows, so `entries.length` is the
   * question there, not the row count).
   */
  function abTable(cols, entries, hint) {
    var head = cols.map(function (c) {
      return "<th" + (c.width ? ' style="width:' + c.width + '"' : "") + ">" + (c.label || "") + "</th>";
    }).join("");
    var body = entries.map(function (en) {
      return "<tr>" + cols.map(function (c) {
        return "<td" + (c.cls ? ' class="' + c.cls + '"' : "") + ">" + (c.cell(en) || "") + "</td>";
      }).join("") + "</tr>";
    }).join("");
    return '<div class="table-wrapper"><table><thead><tr>' + head + "</tr></thead><tbody>" +
      body + "</tbody></table></div>" + (hint || "");
  }

  /** The four cells every address-book row has, whichever surface renders it. */
  var AB_CELLS = {
    name: { label: "Name", width: "220px", cell: function (en) { return escapeHtml(en.name || "—"); } },
    email: { label: "Email", width: "250px", cls: "mono", cell: function (en) { return escapeHtml(en.email || ""); } },
    description: { label: "Description", cell: function (en) { return escapeHtml(en.description || ""); } },
    source: { label: "Source", width: "110px", cell: function (en) { return sourceBadge(en.source); } },
  };

  // ─── Tab surface ───────────────────────────────────────────────────────────

  /**
   * The tab renders the SAME two panes the wizard's picker does — People
   * (searched: contacts, Polaris user accounts and, where the integrations opted
   * in, the org directory) and Regions (browsed) — minus the checkboxes and the
   * Add-to-To/Cc/Bcc footer, which only mean something while composing a Notify
   * action. It previously listed stored contacts alone, so the page an operator
   * opens to ask "who can Polaris email?" answered a narrower question than the
   * modal did.
   *
   * Stored contacts are rendered from GET /contacts rather than out of the
   * search payload, for two things that payload can't carry: the row's
   * `createdBy` and device filter (the Devices + Added by columns, and the
   * per-row ownership check behind Edit/Delete), and completeness — search
   * returns at most 50 deduped hits ordered users-first, so on an install with
   * more than 50 accounts the contacts would fall off the end of the very page
   * that manages them. A search hit whose address a contact already holds is
   * dropped, so one mailbox stays one row.
   */

  // Survives a re-render (the Refresh button, a save from the editor) so the
  // operator's search term isn't silently thrown away under them.
  var _tab = { term: "" };

  function tabBodyHtml() {
    return '' +
      '<div class="page-tabs" id="ab-tab-tabs" style="margin-bottom:10px">' +
        '<button type="button" class="page-tab active" data-ab-ttab="people">People</button>' +
        '<button type="button" class="page-tab" data-ab-ttab="regions">Regions</button>' +
      '</div>' +
      '<div data-ab-tpane="people">' +
        '<div class="form-group" style="margin-bottom:8px">' +
          '<input type="text" class="input" id="ab-tab-search" autocomplete="off" spellcheck="false" ' +
                 'placeholder="Search people, contacts and lists…" value="' + escapeHtml(_tab.term) + '">' +
        '</div>' +
        '<div id="ab-tab-results"><p class="empty-state">Loading…</p></div>' +
      '</div>' +
      '<div data-ab-tpane="regions" style="display:none">' +
        '<p class="hint" style="margin-top:0">Regions come from the polygons drawn on the Device Map. ' +
          'An automation’s <strong>Notify</strong> action can route to a region to reach every user tagged ' +
          'with it, or to the region of the device that triggered the alert. Nothing here is edited on this ' +
          'page — draw or rename a region on the Device Map, and tag users with it under Users.</p>' +
        '<div id="ab-tab-regions"><p class="empty-state">Loading…</p></div>' +
      '</div>';
  }

  function tabPeopleCols() {
    return [
      AB_CELLS.name,
      AB_CELLS.email,
      AB_CELLS.description,
      {
        label: "Devices",
        width: "180px",
        cell: function (en) { return escapeHtml(en.contact ? targetSummary(en.contact) : "—"); },
      },
      AB_CELLS.source,
      {
        label: "Added by",
        width: "120px",
        cell: function (en) { return escapeHtml((en.contact && en.contact.createdBy) || "—"); },
      },
      {
        width: "120px",
        cell: function (en) {
          if (!en.contact || !canEditRow(en.contact)) return "";
          return '<button class="btn btn-secondary btn-sm" data-ab-edit="' + escapeHtml(en.contact.id) + '">Edit</button> ' +
            '<button class="btn btn-danger btn-sm" data-ab-del="' + escapeHtml(en.contact.id) + '">Delete</button>';
        },
      },
    ];
  }

  function matchesTerm(c, lower) {
    if (!lower) return true;
    return String(c.email || "").toLowerCase().indexOf(lower) >= 0 ||
      String(c.name || "").toLowerCase().indexOf(lower) >= 0;
  }

  async function loadTabPeople() {
    var box = document.getElementById("ab-tab-results");
    if (!box) return;
    var term = _tab.term;
    var lower = term.toLowerCase();
    var contacts;
    var entries;
    try {
      var res = await Promise.all([api.contacts.list(), api.contacts.search(term, true)]);
      contacts = ((res[0] && res[0].contacts) || []).filter(function (c) { return matchesTerm(c, lower); });
      entries = (res[1] && res[1].entries) || [];
    } catch (err) {
      if (term !== _tab.term) return;
      box.innerHTML = '<p class="empty-state">' +
        escapeHtml((err && err.message) || "Failed to load the address book") + "</p>";
      return;
    }
    if (term !== _tab.term) return; // a later keystroke already owns the pane

    // Contacts first, and a search hit sharing one of their addresses drops:
    // the contact row is the manageable one, and the picker's own dedupe
    // already treats one mailbox as one entry.
    var held = {};
    contacts.forEach(function (c) { held[String(c.email || "").toLowerCase()] = true; });
    var rows = contacts.map(function (c) {
      return {
        source: "contact", id: c.id, email: c.email, name: c.name,
        description: c.description, kind: "person", contact: c,
      };
    }).concat(entries.filter(function (en) {
      return !en.email || !held[String(en.email).toLowerCase()];
    }));

    var hint = "";
    if (!rows.length) {
      hint = '<p class="hint" style="margin:8px 0 0">' + (term
        ? "No people match that search."
        : "No contacts yet, and no Polaris account carries an email address. Add a contact to route alerts to an " +
          "address that has no Polaris account — a distribution list, an on-call rotation, a vendor NOC.") +
        "</p>";
    } else if (!term && !contacts.length) {
      // The rows are all Polaris accounts and directory hits. Say what's missing
      // rather than let a populated table imply the address book is set up.
      hint = '<p class="hint" style="margin:8px 0 0">No contacts yet — every row above is a Polaris account. ' +
        "Add a contact to route alerts to an address that has no Polaris account — a distribution list, " +
        "an on-call rotation, a vendor NOC.</p>";
    } else if (entries.length >= 50) {
      // searchAddressBook caps at 50 — say so rather than let a truncated list
      // read as "that's everyone".
      hint = '<p class="hint" style="margin:8px 0 0">Showing the first 50 matches — narrow the search to see more.</p>';
    }
    box.innerHTML = abTable(tabPeopleCols(), rows, hint);
  }

  function loadTabRegions() {
    var box = document.getElementById("ab-tab-regions");
    if (!box) return;
    var cols = [AB_CELLS.name, AB_CELLS.description, AB_CELLS.source];
    return loadFilterSchema().then(function (schema) {
      var regions = ((schema.options && schema.options.regions) || []).map(function (name) {
        return { source: "region", id: name, name: name, description: "Every user tagged with this region" };
      });
      box.innerHTML = abTable(cols, regions, regions.length ? "" :
        '<p class="hint" style="margin:8px 0 0">No map regions are defined yet — draw them on the Device Map to route by region.</p>');
    }).catch(function (err) {
      box.innerHTML = '<p class="empty-state">' +
        escapeHtml((err && err.message) || "Failed to load the region catalogue") + "</p>";
    });
  }

  function wireTab(host) {
    host.querySelectorAll("[data-ab-ttab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var want = btn.getAttribute("data-ab-ttab");
        host.querySelectorAll("[data-ab-ttab]").forEach(function (b) { b.classList.toggle("active", b === btn); });
        host.querySelectorAll("[data-ab-tpane]").forEach(function (pane) {
          pane.style.display = pane.getAttribute("data-ab-tpane") === want ? "" : "none";
        });
      });
    });

    var timer = null;
    var search = host.querySelector("#ab-tab-search");
    if (search) {
      search.addEventListener("input", function () {
        _tab.term = this.value.trim();
        clearTimeout(timer);
        timer = setTimeout(function () { loadTabPeople(); }, 250);
      });
    }

    host.addEventListener("click", async function (ev) {
      var ed = ev.target.closest && ev.target.closest("[data-ab-edit]");
      if (ed) {
        var row = ((await api.contacts.list()).contacts || []).find(function (x) {
          return x.id === ed.getAttribute("data-ab-edit");
        });
        if (row) { await openEditor(row); loadTabPeople(); }
        return;
      }
      var del = ev.target.closest && ev.target.closest("[data-ab-del]");
      if (del) {
        if (!(await showConfirm("Delete this contact? Automations routing to it will stop reaching that address."))) return;
        try {
          await api.contacts.delete(del.getAttribute("data-ab-del"));
          showToast("Contact deleted", "success");
        } catch (err) { showToast((err && err.message) || "Delete failed", "error"); }
        loadTabPeople();
      }
    });
  }

  /**
   * Paint (or repaint) the tab. The shell is built ONCE — rebuilding it on every
   * load would blur the search box mid-keystroke — and both panes then refresh
   * from the server, so Refresh and a save from the editor land the same way.
   */
  async function renderTab() {
    var host = document.getElementById("contacts-list");
    if (!host) return;
    if (!host._abShell) {
      host.innerHTML = tabBodyHtml();
      host._abShell = true;
      wireTab(host);
    }
    await Promise.all([loadTabPeople(), loadTabRegions()]);
  }

  // ─── Picker surface (opened from the wizard's recipient fields) ───────────

  /**
   * The two DYNAMIC recipients — entries that name no address but a RULE for
   * finding one from the triggering device at fire time. They were checkboxes
   * under the wizard's recipient fields, which asked "who gets this?" in two
   * places; here they sit in the same list as everyone else and come back as
   * pills. `id` is fixed because one of each is meaningful.
   *
   * They live in DIFFERENT panes, by what they resolve to: responsible contacts
   * are people out of this very address book, so they head the People list;
   * region users are reached BY region, so they head the Regions list. Each sits
   * at the top of its pane rather than in the results, because it isn't a search
   * hit — it's the standing answer to "whoever owns the device".
   */
  var PEOPLE_DYNAMIC = [
    {
      source: "assetContacts",
      id: "assetContacts",
      name: "Asset’s Responsible Contacts",
      description: "The address-book contacts whose device filter covers the triggering device",
    },
  ];
  var REGION_DYNAMIC = [
    {
      source: "deviceRegion",
      id: "deviceRegion",
      name: "Asset’s Region Users",
      description: "Every user whose region tags match the triggering device’s own region: tag (any level)",
    },
  ];

  /**
   * The dynamic Regions entries for an install whose regions are NESTED: one
   * per asset-relative level, so an operator can put front-line staff on the
   * trigger and the division's managers on the escalation.
   *
   * Offered ONLY when something is actually nested (`maxLevel >= 2`). On a flat
   * catalogue "L1 Region Users" is a synonym for the entry above, and offering
   * it would invite a rule that quietly changes meaning the day someone draws
   * a containing polygon.
   */
  function regionDynamicEntries(maxLevel) {
    var out = REGION_DYNAMIC.slice();
    var top = typeof maxLevel === "number" ? maxLevel : 1;
    if (top < 2) return out;
    for (var n = 1; n <= top; n++) {
      out.push({
        source: "deviceRegionLevel",
        id: "deviceRegionLevel:" + n,
        level: n,
        name: "Asset’s L" + n + " Region Users",
        description: n === 1
          ? "The device’s own most-specific region"
          : "The region " + (n - 1) + " level" + (n - 1 === 1 ? "" : "s") + " out from the device’s own region",
      });
    }
    return out;
  }

  function pickerBodyHtml() {
    return '' +
      // Two tabs rather than one merged list: people are SEARCHED (typeahead over
      // users, contacts and the directory) while regions are BROWSED (a short
      // fixed catalogue), and a search box over a dozen region names is noise.
      '<div class="page-tabs" id="ab-pick-tabs" style="margin-bottom:10px">' +
        '<button type="button" class="page-tab active" data-ab-tab="people">People</button>' +
        '<button type="button" class="page-tab" data-ab-tab="regions">Regions</button>' +
      '</div>' +
      '<div data-ab-pane="people">' +
        '<div class="form-group" style="margin-bottom:8px">' +
          '<input type="text" class="input" id="ab-pick-search" autocomplete="off" spellcheck="false" ' +
                 'placeholder="Search people, contacts and lists…">' +
        '</div>' +
        '<div id="ab-pick-results"><p class="empty-state">Loading…</p></div>' +
      '</div>' +
      '<div data-ab-pane="regions" style="display:none">' +
        '<p class="hint" style="margin-top:0">Pick a region to reach every user tagged with it, or ' +
          '<strong>Asset’s Region Users</strong>, which resolves from the region of the device that triggered the alert. ' +
          'Where regions are nested, <strong>L1</strong> is the device’s own region and higher levels are the regions ' +
          'that contain it — so L1 reaches the local team and L2 reaches whoever covers the division.</p>' +
        '<div id="ab-pick-regions"><p class="empty-state">Loading…</p></div>' +
      '</div>';
  }

  function sourceBadge(src) {
    var label = src === "user" ? "Polaris user"
      : src === "contact" ? "Contact"
        : src === "entra" ? "Entra"
          : src === "region" ? "Region"
            : (src === "deviceRegion" || src === "deviceRegionLevel" || src === "assetContacts") ? "Dynamic"
              : "Directory";
    return '<span class="badge" style="font-size:0.7rem">' + escapeHtml(label) + "</span>";
  }

  /**
   * Stable selection key. People key on the ADDRESS (so the same mailbox reached
   * as a user and as a contact is one selection, which is what the search's own
   * dedupe already assumes); region and dynamic entries have no address, so they
   * key on source + id.
   */
  function pickKey(e) {
    return e.email ? String(e.email).toLowerCase() : e.source + "|" + e.id;
  }

  /**
   * Address-book picker. `field` is the recipient field it was opened from
   * ("to" | "cc" | "bcc") and comes back on the result so the caller knows
   * where to drop the entries. Resolves { field, entries } or null.
   */
  function openPicker(opts) {
    var field = (opts && opts.field) || "to";
    return new Promise(function (resolve) {
      var chosen = {};       // pickKey → entry
      var settled = null;
      var entries = [];       // People pane (search results)
      var regionEntries = []; // Regions pane (one row per map region)
      var regionMaxLevel = 1;  // how deep nesting goes — decides the level entries

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

      /**
       * The picker's columns: the shared four, wrapped in a selection checkbox
       * and an Edit cell. Both panes use them, so a region reads like a person.
       */
      function pickCols() {
        return [
          {
            width: "36px",
            cell: function (en) {
              var key = pickKey(en);
              return '<input type="checkbox" data-ab-pick="' + escapeHtml(key) + '"' +
                (chosen[key] ? " checked" : "") + ">";
            },
          },
          AB_CELLS.name,
          AB_CELLS.email,
          AB_CELLS.description,
          AB_CELLS.source,
          {
            width: "110px",
            cell: function (en) {
              return en.source === "contact" && en.owned !== false && canWrite()
                ? '<button class="btn btn-secondary btn-sm" data-ab-pedit="' + escapeHtml(en.id) + '">Edit</button>'
                : "";
            },
          },
        ];
      }

      function render() {
        var box = q("#ab-pick-results");
        // The dynamic entry heads the list unconditionally — it is not a search
        // result, so a query that matches nobody must not hide it.
        box.innerHTML = abTable(pickCols(), PEOPLE_DYNAMIC.concat(entries),
          entries.length ? "" : '<p class="hint" style="margin:8px 0 0">No people match that search.</p>');
      }

      /**
       * The Regions pane: the two dynamic entries first — they're what an
       * operator reaches for most, and they need no region catalogue at all —
       * then one row per operator-drawn map region.
       */
      function renderRegions() {
        var box = q("#ab-pick-regions");
        if (!box) return;
        box.innerHTML = abTable(
          pickCols(),
          regionDynamicEntries(regionMaxLevel).concat(regionEntries),
          regionEntries.length
            ? ""
            : '<p class="hint" style="margin:8px 0 0">No map regions are defined yet — draw them on the Device Map to route by region.</p>',
        );
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

      // Tab switching. Both panes stay in the DOM, so the People search term and
      // the current selection survive a look at the Regions list.
      root.querySelectorAll("[data-ab-tab]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var want = btn.getAttribute("data-ab-tab");
          root.querySelectorAll("[data-ab-tab]").forEach(function (b) {
            b.classList.toggle("active", b === btn);
          });
          root.querySelectorAll("[data-ab-pane]").forEach(function (pane) {
            pane.style.display = pane.getAttribute("data-ab-pane") === want ? "" : "none";
          });
        });
      });

      var timer = null;
      q("#ab-pick-search").addEventListener("input", function () {
        var term = this.value.trim();
        clearTimeout(timer);
        timer = setTimeout(function () { load(term); }, 250);
      });

      root.addEventListener("change", function (ev) {
        var cb = ev.target.closest && ev.target.closest("[data-ab-pick]");
        if (!cb) return;
        var key = cb.getAttribute("data-ab-pick");
        // Both panes' pools, so a selection survives switching tabs — every
        // paint re-reads the checkbox state from `chosen`.
        var pool = entries.concat(PEOPLE_DYNAMIC, regionDynamicEntries(regionMaxLevel), regionEntries);
        var entry = null;
        for (var i = 0; i < pool.length; i++) if (pickKey(pool[i]) === key) entry = pool[i];
        if (cb.checked && entry) chosen[key] = entry;
        else delete chosen[key];
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
          if (!picked.length) { showToast("Select at least one recipient", "error"); return; }
          settled = { field: f, entries: picked };
          ui.close();
        });
      });

      load("");
      // The region catalogue rides the filter-schema payload (which already
      // carries options.regions from listScopeOptions), so the picker needs no
      // second endpoint and no permission the address book lacks.
      loadFilterSchema().then(function (schema) {
        regionEntries = ((schema.options && schema.options.regions) || []).map(function (name) {
          return { source: "region", id: name, name: name, description: "Every user tagged with this region" };
        });
        var lv = schema.options && schema.options.regionLevels;
        regionMaxLevel = lv && typeof lv.maxLevel === "number" ? lv.maxLevel : 1;
        renderRegions();
      }).catch(function () {
        renderRegions(); // degrade to the two dynamic entries — they need no catalogue
      });
    });
  }

  window.PolarisAddressBook = {
    renderTab: renderTab,
    openEditor: function (c) { return openEditor(c).then(function (r) { renderTab(); return r; }); },
    openPicker: openPicker,
  };
})();
