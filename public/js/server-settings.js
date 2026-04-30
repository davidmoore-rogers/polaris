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
      if (target === "maintenance" && !_dbLoaded) loadDatabaseInfo();
      if (target === "identification" && !_tagsLoaded) loadIdentificationTab();
      if (target === "customization" && !_brandingLoaded) loadCustomizationTab();
      if (target === "credentials" && !_credsLoaded) loadCredentialsTab();
      if (target === "api-tokens" && !_apiTokensLoaded) loadApiTokensTab();
    });
  });

  // Check for ?tab= query parameter to open a specific tab
  var urlParams = new URLSearchParams(window.location.search);
  var requestedTab = urlParams.get("tab");
  // Back-compat: ?tab=database now maps to the renamed Maintenance tab.
  if (requestedTab === "database") requestedTab = "maintenance";
  if (requestedTab) {
    var tabBtn = document.querySelector('#settings-tabs .page-tab[data-tab="' + requestedTab + '"]');
    if (tabBtn) {
      tabBtn.click();
      return;
    }
  }

  loadIdentificationTab();
  checkRamBanner();
});

function checkRamBanner() {
  if (typeof api === "undefined" || !api.serverSettings) return;
  api.serverSettings.getPgTuning().then(function (data) {
    var banner = document.getElementById("ram-insufficient-banner");
    if (!banner) return;
    if (!data.ramInsufficient) {
      localStorage.removeItem("polaris_ram_dismissed");
      banner.style.display = "none";
      return;
    }
    // Show persistent banner on this page whether or not it was dismissed from the sidebar
    banner.className = "ram-banner";
    banner.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="ram-banner-icon"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
      '<div class="ram-banner-body">' +
        '<div class="ram-banner-title">Insufficient RAM — Add Memory</div>' +
        'This server has <strong>' + data.currentRamGb + ' GB</strong> of RAM. The current database size requires at least <strong>' + data.recommendedRamGb + ' GB</strong> for reliable performance. ' +
        'This notice will clear automatically once sufficient RAM is detected or the database shrinks below the threshold.' +
      '</div>';
    banner.style.display = "flex";
  }).catch(function () { /* non-critical */ });
}

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
    '<div class="settings-cards-row">' +
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
  return '<div class="settings-cards-row">' +
    '<div class="settings-card">' +
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
    if (result.results && result.results.length > 1) {
      statusEl.innerHTML = result.results.map(function (r) {
        var color = r.ok ? "var(--color-success)" : "var(--color-danger)";
        return '<div style="font-size:0.82rem;padding:2px 0"><span style="color:' + color + '">' +
          (r.ok ? "&#10003;" : "&#10007;") + '</span> <strong>' + escapeHtml(r.server) + '</strong> — ' + escapeHtml(r.message) + '</div>';
      }).join("");
    } else {
      statusEl.innerHTML = result.ok
        ? '<span style="color:var(--color-success)">' + escapeHtml(result.message) + '</span>'
        : '<span style="color:var(--color-danger)">' + escapeHtml(result.message) + '</span>';
    }
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
    '<div class="settings-cards-row-3">' +
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
      '<select id="f-https-key" style="display:none"></select>' +
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
    '<div class="settings-card" style="display:flex;flex-direction:column">' +
      '<h4>Trusted Certificate Authorities</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">CA certificates used to verify remote servers when Polaris connects to integrations, syslog, and archive targets. These are also included in the HTTPS trust chain.</p>' +
      '<ul class="cert-list" id="ca-list"><li class="cert-empty">Loading...</li></ul>' +
      '<div style="margin-top:auto;padding-top:1rem">' +
        '<div class="upload-area" id="ca-upload-area">' +
          '<input type="file" id="ca-file-input" accept=".pem,.crt,.cer,.der">' +
          '<strong style="color:var(--color-text-primary)">Upload CA Certificate</strong>' +
          '<p>Click to select a .pem, .crt, or .cer file</p>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="settings-card" style="display:flex;flex-direction:column">' +
      '<h4>Server Certificates</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">TLS certificate and private key used for HTTPS. Upload a matched certificate and key pair, then select them in the HTTPS Configuration above.</p>' +
      '<ul class="cert-list" id="server-cert-list"><li class="cert-empty">Loading...</li></ul>' +
      '<div style="margin-top:auto;padding-top:1rem;display:flex;gap:12px;flex-wrap:wrap">' +
        '<div class="upload-area" id="cert-upload-area" style="flex:1;min-width:200px">' +
          '<input type="file" id="cert-file-input" accept=".pem,.crt,.cer,.pfx,.p12,.key" multiple>' +
          '<strong style="color:var(--color-text-primary)">Upload Certificate / Key</strong>' +
          '<p>Click to select certificate (.pem, .crt) and/or key (.key, .pem) files</p>' +
        '</div>' +
        '<div class="upload-area" id="generate-cert-area" style="flex:1;min-width:200px">' +
          '<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:6px">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:22px;height:22px;flex-shrink:0;opacity:0.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/><line x1="12" y1="15" x2="12" y2="19"/></svg>' +
            '<strong style="color:var(--color-text-primary)">Generate Self-Signed</strong>' +
          '</div>' +
          '<p>Create a new self-signed certificate for testing or internal use</p>' +
        '</div>' +
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
    if (input.files.length > 0) handler(Array.from(input.files));
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

  keySelect.innerHTML = '<option value=""></option>' +
    keys.map(function (c) {
      return '<option value="' + c.id + '">' + escapeHtml(c.name) + '</option>';
    }).join("");

  autoPairKey();
  certSelect.addEventListener("change", autoPairKey);
}

function autoPairKey() {
  var certSelect = document.getElementById("f-https-cert");
  var keySelect = document.getElementById("f-https-key");
  if (!certSelect || !keySelect) return;

  var certId = certSelect.value;
  if (!certId) { keySelect.value = ""; return; }

  if (_httpsSettings.certId === certId && _httpsSettings.keyId) {
    keySelect.value = _httpsSettings.keyId;
    return;
  }

  var cert = _certData.serverCerts.find(function (c) { return c.id === certId; });
  if (!cert) return;

  var keys = _certData.serverCerts.filter(function (c) { return c.type === "key"; });
  if (keys.length === 0) return;

  var baseName = cert.name.replace(/\.(pem|crt|cer|pfx|p12)$/i, "");
  var matched = keys.find(function (k) {
    return k.name.replace(/\.(key|pem)$/i, "") === baseName;
  });

  if (matched) {
    keySelect.value = matched.id;
  } else {
    var certTime = new Date(cert.uploadedAt).getTime();
    keys.sort(function (a, b) {
      return Math.abs(new Date(a.uploadedAt).getTime() - certTime) -
             Math.abs(new Date(b.uploadedAt).getTime() - certTime);
    });
    keySelect.value = keys[0].id;
  }
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
      '<input type="text" id="f-gen-cn" value="localhost" placeholder="e.g. localhost, polaris.example.com">' +
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
    list.innerHTML = '<li class="cert-empty">No trusted CAs uploaded. Polaris will use the system trust store.</li>';
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
  var certs = _certData.serverCerts.filter(function (c) { return c.type === "cert"; });
  if (!certs.length) {
    list.innerHTML = '<li class="cert-empty">No server certificate configured. The app is using its default configuration.</li>';
    return;
  }
  list.innerHTML = certs.map(certItemHtml).join("");
}

