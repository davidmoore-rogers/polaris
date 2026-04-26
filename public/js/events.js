/**
 * public/js/events.js — Events page logic
 */

var _eventsPageSize = 15;
var _eventsCurrentOffset = 0;
var _eventsCurrentTotal = 0;
var _eventsCurrentPage = [];

(function () {
  var pageSize = _eventsPageSize;
  var currentOffset = 0;
  var currentTotal = 0;

  async function loadEvents() {
    var level = document.getElementById("filter-level").value;
    var resourceType = document.getElementById("filter-resource").value;
    var action = document.getElementById("filter-action").value.trim();
    var actor = document.getElementById("filter-actor").value.trim();
    var message = document.getElementById("filter-message").value.trim();

    try {
      var data = await api.events.list({
        limit: pageSize,
        offset: currentOffset,
        level: level || undefined,
        resourceType: resourceType || undefined,
        action: action || undefined,
        actor: actor || undefined,
        message: message || undefined,
      });

      var events = data.events || [];
      currentTotal = data.total || 0;
      _eventsPageSize = pageSize;
      _eventsCurrentOffset = currentOffset;
      _eventsCurrentTotal = currentTotal;
      _eventsCurrentPage = events;
      renderTable(events);
      renderPagination();
    } catch (err) {
      document.getElementById("events-tbody").innerHTML =
        '<tr><td colspan="7" class="empty-state">Failed to load events</td></tr>';
    }
  }

  function renderTable(events) {
    var tbody = document.getElementById("events-tbody");
    if (!events.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No events found</td></tr>';
      return;
    }

    tbody.innerHTML = events.map(function (ev, idx) {
      var ts = new Date(ev.timestamp);
      var timeStr = ts.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
        " " + ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      var levelClass = "badge-level-" + (ev.level || "info");
      var levelLabel = (ev.level || "info").toUpperCase();

      var resourceLabel = ev.resourceType || "-";
      var resourceName = ev.resourceName ? ' <span style="color:var(--color-text-tertiary);font-size:0.8rem">(' + escapeHtml(ev.resourceName) + ')</span>' : "";

      var detailBtn = ev.details && ev.details.changes
        ? '<button class="btn btn-secondary btn-sm btn-event-detail" data-event-idx="' + idx + '" style="padding:2px 8px;font-size:0.75rem">Detail</button>'
        : '';

      return '<tr>' +
        '<td style="font-family:var(--font-mono);font-size:0.82rem;white-space:nowrap">' + escapeHtml(timeStr) + '</td>' +
        '<td><span class="badge ' + levelClass + '">' + levelLabel + '</span></td>' +
        '<td style="font-family:var(--font-mono);font-size:0.82rem">' + escapeHtml(ev.action || "") + '</td>' +
        '<td>' + escapeHtml(resourceLabel) + resourceName + '</td>' +
        '<td>' + escapeHtml(ev.message || "") + '</td>' +
        '<td>' + escapeHtml(ev.actor || "-") + '</td>' +
        '<td>' + detailBtn + '</td>' +
        '</tr>';
    }).join("");

  }

  function renderPagination() {
    var containers = [];
    var mainEl = document.getElementById("pagination");
    if (mainEl) containers.push(mainEl);
    var topEl = document.getElementById("pagination-top");
    if (topEl) containers.push(topEl);
    if (containers.length === 0) return;

    var totalPages = Math.max(1, Math.ceil(currentTotal / pageSize));
    var currentPage = Math.floor(currentOffset / pageSize) + 1;

    // Build page number buttons
    var pageButtons = "";
    var startPage = Math.max(1, currentPage - 2);
    var endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);

    if (startPage > 1) {
      pageButtons += '<button class="btn btn-secondary btn-sm page-btn" data-page="1">1</button>';
      if (startPage > 2) pageButtons += '<span style="color:var(--color-text-tertiary)">...</span>';
    }

    for (var p = startPage; p <= endPage; p++) {
      if (p === currentPage) {
        pageButtons += '<button class="btn btn-primary btn-sm page-btn" data-page="' + p + '" disabled>' + p + '</button>';
      } else {
        pageButtons += '<button class="btn btn-secondary btn-sm page-btn" data-page="' + p + '">' + p + '</button>';
      }
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) pageButtons += '<span style="color:var(--color-text-tertiary)">...</span>';
      pageButtons += '<button class="btn btn-secondary btn-sm page-btn" data-page="' + totalPages + '">' + totalPages + '</button>';
    }

    var html =
      '<button class="btn btn-secondary btn-sm page-prev" ' + (currentPage <= 1 ? 'disabled' : '') + '>&laquo; Prev</button>' +
      pageButtons +
      '<button class="btn btn-secondary btn-sm page-next" ' + (currentPage >= totalPages ? 'disabled' : '') + '>Next &raquo;</button>' +
      '<span style="font-size:0.82rem;color:var(--color-text-tertiary);margin-left:8px">' + currentTotal + ' events</span>';

    containers.forEach(function (container) {
      container.innerHTML = html;
      container.querySelector(".page-prev").addEventListener("click", function () {
        if (currentOffset >= pageSize) {
          currentOffset -= pageSize;
          loadEvents();
        }
      });
      container.querySelector(".page-next").addEventListener("click", function () {
        if (currentOffset + pageSize < currentTotal) {
          currentOffset += pageSize;
          loadEvents();
        }
      });
      container.querySelectorAll(".page-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var page = parseInt(btn.getAttribute("data-page"), 10);
          currentOffset = (page - 1) * pageSize;
          loadEvents();
        });
      });
    });
  }

  // Filters
  document.getElementById("filter-level").addEventListener("change", function () { currentOffset = 0; loadEvents(); });
  document.getElementById("filter-resource").addEventListener("change", function () { currentOffset = 0; loadEvents(); });
  document.getElementById("filter-pagesize").addEventListener("change", function () {
    pageSize = parseInt(this.value, 10) || 15;
    currentOffset = 0;
    loadEvents();
  });

  var actionTimer;
  document.getElementById("filter-action").addEventListener("input", function () {
    clearTimeout(actionTimer);
    actionTimer = setTimeout(function () { currentOffset = 0; loadEvents(); }, 400);
  });

  var actorTimer;
  document.getElementById("filter-actor").addEventListener("input", function () {
    clearTimeout(actorTimer);
    actorTimer = setTimeout(function () { currentOffset = 0; loadEvents(); }, 400);
  });

  var messageTimer;
  document.getElementById("filter-message").addEventListener("input", function () {
    clearTimeout(messageTimer);
    messageTimer = setTimeout(function () { currentOffset = 0; loadEvents(); }, 400);
  });

  document.getElementById("btn-refresh").addEventListener("click", function () { loadEvents(); });

  // Detail button delegation
  document.getElementById("events-tbody").addEventListener("click", function (e) {
    var btn = e.target.closest(".btn-event-detail");
    if (!btn) return;
    var idx = parseInt(btn.getAttribute("data-event-idx"), 10);
    if (_eventsCurrentPage[idx]) showEventDetail(_eventsCurrentPage[idx]);
  });

  // Settings button
  var settingsBtn = document.getElementById("btn-event-settings");
  if (settingsBtn) settingsBtn.addEventListener("click", openEventSettingsModal);

  // Initial load
  loadEvents();
})();

