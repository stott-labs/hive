# =============================================================================
# H.I.V.E. Setup — Hub for Integrated Visualization & Exploration
# Interactive CLI to generate dashboard.config.json and data files.
# Re-run at any time to update your configuration.
# =============================================================================

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigFile  = Join-Path $ScriptDir 'dashboard.config.json'
$DatabasesFile = Join-Path $ScriptDir 'data\databases.json'
$HivemindPathsDir  = Join-Path $env:USERPROFILE '.config\hivemind'
$HivemindPathsFile = Join-Path $HivemindPathsDir 'paths.env'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Header($text) {
    Write-Host ""
    Write-Host $text -ForegroundColor Cyan -NoNewline
    Write-Host ""
    Write-Host ("-" * 60) -ForegroundColor Cyan
}

function Write-Success($text) { Write-Host "✔  $text" -ForegroundColor Green }
function Write-Info($text)    { Write-Host "ℹ  $text" -ForegroundColor Cyan }
function Write-Warn($text)    { Write-Host "⚠  $text" -ForegroundColor Yellow }

function Ask-Question {
    param(
        [string]$Question,
        [string]$Default = ""
    )
    if ($Default) {
        Write-Host "${Question} " -ForegroundColor White -NoNewline
        Write-Host "[$Default]" -ForegroundColor Cyan -NoNewline
        Write-Host ": " -NoNewline
    } else {
        Write-Host "${Question}: " -ForegroundColor White -NoNewline
    }
    $answer = Read-Host
    if ([string]::IsNullOrWhiteSpace($answer) -and $Default) {
        return $Default
    }
    return $answer
}

