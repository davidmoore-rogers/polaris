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

  // Check for ?tab= query parameter to open a specific tab
  var urlParams = new URLSearchParams(window.location.search);
  var requestedTab = urlParams.get("tab");
  if (requestedTab) {
    var tabBtn = document.querySelector('#settings-tabs .page-tab[data-tab="' + requestedTab + '"]');
    if (tabBtn) {
      tabBtn.click();
      return;
    }
  }

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
        '<div class="search-select" id="tz-select-wrap">' +
          '<input type="text" class="search-select-input" id="f-ntp-timezone" autocomplete="off" placeholder="Search timezones... (blank = system timezone)">' +
          '<input type="hidden" id="f-ntp-timezone-val" value="' + escapeHtml(defaults.timezoneOverride) + '">' +
          '<button type="button" class="search-select-clear" id="tz-clear" title="Clear" style="display:none">&times;</button>' +
          '<span class="search-select-arrow">&#9662;</span>' +
          '<div class="search-select-dropdown" id="tz-dropdown"></div>' +
        '</div>' +
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

  initTimezoneDropdown(defaults.timezoneOverride);
}

function updateCurrentTime() {
  var el = document.getElementById("ntp-current-time");
  if (!el) return;
  var tz = document.getElementById("f-ntp-timezone-val");
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
      timezoneOverride: document.getElementById("f-ntp-timezone-val").value.trim() || null,
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

// ─── Timezone Searchable Dropdown ──────────────────────────────────────────

function initTimezoneDropdown(currentValue) {
  var input = document.getElementById("f-ntp-timezone");
  var hidden = document.getElementById("f-ntp-timezone-val");
  var dropdown = document.getElementById("tz-dropdown");
  var clearBtn = document.getElementById("tz-clear");

  // Build timezone list from Intl API
  var allZones;
  try {
    allZones = Intl.supportedValuesOf("timeZone");
  } catch (_) {
    // Fallback for older browsers — populate a reasonable subset
    allZones = [
      "UTC",
      "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
      "America/Anchorage", "America/Phoenix", "America/Toronto", "America/Vancouver",
      "America/Mexico_City", "America/Sao_Paulo", "America/Buenos_Aires", "America/Bogota",
      "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome",
      "Europe/Amsterdam", "Europe/Moscow", "Europe/Istanbul", "Europe/Athens",
      "Asia/Tokyo", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Singapore", "Asia/Seoul",
      "Asia/Kolkata", "Asia/Dubai", "Asia/Bangkok", "Asia/Taipei", "Asia/Jakarta",
      "Australia/Sydney", "Australia/Melbourne", "Australia/Perth", "Australia/Brisbane",
      "Pacific/Auckland", "Pacific/Honolulu", "Pacific/Fiji",
      "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos", "Africa/Nairobi",
    ];
  }

  var highlightIdx = -1;

  // Set initial display value
  if (currentValue) {
    input.value = currentValue;
    clearBtn.style.display = "";
  }

  function renderOptions(filter) {
    var html = "";
    var count = 0;
    var currentGroup = "";
    var filterLower = (filter || "").toLowerCase();

    // Group by region (part before /)
    for (var i = 0; i < allZones.length; i++) {
      var tz = allZones[i];
      if (filterLower && tz.toLowerCase().indexOf(filterLower) === -1) continue;

      var slash = tz.indexOf("/");
      var group = slash > 0 ? tz.substring(0, slash) : "Other";
      var label = slash > 0 ? tz.substring(slash + 1).replace(/_/g, " ") : tz;

      if (group !== currentGroup) {
        currentGroup = group;
        html += '<div class="search-select-group">' + escapeHtml(group) + '</div>';
      }

      html += '<div class="search-select-option" data-value="' + escapeHtml(tz) + '"' +
        (tz === hidden.value ? ' class="search-select-option selected"' : '') +
        '>' + escapeHtml(label) + ' <span style="color:var(--color-text-tertiary);font-size:0.78rem">' + escapeHtml(tz) + '</span></div>';
      count++;
    }

    if (count === 0) {
      html = '<div class="search-select-empty">No timezones match "' + escapeHtml(filter) + '"</div>';
    }

    dropdown.innerHTML = html;
    highlightIdx = -1;

    // Wire click handlers
    dropdown.querySelectorAll(".search-select-option").forEach(function (opt) {
      opt.addEventListener("mousedown", function (e) {
        e.preventDefault(); // prevent blur
        selectTz(opt.getAttribute("data-value"));
      });
    });
  }

  function selectTz(value) {
    hidden.value = value;
    input.value = value;
    clearBtn.style.display = value ? "" : "none";
    closeDropdown();
    updateCurrentTime();
  }

  function clearTz() {
    hidden.value = "";
    input.value = "";
    clearBtn.style.display = "none";
    closeDropdown();
    updateCurrentTime();
  }

  function openDropdown() {
    renderOptions(input.value === hidden.value ? "" : input.value);
    dropdown.classList.add("open");

    // Scroll to selected item
    var sel = dropdown.querySelector(".selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function closeDropdown() {
    dropdown.classList.remove("open");
    highlightIdx = -1;
    // Restore display value
    input.value = hidden.value || "";
  }

  function getVisibleOptions() {
    return dropdown.querySelectorAll(".search-select-option");
  }

  function updateHighlight(opts) {
    opts.forEach(function (o, i) {
      if (i === highlightIdx) {
        o.classList.add("highlighted");
        o.scrollIntoView({ block: "nearest" });
      } else {
        o.classList.remove("highlighted");
      }
    });
  }

  input.addEventListener("focus", function () {
    input.select();
    openDropdown();
  });

  input.addEventListener("input", function () {
    renderOptions(input.value);
    dropdown.classList.add("open");
  });

  input.addEventListener("blur", function () {
    // Small delay to allow mousedown on option to fire first
    setTimeout(closeDropdown, 150);
  });

  input.addEventListener("keydown", function (e) {
    var opts = getVisibleOptions();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!dropdown.classList.contains("open")) { openDropdown(); return; }
      highlightIdx = Math.min(highlightIdx + 1, opts.length - 1);
      updateHighlight(opts);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlightIdx = Math.max(highlightIdx - 1, 0);
      updateHighlight(opts);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIdx >= 0 && highlightIdx < opts.length) {
        selectTz(opts[highlightIdx].getAttribute("data-value"));
      }
    } else if (e.key === "Escape") {
      closeDropdown();
      input.blur();
    }
  });

  clearBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    clearTz();
    input.focus();
  });
}

