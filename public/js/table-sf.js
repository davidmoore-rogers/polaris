/**
 * public/js/table-sf.js — Per-column sort + inline filter for data tables
 *
 * Usage:
 *   var sf = new TableSF("tbody-id", onChange);
 *   var processed = sf.apply(rawData);
 *
 * Mark sortable/filterable columns with data-sf-key and data-sf-type attributes:
 *   <th data-sf-key="name" data-sf-type="string">Name</th>
 *
 * Supported types: string (default), number, date, ip, array
 * Nested keys work:  data-sf-key="block.name"  or  data-sf-key="_count.subnets"
 *
 * Multi-select dropdown filter: add data-sf-options="value1|value2|value3" to
 * render a checkbox popover instead of a free-text input. Each option may use
 * "value=Label" form to override the displayed label (defaults to capitalized
 * value). Selected values are matched case-insensitively against the row's
 * value via exact equality, and the filter is stored as an array.
 */
function TableSF(tbodyId, onChange) {
  var tbody = document.getElementById(tbodyId);
  this._thead = tbody ? tbody.closest("table").querySelector("thead") : null;
  this._onChange = onChange;
  this._sortKey = null;
  this._sortDir = "asc";
  this._filters = {};
  if (this._thead) this._setup();
}

TableSF.prototype._setup = function () {
  var self = this;
  this._thead.querySelectorAll("th[data-sf-key]").forEach(function (th) {
    var key     = th.getAttribute("data-sf-key");
    var label   = th.textContent.trim();
    var optsRaw = th.getAttribute("data-sf-options");

    th.classList.add("sf-th");

    var headerHtml =
      '<div class="sf-header">' +
        '<span class="sf-label">' + escapeHtml(label) + '</span>' +
        '<span class="sf-sort-icon">⇅</span>' +
      '</div>';

    var typeAttr = th.getAttribute("data-sf-type") || "string";
    if (optsRaw != null) {
      // Empty data-sf-options="" marks the column as a dynamic multi-select;
      // setColumnOptions() will populate the checkbox list once data loads.
      var checks = optsRaw.trim()
        ? self._renderOptionList(self._parseOptions(optsRaw))
        : "";
      th.innerHTML = headerHtml +
        '<div class="sf-filter-multi">' +
          '<button type="button" class="sf-filter sf-multi-button" title="Filter by value">All</button>' +
          '<div class="sf-multi-popover" hidden>' + checks + '</div>' +
        '</div>';
    } else if (typeAttr === "date") {
      th.innerHTML = headerHtml +
        '<div class="sf-filter-date">' +
          '<button type="button" class="sf-filter sf-date-button" title="Filter by date range">Any date</button>' +
          '<div class="sf-multi-popover sf-date-popover" hidden>' +
            '<label class="sf-date-row"><span>From</span><input type="date" data-sf-date="from"></label>' +
            '<label class="sf-date-row"><span>To</span><input type="date" data-sf-date="to"></label>' +
            '<div class="sf-date-actions"><button type="button" class="sf-btn-clear">Clear</button></div>' +
          '</div>' +
        '</div>';
    } else {
      th.innerHTML = headerHtml +
        '<div class="sf-filter-text">' +
          '<button type="button" class="sf-filter-op" title="Filter mode">▾</button>' +
          '<input class="sf-filter" type="text" placeholder="filter…"' +
            ' title="Type to filter. Prefix with ! to exclude rows (e.g. !foo).">' +
          '<div class="sf-multi-popover sf-op-popover" hidden>' +
            '<div class="sf-op-row" data-op="contains">Contains text</div>' +
            '<div class="sf-op-row" data-op="not-contains">Does not contain</div>' +
            '<div class="sf-op-row" data-op="empty">Is empty</div>' +
            '<div class="sf-op-row" data-op="notempty">Is not empty</div>' +
          '</div>' +
        '</div>';
    }

    th.querySelector(".sf-header").addEventListener("click", function () {
      if (self._sortKey === key) {
        self._sortDir = self._sortDir === "asc" ? "desc" : "asc";
      } else {
        self._sortKey = key;
        self._sortDir = "asc";
      }
      self._updateIcons();
      self._onChange();
    });

    if (optsRaw != null) {
      var wrap = th.querySelector(".sf-filter-multi");
      var btn  = wrap.querySelector(".sf-multi-button");
      var pop  = wrap.querySelector(".sf-multi-popover");

      wrap.addEventListener("click", function (e) { e.stopPropagation(); });
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var willOpen = pop.hasAttribute("hidden");
        document.querySelectorAll(".sf-multi-popover").forEach(function (p) {
          p.setAttribute("hidden", "");
        });
        if (willOpen) {
          pop.removeAttribute("hidden");
          self._positionPopover(btn, pop);
        }
      });
      pop.addEventListener("change", function () {
        var selected = Array.prototype.slice.call(
          pop.querySelectorAll('input[type="checkbox"]:checked')
        ).map(function (cb) { return cb.value; });
        if (selected.length) self._filters[key] = selected;
        else                  delete self._filters[key];
        self._updateMultiButtonLabel(th);
        self._onChange();
      });
    } else if (typeAttr === "date") {
      self._wireDateFilter(th, key);
    } else {
      self._wireTextFilter(th, key);
    }
  });

  if (!TableSF._docWired) {
    TableSF._docWired = true;
    var closeAll = function () {
      document.querySelectorAll(".sf-multi-popover").forEach(function (p) {
        p.setAttribute("hidden", "");
      });
    };
    document.addEventListener("click", closeAll);
    window.addEventListener("scroll", closeAll, true);
    window.addEventListener("resize", closeAll);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeAll();
    });
  }
};

