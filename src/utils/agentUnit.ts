/**
 * src/utils/agentUnit.ts — pure helpers for the Linux Polaris Agent systemd unit.
 *
 * Kept separate from agentInstallService (which drags in prisma / ssh2 / sftp) so
 * the privilege-tier → [Service]-block mapping is unit-testable in isolation.
 *
 * Privilege tiers (full root was retired with service control):
 *   "unprivileged" (default) — hardened DynamicUser unit, no capabilities.
 *   "ptrace"                 — unprivileged + AmbientCapabilities=CAP_SYS_PTRACE,
 *                              which lets the agent read other users'
 *                              /proc/<pid>/fd for Application Map connection→PID
 *                              attribution WITHOUT full root. CAP_SYS_PTRACE also
 *                              permits reading any process's memory
 *                              (credential-theft class) — granted with an
 *                              explicit operator warning.
 * A legacy "root" value may still be stored on old ManagedAgent rows, but new
 * installs and reinstalls only ever produce these two units.
 */

export type AgentPrivilegeTier = "unprivileged" | "ptrace";

/** Coerce any stored/incoming value to a tier we can emit a unit for. Legacy
 *  "root" (and anything unknown) collapses to "unprivileged" — reinstalling a
 *  legacy-root agent downgrades it unless the operator explicitly picks ptrace. */
export function normalizePrivilegeTier(v: unknown): AgentPrivilegeTier {
  return v === "ptrace" ? "ptrace" : "unprivileged";
}

/**
 * The systemd [Service] block, keyed by privilege tier. Both variants run as the
 * hardened unprivileged DynamicUser with ProtectSystem=strict / ProtectHome /
 * PrivateTmp / NoNewPrivileges. The "ptrace" variant additionally grants
 * AmbientCapabilities=CAP_SYS_PTRACE (bounded by CapabilityBoundingSet). Ambient
 * caps set by systemd are honored even under NoNewPrivileges/DynamicUser. The
 * rest of the unit and the install script are identical between the two.
 */
export function linuxServiceBlock(tier: AgentPrivilegeTier): string {
  const base = `ExecStart=/usr/local/bin/polaris-agent -conf /var/lib/polaris-agent/agent.conf
Restart=on-failure
RestartSec=5
# Dedicated unprivileged user for the agent. Agent only reads its config +
# writes outbound network traffic; no privileged operations at runtime.
User=polaris-agent
DynamicUser=yes
# StateDirectory exposes /var/lib/polaris-agent as the unit's writable
# state directory; systemd chowns it to the DynamicUser at start so the
# agent can atomically rewrite agent.conf after /enroll lands (the
# bearer must be persisted across restarts or the agent loops on the
# already-consumed enrollment token).
StateDirectory=polaris-agent
StateDirectoryMode=0700
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true`;
  if (tier === "ptrace") {
    return `[Service]
# PTRACE tier — unprivileged + CAP_SYS_PTRACE. Grants read access to other
# users' /proc/<pid>/fd so the agent can attribute network connections to
# processes for the Application Map, WITHOUT full root. NOTE: CAP_SYS_PTRACE
# also permits reading any process's memory (credential-theft class) — granted
# deliberately per host with an operator warning.
${base}
AmbientCapabilities=CAP_SYS_PTRACE
CapabilityBoundingSet=CAP_SYS_PTRACE`;
  }
  return `[Service]
${base}`;
}
