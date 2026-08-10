/**
 * src/services/contactService.ts
 *
 * The address book: named email addresses alerts can route to, each optionally
 * owning a set of devices.
 *
 * Two distinct jobs, which is why this is a table rather than a free-text field:
 *
 *   1. A durable label for an address that has no Polaris account behind it —
 *      a distribution list, an on-call rotation, a vendor NOC. Before this,
 *      such an address could only be retyped into every automation.
 *   2. Device ownership. `assetCriteria` (the tagAssignmentService vocabulary)
 *      unioned with explicit `assetIds` pins says which devices a contact is
 *      responsible for — the MaintenanceSchedule target shape exactly. A notify
 *      action carrying `recipientAssetContacts` resolves that at fire time, so
 *      "email whoever owns this box" needs no per-rule recipient list.
 *
 * Fire-time matching (`resolveContactsForAsset`) evaluates each contact's
 * criteria against the ONE triggering asset via the pure `assetMatchesCriteria`
 * predicate — never a fleet scan. Cost is bounded by contact count, not asset
 * count, and the contact list itself rides a short-TTL cache so a delivery
 * expansion doesn't re-read the table per alert.
 *
 * Ownership: `createdBy` backs the `contacts` function key's ownership
 * dimension (write = your own rows, fullwrite = anyone's), the same mechanism
 * subnets and reservations use. Routes call assertOwnership; this service
 * stays level-agnostic apart from stamping createdBy on create.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { createTtlCache } from "../utils/ttlCache.js";
import {
  assetMatchesCriteria,
  cidrsContainingIp,
  collectCidrs,
  normalizeCriteria,
  resolveMatchingAssetIds,
  SINGLE_ASSET_CANDIDATE_SELECT,
  type TagCriteria,
} from "./tagAssignmentService.js";
import { listRecipientUsers } from "./notificationRecipientService.js";
import { logEvent } from "./eventLogService.js";
import { logger } from "../utils/logger.js";
import { MIN_DIRECTORY_QUERY, searchDirectory } from "./directorySearchService.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ContactRow {
  id: string;
  email: string;
  name: string | null;
  description: string | null;
  assetCriteria: TagCriteria | null;
  assetIds: string[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactInput {
  email: string;
  name?: string | null;
  description?: string | null;
  assetCriteria?: unknown;
  assetIds?: string[];
}

/**
 * One row in the unified address-book search. `source` says where the entry
 * came from so the picker can badge it; the directory sources (entra / ad) are
 * filled in by directorySearchService and never persisted.
 */
export interface AddressBookEntry {
  source: "user" | "contact" | "entra" | "ad";
  id: string;
  email: string;
  name: string | null;
  description: string | null;
  kind: "person" | "group";
  /** True when the caller may edit/delete this entry (contacts only). */
  owned?: boolean;
}

const MAX_ASSET_PINS = 500;

// ─── Normalization ──────────────────────────────────────────────────────────

/**
 * Addresses are compared case-insensitively everywhere downstream
 * (resolveEmailRecipients lower-cases before deduping), so the table stores the
 * lower-cased form and the unique index enforces case-insensitive uniqueness
 * for free.
 */
export function normalizeContactEmail(raw: unknown): string {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!email) throw new AppError(400, "Email address is required");
  if (email.length > 320) throw new AppError(400, "Email address is too long (max 320 characters)");
  // Deliberately permissive — the same shape Zod's .email() accepts, without
  // pulling Zod into a service. A directory can hand back addresses that a
  // stricter RFC parser would reject.
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) {
    throw new AppError(400, `"${email}" is not a valid email address`);
  }
  return email;
}

function trimOrNull(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return v ? v : null;
}

function normalizeAssetIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = Array.from(
    new Set(raw.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())),
  );
  if (out.length > MAX_ASSET_PINS) {
    throw new AppError(400, `Too many pinned devices (max ${MAX_ASSET_PINS})`);
  }
  return out;
}