TableSF.prototype._wireTextFilter = function (th, key) {
  var self = this;
  var wrap = th.querySelector(".sf-filter-text");
  var opBtn = wrap.querySelector(".sf-filter-op");
  var inp   = wrap.querySelector(".sf-filter");
  var pop   = wrap.querySelector(".sf-op-popover");

  wrap.addEventListener("click", function (e) { e.stopPropagation(); });
  inp.addEventListener("click", function (e) { e.stopPropagation(); });

  function commitText() {
    var v = inp.value.trim();
    var raw = self._filters[key];
    var op = "contains";
    if (raw && typeof raw === "object" && raw.op === "not-contains") op = "not-contains";
    if (op === "contains") {
      if (v && v !== "!") self._filters[key] = v;
      else                delete self._filters[key];
    } else {
      if (v) self._filters[key] = { op: "not-contains", q: v };
      else   delete self._filters[key];
    }
    self._updateTextOpUI(th, key);
    self._onChange();
  }
  inp.addEventListener("input", debounce(commitText, 200));

  opBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    var willOpen = pop.hasAttribute("hidden");
    document.querySelectorAll(".sf-multi-popover").forEach(function (p) { p.setAttribute("hidden", ""); });
    if (willOpen) {
      pop.removeAttribute("hidden");
      self._positionPopover(opBtn, pop);
    }
  });
  pop.addEventListener("click", function (e) {
    var row = e.target.closest(".sf-op-row");
    if (!row) return;
    var op = row.getAttribute("data-op");
    pop.setAttribute("hidden", "");
    if (op === "empty" || op === "notempty") {
      self._filters[key] = { op: op };
    } else if (op === "not-contains") {
      var v = inp.value.trim();
      if (v) self._filters[key] = { op: "not-contains", q: v };
      else   delete self._filters[key];
    } else {
      // contains (default) — drop any prior object form, leave plain text input
      var v2 = inp.value.trim();
      if (v2) self._filters[key] = v2;
      else    delete self._filters[key];
    }
    self._updateTextOpUI(th, key);
    self._onChange();
  });
};

