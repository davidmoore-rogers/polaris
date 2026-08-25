/**
 * src/services/notificationRecipientService.ts
 *
 * Routing layer between a fired notification and the concrete recipients of
 * its outbound delivery. Two responsibilities:
 *
 *   resolveRecipientUsers(tags) — which users a set of recipient tags routes
 *     to. A user matches when their effective region/other tag scope
 *     (union(role, user, group) via regionScopeService) intersects the tags.
 *     Region tags compare on their stripped, lower-cased form so a target tag
 *     "region:Atlanta" matches a user whose regionTags include "Atlanta".
 *
 *   expandDeliveries(notificationId, targets) — turn a rule's `targets[]` into
 *     concrete NotificationDelivery rows (one per channel per recipient),
 *     snapshotting recipients at fire time. The deliverNotifications job drains
 *     them. In-app delivery is NOT represented here — it's the Notification row
 *     itself.
 *
 * Recipients are looked up against a short-TTL in-memory index of all users'
 * tag scopes so a tick that fires many notifications resolves once, not
 * per-notification.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import type { Prisma } from "../generated/prisma/client.js";
import { resolveTagScopesForUser } from "./regionScopeService.js";
import { createTtlCache } from "../utils/ttlCache.js";
import { stripRegionPrefix } from "./notificationService.js";
import {
  deviceRegionsAtLevels,
  regionLevelIndex,
  type RegionLevelIndex,
} from "./regionHierarchyService.js";
import {
  renderNotificationTemplate,
  substituteAckToken,
  ackUrlForEmail,
  ackUrlForPush,
} from "../utils/notificationTemplate.js";
import { defaultAlertEmailTemplate, pruneDeadLinks, pruneEmptyDivs, pruneEmptyRows, pruneEmptyTextLines } from "../utils/alertEmailTemplate.js";
import { mintAckTokens, type AckChannel } from "./notificationAckService.js";
import { permissionOf, rankMeets, type AccessLevel } from "../api/middleware/permissions.js";
import {
  type DeliveryTarget,
  type ChannelType,
  type EmailRecipients,
  type EmailComposition,
  CHANNEL_TYPES,
  CHANNEL_TRANSPORT,
} from "./notificationTypes.js";

/**
 * A pre-rendered outbound email (subject/text/html built by the engine at fire
 * time; escalation renders its own at sweep time). cc/bcc arrive UNresolved —
 * this service resolves them to addresses, since recipients are its job.
 * Presence of a ComposedEmail switches email targets to the one-email-per-
 * target model (single delivery row carrying the full To list + Cc + Bcc).
 */
export interface ComposedEmail {
  subject: string;
  text: string;
  html?: string;
  cc?: EmailRecipients | null;
  bcc?: EmailRecipients | null;
}

/**
 * Render the composed outbound email for a composition config from a built
 * context. Any piece the operator left blank falls back to the shared DEFAULT
 * alert template (alertEmailTemplate.ts) — the same strings the automation
 * wizard prefills into a new Notify action, so what Polaris sends and what the
 * operator can edit are one text. cc/bcc pass through unresolved (resolved at
 * expansion time). Lives here (not the engine) so the action-execution layer
 * can compose without a circular import; the engine re-exports it.
 *
 * Empty rows are pruned AFTER rendering: every {asset.*} token renders "" when
 * the field is unset, so a device with no AP and no model would otherwise mail
 * a table of blank cells.
 */