// ─── Settings Modal (Tabbed) ────────────────────────────────────────────────

var _activeSettingsTab = "archive";

async function openEventSettingsModal() {
  var archiveDefaults = { enabled: false, protocol: "scp", host: "", port: 22, username: "", password: "", keyPath: "", remotePath: "/var/archive/polaris" };
  var syslogDefaults = { enabled: false, protocol: "udp", host: "", port: 514, facility: "local0", severity: "info", format: "rfc5424", tlsCaPath: "", tlsCertPath: "", tlsKeyPath: "" };
  var retentionDefaults = { retentionDays: 7, minLevel: "info" };

  if (_activeSettingsTab === "assets") _activeSettingsTab = "archive";

  try {
    var results = await Promise.all([
      api.events.getArchiveSettings().catch(function () { return null; }),
      api.events.getSyslogSettings().catch(function () { return null; }),
      api.events.getRetentionSettings().catch(function () { return null; }),
    ]);
    if (results[0]) {
      var s = results[0];
      archiveDefaults.enabled = s.enabled || false;
      archiveDefaults.protocol = s.protocol || "scp";
      archiveDefaults.host = s.host || "";
      archiveDefaults.port = s.port || 22;
      archiveDefaults.username = s.username || "";
      archiveDefaults.password = s.password || "";
      archiveDefaults.keyPath = s.keyPath || "";
      archiveDefaults.remotePath = s.remotePath || "/var/archive/polaris";
    }
    if (results[1]) {
      var sl = results[1];
      syslogDefaults.enabled = sl.enabled || false;
      syslogDefaults.protocol = sl.protocol || "udp";
      syslogDefaults.host = sl.host || "";
      syslogDefaults.port = sl.port || 514;
      syslogDefaults.facility = sl.facility || "local0";
      syslogDefaults.severity = sl.severity || "info";
      syslogDefaults.format = sl.format || "rfc5424";
      syslogDefaults.tlsCaPath = sl.tlsCaPath || "";
      syslogDefaults.tlsCertPath = sl.tlsCertPath || "";
      syslogDefaults.tlsKeyPath = sl.tlsKeyPath || "";
    }
    if (results[2]) {
      retentionDefaults.retentionDays = results[2].retentionDays || 7;
      retentionDefaults.minLevel = results[2].minLevel || "info";
    }
  } catch (_) {}

  var body =
    // Tabs
    '<div class="settings-tabs">' +
      '<button class="settings-tab' + (_activeSettingsTab === "archive" ? ' active' : '') + '" data-tab="archive">Archive Export</button>' +
      '<button class="settings-tab' + (_activeSettingsTab === "syslog" ? ' active' : '') + '" data-tab="syslog">Syslog</button>' +
      '<button class="settings-tab' + (_activeSettingsTab === "retention" ? ' active' : '') + '" data-tab="retention">Retention</button>' +
    '</div>' +
    // Archive tab panel
    '<div class="settings-tab-panel' + (_activeSettingsTab === "archive" ? ' active' : '') + '" id="tab-archive">' +
      archiveFormHTML(archiveDefaults) +
    '</div>' +
    // Syslog tab panel
    '<div class="settings-tab-panel' + (_activeSettingsTab === "syslog" ? ' active' : '') + '" id="tab-syslog">' +
      syslogFormHTML(syslogDefaults) +
    '</div>' +
    // Retention tab panel
    '<div class="settings-tab-panel' + (_activeSettingsTab === "retention" ? ' active' : '') + '" id="tab-retention">' +
      retentionFormHTML(retentionDefaults) +
    '</div>';

  var noTestTab = _activeSettingsTab === "retention";
  var footer =
    '<div id="settings-footer-left" style="margin-right:auto;display:flex;gap:8px">' +
      '<button class="btn btn-secondary" id="btn-settings-test"' + (noTestTab ? ' style="display:none"' : '') + '>Test Connection</button>' +
    '</div>' +
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-settings-save">Save</button>';

  openModal("Event Settings", body, footer);

  // Tab switching
  document.querySelectorAll(".settings-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var target = tab.getAttribute("data-tab");
      _activeSettingsTab = target;
      document.querySelectorAll(".settings-tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".settings-tab-panel").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      document.getElementById("tab-" + target).classList.add("active");
      var testBtn = document.getElementById("btn-settings-test");
      if (testBtn) testBtn.style.display = target === "retention" ? "none" : "";
      updateSyslogTlsVisibility();
    });
  });

  // Syslog protocol change → toggle TLS fields + default port
  var sysProto = document.getElementById("f-syslog-protocol");
  if (sysProto) {
    sysProto.addEventListener("change", function () {
      updateSyslogTlsVisibility();
      var portEl = document.getElementById("f-syslog-port");
      if (this.value === "tls" && portEl.value === "514") portEl.value = "6514";
      if (this.value !== "tls" && portEl.value === "6514") portEl.value = "514";
    });
  }
  updateSyslogTlsVisibility();

  // Test Connection
  document.getElementById("btn-settings-test").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    var resultId = _activeSettingsTab === "archive" ? "archive-test-result" : "syslog-test-result";
    var resultEl = document.getElementById(resultId);
    if (resultEl) resultEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Testing connection...</span>';
    try {
      var result;
      if (_activeSettingsTab === "archive") {
        result = await api.events.testArchiveConnection(getArchiveFormData());
      } else {
        result = await api.events.testSyslogConnection(getSyslogFormData());
      }
      if (resultEl) {
        resultEl.innerHTML = result.ok
          ? '<span style="color:var(--color-success)">' + escapeHtml(result.message) + '</span>'
          : '<span style="color:var(--color-danger)">' + escapeHtml(result.message) + '</span>';
      }
    } catch (err) {
      if (resultEl) {
        resultEl.innerHTML = err.name === "AbortError"
          ? '<span style="color:var(--color-text-tertiary)">Test aborted</span>'
          : '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
      }
    } finally {
      btn.disabled = false;
    }
  });

  // Save
  document.getElementById("btn-settings-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      if (_activeSettingsTab === "archive") {
        await api.events.updateArchiveSettings(getArchiveFormData());
        showToast("Archive settings saved");
      } else if (_activeSettingsTab === "syslog") {
        await api.events.updateSyslogSettings(getSyslogFormData());
        showToast("Syslog settings saved");
      } else if (_activeSettingsTab === "retention") {
        await api.events.updateRetentionSettings(getRetentionFormData());
        showToast("Retention settings saved");
      }
      closeModal();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// ─── Archive Tab Form ───────────────────────────────────────────────────────

