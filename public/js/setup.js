// public/js/setup.js — First-run setup wizard logic (extracted from
// setup.html inline script so we can drop 'unsafe-inline' from the script CSP).

var currentStep = 1;
var connectionTested = false;
var sessionSecret = "";
var demoMode = false;

// Detect demo mode — if setup/status says needsSetup: false, we're in demo
(async function () {
  try {
    var res = await fetch("/api/setup/status");
    var data = await res.json();
    if (data.needsSetup === false) {
      demoMode = true;
      // Enable Next on step 1 immediately (no connection test required)
      document.getElementById("btn-next-1").disabled = false;
    }
  } catch (_) {}
})();

// ─── Step navigation ──────────────────────────────────────────────

function goToStep(step) {
  currentStep = step;
  for (var i = 1; i <= 4; i++) {
    var panel = document.getElementById("step-" + i);
    panel.classList.toggle("visible", i === step);
  }
  document.getElementById("step-progress").classList.remove("visible");
  updateStepper();
}

function updateStepper() {
  document.querySelectorAll(".stepper-step").forEach(function (el) {
    var s = parseInt(el.dataset.step, 10);
    el.classList.remove("active", "done");
    if (s === currentStep) el.classList.add("active");
    else if (s < currentStep) el.classList.add("done");
  });
  document.querySelectorAll(".stepper-line").forEach(function (el) {
    var l = parseInt(el.dataset.line, 10);
    el.classList.toggle("done", l < currentStep);
  });
}

// ─── Step 1: Database ─────────────────────────────────────────────

function getDbConfig() {
  return {
    host: document.getElementById("db-host").value.trim(),
    port: parseInt(document.getElementById("db-port").value, 10) || 5432,
    username: document.getElementById("db-username").value.trim(),
    password: document.getElementById("db-password").value,
    database: document.getElementById("db-database").value.trim(),
    ssl: document.getElementById("db-ssl").checked,
  };
}

document.getElementById("btn-test-conn").addEventListener("click", async function () {
  var btn = this;
  var resultEl = document.getElementById("test-result");
  btn.disabled = true;
  btn.textContent = "Testing...";
  // Reset to base class — visibility comes from .success / .error in CSS.
  // Don't set inline display:none here, or it'll override the class-based rule.
  resultEl.className = "test-result";
  resultEl.textContent = "";

  try {
    var db = getDbConfig();
    if (!db.host || !db.username || !db.database) {
      throw new Error("Host, username, and database name are required");
    }
    var res = await fetch("/api/setup/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(db),
    });
    var data = await res.json();
    if (data.ok) {
      resultEl.className = "test-result success";
      resultEl.textContent = data.message;
      connectionTested = true;
      document.getElementById("btn-next-1").disabled = false;
    } else {
      resultEl.className = "test-result error";
      resultEl.textContent = data.message;
      connectionTested = false;
      document.getElementById("btn-next-1").disabled = true;
    }
  } catch (err) {
    resultEl.className = "test-result error";
    resultEl.textContent = err.message || "Connection test failed";
    connectionTested = false;
    document.getElementById("btn-next-1").disabled = true;
  } finally {
    btn.disabled = false;
    btn.textContent = "Test Connection";
  }
});

// Reset test when DB fields change
["db-host", "db-port", "db-username", "db-password", "db-database", "db-ssl"].forEach(function (id) {
  document.getElementById(id).addEventListener("input", function () {
    connectionTested = false;
    document.getElementById("btn-next-1").disabled = true;
    var r = document.getElementById("test-result");
    r.className = "test-result";
    r.textContent = "";
  });
});

document.getElementById("btn-next-1").addEventListener("click", function () {
  if (!connectionTested && !demoMode) return;
  goToStep(2);
});

// ─── Step 2: Admin ────────────────────────────────────────────────

var pwRules = {
  length:  function (p) { return p.length >= 8; },
  lower:   function (p) { return /[a-z]/.test(p); },
  upper:   function (p) { return /[A-Z]/.test(p); },
  number:  function (p) { return /[0-9]/.test(p); },
  special: function (p) { return /[^a-zA-Z0-9]/.test(p); },
};

function checkPasswordComplexity(pw) {
  var allPassed = true;
  Object.keys(pwRules).forEach(function (rule) {
    var passed = pwRules[rule](pw);
    if (!passed) allPassed = false;
    var el = document.querySelector('#pw-checks [data-rule="' + rule + '"]');
    if (el) {
      el.querySelector(".pw-icon").innerHTML = passed ? "&#10003;" : "&#9675;";
      el.style.color = passed ? "var(--color-success, #4caf50)" : "var(--color-text-tertiary)";
    }
  });
  return allPassed;
}

document.getElementById("admin-password").addEventListener("input", function () {
  checkPasswordComplexity(this.value);
});

