#!/bin/bash
# =============================================================================
# H.I.V.E. Setup — Hub for Integrated Visualization & Exploration
# Interactive CLI to generate dashboard.config.json and data files.
# Re-run at any time to update your configuration.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/dashboard.config.json"
DATABASES_FILE="$SCRIPT_DIR/data/databases.json"
HIVEMIND_PATHS_DIR="$HOME/.config/hivemind"
HIVEMIND_PATHS_FILE="$HIVEMIND_PATHS_DIR/paths.env"

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

header()  { echo -e "\n${CYAN}${BOLD}$1${RESET}"; echo -e "${CYAN}$(printf -- '-%.0s' {1..60})${RESET}"; }
success() { echo -e "${GREEN}+  $1${RESET}"; }
info()    { echo -e "${CYAN}ℹ  $1${RESET}"; }
warn()    { echo -e "${YELLOW}⚠  $1${RESET}"; }
prompt()  { echo -e "${BOLD}$1${RESET}"; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ask() {
  # ask "Question" default_value → prints to stderr, result in $REPLY
  local question="$1"
  local default="${2:-}"
  if [[ -n "$default" ]]; then
    printf "${BOLD}%s${RESET} ${CYAN}[%s]${RESET}: " "$question" "$default" >&2
  else
    printf "${BOLD}%s${RESET}: " "$question" >&2
  fi
  read -r REPLY
  if [[ -z "$REPLY" && -n "$default" ]]; then
    REPLY="$default"
  fi
}

json_str() {
  # Escape a string for JSON embedding
  printf '%s' "$1" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null \
    || printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}${BOLD}"
echo "  ██╗  ██╗  ██╗██╗   ██╗███████╗"
echo "  ██║  ██║  ██║██║   ██║██╔════╝"
echo "  ███████║  ██║██║   ██║█████╗  "
echo "  ██╔══██║  ██║╚██╗ ██╔╝██╔══╝  "
echo "  ██║  ██║  ██║ ╚████╔╝ ███████╗"
echo "  ╚═╝  ╚═╝  ╚═╝  ╚═══╝  ╚══════╝"
echo -e "${RESET}"
echo -e "${BOLD}  Hub for Integrated Visualization & Exploration${RESET}"
echo -e "  Setup CLI — re-run any time to update your config"
echo ""

# ---------------------------------------------------------------------------
# Check for existing config
# ---------------------------------------------------------------------------
if [[ -f "$CONFIG_FILE" ]]; then
  warn "dashboard.config.json already exists."
  ask "Update it? (y/n)" "y"
  if [[ "$REPLY" != "y" && "$REPLY" != "Y" ]]; then
    info "Aborted. No changes made."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# [1/8] Project Info
# ---------------------------------------------------------------------------
header "[1/8] Project Info"

ask "Project name (short identifier, e.g. myapp)" "myapp"
PROJECT_NAME="$REPLY"

ask "Dashboard title (shown in browser tab)" "H.I.V.E."
DASHBOARD_TITLE="$REPLY"

# ---------------------------------------------------------------------------
# [2/8] Projects Base Directory
# ---------------------------------------------------------------------------
header "[2/8] Projects Base Directory"
info "This is the parent folder where all your repos are cloned."
info "Example: /Users/you/Projects or /c/Users/you/Projects"

DEFAULT_PROJECTS_DIR="$(dirname "$SCRIPT_DIR")"
ask "Projects base directory" "$DEFAULT_PROJECTS_DIR"
while [[ -z "$REPLY" ]]; do
  warn "Base directory is required."
  ask "Projects base directory" "$DEFAULT_PROJECTS_DIR"
done
PROJECTS_DIR="$REPLY"

# ---------------------------------------------------------------------------
# [3/8] Repos to Watch
# ---------------------------------------------------------------------------
header "[3/8] Repos to Watch"
info "Enter repo directory names (relative to your projects base directory)."
info "Press Enter with no input when done."

REPOS_JSON="[]"
REPOS=()
while true; do
  ask "Repo name (blank to stop)" ""
  [[ -z "$REPLY" ]] && break
  REPOS+=("$REPLY")
  success "Added: $REPLY"
done

if [[ ${#REPOS[@]} -gt 0 ]]; then
  REPOS_JSON="["
  for i in "${!REPOS[@]}"; do
    REPOS_JSON+="$(json_str "${REPOS[$i]}")"
    [[ $i -lt $((${#REPOS[@]} - 1)) ]] && REPOS_JSON+=","
  done
  REPOS_JSON+="]"
fi

# ---------------------------------------------------------------------------
# [4/8] Web Service
# ---------------------------------------------------------------------------
header "[4/8] Web Service (optional)"
info "Configure your frontend dev server (e.g. Vue, React)."

ask "Configure web service? (y/n)" "y"
CONFIGURE_WEB="$REPLY"

WEB_REPO_DIR=""
WEB_PORT="8080"
WEB_START_CMD="npm run dev"

if [[ "$CONFIGURE_WEB" == "y" || "$CONFIGURE_WEB" == "Y" ]]; then
  ask "Web repo directory name (relative to projects base)" ""
  WEB_REPO_DIR="$REPLY"
  ask "Web dev server port" "8080"
  WEB_PORT="$REPLY"
  ask "Web start command" "npm run dev"
  WEB_START_CMD="$REPLY"
fi

# ---------------------------------------------------------------------------
# [5/8] API Service
# ---------------------------------------------------------------------------
header "[5/8] API Service (optional)"
info "Configure your backend API dev server."

ask "Configure API service? (y/n)" "y"
CONFIGURE_API="$REPLY"

API_REPO_DIR=""
API_PORT="3000"
API_START_CMD="npm run start:dev"

if [[ "$CONFIGURE_API" == "y" || "$CONFIGURE_API" == "Y" ]]; then
  ask "API repo directory name (relative to projects base)" ""
  API_REPO_DIR="$REPLY"
  ask "API server port" "3000"
  API_PORT="$REPLY"
  ask "API start command" "npm run start:dev"
  API_START_CMD="$REPLY"
fi

# ---------------------------------------------------------------------------
# [6/8] Database Connections
# ---------------------------------------------------------------------------
header "[6/8] Database Connections (optional)"
info "Add PostgreSQL connections for DB Explorer and SQL metric widgets."

ask "Add database connections? (y/n)" "y"
CONFIGURE_DBS="$REPLY"

DB_ENTRIES=()

if [[ "$CONFIGURE_DBS" == "y" || "$CONFIGURE_DBS" == "Y" ]]; then
  while true; do
    echo ""
    info "New database connection (blank ID to stop):"
    ask "Connection ID (e.g. local, staging)" ""
    [[ -z "$REPLY" ]] && break
    DB_ID="$REPLY"

    ask "Label (display name)" "$DB_ID"
    DB_LABEL="$REPLY"

    ask "Host" "localhost"
    DB_HOST="$REPLY"

    ask "Port" "5432"
    DB_PORT="$REPLY"

    ask "User" "postgres"
    DB_USER="$REPLY"

    ask "Password" ""
    DB_PASS="$REPLY"

    ask "Database name" ""
    DB_NAME="$REPLY"

    DB_ENTRIES+=("{\"id\":$(json_str "$DB_ID"),\"label\":$(json_str "$DB_LABEL"),\"host\":$(json_str "$DB_HOST"),\"port\":$DB_PORT,\"user\":$(json_str "$DB_USER"),\"password\":$(json_str "$DB_PASS"),\"database\":$(json_str "$DB_NAME")}")
    success "Added connection: $DB_ID ($DB_HOST/$DB_NAME)"
  done
fi

# ---------------------------------------------------------------------------
# [7/8] Hivemind Integration
# ---------------------------------------------------------------------------
header "[7/8] Hivemind Integration (optional)"
info "Hivemind is the Claude Code shared config system that adds /dashboard and other skills."

HIVEMIND_DIR=""
SIBLING_HIVEMIND="$(dirname "$SCRIPT_DIR")/hivemind"

if [[ -d "$SIBLING_HIVEMIND" ]]; then
  success "Found Hivemind at: $SIBLING_HIVEMIND"
  ask "Use this Hivemind installation? (y/n)" "y"
  if [[ "$REPLY" == "y" || "$REPLY" == "Y" ]]; then
    HIVEMIND_DIR="$SIBLING_HIVEMIND"
  fi
else
  ask "Path to Hivemind directory (blank to skip)" ""
  if [[ -n "$REPLY" ]]; then
    if [[ -d "$REPLY" ]]; then
      HIVEMIND_DIR="$REPLY"
      success "Hivemind set to: $HIVEMIND_DIR"
    else
      warn "Directory not found — skipping Hivemind integration."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# [8/8] Generate Files
# ---------------------------------------------------------------------------
header "[8/8] Generating Configuration Files"

# --- dashboard.config.json ---
WEB_SERVICE_JSON="null"
if [[ -n "$WEB_REPO_DIR" ]]; then
  WEB_SERVICE_JSON="{\"repoDir\":$(json_str "$WEB_REPO_DIR"),\"port\":$WEB_PORT,\"startCmd\":$(json_str "$WEB_START_CMD")}"
fi

API_SERVICE_JSON="null"
if [[ -n "$API_REPO_DIR" ]]; then
  API_SERVICE_JSON="{\"repoDir\":$(json_str "$API_REPO_DIR"),\"port\":$API_PORT,\"startCmd\":$(json_str "$API_START_CMD")}"
fi

cat > "$CONFIG_FILE" <<CONFIGEOF
{
  "project": $(json_str "$PROJECT_NAME"),
  "title": $(json_str "$DASHBOARD_TITLE"),
  "projectsDir": $(json_str "$PROJECTS_DIR"),
  "repos": $REPOS_JSON,
  "services": {
    "web": $WEB_SERVICE_JSON,
    "api": $API_SERVICE_JSON
  }
}
CONFIGEOF
success "Created dashboard.config.json"

# --- data/databases.json ---
mkdir -p "$SCRIPT_DIR/data"
if [[ ${#DB_ENTRIES[@]} -gt 0 ]]; then
  printf '[\n' > "$DATABASES_FILE"
  for i in "${!DB_ENTRIES[@]}"; do
    printf '  %s' "${DB_ENTRIES[$i]}" >> "$DATABASES_FILE"
    [[ $i -lt $((${#DB_ENTRIES[@]} - 1)) ]] && printf ',' >> "$DATABASES_FILE"
    printf '\n' >> "$DATABASES_FILE"
  done
  printf ']\n' >> "$DATABASES_FILE"
  success "Created data/databases.json (${#DB_ENTRIES[@]} connection(s))"
else
  printf '[]\n' > "$DATABASES_FILE"
  info "Created data/databases.json (empty — add connections later)"
fi

# --- run-web.sh ---
if [[ -n "$WEB_REPO_DIR" ]]; then
  cat > "$SCRIPT_DIR/run-web.sh" <<WEBEOF
#!/bin/bash
cd "$(json_str "$PROJECTS_DIR/$WEB_REPO_DIR" | tr -d '"')"
$WEB_START_CMD
WEBEOF
  chmod +x "$SCRIPT_DIR/run-web.sh"
  success "Created run-web.sh"
fi

# --- run-api.sh ---
if [[ -n "$API_REPO_DIR" ]]; then
  cat > "$SCRIPT_DIR/run-api.sh" <<APIEOF
#!/bin/bash
cd "$(json_str "$PROJECTS_DIR/$API_REPO_DIR" | tr -d '"')"
$API_START_CMD
APIEOF
  chmod +x "$SCRIPT_DIR/run-api.sh"
  success "Created run-api.sh"
fi

# --- npm install ---
echo ""
info "Running npm install..."
cd "$SCRIPT_DIR"
npm install
success "Dependencies installed"

# --- ~/.config/hivemind/paths.env ---
mkdir -p "$HIVEMIND_PATHS_DIR"
{
  echo "HIVE_DIR=$(json_str "$SCRIPT_DIR" | tr -d '"')"
  [[ -n "$HIVEMIND_DIR" ]] && echo "HIVEMIND_DIR=$(json_str "$HIVEMIND_DIR" | tr -d '"')"
} > "$HIVEMIND_PATHS_FILE"
success "Written $HIVEMIND_PATHS_FILE"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  H.I.V.E. setup complete!${RESET}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${BOLD}Start the dashboard:${RESET}"
echo -e "  ${CYAN}  npm start${RESET}"
echo ""
echo -e "  ${BOLD}Then open:${RESET}  ${CYAN}http://localhost:3333${RESET}"
echo ""

if [[ -n "$HIVEMIND_DIR" ]]; then
  echo -e "  ${YELLOW}${BOLD}Hivemind found!${RESET} Run the following to complete integration:"
  echo -e "  ${CYAN}  cd $(json_str "$HIVEMIND_DIR" | tr -d '"') && ./setup.sh${RESET}"
  echo ""
fi

echo -e "  ${CYAN}Generated files (gitignored — local only):${RESET}"
echo -e "    dashboard.config.json"
echo -e "    data/databases.json"
[[ -n "$WEB_REPO_DIR" ]] && echo -e "    run-web.sh"
[[ -n "$API_REPO_DIR" ]] && echo -e "    run-api.sh"
echo -e "    $HIVEMIND_PATHS_FILE"
echo ""
