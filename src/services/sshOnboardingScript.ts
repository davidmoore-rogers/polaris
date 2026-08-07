/**
 * src/services/sshOnboardingScript.ts — generator for the Windows SSH
 * onboarding scripts an operator pushes to their fleet before Polaris can
 * install the Polaris Agent over SSH.
 *
 * Pure string building, no I/O — the whole module is unit-testable.
 *
 * TWO scripts come out of here and they must agree:
 *
 *   • buildWindowsOnboardingScript()          — the REMEDIATION script.
 *     Installs the OpenSSH Server capability, starts sshd, optionally creates
 *     the local admin account, writes the Polaris public key into
 *     administrators_authorized_keys with the ACL sshd demands, and optionally
 *     scopes inbound TCP/22 to the Polaris server.
 *
 *   • buildWindowsOnboardingDetectionScript() — the DETECTION script.
 *     Exits 0 when the endpoint is already onboarded, 1 when remediation is
 *     needed. Pairing the two under an Intune Remediation (or an SCCM
 *     Configuration Baseline) is what makes fleet rollout self-healing: a plain
 *     platform script runs ONCE per device and never retries, so a machine that
 *     was offline at assignment time, or was later reimaged, silently stays
 *     unconfigured.
 *
 * The "is the Polaris key already installed" predicate is emitted into BOTH
 * scripts from one place (POLARIS_KEY_PRESENT_FN) so detection can never drift
 * from what remediation writes.
 *
 * DELIVERY-NEUTRAL BY DESIGN. Nothing in the emitted PowerShell is
 * Intune-specific and nothing is machine-specific — the public key, username,
 * account mode and server IP are all fleet constants, and
 * administrators_authorized_keys is a single group-wide file authorizing any
 * local Administrator who presents the key. The identical body runs unchanged
 * under Intune, a GPO startup script, an SCCM baseline, Azure Arc, an RMM job,
 * or a one-off Invoke-Command loop. Only the vehicle differs.
 *
 * TWO THINGS FAIL SILENTLY IF YOU GET THEM WRONG, which is the entire reason
 * this generator exists instead of a doc page telling operators to do it:
 *   1. Windows OpenSSH IGNORES %USERPROFILE%\.ssh\authorized_keys for members
 *      of the Administrators group (sshd_config's AdministratorsAuthorizedKeys
 *      File directive). The key MUST live in
 *      %ProgramData%\ssh\administrators_authorized_keys.
 *   2. sshd REFUSES that file unless it is owned by Administrators/SYSTEM with
 *      inheritance disabled and no other ACEs.
 * Neither produces a useful error on the client — auth just fails.
 */

import { AppError } from "../utils/errors.js";
import { isValidIpv4, isValidCidr } from "../utils/cidr.js";

export type SshOnboardingAccountMode = "existing" | "create";

export interface WindowsOnboardingScriptOptions {
  /** The `authorized_keys` one-liner: "ssh-ed25519 AAAA... comment". */
  publicKey: string;
  /** Account Polaris authenticates as. `DOMAIN\user` allowed when mode=existing. */
  username: string;
  /** "create" emits local-account provisioning; "existing" assumes it's there. */
  accountMode: SshOnboardingAccountMode;
  /** When set, inbound TCP/22 is scoped to this IPv4 address or CIDR. */
  polarisServerIp?: string;
}

/** Firewall rule DisplayName — also the key for idempotent replacement. */
const FIREWALL_RULE_NAME = "Polaris SSH (TCP 22)";

/**
 * Well-known SIDs rather than names. "Administrators" and "SYSTEM" are
 * LOCALIZED — on a German or French Windows install the literal strings don't
 * resolve and both the group-membership check and the ACL write fail.
 */
const SID_ADMINISTRATORS = "S-1-5-32-544";
const SID_SYSTEM = "S-1-5-18";

// ─── Input validation ─────────────────────────────────────────────────────
//
// These values are interpolated into a PowerShell script that an admin then
// runs FLEET-WIDE as SYSTEM. Anything that reaches the template is effectively
// remote code execution on every Windows endpoint in the estate, so validate
// strictly and reject rather than escape-and-hope.

