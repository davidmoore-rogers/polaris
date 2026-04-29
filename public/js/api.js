/**
 * public/js/api.js — Thin fetch wrapper for /api/v1
 */

const API_BASE = "/api/v1";

// ─── Active Query Tracker ───────────────────────────────────────────────────

var activeQueries = [];
var _onQueriesChanged = null;

function _registerQuery(label, controller) {
  var entry = { id: Date.now() + Math.random(), label: label, controller: controller };
  activeQueries.push(entry);
  if (_onQueriesChanged) _onQueriesChanged();
  return entry.id;
}

function _unregisterQuery(id) {
  activeQueries = activeQueries.filter(function (q) { return q.id !== id; });
  if (_onQueriesChanged) _onQueriesChanged();
}

function abortAllQueries() {
  activeQueries.forEach(function (q) { q.controller.abort(); });
  activeQueries = [];
  if (_onQueriesChanged) _onQueriesChanged();
}

// Read a cookie by name. Used to pull the CSRF token the server sets
// via the synchronizer-token middleware.
function _readCookie(name) {
  var m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.$?*|{}()[\]\\\/+^]/g, "\\$&") + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

// Build a headers object prefilled with the CSRF token. Use for direct
// fetch() calls that bypass the shared `request()` helper (file uploads,
// blob downloads, etc).
function _csrfHeaders(extra) {
  var headers = extra ? Object.assign({}, extra) : {};
  var csrf = _readCookie("shelob_csrf");
  if (csrf) headers["X-CSRF-Token"] = csrf;
  return headers;
}

async function request(method, path, body, signal) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  if (signal) opts.signal = signal;

  // Attach CSRF token on state-changing methods. GETs are exempt.
  var upper = method.toUpperCase();
  if (upper !== "GET" && upper !== "HEAD" && upper !== "OPTIONS") {
    var csrf = _readCookie("shelob_csrf");
    if (csrf) opts.headers["X-CSRF-Token"] = csrf;
  }

  const res = await fetch(API_BASE + path, opts);

  if (res.status === 204) return null;
  if (res.status === 401) { window.location.href = "/login.html"; return; }

  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function trackedRequest(label, method, path, body) {
  var controller = new AbortController();
  var qid = _registerQuery(label, controller);
  return request(method, path, body, controller.signal)
    .finally(function () { _unregisterQuery(qid); });
}