export function buildComposedEmail(comp: EmailComposition, ctx: Record<string, string>): ComposedEmail {
  const def = defaultAlertEmailTemplate();
  const own = (tpl: string | null | undefined) => !!tpl?.trim();
  // Our own default renders unknown tokens blank; an operator's template keeps
  // them literal, so their typo stays visible instead of vanishing.
  const optsFor = (operatorAuthored: boolean, html?: boolean) =>
    ({ ...(html ? { html: true } : {}), ...(operatorAuthored ? {} : { unknown: "blank" as const }) });

  const subject = renderNotificationTemplate(
    own(comp.subjectTemplate) ? comp.subjectTemplate! : def.subjectTemplate,
    ctx,
    optsFor(own(comp.subjectTemplate)),
  );
  const text = renderNotificationTemplate(
    own(comp.bodyTextTemplate) ? comp.bodyTextTemplate! : def.bodyTextTemplate,
    ctx,
    optsFor(own(comp.bodyTextTemplate)),
  );
  const html = renderNotificationTemplate(
    own(comp.bodyHtmlTemplate) ? comp.bodyHtmlTemplate! : def.bodyHtmlTemplate,
    ctx,
    optsFor(own(comp.bodyHtmlTemplate), true),
  );
  return {
    // A blank token can leave a dangling separator ("host — "); tidy the tail
    // rather than making the subject template conditional.
    subject: subject.replace(/[\s—\-–:|]+$/u, "").trim(),
    text: pruneEmptyTextLines(text),
    // Dead links are pruned again after the per-recipient {ack} fill, since
    // that is when a recipient without a link gets an empty href.
    html: pruneDeadLinks(pruneEmptyDivs(pruneEmptyRows(html))),
    cc: comp.cc ?? undefined,
    bcc: comp.bcc ?? undefined,
  };
}

export interface RecipientUser {
  id: string;
  email: string | null;
  displayName: string | null;
}

interface IndexedUser extends RecipientUser {
  /** Lower-cased, region-prefix-stripped union of effective region+other tags. */
  matchSet: Set<string>;
  /**
   * Effective REGION tags only, lower-cased. Separate from matchSet because
   * that one flattens region ∪ other into one namespace — tolerable for the
   * legacy free-form `recipientTags`, but wrong once an operator explicitly
   * picks a *region*: a user whose unrelated "other" tag happened to read
   * "Atlanta" would receive Atlanta's alerts. recipientRegions /
   * recipientAllRegions match on this; recipientTags keeps matchSet.
   */
  regionSet: Set<string>;
  /** The user's Role id — recipientRoles routes by it. */
  roleId: string;
  /**
   * Does this user's role grant alerts:write? Decides whether they get a
   * one-click acknowledge link. Resolved inside this 30s-cached index — one
   * extra role read per cache window rather than one per notification —
   * because the alternative is mailing an Acknowledge button to someone the
   * API can only 403.
   */
  canAckAlerts: boolean;
}

// ─── User tag index (short-TTL cache) ───────────────────────────────────────
// createTtlCache (2026-08 audit) — the hand-rolled value+timestamp pair it
// replaces had no in-flight coalescing, so a cold cache could stampede one
// findMany per concurrent delivery expansion.
const USER_INDEX_TTL_MS = 30_000;
const _userIndexCache = createTtlCache<IndexedUser[]>({ ttlMs: USER_INDEX_TTL_MS, maxEntries: 1 });

/** Drop the cached user→tags index (call after a user/role/group-mapping write). */
export function bumpRecipientIndex(): void {
  _userIndexCache.invalidate();
}

function normalizeNeedle(tag: string): string {
  return stripRegionPrefix(tag).toLowerCase();
}

function loadUserIndex(): Promise<IndexedUser[]> {
  return _userIndexCache.getOrCompute("", async () => {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      displayName: true,
      regionTags: true,
      otherTags: true,
      ssoGroups: true,
      authProvider: true,
      roleId: true,
      role: { select: { regionTags: true, otherTags: true, permissions: true } },
    },
  });

  const index: IndexedUser[] = [];
  for (const u of users) {
    const scopes = await resolveTagScopesForUser(u);
    const matchSet = new Set<string>();
    const regionSet = new Set<string>();
    for (const t of scopes.regionTags.effective) {
      const n = normalizeNeedle(t);
      matchSet.add(n);
      regionSet.add(n);
    }
    for (const t of scopes.otherTags.effective) matchSet.add(normalizeNeedle(t));
    const perms = (u.role?.permissions ?? {}) as Record<string, AccessLevel | undefined>;
    index.push({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      matchSet,
      regionSet,
      roleId: u.roleId,
      canAckAlerts: rankMeets(permissionOf(perms, "alerts"), "write"),
    });
  }
  return index;
  });
}

