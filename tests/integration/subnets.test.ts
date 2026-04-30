/**
 * tests/integration/subnets.test.ts
 *
 * Integration tests for /api/v1/subnets.
 * Requires a running PostgreSQL database pointed to by DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/index.js";
import { prisma } from "../../src/db.js";

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.reservation.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();
});

// ─── POST /api/v1/subnets ─────────────────────────────────────────────────────

describe("POST /api/v1/subnets", () => {
  it.todo("carves a subnet from a valid block and returns 201");
  it.todo("returns 400 for an invalid CIDR");
  it.todo("returns 400 when subnet is not within its parent block");
  it.todo("returns 409 when subnet overlaps with a sibling");
});

// ─── POST /api/v1/subnets/next-available ──────────────────────────────────────

describe("POST /api/v1/subnets/next-available", () => {
  it.todo("auto-allocates the next available subnet of the requested prefix length");
  it.todo("returns 409 when no space remains in the block");
});

// ─── GET /api/v1/subnets ──────────────────────────────────────────────────────

describe("GET /api/v1/subnets", () => {
  it.todo("lists all subnets");
  it.todo("filters by blockId");
  it.todo("filters by status");
});

// ─── GET /api/v1/subnets/:id ──────────────────────────────────────────────────

describe("GET /api/v1/subnets/:id", () => {
  it.todo("returns the subnet with its reservations");
  it.todo("returns 404 for an unknown id");
});

// ─── PUT /api/v1/subnets/:id ──────────────────────────────────────────────────

describe("PUT /api/v1/subnets/:id", () => {
  it.todo("updates subnet metadata");
  it.todo("updates subnet status");
});

// ─── DELETE /api/v1/subnets/:id ───────────────────────────────────────────────

describe("DELETE /api/v1/subnets/:id", () => {
  it.todo("deletes a subnet with no active reservations");
  it.todo("returns 409 when active reservations exist");
});
