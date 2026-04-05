# =============================================================================
# H.I.V.E. Setup — Hub for Integrated Visualization & Exploration
# Interactive CLI to generate dashboard.config.json, shared config, and data files.
# Re-run at any time to update your configuration.
# =============================================================================

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir        = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigFile       = Join-Path $ScriptDir 'dashboard.config.json'
$DatabasesFile    = Join-Path $ScriptDir 'data\databases.json'
$SharedConfigDir  = Join-Path $env:USERPROFILE '.config\hivemind'
$SharedConfigFile = Join-Path $SharedConfigDir 'config.md'
$PathsEnvFile     = Join-Path $SharedConfigDir 'paths.env'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Header($text) {
    Write-Host ""
    Write-Host $text -ForegroundColor Cyan -NoNewline
    Write-Host ""
    Write-Host ("-" * 60) -ForegroundColor Cyan
}

function Write-Success($text) { Write-Host "+  $text" -ForegroundColor Green }
function Write-Info($text)    { Write-Host "i  $text" -ForegroundColor Cyan }
function Write-Warn($text)    { Write-Host "!  $text" -ForegroundColor Yellow }

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
    return ($value | ConvertTo-Json -Compress)
}

function Build-JsonArray([string[]]$items) {
    if ($items.Count -eq 0) { return "[]" }
    $parts = $items | ForEach-Object { ConvertTo-JsonString $_ }
    return "[" + ($parts -join ",") + "]"
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
# [1/10] Identity
# ---------------------------------------------------------------------------
Write-Header "[1/10] Identity"
Write-Info "Used by Hivemind skills (/create-pr, /create-bug) and shared across tools."

$gitName  = if ((git config --global user.name 2>$null))  { git config --global user.name }  else { "" }
$gitEmail = if ((git config --global user.email 2>$null)) { git config --global user.email } else { "" }

$Name  = Ask-Question "Your name" $gitName
$Email = Ask-Question "Your email" $gitEmail

# ---------------------------------------------------------------------------
# [2/10] Provider
# ---------------------------------------------------------------------------
Write-Header "[2/10] Provider"
Write-Info "Choose your issue tracker / source control provider."
Write-Info "Options: ado (Azure DevOps), github, skip"

$Provider = Ask-Question "Provider" "ado"

# ---------------------------------------------------------------------------
# [3/10] ADO Configuration
# ---------------------------------------------------------------------------
$AdoOrg = ""; $AdoProject = ""; $AdoTeam = ""
$AdoUsers = @(); $AdoPrRepos = @()
$Reviewers = @(); $ReposList = @()

if ($Provider -eq "ado") {
    Write-Header "[3/10] Azure DevOps Configuration"

    $AdoOrg     = Ask-Question "ADO org name (e.g. mycompany)"
    $AdoProject = Ask-Question "ADO project name (e.g. My Project)"
    $AdoTeam    = Ask-Question "ADO team name (e.g. My Team)"

    Write-Host ""
    Write-Info "ADO usernames to track in dashboards. Enter one per line, blank to finish:"
    while ($true) {
        $u = Ask-Question "  ADO user display name (or blank to finish)"
        if ([string]::IsNullOrWhiteSpace($u)) { break }
        $AdoUsers += $u
        Write-Success "Added user: $u"
    }

    Write-Host ""
    Write-Info "ADO repos for PR tracking in the dashboard. Enter repo names, blank to finish:"
    while ($true) {
        $r = Ask-Question "  ADO repo name (or blank to finish)"
        if ([string]::IsNullOrWhiteSpace($r)) { break }
        $AdoPrRepos += $r
        Write-Success "Added PR repo: $r"
    }

    Write-Host ""
    Write-Info "Default PR reviewers (name or email) for Hivemind /create-pr skill."
    Write-Info "Enter one per line, blank to finish:"
    while ($true) {
        $r = Ask-Question "  Reviewer name or email (or blank to finish)"
        if ([string]::IsNullOrWhiteSpace($r)) { break }
        $Reviewers += $r
        Write-Success "Added reviewer: $r"
    }

    Write-Host ""
    Write-Info "Repositories for Hivemind skills (used by /create-pr for branch reset)."
    Write-Info "Enter repo names, blank to finish:"
    while ($true) {
        $r = Ask-Question "  Repo name (or blank to finish)"
        if ([string]::IsNullOrWhiteSpace($r)) { break }
        $ReposList += $r
        Write-Success "Added repo: $r"
    }
} else {
    Write-Header "[3/10] Azure DevOps Configuration"
    Write-Info "Skipped (provider is not ado)."
}

# ---------------------------------------------------------------------------
# [4/10] GitHub Configuration
# ---------------------------------------------------------------------------
$GithubOrg = ""; $GithubUser = ""
$GithubUsers = @(); $GithubPrRepos = @(); $GithubWatchRepos = @()
$DefaultReviewers = @()

if ($Provider -eq "github") {
    Write-Header "[4/10] GitHub Configuration"

    $GithubOrg  = Ask-Question "GitHub org (e.g. mycompany)"
    $GithubUser = Ask-Question "GitHub username"

    Write-Host ""
    Write-Info "GitHub usernames to track in dashboards. Enter one per line, blank to finish:"
    while ($true) {
        $u = Ask-Question "  GitHub username (or blank to finish)"
        if ([string]::IsNullOrWhiteSpace($u)) { break }
        $GithubUsers += $u
        Write-Success "Added user: $u"
    }

    Write-Host ""
    Write-Info "GitHub repos for PR tracking. Format: owner/repo. Blank to finish:"
    while ($true) {
        $r = Ask-Question "  PR repo (owner/repo, or blank to finish)"
        if ([string]::IsNullOrWhiteSpace($r)) { break }
        $GithubPrRepos += $r
        Write-Success "Added PR repo: $r"
    }

    Write-Host ""
    Write-Info "GitHub repos to watch (activity feed). Format: owner/repo. Blank to finish:"
    while ($true) {
        $r = Ask-Question "  Watch repo (owner/repo, or blank to finish)"
        if ([string]::IsNullOrWhiteSpace($r)) { break }
        $GithubWatchRepos += $r
        Write-Success "Added watch repo: $r"
    }

    Write-Host ""
    Write-Info "Default PR reviewers for Hivemind /create-pr skill."
    Write-Info "Enter GitHub usernames, blank to finish:"
    while ($true) {
        $r = Ask-Question "  Reviewer username (or blank to finish)"
        if ([string]::IsNullOrWhiteSpace($r)) { break }
        $DefaultReviewers += $r
        Write-Success "Added reviewer: $r"
    }

    Write-Host ""
    Write-Info "Repositories for Hivemind skills (used by /create-pr for branch reset)."
    Write-Info "Enter repo names, blank to finish:"
    while ($true) {
        $r = Ask-Question "  Repo name (or blank to finish)"
        if ([string]::IsNullOrWhiteSpace($r)) { break }
        $ReposList += $r
        Write-Success "Added repo: $r"
    }
} elseif ($Provider -ne "ado") {
    Write-Header "[4/10] GitHub Configuration"
    Write-Info "Skipped (provider is not github)."
}

# ---------------------------------------------------------------------------
# [5/10] Project Info
# ---------------------------------------------------------------------------
Write-Header "[5/10] Project Info"

$ProjectName    = Ask-Question "Project name (short identifier, e.g. myapp)" "myapp"
$DashboardTitle = Ask-Question "Dashboard title (shown in browser tab)" "H.I.V.E."

# ---------------------------------------------------------------------------
# [6/10] Projects Base Directory
# ---------------------------------------------------------------------------
Write-Header "[6/10] Projects Base Directory"
Write-Info "This is the parent folder where all your repos are cloned."
Write-Info "Example: C:\Users\you\Projects"

$DefaultProjectsDir = Split-Path -Parent $ScriptDir
$ProjectsDir = ""
while ([string]::IsNullOrWhiteSpace($ProjectsDir)) {
    $ProjectsDir = Ask-Question "Projects base directory" $DefaultProjectsDir
    if ([string]::IsNullOrWhiteSpace($ProjectsDir)) {
        Write-Warn "Base directory is required."
    }
}

# ---------------------------------------------------------------------------
# [7/10] Repos to Watch
# ---------------------------------------------------------------------------
Write-Header "[7/10] Repos to Watch"
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
# [8/10] Web Service
# ---------------------------------------------------------------------------
Write-Header "[8/10] Web Service (optional)"
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
# [9/10] API Service & Databases
# ---------------------------------------------------------------------------
Write-Header "[9/10] API Service & Databases (optional)"

Write-Info "-- API Service --"
$ConfigureApi = Ask-Question "Configure API service? (y/n)" "y"
$ApiRepoDir   = ""
$ApiPort      = "3000"
$ApiStartCmd  = "npm run start:dev"

if ($ConfigureApi -in @('y', 'Y')) {
    $ApiRepoDir  = Ask-Question "API repo directory name (relative to projects base)"
    $ApiPort     = Ask-Question "API server port" "3000"
    $ApiStartCmd = Ask-Question "API start command" "npm run start:dev"
}

Write-Host ""
Write-Info "-- Database Connections --"
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

# --- Docs directory ---
Write-Host ""
Write-Info "-- Documentation (optional) --"
Write-Info "Used by Hivemind /create-bug to create bug documentation files."

$DocsDir = ""
$DocsBugsPath = "Bugs/"
$SiblingDocs = Join-Path (Split-Path -Parent $ScriptDir) "docs"

if (Test-Path $SiblingDocs) {
    Write-Success "Found docs sibling at: $SiblingDocs"
    $useDocs = Ask-Question "Use this path? (y/n)" "y"
    if ($useDocs -in @('y', 'Y')) {
        $DocsDir = $SiblingDocs
    }
}

if ([string]::IsNullOrWhiteSpace($DocsDir)) {
    $DocsDir = Ask-Question "Docs directory for bug files (or blank to skip)"
}

if (-not [string]::IsNullOrWhiteSpace($DocsDir)) {
    $DocsBugsPath = Ask-Question "Bugs subdirectory within docs" "Bugs/"
}

# ---------------------------------------------------------------------------
# [10/10] Generate Files
# ---------------------------------------------------------------------------
Write-Header "[10/10] Generating Configuration Files"

# --- Build provider JSON ---
$AdoJson = "null"
if ($Provider -eq "ado" -and -not [string]::IsNullOrWhiteSpace($AdoOrg)) {
    $AdoJson = "{`"org`":$(ConvertTo-JsonString $AdoOrg),`"project`":$(ConvertTo-JsonString $AdoProject),`"team`":$(ConvertTo-JsonString $AdoTeam),`"users`":$(Build-JsonArray $AdoUsers),`"prRepos`":$(Build-JsonArray $AdoPrRepos)}"
}

