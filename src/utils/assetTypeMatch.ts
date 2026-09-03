/**
 * src/utils/assetTypeMatch.ts
 *
 * The device-type INFERENCE layer: which discovery-time facts land a device in
 * which `AssetTypeDef` bucket. Pure (no DB imports) so the discovery engine,
 * the Network Discovery adopter and the preview endpoint all run the same
 * decision, and so a unit test can exercise it without a database.
 *
 * Two things this deliberately is NOT:
 *
 *  - **It is not how every device gets its type.** A FortiSwitch discovered
 *    from its controller's CMDB *is* a switch, and a vCenter host *is* a
 *    hypervisor — those are identity, read off an authoritative source, and
 *    they stay hardcoded. Rules only decide the cases where Polaris would
 *    otherwise be guessing from a text field. `AUTHORITATIVE_TYPE_SOURCES`
 *    below is the catalogue the Device Types card renders so an operator can
 *    see which buckets their rules cannot affect and why.
 *
 *  - **It is not retroactive.** The resolver answers about ONE device's facts
 *    at the moment discovery sees them. Re-typing existing inventory after a
 *    rule edit is a separate, explicit operator action (see
 *    `assetTypeService.applyMatchRules`), bounded to assets currently sitting
 *    in `other` — the same guard the discovery engine has always applied
 *    before re-typing an existing asset.
 *
 * Contexts exist because the two hardcoded predicates this replaces asked
 * different questions of different inputs. `inferAssetTypeFromOs` read an OS
 * string from a directory record and could only answer server / workstation /
 * other; `assetTypeForHit` read a scanned device's own self-description and
 * could answer firewall / switch / access_point / router / printer. Merging
 * them into one rule set would have silently started typing AD computers
 * "printer" off an OS string, so each type declares which contexts its rules
 * run in and the seed migration reproduces the old split exactly.
 */

/** Facts a source can offer the resolver. Every field is optional. */
export interface AssetTypeFacts {
  os?: string | null;
  osVersion?: string | null;
  hostname?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  /** Entra / Intune chassis type ("desktop", "laptop", "tablet", …). */
  chassis?: string | null;
}

export const MATCH_FIELDS = [
  "any",
  "os",
  "osVersion",
  "hostname",
  "manufacturer",
  "model",
  "chassis",
] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];

export const MATCH_OPS = ["contains", "equals", "starts_with", "ends_with", "regex"] as const;
export type MatchOp = (typeof MATCH_OPS)[number];

export const MATCH_CONTEXTS = ["directory", "scan"] as const;
export type MatchContext = (typeof MATCH_CONTEXTS)[number];

export interface MatchClause {
  field: MatchField;
  op: MatchOp;
  value: string;
  /** Inverts the clause. A negated clause on an ABSENT fact does not match. */
  negate?: boolean;
}

export interface MatchRules {
  /**
   * ANY-of. A type claims a device when at least one clause matches — which is
   * what the hardcoded predicates did (a long `||` ladder), and what an
   * operator listing model prefixes means. AND-of is reachable by writing one
   * regex; a nested tree here would be a second condition-builder dialect for
   * no gain.
   */
  clauses: MatchClause[];
}

/** One registry row, as much of it as the resolver needs. */
export interface MatchableType {
  name: string;
  matchRules: MatchRules | null;
  matchContexts: string[];
  matchPriority: number;
}

// ─── Validation ────────────────────────────────────────────────────────────

const MAX_CLAUSES = 64;
const MAX_VALUE_LEN = 200;

/**
 * Compile-check a regex the operator typed. Returns null when it is usable.
 *
 * A bad pattern has to be refused at WRITE time: the resolver runs inside the
 * discovery hot path, and a `new RegExp` throwing per device per run would
 * turn one typo into a failed discovery for the whole fleet.
 */
export function validateRegex(pattern: string): string | null {
  try {
    new RegExp(pattern, "i");
    return null;
  } catch (err) {
    return `Invalid regular expression: ${(err as Error).message}`;
  }
}

