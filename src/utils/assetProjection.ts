/**
 * src/utils/assetProjection.ts
 *
 * Pure projection of an asset's discovery-owned fields from its AssetSource
 * rows. Phase 3b.0 (shadow): integration writes still own field values on
 * the Asset row directly; this projection is computed alongside and any
 * disagreement is logged for analysis. Phase 3b.1 will cut Asset writes to
 * use the projection as the source of truth.
 *
 * Per-field priority order (first truthy wins). Inferred sources are
 * skipped — they're phase-1 backfill skeletons, not authoritative
 * observations, and including them would falsely flag drift on assets
 * that haven't been re-discovered yet.
 *
 * Fields the projection owns:
 *   hostname, serialNumber, manufacturer, model, os, osVersion,
 *   learnedLocation, ipAddress, latitude, longitude
 *
 * Fields the projection deliberately does NOT own (for now):
 *   - macAddress / macAddresses — DHCP discovery writes these directly to
 *     Asset; no AssetSource carries them yet.
 *   - status / quarantine* — multi-actor (discovery, quarantine code,
 *     decommission job, manual). Out of scope.
 *   - assetType — usually inferred at create and stable thereafter.
 *   - location, department, assignedTo, notes, tags, monitor*, dns* —
 *     operator-owned or system-owned (not from discovery sources).
 *
 * `null` in the returned ProjectedAsset means "no source has an opinion on
 * this field." Drift detection should treat that as no-comment, NOT as a
 * disagreement against an Asset value.
 */

export type AssetSourceKind =
  | "entra"
  | "intune"
  | "ad"
  | "fortigate-firewall"
  | "fortiswitch"
  | "fortiap"
  | "manual";

export interface AssetSourceForProjection {
  sourceKind: AssetSourceKind | string;
  inferred: boolean;
  observed: Record<string, unknown> | null;
}

export interface ProjectedAsset {
  hostname: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  os: string | null;
  osVersion: string | null;
  learnedLocation: string | null;
  ipAddress: string | null;
  latitude: number | null;
  longitude: number | null;
}

export type ProjectionProvenance = Partial<Record<keyof ProjectedAsset, AssetSourceKind | string>>;

export interface ProjectionResult {
  projected: ProjectedAsset;
  provenance: ProjectionProvenance;
}

// Internal: typed accessor for an observed JSON blob. Returns the value as
// unknown so callers narrow per use; treats null/undefined uniformly.
function obsString(o: Record<string, unknown> | null, key: string): string | null {
  if (!o) return null;
  const v = o[key];
  if (typeof v === "string") {
    const t = v.trim();
    return t || null;
  }
  return null;
}

function obsNumber(o: Record<string, unknown> | null, key: string): number | null {
  if (!o) return null;
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Per-field priority: ordered list of (sourceKind, accessor). First accessor
// returning a non-null/non-empty value wins. Each accessor receives the
// matching source's `observed` blob. The shape is wide so the type system
// helps when adding new fields.
type FieldRule = {
  sourceKind: AssetSourceKind;
  pick: (o: Record<string, unknown> | null) => string | number | null;
};

const HOSTNAME_RULES: FieldRule[] = [
  // Intune wins — intune.deviceName is the freshest hands-on signal and
  // already wins in the legacy Entra/Intune merge code (entraIdService
  // merge uses `intune?.deviceName || e.displayName`). The split observed
  // blobs keep the original entra-side displayName separately so this
  // priority works correctly in the new model.
  { sourceKind: "intune", pick: (o) => obsString(o, "deviceName") },
  { sourceKind: "entra",  pick: (o) => obsString(o, "displayName") },
  // AD: dnsHostName preferred (FQDN) with cn fallback (NetBIOS).
  { sourceKind: "ad", pick: (o) => obsString(o, "dnsHostName") || obsString(o, "cn") },
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "hostname") },
  { sourceKind: "fortiswitch", pick: (o) => obsString(o, "switchId") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "name") },
];

const SERIAL_RULES: FieldRule[] = [
  { sourceKind: "intune", pick: (o) => obsString(o, "serialNumber") },
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "serial") },
  { sourceKind: "fortiswitch", pick: (o) => obsString(o, "serial") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "serial") },
];

const MANUFACTURER_RULES: FieldRule[] = [
  // Intune carries the actual hardware vendor (LENOVO, Dell, ...). For
  // Fortinet infrastructure it's always literally "Fortinet" — encoded
  // here as a constant rather than read from observed since the per-source
  // shapes don't include it explicitly.
  { sourceKind: "intune", pick: (o) => obsString(o, "manufacturer") },
  { sourceKind: "fortigate-firewall", pick: () => "Fortinet" },
  { sourceKind: "fortiswitch", pick: () => "Fortinet" },
  { sourceKind: "fortiap", pick: () => "Fortinet" },
];

