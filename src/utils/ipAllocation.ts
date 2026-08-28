/**
 * src/utils/ipAllocation.ts
 *
 * Pure selection of free host addresses out of a subnet's ordered address
 * list — the arithmetic behind the IP panel's Auto-Allocate modal in both its
 * single and its multiple-IP flavour.
 *
 * Deliberately pure (no Prisma, no I/O, no IP math): the caller supplies the
 * ordered host list and the set of addresses already spoken for, so the
 * contiguity rules are unit-testable on their own. Address arithmetic still
 * lives in `utils/cidr.ts` — this file only ever compares and slices strings.
 *
 * `hosts` MUST be in ascending address order with no gaps, which is exactly
 * what `enumerateSubnetIps` produces once the network/broadcast entries are
 * dropped. That is what lets adjacency in the ARRAY stand in for adjacency in
 * the address space, and it is the only assumption this file makes.
 */

export interface AvailableIpSelection {
  /**
   * The chosen addresses, ascending — `count` of them on success, and an
   * EMPTY array when the request can't be satisfied. Callers report the
   * shortfall from the two stats below rather than getting a partial list,
   * because "allocate 12" half-done is not an outcome anyone asked for.
   */
  ips: string[];
  /** Longest run of consecutive free addresses seen in `hosts`. */
  largestRun: number;
  /** Total free host addresses in `hosts`, contiguous or not. */
  availableCount: number;
}

export function selectAvailableIps(
  hosts: readonly string[],
  taken: ReadonlySet<string>,
  count: number,
  contiguous: boolean,
): AvailableIpSelection {
  let availableCount = 0;
  let largestRun = 0;
  let runStart = -1;
  let runLength = 0;
  let firstFittingRunStart = -1;
  const free: string[] = [];

  for (let i = 0; i < hosts.length; i++) {
    const addr = hosts[i] as string;
    if (taken.has(addr)) {
      runStart = -1;
      runLength = 0;
      continue;
    }
    availableCount++;
    if (!contiguous && free.length < count) free.push(addr);
    if (runStart === -1) runStart = i;
    runLength++;
    if (runLength > largestRun) largestRun = runLength;
    if (contiguous && firstFittingRunStart === -1 && count > 0 && runLength >= count) {
      firstFittingRunStart = runStart;
    }
  }

  if (count <= 0) return { ips: [], largestRun, availableCount };

  if (contiguous) {
    const ips = firstFittingRunStart === -1
      ? []
      : hosts.slice(firstFittingRunStart, firstFittingRunStart + count) as string[];
    return { ips, largestRun, availableCount };
  }

  return { ips: free.length === count ? free : [], largestRun, availableCount };
}
