---
name: list
description: Show ADIT timeline entries
---

Show recent events from the ADIT timeline. Use this when the user asks to see
their timeline, history, recent prompts, or what happened during the session.

Run: `npx adit list`

Options:
- `--limit <n>`: Number of entries (default: 20)
- `--actor <a>`: Filter by actor (assistant|user|tool)
- `--checkpoints`: Only show events with git checkpoints
- `--query <text>`: Search by text
- `--expand`: Show longer summaries
