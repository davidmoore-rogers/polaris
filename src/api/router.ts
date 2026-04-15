/**
 * src/api/router.ts
 */

import { Router } from "express";
import blocksRouter from "./routes/blocks.js";
import subnetsRouter from "./routes/subnets.js";
import reservationsRouter from "./routes/reservations.js";
import utilizationRouter from "./routes/utilization.js";

export const router = Router();

router.use("/blocks", blocksRouter);
router.use("/subnets", subnetsRouter);
router.use("/reservations", reservationsRouter);
router.use("/utilization", utilizationRouter);
