/**
 * src/api/routes/deviceIcons.ts — operator-uploaded device icons
 *
 * Admin CRUD for the icons used by the Device Map's topology graph.
 * Image-serve endpoint is auth-only (any logged-in user) so the topology
 * modal can render them without a secondary auth dance.
 */

import { Router } from "express";
import multer from "multer";
import {
  uploadIcon,
  listIcons,
  getIconImage,
  deleteIcon,
} from "../../services/deviceIconService.js";
import { logEvent } from "./events.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { AppError } from "../../utils/errors.js";

const router = Router();

// Hard cap matches deviceIconService's MAX_ICON_BYTES so multer's
// per-request limit and the service-level validation agree on the
// rejection point.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1024 } });

// GET /device-icons — list. Hashes are not returned (they don't exist),
// just the metadata + a thumbnail URL the UI uses for previews.
router.get("/", requireAdmin, async (_req, res, next) => {
  try {
    const icons = await listIcons();
    res.json(
      icons.map((i) => ({
        ...i,
        // Convenience URL for the UI thumbnail and the topology renderer.
        // Same path the topology endpoint embeds in node payloads.
        url: `/api/v1/device-icons/${i.id}/image`,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// POST /device-icons — multipart upload.
//   field name: file (required)
//   form fields: scope ("type" | "model"), key (string)
// Re-uploading the same (scope, key) replaces the existing image.
router.post("/", requireAdmin, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, "Missing 'file' upload");
    const scope = String(req.body?.scope || "");
    const key = String(req.body?.key || "");
    if (!scope || !key) throw new AppError(400, "scope and key are required");
    const summary = await uploadIcon({
      scope: scope as "type" | "model",
      key,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      data: req.file.buffer,
      uploadedBy: (req as any).session?.username,
    });
    logEvent({
      action: "device_icon.uploaded",
      resourceType: "device_icon",
      resourceId: summary.id,
      resourceName: `${summary.scope}:${summary.key}`,
      actor: (req as any).session?.username,
      level: "info",
      message: `Uploaded device icon for ${summary.scope}:${summary.key} (${summary.size} bytes, ${summary.mimeType})`,
    });
    res.json({ ...summary, url: `/api/v1/device-icons/${summary.id}/image` });
  } catch (err) {
    next(err);
  }
});

// DELETE /device-icons/:id
router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const ok = await deleteIcon(id);
    if (!ok) throw new AppError(404, "Icon not found");
    logEvent({
      action: "device_icon.deleted",
      resourceType: "device_icon",
      resourceId: id,
      actor: (req as any).session?.username,
      level: "info",
      message: `Deleted device icon ${id}`,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /device-icons/:id/image — serve raw bytes. Auth-only (session
// cookie); cacheable for 1 hour. Topology modal references this URL on
// each Cytoscape node's `background-image`. Browser cache deduplicates
// fetches across re-renders.
router.get("/:id/image", requireAuth, async (req, res, next) => {
  try {
    const img = await getIconImage(String(req.params.id));
    if (!img) throw new AppError(404, "Icon not found");
    res.setHeader("Content-Type", img.mimeType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(img.data.length));
    res.send(img.data);
  } catch (err) {
    next(err);
  }
});

export default router;