// ─── DNS Settings ─────────────────────────────────────────────────────────

var _dnsDefaults = { servers: [], mode: "standard", dohUrl: "" };

function dnsCardsHTML() {
  return '<div class="settings-card">' +
    '<h4>DNS Configuration</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'Configure custom DNS servers for reverse lookups (PTR records). These servers are used when resolving IP addresses ' +
      'to hostnames — both for manual DNS lookups on the Assets page and during automated integration discovery.' +
    '</p>' +
    '<div class="form-group"><label>Protocol</label>' +
      '<select id="f-dns-mode">' +
        '<option value="standard"' + (_dnsDefaults.mode === "standard" ? ' selected' : '') + '>Standard (UDP/TCP)</option>' +
        '<option value="dot"' + (_dnsDefaults.mode === "dot" ? ' selected' : '') + '>DNS over TLS (DoT)</option>' +
        '<option value="doh"' + (_dnsDefaults.mode === "doh" ? ' selected' : '') + '>DNS over HTTPS (DoH)</option>' +
      '</select>' +
      '<p class="hint">Standard uses plain DNS on port 53. DoT encrypts queries via TLS on port 853. DoH sends queries over HTTPS.</p>' +
    '</div>' +
    '<div id="dns-servers-group" class="form-group"><label>DNS Servers</label>' +
      '<textarea id="f-dns-servers" rows="5" placeholder="One server per line, e.g.:\n8.8.8.8\ndns.google\n2001:4860:4860::8888">' + escapeHtml(_dnsDefaults.servers.join("\n")) + '</textarea>' +
      '<p class="hint" id="dns-servers-hint">Enter one server per line. IP addresses and hostnames are both supported. When empty, the system default resolver is used.</p>' +
      '<div id="dns-servers-examples" style="margin-top:0.5rem;font-size:0.78rem;color:var(--color-text-tertiary)"></div>' +
    '</div>' +
    '<div id="dns-doh-group" class="form-group" style="display:none"><label>DoH URL</label>' +
      '<input type="text" id="f-dns-doh-url" value="' + escapeHtml(_dnsDefaults.dohUrl) + '" placeholder="https://dns.google/resolve">' +
      '<p class="hint">The HTTPS endpoint for DNS queries. Must support the JSON API (application/dns-json). Common providers:</p>' +
      '<div style="margin-top:0.4rem;font-size:0.78rem;color:var(--color-text-tertiary)">' +
        '<table style="border-collapse:collapse;width:100%">' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Google</td><td class="mono">https://dns.google/resolve</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Cloudflare</td><td class="mono">https://cloudflare-dns.com/dns-query</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Quad9</td><td class="mono">https://dns.quad9.net:5053/dns-query</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">AdGuard</td><td class="mono">https://dns.adguard-dns.com/dns-query</td></tr>' +
        '</table>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn btn-primary" id="btn-dns-save">Save DNS Settings</button>' +
    '</div>' +
  '</div>' +
  '<div class="settings-card">' +
    '<h4>Test DNS Lookup</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'Verify that the configured DNS servers can perform reverse lookups by testing with a known IP address.' +
    '</p>' +
    '<div class="form-group"><label>Test IP Address</label>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<input type="text" id="f-dns-test-ip" value="8.8.8.8" placeholder="e.g. 8.8.8.8 or 2001:4860:4860::8888" style="width:320px">' +
        '<button class="btn btn-secondary" id="btn-dns-test">Test Lookup</button>' +
      '</div>' +
      '<p class="hint">Enter an IPv4 or IPv6 address to perform a test PTR lookup against the configured servers.</p>' +
      '<div id="dns-status" style="font-size:0.82rem;margin-top:0.4rem"></div>' +
    '</div>' +
  '</div>';
}

function wireDnsControls() {
  var modeSelect = document.getElementById("f-dns-mode");
  modeSelect.addEventListener("change", updateDnsFieldVisibility);
  updateDnsFieldVisibility();
  document.getElementById("btn-dns-save").addEventListener("click", saveDnsSettings);
  document.getElementById("btn-dns-test").addEventListener("click", testDnsLookup);
}

function updateDnsFieldVisibility() {
  var mode = document.getElementById("f-dns-mode").value;
  var serversGroup = document.getElementById("dns-servers-group");
  var dohGroup = document.getElementById("dns-doh-group");
  var serversHint = document.getElementById("dns-servers-hint");
  var serversExamples = document.getElementById("dns-servers-examples");

  if (mode === "doh") {
    serversGroup.style.display = "none";
    dohGroup.style.display = "";
  } else {
    serversGroup.style.display = "";
    dohGroup.style.display = "none";
    if (mode === "dot") {
      serversHint.textContent = "Enter one server per line. IP addresses and hostnames are both supported. Port 853 (TLS) is used automatically.";
      serversExamples.innerHTML =
        '<table style="border-collapse:collapse;width:100%">' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Google</td><td class="mono">dns.google</td><td class="mono" style="padding-left:12px">8.8.8.8</td><td class="mono" style="padding-left:12px">2001:4860:4860::8888</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Cloudflare</td><td class="mono">one.one.one.one</td><td class="mono" style="padding-left:12px">1.1.1.1</td><td class="mono" style="padding-left:12px">2606:4700:4700::1111</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Quad9</td><td class="mono">dns.quad9.net</td><td class="mono" style="padding-left:12px">9.9.9.9</td><td class="mono" style="padding-left:12px">2620:fe::fe</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">AdGuard</td><td class="mono">dns.adguard-dns.com</td><td class="mono" style="padding-left:12px">94.140.14.14</td><td class="mono" style="padding-left:12px">2a10:50c0::ad1:ff</td></tr>' +
        '</table>';
    } else {
      serversHint.textContent = "Enter one server per line. IP addresses and hostnames are both supported. When empty, the system default resolver is used.";
      serversExamples.innerHTML =
        '<table style="border-collapse:collapse;width:100%">' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Google</td><td class="mono">dns.google</td><td class="mono" style="padding-left:12px">8.8.8.8</td><td class="mono" style="padding-left:12px">2001:4860:4860::8888</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Cloudflare</td><td class="mono">one.one.one.one</td><td class="mono" style="padding-left:12px">1.1.1.1</td><td class="mono" style="padding-left:12px">2606:4700:4700::1111</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Quad9</td><td class="mono">dns.quad9.net</td><td class="mono" style="padding-left:12px">9.9.9.9</td><td class="mono" style="padding-left:12px">2620:fe::fe</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">OpenDNS</td><td class="mono">dns.opendns.com</td><td class="mono" style="padding-left:12px">208.67.222.222</td><td class="mono" style="padding-left:12px">2620:119:35::35</td></tr>' +
        '</table>';
    }
  }
}

