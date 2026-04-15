/**
 * src/index.ts — Application entry point
 */

import path from "node:path";
import express from "express";
import session from "express-session";
import { router } from "./api/router.js";
import { errorHandler } from "./api/middleware/errorHandler.js";
import { logger } from "./utils/logger.js";

const PORT = process.env.PORT ?? 3000;

const app = express();
app.use(express.json());

// Session middleware (MemoryStore is fine for single-process / internal use)
app.use(
  session({
    secret: process.env.SESSION_SECRET || "ipam-dev-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

// Protect dashboard pages — redirect unauthenticated users to login
const protectedPages = ["/", "/index.html", "/blocks.html", "/subnets.html", "/reservations.html", "/users.html"];
app.use((req, res, next) => {
  if (!protectedPages.includes(req.path)) return next();
  if (req.session?.userId) return next();
  return res.redirect("/login.html");
});

app.use(express.static(path.resolve(import.meta.dirname, "..", "public")));

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api/v1", router);
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info({ port: PORT }, "IPAM server listening");
});

export { app };
