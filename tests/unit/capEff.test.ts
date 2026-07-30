/**
 * tests/unit/capEff.test.ts — decoding the agent-reported CapEff bitmask.
 *
 * The three masks that matter operationally:
 *   0000000000080000 — SYS_PTRACE only: the prod 2026-07-29 regression (unit
 *                      predates the CAP_DAC_READ_SEARCH fix; collects nothing)
 *   0000000000080004 — the fixed ptrace-tier pair
 *   0000000000000000 — unprivileged
 */

import { describe, it, expect } from "vitest";
import { decodeCapEff } from "../../src/utils/capEff.js";

describe("decodeCapEff", () => {
  it("decodes the SYS_PTRACE-only regression mask", () => {
    expect(decodeCapEff("0000000000080000")).toEqual({ sysPtrace: true, dacReadSearch: false });
  });

  it("decodes the fixed ptrace-tier pair", () => {
    expect(decodeCapEff("0000000000080004")).toEqual({ sysPtrace: true, dacReadSearch: true });
  });

  it("decodes an unprivileged (zero) mask", () => {
    expect(decodeCapEff("0000000000000000")).toEqual({ sysPtrace: false, dacReadSearch: false });
  });

  it("decodes a full root mask (all bits) as holding both", () => {
    expect(decodeCapEff("000001ffffffffff")).toEqual({ sysPtrace: true, dacReadSearch: true });
  });

  it("tolerates 0x prefix, case, and surrounding whitespace", () => {
    expect(decodeCapEff(" 0x0000000000080004 ")).toEqual({ sysPtrace: true, dacReadSearch: true });
    expect(decodeCapEff("00000000000800A4")).toEqual({ sysPtrace: true, dacReadSearch: true });
  });

  it("returns null (not 'no caps') for null / empty / garbage", () => {
    expect(decodeCapEff(null)).toBeNull();
    expect(decodeCapEff(undefined)).toBeNull();
    expect(decodeCapEff("")).toBeNull();
    expect(decodeCapEff("not-hex")).toBeNull();
    expect(decodeCapEff("00080004deadbeef00")).toBeNull(); // >16 hex digits
  });
});