function collectDnsForm() {
  return {
    mode: document.getElementById("f-dns-mode").value,
    servers: document.getElementById("f-dns-servers").value
      .split("\n").map(function (s) { return s.trim(); }).filter(Boolean),
    dohUrl: (document.getElementById("f-dns-doh-url").value || "").trim(),
  };
}

async function saveDnsSettings() {
  var btn = document.getElementById("btn-dns-save");
  btn.disabled = true;
  try {
    await api.serverSettings.updateDns(collectDnsForm());
    showToast("DNS settings saved");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function testDnsLookup() {
  var btn = document.getElementById("btn-dns-test");
  var statusEl = document.getElementById("dns-status");
  btn.disabled = true;
  statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Testing...</span>';
  try {
    var form = collectDnsForm();
    form.testIp = document.getElementById("f-dns-test-ip").value.trim() || "8.8.8.8";
    var result = await api.serverSettings.testDns(form);
    statusEl.innerHTML = result.ok
      ? '<span style="color:var(--color-success)">' + escapeHtml(result.message) + '</span>'
      : '<span style="color:var(--color-danger)">' + escapeHtml(result.message) + '</span>';
  } catch (err) {
    statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
  } finally {
    btn.disabled = false;
  }
}

// ─── OUI Database ──────────────────────────────────────────────────────────

async function loadOuiStatus() {
  try {
    var status = await api.serverSettings.getOui();
    document.getElementById("oui-status-loaded").textContent = status.loaded ? "Loaded" : "Not downloaded";
    document.getElementById("oui-status-entries").textContent = status.entries ? status.entries.toLocaleString() + " vendors" : "-";
    document.getElementById("oui-status-refreshed").textContent = status.refreshedAt ? formatDate(status.refreshedAt) : "Never";
  } catch (_) {
    document.getElementById("oui-status-loaded").textContent = "Error loading status";
  }
}

async function refreshOuiDatabase() {
  var btn = document.getElementById("btn-oui-refresh");
  var statusEl = document.getElementById("oui-refresh-status");
  btn.disabled = true;
  statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Downloading IEEE OUI database...</span>';
  try {
    var result = await api.serverSettings.refreshOui();
    statusEl.innerHTML = '<span style="color:var(--color-success)">' +
      escapeHtml(result.entries.toLocaleString() + " entries loaded (" + result.sizeKb + " KB)") + '</span>';
    showToast("OUI database refreshed — " + result.entries.toLocaleString() + " vendors", "success");
    loadOuiStatus();
  } catch (err) {
    statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
    showToast("OUI refresh failed: " + err.message, "error");
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

    container.innerHTML =
      // ── Application Updates card ──
      '<div class="settings-card" id="update-card">' +
        '<h4>Application Updates</h4>' +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
          'Check for new versions and apply updates directly from the browser. Updates include a pre-update database backup and automatic rollback on failure.' +
        '</p>' +
        '<div id="update-status-area">' +
          '<div class="db-info-grid" style="margin-bottom:1rem">' +
            '<div class="db-info-label">Current Version</div>' +
            '<div class="db-info-value" id="update-current-version">v' + escapeHtml(_branding && _branding.version ? _branding.version : '?') + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<button class="btn btn-secondary" id="btn-check-updates">Check for Updates</button>' +
            '<span id="update-check-status" style="font-size:0.82rem"></span>' +
          '</div>' +
        '</div>' +
      '</div>' +
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

      // ── Backup Card ──
      '<div class="settings-card">' +
        '<h4>Backup</h4>' +
        '<p class="hint" style="margin-bottom:0.75rem">Create a compressed backup of the database. Optionally encrypt with a password for secure storage or transfer.</p>' +
        '<div class="form-row" style="align-items:flex-end;gap:12px;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:200px">' +
            '<label for="backup-password">Encryption password <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
            '<input type="password" id="backup-password" placeholder="Leave blank for unencrypted backup" autocomplete="new-password">' +
          '</div>' +
          '<div style="flex:1;min-width:200px">' +
            '<label for="backup-password-confirm">Confirm password</label>' +
            '<input type="password" id="backup-password-confirm" placeholder="Re-enter password" autocomplete="new-password">' +
          '</div>' +
          '<div>' +
            '<button class="btn btn-primary" id="btn-backup" style="white-space:nowrap">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
              'Create Backup</button>' +
          '</div>' +
        '</div>' +
        '<div id="backup-status" style="margin-top:0.5rem"></div>' +
      '</div>' +

      // ── Restore Card ──
      '<div class="settings-card">' +
        '<h4>Restore</h4>' +
        '<p class="hint" style="margin-bottom:0.75rem">Restore the database from a previously created backup file. This will replace all current data.</p>' +
        '<div class="restore-drop-zone" id="restore-drop-zone">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" style="opacity:0.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
          '<p>Drag and drop a backup file here, or <label for="restore-file-input" class="link-text" style="cursor:pointer">browse</label></p>' +
          '<p class="hint">Accepts .gz or .enc.gz files</p>' +
          '<input type="file" id="restore-file-input" accept=".gz" style="display:none">' +
        '</div>' +
        '<div id="restore-file-info" style="display:none;margin-top:0.75rem">' +
          '<div class="db-info-grid" style="margin-bottom:0.75rem">' +
            '<div class="db-info-label">File</div><div class="db-info-value" id="restore-filename">-</div>' +
            '<div class="db-info-label">Size</div><div class="db-info-value" id="restore-filesize">-</div>' +
            '<div class="db-info-label">Backup version</div><div class="db-info-value" id="restore-version">-</div>' +
            '<div class="db-info-label">Encrypted</div><div class="db-info-value" id="restore-encrypted">-</div>' +
          '</div>' +
          '<div id="restore-version-warning" style="display:none;margin-bottom:0.75rem;padding:0.6rem 0.75rem;border-radius:6px;background:color-mix(in srgb, var(--color-warning) 12%, transparent);border:1px solid color-mix(in srgb, var(--color-warning) 30%, transparent);font-size:0.82rem;color:var(--color-text-primary)">' +
            '<strong style="color:var(--color-warning)">Version mismatch</strong> — ' +
            'This backup was created with a different version of Shelob. ' +
            'Restoring a backup from a different version may fail or cause issues if the database schema has changed. ' +
            'For best results, ensure the application version matches the backup version before restoring.' +
          '</div>' +
          '<div id="restore-password-row" style="display:none;margin-bottom:0.75rem">' +
            '<label for="restore-password">Decryption password</label>' +
            '<input type="password" id="restore-password" placeholder="Enter the password used during backup" autocomplete="off">' +
          '</div>' +
          '<div style="display:flex;gap:8px">' +
            '<button class="btn btn-danger" id="btn-restore">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
              'Restore Database</button>' +
            '<button class="btn btn-secondary" id="btn-restore-cancel">Cancel</button>' +
          '</div>' +
        '</div>' +
        '<div id="restore-status" style="margin-top:0.5rem"></div>' +
      '</div>' +

      // ── Backup History Card ──
      '<div class="settings-card">' +
        '<h4>Backup History</h4>' +
        '<div id="backup-history-body"><p class="empty-state">Loading...</p></div>' +
      '</div>' +

      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button class="btn btn-secondary" id="btn-db-refresh">Refresh</button>' +
      '</div>';

    // Wire up events
    document.getElementById("btn-db-refresh").addEventListener("click", function () {
      _dbLoaded = false;
      loadDatabaseInfo();
    });

    initBackupControls();
    initRestoreControls();
    loadBackupHistory();
    initUpdateControls();
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

// ─── Backup Logic ───────────────────────────────────────────────────────────

function initBackupControls() {
  var btnBackup = document.getElementById("btn-backup");
  btnBackup.addEventListener("click", async function () {
    var pw = document.getElementById("backup-password").value;
    var pwConfirm = document.getElementById("backup-password-confirm").value;
    var statusEl = document.getElementById("backup-status");

    if (pw && pw !== pwConfirm) {
      statusEl.innerHTML = '<span class="badge badge-error">Passwords do not match</span>';
      return;
    }

    btnBackup.disabled = true;
    btnBackup.textContent = "Creating backup...";
    statusEl.innerHTML = '<span class="badge badge-info">Compressing' + (pw ? " and encrypting" : "") + ' database...</span>';

    try {
      var result = await api.serverSettings.backupDatabase(pw || null);
      if (!result || !result.blob) throw new Error("No data received");

      // Trigger download
      var url = URL.createObjectURL(result.blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      var sizeKb = (result.blob.size / 1024).toFixed(1);
      statusEl.innerHTML = '<span class="badge badge-success">Backup created: ' + escapeHtml(result.filename) + ' (' + sizeKb + ' KB' + (pw ? ', encrypted' : '') + ')</span>';
      document.getElementById("backup-password").value = "";
      document.getElementById("backup-password-confirm").value = "";
      showToast("Backup downloaded: " + result.filename, "success");
      loadBackupHistory();
    } catch (err) {
      statusEl.innerHTML = '<span class="badge badge-error">' + escapeHtml(err.message) + '</span>';
      showToast("Backup failed: " + err.message, "error");
    } finally {
      btnBackup.disabled = false;
      btnBackup.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Create Backup';
    }
  });
}

// ─── Restore Logic ──────────────────────────────────────────────────────────

var _restoreFile = null;

function initRestoreControls() {
  var dropZone = document.getElementById("restore-drop-zone");
  var fileInput = document.getElementById("restore-file-input");
  var fileInfo = document.getElementById("restore-file-info");
  var btnRestore = document.getElementById("btn-restore");
  var btnCancel = document.getElementById("btn-restore-cancel");

  dropZone.addEventListener("dragover", function (e) {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", function () {
    dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", function (e) {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files.length > 0) selectRestoreFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener("change", function () {
    if (fileInput.files.length > 0) selectRestoreFile(fileInput.files[0]);
  });

  btnCancel.addEventListener("click", function () {
    _restoreFile = null;
    fileInfo.style.display = "none";
    dropZone.style.display = "";
    document.getElementById("restore-status").innerHTML = "";
    fileInput.value = "";
  });

  btnRestore.addEventListener("click", async function () {
    if (!_restoreFile) return;
    var pw = document.getElementById("restore-password")?.value || null;
    var statusEl = document.getElementById("restore-status");

    var confirmed = await showConfirm("This will replace ALL current data with the backup contents. This cannot be undone. Continue?");
    if (!confirmed) return;

    btnRestore.disabled = true;
    btnRestore.textContent = "Restoring...";
    statusEl.innerHTML = '<span class="badge badge-info">Restoring database...</span>';

    try {
      var result = await api.serverSettings.restoreDatabase(_restoreFile, pw);
      statusEl.innerHTML = '<span class="badge badge-success">' + escapeHtml(result.message || "Restore completed") +
        (result.backupDate ? ' (backup from ' + escapeHtml(formatDate(result.backupDate)) + ')' : '') + '</span>';
      showToast("Database restored successfully", "success");

      // Reset the form
      _restoreFile = null;
      fileInfo.style.display = "none";
      dropZone.style.display = "";
      document.getElementById("restore-file-input").value = "";

      // Refresh the database info
      setTimeout(function () {
        _dbLoaded = false;
        loadDatabaseInfo();
      }, 1500);
    } catch (err) {
      statusEl.innerHTML = '<span class="badge badge-error">' + escapeHtml(err.message) + '</span>';
      showToast("Restore failed: " + err.message, "error");
    } finally {
      btnRestore.disabled = false;
      btnRestore.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Restore Database';
    }
  });
}

function selectRestoreFile(file) {
  _restoreFile = file;
  var dropZone = document.getElementById("restore-drop-zone");
  var fileInfo = document.getElementById("restore-file-info");
  var statusEl = document.getElementById("restore-status");

  dropZone.style.display = "none";
  fileInfo.style.display = "";
  statusEl.innerHTML = "";

  document.getElementById("restore-filename").textContent = file.name;
  document.getElementById("restore-filesize").textContent = formatFileSize(file.size);

  // Extract version from filename: shelob-backup-1.0.0-2026-...gz
  var versionMatch = file.name.match(/shelob-backup-(\d+\.\d+\.\d+)-/);
  var backupVersion = versionMatch ? versionMatch[1] : null;
  var currentVersion = _branding && _branding.version ? _branding.version : null;
  var versionEl = document.getElementById("restore-version");
  var warningEl = document.getElementById("restore-version-warning");

  if (backupVersion) {
    versionEl.textContent = backupVersion;
    if (currentVersion && backupVersion !== currentVersion) {
      warningEl.style.display = "";
      warningEl.innerHTML =
        '<strong style="color:var(--color-warning)">Version mismatch</strong> — ' +
        'This backup was created with <strong>v' + escapeHtml(backupVersion) + '</strong>, ' +
        'but the running application is <strong>v' + escapeHtml(currentVersion) + '</strong>. ' +
        'Restoring a backup from a different version may fail or cause issues if the database schema has changed. ' +
        'For best results, ensure the application version matches the backup version before restoring.';
    } else {
      warningEl.style.display = "none";
    }
  } else {
    versionEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Unknown</span>';
    warningEl.style.display = "";
    warningEl.innerHTML =
      '<strong style="color:var(--color-warning)">Unknown version</strong> — ' +
      'Could not determine the application version from this backup file. ' +
      'Ensure this backup was created by a compatible version of Shelob before restoring.';
  }

  var isEncrypted = file.name.includes(".enc");
  document.getElementById("restore-encrypted").innerHTML = isEncrypted
    ? '<span class="badge badge-warning" style="font-size:0.75rem">Yes</span>'
    : '<span class="badge badge-info" style="font-size:0.75rem">No</span>';
  document.getElementById("restore-password-row").style.display = isEncrypted ? "" : "none";

  // Also check magic bytes for encryption detection
  if (file.size > 8) {
    var reader = new FileReader();
    reader.onload = function () {
      var arr = new Uint8Array(reader.result);
      var magic = String.fromCharCode.apply(null, arr.slice(0, 7));
      if (magic === "SHELOB1") {
        document.getElementById("restore-encrypted").innerHTML = '<span class="badge badge-warning" style="font-size:0.75rem">Yes</span>';
        document.getElementById("restore-password-row").style.display = "";
      }
    };
    reader.readAsArrayBuffer(file.slice(0, 8));
  }
}

// ─── Backup History ─────────────────────────────────────────────────────────

async function loadBackupHistory() {
  var body = document.getElementById("backup-history-body");
  if (!body) return;
  try {
    var history = await api.serverSettings.listBackups();
    if (!history || history.length === 0) {
      body.innerHTML = '<p class="empty-state" style="font-size:0.85rem">No backups have been created yet.</p>';
      return;
    }
    body.innerHTML =
      '<table class="ip-table"><thead><tr>' +
        '<th>Date</th><th>Filename</th><th style="text-align:right">Size</th><th>Encrypted</th><th style="width:140px"></th>' +
      '</tr></thead><tbody>' +
      history.slice(0, 20).map(function (b) {
        var dlBtn = b.downloadable !== false
          ? '<button class="btn btn-secondary btn-sm backup-dl-btn" data-id="' + escapeHtml(b.id) + '" data-filename="' + escapeHtml(b.filename) + '" style="font-size:0.75rem;padding:2px 8px">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px;margin-right:3px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
              'Download</button>'
          : '<span style="font-size:0.75rem;color:var(--color-text-tertiary)">Unavailable</span>';
        return '<tr>' +
          '<td style="font-size:0.82rem;white-space:nowrap">' + escapeHtml(formatDate(b.createdAt)) + '</td>' +
          '<td class="mono" style="font-size:0.82rem">' + escapeHtml(b.filename) + '</td>' +
          '<td style="text-align:right;font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(b.size || formatFileSize(b.sizeBytes || 0)) + '</td>' +
          '<td>' + (b.encrypted
            ? '<span class="badge badge-warning" style="font-size:0.7rem">Encrypted</span>'
            : '<span class="badge badge-info" style="font-size:0.7rem">Plain</span>') +
          '</td>' +
          '<td style="display:flex;gap:4px">' + dlBtn +
            '<button class="btn btn-danger btn-sm backup-del-btn" data-id="' + escapeHtml(b.id) + '" style="font-size:0.75rem;padding:2px 8px" title="Delete">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>' +
            '</button>' +
          '</td>' +
          '</tr>';
      }).join("") +
      '</tbody></table>';

    // Wire up download buttons
    body.querySelectorAll(".backup-dl-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        btn.disabled = true;
        btn.textContent = "...";
        api.serverSettings.downloadBackup(id).then(function (result) {
          if (!result || !result.blob) throw new Error("No data received");
          var url = URL.createObjectURL(result.blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = result.filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          showToast("Downloaded: " + result.filename, "success");
        }).catch(function (err) {
          showToast("Download failed: " + err.message, "error");
        }).finally(function () {
          btn.disabled = false;
          btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px;margin-right:3px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download';
        });
      });
    });

    body.querySelectorAll(".backup-del-btn").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.getAttribute("data-id");
        var ok = await showConfirm("Delete this backup? This cannot be undone.");
        if (!ok) return;
        btn.disabled = true;
        try {
          await api.serverSettings.deleteBackup(id);
          showToast("Backup deleted");
          loadBackupHistory();
        } catch (err) {
          showToast("Delete failed: " + err.message, "error");
          btn.disabled = false;
        }
      });
    });
  } catch {
    body.innerHTML = '<p class="empty-state" style="font-size:0.85rem">Could not load backup history.</p>';
  }
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  var units = ["B", "KB", "MB", "GB"];
  var i = 0;
  var size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

