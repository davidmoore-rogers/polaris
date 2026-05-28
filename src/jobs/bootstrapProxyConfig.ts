/**
 * src/jobs/bootstrapProxyConfig.ts — one-shot startup task that seeds the
 * proxyConfig Setting row on the first boot of an existing proxy-mode
 * install (the one where this feature ships). After the row exists the
 * task is a no-op forever after.
 *
 * Outside proxy mode this is a complete no-op — the bootstrap function
 * gates internally on isProxyMode().
 */

import { logger } from "../utils/logger.js";
import { bootstrapProxyConfig } from "../services/nginxApplyService.js";
import { runInstrumentedJob } from "./_metrics.js";

(async () => {
  try {
    await runInstrumentedJob("bootstrapProxyConfig", async () => {
      await bootstrapProxyConfig();
    });
  } catch (err) {
    logger.error({ err }, "proxyConfig bootstrap failed (nginx GUI will fall back to defaults until next boot)");
  }
})();