$GithubJson = "null"
if ($Provider -eq "github" -and -not [string]::IsNullOrWhiteSpace($GithubOrg)) {
    $GithubJson = "{`"org`":$(ConvertTo-JsonString $GithubOrg),`"users`":$(Build-JsonArray $GithubUsers),`"prRepos`":$(Build-JsonArray $GithubPrRepos),`"watchRepos`":$(Build-JsonArray $GithubWatchRepos)}"
}

# --- Build services JSON ---
$WebServiceJson = 'null'
if (-not [string]::IsNullOrWhiteSpace($WebRepoDir)) {
    $WebServiceJson = "{`"repoDir`":$(ConvertTo-JsonString $WebRepoDir),`"port`":$WebPort,`"startCmd`":$(ConvertTo-JsonString $WebStartCmd)}"
}

$ApiServiceJson = 'null'
if (-not [string]::IsNullOrWhiteSpace($ApiRepoDir)) {
    $ApiServiceJson = "{`"repoDir`":$(ConvertTo-JsonString $ApiRepoDir),`"port`":$ApiPort,`"startCmd`":$(ConvertTo-JsonString $ApiStartCmd)}"
}

# --- Repos JSON ---
$ReposJson = Build-JsonArray $Repos

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
  },
  "ado": $AdoJson,
  "github": $GithubJson
}
"@
[System.IO.File]::WriteAllText($ConfigFile, $ConfigContent, [System.Text.UTF8Encoding]::new($false))
Write-Success "Created dashboard.config.json"

# --- data/databases.json ---
$DataDir = Join-Path $ScriptDir 'data'
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }

if ($DbEntries.Count -gt 0) {
    $DbJson = $DbEntries | ConvertTo-Json -Depth 5
    if ($DbEntries.Count -eq 1) { $DbJson = "[$DbJson]" }
    [System.IO.File]::WriteAllText($DatabasesFile, $DbJson, [System.Text.UTF8Encoding]::new($false))
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
    [System.IO.File]::WriteAllText($WebScriptPath, $WebScriptContent, [System.Text.UTF8Encoding]::new($false))
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
    [System.IO.File]::WriteAllText($ApiScriptPath, $ApiScriptContent, [System.Text.UTF8Encoding]::new($false))
    Write-Success "Created run-api.ps1"
}

# --- npm install ---
Write-Host ""
Write-Info "Running npm install..."
Set-Location $ScriptDir
npm install
Write-Success "Dependencies installed"

# --- Shared config: ~/.config/hivemind/config.md ---
Write-Host ""
Write-Info "Writing shared Hivemind config..."
if (-not (Test-Path $SharedConfigDir)) {
    New-Item -ItemType Directory -Path $SharedConfigDir -Force | Out-Null
}

$ReviewersBlock = ""
if ($Reviewers.Count -gt 0) {
    $ReviewersBlock = "reviewers:`n" + ($Reviewers | ForEach-Object { "  - $_" } | Out-String).TrimEnd()
}

