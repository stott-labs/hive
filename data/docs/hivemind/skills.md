# Hivemind Skills

Hivemind provides 10 slash commands available in every Claude Code session. Each skill is a directory under `.claude/skills/` containing a `SKILL.md` definition file.

## Planning & Requirements

### /prd — Product Requirements Document

Generates a concise, structured PRD from a feature description. The output is deliberately constrained to one page (~600-800 words) with a fixed structure:

- Problem Statement
- Goals
- Non-Goals
- Assumptions
- Functional Requirements
- Edge Cases
- Open Questions

**Hard rules:** No code, pseudo-code, API schemas, UI mockups, or implementation steps. The PRD captures *what* and *why*, never *how*.

The generated PRD is meant to be frozen — don't edit it after generation. It becomes the input for `/handoff` and the validation target for `/validate`.

**Example:**
```
/prd Users should be able to bulk-assign tickets to team members from the kanban board
```

---

### /handoff — Implementation Tasks

Translates a frozen PRD into implementation-ready engineering tasks. Output format:

- Overview (what the PRD is asking for)
- Task breakdown (T-1, T-2, T-3, ...) with title, scope, description, acceptance criteria
- Edge case coverage
- Validation checklist

Each task is written so an engineer can execute it without interpretation. Acceptance criteria are objectively verifiable — "the button is blue" not "the UX is good."

**Usage:** Run `/handoff` after generating a PRD. Claude reads the PRD from the conversation or a file path.

---

### /validate — Implementation Review

Validates completed work against a PRD. Produces three sections:

- **Matches** — Requirements correctly implemented
- **Gaps** — Missing or incomplete requirements
- **Deviations** — Behavior not specified in the PRD

This is a read-only check — it doesn't suggest refactoring, new features, or code quality improvements. It only measures the implementation against the original specification.

---

## Development Workflow

### /create-pr — Pull Request

Creates a pull request in Azure DevOps or GitHub. The workflow is automatic:

1. Detects the current branch name and extracts a work item ID (from patterns like `bug-1234-fix-login`)
2. Collects all commits since diverging from the target branch
3. Generates PR title and description from the commit history
4. Links the work item to the PR (ADO only)
5. Adds configured reviewers
6. Resets all configured repos back to the default branch

**Branch naming convention:** `{type}-{id}-short-description`

Supported types: `bug`, `feature`, `story`, `task`, `user`, `userstory`

**Special case:** Running `/create-pr` on the `development` branch creates a release PR targeting `main`.

**ADO mode:** Uses MCP for API calls. Requires `ADO_PAT` environment variable.

**GitHub mode:** Uses `gh` CLI. Requires `GITHUB_TOKEN` or `gh auth login`.

---

### /create-bug — Bug Entry

Creates a bug tracking entry with up to three artifacts:

1. **Work item** — ADO Bug or GitHub Issue
2. **Documentation file** — Markdown in `docs/Bugs/Bug-{ID}-{title}.md` (optional, if docs path configured)
3. **Git branch** — `bug-{ID}` or `bug-{ID}-short-description` in the affected repo

Supports two modes:

- **New bug:** Describe the bug in natural language. Claude creates the work item, then generates documentation.
- **Existing bug:** Provide a work item ID. Claude fetches the data from ADO/GitHub and populates the documentation template.

The documentation template includes: frontmatter metadata, symptoms, reproduction steps, environment details, investigation notes, root cause analysis, and fix details.

---

### /stash-branch — Move Changes to New Branch

Moves all uncommitted changes (staged, unstaged, and untracked files) to a new branch. Useful for:

- Started work on the wrong branch
- Want to park changes for later
- Need to context-switch without losing work

Process: stash with descriptive message → create branch → pop stash onto new branch. If branch creation fails, the stash is popped back to prevent data loss.

---

## Repository Management

### /repos — Status Snapshot

Displays a live status table of all sibling repositories:

```
Name       Branch        Changed   Staged   Unstaged   Untracked
my-api     feature-123   3         1        2          0
my-web     main          0         0        0          0
my-db      main          1         0        0          1

3 repos — 1 clean, 2 with changes
```

Resolves the base directory from `PROJECTS_DIR` in `~/.config/hivemind/paths.env`. Auto-detects detached HEAD state.

---

### /dashboard — Launch HIVE

Launches the HIVE dashboard as a detached background process. Features:

- Auto-installs dependencies on first run (`npm install`)
- Checks port availability before launching
- Survives Claude session restarts and context compression
- Opens `http://localhost:3333` in the default browser

Commands:
- `/dashboard` — Launch (or show status if already running)
- `/dashboard stop` — Stop the running instance
- `/dashboard restart` — Stop and relaunch

Requires HIVE to be installed. Looks for it at the path configured during setup.

---

## Automation

### /loop — Recurring Prompt (Session-Local)

Runs a prompt or command on a repeating interval within the current session.

```
/loop check git status every 5m max 12
/loop run tests every 30m until all passing
```

| Argument | Format | Example |
|----------|--------|---------|
| Interval | `Ns`, `Nm`, `Nh` | `5m`, `30s`, `1h` |
| Max iterations | `max N` | `max 12` |
| Stop condition | `until <text>` | `until all passing` |

The loop runs until the session ends, the max is reached, or the stop condition is met. Each iteration is timestamped.

---

### /schedule — Persistent Scheduled Agents

Creates recurring Claude agents that persist across session restarts.

```
/schedule run tests every hour
/schedule check deploy status daily at 9am
/schedule pull all repos weekdays at 8:30am
```

Supports cron expressions (`0 9 * * 1-5`) and natural language (`every 30 minutes`, `daily at noon`).

Management commands:
- `/schedule list` — Show all scheduled agents
- `/schedule delete {name}` — Remove a scheduled agent
- `/schedule status` — Check what's running

Each run creates a new agent context — there's no shared state between executions.

---

## Provider Support

| Skill | ADO | GitHub | Neither |
|-------|-----|--------|---------|
| /prd | works | works | works |
| /handoff | works | works | works |
| /validate | works | works | works |
| /create-pr | MCP | gh CLI | — |
| /create-bug | MCP | gh CLI | — |
| /stash-branch | — | — | git only |
| /repos | — | — | git only |
| /dashboard | — | — | HIVE only |
| /loop | works | works | works |
| /schedule | works | works | works |
