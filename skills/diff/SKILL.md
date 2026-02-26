---
name: diff
description: Show the code diff for an ADIT checkpoint event. Use when the user wants to see what changed in a specific checkpoint.
---

# ADIT Diff

Show the diff for a checkpoint event:

`adit diff $ARGUMENTS`

If the user provides a checkpoint ID, show the diff directly.
If not, list recent checkpoints first:
!`adit list --checkpoints --limit 5`

Use `--file <path>` to filter the diff to a specific file.