function archiveFormHTML(d) {
  return '<div class="form-group">' +
    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
      '<input type="checkbox" id="f-archive-enabled"' + (d.enabled ? ' checked' : '') + '>' +
      '<span>Enable automatic archive export</span>' +
    '</label>' +
    '<p class="hint">When enabled, events are archived and sent to the remote server before being pruned per the configured retention period.</p>' +
  '</div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Connection</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Protocol</label>' +
      '<select id="f-archive-protocol">' +
        '<option value="scp"' + (d.protocol === "scp" ? ' selected' : '') + '>SCP</option>' +
        '<option value="sftp"' + (d.protocol === "sftp" ? ' selected' : '') + '>SFTP</option>' +
      '</select>' +
    '</div>' +
    '<div class="form-group"><label>Port</label><input type="number" id="f-archive-port" value="' + escapeHtml(String(d.port)) + '" min="1" max="65535"></div>' +
  '</div>' +
  '<div class="form-group"><label>Host / IP</label><input type="text" id="f-archive-host" value="' + escapeHtml(d.host) + '" placeholder="e.g. archive.corp.local or 10.0.5.100"></div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Authentication</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Username</label><input type="text" id="f-archive-username" value="' + escapeHtml(d.username) + '" placeholder="e.g. polaris-svc"></div>' +
    '<div class="form-group"><label>Password</label><input type="password" id="f-archive-password" value="' + escapeHtml(d.password) + '" placeholder="Leave blank for key auth"></div>' +
  '</div>' +
  '<div class="form-group"><label>SSH Key Path</label><input type="text" id="f-archive-keypath" value="' + escapeHtml(d.keyPath) + '" placeholder="e.g. /home/polaris/.ssh/id_rsa"><p class="hint">Path on the Polaris server. Used instead of password when provided.</p></div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Destination</p>' +
  '<div class="form-group"><label>Remote Path</label><input type="text" id="f-archive-remotepath" value="' + escapeHtml(d.remotePath) + '" placeholder="e.g. /var/archive/polaris"><p class="hint">Directory on the remote server where archive files will be stored.</p></div>' +
  '<div id="archive-test-result" style="margin-top:0.5rem"></div>';
}

