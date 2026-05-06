# FortiManager Integration — Discovery Decision Tree

This is the operator-facing reference for what the FMG discovery run does and which knobs control which behavior. The detailed phase-by-phase narrative lives in `CLAUDE.md` under "FMG Discovery Workflow"; this doc is the at-a-glance decision tree.

```
FMG Integration Discovery
│
├─ Should this run at all?
│   ├─ enabled === true                       (else: skip silently)
│   └─ either: manual trigger (admin clicks Discover Now)
│       or:    autoDiscover === true  AND  now − lastDiscoveryAt >= pollInterval hours
│
├─ Transport mode  (per-device LIVE-MONITOR queries; CMDB always goes native-FMG)
│   ├─ useProxy === true (DEFAULT)
│   │     → /sys/proxy/json wraps each /api/v2/monitor/* call
│   │     → discoveryParallelism FORCED to 1 (FMG drops parallel proxy sessions)
│   │     → uses FMG's apiToken
│   │
│   └─ useProxy === false   ("bypass" / direct)
│         → /api/v2/monitor/* hits each FortiGate's mgmt IP directly
│         → discoveryParallelism up to 20
│         → uses fortigateApiUser + fortigateApiToken (per-FortiGate REST admin)
│         → mgmt IP resolved via FMG CMDB on `mgmtInterface` (defaults to "mgmt" if blank)
│         → REQUIRED: fortigateApiToken non-empty AND mgmt IP resolvable via FMG
│         → If a precondition fails for a given device, that device is SKIPPED
│           with an error log line and NO proxy fallback — its DHCP scopes /
│           switches / APs / endpoints don't sync this run. Operators see the
│           skip message in the discovery log feed and on the Events page.
│
├─ Roster: which FortiGates does this run touch?
│   ├─ Native FMG GET /dvmdb/adom/<adom>/device  →  knownDeviceNames[]
│   │     (no /sys/proxy/json — bypasses FMG concurrency throttle)
│   │     (no conn_status filter — offline FGs stay in the roster)
│   │
│   └─ Filter through deviceInclude / deviceExclude (wildcards: *, ?)
│         deviceInclude empty → all included
│         deviceInclude set   → ONLY matching FGs queried
│         deviceExclude       → matching FGs skipped
│         filtered-out FGs:   stay in knownDeviceNames (so their subnets aren't
│                             marked stale by Phase 2)
│
├─ Per-FortiGate work (parallel up to discoveryParallelism)
│   │
│   ├─ CMDB queries — ALWAYS native FMG, never proxied
│   │     - system/global             (geo coords, hostname)
│   │     - vdom/root/system/dhcp/server  (configured DHCP scopes)
│   │     - global/switch-controller/managed-switch  (CMDB switch roster)
│   │     - vdom/root/wireless-controller/wtp        (CMDB AP roster)
│   │     - global/system/interface  (interface CMDB; mgmt-IP resolution)
│   │
│   └─ Live monitor — proxy OR direct per "Transport mode" above
│         - system/dhcp                              (active leases)
│         - network/arp                              (IP↔MAC bindings)
│         - switch-controller/managed-switch/status  (live switch status)
│         - wifi/managed_ap                          (live AP status + LLDP[] + mesh)
│         - switch-controller/detected-device        (endpoint MAC table)
│         - firewall/vip                             (VIPs)
│
├─ DHCP scope sync per FortiGate
│   ├─ dhcpInclude / dhcpExclude filter  (scope name or numeric ID)
│   │
│   ├─ For each surviving scope (CMDB ∪ live, CMDB wins on overlap by IP):
│   │     ├─ matched existing Subnet by CIDR?
│   │     │     yes: update name / vlan / fortigateDevice
│   │     │     no:  must fall inside a parent IpBlock
│   │     │           else: log "no matching parent block", skip
│   │     │
│   │     └─ reservations / leases / interface IPs / VIPs imported as Reservation rows
│   │           sourceType ∈ { dhcp_reservation, dhcp_lease, interface_ip, vip }
│   │
│   └─ Conflict detection
│         incoming value differs from existing manual Reservation
│           → upsert Conflict(entityType=reservation, status=pending)
│           → admin reviews on Events page slide-over
│
├─ Stale-subnet deprecation sweep (after Phase 2)
│     Subnet.discoveredBy == this integration  AND  fortigateDevice ∉ knownDeviceNames
│       → status = "deprecated"
│     (offline FGs in roster: PRESERVED. Only FGs REMOVED from FMG trigger deprecate.)
│
├─ FortiGate firewall asset (Phase 3)
│   ├─ Match by serial (assetIdx.findBySerial)
│   │     fall back: hostname / IP
│   │
│   ├─ Existing → UPDATE projected fields + stamp discoveredByIntegrationId
│   │
│   └─ New → CREATE with discoveredByIntegrationId
│         IF fortigateMonitor.addAsMonitored === true
│           → monitored=true (FRESH creates only; existing FGs untouched)
│
├─ FortiSwitch class (Phase 3b — buildClassMonitorStamp(fortiswitchMonitor))
│   │
│   │   ┌─────────────────┬──────────────────┬──────────────────────────────────────┐
│   │   │ enabled         │ addAsMonitored   │ Stamp on NEW switch                  │
│   │   ├─────────────────┼──────────────────┼──────────────────────────────────────┤
│   │   │ false           │ false            │ no-op                                │
│   │   │ false           │ true             │ monitored=true (ICMP source default) │
│   │   │ true (with cred)│ false            │ monitorCredentialId stamped          │
│   │   │ true (with cred)│ true             │ credential AND monitored=true        │
│   │   └─────────────────┴──────────────────┴──────────────────────────────────────┘
│   │
│   ├─ EXISTING switch — operator-override preservation:
│   │     monitoredOperatorSet === true                  → don't touch `monitored`
│   │     existing monitorCredentialId is null
│   │       OR matches cfg.snmpCredentialId              → safe to re-stamp
│   │     existing monitorCredentialId differs           → preserve operator choice
│   │
│   ├─ fortinetTopology stamp:
│   │     { role: "fortiswitch", controllerFortigate, uplinkInterface, state, joinTime }
│   │
│   └─ Decommission sweep:
│         controllerFortigate ∈ inventoriedDevices
│         AND serial ∉ live managed-switch/status table
│         AND serial ∉ CMDB roster
│           → status = "decommissioned"
│         (controllers whose inventory query FAILED: switches under them are LEFT alone)
│
├─ FortiAP class (Phase 3b — same pattern via fortiapMonitor)
│   │   identical 4-row stamp table as FortiSwitch
│   │
│   ├─ Switch-port attribution chain:
│   │     1. LLDP from managed_ap.lldp[] (filter system_description starts "FortiSwitch-")
│   │        → parentSwitch = system_name, parentPort = port_id
│   │     2. Fall back: detected-device MAC table match against AP base_mac
│   │     3. Neither: AP renders hanging directly off the FortiGate in the topology graph
│   │
│   ├─ Mesh stamp:
│   │     mesh_uplink + parent_wtp_id from managed_ap → fortinetTopology.parentApSerial
│   │
│   └─ Decommission via wireless-controller/wtp CMDB roster (same logic)
│
├─ Endpoint enrichment (Phase 7.5)
│   For each MAC seen in switch-controller/detected-device:
│     ├─ skip is_fortilink_peer rows (FortiSwitch peers, not endpoints)
│     ├─ skip infrastructure assetTypes (firewall / switch / access_point)
│     │
│     ├─ Stamp Asset.lastSeenSwitch = "<switchId>/<portName>"
│     │
│     ├─ If asset has no IP, fill from ARP table on same FortiGate
│     │     (conservative: never overwrite an existing IP — IP recycling churn)
│     │
│     └─ Upsert AssetSource(sourceKind="fortigate-endpoint", externalId=MAC)
│
├─ Auto-Monitor Interfaces apply pass (Phase 2c)
│   For each per-class block whose autoMonitorInterfaces ≠ null:
│     ├─ mode = "names"     → explicit ifName list
│     ├─ mode = "wildcard"  → shell patterns (*, ?), optional onlyUp
│     └─ mode = "type"      → physical / aggregate / vlan / loopback / tunnel
│   Union resolved set into Asset.monitoredInterfaces (STRICTLY ADDITIVE)
│
├─ DHCP push (writeback — pushReservations toggle)
│   manual Polaris-created reservation
│   AND on a subnet discovered by this integration
│   AND pushReservations === true
│   AND macAddress is set
│     →  proxy mode: write reserved-address via /sys/proxy/json
│        direct mode: write via per-FortiGate REST API
│        verify on read-back; FAIL the create if device write didn't land
│
├─ Quarantine push (writeback — pushQuarantine toggle)
│   asset.quarantine action
│   AND pushQuarantine === true on integration
│   AND a sighting exists for this asset on a FortiGate this integration owns
│     → push MAC to user.quarantine.targets/<name>/macs on each FortiGate
│        record per-target status in Asset.quarantineTargets
│
└─ Projection apply (Phase 11)
    Re-project every touched asset across all its AssetSource rows:
      hostname  → AD FQDN > Intune > Entra > AD short > FortiGate
      osVersion → Intune > Entra > AD > FortiOS …
    Write back fields where projection ≠ inline-stamped value
    (fixes the "FortiOS clobbers Intune's verbose osVersion" class of bug)
```