/** Validate a rules blob. Returns an error message, or null when it is legal. */
export function validateMatchRules(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "Match rules must be an object.";
  const clauses = (raw as MatchRules).clauses;
  if (!Array.isArray(clauses)) return "Match rules must carry a `clauses` array.";
  if (clauses.length > MAX_CLAUSES) return `At most ${MAX_CLAUSES} clauses per type.`;
  for (const [i, c] of clauses.entries()) {
    const at = `Clause ${i + 1}`;
    if (!c || typeof c !== "object") return `${at} is not an object.`;
    if (!(MATCH_FIELDS as readonly string[]).includes(c.field)) return `${at}: unknown field "${c.field}".`;
    if (!(MATCH_OPS as readonly string[]).includes(c.op)) return `${at}: unknown operator "${c.op}".`;
    if (typeof c.value !== "string" || !c.value.trim()) return `${at}: value is required.`;
    if (c.value.length > MAX_VALUE_LEN) return `${at}: value is longer than ${MAX_VALUE_LEN} characters.`;
    if (c.negate !== undefined && typeof c.negate !== "boolean") return `${at}: negate must be true or false.`;
    if (c.op === "regex") {
      const err = validateRegex(c.value);
      if (err) return `${at}: ${err}`;
    }
  }
  return null;
}

/** Validate a contexts array. Returns an error message, or null. */
export function validateMatchContexts(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return "Match contexts must be an array.";
  for (const c of raw) {
    if (!(MATCH_CONTEXTS as readonly string[]).includes(c)) return `Unknown match context "${c}".`;
  }
  return null;
}

/** Coerce a stored JSON blob into `MatchRules`, or null when it is unusable. */
export function normalizeMatchRules(raw: unknown): MatchRules | null {
  if (validateMatchRules(raw) !== null) return null;
  const clauses = (raw as MatchRules | null)?.clauses;
  if (!Array.isArray(clauses) || clauses.length === 0) return null;
  return {
    clauses: clauses.map((c) => ({
      field: c.field,
      op: c.op,
      value: c.value,
      ...(c.negate ? { negate: true } : {}),
    })),
  };
}

// ─── Evaluation ────────────────────────────────────────────────────────────

/**
 * The text a clause's `field` reads. `any` is the space-joined non-empty
 * facts, which is how `assetTypeForHit` matched (`os` + `hostname`) — pass the
 * resolver only the facts a source actually has and `any` means the same
 * thing it always did.
 */
function factText(facts: AssetTypeFacts, field: MatchField): string | null {
  if (field === "any") {
    const parts = [facts.os, facts.hostname, facts.manufacturer, facts.model, facts.chassis]
      .map((v) => (v ?? "").trim())
      .filter(Boolean);
    return parts.length ? parts.join(" ") : null;
  }
  const v = facts[field as Exclude<MatchField, "any">];
  const s = (v ?? "").trim();
  return s ? s : null;
}

/**
 * Does one clause match? Case-insensitive throughout — every pattern this
 * replaces lower-cased its haystack first.
 *
 * An ABSENT fact never matches, negated or not. "This device is not a Windows
 * box" must not be satisfied by a device that reported no OS at all: at
 * discovery time a missing fact means *not yet known*, and letting absence
 * satisfy a negation is how one silent field outage re-types a fleet.
 */
export function clauseMatches(clause: MatchClause, facts: AssetTypeFacts): boolean {
  const text = factText(facts, clause.field);
  if (text === null) return false;
  const hay = text.toLowerCase();
  const needle = clause.value.trim().toLowerCase();

  let hit: boolean;
  switch (clause.op) {
    case "contains":    hit = hay.includes(needle); break;
    case "equals":      hit = hay === needle; break;
    case "starts_with": hit = hay.startsWith(needle); break;
    case "ends_with":   hit = hay.endsWith(needle); break;
    case "regex": {
      // Validated at write time; a stored pattern that still fails to compile
      // (hand-edited row, restored backup) is treated as no-match rather than
      // being allowed to throw into the discovery loop.
      try {
        hit = new RegExp(clause.value, "i").test(text);
      } catch {
        hit = false;
      }
      break;
    }
    default: hit = false;
  }
  return clause.negate ? !hit : hit;
}

/** Does this type claim the device? */
export function typeMatches(type: MatchableType, facts: AssetTypeFacts, context: MatchContext): boolean {
  if (!type.matchContexts.includes(context)) return false;
  const rules = type.matchRules;
  if (!rules || !rules.clauses.length) return false;
  return rules.clauses.some((c) => clauseMatches(c, facts));
}