function dbInfoRow(label, value) {
  return '<div class="db-info-label">' + escapeHtml(label) + '</div>' +
         '<div class="db-info-value">' + escapeHtml(String(value)) + '</div>';
}

function formatNumber(n) {
  if (n === undefined || n === null) return "-";
  return Number(n).toLocaleString();
}

// ─── Application Updates ───────────────────────────────────────────────────

var _updatePollTimer = null;

function initUpdateControls() {
  document.getElementById("btn-check-updates").addEventListener("click", checkForUpdatesUI);

  // Check if there's a pending notification from a background check or previous restart
  api.serverSettings.getUpdateStatus().then(function (status) {
    if (status.state === "complete") {
      renderUpdateComplete(status);
    } else if (status.state === "failed") {
      renderUpdateFailed(status);
    } else if (status.state === "available") {
      renderUpdateAvailable(status);
    } else if (status.state === "applying" || status.state === "restarting") {
      renderUpdateProgress();
      renderSteps(status.steps);
      startUpdatePolling();
    }
  }).catch(function () {});
}

async function checkForUpdatesUI() {
  var btn = document.getElementById("btn-check-updates");
  var statusEl = document.getElementById("update-check-status");
  btn.disabled = true;
  btn.textContent = "Checking...";
  statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Fetching latest version...</span>';

  try {
    var result = await api.serverSettings.checkForUpdates();

    if (result.state === "up-to-date") {
      statusEl.innerHTML = '<span style="color:var(--color-success)">Up to date (v' + escapeHtml(result.currentVersion) + ')</span>';
      btn.textContent = "Check for Updates";
      btn.disabled = false;
      return;
    }

    if (result.state === "available") {
      renderUpdateAvailable(result);
      return;
    }

    if (result.state === "failed") {
      statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(result.error || "Check failed") + '</span>';
    }
  } catch (err) {
    statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
  }

  btn.textContent = "Check for Updates";
  btn.disabled = false;
}

