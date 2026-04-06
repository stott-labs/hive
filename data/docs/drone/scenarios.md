# Drone Scenarios & Control

Drone ships with 5 scripted scenarios and a set of quick actions. Each scenario is a timed sequence of correlated events designed to showcase different aspects of HIVE.

## The Five Scenarios

### 1. Steady State (~35 seconds, 7 steps)

A normal development day. Commits flow in from the team, the working tree gets dirty, environment variables mutate slightly. No incidents — just a healthy development environment.

**What it demonstrates:** Git status widget, commit history, contribution tracking, env diff.

---

### 2. Production Incident (~30 seconds, 8 steps)

The API starts degrading. Sentry errors spike. A bug is created in ADO. A hotfix is committed. The service recovers. A release is cut.

**What it demonstrates:** External service monitoring, Sentry integration, ADO work items, the full incident-to-resolution cycle.

**Step sequence:**
1. API latency increases
2. API status degrades
3. Sentry error spike
4. Bug created in ADO
5. Hotfix committed
6. API recovers
7. Release published
8. Environment sync

---

### 3. Sprint Kickoff (~32 seconds, 9 steps)

New work items are created. Environment variables are added for new features. Initial commits start landing. A PR is created for the first completed story.

**What it demonstrates:** ADO kanban board, pipeline triggers, env diff (new keys), PR workflow.

---

### 4. Release Day (~30 seconds, 9 steps)

Version bumps and changelog updates. Pipelines trigger. A release is published. Environment configs sync. A brief service hiccup occurs and recovers.

**What it demonstrates:** Releases widget, pipelines with approvals, env diff, service monitoring.

---

### 5. Config Drift (~25 seconds, 6 steps)

Environment keys are added inconsistently — dev gets a key that QA doesn't. Prod is missing a flag that dev has. The drift accumulates and becomes visible.

**What it demonstrates:** Env diff widget, configuration management visibility.

---

## Control Panel

Access at `http://localhost:4000/control`. The Catppuccin-themed UI provides:

### Scenario Buttons

Click any scenario to start it. Progress is logged in real time. Only one scenario runs at a time. Click "Abort" to stop a running scenario.

### Quick Actions

On-demand one-shot actions:

| Action | What It Does |
|--------|-------------|
| Make Commit | Generate a single conventional commit |
| Dirty Working Tree | Create unstaged WIP files |
| Add Release | Publish a new version |
| Mutate Env | Randomly add/remove env keys |
| New Sentry Issue | Add an unresolved error |
| Create Bug | Add an ADO work item |
| Spike Errors | Increase error counts across issues |
| API Down | Set API service to "down" |
| API Recover | Set API service to "operational" |
| Reset All | Clear all state and re-seed |

### Controls

- **Auto-commit toggle** — Enable/disable automatic background commits
- **Tick speed slider** — Adjust the background mutation interval (1-30 seconds)

### Live Status

The control panel shows real-time service status cards and a JSON view of Drone's internal state.

## Control API

All control panel actions are available as HTTP endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/scenarios` | List all 5 scenarios |
| `POST` | `/api/scenario/:name` | Run a scenario |
| `POST` | `/api/scenario/abort` | Stop running scenario |
| `POST` | `/api/action/:action` | Trigger a quick action |
| `GET` | `/api/state` | Current state summary |
| `POST` | `/api/reset` | Reset to seed state |
| `POST` | `/api/auto-commit` | Toggle auto-commits |
| `POST` | `/api/tick-interval` | Set tick speed (`{ interval: 1000-60000 }`) |

## Mock API Endpoints

These endpoints are what HIVE connects to (configured by `setup.mjs`):

### Health Checks

- `GET /health/api-prod` — API production health
- `GET /health/api-staging` — API staging health
- `GET /health/web-prod` — Web production health
- `GET /health/auth-service` — Auth service health
- `GET /health/statuspage` — Aggregate StatusPage-compatible response

### Mock Sentry API

- `GET /sentry/api/0/projects/:org/:project/issues/` — Issue list
- `GET /sentry/api/0/issues/:id/` — Issue detail
- `GET /sentry/api/0/issues/:id/events/latest/` — Latest event
- `GET /sentry/api/0/` — Status check
- `GET /sentry/api/0/organizations/:org/` — Org detail

### Mock ADO API

- `POST /ado/_apis/wit/wiql` — Work item query (WIQL)
- `POST /ado/_apis/wit/workitemsbatch` — Batch get work items
- `GET /ado/_apis/wit/workitems/:id` — Single work item
- `PATCH /ado/_apis/wit/workitems/:id` — Update work item
- `GET /ado/_apis/git/repositories/:repo/pullrequests` — PR list
- `GET /ado/_apis/pipelines` — Pipeline list
- `GET /ado/_apis/pipelines/:id/runs` — Pipeline runs
- `POST /ado/_apis/pipelines/:id/runs` — Queue build
- `POST /ado/_apis/pipelines/:id/runs/:runId/approve` — Approve run

## Background Tick System

Every 10 seconds (configurable), Drone generates micro-mutations:

- **Service latency jitter** — Response times fluctuate by ±30%
- **Background commits** — ~15% chance per tick
- **Sentry error bumps** — ~5% chance of count increase
- **Pipeline advancement** — Queued → running → succeeded/failed
- **Work item transitions** — New → Active → In Design
