# Contributing

The Hive platform is open-source and welcomes contributions. This guide covers how to set up a development environment and the conventions we follow.

## Development Setup

### HIVE

```bash
git clone https://github.com/your-org/hive.git
cd hive
npm install
cp dashboard.config.example.json dashboard.config.json
# Edit dashboard.config.json with your local paths
npm start
```

The server reloads automatically when you edit frontend files (they're served statically). For `server.mjs` changes, restart the process.

### Drone

```bash
git clone https://github.com/your-org/drone.git
cd drone
npm install
npm start
```

### Hivemind

```bash
git clone https://github.com/your-org/hivemind.git
cd hivemind
# Edit skills in .claude/skills/*/SKILL.md
# Test by running: claude --add-dir .
```

## Project Conventions

### Code Style

- **Vanilla JS** — No frameworks, no TypeScript, no bundler
- **ES modules** on the server (`server.mjs`), **plain scripts** on the frontend
- **Catppuccin Mocha** color theme — use CSS custom properties, not hardcoded colors
- **Single-file widgets** — One file per widget, self-registering
- **Minimal dependencies** — Justify any new npm package. Prefer built-in Node.js APIs.

### Widget Conventions

- Every widget file starts with `/* Widget: widget-name */`
- Widgets register themselves: `WIDGET_REGISTRY['widget-name'] = { ... }`
- `destroy()` must clean up all Socket.IO listeners and intervals
- Use `esc()` for all dynamic content
- Use `skeletonRows()` for loading states
- Persist user preferences to `localStorage`

### Commit Messages

We use conventional commits:

```
feat(widget): add pipeline approval button
fix(server): handle null branch in git status
refactor(db): extract connection pool factory
docs: add SQL metric creation guide
```

### Branch Naming

```
{type}-{id}-short-description
```

Types: `bug`, `feature`, `story`, `task`

Examples: `feature-42-pipeline-widget`, `bug-99-fix-log-truncation`

## Architecture Principles

1. **No build step.** Edit a file, refresh the browser. If a change requires a build tool, reconsider the approach.

2. **File-based data.** JSON files in `data/`, not a database. The dashboard itself should have zero infrastructure requirements beyond Node.js.

3. **Passive monitoring.** Use `fs.watch` (kernel notifications) instead of polling. Use TCP connect checks instead of process management. Minimize CPU when idle.

4. **Push over poll.** Use Socket.IO for anything that changes frequently. REST for on-demand requests.

5. **Widget independence.** Widgets should not depend on each other. A broken widget should not crash the dashboard.

6. **Graceful degradation.** If ADO isn't configured, the ADO widget shows an empty state — it doesn't throw errors. If the database is unreachable, metric widgets show a retry message.

## Adding a New Widget

1. Create `public/widgets/my-widget.js`
2. Implement the widget contract (`init`, `refresh`, `destroy`)
3. Add the `<script>` tag to `index.html`
4. If the widget needs server data, add REST endpoints or Socket.IO events to `server.mjs`
5. Test: add the widget from the picker, refresh, remove, re-add

See [Creating Custom Widgets](guides/creating-widgets.md) for a detailed walkthrough.

## Adding a New Hivemind Skill

1. Create `.claude/skills/my-skill/SKILL.md`
2. Define frontmatter: name, description, allowed-tools
3. Write the implementation in the body
4. Re-run Hivemind setup to create the symlink
5. Test in a Claude Code session: `/my-skill`

## Submitting Changes

1. Fork the repo and create a feature branch
2. Make your changes
3. Test locally — verify widgets load, data flows, cleanup works
4. Open a pull request with a clear description of what changed and why
5. Link any related issues

## Reporting Issues

Open an issue on the relevant repo. Include:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Browser and OS (for frontend issues)
- Node.js version (for server issues)
- Relevant config (with credentials removed)
