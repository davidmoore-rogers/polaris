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
import type { Prisma } from "../generated/prisma/client.js";
import { resolveTagScopesForUser } from "./regionScopeService.js";
import { stripRegionPrefix } from "./notificationService.js";
import { type DeliveryTarget, type ChannelType, CHANNEL_TYPES, CHANNEL_TRANSPORT } from "./notificationTypes.js";

export interface RecipientUser {
  id: string;
  email: string | null;
  displayName: string | null;
}

interface IndexedUser extends RecipientUser {
  /** Lower-cased, region-prefix-stripped union of effective region+other tags. */
  matchSet: Set<string>;
}

// ─── User tag index (short-TTL cache) ───────────────────────────────────────
let _userIndex: IndexedUser[] | null = null;
let _userIndexAt = 0;
const USER_INDEX_TTL_MS = 30_000;

/** Drop the cached user→tags index (call after a user/role/group-mapping write). */
export function bumpRecipientIndex(): void {
  _userIndex = null;
}

function normalizeNeedle(tag: string): string {
  return stripRegionPrefix(tag).toLowerCase();
}

async function loadUserIndex(): Promise<IndexedUser[]> {
  const now = Date.now();
  if (_userIndex && now - _userIndexAt < USER_INDEX_TTL_MS) return _userIndex;

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
    for (const t of [...scopes.regionTags.effective, ...scopes.otherTags.effective]) {
      matchSet.add(normalizeNeedle(t));
    }
    index.push({ id: u.id, email: u.email, displayName: u.displayName, matchSet });
  }
  _userIndex = index;
  _userIndexAt = now;
  return index;
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

/** Specific users by id (the rule's "individual user accounts" recipients). */
export async function resolveRecipientUsersByIds(ids: string[] | undefined): Promise<RecipientUser[]> {
  if (!ids || ids.length === 0) return [];
  const want = new Set(ids);
  const index = await loadUserIndex();
  return index.filter((u) => want.has(u.id)).map(({ id, email, displayName }) => ({ id, email, displayName }));
}

/** All users for the rule-builder recipient picker (id + name + email). */
export async function listRecipientUsers(): Promise<{ id: string; username: string; displayName: string | null; email: string | null }[]> {
  return prisma.user.findMany({
    select: { id: true, username: true, displayName: true, email: true },
    orderBy: { username: "asc" },
  });
}

/**
 * Expand a fired notification's rule targets into concrete delivery rows. Each
 * target references a configured NotificationChannel by id; the channel's type
 * decides the transport + how the target fans out:
 *   - email (smtp/oauth_m365): one row per resolved recipient address
 *     (tag-matched users' emails + explicit addresses).
 *   - web_push: one row per recipient user's push subscription (keys snapshotted).
 *   - webhook (slack/teams) / pushbullet: one row; the destination (URL/token)
 *     lives on the channel and is read at send time, NOT duplicated here.
 * Disabled or missing channels are skipped. Best-effort: returns the number of
 * rows created.
 */
export async function expandDeliveries(notificationId: string, targets: DeliveryTarget[] | undefined, scopeRegionTags?: string[]): Promise<number> {
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
    rows.push({ notificationId, channelId, transport, target, meta: meta ?? undefined });
  };

  // Recipient users for a target = union of: specific user ids + (if opted in)
  // users in the rule's scope region(s) + legacy tag-routing. Deduped by id.
  const usersForTarget = async (t: DeliveryTarget): Promise<RecipientUser[]> => {
    const map = new Map<string, RecipientUser>();
    const addUsers = (us: RecipientUser[]) => us.forEach((u) => map.set(u.id, u));
    if (t.recipientUserIds?.length) addUsers(await resolveRecipientUsersByIds(t.recipientUserIds));
    if (t.recipientScopeRegion && scopeRegionTags?.length) addUsers(await resolveRecipientUsers(scopeRegionTags));
    if (t.recipientTags?.length) addUsers(await resolveRecipientUsers(t.recipientTags)); // legacy
    return Array.from(map.values());
  };

  for (const t of targets) {
    const channel = byId.get(t.channelId);
    if (!channel || !channel.enabled || !isChannelType(channel.type)) continue;
    const transport = CHANNEL_TRANSPORT[channel.type as ChannelType];

    if (transport === "email") {
      const addresses = new Set<string>();
      for (const a of t.addresses ?? []) addresses.add(a.trim().toLowerCase()); // custom emails
      for (const u of await usersForTarget(t)) if (u.email) addresses.add(u.email.trim().toLowerCase());
      for (const addr of addresses) add(channel.id, "email", addr);
    } else if (transport === "web_push") {
      const users = await usersForTarget(t);
      if (users.length > 0) {
        const subs = await prisma.pushSubscription.findMany({
          where: { userId: { in: users.map((u) => u.id) } },
          select: { endpoint: true, p256dh: true, auth: true },
        });
        for (const s of subs) add(channel.id, "web_push", s.endpoint, { p256dh: s.p256dh, auth: s.auth });
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

/** Extract the `region:`-prefixed tags from a rule's scope (for recipientScopeRegion). */
export function scopeRegionTagsOf(scope: { tags?: string[] } | null | undefined): string[] {
  const tags = scope && Array.isArray(scope.tags) ? scope.tags : [];
  return tags.filter((t) => typeof t === "string" && t.toLowerCase().startsWith("region:"));
}

function isChannelType(t: string): t is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(t);
}
