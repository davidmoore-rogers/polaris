/**
 * src/services/subnetService.ts
 */

import type { SubnetStatus } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import {
  normalizeCidr,
  isValidCidr,
  cidrContains,
  cidrOverlaps,
  findNextAvailableSubnet,
  detectIpVersion,
  enumerateSubnetIps,
  packIntoAnchor,
} from "../utils/cidr.js";

export interface CreateSubnetInput {
  blockId: string;
  cidr: string;
  name: string;
  purpose?: string;
  vlan?: number;
  tags?: string[];
  createdBy?: string;
}

export interface UpdateSubnetInput {
  name?: string;
  purpose?: string;
  status?: SubnetStatus;
  vlan?: number;
  tags?: string[];
  convertToManual?: boolean;
  mergeIntegration?: boolean;
}

export interface ListSubnetsFilter {
  blockId?: string;
  status?: SubnetStatus;
  tag?: string;
  createdBy?: string;
  limit?: number;
  offset?: number;
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listSubnets(filter: ListSubnetsFilter = {}) {
  const limit = Math.min(filter.limit || 50, 10000);
  const offset = filter.offset || 0;

  const where: Record<string, unknown> = {};
  if (filter.blockId) where.blockId = filter.blockId;
  if (filter.status) where.status = filter.status;
  if (filter.createdBy) where.createdBy = filter.createdBy;

  const [subnets, total] = await Promise.all([
    prisma.subnet.findMany({
      where,
      include: {
        block: { select: { name: true, cidr: true } },
        integration: { select: { id: true, name: true } },
        _count: { select: { reservations: true } },
      },
      orderBy: { cidr: "asc" },
      skip: offset,
      take: limit,
    }),
    prisma.subnet.count({ where }),
  ]);

  const filtered = filter.tag ? subnets.filter((s) => s.tags.includes(filter.tag!)) : subnets;
  return { subnets: filtered, total, limit, offset };
}

// ─── Get ──────────────────────────────────────────────────────────────────────

export async function getSubnet(id: string) {
  const subnet = await prisma.subnet.findUnique({
    where: { id },
    include: {
      block: true,
      integration: { select: { id: true, name: true } },
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
      tags: input.tags ?? [],
      status: "available",
      createdBy: input.createdBy,
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

// ─── Bulk allocation from a template ─────────────────────────────────────────

/**
 * A row in a bulk-allocate template.
 *
 * A regular entry has a name and optional VLAN and produces a subnet.
 * A skip entry (`skip: true`) reserves address space inside the packed
 * anchor region without creating a subnet — used to leave gaps between
 * allocations so later templates land on a clean boundary. The route layer
 * validates that `name` is present whenever `skip` is not true.
 */
export interface BulkAllocateEntry {
  skip?: boolean;
  name?: string;
  prefixLength: number;
  vlan?: number | null;
}

export interface BulkAllocateInput {
  blockId: string;
  prefix: string;
  entries: BulkAllocateEntry[];
  tags?: string[];
  /**
   * Minimum alignment granularity for the group. If the template's combined
   * footprint needs a larger region, that larger prefix is used instead.
   * Defaults to 24 if omitted.
   */
  anchorPrefix?: number;
  createdBy?: string;
}

export interface BulkAllocateResult {
  created: Array<{ name: string; cidr: string; id: string }>;
  anchorCidr: string;
  effectiveAnchorPrefix: number;
}

/**
 * Allocate multiple subnets from one template invocation, anchor-aligned.
 *
 * All entries are placed inside a single contiguous region aligned to the
 * effective anchor prefix (= the larger of the requested anchor and the
 * smallest block that contains the group's packed footprint). Entries are
 * packed in caller order with per-entry prefix alignment padding.
 *
 * All-or-nothing: either every subnet is created in one transaction, or the
 * call throws and nothing changes.
 */
export async function bulkAllocate(input: BulkAllocateInput): Promise<BulkAllocateResult> {
  if (!input.prefix || !input.prefix.trim()) {
    throw new AppError(400, "A site/prefix name is required");
  }
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new AppError(400, "At least one entry is required");
  }

  const requestedAnchor = input.anchorPrefix ?? 24;
  if (!Number.isInteger(requestedAnchor) || requestedAnchor < 8 || requestedAnchor > 32) {
    throw new AppError(400, "Anchor prefix must be between /8 and /32");
  }

  for (const e of input.entries) {
    if (!Number.isInteger(e.prefixLength) || e.prefixLength < 8 || e.prefixLength > 32) {
      const label = e.skip ? "skip" : e.name ?? "unnamed";
      throw new AppError(400, `Entry "${label}" has an invalid prefix length`);
    }
    if (!e.skip && (!e.name || !e.name.trim())) {
      throw new AppError(400, "Every non-skip entry must have a name");
    }
  }

  const hasCreatable = input.entries.some((e) => !e.skip);
  if (!hasCreatable) {
    throw new AppError(400, "At least one non-skip entry is required");
  }

  const block = await prisma.ipBlock.findUnique({ where: { id: input.blockId } });
  if (!block) throw new AppError(404, `IP Block ${input.blockId} not found`);
  if (block.ipVersion !== "v4") {
    throw new AppError(400, "Auto-allocation is currently only supported for IPv4 blocks");
  }

  const prefix = input.prefix.trim();
  const tags = input.tags ?? [];

  // Compute the packed CIDRs under a transaction. Re-query existing subnets
  // inside the transaction so concurrent allocations don't race with us.
  return prisma.$transaction(async (tx) => {
    const existing = await tx.subnet.findMany({
      where: { blockId: input.blockId },
      select: { cidr: true },
    });

    const packed = packIntoAnchor(
      block.cidr,
      existing.map((s) => s.cidr),
      input.entries,
      requestedAnchor
    );
    if (!packed) {
      throw new AppError(
        409,
        `No free /${requestedAnchor}-aligned region in block ${block.cidr} large enough to hold the template`
      );
    }

    // Defence in depth: double-check each creatable assignment against the
    // existing set. packIntoAnchor already guarantees the anchor region is
    // clear; skip entries reserve space but don't get created.
    for (const a of packed.assignments) {
      if (a.entry.skip) continue;
      const overlap = existing.find((s) => cidrOverlaps(s.cidr, a.cidr));
      if (overlap) {
        throw new AppError(409, `Computed subnet ${a.cidr} overlaps existing ${overlap.cidr}`);
      }
    }

    const created: BulkAllocateResult["created"] = [];
    for (const a of packed.assignments) {
      if (a.entry.skip) continue;
      const subnetName = `${prefix}_${a.entry.name}`;
      const normalized = normalizeCidr(a.cidr);
      const row = await tx.subnet.create({
        data: {
          blockId: input.blockId,
          cidr: normalized,
          name: subnetName,
          vlan: a.entry.vlan ?? undefined,
          tags,
          status: "available",
          createdBy: input.createdBy,
        },
      });
      created.push({ id: row.id, name: row.name, cidr: row.cidr });
    }

    return {
      created,
      anchorCidr: packed.anchorCidr,
      effectiveAnchorPrefix: packed.effectiveAnchorPrefix,
    };
  });
}

// ─── Preview (read-only sibling of bulkAllocate) ─────────────────────────────

export interface BulkAllocatePreviewInput {
  blockId: string;
  entries: BulkAllocateEntry[];
  anchorPrefix?: number;
}

export interface BulkAllocatePreviewResult {
  fits: boolean;
  anchorCidr: string | null;
  effectiveAnchorPrefix: number | null;
  assignments: Array<{ name: string | null; skip: boolean; prefixLength: number; cidr: string | null }>;
  totalAddresses: number;
  slashTwentyFourCount: number;
  blockCidr: string;
  /** Surface any validation error reached before running the packer. */
  error: string | null;
}

/**
 * Non-mutating preview of bulkAllocate. Computes the packed assignments and
 * whether they fit in the selected block, without creating any rows.
 */
export async function previewBulkAllocate(
  input: BulkAllocatePreviewInput
): Promise<BulkAllocatePreviewResult> {
  const requestedAnchor = input.anchorPrefix ?? 24;
  if (!Number.isInteger(requestedAnchor) || requestedAnchor < 8 || requestedAnchor > 32) {
    throw new AppError(400, "Anchor prefix must be between /8 and /32");
  }

  const block = await prisma.ipBlock.findUnique({ where: { id: input.blockId } });
  if (!block) throw new AppError(404, `IP Block ${input.blockId} not found`);

  // Compute footprint numbers even if we bail early (so the UI can still show totals).
  let totalAddresses = 0;
  for (const e of input.entries) {
    if (!Number.isInteger(e.prefixLength) || e.prefixLength < 8 || e.prefixLength > 32) {
      // surface invalid entry but keep going — totals aren't meaningful yet
      return {
        fits: false,
        anchorCidr: null,
        effectiveAnchorPrefix: null,
        assignments: [],
        totalAddresses: 0,
        slashTwentyFourCount: 0,
        blockCidr: block.cidr,
        error: `An entry has an invalid prefix length`,
      };
    }
    totalAddresses += 2 ** (32 - e.prefixLength);
  }
  const slashTwentyFourCount = Math.ceil(totalAddresses / 256);

  if (block.ipVersion !== "v4") {
    return {
      fits: false,
      anchorCidr: null,
      effectiveAnchorPrefix: null,
      assignments: [],
      totalAddresses,
      slashTwentyFourCount,
      blockCidr: block.cidr,
      error: "Auto-allocation is currently only supported for IPv4 blocks",
    };
  }

  if (input.entries.length === 0) {
    return {
      fits: false,
      anchorCidr: null,
      effectiveAnchorPrefix: null,
      assignments: [],
      totalAddresses,
      slashTwentyFourCount,
      blockCidr: block.cidr,
      error: null,
    };
  }

  const existing = await prisma.subnet.findMany({
    where: { blockId: input.blockId },
    select: { cidr: true },
  });

  const packed = packIntoAnchor(
    block.cidr,
    existing.map((s) => s.cidr),
    input.entries,
    requestedAnchor
  );

  if (!packed) {
    return {
      fits: false,
      anchorCidr: null,
      effectiveAnchorPrefix: null,
      assignments: input.entries.map((e) => ({
        name: e.skip ? null : e.name ?? null,
        skip: !!e.skip,
        prefixLength: e.prefixLength,
        cidr: null,
      })),
      totalAddresses,
      slashTwentyFourCount,
      blockCidr: block.cidr,
      error: null,
    };
  }

  return {
    fits: true,
    anchorCidr: packed.anchorCidr,
    effectiveAnchorPrefix: packed.effectiveAnchorPrefix,
    assignments: packed.assignments.map((a) => ({
      name: a.entry.skip ? null : a.entry.name ?? null,
      skip: !!a.entry.skip,
      prefixLength: a.entry.prefixLength,
      cidr: a.cidr,
    })),
    totalAddresses,
    slashTwentyFourCount,
    blockCidr: block.cidr,
    error: null,
  };
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateSubnet(id: string, input: UpdateSubnetInput) {
  const subnet = await prisma.subnet.findUnique({ where: { id } });
  if (!subnet) throw new AppError(404, `Subnet ${id} not found`);

  const data: any = {
    name: input.name,
    purpose: input.purpose,
    status: input.status,
    vlan: input.vlan,
    tags: input.tags,
  };
  if (input.convertToManual) {
    data.discoveredBy = null;
    data.fortigateDevice = null;
  }

  return prisma.subnet.update({ where: { id }, data });
}

// ─── IP Enumeration ──────────────────────────────────────────────────────────

export async function getSubnetIps(id: string, page: number, pageSize: number) {
  const subnet = await prisma.subnet.findUnique({
    where: { id },
    include: {
      // config is included so the response can derive `pushEligible` for the
      // reserve modals — the Reservation Push toggle on the integration
      // determines whether MAC becomes required at create time.
      integration: { select: { id: true, name: true, type: true, config: true } },
      reservations: true,
    },
  });
  if (!subnet) throw new AppError(404, `Subnet ${id} not found`);

  const isIpv6 = detectIpVersion(subnet.cidr) === "v6";

  // Push eligibility: only manual per-IP reservations on subnets discovered
  // by an FMG integration with pushReservations=true are pushed. The frontend
  // uses this to mark the MAC field required and validate before submitting.
  const integrationConfig = (subnet.integration?.config ?? {}) as Record<string, unknown>;
  const pushEligible =
    !isIpv6 &&
    subnet.integration?.type === "fortimanager" &&
    integrationConfig.pushReservations === true &&
    !!subnet.fortigateDevice;

  const subnetInfo = {
    name: subnet.name,
    cidr: subnet.cidr,
    status: subnet.status,
    vlan: subnet.vlan,
    purpose: subnet.purpose,
    // Strip config off the integration object before returning — it can hold
    // sensitive fields and the frontend only needs id/name/type.
    integration: subnet.integration
      ? { id: subnet.integration.id, name: subnet.integration.name, type: subnet.integration.type }
      : null,
    fortigateDevice: subnet.fortigateDevice,
    pushEligible,
    hasConflict: subnet.reservations.some(r => r.conflictMessage),
    conflictMessage: subnet.reservations.some(r => r.conflictMessage)
      ? "One or more IPs have conflicts"
      : null,
  };

  const toReservationDto = (r: typeof subnet.reservations[0]) => ({
    id: r.id,
    hostname: r.hostname,
    owner: r.owner,
    status: r.status,
    sourceType: r.sourceType,
    notes: r.notes,
    expiresAt: r.expiresAt,
    createdBy: r.createdBy,
    conflictMessage: r.conflictMessage,
  });

  // DHCP discovery commonly produces multiple reservations for the same host
  // (one per interface MAC), but Asset.ipAddress only points at the most
  // recent primary IP — so direct ipAddress lookup links just one row to the
  // asset. Fall back to hostname matching for the remaining rows so every
  // reservation that came from the same asset gets the Asset button.
  if (isIpv6) {
    const ipv6Addrs = subnet.reservations.filter(r => r.ipAddress).map(r => r.ipAddress!);
    const ipv6Hostnames = Array.from(new Set(
      subnet.reservations.map(r => r.hostname).filter((h): h is string => !!h),
    ));
    const v6Assets = (ipv6Addrs.length > 0 || ipv6Hostnames.length > 0)
      ? await prisma.asset.findMany({
          where: {
            OR: [
              ...(ipv6Addrs.length > 0 ? [{ ipAddress: { in: ipv6Addrs } }] : []),
              ...(ipv6Hostnames.length > 0 ? [{ hostname: { in: ipv6Hostnames } }] : []),
            ],
          },
          select: { id: true, ipAddress: true, hostname: true },
        })
      : [];
    const assetByIpV6 = new Map<string, string>();
    const assetByHostnameV6 = new Map<string, string>();
    for (const a of v6Assets) {
      if (a.ipAddress) assetByIpV6.set(a.ipAddress, a.id);
      if (a.hostname && !assetByHostnameV6.has(a.hostname)) assetByHostnameV6.set(a.hostname, a.id);
    }

    const ips = subnet.reservations
      .filter(r => r.ipAddress)
      .map(r => ({
        address: r.ipAddress!,
        type: "host" as const,
        reservation: toReservationDto(r),
        assetId:
          assetByIpV6.get(r.ipAddress!) ??
          (r.hostname ? assetByHostnameV6.get(r.hostname) ?? null : null),
      }));
    return {
      subnet: subnetInfo,
      ips,
      ipv6: true,
      totalIps: ips.length,
      page: 1,
      pageSize: ips.length,
    };
  }

  const { addresses, total } = enumerateSubnetIps(subnet.cidr, page, pageSize);

  const reservationMap = new Map<string, typeof subnet.reservations[0]>();
  for (const r of subnet.reservations) {
    if (r.ipAddress) {
      const existing = reservationMap.get(r.ipAddress);
      if (!existing || (r.status === "active" && existing.status !== "active")) {
        reservationMap.set(r.ipAddress, r);
      }
    }
  }

  const pageAddrs = addresses.map(a => a.address);
  const pageHostnames = Array.from(new Set(
    pageAddrs
      .map(a => reservationMap.get(a)?.hostname)
      .filter((h): h is string => !!h),
  ));
  const pageAssets = (pageAddrs.length > 0 || pageHostnames.length > 0)
    ? await prisma.asset.findMany({
        where: {
          OR: [
            ...(pageAddrs.length > 0 ? [{ ipAddress: { in: pageAddrs } }] : []),
            ...(pageHostnames.length > 0 ? [{ hostname: { in: pageHostnames } }] : []),
          ],
        },
        select: { id: true, ipAddress: true, hostname: true },
      })
    : [];
  const assetByIp = new Map<string, string>();
  const assetByHostname = new Map<string, string>();
  for (const a of pageAssets) {
    if (a.ipAddress) assetByIp.set(a.ipAddress, a.id);
    if (a.hostname && !assetByHostname.has(a.hostname)) assetByHostname.set(a.hostname, a.id);
  }

  const ips = addresses.map(addr => {
    const r = reservationMap.get(addr.address);
    return {
      address: addr.address,
      type: addr.type,
      reservation: r ? toReservationDto(r) : null,
      assetId:
        assetByIp.get(addr.address) ??
        (r?.hostname ? assetByHostname.get(r.hostname) ?? null : null),
    };
  });

  return {
    subnet: subnetInfo,
    ips,
    ipv6: false,
    totalIps: total,
    page,
    pageSize,
  };
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteSubnet(id: string) {
  const subnet = await prisma.subnet.findUnique({
    where: { id },
    include: {
      reservations: {
        select: { id: true, ipAddress: true, hostname: true, owner: true, status: true },
      },
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

  const deletedReservations = subnet.reservations;
  await prisma.subnet.delete({ where: { id } });

  return { ...subnet, deletedReservations };
}
