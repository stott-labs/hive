# Setting Up Drone with HIVE

Drone needs to be connected to HIVE so the dashboard knows where to find Drone's mock APIs and data files. The `setup.mjs` script handles this automatically.

## Prerequisites

- HIVE is installed and running on port 3333
- Drone is installed (`npm install` completed)

## Quick Setup

```bash
cd drone
npm install
npm start          # Starts on port 4000
```

In a separate terminal:

```bash
node setup.mjs     # Configures HIVE to use Drone
```

The setup script calls HIVE's configuration API to add:

- **Drone as a monitored repo** — appears in git status widget
- **4 external monitors** — pointing to Drone's health endpoints
- **Release config** — pointing to `drone/data/releases.json`
- **Env diff config** — pointing to `drone/data/.env.{dev,qa,prod}`
- **Sentry base URL** — overridden to `http://localhost:4000/sentry`
- **ADO base URL** — overridden to `http://localhost:4000/ado`
- **ADO project config** — demo org, project, team, and 4 simulated users

## Environment Tokens

HIVE's Sentry and ADO widgets check for valid auth tokens before making requests. Add dummy tokens to HIVE's `.env` file:

```env
SENTRY_AUTH_TOKEN=drone-demo
ADO_PAT=drone-demo
```

Drone's mock APIs accept any token value — the key just needs to exist.

## Restart HIVE

After running `setup.mjs` and adding tokens, restart HIVE to pick up the new config:

```bash
# If using the /dashboard skill:
/dashboard restart

# Or manually:
cd ../hive
# Stop existing process, then:
npm start
```

## What Setup Configures

Here's exactly what `setup.mjs` adds to HIVE's config:

```javascript
{
  repos: ['drone'],
  
  externalMonitors: [
    { key: 'api-prod',    label: 'API (Prod)',    url: 'http://localhost:4000/health/api-prod',    type: 'http', interval: 10 },
    { key: 'api-staging', label: 'API (Staging)', url: 'http://localhost:4000/health/api-staging', type: 'http', interval: 10 },
    { key: 'web-prod',    label: 'Web (Prod)',    url: 'http://localhost:4000/health/web-prod',    type: 'http', interval: 10 },
    { key: 'auth-svc',    label: 'Auth Service',  url: 'http://localhost:4000/health/auth-service',type: 'http', interval: 10 },
  ],
  
  releases: { repoDir: 'drone', path: 'data/releases.json' },
  
  envDiff: {
    dev:  { repoDir: 'drone', path: 'data/.env.dev' },
    qa:   { repoDir: 'drone', path: 'data/.env.qa' },
    prod: { repoDir: 'drone', path: 'data/.env.prod' },
  },
  
  sentryBaseUrl: 'http://localhost:4000/sentry',
  sentry: { org: 'demo-org', projects: ['demo-api'] },
  
  adoBaseUrl: 'http://localhost:4000/ado',
  ado: {
    org: 'demo-org',
    project: 'Demo Project',
    team: 'Demo Team',
    users: ['Sarah Chen', 'Marcus Rivera', 'Priya Patel', 'James Okafor'],
    prRepos: ['drone'],
    workItemTypes: ['Bug', 'User Story', 'Feature'],
    activeStates: ['Active', 'New', 'In Design'],
  },
}
```

## Verifying the Setup

After restart, open HIVE at `http://localhost:3333`. You should see:

1. **Repositories widget** — Drone repo appears with its current branch and git status
2. **External Services widget** — Four service cards showing "Up" with response times
3. **Releases widget** — Version history from Drone's seeded releases
4. **Env Diff widget** — Three environments with deliberate mismatches highlighted
5. **Sentry widget** — Unresolved error issues
6. **ADO widget** — Work items in kanban/list view

Open Drone's control panel at `http://localhost:4000/control` and run the "Production Incident" scenario. Watch all six widgets update in real time as the scenario unfolds.

## Cleaning Up

To disconnect Drone from HIVE, remove the Drone-specific entries from HIVE's config through the Settings tab, or re-run HIVE's setup wizard.
