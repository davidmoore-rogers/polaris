import { describe, it, expect } from "vitest";
import {
  CHANGE_TYPES,
  CHANGE_TYPE_ACTIONS,
  CHANGE_TYPE_META,
} from "../../src/services/notificationTypes.js";

// The change-trigger vocabulary is three parallel structures: the enum the
// rule schema validates against, the action string the engine's event tail
// matches on, and the label the wizard renders. A key missing from either map
// produces an automation that silently never fires (no action) or an unlabeled
// picker row — neither fails loudly on its own.

describe("change trigger vocabulary", () => {
  it("maps every change type to an action", () => {
    for (const key of CHANGE_TYPES) {
      expect(CHANGE_TYPE_ACTIONS[key], `missing action for "${key}"`).toBeTruthy();
    }
  });

  it("labels every change type for the wizard", () => {
    for (const key of CHANGE_TYPES) {
      expect(CHANGE_TYPE_META[key], `missing label for "${key}"`).toBeTruthy();
    }
  });

  it("maps each change type to a distinct action", () => {
    const actions = CHANGE_TYPES.map((k) => CHANGE_TYPE_ACTIONS[k]);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("carries no action key that isn't a declared change type", () => {
    const declared = new Set<string>(CHANGE_TYPES);
    for (const key of Object.keys(CHANGE_TYPE_ACTIONS)) {
      expect(declared.has(key), `orphan action key "${key}"`).toBe(true);
    }
  });

  it("keeps the asset.*.changed family pointed at the unconditional events", () => {
    // These four differ from the change.* family: their events are written
    // unconditionally by the write sites (eventLogService builders) rather
    // than through subscription-gated maybeEmitChangeEvents. The picker entry
    // only selects an always-present event, so the action strings must match
    // what those builders emit.
    expect(CHANGE_TYPE_ACTIONS.firmware_changed).toBe("asset.firmware.changed");
    expect(CHANGE_TYPE_ACTIONS.switch_port_changed).toBe("asset.switch_port.changed");
    expect(CHANGE_TYPE_ACTIONS.wireless_ap_changed).toBe("asset.wireless_ap.changed");
    expect(CHANGE_TYPE_ACTIONS.gateway_firewall_changed).toBe("asset.gateway_firewall.changed");
  });
});
