import { describe, it, expect } from "vitest";
import {
  claimIsOperatorOwned,
  claimIsCurrent,
  distinctDeviceCount,
  groupCurrentClaims,
  memberSetKey,
  pickPrimaryMemberId,
  toStoredMember,
  duplicateIpRejectMessage,
  DUPLICATE_IP_COLLISION_REASON,
  type IpClaimRow,
} from "../../src/services/duplicateIpConflictService.js";

const CUTOFF = new Date("2026-08-26T00:00:00Z"); // "7 days ago" for these fixtures
const FRESH = new Date("2026-09-01T00:00:00Z");
const STALE = new Date("2026-07-01T00:00:00Z");

function row(over: Partial<IpClaimRow> = {}): IpClaimRow {
  return {
    id: "a1",
    ip: "10.1.1.50",
    hostname: "host-a",
    assetType: "workstation",
    status: "active",
    monitored: true,
    macAddress: "AA:BB:CC:00:00:01",
    ipSource: "fortigate",
    ipOverride: null,
    lastSeen: FRESH,
    ipLastSeen: FRESH,
    ...over,
  };
}

describe("claimIsOperatorOwned", () => {
  it("is true when the pin equals the recorded address", () => {
    expect(claimIsOperatorOwned({ ip: "10.1.1.50", ipOverride: "10.1.1.50", ipSource: "manual" })).toBe(true);
  });

  it("is true for a manually-sourced address with no pin", () => {
    expect(claimIsOperatorOwned({ ip: "10.1.1.50", ipOverride: null, ipSource: "manual" })).toBe(true);
  });

  it("is false when the pin names a DIFFERENT address than the one recorded", () => {
    // Mid-flight ip-override state: the pin is 10.1.1.9 while the row shows
    // the discovered address. That address is not the operator's claim.
    expect(claimIsOperatorOwned({ ip: "10.1.1.50", ipOverride: "10.1.1.9", ipSource: "fortigate" })).toBe(false);
  });

  it("is false for a discovered address", () => {
    expect(claimIsOperatorOwned({ ip: "10.1.1.50", ipOverride: null, ipSource: "fortimanager" })).toBe(false);
  });
});

describe("claimIsCurrent", () => {
  it("counts a recently re-asserted discovered claim", () => {
    expect(claimIsCurrent(row({ ipLastSeen: FRESH }), CUTOFF)).toBe(true);
  });

  it("drops a stale discovered claim — the DHCP-reuse leftover", () => {
    expect(claimIsCurrent(row({ ipLastSeen: STALE, lastSeen: STALE }), CUTOFF)).toBe(false);
  });

  it("keeps an operator-owned claim however old it is", () => {
    expect(
      claimIsCurrent(
        row({ ipSource: "manual", ipOverride: "10.1.1.50", ipLastSeen: STALE, lastSeen: STALE }),
        CUTOFF,
      ),
    ).toBe(true);
  });

  it("falls back to Asset.lastSeen when there is no history row", () => {
    expect(claimIsCurrent(row({ ipLastSeen: null, lastSeen: FRESH }), CUTOFF)).toBe(true);
    expect(claimIsCurrent(row({ ipLastSeen: null, lastSeen: STALE }), CUTOFF)).toBe(false);
  });

  it("accepts a timestamp the raw query handed back as a string", () => {
    // $queryRaw types are a claim about the driver, not a guarantee.
    const asString = { ...row(), ipLastSeen: FRESH.toISOString() as unknown as Date };
    expect(claimIsCurrent(asString, CUTOFF)).toBe(true);
    const staleString = { ...row(), ipLastSeen: STALE.toISOString() as unknown as Date, lastSeen: null };
    expect(claimIsCurrent(staleString, CUTOFF)).toBe(false);
  });

  it("drops a claim whose timestamp does not parse", () => {
    expect(claimIsCurrent({ ...row(), ipLastSeen: "nonsense" as unknown as Date, lastSeen: null }, CUTOFF)).toBe(false);
  });

  it("drops a claim with no timestamp at all", () => {
    expect(claimIsCurrent(row({ ipLastSeen: null, lastSeen: null }), CUTOFF)).toBe(false);
  });

  it("prefers the per-address timestamp over the asset's presence", () => {
    // Device is present (lastSeen fresh) but nothing has re-asserted THIS
    // address in months — the record is stale, not a duplicate.
    expect(claimIsCurrent(row({ ipLastSeen: STALE, lastSeen: FRESH }), CUTOFF)).toBe(false);
  });
});

describe("distinctDeviceCount", () => {
  it("collapses rows sharing one MAC into a single device", () => {
    expect(
      distinctDeviceCount([{ macAddress: "AA:BB:CC:00:00:01" }, { macAddress: "aa:bb:cc:00:00:01" }]),
    ).toBe(1);
  });

  it("counts differing MACs separately", () => {
    expect(
      distinctDeviceCount([{ macAddress: "AA:BB:CC:00:00:01" }, { macAddress: "AA:BB:CC:00:00:02" }]),
    ).toBe(2);
  });

  it("treats each unknown MAC as its own device", () => {
    expect(distinctDeviceCount([{ macAddress: null }, { macAddress: null }])).toBe(2);
    expect(distinctDeviceCount([{ macAddress: "  " }, { macAddress: "AA:BB:CC:00:00:01" }])).toBe(2);
  });
});

