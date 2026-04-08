---
type: Index
status: active
---

# Architecture Decision Records

This directory captures the **why** behind key design choices in the HIVE platform. Each ADR documents a decision that shaped how the system works today — the context that prompted it, the options we considered, and the reasoning that led to the choice we made.

## Format

Each ADR follows a consistent structure:

- **Status** — Accepted, Superseded, or Deprecated
- **Context** — The problem or situation that required a decision
- **Decision** — What we chose and why
- **Alternatives Considered** — What we evaluated and rejected
- **Consequences** — Trade-offs, both positive and negative

## ADR Index

| # | Decision | Status |
|---|----------|--------|
| 001 | [[decisions/001-vanilla-js-architecture\|Vanilla JavaScript Architecture]] | Accepted |
| 002 | [[decisions/002-widget-plugin-system\|Widget Plugin System]] | Accepted |
| 003 | [[decisions/003-realtime-log-streaming\|Real-Time Log Streaming]] | Accepted |
| 004 | [[decisions/004-json-file-storage\|JSON File Storage]] | Accepted |
| 005 | [[decisions/005-shared-vs-private-data\|Shared vs Private Data Model]] | Accepted |
| 006 | [[decisions/006-two-tier-git-polling\|Two-Tier Git Polling]] | Accepted |
| 007 | [[decisions/007-server-side-request-proxy\|Server-Side Request Proxy]] | Accepted |
| 008 | [[decisions/008-sql-query-safety\|SQL Query Safety Model]] | Accepted |
| 009 | [[decisions/009-named-layouts\|Named Layouts with Tab System]] | Accepted |
| 010 | [[decisions/010-drone-demo-companion\|Drone Demo Companion]] | Accepted |

## When to Write an ADR

Write an ADR when:

- You make a technology choice that affects multiple parts of the system
- You reject an obvious alternative and want to explain why
- A future developer might look at the code and ask "why is it done this way?"
- You change a previous decision (supersede the old ADR)

ADRs are immutable once accepted. If a decision changes, write a new ADR that references and supersedes the original.
