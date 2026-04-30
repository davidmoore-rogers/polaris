#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Polaris deployment script for Windows Server 2019/2022.

.DESCRIPTION
    Installs Node.js 20, PostgreSQL 15, and deploys Polaris as a Windows Service.

    Run as Administrator:
        powershell -ExecutionPolicy Bypass -File deploy\setup-windows.ps1

    What this script does:
      1. Installs Node.js 20 LTS (via winget or direct MSI)
      2. Installs PostgreSQL 15 (via winget or direct installer)
      3. Creates the PostgreSQL database and role
      4. Clones or copies the application to C:\polaris
      5. Installs dependencies and runs migrations
      6. Installs NSSM and registers Polaris as a Windows Service
      7. Opens port 3000 in Windows Firewall

    After running, the app will be available at http://<server-ip>:3000
#>

param(
    [string]$AppDir     = "C:\polaris",
    [string]$DbName     = "polaris",
    [string]$DbUser     = "polaris",
    [string]$DbPass     = "polaris",
    [string]$RepoUrl    = "https://github.com/davidmoore-rogers/polaris.git",
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

Write-Info "Starting Polaris deployment on $env:COMPUTERNAME"

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
        # Direct MSI download
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

# ─── 2. Install PostgreSQL 15 ────────────────────────────────────────────────
$pgBinDirs = @(
    "C:\Program Files\PostgreSQL\15\bin",
    "C:\Program Files\PostgreSQL\16\bin",
    "C:\Program Files\PostgreSQL\17\bin"
)
$pgBin = $pgBinDirs | Where-Object { Test-Path "$_\psql.exe" } | Select-Object -First 1

if ($pgBin) {
    Write-Info "PostgreSQL already installed at $pgBin"
} else {
    Write-Info "Installing PostgreSQL 15..."
    if ($hasWinget) {
        winget install --id PostgreSQL.PostgreSQL.15 --accept-source-agreements --accept-package-agreements --silent
    } else {
        $pgUrl = "https://get.enterprisedb.com/postgresql/postgresql-15.13-1-windows-x64.exe"
        $pgInstaller = "$env:TEMP\postgresql-15-installer.exe"
        Write-Info "Downloading PostgreSQL installer..."
        Invoke-WebRequest -Uri $pgUrl -OutFile $pgInstaller -UseBasicParsing
        Write-Info "Running PostgreSQL installer (this may take a few minutes)..."
        Start-Process $pgInstaller -ArgumentList `
            "--mode unattended --superpassword postgres --servicename postgresql-15 --servicepassword postgres --serverport 5432" `
            -Wait -NoNewWindow
        Remove-Item $pgInstaller -Force -ErrorAction SilentlyContinue
    }

    $pgBin = $pgBinDirs | Where-Object { Test-Path "$_\psql.exe" } | Select-Object -First 1
    if (-not $pgBin) {
        Write-Err "PostgreSQL installation failed — psql.exe not found"
    }
    Write-Info "PostgreSQL installed at $pgBin"
}

# Add PostgreSQL bin to session PATH
if ($env:Path -notlike "*$pgBin*") {
    $env:Path = "$pgBin;$env:Path"
}

# Ensure PostgreSQL service is running
$pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Where-Object { $_.Status -ne "Running" } | Select-Object -First 1
$pgServiceRunning = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq "Running" } | Select-Object -First 1
if ($pgService) {
    Start-Service $pgService.Name
    Write-Info "PostgreSQL service started"
} elseif ($pgServiceRunning) {
    Write-Info "PostgreSQL service is running"
} else {
    Write-Warn "No PostgreSQL service found — you may need to start it manually"
}

# ─── 3. Create database and role ─────────────────────────────────────────────
Write-Info "Setting up PostgreSQL database..."

# Check if role exists
$roleExists = & psql -U postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='$DbUser'" 2>$null
if ($roleExists -notmatch "1") {
    & psql -U postgres -c "CREATE USER $DbUser WITH PASSWORD '$DbPass';" 2>$null
    Write-Info "Database user '$DbUser' created"
} else {
    Write-Info "Database user '$DbUser' already exists"
}

# Check if database exists
$dbExists = & psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='$DbName'" 2>$null
if ($dbExists -notmatch "1") {
    & psql -U postgres -c "CREATE DATABASE $DbName OWNER $DbUser;" 2>$null
    Write-Info "Database '$DbName' created"
} else {
    Write-Info "Database '$DbName' already exists"
}

