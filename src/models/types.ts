/**
 * src/models/types.ts — Shared TypeScript interfaces
 *
 * Application-level types that layer on top of Prisma's generated types.
 */

import type {
  IpBlock,
  Subnet,
  Reservation,
  IpVersion,
  SubnetStatus,
  ReservationStatus,
} from "../generated/prisma/client.js";

// Re-export Prisma enums for convenience
export type { IpVersion, SubnetStatus, ReservationStatus };

// ─── Augmented query result shapes ───────────────────────────────────────────

export type BlockWithSubnetCount = IpBlock & {
  _count: { subnets: number };
};

export type BlockWithSubnets = IpBlock & {
  subnets: (Subnet & { _count: { reservations: number } })[];
};

export type SubnetWithBlock = Subnet & {
  block: Pick<IpBlock, "name" | "cidr">;
  _count: { reservations: number };
};

export type SubnetWithReservations = Subnet & {
  block: IpBlock;
  reservations: Reservation[];
};

export type ReservationWithSubnet = Reservation & {
  subnet: Pick<Subnet, "cidr" | "name">;
};

// ─── Utilization summary shapes ───────────────────────────────────────────────

export interface UtilizationSummary {
  totalBlocks: number;
  totalSubnets: number;
  activeReservations: number;
  expiredReservations: number;
}

export interface BlockUtilization {
  block: IpBlock;
  totalSubnets: number;
  reservedSubnets: number;
  activeReservations: number;
}

export interface SubnetUtilization {
  subnet: Subnet;
  totalAddresses: number;
  activeReservations: number;
  utilizationPercent: number;
}