function renderUpdateAvailable(result) {
  var area = document.getElementById("update-status-area");

  var changesHtml = "";
  if (result.changes && result.changes.length > 0) {
    changesHtml = '<div style="margin-top:0.75rem"><label style="font-size:0.78rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--color-text-tertiary)">Changes (' + result.commitsBehind + ' commit' + (result.commitsBehind === 1 ? '' : 's') + ')</label>' +
      '<div style="max-height:160px;overflow-y:auto;margin-top:0.4rem;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary)">';
    result.changes.forEach(function (c) {
      var parts = c.match(/^(\w+)\s+(.*)$/);
      if (parts) {
        changesHtml += '<div style="padding:0.3rem 0.6rem;font-size:0.82rem;border-bottom:1px solid var(--color-border)">' +
          '<span class="mono" style="color:var(--color-text-tertiary);margin-right:8px">' + escapeHtml(parts[1]) + '</span>' +
          '<span>' + escapeHtml(parts[2]) + '</span></div>';
      } else {
        changesHtml += '<div style="padding:0.3rem 0.6rem;font-size:0.82rem;border-bottom:1px solid var(--color-border)">' + escapeHtml(c) + '</div>';
      }
    });
    changesHtml += '</div></div>';
  }

  area.innerHTML =
    '<div style="background:color-mix(in srgb, var(--color-primary) 10%, transparent);border:1px solid var(--color-primary);border-radius:6px;padding:1rem;margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<span style="color:var(--color-primary);font-weight:600;font-size:0.95rem">Update Available</span>' +
      '</div>' +
      '<div class="db-info-grid">' +
        '<div class="db-info-label">Current</div><div class="db-info-value">v' + escapeHtml(result.currentVersion) + ' <span class="mono" style="color:var(--color-text-tertiary)">(' + escapeHtml(result.currentCommit) + ')</span></div>' +
        '<div class="db-info-label">Latest</div><div class="db-info-value">v' + escapeHtml(result.latestVersion) + ' <span class="mono" style="color:var(--color-text-tertiary)">(' + escapeHtml(result.latestCommit) + ')</span></div>' +
      '</div>' +
      changesHtml +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn btn-primary" id="btn-apply-update">Apply Update</button>' +
      '<button class="btn btn-secondary" id="btn-check-updates">Check Again</button>' +
      '<span id="update-check-status" style="font-size:0.82rem"></span>' +
    '</div>';

  document.getElementById("btn-apply-update").addEventListener("click", applyUpdateUI);
  document.getElementById("btn-check-updates").addEventListener("click", checkForUpdatesUI);
}

