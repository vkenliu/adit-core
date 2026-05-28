#!/usr/bin/env node
/**
 * Checks whether ADIT's native SQLite dependency has a known prebuilt binary.
 *
 * npm hides successful lifecycle output for dependency packages, so unsupported
 * environments fail fast with actionable guidance instead of silently falling
 * through to a long node-gyp build.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const betterSqlite3Prebuilds = {
  "12.6.2": {
    nodeModules: new Set(["115", "127", "131", "137", "141"]),
    targets: new Set([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm",
      "linux-arm64",
      "linux-x64",
      "linuxmusl-arm",
      "linuxmusl-arm64",
      "linuxmusl-x64",
      "win32-arm64",
      "win32-x64",
    ]),
  },
  "12.10.0": {
    nodeModules: new Set(["127", "137", "141", "147"]),
    targets: new Set([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm",
      "linux-arm64",
      "linux-x64",
      "linuxmusl-arm",
      "linuxmusl-arm64",
      "linuxmusl-x64",
      "win32-arm64",
      "win32-x64",
    ]),
  },
};

const nodeAbiLabels = {
  "115": "Node.js 20",
  "127": "Node.js 22",
  "131": "Node.js 23",
  "137": "Node.js 24",
  "141": "Node.js 25",
  "147": "Node.js 26",
};

if (isTruthy(process.env.ADIT_SKIP_NATIVE_PREBUILD_CHECK)) {
  process.exit(0);
}

if (isTruthy(process.env.ADIT_ALLOW_NATIVE_BUILD)) {
  process.exit(0);
}

const packageJson = readPackageJson();
const betterSqlite3Spec = process.env.ADIT_NATIVE_CHECK_BETTER_SQLITE3_VERSION
  ?? packageJson.dependencies?.["better-sqlite3"];

if (typeof betterSqlite3Spec !== "string" || betterSqlite3Spec.trim() === "") {
  process.exit(0);
}

const betterSqlite3Version = exactVersion(betterSqlite3Spec);
if (betterSqlite3Version === null) {
  failWithGuidance({
    reason: `ADIT cannot preflight non-exact better-sqlite3 dependency "${betterSqlite3Spec}".`,
    betterSqlite3Version: betterSqlite3Spec,
    supportedNodeModules: [],
    target: currentTarget(),
    nodeModules: currentNodeModules(),
  });
}

const prebuilds = betterSqlite3Prebuilds[betterSqlite3Version];
if (prebuilds === undefined) {
  failWithGuidance({
    reason: `ADIT cannot confirm prebuilt binary coverage for better-sqlite3@${betterSqlite3Version}.`,
    betterSqlite3Version,
    supportedNodeModules: [],
    target: currentTarget(),
    nodeModules: currentNodeModules(),
  });
}

const target = currentTarget();
const nodeModules = currentNodeModules();
if (prebuilds.targets.has(target) && prebuilds.nodeModules.has(nodeModules)) {
  process.exit(0);
}

failWithGuidance({
  reason: `No known better-sqlite3@${betterSqlite3Version} prebuilt binary matches this environment.`,
  betterSqlite3Version,
  supportedNodeModules: [...prebuilds.nodeModules],
  target,
  nodeModules,
});

function readPackageJson() {
  const scriptPath = fileURLToPath(import.meta.url);
  const packagePath = resolve(dirname(scriptPath), "../package.json");
  return JSON.parse(readFileSync(packagePath, "utf8"));
}

function exactVersion(versionSpec) {
  if (typeof versionSpec !== "string") return null;
  const trimmed = versionSpec.trim();
  const match = /^(\d+\.\d+\.\d+)$/.exec(trimmed);
  return match?.[1] ?? null;
}

function currentTarget() {
  const platform = process.env.ADIT_NATIVE_CHECK_PLATFORM ?? process.platform;
  const arch = process.env.ADIT_NATIVE_CHECK_ARCH ?? process.arch;
  if (platform === "linux") {
    return `${linuxRuntime()}-${arch}`;
  }
  return `${platform}-${arch}`;
}

function currentNodeModules() {
  return process.env.ADIT_NATIVE_CHECK_MODULES ?? process.versions.modules;
}

function linuxRuntime() {
  const override = process.env.ADIT_NATIVE_CHECK_LIBC;
  if (override === "musl") return "linuxmusl";
  if (override === "glibc") return "linux";

  try {
    const report = process.report?.getReport();
    const glibcVersion = report?.header?.glibcVersionRuntime;
    return typeof glibcVersion === "string" && glibcVersion.length > 0
      ? "linux"
      : "linuxmusl";
  } catch {
    return "linux";
  }
}

function failWithGuidance(details) {
  process.stderr.write(buildGuidance(details));
  process.exit(1);
}

function buildGuidance(details) {
  const nodeLabel = nodeAbiLabels[details.nodeModules] ?? `Node ABI ${details.nodeModules}`;
  const supportedNode = formatSupportedNode(
    details.supportedNodeModules,
    details.betterSqlite3Version,
  );

  return [
    "",
    "[ADIT] Native dependency preflight failed.",
    "",
    details.reason,
    `Current environment: ${nodeLabel}, ${details.target}, Node ABI ${details.nodeModules}.`,
    "",
    "npm would likely fall back to native compilation via node-gyp. That can fail",
    "without Python, make, a C++ compiler, or Windows Build Tools installed.",
    "",
    "Recommended fixes:",
    `  - Use a supported Node.js/platform combination${supportedNode}.`,
    "  - Or install native build tools and retry while explicitly allowing native builds.",
    "",
    "Retry examples:",
    "  macOS/Linux: ADIT_ALLOW_NATIVE_BUILD=1 npm install -g @varveai/adit-cli",
    "  PowerShell:  $env:ADIT_ALLOW_NATIVE_BUILD=\"1\"; npm install -g @varveai/adit-cli",
    "  cmd.exe:     set ADIT_ALLOW_NATIVE_BUILD=1 && npm install -g @varveai/adit-cli",
    "",
    "To bypass only this ADIT preflight check, set ADIT_SKIP_NATIVE_PREBUILD_CHECK=1.",
    "",
  ].join("\n");
}

function formatSupportedNode(supportedNodeModules, betterSqlite3Version) {
  if (supportedNodeModules.length === 0) return ".";

  const labels = supportedNodeModules
    .map((nodeModules) => nodeAbiLabels[nodeModules] ?? `ABI ${nodeModules}`)
    .join(", ");

  return ` (${labels} for better-sqlite3@${betterSqlite3Version})`;
}

function isTruthy(value) {
  const normalized = value?.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
