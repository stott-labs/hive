---
type: ADR
status: Accepted
---

# ADR-010: Drone Demo Companion

**Date:** 2026-03  
**Status:** Accepted

## Context

HIVE is a developer dashboard that monitors real infrastructure — git repos, running services, external APIs, Sentry, Azure DevOps. To demonstrate HIVE to someone who doesn't have that infrastructure, we need either:

1. A production-like environment to point at (expensive, risky, requires credentials)
2. A way to generate realistic activity locally

Without one of these, a demo shows an empty dashboard with no data — not compelling.

## Decision

Create **Drone**, a companion Node.js app in a separate repository that generates realistic development activity. Drone runs alongside HIVE and simulates the signals that HIVE monitors:

- **Real git commits** — Drone makes actual commits to its own repo, so the git status widget shows branch changes, dirty files, and commit history
- **Mock API endpoints** — Drone serves Sentry-compatible error feeds, ADO-compatible work item APIs, and health check endpoints that HIVE polls
- **Service health fluctuations** — Endpoints randomly transition between operational, degraded, and down states
- **Scripted scenarios** — Five pre-built scenarios that tell a story (deploy failure, hotfix flow, sprint planning, etc.) with correlated events across widgets

Drone lives at `https://github.com/Montra-Solutions/drone` and installs as a sibling repo.

## Reasoning

**Separate repo keeps HIVE clean.** Demo simulation code doesn't belong in the dashboard codebase. HIVE should remain a production tool with no demo-specific logic. Drone is optional — HIVE works without it.

**Real artifacts, not mocked UI.** Drone generates actual git commits, not fake git status responses. HIVE reads real `.git` state, just like it would in production. This proves that the monitoring pipeline works end-to-end, not just the rendering layer.

**Scripted scenarios tell a story.** A random data generator produces noise. Scenarios produce narrative — "a deploy failed, the team noticed in Sentry, created a work item, pushed a hotfix, verified the fix." This is far more compelling in a demo than random status changes.

**Zero-config when paired with HIVE.** Drone's setup script auto-detects HIVE, injects demo tokens, and configures external monitors. The setup experience documented in [[implemenations/setup-changes]] reduced this to two commands: `npm start` then `node setup.mjs`.

**Correlated events across widgets.** When Drone simulates a deploy failure, the git status widget shows a new commit, the Sentry widget shows new errors, the external services widget shows degraded health, and the ADO widget shows a new bug. This demonstrates HIVE's value — one place to see everything.

## Alternatives Considered

**Built-in demo mode in HIVE** — Add a `--demo` flag that generates fake data internally. This pollutes the HIVE codebase with simulation logic, makes it harder to distinguish demo code from production code, and means "demo mode" would need to be maintained alongside every new feature.

**Docker Compose environment** — Spin up real services (PostgreSQL, a mock API, a web server) in containers. Realistic but heavy — requires Docker, takes minutes to start, and consumes significant resources. Not suitable for a quick demo on a conference laptop.

**Recorded data playback** — Record real API responses and play them back. Simpler than live simulation but static — the data never changes, making repeated demos feel stale. Also can't generate real git commits.

**Cloud-hosted demo environment** — Deploy a persistent demo instance online. Requires hosting, costs money, and creates a security surface. Defeats the "zero cloud dependency" design principle.

## Consequences

**Positive:**
- HIVE demos look alive with real, changing data
- Scenarios tell coherent stories that demonstrate cross-widget value
- Drone is optional — production HIVE installations never need it
- Real git commits prove the monitoring pipeline works end-to-end
- Setup is automated — two commands to a working demo

**Negative:**
- Second repo to clone, install, and maintain
- Drone's mock APIs must stay compatible with HIVE's expectations (coupling)
- Scenarios need updating when HIVE adds new widgets or data sources
- Git commit generation creates actual repo history (needs periodic cleanup or reset)
