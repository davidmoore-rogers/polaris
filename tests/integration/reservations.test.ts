/**
 * tests/integration/reservations.test.ts
 *
 * Integration tests for /api/v1/reservations.
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

// ─── POST /api/v1/reservations ────────────────────────────────────────────────

describe("POST /api/v1/reservations", () => {
  it.todo("creates a specific-IP reservation and returns 201");
  it.todo("creates a full-subnet reservation and marks subnet as reserved");
  it.todo("returns 400 for an IP not within the subnet");
  it.todo("returns 409 for a duplicate active reservation on the same IP");
  it.todo("returns 409 when reserving a deprecated subnet");
});

// ─── GET /api/v1/reservations ─────────────────────────────────────────────────

describe("GET /api/v1/reservations", () => {
  it.todo("lists all reservations");
  it.todo("filters by owner");
  it.todo("filters by projectRef");
  it.todo("filters by status");
});

// ─── GET /api/v1/reservations/:id ────────────────────────────────────────────

describe("GET /api/v1/reservations/:id", () => {
  it.todo("returns the reservation with subnet and block info");
  it.todo("returns 404 for an unknown id");
});

// ─── PUT /api/v1/reservations/:id ────────────────────────────────────────────

describe("PUT /api/v1/reservations/:id", () => {
  it.todo("updates reservation metadata");
  it.todo("extends the TTL via expiresAt");
  it.todo("returns 409 when trying to update an expired reservation");
});

// ─── DELETE /api/v1/reservations/:id ─────────────────────────────────────────

describe("DELETE /api/v1/reservations/:id", () => {
  it.todo("releases an active reservation and returns 204");
  it.todo("restores subnet status to available after full-subnet release");
  it.todo("returns 409 when reservation is already released");
});