/**
 * Which of these user ids may acknowledge an alert right now. Reads the same
 * cached index the recipient resolvers use, so asking costs nothing extra on
 * the fan-out path.
 */
export async function ackCapableUserIds(ids: Iterable<string>): Promise<Set<string>> {
  const want = new Set(ids);
  if (want.size === 0) return new Set();
  const index = await loadUserIndex();
  return new Set(index.filter((u) => want.has(u.id) && u.canAckAlerts).map((u) => u.id));
}

/**
 * Users whose effective tag scope intersects `recipientTags`. Empty
 * recipientTags routes to NO users (an empty target is explicit, not
 * "everyone" — use explicit addresses for broadcast).
 */
export async function resolveRecipientUsers(recipientTags: string[] | undefined): Promise<RecipientUser[]> {
  if (!recipientTags || recipientTags.length === 0) return [];
  const needles = recipientTags.map(normalizeNeedle).filter(Boolean);
  if (needles.length === 0) return [];
  const index = await loadUserIndex();
  return index
    .filter((u) => needles.some((n) => u.matchSet.has(n)))
    .map(({ id, email, displayName }) => ({ id, email, displayName }));
}

/**
 * Users in the NAMED regions — matched against region tags ONLY, unlike
 * resolveRecipientUsers, which searches the flattened region ∪ other set. Once
 * an operator picks a region by name from the map-region catalogue, matching a
 * same-named "other" tag would deliver to the wrong people.
 *
 * Names are compared bare + lower-cased, so a caller may pass either
 * "Atlanta" (how User.regionTags stores it) or "region:Atlanta" (how ASSET tags
 * store it) — normalizeNeedle strips the prefix either way.
 */
export async function resolveUsersByRegions(regions: string[] | undefined): Promise<RecipientUser[]> {
  if (!regions || regions.length === 0) return [];
  const needles = regions.map(normalizeNeedle).filter(Boolean);
  if (needles.length === 0) return [];
  const index = await loadUserIndex();
  return index
    .filter((u) => needles.some((n) => u.regionSet.has(n)))
    .map(({ id, email, displayName }) => ({ id, email, displayName }));
}

/**
 * Every user carrying at least one region tag ("all user regions"). A user with
 * no region at all is deliberately NOT included — they belong to no region, so
 * a region-wide broadcast doesn't cover them; recipientAllUsers is the control
 * for "literally everyone".
 */
export async function resolveUsersInAnyRegion(): Promise<RecipientUser[]> {
  const index = await loadUserIndex();
  return index
    .filter((u) => u.regionSet.size > 0)
    .map(({ id, email, displayName }) => ({ id, email, displayName }));
}

/**
 * Users holding one of the given ROLES. Matched on role ID, not name: a role
 * can be renamed, and User.roleId / ApiToken / GroupMapping already key on the
 * id — so a rename never silently reroutes an automation's recipients.
 *
 * Resolves to users, so this works on email AND web_push alike, unlike
 * recipientAssetContacts (an address with no account behind it).
 */
export async function resolveUsersByRoles(roleIds: string[] | undefined): Promise<RecipientUser[]> {
  if (!roleIds || roleIds.length === 0) return [];
  const want = new Set(roleIds.filter(Boolean));
  if (want.size === 0) return [];
  const index = await loadUserIndex();
  return index
    .filter((u) => want.has(u.roleId))
    .map(({ id, email, displayName }) => ({ id, email, displayName }));
}

/** Every user account — the explicit broadcast opt-in (recipientAllUsers). */
export async function resolveAllUsers(): Promise<RecipientUser[]> {
  const index = await loadUserIndex();
  return index.map(({ id, email, displayName }) => ({ id, email, displayName }));
}

/** Specific users by id (the rule's "individual user accounts" recipients). */
export async function resolveRecipientUsersByIds(ids: string[] | undefined): Promise<RecipientUser[]> {
  if (!ids || ids.length === 0) return [];
  const want = new Set(ids);
  const index = await loadUserIndex();
  return index.filter((u) => want.has(u.id)).map(({ id, email, displayName }) => ({ id, email, displayName }));
}

