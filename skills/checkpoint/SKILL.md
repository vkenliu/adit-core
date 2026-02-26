---
name: checkpoint
description: Create a manual ADIT checkpoint of the current working tree state. Use when the user wants to explicitly save a snapshot before making changes.
---

# ADIT Checkpoint

Create a manual checkpoint of the current working tree:

!`adit list --checkpoints --limit 5`

Show the user the most recent checkpoints so they can see the current state.

To create a new manual checkpoint, the user should make changes and then trigger a stop event.
The ADIT hooks automatically create checkpoints when the assistant makes code changes.