function getArchiveFormData() {
  return {
    enabled: document.getElementById("f-archive-enabled").checked,
    protocol: document.getElementById("f-archive-protocol").value,
    host: document.getElementById("f-archive-host").value.trim(),
    port: parseInt(document.getElementById("f-archive-port").value, 10) || 22,
    username: document.getElementById("f-archive-username").value.trim(),
    password: document.getElementById("f-archive-password").value,
    keyPath: document.getElementById("f-archive-keypath").value.trim(),
    remotePath: document.getElementById("f-archive-remotepath").value.trim() || "/var/archive/polaris",
  };
}

// ─── Syslog Tab Form ────────────────────────────────────────────────────────

function syslogFormHTML(d) {
  return '<div class="form-group">' +
    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
      '<input type="checkbox" id="f-syslog-enabled"' + (d.enabled ? ' checked' : '') + '>' +
      '<span>Enable syslog forwarding</span>' +
    '</label>' +
    '<p class="hint">When enabled, events are forwarded to a remote syslog server in real time.</p>' +
  '</div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Connection</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Protocol</label>' +
      '<select id="f-syslog-protocol">' +
        '<option value="udp"' + (d.protocol === "udp" ? ' selected' : '') + '>UDP</option>' +
        '<option value="tcp"' + (d.protocol === "tcp" ? ' selected' : '') + '>TCP</option>' +
        '<option value="tls"' + (d.protocol === "tls" ? ' selected' : '') + '>TLS (Secure)</option>' +
      '</select>' +
    '</div>' +
    '<div class="form-group"><label>Port</label><input type="number" id="f-syslog-port" value="' + escapeHtml(String(d.port)) + '" min="1" max="65535"></div>' +
  '</div>' +
  '<div class="form-group"><label>Host / IP</label><input type="text" id="f-syslog-host" value="' + escapeHtml(d.host) + '" placeholder="e.g. syslog.corp.local or 10.0.5.200"></div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Syslog Options</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Facility</label>' +
      '<select id="f-syslog-facility">' +
        syslogFacilityOptions(d.facility) +
      '</select>' +
    '</div>' +
    '<div class="form-group"><label>Minimum Severity</label>' +
      '<select id="f-syslog-severity">' +
        '<option value="info"' + (d.severity === "info" ? ' selected' : '') + '>Info (all events)</option>' +
        '<option value="warning"' + (d.severity === "warning" ? ' selected' : '') + '>Warning and above</option>' +
        '<option value="error"' + (d.severity === "error" ? ' selected' : '') + '>Error only</option>' +
      '</select>' +
    '</div>' +
  '</div>' +
  '<div class="form-group"><label>Message Format</label>' +
    '<select id="f-syslog-format">' +
      '<option value="rfc5424"' + (d.format === "rfc5424" ? ' selected' : '') + '>RFC 5424 (modern)</option>' +
      '<option value="rfc3164"' + (d.format === "rfc3164" ? ' selected' : '') + '>RFC 3164 (BSD/legacy)</option>' +
    '</select>' +
  '</div>' +
  '<div id="syslog-tls-fields">' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">TLS Certificates</p>' +
    '<div class="form-group"><label>CA Certificate Path</label><input type="text" id="f-syslog-tlsca" value="' + escapeHtml(d.tlsCaPath) + '" placeholder="e.g. /etc/polaris/ca.pem"><p class="hint">Certificate authority to verify the syslog server.</p></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
      '<div class="form-group"><label>Client Certificate</label><input type="text" id="f-syslog-tlscert" value="' + escapeHtml(d.tlsCertPath) + '" placeholder="Optional"></div>' +
      '<div class="form-group"><label>Client Key</label><input type="text" id="f-syslog-tlskey" value="' + escapeHtml(d.tlsKeyPath) + '" placeholder="Optional"></div>' +
    '</div>' +
  '</div>' +
  '<div id="syslog-test-result" style="margin-top:0.5rem"></div>';
}

function syslogFacilityOptions(selected) {
  var facilities = ["local0","local1","local2","local3","local4","local5","local6","local7"];
  return facilities.map(function (f) {
    return '<option value="' + f + '"' + (selected === f ? ' selected' : '') + '>' + f.toUpperCase() + '</option>';
  }).join("");
}

