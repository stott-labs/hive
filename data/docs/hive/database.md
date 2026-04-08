---
type: Feature Guide
status: active
---

# Database Explorer

The DB tab is a database client built into the dashboard. Browse schemas, run queries, edit data inline, save SQL scripts, and create metric widgets — all without leaving the browser. It supports PostgreSQL connections and ships with an embedded SQLite demo database for zero-config exploration.

## Connections

### How Connections Are Discovered

The server finds database connections from three sources, checked in order:

**1. Environment Variables (Default Connection)**

If `DB_HOST` or `DB_USERNAME` is set, a connection is created automatically:

| Variable | Default |
|----------|---------|
| `DB_HOST` | — |
| `DB_PORT` | 5432 |
| `DB_USERNAME` | — |
| `DB_PASSWORD` | — |
| `DB_DATABASE` | — |
| `DB_SSL` | false |

This connection appears as `env-default`.

**2. Environment Variables (Named Connections)**

Additional connections are discovered by naming pattern. For a connection called "analytics":

- `DB_ANALYTICS_HOST`
- `DB_ANALYTICS_PORT`
- `DB_ANALYTICS_USER`
- `DB_ANALYTICS_PASSWORD`
- `DB_ANALYTICS_DATABASE`

The pattern is `DB_<PREFIX>_HOST` where `<PREFIX>` is any uppercase alphanumeric string. The connection ID becomes `env-{prefix}` in lowercase.

**3. Configuration File**

Add connections to `data/databases.json`:

```json
[
  {
    "id": "local",
    "label": "Local DB",
    "host": "localhost",
    "port": 5432,
    "user": "postgres",
    "password": "your-password",
    "database": "your-database"
  }
]
```

See `data/databases.example.json` for the template.

**4. SQLite Demo (Automatic Fallback)**

If no connections are configured from any source, the server automatically provides an embedded SQLite demo database. This is an in-memory database powered by `sql.js` — no installation needed, no data persists between server restarts.

### Demo Database Schema

The SQLite demo seeds three tables and one view:

**customers**
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | Primary key |
| name | TEXT | |
| email | TEXT | Unique |
| plan | TEXT | free, pro, or enterprise |
| created_at | TEXT | ISO date |

**products**
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | Primary key |
| name | TEXT | |
| category | TEXT | |
| price | REAL | |
| in_stock | INTEGER | Boolean (0/1) |

**orders**
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | Primary key |
| customer_id | INTEGER | Foreign key → customers.id |
| product | TEXT | |
| amount | REAL | |
| status | TEXT | pending, completed, or refunded |
| ordered_at | TEXT | ISO date |

**order_summary** (view)
Joins orders with customers: `customer`, `product`, `amount`, `status`.

### Connection Manager

Open the connection manager to see all discovered connections with masked passwords. Each connection has a **Test** button that verifies connectivity and reports the database version.

### Switching Connections

The connection selector at the top of the DB tab lets you switch between configured databases. The schema browser and query editor update to reflect the selected connection.

## Schema Browser

The left sidebar shows a hierarchical tree of the selected database's structure:

```
Schema (e.g., "public" or "main")
  ├── Tables
  │   ├── customers
  │   │   ├── id (PK)
  │   │   ├── name
  │   │   └── email
  │   └── orders
  │       ├── id (PK)
  │       └── customer_id (FK → customers.id)
  └── Views
      └── order_summary
```

### Badges

- **PK** (yellow) — Primary key column
- **FK** (purple) — Foreign key with tooltip showing the referenced table and column

### Quick Query

Click any table name to auto-populate the query editor with:

```sql
SELECT * FROM "schema"."table" LIMIT 100;
```

### Search

Filter the schema tree by typing in the search box. Matches against table and view names.

## Query Editor

Write SQL in the editor panel. Supports multiple tabs — each tab has its own query and result set.

### Running Queries

- Click **Run** or press **Ctrl+Enter** to execute
- Results appear in the table below the editor
- Timing is shown (e.g., "245ms")
- Tab key inserts 2 spaces for indentation

### Query Safety

By default, only `SELECT` queries are allowed. The server blocks:

`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `GRANT`, `REVOKE`

To run write operations, enable **Write Mode** (see below).

### Results Table

- Click column headers to sort ascending/descending
- Export results as **CSV** or **JSON** (to file or clipboard)
- NULL values are displayed distinctly
- Large result sets are scrollable

## Write Mode

Enable the Write Mode toggle to allow data modification. With write mode on:

### Inline Editing

After running a SELECT on a table with a primary key:

- **Click any cell** to edit its value
- **Enter** saves the change (generates an `UPDATE` statement)
- **Escape** cancels the edit
- Changes are executed immediately against the database

### Adding Rows

Click the **+** button to insert a new row. A form appears for each column. Submitting generates an `INSERT` statement.

### Deleting Rows

Click the **×** button on a row to delete it (with confirmation). Generates a `DELETE` by primary key.

## SQL Scripts

The scripts panel in the sidebar lets you save and organize `.sql` files on disk (stored in `data/db-scripts/`).

### Managing Scripts

- **New File** — Create a `.sql` file
- **New Folder** — Organize scripts into directories
- **Click** a script to open it in a query tab
- **Ctrl+S** saves the active script to disk
- **Right-click** for rename and delete options
- **Drag and drop** to move scripts between folders

### Bulk Import

Import a zip file of `.sql` scripts. The folder structure is preserved. Only `.sql` files are extracted.

## Query History

The history panel shows the last 50 executed queries with:

- Timestamp
- Execution time
- Row count

Click any history entry to restore the query into the editor.

## Metrics Integration

The DB tab integrates with the **Metric Creator** to turn SQL queries into live dashboard widgets. See [[guides/creating-metrics]] for the full walkthrough.

### Quick Summary

1. Write a query that returns the data you want to visualize
2. Open the Metric Creator from the widget picker (+)
3. Choose connection, paste or select your query, preview results
4. Pick a visualization type:
   - **Number** — Single scalar value
   - **Delta** — Value with trend indicator
   - **Table** — Multi-row data
   - **Key/Value Card** — Single row as labeled pairs
   - **Bar Chart** — Horizontal bars (2 columns)
   - **Status Badges** — Color-coded enum values
   - **Gauge** — Arc gauge showing percentage
5. Set name, refresh interval, and widget size
6. Save — widget appears on the dashboard and auto-refreshes

Metric queries are strictly read-only. The server blocks all write operations regardless of write mode settings.

## PostgreSQL vs SQLite

| Capability | PostgreSQL | SQLite Demo |
|-----------|-----------|-------------|
| Schema introspection | Full (information_schema) | PRAGMA-based |
| Write mode | Supported | Supported (in-memory only) |
| Connection pooling | Yes (max 5, 30s idle timeout) | N/A |
| SSL | Configurable | N/A |
| Data persistence | Permanent | Resets on server restart |
| Multiple schemas | Yes | Single ("main") |
| Materialized views | Yes | No |

## Security

- **Passwords are never sent to the frontend** — the connections API masks them as `••••••`
- **Query validation** runs server-side before execution — the frontend cannot bypass it
- **Script paths are validated** against directory traversal (`../` attacks blocked)
- **Metric queries** have a stricter blocklist than ad-hoc queries (no `EXEC`, `CALL`, `COPY`, `VACUUM`, etc.)
