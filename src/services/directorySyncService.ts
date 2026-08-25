/**
 * src/services/directorySyncService.ts
 *
 * Scheduled sync of the organization's Global Address List into the Polaris
 * address book. See business rule 35.
 *
 * SYNCED, unlike its sibling. `directorySearchService` answers one typeahead
 * live and persists NOTHING; this materializes the roster as `Contact` rows so
 * alert recipients and device ownership can be picked from the company
 * directory without an operator curating the book by hand. That reverses the
 * deliberate "never store it" posture the search path was built with, and the
 * mitigations below are the price of the reversal — not decoration.
 *
 * PII POSTURE. Every non-excluded GAL entry lands in Postgres carrying a
 * primary SMTP address, display name, job title, department and phone, plus a
 * per-source `observed` blob holding the AD distinguished name or Entra object
 * id. All of it rides every pg_dump the install produces, including the
 * off-host backup copies.
 *
 * **None of it may reach `Event.details` or the logs.** Events are readable by
 * anyone holding events access and are shipped off-host by the syslog (CEF) and
 * SFTP archivers, so this service's Events carry COUNTS ONLY and its warnings
 * name integrations, never people. The one deliberate exception lives in
 * contactService: `contact.adopted` names the address, exactly as
 * `contact.created` already does — a single act by a person is audited by name,
 * bulk machine activity is anonymous. Do not "fix" that asymmetry.
 *
 * Opt-in per integration (`config.enableDirectorySync`, default false),
 * deliberately SEPARATE from `enableDirectorySearch`: they need the same
 * directory grants but they are not the same decision, because one reads and
 * one stores.
 */

import { matchesWildcard } from "../utils/integrationFilter.js";

/**
 * One directory entry as the bulk readers report it. A superset of the live
 * search's `DirectoryHit`: the extra fields are either stored on the contact
 * (jobTitle / department / phone) or exist only so `directoryExclusionReason`
 * can judge the entry (disabled / mailboxKind / distinguishedName / groupDns).
 */
export interface DirectoryPerson {
  /** Graph object id, or AD objectGUID hex. Stable across renames. */
  externalId: string;
  email: string;
  name: string | null;
  jobTitle: string | null;
  department: string | null;
  phone: string | null;
  description: string | null;
  kind: "person" | "group";
  /** AD only — what the OU include/exclude patterns match against. */
  distinguishedName?: string;
  /** True when the directory says the account is disabled. */
  disabled?: boolean;
  /**
   * AD reports this honestly via msExchRecipientTypeDetails. Graph does NOT
   * expose a mailbox type on /users at all, so the Entra reader leaves this
   * "unknown" rather than guessing — see the exclusion note below.
   */
  mailboxKind?: "user" | "shared" | "room" | "equipment" | "unknown";
  /** Group DNs (AD) or group object ids (Entra) this entry belongs to. */
  groupDns?: string[];
}

/** The operator's exclusion filter, normalized. */
export interface DirectorySyncFilter {
  excludeDisabled: boolean;
  excludeSharedMailboxes: boolean;
  includeGroups: boolean;
  includeOrgContacts: boolean;
  /** AD OU patterns matched against the DN. Include WINS over exclude. */
  ouInclude: string[];
  ouExclude: string[];
  /** Group DNs / object ids whose members are excluded. */
  groupExclude: string[];
  /** Email domains, without the "@". Include WINS over exclude. */
  domainInclude: string[];
  domainExclude: string[];
  /** Glob-lite patterns matched against display name AND address. */
  nameExclude: string[];
  /** Hard cap on entries read per integration per run. */
  maxEntries: number;
}

export const DIRECTORY_SYNC_DEFAULT_MAX_ENTRIES = 20_000;
export const DIRECTORY_SYNC_MAX_ENTRIES_CEILING = 50_000;

function strArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/**
 * Read the `directorySync` config block into a filter, applying defaults.
 *
 * Defaults are deliberately conservative on the two that REMOVE people
 * (disabled accounts and shared mailboxes are excluded) and permissive on the
 * one that adds a whole class (`includeGroups`), because a distribution list is
 * usually exactly what an operator wants to alert. Org contacts default OFF:
 * they are external parties, and mailing a vendor's shared address because it
 * happened to be in the GAL is not a mistake worth making by default.
 */
export function normalizeDirectorySyncFilter(raw: unknown): DirectorySyncFilter {
  const c = (raw ?? {}) as Record<string, unknown>;
  const cap = Number(c.maxEntries);
  return {
    excludeDisabled: bool(c.excludeDisabled, true),
    excludeSharedMailboxes: bool(c.excludeSharedMailboxes, true),
    includeGroups: bool(c.includeGroups, true),
    includeOrgContacts: bool(c.includeOrgContacts, false),
    ouInclude: strArray(c.ouInclude),
    ouExclude: strArray(c.ouExclude),
    groupExclude: strArray(c.groupExclude),
    domainInclude: strArray(c.domainInclude).map((d) => d.replace(/^@/, "").toLowerCase()),
    domainExclude: strArray(c.domainExclude).map((d) => d.replace(/^@/, "").toLowerCase()),
    nameExclude: strArray(c.nameExclude),
    maxEntries: Number.isFinite(cap) && cap > 0
      ? Math.min(Math.trunc(cap), DIRECTORY_SYNC_MAX_ENTRIES_CEILING)
      : DIRECTORY_SYNC_DEFAULT_MAX_ENTRIES,
  };
}

