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
import { buildSchemaCatalog } from "../../src/services/notificationTypes.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
let doc: Window["document"];
let toastErrors: string[];

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
      schema: async () => buildSchemaCatalog(),
      recipientUsers: async () => ({ users: [{ id: "u1", username: "op", displayName: "Op", email: "op@x.com" }] }),
      scopeOptions: async () => ({
        manufacturers: ["Fortinet Inc."],
        models: ["FGT-60F"],
        subnets: [{ id: "s1", name: "Mgmt", cidr: "10.20.0.0/24" }],
      }),
      preview: async () => ({ supported: true, totalEvaluated: 3, matches: [] }),
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
    // severity select carries the shared palette classes
    expect(doc.querySelector("#aw-severity.sev-select")).toBeTruthy();
    expect(doc.querySelectorAll("#aw-severity option.sev-critical").length).toBe(1);
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
    // Category select (device/host/event/change) + the tree with one leaf row.
    const cat = doc.querySelector("#aw-trigger-type") as unknown as { value: string };
    expect(cat.value).toBe("device");
    expect(doc.querySelector("#aw-trig-root .scg-group")).toBeTruthy();
    expect(doc.querySelectorAll("#aw-trig-root .scr-row").length).toBe(1);
    expect(doc.querySelector("#aw-trig-root .tgl-what")).toBeTruthy();
    expect(doc.querySelector("#aw-trig-root .tgl-threshold")).toBeTruthy();
    expect(doc.querySelector("#aw-trig-root .scr-row .aw-grip[draggable='true']")).toBeTruthy();
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

    // Escalation is button-based (no enable checkbox): adding an escalation
    // reveals the delay field, seeds a notify action (channel + recipients),
    // and shows the stop-condition select; removing it hides them again.
    expect(doc.querySelector("#aw-esc-enable")).toBeFalsy();
    const escAdd = doc.querySelector("#aw-esc-add")!;
    expect(escAdd.textContent).toContain("Add escalation");
    expect((doc.querySelector("#aw-esc-config") as unknown as { style: { display: string } }).style.display).toBe("none");
    (escAdd as unknown as { click: () => void }).click();
    const tier = doc.querySelector("#aw-esc-tiers .aw-tier")!;
    expect(tier.querySelector(".tier-after")).toBeTruthy(); // minutes-before field
    expect(tier.querySelector(".tier-actions .aw-action")).toBeTruthy(); // seeded notify action
    expect(tier.querySelector(".na-channel")).toBeTruthy(); // channel select → recipients render from it
    expect((doc.querySelector("#aw-esc-config") as unknown as { style: { display: string } }).style.display).toBe("block");
    (tier.querySelector(".tier-remove") as unknown as { click: () => void }).click();
    expect(doc.querySelector("#aw-esc-tiers .aw-tier")).toBeFalsy();
    expect((doc.querySelector("#aw-esc-config") as unknown as { style: { display: string } }).style.display).toBe("none");

    // Severity bands: the single-leaf trigger collapsed to an asset_metric, so
    // the band editor is present. Adding a tier reveals the notify policy.
    expect(doc.querySelector("#aw-bands-section")).toBeTruthy();
    expect((doc.querySelector("#aw-band-notify") as unknown as { style: { display: string } }).style.display).toBe("none");
    (doc.querySelector("#aw-band-add") as unknown as { click: () => void }).click();
    const band = doc.querySelector("#aw-bands .aw-band")!;
    expect(band).toBeTruthy();
    expect(band.querySelector(".band-copy")).toBeTruthy(); // copy-actions-from affordance
    (band.querySelector(".band-threshold") as unknown as { value: string }).value = "95";
    (band.querySelector(".band-severity") as unknown as { value: string }).value = "critical";
    expect((doc.querySelector("#aw-band-notify") as unknown as { style: { display: string } }).style.display).toBe("block");
    expect((doc.querySelector("#aw-bn-increase") as unknown as { checked: boolean }).checked).toBe(true);
    expect((doc.querySelector("#aw-bn-decrease") as unknown as { checked: boolean }).checked).toBe(false);

    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(doc.querySelector("#aw-step-6.visible")).toBeTruthy();
    expect(doc.querySelector("#aw-summary")).toBeTruthy();
    expect(doc.querySelector("#aw-summary")!.textContent).toContain("critical"); // band in summary
    const affected = doc.querySelector("#aw-affected")!;
    expect(affected.textContent).toContain("3"); // stubbed preview totalEvaluated
    expect(toastErrors).toEqual([]);
  });
});
