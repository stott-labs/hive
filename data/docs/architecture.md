# Platform Architecture

This document describes how HIVE, Hivemind, and Drone fit together as a system.

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Developer's Machine                                            │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   HIVE       │    │   Hivemind   │    │   Drone      │      │
│  │   :3333      │    │  (--add-dir) │    │   :4000      │      │
│  │              │    │              │    │              │      │
│  │  Dashboard   │◄───│  Skills      │    │  Simulator   │      │
│  │  Server      │    │  Config      │    │  Mock APIs   │      │
│  │  Socket.IO   │◄───┤  Hooks       │    │  Git Engine  │      │
│  │  REST API    │◄───────────────────────│  Scenarios   │      │
│  └──────┬───────┘    └──────────────┘    └──────────────┘      │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐                                               │
│  │  Browser     │                                               │
│  │  GridStack   │                                               │
│  │  Widgets     │                                               │
│  │  Socket.IO   │                                               │
│  └──────────────┘                                               │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  Repo: API   │  │  Repo: Web   │  │  Repo: DB    │  ...    │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│                                                                 │
│  ┌──────────────────────────────────────────┐                  │
│  │  ~/.config/hivemind/                      │                  │
│  │    config.md     (shared config)          │                  │
│  │    paths.env     (directory discovery)    │                  │
│  └──────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────┘

External Services (optional)
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Azure DevOps │  │  GitHub      │  │  Sentry      │
│  (MCP / REST) │  │  (gh CLI)    │  │  (REST API)  │
└──────────────┘  └──────────────┘  └──────────────┘
```

## Communication Paths

### HIVE ← Repos (File System)

HIVE monitors repositories by reading the file system directly:
- **Git status** — `git status`, `git log`, `git branch` commands
- **Log streaming** — `fs.watch` on log files (OS kernel notifications)
- **Config files** — Reads `.env`, `releases.json`, migration files

### HIVE ← External APIs (HTTP)

HIVE calls external services on behalf of widgets:
- **Azure DevOps** — REST API with `ADO_PAT` authentication
- **GitHub** — REST API with `GITHUB_TOKEN` authentication
- **Sentry** — REST API with `SENTRY_AUTH_TOKEN` authentication
- **Health checks** — HTTP GET to configured URLs

### HIVE ← Drone (HTTP)

When Drone is running, HIVE's external API calls are redirected to Drone's mock endpoints via `sentryBaseUrl` and `adoBaseUrl` config overrides. Health checks point to Drone's health endpoints. This is transparent to HIVE's code — it doesn't know whether it's talking to real APIs or Drone.

### HIVE ← Hivemind (HTTP + File System)

- **Dashboard notifications** — Hivemind's Claude Code hooks POST to `http://localhost:3333/api/claude/notify` when Claude is awaiting input
- **Shared config** — Both read `~/.config/hivemind/config.md` and `paths.env`
- **Dashboard launch** — Hivemind's `/dashboard` skill starts HIVE's server process

### Hivemind ← Claude Code (Symlinks)

Skills are installed as symlinks from `~/.claude/skills/` to `hivemind/.claude/skills/`. Claude Code discovers them at session start. The `--add-dir` flag adds Hivemind's directory to Claude's context.

## Data Flow

### Real-Time Push (Socket.IO)

```
Log file appended → fs.watch fires → server reads new bytes → Socket.IO emit → browser renders
Git change detected → git status runs → Socket.IO emit → widget updates
Health check completes → result compared → Socket.IO emit → status card updates
```

### Request/Response (REST)

```
Widget refresh click → fetch('/api/...') → server processes → JSON response → widget re-renders
Settings change → PUT /api/config → server writes dashboard.config.json → response
SQL metric query → POST /api/metrics/:id/query → pg.Pool query → result → widget renders
```

### File-Based Persistence

```
Layout change → PUT /api/layouts → server writes data/layouts.json
Metric created → PUT /api/metrics/:id → server writes data/metrics.json
Collection saved → PUT /api/collections → server writes data/api/collections.json
Docs edited → PUT /api/docs/file → server writes to docsDir
```

## Process Model

### HIVE Server

Runs as a detached Node.js process. Not tied to any terminal or Claude session. Started by `/dashboard` skill or `npm start` directly. Listens on port 3333.

**Background workers:**
- Git status poller (~5s interval)
- External service monitors (configurable interval, default 30s)
- Log file watchers (event-driven, zero CPU when idle)

### Drone Server

Independent Express process on port 4000. Runs a background tick loop (10s default) for micro-mutations. Scenarios execute as timed step sequences.

### Claude Code Session

Ephemeral. Loads Hivemind skills via `--add-dir`. Skills execute as part of the Claude conversation. The `/dashboard` skill can start/stop HIVE but doesn't depend on it running.

## Security Model

### Credentials

- Stored in `.env` files (gitignored)
- Never committed, never sent to the browser
- Passwords masked in API responses (`/api/db/connections`, `/api/env`)

### SQL Validation

All SQL queries from the browser are validated server-side. Only `SELECT` is allowed. `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `GRANT`, `REVOKE` are rejected.

### Network Scope

Everything runs on `localhost`. No ports are exposed externally by default. CORS is enabled for local development.

### File Access

HIVE can read/write files within configured repo directories and the data directory. The docs editor writes to the configured `docsDir`. The file browser is scoped to `projectsDir`.
