/**
 * `adit plugin` — Platform plugin management commands.
 *
 * Install, uninstall, list, and validate ADIT integrations
 * for different AI platforms.
 */

import { loadConfig } from "@adit/core";
import {
  getAdapter,
  listAdapters,
  detectPlatform,
  type PlatformAdapter,
} from "@adit/hooks/adapters";
import type { Platform } from "@adit/core";

/** adit plugin install [platform] */
export async function pluginInstallCommand(
  platformArg?: string,
  opts?: { json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const platform = (platformArg ?? detectPlatform()) as Platform;
  const adapter = getAdapterSafe(platform);
  if (!adapter) return;

  const aditBinaryPath = "npx adit-hook";

  try {
    await adapter.installHooks(config.projectRoot, aditBinaryPath);

    if (opts?.json) {
      console.log(JSON.stringify({ ok: true, platform, action: "install" }));
    } else {
      console.log(`Installed ADIT hooks for ${adapter.displayName}`);

      // Validate after install
      const result = await adapter.validateInstallation(config.projectRoot);
      for (const check of result.checks) {
        const symbol = check.ok ? "+" : "x";
        console.log(`  [${symbol}] ${check.name}: ${check.detail}`);
      }
    }
  } catch (err) {
    console.error(`Failed to install hooks for ${platform}: ${(err as Error).message}`);
    process.exit(1);
  }
}

/** adit plugin uninstall [platform] */
export async function pluginUninstallCommand(
  platformArg?: string,
  opts?: { json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const platform = (platformArg ?? detectPlatform()) as Platform;
  const adapter = getAdapterSafe(platform);
  if (!adapter) return;

  try {
    await adapter.uninstallHooks(config.projectRoot);

    if (opts?.json) {
      console.log(JSON.stringify({ ok: true, platform, action: "uninstall" }));
    } else {
      console.log(`Uninstalled ADIT hooks for ${adapter.displayName}`);
    }
  } catch (err) {
    console.error(`Failed to uninstall hooks for ${platform}: ${(err as Error).message}`);
    process.exit(1);
  }
}

/** adit plugin list */
export async function pluginListCommand(
  opts?: { json?: boolean },
): Promise<void> {
  const adapters = listAdapters();

  if (opts?.json) {
    console.log(
      JSON.stringify(
        adapters.map((a) => ({
          platform: a.platform,
          displayName: a.displayName,
          hooks: a.hookMappings.map((m) => m.platformEvent),
        })),
        null,
        2,
      ),
    );
    return;
  }

  console.log("Available platform adapters:\n");
  for (const adapter of adapters) {
    console.log(`  ${adapter.displayName} (${adapter.platform})`);
    console.log(`    Hooks: ${adapter.hookMappings.map((m) => m.platformEvent).join(", ")}`);
  }
}

/** adit plugin validate [platform] */
export async function pluginValidateCommand(
  platformArg?: string,
  opts?: { json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const platform = (platformArg ?? detectPlatform()) as Platform;
  const adapter = getAdapterSafe(platform);
  if (!adapter) return;

  const result = await adapter.validateInstallation(config.projectRoot);

  if (opts?.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Plugin validation for ${adapter.displayName}:\n`);
  for (const check of result.checks) {
    const symbol = check.ok ? "+" : "x";
    console.log(`  [${symbol}] ${check.name}: ${check.detail}`);
  }
  console.log(result.valid ? "\nAll checks passed." : "\nSome checks failed.");
}

function getAdapterSafe(platform: Platform): PlatformAdapter | null {
  try {
    return getAdapter(platform);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
