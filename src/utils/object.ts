/**
 * src/utils/object.ts — tiny object-shape helpers shared across services.
 */

/** Shallow copy of v when it's a non-null object; a fresh empty object otherwise. */
export function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? { ...(v as Record<string, unknown>) } : {};
}
