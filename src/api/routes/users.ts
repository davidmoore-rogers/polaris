/**
 * src/api/routes/users.ts — User management (list, create, reset password, delete)
 */

import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";

const router = Router();

const CreateUserSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(4),
});

const ResetPasswordSchema = z.object({
  password: z.string().min(4),
});

// GET /api/v1/users
router.get("/", async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, username: true, createdAt: true, updatedAt: true },
      orderBy: { username: "asc" },
    });
    res.json(users);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/users
router.post("/", async (req, res, next) => {
  try {
    const { username, password } = CreateUserSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) throw new AppError(409, `User "${username}" already exists`);

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, passwordHash },
      select: { id: true, username: true, createdAt: true },
    });
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/users/:id/password
router.put("/:id/password", async (req, res, next) => {
  try {
    const { password } = ResetPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw new AppError(404, "User not found");

    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.update({
      where: { id: req.params.id },
      data: { passwordHash },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/users/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw new AppError(404, "User not found");

    // Prevent deleting yourself
    if (req.session?.userId === user.id) {
      throw new AppError(400, "You cannot delete your own account");
    }

    await prisma.user.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
