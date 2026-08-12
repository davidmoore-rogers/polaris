/**
 * src/services/notificationAckService.ts — one-click acknowledge links.
 *
 * Owns every read and write of NotificationAckToken. Tokens are minted at
 * delivery fan-out (notificationRecipientService) for recipients who are
 * configured Polaris users, travel inside the alert email / web-push payload,
 * and are redeemed by the public /ack route (api/routes/ack.ts).
 *
 * Two invariants worth stating out loud:
 *
 *  - A token is minted ONLY for a user who holds alerts:write at mint time,
 *    and redemption re-checks it live. Without the second check a role
 *    downgrade would leave working links in old mailboxes; without the first
 *    we would mail an Acknowledge button to someone it can only 403 for.
 *  - Redemption is single-use but IDEMPOTENT-LOOKING: a second click, or a
 *    second recipient's own token, reports who already acknowledged rather
 *    than an error. The alert being acknowledged is the outcome the clicker
 *    wanted; telling them it failed would be a lie.
 */

import { prisma } from "../db.js";
import { logEvent } from "./eventLogService.js";
import { acknowledgeNotifications } from "./notificationService.js";
import { ackTokenExpiry, generateAckToken, hashAckToken, isWellFormedAckToken } from "../utils/ackToken.js";
import { permissionOf, rankMeets, type AccessLevel } from "../api/middleware/permissions.js";

export type AckChannel = "email" | "web_push";

export interface AckMintRequest {
  notificationId: string;
  userId: string;
  channel: AckChannel;
}

export interface MintedAckToken {
  userId: string;
  channel: AckChannel;
  /** The raw token — the only place it ever exists outside the message. */
  raw: string;
}

/** What the /ack page needs to render, or why it can't. */
export type AckOutcomeKind =
  | "valid"
  | "already"
  | "expired"
  | "used"
  | "unknown"
  | "forbidden"
  | "cleared";

export interface AckOutcome {
  kind: AckOutcomeKind;
  /** Present for every kind except "unknown". */
  alert?: {
    id: string;
    message: string;
    severity: string;
    assetHostname: string | null;
    assetId: string | null;
    triggeredAt: Date;
    testRun: boolean;
    acknowledgedBy: string | null;
    acknowledgedAt: Date | null;
  };
  username?: string;
}

/**
 * Batch-mint. One createMany for the whole fan-out — never one create per
 * recipient, because this runs inside the alert's delivery expansion and a
 * fleet-wide rule can address dozens of users at once.
 */
export async function mintAckTokens(reqs: AckMintRequest[]): Promise<MintedAckToken[]> {
  if (reqs.length === 0) return [];
  const now = new Date();
  const expiresAt = ackTokenExpiry(now);
  const minted: MintedAckToken[] = reqs.map((r) => ({
    userId: r.userId,
    channel: r.channel,
    raw: generateAckToken(),
  }));
  await prisma.notificationAckToken.createMany({
    data: minted.map((m, i) => ({
      tokenHash: hashAckToken(m.raw),
      notificationId: reqs[i]!.notificationId,
      userId: m.userId,
      channel: m.channel,
      expiresAt,
    })),
    skipDuplicates: true,
  });
  return minted;
}

/**
 * Can this user acknowledge alerts right now? Reads the role matrix rather
 * than a session, because the clicker has none.
 */
export async function userCanAcknowledge(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: { select: { permissions: true } } },
  });
  const perms = (user?.role?.permissions ?? {}) as Record<string, AccessLevel | undefined>;
  return rankMeets(permissionOf(perms, "alerts"), "write");
}

/**
 * Pure branch logic, extracted so the whole state machine is unit-testable
 * without a database. Order matters: an already-acknowledged alert reports
 * "already" even when the token is spent or the clicker lost permission,
 * because that is the honest answer to "did my click land?".
 */
export function classifyAckToken(
  token: { expiresAt: Date; usedAt: Date | null } | null,
  notif: { acknowledged: boolean; cleared: boolean } | null,
  canAck: boolean,
  now: Date = new Date(),
): AckOutcomeKind {
  if (!token || !notif) return "unknown";
  if (notif.acknowledged) return "already";
  if (token.usedAt) return "used";
  if (token.expiresAt.getTime() <= now.getTime()) return "expired";
  if (notif.cleared) return "cleared";
  if (!canAck) return "forbidden";
  return "valid";
}

