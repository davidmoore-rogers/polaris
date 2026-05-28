// ─── Polaris Agent build card ──────────────────────────────────────────────
//
// Standalone module loaded by integrations.html. Renders the agent build
// inventory + Build button + progress strip + auto-build toggle + server-URL
// stamp + installed-agents summary + bulk Upgrade-all into a container with
// id="agent-build-body". The container is created and mounted by
// integrations.js when the "Polaris Agents" sub-tab is activated.
//
// Three states for the card body:
//   1. No manifest on disk           → "No binaries built yet" + Build button.
//   2. Manifest present, build idle  → inventory grid + Build button + version
//                                      drift hint when agent/VERSION moved.
//   3. Build in flight               → progress strip (poll every 2 s).
//
// On mount, we fetch /inventory AND /build/current in parallel. If a build
// is currently running, we immediately render the progress strip and start
// polling — this rehydrates an operator's view when they switched away
// mid-build.
//
// Dependencies (all globals from app.js or api.js):
//   - api.serverSettings.* (agentInventory / agentBuildCurrent / agentBuildStatus
//     / agentBuildStart / agentBuildCancel / agentPrune / agentServerUrlSet /
//     agentAutoBuildSettingGet / agentAutoBuildSettingSet / agentInstalledSummary
//     / agentUpgradeAll)
//   - escapeHtml, showToast, showConfirm

