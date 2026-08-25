/**
 * public/js/discovery-portability.js — one network **Discovery** as a file.
 *
 * `window.PolarisDiscoveryPortability`. Export writes a `.discovery.json`;
 * import reads one back in the BROWSER (no upload route, no multer) and hands
 * the wizard a draft that saves through the ordinary `POST /network-scans`, so
 * the server's schema plus `networkScanService.validateScanInput` stay the
 * authority.
 *
 * Modelled on automations-portability.js in shape, not by extension — that
 * module is automation-specific throughout.
 *
 * **The `dependencies` block comes first**, because that is what a human
 * opening the file reads. Everything install-specific is STRIPPED from the
 * configuration and recorded there by NAME instead:
 *
 *   - **Credential IDs.** They are the only install-specific ids a Discovery
 *     carries, and they are also the security half: a credential id is useless
 *     elsewhere but it is a pointer into another install's secret store, and
 *     the file is something operators email and commit. So the export records
 *     "snmp credential: public" and the importer re-picks on step 3.
 *   - **The row's own identity** (`id`, `createdBy`, timestamps, `lastRunAt`)
 *     and any run state that came along for the ride (`runId` / `hits` /
 *     `selected`). Run state is not configuration; carrying results into
 *     another install would offer devices that are not on its network.
 *
 * Two traps this module exists to hold, each pinned by a test:
 *
 *   (a) **An imported Discovery must never carry a foreign id.** That is a
 *       property of the CODE, not a promise about the file, so
 *       `parseImportFile` re-strips on the way IN. Without it a hand-edited
 *       file with someone else's `id` would make the wizard's first save a PUT
 *       against an unrelated row.
 *   (b) **A method whose credentials were stripped is left as an EMPTY list,
 *       never dropped.** `validateScanInput` refuses a credentialed method with
 *       no credential, which is exactly the error the operator should see —
 *       dropping the method instead would silently change what the Discovery
 *       does, and an SNMP scan quietly demoted to ICMP-only looks like it ran
 *       fine and found nothing.
 *
 * **Depends on globals** — `escapeHtml` (app.js). Load after api.js/app.js;
 * the wizard reads this namespace guardedly, so a page without it just hides
 * the Import/Export affordances.
 */

/* global escapeHtml */

