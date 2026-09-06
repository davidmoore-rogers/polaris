## cross-cutting/sso-login-and-group-mapping

**What it is:** OIDC + LDAP user login and the IdP-group → role+tags mapping layer. `authProvider ∈ {local, azure, oidc, ldap}`.

**Login entry points:**
- `POST /auth/login` (auth.ts) — local password OR LDAP branch (when the account is `authProvider="ldap"` OR the username is unknown and LDAP is enabled). Shared lockout counter applies to both.
- `GET /auth/oidc/login` + `GET /auth/oidc/callback` (auth.ts) — OIDC Authorization-Code + PKCE; state/nonce/codeVerifier stashed in the (PG) session between the two.
- `POST /auth/azure/callback` — SAML (unchanged; no group reading yet).

**Services:** `oidcAuthService.ts` (openid-client v6), `ldapAuthService.ts` + shared `ldapClient.ts` (ldapts; also used by `activeDirectoryService.ts` for computer discovery), `ssoProvisioning.ts` (shared provision/role-assign), `groupMappingService.ts` (CRUD + `resolveGroupsToAccess`).

**Settings** (Setting rows, admin-only via `serverSettingsSystem:write`): `oidc` (secret masked) + `ldap` (bindPassword masked). Each has a `POST /auth/{oidc,ldap}/test`.

**Invariants / gotchas:**
- LDAP: reject empty passwords before binding (unauthenticated-bind trap); RFC-4515-escape the username (`escapeLdapFilterValue`); fail closed on 0/>1 search hits.
- OIDC: requires `POLARIS_PUBLIC_URL` (redirect URI derivation); Azure `groups` claim emits GUIDs + drops past ~200 groups.
- Highest-privilege role wins on multi-group match; tags union; provider isolation via `@@unique([provider, groupKey])`.
- A GroupMapping → admin-equivalent role is a privilege-escalation surface (logged at warning level).

**When adding a sample/login provider field:** update the service's settings shape (mask secrets, preserve-on-unchanged), the matching tab in `public/js/users.js` (`buildOidcTab`/`buildLdapTab` + `getOidcFormData`/`getLdapFormData`), and `public/js/api.js`.

---