function updateSyslogTlsVisibility() {
  var protoEl = document.getElementById("f-syslog-protocol");
  var tlsFields = document.getElementById("syslog-tls-fields");
  if (protoEl && tlsFields) {
    tlsFields.style.display = protoEl.value === "tls" ? "block" : "none";
  }
}

function getSyslogFormData() {
  return {
    enabled: document.getElementById("f-syslog-enabled").checked,
    protocol: document.getElementById("f-syslog-protocol").value,
    host: document.getElementById("f-syslog-host").value.trim(),
    port: parseInt(document.getElementById("f-syslog-port").value, 10) || 514,
    facility: document.getElementById("f-syslog-facility").value,
    severity: document.getElementById("f-syslog-severity").value,
    format: document.getElementById("f-syslog-format").value,
    tlsCaPath: document.getElementById("f-syslog-tlsca").value.trim(),
    tlsCertPath: document.getElementById("f-syslog-tlscert").value.trim(),
    tlsKeyPath: document.getElementById("f-syslog-tlskey").value.trim(),
  };
}

// ─── Retention Tab Form ─────────────────────────────────────────────────────

function retentionFormHTML(d) {
  return '<div class="form-group">' +
    '<label>Retention Period (days)</label>' +
    '<input type="number" id="f-retention-days" value="' + escapeHtml(String(d.retentionDays)) + '" min="1" max="365" style="max-width:120px">' +
    '<p class="hint">Events older than this many days are automatically deleted. ' +
      'If archive export is enabled, events are archived before being removed. ' +
      'Default is 7 days.</p>' +
  '</div>' +
  '<div class="form-group">' +
    '<label>Minimum Event Level</label>' +
    '<select id="f-retention-minlevel" style="max-width:200px">' +
      '<option value="info"' + (d.minLevel === "info" ? ' selected' : '') + '>Info — store all events</option>' +
      '<option value="warning"' + (d.minLevel === "warning" ? ' selected' : '') + '>Warning — skip info events</option>' +
      '<option value="error"' + (d.minLevel === "error" ? ' selected' : '') + '>Error — skip info and warning events</option>' +
    '</select>' +
    '<p class="hint">Events below this level are not written to the log. Default is Info (all events stored).</p>' +
  '</div>';
}

function getRetentionFormData() {
  return {
    retentionDays: Math.max(1, parseInt(document.getElementById("f-retention-days").value, 10) || 7),
    minLevel: document.getElementById("f-retention-minlevel").value || "info",
  };
}

/* ─── Conflict Resolution Panel ──────────────────────────────────────────── */

