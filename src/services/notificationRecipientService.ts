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
import { renderNotificationTemplate } from "../utils/notificationTemplate.js";
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
 * context. Unset pieces fall back to the pre-feature defaults (subject
 * `[SEV] asset`, text = message + View link). HTML body only when the
 * operator provided one — interpolated values are HTML-escaped there. cc/bcc
 * pass through unresolved (resolved at expansion time). Lives here (not the
 * engine) so the action-execution layer can compose without a circular
 * import; the engine re-exports it for its historical consumers.
 */
export function buildComposedEmail(comp: EmailComposition, ctx: Record<string, string>): ComposedEmail {
  const link = ctx["link"] || "";
  const subject = comp.subjectTemplate && comp.subjectTemplate.trim()
    ? renderNotificationTemplate(comp.subjectTemplate, ctx)
    : `[${ctx["severity.upper"] || "NOTIFICATION"}] ${ctx["asset"] || "Polaris notification"}`;
  const text = comp.bodyTextTemplate && comp.bodyTextTemplate.trim()
    ? renderNotificationTemplate(comp.bodyTextTemplate, ctx)
    : (ctx["message"] || "") + (link ? `\n\nView: ${link}` : "");
  const html = comp.bodyHtmlTemplate && comp.bodyHtmlTemplate.trim()
    ? renderNotificationTemplate(comp.bodyHtmlTemplate, ctx, { html: true })
    : undefined;
  return { subject, text, html, cc: comp.cc ?? undefined, bcc: comp.bcc ?? undefined };
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
      role: { select: { regionTags: true, otherTags: true } },
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
    index.push({ id: u.id, email: u.email, displayName: u.displayName, matchSet, regionSet });
  }
  return index;
  });
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

  const add = (channelId: string, transport: string, target: string, meta?: Prisma.InputJsonValue) => {
    const key = `${channelId}|${transport}|${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    const withEsc = escalation
      ? ({ ...(meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}), escalation } as Prisma.InputJsonValue)
      : meta;
    rows.push({ notificationId, channelId, transport, target, meta: withEsc ?? undefined });
  };

  // Recipient users for a target = union of: specific user ids + (if opted in)
  // users in the TRIGGERING asset's region(s) + (if opted in) users in the
  // rule's scope region(s) + legacy tag-routing. Deduped by id.
  const usersForTarget = async (t: DeliveryTarget): Promise<RecipientUser[]> => {
    const map = new Map<string, RecipientUser>();
    const addUsers = (us: RecipientUser[]) => us.forEach((u) => map.set(u.id, u));
    // Broadcast modes first — recipientAllUsers subsumes every other source, so
    // resolving it short-circuits the rest rather than unioning redundantly.
    if (t.recipientAllUsers) return await resolveAllUsers();
    if (t.recipientAllRegions) addUsers(await resolveUsersInAnyRegion());
    if (t.recipientRegions?.length) addUsers(await resolveUsersByRegions(t.recipientRegions));
    if (t.recipientUserIds?.length) addUsers(await resolveRecipientUsersByIds(t.recipientUserIds));
    if (t.recipientDeviceRegion && assetRegionTags?.length) addUsers(await resolveRecipientUsers(assetRegionTags));
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
      const addresses = new Set<string>();
      for (const a of t.addresses ?? []) addresses.add(a.trim().toLowerCase()); // custom emails
      for (const u of await usersForTarget(t)) if (u.email) addresses.add(u.email.trim().toLowerCase());
      // Address-book contacts owning the triggering asset. Email-only: a
      // contact is an address, not an account, so there's no push endpoint to
      // reach — the web_push branch below deliberately ignores this flag.
      if (t.recipientAssetContacts) {
        for (const a of assetContactEmails ?? []) addresses.add(a.trim().toLowerCase());
      }
      if (composedEmail) {
        const to = Array.from(addresses);
        if (to.length === 0) continue; // no recipients = no send (Graph rejects empty To)
        const { cc, bcc } = dedupeEmailRecipients(to, ccResolved, bccResolved);
        add(channel.id, "email", to.join(", "), {
          composed: true,
          to,
          cc,
          bcc,
          subject: composedEmail.subject,
          text: composedEmail.text,
          ...(composedEmail.html ? { html: composedEmail.html } : {}),
        });
      } else {
        for (const addr of addresses) add(channel.id, "email", addr);
      }
    } else if (transport === "web_push") {
      const users = await usersForTarget(t);
      const subs = users.length
        ? await prisma.pushSubscription.findMany({
            where: { userId: { in: users.map((u) => u.id) } },
            // `surface` rides along so the drain can pick the right deep link
            // (mobile SPA vs desktop Automations page) without a second query.
            select: { endpoint: true, p256dh: true, auth: true, surface: true },
          })
        : [];
      for (const s of subs) add(channel.id, "web_push", s.endpoint, { p256dh: s.p256dh, auth: s.auth, surface: s.surface });
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
  await prisma.notificationDelivery.createMany({ data: rows });
  return rows.length;
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
