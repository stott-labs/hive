# Drone — Overview

**Drone** is a demo simulator for HIVE. It generates realistic development activity — real git commits, mock Sentry errors, fake ADO work items, service health fluctuations — so the HIVE dashboard comes alive without needing a real multi-service development environment.

## Why It Exists

Demoing HIVE with a live environment requires running services, real ADO/GitHub accounts, actual Sentry projects, and active development happening in real time. That's a lot of moving parts for a demo.

Drone replaces all of it. Start it up, run a scenario, and watch HIVE's widgets populate with correlated, realistic data.

## What It Generates

| HIVE Widget | What Drone Produces | How |
|-------------|-------------------|-----|
| **Git Status** | Real commits to the drone repo | `git commit` with author overrides |
| **Commit History** | Conventional commits from a 4-person team | Templates: feat/fix/refactor/test/chore/docs |
| **Contributions** | Activity heatmap data | Real commit timestamps |
| **External Services** | HTTP health endpoints with variable latency | 4 services with operational/degraded/down states |
| **Releases** | Version history in `data/releases.json` | Auto-incrementing patch versions |
| **Env Diff** | `.env.dev`, `.env.qa`, `.env.prod` files | Deliberate mismatches for drift detection |
| **Sentry** | Mock Sentry API with error issues | Titles, culprits, counts, event details |
| **Azure DevOps** | Mock ADO API with work items and pipelines | State transitions, PRs, approvals |

## Architecture

Drone is intentionally minimal — a single Express server with a modular engine architecture:

```
drone/
├── server.mjs              Express app + background tick loop
├── setup.mjs               One-time HIVE configuration
├── lib/
│   ├── state.mjs           Central state machine
│   ├── data.mjs            Seed data (team, templates, errors)
│   ├── git-engine.mjs      Real git commit generation
│   ├── env-engine.mjs      Environment file writer
│   ├── release-engine.mjs  Release publisher
│   ├── health-endpoints.mjs  HTTP health routes
│   ├── mock-sentry.mjs     Sentry API mock
│   ├── mock-ado.mjs        ADO API mock
│   └── scenarios.mjs       Scenario engine
└── control/
    └── index.html          Browser control panel
```

**Total dependencies:** 1 (Express). Everything else is built with Node.js standard library.

## The Simulated Team

Drone simulates a 4-person development team:

| Name | Role |
|------|------|
| Sarah Chen | Backend lead |
| Marcus Rivera | Frontend developer |
| Priya Patel | Full-stack developer |
| James Okafor | DevOps engineer |

Commits are attributed to random team members with realistic conventional commit messages across 8 domains: api, web, auth, db, jobs, payments, notifications, search.

## Key Design Decisions

**Real artifacts, not mocked widgets.** Drone doesn't inject data into HIVE's UI. It creates real git commits, writes real files, and serves real HTTP endpoints. HIVE consumes them through its normal data paths — the same code that reads your actual git status reads Drone's git status.

**Correlated events.** Scenarios don't generate random data. They tell coherent stories: an API degrades → Sentry errors spike → a bug is created → a hotfix is committed → the service recovers → a release is cut. Every widget updates as part of the same narrative.

**Background micro-mutations.** Between scenarios, a tick system generates small changes every 10 seconds — service latency jitter, occasional commits, error count bumps, pipeline state advances. This keeps the dashboard feeling alive.

## Quick Start

```bash
cd drone
npm install
npm start          # Full simulation with auto-commits
# or
npm run start:quiet  # No auto-commits (quieter for development)
```

Configure HIVE to use Drone:

```bash
node setup.mjs
```

Add dummy tokens to HIVE's `.env`:
```
SENTRY_AUTH_TOKEN=drone-demo
ADO_PAT=drone-demo
```

Restart HIVE. Open `http://localhost:4000/control` for the control panel.

## What's Next

- [Scenarios and control panel](scenarios.md)
- [Setting up Drone with HIVE](setup.md)
