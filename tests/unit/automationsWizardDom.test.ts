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
    // Recipient sources: device-region replaces the scope-region checkbox
    // (legacy scope-region renders only on actions that already carry it).
    expect(tier.querySelector(".na-device-region")).toBeTruthy();
    expect(tier.querySelector(".na-scope-region")).toBeFalsy();
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

    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(doc.querySelector("#aw-step-6.visible")).toBeTruthy();
    expect(doc.querySelector("#aw-summary")).toBeTruthy();
    expect(doc.querySelector("#aw-summary")!.textContent).toContain("critical"); // band (added on step 3) in summary
    const affected = doc.querySelector("#aw-affected")!;
    expect(affected.textContent).toContain("3"); // stubbed preview totalEvaluated
    expect(toastErrors).toEqual([]);
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

  it("per-tier sustain rides the payload; unticking per-severity actions strips them", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const win = g.window as InstanceType<typeof Window>;
    const rule = {
      id: "r-sustain",
      name: "Packet loss",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "probeLossPct", aggregation: "latest", windowSec: 900, operator: ">", threshold: 5, forDurationSec: 1800 },
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
});