/** Local or domain account name. Deliberately narrow. */
const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** DOMAIN\user — each half held to the same charset. */
const DOMAIN_USERNAME_RE = /^[A-Za-z0-9._-]{1,64}\\[A-Za-z0-9._-]{1,64}$/;

/**
 * An authorized_keys line: algorithm, base64 blob, optional comment. The
 * comment is the only free-form part, so it is held to a conservative charset
 * (no quotes, no newlines) instead of being escaped.
 */
const PUBLIC_KEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9._@ -]{0,128})?$/;

export function assertValidPublicKey(publicKey: string): string {
  const k = String(publicKey ?? "").trim();
  if (!k) throw new AppError(400, "No SSH public key has been generated yet");
  if (!PUBLIC_KEY_RE.test(k)) {
    throw new AppError(400, "SSH public key is not a well-formed authorized_keys line");
  }
  return k;
}

export function assertValidUsername(username: string, accountMode: SshOnboardingAccountMode): string {
  const u = String(username ?? "").trim();
  if (!u) throw new AppError(400, "A Windows username is required");
  const isDomain = u.includes("\\");
  if (isDomain && accountMode === "create") {
    // New-LocalUser cannot create a domain account, and silently emitting a
    // script that would fail on every endpoint is worse than refusing here.
    throw new AppError(
      400,
      'A domain account (DOMAIN\\user) cannot be created locally — use the "existing account" mode for it',
    );
  }
  if (!(isDomain ? DOMAIN_USERNAME_RE : USERNAME_RE).test(u)) {
    throw new AppError(
      400,
      "Windows username may only contain letters, digits, dot, dash and underscore (optionally DOMAIN\\user)",
    );
  }
  return u;
}

export function assertValidServerIp(ip: string | undefined | null): string {
  const v = String(ip ?? "").trim();
  if (!v) return "";
  // -RemoteAddress accepts a bare address or a CIDR range; allow both.
  if (!isValidIpv4(v) && !isValidCidr(v)) {
    throw new AppError(400, "Polaris server address must be an IPv4 address or CIDR range");
  }
  return v;
}

/**
 * Wrap a validated value as a PowerShell single-quoted literal. Single quotes
 * are literal in PowerShell (no expansion), and the only escape needed is
 * doubling an embedded quote. Validation above already excludes quotes; this
 * is belt-and-braces so a future regex loosening can't become an injection.
 */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ─── Shared PowerShell fragments ──────────────────────────────────────────

/**
 * The single source of truth for "is the Polaris key already in this file".
 *
 * Matches on the key BODY — algorithm + base64 — and deliberately ignores the
 * trailing comment, so re-running after a comment change doesn't append a
 * duplicate line. Emitted into both the remediation and detection scripts.
 */
const POLARIS_KEY_PRESENT_FN = `
function Test-PolarisKeyPresent {
  param([string[]] $Lines, [string] $Key)
  $wantParts = @($Key.Trim() -split '\\s+')
  if ($wantParts.Count -lt 2) { return $false }
  $want = $wantParts[0] + ' ' + $wantParts[1]
  foreach ($line in $Lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = @($line.Trim() -split '\\s+')
    if ($parts.Count -ge 2 -and (($parts[0] + ' ' + $parts[1]) -eq $want)) { return $true }
  }
  return $false
}

function Get-PolarisAuthorizedKeysPath {
  return (Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys')
}

function Get-PolarisSshCapability {
  return (Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1)
}
`.trim();

// ─── Remediation script ───────────────────────────────────────────────────

