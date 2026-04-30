/**
 * tests/integration/blocks.test.ts
 *
 * Integration tests for POST|GET|PUT|DELETE /api/v1/blocks.
 * Requires a running PostgreSQL database pointed to by DATABASE_URL.
 * Spin one up with: docker compose up -d db
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
  // Wipe in dependency order
  await prisma.reservation.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();
});

// ─── POST /api/v1/blocks ──────────────────────────────────────────────────────

describe("POST /api/v1/blocks", () => {
  it.todo("creates a block and returns 201");
  it.todo("returns 400 for an invalid CIDR");
  it.todo("returns 409 for a duplicate CIDR");
});

// ─── GET /api/v1/blocks ───────────────────────────────────────────────────────

describe("GET /api/v1/blocks", () => {
  it.todo("lists all blocks");
  it.todo("filters by ipVersion");
  it.todo("filters by tag");
});

// ─── GET /api/v1/blocks/:id ───────────────────────────────────────────────────

describe("GET /api/v1/blocks/:id", () => {
  it.todo("returns the block with its subnets");
  it.todo("returns 404 for an unknown id");
});

// ─── PUT /api/v1/blocks/:id ───────────────────────────────────────────────────

describe("PUT /api/v1/blocks/:id", () => {
  it.todo("updates block metadata");
  it.todo("returns 404 for an unknown id");
});

// ─── DELETE /api/v1/blocks/:id ────────────────────────────────────────────────

describe("DELETE /api/v1/blocks/:id", () => {
  it.todo("deletes a block with no active reservations and returns 204");
  it.todo("returns 409 when active reservations exist");
});
