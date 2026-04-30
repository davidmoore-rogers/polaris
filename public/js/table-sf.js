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
    } else {
      th.innerHTML = headerHtml +
        '<input class="sf-filter" type="text" placeholder="filter…"' +
          ' title="Type to filter. Prefix with ! to exclude rows (e.g. !foo).">';
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
    } else {
      var inp = th.querySelector(".sf-filter");
      inp.addEventListener("click", function (e) { e.stopPropagation(); });
      inp.addEventListener("input", debounce(function () {
        var v = inp.value.trim();
        if (v && v !== "!") self._filters[key] = v;
        else                delete self._filters[key];
        self._onChange();
      }, 200));
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
    if (multi) {
      var values = Array.isArray(raw) ? raw : [];
      // Drop any restored values that aren't actually a string filter for
      // the legacy text-input variant of this column.
      if (!Array.isArray(raw) && raw != null) delete self._filters[key];
      multi.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
        cb.checked = values.indexOf(cb.value) >= 0;
      });
      self._updateMultiButtonLabel(th);
    } else {
      var inp = th.querySelector(".sf-filter");
      if (inp) {
        if (typeof raw === "string") inp.value = raw;
        else { inp.value = ""; if (raw != null) delete self._filters[key]; }
      }
    }
  });
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
