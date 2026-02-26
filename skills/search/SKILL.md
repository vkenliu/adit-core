---
name: search
description: Search ADIT timeline events by text, including prompts, tool names, and responses.
---

# ADIT Search

Search the timeline: `adit search "$ARGUMENTS"`

Available filters:
- `--actor <actor>` — Filter by actor (assistant, user, tool, system)
- `--type <type>` — Filter by event type
- `--from <date> --to <date>` — Date range filter
- `--branch <branch>` — Filter by git branch
- `--has-checkpoint` — Only events with checkpoints
- `--format json` — JSON output
- `--limit <n>` — Limit results (default 20)
