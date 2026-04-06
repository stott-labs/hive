# Creating SQL Metric Widgets

SQL metric widgets let you turn any `SELECT` query against your PostgreSQL database into a live dashboard panel. HIVE supports 7 visualization types, each optimized for different data shapes.

## Quick Start

1. Open the HIVE dashboard
2. Click the **+** button in the widget picker
3. Select **"Create Metric"**
4. Choose a database connection
5. Write a SQL query
6. Pick a visualization type
7. Configure display options
8. Save

The widget appears on your grid and refreshes on a configurable interval.

## Visualization Types

### Number

A single large number. Best for scalar values.

```sql
SELECT COUNT(*) AS active_users
FROM users
WHERE last_active > NOW() - INTERVAL '24 hours'
```

Displays: **1,247**

---

### Delta

A value with a trend indicator (up/down/flat arrow). Requires two columns: the current value and the comparison value.

```sql
SELECT
  COUNT(*) AS today,
  (SELECT COUNT(*) FROM orders WHERE created_at::date = CURRENT_DATE - 1) AS yesterday
FROM orders
WHERE created_at::date = CURRENT_DATE
```

Displays: **89** ↑ 12%

---

### Table

Multi-row results with selectable columns and row limits.

```sql
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10
```

Displays as a scrollable table with headers.

---

### Key/Value Card

A single row displayed as labeled key-value pairs. Best for profile-style data.

```sql
SELECT name, email, role, last_login
FROM users
WHERE id = 1
```

Displays as a card with each column as a labeled field.

---

### Bar Chart

Horizontal bar chart with label + value pairs. Auto-scales to the largest value.

```sql
SELECT endpoint, COUNT(*) AS requests
FROM access_logs
WHERE timestamp > NOW() - INTERVAL '1 hour'
GROUP BY endpoint
ORDER BY requests DESC
LIMIT 8
```

Displays as horizontal bars with labels and values.

---

### Status Badges

Color-coded badges for boolean or enum columns. Map values to colors (green, red, yellow, blue).

```sql
SELECT
  name,
  CASE WHEN is_healthy THEN 'healthy' ELSE 'unhealthy' END AS status
FROM services
```

Configure color mapping: `healthy` → green, `unhealthy` → red.

---

### Gauge

An SVG arc gauge showing a percentage of a max value. Color shifts from green to red based on the value.

```sql
SELECT
  pg_database_size(current_database()) / 1073741824.0 AS size_gb
```

Configure max value (e.g., 100 GB). Displays as a circular gauge.

---

## Configuration Options

Each metric has:

| Option | Description |
|--------|-------------|
| **Name** | Display title in the widget header |
| **SQL Query** | The SELECT statement to run |
| **Connection** | Which database connection to use |
| **Refresh Interval** | Seconds between automatic refreshes (0 = manual only) |
| **Widget Type** | One of the 7 visualization types |
| **Column Selection** | Which columns to display (table/key-value types) |
| **Row Limit** | Maximum rows to show (table type) |
| **Color Mapping** | Value-to-color rules (status badge type) |
| **Max Value** | Scale maximum (gauge type) |
| **Default Size** | Initial grid dimensions (w x h) |

## Security

All queries are validated server-side before execution. Only `SELECT` statements are allowed. The following are rejected:

- `INSERT`, `UPDATE`, `DELETE`
- `DROP`, `ALTER`, `TRUNCATE`
- `CREATE`, `GRANT`, `REVOKE`
- `EXECUTE`, `CALL`

Comments are stripped before validation to prevent bypass attempts.

## Storage

Metric definitions are saved to `data/metrics.json` (gitignored). Each definition includes the query, connection ID, refresh interval, widget type, and type-specific configuration.

## Tips

- **Use CTEs** for complex queries — they're readable and the query planner handles them well
- **Add `LIMIT`** to table queries — large result sets slow down rendering
- **Use meaningful column aliases** — they become the display labels
- **Test with Preview** before saving — the Metric Creator has a live preview that runs the query and shows the result
- **Set reasonable refresh intervals** — 30-60 seconds for most metrics; faster for critical monitors
- **Combine with Drone** for demos — create metrics against Drone's mock data for presentations

## Example Metrics

### Active Sessions (Number)
```sql
SELECT COUNT(*) AS sessions
FROM pg_stat_activity
WHERE state = 'active'
```

### Table Sizes (Bar Chart)
```sql
SELECT
  tablename AS table,
  pg_total_relation_size(schemaname || '.' || tablename) / 1048576 AS size_mb
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY size_mb DESC
LIMIT 10
```

### Slow Queries (Table)
```sql
SELECT
  LEFT(query, 80) AS query,
  calls,
  ROUND(mean_exec_time::numeric, 2) AS avg_ms,
  ROUND(total_exec_time::numeric, 2) AS total_ms
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 15
```

### Database Health (Status Badges)
```sql
SELECT
  datname AS database,
  CASE
    WHEN numbackends > 50 THEN 'critical'
    WHEN numbackends > 20 THEN 'warning'
    ELSE 'healthy'
  END AS status,
  numbackends AS connections
FROM pg_stat_database
WHERE datname NOT LIKE 'template%'
```
