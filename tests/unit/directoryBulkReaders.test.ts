/**
 * tests/unit/directoryBulkReaders.test.ts
 *
 * The GAL sync's two bulk readers (business rule 35). These assert the QUERY
 * SHAPE rather than the parsing, because the shape is what silently returns the
 * wrong population:
 *
 *   - Graph must page with $select + $filter + $top and NOT use $search. The
 *     live typeahead needs term matching and carries a "VERIFY ON A REAL
 *     TENANT" flag on its $search + $filter + $count combination; a full
 *     enumeration needs none of that, and must not inherit the risk.
 *   - LDAP must use the paged-results control. searchDirectoryAd clamps
 *     sizeLimit to 100 and does no paging, which is right for a typeahead and
 *     would silently truncate a real GAL at AD's MaxPageSize of 1000.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const ldapMock = vi.hoisted(() => ({ withBoundLdapClient: vi.fn() }));
vi.mock("../../src/services/ldapClient.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, withBoundLdapClient: ldapMock.withBoundLdapClient };
});

import { listDirectoryPeople as listEntra } from "../../src/services/entraIdService.js";
import { listDirectoryPeople as listAd } from "../../src/services/activeDirectoryService.js";
import { normalizeDirectorySyncFilter } from "../../src/services/directorySyncService.js";

const FILTER = normalizeDirectorySyncFilter({});

// ─── Graph ──────────────────────────────────────────────────────────────────

const ENTRA_CONFIG = {
  tenantId: "t", clientId: "c", clientSecret: "s",
} as unknown as Parameters<typeof listEntra>[0];

/**
 * A Response whose body is delivered by text(), which is what both the token
 * exchange and graphRequest actually call -- a stub implementing only json()
 * reads as an empty body, and each collection's own .catch() then swallows the
 * failure into an empty array rather than failing loudly.
 */
const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body,
  headers: new Map(),
}) as unknown as Response;

const TOKEN_BODY = { access_token: "tok", expires_in: 3600 };

/** Capture every Graph URL; answer the token endpoint and empty collections. */
function stubFetch(): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("login.microsoftonline.com")) return jsonResponse(TOKEN_BODY);
    urls.push(u);
    return jsonResponse({ value: [] });
  }));
  return urls;
}

describe("entraIdService.listDirectoryPeople", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it("enumerates with $select + $filter + $top and NEVER with $search", async () => {
    const urls = stubFetch();
    await listEntra(ENTRA_CONFIG, FILTER);

    const users = urls.find((u) => u.includes("/v1.0/users"));
    expect(users).toBeTruthy();
    expect(users).toContain("$top=999");
    expect(decodeURIComponent(users!)).toContain("accountEnabled eq true and userType eq 'Member'");
    // The identity fields the picker needs, and the DN the OU filters match on.
    for (const f of ["jobTitle", "department", "businessPhones", "mobilePhone", "onPremisesDistinguishedName"]) {
      expect(users).toContain(f);
    }
    // The whole point of the separate reader.
    expect(urls.every((u) => !u.includes("$search"))).toBe(true);
  });

  it("asks for groups and org contacts only when the filter wants them", async () => {
    let urls = stubFetch();
    await listEntra(ENTRA_CONFIG, normalizeDirectorySyncFilter({ includeGroups: false, includeOrgContacts: false }));
    expect(urls.some((u) => u.includes("/v1.0/groups"))).toBe(false);
    expect(urls.some((u) => u.includes("/v1.0/contacts"))).toBe(false);

    vi.unstubAllGlobals();
    urls = stubFetch();
    await listEntra(ENTRA_CONFIG, normalizeDirectorySyncFilter({ includeGroups: true, includeOrgContacts: true }));
    expect(urls.some((u) => u.includes("/v1.0/groups"))).toBe(true);
    expect(urls.some((u) => u.includes("/v1.0/contacts"))).toBe(true);
  });

  it("degrades per collection — one refused grant must not abort the run", async () => {
    // An aborted run writes nothing, so a single missing grant would leave the
    // address book permanently empty with no partial result to diagnose from.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("login.microsoftonline.com")) return jsonResponse(TOKEN_BODY);
      if (u.includes("/v1.0/groups")) return jsonResponse({ error: { message: "Forbidden" } }, 403);
      return jsonResponse({ value: [{ id: "u1", mail: "jane@example.com", displayName: "Jane", jobTitle: "Operator" }] });
    }));

    const out = await listEntra(ENTRA_CONFIG, FILTER);
    expect(out.map((p) => p.email)).toContain("jane@example.com");
  });

  it("drops mailbox-less accounts and never falls back to the UPN", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("login.microsoftonline.com")) return jsonResponse(TOKEN_BODY);
      return jsonResponse({
        value: u.includes("/v1.0/users")
          ? [{ id: "u1", mail: null, userPrincipalName: "svc@example.com", displayName: "Service" }]
          : [],
      });
    }));

    // A UPN often isn't a routable address, so an account with no mailbox is
    // not a recipient at all.
    expect(await listEntra(ENTRA_CONFIG, FILTER)).toEqual([]);
  });

  it("reports mailboxKind 'unknown', because Graph cannot answer it in bulk", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("login.microsoftonline.com")) return jsonResponse(TOKEN_BODY);
      return jsonResponse({
        value: u.includes("/v1.0/users") ? [{ id: "u1", mail: "jane@example.com", displayName: "Jane" }] : [],
      });
    }));

    const out = await listEntra(ENTRA_CONFIG, FILTER);
    // Claiming "user" would be a guess; claiming "shared" would drop the tenant.
    expect(out[0].mailboxKind).toBe("unknown");
  });
});