describe("groupCurrentClaims", () => {
  it("groups two current claims on one address", () => {
    const groups = groupCurrentClaims(
      [row({ id: "a2", macAddress: "AA:BB:CC:00:00:02" }), row({ id: "a1" })],
      CUTOFF,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].ip).toBe("10.1.1.50");
    expect(groups[0].members.map((m) => m.id)).toEqual(["a1", "a2"]); // sorted, stable
  });

  it("does not group when only one claim is current", () => {
    const groups = groupCurrentClaims(
      [
        row({ id: "a1" }),
        row({ id: "a2", macAddress: "AA:BB:CC:00:00:02", ipLastSeen: STALE, lastSeen: STALE }),
      ],
      CUTOFF,
    );
    expect(groups).toEqual([]);
  });

  it("does not group one device recorded twice (same MAC)", () => {
    const groups = groupCurrentClaims([row({ id: "a1" }), row({ id: "a2" })], CUTOFF);
    expect(groups).toEqual([]);
  });

  it("keeps a three-way collision as one group", () => {
    const groups = groupCurrentClaims(
      [
        row({ id: "a1" }),
        row({ id: "a2", macAddress: "AA:BB:CC:00:00:02" }),
        row({ id: "a3", macAddress: null }),
      ],
      CUTOFF,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
  });

  it("separates addresses and returns them in address order", () => {
    const groups = groupCurrentClaims(
      [
        row({ id: "b1", ip: "10.1.1.60" }),
        row({ id: "b2", ip: "10.1.1.60", macAddress: "AA:BB:CC:00:00:09" }),
        row({ id: "a1", ip: "10.1.1.50" }),
        row({ id: "a2", ip: "10.1.1.50", macAddress: "AA:BB:CC:00:00:02" }),
      ],
      CUTOFF,
    );
    expect(groups.map((g) => g.ip)).toEqual(["10.1.1.50", "10.1.1.60"]);
  });

  it("ignores rows with no address", () => {
    expect(groupCurrentClaims([row({ id: "a1", ip: "" }), row({ id: "a2", ip: "" })], CUTOFF)).toEqual([]);
  });
});

describe("memberSetKey", () => {
  it("is order-independent and accepts both row and stored shapes", () => {
    expect(memberSetKey([{ assetId: "b" }, { assetId: "a" }])).toBe("a,b");
    expect(memberSetKey([{ id: "a" }, { id: "b" }])).toBe("a,b");
  });

  it("distinguishes a changed member set — which is what re-raises a dismissal", () => {
    expect(memberSetKey([{ assetId: "a" }, { assetId: "b" }])).not.toBe(
      memberSetKey([{ assetId: "a" }, { assetId: "c" }]),
    );
  });
});

describe("pickPrimaryMemberId", () => {
  it("picks the lowest id so refreshes do not churn the FK", () => {
    expect(pickPrimaryMemberId([{ id: "b" }, { id: "a" }, { id: "c" }])).toBe("a");
  });

  it("returns null for an empty set", () => {
    expect(pickPrimaryMemberId([])).toBeNull();
  });
});

describe("toStoredMember", () => {
  it("serializes dates and flags the operator-owned claim", () => {
    const stored = toStoredMember(row({ ipSource: "manual", ipOverride: "10.1.1.50" }));
    expect(stored.assetId).toBe("a1");
    expect(stored.pinned).toBe(true);
    expect(stored.lastSeen).toBe(FRESH.toISOString());
    expect(stored.ipLastSeen).toBe(FRESH.toISOString());
  });

  it("keeps nulls null rather than inventing timestamps", () => {
    const stored = toStoredMember(row({ lastSeen: null, ipLastSeen: null, macAddress: null }));
    expect(stored.lastSeen).toBeNull();
    expect(stored.ipLastSeen).toBeNull();
    expect(stored.macAddress).toBeNull();
    expect(stored.pinned).toBe(false);
  });
});

describe("duplicateIpRejectMessage", () => {
  it("names the address and both assets", () => {
    const msg = duplicateIpRejectMessage({
      proposedAssetFields: {
        collisionReason: DUPLICATE_IP_COLLISION_REASON,
        ipAddress: "10.1.1.50",
        members: [{ assetId: "a1", hostname: "host-a" }, { assetId: "a2", hostname: "host-b" }],
      },
    });
    expect(msg).toContain("10.1.1.50");
    expect(msg).toContain("host-a");
    expect(msg).toContain("host-b");
  });

  it("survives a conflict with no members recorded", () => {
    expect(duplicateIpRejectMessage({ proposedAssetFields: null })).toContain("unknown");
  });
});