(function () {
  var overlay = document.getElementById("conflict-overlay");
  var panel = document.getElementById("conflict-panel");
  var closeBtn = document.getElementById("conflict-panel-close");
  var filterSel = document.getElementById("conflict-panel-filter");
  var body = document.getElementById("conflict-panel-body");
  var countEl = document.getElementById("conflict-panel-count");
  var badge = document.getElementById("conflict-badge");
  var btn = document.getElementById("btn-conflicts");
  if (!btn || !overlay) return;

  // Load pending count for badge on page load
  async function refreshBadge() {
    try {
      var data = await api.conflicts.count();
      var n = data.count || 0;
      if (n > 0) {
        badge.textContent = n > 99 ? "99+" : String(n);
        badge.style.display = "block";
      } else {
        badge.style.display = "none";
      }
      if (typeof window.refreshConflictDot === "function") window.refreshConflictDot();
    } catch (_) {}
  }
  refreshBadge();

  function openPanel() {
    overlay.classList.add("open");
    loadConflicts();
  }

  function closePanel() {
    overlay.classList.remove("open");
    refreshBadge();
  }

  btn.addEventListener("click", openPanel);
  closeBtn.addEventListener("click", closePanel);
  overlay.addEventListener("click", function (e) { if (e.target === overlay) closePanel(); });
  filterSel.addEventListener("change", loadConflicts);

  async function loadConflicts(silent) {
    if (!silent) body.innerHTML = '<div class="empty-state" style="padding:2rem">Loading...</div>';
    try {
      var status = filterSel.value;
      var data = await api.conflicts.list({ status: status, limit: 5000 });
      var conflicts = data.conflicts || [];
      countEl.textContent = conflicts.length + " conflict" + (conflicts.length !== 1 ? "s" : "") + (status !== "all" ? " (" + status + ")" : "");
      if (!conflicts.length) {
        body.innerHTML = '<div class="empty-state" style="padding:2rem">No conflicts found.</div>';
        return;
      }
      body.innerHTML = conflicts.map(function (c) { return renderConflictCard(c); }).join("");

      // Bind accept/reject buttons
      body.querySelectorAll("[data-conflict-action]").forEach(function (el) {
        el.addEventListener("click", async function () {
          var id = el.getAttribute("data-conflict-id");
          var action = el.getAttribute("data-conflict-action");
          el.disabled = true;
          try {
            if (action === "accept") {
              await api.conflicts.accept(id);
              showToast("Conflict accepted — discovered values applied");
            } else {
              await api.conflicts.reject(id);
              showToast("Conflict rejected — existing values kept");
            }
            var scrollTop = body.scrollTop;
            await loadConflicts(true);
            body.scrollTop = scrollTop;
            refreshBadge();
          } catch (err) {
            showToast(err.message, "error");
            el.disabled = false;
          }
        });
      });
    } catch (err) {
      body.innerHTML = '<div class="empty-state" style="padding:2rem;color:var(--color-danger)">' + escapeHtml(err.message) + '</div>';
    }
  }

  function sourceBadgeClass(sourceType) {
    if (!sourceType) return "badge-source-device";
    if (sourceType === "vip") return "badge-source-vip";
    if (sourceType.startsWith("dhcp")) return "badge-source-dhcp";
    if (sourceType === "interface_ip") return "badge-source-interface";
    return "badge-source-device";
  }

  function sourceLabel(sourceType) {
    var map = {
      vip: "VIP", dhcp_reservation: "DHCP Reservation", dhcp_lease: "DHCP Lease",
      interface_ip: "Interface IP", fortiswitch: "FortiSwitch", fortinap: "FortiAP",
      fortimanager: "FortiManager", manual: "Manual",
    };
    return map[sourceType] || sourceType || "Unknown";
  }

  function renderConflictCard(c) {
    if (c.entityType === "asset") return renderAssetConflictCard(c);
    return renderReservationConflictCard(c);
  }

  function renderReservationConflictCard(c) {
    var res = c.reservation || {};
    var subnet = res.subnet || {};
    var ip = res.ipAddress || "(full subnet)";
    var subnetLabel = subnet.cidr || "";
    if (subnet.name) subnetLabel += " — " + subnet.name;
    var isResolved = c.status !== "pending";

    var fields = ["hostname", "owner", "projectRef", "notes"];
    var rows = fields.map(function (f) {
      var existingVal = res[f] || null;
      var proposedKey = "proposed" + f.charAt(0).toUpperCase() + f.slice(1);
      var proposedVal = c[proposedKey] || null;
      var changed = (c.conflictFields || []).includes(f);
      return '<tr class="' + (changed ? "conflict-changed" : "") + '">' +
        '<td class="conflict-field">' + formatFieldName(f) + '</td>' +
        '<td>' + (existingVal ? escapeHtml(existingVal) : '<span style="color:var(--color-text-tertiary);font-style:italic">—</span>') + '</td>' +
        '<td>' + (proposedVal ? (changed ? '<strong>' + escapeHtml(proposedVal) + '</strong>' : escapeHtml(proposedVal)) : '<span style="color:var(--color-text-tertiary);font-style:italic">—</span>') + '</td>' +
        '</tr>';
    }).join("");

    var actions = isResolved
      ? '<span class="badge badge-' + c.status + '" style="text-transform:capitalize">' + escapeHtml(c.status) + '</span>' +
        (c.resolvedBy ? ' <span style="color:var(--color-text-tertiary);font-size:0.75rem">by ' + escapeHtml(c.resolvedBy) + '</span>' : '')
      : '<button class="btn btn-secondary btn-sm" data-conflict-action="reject" data-conflict-id="' + c.id + '">Reject</button>' +
        '<button class="btn btn-primary btn-sm" data-conflict-action="accept" data-conflict-id="' + c.id + '">Accept</button>';

    return '<div class="conflict-card">' +
      '<div class="conflict-card-header">' +
        '<span class="badge ' + sourceBadgeClass(c.proposedSourceType) + '">' + escapeHtml(sourceLabel(c.proposedSourceType)) + '</span>' +
        '<strong>' + escapeHtml(ip) + '</strong>' +
        '<span class="conflict-card-subnet">' + escapeHtml(subnetLabel) + '</span>' +
      '</div>' +
      '<div class="conflict-table" style="padding:0">' +
        '<table><thead><tr>' +
          '<th class="conflict-field">Field</th>' +
          '<th>Current (Manual)</th>' +
          '<th>Discovered</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>' +
      '<div class="conflict-card-actions">' + actions + '</div>' +
    '</div>';
  }

  function renderAssetConflictCard(c) {
    var existing = c.asset || {};
    var proposed = c.proposedAssetFields || {};
    var isResolved = c.status !== "pending";

    var fields = [
      ["hostname", "Hostname"],
      ["serialNumber", "Serial"],
      ["macAddress", "MAC"],
      ["ipAddress", "IP"],
      ["manufacturer", "Manufacturer"],
      ["model", "Model"],
      ["os", "OS"],
      ["osVersion", "OS Version"],
      ["assignedTo", "Primary User"],
    ];

    var rows = fields.map(function (pair) {
      var key = pair[0], label = pair[1];
      var existingVal = existing[key] || null;
      var proposedVal = proposed[key] || null;
      var differs = existingVal && proposedVal && String(existingVal).toLowerCase() !== String(proposedVal).toLowerCase();
      return '<tr class="' + (differs ? "conflict-changed" : "") + '">' +
        '<td class="conflict-field">' + escapeHtml(label) + '</td>' +
        '<td>' + (existingVal ? escapeHtml(existingVal) : '<span style="color:var(--color-text-tertiary);font-style:italic">—</span>') + '</td>' +
        '<td>' + (proposedVal ? (differs ? '<strong>' + escapeHtml(proposedVal) + '</strong>' : escapeHtml(proposedVal)) : '<span style="color:var(--color-text-tertiary);font-style:italic">—</span>') + '</td>' +
        '</tr>';
    }).join("");

    var badges = [];
    if (proposed.trustType) badges.push('<span class="badge" style="background:rgba(79,195,247,0.1);color:var(--color-accent);border:1px solid rgba(79,195,247,0.2)">' + escapeHtml(proposed.trustType) + '</span>');
    if (proposed.complianceState) badges.push('<span class="badge ' + (proposed.complianceState === "compliant" ? "badge-active" : "badge-warning") + '">' + escapeHtml(proposed.complianceState) + '</span>');

    var actions = isResolved
      ? '<span class="badge badge-' + c.status + '" style="text-transform:capitalize">' + escapeHtml(c.status) + '</span>' +
        (c.resolvedBy ? ' <span style="color:var(--color-text-tertiary);font-size:0.75rem">by ' + escapeHtml(c.resolvedBy) + '</span>' : '')
      : '<button class="btn btn-secondary btn-sm" data-conflict-action="reject" data-conflict-id="' + c.id + '" title="Create a separate asset for this Entra device">Reject (keep separate)</button>' +
        '<button class="btn btn-primary btn-sm" data-conflict-action="accept" data-conflict-id="' + c.id + '" title="Adopt the existing asset as this Entra device">Accept (merge)</button>';

    return '<div class="conflict-card">' +
      '<div class="conflict-card-header">' +
        '<span class="badge" style="background:rgba(79,195,247,0.12);color:var(--color-accent);border:1px solid rgba(79,195,247,0.3)">Entra ID</span>' +
        '<strong>' + escapeHtml(existing.hostname || proposed.hostname || "(asset)") + '</strong>' +
        '<span class="conflict-card-subnet" style="font-family:var(--font-mono);font-size:0.78rem">' + escapeHtml(c.proposedDeviceId || "") + '</span>' +
        (badges.length ? '<span style="margin-left:auto;display:flex;gap:4px">' + badges.join("") + '</span>' : '') +
      '</div>' +
      '<div style="padding:6px 14px;font-size:0.78rem;color:var(--color-text-secondary)">Hostname collision — this Entra device shares a name with an existing asset that has no Entra link. <strong>Accept</strong> to adopt the existing asset; <strong>Reject</strong> to create a separate asset for the Entra device.</div>' +
      '<div class="conflict-table" style="padding:0">' +
        '<table><thead><tr>' +
          '<th class="conflict-field">Field</th>' +
          '<th>Existing Asset</th>' +
          '<th>Entra / Intune</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>' +
      '<div class="conflict-card-actions">' + actions + '</div>' +
    '</div>';
  }
})();

