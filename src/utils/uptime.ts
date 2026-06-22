/**
 * src/utils/uptime.ts — device-uptime helpers.
 *
 * Uptime is captured on the probe path (SNMP sysUpTime / FortiOS system
 * status / Polaris Agent host.Uptime) and stored on Asset.lastUptimeSec.
 * These pure helpers convert raw probe values into seconds and render a
 * compact human-readable duration. snmpTicksToSeconds feeds the SNMP probe
 * capture in monitoringService; the frontend keeps a mirror of formatUptime()
 * in public/js/app.js (vanilla JS, no module imports).
 */

/**
 * Convert SNMP sysUpTime / hrSystemUptime TimeTicks (hundredths of a second)
 * to whole seconds. Returns null for non-finite / negative input.
 *
 * Note: sysUpTime is a 32-bit counter that wraps at ~497 days and resets when
 * the SNMP agent (not necessarily the device) restarts — acceptable for a
 * "current uptime" display.
 */
export function snmpTicksToSeconds(ticks: unknown): number | null {
  if (ticks == null || ticks === "") return null; // Number(null) is 0, not NaN
  const n = typeof ticks === "number" ? ticks : Number(ticks);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n / 100);
}

/**
 * Render a duration in seconds as a compact "Nd Nh" / "Nh Nm" / "Nm" string.
 * Shows the two most-significant non-zero units. Sub-minute reads as "<1m".
 * Returns "—" for null / negative input.
 */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return "<1m";

  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}