function ConvertTo-JsonString([string]$value) {
    # Escape a plain string for safe JSON embedding (with surrounding quotes)
    return ($value | ConvertTo-Json -Compress)
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  ██╗  ██╗  ██╗██╗   ██╗███████╗" -ForegroundColor Cyan
Write-Host "  ██║  ██║  ██║██║   ██║██╔════╝" -ForegroundColor Cyan
Write-Host "  ███████║  ██║██║   ██║█████╗  " -ForegroundColor Cyan
Write-Host "  ██╔══██║  ██║╚██╗ ██╔╝██╔══╝  " -ForegroundColor Cyan
Write-Host "  ██║  ██║  ██║ ╚████╔╝ ███████╗" -ForegroundColor Cyan
Write-Host "  ╚═╝  ╚═╝  ╚═╝  ╚═══╝  ╚══════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Hub for Integrated Visualization & Exploration" -ForegroundColor White
Write-Host "  Setup CLI — re-run any time to update your config"
Write-Host ""

# ---------------------------------------------------------------------------
# Check for existing config
# ---------------------------------------------------------------------------
if (Test-Path $ConfigFile) {
    Write-Warn "dashboard.config.json already exists."
    $updateChoice = Ask-Question "Update it? (y/n)" "y"
    if ($updateChoice -notin @('y', 'Y')) {
        Write-Info "Aborted. No changes made."
        exit 0
    }
}

# ---------------------------------------------------------------------------
# [1/8] Project Info
# ---------------------------------------------------------------------------
Write-Header "[1/8] Project Info"

$ProjectName    = Ask-Question "Project name (short identifier, e.g. myapp)" "myapp"
$DashboardTitle = Ask-Question "Dashboard title (shown in browser tab)" "H.I.V.E."

# ---------------------------------------------------------------------------
# [2/8] Projects Base Directory
# ---------------------------------------------------------------------------
Write-Header "[2/8] Projects Base Directory"
Write-Info "This is the parent folder where all your repos are cloned."
Write-Info "Example: C:\Users\you\Projects"

$ProjectsDir = ""
while ([string]::IsNullOrWhiteSpace($ProjectsDir)) {
    $ProjectsDir = Ask-Question "Projects base directory"
    if ([string]::IsNullOrWhiteSpace($ProjectsDir)) {
        Write-Warn "Base directory is required."
    }
}

# ---------------------------------------------------------------------------
# [3/8] Repos to Watch
# ---------------------------------------------------------------------------
Write-Header "[3/8] Repos to Watch"
Write-Info "Enter repo directory names (relative to your projects base directory)."
Write-Info "Press Enter with no input when done."

$Repos = @()
while ($true) {
    $repoName = Ask-Question "Repo name (blank to stop)"
    if ([string]::IsNullOrWhiteSpace($repoName)) { break }
    $Repos += $repoName
    Write-Success "Added: $repoName"
}

# ---------------------------------------------------------------------------
# [4/8] Web Service
# ---------------------------------------------------------------------------
Write-Header "[4/8] Web Service (optional)"
Write-Info "Configure your frontend dev server (e.g. Vue, React)."

$ConfigureWeb = Ask-Question "Configure web service? (y/n)" "y"
$WebRepoDir   = ""
$WebPort      = "8080"
$WebStartCmd  = "npm run dev"

if ($ConfigureWeb -in @('y', 'Y')) {
    $WebRepoDir  = Ask-Question "Web repo directory name (relative to projects base)"
    $WebPort     = Ask-Question "Web dev server port" "8080"
    $WebStartCmd = Ask-Question "Web start command" "npm run dev"
}

# ---------------------------------------------------------------------------
# [5/8] API Service
# ---------------------------------------------------------------------------
Write-Header "[5/8] API Service (optional)"
Write-Info "Configure your backend API dev server."

$ConfigureApi = Ask-Question "Configure API service? (y/n)" "y"
$ApiRepoDir   = ""
$ApiPort      = "3000"
$ApiStartCmd  = "npm run start:dev"

if ($ConfigureApi -in @('y', 'Y')) {
    $ApiRepoDir  = Ask-Question "API repo directory name (relative to projects base)"
    $ApiPort     = Ask-Question "API server port" "3000"
    $ApiStartCmd = Ask-Question "API start command" "npm run start:dev"
}

# ---------------------------------------------------------------------------
# [6/8] Database Connections
# ---------------------------------------------------------------------------
Write-Header "[6/8] Database Connections (optional)"
Write-Info "Add PostgreSQL connections for DB Explorer and SQL metric widgets."

$ConfigureDbs = Ask-Question "Add database connections? (y/n)" "y"
$DbEntries = @()

if ($ConfigureDbs -in @('y', 'Y')) {
    while ($true) {
        Write-Host ""
        Write-Info "New database connection (blank ID to stop):"
        $dbId = Ask-Question "Connection ID (e.g. local, staging)"
        if ([string]::IsNullOrWhiteSpace($dbId)) { break }

        $dbLabel = Ask-Question "Label (display name)" $dbId
        $dbHost  = Ask-Question "Host" "localhost"
        $dbPort  = Ask-Question "Port" "5432"
        $dbUser  = Ask-Question "User" "postgres"
        $dbPass  = Ask-Question "Password"
        $dbName  = Ask-Question "Database name"

        $DbEntries += [PSCustomObject]@{
            id       = $dbId
            label    = $dbLabel
            host     = $dbHost
            port     = [int]$dbPort
            user     = $dbUser
            password = $dbPass
            database = $dbName
        }
        Write-Success "Added connection: $dbId ($dbHost/$dbName)"
    }
}

# ---------------------------------------------------------------------------
# [7/8] Hivemind Integration
# ---------------------------------------------------------------------------
Write-Header "[7/8] Hivemind Integration (optional)"
Write-Info "Hivemind is the Claude Code shared config system that adds /dashboard and other skills."

$HivemindDir    = ""
$SiblingHivemind = Join-Path (Split-Path -Parent $ScriptDir) 'hivemind'

if (Test-Path $SiblingHivemind) {
    Write-Success "Found Hivemind at: $SiblingHivemind"
    $useHivemind = Ask-Question "Use this Hivemind installation? (y/n)" "y"
    if ($useHivemind -in @('y', 'Y')) {
        $HivemindDir = $SiblingHivemind
    }
} else {
    $customHivemind = Ask-Question "Path to Hivemind directory (blank to skip)"
    if (-not [string]::IsNullOrWhiteSpace($customHivemind)) {
        if (Test-Path $customHivemind) {
            $HivemindDir = $customHivemind
            Write-Success "Hivemind set to: $HivemindDir"
        } else {
            Write-Warn "Directory not found — skipping Hivemind integration."
        }
    }
}

# ---------------------------------------------------------------------------
# [8/8] Generate Files
# ---------------------------------------------------------------------------
Write-Header "[8/8] Generating Configuration Files"

# --- Build services JSON ---
$WebServiceJson = 'null'
if (-not [string]::IsNullOrWhiteSpace($WebRepoDir)) {
    $WebServiceJson = "{`"repoDir`":$(ConvertTo-JsonString $WebRepoDir),`"port`":$WebPort,`"startCmd`":$(ConvertTo-JsonString $WebStartCmd)}"
}

$ApiServiceJson = 'null'
if (-not [string]::IsNullOrWhiteSpace($ApiRepoDir)) {
    $ApiServiceJson = "{`"repoDir`":$(ConvertTo-JsonString $ApiRepoDir),`"port`":$ApiPort,`"startCmd`":$(ConvertTo-JsonString $ApiStartCmd)}"
}

# --- Repos JSON array ---
$ReposJsonParts = $Repos | ForEach-Object { ConvertTo-JsonString $_ }
$ReposJson = if ($ReposJsonParts) { "[" + ($ReposJsonParts -join ",") + "]" } else { "[]" }

# --- dashboard.config.json ---
$ConfigContent = @"
{
  "project": $(ConvertTo-JsonString $ProjectName),
  "title": $(ConvertTo-JsonString $DashboardTitle),
  "projectsDir": $(ConvertTo-JsonString $ProjectsDir),
  "repos": $ReposJson,
  "services": {
    "web": $WebServiceJson,
    "api": $ApiServiceJson
  }
}
"@
Set-Content -Path $ConfigFile -Value $ConfigContent -Encoding UTF8
Write-Success "Created dashboard.config.json"

# --- data/databases.json ---
$DataDir = Join-Path $ScriptDir 'data'
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }

