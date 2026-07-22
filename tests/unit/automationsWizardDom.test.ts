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
    expect(doc.querySelectorAll("#aw-stepper .stepper-step").length).toBe(5);
    expect(doc.querySelector("#aw-step-1.visible")).toBeTruthy();
    // severity select carries the shared palette classes
    expect(doc.querySelector("#aw-severity.sev-select")).toBeTruthy();
    expect(doc.querySelectorAll("#aw-severity option.sev-critical").length).toBe(1);
  });

  it("Next reaches step 2 and the condition builder is interactive", async () => {
    (doc.querySelector("#aw-name") as unknown as { value: string }).value = "smoke";
    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(doc.querySelector("#aw-step-2.visible")).toBeTruthy();
    expect(doc.querySelector("#aw-cond-root .scg-group")).toBeTruthy();
    expect(doc.querySelector("#aw-cond-root .scg-op")).toBeTruthy();

    (doc.querySelector("#aw-cond-root .scg-add-rule") as unknown as { click: () => void }).click();
    expect(doc.querySelector("#aw-cond-root .scr-row")).toBeTruthy();
    (doc.querySelector("#aw-cond-root .scg-add-group") as unknown as { click: () => void }).click();
    expect(doc.querySelectorAll("#aw-cond-root .scg-group").length).toBe(2);
    expect(toastErrors).toEqual([]);
  });
});
