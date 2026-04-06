# Creating Custom Widgets

This guide walks through building a new HIVE widget from scratch. Every widget follows the same contract: a plain JavaScript object with `init`, `refresh`, and `destroy` methods, registered in `window.WIDGET_REGISTRY`.

## The Widget Contract

```javascript
WIDGET_REGISTRY['my-widget'] = {
  title: 'My Widget',
  icon: '📋',
  defaultSize: { w: 4, h: 3 },
  minW: 2,
  minH: 2,

  init(contentEl, socket, config) {
    // Called once when the widget is added to the grid.
    // contentEl — the widget body <div>, write your DOM here
    // socket — the Socket.IO client instance
    // config — any saved state from the layout JSON
  },

  refresh(socket) {
    // Called when the user clicks the ↻ button.
    // Re-fetch data and re-render.
  },

  destroy(socket) {
    // Called when the widget is removed.
    // MUST clean up all socket listeners and intervals.
  },
};
```

## Step-by-Step Example

Let's build a widget that shows the current time and updates every second.

### 1. Create the widget file

Create `public/widgets/clock.js`:

```javascript
/* Widget: clock */

WIDGET_REGISTRY['clock'] = {
  title: 'Clock',
  icon: '🕐',
  defaultSize: { w: 2, h: 2 },
  minW: 2,
  minH: 2,

  init(contentEl) {
    this._el = contentEl;
    this._render();
    this._interval = setInterval(() => this._render(), 1000);
  },

  refresh() {
    this._render();
  },

  destroy() {
    clearInterval(this._interval);
  },

  _render() {
    const now = new Date();
    this._el.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:center; height:100%; font-size:2rem; font-family:monospace;">
        ${esc(now.toLocaleTimeString())}
      </div>
    `;
  },
};
```

### 2. Add the script tag

In `public/index.html`, add after the last widget script:

```html
<script src="/widgets/clock.js"></script>
```

### 3. Register in the widget picker

The widget picker in `app.js` reads from `WIDGET_REGISTRY` automatically. Your widget appears in the "Add Widget" dropdown as soon as it's registered.

## Rules and Best Practices

### Clean up after yourself

Every `socket.on(event, handler)` in `init()` needs a matching `socket.off(event, handler)` in `destroy()`. Store the handler reference so you can remove the exact function:

```javascript
init(contentEl, socket) {
  this._onStatus = (data) => { /* handle */ };
  socket.on('my-event', this._onStatus);
},

destroy(socket) {
  socket.off('my-event', this._onStatus);
}
```

Every `setInterval` needs a matching `clearInterval` in `destroy()`.

### Use skeleton loaders

Show loading placeholders while data fetches. The `skeletonRows` helper generates them:

```javascript
init(contentEl, socket) {
  contentEl.innerHTML = skeletonRows(5, 'list');
  fetch('/api/my-data').then(r => r.json()).then(data => {
    contentEl.innerHTML = this._renderList(data);
  });
}
```

Patterns: `'list'` (lines), `'table'` (rows with columns), `'card'` (card shapes).

### Escape all dynamic content

Always use the `esc()` helper for any user-controlled or API-returned strings:

```javascript
contentEl.innerHTML = `<div>${esc(item.name)}</div>`;
```

This prevents XSS from malicious data.

### Persist user preferences

Use `localStorage` for filter state, view mode, selected options — anything that should survive a page reload:

```javascript
init(contentEl) {
  this._filter = localStorage.getItem('my-widget-filter') || 'all';
}

// When filter changes:
localStorage.setItem('my-widget-filter', this._filter);
```

### No ES module syntax

Widgets are loaded as plain `<script>` tags. Don't use `import`/`export`. Everything is global.

### Follow the comment header convention

Start each widget file with:

```javascript
/* Widget: my-widget */
```

## Widget with Socket.IO

For real-time data, listen on Socket.IO events:

```javascript
WIDGET_REGISTRY['live-counter'] = {
  title: 'Live Counter',
  icon: '📈',
  defaultSize: { w: 3, h: 2 },
  minW: 2,
  minH: 2,

  init(contentEl, socket) {
    this._el = contentEl;
    this._count = 0;

    this._onIncrement = (data) => {
      this._count = data.count;
      this._render();
    };
    socket.on('counter-update', this._onIncrement);

    this._render();
  },

  refresh(socket) {
    socket.emit('counter-request');
  },

  destroy(socket) {
    socket.off('counter-update', this._onIncrement);
  },

  _render() {
    this._el.innerHTML = `<div style="font-size:3rem; text-align:center; padding:1rem;">${this._count}</div>`;
  },
};
```

## Widget with REST API

For on-demand data fetching:

```javascript
WIDGET_REGISTRY['api-widget'] = {
  title: 'API Data',
  icon: '🔗',
  defaultSize: { w: 4, h: 3 },
  minW: 2,
  minH: 2,

  init(contentEl) {
    this._el = contentEl;
    this._load();
  },

  refresh() {
    this._load();
  },

  destroy() {
    // No socket listeners to clean up
  },

  async _load() {
    this._el.innerHTML = skeletonRows(3, 'list');
    try {
      const res = await fetch('/api/my-endpoint');
      const data = await res.json();
      this._el.innerHTML = data.items
        .map(item => `<div class="list-item">${esc(item.label)}</div>`)
        .join('');
    } catch (err) {
      this._el.innerHTML = `<div class="widget-empty">Failed to load data</div>`;
    }
  },
};
```

## Adding Server Endpoints

If your widget needs custom data, add a REST endpoint in `server.mjs`:

```javascript
app.get('/api/my-endpoint', (_req, res) => {
  // Your data logic
  res.json({ items: [...] });
});
```

For real-time push, emit Socket.IO events from the connection handler:

```javascript
io.on('connection', (socket) => {
  // Inside the existing connection handler:
  socket.on('my-request', () => {
    socket.emit('my-response', { data: '...' });
  });
});
```

## Dynamic Widget Factories

For widgets that are created at runtime (like metric widgets or service log widgets), use a registration function:

```javascript
function registerMyWidget(key, definition) {
  const widgetKey = `my-${key}`;
  WIDGET_REGISTRY[widgetKey] = {
    title: definition.label,
    icon: '🔧',
    defaultSize: { w: 3, h: 2 },
    minW: 2,
    minH: 2,
    init(contentEl, socket, config) { /* ... */ },
    refresh(socket) { /* ... */ },
    destroy(socket) { /* ... */ },
  };
}
```

See `service-log.js` (`registerServiceWidget`) and `metric.js` (`registerMetricWidget`) for production examples.
