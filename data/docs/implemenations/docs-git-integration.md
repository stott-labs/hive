---
type: Implementation Note
status: active
---

# Docs Git Integration

**Date:** 2026-03  
**Related ADR:** [[decisions/004-json-file-storage]]

## Problem

The Docs tab shows git status for the documentation directory — how many files have uncommitted changes, and which specific files are dirty. This sounds simple, but two complications made the initial implementation incorrect:

1. **The docs directory may not be its own git repo.** By default, docs live at `data/docs/` inside the HIVE repo. Git status for this directory reports changes for the *entire* HIVE repo, not just the docs.

2. **Git porcelain paths don't match tree paths.** `git status --porcelain` returns paths relative to the repository root (e.g., `data/docs/getting-started.md`), but the docs tree uses paths relative to the docs directory (e.g., `getting-started.md`). The status bar showed "2 changed" but no files were highlighted in the tree — the paths never matched.

## What Changed

### Path Normalization

The `/api/docs/git/status` endpoint now:

1. Runs `git rev-parse --show-toplevel` to find the repository root
2. Computes the relative path from repo root to docs directory (e.g., `data/docs`)
3. Filters porcelain output to only include files under the docs prefix
4. Strips the prefix from each path so they match the tree's relative paths

```javascript
const repoRoot = execSync('git rev-parse --show-toplevel', { cwd: docsDir }).trim();
const prefix = relative(repoRoot, docsDir);  // "data/docs"
const prefixSlash = prefix ? prefix + '/' : '';

const changedPaths = status.split('\n').reduce((acc, line) => {
  const file = line.slice(3).split(' -> ').pop().trim();
  if (!prefixSlash || file.startsWith(prefixSlash)) {
    acc.push(prefixSlash ? file.slice(prefixSlash.length) : file);
  }
  return acc;
}, []);
```

### Dirty Flag Scoping

The `dirty` field in the response was changed from `status.length > 0` (any change in the entire repo) to `changedPaths.length > 0` (only docs-directory changes). This fixed a bug where non-docs changes (e.g., editing `server.mjs`) caused the docs tab to show "0 changed" instead of "clean" — `dirty` was true from the repo status, but `files` was 0 after filtering.

### Self-Contained Docs Repos

When the docs directory IS its own git repo (e.g., a separately-cloned Obsidian vault), `--show-toplevel` returns the docs directory itself. The prefix is empty, `prefixSlash` is empty, and all paths pass through unchanged. The fix handles both cases transparently.

## Design Decisions

**Why not `git status -- .` to restrict output:** Adding `-- .` to `git status` restricts the files checked but doesn't change the output format — paths are still relative to the repo root. We'd still need the prefix stripping. Also, `-- .` has edge cases with renamed files where the old path is outside the directory.

**Why compute the prefix dynamically instead of from config:** The docs directory path in the config can be relative or absolute. The git repo root can differ from the config's `projectsDir`. Computing the prefix at request time from `--show-toplevel` is always correct regardless of how the paths are configured.

**Why filter out non-docs changes instead of passing them through:** A developer editing `server.mjs` shouldn't see "1 changed" on the docs tab. The docs change indicator should only reflect docs content. Non-docs changes are visible in the Git Status widget on the dashboard grid.

## Edge Cases Handled

| Scenario | Prefix | Behavior |
|----------|--------|----------|
| Docs inside HIVE repo (`data/docs/`) | `data/docs` | Strip prefix, filter non-docs changes |
| Docs as own git repo | (empty) | All paths pass through unchanged |
| Docs in a deeply nested subdirectory | `path/to/docs` | Strip full prefix |
| Windows paths with backslashes | Normalized to `/` | Both repo root and docs dir normalized before `relative()` |

## Lessons Learned

- **`git status --porcelain` paths are always repo-root-relative.** This is by design in git — the `cwd` affects which repo is used, not the path format. Any code that compares porcelain paths to application-relative paths must account for this.
- **Test with nested directories, not just standalone repos.** The initial implementation worked perfectly when docs had their own `.git`. The bug only appeared when docs were a subdirectory of a larger repo — the more common case.
- **`dirty` and `files` must derive from the same filtered set.** Using the full repo status for `dirty` and filtered docs for `files` created an inconsistency that was confusing to users (showing "0 changed" in orange instead of "clean" in green).
