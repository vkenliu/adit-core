/**
 * Verifies npm install preflight behavior for native SQLite binary coverage.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(testDir, "../../scripts/check-native-install.js");

describe("native install preflight", () => {
  it("stays quiet when a known better-sqlite3 prebuild exists", () => {
    const result = runCheck({
      ADIT_NATIVE_CHECK_BETTER_SQLITE3_VERSION: "12.6.2",
      ADIT_NATIVE_CHECK_PLATFORM: "win32",
      ADIT_NATIVE_CHECK_ARCH: "x64",
      ADIT_NATIVE_CHECK_MODULES: "115",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("fails with guidance when native compilation is likely", () => {
    const result = runCheck({
      ADIT_NATIVE_CHECK_BETTER_SQLITE3_VERSION: "12.10.0",
      ADIT_NATIVE_CHECK_PLATFORM: "win32",
      ADIT_NATIVE_CHECK_ARCH: "x64",
      ADIT_NATIVE_CHECK_MODULES: "115",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Native dependency preflight failed");
    expect(result.stderr).toContain("better-sqlite3@12.10.0");
    expect(result.stderr).toContain("Node ABI 115");
    expect(result.stderr).toContain("ADIT_ALLOW_NATIVE_BUILD=1");
  });

  it("allows users to explicitly continue with a native build", () => {
    const result = runCheck({
      ADIT_ALLOW_NATIVE_BUILD: "1",
      ADIT_NATIVE_CHECK_BETTER_SQLITE3_VERSION: "12.10.0",
      ADIT_NATIVE_CHECK_PLATFORM: "win32",
      ADIT_NATIVE_CHECK_ARCH: "x64",
      ADIT_NATIVE_CHECK_MODULES: "115",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("fails when better-sqlite3 is not pinned to an exact version", () => {
    const result = runCheck({
      ADIT_NATIVE_CHECK_BETTER_SQLITE3_VERSION: "^12.10.0",
      ADIT_NATIVE_CHECK_PLATFORM: "win32",
      ADIT_NATIVE_CHECK_ARCH: "x64",
      ADIT_NATIVE_CHECK_MODULES: "115",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("non-exact better-sqlite3 dependency");
    expect(result.stderr).toContain("^12.10.0");
  });
});

function runCheck(overrides: Record<string, string>) {
  const env = { ...process.env, ...overrides };
  delete env.ADIT_ALLOW_NATIVE_BUILD;
  delete env.ADIT_SKIP_NATIVE_PREBUILD_CHECK;

  if (overrides.ADIT_ALLOW_NATIVE_BUILD !== undefined) {
    env.ADIT_ALLOW_NATIVE_BUILD = overrides.ADIT_ALLOW_NATIVE_BUILD;
  }

  return spawnSync(process.execPath, [scriptPath], {
    env,
    encoding: "utf8",
  });
}
