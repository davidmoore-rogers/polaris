/**
 * src/utils/tlsDispatcher.ts
 *
 * Per-request TLS-verification control for `fetch()` callers that talk to
 * devices with self-signed certificates (FortiGate / FortiManager with
 * `verifySsl: false`).
 *
 * The previous approach — flipping `process.env.NODE_TLS_REJECT_UNAUTHORIZED`
 * around each request and restoring it in `finally` — mutated PROCESS-GLOBAL
 * state: with parallel request chains (fortigateService fires seven per
 * discovery device) the set/restore interleaves, and any unrelated in-flight
 * TLS connection in the same process (Graph, vCenter, SMTP...) could run
 * unverified during the window. An undici dispatcher scopes the relaxation to
 * exactly the connections that opted in, the way dnsService/winrm already
 * pass `rejectUnauthorized` per socket.
 *
 * The insecure agent is a lazily-created singleton so opted-in hosts still
 * get connection pooling/keep-alive across requests.
 */

import { Agent, type Dispatcher } from "undici";

let insecureAgent: Agent | null = null;

/**
 * Dispatcher that skips TLS certificate verification. Pass as `dispatcher`
 * in a fetch RequestInit ONLY when the integration's `verifySsl === false`;
 * omit it (undefined) for verifying requests so they ride the default
 * global dispatcher.
 */
export function insecureTlsDispatcher(): Dispatcher {
  if (!insecureAgent) {
    insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return insecureAgent;
}
