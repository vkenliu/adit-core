/**
 * Intent command handler for `/adit intent`.
 *
 * Lists intents for the linked project, or shows detail for a
 * specific intent including tasks, latest plan, and ship notes.
 */

import type { CloudClient } from "../http/client.js";
import type {
  IntentOptions,
  IntentResult,
  IntentSummary,
  IntentDetail,
} from "./types.js";

/**
 * Execute the intent command: list intents or show detail.
 *
 * Requires a linked project with a confirmed project ID.
 */
export async function intentCommand(
  client: CloudClient,
  projectId: string,
  options: IntentOptions,
): Promise<IntentResult> {
  if (options.id) {
    // Show detail for a specific intent
    const intent = await client.get<{ intent: IntentDetail }>(
      `/api/project-link/intents/${encodeURIComponent(options.id)}?projectId=${encodeURIComponent(projectId)}`,
    );
    return { intent: intent.intent };
  }

  // List intents
  let url = `/api/project-link/intents?projectId=${encodeURIComponent(projectId)}`;
  if (options.state) {
    url += `&state=${encodeURIComponent(options.state)}`;
  }

  const response = await client.get<{ intents: IntentSummary[] }>(url);
  return { intents: response.intents };
}

/**
 * Format an intent list for human-readable display.
 */
export function formatIntentList(intents: IntentSummary[]): string {
  if (intents.length === 0) {
    return "No intents found for this project.";
  }

  const lines: string[] = [];
  lines.push(`${intents.length} intent${intents.length !== 1 ? "s" : ""}:`);
  lines.push("");

  for (const intent of intents) {
    const progress = intent.taskCount > 0
      ? `${intent.completedTaskCount}/${intent.taskCount} tasks`
      : "no tasks";
    const branches = intent.linkedBranches.length > 0
      ? ` [${intent.linkedBranches.join(", ")}]`
      : "";
    lines.push(`  ${intent.id.padEnd(28)} ${intent.state.padEnd(12)} ${intent.title}${branches}`);
    lines.push(`${"".padEnd(43)}${progress} | ${intent.businessGoal}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format an intent detail for human-readable display.
 */
export function formatIntentDetail(intent: IntentDetail): string {
  const lines: string[] = [];

  lines.push(`Intent: ${intent.title}`);
  lines.push(`State:  ${intent.state}`);
  lines.push(`Goal:   ${intent.businessGoal}`);

  if (intent.acceptanceMd) {
    lines.push("");
    lines.push("Acceptance Criteria:");
    lines.push(intent.acceptanceMd);
  }

  if (intent.antiGoals) {
    lines.push("");
    lines.push("Anti-Goals:");
    lines.push(intent.antiGoals);
  }

  if (intent.clarityScores) {
    const s = intent.clarityScores;
    lines.push("");
    lines.push(`Clarity: goal=${s.goal.toFixed(2)} constraints=${s.constraints.toFixed(2)} criteria=${s.criteria.toFixed(2)} context=${s.context.toFixed(2)}`);
  }

  if (intent.linkedBranches.length > 0) {
    lines.push(`Branches: ${intent.linkedBranches.join(", ")}`);
  }

  if (intent.tasks.length > 0) {
    lines.push("");
    lines.push(`Tasks (${intent.tasks.length}):`);

    // Group tasks by phase
    const phases = new Map<number, { title: string | null; tasks: typeof intent.tasks }>();
    for (const task of intent.tasks) {
      let group = phases.get(task.phase);
      if (!group) {
        group = { title: task.phaseTitle, tasks: [] };
        phases.set(task.phase, group);
      }
      // Prefer descriptive title over "Phase N"
      if (task.phaseTitle && !task.phaseTitle.startsWith("Phase ")) {
        group.title = task.phaseTitle;
      }
      group.tasks.push(task);
    }

    let taskIndex = 0;
    for (const [phaseNum, group] of phases) {
      const phaseLabel = group.title || `Phase ${phaseNum}`;
      lines.push("");
      lines.push(`  Phase ${phaseNum} — ${phaseLabel}`);
      for (const task of group.tasks) {
        const complexity = task.complexityScore !== null ? ` (complexity: ${task.complexityScore})` : "";
        lines.push(`    #${taskIndex} ${task.title} — ${task.approvalStatus}${complexity}`);
        if (task.description) {
          lines.push(`      ${task.description}`);
        }
        if (task.acceptanceCriteria?.criteria?.length > 0) {
          lines.push(`      Acceptance Criteria:`);
          for (const ac of task.acceptanceCriteria.criteria) {
            lines.push(`      - ${ac}`);
          }
        }
        if (task.acceptanceCriteria?.assertions?.length > 0) {
          lines.push(`      Verification Assertions:`);
          for (const a of task.acceptanceCriteria.assertions) {
            const suffix = a.path ? ` (${a.path})` : "";
            lines.push(`      - [${a.type}] ${a.description}${suffix}`);
          }
        }
        taskIndex++;
      }
    }
  }

  if (intent.plans.length > 0) {
    const latest = intent.plans[0];
    lines.push("");
    lines.push(`Latest Plan (v${latest.version}, ${latest.versionType}):`);
    if (latest.gatekeeperVerdict) {
      lines.push(`  Verdict: ${latest.gatekeeperVerdict}`);
    }
  }

  return lines.join("\n");
}
