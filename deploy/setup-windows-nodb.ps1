#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Shelob deployment script for Windows Server 2019/2022 with a remote/external PostgreSQL database.

.DESCRIPTION
    Installs Node.js 20 and deploys Shelob as a Windows Service, connecting to an external PostgreSQL database.
    Does NOT install PostgreSQL locally.

    Run as Administrator:
        powershell -ExecutionPolicy Bypass -File deploy\setup-windows-nodb.ps1 -DbUrl "postgresql://user:pass@db-host:5432/shelob"

    What this script does:
      1. Installs Node.js 20 LTS (via winget or direct MSI)
      2. Clones or copies the application to C:\shelob
      3. Configures .env with the provided DATABASE_URL
      4. Installs dependencies, builds, and runs migrations against the remote database
      5. Installs NSSM and registers Shelob as a Windows Service
      6. Opens port 3000 in Windows Firewall

    Use this script when your PostgreSQL database is hosted externally
    (e.g. AWS RDS, Azure Database for PostgreSQL, a separate DB server).

    After running, the app will be available at http://<server-ip>:3000
#>

param(
    [string]$DbUrl      = "",
    [string]$AppDir     = "C:\shelob",
    [string]$RepoUrl    = "https://github.com/davidmoore-rogers/shelob.git",
    [int]   $Port       = 3000,
    [string]$NssmUrl    = "https://nssm.cc/release/nssm-2.24.zip"
)

$ErrorActionPreference = "Stop"

# ─── Colors ───────────────────────────────────────────────────────────────────
function Write-Info  { param([string]$Msg) Write-Host "[INFO]  $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "[WARN]  $Msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red; exit 1 }

# ─── Helpers ──────────────────────────────────────────────────────────────────
function Test-Command { param([string]$Name) return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# ─── Preflight ────────────────────────────────────────────────────────────────
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Err "This script must be run as Administrator"
}

if (-not $DbUrl) {
    Write-Host ""
    Write-Host "No -DbUrl provided. Please enter the PostgreSQL connection URL." -ForegroundColor Yellow
    Write-Host "Format: postgresql://user:password@host:5432/database" -ForegroundColor Yellow
    Write-Host ""
    $DbUrl = Read-Host "DATABASE_URL"
    if (-not $DbUrl) {
        Write-Err "DATABASE_URL is required. Use -DbUrl or enter it when prompted."
    }
}

if ($DbUrl -notmatch "^postgres(ql)?://") {
    Write-Err "Invalid DATABASE_URL — must start with postgresql:// or postgres://"
}

Write-Info "Starting Shelob deployment on $env:COMPUTERNAME (remote database mode)"

$hasWinget = Test-Command "winget"

