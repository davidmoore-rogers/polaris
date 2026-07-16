/**
 * src/utils/oidCompare.ts
 *
 * Numeric OID comparison + the monotonic-walk guard built on it.
 *
 * Exists because net-snmp's walk/subtree has NO defense against an agent that
 * returns a non-increasing OID on GETNEXT/GETBULK: walkCb just re-issues the
 * next request anchored at the last varbind's OID, so a broken agent that
 * echoes the queried OID back (seen in the field on ControlByWeb X-4xx
 * devices) loops forever. The library's own `backwardsGetNexts: false` strict
 * mode doesn't help — its `oidFollowsOid` returns true for EQUAL OIDs, which
 * is exactly the echo-loop case. Both Polaris walk paths (the internal
 * collector `snmpWalk` and the operator-facing `snmpWalkRaw` in
 * monitoringService) run every raw varbind through `makeOidMonotonicGuard`
 * and abort the walk with a clear error when the agent stops advancing.
 */

/**
 * Compare two dotted-numeric OID strings component-wise (numeric, not
 * lexicographic — "1.3.6.1.9" < "1.3.6.1.10"). Returns <0 / 0 / >0 like a
 * standard comparator. A strict prefix sorts before its extensions
 * ("1.3.6" < "1.3.6.1"), matching SNMP lexicographic OID ordering.
 * Assumes well-formed inputs (as produced by net-snmp varbinds).
 */
export function compareOids(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const ai = Number(as[i]);
    const bi = Number(bs[i]);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return as.length - bs.length;
}

/**
 * Stateful guard for an SNMP walk: feed it every varbind OID in arrival
 * order; it returns true while the walk is advancing (each OID strictly
 * greater than the last) and false the moment the agent returns an equal or
 * lower OID — the signature of a GETNEXT/GETBULK loop that would otherwise
 * spin forever. One guard instance per walk.
 */
export function makeOidMonotonicGuard(): { advance: (oid: string) => boolean; last: () => string | null } {
  let lastOid: string | null = null;
  return {
    advance(oid: string): boolean {
      if (lastOid !== null && compareOids(oid, lastOid) <= 0) return false;
      lastOid = oid;
      return true;
    },
    last: () => lastOid,
  };
}
