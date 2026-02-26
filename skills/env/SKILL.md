---
name: env
description: Show the environment snapshot for an ADIT event, including git state, runtime versions, and system info.
---

# ADIT Environment

Show the environment snapshot:

`adit env $ARGUMENTS`

Available subcommands:
- `adit env latest` — Show the most recent environment snapshot
- `adit env diff <id1> <id2>` — Compare two environment snapshots
- `adit env history --limit 10` — List environment snapshot history

Environment snapshots capture: git branch/HEAD, runtime versions, OS info, dependency lock hash, and modified files.
