---
type: ADR
status: Accepted
---

# ADR-004: JSON File Storage for Configuration and State

**Date:** 2026-02  
**Status:** Accepted

## Context

HIVE needs to persist several kinds of data: dashboard layouts, API collections, environment variable sets, metric definitions, request history, and user preferences. The data is small (kilobytes), changes infrequently (user actions, not high-throughput writes), and is mostly read on startup.

The question is where to store this data: a database (SQLite, PostgreSQL), a key-value store, or plain files on disk.

## Decision

Store all configuration and state as **JSON files on disk**. Each data type gets its own file in the `data/` directory (shared) or `~/.config/hive/data/` (private).

```
data/
  layouts.json          — Grid positions, named layouts, tab order
  metrics.json          — SQL metric widget definitions
  databases.json        — Database connection configs
  api/
    collections.json    — API request collections
    environments.json   — Environment variable sets
    history.json        — Request execution log
  db-scripts/           — Saved SQL scripts (*.sql files)

~/.config/hive/data/
  user-prefs.json       — Per-user preferences
  api/
    collections.json    — Private API collections
```

Read with `readFileSync`, write with `writeFileSync`, wrapped in `readJsonFile()` / `writeJsonFile()` helpers that handle missing files with defaults.

## Reasoning

**Zero dependencies.** HIVE starts with `npm start`. No database server to install, configure, or manage. No migrations to run. No connection strings to set up. This is a developer tool — it should be lighter than the projects it monitors.

**Human-readable and git-friendly.** JSON files can be inspected and edited by hand. Team-shared files (collections, metrics) can be committed to the repo. Personal files (user-prefs, private collections) live outside the repo in `~/.config/`. This dual-path model is documented in [[decisions/005-shared-vs-private-data]].

**Atomic writes are sufficient.** All data is small enough to write in a single `writeFileSync` call. There are no concurrent writers (single server process) and no transactions needed. The risk of corruption from a crash mid-write is negligible for non-critical data that can be regenerated.

**Schema migrations are trivial.** When the format changes, a migration function runs on startup (e.g., `migrateAuthInherit()` that converts old auth formats). This is simpler than managing database migration files for a tool that stores kilobytes of config.

**Portability.** Copy the `data/` directory to a new machine and everything works. No database dump/restore, no export/import, no schema recreation.

## Alternatives Considered

**SQLite** — Would provide ACID transactions and SQL querying, but adds a native binary dependency (`better-sqlite3`) that can fail on some platforms. HIVE's data access patterns are "read all on startup, write occasionally" — SQL queries provide no benefit over reading a whole JSON file.

**PostgreSQL** — Already supported for the DB Explorer feature, but requiring it for HIVE's own config would add a hard dependency. A developer tool shouldn't require a database server to show a dashboard.

**LevelDB / RocksDB** — Key-value stores solve concurrency and atomic writes, but add native dependencies and lose human readability. The data is too simple to justify.

**localStorage only** — The original approach for layouts. Works for a single browser but doesn't survive browser data clears, can't be shared across machines, and isn't accessible to the server. Migrated to server-side JSON with localStorage as a cache.

## Consequences

**Positive:**
- Zero-config startup — no database to provision
- Files are inspectable, editable, and diffable
- Team-shared config can be committed alongside the code
- Trivial backup — copy the `data/` directory
- No native dependencies that could fail on exotic platforms

**Negative:**
- No concurrent write safety — if HIVE were multi-process, writes could collide (single-process design avoids this)
- No indexing or querying — reading all data into memory on startup (acceptable at current data sizes)
- No referential integrity — deleting a collection doesn't clean up orphaned references
- Large history files could grow unbounded (mitigated by capping at 200 entries)
