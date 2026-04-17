/**
 * public/js/server-settings.js — Server Settings page (NTP + Certificates + Database)
 */

document.addEventListener("DOMContentLoaded", function () {
  // Tab switching
  document.querySelectorAll("#settings-tabs .page-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var target = tab.getAttribute("data-tab");
      document.querySelectorAll("#settings-tabs .page-tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".page-tab-panel").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      document.getElementById("tab-" + target).classList.add("active");
      // Lazy-load tabs on first click
      if (target === "ntp" && !_ntpLoaded) loadNtpSettings();
      if (target === "certificates" && !_certsLoaded) loadCertificates();
      if (target === "database" && !_dbLoaded) loadDatabaseInfo();
      if (target === "identification" && !_tagsLoaded) loadIdentificationTab();
      if (target === "customization" && !_brandingLoaded) loadCustomizationTab();
    });
  });

  loadIdentificationTab();
});

// ─── NTP Tab ────────────────────────────────────────────────────────────────

var _ntpLoaded = false;

async function loadNtpSettings() {
  _ntpLoaded = true;
  var container = document.getElementById("tab-ntp");
  var defaults = {
    enabled: false,
    mode: "ntp",
    servers: "",
    timezoneOverride: "",
  };

  try {
    var saved = await api.serverSettings.getNtp();
    if (saved) {
      defaults.enabled = saved.enabled || false;
      defaults.mode = saved.mode || "ntp";
      defaults.servers = (saved.servers || []).join("\n");
      defaults.timezoneOverride = saved.timezoneOverride || "";
    }
  } catch (_) {}

  container.innerHTML =
    '<div class="settings-card">' +
      '<h4>Time Synchronization</h4>' +
      '<div class="form-group">' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
          '<input type="checkbox" id="f-ntp-enabled"' + (defaults.enabled ? ' checked' : '') + '>' +
          '<span>Enable NTP synchronization</span>' +
        '</label>' +
        '<p class="hint">Synchronize the server clock with external NTP servers.</p>' +
      '</div>' +
      '<div class="form-group"><label>Mode</label>' +
        '<select id="f-ntp-mode">' +
          '<option value="ntp"' + (defaults.mode === "ntp" ? ' selected' : '') + '>NTP (UDP 123)</option>' +
          '<option value="sntp"' + (defaults.mode === "sntp" ? ' selected' : '') + '>SNTP (Simple NTP)</option>' +
          '<option value="nts"' + (defaults.mode === "nts" ? ' selected' : '') + '>NTS (Network Time Security)</option>' +
        '</select>' +
        '<p class="hint">NTS encrypts and authenticates time queries using TLS. Requires NTS-capable servers.</p>' +
      '</div>' +
      '<div class="form-group"><label>NTP Servers</label>' +
        '<textarea id="f-ntp-servers" rows="4" placeholder="One server per line, e.g.:\npool.ntp.org\ntime.google.com\ntime.cloudflare.com">' + escapeHtml(defaults.servers) + '</textarea>' +
        '<p class="hint">Enter one server per line. IP addresses or hostnames are accepted.</p>' +
      '</div>' +
    '</div>' +
    '<div class="settings-card">' +
      '<h4>Timezone Override</h4>' +
      '<div class="form-group"><label>Timezone</label>' +
        '<input type="text" id="f-ntp-timezone" value="' + escapeHtml(defaults.timezoneOverride) + '" placeholder="Leave blank to use system timezone">' +
        '<p class="hint">IANA timezone identifier (e.g. America/Chicago, UTC, Europe/London). Leave blank to use the server\'s OS timezone.</p>' +
      '</div>' +
      '<div id="ntp-current-time" style="font-size:0.82rem;color:var(--color-text-tertiary);margin-top:0.5rem"></div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn btn-primary" id="btn-ntp-save">Save NTP Settings</button>' +
      '<button class="btn btn-secondary" id="btn-ntp-test">Test Sync</button>' +
      '<span id="ntp-status" style="font-size:0.82rem;margin-left:8px"></span>' +
    '</div>';

  // Show current time
  updateCurrentTime();
  setInterval(updateCurrentTime, 1000);

  document.getElementById("btn-ntp-save").addEventListener("click", saveNtpSettings);
  document.getElementById("btn-ntp-test").addEventListener("click", testNtpSync);
}

