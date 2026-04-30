/**
 * tests/unit/subnetService.test.ts
 *
 * Unit tests for subnetService — Prisma is mocked so no database is needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppError } from "../../src/utils/errors.js";

// Mock the prisma singleton before importing the service
const prisma = {
  ipBlock:     { findUnique: vi.fn(), findMany: vi.fn() },
  subnet:      { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
  reservation: { count: vi.fn() },
};
vi.mock("../../src/db.js", () => ({ prisma }));

const { createSubnet, deleteSubnet } = await import("../../src/services/subnetService.js");

beforeEach(() => vi.clearAllMocks());

// ─── createSubnet ─────────────────────────────────────────────────────────────

describe("createSubnet", () => {
  it("throws 400 for an invalid CIDR", async () => {
    await expect(
      createSubnet({ blockId: "b1", cidr: "bad", name: "test" })
    ).rejects.toThrow(AppError);
  });

  it("throws 404 when the parent block does not exist", async () => {
    prisma.ipBlock.findUnique.mockResolvedValue(null);
    await expect(
      createSubnet({ blockId: "b1", cidr: "10.0.1.0/24", name: "test" })
    ).rejects.toThrow(AppError);
  });

  it("throws 400 when subnet CIDR is not within the parent block", async () => {
    prisma.ipBlock.findUnique.mockResolvedValue({ id: "b1", cidr: "192.168.0.0/24", ipVersion: "v4" });
    await expect(
      createSubnet({ blockId: "b1", cidr: "10.0.1.0/24", name: "test" })
    ).rejects.toThrow(AppError);
  });

  it("throws 409 when the subnet overlaps with a sibling", async () => {
    prisma.ipBlock.findUnique.mockResolvedValue({ id: "b1", cidr: "10.0.0.0/8", ipVersion: "v4" });
    prisma.subnet.findMany.mockResolvedValue([{ cidr: "10.0.1.0/24" }]);
    await expect(
      createSubnet({ blockId: "b1", cidr: "10.0.1.0/24", name: "test" })
    ).rejects.toThrow(AppError);
  });

  it("creates the subnet when all checks pass", async () => {
    const fakeSubnet = { id: "s1", cidr: "10.0.1.0/24", blockId: "b1", name: "test" };
    prisma.ipBlock.findUnique.mockResolvedValue({ id: "b1", cidr: "10.0.0.0/8", ipVersion: "v4" });
    prisma.subnet.findMany.mockResolvedValue([]);
    prisma.subnet.create.mockResolvedValue(fakeSubnet);

    const result = await createSubnet({ blockId: "b1", cidr: "10.0.1.0/24", name: "test" });
    expect(result).toEqual(fakeSubnet);
    expect(prisma.subnet.create).toHaveBeenCalledOnce();
  });
});

// ─── deleteSubnet ─────────────────────────────────────────────────────────────

describe("deleteSubnet", () => {
  it("throws 404 when subnet does not exist", async () => {
    prisma.subnet.findUnique.mockResolvedValue(null);
    await expect(deleteSubnet("s1")).rejects.toThrow(AppError);
  });

  it("throws 409 when subnet has active reservations", async () => {
    prisma.subnet.findUnique.mockResolvedValue({ id: "s1", cidr: "10.0.1.0/24", _count: { reservations: 2 } });
    prisma.reservation.count.mockResolvedValue(2);
    await expect(deleteSubnet("s1")).rejects.toThrow(AppError);
  });
});
