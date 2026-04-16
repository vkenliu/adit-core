/**
 * Claude Code VS Code extension adapter.
 *
 * The VS Code Claude extension uses the same hook mechanism and
 * .claude/settings.local.json configuration as the CLI. This adapter
 * delegates all file I/O to the claude-code adapter and overrides
 * only the platform identification so that VS Code sessions are
 * tracked separately in the ADIT timeline.
 *
 * Detection relies on environment variables present in the VS Code
 * extension host process (ELECTRON_RUN_AS_NODE + VSCODE_IPC_HOOK)
 * which are NOT set when the CLI runs — even from VS Code's terminal.
 */

import type { Platform } from "@varveai/adit-core";
import type {
  PlatformAdapter,
  NormalizedHookInput,
} from "./types.js";
import { claudeCodeAdapter } from "./claude-code.js";

export const claudeVscodeAdapter: PlatformAdapter = {
  platform: "claude-vscode" as Platform,
  displayName: "Claude Code (VS Code)",
  hookMappings: claudeCodeAdapter.hookMappings,

  parseInput(raw: Record<string, unknown>, hookType: string): NormalizedHookInput {
    const input = claudeCodeAdapter.parseInput(raw, hookType);
    // Override platform identification for VS Code sessions
    input.platformCli = "claude-vscode";
    return input;
  },

  generateHookConfig(aditBinaryPath: string) {
    return claudeCodeAdapter.generateHookConfig(aditBinaryPath);
  },

  async validateInstallation(projectRoot: string) {
    return claudeCodeAdapter.validateInstallation(projectRoot);
  },

  async installHooks(projectRoot: string, aditBinaryPath: string): Promise<void> {
    return claudeCodeAdapter.installHooks(projectRoot, aditBinaryPath);
  },

  async uninstallHooks(projectRoot: string): Promise<void> {
    return claudeCodeAdapter.uninstallHooks(projectRoot);
  },

  getResumeCommand(_projectRoot: string): string | null {
    // VS Code extension does not have a command-line resume mechanism
    return null;
  },
};
