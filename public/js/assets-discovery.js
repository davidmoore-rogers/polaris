/**
 * public/js/assets-discovery.js — the network Discovery wizard.
 *
 * Reached from the Assets page's "+ Add Asset(s)" menu. A **Discovery** is a
 * saved, re-runnable configuration that sweeps operator-supplied IP ranges,
 * identifies what answers, and lets the operator choose which responders to
 * adopt as assets — the path for equipment that answers SNMP or a REST API but
 * belongs to no controller and no directory (PDUs, UPSes, sensors, cameras,
 * older switches), which today has to be typed in one device at a time.
 *
 * Seven steps: Name → Targets → Methods → Run → Results → Monitoring →
 * Summary. Built in the idiom of appmap-rules-wizard.js (openAppMapRuleWizard),
 * itself a smaller copy of automations-wizard.js: ONE closure-scoped `draft`
 * holding every step's state, a HTML/Wire/Collect/Validate quad per step behind
 * COLLECT / VALIDATE dispatch tables, a footer rendered once whose button
 * visibility is synced per step, and free navigation back to any visited step.
 * The shared .stepper / .step-panel CSS is reused verbatim — the stepper must
 * stay a DIRECT first child of .modal-body for its sticky rule to apply. Ids
 * are `nd-` prefixed so they can never collide with `aw-` or `apr-`.
 *
 * Two things about this wizard are unlike the other two:
 *
 *   - Steps 4 and 5 are not authoring, they are a RUN. Step 4 enqueues a scan
 *     and polls it; step 5 renders what came back. So the draft carries a
 *     `runId` and the wizard can be reopened onto a scan already in flight
 *     (the agent-build.js reattach precedent) rather than losing it when the
 *     operator closes the modal.
 *
 *   - Everything the wizard offers is gated by the key its own route checks.
 *     Authoring and running are `networkScan`; ADOPTING is that plus
 *     `assets:write`, chained — so "may find out what is on the network" and
 *     "may add it to inventory" stay separable, and a read-level caller gets a
 *     read-only walkthrough with Export but no Save/Run/Create.
 *
 * **Depends on globals** — load AFTER `api.js`, `app.js` (openModal /
 * closeModal / showToast / showConfirm / showRowMenu / escapeHtml /
 * permAtLeast), and `assets.js` (which reads this namespace lazily, at click
 * time, so this tag may come after it).
 */

/* global openModal, closeModal, showToast, escapeHtml, permAtLeast, showRowMenu, api */