const WINDOWS_ONBOARDING_PS = `
# ---------------------------------------------------------------------------
# Polaris — Windows SSH onboarding (REMEDIATION)
#
# Prepares this machine so Polaris can install the Polaris Agent over SSH:
#   1. installs + starts the OpenSSH Server capability
#   2. __ACCOUNT_SUMMARY__
#   3. authorizes the Polaris public key for administrator logons
#   4. __FIREWALL_SUMMARY__
#
# Generated by Polaris. Contains no machine-specific values, so the same file
# runs unchanged on every endpoint in the fleet.
#
# HOW TO RUN IT
#   Intune  : Remediations (pair with the detection script so drift self-heals)
#             or Devices > Scripts. Run as SYSTEM, 64-bit PowerShell host = Yes.
#   GPO     : Computer Config > Policies > Windows Settings > Scripts > Startup.
#   SCCM    : Configuration Baseline, paired with the detection script.
#   Arc/RMM : any run-as-SYSTEM script job.
#   Ad hoc  : Invoke-Command -ComputerName ... -FilePath <this file>
#
# Idempotent: safe to run on every boot / every remediation cycle.
# Requires Windows 10 1809 / Server 2019 or later (older builds have no
# OpenSSH Server capability); on those it reports and exits 0 rather than
# failing forever.
#
# REVIEW BEFORE DEPLOYING. This grants fleet-wide administrative SSH access.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

$PolarisPublicKey = __PUBLIC_KEY__
$PolarisUser      = __USERNAME__

__KEY_PRESENT_FN__

# --- 1. OpenSSH Server capability --------------------------------------------
$cap = Get-PolarisSshCapability
if (-not $cap) {
  Write-Host 'unsupported: this Windows build has no OpenSSH Server capability (needs Windows 10 1809 / Server 2019 or later)'
  exit 0
}
if ($cap.State -ne 'Installed') {
  Write-Host ('Installing ' + $cap.Name)
  Add-WindowsCapability -Online -Name $cap.Name | Out-Null
} else {
  Write-Host 'OpenSSH Server already installed'
}

Set-Service -Name sshd -StartupType Automatic
if ((Get-Service -Name sshd).Status -ne 'Running') {
  Start-Service -Name sshd
  Write-Host 'Started sshd'
} else {
  Write-Host 'sshd already running'
}

__ACCOUNT_BLOCK__

# --- 3. Authorize the Polaris public key -------------------------------------
# Windows OpenSSH ignores the per-user authorized_keys for anyone in the
# Administrators group and reads ONLY this file. Getting this wrong does not
# raise an error — authentication just fails.
$authKeys = Get-PolarisAuthorizedKeysPath
$authDir  = Split-Path -Path $authKeys -Parent
if (-not (Test-Path -LiteralPath $authDir)) {
  New-Item -ItemType Directory -Force -Path $authDir | Out-Null
}

$existingLines = @()
if (Test-Path -LiteralPath $authKeys) {
  $existingLines = @(Get-Content -LiteralPath $authKeys -ErrorAction SilentlyContinue)
}

if (Test-PolarisKeyPresent -Lines $existingLines -Key $PolarisPublicKey) {
  Write-Host 'Polaris key already authorized'
} else {
  # Append — never overwrite. Other keys in this file belong to someone else.
  Add-Content -LiteralPath $authKeys -Value $PolarisPublicKey -Encoding ascii
  Write-Host 'Authorized the Polaris key'
}

# sshd refuses administrators_authorized_keys unless it is owned by
# Administrators/SYSTEM, inheritance is off, and no other ACEs are present.
# Well-known SIDs, not names — group names are localized.
$adminSid  = New-Object System.Security.Principal.SecurityIdentifier(__SID_ADMINS__)
$systemSid = New-Object System.Security.Principal.SecurityIdentifier(__SID_SYSTEM__)

$acl = Get-Acl -LiteralPath $authKeys
$acl.SetAccessRuleProtection($true, $false)
foreach ($ace in @($acl.Access)) { [void]$acl.RemoveAccessRule($ace) }
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($adminSid, 'FullControl', 'Allow')))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl', 'Allow')))
$acl.SetOwner($adminSid)
Set-Acl -LiteralPath $authKeys -AclObject $acl
Write-Host 'Applied authorized_keys ACL (Administrators + SYSTEM only)'

__FIREWALL_BLOCK__

Write-Host 'Polaris SSH onboarding complete'
exit 0
`.trim();

