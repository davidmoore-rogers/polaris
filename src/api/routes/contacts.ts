/**
 * src/api/routes/contacts.ts — address-book CRUD + unified recipient search.
 *
 * Mounted at /api/v1/contacts.
 *   GET    /          contacts:read    (list)
 *   GET    /search    contacts:read    (users ∪ contacts, typeahead-ranked)
 *   POST   /preview   contacts:read    (dry-run a contact's device filter)
 *   POST   /          contacts:write   (create — createdBy stamped to the caller)
 *   PUT    /:id       contacts:write   (edit own; fullwrite edits anyone's)
 *   DELETE /:id       contacts:write   (delete own; fullwrite deletes anyone's)
 *
 * The write verbs use the ownership dimension the `contacts` function key
 * declares — the same mechanism subnets/reservations use. requireOwnership
 * asserts "at least write" and stamps req.permissionLevel; assertOwnership then
 * compares the row's createdBy to the caller unless they hold fullwrite.
 *
 * `/search` and `/preview` are declared BEFORE "/:id" so the literal paths
 * aren't captured as ids (the deliveryChannels `/web-push` precedent).
 */

import { Router } from "express";
import { z } from "zod";
import { assertOwnership, requireOwnership, requirePermission } from "../middleware/permissions.js";
import { requestActor } from "../middleware/auth.js";
import { AppError } from "../../utils/errors.js";
import {
  createContact,
  deleteContact,
  getContact,
  listContacts,
  previewContactAssets,
  searchAddressBook,
  updateContact,
} from "../../services/contactService.js";

const contactInputSchema = z.object({
  email: z.string().min(1).max(320),
  name: z.string().max(200).nullish(),
  description: z.string().max(1000).nullish(),
  // Validated in contactService via normalizeCriteria (the shared
  // tagAssignmentService vocabulary), same split as maintenance schedules.
  assetCriteria: z.unknown().optional(),
  assetIds: z.array(z.string()).max(500).optional(),
});

const previewInputSchema = z.object({
  assetCriteria: z.unknown().optional(),
  assetIds: z.array(z.string()).max(500).optional(),
});

export const contactsRouter = Router();

contactsRouter.get("/", requirePermission("contacts", "read"), async (_req, res, next) => {
  try {
    res.json({ contacts: await listContacts() });
  } catch (err) { next(err); }
});

contactsRouter.get("/search", requirePermission("contacts", "read"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const entries = await searchAddressBook(q, { callerUsername: req.session?.username ?? null });
    res.json({ entries });
  } catch (err) { next(err); }
});

contactsRouter.post("/preview", requirePermission("contacts", "read"), async (req, res, next) => {
  try {
    const input = previewInputSchema.parse(req.body);
    res.json(await previewContactAssets(input.assetCriteria ?? null, input.assetIds ?? []));
  } catch (err) { next(err); }
});

contactsRouter.post("/", requireOwnership("contacts"), async (req, res, next) => {
  try {
    const input = contactInputSchema.parse(req.body);
    const contact = await createContact(input, requestActor(req) ?? null);
    res.status(201).json({ contact });
  } catch (err) { next(err); }
});

contactsRouter.put("/:id", requireOwnership("contacts"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await getContact(id);
    if (!existing) throw new AppError(404, "Contact not found");
    assertOwnership(req, existing.createdBy, "edit address-book entries");
    const input = contactInputSchema.parse(req.body);
    const contact = await updateContact(id, input, requestActor(req) ?? undefined);
    res.json({ contact });
  } catch (err) { next(err); }
});

contactsRouter.delete("/:id", requireOwnership("contacts"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await getContact(id);
    if (!existing) throw new AppError(404, "Contact not found");
    assertOwnership(req, existing.createdBy, "delete address-book entries");
    await deleteContact(id, requestActor(req) ?? undefined);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default contactsRouter;
