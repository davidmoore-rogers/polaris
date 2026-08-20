import { describe, it, expect } from "vitest";
import { decodeCentralManagementFlags } from "../../src/services/fortimanagerService.js";

// decodeCentralManagementFlags() turns an ADOM's dvmdb `flags` value into
// per-class central-management verdicts. Central is FMG's default — the
// per_device_* flag being SET means per-device mode. The bit values come
// from the /dvmdb/adom syntax dump rather than hardcoded constants. Pure —
// no network. The fixture values are from a live FMG 7.x (ADOM "ACME":
// flags=65600 = per_device_fsw(65536) + install_deselect_all(64), APs
// centrally managed, switches per-device).

const LIVE_FMG_OPTS = {
  auto_push_cfg: 16384,
  backup: 16,
  install_deselect_all: 64,
  install_on_policy_check_fail: 8192,
  is_autosync: 512,
  no_vpn_console: 8,
  per_device_fsw: 65536,
  per_device_wtp: 1024,
  policy_check_on_install: 4096,
};

describe("decodeCentralManagementFlags", () => {
  it("decodes the live-FMG fixture: switches per-device, APs central", () => {
    const r = decodeCentralManagementFlags(65600, LIVE_FMG_OPTS);
    expect(r).toEqual({ wtp: true, fsw: false });
  });

  it("both per-device flags set → both classes per-device", () => {
    const r = decodeCentralManagementFlags(65536 + 1024, LIVE_FMG_OPTS);
    expect(r).toEqual({ wtp: false, fsw: false });
  });

  it("no per-device flags set → both classes central", () => {
    const r = decodeCentralManagementFlags(64 + 512, LIVE_FMG_OPTS);
    expect(r).toEqual({ wtp: true, fsw: true });
  });

  it("verbose builds returning a string array are handled", () => {
    const r = decodeCentralManagementFlags(["per_device_fsw", "install_deselect_all"], LIVE_FMG_OPTS);
    expect(r).toEqual({ wtp: true, fsw: false });
  });

  it("returns null per class when its flag is absent from the syntax opts (old build)", () => {
    const r = decodeCentralManagementFlags(65600, { per_device_fsw: 65536 });
    expect(r).toEqual({ wtp: null, fsw: false });
  });

  it("returns nulls for a non-numeric flags value", () => {
    const r = decodeCentralManagementFlags("65600", LIVE_FMG_OPTS);
    expect(r).toEqual({ wtp: null, fsw: null });
  });
});