(function () {
  "use strict";

  var _agentBuildPollTimer = null;

  // Lightweight time formatters local to this module so it stays self-
  // contained — the server-settings.js page has richer formatters (with
  // TZ override) but integrations.html doesn't need that complexity.
  function _formatLocalDateTime(iso) {
    try { return new Date(iso).toLocaleString(); }
    catch (_) { return iso || "—"; }
  }
  function _timeAgo(iso) {
    var ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) ms = 0;
    if (ms < 60000) return Math.floor(ms / 1000) + "s ago";
    if (ms < 3600000) return Math.floor(ms / 60000) + "m ago";
    return Math.floor(ms / 3600000) + "h ago";
  }
  function _humanBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KiB";
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MiB";
    return (n / (1024 * 1024 * 1024)).toFixed(2) + " GiB";
  }
  function _formatElapsed(ms) {
    if (ms < 1000) return ms + " ms";
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + "." + Math.floor((ms % 1000) / 100) + " s";
    var m = Math.floor(s / 60);
    return m + "m " + (s % 60) + "s";
  }

  // Compute the SHA-256 fingerprint of an X.509 cert PEM file's DER bytes,
  // returning "sha256:<lowercase-hex>". Matches what the server's
  // certInfo.getServerCertFingerprint() returns byte-for-byte (server hashes
  // x509.raw — that IS the DER). Used by the Cert pin rotation pane's
  // Generate button so operators can fill the pin input from a local
  // .pem/.crt/.cer without copy-pasting from openssl output.
  //
  // Client-side only: the file is read via FileReader and hashed via
  // window.crypto.subtle.digest. Never uploaded.
  //
  // PEM parsing: handles multi-cert chains by picking the FIRST CERTIFICATE
  // block (the leaf is conventionally first; if your file orders it
  // differently, paste the leaf separately). Ignores PRIVATE KEY blocks if
  // the operator accidentally points at a combined cert+key file.
  function _computeCertPinFromPemFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("Could not read file")); };
      reader.onload = function () {
        try {
          var text = String(reader.result || "");
          var match = text.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
          if (!match) {
            reject(new Error("No CERTIFICATE block found — is this a PEM file?"));
            return;
          }
          var b64 = match[1].replace(/\s+/g, "");
          var binary;
          try { binary = atob(b64); }
          catch (_) { reject(new Error("Cert body is not valid base64")); return; }
          var der = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
          window.crypto.subtle.digest("SHA-256", der).then(function (hashBuf) {
            var bytes = new Uint8Array(hashBuf);
            var hex = "";
            for (var j = 0; j < bytes.length; j++) {
              var h = bytes[j].toString(16);
              hex += h.length === 1 ? "0" + h : h;
            }
            resolve("sha256:" + hex);
          }).catch(function (e) {
            reject(new Error("SHA-256 failed: " + (e && e.message || e)));
          });
        } catch (e) {
          reject(e);
        }
      };
      reader.readAsText(file);
    });
  }

  function initAgentBuildCard() {
    Promise.all([
      api.serverSettings.agentInventory().catch(function () { return null; }),
      api.serverSettings.agentBuildCurrent().catch(function () { return { current: null, queue: [] }; }),
    ]).then(function (results) {
      var inv     = results[0];
      var current = results[1] && results[1].current;
      var queue   = (results[1] && results[1].queue) || [];
      if (current && current.phase !== "complete" && current.phase !== "failed") {
        renderAgentBuildProgress(current, queue);
        startAgentBuildPoll(current.buildId);
      } else {
        renderAgentBuildInventory(inv);
      }
    });
  }

  function renderAgentBuildInventory(inv) {
    var body = document.getElementById("agent-build-body");
    if (!body) return;
    if (!inv) {
      body.innerHTML = '<p class="empty-state" style="padding:1rem 0">Failed to load agent build inventory.</p>';
      return;
    }

    // Go-detection: when Go isn't installed, gate the whole Build pathway
    // with a yellow notice. Inventory grid still renders (operators may
    // have staged binaries from a separate build host).
    var goNotice = "";
    if (!inv.goAvailable) {
      goNotice =
        '<div style="margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:rgba(255,160,40,0.08);' +
          'border-left:3px solid var(--color-warning);border-radius:4px;font-size:0.82rem;color:var(--color-warning)">' +
          '⚠ Go is not installed on this Polaris server. Install Go 1.22+ on the host (see ' +
          '<code>docs/INSTALL.md</code> → "Optional: Polaris Agent") and reload to enable the Build button.' +
        '</div>';
    }

    // Version-drift hint: manifest's currentVersion lags getAgentVersion().
    var drift = "";
    if (inv.manifest && inv.manifest.currentVersion !== inv.agentSourceVersion) {
      drift =
        '<div style="margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:rgba(80,150,255,0.08);' +
          'border-left:3px solid var(--color-accent);border-radius:4px;font-size:0.82rem">' +
          'Agent source has moved to <strong>v' + escapeHtml(inv.agentSourceVersion) + '</strong>; built binaries are still ' +
          '<strong>v' + escapeHtml(inv.manifest.currentVersion) + '</strong>. Click Build to refresh.' +
        '</div>';
    } else if (!inv.manifest) {
      drift =
        '<div style="margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:rgba(80,150,255,0.08);' +
          'border-left:3px solid var(--color-accent);border-radius:4px;font-size:0.82rem">' +
          'No agent binaries built yet. Click Build to produce <strong>v' + escapeHtml(inv.agentSourceVersion) + '</strong>.' +
        '</div>';
    }

    var rows = inv.files.map(function (f) {
      var key  = f.platform + "-" + f.arch;
      var size = f.present && f.sizeBytes != null ? _humanBytes(f.sizeBytes) : "—";
      var when = f.present && f.mtime ? _formatLocalDateTime(f.mtime) : "—";
      var mark = f.present
        ? '<span style="color:var(--color-success)">✓</span>'
        : '<span style="color:var(--color-text-tertiary)">—</span>';
      return '<tr>' +
        '<td style="padding:4px 8px"><code>' + escapeHtml(key) + '</code></td>' +
        '<td style="padding:4px 8px;text-align:right">' + escapeHtml(size) + '</td>' +
        '<td style="padding:4px 8px;font-size:0.78rem;color:var(--color-text-tertiary)">' + escapeHtml(when) + '</td>' +
        '<td style="padding:4px 8px;text-align:center">' + mark + '</td>' +
        '</tr>';
    }).join("");

    var buildBtn = inv.goAvailable
      ? '<button class="btn btn-primary" id="btn-agent-build">Build agent binaries (v' + escapeHtml(inv.agentSourceVersion) + ')</button>'
      : '<button class="btn btn-primary" disabled title="Install Go 1.22+ on the server to enable">Build agent binaries</button>';

    var goVerLine = inv.goAvailable && inv.goVersion
      ? '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.5rem 0 0">Toolchain: ' + escapeHtml(inv.goVersion) + '</p>'
      : '';

    var oldVersions = inv.oldVersions || [];
    var cleanupLine = "";
    if (oldVersions.length > 0) {
      var totalBytes = oldVersions.reduce(function (s, v) { return s + (v.bytes || 0); }, 0);
      cleanupLine =
        '<div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--color-border);' +
            'display:flex;align-items:center;gap:0.5rem;font-size:0.85rem">' +
          '<span style="color:var(--color-text-secondary);flex:1">' +
            oldVersions.length + ' old version' + (oldVersions.length > 1 ? "s" : "") +
            ' on disk (up to ' + escapeHtml(_humanBytes(totalBytes)) + ')' +
          '</span>' +
          '<button class="btn btn-secondary" id="btn-agent-prune" style="padding:4px 12px;font-size:0.8rem">Clean up</button>' +
        '</div>';
    }

    // Server-URL row: input pre-filled with the effective URL the agent
    // would dial right now. The cert-derived default sits underneath as
    // a hint so the operator can see what they'd inherit if they cleared
    // the override.
    var srvUrl = inv.serverUrl || { effective: "", override: null, derived: "" };
    var srvUrlVal = srvUrl.override != null ? srvUrl.override : (srvUrl.derived || srvUrl.effective || "");
    var srvUrlHint = srvUrl.override != null
      ? 'Override active. Cert-derived default would be: <code>' + escapeHtml(srvUrl.derived || "—") + '</code>'
      : 'Derived from the HTTPS certificate. Edit to override.';
    var serverUrlRow =
      '<div style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--color-border);font-size:0.85rem">' +
        '<label for="agent-server-url-input" style="display:block;margin-bottom:0.3rem;color:var(--color-text-secondary)">' +
          'Server URL stamped into agent.conf' +
          (srvUrl.override != null
            ? ' <span style="font-size:0.72rem;color:var(--color-accent);font-weight:600;margin-left:0.4rem">OVERRIDE</span>'
            : "") +
        '</label>' +
        '<div style="display:flex;gap:0.5rem;align-items:center">' +
          '<input type="text" id="agent-server-url-input" value="' + escapeHtml(srvUrlVal) + '" ' +
            'placeholder="' + escapeHtml(srvUrl.derived || "https://your-host:443") + '" ' +
            'style="flex:1;padding:5px 8px;font-family:var(--font-mono, monospace);font-size:0.85rem">' +
          '<button class="btn btn-secondary" id="btn-agent-server-url-save" style="padding:4px 14px;font-size:0.8rem">Save</button>' +
        '</div>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.3rem 0 0">' + srvUrlHint + '</p>' +
      '</div>';

    var autoBuildRow =
      '<div style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--color-border);' +
          'display:flex;align-items:center;gap:8px;font-size:0.85rem">' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none">' +
          '<input type="checkbox" id="agent-auto-build-toggle" style="width:15px;height:15px;flex-shrink:0">' +
          '<span>Auto-build agent binaries when <code>agent/VERSION</code> changes</span>' +
        '</label>' +
      '</div>' +
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.3rem 0 0 23px">' +
        'Fires once on server boot when the on-disk manifest lags the agent source. Disable for strict supply-chain controls.' +
      '</p>';

    // Cert-pin rotation slot. Populated async by renderAgentCertPinRotation()
    // after the main inventory renders — it queries the fleet-wide pin summary
    // separately so a slow query doesn't block the rest of the card.
    var certPinRotationSlot =
      '<div id="agent-cert-pin-rotation" style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--color-border);font-size:0.85rem">' +
        '<div style="color:var(--color-text-secondary);margin-bottom:0.3rem">Cert pin rotation</div>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 0.5rem 0">Loading pin set...</p>' +
      '</div>';

    var installedSummarySlot = '<div id="agent-installed-summary"></div>';

    body.innerHTML =
      goNotice +
      drift +
      '<table style="width:100%;border-collapse:collapse;margin-bottom:0.75rem;font-size:0.85rem">' +
        '<thead><tr style="border-bottom:1px solid var(--color-border)">' +
          '<th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--color-text-secondary)">Platform</th>' +
          '<th style="padding:4px 8px;text-align:right;font-weight:600;color:var(--color-text-secondary)">Size</th>' +
          '<th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--color-text-secondary)">Built</th>' +
          '<th style="padding:4px 8px;text-align:center;font-weight:600;color:var(--color-text-secondary)">Present</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '<div>' + buildBtn + '</div>' +
      goVerLine +
      installedSummarySlot +
      cleanupLine +
      serverUrlRow +
      autoBuildRow +
      certPinRotationSlot;

    var btn = document.getElementById("btn-agent-build");
    if (btn) btn.addEventListener("click", onAgentBuildClick);
    var pruneBtn = document.getElementById("btn-agent-prune");
    if (pruneBtn) pruneBtn.addEventListener("click", onAgentPruneClick);

    var srvSaveBtn = document.getElementById("btn-agent-server-url-save");
    var srvInput   = document.getElementById("agent-server-url-input");
    if (srvSaveBtn && srvInput) {
      srvSaveBtn.addEventListener("click", function () {
        var raw = (srvInput.value || "").trim();
        var sendVal = raw === "" ? "" : raw;
        srvSaveBtn.disabled = true;
        api.serverSettings.agentServerUrlSet(sendVal).then(function () {
          showToast(sendVal ? "Agent server URL updated" : "Agent server URL override cleared", "success");
          api.serverSettings.agentInventory().then(renderAgentBuildInventory);
        }).catch(function (err) {
          showToast("Failed: " + err.message, "error");
          srvSaveBtn.disabled = false;
        });
      });
    }

    var autoToggle = document.getElementById("agent-auto-build-toggle");
    if (autoToggle) {
      api.serverSettings.agentAutoBuildSettingGet().then(function (s) {
        autoToggle.checked = s.enabled !== false;
      }).catch(function () {
        autoToggle.checked = true;
      });
      autoToggle.addEventListener("change", function () {
        api.serverSettings.agentAutoBuildSettingSet(autoToggle.checked).catch(function (err) {
          showToast("Failed to save setting: " + err.message, "error");
          autoToggle.checked = !autoToggle.checked;
        });
      });
    }

    // Installed-summary line + Upgrade-all button. Loaded async so the
    // rest of the card paints first; on failure the slot stays empty.
    api.serverSettings.agentInstalledSummary().then(function (s) {
      var slot = document.getElementById("agent-installed-summary");
      if (!slot) return;
      if (!s.totalActive) return;
      if (!s.outOfDate) {
        slot.innerHTML =
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.5rem 0 0">' +
            s.totalActive + ' installed agent' + (s.totalActive > 1 ? "s" : "") +
            ' running v' + escapeHtml(s.currentVersion || "?") + ' (current).' +
          '</p>';
        return;
      }
      slot.innerHTML =
        '<div style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--color-border);' +
            'display:flex;align-items:center;gap:0.5rem;font-size:0.85rem">' +
          '<span style="color:var(--color-text-secondary);flex:1">' +
            s.outOfDate + ' of ' + s.totalActive + ' installed agent' + (s.totalActive > 1 ? "s" : "") +
            ' running an older version' +
            (s.currentVersion ? ' (current: v' + escapeHtml(s.currentVersion) + ')' : "") + '.' +
          '</span>' +
          '<button class="btn btn-secondary" id="btn-agent-upgrade-all" style="padding:4px 12px;font-size:0.8rem">Upgrade all</button>' +
        '</div>';
      var btn = document.getElementById("btn-agent-upgrade-all");
      if (btn) btn.addEventListener("click", function () {
        showConfirm(
          "Push the new agent binary to all " + s.outOfDate + " out-of-date host" + (s.outOfDate > 1 ? "s" : "") + "?\n\n" +
          "Each host briefly bounces its agent service while the binary is replaced. " +
          "Bearers and cert pins are preserved — no re-enrollment required.",
        ).then(function (ok) {
          if (!ok) return;
          api.serverSettings.agentUpgradeAll().then(function (r) {
            showToast("Queued " + r.queued + " of " + r.eligible + " upgrade(s)", "success");
            api.serverSettings.agentInventory().then(renderAgentBuildInventory);
          }).catch(function (err) {
            showToast("Upgrade-all failed: " + err.message, "error");
          });
        });
      });
    }).catch(function () { /* leave the slot empty */ });

    // Cert pin rotation pane. Loaded async; failure leaves the slot showing
    // a one-line error so operators know to refresh.
    renderAgentCertPinRotation();
  }

  // Renders the Cert pin rotation pane in the slot reserved by
  // renderAgentBuildInventory. Fetches /agents/cert-pins/summary, builds one
  // row per distinct pin with canonical/staged counts and a Retire button,
  // plus a "Stage a new pin" input + button. Phase 2 dual-pin / [[prod-cert-rotation]].
  function renderAgentCertPinRotation() {
    var slot = document.getElementById("agent-cert-pin-rotation");
    if (!slot) return;
    api.serverSettings.agentCertPinsSummary().then(function (s) {
      var pins = s.pins || [];
      var totalActive = s.totalActiveAgents || 0;
      var rowsHtml = "";
      if (totalActive === 0) {
        rowsHtml =
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.3rem 0 0.5rem">' +
            'No active agents — staged or retired pins have nothing to apply against until an agent enrolls.' +
          '</p>';
      } else if (pins.length === 0) {
        rowsHtml =
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.3rem 0 0.5rem">' +
            'No pins observed across the active fleet — unexpected; check journalctl on the web role.' +
          '</p>';
      } else {
        rowsHtml =
          '<table style="width:100%;border-collapse:collapse;margin:0.3rem 0 0.5rem;font-size:0.8rem">' +
            '<thead><tr style="border-bottom:1px solid var(--color-border)">' +
              '<th style="padding:3px 6px;text-align:left;font-weight:600;color:var(--color-text-secondary)">Pin (SHA-256)</th>' +
              '<th style="padding:3px 6px;text-align:right;font-weight:600;color:var(--color-text-secondary)">Canonical</th>' +
              '<th style="padding:3px 6px;text-align:right;font-weight:600;color:var(--color-text-secondary)">Staged</th>' +
              '<th style="padding:3px 6px;text-align:right;font-weight:600;color:var(--color-text-secondary)"></th>' +
            '</tr></thead><tbody>' +
            pins.map(function (p) {
              // Truncate the pin display — full sha256 is 71 chars including
              // the "sha256:" prefix, too wide for the card.
              var disp = (p.pin || "").slice(0, 19) + "..." + (p.pin || "").slice(-6);
              return '<tr style="border-bottom:1px solid var(--color-border-light, var(--color-border))">' +
                '<td style="padding:3px 6px;font-family:var(--font-mono, monospace);font-size:0.75rem" title="' + escapeHtml(p.pin) + '">' +
                  escapeHtml(disp) +
                '</td>' +
                '<td style="padding:3px 6px;text-align:right">' + (p.canonical || 0) + '</td>' +
                '<td style="padding:3px 6px;text-align:right">' + (p.staged || 0) + '</td>' +
                '<td style="padding:3px 6px;text-align:right">' +
                  '<button class="btn btn-sm btn-secondary" data-retire-pin="' + escapeHtml(p.pin) + '" style="padding:2px 8px;font-size:0.75rem">Retire</button>' +
                '</td>' +
              '</tr>';
            }).join("") +
          '</tbody></table>';
      }

      slot.innerHTML =
        '<div style="color:var(--color-text-secondary);margin-bottom:0.3rem">Cert pin rotation</div>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 0.5rem 0">' +
          'Stage a new pin BEFORE rotating the server cert; agents trust both old and new during the window. ' +
          'After every agent has heartbeated post-rotation, retire the old pin. ' +
          'Total active agents: <strong>' + totalActive + '</strong>' +
        '</p>' +
        rowsHtml +
        '<div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.3rem">' +
          '<input type="text" id="agent-cert-pin-stage-input" ' +
            'placeholder="sha256:abc123...64hex" ' +
            'style="flex:1;padding:5px 8px;font-family:var(--font-mono, monospace);font-size:0.8rem">' +
          // Hidden file input — triggered by the "from file" link below.
          // Client-side SHA-256 via window.crypto.subtle; the file never
          // leaves the browser.
          '<input type="file" id="agent-cert-pin-file-input" accept=".pem,.crt,.cer" style="display:none">' +
          '<button class="btn btn-secondary" id="btn-agent-cert-pin-generate" style="padding:4px 14px;font-size:0.8rem" ' +
            'title="Fill with the SHA-256 of the cert Polaris is currently serving">Generate</button>' +
          '<button class="btn btn-secondary" id="btn-agent-cert-pin-stage" style="padding:4px 14px;font-size:0.8rem">Stage</button>' +
        '</div>' +
        '<p style="font-size:0.75rem;color:var(--color-text-tertiary);margin:0.3rem 0 0">' +
          'Generate fills the SHA-256 of the cert Polaris is currently serving. ' +
          'To stage a DIFFERENT cert\'s pin (typical pre-rotation flow), ' +
          '<a href="#" id="link-agent-cert-pin-from-file" style="color:var(--color-accent);text-decoration:underline;cursor:pointer">compute it from a local .pem file</a> ' +
          '(client-side; the file is not uploaded). ' +
          'Each agent re-saves agent.conf + restarts via systemd on next /config tick when the pin set changes.' +
        '</p>';

      var stageBtn = document.getElementById("btn-agent-cert-pin-stage");
      var stageIn  = document.getElementById("agent-cert-pin-stage-input");
      var genBtn   = document.getElementById("btn-agent-cert-pin-generate");
      var fileIn   = document.getElementById("agent-cert-pin-file-input");
      if (stageBtn && stageIn) {
        stageBtn.addEventListener("click", function () {
          var pin = (stageIn.value || "").trim().toLowerCase();
          if (!/^sha256:[0-9a-f]{64}$/.test(pin)) {
            showToast("Pin must be sha256:<64 hex chars>", "error");
            return;
          }
          stageBtn.disabled = true;
          api.serverSettings.agentCertPinBulkAdd(pin).then(function (r) {
            showToast("Staged pin on " + r.added + " agent(s) (" + r.alreadyPresent + " already had it)", "success");
            stageIn.value = "";
            renderAgentCertPinRotation();
          }).catch(function (err) {
            showToast("Stage failed: " + err.message, "error");
          }).finally(function () {
            stageBtn.disabled = false;
          });
        });
      }
      // Generate → one-click: fetch the fingerprint of the cert Polaris is
      // currently serving (Node-HTTPS: in-memory PEM; proxy mode: file on
      // disk) via GET /server-settings/https and drop it into the input.
      // This is the operator-most-common path — staging the OLD pin before
      // rotating, or staging a pin to re-pin after an out-of-order rotation.
      if (genBtn && stageIn) {
        genBtn.addEventListener("click", function () {
          genBtn.disabled = true;
          api.serverSettings.getHttps().then(function (h) {
            if (!h || !h.fingerprint) {
              showToast("No cert fingerprint available — is HTTPS running?", "error");
              return;
            }
            stageIn.value = h.fingerprint;
            showToast("Filled with current cert pin", "success");
          }).catch(function (err) {
            showToast("Generate failed: " + err.message, "error");
          }).finally(function () {
            genBtn.disabled = false;
          });
        });
      }
      // "Compute from .pem file" link → file picker → client-side SHA-256.
      // For staging a DIFFERENT cert's pin (typical pre-rotation flow when
      // the new cert hasn't been activated yet). File never leaves the browser.
      var fromFileLink = document.getElementById("link-agent-cert-pin-from-file");
      if (fromFileLink && fileIn && stageIn) {
        fromFileLink.addEventListener("click", function (e) {
          e.preventDefault();
          fileIn.click();
        });
        fileIn.addEventListener("change", function () {
          var f = fileIn.files && fileIn.files[0];
          if (!f) return;
          _computeCertPinFromPemFile(f).then(function (pin) {
            stageIn.value = pin;
            showToast("Computed pin: " + pin.slice(0, 19) + "..." + pin.slice(-6), "success");
          }).catch(function (err) {
            showToast("Could not parse cert: " + err.message, "error");
          }).finally(function () {
            // Clear so picking the same file twice still fires change.
            fileIn.value = "";
          });
        });
      }

      var retireBtns = slot.querySelectorAll("button[data-retire-pin]");
      retireBtns.forEach(function (btn) {
        btn.addEventListener("click", function () {
          var pin = btn.getAttribute("data-retire-pin");
          if (!pin) return;
          var disp = pin.slice(0, 19) + "..." + pin.slice(-6);
          if (!confirm("Retire pin " + disp + " from every active agent? Skipped on any agent where this would be the last pin.")) {
            return;
          }
          btn.disabled = true;
          api.serverSettings.agentCertPinBulkRemove(pin).then(function (r) {
            var msg = "Retired pin from " + r.removed + " agent(s)";
            if (r.lastPinSkipped > 0) msg += " (" + r.lastPinSkipped + " skipped: would have been last pin)";
            showToast(msg, "success");
            renderAgentCertPinRotation();
          }).catch(function (err) {
            showToast("Retire failed: " + err.message, "error");
            btn.disabled = false;
          });
        });
      });
    }).catch(function (err) {
      slot.innerHTML =
        '<div style="color:var(--color-text-secondary);margin-bottom:0.3rem">Cert pin rotation</div>' +
        '<p style="font-size:0.78rem;color:var(--color-warning);margin:0.3rem 0">' +
          'Failed to load: ' + escapeHtml(err.message) +
        '</p>';
    });
  }

  function onAgentPruneClick() {
    api.serverSettings.agentPrune().then(function (r) {
      var n = (r.removed || []).length;
      if (n === 0) {
        showToast("Nothing to clean up — old versions are in use or within the keep-last-N window", "info");
      } else {
        var bytes = r.removed.reduce(function (s, e) { return s + (e.bytes || 0); }, 0);
        showToast("Removed " + n + " old version" + (n > 1 ? "s" : "") + " (" + _humanBytes(bytes) + " freed)", "success");
      }
      api.serverSettings.agentInventory().then(renderAgentBuildInventory);
    }).catch(function (err) {
      showToast("Clean up failed: " + err.message, "error");
    });
  }

  function onAgentBuildClick() {
    api.serverSettings.agentBuildStart().then(function (r) {
      var phase = r.queuePosition === 0 ? "preparing" : "queued";
      renderAgentBuildProgress({
        buildId:   r.buildId,
        version:   r.version,
        phase:     phase,
        steps:     [],
        queuedAt:  new Date().toISOString(),
        startedAt: r.queuePosition === 0 ? new Date().toISOString() : null,
      }, []);
      if (r.queuePosition > 0) {
        showToast("Build queued (position " + r.queuePosition + ")", "info");
      }
      startAgentBuildPoll(r.buildId);
    }).catch(function (err) {
      showToast("Build failed to start: " + err.message, "error");
    });
  }

  function startAgentBuildPoll(buildId) {
    if (_agentBuildPollTimer) clearTimeout(_agentBuildPollTimer);
    var tick = function () {
      Promise.all([
        api.serverSettings.agentBuildStatus(buildId),
        api.serverSettings.agentBuildCurrent().catch(function () { return { current: null, queue: [] }; }),
      ]).then(function (results) {
        var state   = results[0];
        var current = results[1] && results[1].current;
        var queue   = (results[1] && results[1].queue) || [];
        var primary = (state.phase === "queued" && current) ? current : state;
        var queueWithoutPrimary = queue.filter(function (q) { return q.buildId !== primary.buildId; });
        renderAgentBuildProgress(primary, queueWithoutPrimary);
        if (state.phase === "complete" || state.phase === "failed") {
          _agentBuildPollTimer = null;
          api.serverSettings.agentInventory().then(function (inv) {
            renderAgentBuildInventory(inv);
            if (state.phase === "complete") {
              showToast("Built agent binaries v" + state.version, "success");
            } else {
              showToast("Build failed: " + (state.error || "unknown error"), "error");
            }
          });
          return;
        }
        _agentBuildPollTimer = setTimeout(tick, 2000);
      }).catch(function () {
        _agentBuildPollTimer = setTimeout(tick, 5000);
      });
    };
    _agentBuildPollTimer = setTimeout(tick, 200);
  }

  function renderAgentBuildProgress(state, queue) {
    var body = document.getElementById("agent-build-body");
    if (!body) return;

    var elapsedAnchor = state.startedAt || state.queuedAt;
    var elapsedMs = elapsedAnchor ? Date.now() - new Date(elapsedAnchor).getTime() : 0;
    var elapsedTxt = _formatElapsed(elapsedMs);

    var stepsHtml = (state.steps || []).map(function (s) {
      var icon, color;
      if (s.status === "success")      { icon = "✓"; color = "var(--color-success)"; }
      else if (s.status === "failed")  { icon = "✗"; color = "var(--color-danger)"; }
      else if (s.status === "running") { icon = "▸"; color = "var(--color-accent)"; }
      else                              { icon = "○"; color = "var(--color-text-tertiary)"; }
      var dur = s.elapsedMs != null ? _formatElapsed(s.elapsedMs) : (s.status === "running" ? "running" : "pending");
      return '<tr>' +
        '<td style="padding:3px 8px;color:' + color + '">' + icon + '</td>' +
        '<td style="padding:3px 8px"><code>' + escapeHtml(s.platform) + '-' + escapeHtml(s.arch) + '</code></td>' +
        '<td style="padding:3px 8px;text-align:right;font-size:0.78rem;color:var(--color-text-tertiary)">' + escapeHtml(dur) + '</td>' +
        (s.error
          ? '<td style="padding:3px 8px;font-family:monospace;font-size:0.75rem;color:var(--color-danger)">' + escapeHtml(s.error) + '</td>'
          : '<td></td>') +
        '</tr>';
    }).join("");

    var isFinished  = state.phase === "complete" || state.phase === "failed" || state.phase === "cancelled";
    var cancelBtn   = isFinished
      ? ""
      : ' <button class="btn-icon agent-build-cancel" data-build-id="' + escapeHtml(state.buildId) +
          '" title="Cancel" style="margin-left:0.5rem;padding:1px 8px;font-size:0.75rem">×</button>';

    var label;
    if (state.phase === "complete") {
      label = '<strong style="color:var(--color-success)">Built v' + escapeHtml(state.version) + '</strong>';
    } else if (state.phase === "failed") {
      label = '<strong style="color:var(--color-danger)">Build failed</strong>';
    } else if (state.phase === "cancelled") {
      label = '<strong style="color:var(--color-warning)">Build cancelled</strong>';
    } else if (state.phase === "queued") {
      label = '<strong>Queued: v' + escapeHtml(state.version) + '</strong> · waiting · ' + escapeHtml(elapsedTxt) + cancelBtn;
    } else {
      label = '<strong>Building agent binaries v' + escapeHtml(state.version) + '</strong> · ' + escapeHtml(elapsedTxt) + ' elapsed' + cancelBtn;
    }

    var queueHtml = "";
    if (queue && queue.length > 0) {
      queueHtml =
        '<div style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--color-border)">' +
          '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:0.3rem">Queued (' + queue.length + ')</div>' +
          queue.map(function (q) {
            return '<div style="font-size:0.78rem;color:var(--color-text-tertiary);padding:2px 0;display:flex;align-items:center;gap:6px">' +
              '<span style="flex:1">• v' + escapeHtml(q.version) + ' — queued by ' + escapeHtml(q.actor) +
                (q.queuedAt ? ' (' + escapeHtml(_timeAgo(q.queuedAt)) + ')' : "") +
              '</span>' +
              '<button class="btn-icon agent-build-cancel" data-build-id="' + escapeHtml(q.buildId) +
                '" title="Cancel" style="padding:1px 8px;font-size:0.75rem">×</button>' +
            '</div>';
          }).join("") +
        '</div>';
    }

    body.innerHTML =
      '<div style="margin-bottom:0.5rem">' + label + '</div>' +
      (stepsHtml
        ? '<table style="width:100%;border-collapse:collapse;font-size:0.85rem"><tbody>' + stepsHtml + '</tbody></table>'
        : "") +
      (state.error
        ? '<div style="margin-top:0.5rem;padding:0.5rem 0.75rem;background:rgba(255,80,80,0.08);' +
            'border-left:3px solid var(--color-danger);border-radius:4px;font-family:monospace;font-size:0.78rem;' +
            'color:var(--color-danger);white-space:pre-wrap;word-break:break-word">' + escapeHtml(state.error) + '</div>'
        : "") +
      queueHtml;

    body.querySelectorAll(".agent-build-cancel").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        var id = btn.getAttribute("data-build-id");
        if (!id) return;
        showConfirm("Cancel this build? Any partial binaries will remain on disk but unused.").then(function (ok) {
          if (!ok) return;
          api.serverSettings.agentBuildCancel(id).then(function () {
            showToast("Build cancelled", "info");
            api.serverSettings.agentBuildCurrent().then(function (snap) {
              var cur = snap && snap.current;
              if (cur && cur.phase !== "complete" && cur.phase !== "failed" && cur.phase !== "cancelled") {
                renderAgentBuildProgress(cur, (snap.queue || []).filter(function (q) { return q.buildId !== cur.buildId; }));
              } else {
                api.serverSettings.agentInventory().then(renderAgentBuildInventory);
              }
            });
          }).catch(function (err) {
            showToast("Cancel failed: " + err.message, "error");
          });
        });
      });
    });
  }

  // Public surface — integrations.js calls initAgentBuildCard() when the
  // Polaris Agents sub-tab is activated. The card body lives at
  // #agent-build-body which the tab markup creates.
  window.PolarisAgentBuild = {
    init: initAgentBuildCard,
  };
})();
