/**
 * Stub platform adapter.
 *
 * Provides a "not yet supported" adapter for platforms that have been
 * detected but don't have full implementations yet. This is better than
 * throwing at detection time — it gives users a clear error message
 * and documents what's needed to add support.
 */

import type { Platform } from "@varveai/adit-core";
import type {
  PlatformAdapter,
  HookMapping,
  NormalizedHookInput,
  PlatformHookConfig,
  ValidationResult,
} from "./types.js";

/**
 * Create a stub adapter for a platform that is detected but not yet supported.
 * All methods throw with a clear message explaining the platform is not yet implemented.
 */
export function createStubAdapter(
  platform: Platform,
  displayName: string,
  envVarHints: string[],
): PlatformAdapter {
  const notSupported = (method: string): never => {
    throw new Error(
      `${displayName} adapter is not yet implemented (method: ${method}). ` +
        `ADIT detected this platform via environment variables (${envVarHints.join(", ")}). ` +
        `Contributions welcome! See packages/hooks/src/adapters/ for the adapter interface.`,
    );
  };

  return {
    platform,
    displayName,
    hookMappings: [] as HookMapping[],

    parseInput(_raw: Record<string, unknown>, _hookType: string): NormalizedHookInput {
      return notSupported("parseInput");
    },

    generateHookConfig(_aditBinaryPath: string): PlatformHookConfig {
      return notSupported("generateHookConfig");
    },

    async validateInstallation(_projectRoot: string): Promise<ValidationResult> {
      return {
        valid: false,
        checks: [
          {
            name: `${displayName} support`,
            ok: false,
            detail: `${displayName} adapter is not yet implemented`,
          },
        ],
      };
    },

    async installHooks(_projectRoot: string, _aditBinaryPath: string): Promise<void> {
      notSupported("installHooks");
    },

    async uninstallHooks(_projectRoot: string): Promise<void> {
      notSupported("uninstallHooks");
    },

    getResumeCommand(_projectRoot: string): string | null {
      return null;
    },
  };
}

/** GitHub Copilot — AI pair programmer */
export const copilotAdapter = createStubAdapter(
  "copilot",
  "GitHub Copilot",
  ["GITHUB_COPILOT", "COPILOT_SESSION"],
);

/** Unknown / undetected platform */
export const otherAdapter = createStubAdapter(
  "other",
  "Unknown Platform",
  [],
);
