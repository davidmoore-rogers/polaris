/* public/js/alert-ack-modal.js — PolarisAlertAckModal: acknowledge one alert
 * from inside the app, in a modal that MIRRORS /alert-ack.html.
 *
 * Opened from the Down Assets widget's row menu (public/js/widgets/
 * downNodes.js): a down device's row is a prompt to do one of two things, so
 * the click asks which — Acknowledge, or open the device — instead of assuming
 * the second. See PolarisWidgets.openAssetRow.
 *
 * Why a copy of the page rather than the bare note prompt the asset Alerts tab
 * uses (`_promptAckNote` in assets.js): the operator arrived from a widget row
 * that said only "this host is down". Before putting their name on the alert
 * they need to see WHICH alert, what raised it, how bad it is and whether
 * someone beat them to it — which is exactly the card the emailed link already
 * renders. The markup here IS that card's (PolarisAlertAckView), so the two
 * surfaces cannot drift; only the shell differs.
 *
 * Three things it inherits from the page and must keep (business rule 25):
 *   • IT NEVER DECIDES WHO MAY ACKNOWLEDGE. It asks, and reports what came
 *     back. `alerts:write` is the route's gate; a 403 becomes a state, not a
 *     toast. (The widget's menu withholds the verb from a role that plainly
 *     lacks it — that is a courtesy, and this is the control.)
 *   • THE NOTE POLICY IS THE SERVER'S. `requireAckNote` drives the label and
 *     the `required` attribute; acknowledgeNotifications is what refuses an
 *     empty one, so a 400 re-renders the form with the reason.
 *   • IT RE-READS AFTER THE WRITE. Someone else may have acknowledged in
 *     between, and their name is the honest one to show.
 *
 * It also re-reads BEFORE the form: the row that opened it is up to 30s old
 * (the widget's refresh) on top of the feed's 10s server-side cache, so
 * "unacknowledged" on that row is a claim worth re-checking rather than a form
 * that would no-op.
 */

