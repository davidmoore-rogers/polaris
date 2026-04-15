/**
 * src/api/routes/utilization.ts
 */

import { Router } from "express";
import * as utilizationService from "../../services/utilizationService.js";

const router = Router();

// GET /utilization — global dashboard summary
router.get("/", async (_req, res, next) => {
  try {
    res.json(await utilizationService.getGlobalUtilization());
  } catch (err) {
    next(err);
  }
});

// GET /utilization/blocks/:id — per-block breakdown
router.get("/blocks/:id", async (req, res, next) => {
  try {
    const data = await utilizationService.getBlockUtilization(req.params.id);
    if (!data) return res.status(404).json({ error: "Block not found" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