/** All users for the rule-builder recipient picker (id + name + email). */
export async function listRecipientUsers(): Promise<{ id: string; username: string; displayName: string | null; email: string | null; pushDevices: number }[]> {
  // `pushDevices` lets the automation builder warn that a selected recipient
  // has no push-enabled device. Push is opt-in PER BROWSER, so picking a user
  // is not the same as being able to reach them — without this the operator
  // configures a push action that silently delivers nothing.
  const [users, grouped] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, username: true, displayName: true, email: true },
      orderBy: { username: "asc" },
    }),
    prisma.pushSubscription.groupBy({ by: ["userId"], _count: { _all: true } }),
  ]);
  const counts = new Map(grouped.map((g) => [g.userId, g._count._all]));
  return users.map((u) => ({ ...u, pushDevices: counts.get(u.id) ?? 0 }));
}

/**
 * Resolve an EmailRecipients config (user ids + custom addresses) to a
 * deduped, lower-cased address list. Shared by the rule-level cc/bcc and the
 * escalation sweep's tier recipients.
 */
export async function resolveEmailRecipients(r: EmailRecipients | null | undefined): Promise<string[]> {
  if (!r) return [];
  const out = new Set<string>();
  for (const a of r.addresses ?? []) if (a.trim()) out.add(a.trim().toLowerCase());
  for (const u of await resolveRecipientUsersByIds(r.recipientUserIds)) {
    if (u.email) out.add(u.email.trim().toLowerCase());
  }
  // Roles are resolvable in Cc/Bcc too — the token fields treat a role pill the
  // same wherever it's dropped, so the wire shape has to as well. Region pills
  // are the same story: a region resolves to users, and users have addresses.
  for (const u of await resolveUsersByRoles(r.recipientRoles)) {
    if (u.email) out.add(u.email.trim().toLowerCase());
  }
  if (r.recipientRegions?.length) {
    for (const u of await resolveUsersByRegions(r.recipientRegions)) {
      if (u.email) out.add(u.email.trim().toLowerCase());
    }
  }
  return Array.from(out);
}

/**
 * Drop cross-list duplicates from a composed email's recipient lists:
 * To wins over Cc; Bcc drops anything already visible in To or Cc.
 * Case-insensitive. Pure — exported for unit tests.
 */
export function dedupeEmailRecipients(to: string[], cc: string[], bcc: string[]): { cc: string[]; bcc: string[] } {
  const toSet = new Set(to.map((a) => a.toLowerCase()));
  const ccOut = cc.filter((a) => !toSet.has(a.toLowerCase()));
  const visible = new Set([...toSet, ...ccOut.map((a) => a.toLowerCase())]);
  const bccOut = bcc.filter((a) => !visible.has(a.toLowerCase()));
  return { cc: ccOut, bcc: bccOut };
}

/**
 * Expand a fired notification's rule targets into concrete delivery rows. Each
 * target references a configured NotificationChannel by id; the channel's type
 * decides the transport + how the target fans out:
 *   - email (smtp/oauth_m365), no composedEmail: one row per resolved
 *     recipient address (tag-matched users' emails + explicit addresses).
 *   - email WITH composedEmail: ONE row per target — `target` is the joined To
 *     list, and meta snapshots { composed, to, cc, bcc, subject, text, html? }
 *     for the drain (never channel secrets). Empty To skips the target.
 *   - web_push: one row per recipient user's push subscription (keys snapshotted).
 *   - webhook (slack/teams) / pushbullet: one row; the destination (URL/token)
 *     lives on the channel and is read at send time, NOT duplicated here.
 * Disabled or missing channels are skipped. Best-effort: returns the number of
 * rows created.
 */
/**
 * Merge the three address sources into ONE ordered map of address → the
 * Polaris user who owns it (null for an address nobody signs in with).
 *
 * Ownership decides who gets a one-click acknowledge link: only a configured
 * user can be recorded as the acknowledger, so an address-book contact or a
 * typed address gets the mail without one. A user-sourced entry WINS over a
 * typed/contact entry for the same address — typing your colleague's own
 * address should not strip their link — and two users sharing an address
 * (User.email is nullable and NOT unique) tie-break on the lowest id so the
 * choice is stable across sends.
 *
 * Insertion order reproduces the pre-feature Set: typed addresses, then users,
 * then contacts. Re-setting an existing key keeps its original position, so a
 * composed email's To line reads exactly as it did before.
 */
