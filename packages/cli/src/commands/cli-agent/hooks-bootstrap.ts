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