function updateCurrentTime() {
  var el = document.getElementById("ntp-current-time");
  if (!el) return;
  var tz = document.getElementById("f-ntp-timezone");
  var tzVal = tz ? tz.value.trim() : "";
  try {
    var opts = { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" };
    if (tzVal) opts.timeZone = tzVal;
    el.textContent = "Current server time: " + new Date().toLocaleString("en-US", opts);
  } catch (_) {
    el.textContent = "Current server time: " + new Date().toLocaleTimeString();
  }
}

async function saveNtpSettings() {
  var btn = document.getElementById("btn-ntp-save");
  btn.disabled = true;
  try {
    var servers = document.getElementById("f-ntp-servers").value
      .split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
    await api.serverSettings.updateNtp({
      enabled: document.getElementById("f-ntp-enabled").checked,
      mode: document.getElementById("f-ntp-mode").value,
      servers: servers,
      timezoneOverride: document.getElementById("f-ntp-timezone").value.trim() || null,
    });
    showToast("NTP settings saved");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function testNtpSync() {
  var btn = document.getElementById("btn-ntp-test");
  var statusEl = document.getElementById("ntp-status");
  btn.disabled = true;
  statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Testing...</span>';
  try {
    var servers = document.getElementById("f-ntp-servers").value
      .split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
    var result = await api.serverSettings.testNtp({
      mode: document.getElementById("f-ntp-mode").value,
      servers: servers,
    });
    statusEl.innerHTML = result.ok
      ? '<span style="color:var(--color-success)">' + escapeHtml(result.message) + '</span>'
      : '<span style="color:var(--color-danger)">' + escapeHtml(result.message) + '</span>';
  } catch (err) {
    statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
  } finally {
    btn.disabled = false;
  }
}

// ─── Certificates Tab ───────────────────────────────────────────────────────

var _certsLoaded = false;
var _certData = { trustedCAs: [], serverCerts: [] };
var _httpsSettings = { enabled: false, port: 3443, httpPort: 3000, certId: null, keyId: null, redirectHttp: false, running: false };

async function loadCertificates() {
  _certsLoaded = true;
  var container = document.getElementById("tab-certificates");

  // Load HTTPS settings in parallel with cert data
  try {
    _httpsSettings = await api.serverSettings.getHttps();
  } catch (_) {}

  container.innerHTML =
    '<div class="settings-card">' +
      '<h4>HTTPS Configuration</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">Enable HTTPS to encrypt browser connections. Select a server certificate and key from the uploaded certificates below.</p>' +
      '<div id="https-status-banner"></div>' +
      '<div class="form-group">' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
          '<input type="checkbox" id="f-https-enabled"' + (_httpsSettings.enabled ? ' checked' : '') + '>' +
          '<span>Enable HTTPS</span>' +
        '</label>' +
      '</div>' +
      '<div class="form-group"><label>HTTPS Port</label>' +
        '<input type="number" id="f-https-port" value="' + (_httpsSettings.port || 3443) + '" min="1" max="65535" style="width:120px">' +
      '</div>' +
      '<div class="form-group"><label>HTTP Port</label>' +
        '<input type="number" id="f-http-port" value="' + (_httpsSettings.httpPort || 3000) + '" min="1" max="65535" style="width:120px">' +
        '<p class="hint">Changing the HTTP port requires a server restart to take effect.</p>' +
      '</div>' +
      '<div class="form-group"><label>Server Certificate</label>' +
        '<select id="f-https-cert"><option value="">— Upload a certificate first —</option></select>' +
        '<p class="hint">Select the TLS certificate (.pem, .crt) to present to browsers.</p>' +
      '</div>' +
      '<div class="form-group"><label>Private Key</label>' +
        '<select id="f-https-key"><option value="">— Upload a private key first —</option></select>' +
        '<p class="hint">Select the private key (.key) that matches the certificate above.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
          '<input type="checkbox" id="f-https-redirect"' + (_httpsSettings.redirectHttp ? ' checked' : '') + '>' +
          '<span>Redirect HTTP to HTTPS</span>' +
        '</label>' +
        '<p class="hint">When enabled, all HTTP requests will be redirected to HTTPS. Only takes effect after Apply &amp; Restart.</p>' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button class="btn btn-primary" id="btn-https-save">Save</button>' +
        '<button class="btn btn-secondary" id="btn-https-apply">Apply &amp; Restart</button>' +
        '<span id="https-status" style="font-size:0.82rem;margin-left:8px"></span>' +
      '</div>' +
    '</div>' +
    '<div class="settings-card">' +
      '<h4>Trusted Certificate Authorities</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">CA certificates used to verify remote servers when Shelob connects to integrations, syslog, and archive targets. These are also included in the HTTPS trust chain.</p>' +
      '<ul class="cert-list" id="ca-list"><li class="cert-empty">Loading...</li></ul>' +
      '<div style="margin-top:1rem">' +
        '<div class="upload-area" id="ca-upload-area">' +
          '<input type="file" id="ca-file-input" accept=".pem,.crt,.cer,.der">' +
          '<strong style="color:var(--color-text-primary)">Upload CA Certificate</strong>' +
          '<p>Click to select a .pem, .crt, or .cer file</p>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="settings-card">' +
      '<h4>Server Certificates</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">TLS certificate and private key used for HTTPS. Upload a matched certificate and key pair, then select them in the HTTPS Configuration above.</p>' +
      '<ul class="cert-list" id="server-cert-list"><li class="cert-empty">Loading...</li></ul>' +
      '<div style="margin-top:1rem;display:flex;gap:12px;flex-wrap:wrap">' +
        '<div class="upload-area" id="cert-upload-area" style="flex:1;min-width:200px">' +
          '<input type="file" id="cert-file-input" accept=".pem,.crt,.cer,.pfx,.p12,.key" multiple>' +
          '<strong style="color:var(--color-text-primary)">Upload Certificate / Key</strong>' +
          '<p>Click to select certificate (.pem, .crt) and/or key (.key, .pem) files</p>' +
        '</div>' +
        '<div class="upload-area" id="generate-cert-area" style="flex:1;min-width:200px">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:28px;height:28px;margin-bottom:4px;opacity:0.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/><line x1="12" y1="15" x2="12" y2="19"/></svg>' +
          '<strong style="color:var(--color-text-primary)">Generate Self-Signed</strong>' +
          '<p>Create a new self-signed certificate for testing or internal use</p>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Wire upload areas
  wireUploadArea("ca-upload-area", "ca-file-input", uploadCA);
  wireUploadArea("cert-upload-area", "cert-file-input", uploadServerCert);

  document.getElementById("btn-https-save").addEventListener("click", saveHttpsSettings);
  document.getElementById("btn-https-apply").addEventListener("click", applyHttpsSettings);
  document.getElementById("generate-cert-area").addEventListener("click", openGenerateCertModal);

  await refreshCertLists();
}

function wireUploadArea(areaId, inputId, handler) {
  var area = document.getElementById(areaId);
  var input = document.getElementById(inputId);
  area.addEventListener("click", function () { input.click(); });
  input.addEventListener("change", function () {
    if (input.files.length > 0) handler(input.files);
    input.value = "";
  });
}

async function refreshCertLists() {
  try {
    _certData = await api.serverSettings.listCerts();
  } catch (_) {
    _certData = { trustedCAs: [], serverCerts: [] };
  }
  renderCAList();
  renderServerCertList();
  populateHttpsDropdowns();
  updateHttpsStatusBanner();
}

function populateHttpsDropdowns() {
  var certSelect = document.getElementById("f-https-cert");
  var keySelect = document.getElementById("f-https-key");
  if (!certSelect || !keySelect) return;

  var certs = _certData.serverCerts.filter(function (c) { return c.type === "cert"; });
  var keys = _certData.serverCerts.filter(function (c) { return c.type === "key"; });

  certSelect.innerHTML = '<option value="">— Select certificate —</option>' +
    certs.map(function (c) {
      var sel = _httpsSettings.certId === c.id ? " selected" : "";
      return '<option value="' + c.id + '"' + sel + '>' + escapeHtml(c.name) +
        (c.subject ? " (" + escapeHtml(c.subject) + ")" : "") + '</option>';
    }).join("");
  if (certs.length === 0) certSelect.innerHTML = '<option value="">— Upload a certificate first —</option>';

  keySelect.innerHTML = '<option value="">— Select private key —</option>' +
    keys.map(function (c) {
      var sel = _httpsSettings.keyId === c.id ? " selected" : "";
      return '<option value="' + c.id + '"' + sel + '>' + escapeHtml(c.name) + '</option>';
    }).join("");
  if (keys.length === 0) keySelect.innerHTML = '<option value="">— Upload a private key first —</option>';
}

function updateHttpsStatusBanner() {
  var banner = document.getElementById("https-status-banner");
  if (!banner) return;
  if (_httpsSettings.running) {
    banner.innerHTML = '<div style="background:var(--color-success-bg, rgba(46,160,67,0.15));border:1px solid var(--color-success);border-radius:6px;padding:8px 12px;margin-bottom:1rem;font-size:0.82rem;display:flex;align-items:center;gap:8px">' +
      '<span style="color:var(--color-success);font-weight:600">&#9679; HTTPS Active</span>' +
      '<span style="color:var(--color-text-secondary)">Listening on port ' + (_httpsSettings.port || 3443) + '</span>' +
    '</div>';
  } else if (_httpsSettings.enabled) {
    banner.innerHTML = '<div style="background:var(--color-warning-bg, rgba(210,153,34,0.15));border:1px solid var(--color-warning);border-radius:6px;padding:8px 12px;margin-bottom:1rem;font-size:0.82rem;display:flex;align-items:center;gap:8px">' +
      '<span style="color:var(--color-warning);font-weight:600">&#9679; HTTPS Enabled</span>' +
      '<span style="color:var(--color-text-secondary)">Not running — click Apply &amp; Restart to start</span>' +
    '</div>';
  } else {
    banner.innerHTML = '';
  }
}

function collectHttpsForm() {
  return {
    enabled: document.getElementById("f-https-enabled").checked,
    port: parseInt(document.getElementById("f-https-port").value, 10) || 3443,
    httpPort: parseInt(document.getElementById("f-http-port").value, 10) || 3000,
    certId: document.getElementById("f-https-cert").value || null,
    keyId: document.getElementById("f-https-key").value || null,
    redirectHttp: document.getElementById("f-https-redirect").checked,
  };
}

async function saveHttpsSettings() {
  var btn = document.getElementById("btn-https-save");
  btn.disabled = true;
  try {
    _httpsSettings = await api.serverSettings.updateHttps(collectHttpsForm());
    updateHttpsStatusBanner();
    showToast("HTTPS settings saved");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function applyHttpsSettings() {
  var btn = document.getElementById("btn-https-apply");
  var statusEl = document.getElementById("https-status");
  btn.disabled = true;
  statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Saving &amp; applying...</span>';
  try {
    // Save first, then apply
    _httpsSettings = await api.serverSettings.updateHttps(collectHttpsForm());
    var result = await api.serverSettings.applyHttps();
    _httpsSettings.running = result.running;
    updateHttpsStatusBanner();
    statusEl.innerHTML = result.ok
      ? '<span style="color:var(--color-success)">' + escapeHtml(result.message) + '</span>'
      : '<span style="color:var(--color-danger)">' + escapeHtml(result.message) + '</span>';
  } catch (err) {
    statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
  } finally {
    btn.disabled = false;
  }
}

async function openGenerateCertModal() {
  var html =
    '<div class="form-group"><label>Common Name (CN)</label>' +
      '<input type="text" id="f-gen-cn" value="localhost" placeholder="e.g. localhost, shelob.example.com">' +
      '<p class="hint">The hostname that will appear in the certificate subject. Use the hostname clients will connect to.</p>' +
    '</div>' +
    '<div class="form-group"><label>Validity (days)</label>' +
      '<input type="number" id="f-gen-days" value="365" min="1" max="3650" style="width:120px">' +
      '<p class="hint">How long the certificate is valid. Maximum 3650 days (10 years).</p>' +
    '</div>';

  var ok = await showFormModal("Generate Self-Signed Certificate", html, "Generate");
  if (!ok) return;

  var cn = document.getElementById("f-gen-cn").value.trim() || "localhost";
  var days = parseInt(document.getElementById("f-gen-days").value, 10) || 365;

  try {
    var result = await api.serverSettings.generateCert({ commonName: cn, days: days });
    showToast("Self-signed certificate generated: " + cn);
    await refreshCertLists();
    // Auto-select the newly generated cert and key in the HTTPS dropdowns
    if (result.cert && result.key) {
      _httpsSettings.certId = result.cert.id;
      _httpsSettings.keyId = result.key.id;
      populateHttpsDropdowns();
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

function certIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>';
}

function renderCAList() {
  var list = document.getElementById("ca-list");
  if (!_certData.trustedCAs.length) {
    list.innerHTML = '<li class="cert-empty">No trusted CAs uploaded. Shelob will use the system trust store.</li>';
    return;
  }
  list.innerHTML = _certData.trustedCAs.map(function (cert) {
    return '<li class="cert-item">' +
      '<div class="cert-icon">' + certIconSvg() + '</div>' +
      '<div class="cert-info">' +
        '<div class="cert-name">' + escapeHtml(cert.name) + '</div>' +
        '<div class="cert-meta">' + escapeHtml(cert.subject || "Unknown subject") +
          (cert.expiresAt ? ' &middot; Expires ' + formatDate(cert.expiresAt) : '') +
          ' &middot; Uploaded ' + formatDate(cert.uploadedAt) +
        '</div>' +
      '</div>' +
      '<div class="cert-actions">' +
        '<button class="btn btn-sm btn-danger" onclick="deleteCA(\'' + cert.id + '\', \'' + escapeHtml(cert.name) + '\')">Remove</button>' +
      '</div>' +
    '</li>';
  }).join("");
}

function renderServerCertList() {
  var list = document.getElementById("server-cert-list");
  if (!_certData.serverCerts.length) {
    list.innerHTML = '<li class="cert-empty">No server certificate configured. The app is using its default configuration.</li>';
    return;
  }
  list.innerHTML = _certData.serverCerts.map(function (cert) {
    var typeBadge = cert.type === "key"
      ? '<span class="badge badge-deprecated" style="margin-left:6px">KEY</span>'
      : '<span class="badge badge-available" style="margin-left:6px">CERT</span>';
    return '<li class="cert-item">' +
      '<div class="cert-icon">' + certIconSvg() + '</div>' +
      '<div class="cert-info">' +
        '<div class="cert-name">' + escapeHtml(cert.name) + typeBadge + '</div>' +
        '<div class="cert-meta">' +
          (cert.subject ? escapeHtml(cert.subject) + ' &middot; ' : '') +
          (cert.expiresAt ? 'Expires ' + formatDate(cert.expiresAt) + ' &middot; ' : '') +
          'Uploaded ' + formatDate(cert.uploadedAt) +
        '</div>' +
      '</div>' +
      '<div class="cert-actions">' +
        '<button class="btn btn-sm btn-danger" onclick="deleteServerCert(\'' + cert.id + '\', \'' + escapeHtml(cert.name) + '\')">Remove</button>' +
      '</div>' +
    '</li>';
  }).join("");
}

async function uploadCA(files) {
  for (var i = 0; i < files.length; i++) {
    try {
      await api.serverSettings.uploadCert("ca", files[i]);
      showToast("CA certificate uploaded: " + files[i].name);
    } catch (err) {
      showToast("Failed to upload " + files[i].name + ": " + err.message, "error");
    }
  }
  await refreshCertLists();
}

async function uploadServerCert(files) {
  for (var i = 0; i < files.length; i++) {
    try {
      await api.serverSettings.uploadCert("server", files[i]);
      showToast("Uploaded: " + files[i].name);
    } catch (err) {
      showToast("Failed to upload " + files[i].name + ": " + err.message, "error");
    }
  }
  await refreshCertLists();
}

async function deleteCA(id, name) {
  var ok = await showConfirm('Remove trusted CA "' + name + '"?');
  if (!ok) return;
  try {
    await api.serverSettings.deleteCert(id);
    showToast("CA removed");
    await refreshCertLists();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteServerCert(id, name) {
  var ok = await showConfirm('Remove server certificate "' + name + '"?');
  if (!ok) return;
  try {
    await api.serverSettings.deleteCert(id);
    showToast("Certificate removed");
    await refreshCertLists();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── Database Tab ──────────────────────────────────────────────────────────

var _dbLoaded = false;

async function loadDatabaseInfo() {
  var container = document.getElementById("tab-database");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading database information...</p></div>';

  try {
    var db = await api.serverSettings.getDatabase();
    _dbLoaded = true;

    var connParts = [];
    if (db.host) connParts.push(escapeHtml(db.host) + (db.port ? ":" + db.port : ""));
    if (db.database) connParts.push(escapeHtml(db.database));

    container.innerHTML =
      '<div class="settings-card">' +
        '<h4>Database Engine</h4>' +
        '<div class="db-info-grid">' +
          dbInfoRow("Type", db.type || "Unknown") +
          dbInfoRow("Version", db.version || "Unknown") +
          (db.host ? dbInfoRow("Host", db.host + (db.port ? ":" + db.port : "")) : "") +
          (db.database ? dbInfoRow("Database", db.database) : "") +
          (db.ssl ? dbInfoRow("SSL", db.ssl) : "") +
        '</div>' +
      '</div>' +
      '<div class="settings-card">' +
        '<h4>Storage</h4>' +
        '<div class="db-info-grid">' +
          dbInfoRow("Database Size", db.databaseSize || "Unknown") +
          (db.tableCount !== undefined ? dbInfoRow("Tables", db.tableCount) : "") +
        '</div>' +
        (db.tables && db.tables.length > 0
          ? '<div style="margin-top:1rem">' +
              '<table class="ip-table"><thead><tr>' +
                '<th>Table</th><th style="text-align:right">Rows</th><th style="text-align:right">Size</th>' +
              '</tr></thead><tbody>' +
              db.tables.map(function (t) {
                return '<tr>' +
                  '<td class="mono" style="font-size:0.82rem">' + escapeHtml(t.name) + '</td>' +
                  '<td style="text-align:right">' + formatNumber(t.rows) + '</td>' +
                  '<td style="text-align:right;font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(t.size) + '</td>' +
                '</tr>';
              }).join("") +
            '</tbody></table></div>'
          : '') +
      '</div>' +
      (db.uptime || db.activeConnections !== undefined || db.maxConnections !== undefined
        ? '<div class="settings-card">' +
            '<h4>Connection Pool</h4>' +
            '<div class="db-info-grid">' +
              (db.activeConnections !== undefined ? dbInfoRow("Active Connections", db.activeConnections) : "") +
              (db.maxConnections !== undefined ? dbInfoRow("Max Connections", db.maxConnections) : "") +
              (db.uptime ? dbInfoRow("Uptime", db.uptime) : "") +
            '</div>' +
          '</div>'
        : '') +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button class="btn btn-secondary" id="btn-db-refresh">Refresh</button>' +
      '</div>';

    document.getElementById("btn-db-refresh").addEventListener("click", function () {
      _dbLoaded = false;
      loadDatabaseInfo();
    });
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

function dbInfoRow(label, value) {
  return '<div class="db-info-label">' + escapeHtml(label) + '</div>' +
         '<div class="db-info-value">' + escapeHtml(String(value)) + '</div>';
}

function formatNumber(n) {
  if (n === undefined || n === null) return "-";
  return Number(n).toLocaleString();
}

// ─── Customization Tab ─────────────────────────────────────────────────────

var _brandingLoaded = false;
var _brandingData = { appName: "Shelob", subtitle: "Network Management Tool", logoUrl: "/logo.webp" };

async function loadCustomizationTab() {
  var container = document.getElementById("tab-customization");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading...</p></div>';

  try {
    _brandingData = await api.serverSettings.getBranding();
    _brandingLoaded = true;
    renderCustomizationTab();
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

function renderCustomizationTab() {
  var container = document.getElementById("tab-customization");
  var isCustomLogo = _brandingData.logoUrl && _brandingData.logoUrl !== "/logo.webp";

  container.innerHTML =
    '<div class="settings-card">' +
      '<h4>Application Name</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Change the name shown in the sidebar, login page, browser tabs, and PDF exports.' +
      '</p>' +
      '<div class="form-group"><label>Application Name</label>' +
        '<input type="text" id="f-brand-appname" value="' + escapeHtml(_brandingData.appName || "") + '" placeholder="e.g. Shelob">' +
      '</div>' +
      '<div class="form-group"><label>Subtitle</label>' +
        '<input type="text" id="f-brand-subtitle" value="' + escapeHtml(_brandingData.subtitle || "") + '" placeholder="e.g. Network Management Tool">' +
        '<p class="hint">Shown beneath the application name on the sidebar and login page.</p>' +
      '</div>' +
      '<button class="btn btn-primary" id="btn-brand-save">Save</button>' +
    '</div>' +
    '<div class="settings-card">' +
      '<h4>Logo</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Upload a custom logo to replace the default. Recommended size: 280\u00d7280px or larger. Supported formats: PNG, JPEG, WebP, SVG.' +
      '</p>' +
      '<div style="display:flex;align-items:flex-start;gap:1.5rem;flex-wrap:wrap">' +
        '<div style="flex-shrink:0">' +
          '<div class="logo-preview-box">' +
            '<img id="logo-preview" src="' + escapeHtml(_brandingData.logoUrl || "/logo.webp") + '" alt="Current logo">' +
          '</div>' +
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:0.5rem;text-align:center">' +
            (isCustomLogo ? 'Custom logo' : 'Default logo') +
          '</p>' +
        '</div>' +
        '<div style="flex:1;min-width:200px">' +
          '<div class="upload-area" id="logo-upload-area">' +
            '<input type="file" id="logo-file-input" accept="image/png,image/jpeg,image/webp,image/svg+xml">' +
            '<strong style="color:var(--color-text-primary)">Upload New Logo</strong>' +
            '<p>Click to select an image file</p>' +
          '</div>' +
          (isCustomLogo
            ? '<button class="btn btn-secondary" id="btn-logo-reset" style="margin-top:0.75rem">Reset to Default</button>'
            : '') +
        '</div>' +
      '</div>' +
    '</div>';

  // Wire save button
  document.getElementById("btn-brand-save").addEventListener("click", saveBranding);

  // Wire logo upload
  wireUploadArea("logo-upload-area", "logo-file-input", uploadLogo);

  // Wire reset button
  var resetBtn = document.getElementById("btn-logo-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", resetLogo);
  }
}

async function saveBranding() {
  var btn = document.getElementById("btn-brand-save");
  btn.disabled = true;
  try {
    var data = {
      appName: document.getElementById("f-brand-appname").value.trim(),
      subtitle: document.getElementById("f-brand-subtitle").value.trim(),
    };
    _brandingData = await api.serverSettings.updateBranding(data);
    applyBranding(_brandingData);
    showToast("Branding saved");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function uploadLogo(files) {
  if (!files || files.length === 0) return;
  var file = files[0];
  if (!file.type.startsWith("image/")) {
    showToast("Please select an image file", "error");
    return;
  }
  try {
    _brandingData = await api.serverSettings.uploadLogo(file);
    applyBranding(_brandingData);
    renderCustomizationTab();
    showToast("Logo uploaded");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function resetLogo() {
  var ok = await showConfirm("Reset to the default logo?");
  if (!ok) return;
  try {
    _brandingData = await api.serverSettings.deleteLogo();
    applyBranding(_brandingData);
    renderCustomizationTab();
    showToast("Logo reset to default");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── Identification Tab ────────────────────────────────────────────────────

var _tagsLoaded = false;
var _tagsData = [];
var _emptyCategories = [];
var _tagSettings = { enforce: false };

async function loadIdentificationTab() {
  var container = document.getElementById("tab-identification");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading...</p></div>';

  try {
    var results = await Promise.all([
      api.serverSettings.listTags(),
      api.serverSettings.getTagSettings(),
    ]);
    _tagsData = results[0];
    _tagSettings = results[1] || { enforce: false };
    _tagsLoaded = true;
    renderIdentificationTab();
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

function _currentCategories() {
  var cats = {};
  _tagsData.forEach(function (t) { cats[t.category || "General"] = true; });
  return Object.keys(cats);
}

function renderIdentificationTab() {
  var container = document.getElementById("tab-identification");

  // Group tags by category
  var categories = {};
  _tagsData.forEach(function (t) {
    var cat = t.category || "General";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(t);
  });

  // Include tracked empty categories
  _emptyCategories.forEach(function (cat) {
    if (!categories[cat]) categories[cat] = [];
  });

  var catNames = Object.keys(categories).sort();

  var html =
    '<div class="settings-card">' +
      '<h4>Tags</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Define tags used to classify assets, networks, and blocks. Tags can be organized by category for easier filtering.' +
      '</p>' +
      '<div class="form-group" style="margin-bottom:1rem">' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
          '<input type="checkbox" id="f-enforce-tags"' + (_tagSettings.enforce ? ' checked' : '') + '>' +
          '<span>Force predefined tags</span>' +
        '</label>' +
        '<p class="hint">When enabled, users can only select from predefined tags when creating or editing networks and assets. Free-text tag entry will be disabled.</p>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:1rem">' +
        '<button class="btn btn-primary" id="btn-add-tag">+ Add Tag</button>' +
      '</div>';

  if (_tagsData.length === 0 && _emptyCategories.length === 0) {
    html += '<p class="empty-state">No tags defined yet. Add one to get started.</p>';
  } else {
    catNames.forEach(function (cat) {
      var tags = categories[cat];
      var isEmpty = tags.length === 0;
      html += '<div class="tag-category-section">' +
        '<div class="tag-category-header">' +
          '<h5 style="font-size:0.82rem;color:var(--color-text-tertiary);text-transform:uppercase;letter-spacing:0.05em;margin:0">' + escapeHtml(cat) + '</h5>' +
          (isEmpty && isAdmin()
            ? '<button class="tag-category-remove" data-cat="' + escapeHtml(cat) + '" title="Remove empty category">&times;</button>'
            : '') +
        '</div>';
      if (isEmpty) {
        html += '<p style="font-size:0.82rem;color:var(--color-text-tertiary);font-style:italic;margin:0.25rem 0 0">No tags — category will be removed on save</p>';
      } else {
        html += '<div class="tag-chip-list">';
        tags.forEach(function (t) {
          var colorStyle = t.color ? ' style="background:' + escapeHtml(t.color) + '22;border-color:' + escapeHtml(t.color) + ';color:' + escapeHtml(t.color) + '"' : '';
          html += '<span class="tag-chip"' + colorStyle + '>' +
            escapeHtml(t.name) +
            (isAdmin() ? '<button class="tag-chip-delete" data-tag-id="' + t.id + '" title="Delete">&times;</button>' : '') +
          '</span>';
        });
        html += '</div>';
      }
      html += '</div>';
    });
  }

  if (_emptyCategories.length > 0) {
    html += '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:1rem;font-style:italic">' +
      'Empty categories are shown until dismissed. Click the &times; next to an empty category to remove it.' +
    '</p>';
  }

  html += '</div>';
  container.innerHTML = html;

  document.getElementById("btn-add-tag").addEventListener("click", openAddTagModal);

  container.querySelectorAll(".tag-chip-delete").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      deleteTag(btn.getAttribute("data-tag-id"));
    });
  });

  container.querySelectorAll(".tag-category-remove").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var cat = btn.getAttribute("data-cat");
      _emptyCategories = _emptyCategories.filter(function (c) { return c !== cat; });
      renderIdentificationTab();
    });
  });

  document.getElementById("f-enforce-tags").addEventListener("change", async function () {
    var cb = this;
    var newVal = cb.checked;
    cb.disabled = true;
    try {
      await api.serverSettings.updateTagSettings({ enforce: newVal });
      _tagSettings.enforce = newVal;
      // Invalidate the shared tag cache so forms pick up the new mode
      if (typeof _tagCache !== "undefined") _tagCache.loaded = false;
      showToast(newVal ? "Predefined tags enforced" : "Free-text tags enabled");
    } catch (err) {
      cb.checked = !newVal; // revert on failure
      showToast(err.message, "error");
    } finally {
      cb.disabled = false;
    }
  });
}

async function openAddTagModal() {
  // Collect existing categories (including empty tracked ones) for the dropdown
  var existingCats = [];
  _tagsData.forEach(function (t) {
    var cat = t.category || "General";
    if (existingCats.indexOf(cat) === -1) existingCats.push(cat);
  });
  _emptyCategories.forEach(function (cat) {
    if (existingCats.indexOf(cat) === -1) existingCats.push(cat);
  });
  existingCats.sort();

  var catOptions = '<option value="">General</option>';
  existingCats.forEach(function (c) {
    if (c !== "General") {
      catOptions += '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>';
    }
  });

  var body =
    '<div class="form-group"><label>Tag Name *</label>' +
      '<input type="text" id="f-tag-name" placeholder="e.g. prod, critical, kubernetes">' +
    '</div>' +
    '<div class="form-group"><label>Category</label>' +
      '<div style="display:flex;gap:8px">' +
        '<select id="f-tag-category-select" style="flex:1">' + catOptions +
          '<option value="__new__">+ New category...</option>' +
        '</select>' +
        '<input type="text" id="f-tag-category-new" placeholder="Category name" style="flex:1;display:none">' +
      '</div>' +
      '<p class="hint">Group related tags together. e.g. Environment, Function, Location</p>' +
    '</div>' +
    '<div class="form-group"><label>Color</label>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<input type="color" id="f-tag-color" value="#4fc3f7" style="width:40px;height:32px;padding:2px;border:1px solid var(--color-border);border-radius:4px;background:transparent;cursor:pointer">' +
        '<span id="f-tag-color-hex" style="font-family:var(--font-mono);font-size:0.82rem;color:var(--color-text-secondary)">#4fc3f7</span>' +
      '</div>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save-tag">Add Tag</button>';
  openModal("Add Tag", body, footer);

  // Toggle new category input
  var catSelect = document.getElementById("f-tag-category-select");
  var catNew = document.getElementById("f-tag-category-new");
  catSelect.addEventListener("change", function () {
    if (catSelect.value === "__new__") {
      catNew.style.display = "";
      catNew.focus();
    } else {
      catNew.style.display = "none";
    }
  });

  // Update hex preview
  var colorInput = document.getElementById("f-tag-color");
  var hexLabel = document.getElementById("f-tag-color-hex");
  colorInput.addEventListener("input", function () {
    hexLabel.textContent = colorInput.value;
  });

  document.getElementById("btn-save-tag").addEventListener("click", async function () {
    var btn = this;
    var name = document.getElementById("f-tag-name").value.trim();
    if (!name) { showToast("Tag name is required", "error"); return; }

    var category;
    if (catSelect.value === "__new__") {
      category = catNew.value.trim() || "General";
    } else {
      category = catSelect.value || "General";
    }

    btn.disabled = true;
    try {
      await api.serverSettings.createTag({
        name: name,
        category: category,
        color: colorInput.value,
      });
      closeModal();
      showToast('Tag "' + name + '" created');
      // Remove from empty categories if a tag was added to it
      _emptyCategories = _emptyCategories.filter(function (c) { return c !== category; });
      _tagsData = await api.serverSettings.listTags();
      renderIdentificationTab();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function deleteTag(id) {
  var tag = _tagsData.find(function (t) { return t.id === id; });
  var name = tag ? tag.name : "this tag";
  var ok = await showConfirm('Delete tag "' + name + '"? This will not remove it from existing assets or networks.');
  if (!ok) return;

  // Snapshot categories before delete
  var catsBefore = _currentCategories();

  try {
    await api.serverSettings.deleteTag(id);
    showToast('Tag "' + name + '" deleted');
    _tagsData = await api.serverSettings.listTags();

    // Detect categories that became empty after this delete
    var catsAfter = _currentCategories();
    catsBefore.forEach(function (cat) {
      if (catsAfter.indexOf(cat) === -1 && _emptyCategories.indexOf(cat) === -1) {
        _emptyCategories.push(cat);
      }
    });

    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
  }
}
