/**
 * src/utils/pollingCompatibility.ts
 *
 * Pure compatibility matrix between asset sources and polling methods.
 * Used by the resolver (silently falls through when a higher-tier value
 * isn't valid for an asset's source), the routes (Zod validation when an
 * operator picks a method on a class override), and the UI (disable the
 * options that don't apply for a given source).
 *
 * Asset source = which integration discovered the asset (or "manual" for
 * orphans). The new polling-method redesign treats Manual as its own
 * asset source, with the most permissive matrix (any method) since the
 * operator chooses the credential when adding the asset.
 *
 *   FortiManager      → REST API, SNMP, SSH, ICMP                (no WinRM — FortiOS doesn't run it; no Agent — appliance)
 *   FortiGate         → REST API, SNMP, SSH, ICMP                (same — FortiOS again)
 *   Active Directory  → ICMP, WinRM, SSH, Agent                  (no REST API — AD-bound hosts have no shared API)
 *   Entra ID / Intune → ICMP, WinRM, SSH, Agent                  (same — cloud-managed Windows / mobile)
 *   Windows Server    → ICMP, WinRM, SSH, Agent                  (DHCP discovery surfaces Windows hosts)
 *   Manual            → any                                       (operator-chosen)
 *
 * The "agent" method represents a Polaris-managed agent installed locally
 * on the target host (Linux/macOS/Windows × amd64/arm64) that pushes samples
 * back to Polaris over HTTPS and holds an outbound WebSocket for on-demand
 * probes. It's incompatible with appliance sources (FortiManager, FortiGate)
 * because Fortinet appliances can't run third-party binaries. See the
 * "Polaris Agent" section in CLAUDE.md.
 *
 * Locked with the user during the design exchange; see CLAUDE.md
 * "Polling-method compatibility matrix".
 */

export type PollingMethod = "rest_api" | "snmp" | "winrm" | "ssh" | "icmp" | "disabled" | "agent";

/** Streams resolved independently by the four-tier monitor settings hierarchy. */
export type Stream =
  | "responseTime"
  | "cpuMemory"
  | "temperature"
  | "interfaces"
  | "lldp"
  | "storage"
  | "processes"
  | "eventLog";
export type AssetSourceKind =
  | "fortimanager"
  | "fortigate"
  | "activedirectory"
  | "entraid"
  | "windowsserver"
  | "manual";

const ALL_METHODS: ReadonlyArray<PollingMethod> = ["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled", "agent"];

// Each entry is the full set of valid methods for that source. A `Set` is
// O(1) lookup which matters for the resolver running in the hot monitor
// loop, even though the cardinality is small. "disabled" is universally
// allowed — it means "do not poll this stream" and applies to any source.
// "agent" is allowed wherever Polaris can install software (everything
// except the Fortinet appliance sources).
const COMPATIBILITY: Readonly<Record<AssetSourceKind, ReadonlySet<PollingMethod>>> = {
  fortimanager:    new Set<PollingMethod>(["rest_api", "snmp", "ssh", "icmp", "disabled"]),
  fortigate:       new Set<PollingMethod>(["rest_api", "snmp", "ssh", "icmp", "disabled"]),
  activedirectory: new Set<PollingMethod>(["icmp", "winrm", "ssh", "disabled", "agent"]),
  entraid:         new Set<PollingMethod>(["icmp", "winrm", "ssh", "disabled", "agent"]),
  windowsserver:   new Set<PollingMethod>(["icmp", "winrm", "ssh", "disabled", "agent"]),
  manual:          new Set<PollingMethod>(ALL_METHODS),
};

/**
 * Convert an Integration.type string into the AssetSourceKind we use here.
 * Unknown integration types map to "manual" (no source-specific tokens to
 * lean on, so the most permissive matrix applies).
 */
export function assetSourceKindFromIntegrationType(integrationType: string | null | undefined): AssetSourceKind {
  if (!integrationType) return "manual";
  switch (integrationType) {
    case "fortimanager":    return "fortimanager";
    case "fortigate":       return "fortigate";
    case "activedirectory": return "activedirectory";
    case "entraid":         return "entraid";
    case "windowsserver":   return "windowsserver";
    default:                return "manual";
  }
}

// Per-stream method restrictions for streams that genuinely cannot use every
// method their source otherwise allows. Streams NOT listed here impose no
// per-stream restriction (only the source matrix above + the responseTime-only
// ICMP rule in the routes apply), preserving pre-existing behavior for the six
// original streams. The two cross-transport streams:
//   processes — agent/SNMP (hrSWRunTable)/SSH (ps,tasklist)/WinRM (Get-Process).
//               No REST (no host-process FortiOS endpoint) and no ICMP.
//   eventLog  — agent/SSH (journalctl,Get-WinEvent)/WinRM (Get-WinEvent)/REST
//               (FortiOS device log API). No SNMP (no MIB) and no ICMP.
// "disabled" is always allowed (means "don't poll this stream").
const STREAM_METHODS: Partial<Record<Stream, ReadonlySet<PollingMethod>>> = {
  processes: new Set<PollingMethod>(["agent", "snmp", "ssh", "winrm", "disabled"]),
  eventLog:  new Set<PollingMethod>(["agent", "ssh", "winrm", "rest_api", "disabled"]),
};

/** True when `method` is a valid polling method for the given asset source. */
export function isPollingMethodCompatible(source: AssetSourceKind, method: PollingMethod): boolean {
  return COMPATIBILITY[source].has(method);
}

/**
 * True when `method` is valid for `stream`. Streams without an explicit
 * restriction allow any method (the source matrix + route-level ICMP rule
 * still apply). Used by the resolver, the monitorSettings routes, and the UI
 * to gate the cross-transport streams (processes / eventLog).
 */
export function isMethodValidForStream(stream: Stream, method: PollingMethod): boolean {
  const allowed = STREAM_METHODS[stream];
  return allowed ? allowed.has(method) : true;
}

/** Methods valid for `stream`, in display order. Empty restriction → all methods. */
export function methodsForStream(stream: Stream): ReadonlyArray<PollingMethod> {
  const allowed = STREAM_METHODS[stream];
  return allowed ? ALL_METHODS.filter((m) => allowed.has(m)) : ALL_METHODS;
}

/** Returns the methods valid for `source`, in display order (matches ALL_METHODS). */
export function compatibleMethodsFor(source: AssetSourceKind): ReadonlyArray<PollingMethod> {
  const allowed = COMPATIBILITY[source];
  return ALL_METHODS.filter((m) => allowed.has(m));
}

/** All polling-method values, in display order. Useful for UI dropdowns. */
export function allPollingMethods(): ReadonlyArray<PollingMethod> {
  return ALL_METHODS;
}

/** Type guard — narrows arbitrary input to PollingMethod when valid. */
export function isPollingMethod(v: unknown): v is PollingMethod {
  return typeof v === "string" && (ALL_METHODS as ReadonlyArray<string>).includes(v);
}

/** Operator-friendly label for a polling method. */
export function pollingMethodLabel(method: PollingMethod): string {
  switch (method) {
    case "rest_api": return "REST API";
    case "snmp":     return "SNMP";
    case "winrm":    return "WinRM";
    case "ssh":      return "SSH";
    case "icmp":     return "ICMP";
    case "disabled": return "Disabled";
    case "agent":    return "Polaris Agent";
  }
}
