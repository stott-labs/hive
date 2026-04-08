---
type: ADR
status: Accepted
---

# ADR-008: SQL Query Safety Model

**Date:** 2026-03  
**Status:** Accepted

## Context

The DB Explorer lets developers run SQL queries against connected databases. The Metric Creator lets them define SQL queries that run automatically on a schedule and display results as dashboard widgets. Both features accept user-provided SQL — which means both need a safety model.

Two competing concerns:

1. **Usefulness** — Developers need to run real queries, including writes (INSERT, UPDATE) during development
2. **Safety** — An accidental `DROP TABLE` in a metric widget that auto-refreshes every 30 seconds would be catastrophic

## Decision

Implement a **two-tier validation model**:

**Tier 1: Ad-hoc queries (DB Explorer)** — Read-only by default. Developers can opt into write mode per session via a toggle. The `isQuerySafe(sql, allowWrite)` function strips comments and checks for dangerous keywords.

**Tier 2: Metric queries (dashboard widgets)** — Strictly read-only, always. The `isMetricQuerySafe(sql)` function has a broader blocklist and cannot be bypassed. Only `SELECT` statements are allowed.

### Validation Logic

Both functions:
1. Strip single-line comments (`-- ...`)
2. Strip block comments (`/* ... */`)
3. Check for dangerous keywords at the start of statements

**Ad-hoc blocklist** (when write mode is off):
`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `GRANT`, `REVOKE`

**Metric blocklist** (always enforced):
All of the above plus `EXEC`, `EXECUTE`, `CALL`, `COPY`, `VACUUM`, `ANALYZE`, `CLUSTER`, `REINDEX`, `LOCK`

## Reasoning

**String-pattern matching is sufficient for this use case.** The queries come from authenticated developers on their local machine, not from untrusted external input. The goal is preventing *accidents*, not defending against *attacks*. A developer who intentionally wants to bypass the check can edit the server code — and that's fine, it's their machine.

**Comment stripping prevents trivial bypasses.** Without it, `SELECT 1 -- DROP TABLE users` would pass validation because the dangerous keyword is in a comment. Stripping comments first ensures the check sees only executable SQL.

**Write mode is opt-in per session.** The toggle resets on page reload. This prevents muscle-memory mistakes — you can't accidentally run a `DELETE` because you forgot you were in write mode yesterday.

**Metrics are always read-only.** A metric widget runs its query automatically every N seconds. A write operation in a scheduled query could multiply damage over time. There's no legitimate use case for a metric widget that runs `INSERT` or `UPDATE`.

**The extended metric blocklist covers PostgreSQL admin operations.** `VACUUM`, `ANALYZE`, `REINDEX`, and `LOCK` are safe in isolation but shouldn't run on a timer. `EXEC`/`CALL` could invoke stored procedures with side effects.

## Alternatives Considered

**Parameterized queries / prepared statements** — Protect against SQL injection from external input, but HIVE's queries are entered directly by the developer, not constructed from user input. Parameterization doesn't prevent intentional `DROP TABLE`.

**Database roles with read-only permissions** — The "correct" solution from a DBA perspective. But HIVE connects with whatever credentials the developer provides. Requiring them to set up a read-only role adds friction for a local dev tool. The query validation serves as a lightweight substitute.

**AST-based SQL parsing** — Parse the query into an abstract syntax tree and validate the operation type. More robust than string matching but requires a full SQL parser library, which varies by database dialect. Overkill for preventing accidents.

**No validation (trust the developer)** — The developer knows their database. But accidents happen — a misplaced cursor, a leftover `DELETE` from debugging. The lightweight check catches the obvious mistakes without getting in the way.

## Consequences

**Positive:**
- Prevents accidental destructive queries in the common case
- Write mode is available when genuinely needed (development workflows)
- Metric queries are guaranteed read-only regardless of configuration
- No additional dependencies (pure string operations)
- Comment stripping handles the most common bypass attempt

**Negative:**
- Not a security boundary — a determined user can bypass it (acceptable for a local tool)
- String matching can have false positives (e.g., a column named `drop_count` in a `SELECT`)
- Doesn't validate SQL syntax — a malformed query passes validation and fails at the database
- Database-specific operations (PostgreSQL vs MySQL vs SQLite syntax) aren't distinguished
