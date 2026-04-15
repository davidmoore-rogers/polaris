/**
 * src/services/blockService.ts
 */

import { PrismaClient } from "@prisma/client";
import { AppError } from "../utils/errors.js";
import {
  normalizeCidr,
  isValidCidr,
  detectIpVersion,
} from "../utils/cidr.js";

const prisma = new PrismaClient();

const tagsToDb = (tags?: string[]): string => (tags ?? []).join(",");
const tagsFromDb = (tags: string): string[] => tags ? tags.split(",").filter(Boolean) : [];

export interface CreateBlockInput {
  name: string;
  cidr: string;
  description?: string;
  tags?: string[];
}

export interface UpdateBlockInput {
  name?: string;
  description?: string;
  tags?: string[];
}

export interface ListBlocksFilter {
  ipVersion?: "v4" | "v6";
  tag?: string;
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listBlocks(filter: ListBlocksFilter = {}) {
  const blocks = await prisma.ipBlock.findMany({
    where: { ipVersion: filter.ipVersion },
    include: { _count: { select: { subnets: true } } },
    orderBy: { cidr: "asc" },
  });
  const result = blocks.map((b) => ({ ...b, tags: tagsFromDb(b.tags) }));
  return filter.tag ? result.filter((b) => b.tags.includes(filter.tag!)) : result;
}

// ─── Get ──────────────────────────────────────────────────────────────────────

export async function getBlock(id: string) {
  const block = await prisma.ipBlock.findUnique({
    where: { id },
    include: {
      subnets: {
        include: { _count: { select: { reservations: true } } },
        orderBy: { cidr: "asc" },
      },
    },
  });
  if (!block) throw new AppError(404, `IP Block ${id} not found`);
  return {
    ...block,
    tags: tagsFromDb(block.tags),
    subnets: block.subnets.map((s) => ({ ...s, tags: tagsFromDb(s.tags) })),
  };
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createBlock(input: CreateBlockInput) {
  if (!isValidCidr(input.cidr))
    throw new AppError(400, `Invalid CIDR notation: ${input.cidr}`);

  const normalizedCidr = normalizeCidr(input.cidr);
  const ipVersion = detectIpVersion(normalizedCidr);

  const existing = await prisma.ipBlock.findUnique({
    where: { cidr: normalizedCidr },
  });
  if (existing)
    throw new AppError(409, `IP Block with CIDR ${normalizedCidr} already exists`);

  return prisma.ipBlock.create({
    data: {
      name: input.name,
      cidr: normalizedCidr,
      ipVersion,
      description: input.description,
      tags: tagsToDb(input.tags),
    },
  });
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateBlock(id: string, input: UpdateBlockInput) {
  const block = await prisma.ipBlock.findUnique({ where: { id } });
  if (!block) throw new AppError(404, `IP Block ${id} not found`);

  return prisma.ipBlock.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description,
      tags: input.tags !== undefined ? tagsToDb(input.tags) : undefined,
    },
  });
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteBlock(id: string) {
  const block = await prisma.ipBlock.findUnique({
    where: { id },
    include: { subnets: { select: { id: true } } },
  });

  if (!block) throw new AppError(404, `IP Block ${id} not found`);

  const activeReservations = await prisma.reservation.count({
    where: {
      subnetId: { in: block.subnets.map((s) => s.id) },
      status: "active",
    },
  });

  if (activeReservations > 0)
    throw new AppError(
      409,
      `Cannot delete block ${block.cidr} — it has ${activeReservations} active reservation(s) across its subnets`
    );

  return prisma.ipBlock.delete({ where: { id } });
}
