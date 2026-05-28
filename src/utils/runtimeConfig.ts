/**
 * src/utils/runtimeConfig.ts — fail-fast environment validation that runs
 * BEFORE any listener binds, before pg-boss init, before sample buffers
 * start. Throwing here exits Node with non-zero, systemd's
 * `Restart=on-failure` cycles the unit, no partially-initialized listener
 * ever opens.
 *
 * Currently covers proxy-mode invariants — `POLARIS_PROXY_CERT_PATH` and
 * `POLARIS_PUBLIC_URL` must agree on shape, the URL must parse, the cert
 * file must exist. Add new fail-fast checks here as the runtime gains them.
 */

import { existsSync } from "node:fs";
import { isProxyMode } from "./proxyMode.js";
import { logger } from "./logger.js";

export function validateRuntimeConfiguration(): void {
  if (isProxyMode()) {
    validateProxyMode();
  }
}

function validateProxyMode(): void {
  const certPath = process.env.POLARIS_PROXY_CERT_PATH!;
  const publicUrl = process.env.POLARIS_PUBLIC_URL;

  if (!publicUrl) {
    throw new Error(
      "POLARIS_PROXY_CERT_PATH is set but POLARIS_PUBLIC_URL is missing — proxy mode requires both. " +
      "Set POLARIS_PUBLIC_URL=https://<your-polaris-hostname> in /opt/polaris/.env and restart.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error(`POLARIS_PUBLIC_URL is not a valid URL: ${publicUrl}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`POLARIS_PUBLIC_URL must use https:, got ${parsed.protocol} (${publicUrl})`);
  }
  if (!parsed.hostname) {
    throw new Error(`POLARIS_PUBLIC_URL has no hostname: ${publicUrl}`);
  }
  if (!existsSync(certPath)) {
    throw new Error(
      `POLARIS_PROXY_CERT_PATH does not exist: ${certPath} — nginx and Polaris must read the same cert file. ` +
      "Verify the path and that the polaris user has read access.",
    );
  }

  // Single boot banner so operators can confirm proxy mode from journalctl
  // without grepping a dozen scattered log lines. Per design review §13.
  logger.info(
    {
      certPath,
      publicUrl,
    },
    "[HTTPS] External TLS termination enabled — Node HTTPS listener disabled",
  );
}
