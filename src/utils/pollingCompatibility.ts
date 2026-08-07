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
 *   Azure Arc         → ICMP, WinRM, SSH, Agent                  (Arc-enabled servers are ordinary Windows/Linux
 *                                                                 hosts — the Connected Machine agent is a cloud
 *                                                                 control-plane link, not a Polaris transport)
 *   vCenter           → ICMP, SNMP, WinRM, SSH, Agent, vCenter   (VMs are guest OSes → the directory-set methods
 *                                                                 apply; ESXi hosts answer SNMP/SSH; "vcenter" is
 *                                                                 the hypervisor-view cpuMemory stream — see below)
 *   Manual            → any                                       (operator-chosen)
 *
 * The "agent" method represents a Polaris-managed agent installed locally
 * on the target host (Linux/macOS/Windows × amd64/arm64) that pushes samples
 * back to Polaris over HTTPS and holds an outbound WebSocket for on-demand
 * probes. It's incompatible with appliance sources (FortiManager, FortiGate)
 * because Fortinet appliances can't run third-party binaries. See the
 * "Polaris Agent" section in CLAUDE.md.
 *
 * The "vcenter" method is cpuMemory-only (enforced in isMethodValidForStream):
 * per-minute CPU/RAM figures come from the vCenter server's batched
 * quickStats fetch (one SOAP call per integration per tick, warm-cached in
 * monitoringService) rather than from the asset itself. It applies to any
 * asset carrying a vcenter-vm AssetSource — INCLUDING assets discovered by
 * AD/Entra/Windows Server that a vCenter sync later merged into (their
 * discoveredByIntegration still points at the directory integration). The
 * matrix therefore allows "vcenter" on those source kinds too; the hard
 * requirement — a vcenter-vm AssetSource row to resolve the integration
 * through — is enforced where it's cheap: the per-asset PUT validation in
 * assets.ts (one lookup) and the collector itself (soft error when the VM
 * isn't in the quickStats cache). Threading a per-asset "has vcenter
 * source" flag through the hot-loop resolver was rejected — it would cost
 * an AssetSource lookup per asset per tick.
 *
 * Locked with the user during the design exchange; see CLAUDE.md
 * "Polling-method compatibility matrix".
 */

export type PollingMethod = "rest_api" | "snmp" | "winrm" | "ssh" | "icmp" | "disabled" | "agent" | "vcenter";

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
  | "vcenter"
  | "azurearc"
  | "manual";

const ALL_METHODS: ReadonlyArray<PollingMethod> = ["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled", "agent", "vcenter"];

// Each entry is the full set of valid methods for that source. A `Set` is
// O(1) lookup which matters for the resolver running in the hot monitor
// loop, even though the cardinality is small. "disabled" is universally
// allowed — it means "do not poll this stream" and applies to any source.
// "agent" is allowed wherever Polaris can install software (everything
// except the Fortinet appliance sources).
const COMPATIBILITY: Readonly<Record<AssetSourceKind, ReadonlySet<PollingMethod>>> = {
  fortimanager:    new Set<PollingMethod>(["rest_api", "snmp", "ssh", "icmp", "disabled"]),
  fortigate:       new Set<PollingMethod>(["rest_api", "snmp", "ssh", "icmp", "disabled"]),
  // "vcenter" on the directory sources covers VMs those integrations
  // discovered FIRST that a vCenter sync merged into — see header note.
  activedirectory: new Set<PollingMethod>(["icmp", "winrm", "ssh", "disabled", "agent", "vcenter"]),
  entraid:         new Set<PollingMethod>(["icmp", "winrm", "ssh", "disabled", "agent", "vcenter"]),
  windowsserver:   new Set<PollingMethod>(["icmp", "winrm", "ssh", "disabled", "agent", "vcenter"]),
  // Arc-enabled machines are ordinary Windows/Linux hosts, so they take the
  // same set as the directory sources. "vcenter" is included for the same
  // reason it is there — an Arc machine can also be a vCenter-merged VM, and
  // in fact the Arc↔vCenter vmUuid cross-link makes that MORE likely, not
  // less. No rest_api (no shared host API) and no snmp.
  azurearc:        new Set<PollingMethod>(["icmp", "winrm", "ssh", "disabled", "agent", "vcenter"]),
  // Union across the two vCenter classes: VMs are guest OSes (icmp / winrm /
  // ssh / agent like the directory sources), ESXi hosts answer snmp/ssh, and
  // "vcenter" delivers the hypervisor-view cpuMemory stream for VMs.
  vcenter:         new Set<PollingMethod>(["icmp", "snmp", "winrm", "ssh", "disabled", "agent", "vcenter"]),
  manual:          new Set<PollingMethod>(ALL_METHODS),
};

/**
 * Convert an Integration.type string into the AssetSourceKind we use here.
 * Unknown integration types map to "manual" (no source-specific tokens to
 * lean on, so the most permissive matrix applies).
 */
/**
 * True when the integration type is one of the two Fortinet transports
 * (FortiManager / standalone FortiGate). The pair share every FortiOS
 * pathway (discovery, DHCP push, quarantine, description sync, monitoring
 * credentials) — this predicate replaces the `=== "fortimanager" ||
 * === "fortigate"` literal pair that was retyped ~20 times.
 */
export function isFortinetIntegrationType(t: string | null | undefined): boolean {
  return t === "fortimanager" || t === "fortigate";
}

export function assetSourceKindFromIntegrationType(integrationType: string | null | undefined): AssetSourceKind {
  if (!integrationType) return "manual";
  switch (integrationType) {
    case "fortimanager":    return "fortimanager";
    case "fortigate":       return "fortigate";
    case "activedirectory": return "activedirectory";
    case "entraid":         return "entraid";
    case "windowsserver":   return "windowsserver";
    case "vcenter":         return "vcenter";
    case "azurearc":        return "azurearc";
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
 *
 * The "vcenter" method is valid ONLY for cpuMemory — it reads the vCenter
 * server's batched VM quickStats, which carry no response-time, interface,
 * storage, process, or log data. (Expressed as a method-level guard rather
 * than a cpuMemory STREAM_METHODS entry so the unrestricted streams keep
 * allowing every other method.)
 */
export function isMethodValidForStream(stream: Stream, method: PollingMethod): boolean {
  if (method === "vcenter") return stream === "cpuMemory";
  const allowed = STREAM_METHODS[stream];
  return allowed ? allowed.has(method) : true;
}

/** Methods valid for `stream`, in display order. Empty restriction → all methods. */
export function methodsForStream(stream: Stream): ReadonlyArray<PollingMethod> {
  return ALL_METHODS.filter((m) => isMethodValidForStream(stream, m));
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
    case "vcenter":  return "vCenter";
  }
}
