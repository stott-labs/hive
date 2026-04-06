# HIVE Server API Reference

The HIVE server exposes both REST endpoints and Socket.IO events. REST handles request/response operations; Socket.IO handles real-time push.

## REST Endpoints

### Configuration

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/user` | Current user name and email |
| `GET` | `/api/config` | Dashboard config (safe subset for frontend) |
| `GET` | `/api/config/full` | Full config (includes sensitive fields) |
| `PUT` | `/api/config` | Bulk update config |
| `PUT` | `/api/config/section/:section` | Update a single config section |
| `GET` | `/api/env` | List environment variable keys (passwords masked) |
| `PUT` | `/api/env` | Update managed env keys (ADO_PAT, GITHUB_TOKEN, etc.) |
| `GET` | `/api/user-prefs` | Per-user preferences (hidden repos, visibility) |
| `PUT` | `/api/user-prefs` | Save user preferences |
| `GET` | `/api/layouts` | Saved grid layouts |
| `PUT` | `/api/layouts` | Save layout state |

### Repositories

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/git/status` | Git status for all repos |
| `GET` | `/api/repos/:repo/branches` | List all branches |
| `POST` | `/api/repos/:repo/checkout` | Checkout a branch |
| `GET` | `/api/repos/:repo/changed-files` | Dirty file details |
| `GET` | `/api/repos/:repo/diff` | Working diff |
| `GET` | `/api/repos/:repo/tree` | Directory tree |
| `GET` | `/api/repos/:repo/files` | Recursive file listing |
| `GET` | `/api/repos/:repo/file` | Read file content |
| `POST` | `/api/repos/:repo/file` | Write file content |
| `POST` | `/api/repos/:repo/move` | Move/rename file |
| `POST` | `/api/repos/:repo/mkdir` | Create directory |
| `DELETE` | `/api/repos/:repo/file` | Delete file |
| `POST` | `/api/repos/:repo/commit` | Commit with message |
| `POST` | `/api/repos/:repo/discard` | Discard all changes |
| `GET` | `/api/repos/:repo/search` | Full-text search across files |
| `POST` | `/api/repos/pull` | Pull all repos |
| `GET` | `/api/repos/discover` | Auto-discover repos in projects directory |

### Services

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/services` | List services + running status |
| `POST` | `/api/services/start` | Start a service |
| `POST` | `/api/services/stop` | Stop a service |
| `POST` | `/api/services/restart` | Restart a service |

Service status is determined by TCP connect checks on the configured port.

### Database

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/db/connections` | List connections (passwords masked) |
| `POST` | `/api/db/connections/test` | Test a connection |
| `GET` | `/api/db/status` | Connectivity check + version |
| `GET` | `/api/db/schema` | Full schema: tables, views, columns, PKs, FKs |
| `POST` | `/api/db/query` | Execute ad-hoc query (SELECT only) |
| `GET` | `/api/db/table/:schema/:table` | Table data with pagination |
| `GET` | `/api/db/scripts/tree` | SQL scripts directory tree |
| `GET` | `/api/db/scripts/file` | Read script file |
| `PUT` | `/api/db/scripts/file` | Write script file |
| `DELETE` | `/api/db/scripts/file` | Delete script |
| `POST` | `/api/db/scripts/folder` | Create folder |
| `POST` | `/api/db/scripts/rename` | Rename script/folder |
| `POST` | `/api/db/scripts/import-zip` | Bulk import scripts |

### SQL Metrics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/metrics` | List all saved metrics |
| `POST` | `/api/metrics/preview` | Preview a query result |
| `PUT` | `/api/metrics/:id` | Create or update a metric |
| `DELETE` | `/api/metrics/:id` | Delete a metric |
| `POST` | `/api/metrics/:id/query` | Execute a saved metric's query |

