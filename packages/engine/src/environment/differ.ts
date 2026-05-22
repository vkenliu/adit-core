/**
 * Environment snapshot differ.
 *
 * Compares two environment snapshots and produces a structured diff
 * with categorized changes and severity levels.
 */

import type { EnvSnapshot, EnvDiff, EnvChange } from "@varveai/adit-core";

/**
 * Compare two environment snapshots and produce a structured diff.
 */
export function diffEnvironments(prev: EnvSnapshot, current: EnvSnapshot): EnvDiff {
  const changes: EnvChange[] = [];

  // Git changes
  compareField(changes, "gitBranch", "git", prev.gitBranch, current.gitBranch, "warning");
  compareField(changes, "gitHeadSha", "git", prev.gitHeadSha, current.gitHeadSha, "info");

  // Dependency changes
  compareField(changes, "depLockHash", "dependency", prev.depLockHash, current.depLockHash, "warning");
  compareField(changes, "depLockPath", "dependency", prev.depLockPath, current.depLockPath, "info");

  // Runtime version changes
  compareField(changes, "nodeVersion", "runtime", prev.nodeVersion, current.nodeVersion, "warning");
  compareField(changes, "pythonVersion", "runtime", prev.pythonVersion, current.pythonVersion, "warning");

  // Enriched runtime versions (JSON comparison)
  compareJsonField(changes, "runtimeVersions", "runtime", prev.runtimeVersionsJson, current.runtimeVersionsJson);

  // System changes
  compareField(changes, "osInfo", "system", prev.osInfo, current.osInfo, "breaking");
  compareJsonField(changes, "containerInfo", "system", prev.containerInfo, current.containerInfo);
  compareJsonField(changes, "shellInfo", "system", prev.shellInfo, current.shellInfo);
  compareJsonField(changes, "packageManager", "dependency", prev.packageManagerJson, current.packageManagerJson);

  // Modified files changes
  compareModifiedFiles(changes, prev.modifiedFiles, current.modifiedFiles);

  // Compute overall severity
  const severity = computeOverallSeverity(changes);

  return { changes, severity };
}

function compareField(
  changes: EnvChange[],
  field: string,
  category: EnvChange["category"],
  oldValue: string | null,
  newValue: string | null,
  severity: EnvChange["severity"],
): void {
  if (oldValue !== newValue) {
    changes.push({ field, category, oldValue, newValue, severity });
  }
}

function compareJsonField(
  changes: EnvChange[],
  field: string,
  category: EnvChange["category"],
  oldJson: string | null,
  newJson: string | null,
): void {
  if (oldJson === newJson) return;

  // If one is null and the other isn't, that's a change
  if (!oldJson || !newJson) {
    changes.push({
      field,
      category,
      oldValue: oldJson,
      newValue: newJson,
      severity: "info",
    });
    return;
  }

  // Parse and do field-by-field comparison
  try {
    const oldObj = JSON.parse(oldJson) as Record<string, unknown>;
    const newObj = JSON.parse(newJson) as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

    for (const key of allKeys) {
      const oldVal = oldObj[key];
      const newVal = newObj[key];
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        changes.push({
          field: `${field}.${key}`,
          category,
          oldValue: oldVal != null ? String(oldVal) : null,
          newValue: newVal != null ? String(newVal) : null,
          severity: "info",
        });
      }
    }
  } catch {
    // Fallback: treat as opaque string
    changes.push({
      field,
      category,
      oldValue: oldJson,
      newValue: newJson,
      severity: "info",
    });
  }
}

function compareModifiedFiles(
  changes: EnvChange[],
  oldFiles: string | null,
  newFiles: string | null,
): void {
  try {
    const oldList: string[] = oldFiles ? JSON.parse(oldFiles) : [];
    const newList: string[] = newFiles ? JSON.parse(newFiles) : [];

    const oldSet = new Set(oldList);
    const newSet = new Set(newList);

    const added = newList.filter((f) => !oldSet.has(f));
    const removed = oldList.filter((f) => !newSet.has(f));

    if (added.length > 0 || removed.length > 0) {
      changes.push({
        field: "modifiedFiles",
        category: "git",
        oldValue: `${oldList.length} files`,
        newValue: `${newList.length} files (+${added.length} -${removed.length})`,
        severity: "info",
      });
    }
  } catch {
    // Ignore parse errors
  }
}

function computeOverallSeverity(changes: EnvChange[]): EnvDiff["severity"] {
  if (changes.length === 0) return "none";
  if (changes.some((c) => c.severity === "breaking")) return "breaking";
  if (changes.some((c) => c.severity === "warning")) return "warning";
  return "info";
}
