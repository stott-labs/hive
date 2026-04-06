# Getting Started

This guide walks through installing all three projects. Each is independent — you can install just HIVE, or just Hivemind — but they're designed to work together.

## Prerequisites

- **Node.js 18+** — Required for HIVE and Drone
- **Git** — Required for all projects
- **Claude Code CLI** — Required for Hivemind skills (`npm install -g @anthropic-ai/claude-code`)
- **Azure DevOps** or **GitHub** account — Optional, for work item and PR integration

## Step 1: Install H.I.V.E.

```bash
git clone https://github.com/your-org/hive.git
cd hive
npm install
```

Run the interactive setup wizard:

```bash
# macOS / Linux
./setup.sh

# Windows (PowerShell)
.\setup.ps1
```

The wizard walks through:

1. **Identity** — Your name and email (pre-filled from `git config`)
2. **Provider** — Azure DevOps, GitHub, or skip
3. **Provider config** — Org, project, team, users, repos
4. **Projects directory** — Where your repos live on disk
5. **Repos to watch** — Which repo directories to monitor
6. **Services** — Web and API server ports, start commands, repo directories
7. **Databases** — PostgreSQL connections (optional)

This generates `dashboard.config.json` and writes shared config to `~/.config/hivemind/`.

### Launch the dashboard

```bash
# From any Claude Code session (if Hivemind is installed):
/dashboard

# Or directly:
npm start
```

Open `http://localhost:3333` in your browser.

---

## Step 2: Install Drone (Optional)

Drone is only needed for demos. Skip this if you have real repos and services to monitor.

```bash
cd ../
git clone https://github.com/your-org/drone.git
cd drone
npm install
npm start
```

Drone starts on port 4000. Configure HIVE to use it:

```bash
node setup.mjs
```

This calls HIVE's config API to add Drone's mock endpoints (health checks, Sentry, ADO) and adds the drone repo to HIVE's watch list.

Add dummy tokens to HIVE's `.env`:

```
SENTRY_AUTH_TOKEN=drone-demo
ADO_PAT=drone-demo
```

Restart HIVE. The dashboard now shows live demo data. Open `http://localhost:4000/control` for the Drone control panel.

---

## Step 3: Install Hivemind

```bash
cd ../
git clone https://github.com/your-org/hivemind.git
cd hivemind
```

Run setup:

```bash
# macOS / Linux
./setup.sh

# Windows (PowerShell)
.\setup.ps1
```

If HIVE was already installed, setup detects your existing config and skips the identity/provider questions. It:

1. Creates symlinks for all skills in `~/.claude/skills/`
2. Creates a platform-level `CLAUDE.md` in your projects directory
3. Updates `~/.config/hivemind/paths.env` with directory paths
4. Optionally installs Claude Code hooks for dashboard notifications

### Activate Hivemind

Add it to your shell profile so it loads in every Claude session:

```bash
# ~/.zshrc or ~/.bashrc
alias claude='claude --add-dir /path/to/hivemind'
```

```powershell
# PowerShell $PROFILE
function claude { & claude.exe --add-dir 'C:\path\to\hivemind' @args }
```

Now every Claude Code session has access to all Hivemind skills: `/prd`, `/create-pr`, `/create-bug`, `/repos`, `/dashboard`, and more.

---

## Verify Everything Works

1. **HIVE**: Open `http://localhost:3333` — you should see the dashboard with your configured widgets
2. **Drone** (if installed): Open `http://localhost:4000/control` — run the "Steady State" scenario and watch HIVE update
3. **Hivemind**: In any Claude Code session, type `/repos` — you should see a status table of all your repos

## Environment Variables

These are never committed. Set them in HIVE's `.env` file or your shell environment:

| Variable | Required For | Purpose |
|----------|-------------|---------|
| `ADO_PAT` | Azure DevOps widgets | Personal Access Token |
| `GITHUB_TOKEN` | GitHub widgets | Personal Access Token |
| `SENTRY_AUTH_TOKEN` | Sentry widget | Auth token |
| `PORT` | HIVE | Dashboard port (default: 3333) |

## Next Steps

- [Configure HIVE widgets and layouts](hive/configuration.md)
- [Learn about all available widgets](hive/widgets.md)
- [Create custom SQL metric widgets](guides/creating-metrics.md)
- [Build your own widget](guides/creating-widgets.md)
- [Explore Hivemind skills](hivemind/skills.md)
- [Set up Drone scenarios for demos](drone/scenarios.md)
