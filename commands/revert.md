---
name: revert
description: Revert working tree to an ADIT checkpoint
---

Restore the working tree to the state captured at a specific checkpoint.
This uses `git reset --hard` to the checkpoint's shadow commit.

Run: `npx adit revert <event-id>`

Use `npx adit undo` to revert to the parent of the last checkpoint.

Warning: This will discard uncommitted changes.