/** Emitted only for accountMode="create". */
const ACCOUNT_CREATE_PS = `
# --- 2. Local administrator account ------------------------------------------
# Key-only authentication: the password is randomly generated, never used by
# Polaris, and never stored anywhere.
if (-not (Get-LocalUser -Name $PolarisUser -ErrorAction SilentlyContinue)) {
  $pwBytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($pwBytes)
  $pwPlain = [Convert]::ToBase64String($pwBytes) + '!Aa1'
  New-LocalUser -Name $PolarisUser \`
                -Password (ConvertTo-SecureString $pwPlain -AsPlainText -Force) \`
                -FullName 'Polaris Agent Deployment' \`
                -Description 'Used by Polaris to deploy the Polaris Agent over SSH (key auth only)' \`
                -PasswordNeverExpires -AccountNeverExpires | Out-Null
  Remove-Variable pwPlain, pwBytes
  Write-Host ('Created local account ' + $PolarisUser)
} else {
  Write-Host ('Local account ' + $PolarisUser + ' already exists')
}

# Resolve the Administrators group by SID — the name is localized.
$adminGroupName = (Get-LocalGroup -SID __SID_ADMINS__).Name
$isMember = $false
try {
  $isMember = @(Get-LocalGroupMember -Group $adminGroupName -ErrorAction Stop |
                Where-Object { $_.Name -like ('*\\' + $PolarisUser) }).Count -gt 0
} catch { $isMember = $false }
if (-not $isMember) {
  Add-LocalGroupMember -Group $adminGroupName -Member $PolarisUser
  Write-Host ('Added ' + $PolarisUser + ' to ' + $adminGroupName)
} else {
  Write-Host ($PolarisUser + ' already an administrator')
}
`.trim();

/** Emitted only for accountMode="existing". */
const ACCOUNT_EXISTING_PS = `
# --- 2. Account check ---------------------------------------------------------
# Using an existing account: this script does not create or modify it. The
# account must already be a member of the local Administrators group — the
# Polaris Agent installer writes to %ProgramFiles% and registers a service.
Write-Host ('Using existing account ' + $PolarisUser + ' (not created by this script)')
`.trim();

/** Emitted only when a Polaris server address was supplied. */
const FIREWALL_PS = `
# --- 4. Scope inbound TCP/22 to the Polaris server -----------------------------
$fwName = __FW_NAME__
$existingRule = Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue
if ($existingRule) { $existingRule | Remove-NetFirewallRule }
New-NetFirewallRule -DisplayName $fwName \`
                    -Direction Inbound -Protocol TCP -LocalPort 22 \`
                    -RemoteAddress __SERVER_IP__ \`
                    -Action Allow -Profile Any | Out-Null
Write-Host ('Firewall rule set: TCP/22 inbound from ' + __SERVER_IP__)
`.trim();

const NO_FIREWALL_PS = `
# --- 4. Firewall --------------------------------------------------------------
# No Polaris server address was configured, so this script does not touch the
# firewall. Restrict inbound TCP/22 separately — leaving it open to every
# source is a much wider exposure than Polaris needs.
Write-Host 'Firewall: not modified (no Polaris server address configured)'
`.trim();

/**
 * Build the remediation script. Throws AppError on any invalid input rather
 * than emitting a script that would misbehave fleet-wide.
 */
