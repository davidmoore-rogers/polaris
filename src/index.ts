/**
 * src/index.ts — Application entry point
 */

import express from "express";
import { router } from "./api/router.js";
import { errorHandler } from "./api/middleware/errorHandler.js";
import { logger } from "./utils/logger.js";

const PORT = process.env.PORT ?? 3000;

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api/v1", router);
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info({ port: PORT }, "IPAM server listening");
});

export { app };
