---
type: ADR
status: Accepted
---

# ADR-009: Named Layouts with Tab System

**Date:** 2026-03  
**Status:** Accepted

## Context

The dashboard started with a single grid layout saved to `localStorage`. This worked for one developer on one machine, but didn't support:

- Multiple layout configurations (a monitoring view vs a development view)
- Sharing layouts across machines (localStorage doesn't sync)
- Widget tabs (moving a widget from the grid into a persistent tab for quick access)
- Surviving browser data clears

The layout system needed to evolve from "one implicit layout in the browser" to "named layouts persisted on the server."

## Decision

Implement a **named layout system** with server-side persistence and localStorage as a cache:

- Layouts are stored in `data/layouts.json` on the server (source of truth)
- localStorage caches the current state for offline/fast access
- On startup, the server's data wins and syncs to localStorage
- Multiple named layouts can be saved, switched, and deleted
- Each layout stores grid positions, tab widgets, and a list of removed widgets

### Data Structure

```json
{
  "layouts": {
    "Default": {
      "grid": [
        { "id": "git-status", "x": 0, "y": 0, "w": 6, "h": 4 },
        { "id": "sentry", "x": 6, "y": 0, "w": 6, "h": 4 }
      ],
      "tabs": ["commit-history", "ado"],
      "removed": ["cli-tools"]
    },
    "Monitoring": {
      "grid": [...],
      "tabs": [...],
      "removed": [...]
    }
  },
  "active": "Default",
  "tabOrder": ["dashboard", "commit-history", "ado"]
}
```

### Widget Tabs

Any widget can be moved from the grid into a persistent tab in the top navigation bar. Tabbed widgets get their own full-width pane instead of a grid cell. This is useful for widgets that benefit from more space (commit history, ADO work items) or that are referenced frequently.

### New Widget Detection

When a new widget is added to the codebase, the layout system auto-detects it. On load, any widget in `WIDGET_REGISTRY` that isn't in the saved grid, tabs, or removed list is added to the grid at a default position. This ensures new widgets appear automatically without requiring users to manually add them.

### Removed Widget Tracking

When a user removes a widget from their layout, its ID is added to the `removed` list. This prevents the auto-detection logic from re-adding it on next load. The user explicitly chose to remove it — the system respects that choice.

## Reasoning

**Server-side persistence survives browser clears.** Developers clear localStorage, switch browsers, or use incognito mode. The layout should survive all of these. The server file is the source of truth; localStorage is a performance cache.

**Named layouts support different workflows.** A "Monitoring" layout might show external services, Sentry, and health checks. A "Development" layout might show git status, service logs, and the API client. Switching between them should be one click, not 10 minutes of rearranging widgets.

**The removed list prevents nagging.** Without it, removing a widget and reloading the page would bring it back (because auto-detection would see it's missing from the grid). The removed list is the "I meant to do that" signal.

**Tab order persistence maintains muscle memory.** Developers expect their navigation tabs in a consistent order. The `tabOrder` array preserves the order across reloads and layout switches.

## Alternatives Considered

**localStorage only (original design)** — Simple but doesn't survive browser clears, can't be shared across machines, and isn't visible to the server (can't be backed up or versioned).

**Database-backed layouts** — Would support multi-user scenarios and access control, but requires a database dependency. Overkill for a local developer tool.

**URL-encoded layout (query string / hash)** — Would make layouts shareable via URL. But layout data is too large for a URL, and it would break deep-linking to docs/API tabs.

**Git-committed layout files** — Would share layouts across the team via version control. But personal preferences (removed widgets, tab order) would create merge conflicts. The current approach keeps layouts in `data/layouts.json` which can be gitignored or committed per team preference.

## Consequences

**Positive:**
- Layouts survive browser clears and machine switches
- Multiple named layouts for different workflows
- Widget tabs provide quick access to frequently-used panels
- New widgets auto-appear without manual configuration
- Removed widgets stay removed (user intent is preserved)

**Negative:**
- Two sources of state (server + localStorage cache) require sync logic
- Layout migration code must handle old formats on upgrade
- The first load on a fresh install must seed a default layout (fixed by persisting on first run)
- Layout JSON can grow large with many named layouts (mitigated by the data being small per layout)