/**
 * Deterministic evaluation order: priority ascending, then name. Ties on
 * priority are broken by name rather than left to the database's row order,
 * so two installs with the same registry infer the same type.
 */
export function orderTypes(types: readonly MatchableType[]): MatchableType[] {
  return [...types].sort((a, b) =>
    a.matchPriority !== b.matchPriority ? a.matchPriority - b.matchPriority : a.name.localeCompare(b.name),
  );
}

/**
 * Resolve facts to a type name. Returns null when nothing claims the device —
 * callers decide their own default (`other` for discovery, `workstation` for
 * Entra/Intune, which has always assumed its records are endpoints).
 */
export function resolveAssetType(
  types: readonly MatchableType[],
  facts: AssetTypeFacts,
  context: MatchContext,
): string | null {
  for (const t of orderTypes(types)) {
    if (typeMatches(t, facts, context)) return t.name;
  }
  return null;
}

/**
 * The same walk, but reporting WHICH clause decided — the preview surface
 * needs to show an operator why a device landed where it did, and a preview
 * that re-derived its own explanation could disagree with the resolver.
 */
export interface MatchExplanation {
  type: string | null;
  clause: MatchClause | null;
}

export function explainAssetType(
  types: readonly MatchableType[],
  facts: AssetTypeFacts,
  context: MatchContext,
): MatchExplanation {
  for (const t of orderTypes(types)) {
    if (!t.matchContexts.includes(context)) continue;
    const clauses = t.matchRules?.clauses ?? [];
    for (const c of clauses) {
      if (clauseMatches(c, facts)) return { type: t.name, clause: c };
    }
  }
  return { type: null, clause: null };
}

// ─── Registry cache ────────────────────────────────────────────────────────
//
// Mirrors the pattern in utils/assetTypes.ts: assetTypeService.refreshCache()
// installs the rows here at boot and after every mutation, so the discovery
// hot path resolves a type without a query per device.

/** null = never loaded in this process. Distinct from "loaded and empty". */
let _matchRegistry: MatchableType[] | null = null;

export function setAssetTypeMatchRegistry(types: readonly MatchableType[]): void {
  _matchRegistry = orderTypes(types);
}

/** Test seam — lets a suite return a process to the never-loaded state. */
export function resetAssetTypeMatchRegistry(): void {
  _matchRegistry = null;
}

/**
 * The rows the resolver will use. Before the cache is loaded this is the
 * SHIPPED matching rather than nothing, mirroring `isKnownAssetType`'s
 * fall-through to the built-in names in utils/assetTypes.ts.
 *
 * The distinction is load-bearing. An empty ARRAY is a real answer — an
 * operator can legitimately clear every rule — but a `null` cache means this
 * process has not asked yet, and answering "nothing matches" there would type
 * a whole discovery run `other` and look exactly like a fleet of unrecognized
 * devices. Warming is belt and braces on top: `startBackgroundJobs` loads it
 * on every role and `runDiscovery` re-reads it per run.
 */
function activeRegistry(): readonly MatchableType[] {
  if (_matchRegistry !== null) return _matchRegistry;
  return orderTypes(
    Object.entries(DEFAULT_TYPE_MATCHING).map(([name, m]) => ({
      name,
      matchRules: m.rules,
      matchContexts: m.contexts,
      matchPriority: m.priority,
    })),
  );
}

export function getAssetTypeMatchRegistry(): readonly MatchableType[] {
  return activeRegistry();
}

/** Resolve against the live cache. */
export function resolveAssetTypeCached(facts: AssetTypeFacts, context: MatchContext): string | null {
  return resolveAssetType(activeRegistry(), facts, context);
}

// ─── Shipped defaults ──────────────────────────────────────────────────────

