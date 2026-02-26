---
name: revert
description: Revert the working tree to a previous ADIT checkpoint. Use when the user wants to undo AI changes or go back to an earlier state.
---

# ADIT Revert

Revert to a specific checkpoint: `adit revert $ARGUMENTS --yes`

If no checkpoint ID is provided, show recent checkpoints first:
!`adit list --checkpoints --limit 10`

IMPORTANT: Always confirm with the user before reverting. Show them what will change using `adit diff <id>` first.
