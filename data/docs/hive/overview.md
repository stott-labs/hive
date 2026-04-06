# H.I.V.E. — Overview

**H.I.V.E.** (Hub for Integrated Visualization & Exploration) is a self-hosted, browser-based developer dashboard that consolidates your entire development environment into a single tab.

## What It Does

HIVE runs as a Node.js server (Express + Socket.IO) with a vanilla JavaScript frontend. Layout is managed by GridStack.js — every panel is a draggable, resizable widget. The server watches your repos, streams your logs, polls your services, and proxies your API calls. The browser renders it all in real time.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Express.js 4.21 + Socket.IO 4.8 |
| Frontend | Vanilla JS — no framework, no bundler |
| Layout | GridStack.js 10 (drag/resize grid) |
| Database | PostgreSQL via `pg` 8.13 (optional) |
| Styles | Catppuccin Mocha theme (CSS custom properties) |
| Markdown | marked.js for docs rendering |
| Syntax | highlight.js with Catppuccin theme |
| Logs | AnsiUp for ANSI color rendering |

## Architecture

```
Browser (localhost:3333)
  ├── index.html          Single-page shell
  ├── app.js              Grid, tabs, widget lifecycle, Socket.IO client
  ├── style.css           Catppuccin Mocha theme (CSS custom properties)
  ├── widgets/*.js        20 widget files, each self-registering
  ├── db.js               Database explorer UI
  ├── docs.js             Markdown docs browser + editor
  ├── repo.js             Repository file browser + git operations
  ├── settings.js         Configuration editor
  └── swagger.js          OpenAPI/Swagger browser

Server (server.mjs — ~5700 lines)
  ├── Configuration       dashboard.config.json loading, .env parsing
  ├── Log streaming       fs.watch-based passive tail (zero CPU when idle)
  ├── Git tracking        Periodic git status across all repos
  ├── Service monitoring  TCP port checks, HTTP health polling
  ├── Database layer      pg pool management, schema introspection
  ├── REST API            40+ endpoints for all features
  ├── Socket.IO           Real-time push for logs, status, events
  ├── API proxy           HTTP forwarding with streaming support
  └── Mock/Integration    ADO, GitHub, Sentry API wrappers
```

## Key Design Decisions

**Vanilla JS, no framework.** Every widget is a plain object with `init`, `refresh`, and `destroy` methods. No React, no Vue, no build step. The tradeoff is more manual DOM management; the payoff is zero build complexity and instant startup.

**Passive log streaming.** Logs are tailed using `fs.watch` — OS kernel notifications, not polling. CPU usage is zero when no logs are being written. When bytes are appended, the server reads only the new portion and pushes it via Socket.IO.

**Detached process model.** The dashboard runs independently of Claude Code. Launch it with `/dashboard` and it survives session restarts, context compression, and terminal closes. Stop it explicitly with `/dashboard stop`.

**File-based data.** Collections, environments, metrics, layouts, and database configs are all JSON files in the `data/` directory. No external database required for the dashboard itself.

## Feature Highlights

- **20+ pre-built widgets** — Git status, service logs, ADO kanban, GitHub PRs, Sentry errors, contribution grids, and more
- **Custom SQL metrics** — Create dashboard widgets from any SELECT query against your PostgreSQL databases, with 7 visualization types
- **Built-in API client** — Test endpoints with environment variables, import Postman collections, stream NDJSON responses
- **Docs browser** — Browse and edit markdown files with git integration, search, and syntax highlighting
- **Database explorer** — Schema browser, table viewer, SQL script editor with execution
- **Real-time everything** — Socket.IO pushes log lines, git status changes, and health check results as they happen
- **Named layouts** — Save different widget arrangements for different workflows (coding, reviewing, debugging)
- **Audio alarms** — External service monitors can trigger audio alarms when services go down

## File Structure

```
hive/
├── server.mjs                    Main server
├── setup.sh / setup.ps1          Interactive setup wizard
├── dashboard.config.json         Configuration (gitignored)
├── dashboard.config.example.json Template
├── .env                          Credentials (gitignored)
│
├── public/                       Frontend
│   ├── index.html                Page shell
│   ├── app.js                    Core app + grid
│   ├── style.css                 Theme
│   ├── db.js                     Database explorer
│   ├── docs.js                   Docs browser
│   ├── repo.js                   Repo browser
│   ├── settings.js               Settings UI
│   ├── swagger.js                OpenAPI browser
│   └── widgets/                  20 widget files
│
├── data/                         Runtime data (gitignored)
│   ├── api/                      API collections + environments
│   ├── docs/                     Documentation files
│   ├── databases.json            DB connections
│   ├── metrics.json              SQL metric definitions
│   └── layouts.json              Saved grid layouts
│
└── .claude/skills/               Claude Code skills
    └── dashboard/                Dashboard launcher skill
```

## What's Next

- [All widgets explained](widgets.md)
- [Configuration reference](configuration.md)
- [Server API reference](server-api.md)
- [Creating custom widgets](../guides/creating-widgets.md)
- [Creating SQL metric widgets](../guides/creating-metrics.md)
