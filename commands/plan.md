---
name: plan
description: Manage SpecFlow plan artifacts
---

Create and manage structured development plans following the SpecFlow methodology.

Commands:
- `npx adit plan init` — Generate an Intent document to start planning
- `npx adit plan task "<title>"` — Create a task linked to the current roadmap
- `npx adit plan status` — Show plan progress and task completion

Plans are stored in `.adit/plans/` as Markdown files and in the database
for timeline linking.