/**
 * The matching every built-in type ships with — a transcription of the two
 * hardcoded predicates this layer replaced, so a fresh install behaves exactly
 * as it did before rules existed.
 *
 * **Kept in lockstep with the seed migration**
 * (`20260901010000_asset_type_match_rules`), which is where EXISTING installs
 * get their rules; this constant only reaches rows that
 * `seedBuiltInAssetTypes` has to create from scratch (a `prisma migrate reset`
 * or a nuked volume). The two can't share source — one is SQL — so
 * `tests/unit/assetTypeMatch.test.ts` pins the behavior both must produce
 * rather than the text.
 *
 * A type absent from this table (`other`, `hypervisor`, `kubernetes_cluster`)
 * ships with no rules on purpose: `other` is the fallback rather than a match,
 * and the other two are only ever assigned by an authoritative source.
 */
export const DEFAULT_TYPE_MATCHING: Readonly<
  Record<string, { contexts: MatchContext[]; priority: number; rules: MatchRules }>
> = {
  server: {
    contexts: ["directory"],
    priority: 20,
    rules: {
      clauses: [
        "server", "centos", "red hat", "rhel", "rocky linux", "almalinux",
        "oracle linux", "freebsd", "openbsd", "netbsd", "esxi", "vmware",
      ].map((value) => ({ field: "os" as const, op: "contains" as const, value })),
    },
  },
  workstation: {
    contexts: ["directory"],
    priority: 30,
    rules: {
      clauses: [
        { field: "os", op: "regex", value: "windows\\s+(10|11|7|8|xp|vista)" },
        ...["macos", "mac os x", "os x", "linux mint", "ubuntu", "fedora", "debian",
          "arch linux", "manjaro", "pop!_os", "elementary os", "zorin os",
        ].map((value) => ({ field: "os" as const, op: "contains" as const, value })),
      ],
    },
  },
  firewall: {
    contexts: ["scan"],
    priority: 10,
    rules: { clauses: [{ field: "any", op: "regex", value: "\\b(fortigate|firewall|palo alto|sonicwall)\\b" }] },
  },
  switch: {
    contexts: ["scan"],
    priority: 12,
    rules: { clauses: [{ field: "any", op: "regex", value: "\\b(fortiswitch|switch|catalyst|nexus)\\b" }] },
  },
  access_point: {
    contexts: ["scan"],
    priority: 14,
    rules: { clauses: [{ field: "any", op: "regex", value: "\\bfortiap\\b|access point|\\bwlan\\b|\\bwireless\\b" }] },
  },
  router: {
    contexts: ["scan"],
    priority: 16,
    rules: { clauses: [{ field: "any", op: "regex", value: "\\brouter\\b" }] },
  },
  printer: {
    contexts: ["scan"],
    priority: 18,
    rules: { clauses: [{ field: "any", op: "regex", value: "\\bprinter\\b|laserjet|officejet" }] },
  },
};

// ─── The paths rules cannot reach ──────────────────────────────────────────

/**
 * Where a device's type comes from when it is READ rather than guessed.
 *
 * This is documentation with a consumer: the Device Types card renders it so
 * an operator editing rules can see that a FortiSwitch will keep being a
 * switch no matter what they write, and why. Keep it in step with the
 * hardcoded assignments in discoveryEngine / vcenterService / azureArcService
 * — a stale entry here is a card that lies about the system's behavior.
 */
export interface AuthoritativeTypeSource {
  /** Operator-facing name of the discovery path. */
  source: string;
  /** The type names it assigns outright. */
  assigns: string[];
  /** Why it outranks the rules. */
  reason: string;
}

export const AUTHORITATIVE_TYPE_SOURCES: readonly AuthoritativeTypeSource[] = [
  {
    source: "FortiManager / FortiGate discovery",
    assigns: ["firewall", "switch", "access_point"],
    reason:
      "The controller's own CMDB states the device's role. Dependency suppression, topology rendering and polling defaults branch on these three names, so they are read, never inferred.",
  },
  {
    source: "VMware vCenter discovery",
    assigns: ["hypervisor", "server"],
    reason:
      "An ESXi host and a VM are distinct objects in the vCenter inventory. VM identity lives in the asset's Virtualization blob, not in its type.",
  },
  {
    source: "Azure Arc discovery",
    assigns: ["kubernetes_cluster"],
    reason: "An Arc-enabled connected cluster is its own Azure resource type.",
  },
  {
    source: "Operator edit",
    assigns: [],
    reason:
      "A type set by hand is never overwritten. Discovery only re-types an existing asset that is still sitting in “Other”.",
  },
] as const;
