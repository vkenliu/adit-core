/**
 * CLI version — single source of truth.
 *
 * Reads the version string from the CLI package.json so it is never
 * hardcoded or duplicated across the codebase.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const CLI_VERSION: string = pkg.version;
