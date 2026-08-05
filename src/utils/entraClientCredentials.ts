/**
 * src/utils/entraClientCredentials.ts — the Entra ID client-credentials
 * token REQUEST shape (URL + form body), shared by the Graph token fetch
 * (entraIdService, scope graph.microsoft.com/.default, cached, AppError
 * surfaces) and the Trusted Signing token fetch (agentSigningService,
 * scope codesigning.azure.net/.default, per-build, secret-scrubbed plain
 * errors). The two TRANSPORT policies differ deliberately and stay in
 * their services; only the request shape — the part that could silently
 * drift (endpoint version, grant fields) — is shared. Pure, unit-testable
 * without network.
 */

export function buildClientCredentialsTokenRequest(cfg: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}): { url: string; body: URLSearchParams } {
  return {
    url: `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`,
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: cfg.scope,
    }),
  };
}