async function applyUpdateUI() {
  var confirmed = await showConfirm(
    "Apply this update? The server will restart automatically when complete. " +
    "A database backup will be created before updating."
  );
  if (!confirmed) return;

  var btn = document.getElementById("btn-apply-update");
  btn.disabled = true;
  btn.textContent = "Starting update...";

  try {
    await api.serverSettings.applyUpdate();
    renderUpdateProgress();
    startUpdatePolling();
  } catch (err) {
    showToast("Failed to start update: " + err.message, "error");
    btn.disabled = false;
    btn.textContent = "Apply Update";
  }
}

function renderUpdateProgress() {
  var area = document.getElementById("update-status-area");
  area.innerHTML =
    '<div style="margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.75rem">' +
        '<div class="spinner" style="width:18px;height:18px"></div>' +
        '<span style="font-weight:600">Updating...</span>' +
      '</div>' +
      '<div id="update-steps-list"></div>' +
    '</div>';
}

function renderSteps(steps) {
  var el = document.getElementById("update-steps-list");
  if (!el) return;

  var html = '';
  (steps || []).forEach(function (step) {
    var icon = '';
    var color = 'var(--color-text-tertiary)';
    if (step.status === "done") { icon = '&#10003;'; color = 'var(--color-success)'; }
    else if (step.status === "running") { icon = '&#9679;'; color = 'var(--color-primary)'; }
    else if (step.status === "failed") { icon = '&#10007;'; color = 'var(--color-danger)'; }
    else { icon = '&#9675;'; }

    html += '<div style="display:flex;align-items:center;gap:8px;padding:0.35rem 0;font-size:0.88rem">' +
      '<span style="color:' + color + ';font-size:1rem;width:20px;text-align:center;flex-shrink:0">' + icon + '</span>' +
      '<span style="' + (step.status === "running" ? 'font-weight:600' : '') + '">' + escapeHtml(step.name) + '</span>' +
      (step.message ? '<span style="color:var(--color-text-tertiary);font-size:0.78rem;margin-left:auto">' + escapeHtml(step.message) + '</span>' : '') +
    '</div>';
  });
  el.innerHTML = html;
}

function startUpdatePolling() {
  if (_updatePollTimer) clearInterval(_updatePollTimer);
  _updatePollTimer = setInterval(pollUpdateStatus, 2000);
}

function stopUpdatePolling() {
  if (_updatePollTimer) { clearInterval(_updatePollTimer); _updatePollTimer = null; }
}

var _serverDownSince = null;