/** The domain half of an address, lower-cased. "" when there isn't one. */
function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

/**
 * Why this entry should NOT become a contact, or null to keep it.
 *
 * PURE, and returns a REASON rather than a boolean so the run summary can
 * report the dominant cause — "4,102 excluded" is not actionable, "4,102
 * excluded, mostly disabled accounts" is. The reason is a category, never a
 * name: it ends up in an Event, and Events must not carry directory PII.
 *
 * Include-wins-over-exclude for both OU and domain matches the existing AD
 * device-filter semantics (`filterDevices`), so an operator who has configured
 * one already knows how the other behaves.
 */
export function directoryExclusionReason(
  entry: DirectoryPerson,
  filter: DirectorySyncFilter,
): string | null {
  if (!entry.email) return "no email address";

  if (entry.kind === "group" && !filter.includeGroups) return "distribution list";

  if (filter.excludeDisabled && entry.disabled === true) return "disabled account";

  // Only ever excludes on a POSITIVE identification. "unknown" is what the
  // Entra reader reports for every user, because Graph cannot answer this
  // without a per-mailbox call; treating unknown as shared would silently drop
  // the entire tenant.
  if (
    filter.excludeSharedMailboxes &&
    entry.mailboxKind &&
    entry.mailboxKind !== "user" &&
    entry.mailboxKind !== "unknown"
  ) {
    return `${entry.mailboxKind} mailbox`;
  }

  const dn = entry.distinguishedName ?? "";
  if (filter.ouInclude.length > 0) {
    if (!dn || !filter.ouInclude.some((p) => matchesWildcard(p, dn))) return "outside the included OUs";
  } else if (filter.ouExclude.length > 0 && dn) {
    if (filter.ouExclude.some((p) => matchesWildcard(p, dn))) return "in an excluded OU";
  }

  const domain = domainOf(entry.email);
  if (filter.domainInclude.length > 0) {
    if (!filter.domainInclude.includes(domain)) return "outside the included domains";
  } else if (filter.domainExclude.length > 0 && filter.domainExclude.includes(domain)) {
    return "in an excluded domain";
  }

  if (filter.groupExclude.length > 0 && entry.groupDns?.length) {
    const groups = entry.groupDns.map((g) => g.toLowerCase());
    if (filter.groupExclude.some((g) => groups.includes(g.toLowerCase()))) {
      return "member of an excluded group";
    }
  }

  if (filter.nameExclude.length > 0) {
    const name = entry.name ?? "";
    if (filter.nameExclude.some((p) => matchesWildcard(p, name) || matchesWildcard(p, entry.email))) {
      return "matched a name exclusion";
    }
  }

  return null;
}

/** A provenance row's stored view, as the projection consumes it. */
export interface DirectorySourceView {
  sourceKind: string;
  observed: DirectoryPerson;
}

/** What a Contact row's directory-owned fields should be. */
export interface ProjectedContact {
  name: string | null;
  kind: string;
  jobTitle: string | null;
  department: string | null;
  phone: string | null;
  description: string | null;
  origin: string;
}

/**
 * Priority order when a person is present in more than one directory. Entra
 * outranks AD because a hybrid tenant's cloud objects are what HR-driven
 * provisioning writes to first; an on-prem-only person has no Entra source at
 * all and is unaffected by the ordering.
 */
const SOURCE_RANK: Record<string, number> = { entra: 0, ad: 1 };

function rankOf(sourceKind: string): number {
  return SOURCE_RANK[sourceKind] ?? 99;
}

/**
 * Project a contact's directory-owned fields from the set of sources feeding
 * it, highest-priority non-empty value winning PER FIELD.
 *
 * Projected rather than last-writer-wins for one specific reason: with two
 * directories that disagree about a job title, whichever ran most recently
 * would win, so the row would flip on every cycle — a write per contact per
 * run, an audit trail full of churn, and a value that is never stably either
 * answer. Deriving it from the full source set makes the result a function of
 * the inputs, so a steady state is genuinely steady. This is the
 * AssetSource / projectAssetFromSources shape at contact scale.
 *
 * Fixed and documented rather than operator-ordered; if an install ever
 * disagrees, an `assetSourcePriority`-style Setting is the extension point.
 */
export function projectContactFromSources(sources: DirectorySourceView[]): ProjectedContact {
  const ordered = [...sources].sort((a, b) => rankOf(a.sourceKind) - rankOf(b.sourceKind));

  const pick = (get: (o: DirectoryPerson) => string | null | undefined): string | null => {
    for (const s of ordered) {
      const v = get(s.observed ?? ({} as DirectoryPerson));
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    return null;
  };

  return {
    name: pick((o) => o.name),
    // A group in ANY source is a group: the distinction changes who an
    // operator thinks they are mailing, so the more specific claim wins over a
    // source that merely didn't say.
    kind: ordered.some((s) => s.observed?.kind === "group") ? "group" : "person",
    jobTitle: pick((o) => o.jobTitle),
    department: pick((o) => o.department),
    phone: pick((o) => o.phone),
    description: pick((o) => o.description),
    // The origin is the highest-priority source present, so a person who exists
    // in both directories badges as Entra — matching where the projected values
    // mostly came from.
    origin: ordered.length ? ordered[0].sourceKind : "manual",
  };
}