TableSF.prototype._updateTextOpUI = function (th, key) {
  var wrap = th.querySelector(".sf-filter-text");
  if (!wrap) return;
  var opBtn = wrap.querySelector(".sf-filter-op");
  var inp   = wrap.querySelector(".sf-filter");
  var raw   = this._filters[key];
  var op    = "contains";
  if (raw && typeof raw === "object" && raw.op) op = raw.op;
  if (op === "empty" || op === "notempty") {
    // Don't write a sentinel value into the input — keeping value empty means
    // switching back to "contains" doesn't accidentally commit "(is empty)" as
    // the search query. Placeholder communicates the state instead.
    inp.value = "";
    inp.readOnly = true;
    inp.classList.add("sf-filter-readonly");
    inp.placeholder = (op === "empty" ? "(is empty)" : "(is not empty)");
  } else {
    inp.readOnly = false;
    inp.classList.remove("sf-filter-readonly");
    inp.placeholder = "filter…";
    if (raw && typeof raw === "object" && raw.op === "not-contains") {
      if (inp.value !== raw.q) inp.value = raw.q || "";
    } else if (typeof raw === "string") {
      if (inp.value !== raw) inp.value = raw;
    }
  }
  var active = (raw != null);
  opBtn.classList.toggle("sf-filter-op-active", !!active);
  opBtn.title = "Filter mode — current: " + (
    op === "empty"        ? "is empty" :
    op === "notempty"     ? "is not empty" :
    op === "not-contains" ? "does not contain" :
                            "contains text"
  );
};

TableSF.prototype._wireDateFilter = function (th, key) {
  var self = this;
  var wrap = th.querySelector(".sf-filter-date");
  var btn  = wrap.querySelector(".sf-date-button");
  var pop  = wrap.querySelector(".sf-date-popover");
  var fromInp = pop.querySelector('input[data-sf-date="from"]');
  var toInp   = pop.querySelector('input[data-sf-date="to"]');
  var clearBtn = pop.querySelector(".sf-btn-clear");

  wrap.addEventListener("click", function (e) { e.stopPropagation(); });
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    var willOpen = pop.hasAttribute("hidden");
    document.querySelectorAll(".sf-multi-popover").forEach(function (p) { p.setAttribute("hidden", ""); });
    if (willOpen) {
      pop.removeAttribute("hidden");
      self._positionPopover(btn, pop);
    }
  });

  function commit() {
    var from = fromInp.value || null;
    var to   = toInp.value   || null;
    if (!from && !to) delete self._filters[key];
    else self._filters[key] = { type: "date", from: from, to: to };
    self._updateDateButtonLabel(th, key);
    self._onChange();
  }
  fromInp.addEventListener("change", commit);
  toInp.addEventListener("change", commit);
  clearBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    fromInp.value = "";
    toInp.value = "";
    delete self._filters[key];
    self._updateDateButtonLabel(th, key);
    self._onChange();
  });
};

