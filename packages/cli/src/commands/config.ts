/**
 * `adit config` — View and manage ADIT configuration.
 */

import { loadConfig, type AditConfig } from "@adit/core";

/** `adit config` — show current config */
export async function configCommand(
  opts?: { json?: boolean },
): Promise<void> {
  const config = loadConfig();

  if (opts?.json) {
    console.log(JSON.stringify(configToPlain(config), null, 2));
    return;
  }

  console.log("ADIT Configuration\n");
  console.log(`  Project root:    ${config.projectRoot}`);
  console.log(`  Data directory:  ${config.dataDir}`);
  console.log(`  Database:        ${config.dbPath}`);
  console.log(`  Project ID:      ${config.projectId}`);
  console.log(`  Client ID:       ${config.clientId}`);
  console.log(`  Capture env:     ${config.captureEnv}`);
}

function configToPlain(config: AditConfig): Record<string, unknown> {
  return {
    projectRoot: config.projectRoot,
    dataDir: config.dataDir,
    dbPath: config.dbPath,
    projectId: config.projectId,
    clientId: config.clientId,
    captureEnv: config.captureEnv,
  };
}
