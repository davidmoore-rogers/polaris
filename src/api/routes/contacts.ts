/**
 * src/api/routes/contacts.ts — address-book CRUD + unified recipient search.
 *
 * Mounted at /api/v1/contacts.
 *   GET    /                contacts:read    (list, paginated + server-side search)
 *   GET    /search          contacts:read    (users ∪ contacts, typeahead-ranked)
 *   POST   /preview         contacts:read    (dry-run a contact's device filter)
 *   GET    /filter-schema   contacts:read    (device-filter builder vocabulary)
 *   GET    /:id             contacts:read    (one row)
 *   POST   /                contacts:write   (create — createdBy stamped to the caller)
 *   PUT    /:id             contacts:write   (edit own; fullwrite edits anyone's)
 *   DELETE /:id             contacts:write   (delete own; fullwrite deletes anyone's)
 *
 * The write verbs use the ownership dimension the `contacts` function key
 * declares — the same mechanism subnets/reservations use. requireOwnership
 * asserts "at least write" and stamps req.permissionLevel; assertOwnership then
 * compares the row's createdBy to the caller unless they hold fullwrite.
 *
 * `/search`, `/preview` and `/filter-schema` are declared BEFORE "/:id" so the
 * literal paths aren't captured as ids (the deliveryChannels `/web-push`
 * precedent).
 */

import { Router } from "express";
import { z } from "zod";
import { assertOwnership, requireOwnership, requirePermission } from "../middleware/permissions.js";
import { requestActor } from "../middleware/auth.js";
import { AppError } from "../../utils/errors.js";
import { contactSearchLimiter } from "../middleware/rateLimits.js";
import { directorySearchAvailable } from "../../services/directorySearchService.js";
import { DEVICE_FILTER_FIELD_OPS, scopeConditionMeta } from "../../services/notificationTypes.js";
import { listScopeOptions } from "../../services/notificationRuleService.js";
import { listAssetTypes } from "../../services/assetTypeService.js";
import { listAssetTags } from "../../services/tagAssignmentService.js";
import {
  CONTACT_PAGE_DEFAULT,
  CONTACT_PAGE_MAX,
  createContact,
  deleteContact,
  getContact,
  listContacts,
  previewContactAssets,
  searchAddressBook,
  updateContact,
} from "../../services/contactService.js";

// The device-ownership half, shared by the write verbs and the preview dry-run.
// Both blob fields stay `unknown` here and are validated in contactService —
// `assetCondition` against the DEVICE_FILTER condition-tree schema,
// `assetCriteria` (legacy, still accepted from API callers) via
// normalizeCriteria — the same split maintenance schedules use.
const filterInputFields = {
  assetCondition: z.unknown().optional(),
  assetCriteria: z.unknown().optional(),
  assetAllDevices: z.boolean().optional(),
  assetIds: z.array(z.string()).max(500).optional(),
};

const contactInputSchema = z.object({
  email: z.string().min(1).max(320),
  name: z.string().max(200).nullish(),
  description: z.string().max(1000).nullish(),
  ...filterInputFields,
});

const previewInputSchema = z.object(filterInputFields);

// z.coerce because these arrive as query strings. The limit is capped here AND
// in the service: a route is not the only caller, and an uncapped page size is
// how a paginated endpoint quietly becomes an unpaginated one again.
const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(CONTACT_PAGE_MAX).optional().default(CONTACT_PAGE_DEFAULT),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const contactsRouter = Router();

/**
 * One page of the address book. `q` filters on email or name SERVER-side.
 *
 * Paginated because this table is no longer necessarily hand-sized: the caller
 * used to receive every row and filter in the browser, which made the cost of
 * opening the page grow with the whole table. `total` is the unpaged count, so
 * the pager can say how many matched without the payload carrying them.
 */
contactsRouter.get("/", requirePermission("contacts", "read"), async (req, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const page = await listContacts(query);
    res.json({ contacts: page.contacts, total: page.total, limit: query.limit, offset: query.offset });
  } catch (err) { next(err); }
});

// `directory=1` additionally queries the opted-in AD / Entra integrations
// (live, nothing persisted). Rate-limited because that path proxies an external
// API from operator keystrokes.
contactsRouter.get("/search", contactSearchLimiter, requirePermission("contacts", "read"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const wantDirectory = req.query.directory === "1" || req.query.directory === "true";
    const entries = await searchAddressBook(q, {
      callerUsername: req.session?.username ?? null,
      includeDirectory: wantDirectory,
    });
    res.json({ entries, directoryAvailable: await directorySearchAvailable() });
  } catch (err) { next(err); }
});

contactsRouter.post("/preview", requirePermission("contacts", "read"), async (req, res, next) => {
  try {
    const input = previewInputSchema.parse(req.body);
    res.json(await previewContactAssets(input));
  } catch (err) { next(err); }
});

/**
 * The device-filter builder's vocabulary + value suggestions, so the address
 * book renders the SAME nested condition tree the automation wizard does.
 *
 * Its own route rather than reusing `/automations/schema` + `/scope-options`:
 * those are gated `automationManagement:read`, and browsing the address book
 * must not require permission to edit automations. The catalog is built from one
 * shared source (scopeConditionMeta), so the two can't drift — this one carries
 * the wider DEVICE_FILTER field set.
 */
contactsRouter.get("/filter-schema", requirePermission("contacts", "read"), async (_req, res, next) => {
  try {
    // assetTypes + tags ride this payload for the same reason regions and roles
    // ride /scope-options: their own endpoints are gated `assets:read`, which a
    // caller managing the address book need not hold, and the value pickers
    // would silently degrade to free text.
    const [options, assetTypes, tags] = await Promise.all([
      listScopeOptions(),
      listAssetTypes(),
      listAssetTags(),
    ]);
    res.json({
      scopeCondition: scopeConditionMeta(DEVICE_FILTER_FIELD_OPS),
      options: {
        ...options,
        assetTypes: assetTypes.map((t) => ({ name: t.name, label: t.label || t.name })),
        tags,
      },
    });
  } catch (err) { next(err); }
});

/**
 * One row by id. Declared after every literal path above so "search",
 * "preview" and "filter-schema" are not captured as ids.
 *
 * Exists because the alternative the address book was using is re-fetching the
 * ENTIRE list to find one row by id -- which was merely wasteful against a
 * curated table and is untenable against a paginated one, where the row being
 * edited may not even be on the page that was loaded.
 */
contactsRouter.get("/:id", requirePermission("contacts", "read"), async (req, res, next) => {
  try {
    const contact = await getContact(req.params.id as string);
    if (!contact) throw new AppError(404, "Contact not found");
    res.json({ contact });
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
