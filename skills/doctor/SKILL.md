---
name: doctor
description: Run ADIT health checks to validate the installation, hooks, database, and checkpoint integrity.
---

# ADIT Doctor

Run health checks: `adit doctor`

Options:
- `--fix` — Attempt automatic fixes for detected issues
- `--json` — Output results as JSON

Checks performed:
- Git repository detection
- Data directory and database accessibility
- SQLite integrity
- Hook configuration (per-platform)
- Checkpoint ref consistency
- Stale session detection
- adit-hook binary availability