(function () {
  "use strict";

  var FORMAT_VERSION = 1;
  var FILE_SUFFIX = ".discovery.json";
  /** Checked BEFORE the read — the deviceIcons upload precedent. */
  var MAX_IMPORT_BYTES = 256 * 1024;
  /** Bounds the recursive key walk, not the Discovery's own caps. */
  var MAX_DEPTH = 20;
  /** Matches name: z.string().min(1).max(200) on the route. */
  var MAX_NAME_LEN = 200;

  var METHOD_TYPES = ["icmp", "snmp", "restapi", "ssh", "winrm"];
  var TARGET_KINDS = ["cidr", "range", "single"];

  // ─── Names ────────────────────────────────────────────────────────────
  //
  // The filename IS the Discovery's name, both directions. A hostile filename
  // is an untidy name rather than an injection — names are escapeHtml'd
  // everywhere they render.

  function nameFromFilename(filename) {
    var base = String(filename || "").split(/[\\/]/).pop() || "";
    if (base.toLowerCase().endsWith(FILE_SUFFIX)) base = base.slice(0, -FILE_SUFFIX.length);
    else base = base.replace(/\.[^.]*$/, "");
    /* eslint-disable-next-line no-control-regex */
    base = base.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
    if (!base || base === "." || base === "..") return "";
    return base.length > MAX_NAME_LEN ? base.slice(0, MAX_NAME_LEN) : base;
  }

  function filenameForExport(name) {
    /* eslint-disable-next-line no-control-regex */
    var safe = String(name || "").replace(/[\u0000-\u001F\u007F]/g, "")
      .replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
    if (safe.length > 120) safe = safe.slice(0, 120);
    return (safe || "discovery") + FILE_SUFFIX;
  }

  // ─── Safety ───────────────────────────────────────────────────────────

  /**
   * Refuse prototype-polluting keys and unbounded nesting.
   *
   * `JSON.parse` itself is safe; the parsed object is copied into the wizard
   * draft, which is where pollution would bite.
   */
  function assertSafeKeys(value, depth) {
    if (depth > MAX_DEPTH) throw new Error("That file is nested too deeply to be a Discovery.");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) assertSafeKeys(value[i], depth + 1);
      return;
    }
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error("That file contains a key Polaris will not read (" + key + ").");
      }
      assertSafeKeys(value[key], depth + 1);
    }
  }

  function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  // ─── Dependencies ─────────────────────────────────────────────────────

  /**
   * A dependency is something this Discovery needs that a DEFAULT Polaris
   * install would not have. Things every install has — the five probe methods,
   * the target kinds — are deliberately not listed, or the block would be noise.
   */
  function makeDeps() {
    var seen = {};
    var list = [];
    return {
      add: function (kind, name, usedFor) {
        var key = kind + "\u0000" + name;
        if (seen[key]) {
          if (usedFor && seen[key].usedFor.indexOf(usedFor) === -1) seen[key].usedFor.push(usedFor);
          return;
        }
        var row = { kind: kind, name: name, usedFor: usedFor ? [usedFor] : [] };
        seen[key] = row;
        list.push(row);
      },
      list: function () {
        return list.map(function (r) {
          var out = { kind: r.kind, name: r.name };
          if (r.usedFor.length) out.usedFor = r.usedFor.slice();
          return out;
        });
      },
    };
  }

  /**
   * Compare a file's declared dependencies against this install.
   *
   * A kind with no catalogue returns `present: null` — "can't tell" — never a
   * false "missing". Matching is case-insensitive on the name.
   */
  function checkDependencies(dependencies, catalogs) {
    var creds = ((catalogs || {}).credentials || []).map(function (c) {
      return String((c && c.name) || "").toLowerCase();
    });
    return (dependencies || []).map(function (d) {
      var out = { kind: d.kind, name: d.name, usedFor: d.usedFor || [], present: null };
      if (d.kind === "credential") {
        out.present = creds.indexOf(String(d.name || "").toLowerCase()) !== -1;
      }
      return out;
    });
  }

  // ─── Strip ────────────────────────────────────────────────────────────

  function portableTargets(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var t = raw[i];
      if (!isPlainObject(t)) continue;
      if (TARGET_KINDS.indexOf(t.kind) === -1) continue;
      if (typeof t.value !== "string" || !t.value.trim()) continue;
      out.push({ kind: t.kind, value: t.value.trim() });
    }
    return out;
  }

  /**
   * Methods with their credentials replaced by an empty list, and each named
   * credential recorded as a dependency.
   *
   * The method itself survives with `credentialIds: []` — see trap (b) in the
   * file header. `validateScanInput` will refuse to save it until the importer
   * picks credentials, which is the error they should see.
   */
  function portableMethods(raw, deps, resolveName) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    var seen = {};
    for (var i = 0; i < raw.length; i++) {
      var m = raw[i];
      if (!isPlainObject(m)) continue;
      if (METHOD_TYPES.indexOf(m.type) === -1) continue;
      if (seen[m.type]) continue;
      seen[m.type] = 1;
      var ids = Array.isArray(m.credentialIds) ? m.credentialIds : [];
      for (var j = 0; j < ids.length; j++) {
        var name = (typeof resolveName === "function" && resolveName(ids[j])) || ids[j];
        deps.add("credential", String(name), m.type);
      }
      out.push({ type: m.type, credentialIds: [] });
    }
    return out;
  }

  /**
   * `autoMonitor` travels as-is.
   *
   * It names interfaces, mount paths, patterns and interface types — device
   * facts, not install ids — so there is nothing install-specific to strip and
   * nothing worth listing as a dependency. A selection naming ports the target
   * install doesn't have simply pins nothing, which the pure resolvers already
   * handle.
   */
  function portableAutoMonitor(raw) {
    if (!isPlainObject(raw)) return null;
    var keys = Object.keys(raw);
    if (!keys.length) return null;
    var out = {};
    for (var i = 0; i < keys.length; i++) {
      if (isPlainObject(raw[keys[i]])) out[keys[i]] = raw[keys[i]];
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * Strip a Discovery for export.
   *
   * The stripped `scan` is exactly a route request body, so **every export is a
   * valid import** — that property is the headline unit test.
   */
  function stripForExport(scan, catalogs) {
    var deps = makeDeps();
    var resolveName = (catalogs || {}).credentialName;
    var out = {
      name: String((scan && scan.name) || "").trim(),
      description: (scan && scan.description) ? String(scan.description) : null,
      targets: portableTargets(scan && scan.targets),
      methods: portableMethods(scan && scan.methods, deps, resolveName),
      autoMonitor: portableAutoMonitor(scan && scan.autoMonitor),
    };
    return {
      scan: out,
      dependencies: deps.list(),
      needsCredentials: out.methods.some(function (m) { return m.type !== "icmp"; }),
    };
  }

  function buildExportFile(scan, catalogs, meta) {
    var stripped = stripForExport(scan, catalogs);
    var file = { polarisDiscovery: FORMAT_VERSION, exportedAt: new Date().toISOString() };
    if (meta && meta.polarisVersion) file.polarisVersion = meta.polarisVersion;
    // dependencies FIRST — the nested schemas are strict, so a hint cannot live
    // next to the thing it describes; the envelope is the only place.
    file.dependencies = stripped.dependencies;
    if (stripped.needsCredentials) file.needsCredentialSelection = true;
    file.scan = stripped.scan;
    return file;
  }

  // ─── Import ───────────────────────────────────────────────────────────

  /**
   * Parse a `.discovery.json` (or a bare configuration someone pasted out of
   * one) into a wizard draft.
   *
   * Throws with an operator-facing message for anything unusable; a version
   * mismatch is a non-fatal `problems[]` entry rather than a refusal, since the
   * shape may still be readable.
   */
  function parseImportFile(text, filename) {
    var raw = String(text || "");
    if (!raw.trim()) throw new Error("That file is empty.");
    if (raw.length > MAX_IMPORT_BYTES) throw new Error("That file is too large to be a Discovery.");

    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) { throw new Error("That file isn't valid JSON."); }
    assertSafeKeys(parsed, 0);
    if (!isPlainObject(parsed)) throw new Error("That file doesn't contain a Discovery.");

    var problems = [];
    if (parsed.polarisDiscovery != null && Number(parsed.polarisDiscovery) !== FORMAT_VERSION) {
      problems.push("The file says format version " + parsed.polarisDiscovery +
        "; this Polaris reads version " + FORMAT_VERSION + ". Check the targets and methods.");
    }

    // Accept a bare configuration too — someone may have pasted one.
    var scan = isPlainObject(parsed.scan) ? parsed.scan : parsed;
    if (!Array.isArray(scan.targets) || !scan.targets.length) {
      throw new Error("That file names no targets to scan.");
    }

    var name = nameFromFilename(filename);
    if (!name) throw new Error("Rename the file — its name becomes the Discovery's name.");

    // Re-strip on the way IN: "an import never carries a foreign id" is a
    // property of this code, not a promise about the file.
    var restripped = stripForExport(scan, {});
    restripped.scan.name = name;
    if (!restripped.scan.targets.length) {
      throw new Error("None of that file's targets are usable (each needs a kind and a value).");
    }
    if (!restripped.scan.methods.length) {
      throw new Error("That file names no probe methods.");
    }

    return {
      scan: restripped.scan,
      name: name,
      dependencies: Array.isArray(parsed.dependencies) && parsed.dependencies.length
        ? parsed.dependencies
        : restripped.dependencies,
      needsCredentials: parsed.needsCredentialSelection === true || restripped.needsCredentials,
      problems: problems,
    };
  }

  window.PolarisDiscoveryPortability = {
    FORMAT_VERSION: FORMAT_VERSION,
    FILE_SUFFIX: FILE_SUFFIX,
    MAX_IMPORT_BYTES: MAX_IMPORT_BYTES,
    nameFromFilename: nameFromFilename,
    filenameForExport: filenameForExport,
    stripForExport: stripForExport,
    buildExportFile: buildExportFile,
    parseImportFile: parseImportFile,
    checkDependencies: checkDependencies,
    assertSafeKeys: assertSafeKeys,
  };
})();
