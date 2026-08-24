/**
 * tests/unit/cableMembers.test.ts
 *
 * The Device Map's inter-switch member expansion drew a one-cable link as TWO
 * parallel teal lines that named the SAME far-end port on both ends (prod
 * 2026-08-24: "port9 ↔ port27" and "port10 ↔ port27" between two FortiSwitches
 * whose interface tables each showed one link). These pin the two rules that
 * make that impossible.
 */

import { describe, it, expect } from "vitest";
import { pairCableMembers, type CableMember } from "../../src/utils/cableMembers.js";

const phys = (port: string, down = false): CableMember => ({ port, physical: true, down });
const agg = (port: string, down = false): CableMember => ({ port, physical: false, down });

describe("pairCableMembers", () => {
  it("draws one line for a plain single physical link", () => {
    const { lines, unpaired } = pairCableMembers([phys("port27")], [phys("port10")]);
    expect(lines).toEqual([{ a: "port27", b: "port10" }]);
    expect(unpaired).toEqual([]);
  });

  it("draws one line per member for a symmetric bundle, paired in order", () => {
    const { lines, unpaired } = pairCableMembers(
      [phys("port9"), phys("port10")],
      [phys("port27"), phys("port28")],
    );
    expect(lines).toEqual([
      { a: "port9", b: "port27" },
      { a: "port10", b: "port28" },
    ]);
    expect(unpaired).toEqual([]);
  });

  it("never repeats a lone PHYSICAL far-end port across parallel lines", () => {
    // The prod symptom: the far switch claimed two members, this one claimed
    // the single port27 that is actually cabled.
    const { lines, unpaired } = pairCableMembers(
      [phys("port9"), phys("port10")],
      [phys("port27")],
    );
    expect(lines).toEqual([{ a: "port9", b: "port27" }]);
    expect(unpaired).toEqual(["port10"]);
  });

  it("does repeat a lone AGGREGATE name — it labels the whole bundle", () => {
    // A side whose CMDB trunk membership wasn't scraped degrades to the
    // opaque serial-named trunk; both member lines legitimately land on it.
    const { lines, unpaired } = pairCableMembers(
      [phys("port9"), phys("port10")],
      [agg("8EFTQ21003227-0")],
    );
    expect(lines).toEqual([
      { a: "port9", b: "8EFTQ21003227-0" },
      { a: "port10", b: "8EFTQ21003227-0" },
    ]);
    expect(unpaired).toEqual([]);
  });

  it("prefers a live member over one the device reports as down", () => {
    const { lines, unpaired, droppedDown } = pairCableMembers(
      [phys("port9", true), phys("port10")],
      [phys("port27")],
    );
    expect(lines).toEqual([{ a: "port10", b: "port27" }]);
    expect(droppedDown).toEqual(["port9"]);
    expect(unpaired).toEqual([]);
  });

  it("keeps a lone member whatever its link state — a down link still renders", () => {
    const { lines, droppedDown } = pairCableMembers([phys("port27", true)], [phys("port10", true)]);
    expect(lines).toEqual([{ a: "port27", b: "port10" }]);
    expect(droppedDown).toEqual([]);
  });

  it("keeps every member when the whole side reads down (no side is emptied)", () => {
    const { lines, droppedDown } = pairCableMembers(
      [phys("port9", true), phys("port10", true)],
      [phys("port27"), phys("port28")],
    );
    expect(lines).toHaveLength(2);
    expect(droppedDown).toEqual([]);
  });

  it("treats an absent link-state reading as unknown, not down", () => {
    // `down` is set ONLY when the device reported a state and it wasn't "up".
    // Two members with no reading are both still candidates.
    const { lines, droppedDown } = pairCableMembers(
      [phys("port9"), phys("port10")],
      [phys("port27"), phys("port28")],
    );
    expect(lines).toHaveLength(2);
    expect(droppedDown).toEqual([]);
  });

  it("drops the down member and leaves the far side's surplus unpaired", () => {
    const { lines, unpaired, droppedDown } = pairCableMembers(
      [phys("port9"), phys("port10", true)],
      [phys("port27"), phys("port28")],
    );
    expect(lines).toEqual([{ a: "port9", b: "port27" }]);
    expect(droppedDown).toEqual(["port10"]);
    expect(unpaired).toEqual(["port28"]);
  });

  it("draws the resolved side against a null far end when the other side is empty", () => {
    const { lines, unpaired } = pairCableMembers([phys("port9"), phys("port10")], []);
    expect(lines).toEqual([
      { a: "port9", b: null },
      { a: "port10", b: null },
    ]);
    expect(unpaired).toEqual([]);
  });

  it("returns nothing when neither side resolved a member", () => {
    expect(pairCableMembers([], [])).toEqual({ lines: [], unpaired: [], droppedDown: [] });
  });
});
