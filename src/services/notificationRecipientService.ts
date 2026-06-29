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
import type { DeliveryTarget } from "./notificationTypes.js";

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

/**
 * Expand a fired notification's rule targets into concrete delivery rows.
 * Best-effort: returns the number of rows created. Never throws past a logged
 * failure (the caller wraps it, but we guard the DB write too).
 */
export async function expandDeliveries(notificationId: string, targets: DeliveryTarget[] | undefined): Promise<number> {
  if (!targets || targets.length === 0) return 0;

  const rows: Prisma.NotificationDeliveryCreateManyInput[] = [];
  const seen = new Set<string>(); // dedupe channel|target within one notification

  const add = (channel: string, target: string, meta?: Prisma.InputJsonValue) => {
    const key = `${channel}|${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ notificationId, channel, target, meta: meta ?? undefined });
  };

  for (const t of targets) {
    if (t.channel === "email") {
      const addresses = new Set<string>();
      for (const a of t.addresses ?? []) addresses.add(a.trim().toLowerCase());
      if (t.recipientTags?.length) {
        const users = await resolveRecipientUsers(t.recipientTags);
        for (const u of users) if (u.email) addresses.add(u.email.trim().toLowerCase());
      }
      for (const addr of addresses) add("email", addr);
    } else if (t.channel === "webhook") {
      if (t.webhookUrl) add("webhook", t.webhookUrl, { kind: t.webhookKind ?? "generic" });
    } else if (t.channel === "web_push") {
      const users = await resolveRecipientUsers(t.recipientTags);
      if (users.length > 0) {
        const subs = await prisma.pushSubscription.findMany({
          where: { userId: { in: users.map((u) => u.id) } },
          select: { endpoint: true, p256dh: true, auth: true },
        });
        for (const s of subs) add("web_push", s.endpoint, { p256dh: s.p256dh, auth: s.auth });
      }
    }
  }

  if (rows.length === 0) return 0;
  await prisma.notificationDelivery.createMany({ data: rows });
  return rows.length;
}
