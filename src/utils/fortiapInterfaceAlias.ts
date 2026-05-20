// FortiAP interface-name aliasing.
//
// FortiOS reports a managed FortiAP's wired uplink under two different
// naming schemes depending on which surface you ask:
//   - The FortiGate's /api/v2/monitor/wifi/managed_ap response uses the
//     FortiAP-local CLI name (`lan1`, `lan2`, ...) — that's what discovery
//     stamps onto `Asset.fortinetTopology.uplinkInterface`.
//   - The FortiAP's own SNMP IF-MIB exposes the same physical port as the
//     Linux kernel name (`eth0`, `eth1`, ...) — that's what shows up in
//     the System tab interface table AND what `Asset.monitoredInterfaces`
//     must match for the fast-cadence collector to find an ifIndex.
//
// Both names point at the same NIC. The mapping convention is positional:
//   lan1 ↔ eth0
//   lan2 ↔ eth1
//   ...
//
// Wireless-bridge interfaces (`wbh0`, ...) have no Linux kernel sibling
// and pass through unchanged.

/**
 * Returns the list of equivalent interface names for a FortiAP port.
 * Single-element when no alias applies (wbh0, port1, anything non-matching).
 * The input is always included in the result.
 */
export function fortiapInterfaceAliases(name: string): string[] {
  if (typeof name !== "string" || name.length === 0) return [name];
  const lanMatch = /^lan(\d+)$/i.exec(name);
  if (lanMatch) {
    const n = parseInt(lanMatch[1], 10);
    if (n >= 1) return [name, `eth${n - 1}`];
  }
  const ethMatch = /^eth(\d+)$/i.exec(name);
  if (ethMatch) {
    const n = parseInt(ethMatch[1], 10);
    if (n >= 0) return [name, `lan${n + 1}`];
  }
  return [name];
}

/**
 * Pick the canonical interface name to use given a set of names the AP
 * actually reports. Resolution rule:
 *   1. If the eth* form exists in knownIfNames, use that (SNMP-canonical —
 *      matches what the interface table shows and what
 *      Asset.monitoredInterfaces must contain for fast-cadence pinning to
 *      land on a real ifIndex).
 *   2. Else if the lan* form exists, use that.
 *   3. Else return the original input — better to surface the edge under
 *      a name no interface row will match than to drop it silently.
 */
export function normalizeFortiapInterfaceName(name: string, knownIfNames: Set<string>): string {
  const candidates = fortiapInterfaceAliases(name);
  // Prefer eth* form first.
  for (const c of candidates) {
    if (/^eth\d+$/i.test(c) && knownIfNames.has(c)) return c;
  }
  // Fall back to lan* form.
  for (const c of candidates) {
    if (/^lan\d+$/i.test(c) && knownIfNames.has(c)) return c;
  }
  // Last resort: any candidate present in the known set.
  for (const c of candidates) {
    if (knownIfNames.has(c)) return c;
  }
  return name;
}
