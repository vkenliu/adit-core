# ADIT — AI Development Intent Tracker

ADIT is a flight recorder for your AI-assisted development sessions.
It automatically captures prompts, code changes, and tool calls as
a navigable timeline with git-native checkpoints.

## When to Use

Use ADIT commands when the user asks about:
- Their development history or timeline
- Reverting to a previous working state
- What changed during the session
- Searching past prompts or conversations
- Planning development work
- Checking system health

## Available Commands

| User says... | Run this |
|---|---|
| "show my timeline" / "what happened" | `npx adit list` |
| "show me event X" / "details on X" | `npx adit show <id>` |
| "go back to checkpoint X" / "revert to X" | `npx adit revert <id>` |
| "undo last change" / "go back one step" | `npx adit undo` |
| "search for X" / "find where I did X" | `npx adit search "<query>"` |
| "label this as X" | `npx adit label <id> "<label>"` |
| "show the diff for X" | `npx adit diff <id>` |
| "show the prompt for X" | `npx adit prompt <id>` |
| "show environment for X" | `npx adit env <id>` |
| "check adit health" | `npx adit doctor` |
| "export event X" | `npx adit export <id>` |
| "start planning" / "create an intent" | `npx adit plan init` |
| "create a task" | `npx adit plan task "<title>"` |
| "show plan status" | `npx adit plan status` |