# Ensure pg_hba.conf allows password auth
$pgDataDir = & psql -U postgres -tc "SHOW data_directory;" 2>$null
if ($pgDataDir) {
    $pgDataDir = $pgDataDir.Trim()
    $pgHba = Join-Path $pgDataDir "pg_hba.conf"
    if (Test-Path $pgHba) {
        $hbaContent = Get-Content $pgHba -Raw
        if ($hbaContent -notmatch $DbUser) {
            Write-Warn "Adding md5 auth entry for '$DbUser' to pg_hba.conf"
            $entries = @(
                "host    $DbName    $DbUser    127.0.0.1/32    md5",
                "host    $DbName    $DbUser    ::1/128         md5"
            )
            $hbaLines = Get-Content $pgHba
            $insertIdx = 0
            for ($i = 0; $i -lt $hbaLines.Count; $i++) {
                if ($hbaLines[$i] -match "^#\s*TYPE") { $insertIdx = $i + 1; break }
            }
            $newLines = $hbaLines[0..($insertIdx - 1)] + $entries + $hbaLines[$insertIdx..($hbaLines.Count - 1)]
            $newLines | Set-Content $pgHba -Encoding UTF8

            # Reload PostgreSQL
            $pgSvc = Get-Service -Name "postgresql*" | Where-Object { $_.Status -eq "Running" } | Select-Object -First 1
            if ($pgSvc) { & pg_ctl reload -D $pgDataDir 2>$null }
        }
    }
}

Write-Info "Database '$DbName' ready"

# ─── 4. Deploy application ───────────────────────────────────────────────────
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

# ─── 5. Configure environment ────────────────────────────────────────────────
$envFile = Join-Path $AppDir ".env"
if (-not (Test-Path $envFile)) {
    Write-Info "Creating .env from template..."
    $sessionSecret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
    @"
# Database
DATABASE_URL=postgresql://${DbUser}:${DbPass}@localhost:5432/${DbName}

# App
PORT=$Port
NODE_ENV=production
LOG_LEVEL=info

# Auth
SESSION_SECRET=$sessionSecret
"@ | Set-Content $envFile -Encoding UTF8
    Write-Info ".env created with generated SESSION_SECRET"
} else {
    Write-Info ".env already exists — skipping"
}

# ─── 6. Install dependencies & build ─────────────────────────────────────────
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

# Only seed on first deploy
$hasUsers = & psql -U postgres -tc "SELECT count(*) FROM ${DbName}.public.users" 2>$null
$hasUsers = if ($hasUsers) { $hasUsers.Trim() } else { "0" }
if ($hasUsers -eq "" -or $hasUsers -eq "0") {
    Write-Info "Seeding default admin (skipped in production — use the first-run wizard or restore from backup)..."
    & node --env-file=.env --import tsx/esm prisma/seed.ts
    $LASTEXITCODE = 0  # seed.ts refuses in production; treat as success so the script continues
} else {
    Write-Info "Database already seeded ($hasUsers users) — skipping"
}

Pop-Location

# ─── 7. Install NSSM & register Windows Service ─────────────────────────────
$nssmDir = "C:\nssm"
$nssmExe = Join-Path $nssmDir "nssm.exe"

if (-not (Test-Path $nssmExe)) {
    Write-Info "Installing NSSM (Non-Sucking Service Manager)..."
    $nssmZip = "$env:TEMP\nssm.zip"
    Invoke-WebRequest -Uri $NssmUrl -OutFile $nssmZip -UseBasicParsing
    Expand-Archive -Path $nssmZip -DestinationPath "$env:TEMP\nssm-extract" -Force
    if (-not (Test-Path $nssmDir)) { New-Item -ItemType Directory -Path $nssmDir -Force | Out-Null }

    # Find the 64-bit exe inside the extracted folder
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

$serviceName = "Polaris"
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

# Find node.exe path
$nodeExe = (Get-Command node).Source

# Register/update the service
& $nssmExe install $serviceName $nodeExe 2>$null
& $nssmExe set $serviceName AppParameters "dist\index.js"
& $nssmExe set $serviceName AppDirectory $AppDir
& $nssmExe set $serviceName AppEnvironmentExtra "NODE_ENV=production"
& $nssmExe set $serviceName Description "Polaris — IP Management Tool"
& $nssmExe set $serviceName Start SERVICE_AUTO_START
& $nssmExe set $serviceName AppStdout (Join-Path $AppDir "logs\service-stdout.log")
& $nssmExe set $serviceName AppStderr (Join-Path $AppDir "logs\service-stderr.log")
& $nssmExe set $serviceName AppRotateFiles 1
& $nssmExe set $serviceName AppRotateBytes 5242880

# Create logs directory
$logsDir = Join-Path $AppDir "logs"
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }

# Start the service
& $nssmExe start $serviceName 2>$null
Start-Sleep -Seconds 3

$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Info "Polaris service is running"
} else {
    Write-Warn "Service may not have started — check: nssm status $serviceName"
}

# ─── 8. Firewall ─────────────────────────────────────────────────────────────
$fwRule = Get-NetFirewallRule -DisplayName "Polaris (TCP $Port)" -ErrorAction SilentlyContinue
if (-not $fwRule) {
    Write-Info "Opening port $Port in Windows Firewall..."
    New-NetFirewallRule -DisplayName "Polaris (TCP $Port)" `
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
Write-Info "  Polaris deployment complete!"
Write-Info "  URL:   http://${ip}:${Port}"
Write-Info "  Login: admin / admin"
Write-Info "  Logs:  $AppDir\logs\"
Write-Info "  Service: nssm status $serviceName"
Write-Info "============================================"
Write-Host ""
Write-Warn "Change the default admin password after first login!"
