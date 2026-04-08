---
type: ADR
status: Accepted
---

# ADR-006: Two-Tier Git Polling

**Date:** 2026-02  
**Status:** Accepted

## Context

The Git Status widget shows branch name, dirty file count, and behind/ahead counts for every configured repo. This requires two types of git operations:

1. **Local operations** — `git status --porcelain`, `git branch --show-current` — fast, no network
2. **Remote operations** — `git fetch origin`, `git rev-list --left-right --count` — slow, hits the remote

Running both on the same interval creates a trade-off: poll too fast and you hammer the remote; poll too slow and local changes feel laggy.

## Decision

Split git polling into **two independent cycles**:

| Cycle | Interval | Operations | Network |
|-------|----------|-----------|---------|
| Fast | 5 seconds | `git status`, `git branch` | None |
| Slow | 60 seconds | `git fetch`, `git rev-list` | Yes |

The fast cycle keeps branch names and dirty file counts current. The slow cycle updates behind/ahead counts against the remote. Both run per-repo with a 5-second (fast) or 15-second (slow) timeout to prevent hangs.

## Reasoning

**Local git operations are instant.** `git status --porcelain` reads the index and working tree — no network, no disk seeks beyond the `.git` directory. Running it every 5 seconds has negligible cost and makes the dashboard feel live. Developers see their changes reflected within seconds of saving a file.

**Remote operations are expensive and rate-limited.** `git fetch` opens an SSH or HTTPS connection to the remote, negotiates refs, and downloads objects. With 5 repos, fetching every 5 seconds means 60 remote connections per minute. Git hosting providers throttle this. Fetching every 60 seconds is a reasonable compromise.

**Staggered execution prevents thundering herd.** The slow cycle runs repos sequentially (not in parallel) to avoid opening 5 simultaneous SSH connections. The fast cycle runs all repos in parallel via `Promise.all()` since local operations don't contend.

**Cached counts are always available.** The UI always has something to show — the last-known behind/ahead count from the slow cycle, combined with the live branch and dirty count from the fast cycle. There's never a blank or loading state after the first cycle completes.

## Alternatives Considered

**Single polling interval (10s)** — Compromise between fast and slow. But 10 seconds is too slow for local status (feels laggy) and too fast for remote fetch (wastes bandwidth, risks rate limiting).

**File system watcher for local changes** — `fs.watch()` on the entire repo would detect file changes instantly. But watching all files in a large repo (node_modules, build output) is expensive and unreliable. Git's index is the authoritative source — polling it is simpler and more reliable.

**Git hooks (post-commit, post-checkout)** — Would trigger updates on specific events. But hooks require installation in every repo, don't cover all scenarios (editor saves, branch changes from other tools), and add maintenance burden.

**WebSocket from git hosting (GitHub webhooks)** — Would provide push-based updates for remote state. But requires a public endpoint, webhook configuration per repo, and doesn't work for repos hosted on private servers without inbound access.

## Consequences

**Positive:**
- Local changes appear in the dashboard within 5 seconds
- Remote state updates every minute without hammering the hosting provider
- No configuration needed — the intervals are hardcoded sensible defaults
- Graceful degradation — if a repo hangs, the timeout kills it and other repos continue

**Negative:**
- Behind/ahead counts can be up to 60 seconds stale
- The slow cycle can't be manually triggered from the UI (only automatic)
- Sequential slow-cycle execution means the last repo in the list waits for all others to complete
- No adaptive polling — the interval doesn't speed up when activity is detected
