import fs from "node:fs";
import path from "node:path";

const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionEnd",
] as const;

interface HookCommand {
  type?: string;
  command?: string;
  timeout?: number;
}

interface CodexHookEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

export interface InstalledHooks {
  settingsPath: string;
  cleanup: () => void;
}

export function installClaudeHooks(opts: {
  cwd: string;
  endpoint: string;
  marker: string;
  settingsPath?: string;
}): InstalledHooks {
  const claudeDir = path.join(opts.cwd, ".claude");
  const baseSettingsPath = path.join(claudeDir, "settings.local.json");
  const settingsPath = opts.settingsPath ?? baseSettingsPath;
  const managedSettingsFile = settingsPath !== baseSettingsPath;
  const command = `curl -sS --fail --max-time 3 -X POST -H 'content-type: application/json' --data-binary @- '${opts.endpoint}?${opts.marker}' >/dev/null || true`;

  const dirExisted = fs.existsSync(claudeDir);
  const fileExisted = fs.existsSync(settingsPath);
  fs.mkdirSync(claudeDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  const sourceSettingsPath = managedSettingsFile ? baseSettingsPath : settingsPath;
  if (fs.existsSync(sourceSettingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sourceSettingsPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }

  const hooks = (existing.hooks ??= {}) as Record<string, unknown>;
  for (const eventName of EVENTS) {
    const arr = Array.isArray(hooks[eventName])
      ? hooks[eventName] as Array<Record<string, unknown>>
      : [];
    const filtered = arr.filter((entry) => {
      const inner = entry.hooks;
      return !(
        Array.isArray(inner) &&
        inner.some((hook: HookCommand) =>
          typeof hook?.command === "string" &&
          hook.command.includes(opts.marker)
        )
      );
    });
    filtered.push({ hooks: [{ type: "command", command, timeout: 5000 }] });
    hooks[eventName] = filtered;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");

  return {
    settingsPath,
    cleanup: () => {
      if (managedSettingsFile) {
        try {
          fs.unlinkSync(settingsPath);
        } catch {}
        return;
      }

      try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        if (parsed?.hooks && typeof parsed.hooks === "object") {
          for (const eventName of Object.keys(parsed.hooks)) {
            if (!Array.isArray(parsed.hooks[eventName])) continue;
            parsed.hooks[eventName] = parsed.hooks[eventName].filter(
              (entry: Record<string, unknown>) => {
                const inner = entry.hooks;
                return !(
                  Array.isArray(inner) &&
                  inner.some((hook: HookCommand) =>
                    typeof hook?.command === "string" &&
                    hook.command.includes(opts.marker)
                  )
                );
              },
            );
            if (parsed.hooks[eventName].length === 0) {
              delete parsed.hooks[eventName];
            }
          }
          if (Object.keys(parsed.hooks).length === 0) delete parsed.hooks;
        }

        if (Object.keys(parsed).length === 0 && !fileExisted) {
          try {
            fs.unlinkSync(settingsPath);
          } catch {}
          if (!dirExisted) {
            try {
              fs.rmdirSync(claudeDir);
            } catch {}
          }
          return;
        }

        fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + "\n");
      } catch {
        // Leave user settings untouched on parse or filesystem failures.
      }
    },
  };
}

export function installCodexHooks(opts: {
  cwd: string;
  endpoint: string;
  marker: string;
}): InstalledHooks {
  const codexDir = path.join(opts.cwd, ".codex");
  const hooksPath = path.join(codexDir, "hooks.json");
  const command = `curl -sS --fail --max-time 3 -X POST -H 'content-type: application/json' --data-binary @- '${opts.endpoint}?${opts.marker}' >/dev/null || true`;

  const dirExisted = fs.existsSync(codexDir);
  const fileExisted = fs.existsSync(hooksPath);
  const originalContent = fileExisted ? readFile(hooksPath) : null;
  fs.mkdirSync(codexDir, { recursive: true });

  const existing = parseObject(originalContent) ?? {};
  const hooks = asObject(existing.hooks) ?? {};
  existing.hooks = hooks;

  setCodexHook(hooks, "SessionStart", {
    matcher: "startup|resume",
    hooks: [{ type: "command", command, timeout: 30 }],
  }, opts.marker);
  setCodexHook(hooks, "UserPromptSubmit", {
    hooks: [{ type: "command", command, timeout: 30 }],
  }, opts.marker);
  setCodexHook(hooks, "Stop", {
    hooks: [{ type: "command", command, timeout: 30 }],
  }, opts.marker);
  setCodexHook(hooks, "PostToolUse", {
    matcher: "Bash",
    hooks: [{ type: "command", command, timeout: 30 }],
  }, opts.marker);

  fs.writeFileSync(hooksPath, JSON.stringify(existing, null, 2) + "\n");

  return {
    settingsPath: hooksPath,
    cleanup: () => {
      try {
        const current = parseObject(readFile(hooksPath));
        if (!current) {
          restoreCodexHooks({ hooksPath, codexDir, dirExisted, fileExisted, originalContent });
          return;
        }

        const currentHooks = asObject(current.hooks);
        if (currentHooks) {
          for (const eventName of Object.keys(currentHooks)) {
            if (!Array.isArray(currentHooks[eventName])) continue;
            currentHooks[eventName] = (currentHooks[eventName] as unknown[]).filter(
              (entry) => !codexEntryHasMarker(entry, opts.marker),
            );
            if ((currentHooks[eventName] as unknown[]).length === 0) {
              delete currentHooks[eventName];
            }
          }
          if (Object.keys(currentHooks).length === 0) delete current.hooks;
        }

        if (Object.keys(current).length === 0 && !fileExisted) {
          try {
            fs.unlinkSync(hooksPath);
          } catch {}
          if (!dirExisted) {
            try {
              fs.rmdirSync(codexDir);
            } catch {}
          }
          return;
        }

        fs.writeFileSync(hooksPath, JSON.stringify(current, null, 2) + "\n");
      } catch {
        restoreCodexHooks({ hooksPath, codexDir, dirExisted, fileExisted, originalContent });
      }
    },
  };
}

function setCodexHook(
  hooks: Record<string, unknown>,
  eventName: string,
  entry: CodexHookEntry,
  marker: string,
): void {
  const existing = Array.isArray(hooks[eventName]) ? hooks[eventName] as unknown[] : [];
  hooks[eventName] = [
    ...existing.filter((item) => !codexEntryHasMarker(item, marker)),
    entry,
  ];
}

function codexEntryHasMarker(entry: unknown, marker: string): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const hooks = (entry as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) =>
    hook &&
    typeof hook === "object" &&
    !Array.isArray(hook) &&
    typeof (hook as HookCommand).command === "string" &&
    ((hook as HookCommand).command?.includes(marker) ||
      (hook as HookCommand).command?.includes("from=adit-cloud-codex-"))
  );
}

function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function restoreCodexHooks(input: {
  hooksPath: string;
  codexDir: string;
  dirExisted: boolean;
  fileExisted: boolean;
  originalContent: string | null;
}): void {
  try {
    if (input.fileExisted && input.originalContent !== null) {
      fs.writeFileSync(input.hooksPath, input.originalContent);
      return;
    }
    try {
      fs.unlinkSync(input.hooksPath);
    } catch {}
    if (!input.dirExisted) {
      try {
        fs.rmdirSync(input.codexDir);
      } catch {}
    }
  } catch {
    // Hook cleanup must never make the main relay crash on shutdown.
  }
}