TableSF.prototype._updateDateButtonLabel = function (th, key) {
  var btn = th.querySelector(".sf-date-button");
  if (!btn) return;
  var raw = this._filters[key];
  function fmt(s) {
    if (!s) return "";
    var d = new Date(s + "T00:00:00");
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  if (raw && raw.type === "date" && (raw.from || raw.to)) {
    var label;
    if (raw.from && raw.to) label = fmt(raw.from) + " – " + fmt(raw.to);
    else if (raw.from)      label = "Since " + fmt(raw.from);
    else                    label = "Until " + fmt(raw.to);
    btn.textContent = label;
    btn.classList.add("sf-multi-active");
  } else {
    btn.textContent = "Any date";
    btn.classList.remove("sf-multi-active");
  }
};

TableSF.prototype._isEmptyValue = function (v) {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
};

TableSF.prototype._parseOptions = function (raw) {
  return String(raw || "").split("|").filter(function (s) { return s.length > 0; }).map(function (entry) {
    var idx = entry.indexOf("=");
    if (idx >= 0) return { value: entry.slice(0, idx), label: entry.slice(idx + 1) };
    return { value: entry, label: entry.charAt(0).toUpperCase() + entry.slice(1).replace(/_/g, " ") };
  });
};

TableSF.prototype._renderOptionList = function (opts) {
  return opts.map(function (o) {
    return '<label class="sf-multi-option">' +
      '<input type="checkbox" value="' + escapeHtml(o.value) + '">' +
      '<span>' + escapeHtml(o.label) + '</span></label>';
  }).join("");
};

// Repopulate a multi-select column's checkbox list at runtime. Used when
// options are derived from the loaded data (e.g. integration names). Existing
// checked values are preserved if they still exist in the new option set.
TableSF.prototype.setColumnOptions = function (key, options) {
  if (!this._thead) return;
  var th = this._thead.querySelector('th[data-sf-key="' + key + '"]');
  if (!th) return;
  var pop = th.querySelector(".sf-multi-popover");
  if (!pop) return;
  var prevChecked = Array.prototype.slice.call(
    pop.querySelectorAll('input[type="checkbox"]:checked')
  ).map(function (cb) { return cb.value; });
  // Accept either an array of strings or { value, label } objects.
  var normalized = (options || []).map(function (o) {
    if (typeof o === "string") return { value: o, label: o };
    return { value: String(o.value), label: String(o.label != null ? o.label : o.value) };
  });
  pop.innerHTML = this._renderOptionList(normalized);
  var preserved = [];
  pop.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
    if (prevChecked.indexOf(cb.value) >= 0) { cb.checked = true; preserved.push(cb.value); }
  });
  // Also preserve any saved-pref values that aren't in the live DOM yet.
  var saved = this._filters[key];
  if (Array.isArray(saved)) {
    pop.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      if (!cb.checked && saved.indexOf(cb.value) >= 0) { cb.checked = true; preserved.push(cb.value); }
    });
  }
  if (preserved.length) this._filters[key] = preserved;
  else delete this._filters[key];
  this._updateMultiButtonLabel(th);
};

TableSF.prototype._positionPopover = function (btn, pop) {
  var r = btn.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.top  = (r.bottom + 2) + "px";
  pop.style.left = r.left + "px";
  pop.style.minWidth = r.width + "px";
};

TableSF.prototype._updateMultiButtonLabel = function (th) {
  var btn = th.querySelector(".sf-multi-button");
  var pop = th.querySelector(".sf-multi-popover");
  if (!btn || !pop) return;
  var checked = pop.querySelectorAll('input[type="checkbox"]:checked');
  if (checked.length === 0) {
    btn.textContent = "All";
    btn.classList.remove("sf-multi-active");
  } else if (checked.length === 1) {
    btn.textContent = checked[0].nextElementSibling.textContent;
    btn.classList.add("sf-multi-active");
  } else if (checked.length === pop.querySelectorAll('input[type="checkbox"]').length) {
    btn.textContent = "All";
    btn.classList.remove("sf-multi-active");
  } else {
    btn.textContent = checked.length + " selected";
    btn.classList.add("sf-multi-active");
  }
};

TableSF.prototype.restoreFilterUI = function () {
  var self = this;
  if (!self._thead) return;
  self._thead.querySelectorAll("th[data-sf-key]").forEach(function (th) {
    var key = th.getAttribute("data-sf-key");
    var raw = self._filters[key];
    var multi = th.querySelector(".sf-filter-multi");
    var dateWrap = th.querySelector(".sf-filter-date");
    var textWrap = th.querySelector(".sf-filter-text");
    if (multi) {
      var values = Array.isArray(raw) ? raw : [];
      if (!Array.isArray(raw) && raw != null) delete self._filters[key];
      multi.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
        cb.checked = values.indexOf(cb.value) >= 0;
      });
      self._updateMultiButtonLabel(th);
    } else if (dateWrap) {
      var fromInp = dateWrap.querySelector('input[data-sf-date="from"]');
      var toInp   = dateWrap.querySelector('input[data-sf-date="to"]');
      if (raw && raw.type === "date") {
        if (fromInp) fromInp.value = raw.from || "";
        if (toInp)   toInp.value   = raw.to   || "";
      } else {
        if (raw != null) delete self._filters[key];
        if (fromInp) fromInp.value = "";
        if (toInp)   toInp.value   = "";
      }
      self._updateDateButtonLabel(th, key);
    } else if (textWrap) {
      var inp = textWrap.querySelector(".sf-filter");
      if (inp) {
        if (typeof raw === "string") {
          inp.value = raw;
        } else if (raw && typeof raw === "object" && raw.op === "not-contains") {
          inp.value = raw.q || "";
        } else if (raw && typeof raw === "object" && (raw.op === "empty" || raw.op === "notempty")) {
          // _updateTextOpUI sets the readonly placeholder
        } else {
          inp.value = "";
          if (raw != null) delete self._filters[key];
        }
      }
      self._updateTextOpUI(th, key);
    }
  });
};