$DefaultReviewersBlock = ""
if ($DefaultReviewers.Count -gt 0) {
    $DefaultReviewersBlock = "default_reviewers:`n" + ($DefaultReviewers | ForEach-Object { "  - $_" } | Out-String).TrimEnd()
}

$ReposListBlock = ""
if ($ReposList.Count -gt 0) {
    $ReposListBlock = "repos:`n" + ($ReposList | ForEach-Object { "  - $_" } | Out-String).TrimEnd()
}

$SharedContent = @"
# Hivemind Config
# Generated by H.I.V.E. setup — re-run hive/setup.ps1 to update.
# Location: ~/.config/hivemind/config.md

provider: ${Provider}

## Identity
name: ${Name}
email: ${Email}

## ADO Configuration (if provider: ado)
ado_org: ${AdoOrg}
ado_project: ${AdoProject}

${ReviewersBlock}

${ReposListBlock}

## GitHub Configuration (if provider: github)
github_org: ${GithubOrg}
github_user: ${GithubUser}

${DefaultReviewersBlock}

## Paths
projects_dir: ${ProjectsDir}
hive_dir: ${ScriptDir}

## Docs (optional — for bug documentation)
docs_dir: ${DocsDir}
docs_bugs_path: ${DocsBugsPath}
"@