(function () {
  "use strict";

  var View = window.PolarisAlertAckView;

  /** Guarded so this module stays parseable on a surface without app.js. */
  function toast(msg, kind) {
    if (typeof window.showToast === "function") window.showToast(msg, kind);
  }

  /* ─── One state of the dialog ─────────────────────────────────────────────── */

  /**
   * Render a state into the shared modal. `alert` tints the accent rule (the
   * modal's equivalent of the page card's 4px top border); `body` / `footer`
   * are the state's own; `wire` runs after insertion.
   *
   * openModal replaces the ONE shared #modal-overlay, so each state is a fresh
   * openModal call rather than an in-place patch — which is also what keeps the
   * focus trap and the panel lock correct per state.
   */
  function show(state) {
    var accent = state.alert
      ? '<div class="ack-modal-accent" style="--ack-accent:' + View.accentValue(state.alert.severity) + '"></div>'
      : "";
    var lead = state.lead
      ? '<p class="ack-note-label" style="margin-bottom:0.9rem">' + View.esc(state.lead) + "</p>"
      : "";
    window.openModal(state.title, accent + lead + (state.body || ""), state.footer || "");
    if (typeof state.wire === "function") state.wire();
  }

  /** The closing button. "Close" rather than "Cancel" on a state where there is
   *  nothing left to cancel. */
  function closeBtn(label) {
    return '<button type="button" class="btn btn-secondary" id="ack-modal-close">' + View.esc(label) + "</button>";
  }

  function wireClose() {
    var b = document.getElementById("ack-modal-close");
    if (b) b.addEventListener("click", function () { window.closeModal(); });
  }

  /** "Open device" — offered beside every state, because an operator who came
   *  to acknowledge usually wants to look at the thing next. Absent on an alert
   *  with no device (a host_metric rule, a system-scoped event) and on a caller
   *  that gave no opener. */
  function openDeviceBtn(alert, onOpenDevice) {
    if (!alert || !alert.assetId || typeof onOpenDevice !== "function") return "";
    return '<button type="button" class="btn btn-secondary" id="ack-modal-open">Open device</button>';
  }

  function wireOpenDevice(onOpenDevice) {
    var b = document.getElementById("ack-modal-open");
    if (!b) return;
    b.addEventListener("click", function () {
      window.closeModal();
      onOpenDevice();
    });
  }

  /* ─── States ──────────────────────────────────────────────────────────────── */

  function showForm(ctx, alert, errorText) {
    var needNote = alert.requireAckNote === true;
    show({
      title: "Acknowledge alert",
      alert: alert,
      lead: needNote ? "This automation asks for a note before it can be acknowledged." : "",
      body: View.headerHtml(alert)
        + View.noteFieldHtml("ack-modal-note", needNote)
        + View.errorHtml(errorText),
      footer: openDeviceBtn(alert, ctx.onOpenDevice)
        + closeBtn("Cancel")
        + '<button type="button" class="btn btn-primary" id="ack-modal-submit">Acknowledge</button>',
      wire: function () {
        wireClose();
        wireOpenDevice(ctx.onOpenDevice);
        var note = document.getElementById("ack-modal-note");
        if (needNote && note) note.focus();
        document.getElementById("ack-modal-submit").addEventListener("click", function (e) {
          submit(ctx, alert, e.currentTarget, note ? note.value : "");
        });
      },
    });
  }

  /** Acknowledged — just now, or by whoever got there first. */
  function showAcknowledged(ctx, alert, justNow) {
    show({
      title: "Acknowledged",
      alert: alert,
      lead: justNow
        ? "Recorded. The alert stays visible until it clears."
        : (alert.acknowledgedBy
            ? alert.acknowledgedBy + " got here first — nothing more to do."
            : "Someone already acknowledged this one."),
      body: View.headerHtml(alert),
      footer: openDeviceBtn(alert, ctx.onOpenDevice) + closeBtn("Close"),
      wire: function () { wireClose(); wireOpenDevice(ctx.onOpenDevice); },
    });
  }

  function showCleared(ctx, alert) {
    show({
      title: "This alert already cleared",
      alert: alert,
      lead: "It resolved on its own or someone cleared it, so there is nothing to acknowledge.",
      body: View.headerHtml(alert),
      footer: openDeviceBtn(alert, ctx.onOpenDevice) + closeBtn("Close"),
      wire: function () { wireClose(); wireOpenDevice(ctx.onOpenDevice); },
    });
  }

  /* A refusal is a state, not a toast: the operator asked to acknowledge and is
   * owed the reason where they asked. Mirrors the page's forbidden state. */
  function showForbidden(ctx, alert) {
    show({
      title: "Your account can't acknowledge alerts",
      alert: alert,
      lead: "Your role lets you see this alert but not acknowledge it. Ask an administrator if that is unexpected.",
      body: View.headerHtml(alert),
      footer: openDeviceBtn(alert, ctx.onOpenDevice) + closeBtn("Close"),
      wire: function () { wireClose(); wireOpenDevice(ctx.onOpenDevice); },
    });
  }

  /* 404 and 403 on the READ are one sentence: this alert does not lead anywhere
   * the reader can go. The route already answers 404 for an alert outside their
   * region scope rather than confirming it exists. */
  function showMissing(ctx) {
    show({
      title: "This alert is not here any more",
      lead: "It may have cleared and been pruned, or it belongs to a region your account does not cover.",
      body: "",
      footer: closeBtn("Close"),
      wire: wireClose,
    });
  }

  function showBroken(ctx, alertId, msg) {
    show({
      title: "Something went wrong",
      lead: msg || "Polaris could not load this alert just now. Try again in a moment.",
      body: "",
      footer: closeBtn("Close")
        + '<button type="button" class="btn btn-primary" id="ack-modal-retry">Try again</button>',
      wire: function () {
        wireClose();
        document.getElementById("ack-modal-retry").addEventListener("click", function () { open(alertId, ctx); });
      },
    });
  }

  /* ─── Acknowledge ─────────────────────────────────────────────────────────── */

  async function submit(ctx, alert, button, note) {
    button.disabled = true;
    button.textContent = "Acknowledging…";
    try {
      // No `source`: this is an in-app surface, and that closed set names the
      // emailed page and the push action only.
      await api.alerts.acknowledge([alert.id], (note || "").trim() || undefined);
      var fresh;
      try {
        fresh = await api.alerts.get(alert.id);
      } catch (_) {
        fresh = Object.assign({}, alert, { acknowledged: true });
      }
      showAcknowledged(ctx, fresh, true);
      toast("Alert acknowledged", "success");
      // The row that opened this now says the wrong thing — it would keep
      // offering Acknowledge until the widget's own 30s refresh came round.
      if (typeof ctx.onAcknowledged === "function") ctx.onAcknowledged(fresh);
    } catch (err) {
      if (err && err.status === 403) { showForbidden(ctx, alert); return; }
      // A 400 is the note policy refusing an empty note — form validation, not
      // a dead end, so the form comes back with the reason on it.
      showForm(ctx, alert, (err && err.message) || "Could not acknowledge that just now.");
    }
  }

  /* ─── Entry point ─────────────────────────────────────────────────────────── */

  /**
   * open(alertId, { onAcknowledged, onOpenDevice })
   *   onAcknowledged(alert) — the caller refreshes whatever showed the row.
   *   onOpenDevice()        — how THIS surface opens the device; the widget
   *                           hands over its in-place slide-over opener rather
   *                           than letting the modal navigate.
   */
  async function open(alertId, opts) {
    var ctx = opts || {};
    if (!alertId) { showMissing(ctx); return; }
    show({ title: "Acknowledge alert", lead: "Loading alert…", body: "", footer: closeBtn("Cancel"), wire: wireClose });
    var alert;
    try {
      alert = await api.alerts.get(alertId);
    } catch (err) {
      if (err && (err.status === 404 || err.status === 403)) { showMissing(ctx); return; }
      showBroken(ctx, alertId, err && err.message);
      return;
    }
    if (alert.acknowledged) { showAcknowledged(ctx, alert, false); return; }
    if (alert.cleared) { showCleared(ctx, alert); return; }
    showForm(ctx, alert);
  }

  window.PolarisAlertAckModal = { open: open };
})();