const MODEL_RULES: FieldRule[] = [
  { sourceKind: "intune", pick: (o) => obsString(o, "model") },
  // FortiSwitch's observed blob always carries `model: "FortiSwitch"` which
  // is too generic to be useful — skip it here and let the asset row keep
  // whatever the legacy create path stamped (also "FortiSwitch"). Firewall
  // and AP do carry a meaningful model string.
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "model") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "model") },
];

const OS_RULES: FieldRule[] = [
  { sourceKind: "intune", pick: (o) => obsString(o, "operatingSystem") },
  { sourceKind: "entra", pick: (o) => obsString(o, "operatingSystem") },
  { sourceKind: "ad", pick: (o) => obsString(o, "operatingSystem") },
];

const OS_VERSION_RULES: FieldRule[] = [
  { sourceKind: "intune", pick: (o) => obsString(o, "osVersion") },
  { sourceKind: "entra", pick: (o) => obsString(o, "operatingSystemVersion") },
  { sourceKind: "ad", pick: (o) => obsString(o, "operatingSystemVersion") },
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "osVersion") },
  { sourceKind: "fortiswitch", pick: (o) => obsString(o, "osVersion") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "osVersion") },
];

const LEARNED_LOCATION_RULES: FieldRule[] = [
  // AD's OU path is the strongest "where does this device live" signal
  // we have for endpoints. Fortinet infrastructure uses the controller
  // FortiGate as its location label (matches legacy behavior). Note: for
  // firewalls themselves, learnedLocation is the firewall's own hostname —
  // that's already on Asset.hostname so the projection doesn't need to
  // duplicate it; we leave learnedLocation = null for firewalls and let
  // the legacy "set when null" rule continue to work.
  { sourceKind: "ad", pick: (o) => obsString(o, "ouPath") },
  { sourceKind: "fortiswitch", pick: (o) => obsString(o, "controllerFortigate") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "controllerFortigate") },
];

const IP_ADDRESS_RULES: FieldRule[] = [
  // Endpoint IPs come from DHCP discovery on the legacy path — no source
  // row carries them today. Only Fortinet infrastructure projects an IP.
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "mgmtIp") },
  { sourceKind: "fortiswitch", pick: (o) => obsString(o, "mgmtIp") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "mgmtIp") },
];

const LATITUDE_RULES: FieldRule[] = [
  { sourceKind: "fortigate-firewall", pick: (o) => obsNumber(o, "latitude") },
];

const LONGITUDE_RULES: FieldRule[] = [
  { sourceKind: "fortigate-firewall", pick: (o) => obsNumber(o, "longitude") },
];

// Walk priority rules in order; return the first non-empty value plus its
// source kind. Inferred sources are excluded — they're phase-1 backfill
// skeletons, not authoritative observations.
function projectField<T extends string | number>(
  sources: AssetSourceForProjection[],
  rules: FieldRule[],
): { value: T | null; source: AssetSourceKind | null } {
  for (const rule of rules) {
    const candidate = sources.find(
      (s) => s.sourceKind === rule.sourceKind && !s.inferred,
    );
    if (!candidate) continue;
    const picked = rule.pick(candidate.observed);
    if (picked !== null && picked !== undefined && picked !== "") {
      return { value: picked as T, source: rule.sourceKind };
    }
  }
  return { value: null, source: null };
}

export function projectAssetFromSources(
  sources: AssetSourceForProjection[],
): ProjectionResult {
  const projected: ProjectedAsset = {
    hostname: null,
    serialNumber: null,
    manufacturer: null,
    model: null,
    os: null,
    osVersion: null,
    learnedLocation: null,
    ipAddress: null,
    latitude: null,
    longitude: null,
  };
  const provenance: ProjectionProvenance = {};

  const apply = <K extends keyof ProjectedAsset>(field: K, rules: FieldRule[]): void => {
    const { value, source } = projectField(sources, rules);
    if (value !== null) {
      // The discriminated rules above guarantee string-only fields get
      // strings and number-only fields get numbers, but the type system
      // can't see through the array unification. The cast is local to
      // this assignment and safe because the rule list for each field
      // only contains pickers of the matching primitive type.
      projected[field] = value as ProjectedAsset[K];
      if (source) provenance[field] = source;
    }
  };

  apply("hostname", HOSTNAME_RULES);
  apply("serialNumber", SERIAL_RULES);
  apply("manufacturer", MANUFACTURER_RULES);
  apply("model", MODEL_RULES);
  apply("os", OS_RULES);
  apply("osVersion", OS_VERSION_RULES);
  apply("learnedLocation", LEARNED_LOCATION_RULES);
  apply("ipAddress", IP_ADDRESS_RULES);
  apply("latitude", LATITUDE_RULES);
  apply("longitude", LONGITUDE_RULES);

  return { projected, provenance };
}
