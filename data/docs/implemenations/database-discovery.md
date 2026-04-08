---
type: Implementation Note
status: active
---

# Database Connection Discovery

**Date:** 2026-02  
**Related ADR:** [[decisions/004-json-file-storage]]

## Problem

The DB Explorer needs database connections, but different developers and environments configure them differently:

- Some teams use environment variables (12-factor app style)
- Some prefer a config file checked into the repo
- Demo environments have no database at all
- A single project might connect to multiple databases (primary, analytics, read replica)

The connection system needed to support all of these without requiring any specific one.

## What Changed

### Three-Source Discovery

`discoverDbConnections()` in `server.mjs` checks three sources in order:

**1. Default environment variables**
```
DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE, DB_SSL
```
If `DB_HOST` or `DB_USERNAME` is set, a connection is created as `env-default`.

**2. Named environment variable groups**
The function scans `process.env` for keys matching `DB_<PREFIX>_HOST`. For each prefix found (e.g., `DB_ANALYTICS_HOST`), it collects the corresponding `_PORT`, `_USER`, `_PASSWORD`, `_DATABASE` variables and creates a connection as `env-{prefix}`.

This naming convention means adding a new database to a developer's workflow is just adding 4-5 environment variables — no code changes, no config file edits.

**3. Configuration file**
`data/databases.json` can specify connections explicitly:
```json
[{ "id": "local", "label": "Local DB", "host": "localhost", "port": 5432, ... }]
```

### SQLite Fallback

If no connections are discovered from any source, the server automatically provides an embedded SQLite demo database:

- **Driver:** `sql.js` (SQLite compiled to WebAssembly, runs in-memory)
- **Connection ID:** `demo-sqlite`
- **Tables:** `customers`, `products`, `orders`, plus an `order_summary` view
- **Data:** 5 customers, 5 products, 10 orders with relationships
- **Persistence:** None — resets on server restart

This ensures the DB tab and metric widgets always have something to connect to, even on a fresh install with zero configuration.

### Pool Management

PostgreSQL connections use `pg.Pool` with conservative settings:
- `max: 5` — Enough for a developer tool, not enough to exhaust a shared database
- `idleTimeoutMillis: 30000` — Release idle connections after 30 seconds
- `connectionTimeoutMillis: 5000` — Fail fast if the database is unreachable

Pools are cached in a `Map` keyed by connection ID. SQLite connections don't use pools — `sql.js` operates in-memory and doesn't need connection management.

## Design Decisions

**Why environment variable discovery instead of a UI-based connection manager:** Developers already manage database credentials in their shell profile or `.env` files. Discovering connections from environment variables means zero additional configuration for developers who already have `DB_HOST` set. It also avoids storing passwords in a JSON file that could be accidentally committed.

**Why the `DB_<PREFIX>_HOST` naming convention:** It's discoverable by scanning `process.env` keys, supports unlimited connections, and follows a pattern developers already use (like `REDIS_HOST`, `CACHE_HOST`). The alternative — a JSON array of connections — requires editing a file for every new database.

**Why SQLite instead of a mock/stub:** A real SQL engine (even in-memory) means the query editor, schema browser, and metric creator all work with real SQL syntax. A mock would need to simulate query parsing, column discovery, and result formatting. SQLite gives us all of that for free.

**Why `sql.js` instead of `better-sqlite3`:** `better-sqlite3` is a native module that requires compilation and can fail on some platforms (Windows ARM, Alpine Linux). `sql.js` is pure WebAssembly — it works everywhere Node.js runs, with zero native dependencies.

## Lessons Learned

- **Convention-based discovery reduces friction dramatically.** Developers with existing `DB_HOST` variables get the DB Explorer for free — no setup step, no configuration screen.
- **Fallback beats failure.** An empty DB tab with "No connections configured" is useless for evaluation. An in-memory SQLite with demo data lets users explore the feature immediately and decide if it's worth configuring their real database.
- **The doctor should know about fallbacks.** The health check initially warned "No database connections configured" when SQLite would silently take over. The fix was changing the message to acknowledge the fallback: "No database connections configured — embedded SQLite demo will be used."
