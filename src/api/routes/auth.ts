/**
 * src/api/routes/auth.ts — Login / Logout / Session check
 */

import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";

const router = Router();

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// POST /api/v1/auth/login
router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = LoginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { username } });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new AppError(401, "Invalid username or password");
    }

    req.session.userId = user.id;
    req.session.username = user.username;

    res.json({ ok: true, username: user.username });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/logout
router.post("/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

// GET /api/v1/auth/me
router.get("/me", (req, res) => {
  if (req.session?.userId) {
    res.json({ authenticated: true, username: req.session.username });
  } else {
    res.json({ authenticated: false });
  }
});

export default router;
