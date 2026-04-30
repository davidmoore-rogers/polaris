/**
 * src/api/routes/reservations.ts
 *
 * Authorization:
 *   - admin / networkadmin: full CRUD on all reservations
 *   - user / assetsadmin: can create reservations and edit/delete only their own (createdBy match)
 *   - readonly: read-only
 */

import { Router } from "express";
import { z } from "zod";
import * as reservationService from "../../services/reservationService.js";
import * as staleService from "../../services/reservationStaleService.js";
import { AppError } from "../../utils/errors.js";
import { requireAdmin, requireNetworkAdmin, requireUserOrAbove, isNetworkAdminOrAbove } from "../middleware/auth.js";
import { logEvent, buildChanges } from "./events.js";

const router = Router();

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const MacAddressSchema = z
  .string()
  .min(1)
  .refine(
    (s) => /^[0-9a-f]{12}$|^([0-9a-f]{2}[:\-]){5}[0-9a-f]{2}$|^([0-9a-f]{4}\.){2}[0-9a-f]{4}$/i.test(s),
    "MAC address must be 12 hex chars (with optional :, -, or . separators)",
  )
  .optional();

const CreateReservationSchema = z.object({
  subnetId: z.string().uuid(),
  ipAddress: z.string().optional(),
  hostname: z.string().min(1, "Hostname is required"),
  owner: z.string().optional(),
  projectRef: z.string().optional(),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().optional(),
  macAddress: MacAddressSchema,
});

const NextAvailableSchema = z.object({
  subnetId: z.string().uuid(),
  hostname: z.string().min(1, "Hostname is required"),
  owner: z.string().optional(),
  projectRef: z.string().optional(),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().optional(),
  macAddress: MacAddressSchema,
});