document.getElementById("btn-back-2").addEventListener("click", function () { goToStep(1); });
document.getElementById("btn-next-2").addEventListener("click", function () {
  if (!demoMode) {
    var username = document.getElementById("admin-username").value.trim();
    var password = document.getElementById("admin-password").value;
    var confirm = document.getElementById("admin-password-confirm").value;

    if (!username) { alert("Username is required"); return; }
    if (!checkPasswordComplexity(password)) { alert("Password does not meet complexity requirements"); return; }
    if (password !== confirm) { alert("Passwords do not match"); return; }
  }
  goToStep(3);
});

// ─── Step 3: Settings ─────────────────────────────────────────────

async function generateSecret() {
  try {
    var res = await fetch("/api/setup/generate-secret", { method: "POST" });
    var data = await res.json();
    sessionSecret = data.secret;
    document.getElementById("app-secret").value = sessionSecret;
  } catch (_) {
    // Fallback: generate client-side
    var arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    sessionSecret = Array.from(arr).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    document.getElementById("app-secret").value = sessionSecret;
  }
}

generateSecret();

document.getElementById("btn-regen-secret").addEventListener("click", generateSecret);
document.getElementById("btn-back-3").addEventListener("click", function () { goToStep(2); });
document.getElementById("btn-next-3").addEventListener("click", function () {
  var port = parseInt(document.getElementById("app-port").value, 10);
  if (!demoMode) {
    if (!port || port < 1 || port > 65535) { alert("Port must be between 1 and 65535"); return; }
    if (!sessionSecret) { alert("Session secret is required"); return; }
  }

  // Populate review
  var db = getDbConfig();
  document.getElementById("review-db").innerHTML =
    rv("Host", db.host + ":" + db.port) +
    rv("Username", db.username) +
    rv("Database", db.database) +
    rv("SSL", db.ssl ? "Enabled" : "Disabled");

  document.getElementById("review-admin").innerHTML =
    rv("Username", document.getElementById("admin-username").value.trim()) +
    rv("Password", "••••••••");

  document.getElementById("review-app").innerHTML =
    rv("HTTP Port", port) +
    rv("Session Secret", sessionSecret.substring(0, 12) + "…");

  goToStep(4);
});

function rv(label, value) {
  return "<dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd>";
}

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Step 4: Finalize ─────────────────────────────────────────────

document.getElementById("btn-back-4").addEventListener("click", function () { goToStep(3); });
document.getElementById("btn-finalize").addEventListener("click", async function () {
  var btn = this;
  btn.disabled = true;

  // Show progress
  for (var i = 1; i <= 4; i++) document.getElementById("step-" + i).classList.remove("visible");
  var progress = document.getElementById("step-progress");
  progress.classList.add("visible");
  var msgEl = document.getElementById("progress-msg");
  msgEl.textContent = "Writing configuration...";

  try {
    var payload = {
      db: getDbConfig(),
      admin: {
        username: document.getElementById("admin-username").value.trim(),
        password: document.getElementById("admin-password").value,
      },
      app: {
        port: parseInt(document.getElementById("app-port").value, 10) || 3000,
        sessionSecret: sessionSecret,
      },
    };

    msgEl.textContent = "Configuring database and running migrations...";
    var res = await fetch("/api/setup/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    var data = await res.json();

    if (!data.ok) {
      msgEl.textContent = "Setup failed: " + (data.message || "Unknown error");
      progress.querySelector(".spinner").style.display = "none";
      btn.disabled = false;
      document.getElementById("btn-back-4").click();
      alert("Setup failed: " + (data.message || "Unknown error"));
      return;
    }

    // Success — wait for application to restart
    msgEl.textContent = "Setup complete! The application is restarting...";
    var targetPort = payload.app.port;
    var attempts = 0;
    var maxAttempts = 30;

    var pollInterval = setInterval(async function () {
      attempts++;
      try {
        var healthRes = await fetch("http://localhost:" + targetPort + "/health", {
          signal: AbortSignal.timeout(2000),
        });
        if (healthRes.ok) {
          clearInterval(pollInterval);
          msgEl.textContent = "Application is ready! Redirecting...";
          setTimeout(function () {
            window.location.href = "http://localhost:" + targetPort + "/login.html";
          }, 1000);
        }
      } catch (_) {
        // Application not ready yet
      }

      if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        progress.querySelector(".spinner").style.display = "none";
        msgEl.innerHTML = "The application did not come back automatically.<br><br>" +
          "Please restart the application manually, then visit:<br>" +
          '<a href="http://localhost:' + targetPort + '" style="color:var(--color-primary,#4a9eff)">http://localhost:' + targetPort + "</a>";
      }
    }, 2000);

  } catch (err) {
    msgEl.textContent = "Setup failed: " + (err.message || "Network error");
    progress.querySelector(".spinner").style.display = "none";
  }
});
