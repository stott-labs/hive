# HIVE Widgets

Every panel on the dashboard is a widget — a self-contained JavaScript object registered in `window.WIDGET_REGISTRY`. Widgets are draggable, resizable, and independently refreshable.

## Pre-Built Widgets

### Repositories (git-status)

Live git status across all configured repos. Shows current branch, dirty file count, ahead/behind with origin, and sync status. Click a repo to open the full file browser. Includes a branch switcher dropdown and pull button. Repos can be hidden via user preferences.

**Default size:** 6 x 4 | **Min:** 2 x 2

---

### External Services

HTTP health monitoring with status history. Polls configured URLs at a set interval and shows status cards with response times. Supports standard HTTP checks and Statuspage.io API integration. Includes per-service alarm muting and a global alarm toggle. When a service goes down for more than 3 minutes, an audio alarm sounds.

**Default size:** 4 x 4 | **Min:** 2 x 2

---

### Service Logs (Web / API)

Real-time log streaming from your development servers. Tails the last 200 lines on load, then streams new lines as they're written. Supports ANSI color rendering, error-only filtering, auto-scroll, and a clear button. Start/stop/restart controls appear when services are configured.

One widget is registered per configured service (e.g., `service-web`, `service-api`).

**Default size:** 4 x 5 | **Min:** 3 x 2

---

### Azure DevOps

Work item management with kanban board and list views. Supports user filtering, search, state transitions, and inline creation of bugs and stories. Columns are configurable and draggable. Clicking a work item opens it in ADO.

**Default size:** 4 x 6 | **Min:** 3 x 3

---

### GitHub

Pull request tracking across configured repos. Shows PR status, review state, and branch info. Includes an activity feed of recent commits per repo. Supports org-level PR aggregation.

**Default size:** 4 x 5 | **Min:** 3 x 3

---

### Sentry

Production error feed showing unresolved issues. Displays error titles, occurrence counts, user impact, and severity levels. Click an issue to open a detail panel with stack traces, breadcrumbs, and context. Links directly to Sentry for each issue.

**Default size:** 4 x 4 | **Min:** 3 x 2

---

### Contributions

A 26-week activity grid combining GitHub and Azure DevOps contributions. Shows per-day commit counts with intensity coloring (like GitHub's contribution graph). Includes streak counters, longest streak tracking, and a weekends toggle. Supports per-user filtering and a unified view selector for switching between data sources.

**Default size:** 8 x 4 | **Min:** 4 x 3

---

### ADO Git

Azure DevOps pull requests in compact card format. Shows PR title, status, reviewers, source/target branches, and vote status.

**Default size:** 4 x 3 | **Min:** 2 x 2

---

### Pipelines

Azure DevOps build pipeline monitoring. Lists pipeline definitions with their most recent runs. Shows run status (queued, running, succeeded, failed), duration, and trigger info. Supports queuing new builds and approving waiting runs directly from the widget.

**Default size:** 4 x 4 | **Min:** 3 x 3

---

### Activity Feed

A cross-repo commit timeline. Aggregates recent commits from all configured repositories, sorted by date. Shows commit message, author, repo name, and relative timestamp.

**Default size:** 6 x 4 | **Min:** 3 x 2

---

### Commit History

Recent commits from monitored repos in a compact list. Focused on the commit messages and authors rather than the full timeline.

**Default size:** 4 x 3 | **Min:** 2 x 2

---

### Releases

Release version history read from a `releases.json` file in a configured repo. Shows version numbers, dates, and release notes.

**Default size:** 3 x 2 | **Min:** 2 x 2

---

### DB Migrations

Pending database migration status. Reads from the configured `dbRepo` to show which migrations haven't been applied yet. Supports running and rolling back migrations directly from the widget.

**Default size:** 3 x 2 | **Min:** 2 x 2

---

### Env Diff

Side-by-side comparison of environment variables across local, dev, QA, and prod configurations. Highlights missing keys, value mismatches, and keys unique to one environment.

**Default size:** 4 x 3 | **Min:** 3 x 2

---

### Test Runner

Real-time test execution with failure parsing. Detects Vitest and Jest output formats automatically. Extracts failure details including file path, test name, and assertion error. Includes a "Fix with Claude" button that generates a context-aware prompt from the failure.

**Default size:** 6 x 6 | **Min:** 3 x 3

---

### CLI Tools

Quick action executor for configured scripts. Each action is a named command tied to a repo directory. Click to run — output streams in real time. Useful for tasks like database seeding, cache clearing, or running specific scripts.

**Default size:** 3 x 3 | **Min:** 2 x 2

---

### Claude Skills

Displays the status of shared and personal Claude Code skills. Shows junction link health (symlink validation), CLAUDE.md load order hierarchy, and stale junction warnings. Includes a sync button to re-run setup.

**Default size:** 5 x 7 | **Min:** 3 x 3

---

### Claude Usage

Token usage tracking for Claude API sessions. Shows monthly usage quota and cache statistics.

**Default size:** 3 x 2 | **Min:** 2 x 2

---

## Dynamic Widgets

These widgets are created at runtime rather than loaded at page startup.

### SQL Metric Widgets

Created through the Metric Creator UI (accessible from the widget picker). Each metric is a SQL `SELECT` query run against a configured PostgreSQL connection, rendered as one of seven visualization types:

| Type | Best For | Example |
|------|----------|---------|
| **Number** | Single scalar value | Total active users: **1,247** |
| **Delta** | Value with trend | Orders today: **89** ↑12% |
| **Table** | Multi-row results | Top 10 slow queries |
| **Key/Value** | Single row, multiple columns | Current user profile |
| **Bar Chart** | Label + value pairs | Requests per endpoint |
| **Status Badges** | Boolean/enum columns | Service health matrix |
| **Gauge** | Percentage of max | CPU usage: 73% |

Metrics are saved to `data/metrics.json` and can have configurable refresh intervals. Only `SELECT` queries are allowed — the server rejects any write operations.

[[guides/creating-metrics|Learn how to create metrics →]]

### Service Log Widgets

One is registered per configured service using the `registerServiceWidget()` factory in `service-log.js`. They share the same log streaming architecture but are bound to different service keys.

---

## Widget Lifecycle

Every widget follows the same three-method contract:

1. **`init(contentEl, socket, config)`** — Called once when the widget is added to the grid. Sets up DOM, registers Socket.IO listeners, starts timers.

2. **`refresh(socket)`** — Called when the user clicks the refresh button. Re-fetches data and re-renders.

3. **`destroy(socket)`** — Called when the widget is removed. Must clean up all Socket.IO listeners and clear any intervals.

[[guides/creating-widgets|Learn how to build your own widget →]]