async function pollUpdateStatus() {
  try {
    var status = await api.serverSettings.getUpdateStatus();
    _serverDownSince = null;

    if (status.state === "applying" || status.state === "restarting") {
      renderSteps(status.steps);
      if (status.state === "restarting") {
        // Server is about to go down — switch to restart polling
        stopUpdatePolling();
        pollForRestart(status);
      }
      return;
    }

    if (status.state === "complete") {
      stopUpdatePolling();
      renderUpdateComplete(status);
      return;
    }

    if (status.state === "failed") {
      stopUpdatePolling();
      renderUpdateFailed(status);
      return;
    }
  } catch (err) {
    // Server is down — it's probably restarting
    if (!_serverDownSince) _serverDownSince = Date.now();
    // If server has been down for more than 60s, show an error
    if (Date.now() - _serverDownSince > 60000) {
      stopUpdatePolling();
      var area = document.getElementById("update-status-area");
      if (area) {
        area.innerHTML =
          '<div style="background:color-mix(in srgb, var(--color-danger) 10%, transparent);border:1px solid var(--color-danger);border-radius:6px;padding:1rem">' +
            '<strong style="color:var(--color-danger)">Server unreachable</strong>' +
            '<p style="font-size:0.82rem;margin-top:0.5rem">The server has not responded for over 60 seconds. It may have failed to restart. Check the server logs.</p>' +
          '</div>';
      }
    }
  }
}

function pollForRestart(lastStatus) {
  var area = document.getElementById("update-status-area");
  if (area) {
    renderSteps(lastStatus.steps);
    var stepsEl = document.getElementById("update-steps-list");
    if (stepsEl) {
      stepsEl.innerHTML += '<div style="display:flex;align-items:center;gap:8px;padding:0.5rem 0;font-size:0.88rem">' +
        '<div class="spinner" style="width:16px;height:16px"></div>' +
        '<span>Waiting for server to restart...</span>' +
      '</div>';
    }
  }

  var attempts = 0;
  var restartTimer = setInterval(async function () {
    attempts++;
    try {
      var status = await api.serverSettings.getUpdateStatus();
      if (status.state === "complete") {
        clearInterval(restartTimer);
        renderUpdateComplete(status);
        return;
      }
      if (status.state === "failed") {
        clearInterval(restartTimer);
        renderUpdateFailed(status);
        return;
      }
    } catch (_) {
      // Server still down
    }
    if (attempts > 30) {
      clearInterval(restartTimer);
      if (area) {
        area.innerHTML =
          '<div style="background:color-mix(in srgb, var(--color-danger) 10%, transparent);border:1px solid var(--color-danger);border-radius:6px;padding:1rem">' +
            '<strong style="color:var(--color-danger)">Server did not come back</strong>' +
            '<p style="font-size:0.82rem;margin-top:0.5rem">The server has not responded after 60 seconds. Check the server logs for errors.</p>' +
            '<button class="btn btn-secondary" style="margin-top:0.75rem" onclick="location.reload()">Retry</button>' +
          '</div>';
      }
    }
  }, 2000);
}

function renderUpdateComplete(status) {
  var area = document.getElementById("update-status-area");
  if (!area) return;

  area.innerHTML =
    '<div style="background:color-mix(in srgb, var(--color-success) 10%, transparent);border:1px solid var(--color-success);border-radius:6px;padding:1rem;margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<span style="color:var(--color-success);font-weight:600;font-size:0.95rem">&#10003; Update Complete</span>' +
      '</div>' +
      '<div class="db-info-grid">' +
        (status.currentVersion ? '<div class="db-info-label">Previous</div><div class="db-info-value">v' + escapeHtml(status.currentVersion) + '</div>' : '') +
        (status.latestVersion ? '<div class="db-info-label">Current</div><div class="db-info-value">v' + escapeHtml(status.latestVersion) + '</div>' : '') +
      '</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn btn-secondary" id="btn-dismiss-update">Dismiss</button>' +
      '<button class="btn btn-secondary" onclick="location.reload()">Reload Page</button>' +
    '</div>';

  document.getElementById("btn-dismiss-update").addEventListener("click", async function () {
    await api.serverSettings.dismissUpdate();
    // Reset to check state
    var area2 = document.getElementById("update-status-area");
    area2.innerHTML =
      '<div class="db-info-grid" style="margin-bottom:1rem">' +
        '<div class="db-info-label">Current Version</div>' +
        '<div class="db-info-value">v' + escapeHtml(status.latestVersion || '?') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button class="btn btn-secondary" id="btn-check-updates">Check for Updates</button>' +
        '<span id="update-check-status" style="font-size:0.82rem"></span>' +
      '</div>';
    document.getElementById("btn-check-updates").addEventListener("click", checkForUpdatesUI);
  });
}

