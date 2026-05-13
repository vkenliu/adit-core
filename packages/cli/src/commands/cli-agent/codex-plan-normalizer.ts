export const CODEX_UPDATE_PLAN_TOOL = "update_plan";

export type CodexPlanTodoStatus = "pending" | "in_progress" | "completed";
export type CodexPlanTodoPriority = "high" | "medium" | "low";

export interface CodexPlanTodoItem {
  id: string;
  content: string;
  status: CodexPlanTodoStatus;
  priority?: CodexPlanTodoPriority;
  activeForm?: string;
}

export interface CodexUpdatePlanSnapshot {
  todos: CodexPlanTodoItem[];
  explanation?: string;
}

export function normalizeCodexUpdatePlanInput(input: unknown): CodexUpdatePlanSnapshot | null {
  const record = parseCodexToolInput(input);
  const rawTodos = Array.isArray(record.plan)
    ? record.plan
    : Array.isArray(record.todos)
      ? record.todos
      : null;
  if (!rawTodos) return null;

  const todos = rawTodos
    .map((item, index): CodexPlanTodoItem | null => {
      if (!isRecord(item)) return null;
      const content = readString(item.step) ??
        readString(item.content) ??
        readString(item.title) ??
        readString(item.task);
      const status = normalizeCodexPlanStatus(item.status);
      if (!content || !status) return null;
      const priority = normalizeCodexPlanPriority(item.priority);
      const activeForm = readString(item.activeForm);
      return {
        id: readString(item.id) ?? readString(item.key) ?? `plan-${index + 1}`,
        content,
        status,
        ...(priority ? { priority } : {}),
        ...(activeForm ? { activeForm } : {}),
      };
    })
    .filter((item): item is CodexPlanTodoItem => Boolean(item));

  if (todos.length === 0) return null;
  const explanation = readString(record.explanation) ?? readString(record.summary);
  return {
    todos,
    ...(explanation ? { explanation } : {}),
  };
}

export function parseCodexToolInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) return parsed;
      return { value: parsed };
    } catch {
      return { value };
    }
  }
  if (value === undefined) return {};
  return { value };
}

function normalizeCodexPlanStatus(value: unknown): CodexPlanTodoStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  if (normalized === "pending" || normalized === "in_progress" || normalized === "completed") {
    return normalized;
  }
  if (normalized === "todo" || normalized === "not_started") return "pending";
  if (normalized === "doing" || normalized === "active") return "in_progress";
  if (normalized === "complete" || normalized === "done") return "completed";
  return null;
}

function normalizeCodexPlanPriority(value: unknown): CodexPlanTodoPriority | null {
  if (value === "high" || value === "medium" || value === "low") return value;
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
