/**
 * src/utils/sleep.ts — THE promise-setTimeout helper.
 *
 * Four byte-identical private copies (arpPrimeService, winrm, queueService,
 * reclaimBloatedChunks) plus inline occurrences predated this module. The
 * abortable variant (`sleepWithAbort` in fortimanagerService) and the
 * deliberately-synchronous spin (`sleepSync` in certInfo) are different
 * animals and stay where they are.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
