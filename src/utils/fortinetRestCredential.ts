/**
 * src/utils/fortinetRestCredential.ts
 *
 * A per-asset `restapi` credential, mapped onto the auth half of a FortiOS
 * REST call.
 *
 * Why this exists: every FortiOS collector assembles its request through
 * `buildFortinetConfig()`, which read the INTEGRATION's stored token and
 * nothing else — `config.fortigateApiToken` on a FortiManager,
 * `config.apiToken` on a standalone FortiGate. That token is fleet-wide by
 * construction ("must be the same across all managed FortiGates", says the FMG
 * Monitoring tab's own hint), so a fleet where each gate carries its own
 * api-user had no way to be polled over REST at all.
 *
 * Meanwhile the asset edit modal was ALREADY offering a REST API credential
 * picker on every stream whose method is `rest_api` (`_credTypeForPolling` in
 * public/js/assets.js maps rest_api → restapi), `PUT /assets/:id` accepted it,
 * and the resolver reported it — and then the collector ignored it. An operator
 * could select a credential, save, watch the tick report success, and collect
 * nothing, forever. Same failure class as the capability table in
 * `pollingCapability.ts` was written to catch: a control that persists and
 * resolves but reaches no code.
 *
 * ── What the credential contributes, and what it deliberately does not ──────
 * AUTH and TRANSPORT DETAIL only: the token, the port, and whether TLS is
 * verified. The TARGET stays the asset's own address, exactly as it does for
 * every other per-asset credential type — an SNMP / SSH / WinRM credential
 * carries no host either, and the host is what makes a sample belong to an
 * asset.
 *
 * So `baseUrl`'s HOST and SCHEME are read for the port and ignored otherwise.
 * That is not an oversight: the field is required by
 * `validateRestApiConfig` (it is what the credential's own Test button dials),
 * and honouring it here would mean one credential accidentally shared across
 * twenty gates polls ONE device and files its CPU under all twenty. A wrong
 * host is a mis-attribution that looks exactly like real data; a wrong port is
 * a connection error an operator can read.
 */

/** The shape both the Prisma `Credential` row and a test fixture satisfy. */
export interface CredentialLike {
  type: string;
  config: unknown;
}

/** The auth half of a `FortiGateConfig` — what a credential can supply. */
export interface FortinetRestAuth {
  apiUser: string;
  apiToken: string;
  verifySsl: boolean;
  /** Only set when the credential's baseUrl named a non-default port. */
  port?: number;
}

/**
 * First `restapi`-typed credential in the per-stream → asset-default chain.
 *
 * Mirrors the SNMP chain's precedence (`asset.<stream>Credential ??
 * asset.monitorCredential`) and filters on type, because the asset default is
 * usually an SNMP community — a stream on REST must not try to authenticate
 * with it.
 *
 * The class-override tier is deliberately NOT consulted: a per-gate token is
 * per-gate, and a credential shared by a whole asset class is the fleet-wide
 * token this feature exists to escape.
 */
export function pickRestApiCredential(
  ...candidates: Array<CredentialLike | null | undefined>
): CredentialLike | null {
  for (const c of candidates) {
    if (c && c.type === "restapi") return c;
  }
  return null;
}

/**
 * Map a `restapi` credential's config onto FortiOS request auth.
 *
 * Returns `{ error }` rather than throwing so the callers can keep their
 * existing "409 with the operator-facing reason" shape. The messages name the
 * credential, not the integration, so an operator reading a failed tick knows
 * which of the two token sources was in play.
 */
export function restApiCredentialAuth(config: unknown): FortinetRestAuth | { error: string } {
  const cfg = (config ?? {}) as Record<string, unknown>;
  const apiToken = String(cfg.apiToken || "").trim();
  if (!apiToken) return { error: "REST API credential is missing its API token" };

  // `verifyTls` is the credential's field name; `verifySsl` is FortiGateConfig's.
  // Both default to NOT verifying — device certs are self-signed far more often
  // than not, and this pairing has always been opt-in on both sides.
  const auth: FortinetRestAuth = {
    apiUser: String(cfg.apiUser || ""),
    apiToken,
    verifySsl: cfg.verifyTls === true,
  };

  // Port only. See the header for why the host and scheme are dropped.
  const baseUrl = String(cfg.baseUrl || "").trim();
  if (baseUrl) {
    let u: URL | null = null;
    try { u = new URL(baseUrl); } catch { u = null; }
    if (u && u.port) {
      const port = Number(u.port);
      if (Number.isInteger(port) && port > 0 && port <= 65535) auth.port = port;
    }
  }
  return auth;
}
