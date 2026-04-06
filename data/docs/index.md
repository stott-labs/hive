# The Hive Platform

**H.I.V.E.**, **Hivemind**, and **Drone** are three open-source projects that together form a developer productivity platform built around Claude Code. They solve a common pain point: development teams juggle too many tabs, terminals, and tools — and AI assistants forget everything between sessions.

## The Three Projects

### H.I.V.E. — Hub for Integrated Visualization & Exploration

A self-hosted, browser-based developer dashboard. One tab replaces a dozen. Git status across repos, live service logs, external health monitors, a built-in API client, SQL metric widgets, Azure DevOps and GitHub integration, Sentry error feeds, and more — all in a draggable, resizable grid you can customize per workflow.

**Key traits:** Zero cloud dependency. Vanilla JS, no framework. Runs as a detached Node.js process that survives Claude session restarts.

[Read the full HIVE documentation →](hive/overview.md)

---

### Hivemind — Shared Claude Code Skills

A Claude Code `--add-dir` package that gives every repo on your machine the same set of AI-powered slash commands: `/prd` for product requirements, `/create-pr` for pull requests, `/create-bug` for bug tracking, `/repos` for cross-repo status, and more.

**Key traits:** Install once, use everywhere. Org-agnostic codebase with local config. Provider-flexible (Azure DevOps or GitHub).

[Read the full Hivemind documentation →](hivemind/overview.md)

---

### Drone — Demo Simulator

A lightweight Node.js app that generates realistic development activity — real git commits, mock Sentry errors, fake ADO work items, service health fluctuations — so HIVE's dashboard comes alive during demos without needing a real development environment.

**Key traits:** Single dependency (Express). Five scripted scenarios with correlated events. Browser control panel.

[Read the full Drone documentation →](drone/overview.md)

---

## Install Order

| Step | Project | What It Does |
|------|---------|--------------|
| 1 | **H.I.V.E.** | Clone and run setup. Creates shared config, installs dashboard. |
| 2 | **Drone** *(optional)* | Clone and `npm start`. Generates demo data for HIVE. |
| 3 | **Hivemind** | Clone and run setup. Detects existing config, installs skills system-wide. |

[Quick start guide →](getting-started.md)

---

## Who This Is For

- **Platform engineers** managing multi-repo projects who want a unified view
- **Teams using Claude Code** who want consistent AI workflows across all repositories
- **Developers** tired of context-switching between ADO/GitHub, Sentry, terminals, and Postman
- **Anyone curious** about building developer tools with vanilla JS, Socket.IO, and Claude Code skills

## Design Philosophy

1. **Zero cloud dependency** — Everything runs on your machine. Your data stays local.
2. **No framework overhead** — Vanilla JS, plain HTML, CSS custom properties. No bundler, no build step.
3. **Convention over configuration** — Sensible defaults, optional depth. Works out of the box, customizable when needed.
4. **Real artifacts, not mocks** — Drone generates actual git commits and real files. HIVE reads actual git status and real logs. Nothing is faked in production use.
5. **Survive the session** — The dashboard runs as a detached process. Skills persist via symlinks. Configuration lives in `~/.config/`. Nothing dies when Claude's context resets.
