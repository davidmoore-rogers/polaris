---
name: azure-entra-integration
description: "Microsoft Entra ID / Azure integration patterns for a Node.js app: SAML and OIDC (Authorization Code + PKCE) login, group-claim traps (GUIDs, the ~150-group overage), Entra Application Proxy header SSO and its source-IP trust model, Microsoft Graph device and directory reads ($select/$filter/$top, never $search for bulk), Intune managed devices, Azure Arc via Resource Graph, M365 OAuth for SMTP, and Key Vault-fed secrets. Load when a project authenticates against Entra ID, reads Graph, publishes through App Proxy, or handles Azure credentials."
---

# Entra ID / Azure integration patterns

Vendor knowledge distilled from an IP-management app that authenticates its operators against
Entra ID four ways and discovers devices from Entra, Intune and Azure Arc. No app-specific
paths here; the patterns transfer.

## Login

- **SAML** (node-saml): fine for browser SSO; auto-provision on first login into the LEAST
  privileged role and flag the account for role review. Match returning users on the Entra
  object id (`oid`), not on UPN — UPNs change.
- **OIDC** (openid-client, Authorization Code + PKCE): needs a stable public URL to derive the
  redirect URI; make that URL a required setting and fail fast without it. Rate-limit the login
  kick-off per IP (tens per 15 min) and the callback far more generously (hundreds per 5 min):
  a callback carries a signature-validated assertion, not a guessable credential, and one NAT
  egress address carries a whole site's shift-start logins.
- **Group claims**: Entra emits group **object ids (GUIDs)**, not names, unless the app
  registration is configured to emit names — map GUIDs. Past roughly **150 groups** the claim
  is silently **omitted** unless the app uses "groups assigned to the application"; treat an
  absent groups claim as "unknown", never as "no groups". When several mapped groups match,
  the **highest-privilege role wins** and tags union.
- A mapping to an admin-equivalent role makes IdP group membership a path to admin, outside
  any last-admin guard — audit its creation with a warning event.

## Entra Application Proxy header SSO

App Proxy pre-authenticates in the cloud and forwards claims (UPN, object id, group ids) as
operator-named **plain HTTP headers**. Those headers are **unsigned**, so the entire security
model is source-IP trust:

1. Honor identity headers ONLY from an operator allow-list of connector IPs; an empty allow-list
   means header login is disabled (fail closed).
2. Strip the identity headers from every request that does not come from a trusted source, as
   defense in depth, before any router sees them.
3. Auto-login silently for trusted sources; show a fallback button only when the request is
   trusted AND carries headers.
4. Provide a "Test" that echoes the request's source IP as the app sees it — that is the value
   to put in the allow-list, and it depends on the reverse-proxy trust setting.
5. Rate-limit generously: every App Proxy user shares the connector IP.

Converge SAML and header-SSO users on the same object id so one person is one account.

## Microsoft Graph

- Device discovery reads `/devices` and Intune's `/deviceManagement/managedDevices`; keep
  discovery devices-only unless a people-facing feature is explicitly enabled, because people
  reads need directory permissions device discovery never required (without the grant every
  call 403s).
- Bulk reads: page with `$select` + `$filter` + `$top`; **do not use `$search`** for a roster
  sync (it is a typeahead primitive with different consistency and permission semantics).
- A live address-book typeahead and a stored roster sync are two separate opt-ins, because
  one reads and one stores.
- Hybrid-joined devices link on-prem AD and Entra records through the on-prem security
  identifier (`onPremisesSecurityIdentifier` ↔ `objectSid`).
- Never log query strings or directory PII to an audit log that is shipped off-host.

## Azure Arc

Arc-enabled servers come from Azure Resource Manager; the Connected Machine agent runs
**in the guest**, so hostname, OS and SMBIOS serial are the running system's truth and should
outrank directory records (which lag) for those fields. Optional enrichments (VM placement,
SQL Server instances) are one Resource Graph query each; fold them into the machine record
rather than creating new inventory objects. The VM placement enrichment also yields the
instance UUID that dedupes against a vCenter integration.

## Secrets

Secrets belong in **Key Vault** and reach the app as environment variables; never in source,
never hardcoded. Tenant/client secrets and OAuth refresh tokens that must persist server-side
are stored sealed (application-level encryption keyed from an env-injected key) and masked on
every read API. M365 OAuth (client-credentials) for SMTP relays avoids storing a mailbox
password at all.