[System.IO.File]::WriteAllText($SharedConfigFile, $SharedContent, [System.Text.UTF8Encoding]::new($false))
Write-Success "Created $SharedConfigFile"

# --- paths.env ---
$PathsContent = "HIVE_DIR=`"$ScriptDir`"`nPROJECTS_DIR=`"$ProjectsDir`""
[System.IO.File]::WriteAllText($PathsEnvFile, $PathsContent, [System.Text.UTF8Encoding]::new($false))
Write-Success "Created $PathsEnvFile"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host ("=" * 62) -ForegroundColor Green
Write-Host "  H.I.V.E. setup complete!" -ForegroundColor Green
Write-Host ("=" * 62) -ForegroundColor Green
Write-Host ""
Write-Host "  Start the dashboard:" -ForegroundColor White
Write-Host "    node server.mjs" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Then open:  " -NoNewline -ForegroundColor White
Write-Host "http://localhost:3333" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Generated files (gitignored — local only):" -ForegroundColor Cyan
Write-Host "    dashboard.config.json"
Write-Host "    data\databases.json"
if (-not [string]::IsNullOrWhiteSpace($WebRepoDir)) { Write-Host "    run-web.ps1" }
if (-not [string]::IsNullOrWhiteSpace($ApiRepoDir)) { Write-Host "    run-api.ps1" }
Write-Host "    $SharedConfigFile"
Write-Host "    $PathsEnvFile"
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White
Write-Host "    1. Clone Hivemind (if not already) and run its setup.ps1"
Write-Host "       It will detect the config you just created."
Write-Host "    2. Start Claude with: claude --add-dir C:\path\to\hivemind" -ForegroundColor Cyan
Write-Host ""
