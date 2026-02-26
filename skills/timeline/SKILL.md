---
name: timeline
description: Show the ADIT timeline of recent events including prompts, tool calls, and checkpoints. Use when the user wants to see what happened during the session or review recent AI actions.
---

# ADIT Timeline

Show the recent ADIT timeline. Run the adit CLI to list events:

!`adit list --limit 20 --expand`

Present the timeline in a readable format, highlighting:
- Checkpoint events (these have revertible snapshots)
- The sequence of prompt → tool calls → response
- Any environment drift warnings

If the user asks about a specific event, use `adit show <id>` for details.
