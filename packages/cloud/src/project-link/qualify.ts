/**
 * Document quality check and feedback formatting.
 *
 * Calls the server's qualify endpoint to evaluate whether uploaded
 * project documents provide sufficient context for IDD planning.
 * If not qualified, formats the server's feedback for display and
 * returns the summaryPrompt for the AI agent to use.
 */

import type { CloudClient } from "../http/client.js";
import type { QualifyResponse } from "./types.js";

/**
 * Check document quality with the server.
 *
 * Returns the server's qualify response including score, qualification
 * status, and feedback with a summary prompt if not qualified.
 */
export async function checkQuality(
  client: CloudClient,
  projectId: string,
): Promise<QualifyResponse> {
  return client.get<QualifyResponse>(
    `/api/project-link/qualify?projectId=${encodeURIComponent(projectId)}`,
  );
}

/**
 * Format quality feedback for human-readable display.
 *
 * Returns a multi-line string describing what's missing and
 * suggestions for improvement. Returns null if already qualified.
 */
export function formatQualityFeedback(response: QualifyResponse): string | null {
  if (response.qualified || !response.feedback) return null;

  const lines: string[] = [];
  lines.push(`  Score: ${response.score.toFixed(2)} (needs 0.60 to qualify)`);
  lines.push("");

  if (response.feedback.missing.length > 0) {
    lines.push("  Missing:");
    for (const item of response.feedback.missing) {
      lines.push(`    - ${item}`);
    }
    lines.push("");
  }

  if (response.feedback.suggestions.length > 0) {
    lines.push("  Suggestions:");
    for (const item of response.feedback.suggestions) {
      lines.push(`    - ${item}`);
    }
  }

  return lines.join("\n");
}