// ─── LDAP ───────────────────────────────────────────────────────────────────

const AD_CONFIG = {
  host: "dc.corp.example", bindDn: "cn=svc", bindPassword: "p", baseDn: "DC=corp,DC=example",
} as unknown as Parameters<typeof listAd>[0];

/** Run the reader against a fake client and hand back the search options. */
async function captureAdSearch(entries: Record<string, unknown>[] = []) {
  let options: Record<string, any> | null = null;
  ldapMock.withBoundLdapClient.mockImplementation(async (_c: unknown, _s: unknown, fn: any) =>
    fn({ search: async (_base: string, opts: Record<string, unknown>) => { options = opts; return { searchEntries: entries }; } }));
  const result = await listAd(AD_CONFIG, FILTER);
  return { options: options as unknown as Record<string, any>, result };
}

describe("activeDirectoryService.listDirectoryPeople", () => {
  beforeEach(() => { ldapMock.withBoundLdapClient.mockReset(); });

  it("uses the paged-results control and the filter's own cap", async () => {
    // Without paging AD truncates at MaxPageSize (1000) and says nothing.
    const { options } = await captureAdSearch();
    expect(options.paged).toEqual({ pageSize: 1000 });
    expect(options.sizeLimit).toBe(FILTER.maxEntries);
    expect(options.timeLimit).toBe(120);
    expect(options.explicitBufferAttributes).toContain("objectGUID");
  });

  it("identifies entries by objectGUID, not by DN", async () => {
    // A DN changes when a person moves OU or is renamed, which would read as
    // "the old person left, a new one arrived" and churn the contact row on
    // every reorganization. The GUID survives both.
    const { result } = await captureAdSearch([{
      dn: "CN=Jane,OU=Staff,DC=corp,DC=example",
      objectGUID: Buffer.from("0123456789abcdef0123456789abcdef", "hex"),
      mail: "jane@example.com",
      displayName: "Jane Doe",
      title: "Operator",
      objectClass: ["top", "person", "user"],
    }]);
    expect(result).toHaveLength(1);
    expect(result[0].externalId).not.toContain("CN=");
    expect(result[0].externalId).toMatch(/^[0-9a-f]{32}$/);
    expect(result[0].distinguishedName).toBe("CN=Jane,OU=Staff,DC=corp,DC=example");
    expect(result[0].jobTitle).toBe("Operator");
  });

  it("skips an all-zero GUID rather than colliding every broken object onto one id", async () => {
    const { result } = await captureAdSearch([{
      dn: "CN=Broken,DC=corp,DC=example",
      objectGUID: Buffer.alloc(16),
      mail: "broken@example.com",
      objectClass: ["user"],
    }]);
    expect(result).toEqual([]);
  });

  it("only claims 'disabled' when userAccountControl was actually present", async () => {
    // Contacts and groups have no userAccountControl; absent is not "enabled".
    const { result } = await captureAdSearch([
      {
        dn: "CN=A,DC=x", objectGUID: Buffer.from("1".repeat(32), "hex"),
        mail: "a@example.com", objectClass: ["contact"],
      },
      {
        dn: "CN=B,DC=x", objectGUID: Buffer.from("2".repeat(32), "hex"),
        mail: "b@example.com", objectClass: ["user"], userAccountControl: "514",
      },
    ]);
    expect(result.find((r) => r.email === "a@example.com")!.disabled).toBeUndefined();
    expect(result.find((r) => r.email === "b@example.com")!.disabled).toBe(true);
  });
});