### API Client

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/proxy` | Forward HTTP request (supports streaming) |
| `POST` | `/api/proxy/upload` | Forward multipart form with file uploads |
| `GET` | `/api/collections` | List saved request collections |
| `PUT` | `/api/collections` | Save collections |
| `POST` | `/api/collections/import` | Import OpenAPI spec |
| `POST` | `/api/collections/import-postman` | Import Postman collection |
| `POST` | `/api/environments/import-postman` | Import Postman environment |
| `GET` | `/api/environments` | List environments |
| `PUT` | `/api/environments` | Save environments |
| `GET` | `/api/history` | Request history |
| `POST` | `/api/history` | Add to history |

### Documentation

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/docs/tree` | Directory tree |
| `GET` | `/api/docs/file` | Read markdown file |
| `GET` | `/api/docs/asset` | Serve embedded images/assets |
| `GET` | `/api/docs/search` | Full-text search |
| `PUT` | `/api/docs/file` | Write markdown file |
| `POST` | `/api/docs/new-file` | Create new file |
| `POST` | `/api/docs/new-folder` | Create folder |
| `POST` | `/api/docs/git/pull` | Pull docs repo |
| `POST` | `/api/docs/git/push` | Commit and push docs |
| `GET` | `/api/docs/git/status` | Docs git status |

### Azure DevOps

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/ado/status` | Check PAT validity |
| `GET` | `/api/ado/work-items` | Work items with filters |
| `POST` | `/api/ado/work-items` | Create work item |
| `PATCH` | `/api/ado/work-items/:id` | Update work item |
| `GET` | `/api/ado/sprint` | Current sprint info |
| `GET` | `/api/ado/team-members` | Team users |
| `GET` | `/api/ado/project-repos` | ADO repos |
| `GET` | `/api/ado/prs` | Pull requests |
| `GET` | `/api/ado/pipeline-list` | Build pipelines |
| `GET` | `/api/ado/pipelines` | Pipeline runs + approvals |
| `POST` | `/api/ado/pipelines/:id/runs` | Queue a build |
| `POST` | `/api/ado/pipelines/:id/runs/:runId/approve` | Approve a run |
| `GET` | `/api/ado/contributions` | 180-day contribution calendar |

### GitHub

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/github/status` | Check token validity |
| `GET` | `/api/github/prs` | PRs for configured repos |
| `GET` | `/api/github/org-members` | Org members |
| `GET` | `/api/github/org-repos` | Org repos |
| `GET` | `/api/github/repo-activity` | Commits per repo |
| `GET` | `/api/github/actions` | Workflow runs |
| `GET` | `/api/github/contributions` | 180-day contribution calendar |

### Sentry

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sentry/status` | Check auth token |
| `GET` | `/api/sentry/issues` | Unresolved issues |
| `GET` | `/api/sentry/issue/:id` | Issue detail with stack trace |

### Other

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/activity` | Combined commit feed (all repos) |
| `GET` | `/api/commits` | Recent commits |
| `GET` | `/api/commits/contributions` | Contribution counts by author |
| `GET` | `/api/releases` | Parsed releases.json |
| `GET` | `/api/env-diff` | Side-by-side env comparison |
| `GET` | `/api/migrations/status` | Pending DB migrations |
| `GET` | `/api/swagger` | Fetch OpenAPI schema |
| `POST` | `/api/script/run` | Execute sandboxed Node.js script |

---

## Socket.IO Events

### Server → Client (Push)

| Event | Payload | Trigger |
|-------|---------|---------|
| `git-status` | Array of repo status objects | Periodic (every ~5s) or on `refresh` |
| `log` | `{ service, line }` | When a log file is appended to |
| `service-status` | `{ key, running }` | Service port check change |
| `external-status` | `{ key, status, statusCode, responseTime, ... }` | Health check result |
| `claude-usage` | Token usage data | On refresh |
| `service-running` | `{ key, running }` | Port availability changed |
| `migrate-output` | stdout/stderr line | During migration |
| `migrate-done` | `{ success, error? }` | Migration completed |
| `cli-tool-output` | stdout line | During CLI tool execution |
| `cli-tool-done` | `{ code }` | CLI tool completed |
| `test-output` | stdout line | During test run |
| `test-done` | `{ code }` | Test run completed |

### Client → Server (Request)

| Event | Payload | Description |
|-------|---------|-------------|
| `refresh` | — | Trigger manual refresh |
| `clear-logs` | `{ service }` | Clear specific service logs |
| `check-status` | — | Trigger external monitor check |
| `migrate-latest` | — | Run pending migrations |
| `migrate-rollback` | — | Rollback latest migration |
| `cli-tool-run` | `{ tool }` | Execute CLI tool |
| `test-run` | `{ repo, cmd? }` | Start test runner |
| `test-stop` | — | Cancel running tests |
| `repo:clone` | `{ url }` | Clone a repo |
