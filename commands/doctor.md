---
name: doctor
description: Check ADIT installation health
---

Validate that ADIT is correctly set up in the current project.

Run: `npx adit doctor`

Checks:
- Git repository exists
- .adit/ data directory exists
- Database is accessible
- Hooks are installed
- Checkpoint refs are consistent