function rowToContact(row: {
  id: string;
  email: string;
  name: string | null;
  description: string | null;
  assetCriteria: unknown;
  assetIds: string[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ContactRow {
  return {
    ...row,
    // Stored blobs are re-normalized on read rather than trusted: a criteria
    // shape written before a vocabulary change would otherwise reach the
    // matcher unvalidated.
    assetCriteria: normalizeCriteria(row.assetCriteria),
  };
}

// ─── Cache ──────────────────────────────────────────────────────────────────

// Fire-time resolution reads every contact on each alert; without this the
// delivery expansion would re-read the table per notification. 30s mirrors the
// recipient user index next door.
const CONTACT_CACHE_TTL_MS = 30_000;
const _contactCache = createTtlCache<ContactRow[]>({ ttlMs: CONTACT_CACHE_TTL_MS, maxEntries: 1 });

/** Drop the cached contact list (called after every contact write). */
export function bumpContactCache(): void {
  _contactCache.invalidate();
}

function loadContacts(): Promise<ContactRow[]> {
  return _contactCache.getOrCompute("", async () => {
    const rows = await prisma.contact.findMany({ orderBy: { email: "asc" } });
    return rows.map(rowToContact);
  });
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function listContacts(): Promise<ContactRow[]> {
  const rows = await prisma.contact.findMany({ orderBy: [{ name: "asc" }, { email: "asc" }] });
  return rows.map(rowToContact);
}

export async function getContact(id: string): Promise<ContactRow | null> {
  const row = await prisma.contact.findUnique({ where: { id } });
  return row ? rowToContact(row) : null;
}

export async function createContact(input: ContactInput, createdBy: string | null): Promise<ContactRow> {
  const email = normalizeContactEmail(input.email);
  const assetCriteria = normalizeCriteria(input.assetCriteria ?? null);
  const assetIds = normalizeAssetIds(input.assetIds);

  const existing = await prisma.contact.findUnique({ where: { email }, select: { id: true, name: true } });
  if (existing) {
    throw new AppError(409, `"${email}" is already in the address book${existing.name ? ` as "${existing.name}"` : ""}`);
  }

  const row = await prisma.contact.create({
    data: {
      email,
      name: trimOrNull(input.name),
      description: trimOrNull(input.description),
      assetCriteria: (assetCriteria ?? undefined) as never,
      assetIds,
      createdBy,
    },
  });
  bumpContactCache();
  await logEvent({
    action: "contact.created",
    resourceType: "contact",
    resourceId: row.id,
    resourceName: row.email,
    actor: createdBy ?? undefined,
    message: `Added ${row.name ? `"${row.name}" <${row.email}>` : row.email} to the address book${describeTargets(assetCriteria, assetIds)}`,
  });
  return rowToContact(row);
}

/** " (covering N pinned devices + a filter)" — audit detail, "" when untargeted. */
function describeTargets(criteria: TagCriteria | null, assetIds: string[]): string {
  const parts: string[] = [];
  if (criteria) parts.push(`${criteria.rules.length} filter rule${criteria.rules.length === 1 ? "" : "s"}`);
  if (assetIds.length) parts.push(`${assetIds.length} pinned device${assetIds.length === 1 ? "" : "s"}`);
  return parts.length ? ` (device ownership: ${parts.join(" + ")})` : "";
}

export async function updateContact(id: string, input: ContactInput, actor?: string): Promise<ContactRow> {
  const email = normalizeContactEmail(input.email);
  const assetCriteria = normalizeCriteria(input.assetCriteria ?? null);
  const assetIds = normalizeAssetIds(input.assetIds);

  const clash = await prisma.contact.findUnique({ where: { email }, select: { id: true } });
  if (clash && clash.id !== id) {
    throw new AppError(409, `"${email}" is already in the address book`);
  }

  const row = await prisma.contact.update({
    where: { id },
    data: {
      email,
      name: trimOrNull(input.name),
      description: trimOrNull(input.description),
      // null must be written explicitly — `undefined` would leave a stale
      // criteria blob in place when the operator clears the filter.
      assetCriteria: (assetCriteria ?? null) as never,
      assetIds,
    },
  });
  bumpContactCache();
  await logEvent({
    action: "contact.updated",
    resourceType: "contact",
    resourceId: row.id,
    resourceName: row.email,
    actor,
    message: `Updated address-book entry ${row.name ? `"${row.name}" <${row.email}>` : row.email}${describeTargets(assetCriteria, assetIds)}`,
  });
  return rowToContact(row);
}

export async function deleteContact(id: string, actor?: string): Promise<void> {
  // Read first so the audit event can name what was removed — a bare id in the
  // log is useless once the row is gone.
  const existing = await prisma.contact.findUnique({ where: { id }, select: { email: true, name: true } });
  await prisma.contact.delete({ where: { id } });
  bumpContactCache();
  await logEvent({
    action: "contact.deleted",
    resourceType: "contact",
    resourceId: id,
    resourceName: existing?.email,
    actor,
    message: `Removed ${existing?.name ? `"${existing.name}" <${existing.email}>` : (existing?.email ?? id)} from the address book`,
  });
}

// ─── Asset targeting ────────────────────────────────────────────────────────

export interface ContactAssetPreview {
  matchCount: number;
  sample: Array<{ id: string; hostname: string | null; ipAddress: string | null; assetType: string }>;
}

/**
 * Dry-run for the editor: which devices a (criteria, pins) pair covers right
 * now. Union of criteria matches and explicit pins — unlike MaintenanceSchedule
 * this is NOT intersected with monitored=true, because an unmonitored device
 * still has an owner worth emailing (an event/change automation can fire on it).
 */
export async function previewContactAssets(
  rawCriteria: unknown,
  rawAssetIds: unknown,
): Promise<ContactAssetPreview> {
  const criteria = normalizeCriteria(rawCriteria);
  const assetIds = normalizeAssetIds(rawAssetIds);

  const union = new Set<string>(assetIds);
  if (criteria) {
    for (const id of await resolveMatchingAssetIds(criteria)) union.add(id);
  }
  if (union.size === 0) return { matchCount: 0, sample: [] };

  const sample = await prisma.asset.findMany({
    where: { id: { in: Array.from(union) } },
    select: { id: true, hostname: true, ipAddress: true, assetType: true },
    orderBy: { hostname: "asc" },
    take: 100,
  });
  return { matchCount: union.size, sample };
}

/**
 * The contacts responsible for ONE asset — the fire-time path.
 *
 * Deliberately shaped to avoid a fleet scan: the asset is loaded once, and each
 * contact's criteria is tested against it in memory. Subnet rules need CIDR
 * containment, which is a single inet round-trip across every contact's CIDRs
 * combined (and skipped entirely when no contact filters by subnet — the common
 * case). Cost therefore scales with the number of CONTACTS, not with fleet size.
 *
 * Mirrors reconcileTagsForAsset, which does the same thing for managed tags.
 */
export async function resolveContactsForAsset(assetId: string): Promise<ContactRow[]> {
  const contacts = await loadContacts();
  if (contacts.length === 0) return [];

  // Pinned-only contacts need no asset load at all.
  const byPin = contacts.filter((c) => c.assetIds.includes(assetId));
  const withCriteria = contacts.filter((c) => c.assetCriteria != null);
  if (withCriteria.length === 0) return byPin;

  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: SINGLE_ASSET_CANDIDATE_SELECT,
  });
  if (!asset) return byPin;

  const allCidrs = withCriteria.flatMap((c) => collectCidrs(c.assetCriteria as TagCriteria));
  const matchedCidrs = await cidrsContainingIp(asset.ipAddress, allCidrs);

  const out = new Map<string, ContactRow>();
  for (const c of byPin) out.set(c.id, c);
  for (const c of withCriteria) {
    if (out.has(c.id)) continue; // already covered by a pin
    if (assetMatchesCriteria(asset, c.assetCriteria as TagCriteria, matchedCidrs)) out.set(c.id, c);
  }
  return Array.from(out.values());
}

/** Just the addresses — what the delivery expansion actually needs. */
export async function resolveContactEmailsForAsset(assetId: string): Promise<string[]> {
  const contacts = await resolveContactsForAsset(assetId);
  return contacts.map((c) => c.email);
}

// ─── Unified address-book search ────────────────────────────────────────────

/**
 * Search everything Polaris knows how to address: its own user accounts and the
 * contacts table (and, when `includeDirectory` is set and a directory
 * integration opted in, the organization's GAL — filled in by
 * directorySearchService).
 *
 * Deduped by lower-cased email with **user winning over contact**: a Polaris
 * user id is the more durable token because it survives the person changing
 * address, whereas a stored contact address does not.
 */
export async function searchAddressBook(
  query: string,
  opts: { limit?: number; callerUsername?: string | null; includeDirectory?: boolean } = {},
): Promise<AddressBookEntry[]> {
  const limit = opts.limit ?? 50;
  const q = String(query ?? "").trim().toLowerCase();

  const [users, contacts] = await Promise.all([listRecipientUsers(), listContacts()]);

  const entries: AddressBookEntry[] = [];
  for (const u of users) {
    if (!u.email) continue; // an account with no address can't be an email recipient
    entries.push({
      source: "user",
      id: u.id,
      email: u.email,
      name: u.displayName || u.username,
      description: "Polaris user account",
      kind: "person",
    });
  }
  for (const c of contacts) {
    entries.push({
      source: "contact",
      id: c.id,
      email: c.email,
      name: c.name,
      description: c.description,
      kind: "person",
      owned: !!opts.callerUsername && c.createdBy === opts.callerUsername,
    });
  }

  // Directory (GAL) hits rank BELOW the local sources: a Polaris account or a
  // curated contact is the entry an operator meant, and the directory is the
  // long tail. Live only — nothing here is persisted (see directorySearchService).
  if (opts.includeDirectory && q.length >= MIN_DIRECTORY_QUERY) {
    try {
      for (const d of await searchDirectory(q, limit)) {
        entries.push({
          source: d.source,
          id: d.id,
          email: d.email,
          name: d.name,
          description: d.description,
          kind: d.kind,
        });
      }
    } catch (err) {
      // A directory outage must not break the local typeahead.
      logger.warn({ err }, "Directory search failed; returning local address-book results only");
    }
  }

  const seen = new Set<string>();
  const deduped = entries.filter((e) => {
    const key = e.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const filtered = q
    ? deduped.filter(
        (e) => e.email.toLowerCase().includes(q) || (e.name ?? "").toLowerCase().includes(q),
      )
    : deduped;

  // Prefix matches first — the same ranking the appmap/scope typeaheads use, so
  // typing "no" surfaces "noc@…" above "jane.donovan@…".
  const ranked = q
    ? filtered.sort((a, b) => {
        const aPre = a.email.toLowerCase().startsWith(q) || (a.name ?? "").toLowerCase().startsWith(q);
        const bPre = b.email.toLowerCase().startsWith(q) || (b.name ?? "").toLowerCase().startsWith(q);
        if (aPre !== bPre) return aPre ? -1 : 1;
        return (a.name ?? a.email).localeCompare(b.name ?? b.email);
      })
    : filtered;

  return ranked.slice(0, limit);
}