export function buildWindowsOnboardingScript(opts: WindowsOnboardingScriptOptions): string {
  const publicKey = assertValidPublicKey(opts.publicKey);
  const username = assertValidUsername(opts.username, opts.accountMode);
  const serverIp = assertValidServerIp(opts.polarisServerIp);
  if (opts.accountMode !== "create" && opts.accountMode !== "existing") {
    throw new AppError(400, 'Account mode must be "create" or "existing"');
  }

  const accountBlock =
    opts.accountMode === "create"
      ? ACCOUNT_CREATE_PS.replace(/__SID_ADMINS__/g, psLiteral(SID_ADMINISTRATORS))
      : ACCOUNT_EXISTING_PS;

  const firewallBlock = serverIp
    ? FIREWALL_PS
        .replace(/__FW_NAME__/g, psLiteral(FIREWALL_RULE_NAME))
        .replace(/__SERVER_IP__/g, psLiteral(serverIp))
    : NO_FIREWALL_PS;

  return WINDOWS_ONBOARDING_PS
    .replace(/__PUBLIC_KEY__/g, psLiteral(publicKey))
    .replace(/__USERNAME__/g, psLiteral(username))
    .replace(/__KEY_PRESENT_FN__/g, POLARIS_KEY_PRESENT_FN)
    .replace(/__ACCOUNT_BLOCK__/g, accountBlock)
    .replace(/__FIREWALL_BLOCK__/g, firewallBlock)
    .replace(/__SID_ADMINS__/g, psLiteral(SID_ADMINISTRATORS))
    .replace(/__SID_SYSTEM__/g, psLiteral(SID_SYSTEM))
    .replace(
      /__ACCOUNT_SUMMARY__/g,
      opts.accountMode === "create"
        ? `creates the local administrator account '${username}'`
        : `uses the existing administrator account '${username}'`,
    )
    .replace(
      /__FIREWALL_SUMMARY__/g,
      serverIp ? `scopes inbound TCP/22 to ${serverIp}` : "leaves the firewall alone",
    );
}

// ─── Detection script ─────────────────────────────────────────────────────

const WINDOWS_DETECTION_PS = `
# ---------------------------------------------------------------------------
# Polaris — Windows SSH onboarding (DETECTION)
#
# Exit 0 = already onboarded, no action needed.
# Exit 1 = remediation required (run the onboarding script).
#
# Pair this with the remediation script in an Intune Remediation or an SCCM
# Configuration Baseline. That pairing is what makes fleet rollout self-heal:
# a plain platform script runs once per device and never retries, so machines
# that were offline at assignment time, or reimaged afterwards, stay
# unconfigured forever without it.
#
# An unsupported Windows build reports 'unsupported: ...' and exits 0 on
# purpose — remediation cannot fix a missing OS capability, and returning 1
# would loop the pair against that device forever.
#
# Run as SYSTEM, 64-bit PowerShell host = Yes.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

$PolarisPublicKey = __PUBLIC_KEY__

__KEY_PRESENT_FN__

try {
  $cap = Get-PolarisSshCapability
  if (-not $cap) {
    Write-Host 'unsupported: no OpenSSH Server capability on this Windows build'
    exit 0
  }
  if ($cap.State -ne 'Installed') {
    Write-Host 'remediate: OpenSSH Server not installed'
    exit 1
  }

  $svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
  if (-not $svc) {
    Write-Host 'remediate: sshd service missing'
    exit 1
  }
  if ($svc.Status -ne 'Running') {
    Write-Host 'remediate: sshd not running'
    exit 1
  }

  $authKeys = Get-PolarisAuthorizedKeysPath
  if (-not (Test-Path -LiteralPath $authKeys)) {
    Write-Host 'remediate: administrators_authorized_keys missing'
    exit 1
  }
  $lines = @(Get-Content -LiteralPath $authKeys -ErrorAction SilentlyContinue)
  if (-not (Test-PolarisKeyPresent -Lines $lines -Key $PolarisPublicKey)) {
    Write-Host 'remediate: Polaris key not authorized'
    exit 1
  }

  Write-Host 'ok: Polaris SSH onboarding present'
  exit 0
} catch {
  Write-Host ('remediate: detection error - ' + $_.Exception.Message)
  exit 1
}
`.trim();

/**
 * Build the detection half of the pair. Takes only the public key — detection
 * deliberately does NOT check the account or the firewall rule: neither is
 * observable as "wrong" without guessing at local policy, and a false
 * "needs remediation" would re-run the whole script on every cycle forever.
 */
export function buildWindowsOnboardingDetectionScript(opts: { publicKey: string }): string {
  const publicKey = assertValidPublicKey(opts.publicKey);
  return WINDOWS_DETECTION_PS
    .replace(/__PUBLIC_KEY__/g, psLiteral(publicKey))
    .replace(/__KEY_PRESENT_FN__/g, POLARIS_KEY_PRESENT_FN);
}
