/**
 * Shared, process-wide registry of integration IDs that are currently running
 * a discovery. Written by integrations.ts (the route that launches/aborts runs);
 * read by monitoringService.ts to suppress probes that would compete with
 * discovery for the same FortiGate REST sessions.
 *
 * Kept in a standalone module to avoid the circular-import that would result
 * from monitoringService importing integrations (integrations already imports
 * monitoringService for getAdMonitorProtocol).
 */

const _running = new Set<string>();

/** Mark an integration as currently running discovery. */
export function markDiscoveryStarted(integrationId: string): void {
  _running.add(integrationId);
}

/** Remove an integration from the running set (call in the discovery finally block). */
export function markDiscoveryFinished(integrationId: string): void {
  _running.delete(integrationId);
}

/** True while a discovery run is in flight for this integration. */
export function isDiscoveryRunning(integrationId: string): boolean {
  return _running.has(integrationId);
}
