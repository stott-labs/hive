---
type: ADR
status: Accepted
---

# ADR-003: Real-Time Log Streaming via File Watchers

**Date:** 2026-02  
**Status:** Accepted

## Context

Developers run multiple services during development (API server, web frontend, background workers). They need to see log output from all services in one place, updating in real time. The dashboard should show logs without requiring developers to change how they start their services.

Two fundamental design questions:

1. Should HIVE manage (spawn/kill) service processes, or just observe them?
2. How should log data flow from services to the browser?

## Decision

**HIVE observes log files. It does not manage processes.**

Services write their output to log files (via shell redirection or `tee`). HIVE watches those files with `fs.watch()` and pushes new lines to all connected browsers via Socket.IO.

```
Service process → stdout → log file (via tee/redirect)
                                ↓
                         fs.watch() detects change
                                ↓
                         HIVE reads new bytes (offset tracking)
                                ↓
                         Socket.IO push → all browsers
```

## Reasoning

**Zero process coupling.** If HIVE crashes, your services keep running. If a service crashes, HIVE keeps running. They're completely independent. A process-manager approach (like PM2 or a built-in `child_process.spawn`) would tie service lifecycle to the dashboard — restarting HIVE would kill all services.

**No workflow change.** Developers already run services in terminals. They just need to redirect output to a file: `npm run dev 2>&1 | tee ~/.hive/logs/api.log`. Their existing scripts, debuggers, and workflows remain unchanged.

**`fs.watch()` is nearly free.** It uses OS kernel notifications (inotify on Linux, FSEvents on macOS, ReadDirectoryChangesW on Windows). There's zero CPU overhead when logs are idle. The alternative — polling the file system on an interval — would waste cycles and introduce latency.

**Offset tracking prevents re-reading.** HIVE tracks how many bytes it has read from each file. When `fs.watch` fires, it reads only the new bytes appended since the last read. If the file is truncated (service restart), the offset resets to zero.

**Buffer replay on connect.** The server keeps the last ~1000 lines per service in memory. When a new browser tab connects, it replays the buffer immediately so the log panel isn't empty. This gives the feel of a persistent terminal without actual persistence.

## Alternatives Considered

**Process management (spawn services from HIVE)** — Would give tighter control (restart buttons, exit code tracking) but creates dangerous coupling. A dashboard bug shouldn't be able to kill your API server mid-request. Process management is a solved problem (PM2, systemd, Docker) — HIVE shouldn't reinvent it.

**Direct stdout piping (child_process.spawn)** — Same coupling problem, plus it forces services to be children of the HIVE process. Can't attach a debugger to a child process as easily. Doesn't work for services that are already running.

**WebSocket log server in each service** — Each service would expose a WebSocket endpoint for log streaming. This requires modifying every service, adding a dependency, and configuring ports. Invasive and fragile.

**Polling the file system** — Read the file every N milliseconds and diff against the last read. Works but wastes CPU when logs are idle (most of the time) and introduces latency proportional to the poll interval.

## Consequences

**Positive:**
- Services survive HIVE restarts (and vice versa)
- Works with any process — Node, Python, Go, Docker containers — anything that writes to a file
- Zero CPU overhead when logs are idle
- Developers keep their existing terminal workflows
- No dependencies added to monitored services

**Negative:**
- Requires log file setup — developers must redirect output to a known path
- No process control from the dashboard (can't restart a service from the UI without external tooling)
- Log file rotation must be handled externally (HIVE doesn't truncate or rotate)
- `fs.watch` behavior varies slightly across operating systems (though Node abstracts most differences)
