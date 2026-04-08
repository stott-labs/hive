---
type: Implementation Note
status: active
---

# Wiki-Link Requirement for Doc Authoring

**Date:** 2026-04

## Problem

During fresh-install testing, every cross-document link in the docs viewer returned a 404. Clicking "Read the full HIVE documentation →" on the index page navigated the browser to `http://localhost:3333/hivemind/overview.md` — a URL that doesn't exist.

The docs had been authored with standard markdown links:

```markdown
[Read the full HIVE documentation →](hive/overview.md)
```

This is valid markdown and renders correctly in GitHub, Obsidian, and every other markdown viewer. But not in the HIVE docs viewer.

## Root Cause

The docs viewer uses marked.js to render markdown. Standard links become plain `<a href="hive/overview.md">` elements. The browser resolves the `href` relative to the current page URL (`http://localhost:3333/`), producing `http://localhost:3333/hive/overview.md` — which is a static file path, not a docs API route. Result: 404.

Wiki-links take a different code path entirely. Before marked.js ever sees the content, a regex pre-processor converts `[[path|text]]` into:

```html
<a href="#" class="wiki-link" data-doc-path="path.md">text</a>
```

After rendering, a click handler on `.wiki-link` elements intercepts the click and calls `openDocTab(resolveWikilink(path))`, which fetches the file through `/api/docs/file?path=...`. The navigation stays inside the docs viewer.

## What Changed

Converted all 20 standard markdown links across 7 doc files to wiki-link syntax:

```markdown
<!-- Before (broken) -->
[Read the full HIVE documentation →](hive/overview.md)

<!-- After (works) -->
[[hive/overview|Read the full HIVE documentation →]]
```

Also expanded the [[hive/docs-viewer|Docs Viewer]] documentation with a warning callout explaining why wiki-links are required and how the resolution works.

## Why This Wasn't Caught Earlier

The docs were initially authored and reviewed in contexts where standard markdown links work (GitHub README preview, Obsidian, VS Code preview). The HIVE docs viewer's wiki-link requirement is a non-obvious constraint that only manifests at runtime in the browser.

## Authoring Rule

**All cross-document links in the docs vault must use wiki-link syntax.** Standard markdown links will silently produce 404s.

| Use this | Not this |
|----------|----------|
| `[[hive/overview\|HIVE docs]]` | `[HIVE docs](hive/overview.md)` |
| `[[getting-started]]` | `[Getting started](getting-started.md)` |