const api = {
  blocks: {
    list:   (params) => request("GET", "/blocks" + toQuery(params)),
    get:    (id)     => request("GET", `/blocks/${id}`),
    create: (body)   => request("POST", "/blocks", body),
    update: (id, b)  => request("PUT", `/blocks/${id}`, b),
    delete: (id)     => request("DELETE", `/blocks/${id}`),
  },
  subnets: {
    list:          (params) => request("GET", "/subnets" + toQuery(params)),
    get:           (id)     => request("GET", `/subnets/${id}`),
    ips:           (id, params) => request("GET", `/subnets/${id}/ips` + toQuery(params)),
    create:        (body)   => request("POST", "/subnets", body),
    nextAvailable: (body)   => request("POST", "/subnets/next-available", body),
    bulkAllocate:  (body)   => request("POST", "/subnets/bulk-allocate", body),
    bulkAllocatePreview: (body) => request("POST", "/subnets/bulk-allocate/preview", body),
    update:        (id, b)  => request("PUT", `/subnets/${id}`, b),
    delete:        (id)     => request("DELETE", `/subnets/${id}`),
  },
  allocationTemplates: {
    list:   ()        => request("GET",    "/allocation-templates"),
    create: (body)    => request("POST",   "/allocation-templates", body),
    update: (id, b)   => request("PUT",    `/allocation-templates/${id}`, b),
    delete: (id)      => request("DELETE", `/allocation-templates/${id}`),
  },
  credentials: {
    list:   ()        => request("GET",    "/credentials"),
    get:    (id)      => request("GET",    `/credentials/${id}`),
    create: (body)    => request("POST",   "/credentials", body),
    update: (id, b)   => request("PUT",    `/credentials/${id}`, b),
    delete: (id)      => request("DELETE", `/credentials/${id}`),
  },
  reservations: {
    list:          (params) => request("GET", "/reservations" + toQuery(params)),
    get:           (id)     => request("GET", `/reservations/${id}`),
    create:        (body)   => request("POST", "/reservations", body),
    nextAvailable: (body)   => request("POST", "/reservations/next-available", body),
    update:        (id, b)  => request("PUT", `/reservations/${id}`, b),
    release:       (id)     => request("DELETE", `/reservations/${id}`),
  },
  utilization: {
    global:  ()   => request("GET", "/utilization"),
    block:   (id) => request("GET", `/utilization/blocks/${id}`),
    subnet:  (id) => request("GET", `/utilization/subnets/${id}`),
  },
  users: {
    list:          ()       => request("GET", "/users"),
    create:        (body)   => request("POST", "/users", body),
    resetPassword: (id, b)  => request("PUT", `/users/${id}/password`, b),
    updateRole:    (id, b)  => request("PUT", `/users/${id}/role`, b),
    delete:        (id)     => request("DELETE", `/users/${id}`),
    resetTotp:     (id)     => request("DELETE", `/users/${id}/totp`),
  },
  totp: {
    status:     ()     => request("GET",    "/auth/totp/status"),
    enroll:     ()     => request("POST",   "/auth/totp/enroll"),
    confirm:    (body) => request("POST",   "/auth/totp/confirm", body),
    disable:    (body) => request("DELETE", "/auth/totp", body),
  },
  assets: {
    list:      (params) => request("GET", "/assets" + toQuery(params)),
    get:       (id)     => request("GET", `/assets/${id}`),
    create:    (body)   => request("POST", "/assets", body),
    update:    (id, b)  => request("PUT", `/assets/${id}`, b),
    delete:    (id)     => request("DELETE", `/assets/${id}`),
    bulkDelete:(ids)    => request("DELETE", "/assets", { ids }),
    import:    (rows, dryRun) => request("POST", "/assets/import", { rows, dryRun }),
    importPdf: (assets, dryRun) => request("POST", "/assets/import-pdf", { assets, dryRun }),
    dnsLookup: (id)     => request("POST", `/assets/${id}/dns-lookup`),
    forwardLookup: (id) => request("POST", `/assets/${id}/forward-lookup`),
    ouiLookup: (id)     => request("POST", `/assets/${id}/oui-lookup`),
    ouiLookupAll: ()    => trackedRequest("OUI Lookup", "POST", "/assets/oui-lookup"),
    removeMac: (id, mac) => request("DELETE", `/assets/${id}/macs/${encodeURIComponent(mac)}`),
    getIpHistory:         (id)  => request("GET",  `/assets/${id}/ip-history`),
    getHistorySettings:   ()    => request("GET",  "/assets/ip-history-settings"),
    updateHistorySettings:(body) => request("PUT",  "/assets/ip-history-settings", body),
    getMonitorSettings:   ()    => request("GET",  "/assets/monitor-settings"),
    updateMonitorSettings:(body) => request("PUT", "/assets/monitor-settings", body),
    bulkMonitor:          (body) => request("POST", "/assets/bulk-monitor", body),
    monitorHistory:       (id, opts) => {
      // Accepts a range string ("24h") or { range } / { from, to } object.
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = [];
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/monitor-history` + (qs.length ? "?" + qs.join("&") : ""));
    },
    probeNow:             (id)  => request("POST", `/assets/${id}/probe-now`),
    snmpWalk:             (id, body) => request("POST", `/assets/${id}/snmp-walk`, body),
    reserve:              (id)  => request("POST", `/assets/${id}/reserve`),
    unreserve:            (id)  => request("POST", `/assets/${id}/unreserve`),
    // System tab — telemetry, system-info snapshot, per-interface counters, per-mountpoint storage.
    systemInfo:           (id)  => request("GET", `/assets/${id}/system-info`),
    telemetryHistory:     (id, opts) => {
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = [];
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/telemetry-history` + (qs.length ? "?" + qs.join("&") : ""));
    },
    interfaceHistory:     (id, ifName, opts) => {
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = ["ifName=" + encodeURIComponent(ifName)];
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/interface-history?` + qs.join("&"));
    },
    setInterfaceComment:  (id, ifName, description) =>
      request("PUT", `/assets/${id}/interfaces/${encodeURIComponent(ifName)}/comment`, { description: description }),
    storageHistory:       (id, mountPath, opts) => {
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = ["mountPath=" + encodeURIComponent(mountPath)];
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/storage-history?` + qs.join("&"));
    },
    temperatureHistory:   (id, opts) => {
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = [];
      if (opts.sensorName) qs.push("sensorName=" + encodeURIComponent(opts.sensorName));
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/temperature-history` + (qs.length ? "?" + qs.join("&") : ""));
    },
    ipsecHistory:         (id, tunnelName, opts) => {
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = ["tunnelName=" + encodeURIComponent(tunnelName)];
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/ipsec-history?` + qs.join("&"));
    },
  },
  integrations: {
    list:   ()       => request("GET", "/integrations"),
    get:    (id)     => request("GET", `/integrations/${id}`),
    create: (body)   => request("POST", "/integrations", body),
    update: (id, b)  => request("PUT", `/integrations/${id}`, b),
    delete: (id)     => request("DELETE", `/integrations/${id}`),
    test:   (id, name) => trackedRequest("Testing " + (name || "integration"), "POST", `/integrations/${id}/test`),
    testFortigateSample:    (id)   => trackedRequest("Testing random FortiGate", "POST", `/integrations/${id}/test/fortigate-sample`),
    testFortigateSampleNew: (body) => trackedRequest("Testing random FortiGate", "POST", "/integrations/test/fortigate-sample", body),
    register:(id, b) => request("POST", `/integrations/${id}/register`, b),
    discover:(id, name) => trackedRequest("Discovering " + (name || "DHCP"), "POST", `/integrations/${id}/discover`),
    testNew:(body)   => trackedRequest("Testing connection", "POST", "/integrations/test", body),
    query:         (id, body) => request("POST", `/integrations/${id}/query`, body),
    discoveries:   ()    => request("GET", "/integrations/discoveries"),
    abortDiscover: (id)  => request("DELETE", `/integrations/${id}/discover`),
  },
  conflicts: {
    list:   (params) => request("GET", "/conflicts" + toQuery(params)),
    count:  ()       => request("GET", "/conflicts/count"),
    accept: (id)     => request("POST", `/conflicts/${id}/accept`),
    reject: (id)     => request("POST", `/conflicts/${id}/reject`),
  },
  events: {
    list: (params) => request("GET", "/events" + toQuery(params)),
    getArchiveSettings: () => request("GET", "/events/archive-settings"),
    updateArchiveSettings: (body) => request("PUT", "/events/archive-settings", body),
    testArchiveConnection: (body) => trackedRequest("Testing archive connection", "POST", "/events/archive-test", body),
    getSyslogSettings: () => request("GET", "/events/syslog-settings"),
    updateSyslogSettings: (body) => request("PUT", "/events/syslog-settings", body),
    testSyslogConnection: (body) => trackedRequest("Testing syslog connection", "POST", "/events/syslog-test", body),
    getRetentionSettings: () => request("GET", "/events/retention-settings"),
    updateRetentionSettings: (body) => request("PUT", "/events/retention-settings", body),
    getAssetDecommissionSettings: () => request("GET", "/events/asset-decommission-settings"),
    updateAssetDecommissionSettings: (body) => request("PUT", "/events/asset-decommission-settings", body),
  },
  serverSettings: {
    getNtp:      ()       => request("GET", "/server-settings/ntp"),
    updateNtp:   (body)   => request("PUT", "/server-settings/ntp", body),
    testNtp:     (body)   => trackedRequest("Testing NTP sync", "POST", "/server-settings/ntp/test", body),
    listCerts:   ()       => request("GET", "/server-settings/certificates"),
    uploadCert:  (category, file) => uploadFile("/server-settings/certificates", category, file),
    deleteCert:  (id)     => request("DELETE", `/server-settings/certificates/${id}`),
    generateCert:(body)   => request("POST", "/server-settings/certificates/generate", body),
    getHttps:    ()       => request("GET", "/server-settings/https"),
    updateHttps: (body)   => request("PUT", "/server-settings/https", body),
    applyHttps:  ()       => request("POST", "/server-settings/https/apply"),
    getDatabase: ()       => request("GET", "/server-settings/database"),
    backupDatabase: (password) => {
      var opts = { method: "POST", headers: _csrfHeaders({ "Content-Type": "application/json" }) };
      if (password) opts.body = JSON.stringify({ password: password });
      return fetch(API_BASE + "/server-settings/database/backup", opts).then(function (res) {
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || "Backup failed"); });
        var filename = "polaris-backup.gz";
        var cd = res.headers.get("Content-Disposition");
        if (cd) { var m = cd.match(/filename="?([^"]+)"?/); if (m) filename = m[1]; }
        return res.blob().then(function (blob) { return { blob: blob, filename: filename }; });
      });
    },
    restoreDatabase: (file, password) => {
      var formData = new FormData();
      formData.append("file", file);
      if (password) formData.append("password", password);
      return fetch(API_BASE + "/server-settings/database/restore", { method: "POST", headers: _csrfHeaders(), body: formData }).then(function (res) {
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        return res.json().then(function (data) { if (!res.ok) throw new Error(data.error || "Restore failed"); return data; });
      });
    },
    listBackups: () => request("GET", "/server-settings/database/backups"),
    deleteBackup: (id) => request("DELETE", `/server-settings/database/backups/${id}`),
    downloadBackup: (id) => {
      return fetch(API_BASE + "/server-settings/database/backups/" + id + "/download").then(function (res) {
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || "Download failed"); });
        var filename = "backup.gz";
        var cd = res.headers.get("Content-Disposition");
        if (cd) { var m = cd.match(/filename="?([^"]+)"?/); if (m) filename = m[1]; }
        return res.blob().then(function (blob) { return { blob: blob, filename: filename }; });
      });
    },
    listTags:    ()       => request("GET", "/server-settings/tags"),
    createTag:   (body)   => request("POST", "/server-settings/tags", body),
    updateTag:   (id, body) => request("PUT", `/server-settings/tags/${id}`, body),
    deleteTag:   (id)     => request("DELETE", `/server-settings/tags/${id}`),
    getTagSettings: ()    => request("GET", "/server-settings/tags/settings"),
    updateTagSettings: (body) => request("PUT", "/server-settings/tags/settings", body),
    getBranding:  ()       => request("GET", "/server-settings/branding"),
    updateBranding: (body) => request("PUT", "/server-settings/branding", body),
    uploadLogo: (file) => {
      const formData = new FormData();
      formData.append("file", file);
      return fetch(API_BASE + "/server-settings/branding/logo", {
        method: "POST",
        headers: _csrfHeaders(),
        body: formData,
      }).then(function (res) {
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data?.error || "Upload failed");
          return data;
        });
      });
    },
    deleteLogo: () => request("DELETE", "/server-settings/branding/logo"),
    getDns:      ()       => request("GET", "/server-settings/dns"),
    updateDns:   (body)   => request("PUT", "/server-settings/dns", body),
    testDns:     (body)   => trackedRequest("Testing DNS", "POST", "/server-settings/dns/test", body),
    getOui:         ()       => request("GET", "/server-settings/oui"),
    refreshOui:     ()       => trackedRequest("Refreshing OUI database", "POST", "/server-settings/oui/refresh"),
    getOuiOverrides:()       => request("GET", "/server-settings/oui/overrides"),
    addOuiOverride: (body)   => request("POST", "/server-settings/oui/overrides", body),
    deleteOuiOverride:(pfx)  => request("DELETE", `/server-settings/oui/overrides/${encodeURIComponent(pfx)}`),
    listMibs: (params) => request("GET", "/server-settings/mibs" + toQuery(params)),
    getMibFacets: () => request("GET", "/server-settings/mibs/facets"),
    getMibProfileStatus: () => request("GET", "/server-settings/mibs/profile-status"),
    uploadMib: (file, fields) => {
      const formData = new FormData();
      formData.append("file", file);
      if (fields) {
        if (fields.manufacturer) formData.append("manufacturer", fields.manufacturer);
        if (fields.model) formData.append("model", fields.model);
        if (fields.notes) formData.append("notes", fields.notes);
      }
      return fetch(API_BASE + "/server-settings/mibs", {
        method: "POST",
        headers: _csrfHeaders(),
        body: formData,
      }).then(function (res) {
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data?.error || "MIB upload failed");
          return data;
        });
      });
    },
    deleteMib: (id) => request("DELETE", `/server-settings/mibs/${id}`),
    downloadMibUrl: (id) => API_BASE + "/server-settings/mibs/" + encodeURIComponent(id) + "/download",
    listManufacturerAliases:   ()      => request("GET",    "/manufacturer-aliases"),
    createManufacturerAlias:   (body)  => request("POST",   "/manufacturer-aliases", body),
    updateManufacturerAlias:   (id, b) => request("PUT",    `/manufacturer-aliases/${encodeURIComponent(id)}`, b),
    deleteManufacturerAlias:   (id)    => request("DELETE", `/manufacturer-aliases/${encodeURIComponent(id)}`),
    getPgTuning: () => request("GET", "/server-settings/pg-tuning"),
    snoozePgTuning: (days) => request("POST", "/server-settings/pg-tuning/snooze", { days: days || 7 }),
    checkForUpdates: () => request("GET", "/server-settings/updates/check"),
    getUpdateStatus: () => request("GET", "/server-settings/updates/status"),
    applyUpdate:     (password) => request("POST", "/server-settings/updates/apply", password ? { password: password } : undefined),
    dismissUpdate:   () => request("POST", "/server-settings/updates/dismiss"),
    getUpdateHistory: (limit) => request("GET", "/server-settings/updates/history" + (limit ? "?limit=" + limit : "")),
    getUpdateSettings: () => request("GET", "/server-settings/updates/settings"),
    setUpdateSettings: (body) => request("PUT", "/server-settings/updates/settings", body),
  },
  search: {
    query: (q) => request("GET", `/search?q=${encodeURIComponent(q)}`),
  },
  map: {
    sites:    ()        => request("GET", "/map/sites"),
    search:   (q)       => request("GET", `/map/search?q=${encodeURIComponent(q)}`),
    topology: (id)      => request("GET", `/map/sites/${id}/topology`),
  },
  auth: {
    me: () => request("GET", "/auth/me"),
    azureConfig: () => request("GET", "/auth/azure/config"),
    azureSettings: () => request("GET", "/auth/azure/settings"),
    updateAzureSettings: (body) => request("PUT", "/auth/azure/settings", body),
    testAzureSettings: () => request("POST", "/auth/azure/test"),
    oidcSettings: () => request("GET", "/auth/oidc/settings"),
    updateOidcSettings: (body) => request("PUT", "/auth/oidc/settings", body),
    ldapSettings: () => request("GET", "/auth/ldap/settings"),
    updateLdapSettings: (body) => request("PUT", "/auth/ldap/settings", body),
  },
};

async function uploadFile(path, category, file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("category", category);

  const res = await fetch(API_BASE + path, {
    method: "POST",
    headers: _csrfHeaders(),
    body: formData,
  });

  if (res.status === 401) { window.location.href = "/login.html"; return; }
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "Upload failed");
  return data;
}

function toQuery(params) {
  if (!params) return "";
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return qs ? "?" + qs : "";
}
