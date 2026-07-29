/**
 * src/utils/agentUnit.ts — pure helpers for the Linux Polaris Agent systemd unit.
 *
 * Kept separate from agentInstallService (which drags in prisma / ssh2 / sftp) so
 * the privilege-tier → [Service]-block mapping is unit-testable in isolation.
 *
 * Privilege tiers (full root was retired with service control):
 *   "unprivileged" (default) — hardened DynamicUser unit, no capabilities.
 *   "ptrace"                 — unprivileged + AmbientCapabilities=
 *                              CAP_SYS_PTRACE CAP_DAC_READ_SEARCH, the pair
 *                              required to read other users' /proc/<pid>/fd for
 *                              Application Map connection→PID attribution
 *                              WITHOUT full root. BOTH are needed: the fd
 *                              directory is mode 0500 owner-only, so opening it
 *                              is a plain DAC check that only
 *                              CAP_DAC_READ_SEARCH passes (proc_fd_permission →
 *                              generic_permission; CAP_SYS_PTRACE is never
 *                              consulted there), and readlinking the entries is
 *                              the ptrace_may_access check that needs
 *                              CAP_SYS_PTRACE. Shipping only CAP_SYS_PTRACE
 *                              produced zero connection rows fleet-wide (every
 *                              gopsutil socket→PID join EACCESed at the DAC
 *                              step; prod, 2026-07-29). Security cost — stated
 *                              in every operator warning: CAP_DAC_READ_SEARCH
 *                              bypasses read permission checks on ALL files
 *                              (/etc/shadow, key material), and CAP_SYS_PTRACE
 *                              permits reading any process's memory. Granted
 *                              only with an explicit operator opt-in.
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
 * AmbientCapabilities=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH (bounded by
 * CapabilityBoundingSet) — see the header for why the pair is required. Ambient
 * caps set by systemd are honored even under NoNewPrivileges/DynamicUser. The
 * rest of the unit and the install script are identical between the two.
 *
 * NOTE: the unit text is written only at install/reinstall time — changing this
 * block does nothing for already-installed agents until they're reinstalled.
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
# PTRACE tier — unprivileged + CAP_SYS_PTRACE + CAP_DAC_READ_SEARCH. The pair
# grants read access to other users' /proc/<pid>/fd so the agent can attribute
# network connections to processes for the Application Map, WITHOUT full root
# (DAC_READ_SEARCH opens the 0500 fd directory; SYS_PTRACE readlinks the
# entries — either alone is insufficient). NOTE: CAP_DAC_READ_SEARCH bypasses
# read permission checks on all files, and CAP_SYS_PTRACE permits reading any
# process's memory — granted deliberately per host with an operator warning.
${base}
AmbientCapabilities=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH
CapabilityBoundingSet=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH`;
  }
  return `[Service]
${base}`;
}