TableSF.prototype.clearFilters = function () {
  this._filters = {};
  this.restoreFilterUI();
};

TableSF.prototype._updateIcons = function () {
  var self = this;
  this._thead.querySelectorAll("th[data-sf-key]").forEach(function (th) {
    var icon = th.querySelector(".sf-sort-icon");
    if (!icon) return;
    var active = th.getAttribute("data-sf-key") === self._sortKey;
    icon.textContent = active ? (self._sortDir === "asc" ? "▲" : "▼") : "⇅";
    icon.classList.toggle("sf-sort-active", active);
  });
};

TableSF.prototype._val = function (row, key) {
  var v = row;
  key.split(".").forEach(function (p) { v = v != null ? v[p] : null; });
  if (Array.isArray(v)) return v.join(" ");
  return v == null ? "" : v;
};

// Same path resolution as _val but without coercing null/array — used by the
// is-empty / is-not-empty / date-range filters that need to inspect the raw
// underlying value (so a literal "0" or false isn't mistaken for null, and so
// a missing string and an empty array are both correctly classified as empty).
TableSF.prototype._rawVal = function (row, key) {
  var v = row;
  key.split(".").forEach(function (p) { v = v != null ? v[p] : null; });
  return v;
};

TableSF.prototype._ipNum = function (ip) {
  var s = String(ip || "").trim();
  if (!s) return 0n;
  var slash = s.indexOf("/");
  if (slash >= 0) s = s.slice(0, slash);
  if (s.indexOf(":") >= 0) return this._ipv6Num(s);
  var p = s.split(".");
  if (p.length !== 4) return 0n;
  var n = 0n;
  for (var i = 0; i < 4; i++) n = (n << 8n) | BigInt(parseInt(p[i], 10) || 0);
  return n;
};

TableSF.prototype._ipv6Num = function (addr) {
  // Convert a trailing dotted-quad (IPv4-mapped) into two hex groups.
  var lastColon = addr.lastIndexOf(":");
  var tail = addr.slice(lastColon + 1);
  if (tail.indexOf(".") >= 0) {
    var o = tail.split(".");
    if (o.length === 4) {
      var hi = ((parseInt(o[0], 10) || 0) << 8 | (parseInt(o[1], 10) || 0)).toString(16);
      var lo = ((parseInt(o[2], 10) || 0) << 8 | (parseInt(o[3], 10) || 0)).toString(16);
      addr = addr.slice(0, lastColon + 1) + hi + ":" + lo;
    }
  }

  // Expand "::" shorthand into enough zero groups to reach 8 total.
  var parts;
  var dbl = addr.indexOf("::");
  if (dbl >= 0) {
    var leftStr  = addr.slice(0, dbl);
    var rightStr = addr.slice(dbl + 2);
    var left  = leftStr  ? leftStr.split(":")  : [];
    var right = rightStr ? rightStr.split(":") : [];
    var missing = 8 - left.length - right.length;
    if (missing < 0) return 0n;
    var middle = [];
    for (var i = 0; i < missing; i++) middle.push("0");
    parts = left.concat(middle).concat(right);
  } else {
    parts = addr.split(":");
  }

  if (parts.length !== 8) return 0n;
  var n = 0n;
  for (var j = 0; j < 8; j++) n = (n << 16n) | BigInt(parseInt(parts[j] || "0", 16) || 0);
  return n;
};