function renderUpdateFailed(status) {
  var area = document.getElementById("update-status-area");
  if (!area) return;

  var stepsHtml = '';
  if (status.steps && status.steps.length > 0) {
    stepsHtml = '<div style="margin-top:0.75rem">';
    status.steps.forEach(function (step) {
      var icon = step.status === "done" ? "&#10003;" : step.status === "failed" ? "&#10007;" : "&#9675;";
      var color = step.status === "done" ? "var(--color-success)" : step.status === "failed" ? "var(--color-danger)" : "var(--color-text-tertiary)";
      stepsHtml += '<div style="display:flex;align-items:center;gap:8px;padding:0.25rem 0;font-size:0.85rem">' +
        '<span style="color:' + color + '">' + icon + '</span>' +
        '<span>' + escapeHtml(step.name) + '</span>' +
        (step.message ? '<span style="color:var(--color-text-tertiary);font-size:0.78rem;margin-left:auto">' + escapeHtml(step.message) + '</span>' : '') +
      '</div>';
    });
    stepsHtml += '</div>';
  }

  area.innerHTML =
    '<div style="background:color-mix(in srgb, var(--color-danger) 10%, transparent);border:1px solid var(--color-danger);border-radius:6px;padding:1rem;margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<span style="color:var(--color-danger);font-weight:600;font-size:0.95rem">&#10007; Update Failed</span>' +
      '</div>' +
      '<p style="font-size:0.85rem;margin:0.5rem 0">' + escapeHtml(status.error || 'Unknown error') + '</p>' +
      stepsHtml +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn btn-secondary" id="btn-dismiss-update">Dismiss</button>' +
      '<button class="btn btn-secondary" id="btn-check-updates">Check Again</button>' +
    '</div>';

  document.getElementById("btn-dismiss-update").addEventListener("click", async function () {
    await api.serverSettings.dismissUpdate();
    _dbLoaded = false;
    loadDatabaseInfo();
  });
  document.getElementById("btn-check-updates").addEventListener("click", checkForUpdatesUI);
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
var _ouiOverrides = [];

async function loadIdentificationTab() {
  var container = document.getElementById("tab-identification");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading...</p></div>';

  try {
    var results = await Promise.all([
      api.serverSettings.listTags(),
      api.serverSettings.getTagSettings(),
      api.serverSettings.getDns().catch(function () { return null; }),
      api.serverSettings.getOuiOverrides().catch(function () { return []; }),
    ]);
    _tagsData = results[0];
    _tagSettings = results[1] || { enforce: false };
    if (results[2]) {
      _dnsDefaults.servers = results[2].servers || [];
      _dnsDefaults.mode = results[2].mode || "standard";
      _dnsDefaults.dohUrl = results[2].dohUrl || "";
    }
    _ouiOverrides = results[3] || [];
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
  var html = '';

  // ── 1. DNS Configuration ──
  html += dnsCardsHTML();

  // ── 2. OUI Overrides ──
  html +=
    '<div class="settings-card">' +
      '<h4>OUI Overrides</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Define static MAC prefix-to-manufacturer mappings that take priority over the IEEE OUI database. ' +
        'Use this for custom hardware, internal devices, or to correct misidentified vendors.' +
      '</p>';

  if (_ouiOverrides.length > 0) {
    html += '<table class="ip-table" style="margin-bottom:1rem"><thead><tr>' +
      '<th>MAC Prefix</th><th>Manufacturer</th><th style="width:70px"></th>' +
    '</tr></thead><tbody>';
    _ouiOverrides.forEach(function (o) {
      html += '<tr>' +
        '<td class="mono" style="font-size:0.85rem">' + escapeHtml(o.prefix) + '</td>' +
        '<td>' + escapeHtml(o.manufacturer) + '</td>' +
        '<td class="actions"><button class="btn btn-sm btn-danger oui-override-del" data-prefix="' + escapeHtml(o.prefix) + '">Del</button></td>' +
      '</tr>';
    });
    html += '</tbody></table>';
  } else {
    html += '<p class="empty-state" style="margin-bottom:1rem">No overrides defined. The IEEE OUI database is used for all lookups.</p>';
  }

  html +=
      '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">' +
        '<div style="flex:0 0 140px">' +
          '<label style="font-size:0.78rem;font-weight:500">MAC Prefix</label>' +
          '<input type="text" id="f-oui-prefix" placeholder="AA:BB:CC" style="font-family:var(--font-mono);font-size:0.85rem">' +
        '</div>' +
        '<div style="flex:1;min-width:180px">' +
          '<label style="font-size:0.78rem;font-weight:500">Manufacturer</label>' +
          '<input type="text" id="f-oui-manufacturer" placeholder="e.g. Custom Switch Co.">' +
        '</div>' +
        '<button class="btn btn-primary" id="btn-add-oui-override">Add Override</button>' +
      '</div>' +
    '</div>';

  // ── 3. OUI Database ──
  html +=
    '<div class="settings-card">' +
      '<h4>MAC OUI Database</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'The IEEE OUI (Organizationally Unique Identifier) database maps MAC address prefixes to hardware manufacturers. ' +
        'It is refreshed automatically every week. You can also trigger a manual refresh below.' +
      '</p>' +
      '<div id="oui-status" class="db-info-grid" style="margin-bottom:1rem">' +
        '<div class="db-info-label">Status</div><div class="db-info-value" id="oui-status-loaded">Loading...</div>' +
        '<div class="db-info-label">Entries</div><div class="db-info-value" id="oui-status-entries">-</div>' +
        '<div class="db-info-label">Last Refreshed</div><div class="db-info-value" id="oui-status-refreshed">-</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button class="btn btn-secondary" id="btn-oui-refresh">Refresh OUI Database</button>' +
        '<span id="oui-refresh-status" style="font-size:0.82rem;margin-left:8px"></span>' +
      '</div>' +
    '</div>';

  // ── 4. Tags (bottom) ──
  // Group tags by category
  var categories = {};
  _tagsData.forEach(function (t) {
    var cat = t.category || "General";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(t);
  });
  _emptyCategories.forEach(function (cat) {
    if (!categories[cat]) categories[cat] = [];
  });
  var catNames = Object.keys(categories).sort();

  html +=
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

  // ── Set HTML and wire events ──
  container.innerHTML = html;

  wireDnsControls();
  loadOuiStatus();

  // OUI override events
  document.getElementById("btn-add-oui-override").addEventListener("click", addOuiOverride);
  container.querySelectorAll(".oui-override-del").forEach(function (btn) {
    btn.addEventListener("click", function () {
      deleteOuiOverrideUI(btn.getAttribute("data-prefix"));
    });
  });

  // OUI database refresh
  document.getElementById("btn-oui-refresh").addEventListener("click", refreshOuiDatabase);

  // Tags events
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
      if (typeof _tagCache !== "undefined") _tagCache.loaded = false;
      showToast(newVal ? "Predefined tags enforced" : "Free-text tags enabled");
    } catch (err) {
      cb.checked = !newVal;
      showToast(err.message, "error");
    } finally {
      cb.disabled = false;
    }
  });
}

async function addOuiOverride() {
  var prefix = document.getElementById("f-oui-prefix").value.trim();
  var manufacturer = document.getElementById("f-oui-manufacturer").value.trim();
  if (!prefix || !manufacturer) { showToast("Both MAC prefix and manufacturer are required", "error"); return; }
  try {
    var result = await api.serverSettings.addOuiOverride({ prefix: prefix, manufacturer: manufacturer });
    // Update local cache
    var idx = _ouiOverrides.findIndex(function (o) { return o.prefix === result.prefix; });
    if (idx >= 0) _ouiOverrides[idx] = result;
    else _ouiOverrides.push(result);
    _ouiOverrides.sort(function (a, b) { return a.prefix.localeCompare(b.prefix); });
    var msg = "OUI override added: " + result.prefix + " → " + result.manufacturer;
    if (result.assetsUpdated > 0) msg += " (" + result.assetsUpdated + " asset" + (result.assetsUpdated === 1 ? "" : "s") + " updated)";
    showToast(msg, "success");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteOuiOverrideUI(prefix) {
  var ok = await showConfirm('Remove OUI override for "' + prefix + '"?');
  if (!ok) return;
  try {
    await api.serverSettings.deleteOuiOverride(prefix);
    _ouiOverrides = _ouiOverrides.filter(function (o) { return o.prefix !== prefix; });
    showToast("Override removed");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
  }
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