function certItemHtml(cert) {
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

// ─── Maintenance Tab ───────────────────────────────────────────────────────

var _dbLoaded = false;

function _capacityFormatBytes(b) {
  if (b == null) return "—";
  if (b >= 1024 * 1024 * 1024) return (b / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  if (b >= 1024 * 1024) return Math.round(b / (1024 * 1024)) + " MB";
  if (b >= 1024) return Math.round(b / 1024) + " kB";
  return b + " B";
}

function _capacityFormatPct(num, denom) {
  if (denom == null || denom <= 0) return "—";
  return Math.round((num / denom) * 100) + "%";
}

function _capacitySeverityLabel(s) {
  if (s === "red") return "Critical";
  if (s === "amber") return "Action recommended";
  return "Healthy";
}

function renderCapacityCard(capacity, dbInfo, pgTuning) {
  if (!capacity) return "";

  var severity = capacity.severity || "ok";
  var pillClass = "capacity-pill capacity-pill-" + severity;

  // For pg_tuning_needed, inline the actual current → recommended rows so
  // operators don't have to scroll down to the sidebar tuning alert to see
  // what to change.
  var badPgSettings = (pgTuning && Array.isArray(pgTuning.settings))
    ? pgTuning.settings.filter(function (s) { return !s.ok; })
    : [];
  var pgConfigFile = pgTuning && pgTuning.pgConfigFile ? pgTuning.pgConfigFile : null;
  var pgSettingsRowsHtml = badPgSettings.length
    ? '<div class="capacity-reason-pg-settings">' +
        badPgSettings.map(function (s) {
          return '<div class="pg-tuning-row">' +
            '<span class="pg-tuning-param">' + escapeHtml(s.name) + '</span>' +
            '<span class="pg-tuning-values">' + escapeHtml(s.current) + ' &rarr; ' + escapeHtml(s.recommended) + '</span>' +
          '</div>';
        }).join("") +
        (pgConfigFile
          ? '<div class="capacity-reason-pg-path">Edit in <code>' + escapeHtml(pgConfigFile) + '</code> and restart PostgreSQL.</div>'
          : '') +
      '</div>'
    : '';

  // Reasons section — list each issue with severity + suggestion
  var reasonsHtml = "";
  if (capacity.reasons && capacity.reasons.length > 0) {
    reasonsHtml =
      '<div class="capacity-reasons">' +
        capacity.reasons.map(function (r) {
          var extra = r.code === "pg_tuning_needed" ? pgSettingsRowsHtml : "";
          return '<div class="capacity-reason capacity-reason-' + r.severity + '">' +
            '<div class="capacity-reason-head">' +
              '<span class="capacity-pill capacity-pill-' + r.severity + ' capacity-pill-sm">' +
                (r.severity === "red" ? "Critical" : "Warning") +
              '</span>' +
              '<span class="capacity-reason-msg">' + escapeHtml(r.message) + '</span>' +
            '</div>' +
            '<div class="capacity-reason-suggestion">' + escapeHtml(r.suggestion) + '</div>' +
            extra +
          '</div>';
        }).join("") +
      '</div>';
  }

  var host = capacity.appHost || {};
  var db = capacity.database || {};
  var work = capacity.workload || {};

  var diskPct = host.diskFreeBytes != null && host.diskTotalBytes
    ? Math.round((host.diskFreeBytes / host.diskTotalBytes) * 100)
    : null;

  var hostHtml =
    '<div class="capacity-stat-card">' +
      '<h5>Application host</h5>' +
      '<div class="db-info-grid">' +
        dbInfoRow("CPU cores", host.cpuCount != null ? host.cpuCount : "—") +
        dbInfoRow("RAM (total)", _capacityFormatBytes(host.totalMemoryBytes)) +
        dbInfoRow("RAM (free)", _capacityFormatBytes(host.freeMemoryBytes)) +
        (host.loadAvg ? dbInfoRow("Load avg (1/5/15m)", host.loadAvg.map(function (n) { return n.toFixed(2); }).join(" / ")) : "") +
        dbInfoRow("Disk free", _capacityFormatBytes(host.diskFreeBytes) + (diskPct != null ? " (" + diskPct + "%)" : "")) +
        dbInfoRow("Disk total", _capacityFormatBytes(host.diskTotalBytes)) +
        dbInfoRow("DB co-located", host.dbColocated ? "Yes" : "No (remote)") +
      '</div>' +
      (host.dbColocated
        ? ''
        : '<p class="hint" style="margin-top:0.5rem">Disk free is measured on the Polaris install volume. PostgreSQL is on a separate host — its data volume is not visible here.</p>') +
    '</div>';

  var allTables = (dbInfo && dbInfo.tables) || [];
  var tablesHtml = allTables.map(function (t) {
    return '<tr>' +
      '<td class="mono" style="font-size:0.78rem">' + escapeHtml(t.name) + '</td>' +
      '<td style="text-align:right">' + formatNumber(t.rows) + '</td>' +
      '<td style="text-align:right;font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(t.size) + '</td>' +
      '</tr>';
  }).join("");

  var dbHtml =
    '<div class="capacity-stat-card">' +
      '<h5>Database</h5>' +
      '<div class="db-info-grid">' +
        dbInfoRow("Current size", _capacityFormatBytes(db.sizeBytes)) +
        dbInfoRow("Steady-state at current settings", _capacityFormatBytes(work.steadyStateSizeBytes)) +
        (allTables.length ? dbInfoRow("Tables", allTables.length) : "") +
      '</div>' +
      (tablesHtml
        ? '<div style="margin-top:0.75rem;max-height:240px;overflow-y:auto">' +
            '<table class="ip-table"><thead><tr>' +
              '<th>Table</th>' +
              '<th style="text-align:right">Rows</th>' +
              '<th style="text-align:right">Size</th>' +
            '</tr></thead><tbody>' + tablesHtml + '</tbody></table>' +
          '</div>'
        : '') +
    '</div>';

  var workHtml =
    '<div class="capacity-stat-card">' +
      '<h5>Monitoring workload</h5>' +
      '<div class="db-info-grid">' +
        dbInfoRow("Monitored assets", formatNumber(work.monitoredAssetCount || 0)) +
        (work.cadences
          ? dbInfoRow("Cadences",
              work.cadences.responseTimeSec + "s response · " +
              work.cadences.telemetrySec + "s telemetry · " +
              work.cadences.systemInfoSec + "s system info")
          : "") +
        (work.retention
          ? dbInfoRow("Retention",
              work.retention.monitorDays + "d monitor · " +
              work.retention.telemetryDays + "d telemetry · " +
              work.retention.systemInfoDays + "d system info")
          : "") +
      '</div>' +
      '<p class="hint" style="margin-top:0.5rem">Steady-state size is what the database grows to if monitoring settings stay as they are. Reduce retention or cadence to lower it.</p>' +
    '</div>';

  return '<div class="settings-card capacity-card capacity-card-' + severity + '" id="capacity-card">' +
    '<div class="capacity-header">' +
      '<h4 style="margin:0">Capacity</h4>' +
      '<span class="' + pillClass + '">' + _capacitySeverityLabel(severity) + '</span>' +
    '</div>' +
    reasonsHtml +
    '<div class="capacity-grid">' + hostHtml + dbHtml + workHtml + '</div>' +
    '<p class="hint" style="margin-top:0.75rem;font-size:0.78rem">Last computed ' + escapeHtml(capacity.computedAt || "") + '</p>' +
  '</div>';
}

async function loadDatabaseInfo() {
  var container = document.getElementById("tab-maintenance");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading maintenance information...</p></div>';

  try {
    // Fetch capacity in parallel with the database snapshot — if capacity
    // fails (e.g. statfs not available) we still render the rest of the tab.
    var results = await Promise.allSettled([
      api.serverSettings.getDatabase(),
      api.serverSettings.getPgTuning(),
    ]);
    if (results[0].status === "rejected") throw results[0].reason;
    var db = results[0].value;
    var pgTuning = results[1].status === "fulfilled" && results[1].value
      ? results[1].value
      : null;
    var capacity = pgTuning && pgTuning.capacity ? pgTuning.capacity : null;
    _dbLoaded = true;

    container.innerHTML =
      renderCapacityCard(capacity, db, pgTuning) +
      // ── Application Updates card ──
      '<div class="settings-card" id="update-card">' +
        '<h4>Application Updates</h4>' +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
          'Check for new versions and apply updates directly from the browser. Automatic rollback on failure.' +
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
        '<div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
          '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none">' +
            '<input type="checkbox" id="update-backup-checkbox" style="width:15px;height:15px;flex-shrink:0">' +
            '<span style="font-size:0.85rem">Back up database before applying updates</span>' +
          '</label>' +
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.3rem 0 0 23px">Disable to skip the backup step and apply updates faster. Not recommended for production systems.</p>' +
        '</div>' +
        '<details id="update-history" style="margin-top:1rem">' +
          '<summary style="cursor:pointer;font-size:0.82rem;color:var(--color-text-secondary);user-select:none">Recent updates</summary>' +
          '<div id="update-history-body" style="margin-top:0.6rem;font-size:0.82rem;color:var(--color-text-tertiary)">Loading...</div>' +
        '</details>' +
      '</div>' +
      (function () {
        var engineCard = '<div class="settings-card">' +
          '<h4>Database Engine</h4>' +
          '<div class="db-info-grid">' +
            dbInfoRow("Type", db.type || "Unknown") +
            dbInfoRow("Version", db.version || "Unknown") +
            (db.host ? dbInfoRow("Host", db.host + (db.port ? ":" + db.port : "")) : "") +
            (db.database ? dbInfoRow("Database", db.database) : "") +
            (db.ssl ? dbInfoRow("SSL", db.ssl) : "") +
          '</div>' +
        '</div>';
        var hasPool = db.uptime || db.activeConnections !== undefined || db.maxConnections !== undefined;
        var poolCard = hasPool
          ? '<div class="settings-card">' +
              '<h4>Connection Pool</h4>' +
              '<div class="db-info-grid">' +
                (db.activeConnections !== undefined ? dbInfoRow("Active Connections", db.activeConnections) : "") +
                (db.maxConnections !== undefined ? dbInfoRow("Max Connections", db.maxConnections) : "") +
                (db.uptime ? dbInfoRow("Uptime", db.uptime) : "") +
              '</div>' +
            '</div>'
          : '';
        return hasPool
          ? '<div class="settings-cards-row">' + engineCard + poolCard + '</div>'
          : engineCard;
      })() +
      // ── Backup / Restore / History — three columns ──
      '<div class="settings-cards-row-3">' +

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
            'This backup was created with a different version of Polaris. ' +
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

      '</div>' + // close 3-column row of Backup/Restore/History cards

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

// Returns true if the caller should proceed. If discoveries are running, prompts
// the user to abort them first; aborts on confirmation, cancels on dismissal.
async function warnIfDiscoveryRunning(actionLabel) {
  var result;
  try { result = await api.integrations.discoveries(); } catch (_) { return true; }
  var running = (result && result.discoveries) || [];
  if (running.length === 0) return true;

  var names = running.map(function (d) { return d.name; }).join(", ");
  var confirmed = await showConfirm(
    'A discovery is currently running (' + names + ').\n\n' +
    'Abort the discovery and continue with the ' + actionLabel + '?'
  );
  if (!confirmed) return false;

  await Promise.allSettled(running.map(function (d) {
    return api.integrations.abortDiscover(d.id);
  }));
  return true;
}

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

    if (!await warnIfDiscoveryRunning("backup")) return;

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

    if (!await warnIfDiscoveryRunning("restore")) return;

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

  // Extract version from filename: polaris-backup-1.0.0-2026-...gz
  var versionMatch = file.name.match(/polaris-backup-(\d+\.\d+\.\d+)-/);
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
      'Ensure this backup was created by a compatible version of Polaris before restoring.';
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
      if (magic === "POLARIS") {
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
        var preUpdateBadge = b.preUpdate
          ? ' <span class="badge" style="font-size:0.7rem;background:color-mix(in srgb, var(--color-warning) 15%, transparent);color:var(--color-warning);border:1px solid color-mix(in srgb, var(--color-warning) 40%, transparent)">Pre-update</span>'
          : '';
        var pathRow = b.path
          ? '<div class="mono" style="font-size:0.72rem;color:var(--color-text-tertiary);margin-top:2px;word-break:break-all" title="' + escapeHtml(b.path) + '">' + escapeHtml(b.path) + '</div>'
          : '';
        return '<tr>' +
          '<td style="font-size:0.82rem;white-space:nowrap;vertical-align:top">' + escapeHtml(formatDate(b.createdAt)) + '</td>' +
          '<td class="mono" style="font-size:0.82rem">' + escapeHtml(b.filename) + preUpdateBadge + pathRow + '</td>' +
          '<td style="text-align:right;font-size:0.82rem;color:var(--color-text-secondary);vertical-align:top">' + formatFileSize(b.size || b.sizeBytes || 0) + '</td>' +
          '<td style="vertical-align:top">' + (b.encrypted
            ? '<span class="badge badge-warning" style="font-size:0.7rem">Encrypted</span>'
            : '<span class="badge badge-info" style="font-size:0.7rem">Plain</span>') +
          '</td>' +
          '<td style="display:flex;gap:4px;vertical-align:top">' + dlBtn +
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

  // Load and wire the backup checkbox
  var backupCheckbox = document.getElementById("update-backup-checkbox");
  if (backupCheckbox) {
    api.serverSettings.getUpdateSettings().then(function (s) {
      backupCheckbox.checked = !s.skipBackup;
    }).catch(function () {
      backupCheckbox.checked = true; // default: enabled
    });
    backupCheckbox.addEventListener("change", function () {
      api.serverSettings.setUpdateSettings({ skipBackup: !backupCheckbox.checked }).catch(function (err) {
        showToast("Failed to save setting: " + err.message, "error");
        backupCheckbox.checked = !backupCheckbox.checked; // revert
      });
    });
  }

  var historyEl = document.getElementById("update-history");
  if (historyEl) {
    var historyLoaded = false;
    historyEl.addEventListener("toggle", function () {
      if (!historyEl.open || historyLoaded) return;
      historyLoaded = true;
      loadUpdateHistory();
    });
  }

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

async function loadUpdateHistory() {
  var body = document.getElementById("update-history-body");
  if (!body) return;
  try {
    var commits = await api.serverSettings.getUpdateHistory(20);
    if (!commits || commits.length === 0) {
      body.innerHTML = '<span>No commit history available.</span>';
      return;
    }
    var html = '<div style="border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary);max-height:280px;overflow-y:auto">';
    commits.forEach(function (c, i) {
      html += '<div style="padding:0.35rem 0.6rem;' + (i < commits.length - 1 ? 'border-bottom:1px solid var(--color-border);' : '') + 'display:flex;gap:10px;align-items:baseline">' +
        '<span class="mono" style="color:var(--color-text-tertiary);flex-shrink:0">' + escapeHtml(c.hash) + '</span>' +
        (c.date ? '<span style="color:var(--color-text-tertiary);font-size:0.78rem;flex-shrink:0">' + escapeHtml(c.date) + '</span>' : '') +
        '<span style="color:var(--color-text-primary)">' + escapeHtml(c.subject) + '</span>' +
      '</div>';
    });
    html += '</div>';
    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = '<span style="color:var(--color-danger)">Failed to load history: ' + escapeHtml(err.message || String(err)) + '</span>';
  }
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
  if (!await warnIfDiscoveryRunning("update")) return;

  var backupCheckbox = document.getElementById("update-backup-checkbox");
  var backupEnabled = backupCheckbox ? backupCheckbox.checked : true;

  var password = null;
  if (backupEnabled) {
    var pwResult = await promptUpdateBackupPassword();
    if (pwResult === null) return; // user cancelled
    password = pwResult || null;   // empty string → unencrypted
  } else {
    var confirmed = await showConfirm(
      "Apply this update? Backup is disabled — no recovery point will be created. " +
      "The server will restart automatically when complete."
    );
    if (!confirmed) return;
  }

  var btn = document.getElementById("btn-apply-update");
  btn.disabled = true;
  btn.textContent = "Starting update...";

  try {
    await api.serverSettings.applyUpdate(password);
    renderUpdateProgress();
    startUpdatePolling();
  } catch (err) {
    showToast("Failed to start update: " + err.message, "error");
    btn.disabled = false;
    btn.textContent = "Apply Update";
  }
}

// Returns the entered password (string), "" for proceed-without-encryption, or null for cancel.
function promptUpdateBackupPassword() {
  return new Promise(function (resolve) {
    var body =
      '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'A database backup will be created before the update and the server will restart automatically when complete. ' +
        'Optionally encrypt the backup with a password — recommended if the backup will be archived off-host.' +
      '</p>' +
      '<div class="form-row" style="gap:12px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:180px">' +
          '<label for="update-backup-pw">Encryption password <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
          '<input type="password" id="update-backup-pw" placeholder="Leave blank for unencrypted backup" autocomplete="new-password">' +
        '</div>' +
        '<div style="flex:1;min-width:180px">' +
          '<label for="update-backup-pw-confirm">Confirm password</label>' +
          '<input type="password" id="update-backup-pw-confirm" placeholder="Re-enter password" autocomplete="new-password">' +
        '</div>' +
      '</div>' +
      '<div id="update-backup-pw-error" style="color:var(--color-danger);font-size:0.82rem;margin-top:0.5rem;min-height:1em"></div>';
    var footer =
      '<button class="btn btn-secondary" id="upd-pw-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="upd-pw-ok">Apply Update</button>';
    openModal("Apply Update", body, footer);

    document.getElementById("upd-pw-cancel").onclick = function () {
      closeModal();
      resolve(null);
    };
    document.getElementById("upd-pw-ok").onclick = function () {
      var pw = document.getElementById("update-backup-pw").value;
      var pwConfirm = document.getElementById("update-backup-pw-confirm").value;
      var errEl = document.getElementById("update-backup-pw-error");
      if (pw && pw !== pwConfirm) {
        errEl.textContent = "Passwords do not match";
        return;
      }
      errEl.textContent = "";
      closeModal();
      resolve(pw || "");
    };
    var pwInput = document.getElementById("update-backup-pw");
    if (pwInput) pwInput.focus();
  });
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
      window.location.href = "server-settings.html?tab=database";
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
        window.location.href = "server-settings.html?tab=database";
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

  var changesHtml = "";
  if (status.changes && status.changes.length > 0) {
    var n = status.changes.length;
    changesHtml = '<div style="margin-top:0.75rem"><label style="font-size:0.78rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--color-text-tertiary)">Applied Changes (' + n + ' commit' + (n === 1 ? '' : 's') + ')</label>' +
      '<div style="max-height:200px;overflow-y:auto;margin-top:0.4rem;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary)">';
    status.changes.forEach(function (c) {
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
    '<div style="background:color-mix(in srgb, var(--color-success) 10%, transparent);border:1px solid var(--color-success);border-radius:6px;padding:1rem;margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<span style="color:var(--color-success);font-weight:600;font-size:0.95rem">&#10003; Update Complete</span>' +
      '</div>' +
      '<div class="db-info-grid">' +
        (status.currentVersion ? '<div class="db-info-label">Previous</div><div class="db-info-value">v' + escapeHtml(status.currentVersion) + '</div>' : '') +
        (status.latestVersion ? '<div class="db-info-label">Current</div><div class="db-info-value">v' + escapeHtml(status.latestVersion) + '</div>' : '') +
      '</div>' +
      changesHtml +
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

  var recoveryHtml = '';
  if (status.backupFile) {
    var cmd = 'gunzip -c ' + status.backupFile + ' | psql "DATABASE_URL"';
    recoveryHtml =
      '<div style="margin-top:1rem;background:color-mix(in srgb, var(--color-warning) 8%, transparent);border:1px solid color-mix(in srgb, var(--color-warning) 35%, transparent);border-radius:6px;padding:1rem">' +
        '<div style="font-weight:600;font-size:0.88rem;margin-bottom:0.5rem">Pre-update backup available</div>' +
        '<p style="font-size:0.82rem;margin:0 0 0.75rem">A backup was created before the update started. Download it from <strong>Backup History</strong> below before attempting any recovery.</p>' +
        '<details>' +
          '<summary style="cursor:pointer;font-size:0.82rem;color:var(--color-text-secondary);user-select:none">Manual restore instructions (if the app is unavailable)</summary>' +
          '<ol style="font-size:0.82rem;margin:0.6rem 0 0.5rem;padding-left:1.4rem;line-height:1.7">' +
            '<li>Download the pre-update backup from <strong>Backup History</strong> below.</li>' +
            '<li>Stop the Polaris service on the server:<br>' +
              '<code style="font-size:0.8rem;background:var(--color-bg-secondary);padding:1px 5px;border-radius:3px">sudo systemctl stop polaris</code>' +
              ' &nbsp;(Linux) &nbsp;or&nbsp; ' +
              '<code style="font-size:0.8rem;background:var(--color-bg-secondary);padding:1px 5px;border-radius:3px">nssm stop Polaris</code>' +
              ' (Windows)</li>' +
            '<li>Restore the database — replace <code style="font-size:0.8rem">DATABASE_URL</code> with the value from your <code style="font-size:0.8rem">.env</code> file:<br>' +
              '<code style="display:block;margin-top:0.3rem;font-size:0.8rem;background:var(--color-bg-secondary);padding:4px 8px;border-radius:3px;white-space:nowrap;overflow-x:auto">' + escapeHtml(cmd) + '</code>' +
            '</li>' +
            '<li>Restart the service:<br>' +
              '<code style="font-size:0.8rem;background:var(--color-bg-secondary);padding:1px 5px;border-radius:3px">sudo systemctl start polaris</code>' +
              ' &nbsp;(Linux) &nbsp;or&nbsp; ' +
              '<code style="font-size:0.8rem;background:var(--color-bg-secondary);padding:1px 5px;border-radius:3px">nssm start Polaris</code>' +
              ' (Windows)</li>' +
          '</ol>' +
        '</details>' +
      '</div>';
  }

  area.innerHTML =
    '<div style="background:color-mix(in srgb, var(--color-danger) 10%, transparent);border:1px solid var(--color-danger);border-radius:6px;padding:1rem;margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<span style="color:var(--color-danger);font-weight:600;font-size:0.95rem">&#10007; Update Failed</span>' +
      '</div>' +
      '<p style="font-size:0.85rem;margin:0.5rem 0">' + escapeHtml(status.error || 'Unknown error') + '</p>' +
      stepsHtml +
    '</div>' +
    recoveryHtml +
    '<div style="display:flex;gap:8px;align-items:center;margin-top:1rem">' +
      '<button class="btn btn-secondary" id="btn-dismiss-update">Dismiss</button>' +
      '<button class="btn btn-secondary" id="btn-check-updates">Check Again</button>' +
    '</div>';

  // Reload backup history so the pre-update backup entry is visible immediately
  if (status.backupFile) loadBackupHistory();

  document.getElementById("btn-dismiss-update").addEventListener("click", async function () {
    await api.serverSettings.dismissUpdate();
    _dbLoaded = false;
    loadDatabaseInfo();
  });
  document.getElementById("btn-check-updates").addEventListener("click", checkForUpdatesUI);
}

// ─── Customization Tab ─────────────────────────────────────────────────────

var _brandingLoaded = false;
var _brandingData = { appName: "Polaris", subtitle: "Network Management Tool", logoUrl: "/logo.png" };

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
  var isCustomLogo = _brandingData.logoUrl && _brandingData.logoUrl !== "/logo.png";

  container.innerHTML =
    '<div class="settings-cards-row">' +
    '<div class="settings-card">' +
      '<h4>Application Name</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Change the name shown in the sidebar, login page, browser tabs, and PDF exports.' +
      '</p>' +
      '<div class="form-group"><label>Application Name</label>' +
        '<input type="text" id="f-brand-appname" value="' + escapeHtml(_brandingData.appName || "") + '" placeholder="e.g. Polaris">' +
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
        'Upload a custom logo to replace the default. Recommended size: 280\u00d7280px or larger. Supported formats: PNG, JPEG, WebP.' +
      '</p>' +
      '<div style="display:flex;align-items:flex-start;gap:1.5rem;flex-wrap:wrap">' +
        '<div style="flex-shrink:0">' +
          '<div class="logo-preview-box">' +
            '<img id="logo-preview" src="' + escapeHtml(_brandingData.logoUrl || "/logo.png") + '" alt="Current logo">' +
          '</div>' +
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:0.5rem;text-align:center">' +
            (isCustomLogo ? 'Custom logo' : 'Default logo') +
          '</p>' +
        '</div>' +
        '<div style="flex:1;min-width:200px">' +
          '<div class="upload-area" id="logo-upload-area">' +
            '<input type="file" id="logo-file-input" accept="image/png,image/jpeg,image/webp">' +
            '<strong style="color:var(--color-text-primary)">Upload New Logo</strong>' +
            '<p>Click to select an image file</p>' +
          '</div>' +
          (isCustomLogo
            ? '<button class="btn btn-secondary" id="btn-logo-reset" style="margin-top:0.75rem">Reset to Default</button>'
            : '') +
        '</div>' +
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
var _mibsData = [];
var _mibFacets = { manufacturers: [], modelsByManufacturer: {} };
var _manufacturerAliases = [];
var _mibFilter = { manufacturer: "", model: "", scope: "all" };
var _mibProfileStatus = [];

async function loadIdentificationTab() {
  var container = document.getElementById("tab-identification");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading...</p></div>';

  try {
    var results = await Promise.all([
      api.serverSettings.listTags(),
      api.serverSettings.getTagSettings(),
      api.serverSettings.getDns().catch(function () { return null; }),
      api.serverSettings.getOuiOverrides().catch(function () { return []; }),
      api.serverSettings.listMibs().catch(function () { return []; }),
      api.serverSettings.getMibFacets().catch(function () { return { manufacturers: [], modelsByManufacturer: {} }; }),
      api.serverSettings.getMibProfileStatus().catch(function () { return []; }),
      api.serverSettings.listManufacturerAliases().catch(function () { return []; }),
    ]);
    _tagsData = results[0];
    _tagSettings = results[1] || { enforce: false };
    if (results[2]) {
      _dnsDefaults.servers = results[2].servers || [];
      _dnsDefaults.mode = results[2].mode || "standard";
      _dnsDefaults.dohUrl = results[2].dohUrl || "";
    }
    _ouiOverrides = results[3] || [];
    _mibsData = results[4] || [];
    _mibFacets = results[5] || { manufacturers: [], modelsByManufacturer: {} };
    _mibProfileStatus = results[6] || [];
    _manufacturerAliases = results[7] || [];
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

  // ── 2. MAC & Vendor Identification (consolidated: Overrides + Aliases + OUI Database) ──
  html += '<div class="settings-card">' +
    '<h4>MAC &amp; Vendor Identification</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1.25rem">' +
      'Three-layer resolution pipeline: <strong>Prefix Overrides</strong> take top priority, ' +
      'then <strong>Manufacturer Aliases</strong> normalize the vendor name, ' +
      'and the <strong>IEEE OUI Database</strong> provides the base lookup.' +
    '</p>';

  // ── Prefix Overrides ──
  html += '<h5 class="mac-id-section-heading">Prefix Overrides</h5>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
      'Static MAC prefix → manufacturer mappings that take priority over everything else. ' +
      'Use for custom hardware, internal devices, or to correct misidentified vendors.' +
    '</p>';

  if (_ouiOverrides.length > 0) {
    html += '<table class="ip-table" style="margin-bottom:1rem"><thead><tr>' +
      '<th>MAC Prefix</th><th>Manufacturer</th><th>Device</th><th style="width:70px"></th>' +
    '</tr></thead><tbody>';
    _ouiOverrides.forEach(function (o) {
      html += '<tr>' +
        '<td class="mono" style="font-size:0.85rem">' + escapeHtml(o.prefix) + '</td>' +
        '<td>' + escapeHtml(o.manufacturer) + '</td>' +
        '<td>' + escapeHtml(o.device || '') + '</td>' +
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
      '<div style="flex:1;min-width:160px">' +
        '<label style="font-size:0.78rem;font-weight:500">Manufacturer</label>' +
        '<input type="text" id="f-oui-manufacturer" placeholder="e.g. Custom Switch Co.">' +
      '</div>' +
      '<div style="flex:1;min-width:160px">' +
        '<label style="font-size:0.78rem;font-weight:500">Device <span style="color:var(--color-text-tertiary);font-weight:400">(optional)</span></label>' +
        '<input type="text" id="f-oui-device" placeholder="e.g. PowerEdge R740">' +
      '</div>' +
      '<button class="btn btn-primary" id="btn-add-oui-override">Add Override</button>' +
    '</div>';

  // ── Divider ──
  html += '<hr class="mac-id-divider">';

  // ── Two-column: Manufacturer Aliases (left) + IEEE OUI Database (right) ──
  html += '<div class="mac-id-two-col">';

  // Left: Manufacturer Aliases
  html += '<div>' +
    '<h5 class="mac-id-section-heading">Manufacturer Aliases</h5>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
      'Map vendor name variants to a single canonical form so the same vendor doesn\'t split into multiple entries. ' +
      'Each alias (e.g. <code>Fortinet, Inc.</code>) is rewritten to its canonical name (e.g. <code>Fortinet</code>) on every asset and MIB write. ' +
      'Aliases are matched case-insensitively.' +
    '</p>';

  if (_manufacturerAliases.length > 0) {
    var groups = {};
    _manufacturerAliases.forEach(function (a) {
      if (!groups[a.canonical]) groups[a.canonical] = [];
      groups[a.canonical].push(a);
    });
    var canonicalNames = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b); });

    html += '<div style="max-height:22rem;overflow-y:auto;overflow-x:auto;margin-bottom:1rem">' +
      '<table class="ip-table"><thead><tr>' +
      '<th style="position:sticky;top:0;z-index:1;background:var(--color-bg-primary)">Alias</th>' +
      '<th style="position:sticky;top:0;z-index:1;background:var(--color-bg-primary)">Canonical</th>' +
      '<th style="position:sticky;top:0;z-index:1;background:var(--color-bg-primary);width:120px"></th>' +
    '</tr></thead><tbody>';
    canonicalNames.forEach(function (canonical) {
      groups[canonical].forEach(function (a) {
        html += '<tr data-alias-id="' + escapeHtml(a.id) + '">' +
          '<td><span class="alias-text mono" style="font-size:0.85rem">' + escapeHtml(a.alias) + '</span></td>' +
          '<td><span class="canonical-text">' + escapeHtml(a.canonical) + '</span></td>' +
          '<td class="actions">' +
            '<button class="btn btn-sm alias-edit" data-id="' + escapeHtml(a.id) + '">Edit</button> ' +
            '<button class="btn btn-sm btn-danger alias-del" data-id="' + escapeHtml(a.id) + '">Del</button>' +
          '</td>' +
        '</tr>';
      });
    });
    html += '</tbody></table></div>'; // end scroll container
  } else {
    html += '<p class="empty-state" style="margin-bottom:1rem">No aliases defined.</p>';
  }

  html +=
    '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">' +
      '<div style="flex:2;min-width:160px">' +
        '<label style="font-size:0.78rem;font-weight:500">Alias <span style="color:var(--color-text-tertiary);font-weight:400">(input)</span></label>' +
        '<input type="text" id="f-alias-input" placeholder="e.g. Fortinet, Inc.">' +
      '</div>' +
      '<div style="flex:1;min-width:120px">' +
        '<label style="font-size:0.78rem;font-weight:500">Canonical</label>' +
        '<input type="text" id="f-alias-canonical" placeholder="e.g. Fortinet">' +
      '</div>' +
      '<button class="btn btn-primary" id="btn-add-alias">Add</button>' +
    '</div>' +
  '</div>';

  // Right: IEEE OUI Database
  html += '<div>' +
    '<h5 class="mac-id-section-heading">IEEE OUI Database</h5>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
      'Maps MAC address prefixes to hardware manufacturers. ' +
      'Refreshed automatically every week; aliases and overrides layer on top.' +
    '</p>' +
    '<div id="oui-status" class="db-info-grid" style="margin-bottom:1rem">' +
      '<div class="db-info-label">Status</div><div class="db-info-value" id="oui-status-loaded">Loading...</div>' +
      '<div class="db-info-label">Entries</div><div class="db-info-value" id="oui-status-entries">-</div>' +
      '<div class="db-info-label">Last Refreshed</div><div class="db-info-value" id="oui-status-refreshed">-</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn btn-secondary" id="btn-oui-refresh">Refresh Now</button>' +
      '<span id="oui-refresh-status" style="font-size:0.82rem;margin-left:8px"></span>' +
    '</div>' +
  '</div>';

  html += '</div>'; // end mac-id-two-col
  html += '</div>'; // end settings-card

  // ── 4. MIB Database ──
  html += mibCardHTML();

  // ── 5. Tags (bottom) ──
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
            (isAdmin() ? '<button class="tag-chip-edit" data-tag-id="' + t.id + '" title="Edit" style="margin-left:4px;background:none;border:none;color:inherit;cursor:pointer;font-size:0.75rem;opacity:0.7;padding:0">&#9998;</button>' : '') +
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
  wireMibControls();

  // OUI override events
  document.getElementById("btn-add-oui-override").addEventListener("click", addOuiOverride);
  container.querySelectorAll(".oui-override-del").forEach(function (btn) {
    btn.addEventListener("click", function () {
      deleteOuiOverrideUI(btn.getAttribute("data-prefix"));
    });
  });

  // OUI database refresh
  document.getElementById("btn-oui-refresh").addEventListener("click", refreshOuiDatabase);

  // Manufacturer alias events
  wireManufacturerAliasControls();

  // Tags events
  document.getElementById("btn-add-tag").addEventListener("click", openAddTagModal);

  container.querySelectorAll(".tag-chip-edit").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      openEditTagModal(btn.getAttribute("data-tag-id"));
    });
  });

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
  var device = document.getElementById("f-oui-device").value.trim();
  if (!prefix || !manufacturer) { showToast("Both MAC prefix and manufacturer are required", "error"); return; }
  try {
    var body = { prefix: prefix, manufacturer: manufacturer };
    if (device) body.device = device;
    var result = await api.serverSettings.addOuiOverride(body);
    // Update local cache
    var idx = _ouiOverrides.findIndex(function (o) { return o.prefix === result.prefix; });
    if (idx >= 0) _ouiOverrides[idx] = result;
    else _ouiOverrides.push(result);
    _ouiOverrides.sort(function (a, b) { return a.prefix.localeCompare(b.prefix); });
    var msg = "OUI override added: " + result.prefix + " → " + result.manufacturer;
    if (result.device) msg += " / " + result.device;
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

// ─── MIB Database card ─────────────────────────────────────────────────────

function _mibFilteredRows() {
  return _mibsData.filter(function (m) {
    if (_mibFilter.scope === "generic" && m.manufacturer) return false;
    if (_mibFilter.scope === "device" && !m.manufacturer) return false;
    if (_mibFilter.manufacturer && (m.manufacturer || "").toLowerCase() !== _mibFilter.manufacturer.toLowerCase()) return false;
    if (_mibFilter.model && (m.model || "").toLowerCase() !== _mibFilter.model.toLowerCase()) return false;
    return true;
  });
}

function _mibManufacturerOptions(selected) {
  var opts = '<option value=""' + (!selected ? ' selected' : '') + '>All manufacturers</option>';
  (_mibFacets.manufacturers || []).forEach(function (m) {
    opts += '<option value="' + escapeHtml(m) + '"' + (selected === m ? ' selected' : '') + '>' + escapeHtml(m) + '</option>';
  });
  return opts;
}

function _mibModelOptions(manufacturer, selected) {
  var models = (_mibFacets.modelsByManufacturer || {})[manufacturer] || [];
  var opts = '<option value=""' + (!selected ? ' selected' : '') + '>All models</option>';
  models.forEach(function (m) {
    opts += '<option value="' + escapeHtml(m) + '"' + (selected === m ? ' selected' : '') + '>' + escapeHtml(m) + '</option>';
  });
  return opts;
}

// ─── Manufacturer Aliases helpers ──────────────────────────────────────────
// (card HTML is inlined into renderIdentificationTab as part of the consolidated
// MAC & Vendor Identification card)

function wireManufacturerAliasControls() {
  var addBtn = document.getElementById("btn-add-alias");
  if (addBtn) addBtn.addEventListener("click", addManufacturerAlias);

  var container = document.getElementById("tab-identification");
  container.querySelectorAll(".alias-del").forEach(function (btn) {
    btn.addEventListener("click", function () {
      deleteManufacturerAliasUI(btn.getAttribute("data-id"));
    });
  });
  container.querySelectorAll(".alias-edit").forEach(function (btn) {
    btn.addEventListener("click", function () {
      editManufacturerAliasUI(btn.getAttribute("data-id"));
    });
  });
}

async function addManufacturerAlias() {
  var aliasInput = document.getElementById("f-alias-input");
  var canonicalInput = document.getElementById("f-alias-canonical");
  var alias = (aliasInput.value || "").trim();
  var canonical = (canonicalInput.value || "").trim();
  if (!alias || !canonical) {
    showToast("Both alias and canonical are required", "error");
    return;
  }
  try {
    await api.serverSettings.createManufacturerAlias({ alias: alias, canonical: canonical });
    aliasInput.value = "";
    canonicalInput.value = "";
    showToast('Alias "' + alias + '" → "' + canonical + '" added', "success");
    await loadIdentificationTab();
  } catch (err) {
    showToast(err.message || "Failed to add alias", "error");
  }
}

async function deleteManufacturerAliasUI(id) {
  var existing = _manufacturerAliases.find(function (a) { return a.id === id; });
  var label = existing ? '"' + existing.alias + '" → "' + existing.canonical + '"' : "this alias";
  var ok = await showConfirm("Delete alias " + label + "?");
  if (!ok) return;
  try {
    await api.serverSettings.deleteManufacturerAlias(id);
    showToast("Alias deleted", "success");
    await loadIdentificationTab();
  } catch (err) {
    showToast(err.message || "Failed to delete alias", "error");
  }
}

function editManufacturerAliasUI(id) {
  var existing = _manufacturerAliases.find(function (a) { return a.id === id; });
  if (!existing) return;

  var body =
    '<div class="form-group"><label>Alias *</label>' +
      '<input type="text" id="f-edit-alias" value="' + escapeHtml(existing.alias) + '">' +
      '<div style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:4px">Stored lowercased; matched case-insensitively against incoming manufacturer strings.</div>' +
    '</div>' +
    '<div class="form-group"><label>Canonical *</label>' +
      '<input type="text" id="f-edit-canonical" value="' + escapeHtml(existing.canonical) + '">' +
      '<div style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:4px">Saving will rewrite existing assets and MIBs already stored under the previous canonical value.</div>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save-alias">Save Changes</button>';
  openModal("Edit Manufacturer Alias", body, footer);

  document.getElementById("btn-save-alias").addEventListener("click", async function () {
    var btn = this;
    var alias = document.getElementById("f-edit-alias").value.trim();
    var canonical = document.getElementById("f-edit-canonical").value.trim();
    if (!alias || !canonical) {
      showToast("Both alias and canonical are required", "error");
      return;
    }
    btn.disabled = true;
    try {
      await api.serverSettings.updateManufacturerAlias(id, { alias: alias, canonical: canonical });
      closeModal();
      showToast("Alias updated", "success");
      await loadIdentificationTab();
    } catch (err) {
      showToast(err.message || "Failed to update alias", "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function mibCardHTML() {
  var rows = _mibFilteredRows();
  var html = '<div class="settings-card">' +
    '<h4>MIB Database</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'SNMP MIB modules used to resolve vendor-specific OIDs during monitoring. ' +
      'Vendor profiles (Cisco, Juniper, Fortinet, …) are <b>universal</b> per-manufacturer, but you can also upload a <b>device-specific</b> MIB that overrides the vendor MIB for one model only. Resolution priority at probe time is <i>device → vendor → generic → built-in seed</i>. ' +
      'Files are validated as ASN.1/SMI on upload — anything else is rejected.' +
    '</p>';

  // Vendor Profile Status pill
  html += mibProfileStatusHTML();

  // Filter row
  html +=
    '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:1rem">' +
      '<div style="flex:1;min-width:160px">' +
        '<label style="font-size:0.78rem;font-weight:500">Manufacturer</label>' +
        '<select id="f-mib-filter-mfr">' + _mibManufacturerOptions(_mibFilter.manufacturer) + '</select>' +
      '</div>' +
      '<div style="flex:1;min-width:160px">' +
        '<label style="font-size:0.78rem;font-weight:500">Model</label>' +
        '<select id="f-mib-filter-model"' + (_mibFilter.manufacturer ? '' : ' disabled') + '>' +
          _mibModelOptions(_mibFilter.manufacturer, _mibFilter.model) +
        '</select>' +
      '</div>' +
      '<div style="flex:0 0 auto">' +
        '<label style="font-size:0.78rem;font-weight:500">Scope</label>' +
        '<select id="f-mib-filter-scope">' +
          '<option value="all"' + (_mibFilter.scope === "all" ? " selected" : "") + '>All</option>' +
          '<option value="device"' + (_mibFilter.scope === "device" ? " selected" : "") + '>Device-specific</option>' +
          '<option value="generic"' + (_mibFilter.scope === "generic" ? " selected" : "") + '>Generic only</option>' +
        '</select>' +
      '</div>' +
    '</div>';

  // List
  if (rows.length > 0) {
    html += '<table class="ip-table" style="margin-bottom:1rem"><thead><tr>' +
      '<th>Module</th><th>Manufacturer</th><th>Model</th><th>Imports</th><th style="width:90px;text-align:right">Size</th><th style="width:130px">Uploaded</th><th style="width:120px"></th>' +
    '</tr></thead><tbody>';
    rows.forEach(function (m) {
      var sizeKb = (m.size / 1024).toFixed(1) + " KB";
      var importsText = (m.imports && m.imports.length > 0) ? m.imports.length + " ref" + (m.imports.length === 1 ? "" : "s") : "—";
      var importsTitle = (m.imports && m.imports.length > 0) ? m.imports.join(", ") : "";
      html += '<tr>' +
        '<td class="mono" style="font-size:0.85rem">' + escapeHtml(m.moduleName) + '</td>' +
        '<td>' + (m.manufacturer ? escapeHtml(m.manufacturer) : '<span style="color:var(--color-text-tertiary);font-style:italic">generic</span>') + '</td>' +
        '<td>' + (m.model ? escapeHtml(m.model) : '<span style="color:var(--color-text-tertiary)">—</span>') + '</td>' +
        '<td' + (importsTitle ? ' title="' + escapeHtml(importsTitle) + '"' : '') + ' style="font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(importsText) + '</td>' +
        '<td style="text-align:right;font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(sizeKb) + '</td>' +
        '<td style="font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(formatDate(m.uploadedAt)) + '</td>' +
        '<td class="actions" style="white-space:nowrap">' +
          '<a class="btn btn-sm btn-secondary" href="' + api.serverSettings.downloadMibUrl(m.id) + '" download="' + escapeHtml(m.filename) + '">Download</a> ' +
          '<button class="btn btn-sm btn-danger mib-del" data-id="' + escapeHtml(m.id) + '" data-name="' + escapeHtml(m.moduleName) + '">Del</button>' +
        '</td>' +
      '</tr>';
    });
    html += '</tbody></table>';
  } else if (_mibsData.length === 0) {
    html += '<p class="empty-state" style="margin-bottom:1rem">No MIBs uploaded yet. Add one below to start.</p>';
  } else {
    html += '<p class="empty-state" style="margin-bottom:1rem">No MIBs match the current filter.</p>';
  }

  // Upload form
  var mfrListId = "mib-mfr-datalist";
  var modelListId = "mib-model-datalist";
  var mfrOpts = (_mibFacets.manufacturers || []).map(function (m) { return '<option value="' + escapeHtml(m) + '"></option>'; }).join("");
  var modelOpts = "";
  Object.keys(_mibFacets.modelsByManufacturer || {}).forEach(function (mfr) {
    (_mibFacets.modelsByManufacturer[mfr] || []).forEach(function (md) {
      modelOpts += '<option value="' + escapeHtml(md) + '"></option>';
    });
  });

  html +=
    '<div style="border-top:1px solid var(--color-border);padding-top:1rem">' +
      '<h5 style="margin:0 0 0.75rem;font-size:0.9rem">Upload MIB</h5>' +
      '<datalist id="' + mfrListId + '">' + mfrOpts + '</datalist>' +
      '<datalist id="' + modelListId + '">' + modelOpts + '</datalist>' +
      '<div class="form-group" style="margin-bottom:0.75rem">' +
        '<label style="font-size:0.78rem;font-weight:500;display:block;margin-bottom:0.25rem">Scope</label>' +
        '<label style="display:block;margin-bottom:0.25rem;cursor:pointer">' +
          '<input type="radio" name="mib-scope-up" value="vendor" checked> ' +
          '<b>Manufacturer-wide</b> &mdash; covers every model from this vendor (most common)' +
        '</label>' +
        '<label style="display:block;margin-bottom:0.25rem;cursor:pointer">' +
          '<input type="radio" name="mib-scope-up" value="device"> ' +
          '<b>Device-specific</b> &mdash; overrides the manufacturer-wide MIB for one model only' +
        '</label>' +
        '<label style="display:block;cursor:pointer">' +
          '<input type="radio" name="mib-scope-up" value="generic"> ' +
          '<b>Generic</b> &mdash; shared across all vendors (e.g. SNMPv2-SMI, IF-MIB)' +
        '</label>' +
      '</div>' +
      '<div id="mib-upload-vendor-fields" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:0.75rem">' +
        '<div style="flex:1;min-width:160px">' +
          '<label style="font-size:0.78rem;font-weight:500">Manufacturer *</label>' +
          '<input type="text" id="f-mib-up-mfr" list="' + mfrListId + '" placeholder="e.g. Cisco">' +
        '</div>' +
        '<div id="mib-upload-model-field" style="flex:1;min-width:160px;display:none">' +
          '<label style="font-size:0.78rem;font-weight:500">Model *</label>' +
          '<input type="text" id="f-mib-up-model" list="' + modelListId + '" placeholder="e.g. Catalyst 9300">' +
        '</div>' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:0.75rem">' +
        '<label style="font-size:0.78rem;font-weight:500">MIB file *</label>' +
        '<input type="file" id="f-mib-up-file" accept=".mib,.txt,.my,.smi,text/plain">' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:0.75rem">' +
        '<label style="font-size:0.78rem;font-weight:500">Notes <span style="color:var(--color-text-tertiary);font-weight:400">(optional)</span></label>' +
        '<input type="text" id="f-mib-up-notes" placeholder="Source URL, version, anything you want to remember">' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button class="btn btn-primary" id="btn-mib-upload">Upload MIB</button>' +
        '<span id="mib-upload-status" style="font-size:0.82rem"></span>' +
      '</div>' +
    '</div>';

  html += '</div>';
  return html;
}

function wireMibControls() {
  var mfr = document.getElementById("f-mib-filter-mfr");
  var model = document.getElementById("f-mib-filter-model");
  var scope = document.getElementById("f-mib-filter-scope");
  if (mfr) {
    mfr.addEventListener("change", function () {
      _mibFilter.manufacturer = mfr.value || "";
      _mibFilter.model = ""; // reset model when manufacturer changes
      renderIdentificationTab();
    });
  }
  if (model) {
    model.addEventListener("change", function () {
      _mibFilter.model = model.value || "";
      renderIdentificationTab();
    });
  }
  if (scope) {
    scope.addEventListener("change", function () {
      _mibFilter.scope = scope.value || "all";
      renderIdentificationTab();
    });
  }

  document.querySelectorAll("input[name='mib-scope-up']").forEach(function (r) {
    r.addEventListener("change", function () {
      var fields = document.getElementById("mib-upload-vendor-fields");
      var modelField = document.getElementById("mib-upload-model-field");
      if (!fields || !modelField) return;
      if (!r.checked) return;
      if (r.value === "generic") {
        fields.style.display = "none";
      } else {
        fields.style.display = "flex";
        modelField.style.display = r.value === "device" ? "block" : "none";
      }
    });
  });

  var btn = document.getElementById("btn-mib-upload");
  if (btn) btn.addEventListener("click", uploadMibUI);

  document.querySelectorAll(".mib-del").forEach(function (b) {
    b.addEventListener("click", function () {
      deleteMibUI(b.getAttribute("data-id"), b.getAttribute("data-name"));
    });
  });
}

async function uploadMibUI() {
  var fileInput = document.getElementById("f-mib-up-file");
  var statusEl = document.getElementById("mib-upload-status");
  var btn = document.getElementById("btn-mib-upload");
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    showToast("Choose a MIB file first", "error");
    return;
  }
  var scopeRadio = document.querySelector("input[name='mib-scope-up']:checked");
  var scope = scopeRadio ? scopeRadio.value : "vendor";
  var fields = {};
  if (scope === "vendor" || scope === "device") {
    var mfr = (document.getElementById("f-mib-up-mfr").value || "").trim();
    if (!mfr) { showToast("Manufacturer is required for manufacturer-wide and device-specific MIBs", "error"); return; }
    fields.manufacturer = mfr;
  }
  if (scope === "device") {
    var model = (document.getElementById("f-mib-up-model").value || "").trim();
    if (!model) { showToast("Model is required for device-specific MIBs", "error"); return; }
    fields.model = model;
  }
  var notes = (document.getElementById("f-mib-up-notes").value || "").trim();
  if (notes) fields.notes = notes;

  btn.disabled = true;
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Uploading…</span>';
  try {
    var created = await api.serverSettings.uploadMib(fileInput.files[0], fields);
    showToast("MIB uploaded: " + created.moduleName, "success");
    if (statusEl) statusEl.innerHTML = "";
    // Refresh list + facets + profile status
    var [list, facets, status] = await Promise.all([
      api.serverSettings.listMibs(),
      api.serverSettings.getMibFacets(),
      api.serverSettings.getMibProfileStatus(),
    ]);
    _mibsData = list || [];
    _mibFacets = facets || { manufacturers: [], modelsByManufacturer: {} };
    _mibProfileStatus = status || [];
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
  } finally {
    btn.disabled = false;
  }
}

async function deleteMibUI(id, name) {
  var ok = await showConfirm('Delete MIB module "' + name + '"?');
  if (!ok) return;
  try {
    await api.serverSettings.deleteMib(id);
    _mibsData = _mibsData.filter(function (m) { return m.id !== id; });
    // Refresh profile status — deleting a MIB can drop a vendor profile
    // back to "MIB needed" or remove a model override row.
    _mibProfileStatus = await api.serverSettings.getMibProfileStatus().catch(function () { return _mibProfileStatus; });
    showToast("MIB deleted");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function mibProfileStatusHTML() {
  if (!_mibProfileStatus || _mibProfileStatus.length === 0) return "";

  var html = '<div style="background:var(--color-bg-secondary,rgba(0,0,0,0.04));border:1px solid var(--color-border);border-radius:6px;padding:0.75rem 1rem;margin-bottom:1rem">' +
    '<div style="font-size:0.85rem;font-weight:600;margin-bottom:0.5rem">Vendor Profile Status</div>' +
    '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:0.5rem">' +
      'Each profile is universal &mdash; it applies to every asset whose <code>manufacturer</code> matches the regex. The columns below show whether the underlying MIBs have been uploaded so the probe can resolve the profile\'s symbolic OIDs. Model overrides layer on top of the universal coverage for one product only.' +
    '</div>';

  _mibProfileStatus.forEach(function (p) {
    var statusBadge;
    if (p.ready) {
      statusBadge = '<span style="background:rgba(34,197,94,0.15);color:#16a34a;padding:1px 6px;border-radius:3px;font-size:0.72rem">READY</span>';
    } else if (p.partial) {
      statusBadge = '<span style="background:rgba(245,158,11,0.15);color:#d97706;padding:1px 6px;border-radius:3px;font-size:0.72rem">PARTIAL</span>';
    } else {
      statusBadge = '<span style="background:rgba(148,163,184,0.18);color:var(--color-text-secondary);padding:1px 6px;border-radius:3px;font-size:0.72rem">MIB NEEDED</span>';
    }

    html += '<div style="border-top:1px solid var(--color-border);padding-top:0.5rem;margin-top:0.5rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.25rem">' +
        '<span style="font-weight:500">' + escapeHtml(p.vendor) + '</span>' +
        statusBadge +
        '<span style="font-size:0.72rem;color:var(--color-text-tertiary);font-family:var(--font-mono)">match: /' + escapeHtml(p.matchPattern) + '/i</span>' +
      '</div>';

    if (p.symbols && p.symbols.length > 0) {
      html += '<table style="font-size:0.78rem;margin-left:0.5rem"><tbody>';
      p.symbols.forEach(function (s) {
        var icon = s.resolved
          ? '<span style="color:#16a34a">&#x2713;</span>'
          : '<span style="color:#d97706">&#x26A0;</span>';
        var fromText = s.resolved && s.fromModuleName
          ? '<span style="color:var(--color-text-secondary)">from <span class="mono">' + escapeHtml(s.fromModuleName) + '</span>' +
              (s.fromScope && s.fromScope !== "seed" ? ' (' + escapeHtml(s.fromScope) + ')' : '') +
            '</span>'
          : '<span style="color:#d97706">unresolved &mdash; upload the MIB defining <span class="mono">' + escapeHtml(s.symbol) + '</span></span>';
        html += '<tr>' +
          '<td style="padding:1px 8px 1px 0">' + icon + '</td>' +
          '<td style="padding:1px 8px 1px 0;color:var(--color-text-secondary)">' + escapeHtml(s.metric) + '</td>' +
          '<td class="mono" style="padding:1px 8px 1px 0">' + escapeHtml(s.symbol) + '</td>' +
          '<td style="padding:1px 0">' + fromText + '</td>' +
        '</tr>';
      });
      html += '</tbody></table>';
    }

    if (p.modelOverrides && p.modelOverrides.length > 0) {
      var pieces = p.modelOverrides.map(function (o) {
        return escapeHtml(o.model) + ' (' + o.mibCount + ' MIB' + (o.mibCount === 1 ? '' : 's') + ')';
      }).join(', ');
      html += '<div style="font-size:0.75rem;color:var(--color-text-secondary);margin-top:0.25rem;margin-left:0.5rem">' +
        '<b>Model overrides:</b> ' + pieces +
      '</div>';
    }

    html += '</div>';
  });

  html += '</div>';
  return html;
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
        '<input type="color" id="f-tag-color" value="' + randomTagColor() + '" style="width:40px;height:32px;padding:2px;border:1px solid var(--color-border);border-radius:4px;background:transparent;cursor:pointer">' +
        '<span id="f-tag-color-hex" style="font-family:var(--font-mono);font-size:0.82rem;color:var(--color-text-secondary)"></span>' +
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
  hexLabel.textContent = colorInput.value;

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

async function openEditTagModal(id) {
  var tag = _tagsData.find(function (t) { return t.id === id; });
  if (!tag) return;

  var existingCats = [];
  _tagsData.forEach(function (t) {
    var cat = t.category || "General";
    if (existingCats.indexOf(cat) === -1) existingCats.push(cat);
  });
  _emptyCategories.forEach(function (cat) {
    if (existingCats.indexOf(cat) === -1) existingCats.push(cat);
  });
  existingCats.sort();

  var catOptions = '<option value="General"' + (tag.category === "General" ? ' selected' : '') + '>General</option>';
  existingCats.forEach(function (c) {
    if (c !== "General") {
      catOptions += '<option value="' + escapeHtml(c) + '"' + (tag.category === c ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
    }
  });

  var body =
    '<div class="form-group"><label>Tag Name *</label>' +
      '<input type="text" id="f-tag-name" value="' + escapeHtml(tag.name) + '">' +
    '</div>' +
    '<div class="form-group"><label>Category</label>' +
      '<div style="display:flex;gap:8px">' +
        '<select id="f-tag-category-select" style="flex:1">' + catOptions +
          '<option value="__new__">+ New category...</option>' +
        '</select>' +
        '<input type="text" id="f-tag-category-new" placeholder="Category name" style="flex:1;display:none">' +
      '</div>' +
    '</div>' +
    '<div class="form-group"><label>Color</label>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<input type="color" id="f-tag-color" value="' + escapeHtml(tag.color || "#4fc3f7") + '" style="width:40px;height:32px;padding:2px;border:1px solid var(--color-border);border-radius:4px;background:transparent;cursor:pointer">' +
        '<span id="f-tag-color-hex" style="font-family:var(--font-mono);font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(tag.color || "#4fc3f7") + '</span>' +
      '</div>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save-tag">Save Changes</button>';
  openModal("Edit Tag", body, footer);

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

  var colorInput = document.getElementById("f-tag-color");
  var hexLabel = document.getElementById("f-tag-color-hex");
  colorInput.addEventListener("input", function () {
    hexLabel.textContent = colorInput.value;
  });
  hexLabel.textContent = colorInput.value;

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
      await api.serverSettings.updateTag(id, {
        name: name,
        category: category,
        color: colorInput.value,
      });
      closeModal();
      showToast('Tag "' + name + '" updated');
      if (typeof _tagCache !== "undefined") _tagCache.loaded = false;
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

// ─── Credentials Tab ───────────────────────────────────────────────────────

var _credsLoaded = false;
var _credsData = [];
// Mask sentinel must match the server's credentialService.MASK. Secrets
// arrive pre-masked from GET; the server preserves the real value on PUT
// whenever the mask (or an empty string) is resubmitted.
var _credMask = "••••••••";

async function loadCredentialsTab() {
  var container = document.getElementById("tab-credentials");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading...</p></div>';
  try {
    _credsData = await api.credentials.list();
    _credsLoaded = true;
    renderCredentialsTab();
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

function credTypeLabel(t) {
  if (t === "snmp") return "SNMP";
  if (t === "winrm") return "WinRM";
  if (t === "ssh") return "SSH";
  return t;
}

function credSummary(c) {
  var cfg = c.config || {};
  if (c.type === "snmp") {
    if (cfg.version === "v3") return "v3 · " + escapeHtml(cfg.username || "") + " · " + escapeHtml(cfg.securityLevel || "");
    return "v2c · community set";
  }
  if (c.type === "winrm") {
    return escapeHtml(cfg.username || "") + (cfg.useHttps ? " · HTTPS" : "");
  }
  if (c.type === "ssh") {
    var auth = (typeof cfg.privateKey === "string" && cfg.privateKey) ? "private key" : "password";
    return escapeHtml(cfg.username || "") + " · " + auth;
  }
  return "";
}

function renderCredentialsTab() {
  var container = document.getElementById("tab-credentials");
  var rows = _credsData.map(function (c) {
    return '<tr>' +
      '<td>' + escapeHtml(c.name) + '</td>' +
      '<td>' + credTypeLabel(c.type) + '</td>' +
      '<td style="color:var(--color-text-secondary);font-size:0.85rem">' + credSummary(c) + '</td>' +
      '<td style="text-align:right">' +
        '<button class="btn btn-sm btn-secondary" data-action="edit" data-id="' + escapeHtml(c.id) + '">Edit</button> ' +
        '<button class="btn btn-sm btn-danger" data-action="delete" data-id="' + escapeHtml(c.id) + '" data-name="' + escapeHtml(c.name) + '">Delete</button>' +
      '</td>' +
    '</tr>';
  }).join("");

  container.innerHTML =
    '<div class="settings-card">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">' +
        '<h4 style="margin:0">Stored Credentials</h4>' +
        '<button class="btn btn-primary btn-sm" id="btn-cred-new">Add Credential</button>' +
      '</div>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Named credentials for asset monitoring probes. ' +
        'SNMP (v2c/v3), WinRM, and SSH credentials can be reused across assets. ' +
        'ICMP needs no credentials, and FortiManager-discovered firewalls reuse the direct-mode API token configured on their integration.' +
      '</p>' +
      (_credsData.length === 0
        ? '<p class="empty-state">No credentials yet. Click "Add Credential" to create one.</p>'
        : '<table class="data-table"><thead><tr><th>Name</th><th>Type</th><th>Details</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>') +
    '</div>';

  document.getElementById("btn-cred-new").addEventListener("click", function () { openCredentialModal(null); });
  container.querySelectorAll('button[data-action="edit"]').forEach(function (btn) {
    btn.addEventListener("click", function () { openCredentialModal(btn.getAttribute("data-id")); });
  });
  container.querySelectorAll('button[data-action="delete"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      deleteCredential(btn.getAttribute("data-id"), btn.getAttribute("data-name"));
    });
  });
}

async function openCredentialModal(id) {
  var cred = null;
  if (id) {
    try { cred = await api.credentials.get(id); }
    catch (err) { showToast(err.message, "error"); return; }
  }
  var isNew = !cred;
  var type = cred ? cred.type : "snmp";
  var title = isNew ? "Add Credential" : ("Edit Credential — " + cred.name);
  var body =
    '<div class="form-group"><label>Name</label>' +
      '<input type="text" id="f-cred-name" value="' + escapeHtml(cred ? cred.name : "") + '" placeholder="e.g. Core SNMP v2c">' +
    '</div>' +
    '<div class="form-group"><label>Type</label>' +
      '<select id="f-cred-type"' + (isNew ? '' : ' disabled') + '>' +
        '<option value="snmp"'  + (type === "snmp"  ? ' selected' : '') + '>SNMP</option>' +
        '<option value="winrm"' + (type === "winrm" ? ' selected' : '') + '>WinRM</option>' +
        '<option value="ssh"'   + (type === "ssh"   ? ' selected' : '') + '>SSH</option>' +
      '</select>' +
      (isNew ? '<p class="hint">Type cannot be changed after creation.</p>' : '') +
    '</div>' +
    '<div id="cred-type-fields"></div>';
  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-cred-save">Save</button>';
  openModal(title, body, footer);

  function renderTypeFields() {
    var t = document.getElementById("f-cred-type").value;
    var cfg = (cred && cred.config) || {};
    var host = document.getElementById("cred-type-fields");
    if (t === "snmp") host.innerHTML = credSnmpForm(cfg);
    else if (t === "winrm") host.innerHTML = credWinrmForm(cfg);
    else host.innerHTML = credSshForm(cfg);
    wireSnmpVersionToggle();
  }
  document.getElementById("f-cred-type").addEventListener("change", renderTypeFields);
  renderTypeFields();

  document.getElementById("btn-cred-save").addEventListener("click", async function () {
    var name = (document.getElementById("f-cred-name").value || "").trim();
    if (!name) { showToast("Name is required", "error"); return; }
    var selectedType = document.getElementById("f-cred-type").value;
    var config = readCredentialForm(selectedType);
    try {
      if (isNew) await api.credentials.create({ name: name, type: selectedType, config: config });
      else await api.credentials.update(id, { name: name, config: config });
      closeModal();
      showToast("Credential saved");
      await loadCredentialsTab();
    } catch (err) {
      showToast(err.message, "error");
    }
  });
}

function credSnmpForm(cfg) {
  var version = cfg.version === "v3" ? "v3" : "v2c";
  var community = cfg.community || "";
  var port = cfg.port || "";
  var v3 = {
    username: cfg.username || "",
    securityLevel: cfg.securityLevel || "authPriv",
    authProtocol: cfg.authProtocol || "SHA",
    authKey: cfg.authKey || "",
    privProtocol: cfg.privProtocol || "AES",
    privKey: cfg.privKey || "",
  };
  return (
    '<div class="form-group"><label>Version</label>' +
      '<select id="f-snmp-version">' +
        '<option value="v2c"' + (version === "v2c" ? " selected" : "") + '>v2c</option>' +
        '<option value="v3"'  + (version === "v3"  ? " selected" : "") + '>v3</option>' +
      '</select>' +
    '</div>' +
    '<div id="snmp-v2c-fields" style="display:' + (version === "v2c" ? "block" : "none") + '">' +
      '<div class="form-group"><label>Community</label>' +
        '<input type="password" id="f-snmp-community" value="' + escapeHtml(community) + '" placeholder="public">' +
      '</div>' +
    '</div>' +
    '<div id="snmp-v3-fields" style="display:' + (version === "v3" ? "block" : "none") + '">' +
      '<div class="form-group"><label>Username</label>' +
        '<input type="text" id="f-snmp-user" value="' + escapeHtml(v3.username) + '">' +
      '</div>' +
      '<div class="form-group"><label>Security Level</label>' +
        '<select id="f-snmp-seclevel">' +
          '<option value="noAuthNoPriv"' + (v3.securityLevel === "noAuthNoPriv" ? " selected" : "") + '>noAuthNoPriv</option>' +
          '<option value="authNoPriv"'   + (v3.securityLevel === "authNoPriv"   ? " selected" : "") + '>authNoPriv</option>' +
          '<option value="authPriv"'     + (v3.securityLevel === "authPriv"     ? " selected" : "") + '>authPriv</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group"><label>Auth Protocol</label>' +
        '<select id="f-snmp-authproto">' +
          '<option value="SHA"'    + (v3.authProtocol === "SHA"    ? " selected" : "") + '>SHA-1 (HMAC-SHA-96)</option>' +
          '<option value="MD5"'    + (v3.authProtocol === "MD5"    ? " selected" : "") + '>MD5 (HMAC-MD5-96)</option>' +
          '<option value="SHA224"' + (v3.authProtocol === "SHA224" ? " selected" : "") + '>SHA-224</option>' +
          '<option value="SHA256"' + (v3.authProtocol === "SHA256" ? " selected" : "") + '>SHA-256</option>' +
          '<option value="SHA384"' + (v3.authProtocol === "SHA384" ? " selected" : "") + '>SHA-384</option>' +
          '<option value="SHA512"' + (v3.authProtocol === "SHA512" ? " selected" : "") + '>SHA-512</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group"><label>Auth Key</label>' +
        '<input type="password" id="f-snmp-authkey" value="' + escapeHtml(v3.authKey) + '">' +
      '</div>' +
      '<div class="form-group"><label>Priv Protocol</label>' +
        '<select id="f-snmp-privproto">' +
          '<option value="AES"'     + (v3.privProtocol === "AES"     ? " selected" : "") + '>AES-128 (CFB)</option>' +
          '<option value="DES"'     + (v3.privProtocol === "DES"     ? " selected" : "") + '>DES (CBC, 56-bit)</option>' +
          '<option value="AES256B"' + (v3.privProtocol === "AES256B" ? " selected" : "") + '>AES-256 (Blumenthal draft)</option>' +
          '<option value="AES256R"' + (v3.privProtocol === "AES256R" ? " selected" : "") + '>AES-256 (Reeder draft / Cisco)</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group"><label>Priv Key</label>' +
        '<input type="password" id="f-snmp-privkey" value="' + escapeHtml(v3.privKey) + '">' +
      '</div>' +
    '</div>' +
    '<div class="form-group"><label>Port</label>' +
      '<input type="number" id="f-snmp-port" value="' + escapeHtml(String(port)) + '" placeholder="161" min="1" max="65535">' +
    '</div>'
  );
}

function wireSnmpVersionToggle() {
  var sel = document.getElementById("f-snmp-version");
  if (!sel) return;
  sel.addEventListener("change", function () {
    var v = sel.value;
    var v2 = document.getElementById("snmp-v2c-fields");
    var v3 = document.getElementById("snmp-v3-fields");
    if (v2) v2.style.display = v === "v2c" ? "block" : "none";
    if (v3) v3.style.display = v === "v3"  ? "block" : "none";
  });
}

function credWinrmForm(cfg) {
  return (
    '<div class="form-group"><label>Username</label>' +
      '<input type="text" id="f-winrm-user" value="' + escapeHtml(cfg.username || "") + '" placeholder="Administrator">' +
    '</div>' +
    '<div class="form-group"><label>Password</label>' +
      '<input type="password" id="f-winrm-pass" value="' + escapeHtml(cfg.password || "") + '">' +
    '</div>' +
    '<div class="form-group"><label>Port</label>' +
      '<input type="number" id="f-winrm-port" value="' + escapeHtml(String(cfg.port || "")) + '" placeholder="5986" min="1" max="65535">' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" id="f-winrm-https"' + (cfg.useHttps ? " checked" : "") + '>' +
        '<span>Use HTTPS</span>' +
      '</label>' +
    '</div>'
  );
}

function credSshForm(cfg) {
  return (
    '<div class="form-group"><label>Username</label>' +
      '<input type="text" id="f-ssh-user" value="' + escapeHtml(cfg.username || "") + '">' +
    '</div>' +
    '<div class="form-group"><label>Password</label>' +
      '<input type="password" id="f-ssh-pass" value="' + escapeHtml(cfg.password || "") + '">' +
      '<p class="hint">Provide either a password or a private key.</p>' +
    '</div>' +
    '<div class="form-group"><label>Private Key</label>' +
      '<textarea id="f-ssh-key" rows="5" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----">' + escapeHtml(cfg.privateKey || "") + '</textarea>' +
    '</div>' +
    '<div class="form-group"><label>Port</label>' +
      '<input type="number" id="f-ssh-port" value="' + escapeHtml(String(cfg.port || "")) + '" placeholder="22" min="1" max="65535">' +
    '</div>'
  );
}

function readCredentialForm(type) {
  function num(v) { v = (v || "").trim(); return v ? Number(v) : undefined; }
  if (type === "snmp") {
    var version = document.getElementById("f-snmp-version").value;
    var port = num(document.getElementById("f-snmp-port").value);
    if (version === "v2c") {
      var cfg = { version: "v2c", community: document.getElementById("f-snmp-community").value };
      if (port !== undefined) cfg.port = port;
      return cfg;
    }
    var v3 = {
      version: "v3",
      username: document.getElementById("f-snmp-user").value,
      securityLevel: document.getElementById("f-snmp-seclevel").value,
      authProtocol: document.getElementById("f-snmp-authproto").value,
      authKey: document.getElementById("f-snmp-authkey").value,
      privProtocol: document.getElementById("f-snmp-privproto").value,
      privKey: document.getElementById("f-snmp-privkey").value,
    };
    if (port !== undefined) v3.port = port;
    return v3;
  }
  if (type === "winrm") {
    var w = {
      username: document.getElementById("f-winrm-user").value,
      password: document.getElementById("f-winrm-pass").value,
      useHttps: document.getElementById("f-winrm-https").checked,
    };
    var wp = num(document.getElementById("f-winrm-port").value);
    if (wp !== undefined) w.port = wp;
    return w;
  }
  var s = {
    username: document.getElementById("f-ssh-user").value,
    password: document.getElementById("f-ssh-pass").value,
    privateKey: document.getElementById("f-ssh-key").value,
  };
  var sp = num(document.getElementById("f-ssh-port").value);
  if (sp !== undefined) s.port = sp;
  return s;
}

async function deleteCredential(id, name) {
  var ok = await showConfirm('Delete credential "' + name + '"?');
  if (!ok) return;
  try {
    await api.credentials.delete(id);
    showToast("Credential deleted");
    await loadCredentialsTab();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── API Tokens tab ────────────────────────────────────────────────────────

var _apiTokensLoaded = false;

async function loadApiTokensTab() {
  var container = document.getElementById("tab-api-tokens");
  if (!container) return;
  _apiTokensLoaded = true;
  container.innerHTML = '<p class="empty-state" style="padding:2rem">Loading…</p>';
  try {
    var data = await api.apiTokens.list();
    renderApiTokensTab(data.tokens || [], data.knownScopes || []);
  } catch (err) {
    container.innerHTML = '<p class="empty-state" style="color:var(--color-danger,#c0392b);padding:2rem">' + escapeHtml(err.message || "Failed to load API tokens") + '</p>';
  }
}

function renderApiTokensTab(tokens, knownScopes) {
  var container = document.getElementById("tab-api-tokens");
  if (!container) return;

  var tableHtml = tokens.length
    ? '<div class="table-wrapper"><table class="data-table"><thead><tr>' +
        '<th>Name</th><th>Prefix</th><th>Scopes</th><th>Created By</th><th>Last Used</th><th>Expires</th><th>Status</th><th>Actions</th>' +
      '</tr></thead><tbody>' +
      tokens.map(function (t) {
        var statusBadge = t.revokedAt
          ? '<span class="badge badge-disabled">Revoked</span>'
          : t.expiresAt && new Date(t.expiresAt) <= new Date()
            ? '<span class="badge badge-decommissioned">Expired</span>'
            : '<span class="badge badge-active">Active</span>';
        var actions = t.revokedAt
          ? '<button class="btn btn-sm btn-danger" onclick="deleteApiToken(\'' + t.id + '\',\'' + escapeHtml(t.name) + '\')">Delete</button>'
          : '<button class="btn btn-sm btn-secondary" onclick="revokeApiToken(\'' + t.id + '\',\'' + escapeHtml(t.name) + '\')">Revoke</button>' +
            '<button class="btn btn-sm btn-danger" onclick="deleteApiToken(\'' + t.id + '\',\'' + escapeHtml(t.name) + '\')">Delete</button>';
        return '<tr>' +
          '<td><strong>' + escapeHtml(t.name) + '</strong></td>' +
          '<td class="mono">' + escapeHtml(t.tokenPrefix || "—") + '…</td>' +
          '<td>' + (t.scopes || []).map(function (s) { return '<span class="badge badge-type">' + escapeHtml(s) + '</span> '; }).join("") + '</td>' +
          '<td>' + escapeHtml(t.createdBy || "—") + '</td>' +
          '<td>' + (t.lastUsedAt ? formatDate(t.lastUsedAt) + (t.lastUsedIp ? ' <span class="mono" style="font-size:0.78rem;color:var(--color-text-secondary)">(' + escapeHtml(t.lastUsedIp) + ')</span>' : '') : "—") + '</td>' +
          '<td>' + (t.expiresAt ? formatDate(t.expiresAt) : "Never") + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td class="actions">' + actions + '</td>' +
        '</tr>';
      }).join("") +
      '</tbody></table></div>'
    : '<p class="empty-state" style="padding:1.5rem 0">No API tokens yet.</p>';

  var scopeOpts = (knownScopes || []).map(function (s) {
    return '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" name="scope" value="' + escapeHtml(s) + '"> ' + escapeHtml(s) + '</label>';
  }).join(" ");

  container.innerHTML =
    '<div class="settings-section">' +
      '<h3 class="settings-section-title">API Tokens</h3>' +
      '<p style="color:var(--color-text-secondary);margin:0 0 1rem">Bearer tokens for external systems (e.g. SIEM) to call the Polaris API. ' +
        'The raw token value is shown <strong>once</strong> at creation and cannot be recovered.</p>' +
      tableHtml +
    '</div>' +
    '<div class="settings-section" style="margin-top:1.5rem">' +
      '<h4 style="margin:0 0 0.75rem">Create New Token</h4>' +
      '<div style="display:grid;gap:0.75rem;max-width:480px">' +
        '<div>' +
          '<label class="form-label" for="f-token-name">Name <span style="color:var(--color-danger,#c0392b)">*</span></label>' +
          '<input type="text" id="f-token-name" class="form-input" placeholder="e.g. SIEM Quarantine" maxlength="80">' +
        '</div>' +
        '<div>' +
          '<label class="form-label">Scopes <span style="color:var(--color-danger,#c0392b)">*</span></label>' +
          '<div style="display:flex;gap:1rem;flex-wrap:wrap">' + scopeOpts + '</div>' +
        '</div>' +
        '<div>' +
          '<label class="form-label" for="f-token-expires">Expires (optional)</label>' +
          '<input type="datetime-local" id="f-token-expires" class="form-input">' +
        '</div>' +
        '<div><button class="btn btn-primary" id="btn-create-api-token">Create Token</button></div>' +
      '</div>' +
    '</div>';

  document.getElementById("btn-create-api-token").addEventListener("click", createApiToken);
}

async function createApiToken() {
  var name = (document.getElementById("f-token-name").value || "").trim();
  if (!name) { showToast("Token name is required", "error"); return; }
  var scopes = Array.from(document.querySelectorAll('input[name="scope"]:checked')).map(function (cb) { return cb.value; });
  if (!scopes.length) { showToast("Select at least one scope", "error"); return; }
  var expiresAt = document.getElementById("f-token-expires").value;
  var body = { name: name, scopes: scopes };
  if (expiresAt) body.expiresAt = new Date(expiresAt).toISOString();

  var btn = document.getElementById("btn-create-api-token");
  btn.disabled = true;
  try {
    var result = await api.apiTokens.create(body);
    // Show the raw token in a modal — the only time the caller ever sees it.
    _showRawTokenModal(result.token.name, result.rawToken);
    _apiTokensLoaded = false;
    await loadApiTokensTab();
  } catch (err) {
    showToast(err.message || "Create failed", "error");
  } finally {
    btn.disabled = false;
  }
}

function _showRawTokenModal(name, rawToken) {
  var body =
    '<p style="margin:0 0 0.75rem">Token <strong>' + escapeHtml(name) + '</strong> created. Copy the token below — it will <strong>never be shown again</strong>.</p>' +
    '<div style="background:var(--color-surface-alt,#1a1a1a);border:1px solid var(--color-border);border-radius:6px;padding:0.75rem;font-family:monospace;font-size:0.9rem;word-break:break-all;user-select:all" id="raw-token-display">' +
      escapeHtml(rawToken) +
    '</div>' +
    '<div style="margin-top:0.75rem">' +
      '<button class="btn btn-secondary" id="btn-copy-raw-token">Copy to clipboard</button>' +
    '</div>';
  openModal("Token Created — Save Now", body,
    '<button class="btn btn-primary" onclick="closeModal()">I have saved it</button>');
  document.getElementById("btn-copy-raw-token").addEventListener("click", async function () {
    try {
      await navigator.clipboard.writeText(rawToken);
      showToast("Token copied");
    } catch (_) {
      showToast("Copy failed — select the token text manually", "error");
    }
  });
}

async function revokeApiToken(id, name) {
  var ok = await showConfirm('Revoke token "' + name + '"? It will stop working immediately.');
  if (!ok) return;
  try {
    await api.apiTokens.revoke(id);
    showToast('Token "' + name + '" revoked');
    _apiTokensLoaded = false;
    await loadApiTokensTab();
  } catch (err) {
    showToast(err.message || "Revoke failed", "error");
  }
}

async function deleteApiToken(id, name) {
  var ok = await showConfirm('Permanently delete token "' + name + '"? This cannot be undone.');
  if (!ok) return;
  try {
    await api.apiTokens.delete(id);
    showToast('Token "' + name + '" deleted');
    _apiTokensLoaded = false;
    await loadApiTokensTab();
  } catch (err) {
    showToast(err.message || "Delete failed", "error");
  }
}
