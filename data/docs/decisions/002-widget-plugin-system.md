---
type: ADR
status: Accepted
---

# ADR-002: Widget Plugin System

**Date:** 2026-02  
**Status:** Accepted

## Context

The dashboard needs a way to add, remove, and configure independent panels. Each panel shows different data (git status, service logs, Sentry errors, ADO work items, etc.) and has its own data-fetching and rendering logic. The system should make it trivial for a developer to add a new widget without modifying existing code.

## Decision

Use a **global `window.WIDGET_REGISTRY` object** where each widget self-registers by key. Widgets are plain JavaScript objects with three lifecycle methods: `init`, `refresh`, and `destroy`. Each widget lives in its own file under `public/widgets/` and is loaded via a `<script>` tag in `index.html`.

```javascript
// public/widgets/my-widget.js
WIDGET_REGISTRY['my-widget'] = {
  title: 'My Widget',
  icon: '📋',
  defaultSize: { w: 4, h: 3 },
  init(contentEl, socket, config) { /* set up DOM and listeners */ },
  refresh(socket) { /* re-fetch and re-render */ },
  destroy(socket) { /* clean up listeners and timers */ },
};
```

## Reasoning

**Self-registration eliminates coordination.** There's no central manifest, no import map, no router config to update. Each widget file is self-contained — it registers itself when the `<script>` tag loads. The grid iterates `Object.keys(WIDGET_REGISTRY)` to discover available widgets.

**The three-method contract is minimal but sufficient.** `init` handles setup (DOM creation, socket listeners, initial data fetch). `refresh` handles manual reload. `destroy` handles cleanup (removing socket listeners and clearing timers). This covers every widget's lifecycle without imposing a complex component model.

**Runtime registration enables dynamic widgets.** The metric system (`metric.js`) and service log system (`service-log.js`) create widgets at runtime based on server configuration. `registerMetricWidget(metric)` creates and registers a widget from a SQL query definition. This would be awkward with a compile-time module system.

**Global scope is intentional.** Since there's no bundler (see [[decisions/001-vanilla-js-architecture]]), all files share the global scope. The registry, helpers (`esc()`, `skeletonRows()`), and the Socket.IO client are all globals. This is a feature, not a bug — it keeps widget files simple and dependency-free.

## Alternatives Considered

**ES Modules with dynamic import()** — Would provide encapsulation and lazy loading, but requires a module-aware server setup (MIME types, import maps) and makes the Socket.IO client harder to share. The widgets are small enough that lazy loading provides no measurable benefit.

**Custom Elements (Web Components)** — Shadow DOM would provide style isolation, but GridStack manipulates widget containers directly. Shadow DOM boundaries would complicate GridStack's resize/drag behavior and make shared theme variables harder to apply.

**Event-based plugin system** — Widgets could register via a `registerWidget()` function that validates the contract. We chose direct object assignment for simplicity — the contract is enforced by convention and documented in CLAUDE.md. A validation layer could be added later if needed.

## Consequences

**Positive:**
- Adding a widget is a 4-step process: create file, register object, add `<script>` tag, add to picker
- Dynamic widgets (metrics, services) work the same way as static widgets
- No framework lock-in — widgets are plain objects with DOM manipulation
- The widget picker auto-discovers available widgets from the registry

**Negative:**
- No enforced contract — a widget missing `destroy()` won't error until removal
- Global namespace pollution — all widgets share `window`, though collisions haven't been an issue
- Load order matters — `shared.js` must load before any widget file, and `app.js` must load after all widgets
- No lazy loading — all widget JS is parsed on page load (acceptable at current scale)
