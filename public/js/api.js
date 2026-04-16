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

async function request(method, path, body, signal) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  if (signal) opts.signal = signal;

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
    create:        (body)   => request("POST", "/subnets", body),
    nextAvailable: (body)   => request("POST", "/subnets/next-available", body),
    update:        (id, b)  => request("PUT", `/subnets/${id}`, b),
    delete:        (id)     => request("DELETE", `/subnets/${id}`),
  },
  reservations: {
    list:    (params) => request("GET", "/reservations" + toQuery(params)),
    get:     (id)     => request("GET", `/reservations/${id}`),
    create:  (body)   => request("POST", "/reservations", body),
    update:  (id, b)  => request("PUT", `/reservations/${id}`, b),
    release: (id)     => request("DELETE", `/reservations/${id}`),
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
  },
  assets: {
    list:   (params) => request("GET", "/assets" + toQuery(params)),
    get:    (id)     => request("GET", `/assets/${id}`),
    create: (body)   => request("POST", "/assets", body),
    update: (id, b)  => request("PUT", `/assets/${id}`, b),
    delete: (id)     => request("DELETE", `/assets/${id}`),
  },
  integrations: {
    list:   ()       => request("GET", "/integrations"),
    get:    (id)     => request("GET", `/integrations/${id}`),
    create: (body)   => request("POST", "/integrations", body),
    update: (id, b)  => request("PUT", `/integrations/${id}`, b),
    delete: (id)     => request("DELETE", `/integrations/${id}`),
    test:   (id, name) => trackedRequest("Testing " + (name || "integration"), "POST", `/integrations/${id}/test`),
    register:(id, b) => request("POST", `/integrations/${id}/register`, b),
    discover:(id, name) => trackedRequest("Discovering " + (name || "DHCP"), "POST", `/integrations/${id}/discover`),
    testNew:(body)   => trackedRequest("Testing connection", "POST", "/integrations/test", body),
  },
  events: {
    list: (params) => request("GET", "/events" + toQuery(params)),
    getArchiveSettings: () => request("GET", "/events/archive-settings"),
    updateArchiveSettings: (body) => request("PUT", "/events/archive-settings", body),
    testArchiveConnection: (body) => trackedRequest("Testing archive connection", "POST", "/events/archive-test", body),
    getSyslogSettings: () => request("GET", "/events/syslog-settings"),
    updateSyslogSettings: (body) => request("PUT", "/events/syslog-settings", body),
    testSyslogConnection: (body) => trackedRequest("Testing syslog connection", "POST", "/events/syslog-test", body),
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
  },
  auth: {
    me: () => request("GET", "/auth/me"),
  },
};

async function uploadFile(path, category, file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("category", category);

  const res = await fetch(API_BASE + path, {
    method: "POST",
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
