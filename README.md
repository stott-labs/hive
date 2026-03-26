# H.I.V.E.
### Hub for Integrated Visualization & Exploration

A developer dashboard for monitoring git repos, streaming service logs, tracking external service health, and running custom SQL metrics — all in a single browser tab.

## Features

- **Git Status** — live status for all your repos (branch, dirty files, ahead/behind), refreshes every 5s
- **Log Streaming** — tail Web and API dev server logs in real time
- **External Monitors** — HTTP health checks for your services with alarm sounds when they go down
- **SQL Metric Widgets** — write custom SELECT queries, visualize results as number metrics, tables, charts, gauges, and more
- **Database Explorer** — browse and run queries against configured PostgreSQL connections
- **API Collections** — lightweight HTTP client built into the dashboard
- **Docs Viewer** — render markdown documentation from your repos
- **Widget Grid** — drag, resize, and save your layout with GridStack

## Tech Stack

- **Server:** Express.js + Socket.IO
- **Frontend:** Vanilla JS, no bundler
- **Layout:** GridStack.js
- **Database:** PostgreSQL via `pg`
- **Styles:** Catppuccin Mocha theme

## Setup

### First time

```bash
# macOS / Linux
./setup.sh

# Windows (PowerShell)
.\setup.ps1
```

The setup CLI will ask you a few questions and generate all config files. Re-run at any time to update your config.

### What setup creates

| File | Purpose |
|---|---|
| `dashboard.config.json` | Project repos, services, monitors, integrations |
| `data/databases.json` | PostgreSQL connection strings |
| `run-web.sh` / `run-web.ps1` | Launch script for your web dev server |
| `run-api.sh` / `run-api.ps1` | Launch script for your API dev server |

All generated files are gitignored — they never leave your machine.

## Running

```bash
node server.mjs
# or with a custom port:
PORT=4000 node server.mjs
```

Open `http://localhost:3333` (or your configured port).

## Better together: Hivemind

H.I.V.E. pairs with **[Hivemind](https://github.com/YOUR_ORG/hivemind)** — a Claude Code shared config system. With Hivemind installed, you get the `/dashboard` skill which launches H.I.V.E. directly from Claude, plus team-shared skills for PRs, bugs, and more.

Each works independently. Both installed = full experience.

## SQL Metric Widgets

The **Metric Creator** lets you write custom SELECT queries and turn results into dashboard widgets. Queries run directly against your configured PostgreSQL connections. Only SELECT statements are allowed — INSERT/UPDATE/DELETE/DROP are blocked server-side.

Widget types: Number Metric, Delta Metric, Table List, Key/Value Card, Bar Chart, Status Badges, Gauge.

Saved metrics live in `data/metrics.json` (gitignored — your queries stay local).

## Config Reference

See `dashboard.config.example.json` for a fully documented configuration template.
