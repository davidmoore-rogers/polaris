/**
 * tests/unit/directorySyncFilter.test.ts
 *
 * The two PURE decisions behind the address-book directory (GAL) sync
 * (business rule 35):
 *
 *   - directoryExclusionReason  — who does NOT become a contact, and why. The
 *     reason is a category rather than a name because it ends up in an Event,
 *     and Events must not carry directory PII.
 *   - projectContactFromSources — what a contact's fields are when the same
 *     person exists in two directories that disagree.
 *
 * Plus buildGalLdapFilter, which is pure for exactly this reason: an LDAP filter
 * either selects the right population or silently selects the wrong one, and
 * pinning the string is far cheaper than finding out against a live directory.
 */

import { describe, it, expect } from "vitest";
import {
  DIRECTORY_SYNC_DEFAULT_MAX_ENTRIES,
  DIRECTORY_SYNC_MAX_ENTRIES_CEILING,
  directoryExclusionReason,
  normalizeDirectorySyncFilter,
  projectContactFromSources,
  type DirectoryPerson,
  type DirectorySyncFilter,
} from "../../src/services/directorySyncService.js";
import { buildGalLdapFilter } from "../../src/services/activeDirectoryService.js";

const F = (over: Partial<DirectorySyncFilter> = {}): DirectorySyncFilter => ({
  ...normalizeDirectorySyncFilter({}),
  ...over,
});

const P = (over: Partial<DirectoryPerson> = {}): DirectoryPerson => ({
  externalId: "x1",
  email: "jane@example.com",
  name: "Jane Doe",
  jobTitle: null,
  department: null,
  phone: null,
  description: null,
  kind: "person",
  ...over,
});

describe("normalizeDirectorySyncFilter", () => {
  it("defaults to excluding the two classes that are rarely people", () => {
    const f = normalizeDirectorySyncFilter({});
    expect(f.excludeDisabled).toBe(true);
    expect(f.excludeSharedMailboxes).toBe(true);
    // Distribution lists usually ARE what an operator wants to alert.
    expect(f.includeGroups).toBe(true);
    // Org contacts are external parties — mailing a vendor because they were in
    // the GAL is not a mistake worth making by default.
    expect(f.includeOrgContacts).toBe(false);
    expect(f.maxEntries).toBe(DIRECTORY_SYNC_DEFAULT_MAX_ENTRIES);
  });

  it("clamps the entry cap and strips a leading @ from domains", () => {
    expect(normalizeDirectorySyncFilter({ maxEntries: 10_000_000 }).maxEntries)
      .toBe(DIRECTORY_SYNC_MAX_ENTRIES_CEILING);
    expect(normalizeDirectorySyncFilter({ maxEntries: 0 }).maxEntries)
      .toBe(DIRECTORY_SYNC_DEFAULT_MAX_ENTRIES);
    expect(normalizeDirectorySyncFilter({ domainExclude: ["@Contoso.com", " partner.example "] }).domainExclude)
      .toEqual(["contoso.com", "partner.example"]);
  });
});

describe("directoryExclusionReason", () => {
  it("keeps an ordinary person", () => {
    expect(directoryExclusionReason(P(), F())).toBeNull();
  });

  it("drops an entry with no address — it can never be a recipient", () => {
    expect(directoryExclusionReason(P({ email: "" }), F())).toMatch(/no email/i);
  });

  it("drops disabled accounts when asked, and keeps them when not", () => {
    expect(directoryExclusionReason(P({ disabled: true }), F())).toMatch(/disabled/i);
    expect(directoryExclusionReason(P({ disabled: true }), F({ excludeDisabled: false }))).toBeNull();
  });

  it("excludes a shared mailbox only on a POSITIVE identification", () => {
    expect(directoryExclusionReason(P({ mailboxKind: "room" }), F())).toMatch(/room mailbox/i);
    expect(directoryExclusionReason(P({ mailboxKind: "user" }), F())).toBeNull();
    // "unknown" is what Graph forces (it exposes no mailbox type on /users) and
    // what AD reports with no Exchange schema. Treating it as shared would
    // silently drop an entire tenant.
    expect(directoryExclusionReason(P({ mailboxKind: "unknown" }), F())).toBeNull();
    expect(directoryExclusionReason(P({ mailboxKind: undefined }), F())).toBeNull();
  });

  it("drops distribution lists only when groups are switched off", () => {
    expect(directoryExclusionReason(P({ kind: "group" }), F())).toBeNull();
    expect(directoryExclusionReason(P({ kind: "group" }), F({ includeGroups: false })))
      .toMatch(/distribution list/i);
  });

  describe("OU scoping (include WINS over exclude, matching filterDevices)", () => {
    const inside = P({ distinguishedName: "CN=Jane,OU=Staff,DC=corp,DC=example" });
    const outside = P({ distinguishedName: "CN=Svc,OU=Service Accounts,DC=corp,DC=example" });

    it("keeps only the included OUs when an include list is set", () => {
      const f = F({ ouInclude: ["*OU=Staff,*"], ouExclude: ["*OU=Staff,*"] });
      expect(directoryExclusionReason(inside, f)).toBeNull();
      expect(directoryExclusionReason(outside, f)).toMatch(/outside the included OUs/i);
    });

    it("falls back to the exclude list when there is no include list", () => {
      const f = F({ ouExclude: ["*OU=Service Accounts,*"] });
      expect(directoryExclusionReason(inside, f)).toBeNull();
      expect(directoryExclusionReason(outside, f)).toMatch(/excluded OU/i);
    });

    it("excludes an entry with NO DN when an include list is set", () => {
      // An entry the include list cannot possibly match is out — the operator
      // said "only these OUs", and "we don't know where it is" is not one.
      expect(directoryExclusionReason(P({ distinguishedName: undefined }), F({ ouInclude: ["*OU=Staff,*"] })))
        .toMatch(/outside the included OUs/i);
    });
  });

  it("scopes by email domain, include winning over exclude", () => {
    const partner = P({ email: "bob@partner.example" });
    expect(directoryExclusionReason(partner, F({ domainExclude: ["partner.example"] })))
      .toMatch(/excluded domain/i);
    expect(directoryExclusionReason(partner, F({ domainInclude: ["example.com"] })))
      .toMatch(/outside the included domains/i);
    expect(directoryExclusionReason(P(), F({ domainInclude: ["example.com"] }))).toBeNull();
  });

  it("excludes members of an excluded group, case-insensitively", () => {
    const f = F({ groupExclude: ["CN=Contractors,DC=corp,DC=example"] });
    expect(directoryExclusionReason(P({ groupDns: ["cn=contractors,dc=corp,dc=example"] }), f))
      .toMatch(/excluded group/i);
    expect(directoryExclusionReason(P({ groupDns: ["CN=Staff,DC=corp,DC=example"] }), f)).toBeNull();
  });

  it("matches name exclusions against BOTH the display name and the address", () => {
    expect(directoryExclusionReason(P({ name: "svc-backup" }), F({ nameExclude: ["svc-*"] })))
      .toMatch(/name exclusion/i);
    expect(directoryExclusionReason(P({ name: "Jane Doe", email: "noreply@example.com" }), F({ nameExclude: ["noreply@*"] })))
      .toMatch(/name exclusion/i);
    expect(directoryExclusionReason(P(), F({ nameExclude: ["svc-*"] }))).toBeNull();
  });
});