TableSF.prototype.apply = function (data) {
  var self = this;
  var result = data;

  var fKeys = Object.keys(self._filters);
  if (fKeys.length) {
    result = result.filter(function (row) {
      return fKeys.every(function (k) {
        var raw = self._filters[k];
        if (Array.isArray(raw)) {
          if (!raw.length) return true;
          var rv = String(self._val(row, k)).toLowerCase();
          for (var i = 0; i < raw.length; i++) {
            if (rv === String(raw[i]).toLowerCase()) return true;
          }
          return false;
        }
        if (raw && typeof raw === "object") {
          // Operator-based text filter
          if (raw.op === "empty")    return self._isEmptyValue(self._rawVal(row, k));
          if (raw.op === "notempty") return !self._isEmptyValue(self._rawVal(row, k));
          if (raw.op === "not-contains") {
            var qn = String(raw.q || "").toLowerCase();
            if (!qn) return true;
            return !String(self._val(row, k)).toLowerCase().includes(qn);
          }
          // Date range
          if (raw.type === "date") {
            var rv2 = self._rawVal(row, k);
            if (rv2 == null || rv2 === "") return false;
            var d = new Date(rv2);
            if (isNaN(d.getTime())) return false;
            if (raw.from) {
              var fromD = new Date(raw.from + "T00:00:00");
              if (d < fromD) return false;
            }
            if (raw.to) {
              var toD = new Date(raw.to + "T23:59:59.999");
              if (d > toD) return false;
            }
            return true;
          }
          return true;
        }
        var exclude = raw.charAt(0) === "!";
        var q       = (exclude ? raw.slice(1) : raw).toLowerCase();
        if (!q) return true;
        var match = String(self._val(row, k)).toLowerCase().includes(q);
        return exclude ? !match : match;
      });
    });
  }

  if (self._sortKey) {
    var k    = self._sortKey;
    var thEl = self._thead.querySelector('th[data-sf-key="' + k + '"]');
    var type = thEl ? (thEl.getAttribute("data-sf-type") || "string") : "string";
    var dir  = self._sortDir === "asc" ? 1 : -1;
    result = result.slice().sort(function (a, b) {
      var av = self._val(a, k), bv = self._val(b, k);
      if (type === "number") return (parseFloat(av) - parseFloat(bv)) * dir;
      if (type === "date")   return (new Date(av)   - new Date(bv))   * dir;
      if (type === "ip") {
        var ai = self._ipNum(av), bi = self._ipNum(bv);
        return (ai < bi ? -1 : ai > bi ? 1 : 0) * dir;
      }
      var as = String(av).toLowerCase(), bs = String(bv).toLowerCase();
      return (as < bs ? -1 : as > bs ? 1 : 0) * dir;
    });
  }

  return result;
};

/**
 * setupColumnLayout(tableEl, options) — Resizable column widths + show/hide
 * column chooser. Independent of TableSF (works on any <table>) so the Events
 * page (which doesn't use TableSF) can use it too.
 *
 * Each <th> is given a stable column id derived from data-sf-key, then
 * data-col-id, then "__col<index>". Columns marked data-col-required="true"
 * (or with class "cb-col" / "fav-col") cannot be hidden via the chooser.
 *
 * options:
 *   chooserButton  — element; clicking it toggles the column chooser popover
 *   onChange       — callback invoked when widths or hidden cols change
 *   labelFor       — fn(thEl) -> string label override for the chooser entry
 *
 * Returns { getPrefs, setPrefs, openChooser, refresh } so callers can persist
 * { widths, hidden } themselves alongside their other prefs.
 */
