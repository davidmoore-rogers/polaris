/**
 * tests/unit/descriptionSyncService.test.ts
 *
 * Push-path coverage for description sync with the FortiOS transport mocked
 * at the callFortiOs seam (the same seam both useProxy modes and the
 * standalone FortiGate integration flow through — reservationPushService's
 * Transport). Asserts: pre-read → PUT → read-back-verify sequencing, the
 * equal-value short-circuit (no PUT), verify-mismatch → permanent failure,
 * thrown transport errors → classified failure result (never a throw), and
 * the per-target endpoint/body shapes for interface / switch-port /
 * device-level targets.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppError } from "../../src/utils/errors.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn() }));
vi.mock("../../src/services/reservationPushService.js", () => ({
  buildTransportForIntegration: vi.fn(),
  callFortiOs: vi.fn(),
  // Mirror of the real classifier's AppError-status behavior — the real
  // function has its own coverage in reservationPushClassify.test.ts.
  classifyPushError: (err: unknown) =>
    err instanceof AppError && [400, 404, 409].includes(err.httpStatus) ? "permanent" : "transient",
}));

import { callFortiOs, buildTransportForIntegration } from "../../src/services/reservationPushService.js";
import {
  pushInterfaceDescription,
  pushSwitchPortDescription,
  pushDeviceDescription,
} from "../../src/services/descriptionSyncService.js";

const callMock = vi.mocked(callFortiOs);
const transportMock = vi.mocked(buildTransportForIntegration);

const integration = { id: "intg-1", type: "fortimanager", config: {} };
const fakeTransport = { kind: "direct-fortigate", fgConfig: { host: "10.0.0.1", apiToken: "t" }, vdom: "root" } as any;

beforeEach(() => {
  vi.clearAllMocks();
  transportMock.mockResolvedValue(fakeTransport);
});

describe("pushInterfaceDescription", () => {
  it("pre-reads, PUTs, verifies, and reports the overwritten device value", async () => {
    callMock
      .mockResolvedValueOnce([{ name: "port1", description: "device old" }]) // pre-read
      .mockResolvedValueOnce({}) // PUT
      .mockResolvedValueOnce([{ name: "port1", description: "new value" }]); // verify
    const res = await pushInterfaceDescription({
      integration, deviceName: "FG-BRANCH-01", ifName: "port1", value: "new value",
    });
    expect(res).toEqual({ ok: true, previousDeviceValue: "device old" });
    expect(callMock).toHaveBeenCalledTimes(3);
    const put = callMock.mock.calls[1];
    expect(put[1]).toBe("PUT");
    expect(put[2]).toBe("/api/v2/cmdb/system/interface/port1");
    expect(put[3]).toEqual({ description: "new value" });
  });

  it("skips the PUT entirely when the device already matches", async () => {
    callMock.mockResolvedValueOnce([{ name: "port1", description: "same" }]);
    const res = await pushInterfaceDescription({
      integration, deviceName: "FG-BRANCH-01", ifName: "port1", value: "same",
    });
    expect(res.ok).toBe(true);
    expect(callMock).toHaveBeenCalledTimes(1); // pre-read only
  });

  it("skips the pre-read when currentDeviceValue is supplied (reconcile path)", async () => {
    callMock
      .mockResolvedValueOnce({}) // PUT
      .mockResolvedValueOnce([{ description: "v2" }]); // verify
    const res = await pushInterfaceDescription({
      integration, deviceName: "FG-BRANCH-01", ifName: "port1", value: "v2",
      currentDeviceValue: "v1", transport: fakeTransport,
    });
    expect(res).toEqual({ ok: true, previousDeviceValue: "v1" });
    expect(transportMock).not.toHaveBeenCalled();
    expect(callMock.mock.calls[0][1]).toBe("PUT");
  });

  it("flags a verify mismatch as a permanent failure", async () => {
    callMock
      .mockResolvedValueOnce([{ description: "old" }]) // pre-read
      .mockResolvedValueOnce({}) // PUT accepted…
      .mockResolvedValueOnce([{ description: "old" }]); // …but device kept the old value
    const res = await pushInterfaceDescription({
      integration, deviceName: "FG-BRANCH-01", ifName: "port1", value: "new",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorKind).toBe("permanent");
      expect(res.error).toContain("verify mismatch");
    }
  });

  it("returns a classified failure instead of throwing on transport errors", async () => {
    callMock.mockRejectedValueOnce(new AppError(404, "Endpoint not found"));
    const notFound = await pushInterfaceDescription({
      integration, deviceName: "FG-BRANCH-01", ifName: "port1", value: "v",
    });
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.errorKind).toBe("permanent");

    callMock.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    const timeout = await pushInterfaceDescription({
      integration, deviceName: "FG-BRANCH-01", ifName: "port1", value: "v",
    });
    expect(timeout.ok).toBe(false);
    if (!timeout.ok) expect(timeout.errorKind).toBe("transient");
  });

  it("URL-encodes interface names", async () => {
    callMock
      .mockResolvedValueOnce([{ description: null }])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([{ description: "v" }]);
    await pushInterfaceDescription({
      integration, deviceName: "FG", ifName: "ae1/2", value: "v",
    });
    expect(callMock.mock.calls[1][2]).toBe("/api/v2/cmdb/system/interface/ae1%2F2");
  });
});

describe("pushSwitchPortDescription", () => {
  it("pre-reads the managed-switch row and PUTs the child ports entry", async () => {
    callMock
      .mockResolvedValueOnce([{
        "switch-id": "S124EP1234567890",
        ports: [{ "port-name": "port5", description: "old port desc" }],
      }]) // pre-read (whole switch row)
      .mockResolvedValueOnce({}) // PUT child entry
      .mockResolvedValueOnce([{ description: "patch bay 3" }]); // verify child entry
    const res = await pushSwitchPortDescription({
      integration, deviceName: "FG-BRANCH-01",
      switchId: "S124EP1234567890", portName: "port5", value: "patch bay 3",
    });
    expect(res).toEqual({ ok: true, previousDeviceValue: "old port desc" });
    const put = callMock.mock.calls[1];
    expect(put[2]).toBe("/api/v2/cmdb/switch-controller/managed-switch/S124EP1234567890/ports/port5");
    expect(put[3]).toEqual({ description: "patch bay 3" });
  });

  it("truncates to the switch-port cap (63)", async () => {
    const long = "z".repeat(100);
    callMock
      .mockResolvedValueOnce([{ "switch-id": "SN", ports: [{ "port-name": "port1", description: null }] }])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([{ description: "z".repeat(63) }]);
    const res = await pushSwitchPortDescription({
      integration, deviceName: "FG", switchId: "SN", portName: "port1", value: long,
    });
    expect(res.ok).toBe(true);
    expect((callMock.mock.calls[1][3] as any).description).toHaveLength(63);
  });
});

describe("pushDeviceDescription", () => {
  it("fortigate-global target writes system/global alias (capped at 35)", async () => {
    const long = "a".repeat(50);
    callMock
      .mockResolvedValueOnce([{ alias: "old alias" }]) // pre-read
      .mockResolvedValueOnce({}) // PUT
      .mockResolvedValueOnce([{ alias: "a".repeat(35) }]); // verify
    const res = await pushDeviceDescription({
      integration, deviceName: "FG-HQ", target: { kind: "fortigate-global" }, value: long,
    });
    expect(res).toEqual({ ok: true, previousDeviceValue: "old alias" });
    const put = callMock.mock.calls[1];
    expect(put[2]).toBe("/api/v2/cmdb/system/global");
    expect((put[3] as any).alias).toHaveLength(35);
  });

  it("managed-switch target writes the switch description", async () => {
    callMock
      .mockResolvedValueOnce([{ "switch-id": "SN1", description: null }])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([{ description: "IDF-2 stack" }]);
    const res = await pushDeviceDescription({
      integration, deviceName: "FG-HQ",
      target: { kind: "managed-switch", switchId: "SN1" }, value: "IDF-2 stack",
    });
    expect(res.ok).toBe(true);
    expect(callMock.mock.calls[1][2]).toBe("/api/v2/cmdb/switch-controller/managed-switch/SN1");
    expect(callMock.mock.calls[1][3]).toEqual({ description: "IDF-2 stack" });
  });

  it("wtp target writes the AP comment", async () => {
    callMock
      .mockResolvedValueOnce([{ "wtp-id": "FP231F123", comment: "old" }])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([{ comment: "lobby AP" }]);
    const res = await pushDeviceDescription({
      integration, deviceName: "FG-HQ",
      target: { kind: "wtp", wtpId: "FP231F123" }, value: "lobby AP",
    });
    expect(res).toEqual({ ok: true, previousDeviceValue: "old" });
    expect(callMock.mock.calls[1][2]).toBe("/api/v2/cmdb/wireless-controller/wtp/FP231F123");
    expect(callMock.mock.calls[1][3]).toEqual({ comment: "lobby AP" });
  });

  it("a failed verify read reports transient (PUT landed, re-check next cycle)", async () => {
    callMock
      .mockResolvedValueOnce([{ alias: "old" }])
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("socket hang up"));
    const res = await pushDeviceDescription({
      integration, deviceName: "FG-HQ", target: { kind: "fortigate-global" }, value: "new",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorKind).toBe("transient");
      expect(res.error).toContain("verify read");
    }
  });
});
