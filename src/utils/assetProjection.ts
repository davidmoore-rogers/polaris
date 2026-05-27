/**
 * src/utils/assetProjection.ts
 *
 * Pure projection of an asset's discovery-owned fields from its AssetSource
 * rows. Phase 3b.0 (shadow): integration writes still own field values on
 * the Asset row directly; this projection is computed alongside and any
 * disagreement is logged for analysis. Phase 3b.1 will cut Asset writes to
 * use the projection as the source of truth.
 *
 * Priority rules below were tuned against real shadow-drift logs from
 * production discovery cycles. Specifically:
 *   - hostname: AD's `dnsHostName` wins when it's an FQDN (contains a dot)
 *     because operators value the FQDN form for DNS / log searches.
 *     Otherwise priority falls through Intune → Entra → AD short forms.
 *   - os: AD wins when present — its `operatingSystem` carries the Windows
 *     edition ("Windows 10 Pro") that Intune/Entra collapse to "Windows".
 *   - manufacturer: Intune's value is normalized through the manufacturer
 *     alias map before projection so it matches the canonicalized form
 *     that the Prisma extension stamps on Asset.manufacturer (otherwise
 *     "Dell Inc." vs "Dell" produces noise drift on every cycle).
 *   - ipAddress: fortigate-endpoint wins — the FortiGate sees the live
 *     DHCP/ARP binding, so its observed.ipAddress is the freshest
 *     signal. MDM sources don't carry IP at all. Fortinet infrastructure
 *     rules below only apply to firewall/switch/AP-typed assets, which
 *     never carry a fortigate-endpoint source.
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
 * See the "Asset projection priority table" section in CLAUDE.md for
 * the full per-field × per-source-kind priority matrix.
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

import { normalizeManufacturer } from "./manufacturerNormalize.js";
import { isValidGeoCoord } from "./geo.js";

export type AssetSourceKind =
  | "entra"
  | "intune"
  | "ad"
  | "fortigate-firewall"
  | "fortiswitch"
  | "fortiap"
  | "fortigate-endpoint"
  | "polaris-agent"
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
  snmpLocation: string | null;
  learnedAddress: string | null;
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
  // Polaris Agent runs ON the host — it knows the configured hostname
  // (os.Hostname / Win32 GetComputerNameEx / Darwin sysctl) authoritatively.
  // Wins over every inferred source (AD, Entra, Intune) because those infer
  // hostname from elsewhere (DNS, MDM enrollment, computer-object name)
  // and can drift from what the host actually answers to.
  { sourceKind: "polaris-agent", pick: (o) => obsString(o, "hostname") },
  // FQDN from AD wins next — when an AD source has a dnsHostName containing a
  // dot, that's the FQDN form operators search for in DNS / DHCP / logs.
  // Tuned from production shadow-drift logs where ~7k entries per 24h
  // showed Asset.hostname (FQDN) drifting against an Intune/Entra-only
  // projection (short form). Falls through if AD has no dnsHostName, or
  // if its dnsHostName is short-form (rare — usually means cn-derived
  // fallback).
  { sourceKind: "ad", pick: (o) => {
      const v = obsString(o, "dnsHostName");
      return v && v.includes(".") ? v : null;
    }
  },
  // Intune wins next — intune.deviceName is the freshest hands-on signal
  // for non-AD-joined devices (BYO laptops, mobile devices). The split
  // observed blobs keep the original entra/intune-side names separate so
  // these priorities work correctly in the new model.
  { sourceKind: "intune", pick: (o) => obsString(o, "deviceName") },
  { sourceKind: "entra",  pick: (o) => obsString(o, "displayName") },
  // AD non-FQDN fallback — short dnsHostName or cn (NetBIOS).
  { sourceKind: "ad", pick: (o) => obsString(o, "dnsHostName") || obsString(o, "cn") },
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "hostname") },
  { sourceKind: "fortiswitch", pick: (o) => obsString(o, "switchId") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "name") },
  // fortigate-endpoint hostname — the FortiGate's DHCP client identifier.
  // Lowest priority because DHCP client IDs are operator-set and may not
  // match the device's "real" hostname (random strings, owner names,
  // serial numbers). Useful only when no MDM/AD source has an opinion.
  { sourceKind: "fortigate-endpoint", pick: (o) => obsString(o, "hostname") },
];

const SERIAL_RULES: FieldRule[] = [
  // Polaris Agent reads DMI/SMBIOS directly (/sys/class/dmi/id/product_serial
  // on Linux; ioreg IOPlatformSerialNumber on macOS; HKLM\HARDWARE\DESCRIPTION
  // \System\BIOS on Windows). Authoritative — beats MDM serial fields that
  // are populated by inventory-time enrollment and can be empty/cached.
  // On hardened Linux hosts product_serial may be 0400 (root only); the
  // agent's DynamicUser then gets no value and the projection falls through
  // to Intune.
  { sourceKind: "polaris-agent", pick: (o) => obsString(o, "serialNumber") },
  { sourceKind: "intune", pick: (o) => obsString(o, "serialNumber") },
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "serial") },
  { sourceKind: "fortiswitch", pick: (o) => obsString(o, "serial") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "serial") },
];

const MANUFACTURER_RULES: FieldRule[] = [
  // Polaris Agent reads DMI sys_vendor / IOPlatformManufacturer / BIOS
  // registry — the manufacturer string the firmware itself reports. Run
  // through normalizeManufacturer so it matches the canonical Asset value.
  { sourceKind: "polaris-agent", pick: (o) => {
      const raw = obsString(o, "manufacturer");
      return raw ? normalizeManufacturer(raw) : null;
    }
  },
  // Intune carries the actual hardware vendor ("Dell Inc.", "LENOVO", ...)
  // pre-canonicalization. Run through normalizeManufacturer so the
  // projected value matches what the Prisma extension stamps on
  // Asset.manufacturer post-canonicalization (e.g. "Dell Inc." → "Dell").
  // Without this, drift fires on every cycle for the gap between the raw
  // vendor string and the canonical brand name.
  { sourceKind: "intune", pick: (o) => {
      const raw = obsString(o, "manufacturer");
      return raw ? normalizeManufacturer(raw) : null;
    }
  },
  // Fortinet infrastructure: always literally "Fortinet" — already canonical.
  { sourceKind: "fortigate-firewall", pick: () => "Fortinet" },
  { sourceKind: "fortiswitch", pick: () => "Fortinet" },
  { sourceKind: "fortiap", pick: () => "Fortinet" },
  // fortigate-endpoint hardwareVendor — populated from FortiOS device-
  // inventory or OUI lookup at discovery time. Coarser than Intune
  // (vendor only, no model fidelity) but better than nothing for assets
  // that have no MDM source. Same alias-normalization pass as Intune so
  // "Dell Inc." → "Dell" matches the canonical Asset value.
  { sourceKind: "fortigate-endpoint", pick: (o) => {
      const raw = obsString(o, "hardwareVendor");
      return raw ? normalizeManufacturer(raw) : null;
    }
  },
];

const MODEL_RULES: FieldRule[] = [
  // Polaris Agent reads DMI product_name / IOPlatformProduct / BIOS
  // registry. Beats Intune for the same DMI-is-authoritative reason as
  // manufacturer; falls through when DMI is unreadable.
  { sourceKind: "polaris-agent", pick: (o) => obsString(o, "model") },
  { sourceKind: "intune", pick: (o) => obsString(o, "model") },
  // FortiSwitch's observed blob always carries `model: "FortiSwitch"` which
  // is too generic to be useful — skip it here and let the asset row keep
  // whatever the legacy create path stamped (also "FortiSwitch"). Firewall
  // and AP do carry a meaningful model string.
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "model") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "model") },
  // fortigate-endpoint model — DHCP fingerprint or device-inventory model
  // string. Coarse signal but better than nothing for non-MDM assets.
  { sourceKind: "fortigate-endpoint", pick: (o) => obsString(o, "model") },
];

const OS_RULES: FieldRule[] = [
  // Polaris Agent reads os-release on Linux (PRETTY_NAME → "Red Hat
  // Enterprise Linux 8.10"), sw_vers on macOS ("macOS 14.4.1"), or
  // Windows version registry. Beats AD's edition string because the
  // agent reflects what's actually running right now (post-upgrade,
  // post-reimage), whereas AD's operatingSystem only updates when
  // a domain-joined client re-registers — which can lag months on
  // long-running servers.
  { sourceKind: "polaris-agent", pick: (o) => obsString(o, "os") },
  // AD's operatingSystem carries the Windows edition ("Windows 10 Pro",
  // "Windows 11 Enterprise"). Intune/Entra collapse to just "Windows".
  // Edition is operationally meaningful — keep AD when present.
  { sourceKind: "ad", pick: (o) => obsString(o, "operatingSystem") },
  { sourceKind: "intune", pick: (o) => obsString(o, "operatingSystem") },
  { sourceKind: "entra", pick: (o) => obsString(o, "operatingSystem") },
  // fortigate-endpoint os — FortiGate device-inventory's OS detection
  // (rough fingerprint based on DHCP options + traffic). Coarse but
  // useful when no MDM/AD source has the device.
  { sourceKind: "fortigate-endpoint", pick: (o) => obsString(o, "os") },
];

const OS_VERSION_RULES: FieldRule[] = [
  // Polaris Agent reports VERSION_ID from os-release (Linux) or the
  // actual kernel / OS build (macOS sw_vers, Windows registry).
  // Authoritative for "what version is actually running now."
  { sourceKind: "polaris-agent", pick: (o) => obsString(o, "osVersion") },
  { sourceKind: "intune", pick: (o) => obsString(o, "osVersion") },
  { sourceKind: "entra", pick: (o) => obsString(o, "operatingSystemVersion") },
  { sourceKind: "ad", pick: (o) => obsString(o, "operatingSystemVersion") },
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "osVersion") },
  { sourceKind: "fortiswitch", pick: (o) => obsString(o, "osVersion") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "osVersion") },
  { sourceKind: "fortigate-endpoint", pick: (o) => obsString(o, "osVersion") },
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
  // fortigate-endpoint learnedLocation — the FortiGate device name acts
  // as a site label for endpoints with no AD OU (BYO laptops on guest
  // SSIDs, contractor devices, IoT gear). Slots between AD (the
  // operator-organized OU path) and the legacy controllerFortigate
  // labels for switches/APs.
  { sourceKind: "fortigate-endpoint", pick: (o) => obsString(o, "learnedLocation") },
  { sourceKind: "fortiswitch", pick: (o) => obsString(o, "controllerFortigate") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "controllerFortigate") },
];

const IP_ADDRESS_RULES: FieldRule[] = [
  // Endpoint IPs: fortigate-endpoint sees the live DHCP/ARP binding —
  // freshest signal we have. MDM sources don't carry IP. Wins over
  // Fortinet-infrastructure mgmtIp for endpoint-typed assets, and the
  // infrastructure rules below only apply to firewall/switch/AP-typed
  // assets that won't have a fortigate-endpoint source on them.
  { sourceKind: "fortigate-endpoint", pick: (o) => obsString(o, "ipAddress") },
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "mgmtIp") },
  { sourceKind: "fortiswitch", pick: (o) => obsString(o, "mgmtIp") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "mgmtIp") },
];

// Coord resolution priority on the fortigate-firewall source. SNMP sysLocation
// is pulled via the FortiOS REST API (`/api/v2/cmdb/system.snmp/sysinfo`) when
// `fortigateMonitor.pullSnmpLocation` is on, then geocoded via Nominatim. When
// the geocoder returns valid coords, that pair is authoritative — sysLocation
// is configured on the FortiGate itself, the natural place network engineers
// record device location.
//
//   1. SNMP-geocoded sysLocation (highest priority; only populated in the
//      observed blob when the REST pull + geocode both succeeded)
//   2. FMG metavars `Latitude` / `Longitude` (operator-managed fallback when
//      SNMP is off or returns no usable location)
//   3. CMDB `gui-device-latitude` / `gui-device-longitude` (FortiOS GUI
//      values; pre-feature source)
//
// Each picker validates the (lat, lng) pair as a whole via isValidGeoCoord
// so a half-valid tier (e.g. metavar lat set, metavar lng=0) falls through
// to the next tier rather than mixing tiers. The rule order is the SAME
// for latitude and longitude — when one resolves at tier N, the other will
// too because the pair-validity check inside each picker has the same
// outcome.
const LATITUDE_RULES: FieldRule[] = [
  { sourceKind: "fortigate-firewall", pick: (o) => {
    const lat = obsNumber(o, "snmpGeocodedLatitude");
    const lng = obsNumber(o, "snmpGeocodedLongitude");
    return isValidGeoCoord(lat, lng) ? lat : null;
  }},
  { sourceKind: "fortigate-firewall", pick: (o) => {
    const lat = obsNumber(o, "metavarLatitude");
    const lng = obsNumber(o, "metavarLongitude");
    return isValidGeoCoord(lat, lng) ? lat : null;
  }},
  { sourceKind: "fortigate-firewall", pick: (o) => {
    const lat = obsNumber(o, "latitude");
    const lng = obsNumber(o, "longitude");
    return isValidGeoCoord(lat, lng) ? lat : null;
  }},
];

const LONGITUDE_RULES: FieldRule[] = [
  { sourceKind: "fortigate-firewall", pick: (o) => {
    const lat = obsNumber(o, "snmpGeocodedLatitude");
    const lng = obsNumber(o, "snmpGeocodedLongitude");
    return isValidGeoCoord(lat, lng) ? lng : null;
  }},
  { sourceKind: "fortigate-firewall", pick: (o) => {
    const lat = obsNumber(o, "metavarLatitude");
    const lng = obsNumber(o, "metavarLongitude");
    return isValidGeoCoord(lat, lng) ? lng : null;
  }},
  { sourceKind: "fortigate-firewall", pick: (o) => {
    const lat = obsNumber(o, "latitude");
    const lng = obsNumber(o, "longitude");
    return isValidGeoCoord(lat, lng) ? lng : null;
  }},
];

// Raw SNMP sysLocation string. Only fortigate-firewall sources carry it
// (discovery-time SNMP pull is FortiGate-specific). Surfaced on the asset
// details General tab regardless of whether the geocoder produced usable
// coords — operators see what the FortiGate is telling SNMP even when
// the value couldn't be resolved to a lat/lng.
const SNMP_LOCATION_RULES: FieldRule[] = [
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "snmpLocation") },
];

// Auto-discovered street address from the FMG per-device address metavariable
// (operator-named via `fortigateMonitor.addressMetavar`). Only fortigate-firewall
// sources carry it; the value is whatever string the operator stored in that
// metavar. Surfaced as "Address" on the asset details General tab.
const LEARNED_ADDRESS_RULES: FieldRule[] = [
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "metavarAddress") },
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
    snmpLocation: null,
    learnedAddress: null,
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
  apply("snmpLocation", SNMP_LOCATION_RULES);
  apply("learnedAddress", LEARNED_ADDRESS_RULES);

  return { projected, provenance };
}
