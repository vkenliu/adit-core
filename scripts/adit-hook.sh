#!/usr/bin/env bash
#
# ADIT hook wrapper for Claude Code plugin.
#
# This script is called by Claude Code's hook system. It resolves
# the adit-hook binary and invokes it with the given command.
# Fail-open: any error exits 0 so the AI agent is never blocked.
#

set -o pipefail

HOOK_COMMAND="${1:-}"

# Resolve the plugin root (directory containing this script's parent)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"

# Try to find adit-hook binary in order of preference:
# 1. Local node_modules/.bin in the plugin
# 2. npx (project-local)
# 3. Global installation
find_adit_hook() {
  local bin_path="$PLUGIN_ROOT/node_modules/.bin/adit-hook"
  if [ -x "$bin_path" ]; then
    echo "$bin_path"
    return
  fi

  # Check if npx is available and adit-hook is locally installed
  if command -v npx &>/dev/null; then
    echo "npx adit-hook"
    return
  fi

  # Check global
  if command -v adit-hook &>/dev/null; then
    echo "adit-hook"
    return
  fi

  return 1
}

# Main execution
main() {
  if [ -z "$HOOK_COMMAND" ]; then
    exit 0
  fi

  local cmd
  cmd=$(find_adit_hook) || exit 0

  # Pipe stdin through to the hook binary
  $cmd "$HOOK_COMMAND"
}

# Fail-open: catch all errors, exit 0
main 2>/dev/null
exit 0