if ($DbEntries.Count -gt 0) {
    $DbJson = $DbEntries | ConvertTo-Json -Depth 5
    # Ensure it's always an array
    if ($DbEntries.Count -eq 1) { $DbJson = "[$DbJson]" }
    Set-Content -Path $DatabasesFile -Value $DbJson -Encoding UTF8
    Write-Success "Created data/databases.json ($($DbEntries.Count) connection(s))"
} else {
    Set-Content -Path $DatabasesFile -Value '[]' -Encoding UTF8
    Write-Info "Created data/databases.json (empty — add connections later)"
}

# --- run-web.ps1 ---
if (-not [string]::IsNullOrWhiteSpace($WebRepoDir)) {
    $WebScriptPath = Join-Path $ScriptDir 'run-web.ps1'
    $WebScriptContent = @"
# Generated by setup.ps1 — gitignored
Set-Location $(ConvertTo-JsonString "$ProjectsDir\$WebRepoDir")
$WebStartCmd
"@
    Set-Content -Path $WebScriptPath -Value $WebScriptContent -Encoding UTF8
    Write-Success "Created run-web.ps1"
}

# --- run-api.ps1 ---
if (-not [string]::IsNullOrWhiteSpace($ApiRepoDir)) {
    $ApiScriptPath = Join-Path $ScriptDir 'run-api.ps1'
    $ApiScriptContent = @"
# Generated by setup.ps1 — gitignored
Set-Location $(ConvertTo-JsonString "$ProjectsDir\$ApiRepoDir")
$ApiStartCmd
"@
    Set-Content -Path $ApiScriptPath -Value $ApiScriptContent -Encoding UTF8
    Write-Success "Created run-api.ps1"
}

# --- npm install ---
Write-Host ""
Write-Info "Running npm install..."
Set-Location $ScriptDir
npm install
Write-Success "Dependencies installed"

# --- ~/.config/hivemind/paths.env ---
if (-not (Test-Path $HivemindPathsDir)) {
    New-Item -ItemType Directory -Path $HivemindPathsDir -Force | Out-Null
}
$PathsContent = "HIVE_DIR=$ScriptDir"
if (-not [string]::IsNullOrWhiteSpace($HivemindDir)) {
    $PathsContent += "`nHIVEMIND_DIR=$HivemindDir"
}
Set-Content -Path $HivemindPathsFile -Value $PathsContent -Encoding UTF8
Write-Success "Written $HivemindPathsFile"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host ("━" * 62) -ForegroundColor Green
Write-Host "  H.I.V.E. setup complete!" -ForegroundColor Green
Write-Host ("━" * 62) -ForegroundColor Green
Write-Host ""
Write-Host "  Start the dashboard:" -ForegroundColor White
Write-Host "    node server.mjs" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Then open:  " -NoNewline -ForegroundColor White
Write-Host "http://localhost:3333" -ForegroundColor Cyan
Write-Host ""

if (-not [string]::IsNullOrWhiteSpace($HivemindDir)) {
    Write-Host "  Hivemind found! Run the following to complete integration:" -ForegroundColor Yellow
    Write-Host "    cd `"$HivemindDir`" && .\setup.ps1" -ForegroundColor Cyan
    Write-Host ""
}

Write-Host "  Generated files (gitignored — local only):" -ForegroundColor Cyan
Write-Host "    dashboard.config.json"
Write-Host "    data\databases.json"
if (-not [string]::IsNullOrWhiteSpace($WebRepoDir)) { Write-Host "    run-web.ps1" }
if (-not [string]::IsNullOrWhiteSpace($ApiRepoDir)) { Write-Host "    run-api.ps1" }
Write-Host "    $HivemindPathsFile"
Write-Host ""
