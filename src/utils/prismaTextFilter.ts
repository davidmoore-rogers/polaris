/**
 * src/utils/prismaTextFilter.ts — operator-aware text-column filter builder.
 *
 * The TableSF server-side contract: a text column filter arrives as
 * (value, op) with op ∈ contains | not_contains | empty | is_not_empty
 * (missing/unknown op → contains). This translates one filter into a
 * Prisma WHERE-level fragment (`{ field: ... }` / `{ OR: [...] }` — not
 * field-level, because empty / is_not_empty need OR / AND composition);
 * the call site ANDs the fragments together.
 *
 * `nullable` controls the blank checks: nullable columns need a null arm,
 * while non-nullable columns compare against "" only (Prisma rejects
 * `equals: null` on a non-nullable field). NOTE the `not_contains` shape:
 * `mode` is a SIBLING of `not` in Prisma's string filter — nesting it
 * inside the `not` object is rejected by the client.
 *
 * Previously implemented twice (events.ts buildTextFilter, assets.ts
 * buildAssetTextFilter) — 2026-08 audit.
 */

export const TEXT_FILTER_OPS = new Set(["contains", "not_contains", "empty", "is_not_empty"]);

export function buildPrismaTextFilter(
  field: string,
  value: string | undefined,
  op: string | undefined,
  opts?: { nullable?: boolean },
): Record<string, unknown> | undefined {
  const operator = op && TEXT_FILTER_OPS.has(op) ? op : "contains";
  const nullable = opts?.nullable !== false;
  if (operator === "empty") {
    return nullable ? { OR: [{ [field]: null }, { [field]: "" }] } : { [field]: "" };
  }
  if (operator === "is_not_empty") {
    return nullable
      ? { AND: [{ [field]: { not: null } }, { [field]: { not: "" } }] }
      : { [field]: { not: "" } };
  }
  const v = (value || "").trim();
  if (!v) return undefined;
  if (operator === "not_contains") {
    return { [field]: { not: { contains: v }, mode: "insensitive" } };
  }
  return { [field]: { contains: v, mode: "insensitive" } };
}
