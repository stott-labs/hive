---
type: Implementation Note
status: active
---

# Layout Persistence & First-Run Seeding

**Date:** 2026-03  
**Related ADR:** [[decisions/009-named-layouts]]

## Problem

The dashboard layout system evolved through three phases, each solving a problem introduced by the previous one:

1. **Phase 1: localStorage only** — Layout saved in the browser. Clearing browser data lost the layout. Couldn't share across machines.
2. **Phase 2: Server-side layouts.json** — Layout persisted to disk. Survived browser clears. But on first run, `layouts.json` was empty, so the hardcoded `DEFAULT_LAYOUT` constant was used as a fallback — and never persisted. Any grid event before the fallback was saved could overwrite the intended default.
3. **Phase 3: First-run seeding** — The fallback default is now explicitly saved to `layouts.json` on first load.

## What Changed

### Migration from localStorage to Server

The `_loadLayoutsFromServer()` function in `app.js` implements a server-first sync:

1. Fetch `GET /api/layouts` from server
2. If server has data → sync to localStorage (server wins)
3. If server is empty → check localStorage for legacy data and migrate it up to the server

This ensures the server file is always the source of truth, while localStorage provides a fast cache for the current session.

### Legacy Key Migration

Old single-layout keys (`dashboard-layout`, `dashboard-tab-widgets`) are detected on startup and converted into a named "Default" layout in the new system. The old keys are then deleted. This migration runs once and is transparent to the user.

### First-Run Seeding Fix

The hardcoded `DEFAULT_LAYOUT` constant defines the initial widget arrangement:

```javascript
const DEFAULT_LAYOUT = [
  { id: 'ado',               x: 0, y: 0,  w: 5, h: 5 },
  { id: 'commit-history',    x: 5, y: 0,  w: 4, h: 5 },
  { id: 'releases',          x: 9, y: 0,  w: 3, h: 3 },
  // ...
];
```

Previously, this was applied on load but never persisted. If a grid change event fired before the user explicitly saved (which happens automatically during GridStack initialization), the saved layout could differ from the intended default.

The fix: after applying the fallback default and re-enabling saves (`suppressSave = false`), explicitly call `saveLayout()` to persist it. This ensures `layouts.json` always has a "Default" entry after first load.

### New Widget Auto-Detection

When a developer adds a new widget to the codebase, the layout loader detects it:

1. Build the full default layout (hardcoded defaults + dynamic service widgets)
2. Compare against the saved layout
3. Any widget in the default that isn't in the saved grid, tabs, or removed list gets auto-added

The `removed` list is critical here — it tracks widgets the user explicitly removed. Without it, removing a widget and reloading would bring it back.

## Design Decisions

**Why `suppressSave` during initialization:** GridStack fires `change` events when widgets are added during `applyLayout()`. Without suppression, each widget addition would trigger a save — writing an incomplete layout to disk. The flag prevents saves until all widgets are placed and the layout is stable.

**Why server wins over localStorage:** If both have data, the server is preferred because it's the persistent source. localStorage might contain stale data from a previous session where the user made changes on a different machine (or in a different browser) that were saved to the server.

**Why not seed `layouts.json` in setup scripts:** The default layout includes dynamic widgets (service logs) that depend on runtime configuration. The full default can only be computed in the browser after `initServices()` resolves. Seeding a static file in setup would miss dynamic widgets.

## Lessons Learned

- **Fallback logic needs persistence.** A fallback that's applied but never saved is fragile — anything that triggers a save before the fallback is explicitly persisted can overwrite it with partial state.
- **Suppress saves during bulk operations.** GridStack's event-driven model fires events for every individual widget change. Bulk operations (layout load, widget migration) need a flag to batch the final save.
- **Track negative state (removed list), not just positive state (grid + tabs).** Without a "removed" list, the system can't distinguish "user hasn't seen this widget yet" from "user saw it and removed it."
