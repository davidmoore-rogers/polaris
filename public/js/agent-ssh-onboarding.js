// ─── SSH deployment card (Windows + Linux) ─────────────────────────────────
//
// Standalone module loaded by integrations.html, rendering into
// #agent-ssh-onboarding-body on the "Polaris Agents" sub-tab. Mounted lazily
// by integrations.js alongside the discovery-rules and agent-build cards.
//
// What the card does, in the operator's order of operations:
//   1. Generate the deployment keypair (Polaris keeps the private half sealed
//      and never shows it; only the public half + fingerprint come back).
//   2. Per platform, configure which account Polaris connects as and whether
//      the script should create it. Windows and Linux share the keypair but
//      get their own managed credential, because a Credential holds one
//      username and a Windows DOMAIN\user is meaningless on Linux.
//   3. Download the onboarding script — and the detection script that pairs
//      with it for self-healing fleet rollout.
//
// Deliberately delivery-neutral: nothing in the generated scripts is
// Intune- or Ansible-specific, so the card presents the delivery vehicles as
// equal options rather than assuming one.
//
// Dependencies (globals from api.js / app.js):
//   - api.serverSettings.agentWindowsSsh{Get,Save,Generate,Script}
//   - escapeHtml, showToast, showConfirm

(function () {
  "use strict";

  var _state = null;
  // Cache scripts per (platform, kind) so Copy/Download don't re-hit the
  // server and the preview toggles instantly.
  var _scripts = {};
  var _activeKind = "remediation";
  var _platform = "windows";

  function scriptCacheKey(platform, kind) { return platform + ":" + kind; }
  function acct() { return (_state && _state[_platform]) || { accountMode: "existing", username: "" }; }

  function el(id) { return document.getElementById(id); }

  function cardBodyHtml(s) {
    var hasKey = !!(s && s.publicKey);
    return (
      keypairPaneHtml(s, hasKey) +
      platformTabsHtml() +
      configPaneHtml(s, hasKey) +
      scriptPaneHtml(hasKey) +
      publishPaneHtml(hasKey) +
      hostKeysPaneHtml()
    );
  }

  // ─── Publish pane ────────────────────────────────────────────────────────
  //
  // Pushes the generated scripts to a delivery vehicle instead of the operator
  // downloading and uploading them. Each vehicle is opt-in on its own
  // integration; a target that hasn't opted in is shown DISABLED with a pointer
  // to the checkbox rather than hidden, or the feature is undiscoverable.
  function publishPaneHtml(hasKey) {
    // Intune deploys scripts to Windows only; the Linux half is Arc's job.
    if (_platform !== "windows") return "";
    return (
      '<div style="padding-top:1rem;border-top:1px solid var(--color-border);margin-top:1rem">' +
        '<h5 style="margin:0 0 0.5rem 0">4. Publish to Intune <span style="font-weight:normal;color:var(--color-text-tertiary)">(optional)</span></h5>' +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin:0 0 0.75rem 0">' +
          'Uploads the pair above as an Intune <strong>Remediation</strong>, so you skip the download-and-paste step. ' +
          'Re-publishing updates the same policy rather than creating a second one. ' +
          '<strong>Polaris never assigns it</strong> &mdash; it arrives targeting nothing, and you choose the device ' +
          'groups in Intune after reading the script.' +
        '</p>' +
        (hasKey
          ? '<div id="wssh-publish-targets"><p class="empty-state" style="padding:0.5rem 0;margin:0">Loading&hellip;</p></div>'
          : '<p class="empty-state" style="padding:0.5rem 0;margin:0">Generate a keypair first.</p>') +
      '</div>'
    );
  }

  function renderPublishTargets(targets) {
    var host = el("wssh-publish-targets");
    if (!host) return;
    if (!targets || !targets.length) {
      host.innerHTML = '<p class="empty-state" style="padding:0.5rem 0;margin:0">' +
        'No Entra ID integration configured. Add one on the Integrations tab to publish to Intune.</p>';
      return;
    }
    host.innerHTML = targets.map(function (t) {
      return '<div style="display:flex;align-items:center;gap:8px;padding:0.4rem 0">' +
        '<span style="flex:1">' + escapeHtml(t.integrationName) + '</span>' +
        (t.enabled
          ? '<button class="btn btn-sm btn-primary" data-wssh-publish="' + escapeHtml(t.integrationId) +
            '" data-wssh-publish-name="' + escapeHtml(t.integrationName) + '">Publish to Intune</button>'
          : '<span class="hint" style="margin:0">Not enabled &mdash; turn on <em>Publish deployment scripts to Intune</em> ' +
            'on this integration\'s Script Publishing tab.</span>') +
      '</div>';
    }).join("");

    Array.prototype.forEach.call(host.querySelectorAll("[data-wssh-publish]"), function (btn) {
      btn.addEventListener("click", function () { onPublishIntune(btn); });
    });
  }

  function onPublishIntune(btn) {
    var id = btn.getAttribute("data-wssh-publish");
    var name = btn.getAttribute("data-wssh-publish-name");
    showConfirm(
      "Publish the Windows onboarding scripts to Intune via \"" + name + "\"?\n\n" +
      "This creates (or updates) a Remediation in your tenant. It will NOT be assigned to any device " +
      "group — you assign it in the Intune console after reviewing the script.\n\n" +
      "The script grants administrative SSH access to every device it eventually runs on."
    ).then(function (ok) {
      if (!ok) return;
      btn.disabled = true;
      api.serverSettings.scriptPublishIntune(id)
        .then(function (r) {
          showToast(
            (r.created ? "Created" : "Updated") + " Intune Remediation \"" + r.displayName + "\" (unassigned)",
            "success",
          );
        })
        .catch(function (err) {
          showToast((err && err.message) ? err.message : "Publish failed", "error");
        })
        .finally(function () { btn.disabled = false; });
    });
  }

  function loadPublishTargets() {
    if (_platform !== "windows" || !(_state && _state.publicKey)) return;
    api.serverSettings.scriptPublishTargets()
      .then(function (r) { renderPublishTargets(r && r.intune); })
      .catch(function (err) {
        var host = el("wssh-publish-targets");
        if (host) {
          host.innerHTML = '<p class="empty-state" style="padding:0.5rem 0;margin:0">Could not load: ' +
            escapeHtml((err && err.message) || "unknown error") + "</p>";
        }
      });
  }

  // Pinned SSH host keys. Lives here rather than on the credential form
  // because the pins are fleet-wide, not per-credential — and because this is
  // where an operator lands when an install starts failing after a rebuild.
  function hostKeysPaneHtml() {
    return (
      '<div style="padding-top:1rem;border-top:1px solid var(--color-border);margin-top:1rem">' +
        '<h5 style="margin:0 0 0.5rem 0">Pinned SSH host keys</h5>' +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin:0 0 0.75rem 0">' +
          'When a credential has <em>Verify the server\'s host key</em> enabled, Polaris records the key each host ' +
          'presents on first connection and refuses later connections if it changes. If a host was legitimately ' +
          'rebuilt or re-keyed, delete its pin here &mdash; the next connection will trust and re-pin whatever answers.' +
        '</p>' +
        '<div id="wssh-hostkeys"><p class="empty-state" style="padding:0.5rem 0;margin:0">Loading&hellip;</p></div>' +
      '</div>'
    );
  }

  function renderHostKeys(rows) {
    var host = el("wssh-hostkeys");
    if (!host) return;
    if (!rows || !rows.length) {
      host.innerHTML = '<p class="empty-state" style="padding:0.5rem 0;margin:0">No host keys pinned yet. ' +
        'Pins appear the first time Polaris connects to a host using a credential with host-key verification on.</p>';
      return;
    }
    var body = rows.map(function (r) {
      return '<tr>' +
        '<td class="mono">' + escapeHtml(r.host) + (r.port !== 22 ? ":" + escapeHtml(String(r.port)) : "") + '</td>' +
        '<td>' + escapeHtml(r.keyType || "—") + '</td>' +
        '<td class="mono" style="font-size:0.78rem">' + escapeHtml(r.fingerprint) + '</td>' +
        '<td>' + escapeHtml(r.firstSeen ? new Date(r.firstSeen).toLocaleDateString() : "—") + '</td>' +
        '<td style="text-align:right"><button class="btn btn-sm btn-secondary" data-wssh-delpin="' + escapeHtml(r.id) +
          '" data-wssh-pinhost="' + escapeHtml(r.host) + '">Delete</button></td>' +
      '</tr>';
    }).join("");
    host.innerHTML =
      '<table class="data-table"><thead><tr>' +
        '<th>Host</th><th>Type</th><th>Fingerprint</th><th>First seen</th><th></th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>';

    Array.prototype.forEach.call(host.querySelectorAll("[data-wssh-delpin]"), function (btn) {
      btn.addEventListener("click", function () { onDeletePin(btn); });
    });
  }

  function onDeletePin(btn) {
    var id = btn.getAttribute("data-wssh-delpin");
    var hostName = btn.getAttribute("data-wssh-pinhost");
    showConfirm(
      "Delete the pinned host key for " + hostName + "?\n\n" +
      "The next connection to this host will trust and pin whatever answers. Only do this if you know the host " +
      "was legitimately rebuilt or re-keyed — otherwise you would be accepting an impersonator."
    ).then(function (ok) {
      if (!ok) return;
      btn.disabled = true;
      api.serverSettings.sshHostKeyDelete(id)
        .then(function () { showToast("Pin deleted", "success"); loadHostKeys(); })
        .catch(function (err) {
          showToast((err && err.message) ? err.message : "Could not delete the pin", "error");
          btn.disabled = false;
        });
    });
  }

  function loadHostKeys() {
    api.serverSettings.sshHostKeysList()
      .then(function (r) { renderHostKeys(r && r.hostKeys); })
      .catch(function (err) {
        var host = el("wssh-hostkeys");
        if (host) {
          host.innerHTML = '<p class="empty-state" style="padding:0.5rem 0;margin:0">Could not load pinned keys: ' +
            escapeHtml((err && err.message) || "unknown error") + "</p>";
        }
      });
  }

  function keypairPaneHtml(s, hasKey) {
    var rows = "";
    if (hasKey) {
      rows =
        '<div class="detail-row"><span class="detail-label">Fingerprint</span>' +
          '<span class="detail-value mono">' + escapeHtml(s.fingerprint || "—") + '</span></div>' +
        '<div class="detail-row"><span class="detail-label">Credentials</span>' +
          '<span class="detail-value">' +
            escapeHtml((s.credentialNames && s.credentialNames.windows) || "—") + '<br>' +
            escapeHtml((s.credentialNames && s.credentialNames.linux) || "—") +
          '</span></div>' +
        '<div class="detail-row"><span class="detail-label">Generated</span>' +
          '<span class="detail-value">' + escapeHtml(s.generatedAt ? new Date(s.generatedAt).toLocaleString() : "—") + '</span></div>' +
        '<div class="form-group" style="margin-top:0.75rem">' +
          '<label>Public key <span style="font-weight:normal;color:var(--color-text-tertiary)">(what the scripts install on each host)</span></label>' +
          '<textarea readonly rows="2" class="mono" id="wssh-pubkey" style="width:100%">' + escapeHtml(s.publicKey) + '</textarea>' +
        '</div>';
    }

    return (
      '<div style="padding-bottom:1rem;border-bottom:1px solid var(--color-border);margin-bottom:1rem">' +
        '<h5 style="margin:0 0 0.5rem 0">1. Deployment keypair</h5>' +
        (hasKey
          ? rows
          : '<p class="empty-state" style="padding:0.5rem 0;margin:0">No keypair yet. Generate one to get started — Polaris keeps the private half and never displays it.</p>') +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:0.75rem">' +
          '<button class="btn ' + (hasKey ? "btn-secondary" : "btn-primary") + '" id="wssh-generate">' +
            (hasKey ? "Regenerate keypair" : "Generate keypair") + '</button>' +
        '</div>' +
        (hasKey
          ? '<p class="hint" style="color:var(--color-warning,#d98c00);margin-top:0.5rem">Regenerating invalidates the current key everywhere. Every endpoint must re-run the onboarding script before Polaris can reach it again.</p>'
          : '') +
        '<p class="hint" style="margin-top:0.5rem">The private key is stored encrypted and is never shown or downloadable. There is no escrow copy: if it is lost, regenerate and re-run the script (which is safe to re-run).</p>' +
      '</div>'
    );
  }

  function platformTabsHtml() {
    function tab(id, label) {
      return '<button class="btn btn-sm ' + (_platform === id ? "btn-primary" : "btn-secondary") +
        '" data-wssh-platform="' + id + '">' + label + '</button>';
    }
    return (
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:1rem">' +
        tab("windows", "Windows") + tab("linux", "Linux") +
        '<span class="hint" style="margin:0 0 0 0.5rem">' +
          'Both platforms share one keypair; the account differs, so each has its own managed credential.' +
        '</span>' +
      '</div>'
    );
  }

  function configPaneHtml(s, hasKey) {
    var a = (s && s[_platform]) || {};
    var mode = a.accountMode || "existing";
    var isLinux = _platform === "linux";
    return (
      '<div style="padding-bottom:1rem;border-bottom:1px solid var(--color-border);margin-bottom:1rem">' +
        '<h5 style="margin:0 0 0.5rem 0">2. Windows account</h5>' +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin:0 0 0.75rem 0">' +
          'Polaris signs in as this account. It must be a member of the local Administrators group — the agent installer writes to <code>%ProgramFiles%</code> and registers a service.' +
        '</p>' +
        '<div class="form-group">' +
          '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">' +
            '<input type="radio" name="wssh-mode" value="existing"' + (mode === "existing" ? " checked" : "") + '>' +
            '<span>Use an existing administrator account</span>' +
          '</label>' +
          '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;margin-top:4px">' +
            '<input type="radio" name="wssh-mode" value="create"' + (mode === "create" ? " checked" : "") + '>' +
            '<span>Create a dedicated local account on each ' + (isLinux ? "host" : "endpoint") + '</span>' +
          '</label>' +
          '<p class="hint" id="wssh-mode-hint"></p>' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Username</label>' +
          '<input type="text" id="wssh-username" value="' + escapeHtml((s && s.username) || "") + '" placeholder="polaris-agent">' +
          '<p class="hint"><code>DOMAIN\\user</code> is allowed only with an existing account — a domain account cannot be created locally.</p>' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Polaris server address <span style="font-weight:normal;color:var(--color-text-tertiary)">(optional)</span></label>' +
          '<input type="text" id="wssh-serverip" value="' + escapeHtml((s && s.polarisServerIp) || "") + '" placeholder="10.0.0.42 or 10.0.0.0/24">' +
          '<p class="hint">When set, the script scopes inbound TCP/22 to this address. Left blank it does not touch the firewall — restrict port 22 some other way, or every host on the network can reach sshd.</p>' +
        '</div>' +
        (isLinux
          ? '<p class="hint" style="color:var(--color-warning,#d98c00)">The sudoers drop-in grants this account passwordless root on every host it is applied to. That is what the agent installer requires; scope the account accordingly and have someone review the script before it goes into your config management.</p>'
          : '') +
        '<button class="btn btn-secondary" id="wssh-save"' + (hasKey ? "" : " disabled") + '>Save settings</button>' +
      '</div>'
    );
  }

  function scriptPaneHtml(hasKey) {
    if (!hasKey) {
      return (
        '<div>' +
          '<h5 style="margin:0 0 0.5rem 0">3. Onboarding script</h5>' +
          '<p class="empty-state" style="padding:0.5rem 0;margin:0">Generate a keypair first — the script embeds the public key.</p>' +
        '</div>'
      );
    }
    return (
      '<div>' +
        '<h5 style="margin:0 0 0.5rem 0">3. Onboarding script</h5>' +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin:0 0 0.75rem 0">' +
          (_platform === "linux"
            ? 'Plain bash with no machine-specific values, so the same file runs unchanged on every host. Run it as <strong>root</strong>; it is idempotent. '
            : 'Plain PowerShell with no machine-specific values, so the same file runs unchanged on every endpoint. Run it as SYSTEM with the 64-bit PowerShell host. ') +
          'The <strong>detection</strong> script is optional but recommended: pairing the two makes rollout self-healing, ' +
          'because a one-shot script never retries on machines that were offline or have since been reimaged.' +
        '</p>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem">' +
          '<button class="btn btn-sm btn-secondary" id="wssh-show-remediation">Onboarding script</button>' +
          '<button class="btn btn-sm btn-secondary" id="wssh-show-detection">Detection script</button>' +
          '<span style="flex:1"></span>' +
          '<button class="btn btn-sm btn-secondary" id="wssh-copy">Copy</button>' +
          '<button class="btn btn-sm btn-primary" id="wssh-download">Download ' + (_platform === "linux" ? ".sh" : ".ps1") + '</button>' +
        '</div>' +
        '<textarea readonly rows="16" class="mono" id="wssh-script" style="width:100%" placeholder="Loading…"></textarea>' +
        deliveryNoteHtml() +
      '</div>'
    );
  }

  // Operators reasonably assume "we use Intune" covers the whole estate. It
  // does not — Intune has never managed traditional Windows Server, and the
  // AD/Entra auto-deploy config has a Servers class. Saying so here is
  // cheaper than a half-onboarded fleet.
  function deliveryNoteHtml() {
    if (_platform === "linux") {
      return (
        '<details style="margin-top:0.75rem">' +
          '<summary style="cursor:pointer;font-size:0.82rem;color:var(--color-text-secondary)">How to deploy this across a fleet</summary>' +
          '<div style="font-size:0.82rem;color:var(--color-text-secondary);padding:0.5rem 0 0 0.5rem">' +
            '<p style="margin:0 0 0.4rem 0"><strong>Ansible</strong> &mdash; <code>ansible all -b -m script -a polaris-ssh-onboarding.sh</code>, or pair it with the detection script for a check/apply split.</p>' +
            '<p style="margin:0 0 0.4rem 0"><strong>Salt / Chef / Puppet</strong> &mdash; any run-as-root script resource; the detection script gives you an <code>onlyif</code>-style guard.</p>' +
            '<p style="margin:0 0 0.4rem 0"><strong>cloud-init</strong> &mdash; drop it in <code>runcmd</code> so new instances onboard at first boot.</p>' +
            '<p style="margin:0 0 0.4rem 0"><strong>No tooling</strong> &mdash; <code>scp</code> it over, then <code>sudo bash polaris-ssh-onboarding.sh</code>.</p>' +
            '<p style="margin:0"><strong>Not installed by the script:</strong> <code>openssh-server</code>. That needs distro-specific package management, and a host you cannot already reach over SSH is not one this script was delivered to &mdash; it detects and reports instead.</p>' +
          '</div>' +
        '</details>'
      );
    }
    return (
      '<details style="margin-top:0.75rem">' +
        '<summary style="cursor:pointer;font-size:0.82rem;color:var(--color-text-secondary)">How to deploy this across a fleet</summary>' +
        '<div style="font-size:0.82rem;color:var(--color-text-secondary);padding:0.5rem 0 0 0.5rem">' +
          '<p style="margin:0 0 0.4rem 0"><strong>Intune (Windows 10/11)</strong> — Remediations, using both scripts. Devices &gt; Scripts also works but runs once per device and never retries.</p>' +
          '<p style="margin:0 0 0.4rem 0"><strong>Domain-joined, no Intune</strong> — GPO startup script (Computer Config &gt; Policies &gt; Windows Settings &gt; Scripts &gt; Startup). Runs as SYSTEM at boot; re-running every boot is harmless.</p>' +
          '<p style="margin:0 0 0.4rem 0"><strong>Configuration Manager</strong> — Configuration Baseline with the detection + remediation pair.</p>' +
          '<p style="margin:0 0 0.4rem 0"><strong>Windows Server</strong> — not Intune. Use GPO, Configuration Manager, or Azure Arc. The script body is identical.</p>' +
          '<p style="margin:0 0 0.4rem 0"><strong>RMM tools</strong> — paste as a run-as-SYSTEM script job.</p>' +
          '<p style="margin:0"><strong>No tooling</strong> — <code>Invoke-Command -ComputerName (Get-ADComputer -Filter ...).Name -FilePath .\\polaris-ssh-onboarding.ps1</code>. This uses WinRM once to bootstrap SSH, after which Polaris no longer needs a password on the wire.</p>' +
        '</div>' +
      '</details>'
    );
  }

  function syncModeHint() {
    var hint = el("wssh-mode-hint");
    if (!hint) return;
    var create = document.querySelector('input[name="wssh-mode"][value="create"]');
    var isLinux = _platform === "linux";
    if (create && create.checked) {
      hint.textContent = isLinux
        ? "The script creates the account with its password locked — authentication is by key only — and gives it passwordless sudo."
        : "The script creates the account with a random password it never reports — authentication is by key only — and adds it to the local Administrators group.";
    } else {
      hint.textContent = isLinux
        ? "The script installs the key and the sudoers drop-in, but will not create the account — it fails if the account is missing."
        : "The script only installs the key. It will not create the account or change its group membership.";
    }
  }

  function render() {
    var body = el("agent-ssh-onboarding-body");
    if (!body) return;
    body.innerHTML = cardBodyHtml(_state);
    wire();
    syncModeHint();
    if (_state && _state.publicKey) loadScript(_activeKind);
    loadPublishTargets();
    // Independent of the keypair — pins can exist from hand-made credentials
    // that never went through this card.
    loadHostKeys();
  }

  function wire() {
    var gen = el("wssh-generate");
    if (gen) gen.addEventListener("click", onGenerate);

    var save = el("wssh-save");
    if (save) save.addEventListener("click", onSave);

    Array.prototype.forEach.call(
      document.querySelectorAll('input[name="wssh-mode"]'),
      function (r) { r.addEventListener("change", syncModeHint); },
    );

    Array.prototype.forEach.call(
      document.querySelectorAll("[data-wssh-platform]"),
      function (b) {
        b.addEventListener("click", function () {
          var next = b.getAttribute("data-wssh-platform");
          if (next === _platform) return;
          _platform = next;
          _activeKind = "remediation";
          render();
        });
      },
    );

    var showRem = el("wssh-show-remediation");
    if (showRem) showRem.addEventListener("click", function () { loadScript("remediation"); });
    var showDet = el("wssh-show-detection");
    if (showDet) showDet.addEventListener("click", function () { loadScript("detection"); });

    var copy = el("wssh-copy");
    if (copy) copy.addEventListener("click", onCopy);
    var dl = el("wssh-download");
    if (dl) dl.addEventListener("click", onDownload);
  }

  function onGenerate() {
    var hasKey = !!(_state && _state.publicKey);
    var proceed = hasKey
      ? showConfirm(
          "Regenerate the deployment keypair?\n\n" +
          "The current key stops working immediately. Polaris will not be able to reach any Windows endpoint over SSH " +
          "until the onboarding script has re-run everywhere and installed the new key.\n\n" +
          "This affects BOTH the Windows and Linux credentials — they share one keypair.

" +
          "Agents already installed keep reporting — this only affects installing, upgrading and removing them."
        )
      : Promise.resolve(true);

    Promise.resolve(proceed).then(function (ok) {
      if (!ok) return;
      var btn = el("wssh-generate");
      if (btn) btn.disabled = true;
      return api.serverSettings.agentWindowsSshGenerate()
        .then(function (s) {
          _state = s;
          _scripts = {};
          showToast(hasKey ? "Keypair regenerated" : "Keypair generated", "success");
          render();
        })
        .catch(function (err) {
          showToast((err && err.message) ? err.message : "Could not generate the keypair", "error");
          if (btn) btn.disabled = false;
        });
    });
  }

  function onSave() {
    var modeEl = document.querySelector('input[name="wssh-mode"]:checked');
    var body = {
      platform: _platform,
      accountMode: modeEl ? modeEl.value : "existing",
      username: (el("wssh-username") || {}).value || "",
      polarisServerIp: (el("wssh-serverip") || {}).value || "",
    };
    var btn = el("wssh-save");
    if (btn) btn.disabled = true;
    api.serverSettings.agentWindowsSshSave(body)
      .then(function (s) {
        _state = s;
        // Config feeds the remediation script, so drop the cached copies.
        _scripts = {};
        showToast("Settings saved", "success");
        render();
      })
      .catch(function (err) {
        showToast((err && err.message) ? err.message : "Could not save settings", "error");
      })
      .finally(function () { if (btn) btn.disabled = false; });
  }

  function loadScript(kind) {
    _activeKind = kind;
    var ta = el("wssh-script");
    var remBtn = el("wssh-show-remediation");
    var detBtn = el("wssh-show-detection");
    if (remBtn) remBtn.classList.toggle("btn-primary", kind === "remediation");
    if (detBtn) detBtn.classList.toggle("btn-primary", kind === "detection");

    var ck = scriptCacheKey(_platform, kind);
    if (_scripts[ck]) {
      if (ta) ta.value = _scripts[ck].script;
      return;
    }
    if (ta) ta.value = "Loading…";
    var forPlatform = _platform;
    api.serverSettings.agentWindowsSshScript(kind, forPlatform)
      .then(function (r) {
        _scripts[ck] = r;
        // Guard against a platform/kind switch landing mid-flight.
        if (_activeKind === kind && _platform === forPlatform && el("wssh-script")) {
          el("wssh-script").value = r.script;
        }
      })
      .catch(function (err) {
        if (el("wssh-script")) {
          el("wssh-script").value = "Could not load the script: " + ((err && err.message) || "unknown error");
        }
      });
  }

  function onCopy() {
    var cur = _scripts[scriptCacheKey(_platform, _activeKind)];
    if (!cur) return;
    navigator.clipboard.writeText(cur.script)
      .then(function () { showToast("Script copied to clipboard", "success"); })
      .catch(function () { showToast("Could not copy — select the text and copy manually", "error"); });
  }

  function onDownload() {
    var cur = _scripts[scriptCacheKey(_platform, _activeKind)];
    if (!cur) return;
    // Client-side Blob download: the route returns JSON so the same fetch can
    // feed the inline preview, and there's no second endpoint to gate.
    var blob = new Blob([cur.script], { type: "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = cur.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function initSshOnboardingCard() {
    var body = el("agent-ssh-onboarding-body");
    if (!body) return;
    api.serverSettings.agentWindowsSshGet()
      .then(function (s) { _state = s; render(); })
      .catch(function (err) {
        // 403 is the expected path for a role without serverSettingsSystem —
        // hide the whole card rather than showing a broken one.
        var card = document.getElementById("agent-ssh-onboarding-card");
        if (err && err.status === 403) { if (card) card.style.display = "none"; return; }
        body.innerHTML = '<p class="empty-state" style="padding:1rem 0">Could not load: ' +
          escapeHtml((err && err.message) || "unknown error") + "</p>";
      });
  }

  window.PolarisAgentSshOnboarding = {
    init: initSshOnboardingCard,
  };
})();
