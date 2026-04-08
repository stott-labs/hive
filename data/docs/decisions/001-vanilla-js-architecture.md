---
type: ADR
status: Accepted
---

# ADR-001: Vanilla JavaScript Architecture

**Date:** 2026-02  
**Status:** Accepted

## Context

HIVE is a developer dashboard — a single-page app with a grid of widgets, each rendering its own data. The frontend needed to support:

- 20+ independently-authored widget panels
- Real-time updates via Socket.IO
- Drag-and-resize layout via GridStack.js
- A plugin-like model where adding a widget means adding one file

The team had experience with React, Vue, and Angular. The question was whether a framework would accelerate development or add unnecessary weight.

## Decision

Build the entire frontend with **vanilla JavaScript, no framework, no bundler, no TypeScript**. Each widget is a plain `<script>` tag. The server is a single `server.mjs` file. There is no build step.

## Reasoning

**Widgets are isolated by design.** Each widget manages its own DOM subtree (`contentEl`) and its own socket listeners. There's no shared state between widgets — no store, no context, no props. A framework's component model would add ceremony for a problem we don't have.

**No build step means instant feedback.** Edit a file, refresh the browser. No waiting for Webpack, Vite, or esbuild. No source maps to debug. No dependency tree to reason about. This matters for a tool that developers use *while developing* — the dashboard itself shouldn't have a development workflow.

**GridStack.js is framework-agnostic.** GridStack operates directly on DOM elements. Using React or Vue would require a wrapper component that translates between the framework's virtual DOM and GridStack's direct DOM manipulation. These wrappers are notoriously fragile and add a layer of bugs we'd have to maintain.

**The total frontend is small.** The entire frontend is ~10 files. The complexity ceiling is low enough that vanilla JS remains readable and maintainable. If the frontend grew to 50+ components with shared state, we'd revisit this.

**Ownership and debuggability.** With no framework, there are no abstractions between us and the browser. `document.createElement`, `addEventListener`, `innerHTML`. Every developer on the team can read and modify the code without learning a framework's idioms or debugging through its internals.

## Alternatives Considered

**React** — Component model would be clean for widgets, but JSX requires a build step, React's reconciler would conflict with GridStack's direct DOM manipulation, and Socket.IO integration requires manual effect cleanup that mirrors what we'd write in vanilla JS anyway.

**Vue** — Single-file components are appealing, but the reactivity system is overkill for widgets that re-render by replacing `innerHTML`. Vue's template compilation also requires a build step (or runtime compiler, which is large).

**Svelte** — Closest to vanilla output, but still requires a compiler. Adds tooling complexity for a project that prioritizes zero-config.

**TypeScript** — Adds type safety but requires compilation. For a project this size, the cost of maintaining `tsconfig.json`, dealing with type definition files for GridStack/Socket.IO, and adding a build step outweighs the benefit. JSDoc comments provide type hints where needed.

## Consequences

**Positive:**
- Zero build tooling to install, configure, or maintain
- New contributors can read the code immediately — it's just JavaScript
- Adding a widget is truly one file + one `<script>` tag
- No framework version upgrades or breaking changes to track
- The dashboard loads in milliseconds (no JS bundle to parse)

**Negative:**
- No virtual DOM — widgets that frequently update must manage their own DOM diffing or accept full re-renders
- No component encapsulation — all widget code shares the global scope (name collisions are possible but haven't occurred)
- No TypeScript — typos in property names fail silently at runtime
- Testing is manual — no component testing framework (Jest/RTL/Vitest) without a build step