function setupColumnLayout(tableEl, options) {
  options = options || {};
  if (!tableEl) return null;
  var thead = tableEl.querySelector("thead");
  if (!thead) return null;
  var headerRow = thead.querySelector("tr");
  if (!headerRow) return null;
  var ths = Array.prototype.slice.call(headerRow.children);
  if (!ths.length) return null;

  var colIds = ths.map(function (th, i) {
    var id = th.getAttribute("data-sf-key") ||
             th.getAttribute("data-col-id") ||
             ("__col" + i);
    th.setAttribute("data-col-id", id);
    return id;
  });

  var required = {};
  ths.forEach(function (th, i) {
    if (th.classList.contains("cb-col") || th.classList.contains("fav-col")) required[colIds[i]] = true;
    if (th.getAttribute("data-col-required") === "true") required[colIds[i]] = true;
  });

  // Inject a colgroup so widths apply consistently to header + body.
  var colgroup = tableEl.querySelector("colgroup");
  if (!colgroup) {
    colgroup = document.createElement("colgroup");
    ths.forEach(function () { colgroup.appendChild(document.createElement("col")); });
    tableEl.insertBefore(colgroup, thead);
  } else {
    while (colgroup.children.length < ths.length) colgroup.appendChild(document.createElement("col"));
  }
  var cols = Array.prototype.slice.call(colgroup.children).slice(0, ths.length);

  // Per-table <style> block holding hide rules. Targeted by data-sf-table-id
  // so multiple tables on the same page don't collide.
  var tableId = tableEl.getAttribute("data-sf-table-id");
  if (!tableId) {
    tableId = "sftbl-" + Math.random().toString(36).slice(2, 9);
    tableEl.setAttribute("data-sf-table-id", tableId);
  }
  var styleEl = document.getElementById("sf-style-" + tableId);
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "sf-style-" + tableId;
    document.head.appendChild(styleEl);
  }

  var widths = {};
  var hidden = {};

  function rewriteHideStyle() {
    var rules = [];
    var sel = 'table[data-sf-table-id="' + tableId + '"]';
    Object.keys(hidden).forEach(function (id) {
      var idx = colIds.indexOf(id);
      if (idx < 0) return;
      var n = idx + 1;
      rules.push(sel + ' > thead > tr > :nth-child(' + n + ') { display: none; }');
      rules.push(sel + ' > tbody > tr > :nth-child(' + n + ') { display: none; }');
      rules.push(sel + ' > colgroup > col:nth-child(' + n + ') { display: none; }');
    });
    styleEl.textContent = rules.join("\n");
  }

  function applyWidths() {
    var anyWidth = false;
    colIds.forEach(function (id, i) {
      var w = widths[id];
      if (typeof w === "number" && w > 0) {
        cols[i].style.width = w + "px";
        anyWidth = true;
      } else {
        cols[i].style.width = "";
      }
    });
    tableEl.style.tableLayout = anyWidth ? "fixed" : "";
  }

  function ensureAllWidthsMeasured() {
    // Capture rendered widths on first resize so switching to fixed layout
    // doesn't collapse the columns the user hasn't touched yet.
    colIds.forEach(function (id, i) {
      if (widths[id] != null) return;
      var rect = ths[i].getBoundingClientRect();
      if (rect.width > 0) widths[id] = Math.round(rect.width);
    });
  }

  ths.forEach(function (th, i) {
    if (th.querySelector(".sf-resize-handle")) return;
    if (!th.style.position) th.style.position = "relative";
    var handle = document.createElement("span");
    handle.className = "sf-resize-handle";
    handle.title = "Drag to resize";
    th.appendChild(handle);
    handle.addEventListener("click", function (e) { e.stopPropagation(); });
    handle.addEventListener("mousedown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      ensureAllWidthsMeasured();
      var id = colIds[i];
      var startX = e.clientX;
      var startW = widths[id] || ths[i].getBoundingClientRect().width;
      function onMove(ev) {
        var w = Math.max(40, Math.round(startW + (ev.clientX - startX)));
        widths[id] = w;
        applyWidths();
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.classList.remove("sf-resizing");
        if (typeof options.onChange === "function") options.onChange();
      }
      document.body.classList.add("sf-resizing");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });

  var chooserPop = null;
  function buildChooser() {
    if (chooserPop) return chooserPop;
    chooserPop = document.createElement("div");
    chooserPop.className = "sf-col-chooser sf-multi-popover";
    chooserPop.setAttribute("hidden", "");
    chooserPop.addEventListener("click", function (e) { e.stopPropagation(); });
    chooserPop.addEventListener("change", function (e) {
      if (!e.target || e.target.type !== "checkbox") return;
      var id = e.target.getAttribute("data-col-id");
      if (!id) return;
      if (e.target.checked) delete hidden[id];
      else hidden[id] = true;
      rewriteHideStyle();
      if (typeof options.onChange === "function") options.onChange();
    });
    document.body.appendChild(chooserPop);
    return chooserPop;
  }

  function renderChooser() {
    buildChooser();
    var html = '<div class="sf-col-chooser-title">Show columns</div>';
    var any = false;
    ths.forEach(function (th, i) {
      var id = colIds[i];
      if (required[id]) return;
      any = true;
      var label = (typeof options.labelFor === "function" ? options.labelFor(th) : null);
      if (!label) {
        var labelEl = th.querySelector(".sf-label");
        label = labelEl ? labelEl.textContent.trim() : th.textContent.trim();
      }
      if (!label) label = id;
      var checked = hidden[id] ? "" : "checked";
      html += '<label class="sf-col-chooser-row sf-multi-option">' +
        '<input type="checkbox" data-col-id="' + escapeHtml(id) + '" ' + checked + '>' +
        '<span>' + escapeHtml(label) + '</span></label>';
    });
    if (!any) html += '<div class="sf-col-chooser-empty">No optional columns.</div>';
    chooserPop.innerHTML = html;
  }

  function openChooser(triggerEl) {
    renderChooser();
    document.querySelectorAll(".sf-multi-popover").forEach(function (p) { p.setAttribute("hidden", ""); });
    chooserPop.removeAttribute("hidden");
    var anchor = triggerEl || options.chooserButton || tableEl;
    var r = anchor.getBoundingClientRect();
    chooserPop.style.position = "fixed";
    chooserPop.style.top  = (r.bottom + 4) + "px";
    chooserPop.style.left = Math.max(8, r.right - 240) + "px";
    chooserPop.style.minWidth = "220px";
  }

  if (options.chooserButton) {
    options.chooserButton.addEventListener("click", function (e) {
      e.stopPropagation();
      var willOpen = !chooserPop || chooserPop.hasAttribute("hidden");
      document.querySelectorAll(".sf-multi-popover").forEach(function (p) { p.setAttribute("hidden", ""); });
      if (willOpen) openChooser(options.chooserButton);
    });
  }

  // Reuse the doc-wide popover-close wiring TableSF._setup installs. If no
  // TableSF has been instantiated on the page (e.g. Events), install it here.
  if (!TableSF._docWired) {
    TableSF._docWired = true;
    var closeAll = function () {
      document.querySelectorAll(".sf-multi-popover").forEach(function (p) { p.setAttribute("hidden", ""); });
    };
    document.addEventListener("click", closeAll);
    window.addEventListener("scroll", closeAll, true);
    window.addEventListener("resize", closeAll);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeAll();
    });
  }

  return {
    getPrefs: function () {
      return { widths: Object.assign({}, widths), hidden: Object.keys(hidden) };
    },
    setPrefs: function (p) {
      if (!p) return;
      if (p.widths && typeof p.widths === "object") {
        Object.keys(p.widths).forEach(function (id) {
          var v = p.widths[id];
          if (typeof v === "number" && v > 0) widths[id] = v;
        });
      }
      if (Array.isArray(p.hidden)) {
        p.hidden.forEach(function (id) {
          if (!required[id]) hidden[id] = true;
        });
      }
      applyWidths();
      rewriteHideStyle();
    },
    openChooser: openChooser,
    refresh: function () { applyWidths(); rewriteHideStyle(); },
  };
}
