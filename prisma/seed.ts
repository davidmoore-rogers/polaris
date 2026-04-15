/**
 * prisma/seed.ts — Example seed data for local development
 *
 * Run with: npm run db:seed
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // ─── Default Admin User ────────────────────────────────────────────────────

  const adminHash = await bcrypt.hash("admin", 10);
  await prisma.user.upsert({
    where:  { username: "admin" },
    update: {},
    create: {
      username:     "admin",
      passwordHash: adminHash,
    },
  });

  // ─── IP Blocks ─────────────────────────────────────────────────────────────

  const corpBlock = await prisma.ipBlock.upsert({
    where:  { cidr: "10.0.0.0/8" },
    update: {},
    create: {
      name:        "Corporate Datacenter",
      cidr:        "10.0.0.0/8",
      ipVersion:   "v4",
      description: "Primary RFC-1918 space for internal infrastructure",
      tags:        ["datacenter", "internal"],
    },
  });

  const mgmtBlock = await prisma.ipBlock.upsert({
    where:  { cidr: "172.16.0.0/12" },
    update: {},
    create: {
      name:        "Management Network",
      cidr:        "172.16.0.0/12",
      ipVersion:   "v4",
      description: "Out-of-band management and BMC access",
      tags:        ["management", "oob"],
    },
  });

  // ─── Subnets ───────────────────────────────────────────────────────────────

  const k8sSubnet = await prisma.subnet.upsert({
    where:  { cidr: "10.0.1.0/24" },
    update: {},
    create: {
      blockId:  corpBlock.id,
      cidr:     "10.0.1.0/24",
      name:     "K8s Node Pool",
      purpose:  "Production Kubernetes worker nodes",
      status:   "available",
      vlan:     100,
      tags:     ["kubernetes", "prod"],
    },
  });

  const dbSubnet = await prisma.subnet.upsert({
    where:  { cidr: "10.0.2.0/24" },
    update: {},
    create: {
      blockId:  corpBlock.id,
      cidr:     "10.0.2.0/24",
      name:     "Database Tier",
      purpose:  "PostgreSQL and Redis clusters",
      status:   "available",
      vlan:     200,
      tags:     ["database", "prod"],
    },
  });

  const mgmtSubnet = await prisma.subnet.upsert({
    where:  { cidr: "172.16.0.0/24" },
    update: {},
    create: {
      blockId:  mgmtBlock.id,
      cidr:     "172.16.0.0/24",
      name:     "BMC / IPMI",
      purpose:  "Baseboard management controllers",
      status:   "available",
      vlan:     999,
      tags:     ["management", "bmc"],
    },
  });

  // ─── Reservations ──────────────────────────────────────────────────────────

  await prisma.reservation.upsert({
    where: {
      subnetId_ipAddress_status: {
        subnetId:  k8sSubnet.id,
        ipAddress: "10.0.1.10",
        status:    "active",
      },
    },
    update: {},
    create: {
      subnetId:   k8sSubnet.id,
      ipAddress:  "10.0.1.10",
      hostname:   "k8s-worker-01",
      owner:      "platform-team",
      projectRef: "INFRA-001",
      notes:      "Primary worker node",
      status:     "active",
    },
  });

  await prisma.reservation.upsert({
    where: {
      subnetId_ipAddress_status: {
        subnetId:  k8sSubnet.id,
        ipAddress: "10.0.1.11",
        status:    "active",
      },
    },
    update: {},
    create: {
      subnetId:   k8sSubnet.id,
      ipAddress:  "10.0.1.11",
      hostname:   "k8s-worker-02",
      owner:      "platform-team",
      projectRef: "INFRA-001",
      notes:      "Secondary worker node",
      status:     "active",
    },
  });

  await prisma.reservation.upsert({
    where: {
      subnetId_ipAddress_status: {
        subnetId:  dbSubnet.id,
        ipAddress: "10.0.2.10",
        status:    "active",
      },
    },
    update: {},
    create: {
      subnetId:   dbSubnet.id,
      ipAddress:  "10.0.2.10",
      hostname:   "postgres-primary",
      owner:      "data-team",
      projectRef: "DB-001",
      notes:      "Primary PostgreSQL instance",
      status:     "active",
    },
  });

  console.log("Seed complete.");
  console.log(`  Users:        ${await prisma.user.count()}`);
  console.log(`  Blocks:       ${await prisma.ipBlock.count()}`);
  console.log(`  Subnets:      ${await prisma.subnet.count()}`);
  console.log(`  Reservations: ${await prisma.reservation.count()}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