(function () {
  "use strict";

  var STEPS = ["Name", "Targets", "Methods", "Run", "Results", "Monitoring", "Summary"];

  /**
   * A fresh draft. `targets` / `methods` / `autoMonitor` mirror the
   * NetworkScan columns 1:1 so a saved profile round-trips without a
   * translation layer; `runId` and `hits` are run state, not configuration,
   * and are deliberately NOT part of what gets saved or exported.
   */
  function emptyDraft() {
    return {
      id: null,
      name: "",
      description: null,
      targets: [],
      methods: [],
      autoMonitor: null,
      // run state
      runId: null,
      hits: [],
      selectedAddresses: [],
    };
  }

  /** Can the caller author (create / edit / run) a Discovery? */
  function canWrite() { return permAtLeast("networkScan", "write"); }
  /** Can the caller turn responders into assets? Chained with the above. */
  function canAdopt() { return canWrite() && permAtLeast("assets", "write"); }

  /**
   * Open the wizard. `existing` is a saved NetworkScan row (edit), absent for
   * a new one. `opts.import` marks a draft parsed out of a .discovery.json
   * file, which saves as a CREATE — the automations wizard's clone/import
   * shape, where `editing` deliberately stays null.
   */
  function open(existing, opts) {
    opts = opts || {};
    var importing = !!opts.import && !!existing;
    var editing = importing ? null : (existing || null);
    var draft = existing ? JSON.parse(JSON.stringify(existing)) : emptyDraft();
    if (importing) draft.id = null;

    var step = 1;
    var visited = (editing || importing) ? STEPS.length : 1;

    // ─── Steps ───────────────────────────────────────────────────────
    // Each step is an HTML/Wire/Collect/Validate quad. Steps land here as
    // they are built; a placeholder panel keeps navigation honest in the
    // meantime rather than rendering a blank step that looks broken.

    function placeholderHtml(label) {
      return '<p class="hint" style="margin:0">' + escapeHtml(label) +
        " — not built yet.</p>";
    }

    function step1Html()  { return placeholderHtml("Name and description"); }
    function step2Html()  { return placeholderHtml("IP ranges and subnets to scan"); }
    function step3Html()  { return placeholderHtml("Polling methods and credentials to try"); }
    function step4Html()  { return placeholderHtml("Run"); }
    function step5Html()  { return placeholderHtml("Results"); }
    function step6Html()  { return placeholderHtml("Interface and storage monitoring"); }
    function step7Html()  { return placeholderHtml("Summary"); }

    var noop = function () {};
    var ok = function () { return null; };

    var COLLECT = { 1: noop, 2: noop, 3: noop, 4: noop, 5: noop, 6: noop, 7: noop };
    var VALIDATE = { 1: ok, 2: ok, 3: ok, 4: ok, 5: ok, 6: ok, 7: ok };

    // ─── Shell ───────────────────────────────────────────────────────

    function stepperHtml() {
      var html = '<div class="stepper" id="nd-stepper">';
      STEPS.forEach(function (label, i) {
        var n = i + 1;
        if (i > 0) html += '<div class="stepper-line" data-line="' + (n - 1) + '"></div>';
        html += '<div class="stepper-step" data-step="' + n + '">' +
          '<span class="stepper-num">' + n + "</span><span>" + escapeHtml(label) + "</span></div>";
      });
      return html + "</div>";
    }

    function updateStepper() {
      document.querySelectorAll("#nd-stepper .stepper-step").forEach(function (el) {
        var n = Number(el.getAttribute("data-step"));
        el.classList.toggle("active", n === step);
        el.classList.toggle("done", n < step);
        el.classList.toggle("clickable", n <= visited && n !== step);
      });
      document.querySelectorAll("#nd-stepper .stepper-line").forEach(function (el) {
        el.classList.toggle("done", Number(el.getAttribute("data-line")) < step);
      });
    }

    function syncFooter() {
      document.getElementById("nd-back").style.display = step > 1 ? "" : "none";
      document.getElementById("nd-next").style.display = step < STEPS.length ? "" : "none";
      // Save is a write verb: a read-level caller walking a saved Discovery
      // gets no button at all rather than one whose click can only 403.
      var save = document.getElementById("nd-save");
      if (save) save.style.display = (step === STEPS.length || editing) ? "" : "none";
    }

    function goToStep(n, opts2) {
      opts2 = opts2 || {};
      if (!opts2.skipCollect) COLLECT[step]();
      if (opts2.validate) {
        var problem = VALIDATE[step]();
        if (problem) { showToast(problem, "error"); return false; }
      }
      document.getElementById("nd-step-" + step).classList.remove("visible");
      step = n;
      visited = Math.max(visited, n);
      document.getElementById("nd-step-" + step).classList.add("visible");
      updateStepper();
      syncFooter();
      var body = document.querySelector(".modal-body");
      if (body) body.scrollTop = 0;
      return true;
    }

    var bodyHtml = stepperHtml() +
      '<div class="step-panel visible" id="nd-step-1">' + step1Html() + "</div>" +
      '<div class="step-panel" id="nd-step-2">' + step2Html() + "</div>" +
      '<div class="step-panel" id="nd-step-3">' + step3Html() + "</div>" +
      '<div class="step-panel" id="nd-step-4">' + step4Html() + "</div>" +
      '<div class="step-panel" id="nd-step-5">' + step5Html() + "</div>" +
      '<div class="step-panel" id="nd-step-6">' + step6Html() + "</div>" +
      '<div class="step-panel" id="nd-step-7">' + step7Html() + "</div>";

    var footer =
      '<button type="button" class="btn btn-secondary" id="nd-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-secondary" id="nd-back" style="display:none">&larr; Back</button>' +
      '<button type="button" class="btn btn-primary" id="nd-next">Next &rarr;</button>' +
      (canWrite()
        ? '<button type="button" class="btn btn-primary" id="nd-save" style="display:none">' +
            (editing ? "Save changes" : "Create discovery") + "</button>"
        : "");

    openModal(
      editing ? "Edit discovery" : importing ? "Imported discovery" : "New discovery",
      bodyHtml, footer, { wide: true },
    );

    document.getElementById("nd-next").addEventListener("click", function () {
      goToStep(step + 1, { validate: true });
    });
    document.getElementById("nd-back").addEventListener("click", function () { goToStep(step - 1); });
    document.getElementById("nd-stepper").addEventListener("click", function (ev) {
      var el = ev.target.closest ? ev.target.closest(".stepper-step") : null;
      if (!el) return;
      var n = Number(el.getAttribute("data-step"));
      if (n <= visited && n !== step) goToStep(n);
    });
    document.getElementById("nd-cancel").addEventListener("click", function () { closeModal(); });

    updateStepper();
    syncFooter();
  }

  /**
   * The saved-Discovery list. A wizard alone gives no way back to something
   * saved "for future use", so this is that door: name, targets, last run,
   * and a per-row menu of Run / Edit / Export / Delete gated by the key each
   * verb's route checks.
   */
  function openList() {
    showToast("Saved discoveries are not available yet.", "info");
  }

  window.PolarisAssetDiscovery = {
    open: open,
    openList: openList,
    // Pure helpers, re-exported for the happy-dom unit suite.
    STEPS: STEPS,
    emptyDraft: emptyDraft,
  };
})();