## The four big "what does the operator control?" knobs

| Knob | Default | Effect |
|---|---|---|
| `useProxy` | `true` | Proxy = parallelism 1, FMG token. Direct = parallelism 20, per-FG token. Direct misconfigured per-device = that device skipped with error (no fallback). |
| `fortigateMonitor.addAsMonitored` | `false` | New FGs land monitored. Existing FGs unaffected. |
| `forti{switch,ap}Monitor.{enabled, addAsMonitored, snmpCredentialId}` | all `false` / `null` | 4-way grid above; operator-override preservation on existing rows. |
| `pushReservations` / `pushQuarantine` | both `false` | Writeback toggles; off by default. |

## Direct mode vs the probe path — same strict behavior

The discovery path (this doc) and the response-time probe controller-redirect path (`fetchFortinetControllerInventory` in `src/services/monitoringService.ts`) both run with `useProxy=false` strict semantics — a precondition failure (missing token, missing mgmtInterface, mgmt-IP not resolvable) **fails loudly per-device** with a clear error rather than silently falling back to FMG proxy. This matters at scale: a silent fallback to proxy turns "I disabled proxy" into "I disabled proxy except when something else is wrong, in which case it silently re-enables itself and overruns FMG's session limit."

## Companion docs

- **`CLAUDE.md` → "FMG Discovery Workflow"** — phase-by-phase narrative, the underlying data shapes (DHCP scopes / reservation sourceTypes / `fortinetTopology` blob shape), and the multi-source asset model that backs the projection step.
- **`CLAUDE.md` → "Polling-method redesign"** — how the resolved per-stream polling method (`responseTimePolling` / `telemetryPolling` / `interfacesPolling` / `lldpPolling`) flows from per-asset → class override → integration tier → source default for monitoring (post-discovery).
