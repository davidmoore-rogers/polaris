/**
 * tests/unit/automationsWizardDom.test.ts — DOM render smoke for the 5-step
 * automation wizard (public/js/automations-wizard.js).
 *
 * The wizard is a plain browser script (no module exports), so this test
 * loads it via eval into a happy-dom Window with the app-shell globals
 * stubbed (openModal/escapeHtml/permAtLeast/api/…) and the REAL schema
 * catalog from buildSchemaCatalog — then drives openAutomationWizard through
 * the first two steps. This is the regression net for the class of bug where
 * a helper is referenced during the modal-body assembly before its `var`
 * assignment has run (the wizard silently fails to open — nothing renders,
 * no toast — exactly what shipped when the condition builder's scMeta was
 * initialized after the body build).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { buildSchemaCatalog, ruleInputSchema } from "../../src/services/notificationTypes.js";
import { dimensionPickerMeta } from "../../src/services/notificationDimensionService.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
let doc: Window["document"];
let toastErrors: string[];
const savedPayloads: Record<string, unknown>[] = [];

beforeAll(() => {
  const win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  toastErrors = [];
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.showToast = (msg: string, kind: string) => { if (kind === "error") toastErrors.push(msg); };
  g.showConfirm = async () => false;
  g.permAtLeast = () => true;
  g.closeModal = () => {};
  g.openModal = (title: string, body: string, footer: string) => {
    const overlay = doc.createElement("div");
    overlay.innerHTML =
      '<div class="modal"><div class="modal-header"><h3>' + title + "</h3></div>" +
      '<div class="modal-body">' + body + "</div>" +
      '<div class="modal-footer">' + footer + "</div></div>";
    doc.body.appendChild(overlay);
  };
  g.api = {
    automations: {
      update: async (_id: string, payload: unknown) => { savedPayloads.push(payload as Record<string, unknown>); return { rule: {} }; },
      create: async (payload: unknown) => { savedPayloads.push(payload as Record<string, unknown>); return { rule: {} }; },
      // Exactly what GET /automations/schema answers — dimensionPickers is
      // merged in at the route, not by buildSchemaCatalog, and without it every
      // dimension control falls back to a plain text box.
      schema: async () => ({ ...buildSchemaCatalog(), dimensionPickers: dimensionPickerMeta() }),
      recipientUsers: async () => ({ users: [{ id: "u1", username: "op", displayName: "Op", email: "op@x.com" }] }),
      scopeOptions: async () => ({
        manufacturers: ["Fortinet Inc."],
        models: ["FGT-60F"],
        subnets: [{ id: "s1", name: "Mgmt", cidr: "10.20.0.0/24" }],
      }),
      preview: async () => ({ supported: true, totalEvaluated: 3, matches: [] }),
      dimensionValues: async (body: { dimension: string }) => ({
        values: body.dimension === "sensorClass"
          ? [{ value: "temperature", assetCount: 2 }, { value: "fan", assetCount: 2 }]
          : [
              { value: "CPU ON-DIE Temperature", assetCount: 2 },
              { value: "CPU Fan", assetCount: 2 },
              { value: "DTS CPU0", assetCount: 1 },
            ],
        noun: body.dimension === "sensorClass" ? "hardware sensor classes" : "hardware sensors",
        narrowLabel: "",
        scopedAssets: 2,
        sampledAssets: 2,
        assetsWithData: 2,
        windowHours: 3,
      }),
    },
    assets: { tags: async () => ({ tags: ["region:Atlanta", "prod"] }) },
    assetTypes: { list: async () => ({ types: [{ name: "server", label: "Server" }, { name: "switch", label: "Switch" }] }) },
    deliveryChannels: { list: async () => ({ channels: [{ id: "c1", name: "NOC email", type: "smtp", enabled: true }] }) },
    automationScripts: { list: async () => ({ scripts: [{ id: "sc1", name: "restart-svc", interpreter: "bash", runTarget: "either", timeoutSec: 60 }] }) },
  };
  // Module-scope caches normally owned by automations.js (loaded first on the page).
  g._ruleSchema = null;
  g._ruleTagList = null;
  g._ruleAssetTypes = null;
  g._ruleChannels = null;
  g._ruleRecipientUsers = null;
  g._looksLikeDeviceId = () => false;

  // The devices-step tree builder lives in its own script, loaded BEFORE the
  // wizard on every page that carries it — the wizard reads
  // window.PolarisConditionBuilder while assembling the modal body, so a
  // missing module here reproduces the "wizard silently fails to open" bug.
  const cbSrc = readFileSync(resolve(__dirname, "../../public/js/condition-builder.js"), "utf8");
  (0, eval)(cbSrc);
  const src = readFileSync(resolve(__dirname, "../../public/js/automations-wizard.js"), "utf8");
  (0, eval)(src);
});

describe("automation wizard DOM render", () => {
  it("openAutomationWizard(null) renders the modal, stepper, and step 1", async () => {
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)(null);
    expect(toastErrors).toEqual([]);
    expect(doc.querySelector(".modal")).toBeTruthy();
    expect(doc.querySelectorAll("#aw-stepper .stepper-step").length).toBe(6);
    expect(doc.querySelector("#aw-step-1.visible")).toBeTruthy();
    // Severity + Enabled were removed from the name step (severity moved to the
    // trigger step; enabled is managed from the list toggle).
    expect(doc.querySelector("#aw-severity")).toBeFalsy();
    expect(doc.querySelector("#aw-enabled")).toBeFalsy();
  });

  it("Next reaches step 2; All assets is checked by default and hides the builder", async () => {
    (doc.querySelector("#aw-name") as unknown as { value: string }).value = "smoke";
    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(doc.querySelector("#aw-step-2.visible")).toBeTruthy();
    const allCb = doc.querySelector("#aw-all-assets") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void };
    expect(allCb).toBeTruthy();
    expect(allCb.checked).toBe(true);
    expect((doc.querySelector("#aw-cond-wrap") as unknown as { style: { display: string } }).style.display).toBe("none");
  });

  it("unchecking All assets reveals the builder with a starter row; add-rule/add-group work", async () => {
    const win = g.window as InstanceType<typeof Window>;
    const allCb = doc.querySelector("#aw-all-assets") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void };
    allCb.checked = false;
    allCb.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect((doc.querySelector("#aw-cond-wrap") as unknown as { style: { display: string } }).style.display).toBe("block");
    expect(doc.querySelector("#aw-cond-root .scg-group")).toBeTruthy();
    expect(doc.querySelectorAll("#aw-cond-root .scr-row").length).toBe(1); // seeded starter row
    // Rows carry a draggable grip for the tree drag-and-drop.
    expect(doc.querySelector("#aw-cond-root .scr-row .aw-grip[draggable='true']")).toBeTruthy();

    (doc.querySelector("#aw-cond-root .scg-add-rule") as unknown as { click: () => void }).click();
    expect(doc.querySelectorAll("#aw-cond-root .scr-row").length).toBe(2);
    (doc.querySelector("#aw-cond-root .scg-add-group") as unknown as { click: () => void }).click();
    expect(doc.querySelectorAll("#aw-cond-root .scg-group").length).toBe(2);
    // Sub-groups get a grip too (root group does not).
    expect(doc.querySelectorAll("#aw-cond-root .scg-group .aw-grip").length).toBeGreaterThan(0);
    expect(toastErrors).toEqual([]);
  });

  it("value combobox opens existing values on click and filters as you type", async () => {
    const row = doc.querySelector("#aw-cond-root .scr-row")!;
    const fieldSel = row.querySelector(".scr-field") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    const win = g.window as InstanceType<typeof Window>;
    // Switch the row's field to Model, then click into the value input.
    fieldSel.value = "model";
    fieldSel.dispatchEvent(new win.Event("change", { bubbles: true }));
    const input = row.querySelector(".scr-value") as unknown as { value: string; click: () => void; dispatchEvent: (e: unknown) => void };
    input.click();
    let items = row.querySelectorAll(".aw-suggest.open .aw-suggest-item");
    expect(items.length).toBe(1); // the stubbed inventory has one model
    expect(items[0]!.textContent).toBe("FGT-60F");
    // Typing filters — a non-matching query shows the empty hint instead.
    input.value = "zzz";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(row.querySelectorAll(".aw-suggest.open .aw-suggest-item").length).toBe(0);
    expect(row.querySelector(".aw-suggest.open .aw-suggest-empty")).toBeTruthy();
    // A matching query brings the value back; clicking it fills the input.
    input.value = "fgt";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    items = row.querySelectorAll(".aw-suggest.open .aw-suggest-item");
    expect(items.length).toBe(1);
    items[0]!.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
    expect(input.value).toBe("FGT-60F");
    expect(row.querySelector(".aw-suggest.open")).toBeFalsy(); // closed after pick
    expect(toastErrors).toEqual([]);
  });

  it("step 3 renders the trigger condition tree with a starter leaf", async () => {
    const win = g.window as InstanceType<typeof Window>;
    // Re-check All assets so step 2 validates (the builder has unfinished rows).
    const allCb = doc.querySelector("#aw-all-assets") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void };
    allCb.checked = true;
    allCb.dispatchEvent(new win.Event("change", { bubbles: true }));
    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(toastErrors).toEqual([]);
    expect(doc.querySelector("#aw-step-3.visible")).toBeTruthy();
    // Severity leads the trigger step (single mode default): standalone
    // dropdown shown, multi-severity checkbox present + off, bands hidden.
    expect(doc.querySelector("#aw-trigger-severity.sev-select")).toBeTruthy();
    expect(doc.querySelectorAll("#aw-trigger-severity option.sev-critical").length).toBe(1);
    const multiCb = doc.querySelector("#aw-multi-sev") as unknown as { checked: boolean; disabled: boolean; dispatchEvent: (e: unknown) => void };
    expect(multiCb).toBeTruthy();
    expect(multiCb.checked).toBe(false);
    expect((doc.querySelector("#aw-bands-host") as unknown as { style: { display: string } }).style.display).toBe("none");
    // Category select (device/host/event/change) + the tree with one leaf row.
    const cat = doc.querySelector("#aw-trigger-type") as unknown as { value: string };
    expect(cat.value).toBe("device");
    // The message template moved to the Actions step (mandatory in-app card).
    expect(doc.querySelector("#aw-step-3 #aw-msg")).toBeFalsy();
    expect(doc.querySelector("#aw-trig-root .scg-group")).toBeTruthy();
    expect(doc.querySelectorAll("#aw-trig-root .scr-row").length).toBe(1);
    expect(doc.querySelector("#aw-trig-root .tgl-what")).toBeTruthy();
    expect(doc.querySelector("#aw-trig-root .tgl-threshold")).toBeTruthy();
    expect(doc.querySelector("#aw-trig-root .scr-row .aw-grip[draggable='true']")).toBeTruthy();

    // Enable multi-severity → single dropdown hides; the base severity select +
    // a "+ Severity" button are injected INTO the condition group header/buttons.
    multiCb.checked = true;
    multiCb.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect((doc.querySelector("#aw-single-sev-wrap") as unknown as { style: { display: string } }).style.display).toBe("none");
    expect(doc.querySelector("#aw-trig-root .scg-group .scg-sev")).toBeTruthy();   // base severity in the group header
    const addSev = doc.querySelector("#aw-trig-root .scg-group .scg-add-sev");
    expect(addSev).toBeTruthy();                                                   // + Severity next to +Condition/+Group
    expect((doc.querySelector("#aw-band-notify") as unknown as { style: { display: string } }).style.display).toBe("none");

    // Clicking + Severity adds a tier GROUP block: severity header + a condition
    // row (locked metric, editable operator/value) + its own + Severity.
    (addSev as unknown as { click: () => void }).click();
    const band = doc.querySelector("#aw-bands .aw-band")!;
    expect(band).toBeTruthy();
    expect(band.querySelector(".band-severity")).toBeTruthy();
    expect(band.querySelector(".band-add-sev")).toBeTruthy();                      // per-tier + Severity
    expect((band.querySelector(".band-cond .tgl-what") as unknown as { disabled: boolean }).disabled).toBe(true); // metric locked
    (band.querySelector(".band-cond .tgl-threshold") as unknown as { value: string }).value = "95"; // editable value
    (band.querySelector(".band-severity") as unknown as { value: string }).value = "critical";
    expect((doc.querySelector("#aw-band-notify") as unknown as { style: { display: string } }).style.display).toBe("block");
    expect((doc.querySelector("#aw-bn-increase") as unknown as { checked: boolean }).checked).toBe(true);
    expect((doc.querySelector("#aw-bn-decrease") as unknown as { checked: boolean }).checked).toBe(false);

    // "Sustained for" is per TIER: every added tier carries its own input, and
    // the base tier's moves INSIDE the base condition group so it reads as that
    // tier's setting rather than a rule-wide one sitting between the tiers.
    expect(band.querySelector(".band-duration")).toBeTruthy();
    expect(doc.querySelector("#aw-trig-root .scg-group > .aw-dur #tf-duration-min")).toBeTruthy();
    (band.querySelector(".band-duration") as unknown as { value: string }).value = "5";
  });

  it("step 4 shows the default-checked 'trigger no longer true' checkbox; step 6 lists affected devices", async () => {
    // Fill the leaf threshold so step 3 validates.
    (doc.querySelector("#aw-trig-root .tgl-threshold") as unknown as { value: string }).value = "90";
    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(toastErrors).toEqual([]);
    expect(doc.querySelector("#aw-step-4.visible")).toBeTruthy();
    const autoCb = doc.querySelector("#aw-reset-auto") as unknown as { checked: boolean };
    expect(autoCb).toBeTruthy();
    expect(autoCb.checked).toBe(true);
    // Single-condition trigger → hysteresis extras available under the checkbox.
    expect(doc.querySelector("#aw-hyst-enable")).toBeTruthy();

    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(doc.querySelector("#aw-step-5.visible")).toBeTruthy();
    expect(doc.querySelector("#aw-summary")).toBeFalsy(); // summary moved to step 6

    // The mandatory in-app card leads the Actions step: not an .aw-action row
    // (so it can't be collected/removed) and carries the moved message
    // template. It covers the ALERT only — every delivery row, the escalation
    // sweep and acknowledge/clear key on Notification.id, so it genuinely
    // can't be removed. The audit Event moved OUT to a removable
    // "Create an Event" action in the list below.
    const inapp = doc.querySelector("#aw-step-5 #aw-inapp-card")!;
    expect(inapp).toBeTruthy();
    expect(inapp.classList.contains("aw-action")).toBe(false);
    expect(inapp.querySelector("#aw-msg")).toBeTruthy();
    expect(inapp.textContent).toContain("in-app alert (always happens)");
    expect(inapp.textContent).not.toContain("event + in-app alert");
    expect(inapp.querySelector(".aw-action-remove")).toBeFalsy();

    // ...and the Event IS a removable action row, present by default.
    const eventRow = Array.from(doc.querySelectorAll("#aw-step-5 .aw-action")).find(
      (r) => (r.querySelector(".aw-action-type") as HTMLSelectElement | null)?.value === "event",
    );
    expect(eventRow).toBeTruthy();
    expect(eventRow!.querySelector(".aw-action-remove")).toBeTruthy();
    expect(eventRow!.textContent).toContain("notification.triggered");
    // An audit Event is instantaneous — no chain to chase, and the server
    // schema gives it no escalation key.
    expect(eventRow!.querySelector(":scope > .aw-esc-sec")).toBeFalsy();

    // Escalation is PER ITEM now: the mandatory card hosts the alert's
    // (rule-level) chain, each action row hosts its own. The old bottom
    // escalation box is gone entirely.
    expect(doc.querySelector("#aw-esc-enable")).toBeFalsy();
    expect(doc.querySelector("#aw-esc-add")).toBeFalsy();
    expect(doc.querySelector("#aw-esc-tiers")).toBeFalsy();
    const cardEsc = doc.querySelector("#aw-inapp-card .aw-esc-sec")!;
    expect(cardEsc).toBeTruthy();
    expect(cardEsc.querySelector(".aesc-add")!.textContent).toContain("Escalate if unhandled");
    expect((cardEsc.querySelector(".aesc-config") as unknown as { style: { display: string } }).style.display).toBe("none");
    (cardEsc.querySelector(".aesc-add") as unknown as { click: () => void }).click();
    const tier = cardEsc.querySelector(".aesc-tiers .aw-tier")!;
    expect(tier.querySelector(".tier-after")).toBeTruthy(); // minutes-before field
    expect(tier.querySelector(".tier-actions .aw-action")).toBeTruthy(); // seeded notify action
    expect(tier.querySelector(".na-channel")).toBeTruthy(); // channel select → recipients render from it
    // Recipient sources on an EMAIL channel are all pills in the To field —
    // device-region and asset-contacts became recipients you can see rather than
    // checkboxes beside the field (the checkbox survives only on Web Push, which
    // has no token field to hold a pill). Legacy scope-region renders only on
    // actions that already carry it.
    expect(tier.querySelector(".na-device-region")).toBeFalsy();
    expect(tier.querySelector(".na-asset-contacts")).toBeFalsy();
    expect(tier.querySelector(".na-scope-region")).toBeFalsy();
    expect(tier.querySelector('.na-recip-box[data-field="to"]')).toBeTruthy();
    // No chains inside chains: the tier-hosted action row has no footer.
    expect(tier.querySelector(".tier-actions .aw-action .aw-esc-sec")).toBeFalsy();
    expect((cardEsc.querySelector(".aesc-config") as unknown as { style: { display: string } }).style.display).toBe("block");
    (tier.querySelector(".tier-remove") as unknown as { click: () => void }).click();
    expect(cardEsc.querySelector(".aesc-tiers .aw-tier")).toBeFalsy();
    expect((cardEsc.querySelector(".aesc-config") as unknown as { style: { display: string } }).style.display).toBe("none");
    // Band editor is NOT on step 5 (it moved to step 3, with the trigger).
    expect(doc.querySelector("#aw-step-5 #aw-bands-section")).toBeFalsy();

    // Per-severity actions are OPT-IN, mirroring the trigger step's
    // multi-severity checkbox: off by default, so one action list runs at every
    // severity and the per-tier sections stay out of the way.
    const win5 = g.window as InstanceType<typeof Window>;
    const perSevCb = doc.querySelector("#aw-band-actions-multi") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void };
    expect(perSevCb).toBeTruthy();
    expect(perSevCb.checked).toBe(false);
    expect((doc.querySelector("#aw-step-5 .aw-band-actions") as unknown as { style: { display: string } }).style.display).toBe("none");
    perSevCb.checked = true;
    perSevCb.dispatchEvent(new win5.Event("change", { bubbles: true }));
    expect((doc.querySelector("#aw-step-5 .aw-band-actions") as unknown as { style: { display: string } }).style.display).toBe("");

    // Multi-severity carries into Actions: a per-severity section per band,
    // whose action rows get their own "Escalate if unhandled" footer.
    const bandSec = doc.querySelector("#aw-step-5 .aw-band-actions")!;
    expect(bandSec).toBeTruthy();
    expect(bandSec.textContent).toContain("critical");
    expect(bandSec.textContent).toContain("base actions"); // empty-band fallback note
    (bandSec.querySelector(".ba-add") as unknown as { click: () => void }).click();
    const bandAction = bandSec.querySelector(".ba-actions .aw-action")!;
    expect(bandAction).toBeTruthy();
    expect(bandAction.querySelector(".aw-esc-sec .aesc-add")).toBeTruthy(); // per-action chain
    // Top-level action rows are escalatable too. Take the LAST row — the one
    // just added: the first is the default audit-Event action, which
    // deliberately has no escalation footer.
    (doc.querySelector("#aw-add-action") as unknown as { click: () => void }).click();
    const baseRows = doc.querySelectorAll("#aw-actions .aw-action");
    const baseAction = baseRows[baseRows.length - 1]!;
    expect(baseAction.querySelector(".aw-esc-sec .aesc-add")).toBeTruthy();
    // Remove both again so step-5 validation (notify needs a recipient) passes.
    (bandAction.querySelector(".aw-action-remove") as unknown as { click: () => void }).click();
    (baseAction.querySelector(".aw-action-remove") as unknown as { click: () => void }).click();

    // "When this resets" — the list that makes a recovery expressible at all.
    // It starts mirroring the trigger's notify actions, so telling the same
    // people it came back costs nothing.
    const resetCard = doc.querySelector("#aw-step-5 #aw-reset-card")!;
    expect(resetCard).toBeTruthy();
    expect((doc.querySelector("#aw-reset-actions-on") as unknown as { checked: boolean }).checked).toBe(true);
    (doc.querySelector("#aw-add-action") as unknown as { click: () => void }).click();
    const newNotify = Array.from(doc.querySelectorAll("#aw-actions .aw-action")).pop()!;
    const chanSel = newNotify.querySelector(".na-channel") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    chanSel.value = "c1";
    chanSel.dispatchEvent(new win5.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(doc.querySelector("#aw-reset-actions .aw-action")).toBeTruthy();
    expect(doc.querySelector("#aw-reset-mirror-note")!.textContent).toContain("Following your notify actions");
    // Clean up so step-5 validation (a notify needs a recipient) still passes.
    (newNotify.querySelector(".aw-action-remove") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 10));

    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(doc.querySelector("#aw-step-6.visible")).toBeTruthy();
    expect(doc.querySelector("#aw-summary")).toBeTruthy();
    expect(doc.querySelector("#aw-summary")!.textContent).toContain("critical"); // band (added on step 3) in summary
    const affected = doc.querySelector("#aw-affected")!;
    expect(affected.textContent).toContain("3"); // stubbed preview totalEvaluated
    expect(toastErrors).toEqual([]);
  });

  it("step 6 offers a test per delivery destination, defaulting to 'me only'", async () => {
    const block = doc.querySelector("#aw-test-delivery")!;
    expect(block).toBeTruthy();

    // "Send to me only" must be the default — a mis-aimed press otherwise
    // emails the automation's real recipient list.
    const self = doc.querySelector('input[name="aw-test-to"][value="self"]') as unknown as { checked: boolean };
    expect(self.checked).toBe(true);
    expect((doc.querySelector("#aw-test-real-warn") as unknown as { style: { display: string } }).style.display).toBe("none");

    // The draft carries the default audit-Event action, so the Event test is
    // offered; api_call/script actions never are (the server refuses to run
    // them from a button, so a button would be a lie).
    const labels = Array.from(doc.querySelectorAll(".awtd-btn")).map((b) => b.textContent);
    expect(labels).toContain("Write a test Event");
    expect(labels.join(" ")).not.toMatch(/script|API/i);

    // Picking "real recipients" reveals the warning.
    const win6 = g.window as InstanceType<typeof Window>;
    const real = doc.querySelector('input[name="aw-test-to"][value="recipients"]') as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void };
    real.checked = true;
    real.dispatchEvent(new win6.Event("change", { bubbles: true }));
    expect((doc.querySelector("#aw-test-real-warn") as unknown as { style: { display: string } }).style.display).toBe("");
  });

  it("edit-mode round-trip: per-action escalation, band actions, device-region and the moved template survive save", async () => {
    // Fresh document — the previous wizard's modal would duplicate every id.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const chain = { stopOn: "clear", tiers: [{ afterMin: 20, actions: [{ type: "api_call", method: "POST", url: "https://pager.example.com/x", timeoutSec: 15 }] }] };
    const rule = {
      id: "r-edit",
      name: "Hot CPU",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto", clearThreshold: 75 },
      cooldownSec: null,
      messageTemplate: "{asset} cpu {value}",
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true, escalation: chain }],
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 15, actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.com"] }] }] },
      severityBands: [{ threshold: 95, severity: "critical", actions: [{ type: "api_call", method: "POST", url: "https://x.example.com/crit", timeoutSec: 15 }] }],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
    };
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)(rule);
    expect(toastErrors).toEqual([]);
    // Save straight from step 1 (edit mode): steps 4-6 were never rendered, so
    // the payload comes from the hydrated draft — the exact data-loss surface
    // this test pins.
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    expect(savedPayloads).toHaveLength(1);
    const p = savedPayloads[0]! as Record<string, any>;
    expect(p.messageTemplate).toBe("{asset} cpu {value}");
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0].recipientDeviceRegion).toBe(true);
    expect(p.actions[0].escalation).toEqual(chain);
    expect(p.escalation).toEqual(rule.escalation);
    expect(p.severityBands).toHaveLength(1);
    expect(p.severityBands[0].actions).toEqual(rule.severityBands[0].actions);
    expect(p.bandNotify).toEqual(rule.bandNotify);
    // And the payload passes the real server-side schema.
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("severity blocks fold, and the fold survives a re-render", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const w = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-fold",
      name: "Fold",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">=", threshold: 80, forDurationSec: 300 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.com"] }],
      severityBands: [
        { threshold: 90, severity: "serious", actions: [] },
        { threshold: 95, severity: "critical", actions: [{ type: "event" }] },
      ],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
    });

    // ── Step 3: each tier folds ──
    (doc.querySelector('.stepper-step[data-step="3"]') as unknown as { click: () => void }).click();
    // The BASE block folds too — it was the one severity block without a
    // chevron, which made it read as a different kind of thing.
    const base = doc.querySelector("#aw-trig-root > .scg-group")!;
    expect(base.getAttribute("data-collapse-key")).toBe("t3:base");
    expect(base.querySelector(":scope > div > .aw-collapse")).toBeTruthy();
    const baseParts = Array.from(base.querySelectorAll(":scope > .aw-collapse-part"));
    expect(baseParts.length).toBeGreaterThan(0);
    (base.querySelector("[data-collapse]") as unknown as { dispatchEvent: (e: unknown) => void })
      .dispatchEvent(new w.Event("click", { bubbles: true }));
    // Its parts hide in place rather than being moved into a wrapper — moving
    // .scg-children would break tgCollectGroup.
    baseParts.forEach((p) => {
      expect((p as unknown as { style: { display: string } }).style.display).toBe("none");
    });
    expect((base.querySelector(".aw-collapse-summary") as unknown as { textContent: string }).textContent)
      .toContain("80");
    (base.querySelector("[data-collapse]") as unknown as { dispatchEvent: (e: unknown) => void })
      .dispatchEvent(new w.Event("click", { bubbles: true }));

    const tiers = Array.from(doc.querySelectorAll("#aw-step-3 .aw-band"));
    expect(tiers.length).toBe(2);
    // Keyed by SEVERITY, not index — removing a tier must not slide another
    // tier's fold state onto it.
    expect(tiers.map((t) => t.getAttribute("data-collapse-key"))).toEqual(["t3:serious", "t3:critical"]);

    const tier = tiers[1]!;
    const body = tier.querySelector(".aw-collapse-body") as unknown as { style: { display: string } };
    const summary = tier.querySelector(".aw-collapse-summary") as unknown as
      { style: { display: string }; textContent: string };
    expect(body.style.display).not.toBe("none");
    // The summary describes the tier from its own controls, so a folded block
    // still says what it does.
    expect(summary.textContent).toContain("95");

    (tier.querySelector("[data-collapse]") as unknown as { dispatchEvent: (e: unknown) => void })
      .dispatchEvent(new w.Event("click", { bubbles: true }));
    expect(body.style.display).toBe("none");
    expect(summary.style.display).not.toBe("none");
    // The base tier is untouched by folding a band.
    expect((tiers[0]!.querySelector(".aw-collapse-body") as unknown as { style: { display: string } }).style.display)
      .not.toBe("none");

    // ── Step 5: per-severity action sections fold, and step 3's fold survived
    // the panel renders in between (the state is keyed, not held on the node) ──
    (doc.querySelector('.stepper-step[data-step="5"]') as unknown as { click: () => void }).click();
    const multi = doc.querySelector("#aw-band-actions-multi") as unknown as
      { checked: boolean; dispatchEvent: (e: unknown) => void };
    if (!multi.checked) {
      multi.checked = true;
      multi.dispatchEvent(new w.Event("change", { bubbles: true }));
    }
    const sections = Array.from(doc.querySelectorAll("#aw-step-5 [data-collapse-key]"));
    expect(sections.map((x) => x.getAttribute("data-collapse-key")))
      .toEqual(["t5:base", "t5:serious", "t5:critical"]);
    // A band with no actions of its own says so while folded — that's the state
    // that falls back to the base actions.
    const serious = sections[1]!;
    expect((serious.querySelector(".aw-collapse-summary") as unknown as { textContent: string }).textContent)
      .toMatch(/no actions of its own/i);

    (doc.querySelector('.stepper-step[data-step="3"]') as unknown as { click: () => void }).click();
    const criticalAgain = Array.from(doc.querySelectorAll("#aw-step-3 .aw-band"))
      .find((t) => t.getAttribute("data-collapse-key") === "t3:critical")!;
    expect((criticalAgain.querySelector(".aw-collapse-body") as unknown as { style: { display: string } }).style.display)
      .toBe("none");

    // Folding changes nothing about what saves.
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const p = savedPayloads[0]! as Record<string, any>;
    expect(p.severityBands).toHaveLength(2);
    expect(p.severityBands.map((b: { severity: string }) => b.severity)).toEqual(["serious", "critical"]);
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("email customization is a checkbox: unchecked stores NO templates", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-mail",
      name: "Mail",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.com"] }],
    });
    (doc.querySelector('.stepper-step[data-step="5"]') as unknown as { click: () => void }).click();

    const comp = doc.querySelector("#aw-step-5 .na-comp")!;
    const enable = comp.querySelector(".na-comp-enable") as unknown as
      { checked: boolean; dispatchEvent: (e: unknown) => void };
    // A stored action carrying no templates opens UNCHECKED — it follows the
    // shared default rather than owning a frozen copy of it.
    expect(enable.checked).toBe(false);
    expect((comp.querySelector(".na-comp-body") as unknown as { style: { display: string } }).style.display)
      .toBe("none");
    // The old disclosure is gone.
    expect(doc.querySelector("#aw-step-5 details.na-comp")).toBeFalsy();
    // ...but the fields ARE prefilled from the default, so ticking shows real text.
    expect(((comp.querySelector(".na-subject") as unknown as { value: string }).value || "").length)
      .toBeGreaterThan(0);

    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const p = savedPayloads[0]! as Record<string, any>;
    const comp0 = p.actions[0].emailComposition;
    // No templates collected while unchecked (cc/bcc would still ride here).
    expect(comp0?.subjectTemplate).toBeUndefined();
    expect(comp0?.bodyTextTemplate).toBeUndefined();
    expect(comp0?.bodyHtmlTemplate).toBeUndefined();
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("checked, it stores BOTH bodies; the Plain/HTML control is a view switch", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-mail2",
      name: "Mail2",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      // Carries its own subject → the box opens checked.
      actions: [{
        type: "notify",
        channelId: "c1",
        addresses: ["noc@example.com"],
        emailComposition: { subjectTemplate: "MINE {asset}" },
      }],
    });
    (doc.querySelector('.stepper-step[data-step="5"]') as unknown as { click: () => void }).click();

    const comp = doc.querySelector("#aw-step-5 .na-comp")!;
    expect((comp.querySelector(".na-comp-enable") as unknown as { checked: boolean }).checked).toBe(true);
    expect((comp.querySelector(".na-comp-body") as unknown as { style: { display: string } }).style.display)
      .not.toBe("none");
    // The "Send an HTML body" checkbox is gone — it never controlled whether
    // HTML was sent (a blank template already fell back to the default HTML).
    expect(comp.querySelector(".na-html-enable")).toBeFalsy();

    const text = comp.querySelector('[data-body-mode="text"]') as unknown as
      { style: { display: string }; value: string };
    const html = comp.querySelector('[data-body-mode="html"]') as unknown as
      { style: { display: string }; value: string };
    expect(text.style.display).not.toBe("none");
    expect(html.style.display).toBe("none");
    // Variables are visible in both modes rather than hidden behind a second
    // disclosure — the palette sits above the editor.
    expect(comp.querySelectorAll(".tpl-token").length).toBeGreaterThan(0);

    const w = g.window as InstanceType<typeof Window>;
    const modes = Array.from(comp.querySelectorAll(".na-mode"));
    (modes[1] as unknown as { dispatchEvent: (e: unknown) => void })
      .dispatchEvent(new w.Event("click", { bubbles: true }));
    expect(text.style.display).toBe("none");
    expect(html.style.display).not.toBe("none");
    // A view switch touches no value.
    text.value = "PLAIN {asset}";
    html.value = "<p>HTML {asset}</p>";

    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const c = (savedPayloads[0]! as Record<string, any>).actions[0].emailComposition;
    // BOTH bodies stored: the toggle chose which one was on screen, not which
    // one gets sent.
    expect(c.bodyTextTemplate).toBe("PLAIN {asset}");
    expect(c.bodyHtmlTemplate).toBe("<p>HTML {asset}</p>");
    expect(() => ruleInputSchema.parse(savedPayloads[0])).not.toThrow();
  });

  it("per-tier sustain rides the payload; unticking per-severity actions strips them", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const win = g.window as InstanceType<typeof Window>;
    const rule = {
      id: "r-sustain",
      // cpuPct, not packet loss: per-tier sustain is the thing under test, and a
      // windowed-ratio metric deliberately has no per-tier hold (business rule 29).
      name: "High CPU",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 5, forDurationSec: 1800 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: [
        { threshold: 15, severity: "serious", forDurationSec: 900, actions: [{ type: "api_call", method: "POST", url: "https://x.example.com/s", timeoutSec: 15 }] },
        { threshold: 25, severity: "critical", forDurationSec: 0, actions: [] },
      ],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
    };
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)(rule);
    for (let i = 0; i < 4; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(toastErrors).toEqual([]);
    expect(doc.querySelector("#aw-step-5.visible")).toBeTruthy();
    // Every tier kept its own "Sustained for" through the step-3 round trip.
    const durs = Array.from(doc.querySelectorAll("#aw-bands .band-duration")).map((el) => (el as unknown as { value: string }).value);
    expect(durs).toEqual(["15", "0"]);
    expect((doc.querySelector("#tf-duration-min") as unknown as { value: string }).value).toBe("30");
    // The stored rule carries per-band actions, so the toggle opens ON.
    const perSevCb = doc.querySelector("#aw-band-actions-multi") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void };
    expect(perSevCb.checked).toBe(true);
    perSevCb.checked = false;
    perSevCb.dispatchEvent(new win.Event("change", { bubbles: true }));

    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const p = savedPayloads[0]! as Record<string, any>;
    expect(p.trigger.forDurationSec).toBe(1800);
    expect(p.severityBands.map((b: any) => b.forDurationSec)).toEqual([900, 0]);
    // Toggle off ⇒ bands save bare and the server runs the base actions at
    // every severity.
    expect(p.severityBands[0].actions).toEqual([]);
    expect(p.severity).toBe("warning");
    expect(p.severityBands.map((b: any) => b.severity)).toEqual(["serious", "critical"]);
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("changing the base condition's sampling re-mirrors onto every existing severity tier", async () => {
    // Tiers SHARE the base's metric / aggregation / dimension filters (business
    // rule 19) — collectBands takes only their operator + threshold. A tier left
    // displaying the sampling it was created with told the operator the change
    // hadn't applied, and deleting + re-adding every tier was the only way to
    // make the display agree with what would actually be saved.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const win = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-resample",
      name: "Packet loss",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "probeLossPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 5, forDurationSec: 300 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: [
        { threshold: 15, severity: "serious", forDurationSec: 300, actions: [] },
        { threshold: 25, severity: "critical", operator: ">=", forDurationSec: 60, actions: [] },
      ],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(doc.querySelector("#aw-step-3.visible")).toBeTruthy();
    const bandAggs = () =>
      Array.from(doc.querySelectorAll("#aw-bands .band-cond .tgl-agg")).map((el) => (el as unknown as { value: string }).value);
    expect(bandAggs()).toEqual(["latest", "latest"]);

    // Base latest → median: every tier follows, and each keeps its own value +
    // its own operator override (only the SAMPLING is shared).
    const agg = doc.querySelector("#aw-trig-root .tgl-agg") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    agg.value = "median";
    agg.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect(bandAggs()).toEqual(["median", "median"]);
    expect(Array.from(doc.querySelectorAll("#aw-bands .band-cond .tgl-threshold")).map((el) => (el as unknown as { value: string }).value))
      .toEqual(["15", "25"]);
    expect(Array.from(doc.querySelectorAll("#aw-bands .band-cond .tgl-op")).map((el) => (el as unknown as { value: string }).value))
      .toEqual([">", ">="]);
    // Still locked after the re-render — a tier's sampling isn't editable.
    expect((doc.querySelector("#aw-bands .band-cond .tgl-agg") as unknown as { disabled: boolean }).disabled).toBe(true);
    expect((doc.querySelector("#aw-bands .band-cond .tgl-what") as unknown as { disabled: boolean }).disabled).toBe(true);

    // The metric follows too (the same lie, one control over).
    const what = doc.querySelector("#aw-trig-root .tgl-what") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    what.value = "m:cpuPct";
    what.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect(Array.from(doc.querySelectorAll("#aw-bands .band-cond .tgl-what")).map((el) => (el as unknown as { value: string }).value))
      .toEqual(["m:cpuPct", "m:cpuPct"]);
    // Re-rendering a row from a metric swap resets the base's own aggregation to
    // `latest`; the tiers mirror that too rather than keeping a stale median.
    expect(bandAggs()).toEqual(["latest", "latest"]);
    expect(toastErrors).toEqual([]);
  });

  it("sensor-name filter is a picker: offers the fleet's own sensor names, filters as you type, and flags one nothing reports", async () => {
    // A sensor name ("CPU ON-DIE Temperature") is not guessable, and the
    // dimension is a substring PATTERN the server can't reject — so a typo used
    // to save cleanly and then never match a reading. The control has to both
    // offer what the scoped devices report and say whether what's typed hits.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const win = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-sensor",
      name: "Hot sensor",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: {
        type: "asset_metric", metric: "hwSensorValue", aggregation: "latest", windowSec: 0,
        operator: ">=", threshold: 70, dimensionFilter: { sensorClass: "temperature" },
      },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: null,
      bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(doc.querySelector("#aw-step-3.visible")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30)); // dimension-values fetch settles

    // Sensor CLASS is a closed enum → a select of what's reported, device counts
    // included. Sensor NAME is the pattern → a combobox, not a bare text box.
    const cls = doc.querySelector('#aw-trig-root select.tgl-dim[data-dim="sensorClass"]') as unknown as { value: string; textContent: string };
    expect(cls.value).toBe("temperature");
    expect(cls.textContent).toContain("temperature (2)");
    const combo = doc.querySelector("#aw-trig-root .aw-combo-dim")!;
    const input = combo.querySelector('input.tgl-dim[data-dim="sensorNamePattern"]') as unknown as
      { value: string; click: () => void; dispatchEvent: (e: unknown) => void };
    expect(input).toBeTruthy();
    const cue = () => (combo.nextElementSibling as unknown as { textContent: string }).textContent;
    const items = () => Array.from(combo.querySelectorAll(".aw-suggest.open .aw-suggest-item"));

    // Click opens the full list of sensors the selected devices actually report.
    input.click();
    expect(items().map((i) => i.textContent!.trim())).toEqual([
      "CPU ON-DIE Temperature (2)", "CPU Fan (2)", "DTS CPU0 (1)",
    ]);

    // Typing filters by SUBSTRING (mid-string "fan" — a datalist's prefix match
    // showed nothing) and the cue says how much it selects.
    input.value = "fan";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(items().map((i) => i.textContent!.trim())).toEqual(["CPU Fan (2)"]);
    expect(cue()).toBe("✓ matches 1 of 3 reported hardware sensors");

    // A plausible-but-wrong name is called out rather than silently accepted.
    input.value = "CPU ON DIE";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(items()).toHaveLength(0);
    expect(combo.querySelector(".aw-suggest.open .aw-suggest-empty")!.textContent).toContain("None of the 3 reported hardware sensors");
    expect(cue()).toContain("never fire");

    // Picking a suggestion fills the input exactly and confirms the pick.
    input.value = "on-die";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    items()[0]!.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
    expect(input.value).toBe("CPU ON-DIE Temperature");
    expect(combo.querySelector(".aw-suggest.open")).toBeFalsy(); // closed after pick
    expect(cue()).toBe("✓ exact match");
    expect(toastErrors).toEqual([]);

    // Keyboard: ArrowDown highlights, Enter picks, Escape closes without
    // touching the value (and must not bubble out and close the modal).
    input.value = "cpu";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(combo.querySelector(".aw-suggest-item.active")!.getAttribute("data-val")).toBe("CPU Fan");
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(input.value).toBe("CPU Fan");
    expect(combo.querySelector(".aw-suggest.open")).toBeFalsy();
    input.click();
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(combo.querySelector(".aw-suggest.open")).toBeFalsy();
    expect(input.value).toBe("CPU Fan");
    expect(doc.querySelector(".modal")).toBeTruthy();

    // Back to the exact sensor for the save assertion below.
    input.value = "CPU ON-DIE Temperature";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    // …and the picked value is what saves.
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    const p = savedPayloads[0]! as Record<string, any>;
    expect(p.trigger.dimensionFilter).toEqual({ sensorClass: "temperature", sensorNamePattern: "CPU ON-DIE Temperature" });
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("the condition row has no window box: 'Sustained for' IS the aggregation window, mandatory and starred", async () => {
    // Two time inputs meaning almost the same thing ("avg over 300 sec" +
    // "sustained for N minutes") is what this collapses. The duration field is
    // the trigger's one time knob: the measurement window for avg/median/min/max
    // (so no sustain on top), the sustain clock for `latest`.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const win = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-window",
      name: "Hot CPU",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: null,
      bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(doc.querySelector("#aw-step-3.visible")).toBeTruthy();

    // The per-condition window control is gone; the aggregation select remains.
    expect(doc.querySelector("#aw-trig-root .tgl-window")).toBeFalsy();
    expect(doc.querySelector("#aw-trig-root .tgl-agg")).toBeTruthy();
    // median joined the vocabulary.
    const agg = doc.querySelector("#aw-trig-root .tgl-agg") as unknown as { value: string; textContent: string; dispatchEvent: (e: unknown) => void };
    expect(agg.value).toBe("avg");
    expect(agg.textContent).toContain("median");

    // A stored aggregation window renders as the duration (300s → 5 min) and the
    // field is marked required.
    const dur = doc.querySelector("#tf-duration-min") as unknown as { value: string; placeholder: string; dispatchEvent: (e: unknown) => void };
    expect(dur.value).toBe("5");
    const star = () => (doc.querySelector(".aw-dur .aw-dur-req") as unknown as { style: { display: string } }).style.display;
    expect(star()).not.toBe("none");

    // Switch to median + 10 minutes: the window follows the duration and no
    // sustain clock is stacked on top of it.
    agg.value = "median";
    agg.dispatchEvent(new win.Event("change", { bubbles: true }));
    dur.value = "10";
    dur.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(star()).not.toBe("none");
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    expect(savedPayloads).toHaveLength(1);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.trigger.aggregation).toBe("median");
    expect(saved.trigger.windowSec).toBe(600);
    expect(saved.trigger.forDurationSec).toBe(0);
    expect(() => ruleInputSchema.parse(saved)).not.toThrow();

    // Back on `latest` the same field is the optional sustain again — no
    // asterisk, and the minutes land on forDurationSec instead of the window.
    agg.value = "latest";
    agg.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect(star()).toBe("none");
    expect(dur.placeholder).toContain("0 = fire as soon as");
  });

  it("a `latest` condition's minutes stay the sustain clock, not a window", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-sustain-only",
      // Again cpuPct: `latest` keeps its sustain clock, but packet loss is always
      // a window and is covered by its own tests below.
      name: "High CPU",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 5, forDurationSec: 600 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: null,
      bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((doc.querySelector("#tf-duration-min") as unknown as { value: string }).value).toBe("10");
    expect((doc.querySelector(".aw-dur .aw-dur-req") as unknown as { style: { display: string } }).style.display).toBe("none");
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.trigger.windowSec).toBe(0);
    expect(saved.trigger.forDurationSec).toBe(600);
  });

  it("an aggregation with the period left at 0 is refused, not measured over a default lookback", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const win = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-no-window",
      name: "Hot CPU",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: null,
      bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    const dur = doc.querySelector("#tf-duration-min") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    dur.value = "0";
    dur.dispatchEvent(new win.Event("input", { bubbles: true }));
    toastErrors.length = 0;
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(savedPayloads).toHaveLength(0);
    expect(toastErrors.join(" ")).toContain("Sustained for (minutes)");
  });

  it("the formula block under the sentence moves the minutes when the aggregation changes", async () => {
    doc.body.innerHTML = "";
    const win = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-formula",
      name: "Loss",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "probeLossPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 5, forDurationSec: 600 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: null,
      bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    const box = doc.querySelector("#aw-trigger-formula") as unknown as { style: { display: string }; textContent: string };
    // `latest`: the minutes are the hold, outside the term, and there's no window
    // argument at all — nothing for the sampling floor to qualify.
    expect(box.style.display).not.toBe("none");
    expect(box.textContent).toContain("latest(");
    expect(box.textContent).toContain("held 10m");
    expect(box.textContent).not.toContain("floor");
    // The formula and the sentence are twins of one draft, so they must name the
    // same severity — asserted against each other rather than against a literal.
    const sentence = (doc.querySelector("#aw-trigger-sentence") as unknown as { textContent: string }).textContent;
    const sev = (box.textContent.split("⇒ ")[1] || "").trim();
    expect(sev).toBeTruthy();
    expect(sentence).toContain(sev);

    // Switching to an aggregation moves the same minutes INSIDE the term, and
    // 10 minutes is under the engine's 15-minute floor, so the note appears.
    const agg = doc.querySelector(".scr-row .tgl-agg") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    agg.value = "median";
    agg.dispatchEvent(new win.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(box.textContent).toContain("median(");
    expect(box.textContent).toContain("10m)");
    expect(box.textContent).not.toContain("held");
    expect(box.textContent).toContain("floor");

    // An event trigger computes no value — the block hides rather than showing
    // an empty formula.
    const type = doc.querySelector("#aw-trigger-type") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    type.value = "event";
    type.dispatchEvent(new win.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect((doc.querySelector("#aw-trigger-formula") as unknown as { style: { display: string } }).style.display).toBe("none");
  });
  // -- Packet loss: History, not "sustained for" (business rule 29) -----------
  // probeLossPct is a ratio over its window, so the wizard's one time field IS
  // the measurement period. Before this, `latest` + 60 minutes stored a 60-minute
  // HOLD while the engine measured over its 15-minute floor -- the automation
  // said one thing and did another.
  //
  // ENVIRONMENT NOTE: happy-dom mis-parses `<option selected>` -- a select whose
  // selected option isn't the first reports the option AFTER it -- so a stored
  // metric doesn't survive into `select.value` the way it does in a browser
  // (which is why renderBandCond assigns select values instead of trusting the
  // markup). These tests therefore PICK the metric the way an operator would,
  // with a change event, and assert from there.
  async function pickMetric(metric: string) {
    const win = g.window as InstanceType<typeof Window>;
    const sel = doc.querySelector("#aw-trig-root .tgl-what") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    sel.value = "m:" + metric;
    sel.dispatchEvent(new win.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    // The change handler re-renders the row from the model, which re-introduces
    // the happy-dom parse bug on the freshly-written markup — so re-pin the new
    // select (no event this time; the row is already built for this metric).
    const after = doc.querySelector("#aw-trig-root .tgl-what") as unknown as { value: string };
    after.value = "m:" + metric;
    const agg = doc.querySelector("#aw-trig-root .tgl-agg") as unknown as { value: string } | null;
    if (agg) agg.value = "latest";
    // Switching metric deliberately clears the threshold (a value for one metric
    // rarely means anything for another), so re-enter it — and let THAT event be
    // what re-runs the panel-level syncs, now that the metric select is pinned.
    const thr = doc.querySelector("#aw-trig-root .tgl-threshold") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    thr.value = "10";
    thr.dispatchEvent(new win.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
  }

  const LOSS_BASE = {
    description: null,
    enabled: true,
    severity: "warning",
    trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 10, forDurationSec: 0 },
    scope: { allAssets: true },
    cooldownSec: null,
    messageTemplate: null,
    actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
    escalation: null,
  };

  it("relabels the time field as History for packet loss and stamps it as the window", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      ...LOSS_BASE, id: "r-loss-history", name: "High packet loss",
      reset: { mode: "auto" }, severityBands: null, bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    await pickMetric("probeLossPct");

    // The field renames itself and becomes mandatory...
    const label = doc.querySelector(".aw-dur label") as unknown as { textContent: string };
    expect(label.textContent).toContain("History");
    expect(label.textContent).not.toContain("Sustained");
    expect((doc.querySelector(".aw-dur .aw-dur-req") as unknown as { style: { display: string } }).style.display).toBe("");
    // ...defaults rather than leaving a window the engine has to invent...
    expect((doc.querySelector("#tf-duration-min") as unknown as { value: string }).value).toBe("15");
    // ...and the aggregation control is hidden, since a ratio has nothing to aggregate.
    expect((doc.querySelector('#aw-trig-root .tgl-agg[data-ratio="1"]') as unknown as { style: { display: string } }).style.display).toBe("none");

    // An operator-typed 60 saves as the WINDOW, with no hold clock on top.
    (doc.querySelector("#tf-duration-min") as unknown as { value: string }).value = "60";
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.trigger.metric).toBe("probeLossPct");
    expect(saved.trigger.windowSec).toBe(3600);
    expect(saved.trigger.forDurationSec).toBe(0);
  });

  it("refuses a History shorter than the engine's minimum window", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      ...LOSS_BASE, id: "r-loss-short", name: "High packet loss",
      reset: { mode: "auto" }, severityBands: null, bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    await pickMetric("probeLossPct");
    (doc.querySelector("#tf-duration-min") as unknown as { value: string }).value = "2";
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    // Refused rather than quietly measured over the engine's floor.
    expect(savedPayloads.length).toBe(0);
    expect(toastErrors.join(" ")).toContain("History");
  });

  it("gives packet-loss severity tiers no hold clock of their own", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      ...LOSS_BASE, id: "r-loss-bands", name: "High packet loss",
      reset: { mode: "auto", clearThreshold: 5 },
      severityBands: [
        { threshold: 20, severity: "serious", actions: [] },
        { threshold: 30, severity: "critical", actions: [] },
      ],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    // A non-ratio metric keeps its per-tier hold boxes visible...
    const bandDurWraps = () => Array.from(doc.querySelectorAll("#aw-bands .band-duration"))
      .map((el) => ((el as unknown as { closest: (q: string) => { style: { display: string } } }).closest(".aw-dur")).style.display);
    expect(bandDurWraps().length).toBeGreaterThan(0);
    expect(bandDurWraps().every((d) => d !== "none")).toBe(true);
    await pickMetric("probeLossPct");
    // ...and switching to packet loss hides them: tiers share the History window.
    expect(bandDurWraps().every((d) => d === "none")).toBe(true);
    // The ladder itself survives, sharing that one window.
    (doc.querySelector("#tf-duration-min") as unknown as { value: string }).value = "15";
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.severityBands.map((b: any) => [b.threshold, b.severity])).toEqual([[20, "serious"], [30, "critical"]]);
    expect(saved.trigger.windowSec).toBe(900);
    expect(saved.severityBands.every((b: any) => !b.forDurationSec)).toBe(true);
  });
});