/* ─── PDF Export ──────────────────────────────────────────────────────────── */

(function () {
  var menu = document.getElementById("export-menu");
  var btn  = document.getElementById("btn-export");
  if (!btn || !menu) return;

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    menu.classList.toggle("open");
  });
  document.addEventListener("click", function () { menu.classList.remove("open"); });
  menu.addEventListener("click", function (e) { e.stopPropagation(); });

  menu.querySelectorAll("button[data-export]").forEach(function (item) {
    item.addEventListener("click", async function () {
      menu.classList.remove("open");
      await handleEventExport(this.getAttribute("data-export"), this.getAttribute("data-fmt"));
    });
  });
})();

function _getEventFilters() {
  return {
    level: document.getElementById("filter-level").value || undefined,
    resourceType: document.getElementById("filter-resource").value || undefined,
    action: document.getElementById("filter-action").value.trim() || undefined,
    actor: document.getElementById("filter-actor").value.trim() || undefined,
    message: document.getElementById("filter-message").value.trim() || undefined,
  };
}

async function handleEventExport(mode, fmt) {
  var events, label, ok;

  if (mode === "page") {
    events = _eventsCurrentPage;
    var pageNum = Math.floor(_eventsCurrentOffset / _eventsPageSize) + 1;
    label = "page " + pageNum;
  } else if (mode === "filtered") {
    var total = _eventsCurrentTotal;
    label = total + " filtered events";
    if (total > 100) {
      ok = await showConfirm("This will export " + total + " events. Continue?");
      if (!ok) return;
    }
  } else if (mode === "all") {
    ok = await showConfirm("Export the entire event log? This may take a moment.");
    if (!ok) return;
  }

  await trackedPdfExport("Exporting events " + fmt.toUpperCase(), async function (signal) {
    if (mode === "filtered") {
      var filters = _getEventFilters();
      filters.limit = 10000;
      filters.offset = 0;
      var data = await request("GET", "/events" + toQuery(filters), undefined, signal);
      events = (data.events || []);
      label = events.length + " filtered events";
    } else if (mode === "all") {
      var data = await request("GET", "/events" + toQuery({ limit: 10000, offset: 0 }), undefined, signal);
      events = (data.events || []);
      label = "all " + events.length + " events";
    }
    if (signal.aborted) return;
    if (!events || events.length === 0) { showToast("No events to export", "error"); return; }
    if (fmt === "csv") generateEventCsv(events);
    else generateEventPdf(events, label);
  });
}