const UpdateReservationSchema = z.object({
  hostname: z.string().optional(),
  owner: z.string().min(1, "Owner is required").optional(),
  projectRef: z.string().min(1, "Project reference is required").optional(),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// ─── Stale-reservation alerts (must come before /:id) ──────────────────────
//
// Settings are admin-only writes; reads are open to any authenticated user
// so the Events page can render the badge count for everyone.

const StaleSettingsSchema = z.object({
  staleAfterDays: z.number().int().min(0).max(3650),
});

router.get("/stale-settings", async (_req, res, next) => {
  try {
    res.json(await staleService.getStaleSettings());
  } catch (err) { next(err); }
});

router.put("/stale-settings", requireAdmin, async (req, res, next) => {
  try {
    const input = StaleSettingsSchema.parse(req.body);
    const updated = await staleService.updateStaleSettings(input);
    logEvent({
      action: "reservation.stale-settings.updated",
      resourceType: "setting",
      actor: req.session?.username,
      message: `Reservation stale-detection threshold set to ${updated.staleAfterDays} day(s)${updated.staleAfterDays === 0 ? " — alerts disabled" : ""}`,
      details: { staleAfterDays: updated.staleAfterDays },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

router.get("/alerts", async (req, res, next) => {
  try {
    const show = req.query.show === "ignored" ? "ignored" : "active";
    const alerts = await staleService.listStaleReservations(show);
    res.json({ alerts, total: alerts.length, show });
  } catch (err) { next(err); }
});

// Badge count is always the active list — ignored rows are silenced by the
// operator and shouldn't drive a sidebar badge.
router.get("/alerts/count", async (_req, res, next) => {
  try {
    const alerts = await staleService.listStaleReservations("active");
    res.json({ count: alerts.length });
  } catch (err) { next(err); }
});

// Snooze a stale-reservation alert by `staleAfterDays` more days. Sets
// staleSnoozedUntil = now + staleAfterDays so the row is suppressed from the
// alert list and the job won't re-fire until the snooze expires (or until
// discovery sees the IP active again, which clears the snooze automatically).
// Open to any user-or-above so operators can quiet noise without admin escalation.
router.post("/:id/snooze", requireUserOrAbove, async (req, res, next) => {
  try {
    const result = await staleService.snoozeReservation(req.params.id as string);
    logEvent({
      action: "reservation.stale.snoozed",
      resourceType: "reservation",
      resourceId: result.reservationId,
      actor: req.session?.username,
      message: `Stale-reservation alert snoozed for ${result.daysAdded} day(s); next alert eligibility ${result.snoozedUntil.toISOString()}`,
      details: { snoozedUntil: result.snoozedUntil.toISOString(), daysAdded: result.daysAdded },
    });
    res.json(result);
  } catch (err) { next(err); }
});

// Permanently ignore a stale-reservation alert (admin / network-admin). The
// row is suppressed from the active alert list and the job won't ever
// re-fire on it, even if it later goes online and offline again — operator's
// intent is durable. Reachable via the admin filter view in the Alerts panel.
router.post("/:id/stale-ignore", requireNetworkAdmin, async (req, res, next) => {
  try {
    const result = await staleService.setStaleIgnored(req.params.id as string, true);
    logEvent({
      action: "reservation.stale.ignored",
      resourceType: "reservation",
      resourceId: result.reservationId,
      actor: req.session?.username,
      message: `Stale-reservation alert permanently ignored — operator opted out of future notifications for this row`,
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.delete("/:id/stale-ignore", requireNetworkAdmin, async (req, res, next) => {
  try {
    const result = await staleService.setStaleIgnored(req.params.id as string, false);
    logEvent({
      action: "reservation.stale.unignored",
      resourceType: "reservation",
      resourceId: result.reservationId,
      actor: req.session?.username,
      message: `Stale-reservation alert un-ignored — row will alert again on the next stale crossing`,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /reservations/next-available  (must come before /:id)
router.post("/next-available", requireUserOrAbove, async (req, res, next) => {
  try {
    const input = NextAvailableSchema.parse(req.body);
    const reservation = await reservationService.nextAvailableReservation({
      ...input,
      createdBy: req.session?.username,
    });
    const pushedSuffix = reservation.pushStatus === "synced"
      ? ` and pushed to FortiGate`
      : "";
    logEvent({ action: "reservation.created", resourceType: "reservation", resourceId: reservation.id, resourceName: reservation.hostname || reservation.ipAddress || undefined, actor: req.session?.username, message: `Reservation auto-allocated for ${reservation.ipAddress} (${input.owner || "no owner"})${pushedSuffix}` });
    res.status(201).json(reservation);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const { subnetId, owner, projectRef, status } = req.query as Record<string, string>;
    const limit = parseInt(req.query.limit as string, 10) || undefined;
    const offset = parseInt(req.query.offset as string, 10) || undefined;
    res.json(await reservationService.listReservations({
      subnetId,
      owner,
      projectRef,
      status: status as any,
      limit,
      offset,
    }));
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    res.json(await reservationService.getReservation(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post("/", requireUserOrAbove, async (req, res, next) => {
  try {
    const input = CreateReservationSchema.parse(req.body);
    const reservation = await reservationService.createReservation({
      ...input,
      createdBy: req.session?.username,
    });
    const pushedSuffix = reservation.pushStatus === "synced"
      ? ` and pushed to FortiGate`
      : "";
    logEvent({ action: "reservation.created", resourceType: "reservation", resourceId: reservation.id, resourceName: input.hostname || input.ipAddress, actor: req.session?.username, message: `Reservation created for ${input.ipAddress || "subnet"} (${input.owner})${pushedSuffix}` });
    res.status(201).json(reservation);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requireUserOrAbove, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const before = await reservationService.getReservation(id);
    if (!isNetworkAdminOrAbove(req) && before.createdBy !== req.session?.username) {
      throw new AppError(403, "Forbidden — you can only edit reservations you created");
    }
    const input = UpdateReservationSchema.parse(req.body);
    const reservation = await reservationService.updateReservation(id, input);
    const changes = buildChanges(
      { hostname: before.hostname, owner: before.owner, projectRef: before.projectRef, expiresAt: before.expiresAt, notes: before.notes },
      { hostname: reservation.hostname, owner: reservation.owner, projectRef: reservation.projectRef, expiresAt: reservation.expiresAt, notes: reservation.notes },
    );
    logEvent({ action: "reservation.updated", resourceType: "reservation", resourceId: id, resourceName: input.hostname, actor: req.session?.username, message: `Reservation updated`, details: changes ? { changes } : undefined });
    res.json(reservation);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireUserOrAbove, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    if (!isNetworkAdminOrAbove(req)) {
      const existing = await reservationService.getReservation(id);
      if (existing.createdBy !== req.session?.username) {
        throw new AppError(403, "Forbidden — you can only release reservations you created");
      }
    }
    await reservationService.releaseReservation(id);
    logEvent({ action: "reservation.released", resourceType: "reservation", resourceId: id, actor: req.session?.username, message: `Reservation released` });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
