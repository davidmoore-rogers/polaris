/**
 * src/services/subnetService.ts
 */

import { PrismaClient, SubnetStatus } from "@prisma/client";
import { AppError } from "../utils/errors.js";
import {
  normalizeCidr,
  isValidCidr,
  cidrContains,
  cidrOverlaps,
  findNextAvailableSubnet,
  detectIpVersion,
} from "../utils/cidr.js";

const prisma = new PrismaClient();

const tagsToDb = (tags?: string[]): string => (tags ?? []).join(",");
const tagsFromDb = (tags: string): string[] => tags ? tags.split(",").filter(Boolean) : [];

export interface CreateSubnetInput {
  blockId: string;
  cidr: string;
  name: string;
  purpose?: string;
  vlan?: number;
  tags?: string[];
}

export interface UpdateSubnetInput {
  name?: string;
  purpose?: string;
  status?: SubnetStatus;
  vlan?: number;
  tags?: string[];
}

export interface ListSubnetsFilter {
  blockId?: string;
  status?: SubnetStatus;
  tag?: string;
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listSubnets(filter: ListSubnetsFilter = {}) {
  const subnets = await prisma.subnet.findMany({
    where: {
      blockId: filter.blockId,
      status: filter.status,
    },
    include: {
      block: { select: { name: true, cidr: true } },
      _count: { select: { reservations: true } },
    },
    orderBy: { cidr: "asc" },
  });
  const result = subnets.map((s) => ({ ...s, tags: tagsFromDb(s.tags) }));
  return filter.tag ? result.filter((s) => s.tags.includes(filter.tag!)) : result;
}

// ─── Get ──────────────────────────────────────────────────────────────────────

export async function getSubnet(id: string) {
  const subnet = await prisma.subnet.findUnique({
    where: { id },
    include: {
      block: true,
      reservations: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!subnet) throw new AppError(404, `Subnet ${id} not found`);
  return subnet;
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createSubnet(input: CreateSubnetInput) {
  if (!isValidCidr(input.cidr))
    throw new AppError(400, `Invalid CIDR notation: ${input.cidr}`);

  const normalizedCidr = normalizeCidr(input.cidr);

  // Load parent block
  const block = await prisma.ipBlock.findUnique({ where: { id: input.blockId } });
  if (!block) throw new AppError(404, `IP Block ${input.blockId} not found`);

  // Subnet must be within the parent block
  if (!cidrContains(block.cidr, normalizedCidr))
    throw new AppError(
      400,
      `Subnet ${normalizedCidr} is not within block ${block.cidr}`
    );

  // IP version must match the block
  if (detectIpVersion(normalizedCidr) !== block.ipVersion)
    throw new AppError(
      400,
      `Subnet IP version does not match block IP version (${block.ipVersion})`
    );

  // No overlapping sibling subnets
  const siblings = await prisma.subnet.findMany({
    where: { blockId: input.blockId },
    select: { cidr: true },
  });
  const overlap = siblings.find((s) => cidrOverlaps(s.cidr, normalizedCidr));
  if (overlap)
    throw new AppError(
      409,
      `Subnet ${normalizedCidr} overlaps with existing subnet ${overlap.cidr}`
    );

  return prisma.subnet.create({
    data: {
      blockId: input.blockId,
      cidr: normalizedCidr,
      name: input.name,
      purpose: input.purpose,
      vlan: input.vlan,
      tags: tagsToDb(input.tags),
      status: "available",
    },
  });
}

// ─── Auto-allocate next available ────────────────────────────────────────────

export async function allocateNextSubnet(
  blockId: string,
  prefixLength: number,
  metadata: Omit<CreateSubnetInput, "blockId" | "cidr">
) {
  const block = await prisma.ipBlock.findUnique({ where: { id: blockId } });
  if (!block) throw new AppError(404, `IP Block ${blockId} not found`);

  if (block.ipVersion !== "v4")
    throw new AppError(400, "Auto-allocation is currently only supported for IPv4 blocks");

  if (prefixLength < 8 || prefixLength > 32)
    throw new AppError(400, "Prefix length must be between 8 and 32");

  const existing = await prisma.subnet.findMany({
    where: { blockId },
    select: { cidr: true },
  });

  const nextCidr = findNextAvailableSubnet(
    block.cidr,
    existing.map((s) => s.cidr),
    prefixLength
  );

  if (!nextCidr)
    throw new AppError(
      409,
      `No available /${prefixLength} subnet found in block ${block.cidr}`
    );

  return createSubnet({ ...metadata, blockId, cidr: nextCidr });
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateSubnet(id: string, input: UpdateSubnetInput) {
  const subnet = await prisma.subnet.findUnique({ where: { id } });
  if (!subnet) throw new AppError(404, `Subnet ${id} not found`);

  return prisma.subnet.update({
    where: { id },
    data: {
      name: input.name,
      purpose: input.purpose,
      status: input.status,
      vlan: input.vlan,
      tags: input.tags !== undefined ? tagsToDb(input.tags) : undefined,
    },
  });
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteSubnet(id: string) {
  const subnet = await prisma.subnet.findUnique({
    where: { id },
    include: {
      _count: { select: { reservations: true } },
    },
  });

  if (!subnet) throw new AppError(404, `Subnet ${id} not found`);

  const activeCount = await prisma.reservation.count({
    where: { subnetId: id, status: "active" },
  });

  if (activeCount > 0)
    throw new AppError(
      409,
      `Cannot delete subnet ${subnet.cidr} — it has ${activeCount} active reservation(s)`
    );

  return prisma.subnet.delete({ where: { id } });
}
