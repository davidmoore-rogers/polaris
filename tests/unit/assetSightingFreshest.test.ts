import { describe, it, expect } from "vitest";
import { computeFreshestGateChanges } from "../../src/services/assetSightingService.js";

// Backs asset.gateway_firewall.changed. "Freshest sighting" is the same rule
// syncEndpointDependencyEdges uses to pick an endpoint's parent gate, so this
// tracks the value that actually drives dependency suppression.
//
// A gate move INSERTS a row (the unique key includes fortigateDevice) and
// nothing prunes the old one, so an asset accumulates a row per gate it has
// ever been behind — which is why the question is "which row is freshest",
// not "which row exists".

const t = (min: number) => new Date(Date.UTC(2026, 7, 20, 12, min, 0));

describe("computeFreshestGateChanges", () => {
  it("reports a clean takeover when the old gate falls silent", () => {
    const changes = computeFreshestGateChanges(
      [{ assetId: "a1", fortigateDevice: "GATE-A", lastSeen: t(0) }],
      [{ assetId: "a1", fortigateDevice: "GATE-B", seenAt: t(10) }],
    );
    expect(changes).toEqual([{ assetId: "a1", from: "GATE-A", to: "GATE-B" }]);
  });

  it("says nothing on a first sighting", () => {
    // No prior rows = Polaris learning where the device lives, not a move.
    expect(
      computeFreshestGateChanges([], [{ assetId: "a1", fortigateDevice: "GATE-A", seenAt: t(0) }]),
    ).toEqual([]);
  });

  it("says nothing when the incumbent gate is restated", () => {
    expect(
      computeFreshestGateChanges(
        [{ assetId: "a1", fortigateDevice: "GATE-A", lastSeen: t(0) }],
        [{ assetId: "a1", fortigateDevice: "GATE-A", seenAt: t(10) }],
      ),
    ).toEqual([]);
  });

  it("suppresses the dual-lease flap (takeover guard)", () => {
    // A device with a live lease on one gate and a not-yet-expired lease on
    // another has BOTH rows stamped to ~now every run. Without the guard the
    // freshest tie-flips every cycle and emits forever. Requiring the
    // incumbent to fall silent is what makes this reportable exactly once.
    const current = [
      { assetId: "a1", fortigateDevice: "GATE-A", lastSeen: t(0) },
      { assetId: "a1", fortigateDevice: "GATE-B", lastSeen: t(1) },
    ];
    const incoming = [
      { assetId: "a1", fortigateDevice: "GATE-A", seenAt: t(10) },
      { assetId: "a1", fortigateDevice: "GATE-B", seenAt: t(10) },
    ];
    expect(computeFreshestGateChanges(current, incoming)).toEqual([]);
  });

  it("treats an integration-prefixed device name as the same gate", () => {
    expect(
      computeFreshestGateChanges(
        [{ assetId: "a1", fortigateDevice: "CENTRALFMG1:GATE-A", lastSeen: t(0) }],
        [{ assetId: "a1", fortigateDevice: "GATE-A", seenAt: t(10) }],
      ),
    ).toEqual([]);
  });

  it("does not report when the incoming gate is older than the incumbent", () => {
    // A stale sighting for a gate the device left must not win the freshest slot.
    expect(
      computeFreshestGateChanges(
        [{ assetId: "a1", fortigateDevice: "GATE-B", lastSeen: t(30) }],
        [{ assetId: "a1", fortigateDevice: "GATE-A", seenAt: t(5) }],
      ),
    ).toEqual([]);
  });

  it("handles assets independently in one batch", () => {
    const changes = computeFreshestGateChanges(
      [
        { assetId: "a1", fortigateDevice: "GATE-A", lastSeen: t(0) },
        { assetId: "a2", fortigateDevice: "GATE-C", lastSeen: t(0) },
      ],
      [
        { assetId: "a1", fortigateDevice: "GATE-B", seenAt: t(10) },
        { assetId: "a2", fortigateDevice: "GATE-C", seenAt: t(10) }, // restated
        { assetId: "a3", fortigateDevice: "GATE-D", seenAt: t(10) }, // first sighting
      ],
    );
    expect(changes).toEqual([{ assetId: "a1", from: "GATE-A", to: "GATE-B" }]);
  });

  it("breaks an equal-timestamp incumbent tie deterministically", () => {
    // Two current rows with identical lastSeen must pick the same incumbent on
    // every run, or the event would depend on row order.
    const current = [
      { assetId: "a1", fortigateDevice: "GATE-Z", lastSeen: t(0) },
      { assetId: "a1", fortigateDevice: "GATE-A", lastSeen: t(0) },
    ];
    const incoming = [{ assetId: "a1", fortigateDevice: "GATE-M", seenAt: t(10) }];
    const first = computeFreshestGateChanges(current, incoming);
    const reordered = computeFreshestGateChanges([...current].reverse(), incoming);
    expect(first).toEqual([{ assetId: "a1", from: "GATE-A", to: "GATE-M" }]);
    expect(reordered).toEqual(first);
  });

  it("ignores rows missing an asset or device", () => {
    expect(
      computeFreshestGateChanges(
        [{ assetId: "a1", fortigateDevice: "GATE-A", lastSeen: t(0) }],
        [{ assetId: "a1", fortigateDevice: "", seenAt: t(10) }],
      ),
    ).toEqual([]);
  });
});
