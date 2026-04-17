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
 * Always shows per-document structural details.
 * If not qualified, also shows missing items and suggestions.
 */
export function formatQualityFeedback(response: QualifyResponse): string | null {
  const lines: string[] = [];
  const hasLowScoreDocs = response.documentDetails?.some(
    (d) => d.structuralScore < 0.6
  );

  // Show document details when there are low-scoring docs or not qualified
  if (response.documentDetails && response.documentDetails.length > 0) {
    lines.push("  Document scores:");
    for (const doc of response.documentDetails) {
      const scorePct = Math.round(doc.structuralScore * 100);
      const warn = scorePct < 60 ? " ⚠" : "";
      lines.push(`    ${doc.fileName} — ${scorePct}% (${doc.detectedType})${warn}`);
      if (doc.hasStubContent) {
        lines.push(`      ↳ contains placeholder/stub content`);
      }
    }
    lines.push("");
  }

  if (!response.qualified && response.feedback) {
    lines.push(`  Overall score: ${response.score.toFixed(2)} (needs 0.60)`);
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
  } else if (hasLowScoreDocs) {
    lines.push("  Tip: Use /generate-docs in your AI coding tool to auto-fill");
    lines.push("       document content from your codebase. Then re-run link.");
  }

  return lines.length > 0 ? lines.join("\n") : null;
}