interface LoadedToken {
  id: string;
  expiresAt: Date;
  usedAt: Date | null;
  userId: string;
  channel: string;
  username: string;
  notification: {
    id: string;
    message: string;
    severity: string;
    assetHostname: string | null;
    assetId: string | null;
    triggeredAt: Date;
    testRun: boolean;
    acknowledged: boolean;
    acknowledgedBy: string | null;
    acknowledgedAt: Date | null;
    cleared: boolean;
  };
}

async function loadToken(raw: string): Promise<LoadedToken | null> {
  // Shape-check first so a mangled scanner URL never reaches the database.
  if (!isWellFormedAckToken(raw)) return null;
  const row = await prisma.notificationAckToken.findUnique({
    where: { tokenHash: hashAckToken(raw) },
    select: {
      id: true,
      expiresAt: true,
      usedAt: true,
      userId: true,
      channel: true,
      user: { select: { username: true } },
      notification: {
        select: {
          id: true,
          message: true,
          severity: true,
          assetHostname: true,
          assetId: true,
          triggeredAt: true,
          testRun: true,
          acknowledged: true,
          acknowledgedBy: true,
          acknowledgedAt: true,
          cleared: true,
        },
      },
    },
  });
  if (!row) return null;
  return { ...row, username: row.user.username };
}

function outcomeFrom(kind: AckOutcomeKind, row: LoadedToken | null): AckOutcome {
  if (!row) return { kind: "unknown" };
  const n = row.notification;
  return {
    kind,
    username: row.username,
    alert: {
      id: n.id,
      message: n.message,
      severity: n.severity,
      assetHostname: n.assetHostname,
      assetId: n.assetId,
      triggeredAt: n.triggeredAt,
      testRun: n.testRun,
      acknowledgedBy: n.acknowledgedBy,
      acknowledgedAt: n.acknowledgedAt,
    },
  };
}

/**
 * Look up and classify WITHOUT mutating — this backs the GET, which must stay
 * inert because Outlook Safe Links, Proofpoint and every other mail scanner
 * fetches links before a human ever sees them.
 */
export async function inspectAckToken(raw: string): Promise<AckOutcome> {
  const row = await loadToken(raw);
  if (!row) return { kind: "unknown" };
  const canAck = await userCanAcknowledge(row.userId);
  return outcomeFrom(classifyAckToken(row, row.notification, canAck), row);
}

/** Redeem the token: acknowledge the alert as its bound user, then spend it. */
export async function redeemAckToken(raw: string, note?: string): Promise<AckOutcome> {
  const row = await loadToken(raw);
  if (!row) return { kind: "unknown" };
  const canAck = await userCanAcknowledge(row.userId);
  const kind = classifyAckToken(row, row.notification, canAck);
  if (kind !== "valid") {
    // An unknown token is attacker- and scanner-reachable, so it must never
    // write to a 7-day-retention audit log. A token we actually issued that
    // then failed is worth recording — it means a real recipient hit a wall.
    await logEvent({
      action: "notification.ack_link.rejected",
      resourceType: "notification",
      resourceId: row.notification.id,
      actor: `${row.username} (ack link)`,
      level: "warning",
      message: `Acknowledge link rejected (${kind})`,
      details: { reason: kind, channel: row.channel, userId: row.userId },
    });
    return outcomeFrom(kind, row);
  }

  const count = await acknowledgeNotifications([row.notification.id], `${row.username} (ack link)`, note, {
    source: row.channel === "web_push" ? "web_push_action" : "ack_link",
  });
  await prisma.notificationAckToken.update({
    where: { id: row.id },
    data: { usedAt: new Date() },
  });
  // count === 0 means someone else acknowledged between the check and the
  // write; the alert is acknowledged either way, which is what the clicker
  // asked for.
  const fresh = await loadToken(raw);
  return outcomeFrom(count > 0 ? "valid" : "already", fresh ?? row);
}

/**
 * Delete spent and expired tokens. Called on an hourly guard from the
 * deliverNotifications tick (the job that already owns the delivery
 * lifecycle) — one indexed deleteMany, never a scan.
 */
export async function pruneAckTokens(now: Date = new Date()): Promise<number> {
  const usedCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const res = await prisma.notificationAckToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: usedCutoff } }],
    },
  });
  return res.count;
}