# ─── 1. Install Node.js 20 ───────────────────────────────────────────────────
Refresh-Path
if ((Test-Command "node") -and ((node -v) -match "^v(20|22)\.")) {
    Write-Info "Node.js $(node -v) already installed"
} else {
    Write-Info "Installing Node.js 20 LTS..."
    if ($hasWinget) {
        winget install --id OpenJS.NodeJS.LTS --version 20.19.0 --accept-source-agreements --accept-package-agreements --silent
    } else {
        $nodeUrl = "https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi"
        $nodeMsi = "$env:TEMP\node-v20.19.0-x64.msi"
        Write-Info "Downloading Node.js installer..."
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeMsi -UseBasicParsing
        Write-Info "Running Node.js installer..."
        Start-Process msiexec.exe -ArgumentList "/i `"$nodeMsi`" /qn /norestart" -Wait -NoNewWindow
        Remove-Item $nodeMsi -Force -ErrorAction SilentlyContinue
    }
    Refresh-Path
    if (-not (Test-Command "node")) {
        Write-Err "Node.js installation failed — 'node' not found in PATH. You may need to restart the terminal and re-run."
    }
    Write-Info "Node.js $(node -v) installed"
}

# ─── 2. Test database connectivity ──────────────────────────────────────────
Write-Info "Testing database connectivity..."
try {
    $testResult = & node -e "
        const url = new URL('$DbUrl');
        const net = require('net');
        const s = net.createConnection(parseInt(url.port) || 5432, url.hostname, () => { console.log('OK'); s.end(); });
        s.setTimeout(5000, () => { console.log('TIMEOUT'); s.end(); });
        s.on('error', (e) => { console.log('FAIL:' + e.message); });
    " 2>$null
    if ($testResult -eq "OK") {
        Write-Info "Database host is reachable"
    } else {
        Write-Warn "Could not reach database host ($testResult) — continuing anyway"
    }
} catch {
    Write-Warn "Could not test database connectivity — continuing anyway"
}

# ─── 3. Deploy application ───────────────────────────────────────────────────
if (Test-Path (Join-Path $AppDir ".git")) {
    Write-Info "Updating existing installation..."
    Push-Location $AppDir
    & git pull --ff-only
    Pop-Location
} else {
    if (Test-Command "git") {
        Write-Info "Cloning repository to $AppDir..."
        if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
        & git clone $RepoUrl $AppDir
    } else {
        Write-Err "git is not installed. Install Git for Windows, or manually copy the application to $AppDir"
    }
}

# ─── 4. Configure environment ────────────────────────────────────────────────
$envFile = Join-Path $AppDir ".env"
if (-not (Test-Path $envFile)) {
    Write-Info "Creating .env..."
    $sessionSecret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
    @"
# Database (remote)
DATABASE_URL=$DbUrl

# App
PORT=$Port
NODE_ENV=production
LOG_LEVEL=info

# Auth
SESSION_SECRET=$sessionSecret
"@ | Set-Content $envFile -Encoding UTF8
    Write-Info ".env created with remote DATABASE_URL"
} else {
    Write-Info ".env already exists — skipping"
    Write-Warn "Verify DATABASE_URL in $envFile points to the correct remote database"
}

# ─── 5. Install dependencies & build ─────────────────────────────────────────
Push-Location $AppDir

Write-Info "Installing dependencies..."
& npm ci --production=false
if ($LASTEXITCODE -ne 0) { Write-Err "npm ci failed" }

Write-Info "Building TypeScript..."
& npx tsc
if ($LASTEXITCODE -ne 0) { Write-Err "TypeScript build failed" }

Write-Info "Running database migrations..."
& npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) { Write-Err "Prisma migration failed" }

# Seed on first deploy — check via Prisma
$hasUsers = & node --env-file=.env -e "
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient();
    p.user.count().then(c => { console.log(c); p.`$disconnect(); }).catch(() => { console.log(0); p.`$disconnect(); });
" 2>$null
$hasUsers = if ($hasUsers) { ($hasUsers | Select-Object -Last 1).Trim() } else { "0" }
if ($hasUsers -eq "" -or $hasUsers -eq "0") {
    Write-Info "Seeding database (first deploy)..."
    & node --env-file=.env --import tsx/esm prisma/seed.ts
} else {
    Write-Info "Database already seeded ($hasUsers users) — skipping"
}

Pop-Location

# ─── 6. Install NSSM & register Windows Service ─────────────────────────────
$nssmDir = "C:\nssm"
$nssmExe = Join-Path $nssmDir "nssm.exe"

if (-not (Test-Path $nssmExe)) {
    Write-Info "Installing NSSM (Non-Sucking Service Manager)..."
    $nssmZip = "$env:TEMP\nssm.zip"
    Invoke-WebRequest -Uri $NssmUrl -OutFile $nssmZip -UseBasicParsing
    Expand-Archive -Path $nssmZip -DestinationPath "$env:TEMP\nssm-extract" -Force
    if (-not (Test-Path $nssmDir)) { New-Item -ItemType Directory -Path $nssmDir -Force | Out-Null }

    $extracted = Get-ChildItem "$env:TEMP\nssm-extract" -Recurse -Filter "nssm.exe" |
                 Where-Object { $_.DirectoryName -like "*win64*" } |
                 Select-Object -First 1
    if (-not $extracted) {
        $extracted = Get-ChildItem "$env:TEMP\nssm-extract" -Recurse -Filter "nssm.exe" | Select-Object -First 1
    }
    if (-not $extracted) { Write-Err "Failed to find nssm.exe in downloaded archive" }
    Copy-Item $extracted.FullName $nssmExe -Force
    Remove-Item $nssmZip -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\nssm-extract" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Info "NSSM installed to $nssmExe"
} else {
    Write-Info "NSSM already installed at $nssmExe"
}

$serviceName = "Shelob"
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue

if ($existingService) {
    Write-Info "Service '$serviceName' already exists — updating..."
    if ($existingService.Status -eq "Running") {
        & $nssmExe stop $serviceName 2>$null
        Start-Sleep -Seconds 2
    }
} else {
    Write-Info "Creating Windows Service '$serviceName'..."
}

$nodeExe = (Get-Command node).Source

& $nssmExe install $serviceName $nodeExe 2>$null
& $nssmExe set $serviceName AppParameters "dist\index.js"
& $nssmExe set $serviceName AppDirectory $AppDir
& $nssmExe set $serviceName AppEnvironmentExtra "NODE_ENV=production"
& $nssmExe set $serviceName Description "Shelob — IP Management Tool"
& $nssmExe set $serviceName Start SERVICE_AUTO_START
& $nssmExe set $serviceName AppStdout (Join-Path $AppDir "logs\service-stdout.log")
& $nssmExe set $serviceName AppStderr (Join-Path $AppDir "logs\service-stderr.log")
& $nssmExe set $serviceName AppRotateFiles 1
& $nssmExe set $serviceName AppRotateBytes 5242880

$logsDir = Join-Path $AppDir "logs"
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }

& $nssmExe start $serviceName 2>$null
Start-Sleep -Seconds 3

$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Info "Shelob service is running"
} else {
    Write-Warn "Service may not have started — check: nssm status $serviceName"
}

# ─── 7. Firewall ─────────────────────────────────────────────────────────────
$fwRule = Get-NetFirewallRule -DisplayName "Shelob (TCP $Port)" -ErrorAction SilentlyContinue
if (-not $fwRule) {
    Write-Info "Opening port $Port in Windows Firewall..."
    New-NetFirewallRule -DisplayName "Shelob (TCP $Port)" `
        -Direction Inbound -Protocol TCP -LocalPort $Port `
        -Action Allow -Profile Domain,Private | Out-Null
    Write-Info "Firewall rule created (Domain + Private profiles)"
} else {
    Write-Info "Firewall rule for port $Port already exists"
}

# ─── Done ─────────────────────────────────────────────────────────────────────
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" } | Select-Object -First 1).IPAddress
if (-not $ip) { $ip = "localhost" }

Write-Host ""
Write-Info "============================================"
Write-Info "  Shelob deployment complete!"
Write-Info "  Mode:  Remote database"
Write-Info "  URL:   http://${ip}:${Port}"
Write-Info "  Login: admin / admin"
Write-Info "  Logs:  $AppDir\logs\"
Write-Info "  Service: nssm status $serviceName"
Write-Info "============================================"
Write-Host ""
Write-Warn "Change the default admin password after first login!"