export function buildAddressOwnerMap(
  users: RecipientUser[],
  typed: string[] | undefined,
  contacts: string[] | undefined,
): Map<string, RecipientUser | null> {
  const norm = (a: string) => a.trim().toLowerCase();
  const out = new Map<string, RecipientUser | null>();
  for (const a of typed ?? []) if (a.trim()) out.set(norm(a), null);
  for (const u of users) {
    if (!u.email) continue;
    const key = norm(u.email);
    const held = out.get(key);
    // Lowest id wins so repeated sends pick the same person.
    if (held && held.id <= u.id) continue;
    out.set(key, u);
  }
  for (const a of contacts ?? []) {
    const key = norm(a);
    if (a.trim() && !out.has(key)) out.set(key, null);
  }
  return out;
}

/**
 * Who — if anyone — may carry the acknowledge link in a COMPOSED email (one
 * message, one shared body, a joined To list).
 *
 * A shared body can only carry a link when exactly one person will read it:
 * the token records who acknowledged, and a cc'd contact clicking a link
 * addressed to someone else would file the acknowledgement under that user's
 * name. Hence: exactly one To address, owned by a user, with no Cc and no Bcc.
 * Anything else gets the message with `{ack}` rendered empty.
 */
export function composedAckRecipient(
  to: string[],
  cc: string[],
  bcc: string[],
  owners: Map<string, RecipientUser | null>,
): RecipientUser | null {
  if (to.length !== 1 || cc.length > 0 || bcc.length > 0) return null;
  return owners.get(to[0]!) ?? null;
}

export interface ExpandDeliveriesOptions {
  /** `region:` tags mined from the RULE's scope (recipientScopeRegion routing). */
  scopeRegionTags?: string[];
  /** The TRIGGERING asset's region tags — stripped snapshot (regionSnapshot /
   *  Notification.regionTags) — for recipientDeviceRegion routing. */
  assetRegionTags?: string[];
  /** Addresses of the address-book contacts RESPONSIBLE for the triggering
   *  asset, for recipientAssetContacts routing. Resolved by the CALLER
   *  (automationActionService → contactService.resolveContactEmailsForAsset)
   *  and passed in, exactly like the region tags above — contactService already
   *  imports this module for listRecipientUsers, so resolving it here would
   *  close an import cycle. */
  assetContactEmails?: string[];
  composedEmail?: ComposedEmail;
  /** Escalation provenance (tier/attempt) — stamped into every row's meta so
   *  the View tab's "Escalated" marker and audits can attribute the send. */
  escalation?: { tier: number; attempt: number };
}

