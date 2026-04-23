/**
 * src/api/routes/search.ts — Global search endpoint
 */

import { Router } from "express";
import { searchAll } from "../../services/searchService.js";

const router = Router();

// GET /api/v1/search?q=<query>
router.get("/", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const results = await searchAll(q);
    res.json(results);
  } catch (err) {
    next(err);
  }
});

export default router;
