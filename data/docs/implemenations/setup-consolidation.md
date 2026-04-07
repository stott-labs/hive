---
type: Implementation Note
status: active
---

# One-Line Setup Consolidation

**Date:** 2026-03  
**Related ADR:** [[decisions/010-drone-demo-companion]]  
**Related:** [[implemenations/setup-changes]] (original review)

## Problem

The original setup experience required 3 repo clones, 3 install steps, 3 setup scripts, 2 manual config edits, and a restart — with ordering dependencies that weren't documented. The [[implemenations/setup-changes|setup experience review]] identified this as the biggest barrier to adoption.

A user evaluating the platform had to understand the relationship between HIVE, Drone, and Hivemind before they could see anything work. Most would bail before step 2.

## What Changed

### Demo Mode in Setup Scripts

Both `setup.ps1` and `setup.sh` gained a demo mode branch at the start:

```
Would you like to:
  [1] Full setup (configure your repos, services, and integrations)
  [2] Demo mode (minimal config — pair with Drone)
```

Demo mode auto-detects the parent directory, checks for a `drone` sibling, and writes a minimal `dashboard.config.json` without asking questions about ADO orgs, GitHub tokens, or service ports.

### Drone Auto-Configuration

`drone/setup.mjs` was enhanced to:

1. Detect HIVE's `.env` file path from the config
2. Auto-inject `SENTRY_AUTH_TOKEN=drone-demo` and `ADO_PAT=drone-demo` if missing
3. Trigger a hot-reload on HIVE via `POST /api/reload` so changes take effect without restart

### Health Check Script

`doctor.mjs` was added to validate the entire stack in one command (`npm run doctor`). It checks:

- Config file validity
- Project directory and repo existence
- Environment tokens
- Drone and HIVE reachability
- Database connection configuration
- Hivemind config and skill installation

## Design Decisions During Implementation

**Why `POST /api/reload` instead of requiring a restart:** Restarting HIVE kills all WebSocket connections, which means the browser loses its log buffers and git status cache. A hot-reload endpoint re-reads the config and `.env` file without dropping connections. This also enabled Drone's setup script to configure HIVE without user intervention.

**Why `doctor.mjs` checks reachability via HTTP, not process lists:** `tasklist` (Windows) and `ps` (Unix) would tell us if `node server.mjs` is running, but not if the server is actually responding. An HTTP health check against `/api/config` verifies the full stack: process running, port bound, Express routing, config loaded.

**Why demo mode writes a real config file (not a flag):** A `--demo` runtime flag would require conditional logic throughout the server. Instead, demo mode writes a real `dashboard.config.json` with demo-appropriate values. The server doesn't know or care whether it's in "demo mode" — it just reads its config.

## Result

Setup went from ~15 minutes with 10+ manual steps to:

```bash
git clone <hive> && cd hive && npm install && npm run setup  # choose demo mode
git clone <drone> && cd drone && npm install && npm start && node setup.mjs
```

Both repos running, dashboard populated, all widgets showing data. Total time: under 2 minutes.

## Lessons Learned

- **Silent failures are the real enemy.** The old setup didn't fail — it succeeded partially, then widgets showed blank. `npm run doctor` turns invisible problems into visible checklists.
- **Automation should be idempotent.** Drone's `setup.mjs` can be run repeatedly without duplicating tokens or corrupting config. Every step checks before it writes.
- **The first 5 minutes determine adoption.** Nobody reads docs for a tool they haven't seen work yet. Getting to a working dashboard fast is more important than getting to a perfectly-configured dashboard.