function generateEventPdf(events, label) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("PDF library not loaded. Check your internet connection and reload the page.");
  }
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });

  var now = new Date();
  var timestamp = now.toLocaleDateString() + " " + now.toLocaleTimeString();

  doc.setFontSize(16);
  doc.setTextColor(40, 40, 40);
  doc.text((_branding ? _branding.appName : "Polaris") + " \u2014 Event Log", 40, 36);
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text("Generated: " + timestamp + "  |  Scope: " + label + "  |  Count: " + events.length, 40, 52);

  var head = [["Timestamp", "Level", "Action", "Resource", "Message", "User"]];
  var body = events.map(function (ev) {
    var ts = new Date(ev.timestamp);
    var timeStr = ts.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      " " + ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    var resource = ev.resourceType || "-";
    if (ev.resourceName) resource += " (" + ev.resourceName + ")";
    return [
      timeStr,
      (ev.level || "info").toUpperCase(),
      ev.action || "-",
      resource,
      ev.message || "-",
      ev.actor || "-",
    ];
  });

  doc.autoTable({
    startY: 64,
    head: head,
    body: body,
    theme: "grid",
    styles: { fontSize: 7.5, cellPadding: 4, overflow: "linebreak" },
    headStyles: { fillColor: [30, 30, 54], textColor: [230, 230, 230], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 250] },
    margin: { left: 40, right: 40 },
    columnStyles: {
      0: { cellWidth: 100 },
      1: { cellWidth: 42 },
      2: { cellWidth: 90 },
      3: { cellWidth: 80 },
      5: { cellWidth: 60 },
    },
    didDrawPage: function (data) {
      var pageNum = doc.internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(
        "Page " + data.pageNumber + " of " + pageNum + "  |  " + (_branding ? _branding.appName : "Polaris") + " Event Log",
        doc.internal.pageSize.getWidth() / 2,
        doc.internal.pageSize.getHeight() - 20,
        { align: "center" }
      );
    },
  });

  var filename = "polaris-events-" + now.toISOString().slice(0, 10) + ".pdf";
  doc.save(filename);
  showToast("Exported " + events.length + " events to " + filename);
}

function showEventDetail(ev) {
  var changes = ev.details && ev.details.changes ? ev.details.changes : {};
  var keys = Object.keys(changes);
  if (!keys.length) return;

  var rows = keys.map(function (field) {
    var c = changes[field];
    var from = c.from === null || c.from === "" ? '<span style="color:var(--color-text-tertiary);font-style:italic">empty</span>' : escapeHtml(formatDetailValue(c.from));
    var to = c.to === null || c.to === "" ? '<span style="color:var(--color-text-tertiary);font-style:italic">empty</span>' : escapeHtml(formatDetailValue(c.to));
    return '<tr>' +
      '<td style="font-weight:500;white-space:nowrap">' + escapeHtml(formatFieldName(field)) + '</td>' +
      '<td style="color:var(--color-danger)">' + from + '</td>' +
      '<td style="color:var(--color-success)">' + to + '</td>' +
      '</tr>';
  }).join("");

  var ts = new Date(ev.timestamp);
  var timeStr = ts.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " " + ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  var body =
    '<div style="margin-bottom:1rem;font-size:0.85rem;color:var(--color-text-secondary)">' +
      '<span style="font-family:var(--font-mono)">' + escapeHtml(ev.action) + '</span> by <strong>' + escapeHtml(ev.actor || "unknown") + '</strong> at ' + escapeHtml(timeStr) +
    '</div>' +
    '<table style="width:100%">' +
      '<thead><tr>' +
        '<th style="width:120px">Field</th>' +
        '<th>Before</th>' +
        '<th>After</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>';

  var title = "Change Detail" + (ev.resourceName ? " — " + ev.resourceName : "");
  openModal(title, body, '<button class="btn btn-secondary" onclick="closeModal()">Close</button>');
}

function formatFieldName(field) {
  return field.replace(/([A-Z])/g, " $1").replace(/^./, function (c) { return c.toUpperCase(); });
}

function formatDetailValue(val) {
  if (Array.isArray(val)) return val.join(", ") || "none";
  if (val instanceof Object) return JSON.stringify(val);
  return String(val);
}

function generateEventCsv(events) {
  var headers = ["Timestamp", "Level", "Action", "Resource Type", "Resource Name", "Message", "User"];
  var rows = events.map(function (ev) {
    var ts = new Date(ev.timestamp);
    var timeStr = ts.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
      " " + ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return [
      timeStr, (ev.level || "info").toUpperCase(), ev.action || "",
      ev.resourceType || "", ev.resourceName || "", ev.message || "", ev.actor || "",
    ];
  });
  var filename = "polaris-events-" + new Date().toISOString().slice(0, 10) + ".csv";
  downloadCsv(headers, rows, filename);
  showToast("Exported " + events.length + " events to " + filename);
}
