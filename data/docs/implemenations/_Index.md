---
type: Index
status: active
---

# Implementation Notes

This directory captures the context behind significant implementation efforts — the problem that triggered the work, what changed, and lessons learned. Unlike ADRs (which capture *decisions*), implementation notes capture the *execution*: what actually happened when we built or changed something.

## Notes Index

| Note | Topic | Date |
|------|-------|------|
| [[implemenations/setup-changes\|Setup Experience Review]] | Analysis and plan for simplifying the 3-repo setup experience | 2026-02 |
| [[implemenations/setup-consolidation\|One-Line Setup Consolidation]] | How setup went from 10+ steps to one command | 2026-03 |
| [[implemenations/layout-persistence\|Layout Persistence & First-Run Seeding]] | Migration from localStorage to server-side layouts | 2026-03 |
| [[implemenations/database-discovery\|Database Connection Discovery]] | Environment-variable-driven connection detection with SQLite fallback | 2026-02 |
| [[implemenations/docs-git-integration\|Docs Git Integration]] | How the docs viewer handles git status in nested repositories | 2026-03 |
| [[implemenations/wiki-link-requirement\|Wiki-Link Requirement]] | Why standard markdown links 404 and wiki-links are required | 2026-04 |
