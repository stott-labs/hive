# H.I.V.E. — Hub for Integrated Visualization & Exploration

Browser-based developer dashboard. Runs as a detached Node.js process (`server.mjs`) with a vanilla JS + Socket.IO frontend. Layout is managed by GridStack.js.

Launch with `/dashboard`, stop with `/dashboard stop`.

## Tech Stack

| Layer | Tech |
|---|---|
| Server | Express.js + Socket.IO (`server.mjs`) |
| Frontend | Vanilla JS, no bundler |
| Layout | GridStack.js (drag/resize grid) |
| Database | PostgreSQL via `pg` pool |
| Styles | Catppuccin Mocha theme (CSS custom properties) |

---

## Widgets

### What a widget is

A widget is a self-contained dashboard panel. Each widget is a plain JS object registered in `window.WIDGET_REGISTRY` under a unique string key. The grid renders it into a resizable, draggable tile.

### Widget contract

Every widget object must implement these three methods:

```js
WIDGET_REGISTRY['my-widget'] = {
  title: 'My Widget',       // shown in the widget header
  icon: '📋',               // emoji or unicode, shown as drag handle
  defaultSize: { w: 4, h: 3 },
  minW: 2,
  minH: 2,

  init(contentEl, socket, config) {
    // Called once when the widget is added to the grid.
    // contentEl is the widget body <div> — write your DOM here.
    // socket is the Socket.IO client instance.
    // config is any saved state from the layout JSON.
  },

  refresh(socket) {
    // Called when the user clicks the ↻ refresh button.
    // Re-fetch data and re-render contentEl.
  },

  destroy(socket) {
    // Called when the widget is removed from the grid.
    // MUST remove all socket listeners added in init() to avoid leaks:
    //   socket.off('event-name', this._handler);
    // MUST clear any setInterval timers.
  },
};
```

### Rules

- **Clean up after yourself.** Every `socket.on(event, handler)` in `init()` needs a matching `socket.off(event, handler)` in `destroy()`. Store the handler as `this._handler` so you can reference the same function.
- **Use skeleton loaders.** Call `skeletonRows(n, pattern)` (patterns: `'list'`, `'table'`, `'card'`) as the initial `contentEl.innerHTML` while data loads.
- **Escape all dynamic content.** Use the global `esc(str)` helper for any user-controlled or API-returned strings inserted into HTML.
- **Persist user preferences** to `localStorage` (filter state, selected env, view mode, etc.) so the widget restores its last state on reload.
- **No ES module syntax** (`import`/`export`). These are plain `<script>` tags — everything is global.

### Where widget files live

```
public/
  widgets/
    shared.js           ← Load first. WIDGET_REGISTRY init + shared helpers.
    git-status.js
    external-services.js
    claude-usage.js
    ado.js
    sentry.js
    releases.js
    db-migrations.js
    env-diff.js
    test-runner.js
    cli-tools.js
    service-log.js      ← registerServiceWidget() factory for log-streaming widgets
    github.js
    commit-history.js
    contributions.js
    claude-skills.js
    metric.js           ← registerMetricWidget() + renderMetricWidget() for SQL-backed widgets
```

Each file is loaded as a `<script>` tag in `index.html` in the order above. `shared.js` must be first.

### Adding a new widget

1. Create `public/widgets/my-widget.js` with the comment header `/* Widget: my-widget */`.
2. Register it: `WIDGET_REGISTRY['my-widget'] = { ... }` — implement `init`, `refresh`, `destroy`.
3. Add a `<script src="/widgets/my-widget.js"></script>` tag to `index.html` after the last existing widget `<script>`.
4. Add it to the widget picker in `app.js` → `updateWidgetPicker()` so users can add it to their layout.

### Shared helpers (defined in `shared.js`)

| Helper | Purpose |
|---|---|
| `skeletonRows(count, pattern)` | Skeleton loader HTML (`'list'`, `'table'`, `'card'`) |
| `createWidgetChrome(title, icon)` | Creates the widget wrapper with header + body (used internally by the grid, not usually called directly) |
| `esc(str)` | HTML-escapes a string — use for all dynamic content |

### Dynamic widget factories

Two widget types are registered at runtime rather than at page load:

- **`registerServiceWidget(key, def)`** (`service-log.js`) — creates a log-streaming widget for a named service (Web, API, etc.).
- **`registerMetricWidget(metric)`** / **`unregisterMetricWidget(metricId)`** (`metric.js`) — creates SQL-backed custom metric widgets defined through the Metric Creator UI. Metric definitions are stored in `data/metrics.json`.

---

## Server API (`server.mjs`)

REST endpoints are defined before the `io.on('connection', ...)` block. Socket.IO events are emitted from within the connection handler. Key endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/git/status` | Git status for all repos |
| `GET` | `/api/metrics` | List saved metric definitions |
| `POST` | `/api/metrics/preview` | Preview SQL query result |
| `PUT` | `/api/metrics/:id` | Save/update a metric |
| `DELETE` | `/api/metrics/:id` | Delete a metric |
| `POST` | `/api/metrics/:id/query` | Run a saved metric query |
| `GET` | `/api/db/query` | Run an ad-hoc DB query |

SQL queries from the Metric Creator are validated server-side with `isMetricQuerySafe()` — only `SELECT` is allowed; `INSERT`, `UPDATE`, `DELETE`, `DROP`, etc. are rejected.