export async function expandDeliveries(
  notificationId: string,
  targets: DeliveryTarget[] | undefined,
  opts: ExpandDeliveriesOptions = {},
): Promise<number> {
  const { scopeRegionTags, assetRegionTags, assetContactEmails, composedEmail, escalation } = opts;
  if (!targets || targets.length === 0) return 0;

  // Resolve the referenced channels once (type + enabled).
  const ids = Array.from(new Set(targets.map((t) => t.channelId).filter(Boolean)));
  if (ids.length === 0) return 0;
  const channels = await prisma.notificationChannel.findMany({
    where: { id: { in: ids } },
    select: { id: true, type: true, enabled: true },
  });
  const byId = new Map(channels.map((c) => [c.id, c]));

  const rows: Prisma.NotificationDeliveryCreateManyInput[] = [];
  const seen = new Set<string>(); // dedupe channelId|transport|target within one notification
  // Parallel to `rows`: which recipient (if any) this row's acknowledge link
  // belongs to. Tokens are minted in ONE batch after the walk, then stamped
  // in — a create per recipient would put dozens of round trips on the
  // alerting fan-out path.
  const rowAck: Array<{ userId: string; channel: AckChannel } | null> = [];

  const add = (
    channelId: string,
    transport: string,
    target: string,
    meta?: Prisma.InputJsonValue,
    ackFor?: { userId: string; channel: AckChannel } | null,
  ) => {
    const key = `${channelId}|${transport}|${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    const withEsc = escalation
      ? ({ ...(meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}), escalation } as Prisma.InputJsonValue)
      : meta;
    rows.push({ notificationId, channelId, transport, target, meta: withEsc ?? undefined });
    rowAck.push(ackFor ?? null);
  };

  // Recipient users for a target = union of: specific user ids + (if opted in)
  // users in the TRIGGERING asset's region(s) + (if opted in) users in the
  // rule's scope region(s) + legacy tag-routing. Deduped by id.
  // Resolved AT MOST ONCE per notification, and only when an action actually
  // asks for level routing — the same posture as assetContactEmails() in
  // automationActionService. A rule with three notify actions shares one
  // lookup; a rule that never opts in pays nothing.
  let _regionLevels: RegionLevelIndex | null = null;
  const regionLevels = async (): Promise<RegionLevelIndex> => {
    if (!_regionLevels) _regionLevels = await regionLevelIndex();
    return _regionLevels;
  };

  const usersForTarget = async (t: DeliveryTarget): Promise<RecipientUser[]> => {
    const map = new Map<string, RecipientUser>();
    const addUsers = (us: RecipientUser[]) => us.forEach((u) => map.set(u.id, u));
    // Broadcast modes first — recipientAllUsers subsumes every other source, so
    // resolving it short-circuits the rest rather than unioning redundantly.
    if (t.recipientAllUsers) return await resolveAllUsers();
    if (t.recipientAllRegions) addUsers(await resolveUsersInAnyRegion());
    if (t.recipientRegions?.length) addUsers(await resolveUsersByRegions(t.recipientRegions));
    if (t.recipientRoles?.length) addUsers(await resolveUsersByRoles(t.recipientRoles));
    if (t.recipientUserIds?.length) addUsers(await resolveRecipientUsersByIds(t.recipientUserIds));
    if (t.recipientDeviceRegion && assetRegionTags?.length) addUsers(await resolveRecipientUsers(assetRegionTags));
    // Asset-RELATIVE level routing: level 1 = the device's own innermost
    // region, 2 = the division containing it, walked outward along the
    // containment edges (regionHierarchyService). Matches `regionSet`
    // (region tags only) via resolveUsersByRegions rather than the flattened
    // `matchSet` recipientDeviceRegion uses, because these names come from the
    // region catalogue by construction — the same reasoning recipientRegions
    // already carries. The asymmetry with recipientDeviceRegion is deliberate
    // and documented in TOUCHES.md; do NOT "unify" them, that changes who
    // existing rules deliver to.
    if (t.recipientDeviceRegionLevels?.length && assetRegionTags?.length) {
      const names = deviceRegionsAtLevels(assetRegionTags, t.recipientDeviceRegionLevels, await regionLevels());
      if (names.length) addUsers(await resolveUsersByRegions(names));
    }
    if (t.recipientScopeRegion && scopeRegionTags?.length) addUsers(await resolveRecipientUsers(scopeRegionTags));
    if (t.recipientTags?.length) addUsers(await resolveRecipientUsers(t.recipientTags)); // legacy
    return Array.from(map.values());
  };

  // Rule-level Cc/Bcc resolve once per notification, then apply per email target.
  const ccResolved = composedEmail ? await resolveEmailRecipients(composedEmail.cc) : [];
  const bccResolved = composedEmail ? await resolveEmailRecipients(composedEmail.bcc) : [];

  for (const t of targets) {
    const channel = byId.get(t.channelId);
    if (!channel || !channel.enabled || !isChannelType(channel.type)) continue;
    const transport = CHANNEL_TRANSPORT[channel.type as ChannelType];

    if (transport === "email") {
      // Address-book contacts owning the triggering asset. Email-only: a
      // contact is an address, not an account, so there's no push endpoint to
      // reach — the web_push branch below deliberately ignores this flag.
      const contactAddrs = t.recipientAssetContacts ? assetContactEmails ?? [] : [];
      const targetUsers = await usersForTarget(t);
      const owners = buildAddressOwnerMap(targetUsers, t.addresses, contactAddrs);
      // An acknowledge link is only useful to someone whose role can actually
      // acknowledge; emailLinksOn is false on installs with no public URL,
      // where an /ack link would be unreachable anyway.
      const ackable = await ackCapableUserIds(
        Array.from(owners.values(), (u) => u?.id).filter((id): id is string => !!id),
      );
      const emailLinksOn = ackUrlForEmail("probe") !== null;
      const ackUserFor = (u: RecipientUser | null | undefined): string | null =>
        emailLinksOn && u && ackable.has(u.id) ? u.id : null;

      if (composedEmail) {
        const to = Array.from(owners.keys());
        if (to.length === 0) continue; // no recipients = no send (Graph rejects empty To)
        const { cc, bcc } = dedupeEmailRecipients(to, ccResolved, bccResolved);
        const soleUserId = ackUserFor(composedAckRecipient(to, cc, bcc, owners));
        add(
          channel.id,
          "email",
          to.join(", "),
          {
            composed: true,
            to,
            cc,
            bcc,
            subject: composedEmail.subject,
            text: composedEmail.text,
            ...(composedEmail.html ? { html: composedEmail.html } : {}),
          },
          soleUserId ? { userId: soleUserId, channel: "email" } : null,
        );
      } else {
        for (const [addr, owner] of owners) {
          const userId = ackUserFor(owner);
          add(channel.id, "email", addr, undefined, userId ? { userId, channel: "email" } : null);
        }
      }
    } else if (transport === "web_push") {
      const users = await usersForTarget(t);
      const subs = users.length
        ? await prisma.pushSubscription.findMany({
            where: { userId: { in: users.map((u) => u.id) } },
            // `surface` rides along so the drain can pick the right deep link
            // (mobile SPA vs desktop Automations page) without a second query.
            // userId comes along for the acknowledge token — a push always
            // belongs to a signed-in account, so every row can carry one.
            select: { endpoint: true, p256dh: true, auth: true, surface: true, userId: true },
          })
        : [];
      const pushAckable = await ackCapableUserIds(subs.map((s) => s.userId));
      for (const s of subs) {
        add(
          channel.id,
          "web_push",
          s.endpoint,
          { p256dh: s.p256dh, auth: s.auth, surface: s.surface },
          pushAckable.has(s.userId) ? { userId: s.userId, channel: "web_push" } : null,
        );
      }
      if (subs.length === 0) {
        // Push is opt-in per browser, so a perfectly valid-looking automation
        // can resolve to zero devices and deliver nothing at all. Say so.
        // logger, not an Event: this runs per notification on the alerting hot
        // path, and a fleet-wide rule would otherwise flood the audit log.
        logger.warn(
          { channelId: channel.id, notificationId, matchedUsers: users.length },
          users.length === 0
            ? "web_push target matched no users — nothing delivered"
            : "web_push target matched users but none have a push-enabled device — nothing delivered",
        );
      }
    } else {
      // webhook (slack/teams) + pushbullet: one row, fixed destination on the channel.
      add(channel.id, transport, "");
    }
  }

  if (rows.length === 0) return 0;
  await stampAckTokens(notificationId, rows, rowAck);
  await prisma.notificationDelivery.createMany({ data: rows });
  return rows.length;
}

/**
 * Mint one acknowledge token per (user, channel) that asked for one and write
 * it into the matching delivery rows' meta — plus, for composed emails,
 * substitute the deferred `{ack}` token inside the already-rendered
 * subject/text/html.
 *
 * One token per (user, channel), not per row: a user with three enrolled
 * devices should be able to acknowledge from whichever one buzzes, and the
 * first click spending the token for the rest is exactly right — the alert is
 * acknowledged. Tokens are NOT reused across notifications or escalation
 * tiers, since only the digest is stored and each send mints fresh.
 */
async function stampAckTokens(
  notificationId: string,
  rows: Prisma.NotificationDeliveryCreateManyInput[],
  rowAck: Array<{ userId: string; channel: AckChannel } | null>,
): Promise<void> {
  const wanted = new Map<string, { userId: string; channel: AckChannel }>();
  for (const a of rowAck) if (a) wanted.set(`${a.userId}|${a.channel}`, a);

  // Deliberately NOT an early return when nothing is minted: an automation
  // whose only recipients are raw addresses or address-book contacts earns no
  // token at all, and returning here would mail them the literal "{ack}". The
  // strip pass below is what has to run in that case.
  const reqs = Array.from(wanted.values()).map((w) => ({ notificationId, ...w }));
  const minted = wanted.size > 0 ? await mintAckTokens(reqs) : [];
  const tokenFor = new Map(minted.map((m) => [`${m.userId}|${m.channel}`, m.raw]));

  applyAckToRows(rows, rowAck, tokenFor);
}

/**
 * Write each row's minted token into its meta and resolve the deferred `{ack}`
 * in composed bodies — filling it for a row that earned a token, blanking it
 * for one that didn't.
 *
 * Pure and exported for the tests because the blank half is the half that
 * breaks quietly: it only runs for recipients who can't acknowledge (raw
 * addresses, address-book contacts), so a mistake there mails a literal
 * "{ack}" to exactly the people least equipped to report it.
 */
export function applyAckToRows(
  rows: Prisma.NotificationDeliveryCreateManyInput[],
  rowAck: Array<{ userId: string; channel: AckChannel } | null>,
  tokenFor: Map<string, string>,
): void {
  rows.forEach((row, i) => {
    const want = rowAck[i];
    const token = want ? tokenFor.get(`${want.userId}|${want.channel}`) ?? null : null;
    const meta = (row.meta && typeof row.meta === "object" ? { ...(row.meta as Record<string, unknown>) } : {}) as Record<string, unknown>;
    if (want && token) meta.ack = { token, userId: want.userId };

    if (meta.composed) {
      // The body was rendered before recipients were known, so {ack} is still
      // sitting in it literally. Resolve it now for this one recipient, then
      // re-prune: filling OR blanking can leave an "Acknowledge:" line (or an
      // href="" button) with nothing behind it.
      const url = token ? ackUrlForEmail(token) : null;
      if (typeof meta.subject === "string") meta.subject = substituteAckToken(meta.subject, url);
      if (typeof meta.text === "string") meta.text = pruneEmptyTextLines(substituteAckToken(meta.text, url));
      if (typeof meta.html === "string") meta.html = pruneDeadLinks(pruneEmptyRows(substituteAckToken(meta.html, url, { html: true })));
    }
    row.meta = meta as Prisma.InputJsonValue;
  });
}

/** Web-push payload URL for a delivery row's acknowledge token, if it has one. */
export function ackUrlFromMeta(meta: unknown): string | null {
  const m = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : null;
  const ack = m?.ack && typeof m.ack === "object" ? (m.ack as Record<string, unknown>) : null;
  return typeof ack?.token === "string" ? ackUrlForPush(ack.token) : null;
}

/** Extract the `region:`-prefixed tags from a rule's scope (for
 *  recipientScopeRegion) — from the flat `tags` dimension AND from positive
 *  tag rules inside a condition tree (field "tag", operator "has"). */
export function scopeRegionTagsOf(
  scope: { tags?: string[]; condition?: { op: string; children: unknown[] } | null } | null | undefined,
): string[] {
  const out = new Set<string>();
  const tags = scope && Array.isArray(scope.tags) ? scope.tags : [];
  for (const t of tags) {
    if (typeof t === "string" && t.toLowerCase().startsWith("region:")) out.add(t);
  }
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const g = node as { op?: string; children?: unknown[]; field?: string; operator?: string; value?: string };
    if (Array.isArray(g.children)) { g.children.forEach(walk); return; }
    if (g.field === "tag" && g.operator === "has" && typeof g.value === "string" && g.value.toLowerCase().startsWith("region:")) {
      out.add(g.value);
    }
  };
  if (scope?.condition) walk(scope.condition);
  return Array.from(out);
}

function isChannelType(t: string): t is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(t);
}
