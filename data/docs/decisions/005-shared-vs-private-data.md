---
type: ADR
status: Accepted
---

# ADR-005: Shared vs Private Data Model

**Date:** 2026-02  
**Status:** Accepted

## Context

HIVE is used by development teams. Some data should be shared across the team (API collection templates, metric definitions, dashboard config), while other data is personal (credentials, private requests, UI preferences). The system needs to support both without merge conflicts or accidental credential exposure.

## Decision

Use a **dual-directory model** with two storage roots:

| Path | Scope | Git Status |
|------|-------|------------|
| `data/` (project directory) | Shared — committed to repo | Tracked |
| `~/.config/hive/data/` | Private — per user, per machine | Ignored |

When both paths contain data of the same type, private data takes precedence. The API merges both sources and marks each item with `_source: 'shared'` or `_source: 'private'` so the frontend can display the distinction.

## Reasoning

**Credentials stay off the repo.** API collections often contain auth tokens, API keys, or passwords in headers. Private collections live in `~/.config/` which is never committed. Shared collections contain templates with `{{variable}}` placeholders — credentials live in environments that are also per-user.

**Team templates without merge conflicts.** A team lead creates a collection with standard API endpoints and commits it to `data/api/collections.json`. Every developer gets it on `git pull`. They can fork it into their private directory to add personal tweaks without creating a merge conflict.

**User preferences are inherently personal.** Which repos are hidden, which services are collapsed, sidebar widths — these vary by developer and by machine. Storing them in `~/.config/hive/data/user-prefs.json` keeps them out of version control entirely.

**Private overrides shared by ID.** If a shared collection has ID `col_abc` and a private collection also has `col_abc`, the private version wins. This allows developers to "fork" a shared template and customize it without affecting the team copy.

## Alternatives Considered

**Single directory with .gitignore patterns** — Would keep everything in one place but requires careful gitignore maintenance. A new file type would need a new ignore rule. Easy to accidentally commit credentials.

**Database with user accounts** — Would provide proper access control but requires authentication, user management, and a database dependency. Overkill for a local developer tool.

**Environment variables for all credentials** — Works for a few tokens but doesn't scale to per-request auth headers, custom certificates, or multi-environment credentials. Environment variables also can't represent structured data (collections with nested folders).

## Consequences

**Positive:**
- Credentials never appear in git history
- Team templates propagate via normal `git pull`
- Each developer can customize without conflicts
- Private data survives repo clones (lives in `~/.config/`)
- Clear separation — developers know where their data lives

**Negative:**
- Two places to look when debugging data issues
- Private data doesn't sync across machines (by design, but can surprise users)
- The merge logic (private overrides shared by ID) could silently hide team updates
- No mechanism to "push" private changes back to shared (manual copy required)