describe("projectContactFromSources", () => {
  const src = (sourceKind: string, over: Partial<DirectoryPerson>) => ({
    sourceKind,
    observed: P(over),
  });

  it("takes the highest-priority NON-EMPTY value per field", () => {
    const out = projectContactFromSources([
      src("ad", { name: "J. Doe", jobTitle: "Operator", department: "Quarry Ops", phone: "555-1000" }),
      src("entra", { name: "Jane Doe", jobTitle: null, department: "Operations", phone: null }),
    ]);
    expect(out.name).toBe("Jane Doe");          // entra outranks ad
    expect(out.department).toBe("Operations");
    expect(out.jobTitle).toBe("Operator");      // entra had none, so ad fills in
    expect(out.phone).toBe("555-1000");
    expect(out.origin).toBe("entra");
  });

  it("is STABLE under source order — the whole reason it is a projection", () => {
    // Last-writer-wins would flip this row on every cycle: a write per contact
    // per run, an audit trail full of churn, and a value that is never stably
    // either answer.
    const a = src("ad", { jobTitle: "Operator" });
    const b = src("entra", { jobTitle: "Plant Operator" });
    const one = projectContactFromSources([a, b]);
    const two = projectContactFromSources([b, a]);
    expect(one).toEqual(two);
    expect(one.jobTitle).toBe("Plant Operator");
  });

  it("treats whitespace as empty and trims what it keeps", () => {
    const out = projectContactFromSources([
      src("entra", { jobTitle: "   " }),
      src("ad", { jobTitle: "  Foreman  " }),
    ]);
    expect(out.jobTitle).toBe("Foreman");
  });

  it("a group in ANY source is a group", () => {
    // The distinction changes who an operator thinks they are mailing, so the
    // more specific claim beats a source that merely didn't say.
    const out = projectContactFromSources([
      src("entra", { kind: "person" }),
      src("ad", { kind: "group" }),
    ]);
    expect(out.kind).toBe("group");
  });

  it("reports manual origin for an empty source set", () => {
    expect(projectContactFromSources([]).origin).toBe("manual");
  });
});

describe("buildGalLdapFilter", () => {
  it("always requires an address and selects people and contacts", () => {
    const f = buildGalLdapFilter(F({ excludeDisabled: false, excludeSharedMailboxes: false, includeGroups: false }));
    expect(f).toBe("(&(mail=*)(|(&(objectCategory=person)(objectClass=user))(objectClass=contact)))");
  });

  it("adds mail-enabled groups at the SOURCE rather than fetching and dropping them", () => {
    const f = buildGalLdapFilter(F({ excludeDisabled: false, excludeSharedMailboxes: false, includeGroups: true }));
    expect(f).toContain("(&(objectClass=group)(mail=*))");
  });

  it("excludes disabled accounts with the bit-AND matching rule", () => {
    const f = buildGalLdapFilter(F({ excludeSharedMailboxes: false }));
    expect(f).toContain("(!(userAccountControl:1.2.840.113556.1.4.803:=2))");
  });

  it("excludes shared, room and equipment mailboxes by Exchange type", () => {
    const f = buildGalLdapFilter(F({ excludeDisabled: false }));
    expect(f).toContain("(!(msExchRecipientTypeDetails=4))");
    expect(f).toContain("(!(msExchRecipientTypeDetails=16))");
    expect(f).toContain("(!(msExchRecipientTypeDetails=32))");
  });

  it("never puts OU patterns in the filter — LDAP cannot express a DN wildcard", () => {
    const f = buildGalLdapFilter(F({ ouInclude: ["*OU=Staff,*"], ouExclude: ["*OU=Svc,*"] }));
    expect(f).not.toContain("OU=");
  });
});
